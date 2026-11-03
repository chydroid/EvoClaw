/**
 * @evoclaw/infrastructure/errors — 统一错误处理模块
 *
 * 合并三处现有错误处理：
 * - packages/agent/src/error-classifier.ts（LLMErrorType 14 类 + classifyLLMError）
 * - packages/agent/src/skill-dispatch-error-handler.ts（skill 6 类 pattern）
 * - packages/gateway/src/gateway-server.ts + protocol-adapter.ts（handleError 500 JSON）
 *
 * 使用方式见 /tmp/evoclaw-refactor/design.md
 */

// ── 统一 ErrorCode（吸收 LLMErrorType + skill category + gateway 通用错误） ──
export type ErrorCode =
  | "timeout"
  | "network"
  | "auth"
  | "rate_limit"
  | "context_overflow"
  | "content_policy"
  | "ssl_cert"
  | "model_not_found"
  | "payload_too_large"
  | "provider_policy"
  | "billing"
  | "abort"
  | "skill_failure"
  | "unknown";

export type ErrorDomain = "llm" | "skill" | "gateway";

export interface ClassifiedError {
  code: ErrorCode;
  retryable: boolean;
  backoffMs: number;
  message: string;
  /** 是否为瞬时错误（可重试） */
  isTransient?: boolean;
  /** 是否有 Retry-After 契约（影响 jitter） */
  hasRetryAfterContract?: boolean;
  /** 是否跳过当前 provider 并 fallback（non-transient） */
  shouldSkipProvider?: boolean;
  /** 原始 cause */
  cause?: unknown;
  /** 来源域信息（provider 名 / skill 名 / 路由路径等） */
  context: Record<string, unknown>;
  /** 原始 domain，保留旧语义（skill 的 shouldFallbackToLLM 等） */
  domain?: ErrorDomain;
}

export interface UserFriendlyError {
  userMessage: string;
  actionableHint?: string;
  notify: boolean;
}

export interface HttpResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface ClassifyInput {
  statusCode?: number;
  message?: string;
  cause?: unknown;
  domain: ErrorDomain;
  context?: Record<string, unknown>;
}

export interface ErrorHandlerOptions {
  /** 注入 Observability，用于 onClassified 指标/日志（best-effort） */
  observability?: unknown;
}

export interface ErrorHandler {
  classify(input: ClassifyInput): ClassifiedError;
  forUser(e: ClassifiedError): UserFriendlyError;
  toHttpResponse(e: ClassifiedError, isProd: boolean): HttpResponse;
  /** 副作用钩子：默认接 obs + stderr；可覆写 */
  onClassified?: (e: ClassifiedError) => void;
  /** 供 agent fallback 使用：non-transient 返回 true */
  shouldSkipProvider(e: ClassifiedError): boolean;
}

// ── 核心实现 ────────────────────────────────────────────────

const MAX_BACKOFF_MS = 60_000;

function applyBackoffJitter(base: number, hasRetryAfterContract: boolean): number {
  // 与 llm-caller.ts 中 jitteredBackoff 语义一致：
  // 有 Retry-After 契约时用全 jitter；无契约时用等比例抖动
  if (hasRetryAfterContract) {
    return Math.floor(base * (0.5 + Math.random() * 0.5));
  }
  return Math.floor(base * (0.7 + Math.random() * 0.3));
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause ?? "unknown error");
}

function classifyByPatterns(input: ClassifyInput): ClassifiedError {
  const text = [input.message, messageOf(input.cause)].filter(Boolean).join(" ").toLowerCase();

  // fail-fast 类（non-transient，跳过 provider）
  if (/cert|ssl|self.signed|unable to verify/i.test(text)) {
    return { code: "ssl_cert", retryable: false, backoffMs: 0, shouldSkipProvider: true, message: "SSL/TLS certificate verification failed", cause: input.cause, context: input.context ?? {} };
  }
  if (/content.policy|safety.filter|blocked by policy|nsfw/i.test(text)) {
    return { code: "content_policy", retryable: false, backoffMs: 0, shouldSkipProvider: true, message: "Content policy blocked", cause: input.cause, context: input.context ?? {} };
  }
  if (/data.policy|privacy.policy|provider.policy/i.test(text)) {
    return { code: "provider_policy", retryable: false, backoffMs: 0, shouldSkipProvider: true, message: "Provider policy blocked", cause: input.cause, context: input.context ?? {} };
  }
  if (/model.?not.?found|no such model|unknown model/i.test(text)) {
    return { code: "model_not_found", retryable: false, backoffMs: 0, shouldSkipProvider: true, message: "Model not found", cause: input.cause, context: input.context ?? {} };
  }
  if (/abort(ed|ed?)/i.test(text) && input.statusCode === undefined) {
    // 用户/系统主动取消，非 provider 错误
    return { code: "abort", retryable: false, backoffMs: 0, message: "Request aborted", cause: input.cause, context: input.context ?? {} };
  }
  if (/billing|insufficient quota|out of credit/i.test(text)) {
    return { code: "billing", retryable: false, backoffMs: 0, shouldSkipProvider: true, message: "Billing/quota failure", cause: input.cause, context: input.context ?? {} };
  }

  // 429 类（transient，等待后重试）
  if (input.statusCode === 429 || /rate.?limit|too many requests|throttl|429/i.test(text)) {
    const retryAfterMatch = text.match(/retry.after.? ?(\d+)/i);
    const retryAfterSeconds = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) : 0;
    const hasContract = retryAfterSeconds > 0;
    const base = hasContract ? Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS) : 5000;
    return {
      code: "rate_limit",
      retryable: true,
      backoffMs: applyBackoffJitter(base, hasContract),
      isTransient: true,
      hasRetryAfterContract: hasContract,
      shouldSkipProvider: false,
      message: "Rate limit exceeded",
      cause: input.cause,
      context: input.context ?? {},
    };
  }

  // 401/403 类（auth）
  if (input.statusCode === 401 || input.statusCode === 403 || /unauthorized|forbidden|invalid (api )?key|auth(entication)? (failed|error)/i.test(text)) {
    return { code: "auth", retryable: false, backoffMs: 0, shouldSkipProvider: true, message: "Authentication failed", cause: input.cause, context: input.context ?? {} };
  }

  // 413 类（payload too large）
  if (input.statusCode === 413 || /payload too large|request body too large/i.test(text)) {
    return { code: "payload_too_large", retryable: true, backoffMs: 0, isTransient: true, message: "Request payload too large", cause: input.cause, context: input.context ?? {} };
  }

  // 413/上下文溢出类
  if (/context(\\.length)? exceeded|request_too_large|input is too long|maximum.context/i.test(text)) {
    return { code: "context_overflow", retryable: false, backoffMs: 0, message: "Context window exceeded", cause: input.cause, context: input.context ?? {} };
  }

  // 网络/超时类（transient）
  if (input.statusCode === 408 || /timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(text)) {
    return { code: "timeout", retryable: true, backoffMs: applyBackoffJitter(5000, false), isTransient: true, message: "Request timed out", cause: input.cause, context: input.context ?? {} };
  }
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network error|DNS resolution failed/i.test(text)) {
    return { code: "network", retryable: true, backoffMs: applyBackoffJitter(3000, false), isTransient: true, message: "Network error", cause: input.cause, context: input.context ?? {} };
  }

  // skill 域专用
  if (input.domain === "skill" && input.statusCode === undefined) {
    return { code: "skill_failure", retryable: false, backoffMs: 0, message: messageOf(input.cause), cause: input.cause, context: input.context ?? {}, domain: "skill" };
  }

  // 兜底
  return { code: "unknown", retryable: false, backoffMs: 0, message: messageOf(input.cause), cause: input.cause, context: input.context ?? {}, domain: input.domain };
}

