/**
 * DLQBatchRetry — 死信队列批量重试工具
 *
 * 项目已有 packages/gateway/src/dead-letter-queue.ts，但未提供批量重试 API。
 * 本模块作为上层批量重试封装，不修改原 DLQ 模块。
 *
 * 能力：
 *  - retryAll: 并发重试所有条目（受 maxConcurrency 限制）
 *  - retryByTopic: 按 topic 过滤后重试
 *  - retryWithFilter: 自定义过滤条件
 *  - 指数退避（retryDelayMs * 2^n）
 *  - retryCount 超过 maxRetries 直接标记为 stillFailed
 *  - failFast=true 时遇到第一个失败就停止
 *  - 不修改 entries，由调用方决定是否从 DLQ 删除
 */

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface DLQEntry {
  id: string;
  topic: string;
  payload: unknown;
  originalError?: string;
  failedAt: number;
  retryCount: number;
}

export interface DLQBatchRetryResult {
  total: number;
  succeeded: number;
  failed: number;
  recovered: string[];
  stillFailed: Array<{ id: string; reason: string }>;
  durationMs: number;
}

export type DLQRetryHandler = (entry: DLQEntry) => Promise<void>;

export interface DLQBatchConfig {
  /** 并发上限（默认 10） */
  maxConcurrency?: number;
  /** 单条目最大重试次数（默认 3） */
  maxRetries?: number;
  /** 重试退避基础延迟（毫秒，默认 100） */
  retryDelayMs?: number;
  /** true 时遇到第一个失败就停止（默认 false） */
  failFast?: boolean;
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

interface ResolvedConfig {
  maxConcurrency: number;
  maxRetries: number;
  retryDelayMs: number;
  failFast: boolean;
}

const DEFAULT_CONFIG: ResolvedConfig = {
  maxConcurrency: 10,
  maxRetries: 3,
  retryDelayMs: 100,
  failFast: false,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

// ── 主类 ────────────────────────────────────────────────────────────────────

export class DLQBatchRetry {
  private readonly handler: DLQRetryHandler;
  private readonly config: ResolvedConfig;

  constructor(handler: DLQRetryHandler, config?: DLQBatchConfig) {
    this.handler = handler;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      maxConcurrency: Math.max(1, config?.maxConcurrency ?? DEFAULT_CONFIG.maxConcurrency),
      maxRetries: Math.max(0, config?.maxRetries ?? DEFAULT_CONFIG.maxRetries),
    };
  }

  /** 并发重试所有条目 */
  async retryAll(entries: DLQEntry[]): Promise<DLQBatchRetryResult> {
    return this.retryInternal(entries);
  }

  /** 按 topic 过滤后重试 */
  async retryByTopic(entries: DLQEntry[], topic: string): Promise<DLQBatchRetryResult> {
    const filtered = entries.filter((e) => e.topic === topic);
    return this.retryInternal(filtered);
  }

  /** 自定义过滤条件 */
  async retryWithFilter(
    entries: DLQEntry[],
    filter: (entry: DLQEntry) => boolean,
  ): Promise<DLQBatchRetryResult> {
    const filtered = entries.filter(filter);
    return this.retryInternal(filtered);
  }

  // ── 私有：核心逻辑 ────────────────────────────────────────────────────────

  /**
   * 核心重试逻辑：
   *  1. retryCount 已超过 maxRetries 的直接标记 stillFailed
   *  2. 否则调用 handler，失败时按 maxRetries 重试（指数退避 retryDelayMs*2^n）
   *  3. failFast=true 时遇到第一个失败就停止后续条目
   *  4. 不修改传入的 entries
   */
  private async retryInternal(entries: DLQEntry[]): Promise<DLQBatchRetryResult> {
    const start = Date.now();
    const recovered: string[] = [];
    const stillFailed: Array<{ id: string; reason: string }> = [];

    // 预先筛选：retryCount 已超限的直接标记
    const todo: DLQEntry[] = [];
    for (const entry of entries) {
      if (entry.retryCount >= this.config.maxRetries) {
        stillFailed.push({
          id: entry.id,
          reason: `已超过最大重试次数 (${this.config.maxRetries})`,
        });
      } else {
        todo.push(entry);
      }
    }

    // failFast 用 abort 标志短路
    let aborted = false;
    const queue = [...todo];
    const concurrency = Math.min(this.config.maxConcurrency, todo.length);

    const processOne = async (entry: DLQEntry): Promise<void> => {
      const result = await this.tryWithRetries(entry);
      if (result.success) {
        recovered.push(entry.id);
      } else {
        stillFailed.push({ id: entry.id, reason: result.reason ?? "未知错误" });
        if (this.config.failFast) {
          aborted = true;
        }
      }
    };

    const worker = async (): Promise<void> => {
      while (queue.length > 0 && !aborted) {
        const entry = queue.shift();
        if (!entry) break;
        await processOne(entry);
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // failFast 触发后，未处理的条目全部记为 stillFailed
    if (aborted) {
      for (const entry of queue) {
        stillFailed.push({ id: entry.id, reason: "failFast 中止" });
      }
    }

    const succeeded = recovered.length;
    const failed = stillFailed.length;

    return {
      total: entries.length,
      succeeded,
      failed,
      recovered,
      stillFailed,
      durationMs: Date.now() - start,
    };
  }

  /** 对单条目执行 handler + 指数退避重试 */
  private async tryWithRetries(
    entry: DLQEntry,
  ): Promise<{ success: boolean; reason?: string }> {
    // 剩余可重试次数 = maxRetries - 已有 retryCount
    const remaining = this.config.maxRetries - entry.retryCount;
    const maxAttempts = Math.max(1, remaining);

    let lastReason = "未知错误";
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.handler(entry);
        return { success: true };
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts - 1) {
          // 指数退避：retryDelayMs * 2^n，上限 30 秒防止过长延迟
          const delay = Math.min(30000, this.config.retryDelayMs * Math.pow(2, attempt));
          await sleep(delay);
        }
      }
    }
    return { success: false, reason: lastReason };
  }
}
