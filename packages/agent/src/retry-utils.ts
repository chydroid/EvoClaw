/**
 * Retry Utilities — 借鉴 openclaw 的双 jitter 重试机制与可中断 sleep。
 *
 * 核心改进（相比原 EvoClaw 的固定 backoffMs）：
 *  1. 双 jitter 模式：symmetric（普通退避）+ positive（Retry-After 下限契约）
 *  2. 加密安全随机：避免重试模式可预测
 *  3. 可中断 sleep：支持 AbortSignal，用户取消后立即停止
 *  4. Retry-After 契约：保证不低于服务端要求的下限
 *  5. 指数退避 + 上限：防止过长等待
 *
 * 参考：openclaw-main/src/infra/retry.ts、backoff.ts
 */

// ── Types ─────────────────────────────────────────────────

export interface BackoffPolicy {
  /** 第一次重试的延迟（ms） */
  initialMs: number;
  /** 延迟上限（ms） */
  maxMs: number;
  /** 指数因子 */
  factor: number;
  /** jitter 比例 (0-1) */
  jitter: number;
}

export interface RetryConfig {
  /** 最大尝试次数（含首次） */
  attempts?: number;
  /** 最小延迟（ms） */
  minDelayMs?: number;
  /** 最大延迟（ms） */
  maxDelayMs?: number;
  /** jitter 比例 (0-1) */
  jitter?: number;
}

export interface RetryOptions extends RetryConfig {
  /** 操作标签（用于日志） */
  label?: string;
  /** 自定义是否重试判断 */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** 从错误中解析 Retry-After（ms） */
  retryAfterMs?: (err: unknown) => number | undefined;
  /** 重试前回调 */
  onRetry?: (info: RetryInfo) => void;
  /** 中断信号 */
  abortSignal?: AbortSignal;
}

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  err: unknown;
  label?: string;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_BACKOFF: Required<BackoffPolicy> = {
  initialMs: 300,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.3,
};

const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  attempts: 3,
  minDelayMs: 300,
  maxDelayMs: 30_000,
  jitter: 0.3,
};

// ── Secure Random ─────────────────────────────────────────

/**
 * 生成加密安全的 [0, 1) 随机数。
 * 优先使用 crypto.randomBytes，回退到 Math.random。
 */
function generateSecureFraction(): number {
  try {
    // Node.js 环境
    if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
      const buf = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buf);
      return buf[0] / 0x100000000;
    }
  } catch {
    // 回退
  }
  return Math.random();
}

// ── Jitter ────────────────────────────────────────────────

type JitterMode = "symmetric" | "positive";

/**
 * 应用 jitter 到延迟值。
 *
 * - symmetric：jitter 在 [-jitter, +jitter] 对称分布，用 Math.round。
 *   适用于普通指数退避，允许略微提前。
 *
 * - positive：jitter 在 [0, +jitter] 正向分布，用 Math.ceil。
 *   关键特性：保证实际延迟不低于基础延迟。
 *   当服务端返回 Retry-After 时使用，确保不违反服务端契约。
 */
export function applyJitter(
  delayMs: number,
  jitter: number,
  mode: JitterMode = "symmetric",
): number {
  if (jitter <= 0) return delayMs;

  const fraction = generateSecureFraction();
  const offset = mode === "positive"
    ? fraction * jitter
    : (fraction * 2 - 1) * jitter;
  const raw = delayMs * (1 + offset);

  // positive 模式保证 delay >= delayMs，必须向上取整
  // symmetric 模式无下限契约，用四舍五入
  return Math.max(0, mode === "positive" ? Math.ceil(raw) : Math.round(raw));
}

// ── Backoff ───────────────────────────────────────────────

/**
 * 计算有界的指数退避延迟。
 */
