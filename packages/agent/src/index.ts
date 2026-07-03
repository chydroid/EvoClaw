export { TaskOrchestrator } from "./task-orchestrator";
export { AgentPoolManager } from "./agent-pool";
export { ActorSystem } from "./actor-system";
export { DAGExecutor } from "./dag-executor";
export { StateGraph, CompiledGraph, MemoryCheckpointer } from "./state-graph";
export type { NodeFn, Reducer, StateSchema, RouterFn, GraphEvent, CompileOptions, Checkpointer, Checkpoint, CheckpointMetadata } from "./state-graph";
export { DynamicDAGBuilder } from "./dynamic-dag-builder";
export { AgentModelExecutor } from "./agent-model-executor";
export type { TaskStatus, AgentProgressEvent, AgentProgressCallback, AutoSplitConfig } from "./types";
export type { TaskCheckpoint } from "./task-checkpoint-manager";
export { taskStatusTracker } from "./task-status-tracker";
export { taskCheckpointManager } from "./task-checkpoint-manager";
export { ExecutionCheckpointStore } from "./execution-checkpoint";
export type { ExecutionState, ExecutionSnapshot } from "./execution-checkpoint";
export { TaskPlanner } from "./task-planner";
export { BootstrapManager } from "./bootstrap-manager";
export { CompactionManager } from "./compaction-manager";
export { AgentLifecycleManager, AgentLifecycleEvent } from "./agent-lifecycle";
export { QueueManager } from "./queue-manager";
export { buildAgentSystemPrompt, buildCompactSkillsPrompt } from "./system-prompt";
export { classifyLLMError, isContextOverflowError, isRateLimitError, estimateTokensFromText, estimateMessagesTokens, LLMErrorType } from "./error-classifier";
export type { DAGBuilderConfig, BuildContext } from "./dynamic-dag-builder";
export type { ModelConfig, ProviderConfig, AgentExecutionResult, ToolDefinition } from "./types";
export type { SubTask, TaskPlan, ProjectTemplate } from "./task-planner";
export type { PromptMode, SystemPromptParams } from "./system-prompt";
export type { ClassifiedError } from "./error-classifier";
export type { CompactionSummary, CompactionConfig } from "./compaction-manager";
export type { AgentStatus, ToolCallStatus, LifecycleEventData, ErrorEvent, ToolCallEvent, CompactionEvent, PermissionEvent } from "./agent-lifecycle";
export type { QueueMode, QueueItem, QueueConfig } from "./queue-manager";
export { SessionManager } from "./session-manager";
export type { SessionConfig, SessionInfo, SessionTurn, SessionLoadResult, SessionLock } from "./session-manager";

