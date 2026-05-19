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

export function classifyLLMError(
  statusCode?: number,
  errorText?: string,
  errorMessage?: string
): ClassifiedError {
  const combinedText = [errorText, errorMessage].filter(Boolean).join(" ");
  const lower = combinedText.toLowerCase();

  if (statusCode === 429) {
    return {
      type: LLMErrorType.RATE_LIMIT,
      retryable: true,
      shouldCompact: false,
      shouldRotateAuth: true,
      backoffMs: 5000,
      message: "Rate limit exceeded. Rotating to next provider.",
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
    };
  }

  for (const pattern of CONTEXT_OVERFLOW_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        type: LLMErrorType.CONTEXT_OVERFLOW,
        retryable: true,
        shouldCompact: true,
        shouldRotateAuth: false,
        backoffMs: 1000,
        message: "Context overflow detected. Compacting conversation before retry.",
      };
    }
  }

  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(lower)) {
      const backoffMatch = lower.match(/retry.after.(\d+)/i);
      const backoff = backoffMatch ? parseInt(backoffMatch[1], 10) * 1000 : 5000;
      return {
        type: LLMErrorType.RATE_LIMIT,
        retryable: true,
        shouldCompact: false,
        shouldRotateAuth: true,
        backoffMs: Math.min(backoff, 30000),
        message: "Rate limit detected. Retrying after backoff.",
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
        backoffMs: 2000,
        message: "Request timed out. Retrying.",
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