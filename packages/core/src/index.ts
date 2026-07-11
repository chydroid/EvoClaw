export * from "./types/skill";
export type {
  SKILLmdDocument,
  SKILLmdMeta,
  OpenClawMetadata,
  OpenClawSkillMeta,
  SkillConfigStatus,
  SkillInstallSpec,
  SkillInstallStep,
} from "./types/skill";
export * from "./types/task";
export * from "./types/agent";
export * from "./types/event";
export * from "./types/plugin";
export * from "./types/evolution";
export * from "./types/memory";
export * from "./types/security";
export * from "./types/mcp";
export {
  EvoError,
  ConfigError,
  AuthError,
  ProviderError,
  RateLimitError,
  ContextOverflowError,
  TaskError,
  PluginError,
  isEvoError,
  isProviderError,
  isRateLimitError,
  isContextOverflowError,
  isConfigError,
  isAuthError,
  isTaskError,
  isPluginError,
} from "./types/errors";
export type {} from "./types/errors";
export { ServiceRegistry } from "./service-registry";
export { EventBus } from "./event-bus";
export { ConfigManager, defaultConfig } from "./config";
export type { AppConfig, DeepPartial, PersonaConfig } from "./config";
export { ConfigValidator, ConfigWatcher, CONFIG_SCHEMA, ValidationError as ConfigValidationError } from "./config-schema";
export type { ConfigValidationResult, SchemaConfigChange, SchemaConfigChangeHandler } from "./config-schema";
export { PluginManager } from "./plugin-system";
export type {
  Plugin, PluginManifest, PluginContext, PluginHookRegistration,
  PluginHook, PluginHookResult, HookBaseResult, HookContext, HookPriority,
  BeforeAgentStartHook, BeforeAgentStartResult,
  BeforeAgentReplyHook, BeforeAgentReplyResult,
  AgentEndHook, AgentEndResult,
  BeforeModelResolveHook, BeforeModelResolveResult,
  BeforePromptBuildHook, BeforePromptBuildResult,
  BeforeToolCallHook, BeforeToolCallResult,
  AfterToolCallHook, AfterToolCallResult,
  ToolResultPersistHook, ToolResultPersistResult,
  BeforeCompactionHook, BeforeCompactionResult,
  AfterCompactionHook, AfterCompactionResult,
  MessageReceivedHook, MessageReceivedResult,
  MessageSendingHook, MessageSendingResult,
  MessageSentHook, MessageSentResult,
  SessionStartHook, SessionStartResult,
  SessionEndHook, SessionEndResult,
  GatewayStartHook, GatewayStopHook,
  BeforeInstallHook, BeforeInstallResult,
} from "./plugin-system";
export {
  shouldRejectHardlinkedPluginFiles,
  isNixStorePluginRoot,
  resolveIsNixMode,
  getFileInodeInfo,
  isHardlinkedFile,
  scanPluginForHardlinks,
  PluginProvenanceIndex,
} from "./plugin-hardlink-policy";
export type {
  PluginOrigin,
  FileInodeInfo,
  HardlinkCheckResult,
  ProvenanceEntry,
} from "./plugin-hardlink-policy";
export { ConfigSchemaMerger, generateUiHints, matchWildcard } from "./config-schema-merge";
export type {
  JsonSchemaFragment,
  SchemaMergeConflict,
  SchemaMergeResult,
  SchemaMergeConfig,
  ConfigPropertyHint,
} from "./config-schema-merge";
export {
  ENV_ALIASES, CONFIG_ALIASES, TOOL_ALIASES,
  getEnvWithCompat, translateLegacyKey, resolveToolName,
  detectLegacyEnv, printMigrationHints,
} from "./compat-layer";

export { ConfigDoctor, diagnoseConfig, doctorAndFix } from "./config-doctor";
export type { Diagnostic, DiagnosticSeverity, DoctorReport, DoctorOptions } from "./config-doctor";

export { LastKnownGoodConfig } from "./config-lkg";
export type { ConfigSnapshot, LKGConfig, DiffResult } from "./config-lkg";

export { FeatureFlagStore } from "./feature-flags";
export type { FeatureFlag, FeatureFlagsConfig, FlagEvaluation } from "./feature-flags";

export { GracefulShutdownManager } from "./graceful-shutdown";
export type { ShutdownPhase, ShutdownTask, GracefulShutdownConfig, ShutdownStatus } from "./graceful-shutdown";

export { LRUCache } from "./lru-cache";
export type { CacheEntry, LRUCacheConfig, CacheStats } from "./lru-cache";

export { Semaphore, Mutex, ConcurrencyLimiter } from "./concurrency";
export type { SemaphoreConfig, SemaphoreStats } from "./concurrency";

export { ConfigRPC } from "./config-rpc";
export type { ConfigValue, ConfigChange, ConfigValidator as ConfigRPCValidator, ConfigSchemaEntry, ConfigRPCConfig } from "./config-rpc";

export { OnboardingWizard } from "./onboarding";
export type { IdentityConfig, AuthConfig, GatewayConfig, LLMConfig, DataConfig, OnboardingConfig, OnboardingProgress, OnboardingWizardConfig, OnboardingStep, InputHandler, SelectHandler } from "./onboarding";

export { ConfigMigrationManager } from "./config-migration";
export type { MigrationStep, MigrationResult, ConfigMigrationConfig, SemVer } from "./config-migration";

// Profile Manager — 多实例隔离系统（借鉴 hermes-agent Profile 设计）
export { ProfileManager } from "./profile-manager";
export type { ProfileConfig, ProfileManagerOptions } from "./profile-manager";

// Env Loader — .env 文件加载与净化（借鉴 hermes-agent env_loader.py）
export {
  parseEnvContent,
  loadEnvFile,
  loadAndApplyEnvFile,
  isPlaceholderToken,
  hasUsableSecret,
  backupCorruptConfig,
} from "./env-loader";
export type { EnvLoadResult } from "./env-loader";