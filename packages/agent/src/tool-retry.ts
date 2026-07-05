/**
 * Tool Retry — 工具调用重试与指数退避。
 *
 * 借鉴 LangChain / AutoGPT / OpenAI SDK 的重试机制：
 * - 对瞬时错误（网络、5xx、429 限流）自动重试
 * - 指数退避 + 抖动，避免重试风暴
 * - 可配置最大重试次数、最大退避时间
 * - 不重试确定性错误（4xx 参数错误、权限拒绝等）
 *
 * 配合 ToolResultCache 使用：先查缓存，未命中则执行（带重试），结果写回缓存。
 */

/** 重试配置 */
export interface RetryOptions {
  /** 最大重试次数（不含首次执行）。默认 3。 */
  maxRetries?: number;
  /** 初始退避（毫秒）。默认 500ms。 */
  initialBackoffMs?: number;
  /** 退避乘数。默认 2（指数退避）。 */
  backoffMultiplier?: number;
  /** 最大退避（毫秒）。默认 30 秒。 */
  maxBackoffMs?: number;
  /** 抖动比例（0-1）。默认 0.25（±25% 抖动）。 */
  jitterRatio?: number;
  /** 判断错误是否可重试。默认重试网络错误、5xx、429。 */
  isRetryable?: (error: unknown) => boolean;
  /** 重试前回调（用于日志/监控）。 */
  onRetry?: (info: { attempt: number; error: unknown; nextDelayMs: number }) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "isRetryable" | "onRetry">> = {
  maxRetries: 3,
  initialBackoffMs: 500,
  backoffMultiplier: 2,
  maxBackoffMs: 30_000,
  jitterRatio: 0.25,
};

/**
 * 默认可重试错误判定：
 * - TypeError / fetch 错误（网络层）
 * - HTTP 429（限流）
 * - HTTP 5xx（服务器错误）
 * - ECONNRESET / ECONNREFUSED / ETIMEDOUT / ENOTFOUND
 */
export function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // 网络层错误
    if (error.name === "TypeError" && msg.includes("fetch")) return true;
    // Node.js 系统错误码
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return true;
    }
    // HTTP 状态码（错误消息中包含 "http 429" / "http 5xx"）
    if (/http\s+429/.test(msg)) return true;
    if (/http\s+5\d{2}/.test(msg)) return true;
    // AbortError（超时）在某些情况下可重试
    if (error.name === "AbortError" && msg.includes("timeout")) return true;
    // 限流关键词
    if (msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("quota exceeded")) return true;
    if (msg.includes("service unavailable") || msg.includes("internal server error") || msg.includes("bad gateway") || msg.includes("gateway timeout")) return true;
    return false;
  }
  // 字符串错误
  if (typeof error === "string") {
    const lower = error.toLowerCase();
    if (lower.includes("rate limit") || lower.includes("timeout") || lower.includes("econnreset") || lower.includes("econnrefused")) return true;
    if (/http\s+5\d{2}/.test(lower)) return true;
  }
  return false;
}

/** 计算第 n 次重试的退避时间（含抖动） */
export function computeBackoff(attempt: number, opts: typeof DEFAULT_OPTIONS): number {
  const base = Math.min(
    opts.initialBackoffMs * Math.pow(opts.backoffMultiplier, attempt),
    opts.maxBackoffMs,
  );
  // 抖动：±jitterRatio
  const jitter = base * opts.jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/** sleep 辅助（unref 防止阻止进程退出） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const h = setTimeout(resolve, ms);
    h.unref?.();
  });
}

/**
 * 带重试的工具执行包装器。
 *
 * @param fn 工具执行函数
 * @param args 传给 fn 的参数
 * @param options 重试配置
 * @returns 工具执行结果
 * @throws 重试耗尽后抛出最后一次错误
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const isRetryable = options.isRetryable ?? defaultIsRetryable;
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= opts.maxRetries || !isRetryable(err)) {
        throw err;
      }
      const delayMs = computeBackoff(attempt, opts);
      options.onRetry?.({ attempt: attempt + 1, error: err, nextDelayMs: delayMs });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * 创建可重试的工具执行器。
 *
 * 使用方式：
 * ```ts
 * const executor = createRetryExecutor({ maxRetries: 5 });
 * const result = await executor(() => callExpensiveAPI(params));
 * ```
 */
export function createRetryExecutor(defaultOptions: RetryOptions = {}) {
  return <T>(fn: () => Promise<T>, overrideOptions?: RetryOptions): Promise<T> => {
    return withRetry(fn, { ...defaultOptions, ...overrideOptions });
  };
}
