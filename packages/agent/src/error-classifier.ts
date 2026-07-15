import { applyJitter } from "./retry-utils";
import { resolveFailoverReason, isTransientReason, type FailoverReason } from "./failover-policy";

export enum LLMErrorType {
  CONTEXT_OVERFLOW = "context_overflow",
  RATE_LIMIT = "rate_limit",
  AUTH = "auth",
  BILLING = "billing",
  TIMEOUT = "timeout",
  NETWORK = "network",
  PROVIDER_ERROR = "provider_error",
  UNKNOWN = "unknown",
  // ── 对齐 hermes-agent 错误分类粒度（fix-1） ──
  /** Provider 安全过滤器拒绝（确定性，不可重试，应立即 fallback） */
  CONTENT_POLICY = "content_policy",
  /** SSL/TLS 证书验证失败（fail-fast，重试无意义） */
  SSL_CERT = "ssl_cert",
  /** 模型不存在（non-transient，应跳过该 provider） */
  MODEL_NOT_FOUND = "model_not_found",
  /** 请求体过大 413（transient，需压缩/裁剪后重试） */
  PAYLOAD_TOO_LARGE = "payload_too_large",
  /** 聚合器（如 OpenRouter）账户数据/隐私策略阻止（non-transient） */
  PROVIDER_POLICY = "provider_policy",
}

export interface ClassifiedError {
  type: LLMErrorType;
  retryable: boolean;
  shouldCompact: boolean;
  shouldRotateAuth: boolean;
  backoffMs: number;
  message: string;
  /** 失败原因分类（借鉴 openclaw failover-policy） */
  reason?: FailoverReason;
  /** 是否为瞬时错误（可重试） */
  isTransient?: boolean;
  /** 是否有 Retry-After 契约（影响 jitter 模式） */
  hasRetryAfterContract?: boolean;
  /** 是否应跳过当前 provider 并 fallback 到下一个（fix-1）
   *  适用于 non-transient 错误（auth/billing/content_policy/ssl_cert/model_not_found/provider_policy） */
  shouldSkipProvider?: boolean;
  /** 是否应剥离 thinking 块后重试（fix-1，对应 thinking_signature reason） */
  shouldStripThinking?: boolean;
  /** 是否应将 tool 消息列表内容降级为纯文本后重试（fix-1） */
  shouldFlattenToolContent?: boolean;
}

const CONTEXT_OVERFLOW_PATTERNS = [
  /context.length.exceeded/i,
  /request_too_large/i,
  /input.exceeds.the.maximum.number.of.tokens/i,
  /input.token.count.exceeds/i,
  /input.is.too.long/i,
  /maximum.context.length/i,
  /context.window/i,
  /reduce.the.length/i,
  /too.many.tokens/i,
  /token.limit/i,
  /ollama.error.*context.length.exceeded/i,
];

const RATE_LIMIT_PATTERNS = [
  /rate.limit/i,
  /too.many.requests/i,
  /429/i,
  /quota.exceeded/i,
  /throttl/i,
  /requests.too.frequent/i,
  /please.wait/i,
  /retry.after/i,
];

const AUTH_PATTERNS = [
  /invalid.api.key/i,
  /unauthorized/i,
  /401/i,
  /403/i,
  /authentication/i,
  /auth.failed/i,
  /incorrect.api.key/i,
  /not.authorized/i,
  /access.denied/i,
  /permission.denied/i,
];

const BILLING_PATTERNS = [
  /billing/i,
  /insufficient.quota/i,
  /insufficient_quota/i,
  /account.*balance/i,
  /payment/i,
  /credit/i,
  /usage.limit/i,
  /free.trial/i,
  /subscription/i,
  /plan.*limit/i,
  /402/i,
];

const TIMEOUT_PATTERNS = [
  /timeout/i,
  /timed.out/i,
  /abort/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /socket.hang.up/i,
];

// ── fix-1: 新增错误模式数组（对齐 hermes-agent error_classifier.py） ──

