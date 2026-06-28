export { MessageQueue } from "./message-queue";
export { ProcessManager } from "./process-manager";
export { FileSystemManager, atomicWriteFile, atomicReplace, CrossProcessLock } from "./filesystem-manager";
export { Logger } from "./logger";
export type { LogLevel } from "./logger";
export { RotatingFileAppender, pruneOldRollingLogs } from "./rotating-file-appender";
export type { RotatingFileAppenderConfig } from "./rotating-file-appender";
export {
  generateTraceId,
  generateSpanId,
  createRootTraceContext,
  createChildTraceContext,
  formatTraceparent,
  parseTraceparent,
  extractTraceContextFromHeaders,
  injectTraceContextIntoHeaders,
  withTraceContext,
  getCurrentTrace,
  emitDiagnosticEvent,
  startSpan,
} from "./trace-context";
export type {
  TraceContext,
  TraceSpanContext,
  DiagnosticEvent,
  Span,
} from "./trace-context";
export { DatabaseManager } from "./database-manager";
export { BrowserController } from "./browser-controller";
export type { NavigationResult, BrowserElement, BrowserPage, FormData } from "./browser-controller";
export { PlaywrightBrowser } from "./playwright-browser";
export type { PlaywrightTab, ScreenshotOptions, CookieData, LoginResult, FormFillOptions } from "./playwright-browser";
export { parseMarkdown, stripFormatting, extractLinks, extractUrls, renderTable, chunkMarkdown, detectLanguage } from "./markdown";
export type { CodeBlock, Frontmatter, ParsedMarkdown, ChunkOptions } from "./markdown";
export { LinkPreviewer } from "./link-understanding";
export type { LinkPreview, LinkUnderstandingConfig } from "./link-understanding";
export { Crestodian } from "./crestodian";
export type { SystemHealth, CrestodianConfig } from "./crestodian";
export { detectFromBytes, infoFromFilename, mimeFromExtension, parseDataURI, toDataURI, parseAudioTags, extractText } from "./media-processor";
export type { MediaType, MediaInfo } from "./media-processor";
export { DockerSandbox } from "./docker-sandbox";
export type { SandboxConfig, SandboxResult } from "./docker-sandbox";
export { SSHSandbox } from "./ssh-sandbox";
export type { SSHSandboxConfig, SSHSandboxResult } from "./ssh-sandbox";
export { SandboxManager } from "./sandbox-manager";
export type { SandboxBackendType, UnifiedSandboxConfig, SandboxSession } from "./sandbox-manager";
export { DaemonManager } from "./daemon-manager";
export type { DaemonConfig, DaemonStatus } from "./daemon-manager";
export { UpdateManager } from "./update-manager";
export type { UpdateConfig, ReleaseInfo, UpdateCheckResult, UpdateProgress } from "./update-manager";
export { Observability } from "./observability";
export type { MetricDef, MetricLabel, MetricValue, MetricType, TraceSpan, HealthReport, ObservabilityConfig } from "./observability";
export { TracingService } from "./tracing";
export type { TracingConfig } from "./tracing";
export { InMemorySpanCollector } from "./span-collector";
export type { RecordedSpan } from "./span-collector";
export { ApiClient, QueryBuilder, WebhookSender, GraphQLClient, PageScraper } from "./api-toolkit";
export type { ApiClientConfig, HttpRequestOptions, HttpResponse, PaginationOptions, DbQuery, WebhookPayload, PageMetadata } from "./api-toolkit";

export { ResourcePool } from "./resource-pool";
export type { PooledResource, ResourcePoolConfig, PoolStats } from "./resource-pool";
export { isScraplingAvailable, generateAdaptiveScraperScript, generateSimpleFetchScript, getScraplingInfo } from "./scrapling-bridge";
export { isYtDlpAvailable, isFfmpegAvailable, getMediaDownloaderInfo, detectPlatform, generateVideoDownloadScript, generateMusicDownloadScript } from "./media-downloader";

// SafeWriter — 安全输出写入器（防 broken pipe 崩溃）
export { SafeWriter, getSafeStdout, getSafeStderr, installSafeIOHandlers } from "./safe-writer";

// FileSystemCheckpointManager — 基于 Git 影子存储的文件系统检查点管理器
// 借鉴 hermes-agent tools/checkpoint_manager.py：支持回滚的文件快照
export {
  FileSystemCheckpointManager,
  getCheckpointManager,
  resetCheckpointManager,
  computeProjectId,
} from "./filesystem-checkpoint";
export type { CheckpointConfig, CheckpointResult, RollbackResult, CheckpointEntry } from "./filesystem-checkpoint";

