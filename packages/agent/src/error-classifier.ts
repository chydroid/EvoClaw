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

// ── Jitter 配置 ───────────────────────────────────────────
// 借鉴 openclaw 的双 jitter 模式：symmetric 用于普通退避，
// positive 用于 Retry-After 场景（保证不低于下限）。
const JITTER_FACTOR = 0.3;
const MAX_BACKOFF_MS = 30_000;

/**
 * 对 backoffMs 应用 jitter。
 * - 有 Retry-After 契约时用 positive 模式（保证不低于下限）
 * - 无契约时用 symmetric 模式（允许分散）
 */
function applyBackoffJitter(backoffMs: number, hasRetryAfter = false): number {
  const jittered = applyJitter(backoffMs, JITTER_FACTOR, hasRetryAfter ? "positive" : "symmetric");
  return Math.min(Math.max(0, jittered), MAX_BACKOFF_MS);
}

export function classifyLLMError(
  statusCode?: number,
  errorText?: string,
  errorMessage?: string
): ClassifiedError {
  const combinedText = [errorText, errorMessage].filter(Boolean).join(" ");
  const lower = combinedText.toLowerCase();

  // 解析 FailoverReason（借鉴 openclaw failover-policy）
  const reason = resolveFailoverReason(statusCode, combinedText);
  const isTransient = isTransientReason(reason);

  if (statusCode === 429) {
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
      backoffMs: 0,
      message: "Billing issue. Rotating to next provider.",
      reason,
      isTransient,
    };
  }

  for (const pattern of CONTEXT_OVERFLOW_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        type: LLMErrorType.CONTEXT_OVERFLOW,
        retryable: true,
        shouldCompact: true,
        shouldRotateAuth: false,
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
        backoffMs: applyBackoffJitter(2000),
        message: "Request timed out. Retrying.",
        reason,
        isTransient,
      };
    }
  }

  return {
    type: LLMErrorType.UNKNOWN,
    retryable: false,
    shouldCompact: false,
    shouldRotateAuth: false,
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