/** SSL/TLS 证书验证失败模式（fail-fast，不重试） */
const SSL_CERT_PATTERNS = [
  /ssl.*cert/i,
  /certificate.*verify/i,
  /unable.to.get.local.issuer/i,
  /self.signed.certificate/i,
  /certificate.has.expired/i,
  /certificate.*not.trusted/i,
  /peer.certificate.*rejected/i,
  /ERR_TLS_CERT/i,
  /CERT_HAS_EXPIRED/i,
  /DEPTH_ZERO_SELF_SIGNED_CERT/i,
  /UNABLE_TO_VERIFY_LEAF_SIGNATURE/i,
];

/** Provider 安全过滤器拒绝模式（确定性，不可重试，应立即 fallback） */
const CONTENT_POLICY_PATTERNS = [
  /content.*policy/i,
  /safety.filter/i,
  /content_filter/i,
  /responsibleaipolicyviolation/i,
  /flagged.*safety/i,
  /flagged.*cyber/i,
  /violates.*usage.polic/i,
  /violates.*content.polic/i,
  /request.*flagged.by/i,
  /prompt.*flagged.by/i,
  /cannot.be.generated.*safety/i,
  /inappropriate.content/i,
  /harmful.content/i,
  /refusing.to.generate/i,
  /content_policy_violation/i,
];

/** 模型不存在模式（non-transient，应跳过该 provider） */
const MODEL_NOT_FOUND_PATTERNS = [
  /model.*not.found/i,
  /model.*does.not.exist/i,
  /model.*not.available/i,
  /unknown.model/i,
  /invalid.model/i,
  /unsupported.model/i,
  /no.such.model/i,
  /model_not_found/i,
  /is.not.a.valid.model/i,
  /model.*deprecated/i,
];

/** 请求体过大模式（413，transient，需压缩/裁剪后重试） */
const PAYLOAD_TOO_LARGE_PATTERNS = [
  /request.entity.too.large/i,
  /payload.too.large/i,
  /request.too.large/i,
  /body.*too.large/i,
  /413/i,
  /content.length.exceeds/i,
];

/** OpenRouter upstream 429 模式（不轮换健康 key，因为上游 provider 已限流） */
const UPSTREAM_RATE_LIMIT_PATTERNS = [
  /upstream.*429/i,
  /429.*upstream/i,
  /upstream.*rate.limit/i,
  /provider.*upstream.*limit/i,
  /upstream.provider.*throttl/i,
  /OpenRouter.*upstream/i,
];

/** 聚合器账户策略阻止模式（non-transient，应跳过该 provider） */
const PROVIDER_POLICY_PATTERNS = [
  /no.endpoints.available.matching/i,
  /no.endpoints.found.matching/i,
  /data.policy.*not.allow/i,
  /guardrail.*not.allow/i,
  /provider.policy/i,
  /account.*data.policy/i,
  /privacy.policy.*restrict/i,
];

/** Server disconnect + 大 session 启发式模式（应触发 context 压缩） */
const SERVER_DISCONNECT_PATTERNS = [
  /server.disconnected/i,
  /peer.closed.connection/i,
  /connection.reset.by.peer/i,
  /connection.closed.prematurely/i,
  /incomplete.chunked/i,
  /stream.closed.prematurely/i,
];

// ── Jitter 配置 ───────────────────────────────────────────
// 借鉴 openclaw 的双 jitter 模式：symmetric 用于普通退避，
// positive 用于 Retry-After 场景（保证不低于下限）。
const JITTER_FACTOR = 0.3;
// 上限提升至 5 分钟：当 provider 通过 Retry-After 显式要求更长等待时，
// 30s 上限会违反契约导致反复 429。普通退避仍由各分支的 baseBackoff 控制。
const MAX_BACKOFF_MS = 300_000;
// 普通退避（无 Retry-After 契约）仍使用 30s 上限，避免无谓的长等待。
const MAX_ORDINARY_BACKOFF_MS = 30_000;

/**
 * 对 backoffMs 应用 jitter。
 * - 有 Retry-After 契约时用 positive 模式（保证不低于下限）
 * - 无契约时用 symmetric 模式（允许分散）
 */
