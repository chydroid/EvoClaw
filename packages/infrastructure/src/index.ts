export { MessageQueue } from "./message-queue";
export { ProcessManager } from "./process-manager";
export { FileSystemManager, atomicWriteFile, atomicReplace, CrossProcessLock } from "./filesystem-manager";
export { Logger } from "./logger";
export type { LogLevel, FileLoggingOptions } from "./logger";
export { OpenAITTSProvider, createDefaultTTSProvider, splitTextIntoFragments, TTSPlaybackRegistry } from "./tts-stream";
export type { VoiceStreamProvider, TTSChunk, TTSPlaybackSession } from "./tts-stream";
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
export type { PlaywrightTab, ScreenshotOptions, CookieData, LoginResult, FormFillOptions, DomSelectorInfo, DomExtractResult } from "./playwright-browser";
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
export { LocalSandboxBackend } from "./sandbox-backend";
export type { ISandboxBackend, SandboxExecuteOptions, SandboxScriptOptions } from "./sandbox-backend";
export { SingularitySandbox, ModalSandboxBackend, DaytonaSandboxBackend, VercelSandboxBackend } from "./cloud-sandboxes";
export type { CloudSandboxConfig } from "./cloud-sandboxes";
export { CodeKernelRegistry, kernelRegistry } from "./code-kernel";
export type { KernelCellResult, KernelExecuteOptions, KernelRegistryConfig } from "./code-kernel";
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
// （Step 6 对齐 Hermes ProcessTerminationMixin：父进程先 SIGTERM + grace 内存活重扫 /
//  幸存者验证 settle 复查 1.0s / fail-closed = 不可验证即幸存者并入 KillResult.survivors）
export {
  killProcessTree,
  killChildProcessTree,
  findPidsByName,
  pidExists,
} from "./process-tree-killer";
export type { KillOptions, KillResult } from "./process-tree-killer";

// process-wait-policy — 静默等待策略（对齐 Hermes process_registry_wait_policy.py）
// 连续静默 2 轮 → promote（notify_on_complete 接管 + stop note）；forget on exit/非 wait-poll 动作
export { WaitPolicyTracker, PROMOTE_AFTER } from "./process-wait-policy";
export type { WaitPolicyObserveResult } from "./process-wait-policy";

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

// F14: ProcessRegistry — 后台进程注册表 + watch pattern 限速 + 断路器 + PID 复用保护（对标 Hermes tools/process_registry.py）
export {
  ProcessRegistry,
  processRegistry,
  formatUptimeShort,
} from "./process-registry";
export type {
  ProcessSession,
  WatchEvent,
  CompletionReason,
  TerminationSource,
  PidScope,
} from "./process-registry";

// ProcessSupervisor — 轻量级进程监督器，自动重启（指数退避 + 滑动窗口限流）
// 借鉴 hermes-agent s6-overlay 的进程监督思路，在应用层实现等效的崩溃自动恢复
export { ProcessSupervisor } from "./process-supervisor";
export type {
  SpawnResult,
  SpawnFn,
  RestartPolicy,
  RegisterOptions,
  SupervisedProcess,
} from "./process-supervisor";

// ShutdownForensics — 关闭取证快照（SIGTERM/SIGINT 上下文 + 诊断命令）
// 借鉴 hermes-agent 的 shutdown_forensics.py
export { ShutdownForensics } from "./shutdown-forensics";
export type { ShutdownSnapshot } from "./shutdown-forensics";

// TTS Provider Registry（Hermes 对齐 Step 5 —— G5）
//   文件合成方程：synthesize(text) → 落盘路径；BUILTIN 8 家；edge 免费默认。
//   流式侧仍由 tts-stream.ts 承载（WebUI voice SSE），不在本模块。
export type {
  TTSProvider,
  TTSSynthesizeOptions,
  TTSOutputFormat,
} from "./tts-providers";
export {
  ProviderRegistry,
  BUILTIN_TTS_PROVIDERS,
  TTS_DEFAULT_CHAIN,
  createTTSRegistry,
  resolveOutputFormat,
  defaultTTSOutputDir,
  EdgeTTSProvider,
  OpenAiCompatibleTTSProvider,
  XAITTTSProvider,
  ElevenLabsTTSProvider,
  MistralTTSProvider,
  GeminiTTSProvider,
  MiniMaxTTSProvider,
  runPythonProcess,
  PythonModuleProbe,
} from "./tts-providers";

// STT Provider Registry（Hermes 对齐 Step 5 —— G5）
//   信封 {success, transcript, provider, error} 永不抛；BUILTIN 7 家；local faster-whisper 免费默认。
export type {
  TranscriptionEnvelope,
  TranscriptionProvider,
  TranscribeOptions,
} from "./stt-providers";
export {
  SttRegistry,
  BUILTIN_STT_PROVIDERS,
  STT_DEFAULT_CHAIN,
  createSttRegistry,
  LocalFasterWhisperProvider,
  OpenAiCompatibleSttProvider,
  ElevenLabsSttProvider,
} from "./stt-providers";