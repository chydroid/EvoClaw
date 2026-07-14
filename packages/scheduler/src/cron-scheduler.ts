import { EventEmitter } from "events";
import * as crypto from "crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CronJobStatus = "idle" | "running" | "paused" | "error";

export interface CronJobConfig {
  /** Unique job id. Auto-generated when omitted. */
  id?: string;
  /** Human-readable name for the job. */
  name: string;
  /** Cron expression: "minute hour dayOfMonth month dayOfWeek" */
  schedule: string;
  /** Async function executed when the schedule fires. */
  task: () => Promise<void>;
  /** Associated agent id (optional). */
  agentId?: string;
  /** Whether the job starts enabled. Default: true. */
  enabled?: boolean;
  /**
   * When true every execution receives a unique sessionId so the run is
   * isolated from other invocations.  Default: false.
   */
  isolatedSession?: boolean;
  /** Maximum execution time in ms.  Runs exceeding this are aborted. */
  timeout?: number;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  task: () => Promise<void>;
  agentId?: string;
  enabled: boolean;
  isolatedSession: boolean;
  timeout?: number;
  status: CronJobStatus;
  createdAt: Date;
  updatedAt: Date;
  lastRun?: Date;
  nextRun?: Date;
  runCount: number;
  errorCount: number;
  lastError?: string;
}

export interface CronExecutionRecord {
  jobId: string;
  jobName: string;
  sessionId?: string;
  startedAt: Date;
  completedAt?: Date;
  duration?: number;
  success: boolean;
  error?: string;
  result?: unknown;
}

// ─── Cron Expression Parser ──────────────────────────────────────────────────

interface CronField {
  values: Set<number>;
  isAll: boolean;
}

interface CronFields {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const RANGES: Record<string, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 7],
};

class CronExpression {
  readonly fields: CronFields;

  private constructor(fields: CronFields) {
    this.fields = fields;
  }

  // ── Parse ────────────────────────────────────────────────────────────────

  static parse(expression: string): CronExpression {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(
        `Invalid cron expression "${expression}": expected 5 fields, got ${parts.length}`,
      );
    }

