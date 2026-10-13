/**
 * BackgroundDelegator — 后台子 Agent 并行派发 + 结果合并。
 *
 * 对标 Hermes v0.18.0 "子 Agent 后台并行"：
 * - delegate_task 后台派发多个子任务
 * - 你在对话框里继续聊，不受阻塞
 * - 结果合并返回
 *
 * 设计原则：
 * 1. Fire-and-forget —— 派发后立即返回 taskId，不阻塞主对话
 * 2. 结果回调 —— 子任务完成后通过回调通知
 * 3. 结果合并 —— 多个子任务的结果可合并为一条消息注入主对话
 * 4. 超时保护 —— 每个子任务有独立超时
 * 5. 取消支持 —— 可取消单个或全部后台任务
 *
 * 用法：
 * ```ts
 * const delegator = new BackgroundDelegator();
 * const task1 = delegator.delegate("分析这段代码", chatFn);
 * const task2 = delegator.delegate("写单元测试", chatFn);
 * // 继续聊天...
 * const results = await delegator.awaitAll([task1.id, task2.id]);
 * ```
 */

import * as crypto from "crypto";

// ── Types ─────────────────────────────────────────────────

/** 后台任务状态 */
export type BackgroundTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "timeout";

/** 后台任务 */
export interface BackgroundTask {
  /** 唯一任务 ID */
  id: string;
  /** 任务描述 */
  description: string;
  /** 当前状态 */
  status: BackgroundTaskStatus;
  /** 结果（完成时） */
  result?: string;
  /** 错误信息（失败时） */
  error?: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 完成时间戳 */
  completedAt?: number;
  /** 超时（ms） */
  timeoutMs: number;
  /** AbortController（用于取消） */
  abortController: AbortController;
  /**
   * P1-2 mid-flight steering：待注入的实时指令队列。
   * steer() 写入；DelegateFn 实现方在下一轮 prompt 组装点取出，
   * 追加为新增 user message（不重写已缓存前缀，遵守 prompt-cache 约束）。
   */
  pendingInstructions: string[];
  /** P1-2 硬转向：最近一次 hard steer 携带的指令（可选） */
  lastHardSteer?: string;
}

/** 后台任务派发选项 */
export interface DelegateOptions {
  /** 任务描述 */
  description: string;
  /** 超时（ms，默认 120000 = 2 分钟） */
  timeoutMs?: number;
  /** 是否在完成后自动合并结果到主对话（默认 false） */
  autoMerge?: boolean;
}

/** 派发函数 —— 由调用方注入实际执行逻辑 */
export type DelegateFn = (
  description: string,
  signal: AbortSignal,
) => Promise<string>;

/** 后台任务完成回调 */
export type TaskCompleteCallback = (task: BackgroundTask) => void;

// ── BackgroundDelegator ───────────────────────────────────

/**
 * BackgroundDelegator —— 后台子 Agent 并行派发器。
 *
 * 对标 Hermes 的 delegate_task 后台模式：
 * - 派发后立即返回，主对话不阻塞
 * - 子任务在后台并行执行
 * - 完成后通过回调通知，可合并结果
 */
export class BackgroundDelegator {
  private static readonly MAX_PENDING_RESULTS = 100;
  private static readonly MAX_TASKS = 500;

  private tasks = new Map<string, BackgroundTask>();
  private onComplete?: TaskCompleteCallback;
  private pendingResults: BackgroundTask[] = [];

  constructor(options?: { onComplete?: TaskCompleteCallback }) {
    this.onComplete = options?.onComplete;
  }

