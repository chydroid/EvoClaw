export { ScheduleManager } from "./schedule-manager";
export type {
  ScheduledTask,
  TaskRunResult,
  ScheduleStats,
} from "./schedule-manager";

export { CronScheduler } from "./cron-scheduler";
export type {
  CronJob,
  CronJobConfig,
  CronJobStatus,
  CronExecutionRecord,
} from "./cron-scheduler";

export { CronRunLogger } from "./run-log";
export type { RunLogEntry, RunLogQuery, RunLogConfig, RunLogStats } from "./run-log";

// 第 5 轮提升：cron 子系统能力扩展
export {
  StaggerCoordinator,
  isTopOfHourCronExpr,
  normalizeCronStaggerMs,
  resolveDefaultCronStaggerMs,
  DEFAULT_TOP_OF_HOUR_STAGGER_MS,
} from "./stagger";
export type { StaggerEntry, StaggerDecision, StaggerCoordinatorOptions } from "./stagger";

export { SessionReaper, isZombieSession } from "./session-reaper";
export type {
  ReaperSession,
  ReaperDecision,
  ReaperHandlers,
  SessionReaperOptions,
} from "./session-reaper";

export { RunLogStore, asSqliteDatabase } from "./run-log-store";
export type {
  RunLogEntry as SqliteRunLogEntry,
  RunLogQuery as SqliteRunLogQuery,
  RunLogStats as SqliteRunLogStats,
  SqliteDatabaseLike,
} from "./run-log-store";

export {
  validateCronProtocol,
  checkCronExpression,
  isValidIanaTimezone,
  nextRunHint,
  hasErrors,
  findingsByRule,
  MAX_NAME_LENGTH,
  MAX_TIMEOUT_MS,
  MAX_RETRIES,
} from "./cron-protocol-conformance";
export type { CronJobSpec, ConformanceFinding } from "./cron-protocol-conformance";