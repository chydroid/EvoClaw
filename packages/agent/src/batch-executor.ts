/**
 * BatchExecutor — 批量并发执行工具调用。
 *
 * 对标 Claude Computer Use / Devin 的多步并行执行能力：
 *   - 并发限速（信号量 + sliding window 速率限制）
 *   - 失败隔离（单任务失败不影响其他任务，可选 failFast）
 *   - 超时取消（Promise.race + setTimeout）
 *   - 重试退避（指数退避 + jitter）
 *   - DAG 依赖（拓扑排序 + 环检测）
 *
 * 设计要点：
 *   - 不绑定具体工具实现：通过注入 `BatchToolExecutorFn` 调用任意工具
 *   - 简单信号量实现 maxConcurrency 限制
 *   - sliding window 算法实现 rateLimitPerSecond 限制
 *   - DAG 用 Kahn 算法拓扑分层，同层并行执行
 */

// ── 类型 ────────────────────────────────────────────────────────────────────

export type BatchToolExecutorFn = (
  toolName: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export interface BatchTask {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  /** 依赖的任务 ID 列表（用于 DAG 执行） */
  dependsOn?: string[];
  /** 单任务超时（毫秒），覆盖 defaultTimeoutMs */
  timeoutMs?: number;
  /** 单任务重试次数，覆盖 defaultRetries */
  retries?: number;
}

export interface BatchTaskResult {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  attempts: number;
}

export interface BatchResult {
  results: BatchTaskResult[];
  succeeded: number;
  failed: number;
  totalDurationMs: number;
}

export interface BatchExecutorConfig {
  /** 最大并发数，默认 5 */
  maxConcurrency?: number;
  /** 默认超时（毫秒），默认 30000 */
  defaultTimeoutMs?: number;
  /** 默认重试次数，默认 0 */
  defaultRetries?: number;
  /** 重试基础延迟（毫秒），默认 1000 */
  retryDelayMs?: number;
  /** 每秒最大调用次数，未设置则不限速 */
  rateLimitPerSecond?: number;
  /** 一个失败是否立即终止整体执行，默认 false */
  failFast?: boolean;
}

// ── 默认配置 ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 0;
const DEFAULT_RETRY_DELAY_MS = 1_000;

// ── 简单信号量 ──────────────────────────────────────────────────────────────

class SimpleSemaphore {
  private available: number;
  private readonly max: number;
  private waiters: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
    this.available = this.max;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => resolve());
    });
  }

  release(): void {
    if (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) w();
    } else {
      this.available = Math.min(this.available + 1, this.max);
    }
  }
}

// ── Sliding Window 限速器 ───────────────────────────────────────────────────

class SlidingWindowRateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly maxPerSecond: number) {}

  /**
   * 如果当前窗口内调用数已达上限，返回需要等待的毫秒数；否则返回 0。
   *
   * 注意：单独调用此方法后再调用 `record()` 不是原子的，
   * 多个并发调用者可能同时看到返回 0 而全部 record，导致限速失效。
   * 生产代码应使用 `acquire()`。
   */
  waitMs(): number {
    const now = Date.now();
    const windowStart = now - 1000;
    // 移除超过 1 秒的旧时间戳
    while (this.timestamps.length > 0 && this.timestamps[0] < windowStart) {
      this.timestamps.shift();
    }
    if (this.timestamps.length < this.maxPerSecond) {
      return 0;
    }
    // 计算需要等待多久才能腾出位置
    const oldest = this.timestamps[0];
    return Math.max(0, oldest + 1000 - now);
  }

  /**
   * 记录一次调用。
   *
   * 注意：与 `waitMs()` 配合使用存在竞态，请优先使用 `acquire()`。
   */
  record(): void {
    this.timestamps.push(Date.now());
  }

  /**
   * 原子地等待并通过限速：把 `waitMs()` + `record()` 合并为原子操作。
   *
   * 在 JS 单线程模型下，async 函数内 `waitMs()` 返回 0 到 `record()` 之间
   * 没有 await，不会被其他并发任务插入，因此不会出现 N 个任务同时看到
   * 未满而全部 record 的竞态。
   */
  async acquire(): Promise<void> {
    for (;;) {
      const wait = this.waitMs();
      if (wait === 0) {
        this.record();
        return;
      }
      await this.sleep(wait);
    }
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (t.unref) t.unref();
    });
  }
}

// ── 主类 ────────────────────────────────────────────────────────────────────

export class BatchExecutor {
  private readonly executorFn: BatchToolExecutorFn;
  private readonly maxConcurrency: number;
  private readonly defaultTimeoutMs: number;
  private readonly defaultRetries: number;
  private readonly retryDelayMs: number;
  private readonly rateLimitPerSecond: number | undefined;
  private readonly failFast: boolean;

  constructor(executorFn: BatchToolExecutorFn, config?: BatchExecutorConfig) {
    this.executorFn = executorFn;
    this.maxConcurrency = config?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultRetries = config?.defaultRetries ?? DEFAULT_RETRIES;
    this.retryDelayMs = config?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.rateLimitPerSecond = config?.rateLimitPerSecond;
    this.failFast = config?.failFast ?? false;
  }