  /**
   * 派发一个后台任务。
   * 立即返回 task 对象，不等待执行完成。
   */
  delegate(description: string, fn: DelegateFn, options?: Omit<DelegateOptions, "description">): BackgroundTask {
    const id = `bg-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const timeoutMs = options?.timeoutMs ?? 120000;
    const abortController = new AbortController();

    const task: BackgroundTask = {
      id,
      description,
      status: "pending",
      createdAt: Date.now(),
      timeoutMs,
      abortController,
      pendingInstructions: [],
    };

    this.tasks.set(id, task);

    // 安全：自动淘汰过期任务，防止 Map 无界增长
    if (this.tasks.size > BackgroundDelegator.MAX_TASKS) {
      this.cleanupExpired();
    }

    // 异步执行（不 await —— fire and forget）
    this.executeTask(task, fn).catch((err) => {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      task.completedAt = Date.now();
    });

    return task;
  }

  /** 批量派发多个后台任务 */
  delegateBatch(
    tasks: Array<{ description: string; options?: Omit<DelegateOptions, "description"> }>,
    fn: DelegateFn,
  ): BackgroundTask[] {
    return tasks.map((t) => this.delegate(t.description, fn, t.options));
  }

  /** 获取任务状态 */
  getTask(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  /** 列出所有任务 */
  listTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  /** 列出活动任务（pending 或 running） */
  listActiveTasks(): BackgroundTask[] {
    return this.listTasks().filter((t) => t.status === "pending" || t.status === "running");
  }

  /** 列出已完成但未被消费的结果 */
  listPendingResults(): BackgroundTask[] {
    return [...this.pendingResults];
  }

  /**
   * 等待指定任务完成。
   * 如果任务已经完成，立即返回。
   */
  async awaitTask(id: string): Promise<BackgroundTask> {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "timeout") {
      return task;
    }
    // 轮询等待（简单实现，避免引入 EventEmitter 依赖）
    return new Promise((resolve) => {
      const check = () => {
        const t = this.tasks.get(id);
        if (!t) { resolve(task); return; }
        if (t.status === "completed" || t.status === "failed" || t.status === "cancelled" || t.status === "timeout") {
          resolve(t);
        } else {
          // unref 避免 timer 阻止进程优雅退出
          const h = setTimeout(check, 500);
          h.unref?.();
        }
      };
      check();
    });
  }

  /**
   * 等待多个任务全部完成。
   */
  async awaitAll(ids: string[]): Promise<BackgroundTask[]> {
    return Promise.all(ids.map((id) => this.awaitTask(id)));
  }

  /**
   * 等待所有活动任务完成。
   */
  async awaitAllActive(): Promise<BackgroundTask[]> {
    const activeIds = this.listActiveTasks().map((t) => t.id);
    return this.awaitAll(activeIds);
  }

  /**
   * 消费并返回所有待合并的结果（从 pendingResults 中移除）。
   * 用于将后台任务结果注入主对话。
   */
  consumePendingResults(): BackgroundTask[] {
    const results = this.pendingResults;
    this.pendingResults = [];
    return results;
  }

  /**
   * 合并已完成任务的结果为一条消息文本。
   */
  mergeResults(tasks: BackgroundTask[]): string {
    if (tasks.length === 0) return "";
    const lines: string[] = [];
    lines.push(`**🔄 后台任务结果合并 (${tasks.length} 个任务)**\n`);
    for (const task of tasks) {
      const icon = task.status === "completed" ? "✅" : task.status === "failed" ? "❌" : "⏳";
      lines.push(`### ${icon} ${task.description}`);
      lines.push(`任务 ID: \`${task.id}\``);
      if (task.status === "completed" && task.result) {
        lines.push(`结果:\n${task.result.slice(0, 2000)}`);
      } else if (task.status === "failed" && task.error) {
        lines.push(`错误: ${task.error}`);
      } else if (task.status === "timeout") {
        lines.push(`超时（${task.timeoutMs}ms）`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  /**
   * P1-2 mid-flight steering：向运行中的后台任务注入实时指令。
   *
   * - `hard === false`（默认，软转向）：指令追加进 `task.pendingInstructions` 队列，
   *   DelegateFn 实现方在下一轮 prompt 组装点调用 `drainInstructions(task.id)` 取出，
   *   追加为**新增** user message，不重写已缓存前缀（prompt-cache 约束）。
   * - `hard === true`（硬转向）：立即中止当前轮（abortController.abort），
   *   指令记入 `lastHardSteer`，调用方可据此携带指令重新 spawn 新任务。
   *
   * 返回是否注入成功（未知 id / 任务已终态返回 false）。
   */
  steerTask(id: string, instruction: string, options?: { hard?: boolean }): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    const terminal = task.status === "completed" || task.status === "failed" ||
      task.status === "cancelled" || task.status === "timeout";
    if (terminal) return false;

    if (options?.hard) {
      task.lastHardSteer = instruction;
      task.abortController.abort(new Error(`Task ${id} hard-steered by user: ${instruction.slice(0, 80)}`));
      task.status = "cancelled";
      task.completedAt = Date.now();
    } else {
      task.pendingInstructions.push(instruction);
    }
    return true;
  }

  /**
   * 取出（并清空）指定任务当前累积的全部软转向指令。
   * DelegateFn 实现方应在每轮 LLM 调用前调用本方法，把返回的指令
   * 拼进**本轮新增的** user message，避免改动已缓存前缀。
   */
  drainInstructions(id: string): string[] {
    const task = this.tasks.get(id);
    if (!task || task.pendingInstructions.length === 0) return [];
    const drained = task.pendingInstructions.splice(0, task.pendingInstructions.length);
    return drained;
  }

  /** 构造 SubagentRegistry 可用的操控通道（把 steer/abort 桥接到本 delegator 的任务） */
  buildSteerChannel(id: string): {
    push: (instruction: string) => void;
    abort: () => void;
  } {
    return {
      push: (instruction) => { this.steerTask(id, instruction); },
      abort: () => { this.steerTask(id, "hard steer", { hard: true }); },
    };
  }

  /** 取消单个任务 */
  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "timeout") return false;
    task.abortController.abort(new Error(`Task ${id} cancelled by user`));
    task.status = "cancelled";
    task.completedAt = Date.now();
    return true;
  }