export function computeBackoff(policy: BackoffPolicy, attempt: number): number {
  const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
  const jitter = base * policy.jitter * generateSecureFraction();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

// ── Decorrelated Jittered Backoff ─────────────────────────

/**
 * 单调递增计数器，用于 jitter 种子去重。
 *
 * 借鉴 hermes-agent agent/retry_utils.py 的 _jitter_counter 设计：
 * 当多个会话并发重试同一个 rate-limited provider 时，
 * 仅依赖时间戳作为种子会导致种子碰撞（同一纳秒内多个调用），
 * 使重试同步化（thundering herd）。
 *
 * 计数器保证每次调用获得唯一种子，实现 decorrelated jitter。
 * 使用原子操作语义：Node.js 单线程模型下 ++ 是原子的；
 * Worker 线程间不共享内存，无需跨进程锁。
 */
let _jitterCounter = 0;

/**
 * 计算去相关抖动退避延迟（Decorrelated Jittered Backoff）。
 *
 * 借鉴 hermes-agent agent/retry_utils.py jittered_backoff：
 *   delay = min(base * 2^(attempt-1), max) + uniform(0, jitter_ratio * delay)
 *
 * 相比 computeBackoff 的改进：
 *   1. 单调计数器种子：防止并发重试同步化（thundering herd）
 *   2. 时间戳 + 计数器混合种子：即使时钟粗糙也能去相关
 *   3. 黄金比例哈希：分散种子位模式
 *
 * @param attempt 1-based 重试次数
 * @param baseDelayMs 第一次重试的基础延迟（ms）
 * @param maxDelayMs 延迟上限（ms）
 * @param jitterRatio jitter 比例 (0-1)，0.5 表示 jitter 在 [0, 0.5*delay] 均匀分布
 * @returns 延迟（ms）
 *
 * @example
 * ```ts
 * // 多个并发会话重试同一 provider 时，各自获得不同的延迟
 * const delay1 = jitteredBackoff(3, 5000, 120000, 0.5);
 * const delay2 = jitteredBackoff(3, 5000, 120000, 0.5);
 * // delay1 !== delay2（极大概率）
 * ```
 */
export function jitteredBackoff(
  attempt: number,
  baseDelayMs: number = 5000,
  maxDelayMs: number = 120_000,
  jitterRatio: number = 0.5,
): number {
  // 原子递增计数器（Node.js 单线程下 ++ 即原子）
  _jitterCounter = (_jitterCounter + 1) >>> 0;
  const tick = _jitterCounter;

  const exponent = Math.max(0, attempt - 1);
  let delay: number;
  if (exponent >= 63 || baseDelayMs <= 0) {
    delay = maxDelayMs;
  } else {
    delay = Math.min(baseDelayMs * (2 ** exponent), maxDelayMs);
  }

  // 混合种子：时间戳 ^ (计数器 * 黄金比例)
  // 黄金比例 0x9E3779B9 使计数器位模式分散，避免低位循环
  const timeNs = Number(BigInt(Date.now()) * 1_000_000n & 0xFFFFFFFFn);
  const seed = (timeNs ^ (tick * 0x9E3779B9)) >>> 0;

  // 使用加密安全随机 + 种子混合，保证去相关
  const fraction = generateSecureFraction();
  // 用种子做额外扰动（即使 crypto 不可靠也能去相关）
  const seedFraction = (seed / 0x100000000);
  const combined = (fraction + seedFraction) % 1;

  const jitter = combined * jitterRatio * delay;
  return Math.round(delay + jitter);
}

/** 重置 jitter 计数器（仅用于测试）。 */
export function _resetJitterCounterForTests(): void {
  _jitterCounter = 0;
}

// ── Abortable Sleep ───────────────────────────────────────

/**
 * 可中断的 sleep。
 *
 * 支持 AbortSignal，当信号触发时立即 reject。
 * 这解决了传统 setTimeout 退避无法中断的问题——
 * 用户取消后任务不会继续执行。
 */
export function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  const delayMs = Math.max(0, Math.min(ms, 2_147_483_647));

  return new Promise<void>((resolve, reject) => {
    if (delayMs === 0) {
      resolve();
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      reject(new Error("aborted", { cause: abortSignal?.reason ?? new Error("aborted") }));
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
    }

    timer = setTimeout(() => {
      settled = true;
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      timer = null;
      resolve();
    }, delayMs);
  });
}

// ── Retry Async ───────────────────────────────────────────