  /**
   * 默认执行入口：根据是否存在依赖自动选择策略。
   *   - 任意任务声明 dependsOn → executeDAG
   *   - 否则 → executeParallel
   */
  async execute(tasks: BatchTask[]): Promise<BatchResult> {
    if (tasks.length === 0) {
      return { results: [], succeeded: 0, failed: 0, totalDurationMs: 0 };
    }
    const hasDeps = tasks.some((t) => t.dependsOn && t.dependsOn.length > 0);
    return hasDeps ? this.executeDAG(tasks) : this.executeParallel(tasks);
  }

  /**
   * 全部并行执行（受 maxConcurrency 限制）。
   */
  async executeParallel(tasks: BatchTask[]): Promise<BatchResult> {
    if (tasks.length === 0) {
      return { results: [], succeeded: 0, failed: 0, totalDurationMs: 0 };
    }
    const start = Date.now();
    const semaphore = new SimpleSemaphore(this.maxConcurrency);
    const rateLimiter = this.rateLimitPerSecond
      ? new SlidingWindowRateLimiter(this.rateLimitPerSecond)
      : null;

    const aborted = { value: false };
    const settled: BatchTaskResult[] = await Promise.all(
      tasks.map((task) =>
        this.runOne(task, semaphore, rateLimiter, aborted).then((res) => {
          if (!res.success && this.failFast) {
            aborted.value = true;
          }
          return res;
        }),
      ),
    );

    return this.buildBatchResult(settled, start);
  }

  /**
   * 串行执行：前一个完成才下一个。
   */
  async executeSequential(tasks: BatchTask[]): Promise<BatchResult> {
    if (tasks.length === 0) {
      return { results: [], succeeded: 0, failed: 0, totalDurationMs: 0 };
    }
    const start = Date.now();
    const semaphore = new SimpleSemaphore(this.maxConcurrency);
    const rateLimiter = this.rateLimitPerSecond
      ? new SlidingWindowRateLimiter(this.rateLimitPerSecond)
      : null;

    const results: BatchTaskResult[] = [];
    const aborted = { value: false };

    for (const task of tasks) {
      if (aborted.value) {
        // failFast 触发：剩余任务标记为失败
        results.push({
          id: task.id,
          success: false,
          error: "skipped due to failFast",
          durationMs: 0,
          attempts: 0,
        });
        continue;
      }
      const res = await this.runOne(task, semaphore, rateLimiter, aborted);
      results.push(res);
      if (!res.success && this.failFast) {
        aborted.value = true;
      }
    }

    return this.buildBatchResult(results, start);
  }

  /**
   * DAG 执行：根据 dependsOn 拓扑分层，同层并行，层间串行。
   * 环检测：发现循环依赖时抛错。
   */
  async executeDAG(tasks: BatchTask[]): Promise<BatchResult> {
    if (tasks.length === 0) {
      return { results: [], succeeded: 0, failed: 0, totalDurationMs: 0 };
    }

    // 构建任务索引
    const taskMap = new Map<string, BatchTask>();
    for (const t of tasks) {
      if (taskMap.has(t.id)) {
        throw new Error(`Duplicate task id: ${t.id}`);
      }
      taskMap.set(t.id, t);
    }

    // 检测循环依赖 + 拓扑分层
    const levels = this.topologicalLevels(tasks, taskMap);

    const start = Date.now();
    const semaphore = new SimpleSemaphore(this.maxConcurrency);
    const rateLimiter = this.rateLimitPerSecond
      ? new SlidingWindowRateLimiter(this.rateLimitPerSecond)
      : null;

    // 已完成结果索引
    const completed = new Map<string, BatchTaskResult>();
    const aborted = { value: false };

    for (const layer of levels) {
      if (aborted.value) {
        // 把剩余层任务标记为 skipped
        for (const t of layer) {
          completed.set(t.id, {
            id: t.id,
            success: false,
            error: "skipped due to failFast",
            durationMs: 0,
            attempts: 0,
          });
        }
        continue;
      }

      // 检查依赖是否全部成功；任一失败则跳过本任务（除非 failFast）
      const runnable: BatchTask[] = [];
      for (const t of layer) {
        const deps = t.dependsOn ?? [];
        const failedDep = deps.find((d) => {
          const r = completed.get(d);
          return !r || !r.success;
        });
        if (failedDep) {
          completed.set(t.id, {
            id: t.id,
            success: false,
            error: `dependency "${failedDep}" failed or missing`,
            durationMs: 0,
            attempts: 0,
          });
          if (this.failFast) aborted.value = true;
        } else {
          runnable.push(t);
        }
      }

      if (runnable.length === 0) continue;

      // 同层并行执行
      const layerResults = await Promise.all(
        runnable.map((t) =>
          this.runOne(t, semaphore, rateLimiter, aborted).then((res) => {
            if (!res.success && this.failFast) {
              aborted.value = true;
            }
            return res;
          }),
        ),
      );
      for (const r of layerResults) {
        completed.set(r.id, r);
      }
    }

    // 按原始顺序输出结果
    const results: BatchTaskResult[] = tasks.map(
      (t) =>
        completed.get(t.id) ?? {
          id: t.id,
          success: false,
          error: "not executed",
          durationMs: 0,
          attempts: 0,
        },
    );

    return this.buildBatchResult(results, start);
  }