function applyBackoffJitter(backoffMs: number, hasRetryAfter = false): number {
  const jittered = applyJitter(backoffMs, JITTER_FACTOR, hasRetryAfter ? "positive" : "symmetric");
  // Retry-After 契约场景尊重 provider 要求，使用 MAX_BACKOFF_MS（5min）；
  // 普通退避使用更短的 MAX_ORDINARY_BACKOFF_MS（30s）避免长等待。
  const cap = hasRetryAfter ? MAX_BACKOFF_MS : MAX_ORDINARY_BACKOFF_MS;
  return Math.min(Math.max(0, jittered), cap);
}

export interface ClassifyOptions {
  /** 当前 session 估算 token 数（用于 server-disconnect + 大 session 启发式） */
  sessionTokens?: number;
  /** 触发 context_overflow 启发式的 token 阈值（默认 100000） */
  largeSessionThreshold?: number;
}

export function classifyLLMError(
  statusCode?: number,
  errorText?: string,
  errorMessage?: string,
  options?: ClassifyOptions
): ClassifiedError {
  const combinedText = [errorText, errorMessage].filter(Boolean).join(" ");
  const lower = combinedText.toLowerCase();

  // 解析 FailoverReason（借鉴 openclaw failover-policy）
  const reason = resolveFailoverReason(statusCode, combinedText);
  const isTransient = isTransientReason(reason);

  // ── fix-1: 优先级最高的 fail-fast 检查（在 status code 之前） ──

  // SSL/TLS 证书验证失败：fail-fast，重试无意义（除非配置变更）
  for (const pattern of SSL_CERT_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        type: LLMErrorType.SSL_CERT,
        retryable: false,
        shouldCompact: false,
        shouldRotateAuth: false,
        shouldSkipProvider: true,
        backoffMs: 0,
        message: "SSL/TLS certificate verification failed. Skipping provider (fail-fast).",
        reason,
        isTransient: false,
      };
    }
  }

  // Provider 安全过滤器拒绝：确定性，不可重试，应立即 fallback
  for (const pattern of CONTENT_POLICY_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        type: LLMErrorType.CONTENT_POLICY,
        retryable: false,
        shouldCompact: false,
        shouldRotateAuth: false,
        shouldSkipProvider: true,
        backoffMs: 0,
        message: "Content policy blocked. Skipping provider (deterministic refusal).",
        reason: "content_policy_blocked",
        isTransient: false,
      };
    }
  }

  // 聚合器账户策略阻止（如 OpenRouter data policy）：non-transient，应跳过
  for (const pattern of PROVIDER_POLICY_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        type: LLMErrorType.PROVIDER_POLICY,
        retryable: false,
        shouldCompact: false,
        shouldRotateAuth: false,
        shouldSkipProvider: true,
        backoffMs: 0,
        message: "Provider policy blocked. Skipping provider (account data/privacy policy).",
        reason: "provider_policy_blocked",
        isTransient: false,
      };
    }
  }

  if (statusCode === 429) {
    // ── fix-1: 检测 OpenRouter upstream 429 ──
    // 上游 provider（如 OpenAI）被限流时，轮换 OpenRouter 的 key 无意义，
    // 因为所有 key 都会路由到同一个上游。此时应保持 key 不变并等待 backoff。
    const isUpstreamRateLimit = UPSTREAM_RATE_LIMIT_PATTERNS.some((p) => p.test(lower));
    if (isUpstreamRateLimit) {
      const retryAfterMatch = lower.match(/retry.after.?\s*(\d+)/i);
      const retryAfterSeconds = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) : 0;
      const hasRetryAfter = retryAfterSeconds > 0;
      const baseBackoff = hasRetryAfter
        ? Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS)
        : 10000; // upstream 429 默认等待 10s（比普通 429 更长）
      return {
        type: LLMErrorType.RATE_LIMIT,
        retryable: true,
        shouldCompact: false,
        shouldRotateAuth: false, // 不轮换 key（上游已限流，轮换无效）
        shouldSkipProvider: false,
        backoffMs: applyBackoffJitter(baseBackoff, hasRetryAfter),
        message: "Upstream provider rate-limited. Waiting before retry (no key rotation).",
        reason,
        isTransient,
        hasRetryAfterContract: hasRetryAfter,
      };
    }

    // 解析 Retry-After
    const retryAfterMatch = lower.match(/retry.after.?\s*(\d+)/i);
    const retryAfterSeconds = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) : 0;
    const hasRetryAfter = retryAfterSeconds > 0;
    const baseBackoff = hasRetryAfter
      ? Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS)
      : 5000;
    return {
      type: LLMErrorType.RATE_LIMIT,
      retryable: true,
      shouldCompact: false,
      shouldRotateAuth: true,
      shouldSkipProvider: false,
      backoffMs: applyBackoffJitter(baseBackoff, hasRetryAfter),
      message: "Rate limit exceeded. Rotating to next provider.",
      reason,
      isTransient,
      hasRetryAfterContract: hasRetryAfter,
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    return {
      type: LLMErrorType.AUTH,
      retryable: false,
      shouldCompact: false,
      shouldRotateAuth: true,
      shouldSkipProvider: true,
      backoffMs: 0,
      message: "Authentication failed. Rotating to next provider.",
      reason,
      isTransient,
    };
  }

  if (statusCode === 402) {
    return {
      type: LLMErrorType.BILLING,
      retryable: false,
      shouldCompact: false,
      shouldRotateAuth: true,
      shouldSkipProvider: true,
      backoffMs: 0,
      message: "Billing issue. Rotating to next provider.",
      reason,
      isTransient,
    };
  }

  // ── fix-1: 413 请求体过大（transient，需压缩后重试） ──
  if (statusCode === 413) {
    return {
      type: LLMErrorType.PAYLOAD_TOO_LARGE,
      retryable: true,
      shouldCompact: true, // 触发压缩以缩小请求体
      shouldRotateAuth: false,
      shouldSkipProvider: false,
      backoffMs: applyBackoffJitter(1000),
      message: "Payload too large (413). Compacting conversation before retry.",
      reason: "payload_too_large",
      isTransient: true,
    };
  }

  // ── fix-1: 404 优先匹配 model_not_found 模式 ──
  if (statusCode === 404) {
    for (const pattern of MODEL_NOT_FOUND_PATTERNS) {
      if (pattern.test(lower)) {
        return {
          type: LLMErrorType.MODEL_NOT_FOUND,
          retryable: false,
          shouldCompact: false,
          shouldRotateAuth: false, // 模型问题与 key 无关
          shouldSkipProvider: true,
          backoffMs: 0,
          message: "Model not found. Skipping provider.",
          reason: "model_not_found",
          isTransient: false,
        };
      }
    }
    // 404 但无 model_not_found 模式：保守归类为 PROVIDER_ERROR 重试
    return {
      type: LLMErrorType.PROVIDER_ERROR,
      retryable: true,
      shouldCompact: false,
      shouldRotateAuth: false,
      shouldSkipProvider: false,
      backoffMs: applyBackoffJitter(2000),
      message: "Provider returned 404. Retrying.",
      reason,
      isTransient: true,
    };
  }

  for (const pattern of CONTEXT_OVERFLOW_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        type: LLMErrorType.CONTEXT_OVERFLOW,
        retryable: true,
        shouldCompact: true,
        shouldRotateAuth: false,
        shouldSkipProvider: false,
        backoffMs: applyBackoffJitter(1000),
        message: "Context overflow detected. Compacting conversation before retry.",
        reason,
        isTransient,
      };
    }
  }

  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(lower)) {
      const backoffMatch = lower.match(/retry.after.(\d+)/i);
      const hasRetryAfter = !!backoffMatch;
      const backoff = backoffMatch ? parseInt(backoffMatch[1], 10) * 1000 : 5000;
      return {
        type: LLMErrorType.RATE_LIMIT,
        retryable: true,
        shouldCompact: false,
        shouldRotateAuth: true,
        shouldSkipProvider: false,
        backoffMs: applyBackoffJitter(Math.min(backoff, MAX_BACKOFF_MS), hasRetryAfter),
        message: "Rate limit detected. Retrying after backoff.",
        reason,
        isTransient,
        hasRetryAfterContract: hasRetryAfter,
      };
    }
  }

  for (const pattern of AUTH_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        type: LLMErrorType.AUTH,
        retryable: false,
        shouldCompact: false,
        shouldRotateAuth: true,
        shouldSkipProvider: true,
        backoffMs: 0,
        message: "Authentication error. Skipping this provider.",
        reason,
        isTransient,
      };
    }
  }

  for (const pattern of BILLING_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        type: LLMErrorType.BILLING,
        retryable: false,
        shouldCompact: false,
        shouldRotateAuth: true,
        shouldSkipProvider: true,
        backoffMs: 0,
        message: "Billing/quota issue. Skipping this provider.",
        reason,
        isTransient,
      };
    }
  }

  for (const pattern of TIMEOUT_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        type: LLMErrorType.TIMEOUT,
        retryable: true,
        shouldCompact: false,
        shouldRotateAuth: false,
        shouldSkipProvider: false,
        backoffMs: applyBackoffJitter(2000),
        message: "Request timed out. Retrying.",
        reason,
        isTransient,
      };
    }
  }

  // ── fix-1: 模型不存在模式匹配（无 status code 时） ──
  for (const pattern of MODEL_NOT_FOUND_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        type: LLMErrorType.MODEL_NOT_FOUND,
        retryable: false,
        shouldCompact: false,
        shouldRotateAuth: false,
        shouldSkipProvider: true,
        backoffMs: 0,
        message: "Model not found. Skipping provider.",
        reason: "model_not_found",
        isTransient: false,
      };
    }
  }

  // ── fix-1: 请求体过大模式匹配（无 status code 时） ──
  for (const pattern of PAYLOAD_TOO_LARGE_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        type: LLMErrorType.PAYLOAD_TOO_LARGE,
        retryable: true,
        shouldCompact: true,
        shouldRotateAuth: false,
        shouldSkipProvider: false,
        backoffMs: applyBackoffJitter(1000),
        message: "Payload too large. Compacting conversation before retry.",
        reason: "payload_too_large",
        isTransient: true,
      };
    }
  }

  // 5xx 服务端错误：provider 内部错误，可重试。
  // 此前 5xx 落入 UNKNOWN 分支，被 llm-caller 当作成功空响应处理，
  // 导致 recordProviderSuccess 被错误调用、循环空转消耗 budget。
  if (typeof statusCode === "number" && statusCode >= 500 && statusCode < 600) {
    // ── fix-1: 5xx 中的请求验证错误识别 ──
    // 某些 provider 在 5xx 响应中返回请求格式/参数验证错误（如 "invalid request"），
    // 这种情况重试无意义，应跳过。仅在错误文本明确包含验证相关关键词时归类为 non-transient。
    if (/invalid.request|validation.error|bad.request|malformed/i.test(lower)) {
      return {
        type: LLMErrorType.PROVIDER_ERROR,
        retryable: false, // 验证错误不可重试
        shouldCompact: false,
        shouldRotateAuth: false,
        shouldSkipProvider: true,
        backoffMs: 0,
        message: `Provider returned validation error in 5xx (HTTP ${statusCode}). Skipping provider.`,
        reason: "format_error",
        isTransient: false,
      };
    }
    return {
      type: LLMErrorType.PROVIDER_ERROR,
      retryable: true,
      shouldCompact: false,
      shouldRotateAuth: false,
      shouldSkipProvider: false,
      backoffMs: applyBackoffJitter(2000),
      message: `Provider server error (HTTP ${statusCode}). Retrying.`,
      reason,
      isTransient: true,
    };
  }

  // ── fix-1: server disconnect + 大 session 启发式 ──
  // 当 provider 在流式响应中途中断（如 server disconnected）且 session 很大时，
  // 大概率是上下文超限导致 provider 中断流。此时归类为 CONTEXT_OVERFLOW 触发压缩，
  // 而非简单的网络错误重试（重试同样会中断）。
  const largeThreshold = options?.largeSessionThreshold ?? 100_000;
  const sessionTokens = options?.sessionTokens ?? 0;
  if (sessionTokens >= largeThreshold) {
    for (const pattern of SERVER_DISCONNECT_PATTERNS) {
      if (pattern.test(lower)) {
        return {
          type: LLMErrorType.CONTEXT_OVERFLOW,
          retryable: true,
          shouldCompact: true,
          shouldRotateAuth: false,
          shouldSkipProvider: false,
          backoffMs: applyBackoffJitter(1000),
          message: "Server disconnected on large session. Heuristically treating as context overflow.",
          reason: "context_overflow",
          isTransient: true,
        };
      }
    }
  }

  return {
    type: LLMErrorType.UNKNOWN,
    retryable: false,
    shouldCompact: false,
    shouldRotateAuth: false,
    shouldSkipProvider: false,
    backoffMs: 0,
    message: `Unknown error: ${combinedText.slice(0, 200)}`,
    reason,
    isTransient,
  };
}

