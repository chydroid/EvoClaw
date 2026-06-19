export { TaskOrchestrator } from "./task-orchestrator";
export { AgentPoolManager } from "./agent-pool";
export { ActorSystem } from "./actor-system";
export { DAGExecutor } from "./dag-executor";
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

export { ContextFocusManager } from "./context-focus";
export type { FocusTarget, FocusContext, ContextFocusConfig } from "./context-focus";

export { HumanApprovalManager } from "./human-approval";
export type { PendingApproval, ApprovalConfig, TrustRule, RiskLevel } from "./human-approval";

export { ModelSwitcher } from "./model-switcher";
export type { ModelAlias, ModelPreset, ActiveModel, ModelSwitchEvent, ModelSwitcherConfig } from "./model-switcher";

export { CopilotRouter } from "./copilot-router";
export type { CopilotRouteRule, CopilotRouterConfig, RoutingDecision, UserLLMProvider } from "./copilot-router";

export { CredentialPool } from "./credential-pool";
export type { CredentialEntry, CredentialPoolConfig } from "./credential-pool";

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
export { IterationBudget } from "./iteration-budget";
export type { IterationBudgetConfig, IterationBudgetStatus } from "./iteration-budget";

// Input Pipeline system
export { PipelineRunner } from "./input-pipeline";
export type { PipelineContext, PipelineStage } from "./input-pipeline";
export { createXssSanitizeStage, createLengthGuardStage, createAttachmentInjectionStage, createGuardrailsStage, createPluginPreProcessStage, createSystemTagSanitizeStage, createEchoDetectionStage } from "./input-pipeline";

// Context Pruning system
export { ContextPruningManager } from "./context-pruning";
export type { ContextPruningConfig, PruningResult } from "./context-pruning";