// v0.35: 性能与可用性增强
export { LazySkillLoader } from "./lazy-skill-loader";
export type { LazySkill, LazySkillEntry, LazyLoaderConfig, LoadStatus } from "./lazy-skill-loader";
export { FirstEventTracer } from "./first-event-tracer";
export type { FirstEventTrace, TraceStage, FirstEventTracerConfig } from "./first-event-tracer";
export { TokenUsageTracker } from "./token-usage-tracker";
export type { UsageRecord, UsageSummary, TokenUsageTrackerConfig, ModelCostInfo, ModelCostProvider } from "./token-usage-tracker";
export { DEFAULT_MODEL_COSTS } from "./token-usage-tracker";
export { SessionUndoManager } from "./session-undo-manager";
export type { UndoUnit, SessionUndoConfig } from "./session-undo-manager";
export { SessionFTSSearch } from "./session-fts-search";
export type { IndexedMessage, FTSResult, SessionFTSSearchConfig } from "./session-fts-search";
export { ContextEngine } from "./context-engine";
export type { ContextConfig, ContextAssemblyInput, ContextAssemblyResult, PromptLayer, PromptSection, FrozenPromptState, LayeredContextResult } from "./context-engine";
export { AgentRouter } from "./agent-router";
export type { AgentConfig, AgentBinding, ToolPolicy, RouteRequest, ResolvedRoute, RouterConfig } from "./agent-router";
export { SubagentRegistry } from "./subagent-registry";
export type { SubagentConfig, SubagentInfo, SubagentStatus, SubagentEvent, SubagentListFilter, SubagentRegistryEvent } from "./subagent-registry";
export { handleChatCommand, dispatchCommand } from "./chat-commands";
export type { CommandResult, CommandContext } from "./chat-commands";
export { AutoReplyEngine } from "./auto-reply";
export type { AutoReplyRule, AutoReplyContext, AutoReplyMatch, AutoReplyConfig } from "./auto-reply";
export { CommitmentManager } from "./commitments";
export type { Commitment, CommitmentStatus, CommitmentFilter, CommitmentStore } from "./commitments";
export { queryModels, getModel, getModelsByProvider, findBestModelForContext, formatModelList, getProviders, getTotalModels, getCatalog } from "./model-catalog";
export type { ModelEntry, ModelProvider, ModelCapability, ModelQuery } from "./model-catalog";
export { EventLedger } from "./event-ledger";
export type { LedgerEventType, LedgerEntry, LedgerQuery, EventLedgerConfig } from "./event-ledger";
export { ModelFailoverManager } from "./model-failover";
export type { FailoverConfig, ProviderHealth, FailoverProvider } from "./model-failover";
export { DefaultProviderRegistry } from "./provider-registry";
export type { RegistryEntry, ResolvedProvider, RegistryConfig } from "./provider-registry";
export { OpenAIProvider, AnthropicProvider, GoogleProvider } from "./providers/index.js";
export { ProgressDraftsManager } from "./progress-drafts";
export type { ProgressDraft, ProgressEvent, ProgressDraftsConfig, ProgressListener, DraftStatus } from "./progress-drafts";
export { FormalVerifier, ATLAS_TACTICS } from "./formal-verification";
export type { AtlasTacticId, AtlasTechnique, DetectionPattern, ThreatMatch, VerificationResult, RuntimeCheckContext, VerificationConfig } from "./formal-verification";
export { TUIManager } from "./tui-interface";
export type { TUIState, TUIMessage, TUIStatus, TUINotification, TUICommand, TUIConfig, TUIPanel } from "./tui-interface";
export { TaskScheduler } from "./task-scheduler";
export type { ScheduledTask, ScheduleResult, SchedulerConfig, TaskPriority, TaskCategory } from "./task-scheduler";
export { SelfHealingEngine } from "./self-healing";
export type { ResilienceConfig, HealthScore, ErrorPattern, MutationStrategy, AnomalyRecord, RecoveryStrategy } from "./self-healing";
export { SwarmOrchestrator } from "./swarm-orchestrator";
export type { SwarmAgent, SwarmConfig, AgentRole, DelegationRequest, DelegationResult, ConsensusProposal, ConsensusVote, ConsensusResult } from "./swarm-orchestrator";
export { ReplyDeduplicator, areMessagesDuplicate } from "./reply-dedup";
export type { DedupConfig, DedupEntry, DedupCheckResult } from "./reply-dedup";

export { ThreadBindingsManager } from "./thread-bindings";
export type { ThreadBinding, ThreadBindingsConfig, BindingEvent } from "./thread-bindings";

export { SessionRetentionManager } from "./session-retention";
export type { SessionEntry, RetentionPolicy, RetentionConfig, RetentionResult } from "./session-retention";

// Session Reset Policy — 会话重置策略（借鉴 hermes-agent SessionResetPolicy）
export { shouldResetSession, shouldNotifyReset, DEFAULT_RESET_POLICY } from "./session-reset-policy";
export type { SessionResetMode, SessionResetPolicy, SessionResetCheck, SessionResetInfo } from "./session-reset-policy";

export { ContextFocusManager } from "./context-focus";
export type { FocusTarget, FocusContext, ContextFocusConfig } from "./context-focus";

export { HumanApprovalManager } from "./human-approval";
export type { PendingApproval, ApprovalConfig, TrustRule, RiskLevel } from "./human-approval";

export { ModelSwitcher } from "./model-switcher";
export type { ModelAlias, ModelPreset, ActiveModel, ModelSwitchEvent, ModelSwitcherConfig } from "./model-switcher";

export { CopilotRouter } from "./copilot-router";
export type { CopilotRouteRule, CopilotRouterConfig, RoutingDecision, UserLLMProvider } from "./copilot-router";

export { CredentialPool } from "./credential-pool";
export type { CredentialEntry, CredentialPoolOptions, CredentialPoolLegacyConfig, CredentialState, RotationStrategy } from "./credential-pool";

// Text processing utilities
export { stripWebNoise, collapseNewlines, summarizeToolResult, stripHtml, compactJson, compactJsonValue, smartTruncateString, filterPlainText, normalizeUrls, groupSimilarLines, extractCodeSignatures, deduplicateLines, smartTruncate } from "./text-processor";

// Evals system
export { EvalRunner, BUILTIN_EVAL_CASES } from "./evals";
export type { EvalCase, EvalResult, EvalRunSummary, EvalConfig } from "./evals";