    return new CronExpression({
      minute: CronExpression.parseField(parts[0], "minute"),
      hour: CronExpression.parseField(parts[1], "hour"),
      dayOfMonth: CronExpression.parseField(parts[2], "dayOfMonth"),
      month: CronExpression.parseField(parts[3], "month"),
      dayOfWeek: CronExpression.parseField(parts[4], "dayOfWeek"),
    });
  }

  private static parseField(raw: string, fieldName: string): CronField {
    const [min, max] = RANGES[fieldName];
    const trimmed = raw.trim();

    if (trimmed === "*") {
      return { values: new Set(), isAll: true };
    }

    const values = new Set<number>();
    const segments = trimmed.split(",");

    for (const seg of segments) {
      // 安全：处理步进值语法（如 */5、0-30/2、5/10）
      // 旧实现不解析 /step，导致 0-30/2 被当作 0-30（每分钟都触发）
      let step = 1;
      let hasStep = false;
      let rangePart = seg;
      if (seg.includes("/")) {
        hasStep = true;
        const slashParts = seg.split("/");
        if (slashParts.length !== 2) {
          throw new Error(`Invalid step expression "${seg}" in field "${fieldName}"`);
        }
        rangePart = slashParts[0];
        step = parseInt(slashParts[1], 10);
        if (isNaN(step) || step < 1) {
          throw new Error(`Invalid step value "${slashParts[1]}" in field "${fieldName}"`);
        }
      }

      if (rangePart === "*") {
        // */step 语法：从 min 到 max，按 step 递增
        for (let v = min; v <= max; v += step) {
          if (fieldName === "dayOfWeek" && v === 7) {
            values.add(0);
          } else {
            values.add(v);
          }
        }
      } else if (rangePart.includes("-")) {
        const parts = rangePart.split("-");
        if (parts.length !== 2) throw new Error(`Invalid range "${rangePart}" in field "${fieldName}"`);
        const [lo, hi] = parts;
        const loNum = parseInt(lo, 10);
        const hiNum = parseInt(hi, 10);
        if (isNaN(loNum) || isNaN(hiNum)) {
          throw new Error(`Invalid range "${rangePart}" in field "${fieldName}"`);
        }
        if (loNum < min || hiNum > max || loNum > hiNum) {
          throw new Error(
            `Range ${loNum}-${hiNum} out of bounds [${min},${max}] in field "${fieldName}"`,
          );
        }
        for (let v = loNum; v <= hiNum; v += step) {
          // BUG 9.1 fix: cron 标准中 dayOfWeek=7 等价于 0（周日）。
          // Date.getDay() 返回 0-6，7 永不匹配。归一化为 0。
          if (fieldName === "dayOfWeek" && v === 7) {
            values.add(0);
          } else {
            values.add(v);
          }
        }
      } else {
        const num = parseInt(rangePart, 10);
        if (isNaN(num) || num < min || num > max) {
          throw new Error(
            `Value "${rangePart}" out of bounds [${min},${max}] in field "${fieldName}"`,
          );
        }
        // BUG 9.1 fix: 同上，dayOfWeek=7 归一化为 0
        if (hasStep) {
          // num/step 语法：从 num 到 max 按 step 递增
          for (let v = num; v <= max; v += step) {
            if (fieldName === "dayOfWeek" && v === 7) {
              values.add(0);
            } else {
              values.add(v);
            }
          }
        } else {
          // 纯数字：仅此单一值，不应扩展为范围
          if (fieldName === "dayOfWeek" && num === 7) {
            values.add(0);
          } else {
            values.add(num);
          }
        }
      }
    }

    return { values, isAll: false };
  }

  // ── Match ────────────────────────────────────────────────────────────────

  /** Check whether `date` satisfies this cron expression. */
  matches(date: Date): boolean {
    return (
      CronExpression.fieldMatches(this.fields.minute, date.getMinutes()) &&
      CronExpression.fieldMatches(this.fields.hour, date.getHours()) &&
      CronExpression.dayMatches(
        this.fields.dayOfMonth,
        this.fields.dayOfWeek,
        date,
      )
      && CronExpression.fieldMatches(this.fields.month, date.getMonth() + 1)
    );
  }

  private static fieldMatches(field: CronField, actual: number): boolean {
    return field.isAll || field.values.has(actual);
  }

  /**
   * Cron rules for day fields:
   * - If both dayOfMonth and dayOfWeek are specified (non-*), match on EITHER.
   * - If only one is specified, use that one.
   * - If both are *, match all days.
   */
  private static dayMatches(
    dom: CronField,
    dow: CronField,
    date: Date,
  ): boolean {
    const domAll = dom.isAll;
    const dowAll = dow.isAll;

    if (!domAll && !dowAll) {
      // Both specified → OR logic
      return (
        dom.values.has(date.getDate()) ||
        dow.values.has(date.getDay())
      );
    }

    if (!domAll) return dom.values.has(date.getDate());
    if (!dowAll) return dow.values.has(date.getDay());
    return true;
  }

  // ── Next date ────────────────────────────────────────────────────────────

  /**
   * Compute the next date (after `from`) matching this cron expression.
   * Walks minute-by-minute up to 2 years forward.  Returns null if
   * no match is found within that window.
   */
  static nextDate(expression: string, from: Date = new Date()): Date | null {
    const cronExpr = CronExpression.parse(expression);
    const maxIterations = 2 * 366 * 24 * 60; // ~1 053 120 minutes ≈ 2 years
    const candidate = new Date(from);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    for (let i = 0; i < maxIterations; i++) {
      if (cronExpr.matches(candidate)) {
        return candidate;
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }

    return null;
  }

  // ── Validate ─────────────────────────────────────────────────────────────

  static validate(expression: string): boolean {
    try {
      CronExpression.parse(expression);
      return true;
    } catch {
      return false;
    }
  }
}

// ─── CronScheduler ──────────────────────────────────────────────────────────

/** Generate a unique id using crypto.randomUUID() (replaces Math.random-based short id). */
function uid(): string {
  return crypto.randomUUID();
}

export declare interface CronScheduler {
  emit(event: "job:start", record: CronExecutionRecord): boolean;
  emit(event: "job:complete", record: CronExecutionRecord): boolean;
  emit(event: "job:error", record: CronExecutionRecord): boolean;
  emit(event: "job:paused", jobId: string): boolean;
  emit(event: "job:resumed", jobId: string): boolean;