  /** 取消所有活动任务 */
  cancelAll(): number {
    const active = this.listActiveTasks();
    for (const task of active) {
      this.cancel(task.id);
    }
    return active.length;
  }

  /** 清理已完成的任务（释放内存） */
  cleanup(): number {
    const toRemove = this.listTasks().filter(
      (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled" || t.status === "timeout",
    );
    for (const task of toRemove) {
      this.tasks.delete(task.id);
    }
    return toRemove.length;
  }

  // ── Internal ────────────────────────────────────────────

  /** 实际执行任务（带超时） */
  private async executeTask(task: BackgroundTask, fn: DelegateFn): Promise<void> {
    task.status = "running";

    // 设置超时
    const timeoutHandle = setTimeout(() => {
      if (task.status === "running" || task.status === "pending") {
        task.abortController.abort(new Error(`Task timed out after ${task.timeoutMs}ms`));
        task.status = "timeout";
        task.completedAt = Date.now();
      }
    }, task.timeoutMs);
    timeoutHandle.unref?.();

    try {
      const result = await fn(task.description, task.abortController.signal);
      clearTimeout(timeoutHandle);
      // 状态可能已被 timeout/cancel 回调修改，读取当前值判断（与 catch 块一致）
      const currentStatus = task.status as BackgroundTaskStatus;
      if (currentStatus === "cancelled" || currentStatus === "timeout") {
        // 已被取消或超时，不覆盖状态
        return;
      }
      task.result = result;
      task.status = "completed";
      task.completedAt = Date.now();
      this.pushPendingResult(task);
      this.onComplete?.(task);
    } catch (err) {
      clearTimeout(timeoutHandle);
      // 状态可能已被 timeout/cancel 回调修改，读取当前值判断
      const currentStatus = task.status as BackgroundTaskStatus;
      if (currentStatus === "cancelled" || currentStatus === "timeout") {
        // 已被取消或超时，不覆盖状态
        return;
      }
      task.error = err instanceof Error ? err.message : String(err);
      task.status = "failed";
      task.completedAt = Date.now();
      this.pushPendingResult(task);
      this.onComplete?.(task);
    }
  }

  /** 添加待消费结果，自动淘汰最旧条目防止无界增长 */
  private pushPendingResult(task: BackgroundTask): void {
    this.pendingResults.push(task);
    if (this.pendingResults.length > BackgroundDelegator.MAX_PENDING_RESULTS) {
      this.pendingResults.shift();
    }
  }

  /** 自动淘汰已完成的过期任务 */
  private cleanupExpired(): void {
    const toRemove = this.listTasks().filter(
      (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled" || t.status === "timeout",
    );
    for (const task of toRemove) {
      this.tasks.delete(task.id);
    }
  }
}
