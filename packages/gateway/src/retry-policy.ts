/**
 * Retry Policy — exponential backoff with jitter for resilient
 * message delivery and API calls across all channels.
 *
 * Features:
 *  - Exponential backoff with configurable base delay
 *  - Jitter (full + decorrelated) to prevent thundering herd
 *  - Max retries and max delay caps
 *  - Retryable error classification
 *  - Circuit breaker integration ready
 *  - Attempt lifecycle callbacks
 *
 * Design: Independent of any specific channel or protocol. Can be
 * composed into any operation that needs retry logic.
 */

// ── Types ─────────────────────────────────────────────────

export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Base delay between retries (ms) */
  baseDelayMs: number;
  /** Maximum delay cap (ms) */
  maxDelayMs: number;
  /** Backoff multiplier (e.g., 2 = exponential) */
  backoffMultiplier: number;
  /** Jitter strategy */
  jitter: "none" | "full" | "decorrelated";
  /** Whether to retry on all errors or only classified ones */
  retryOnAllErrors: boolean;
  /** Error classifier: returns true if error is retryable */
  isRetryable?: (error: Error) => boolean;
  /** Timeout for each attempt (ms, 0 = no timeout) */
  attemptTimeoutMs: number;
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
  totalTimeMs: number;
}

export interface RetryAttempt {
  attempt: number;
  delayMs: number;
  startedAt: number;
}

export interface RetryCallbacks<T> {
  onAttempt?: (attempt: RetryAttempt) => void;
  onRetry?: (attempt: RetryAttempt, error: Error) => void;
  onSuccess?: (result: T, attempts: number) => void;
  onGiveUp?: (error: Error, attempts: number) => void;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  jitter: "decorrelated",
  retryOnAllErrors: false,
  attemptTimeoutMs: 30_000,
};

// ── Retryable Error Classification ────────────────────────

const RETRYABLE_ERROR_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EPIPE/i,
  /network error/i,
  /rate limit/i,
  /too many requests/i,
  /service unavailable/i,
  /gateway timeout/i,
  /bad gateway/i,
  /temporarily unavailable/i,
  /try again/i,
  /request timed out/i,
  /socket hang up/i,
];

/**
 * Classify whether an error is retryable based on known patterns.
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message || "";
  const name = error.name || "";

  // Always retryable error types
  if (["TimeoutError", "AbortError", "FetchError"].includes(name)) {
    return true;
  }

  // Check against known patterns
  for (const pattern of RETRYABLE_ERROR_PATTERNS) {
    if (pattern.test(message)) return true;
  }

  // HTTP 429, 502, 503, 504 status codes
  const statusMatch = message.match(/status (?:code )?(\d{3})/i);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    if ([429, 502, 503, 504].includes(status)) return true;
  }

  return false;
}

// ── Jitter Functions ──────────────────────────────────────

function fullJitter(delay: number): number {
  return Math.random() * delay;
}

function decorrelatedJitter(delay: number, baseDelay: number): number {
  return baseDelay + Math.random() * delay;
}

function computeDelay(
  attempt: number,
  config: RetryConfig,
  previousDelay?: number,
): number {
  let delay = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);

  switch (config.jitter) {
    case "full":
      delay = fullJitter(delay);
      break;
    case "decorrelated":
      delay = decorrelatedJitter(delay, previousDelay ?? config.baseDelayMs);
      break;
    default:
      break;
  }

  return Math.min(delay, config.maxDelayMs);
}

// ── Timeout Wrapper ───────────────────────────────────────

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Retry Executor ────────────────────────────────────────

export class RetryPolicy {
  private config: RetryConfig;

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute an async function with retry logic.
   */
  async execute<T>(
    fn: (attempt: number) => Promise<T>,
    callbacks?: RetryCallbacks<T>,
  ): Promise<RetryResult<T>> {
    const startTime = Date.now();
    let lastError: Error | undefined;
    let previousDelay: number | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const delayMs = attempt === 0 ? 0 : computeDelay(attempt, this.config, previousDelay);
      previousDelay = delayMs;

      const retryAttempt: RetryAttempt = {
        attempt,
        delayMs,
        startedAt: Date.now(),
      };

      callbacks?.onAttempt?.(retryAttempt);

      try {
        const result = await withTimeout(fn(attempt), this.config.attemptTimeoutMs);

        const totalTimeMs = Date.now() - startTime;
        callbacks?.onSuccess?.(result, attempt + 1);

        return {
          success: true,
          result,
          attempts: attempt + 1,
          totalTimeMs,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if this error is retryable
        if (!this.config.retryOnAllErrors && this.config.isRetryable) {
          if (!this.config.isRetryable(lastError)) {
            callbacks?.onGiveUp?.(lastError, attempt + 1);
            return {
              success: false,
              error: lastError,
              attempts: attempt + 1,
              totalTimeMs: Date.now() - startTime,
            };
          }
        } else if (!this.config.retryOnAllErrors && !isRetryableError(lastError)) {
          callbacks?.onGiveUp?.(lastError, attempt + 1);
          return {
            success: false,
            error: lastError,
            attempts: attempt + 1,
            totalTimeMs: Date.now() - startTime,
          };
        }

        // Last attempt
        if (attempt === this.config.maxRetries) {
          callbacks?.onGiveUp?.(lastError, attempt + 1);
          return {
            success: false,
            error: lastError,
            attempts: attempt + 1,
            totalTimeMs: Date.now() - startTime,
          };
        }

        callbacks?.onRetry?.(retryAttempt, lastError);

        if (delayMs > 0) {
          await delay(delayMs);
        }
      }
    }

    // Should never reach here
    return {
      success: false,
      error: lastError ?? new Error("Unknown error"),
      attempts: this.config.maxRetries + 1,
      totalTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Calculate what the next retry delay would be for a given attempt number.
   */
  getDelayForAttempt(attempt: number): number {
    return computeDelay(attempt, this.config);
  }

  configure(updates: Partial<RetryConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}

// ── Presets ───────────────────────────────────────────────

export const RetryPresets = {
  /** Fast retries for internal operations */
  fast: (): RetryConfig => ({
    maxRetries: 2,
    baseDelayMs: 500,
    maxDelayMs: 5000,
    backoffMultiplier: 2,
    jitter: "full",
    retryOnAllErrors: true,
    attemptTimeoutMs: 10_000,
  }),

  /** Standard retries for API calls */
  standard: (): RetryConfig => ({
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
    jitter: "decorrelated",
    retryOnAllErrors: false,
    attemptTimeoutMs: 30_000,
  }),

  /** Persistent retries for critical messages */
  persistent: (): RetryConfig => ({
    maxRetries: 5,
    baseDelayMs: 2000,
    maxDelayMs: 60_000,
    backoffMultiplier: 2,
    jitter: "decorrelated",
    retryOnAllErrors: false,
    attemptTimeoutMs: 60_000,
  }),

  /** Aggressive retries for high-priority delivery */
  aggressive: (): RetryConfig => ({
    maxRetries: 10,
    baseDelayMs: 500,
    maxDelayMs: 15_000,
    backoffMultiplier: 1.5,
    jitter: "full",
    retryOnAllErrors: true,
    attemptTimeoutMs: 15_000,
  }),
} satisfies Record<string, () => RetryConfig>;