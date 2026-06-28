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