export function isContextOverflowError(statusCode?: number, errorText?: string): boolean {
  if (!errorText) return false;
  const lower = errorText.toLowerCase();
  return CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(lower));
}

export function isRateLimitError(statusCode?: number, errorText?: string): boolean {
  if (statusCode === 429) return true;
  if (!errorText) return false;
  const lower = errorText.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((p) => p.test(lower));
}

/** fix-1: 检测是否为 content_policy 拒绝（确定性，不可重试） */
export function isContentPolicyError(statusCode?: number, errorText?: string): boolean {
  // 部分 provider 通过 451 状态码返回内容策略拒绝
  if (statusCode === 451) return true;
  if (!errorText) return false;
  const lower = errorText.toLowerCase();
  return CONTENT_POLICY_PATTERNS.some((p) => p.test(lower));
}

/** fix-1: 检测是否为 SSL/TLS 证书验证失败（fail-fast） */
export function isSslCertError(statusCode?: number, errorText?: string): boolean {
  if (!errorText) return false;
  const lower = errorText.toLowerCase();
  return SSL_CERT_PATTERNS.some((p) => p.test(lower));
}

/** fix-1: 检测是否为模型不存在错误（non-transient，应跳过 provider） */
export function isModelNotFoundError(statusCode?: number, errorText?: string): boolean {
  if (statusCode === 404) {
    if (!errorText) return true; // 404 默认按 model_not_found 处理
    const lower = errorText.toLowerCase();
    return MODEL_NOT_FOUND_PATTERNS.some((p) => p.test(lower));
  }
  if (!errorText) return false;
  const lower = errorText.toLowerCase();
  return MODEL_NOT_FOUND_PATTERNS.some((p) => p.test(lower));
}

