import { applyJitter } from "./retry-utils";
import {
  resolveFailoverReason,
  isTransientReason,
  isAccountWallText,
  isUpstreamBlockedText,
  CONTENT_POLICY_BLOCKED_PATTERNS,
  MODEL_NOT_FOUND_PATTERNS as MODEL_NOT_FOUND_PATTERNS_TEXT,
  type FailoverReason,
} from "./failover-policy";

export enum LLMErrorType {
  CONTEXT_OVERFLOW = "context_overflow",
  RATE_LIMIT = "rate_limit",
  AUTH = "auth",
  BILLING = "billing",
  TIMEOUT = "timeout",
  NETWORK = "network",
  PROVIDER_ERROR = "provider_error",
  UNKNOWN = "unknown",
  // ★ 2026-10-30 新增：用户/系统主动取消（abort），不是 provider 错误。
  // 此前 "Request aborted" 被 TIMEOUT_PATTERNS 的 /abort/i 吞掉 → 走 overload
  // ladder（6s/14s/27s 退避）+ circuit breaker（30s 冷却）≈ 50-77s 浪费/次，
  // 还会误触熔断器把健康 provider 排除（v7 压测 Task 1/10 实证）。
  ABORT = "abort",
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
  /** ★ hermes 对齐 R10：max_tokens 超过 provider 输出上限（transient，clamp 后原地重试） */
  OUTPUT_CAP = "output_cap",
  /** ★ v36 对齐 hermes `upstream_blocked`：403 来自 provider 前方的 WAF/CDN/代理
   *  （凭证根本没到达 provider，key 健康；换人但不熔断、不给 key 指引） */
  UPSTREAM_BLOCKED = "upstream_blocked",
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
  /** ★ v36（hermes `_ABORT_FALLBACK` 等价）：确定性地换下一个 provider，但
   *  **不熔断、不写 skip list**。用于「本 provider 拒绝了这一份请求，但凭证/服务
   *  本身未必有问题」的 403 家族（裸 403、WAF 拦截）。与 `shouldSkipProvider`
   *  互斥——后者会把 provider 拉黑 300s。 */
  shouldFallbackWithoutBench?: boolean;
  /** 是否应剥离 thinking 块后重试（fix-1，对应 thinking_signature reason） */
  shouldStripThinking?: boolean;
  /** 是否应将 tool 消息列表内容降级为纯文本后重试（fix-1） */
  shouldFlattenToolContent?: boolean;
  /** ★ hermes 对齐 R10：output_cap 错误时从错误文本解析出的 provider 输出上限（token 数） */
  parsedOutputCap?: number;
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

/**
 * Provider 安全过滤器拒绝模式（确定性，不可重试，应立即 fallback）。
 *
 * ★ 2026-11-26（v34 治本）：措辞表**唯一真相**在
 *   `failover-policy.ts:CONTENT_POLICY_BLOCKED_PATTERNS`（对标 hermes 的
 *   `_CONTENT_POLICY_BLOCKED_PATTERNS`）。这里只保留 EvoClaw 历史上额外的
 *   正则形态（更宽松的动词/名词搭配），由同一张字面表派生，避免两份清单
 *   再次漂移——此前 failover-policy 用子串、本文件用正则，`our safety system`
 *   只在后者缺席，403 安全拒绝被误判 AUTH（实测 13 次）。
 *
 * 纪律：绝不加入泛化词 "policy"——它会与 billing/auth 撞车（见下方回归测试）。
 */
const CONTENT_POLICY_PATTERNS: RegExp[] = [
  /content.*policy/i,
  /safety.filter/i,
  /safety.guardrail/i,
  // 从字面表派生：把每个短语转成「词间可有任意非字母分隔」的正则
  ...CONTENT_POLICY_BLOCKED_PATTERNS.map(
    (p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s._-]*"), "i"),
  ),
  /content_policy_violation/i,
  /inappropriate.content/i,
  /harmful.content/i,
  /refusing.to.generate/i,
];

/** 模型不存在模式（non-transient，应跳过该 provider）。
 *
 * ★ 2026-11-26（v34 治本）：字面表**唯一真相**在
 *   `failover-policy.ts:MODEL_NOT_FOUND_PATTERNS`（对标 hermes 的
 *   `_MODEL_NOT_FOUND_PATTERNS`）。此处派生为「词间可有任意非字母分隔」的正则，
 *   并保留 EvoClaw 历史上额外的正则形态。
 *
 *   此前两份清单语义矛盾：resolveFailoverReason(404, 下线措辞) 说
 *   model_not_found，本文件的 404 分支却因匹配不到而返回 retryable 的
 *   PROVIDER_ERROR → 已下线的 slug 被过载阶梯反复重试。
 */
const MODEL_NOT_FOUND_PATTERNS: RegExp[] = [
  ...MODEL_NOT_FOUND_PATTERNS_TEXT.map(
    (p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s._-]*"), "i"),
  ),
  // EvoClaw 额外形态（措辞表未覆盖的变体）
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
  /no.route.matched/i,
  /route.*not.found/i,
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

// ★ 2026-10-30：abort 模式——必须在 TIMEOUT_PATTERNS 之前匹配，
// 否则 /abort/i 会把它吞进 TIMEOUT → 走退避阶梯 + 熔断器，浪费 50-77s/次。
const ABORT_PATTERNS = [
  /request aborted/i,
  /aborterror/i,
  /this operation was aborted/i,
  /aborted due to/i,
  /aborted by/i,
  /aborted at/i,
  /signal.*abort/i,
  /^aborted$/i,           // controller.abort(new Error("aborted")) → 裸 "aborted"
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
  // ★ 2026-11-26（v34 同类治本）：451 = Unavailable For Legal Reasons，
  //   定义上就是内容/法律性拒绝。isContentPolicyError() 早已特判 451，
  //   但主分类器此前没有对应分支 → 451 落到 unknown/transient，被反复重试
  //   且换 provider 重发同一提示词（必然再被拒）。与措辞表同源处理。
  if (statusCode === 451) {
    return {
      type: LLMErrorType.CONTENT_POLICY,
      retryable: false,
      shouldCompact: false,
      shouldRotateAuth: false,
      shouldSkipProvider: true,
      backoffMs: 0,
      message: "Content policy blocked (HTTP 451). Skipping provider (deterministic refusal).",
      reason: "content_policy_blocked",
      isTransient: false,
    };
  }
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
    // ── ★ v36 同类治本，对标 hermes `_status_403` / `_V_AUTH_FALLBACK` ──
    // 403 有三种语义（此前一律 auth + skip 300s）：
    //   ① 额度/账户墙 → billing（充值/换额度才有救）；
    //   ② provider 前方的 WAF/CDN 挑战页 → upstream_blocked（凭证没到 provider）；
    //   ③ 其余 403 → auth，但 hermes 明确**不熔断**（`_V_AUTH_FALLBACK`：
    //      retryable=False, should_fallback=True, should_rotate=False）——
    //      403 常常是「本次请求形态/网关策略」而非「这个 provider 挂了」。
    // 401 仍是确定的凭证失败，保持跳过。
    // v35 实测：magpie 一次**空响应体**的 403 被判 auth → skip list 300s，
    // 同 session 后续 6 次请求全部跳过健康 provider。
    if (statusCode === 403) {
      if (isAccountWallText(combinedText)) {
        return {
          type: LLMErrorType.BILLING,
          retryable: false,
          shouldCompact: false,
          shouldRotateAuth: true,
          shouldSkipProvider: true,
          backoffMs: 0,
          message: "Account/quota wall on HTTP 403. Rotating to next provider.",
          reason: "billing",
          isTransient: false,
        };
      }
      if (isUpstreamBlockedText(combinedText)) {
        return {
          type: LLMErrorType.UPSTREAM_BLOCKED,
          retryable: false,
          shouldCompact: false,
          shouldRotateAuth: false,
          shouldSkipProvider: false,
          shouldFallbackWithoutBench: true,
          backoffMs: 0,
          message: "Blocked by a WAF/CDN in front of the provider (HTTP 403). Key is likely fine; falling back.",
          reason: "upstream_blocked",
          isTransient: false,
        };
      }
      // 裸 403（含空响应体）：换人继续，但不计入 provider 健康度、不进 skip list。
      return {
        type: LLMErrorType.AUTH,
        retryable: false,
        shouldCompact: false,
        shouldRotateAuth: false,
        shouldSkipProvider: false,
        shouldFallbackWithoutBench: true,
        backoffMs: 0,
        message: "Provider declined this request (HTTP 403) without naming a credential problem. Falling back without benching.",
        reason,
        isTransient: false,
      };
    }
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
    // 404 但措辞不匹配任何模式：**仍归 model_not_found**。
    //
    // ★ 2026-11-26（v34 实证，与 content-policy 同一类「双份清单漂移」）：
    //   此前这里返回 `{ type: PROVIDER_ERROR, retryable: true, isTransient: true,
    //   reason: "model_not_found" }` —— 对象自相矛盾（reason 是 non-transient，
    //   却标可重试），且与 `resolveFailoverReason(404)` 的判定相反。实测
    //   OpenRouter 下线 slug 的 404 措辞（"…is no longer available…no provider
    //   serves this model anymore"）未命中模式 → 走此分支 → 过载阶梯重试
    //   27 次 + 熔断，白烧 6s/11s/27s。
    //   现在与 failover-policy 同判：404 = 该 provider 上没有这个模型/路由
    //   （含 baseURL 拼错、网关路径不存在），重试无意义，跳过该 provider。
    return {
      type: LLMErrorType.MODEL_NOT_FOUND,
      retryable: false,
      shouldCompact: false,
      shouldRotateAuth: false,
      shouldSkipProvider: true,
      backoffMs: 0,
      message: "Provider returned 404 (no model/route at this path). Skipping provider.",
      reason: "model_not_found",
      isTransient: false,
    };
  }

  // ── ★ hermes 对齐 R10（is_output_cap_error 语义移植）：output-cap 门 ──
  // 必须在 CONTEXT_OVERFLOW 之前：OpenAI 式 "max_tokens is too large... reduce
  // the length" 会同时命中 /reduce.the.length/i 与 /token.limit/i → 被误判成
  // context_overflow → 触发压缩。但压缩改不了 max_tokens，同一错误会反复进压
  // 缩器形成死循环（hermes model_metadata.py 注释明言的陷阱）。
  // 判别：错误把 max_tokens 当作 cap/range/limit 描述（而非描述输入超长）→
  // output_cap。resolveFailoverReason 已先行识别一部分，这里补通用词表。
  if (isOutputCapError(statusCode, combinedText)) {
    return {
      type: LLMErrorType.OUTPUT_CAP,
      retryable: true,
      shouldCompact: false,
      shouldRotateAuth: false,
      shouldSkipProvider: false,
      backoffMs: applyBackoffJitter(500),
      message: "Output cap (max_tokens) exceeds provider limit. Clamping max_tokens before retry.",
      reason: "output_cap",
      isTransient: true,
      parsedOutputCap: parseAvailableOutputTokens(combinedText) ?? undefined,
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

  // ★ 2026-10-30：abort 检测——必须在 TIMEOUT_PATTERNS 之前。
  // abort 是用户/系统主动取消（软超时暂停、客户端断开、/cancel），
  // 不是 provider 错误：不退避、不 failover、不触发熔断器。
  // 返回 retryable:false + backoffMs:0，由 caller 层 break 出 provider 循环，
  // 交给 round 顶部的 abortSignal 检查统一处理取消。
  for (const pattern of ABORT_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        type: LLMErrorType.ABORT,
        retryable: false,
        shouldCompact: false,
        shouldRotateAuth: false,
        shouldSkipProvider: false,
        backoffMs: 0,
        message: "Request aborted (deliberate cancellation). Not a provider error.",
        reason: "aborted",
        isTransient: false,
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

  // 408 Request Timeout 是 4xx 里唯一语义上"重发可能成功"的（上游排队超时），
  // 必须在下面的通用 4xx 兜底之前拦下，否则会被当成 format_error 跳过 provider。
  if (statusCode === 408) {
    return {
      type: LLMErrorType.TIMEOUT,
      retryable: true,
      shouldCompact: false,
      shouldRotateAuth: false,
      shouldSkipProvider: false,
      backoffMs: applyBackoffJitter(2000),
      message: "Request timeout (HTTP 408). Retrying after backoff.",
      reason: "timeout",
      isTransient: true,
    };
  }

  // ── ★ 2026-11-27（v35 同类治本，对标 hermes `_by_status` 默认值）──
  // hermes: `default = _V_FORMAT_ERROR if 400 <= status < 500 else ...`。
  // 此前这里没有 4xx 兜底：未单列的 4xx（400/405/415/431…）落到 UNKNOWN
  // （retryable:false 但 caller 仍 recordProviderSuccess → 空响应空转），
  // 或落进措辞匹配被当成 `unclassified`（transient）→ 过载阶梯 + 熔断
  // 反复重发**同一份必然再被拒的请求体**。实测（v35）一次 400 会白烧
  // 3 次重试 + 一次 failover 才收敛。
  // 4xx 语义即「客户端请求形态有问题」：不可重试，跳过该 provider。
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    // hermes `_classify_400` 尾部启发式：错误体泛泛（短/空/仅 "error"）且
    // session 很大时，大概率是「上下文太长」被网关笼统拒绝——压缩才有救，
    // 按 format_error 跳过 provider 反而会丢掉唯一可行的恢复路径。
    const bodyMsg = combinedText.trim().toLowerCase();
    const isGenericBody = bodyMsg.length < 30 || bodyMsg === "error" || bodyMsg === "";
    const large4xxThreshold = options?.largeSessionThreshold ?? 100_000;
    if (isGenericBody && (options?.sessionTokens ?? 0) >= large4xxThreshold) {
      return {
        type: LLMErrorType.CONTEXT_OVERFLOW,
        retryable: true,
        shouldCompact: true,
        shouldRotateAuth: false,
        shouldSkipProvider: false,
        backoffMs: applyBackoffJitter(1000),
        message: `Generic ${statusCode} on large session. Heuristically treating as context overflow.`,
        reason: "context_overflow",
        isTransient: true,
      };
    }
    // 注意：用上面已解析的 `reason`，不要写死 "format_error"。provider 专属
    // 规则（thinking_signature / multimodal_tool_content_unsupported /
    // image_too_large / provider_policy_blocked …）在 resolveFailoverReason
    // 里先于状态码默认值命中，与 hermes `_classify_400` 的判定顺序一致；
    // 写死会覆盖掉这些更精确的恢复路径。
    return {
      type: LLMErrorType.PROVIDER_ERROR,
      retryable: false,
      shouldCompact: false,
      shouldRotateAuth: false,
      shouldSkipProvider: true,
      backoffMs: 0,
      message: `Request rejected by provider (HTTP ${statusCode}, ${reason}). Skipping provider.`,
      reason,
      isTransient: false,
    };
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
    // ── 过载 / 超时细分（2026-10-18，对齐 hermes 瞬时过载自动恢复阶梯）──
    // 503 常由过载（overloaded）导致，504/529 多为上游超时。归入 overloaded/timeout
    // 让恢复阶梯（overload-recovery）按 Retry-After 或 15s→60s 退避原地重试，
    // 而不是走 2s 短退避后 failover 到下一个 provider。
    if (statusCode === 503) {
      return {
        type: LLMErrorType.PROVIDER_ERROR,
        retryable: true,
        shouldCompact: false,
        shouldRotateAuth: false,
        shouldSkipProvider: false,
        backoffMs: applyBackoffJitter(5000),
        message: `Provider overloaded (HTTP 503). Waiting before retry in place.`,
        reason: "overloaded",
        isTransient: true,
      };
    }
    if (statusCode === 504 || statusCode === 529) {
      return {
        type: LLMErrorType.TIMEOUT,
        retryable: true,
        shouldCompact: false,
        shouldRotateAuth: false,
        shouldSkipProvider: false,
        backoffMs: applyBackoffJitter(5000),
        message: `Provider gateway/upstream timeout (HTTP ${statusCode}). Retrying after backoff.`,
        reason: statusCode === 529 ? "overloaded" : "timeout",
        isTransient: true,
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

  // ── ★ 2026-11-27（v35，对标 hermes `_V_UNKNOWN`）──
  // hermes: `_V_UNKNOWN = _v(_R.unknown)` —— retryable 默认 True
  // （"Unclassifiable — retry with backoff"），should_fallback 不设。
  // 此前这里 retryable:false + backoffMs:0，而 llm-caller 又把 UNKNOWN
  // 排除在错误分支之外 → 落进**成功路径**（recordProviderSuccess +
  // consecutiveErrors=0）→ 空回复空转，永不 failover（v35 线上 400 的
  // 放大器）。语义上「无法归类」恰恰意味着「不能断定重发无意义」，
  // 正确处置是退避后重试同 provider，耗尽再交给 fallback 链。
  return {
    type: LLMErrorType.UNKNOWN,
    retryable: true,
    shouldCompact: false,
    shouldRotateAuth: false,
    shouldSkipProvider: false,
    backoffMs: applyBackoffJitter(2000),
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

// ── ★ hermes 对齐 R10（model_metadata.py is_output_cap_error 语义移植）──────
//
// output-cap 400：请求里的 max_tokens 超过 provider 的输出上限。
// Hermes 注释明言的陷阱：若把这类 400 误分类为 context_overflow，
// 会触发压缩——但压缩改不了 max_tokens，同一错误反复进压缩器形成死循环。
//
// 判别式（hermes _OUTPUT_CAP_SIGNALS / _INPUT_OVERFLOW_SIGNALS 语义）：
//   cap 信号 = 错误把 max_tokens 描述为上限/范围/超限（且通常给出合法范围）
//   input 信号 = 错误描述「输入/上下文/prompt 超长」（这才是真 overflow）
// 命中 cap 信号且不含 input 信号 → output_cap。

/** max_tokens 被当作上限描述的信号（cap/range/limit 语义）。 */
const OUTPUT_CAP_SIGNALS = [
  /max_tokens.{0,40}(too large|too big|exceed|exceeds|invalid|must be|should be|is greater than|above|over)/i,
  /max_tokens.{0,40}(less than|at most|no more than|maximum of|up to|max\.? of)\s*\d+/i,
  /max_tokens.is higher than/i,
  /max_completion_tokens.{0,40}(exceed|invalid|must be|too large)/i,
  /max_output_tokens.{0,40}(exceed|invalid|must be|too large)/i,
  /(output|completion).{0,20}token.{0,20}(limit|cap|maximum)/i,
  /max_tokens.is too large/i,
];

/** 描述输入/上下文超长的信号（真 overflow，非 output-cap）。 */
const INPUT_OVERFLOW_SIGNALS = [
  /input.{0,30}(too long|exceeds|too many)/i,
  /context.{0,30}(length|window|exceed|full)/i,
  /prompt.{0,30}(too long|exceeds)/i,
  /maximum context length/i,
];

/**
 * 判断是否为 output-cap 错误（max_tokens 超上限）。
 * 必须先于 CONTEXT_OVERFLOW 判定调用（同一文本可能同时含
 * "reduce the length" 类词——那是让减小 max_tokens，不是让压缩上下文）。
 */
export function isOutputCapError(statusCode?: number, errorText?: string): boolean {
  if (!errorText) return false;
  // output-cap 几乎都是 400（部分 provider 用 422）
  if (statusCode !== undefined && statusCode !== 400 && statusCode !== 422) return false;
  const lower = errorText.toLowerCase();
  // 明确描述输入超长 → 真 overflow，不是 output-cap
  if (INPUT_OVERFLOW_SIGNALS.some((p) => p.test(lower))) return false;
  return OUTPUT_CAP_SIGNALS.some((p) => p.test(lower));
}

/**
 * 从错误文本解析 provider 声明的输出上限数字
 * （hermes parse_available_output_tokens_from_error 语义移植，覆盖常见措辞）：
 *   - "max_tokens must be less than 65536"
 *   - "max_tokens is too large: 1000000. Maximum is 32768"
 *   - "max_tokens can be up to 8192"
 *   - "maximum output tokens is 16384"
 */
export function parseAvailableOutputTokens(errorText?: string): number | null {
  if (!errorText) return null;
  const patterns = [
    /maximum is (\d{3,})/i,
    /max(?:imum)?(?:\.|:)?\s*(?:is|of|allowed)?\s*(\d{3,})/i,
    /less than or equal to (\d{3,})/i,
    /at most (\d{3,})/i,
    /up to (\d{3,})/i,
    /no more than (\d{3,})/i,
    /must be (?:less than|below|under|at most|max(?:imum)?)\s*(\d{3,})/i,
    /(\d{3,})\s*tokens?\b/i,
  ];
  for (const p of patterns) {
    const m = errorText.match(p);
    if (m) {
      const n = parseInt(m[1], 10);
      // 合理性：输出上限至少 64，至多 10M（滤掉误抓的 HTTP 状态码/请求 id）
      if (n >= 64 && n <= 10_000_000) return n;
    }
  }
  return null;
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
 * @param hasNextProvider 是否还有下一个候选 provider（决定「已切换」措辞是否属实）
 * @returns 用户友好的错误消息
 */
export function formatClassifiedErrorForUser(
  error: ClassifiedError,
  providerName?: string,
  hasNextProvider: boolean = true,
): UserFriendlyError {
  const providerLabel = providerName ? `"${providerName}"` : "当前 provider";
  // 没有下一个 provider 时「已自动切换」是假话——必须如实说已无可用入口。
  const switched = hasNextProvider ? "已自动切换到下一个 provider。" : "没有其他可用的 provider 了。";

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
      // ★ v36：裸 403（未指明凭证问题）不再谎称「认证失败 / 请检查 API key」——
      //   凭证可能完全健康，只是这个 provider 拒绝了这个请求（hermes 对无措辞
      //   的 403 从不给 key 指引：`_V_AUTH_FALLBACK` 不 rotate、不 bench）。
      if (error.shouldFallbackWithoutBench) {
        return {
          userMessage: `${providerLabel} 拒绝了本次请求（HTTP 403，未说明凭证问题），${switched}`,
          actionableHint: "若所有 provider 都这样拒绝，请检查请求内容/网络出口是否被拦截；凭证本身通常无需修改。",
          shouldNotifyUser: true,
        };
      }
      return {
        userMessage: `${providerLabel} 认证失败，${switched}`,
        actionableHint: "请检查 API key 配置（.env 文件或 /config 命令）。",
        shouldNotifyUser: true,
      };

    case LLMErrorType.UPSTREAM_BLOCKED:
      return {
        userMessage: `${providerLabel} 前方的防火墙/CDN 拦截了请求（HTTP 403），${switched}`,
        actionableHint: "凭证通常没问题：多为代理/WAF 拦截。可检查网络出口或直接切换到其他 provider。",
        shouldNotifyUser: true,
      };

    case LLMErrorType.BILLING:
      return {
        userMessage: `${providerLabel} 账户余额不足，${switched}`,
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
        userMessage: `模型不存在，${hasNextProvider ? "已自动 fallback 到下一个 provider。" : "没有其他可用的 provider 了。"}`,
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
      // ★ 2026-11-27（v35）：PROVIDER_ERROR 现在同时承载 5xx（可重试）与
      // 通用 4xx（format_error，不可重试）。统一说「5xx，正在重试」是假话——
      // 用户会以为系统还在自动恢复，实际已经跳到下一个 provider 了。
      if (error.retryable) {
        return {
          userMessage: `${providerLabel} 返回了服务器错误，正在重试...`,
          actionableHint: "如持续出现，provider 可能暂时不可用，建议切换到其他 provider。",
          shouldNotifyUser: false, // 5xx 重试不打扰
        };
      }
      return {
        userMessage: `${providerLabel} 拒绝了本次请求（请求格式错误），${switched}`,
        actionableHint: "如所有 provider 都拒绝，请检查模型配置（/model）或换用其他模型。",
        shouldNotifyUser: true,
      };

    case LLMErrorType.ABORT:
      return {
        userMessage: "请求已取消（软超时暂停或用户中断）。",
        actionableHint: "任务已保存检查点，可在后台继续。输入 /resume 立即续跑。",
        shouldNotifyUser: false, // 取消是常规操作，不打扰
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