  on(event: "job:start", listener: (record: CronExecutionRecord) => void): this;
  on(event: "job:complete", listener: (record: CronExecutionRecord) => void): this;
  on(event: "job:error", listener: (record: CronExecutionRecord) => void): this;
  on(event: "job:paused", listener: (jobId: string) => void): this;
  on(event: "job:resumed", listener: (jobId: string) => void): this;
}

export class CronScheduler extends EventEmitter {
  private jobs: Map<string, CronJob> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private executionHistory: CronExecutionRecord[] = [];
  private running: Set<string> = new Set();
  private maxConcurrent: number;

  constructor(options?: { maxConcurrentJobs?: number }) {
    super();
    this.maxConcurrent = options?.maxConcurrentJobs ?? 5;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Create & register a scheduled job.  If `config.enabled` is not explicitly
   * `false` the first timer is armed immediately.
   */
  addJob(config: CronJobConfig): CronJob {
    if (!CronExpression.validate(config.schedule)) {
      throw new Error(`Invalid cron schedule: "${config.schedule}"`);
    }

    const id = config.id ?? uid();
    if (this.jobs.has(id)) {
      throw new Error(`Job with id "${id}" already exists`);
    }

    const now = new Date();
    const job: CronJob = {
      id,
      name: config.name,
      schedule: config.schedule,
      task: config.task,
      agentId: config.agentId,
      enabled: config.enabled !== false,
      isolatedSession: config.isolatedSession ?? false,
      timeout: config.timeout,
      status: config.enabled !== false ? "idle" : "paused",
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      errorCount: 0,
    };

    this.jobs.set(id, job);

    if (job.enabled) {
      this.scheduleNext(job);
    }

    return { ...job };
  }

  /** Remove a job entirely.  Any pending timer is cancelled. */
  removeJob(id: string): boolean {
    this.clearTimer(id);
    this.running.delete(id);
    return this.jobs.delete(id);
  }

  /** Get a single job by id (shallow copy). */
  getJob(id: string): CronJob | undefined {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  /** Return all registered jobs (shallow copies). */
  listJobs(): CronJob[] {
    return [...this.jobs.values()].map((j) => ({ ...j }));
  }

  /** Pause a job so it no longer fires on schedule. */
  pauseJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === "paused") return true;

    this.clearTimer(id);
    job.status = "paused";
    job.enabled = false;
    job.updatedAt = new Date();
    this.emit("job:paused", id);
    return true;
  }