// A2A (Agent-to-Agent) protocol
export { A2AClient, A2AServer } from "./a2a";
export type { A2AAgentCard, A2ACapability, A2ATask, A2ATaskResult, A2AMessage, A2AClientConfig, A2AServerConfig } from "./a2a";

// ACP (Agent Delegation Protocol)
export { ACPProtocolHandler } from "./acp-delegation";
export type { ACPAgent, ACPDelegationRequest, ACPDelegationResult } from "./acp-delegation";

// ToolChain system
export { ToolChainExecutor, type ToolChainDefinition, type ToolChainResult, type ToolChainStep } from "./tool-chain";
export { ToolChainRegistry, createBuiltinToolChainRegistry } from "./tool-chain-registry";

// Guardrails system
export { GuardrailsManager, InputGuardrail, OutputGuardrail, ToolGuardrail } from "./guardrails";
export type { GuardrailResult, GuardrailConfig, GuardrailStats, InputRule, OutputRule, ToolRule, Severity, GuardrailAction } from "./guardrails";

// Structured Output system
export { StructuredOutputParser, SchemaRegistry } from "./structured-output";
export type { OutputSchema, StructuredOutputResult, StructuredOutputConfig } from "./structured-output";

// Observability system
export { AgentObservability } from "./agent-observability";
export type { Span, Trace, TraceSummary, Metric, SpanKind, SpanEvent, ObservabilityConfig } from "./agent-observability";

// Prompt Cache system
export { PromptCache } from "./prompt-cache";
export type { PromptCacheConfig, CacheEntry, CacheStats } from "./prompt-cache";

// Stable Stringify & Prompt Cache Stability — prompt-cache 显式管理
// 灵感来自 openclaw-main 的 prompt-cache-stability / stable-stringify / cache-trace
export {
  stableStringify,
  stableHash,
  stableEqual,
  stableDiff,
} from "./stable-stringify";
export type {
  StableStringifyOptions,
  StableDiffResult,
} from "./stable-stringify";
export {
  PromptCacheStabilityManager,
  estimateTokens,
} from "./prompt-cache-stability";
export type {
  CacheProvider,
  PromptCacheKey,
  CacheStabilityResult,
} from "./prompt-cache-stability";
export { CacheTracer } from "./cache-trace";
export type {
  CacheTraceEntry,
  CacheTraceQuery,
  CacheTraceStats,
  ModelCostEntry,
  CostTable,
} from "./cache-trace";

// /steer real-time control command
export { SteerManager } from "./steer-command";
export type { SteerInstruction, SteerResult } from "./steer-command";

// Workboard multi-agent orchestration
export { Workboard } from "./workboard";
export type { BoardTask, BoardComment, BoardRun, BoardColumn } from "./workboard";

// Computed Status system
export { ComputedStatusEngine } from "./computed-status";
export type { ComputedStatusResult, StatusSource } from "./computed-status";

// Stale Context Invalidation system
export { StaleContextManager } from "./stale-context";
export type { StaleContextConfig, ToolResultMeta } from "./stale-context";

// Iteration Budget system
export { IterationBudget, DEFAULT_PARENT_BUDGET, DEFAULT_CHILD_BUDGET, isExecuteCodeTool } from "./iteration-budget";
export type { IterationBudgetConfig, IterationBudgetStatus } from "./iteration-budget";

// Rate Limit Tracker system
export { RateLimitTracker } from "./rate-limit-tracker";
export type { RateLimitBucket, RateLimitState } from "./rate-limit-tracker";

// Input Pipeline system
export { PipelineRunner } from "./input-pipeline";
export type { PipelineContext, PipelineStage } from "./input-pipeline";
export { createXssSanitizeStage, createLengthGuardStage, createAttachmentInjectionStage, createGuardrailsStage, createPluginPreProcessStage, createSystemTagSanitizeStage, createEchoDetectionStage } from "./input-pipeline";
export { ConversationFlow, createConversationFlowStage } from "./conversation-flow";
export type { ConversationIntent, ConversationState, ConversationFlowConfig, FlowCheckResult } from "./conversation-flow";

// Context Pruning system
export { ContextPruningManager } from "./context-pruning";
export type { ContextPruningConfig, PruningResult } from "./context-pruning";

// Tool Output 3-pass Pruner — 工具输出 3-pass 裁剪器
// 借鉴 hermes-agent agent/context_compressor.py _prune_old_tool_results：
//   Pass 1 dedup → Pass 2 informative summary → Pass 3 args JSON truncation
export { ToolOutputPruner, getToolOutputPruner, resetToolOutputPruner, DEFAULT_PRUNER_CONFIG } from "./tool-output-pruner";
export type { ToolOutputPrunerConfig, PruningStats, ToolMessage } from "./tool-output-pruner";

