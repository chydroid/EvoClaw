/**
 * BackgroundTaskRegistry — 后台任务注册表 + 安全 drain。
 *
 * 借鉴 TencentDB-Agent-Memory 的 `bgTasks` Set + `destroy()` drain 模式：
 * - fire-and-forget 后台任务注册到 Set
 * - destroy() 时等待所有任务完成（带超时）
 * - 任务失败不阻塞主流程，仅记录
 *
 * 解决问题：异步任务在进程关闭时被强行中断，导致数据丢失或文件损坏。
 */

/** 后台任务条目。 */
interface BgTaskEntry {
  /** 任务 promise。 */
  promise: Promise<unknown>;
  /** 任务描述（调试用）。 */
  description: string;
  /** 注册时间。 */
  registeredAt: number;
  /** 是否已完成。 */
  settled: boolean;
  /** 错误信息（若失败）。 */
  error?: unknown;
}

/** BackgroundTaskRegistry 配置。 */
export interface BgTaskRegistryOptions {
  /** drain 超时（毫秒）。默认 5000。 */
  drainTimeoutMs?: number;
  /** 是否在任务失败时打印错误。默认 true。 */
  logErrors?: boolean;
}

const DEFAULT_OPTIONS: Required<BgTaskRegistryOptions> = {
  drainTimeoutMs: 5000,
  logErrors: true,
};

/**
 * 后台任务注册表。
 *
 * 使用方式：
 *   const registry = new BackgroundTaskRegistry();
 *   registry.register("save L1", (async () => { ... })());
 *   await registry.drain();  // 进程关闭前等待所有任务完成
 */
export class BackgroundTaskRegistry {
  private tasks = new Set<BgTaskEntry>();
  private opts: Required<BgTaskRegistryOptions>;
  private destroyed = false;

  constructor(options?: BgTaskRegistryOptions) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 注册一个后台任务。
   * @returns 入参 promise 本身（便于 await）
   */
  register<T>(description: string, promise: Promise<T>): Promise<T> {
    if (this.destroyed) {
      // 已 destroy，直接返回 promise（不注册）
      return promise;
    }
    const entry: BgTaskEntry = {
      promise,
      description,
      registeredAt: Date.now(),
      settled: false,
    };
    this.tasks.add(entry);
    promise
      .then(() => {
        entry.settled = true;
      })
      .catch((err) => {
        entry.settled = true;
        entry.error = err;
        if (this.opts.logErrors) {
          // 静默记录，不抛出
          // eslint-disable-next-line no-console
          console.error(`[BgTaskRegistry] task "${description}" failed:`, err);
        }
      })
      .finally(() => {
        this.tasks.delete(entry);
      });
    return promise;
  }

  /** 当前待完成任务数。 */
  get pendingCount(): number {
    return this.tasks.size;
  }

  /** 是否已 destroy。 */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * 等待所有后台任务完成（带超时）。
   *
   * 借鉴 TencentDB-Agent-Memory 的 destroy() drain 模式：
   * - 5 秒超时保护
   * - 超时后强制返回，未完成任务继续在后台跑（不杀）
   */
  async drain(): Promise<{
    completed: number;
    timedOut: number;
    errors: Array<{ description: string; error: unknown }>;
  }> {
    if (this.tasks.size === 0) {
      this.destroyed = true;
      return { completed: 0, timedOut: 0, errors: [] };
    }

    const errors: Array<{ description: string; error: unknown }> = [];
    const initialCount = this.tasks.size;
    const timeout = this.opts.drainTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // 用 Promise.race 实现超时
    const allSettled = Promise.all(
      [...this.tasks].map((entry) =>
        entry.promise.then(
          () => undefined,
          (err) => {
            errors.push({ description: entry.description, error: err });
          }
        )
      )
    );

    const timeoutPromise = new Promise<never>((resolve) => {
      // 保存 timer 句柄，race 结束后清理，避免 timer 残留占用资源
      timer = setTimeout(() => resolve(undefined as never), timeout);
    });

    try {
      await Promise.race([allSettled, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    this.destroyed = true;
    const completed = initialCount - this.tasks.size;
    return {
      completed,
      timedOut: this.tasks.size,
      errors,
    };
  }

  /** 重置注册表（主要用于测试）。 */
  reset(): void {
    this.tasks.clear();
    this.destroyed = false;
  }
}
