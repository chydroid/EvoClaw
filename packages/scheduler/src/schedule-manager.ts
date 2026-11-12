import { ServiceRegistry, EventBus, atomicWriteFileSync } from "@evoclaw/core";
import * as cron from "node-cron";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export interface ScheduledTask {
  id: string;
  name: string;
  cronExpression: string;
  description: string;
  handlerType: "email_check" | "report_generate" | "browser_action" | "system_cleanup" | "custom" | "shell";
  handlerConfig: Record<string, unknown>;
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
  runCount: number;
  errorCount: number;
  /** 连续失败次数（对标 hermes failure_streak） */
  failureStreak: number;
  maxRetries: number;
  retryDelayMs: number;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
  /**
   * P7：派发前写入的「已认领窗口」。进程崩溃后重启时据此只补跑一次；
   * owner 存活且未过期时其他进程不得接手。
   */
  pendingSlot?: {
    /** 该次运行对应的计划触发时间（ISO） */
    scheduledAt: string;
    /** 认领时间（ISO） */
    stampedAt: string;
    /** 认领进程 PID */
    owner: number;
    /** true 表示这是重启后的恢复认领（只恢复一次） */
    recovered?: boolean;
  };
  /**
   * P7：每任务运行配额（EvoClaw 扩展，非 Hermes quota_hold）。
   * windowMs 窗口内最多 limit 次；未配置 = 不限制。
   */
  quota?: {
    windowMs: number;
    limit: number;
    windowStart?: string;
    used?: number;
  };
  /** P7：每任务时区（IANA）；未配置时回落全局 EVOCLAW_TIMEZONE */
  timezone?: string;
}

/** P7：pendingSlot 超过该时长即视为过期（owner 可能假活/停滞） */
const PENDING_SLOT_TTL_MS = 300_000;

export interface TaskRunResult {
  taskId: string;
  runAt: Date;
  success: boolean;
  duration: number;
  error?: string;
  output?: unknown;
}

export interface ScheduleStats {
  totalTasks: number;
  activeTasks: number;
  totalRuns: number;
  totalErrors: number;
  lastRun?: Date;
}