  // ── 私有：单任务执行 ─────────────────────────────────────────────────────

  /**
   * 执行单个任务：限速等待 + 信号量获取 + 重试 + 超时。
   * 失败隔离：try/catch 捕获所有错误，永不 reject。
   */
  private async runOne(
    task: BatchTask,
    semaphore: SimpleSemaphore,
    rateLimiter: SlidingWindowRateLimiter | null,
    aborted: { value: boolean },
  ): Promise<BatchTaskResult> {
    if (aborted.value) {
      return {
        id: task.id,
        success: false,
        error: "skipped due to failFast",
        durationMs: 0,
        attempts: 0,
      };
    }

    const start = Date.now();
    const maxRetries = task.retries ?? this.defaultRetries;
    const timeoutMs = task.timeoutMs ?? this.defaultTimeoutMs;

    let lastError: string | undefined;
    let attempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts++;
      // 限速等待：使用原子 acquire，避免 waitMs + record 分离导致的并发竞态
      if (rateLimiter) {
        if (aborted.value) break;
        await rateLimiter.acquire();
      }

      await semaphore.acquire();
      try {
        // 拿到信号量后再检查一次 abort，避免在 failFast 触发后仍执行任务
        if (aborted.value) {
          return {
            id: task.id,
            success: false,
            error: "skipped due to failFast",
            durationMs: Date.now() - start,
            attempts,
          };
        }
        const result = await this.raceWithTimeout(
          this.executorFn(task.toolName, task.params),
          timeoutMs,
          task.id,
        );
        return {
          id: task.id,
          success: true,
          result,
          durationMs: Date.now() - start,
          attempts,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // 超时或失败后释放信号量
      } finally {
        semaphore.release();
      }

      // 还有重试机会：退避后继续
      if (attempt < maxRetries) {
        const backoff = this.computeBackoff(attempt);
        await this.delay(backoff);
      }
    }

    return {
      id: task.id,
      success: false,
      error: lastError ?? "unknown error",
      durationMs: Date.now() - start,
      attempts,
    };
  }

  /**
   * Promise.race + setTimeout 实现超时。
   */
  private raceWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    taskId: string,
  ): Promise<T> {
    if (timeoutMs <= 0) return promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`task "${taskId}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /**
   * 指数退避 + jitter：base * 2^attempt * (1 ± 20%)。
   */
  private computeBackoff(attempt: number): number {
    const base = this.retryDelayMs * 2 ** attempt;
    const jitterFactor = 1 + (Math.random() * 0.4 - 0.2); // ±20%
    return Math.max(0, Math.round(base * jitterFactor));
  }

  private delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (t.unref) t.unref();
    });
  }

  // ── 私有：拓扑分层 + 环检测 ───────────────────────────────────────────────

  /**
   * Kahn 算法拓扑分层：返回每层任务数组（同层可并行）。
   * 检测到环时抛错。
   */
  private topologicalLevels(
    tasks: BatchTask[],
    taskMap: Map<string, BatchTask>,
  ): BatchTask[][] {
    // 入度表 + 邻接表
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const t of tasks) {
      if (!inDegree.has(t.id)) inDegree.set(t.id, 0);
      if (!adjacency.has(t.id)) adjacency.set(t.id, []);
    }

    for (const t of tasks) {
      for (const dep of t.dependsOn ?? []) {
        if (!taskMap.has(dep)) {
          // 依赖不存在的任务：视为入度 0 的缺失依赖，跳过连接
          // 该任务会在 runOne 阶段被标记为失败
          continue;
        }
        // 注意：dep -> t 的边
        adjacency.get(dep)?.push(t.id);
        inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
      }
    }

    const levels: BatchTask[][] = [];
    let current: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) current.push(id);
    }

    let processed = 0;
    while (current.length > 0) {
      const layer: BatchTask[] = [];
      for (const id of current) {
        const task = taskMap.get(id);
        if (task) layer.push(task);
      }
      levels.push(layer);
      processed += current.length;

      const next: string[] = [];
      for (const id of current) {
        for (const neighbor of adjacency.get(id) ?? []) {
          const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
          inDegree.set(neighbor, newDeg);
          if (newDeg === 0) next.push(neighbor);
        }
      }
      current = next;
    }

    if (processed !== tasks.length) {
      throw new Error(
        "BatchExecutor.executeDAG: cycle detected in task dependencies",
      );
    }

    return levels;
  }

  // ── 私有：结果汇总 ─────────────────────────────────────────────────────────

  private buildBatchResult(
    results: BatchTaskResult[],
    start: number,
  ): BatchResult {
    let succeeded = 0;
    let failed = 0;
    for (const r of results) {
      if (r.success) succeeded++;
      else failed++;
    }
    return {
      results,
      succeeded,
      failed,
      totalDurationMs: Date.now() - start,
    };
  }
}