// ── 用户友好呈现 ─────────────────────────────────────────────
function forUserImpl(e: ClassifiedError): UserFriendlyError {
  const label = String(e.context?.provider ?? e.context?.route ?? "当前服务");
  switch (e.code) {
    case "context_overflow":
      return { userMessage: "对话历史过长，已触发自动压缩。", actionableHint: "如频繁出现此提示，可手动压缩对话历史。", notify: true };
    case "rate_limit":
      return { userMessage: `${label} 触发速率限制，正在等待后重试...`, actionableHint: "如持续出现，可切换到其他 provider 或降低请求频率。", notify: true };
    case "auth":
      return { userMessage: `${label} 认证失败，已自动切换到下一个 provider。`, actionableHint: "请检查 API key 配置。", notify: true };
    case "timeout":
      return { userMessage: `${label} 响应超时，正在重试...`, notify: false };
    case "network":
      return { userMessage: `${label} 网络异常，正在重试...`, notify: false };
    case "skill_failure":
      return { userMessage: "技能执行失败，正在尝试其他方式继续处理...", notify: true };
    default:
      return { userMessage: `服务调用失败：${e.message}`, notify: true };
  }
}

// ── HTTP 响应（与 gateway-server.handleError 行为等价） ─────
function toHttpResponseImpl(e: ClassifiedError, isProd: boolean): HttpResponse {
  // 非 5xx 类错误映射到语义化状态码
  let status = 500;
  if (e.code === "rate_limit") status = 429;
  else if (e.code === "timeout") status = 504;
  else if (e.code === "auth") status = 401;
  else if (e.code === "payload_too_large") status = 413;

  return {
    status,
    body: {
      error: status === 500 ? "Internal Server Error" : e.message,
      code: e.code,
      ...(isProd ? {} : { message: e.message }), // 生产隐藏内部 message
    },
  };
}

// ── 工厂 ─────────────────────────────────────────────────────
export function createErrorHandler(opts?: ErrorHandlerOptions): ErrorHandler {
  return {
    classify: (input) => classifyByPatterns(input),
    forUser: forUserImpl,
    toHttpResponse: (e, isProd) => toHttpResponseImpl(e, isProd),
    shouldSkipProvider: (e) => e.shouldSkipProvider === true || e.code === "auth" || e.code === "billing" || e.code === "ssl_cert" || e.code === "model_not_found" || e.code === "content_policy" || e.code === "provider_policy",
    onClassified: (e) => {
      // best-effort：默认接 stderr；obs 指标由调用方自行注入
      try {
        process.stderr.write(`[ErrorHandler] ${e.code} — ${e.message}\n`);
      } catch { /* observability is best-effort */ }
      void opts?.observability;
    },
  };
}

// ── 向后兼容：LLMErrorType 枚举值映射（供 error-classifier.ts 薄包装使用） ──
export const LLM_ERROR_CODE_MAP: Record<string, ErrorCode> = {
  context_overflow: "context_overflow",
  rate_limit: "rate_limit",
  auth: "auth",
  billing: "billing",
  timeout: "timeout",
  network: "network",
  provider_error: "unknown",
  unknown: "unknown",
  abort: "abort",
  content_policy: "content_policy",
  ssl_cert: "ssl_cert",
  model_not_found: "model_not_found",
  payload_too_large: "payload_too_large",
  provider_policy: "provider_policy",
};