export class ScheduleManager {
  private tasks: Map<string, ScheduledTask> = new Map();
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private runHistory: TaskRunResult[] = [];
  private handlers: Map<string, (task: ScheduledTask) => Promise<void>> = new Map();
  private runningTasks: Set<string> = new Set();
  private dataDir: string;
  private started = false;
  private failureNudgeThreshold: number;
  /** P7：loadTasks 恢复的待补跑任务（start() 时执行一次） */
  private recoveredTaskIds = new Set<string>();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    options?: { dataDir?: string; failureNudgeThreshold?: number }
  ) {
    this.dataDir = options?.dataDir || path.join(process.cwd(), "data", "scheduler");
    // 2026-10-25 P2：连续失败审查阈值（对标 hermes cron.failure_nudge_threshold，默认 3）
    this.failureNudgeThreshold = options?.failureNudgeThreshold ?? 3;
  }

  async initialize(): Promise<void> {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    await this.loadTasks();
  }

  registerHandler(
    handlerType: ScheduledTask["handlerType"],
    handler: (task: ScheduledTask) => Promise<void>
  ): void {
    this.handlers.set(handlerType, handler);
  }

  createTask(options: {
    name: string;
    cronExpression: string;
    description?: string;
    handlerType: ScheduledTask["handlerType"];
    handlerConfig?: Record<string, unknown>;
    maxRetries?: number;
    retryDelayMs?: number;
    enabled?: boolean;
    /** P7：任务时区（IANA），缺省回落全局 */
    timezone?: string;
    /** P7：每任务运行配额 */
    quota?: ScheduledTask["quota"];
  }): ScheduledTask {
    if (!cron.validate(options.cronExpression)) {
      throw new Error(`Invalid cron expression: ${options.cronExpression}`);
    }

    const id = `task-${crypto.randomUUID()}`;
    const nextDate = this.calculateNextRun(options.cronExpression);

    const task: ScheduledTask = {
      id,
      name: options.name,
      cronExpression: options.cronExpression,
      description: options.description || "",
      handlerType: options.handlerType,
      handlerConfig: options.handlerConfig || {},
      enabled: options.enabled !== false,
      runCount: 0,
      errorCount: 0,
      failureStreak: 0,
      maxRetries: options.maxRetries ?? 3,
      retryDelayMs: options.retryDelayMs ?? 60000,
      nextRun: nextDate,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(options.timezone ? { timezone: options.timezone } : {}),
      ...(options.quota ? { quota: options.quota } : {}),
    };

    this.tasks.set(id, task);
    this.saveTasks();

    if (this.started && task.enabled) {
      this.startTask(task);
    }

    this.eventBus.publish(
      "scheduler.task_created",
      { taskId: id, name: task.name, cronExpression: task.cronExpression },
      "schedule-manager"
    );

    return { ...task };
  }

  updateTask(
    taskId: string,
    updates: Partial<Pick<ScheduledTask, "name" | "cronExpression" | "description" | "handlerType" | "handlerConfig" | "enabled" | "maxRetries" | "retryDelayMs" | "timezone" | "quota">>
  ): ScheduledTask | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const wasEnabled = task.enabled;
    const cronChanged = updates.cronExpression && updates.cronExpression !== task.cronExpression;

    if (updates.cronExpression !== undefined) {
      if (!cron.validate(updates.cronExpression)) {
        throw new Error(`Invalid cron expression: ${updates.cronExpression}`);
      }
    }

    // 过滤危险键防止原型污染
    const safeUpdates = Object.fromEntries(
      Object.entries(updates).filter(([k]) => k !== "__proto__" && k !== "constructor" && k !== "prototype")
    );
    Object.assign(task, safeUpdates, { updatedAt: new Date() });

    if (this.started) {
      this.stopTask(taskId);

      if (cronChanged) {
        task.nextRun = this.calculateNextRun(task.cronExpression);
      }

      if (task.enabled) {
        this.startTask(task);
      }
    } else if (wasEnabled && updates.enabled === false) {
      this.stopTask(taskId);
    }

    this.saveTasks();
    return { ...task };
  }

  deleteTask(taskId: string): boolean {
    this.stopTask(taskId);
    const removed = this.tasks.delete(taskId);
    if (removed) {
      this.saveTasks();
      this.eventBus.publish(
        "scheduler.task_deleted",
        { taskId },
        "schedule-manager"
      );
    }
    return removed;
  }

  getTask(taskId: string): ScheduledTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : undefined;
  }

  listTasks(): ScheduledTask[] {
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }

  getStats(): ScheduleStats {
    const tasks = [...this.tasks.values()];
    return {
      totalTasks: tasks.length,
      activeTasks: tasks.filter((t) => t.enabled).length,
      totalRuns: tasks.reduce((sum, t) => sum + t.runCount, 0),
      totalErrors: tasks.reduce((sum, t) => sum + t.errorCount, 0),
      lastRun: this.runHistory.length > 0
        ? this.runHistory[this.runHistory.length - 1].runAt
        : undefined,
    };
  }

  getRunHistory(taskId?: string, limit = 50): TaskRunResult[] {
    let history = this.runHistory;
    if (taskId) {
      history = history.filter((r) => r.taskId === taskId);
    }
    if (limit <= 0) return [];
    return history.slice(-limit);
  }

  async executeTask(taskId: string): Promise<TaskRunResult> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return {
        taskId,
        runAt: new Date(),
        success: false,
        duration: 0,
        error: "Task not found",
      };
    }

    return this.runTask(task);
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    for (const task of this.tasks.values()) {
      if (task.enabled) {
        this.startTask(task);
      }
    }

    // P7：崩溃/停机恢复 —— 每个 pendingSlot 只补跑一次。
    // runningTasks 守卫保证与刚触发的 cron tick 不会双跑。
    const recovered = [...this.recoveredTaskIds];
    this.recoveredTaskIds.clear();
    for (const taskId of recovered) {
      const task = this.tasks.get(taskId);
      if (!task || !task.enabled) continue;
      void this.runTask(task);
    }

    this.eventBus.publish(
      "scheduler.started",
      { activeTaskCount: [...this.tasks.values()].filter((t) => t.enabled).length },
      "schedule-manager"
    );
  }

  async stop(): Promise<void> {
    this.started = false;
    // 停止所有 cron job，阻止新任务触发
    for (const [id] of this.tasks) {
      this.stopTask(id);
    }
    // 等待运行中任务完成（带超时，避免永久阻塞关闭流程）
    const STOP_TIMEOUT_MS = 5000;
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (this.runningTasks.size > 0 && Date.now() < deadline) {
      // unref 防止定时器阻止进程优雅退出
      await new Promise(resolve => {
        const t = setTimeout(resolve, 100);
        t.unref();
      });
    }
    await this.eventBus.publish("scheduler.stopped", {}, "schedule-manager");
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  private startTask(task: ScheduledTask): void {
    if (this.cronJobs.has(task.id)) return;

    try {
      const job = cron.schedule(task.cronExpression, async () => {
        await this.runTask(task);
      }, {
        scheduled: true,
        // P7：任务级时区优先；老任务无该字段时保持原全局行为，避免静默平移
        timezone: task.timezone || process.env.EVOCLAW_TIMEZONE || "Asia/Shanghai",
      });

      this.cronJobs.set(task.id, job);
      task.nextRun = this.calculateNextRun(task.cronExpression);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.eventBus.publish("scheduler.task_error", {
        taskId: task.id,
        error: `Failed to start cron job: ${msg}`,
      }, "schedule-manager");
    }
  }

  private stopTask(taskId: string): void {
    const job = this.cronJobs.get(taskId);
    if (job) {
      job.stop();
      this.cronJobs.delete(taskId);
    }
  }

  private async runTask(task: ScheduledTask): Promise<TaskRunResult> {
    // 防止同一任务并发执行（cron tick 可能在前一次运行未完成时再次触发）
    if (this.runningTasks.has(task.id)) {
      process.stderr.write(`[ScheduleManager] Task "${task.name}" (${task.id}) already running, skipping this tick\n`);
      return { taskId: task.id, runAt: new Date(), success: false, duration: 0, error: "Already running" };
    }

    // P7：配额门（手动 executeTask 同样经过此门；配置见 ScheduledTask.quota）
    if (!this.consumeQuota(task)) {
      const result: TaskRunResult = {
        taskId: task.id,
        runAt: new Date(),
        success: false,
        duration: 0,
        error: "Quota exceeded",
      };
      this.eventBus.publish(
        "scheduler.task_skipped",
        { taskId: task.id, name: task.name, reason: "quota", quota: task.quota },
        "schedule-manager",
      );
      process.stderr.write(`[ScheduleManager] Task "${task.name}" skipped: quota exceeded\n`);
      return result;
    }

    this.runningTasks.add(task.id);

    // P7：派发前持久认领窗口（at-most-once）。同步落盘，崩溃后可据此恢复一次。
    const scheduledAt = (task.nextRun ?? new Date()).toISOString();
    task.pendingSlot = {
      scheduledAt,
      stampedAt: new Date().toISOString(),
      owner: process.pid,
    };
    this.saveTasksSync();

    try {
      return await this.runTaskInner(task);
    } finally {
      this.runningTasks.delete(task.id);
      // 正常路径 recordResult 已清除；异常路径在此兜底，避免窗口永久悬挂
      if (task.pendingSlot?.owner === process.pid) {
        task.pendingSlot = undefined;
        this.saveTasksSync();
      }
    }
  }

  private async runTaskInner(task: ScheduledTask): Promise<TaskRunResult> {
    const startTime = Date.now();
    const runAt = new Date();

    const handler = this.handlers.get(task.handlerType);
    if (!handler) {
      const result: TaskRunResult = {
        taskId: task.id,
        runAt,
        success: false,
        duration: Date.now() - startTime,
        error: `No handler registered for handlerType: ${task.handlerType}`,
      };
      this.recordResult(task, result);
      return result;
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= task.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await this.sleep(task.retryDelayMs);
        }

        await handler(task);

        const result: TaskRunResult = {
          taskId: task.id,
          runAt,
          success: true,
          duration: Date.now() - startTime,
        };

        this.recordResult(task, result);

        await this.eventBus.publish(
          "scheduler.task_completed",
          { taskId: task.id, name: task.name, duration: result.duration },
          "schedule-manager"
        );

        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        await this.eventBus.publish(
          "scheduler.task_retry",
          {
            taskId: task.id,
            name: task.name,
            attempt: attempt + 1,
            maxRetries: task.maxRetries,
            error: lastError.message,
          },
          "schedule-manager"
        );
      }
    }

    const result: TaskRunResult = {
      taskId: task.id,
      runAt,
      success: false,
      duration: Date.now() - startTime,
      error: lastError?.message || "Max retries exceeded",
    };

    this.recordResult(task, result);

    await this.eventBus.publish(
      "scheduler.task_failed",
      {
        taskId: task.id,
        name: task.name,
        error: lastError?.message,
        totalAttempts: task.maxRetries + 1,
      },
      "schedule-manager"
    );

    return result;
  }

  /**
   * P7：消费一次配额。窗口滚动时重置计数。
   * @returns true = 允许运行；false = 配额耗尽（本窗口不再运行）
   */
  private consumeQuota(task: ScheduledTask): boolean {
    const quota = task.quota;
    if (!quota || quota.limit <= 0) return true;
    const now = Date.now();
    const windowStart = quota.windowStart ? Date.parse(quota.windowStart) : NaN;
    if (!Number.isFinite(windowStart) || now - windowStart >= quota.windowMs) {
      quota.windowStart = new Date(now).toISOString();
      quota.used = 0;
    }
    if ((quota.used ?? 0) >= quota.limit) {
      this.saveTasksSync();
      return false;
    }
    quota.used = (quota.used ?? 0) + 1;
    return true;
  }

  private recordResult(task: ScheduledTask, result: TaskRunResult): void {
    // P7：运行结束（成功/失败）即释放认领窗口
    task.pendingSlot = undefined;
    task.runCount++;
    task.lastRun = result.runAt;
    task.nextRun = this.calculateNextRun(task.cronExpression);
    task.updatedAt = new Date();

    if (!result.success) {
      task.errorCount++;
      task.lastError = result.error;
      // 2026-10-25 P2：连续失败计数（对标 hermes _failure_streak_nudge）
      task.failureStreak++;
      if (this.failureNudgeThreshold > 0 && task.failureStreak >= this.failureNudgeThreshold) {
        // 发布审查建议事件——由上层（slash command / notification）消费
        this.eventBus.publish(
          "scheduler.failure_streak_review",
          {
            taskId: task.id,
            taskName: task.name,
            streak: task.failureStreak,
            lastError: task.lastError,
            nudge: `此任务已连续失败 ${task.failureStreak} 次。建议检查任务配置或提示词，或暂停该任务。`,
          },
          "schedule-manager",
        );
      }
    } else {
      task.lastError = undefined;
      task.failureStreak = 0;
    }

    this.runHistory.push(result);
    if (this.runHistory.length > 1000) {
      this.runHistory = this.runHistory.slice(-500);
    }

    this.saveTasks();
  }

  private calculateNextRun(cronExpression: string): Date | undefined {
    // BUG 10.2 fix: 原代码若 nextDate() 抛错，interval.stop() 不会执行，
    // 导致 cron interval 定时器泄漏。改用 try/finally 确保释放。
    let interval: { nextDate(): { toJSDate(): Date }; stop(): void } | null = null;
    try {
      interval = cron.schedule(cronExpression, () => {}, { scheduled: false }) as unknown as { nextDate(): { toJSDate(): Date }; stop(): void };
      const next = interval.nextDate();
      return next.toJSDate();
    } catch {
      return undefined;
    } finally {
      if (interval) {
        try { interval.stop(); } catch { /* ignore stop errors */ }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  private async loadTasks(): Promise<void> {
    try {
      const filePath = path.join(this.dataDir, "tasks.json");
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw) as ScheduledTask[];
        for (const t of data) {
          this.tasks.set(t.id, {
            ...t,
            failureStreak: t.failureStreak ?? 0,
            createdAt: new Date(t.createdAt),
            updatedAt: new Date(t.updatedAt),
            lastRun: t.lastRun ? new Date(t.lastRun) : undefined,
            nextRun: t.nextRun ? new Date(t.nextRun) : undefined,
          });
        }
      }
      this.recoverPendingSlots();
    } catch (err) {
      process.stderr.write("[ScheduleManager] Failed to load tasks:" + " " + err + "\n");
    }
  }

  /**
   * P7 恢复：pendingSlot 的 owner 仍存活且未超过 TTL → 不动（另一个进程正在跑）；
   * 否则本进程认领一次，start() 时补跑。停用的任务只清窗口、不补跑。
   */
  private recoverPendingSlots(): void {
    const now = Date.now();
    let changed = false;
    for (const task of this.tasks.values()) {
      const slot = task.pendingSlot;
      if (!slot) continue;

      const stampedAt = Date.parse(slot.stampedAt);
      const fresh = Number.isFinite(stampedAt) && now - stampedAt < PENDING_SLOT_TTL_MS;
      if (isPidAlive(slot.owner) && fresh) {
        // 活着的 owner 正在执行（或刚认领），不抢
        continue;
      }

      if (!task.enabled) {
        task.pendingSlot = undefined;
        changed = true;
        continue;
      }

      // 只恢复一次：覆盖为当前进程的认领窗口 + 标记 recovered
      task.pendingSlot = {
        scheduledAt: slot.scheduledAt,
        stampedAt: new Date(now).toISOString(),
        owner: process.pid,
        recovered: true,
      };
      task.nextRun = new Date(now);
      this.recoveredTaskIds.add(task.id);
      changed = true;
      process.stderr.write(
        `[ScheduleManager] Recovering missed slot for task "${task.name}" (${task.id}) ` +
        `scheduled at ${slot.scheduledAt} (owner ${slot.owner})\n`,
      );
    }
    if (changed) {
      this.saveTasksSync();
    }
  }

  private async saveTasks(): Promise<void> {
    this.saveTasksSync();
  }

  /** 同步落盘（P7：派发前认领窗口必须在下一次 tick 前写入磁盘） */
  private saveTasksSync(): void {
    try {
      const filePath = path.join(this.dataDir, "tasks.json");
      const data = [...this.tasks.values()];
      atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      process.stderr.write("[ScheduleManager] Failed to save tasks:" + " " + err + "\n");
    }
  }
}

/** PID 存活检测：EPERM 视为存活（与 CrossProcessLock 语义一致） */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