/**
 * 运行异步操作直到成功、重试策略停止或尝试次数耗尽。
 *
 * 核心改进：
 * 1. 双 jitter：Retry-After 用 positive，普通退避用 symmetric
 * 2. 可中断：支持 AbortSignal
 * 3. Retry-After 契约：保证不低于服务端下限
 * 4. 指数退避 + 上限：防止过长等待
 *
 * @example
 * ```ts
 * const result = await retryAsync(
 *   () => fetchApi(),
 *   {
 *     attempts: 5,
 *     jitter: 0.3,
 *     shouldRetry: (err) => isTransient(err),
 *     retryAfterMs: (err) => parseRetryAfter(err),
 *     onRetry: (info) => logger.log(`Retry ${info.attempt}/${info.maxAttempts}`),
 *     abortSignal: controller.signal,
 *   }
 * );
 * ```
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  attemptsOrOptions: number | RetryOptions = 3,
  initialDelayMs = 300,
): Promise<T> {
  // 简单模式：只传尝试次数
  if (typeof attemptsOrOptions === "number") {
    const attempts = Math.max(1, Math.round(attemptsOrOptions));
    let lastErr: unknown;

    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i === attempts - 1) break;

        const delay = Math.min(initialDelayMs * 2 ** i, DEFAULT_RETRY_CONFIG.maxDelayMs);
        const jittered = applyJitter(delay, DEFAULT_RETRY_CONFIG.jitter, "symmetric");
        await sleepWithAbort(jittered);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error("Retry failed", { cause: lastErr });
  }

  // 完整模式：使用 RetryOptions
  const options = attemptsOrOptions;
  const resolved = resolveRetryConfig(DEFAULT_RETRY_CONFIG, options);
  const maxAttempts = resolved.attempts;
  const minDelayMs = resolved.minDelayMs;
  const maxDelayMs = resolved.maxDelayMs;
  const jitter = resolved.jitter;
  const shouldRetry = options.shouldRetry ?? (() => true);
  const abortSignal = options.abortSignal;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 检查中断
    if (abortSignal?.aborted) {
      throw new Error("aborted", { cause: abortSignal.reason ?? new Error("aborted") });
    }

    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
        break;
      }

      // 解析 Retry-After
      const retryAfterMs = options.retryAfterMs?.(err);
      const hasRetryAfter = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs);

      // 计算基础延迟
      const baseDelay = hasRetryAfter
        ? Math.max(retryAfterMs!, minDelayMs)
        : minDelayMs * 2 ** (attempt - 1);

      let delay = Math.min(baseDelay, maxDelayMs);

      // Retry-After 是与服务端的下限契约：
      // - 使用 positive jitter 保证不低于下限
      // - 例外：当 retryAfterMs > maxDelayMs 时，契约已无法满足，
      //   回退到 symmetric 保留分散性
      const canHonorRetryAfter =
        hasRetryAfter && typeof retryAfterMs === "number" && retryAfterMs <= maxDelayMs;
      delay = applyJitter(delay, jitter, canHonorRetryAfter ? "positive" : "symmetric");
      delay = Math.min(Math.max(delay, minDelayMs), maxDelayMs);

      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs: delay,
        err,
        label: options.label,
      });

      if (delay > 0) {
        await sleepWithAbort(delay, abortSignal);
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("Retry failed", { cause: lastErr });
}

// ── Config Resolution ─────────────────────────────────────

function resolveRetryConfig(
  defaults: Required<RetryConfig>,
  overrides?: RetryConfig,
): Required<RetryConfig> {
  const attempts = Math.max(1, Math.round(overrides?.attempts ?? defaults.attempts));
  const minDelayMs = Math.max(0, Math.round(overrides?.minDelayMs ?? defaults.minDelayMs));
  const maxDelayMs = Math.max(minDelayMs, Math.round(overrides?.maxDelayMs ?? defaults.maxDelayMs));
  const jitter = Math.min(1, Math.max(0, overrides?.jitter ?? defaults.jitter));
  return { attempts, minDelayMs, maxDelayMs, jitter };
}

// ── Convenience Helpers ───────────────────────────────────

/**
 * 判断错误是否为可重试的瞬时错误。
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // 网络错误
    if (msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("socket hang up")) {
      return true;
    }
    // 超时
    if (msg.includes("timeout") || msg.includes("timed out")) {
      return true;
    }
    // 5xx 服务器错误
    if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504")) {
      return true;
    }
    // 中断错误不可重试
    if (msg === "aborted") {
      return false;
    }
  }
  return false;
}

/**
 * 从错误中解析 Retry-After 值（ms）。
 */
export function parseRetryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;

  const msg = err.message;
  // "retry after 30 seconds" / "retry-after: 30"
  const match = msg.match(/retry.?after.?\s*(\d+)/i);
  if (match) {
    const seconds = parseInt(match[1], 10);
    return seconds * 1000;
  }
  return undefined;
}