// Error Recovery Executor — 错误恢复执行分支
// 借鉴 hermes-agent agent/conversation_loop.py：20+ FailoverReason 恢复动作 + TurnRetryState 一次性守卫
export { ErrorRecoveryExecutor, TurnRetryState, getErrorRecoveryExecutor, resetErrorRecoveryExecutor } from "./error-recovery-executor";
export type { RecoveryContext, RecoveryResult, RecoveryMessage } from "./error-recovery-executor";

// Concurrent Tool Executor — 并发工具执行池
// 借鉴 hermes-agent agent/tool_executor.py execute_tool_calls_concurrent：
//   8 worker + 安全分类（never-parallel / path-scoped / safe-parallel）+ 心跳 + 中断
export { ConcurrentToolExecutor, getConcurrentToolExecutor, resetConcurrentToolExecutor, classifyToolParallelism, DEFAULT_CONCURRENT_CONFIG } from "./concurrent-tool-executor";
export type { ToolParallelismClass, ToolCall, ToolExecutionResult, ToolExecutorFn, ConcurrentExecutorConfig } from "./concurrent-tool-executor";

// Tool Result Persistence Manager — 工具结果持久化管理器（三层防御）
// 借鉴 hermes-agent tools/tool_result_storage.py + budget_config.py：
//   Layer 1 per-tool cap → Layer 2 per-result persistence → Layer 3 per-turn budget
export { ToolResultPersistenceManager, getToolResultPersistenceManager, resetToolResultPersistenceManager, generatePreview, DEFAULT_BUDGET_CONFIG } from "./tool-result-persistence";
export type { BudgetConfig, PersistedOutputInfo, TurnBudgetResult, TurnMessage } from "./tool-result-persistence";

// Schema Sanitizer — JSON Schema 清洗器（多后端兼容）
// 借鉴 hermes-agent tools/schema_sanitizer.py：
//   llama.cpp/OpenAI Codex/Fireworks/xAI/Anthropic 后端兼容性清洗
export { sanitizeToolSchemas, reactiveSanitize } from "./schema-sanitizer";
export type { ToolSchema, JsonSchema as SchemaJson, BackendType, SanitizeOptions } from "./schema-sanitizer";

// Tool Argument Coercer — 工具参数类型强制转换器
// 借鉴 hermes-agent model_tools.py _coerce_value/_coerce_json：
//   运行时参数类型校正（string→int/number/boolean/array/object）
export { coerceValue, coerceToolArguments } from "./tool-argument-coercer";
export type { CoerceResult } from "./tool-argument-coercer";

// Cross-Session Rate Guard — 跨会话速率限制守卫
// 借鉴 hermes-agent agent/nous_rate_guard.py：
//   文件共享状态 + retry amplification 防护 + genuine rate limit 区分
export { CrossSessionRateGuard, getCrossSessionRateGuard, resetCrossSessionRateGuard, parseResetSeconds, DEFAULT_RATE_GUARD_CONFIG } from "./cross-session-rate-guard";
export type { CrossSessionRateLimitState, RateGuardConfig } from "./cross-session-rate-guard";

// Streaming Recovery Manager — 流式响应中断恢复管理器
// 借鉴 hermes-agent agent/conversation_loop.py lines 4080-4119：
//   partial_stream_recovery / truncated_tool_call_retries / length_continue / thinking_prefill / housekeeping_fallback
export { StreamingRecoveryManager, getStreamingRecoveryManager, resetStreamingRecoveryManager, hasContentAfterThinkBlock, stripThinkBlocks, PARTIAL_STREAM_STUB_ID, DEFAULT_STREAMING_RECOVERY_CONFIG } from "./streaming-recovery";
export type { StreamRecoveryContext, StreamRecoveryResult, StreamingRecoveryConfig } from "./streaming-recovery";

// Tool Result Middleware — 工具结果后处理中间件
// 借鉴 hermes-agent hermes_cli/middleware.py + model_tools.py transform_tool_result：
//   请求中间件 + 执行中间件 + 结果转换 hook + 终端输出转换
export { ToolResultMiddleware, getToolResultMiddleware, resetToolResultMiddleware, DownstreamExecutionError, MiddlewareAlreadyConsumedError, createRedactionTransform, createSizeLimitTransform, createJsonFormatTransform, DEFAULT_MIDDLEWARE_CONFIG } from "./tool-result-middleware";
export type { ToolCallContext, ToolResultContext, ToolRequestMiddleware, ToolExecutionMiddleware, ToolResultTransform, TerminalOutputTransform, MiddlewareConfig } from "./tool-result-middleware";