/** fix-1: 检测是否为 OpenRouter upstream 429（不轮换 key） */
export function isUpstreamRateLimitError(errorText?: string): boolean {
  if (!errorText) return false;
  const lower = errorText.toLowerCase();
  return UPSTREAM_RATE_LIMIT_PATTERNS.some((p) => p.test(lower));
}

export function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length * 0.25);
}

export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string | null }>
): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.content) {
      total += estimateTokensFromText(msg.content);
    }
  }
  return total;
}

// ── R2-1: 错误消息友好化（借鉴 hermes-agent _content_policy_blocked_result + _exhaust_response） ──

/**
 * 用户友好的错误消息。
 *
 * 借鉴 hermes-agent conversation_loop.py 的错误消息转换层：
 *   - 把原始 provider error string 转换为用户可读的消息
 *   - 提供 action-oriented 的恢复建议
 *   - 通过 progress-drafts 上报给用户
 */
export interface UserFriendlyError {
  /** 用户可读的错误消息 */
  userMessage: string;
  /** 可操作的恢复建议（可选） */
  actionableHint?: string;
  /** 是否应通过 progress 上报给用户 */
  shouldNotifyUser: boolean;
}

/**
 * 把 ClassifiedError 转换为用户友好的错误消息。
 *
 * 借鉴 hermes-agent：
 *   - _content_policy_blocked_result：把 provider 安全拒绝转为可读消息
 *   - _exhaust_response：把 thinking budget 耗尽转为 action-oriented 建议
 *   - _tool_failure_recovery_hint：按工具名返回恢复建议
 *
 * @param error 已分类的错误
 * @param providerName provider 名称（用于消息中提及）
 * @returns 用户友好的错误消息
 */
