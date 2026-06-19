import { ServiceRegistry, EventBus } from "@evoclaw/core";
import * as cron from "node-cron";
import * as fs from "fs";
import * as path from "path";

export interface ScheduledTask {
  id: string;
  name: string;
  cronExpression: string;
  description: string;
  handlerType: "email_check" | "report_generate" | "browser_action" | "system_cleanup" | "custom";
  handlerConfig: Record<string, unknown>;
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
  runCount: number;
  errorCount: number;
  maxRetries: number;
  retryDelayMs: number;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

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
  private dataDir: string;
  private started = false;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    options?: { dataDir?: string }
  ) {
    this.dataDir = options?.dataDir || path.join(process.cwd(), "data", "scheduler");
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
  }): ScheduledTask {
    if (!cron.validate(options.cronExpression)) {
      throw new Error(`Invalid cron expression: ${options.cronExpression}`);
    }

    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
      maxRetries: options.maxRetries ?? 3,
      retryDelayMs: options.retryDelayMs ?? 60000,
      nextRun: nextDate,
      createdAt: new Date(),
      updatedAt: new Date(),
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
    updates: Partial<Pick<ScheduledTask, "name" | "cronExpression" | "description" | "handlerType" | "handlerConfig" | "enabled" | "maxRetries" | "retryDelayMs">>
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

    Object.assign(task, updates, { updatedAt: new Date() });

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

    this.eventBus.publish(
      "scheduler.started",
      { activeTaskCount: [...this.tasks.values()].filter((t) => t.enabled).length },
      "schedule-manager"
    );
  }

  stop(): void {
    this.started = false;
    for (const [id] of this.tasks) {
      this.stopTask(id);
    }
    this.eventBus.publish("scheduler.stopped", {}, "schedule-manager");
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
        timezone: "Asia/Shanghai",
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

        this.eventBus.publish(
          "scheduler.task_completed",
          { taskId: task.id, name: task.name, duration: result.duration },
          "schedule-manager"
        );

        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        this.eventBus.publish(
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

    this.eventBus.publish(
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

  private recordResult(task: ScheduledTask, result: TaskRunResult): void {
    task.runCount++;
    task.lastRun = result.runAt;
    task.nextRun = this.calculateNextRun(task.cronExpression);
    task.updatedAt = new Date();

    if (!result.success) {
      task.errorCount++;
      task.lastError = result.error;
    } else {
      task.lastError = undefined;
    }

    this.runHistory.push(result);
    if (this.runHistory.length > 1000) {
      this.runHistory = this.runHistory.slice(-500);
    }

    this.saveTasks();
  }

  private calculateNextRun(cronExpression: string): Date | undefined {
    try {
      const interval: { nextDate(): { toJSDate(): Date }; stop(): void } = cron.schedule(cronExpression, () => {}, { scheduled: false }) as unknown as { nextDate(): { toJSDate(): Date }; stop(): void };
      const next = interval.nextDate();
      interval.stop();
      return next.toJSDate();
    } catch {
      return undefined;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
            createdAt: new Date(t.createdAt),
            updatedAt: new Date(t.updatedAt),
            lastRun: t.lastRun ? new Date(t.lastRun) : undefined,
            nextRun: t.nextRun ? new Date(t.nextRun) : undefined,
          });
        }
      }
    } catch (err) {
      process.stderr.write("[ScheduleManager] Failed to load tasks:" + " " + err);
    }
  }

  private async saveTasks(): Promise<void> {
    try {
      const filePath = path.join(this.dataDir, "tasks.json");
      const data = [...this.tasks.values()];
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      process.stderr.write("[ScheduleManager] Failed to save tasks:" + " " + err);
    }
  }
}