// ProcessTreeKiller — 跨平台进程树终止
// 借鉴 hermes-agent tools/process_registry.py：POSIX psutil 递归 / Windows taskkill /T /F
export {
  killProcessTree,
  killChildProcessTree,
  findPidsByName,
  pidExists,
} from "./process-tree-killer";
export type { KillOptions, KillResult } from "./process-tree-killer";

// Diagnostic 体系 — 诊断阶段 / 载荷 / 稳定性 / 支持包
// 对齐 openclaw-main 的 src/logging/diagnostic-*.ts
export { DiagnosticPhaseTracker } from "./diagnostic-phase";
export type {
  DiagnosticPhase,
  DiagnosticPhaseKind,
  DiagnosticPhaseStatus,
} from "./diagnostic-phase";
export {
  DiagnosticPayloadBuilder,
  DiagnosticPayloadCollector,
  DEFAULT_SENSITIVE_KEYS,
} from "./diagnostic-payload";
export type {
  DiagnosticPayload,
  DiagnosticSeverity,
  DiagnosticEntityType,
  DiagnosticPayloadCreateOptions,
  DiagnosticPayloadQuery,
} from "./diagnostic-payload";
export { StabilityMonitor, DEFAULT_STABILITY_CONFIG } from "./diagnostic-stability";
export type {
  StabilityAssessment,
  StabilityConfig,
  StabilityIssue,
} from "./diagnostic-stability";
export { SupportBundleBuilder, redactString } from "./diagnostic-support-bundle";
export type {
  SupportBundle,
  SupportBundleInput,
  SupportBundleExportOptions,
  PhaseInput,
} from "./diagnostic-support-bundle";

// SQLite 精细化管理 — PRAGMA / 事务 / WAL checkpoint
// 对齐 openclaw-main 的 src/infra/sqlite-transaction.ts + sqlite-wal.ts
export {
  applyPragmas,
  readPragmas,
  validatePragmas,
  getDefaultPragmas,
  DEFAULT_PRODUCTION_PRAGMAS,
  DEFAULT_DEVELOPMENT_PRAGMAS,
} from "./sqlite-pragma";
export type {
  PragmaConfig,
  AppliedPragmas,
  SqliteDb,
  SqliteStatement,
  JournalMode,
  SynchronousMode,
  TempStoreMode,
} from "./sqlite-pragma";
export {
  withTransaction,
  withSavepoint,
  batchExec,
  isInTransaction,
  getTransactionStats,
  resetTransactionStats,
  TransactionError,
} from "./sqlite-transaction";
export type {
  TransactionMode,
  TransactionStats,
} from "./sqlite-transaction";
export {
  checkpointWal,
  getWalStatus,
  WalAutoCheckpoint,
  setWalAutocheckpoint,
  walPoll,
} from "./sqlite-wal";
export type {
  CheckpointMode,
  WalCheckpointResult,
  WalStatus,
} from "./sqlite-wal";

// Gateway restart 协调体系 — coordinator + sentinel + intent + stale-pids + handoff
// 对齐 openclaw-main 的 src/infra/restart.ts + restart-stale-pids.ts
export {
  RestartCoordinator,
  getDefaultRestartCoordinator,
  resetDefaultRestartCoordinator,
} from "./restart-coordinator";
export type {
  RestartAuditInfo,
  RestartDeferralHooks,
  RestartEmitHooks,
  ScheduledRestart,
} from "./restart-coordinator";
export {
  RestartSentinel,
  getDefaultRestartSentinel,
  resetDefaultRestartSentinel,
} from "./restart-sentinel";
export type { SentinelState } from "./restart-sentinel";
export {
  writeGatewayRestartIntentSync,
  consumeGatewayRestartIntentSync,
  clearGatewayRestartIntentSync,
  readGatewayRestartIntentPayloadSync,
  resolveDefaultStateDir,
  resolveRestartIntentPath,
  getIntentTtlMs,
  getIntentMaxBytes,
} from "./restart-intent";
export type {
  GatewayRestartIntent,
  GatewayRestartIntentPayload,
  ConsumeIntentResult,
} from "./restart-intent";
export {
  triggerGatewayRestart,
} from "./restart-handoff";
export type { RestartAttempt, RestartMethod } from "./restart-handoff";
export {
  cleanStaleGatewayProcessesSync,
  findGatewayPidsOnPortSync,
  getSelfAndAncestorPidsSync,
  isGatewayArgv,
  terminateStaleProcessesSync,
  waitForPortFreeSync,
} from "./restart-stale-pids";
export type {
  TerminateResult,
  PollPortResult,
} from "./restart-stale-pids";