export function formatClassifiedErrorForUser(
  error: ClassifiedError,
  providerName?: string,
): UserFriendlyError {
  const providerLabel = providerName ? `"${providerName}"` : "当前 provider";

  switch (error.type) {
    case LLMErrorType.CONTEXT_OVERFLOW:
      return {
        userMessage: "对话历史过长，已触发自动压缩。",
        actionableHint: "如频繁出现此提示，可使用 /compact 手动压缩对话历史。",
        shouldNotifyUser: true,
      };

    case LLMErrorType.RATE_LIMIT:
      return {
        userMessage: `${providerLabel} 触发了速率限制，正在等待后重试...`,
        actionableHint: "如持续出现，可切换到其他 provider（/model）或降低请求频率。",
        shouldNotifyUser: true,
      };

    case LLMErrorType.AUTH:
      return {
        userMessage: `${providerLabel} 认证失败，已自动切换到下一个 provider。`,
        actionableHint: "请检查 API key 配置（.env 文件或 /config 命令）。",
        shouldNotifyUser: true,
      };

    case LLMErrorType.BILLING:
      return {
        userMessage: `${providerLabel} 账户余额不足，已自动切换到下一个 provider。`,
        actionableHint: "请充值或更换 provider。",
        shouldNotifyUser: true,
      };

    case LLMErrorType.TIMEOUT:
      return {
        userMessage: `${providerLabel} 请求超时，正在重试...`,
        actionableHint: "如持续超时，可尝试切换模型或简化请求。",
        shouldNotifyUser: false, // 超时重试是常规操作，不打扰用户
      };

    case LLMErrorType.NETWORK:
      return {
        userMessage: `网络连接错误（${error.message.slice(0, 100)}），正在重试...`,
        actionableHint: "请检查网络连接和代理配置。",
        shouldNotifyUser: false, // 网络错误重试不打扰
      };

    case LLMErrorType.CONTENT_POLICY:
      return {
        userMessage: `${providerLabel} 的安全过滤器拒绝了请求。`,
        actionableHint: "建议改写请求措辞、缩小上下文范围，或切换到其他 provider。",
        shouldNotifyUser: true,
      };

    case LLMErrorType.SSL_CERT:
      return {
        userMessage: `TLS 证书验证失败（不可重试）。`,
        actionableHint: "请检查 CA 证书配置或代理设置。如使用自签名证书，需配置 NODE_EXTRA_CA_CERTS。",
        shouldNotifyUser: true,
      };

    case LLMErrorType.MODEL_NOT_FOUND:
      return {
        userMessage: `模型不存在，已自动 fallback 到下一个 provider。`,
        actionableHint: "请检查模型名称配置（/config 或 .env）。",
        shouldNotifyUser: true,
      };

    case LLMErrorType.PAYLOAD_TOO_LARGE:
      return {
        userMessage: "请求体过大，正在压缩对话历史后重试...",
        actionableHint: "如频繁出现，可使用 /compact 手动压缩或减少单次输入长度。",
        shouldNotifyUser: true,
      };

    case LLMErrorType.PROVIDER_POLICY:
      return {
        userMessage: `${providerLabel} 的账户策略阻止了请求。`,
        actionableHint: "请联系 provider 管理员或切换到其他 provider。",
        shouldNotifyUser: true,
      };

    case LLMErrorType.PROVIDER_ERROR:
      return {
        userMessage: `${providerLabel} 返回了服务器错误（5xx），正在重试...`,
        actionableHint: "如持续出现，provider 可能暂时不可用，建议切换到其他 provider。",
        shouldNotifyUser: false, // 5xx 重试不打扰
      };

    case LLMErrorType.UNKNOWN:
    default:
      return {
        userMessage: `发生未知错误：${error.message.slice(0, 200)}`,
        actionableHint: "可尝试重试或切换 provider。如问题持续，请通过 /feedback 反馈。",
        shouldNotifyUser: true,
      };
  }
}