  /** Resume a paused job.  The next run is re-calculated. */
  resumeJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status !== "paused") return true;

    job.status = "idle";
    job.enabled = true;
    job.updatedAt = new Date();
    this.scheduleNext(job);
    this.emit("job:resumed", id);
    return true;
  }

  /**
   * Return execution history, optionally filtered to a single job.
   * Most-recent records come last.
   */
  getExecutionHistory(jobId?: string, limit = 100): CronExecutionRecord[] {
    let records = this.executionHistory;
    if (jobId) {
      records = records.filter((r) => r.jobId === jobId);
    }
    return records.slice(-limit);
  }

  /** Number of jobs currently executing. */
  get activeRunCount(): number {
    return this.running.size;
  }

  /** Return all execution history (exposed for introspection / testing). */
  get fullHistory(): CronExecutionRecord[] {
    return [...this.executionHistory];
  }

  /**
   * Shutdown the scheduler: cancel all pending timers, mark jobs as stopped,
   * and clear execution history.  In-flight jobs are not forcibly killed — they
   * are allowed to finish naturally (the `running` set tracks them).
   */
  shutdown(): void {
    for (const [jobId, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
    for (const job of this.jobs.values()) {
      if (job.status === "idle" || job.status === "running") {
        job.status = "paused";
      }
      job.nextRun = undefined;
    }
    this.running.clear();
    this.executionHistory = [];
  }

  // ── Internal scheduling ──────────────────────────────────────────────────

  private scheduleNext(job: CronJob): void {
    this.clearTimer(job.id);

    if (!job.enabled || job.status === "paused") return;

    const next = CronExpression.nextDate(job.schedule);
    if (!next) return;

    job.nextRun = next;
    job.updatedAt = new Date();

    const delay = Math.max(0, next.getTime() - Date.now());
    // 安全：setTimeout delay 超过 2^31-1 ms（约 24.8 天）会被截断为 1ms，
    // 导致 CPU 忙循环。将长 delay 拆分为多个最多 24 天的 setTimeout。
    const MAX_TIMER_DELAY = 2_000_000_000; // ~23 天，安全低于 2^31-1
    const scheduleWithCap = (remaining: number): void => {
      const cappedDelay = Math.min(remaining, MAX_TIMER_DELAY);
      const timer = setTimeout(() => {
        if (remaining > MAX_TIMER_DELAY) {
          // 继续等待剩余时间
          scheduleWithCap(remaining - cappedDelay);
        } else {
          void this.executeJob(job.id).catch((err) => {
            process.stderr.write(`[CronScheduler] executeJob failed for "${job.id}":` + " " + err + "\n");
          });
        }
      }, cappedDelay);
      timer.unref();
      this.timers.set(job.id, timer);
    };
    scheduleWithCap(delay);
  }

  private clearTimer(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
  }

  private async executeJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    // BUG 9.2 fix: 原代码仅检查 this.running.size >= maxConcurrent，
    // 未检查 this.running.has(jobId)，可能导致同一 job 并发执行
    //（如长任务运行中，下一次 cron tick 触发同一 job）。
    if (this.running.has(jobId)) {
      // 同一 job 已在运行，跳过本次触发，等待下次调度
      this.scheduleNext(job);
      return;
    }

    // Enforce concurrency limit
    if (this.running.size >= this.maxConcurrent) {
      // Re-schedule for 1 second later and try again
      const retryTimer = setTimeout(() => {
        void this.executeJob(jobId).catch((err) => {
          process.stderr.write(`[CronScheduler] retry executeJob failed for "${jobId}":` + " " + err + "\n");
        });
      }, 1000);
      retryTimer.unref?.();
      this.timers.set(jobId, retryTimer);
      return;
    }

    this.running.add(jobId);

    const sessionId = job.isolatedSession ? uid() : undefined;
    const startedAt = new Date();

    const record: CronExecutionRecord = {
      jobId: job.id,
      jobName: job.name,
      sessionId,
      startedAt,
      success: false,
    };

    this.emit("job:start", { ...record });

    job.status = "running";
    job.lastRun = startedAt;
    job.runCount++;
    job.updatedAt = new Date();

    try {
      const result = await this.runWithTimeout(job);
      record.completedAt = new Date();
      record.duration = record.completedAt.getTime() - startedAt.getTime();
      record.success = true;
      record.result = result;

      job.status = "idle";
      job.lastError = undefined;
      this.emit("job:complete", { ...record });
    } catch (err) {
      record.completedAt = new Date();
      record.duration = record.completedAt.getTime() - startedAt.getTime();
      const msg = err instanceof Error ? err.message : String(err);
      record.error = msg;

      job.status = "error";
      job.errorCount++;
      job.lastError = msg;
      this.emit("job:error", { ...record });
    } finally {
      this.running.delete(jobId);
      job.updatedAt = new Date();
      this.executionHistory.push(record);
      if (this.executionHistory.length > 1000) {
        this.executionHistory = this.executionHistory.slice(-500);
      }
      // Re-schedule next run regardless of success/failure
      this.scheduleNext(job);
    }
  }

  private async runWithTimeout(job: CronJob): Promise<unknown> {
    if (!job.timeout || job.timeout <= 0) {
      return job.task();
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Job "${job.name}" timed out after ${job.timeout}ms`)),
        job.timeout,
      );
      timer.unref?.();
    });

    const taskPromise = job.task();
    let taskError: unknown = null;
    taskPromise.catch((err) => { taskError = err; });
    try {
      return await Promise.race([taskPromise, timeoutPromise]);
    } catch (raceErr) {
      // 如果是超时，且任务本身也失败了，附加原始错误信息
      if (taskError) {
        throw new Error(`${raceErr instanceof Error ? raceErr.message : String(raceErr)} (task error: ${taskError instanceof Error ? taskError.message : String(taskError)})`);
      }
      throw raceErr;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // 防止超时后任务仍 pending 并最终 reject 导致 unhandledRejection，并记录日志
      taskPromise.catch((err) => {
        process.stderr.write(`[CronScheduler] Job "${job.name}" rejected after timeout: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
  }
}