export { TaskOrchestrator } from "./task-orchestrator";
export { AgentPoolManager } from "./agent-pool";
export { ActorSystem } from "./actor-system";
export { DAGExecutor } from "./dag-executor";
export { StateGraph, CompiledGraph, MemoryCheckpointer } from "./state-graph";
export type { NodeFn, Reducer, StateSchema, RouterFn, GraphEvent, CompileOptions, Checkpointer, Checkpoint, CheckpointMetadata } from "./state-graph";
export { SqliteCheckpointer, asSqliteDatabase } from "./sqlite-checkpointer";
export type { SqliteDatabaseLike as AgentSqliteDatabaseLike } from "./sqlite-checkpointer";
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

// Multi-Agent Collaboration Patterns — GroupChat / Debate / RoundRobin / Selector
// 借鉴 AutoGen GroupChat / CrewAI Crew / ChatDev debate / OpenAI Agents SDK orchestration
export { RoundRobinChat, GroupChat, DebatePattern, createSpeaker, formatChatResult } from "./multi-agent-patterns";
export type { AgentSpeaker, ChatTurn, ChatResult, ChatFn, SelectorFn, StopConditionFn } from "./multi-agent-patterns";

// MoA (Mixture-of-Agents) Committee — 多模型并行推理 + 聚合模型合成
// 对标 Hermes v0.18.0 "MoA 委员会"：多模型 fan-out → 聚合模型合成
export { MoaCommittee, MoaPresetRegistry, parseMoaMember, formatMoaResult } from "./moa-committee";
export type { MoaMember, MoaPreset, MoaReferenceResult, MoaResult, MoaChatFn, MoaAggregatorChunkCallback } from "./moa-committee";

// Goal Contract — 目标合约验证系统
// 对标 Hermes v0.18.0 "Goal Contract"：从"我觉得修好了"到"测试通过了，这是证据"
export { GoalContract, GoalRegistry } from "./goal-contract";
export type { ContractClause, ClauseResult, ContractVerificationResult, GoalContractConfig, GoalStatus, GoalRunRecord } from "./goal-contract";

// BackgroundDelegator — 后台子 Agent 并行派发 + 结果合并
// 对标 Hermes v0.18.0 "子 Agent 后台并行"：delegate_task fire-and-forget + 继续聊天
export { BackgroundDelegator } from "./background-delegator";
export type { BackgroundTask, BackgroundTaskStatus, DelegateOptions, DelegateFn, TaskCompleteCallback } from "./background-delegator";
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
export { EvalRunner, BUILTIN_EVAL_CASES, DEFAULT_JUDGE_CRITERIA } from "./evals";
export type { EvalCase, EvalResult, EvalRunSummary, EvalConfig, CustomEvaluator, LLMJudgeCriteria } from "./evals";

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

// Tool types & result schema validation
export { validateToolResult, validateToolDescriptor, createToolDescriptor, ToolValidationError, ToolExecutionError } from "./tool-types";
export type { ToolInputSchema, JsonSchemaProperty, ToolResult, ToolDescriptor, ToolExecutor, ToolCallRequest, ToolCallResponse, ToolExecutionContext, ToolRegistry, ToolExecutionOptions, ToolResultValidation, JsonPrimitive, JsonValue, JsonObject, JsonArray } from "./tool-types";

// Prompt Registry — 集中式 Prompt 模板管理与变量插值
// 借鉴 LangChain PromptTemplate / LangSmith Prompt Hub / AutoGen role-based prompt templates
export { PromptRegistry, registerBuiltinPromptTemplates } from "./prompt-registry";
export type { PromptTemplateEntry, PromptRegistryConfig } from "./prompt-registry";

// FuzzyMatch — 多策略模糊匹配链（对标 Hermes tools/fuzzy_match.py）
export { fuzzyFindAndReplace, fuzzyFind } from "./fuzzy-match";
export type { FuzzyMatchResult, FuzzyStrategy } from "./fuzzy-match";

// PatchParser — V4A patch 格式解析器（对标 Hermes tools/patch_parser.py）
export { parseV4APatch, applyV4AOperations, applyHunks, serializeV4A } from "./patch-parser";
export type { V4AOperation, V4AHunk, V4AHunkLine, V4AOpType, ParseResult, ApplyResult } from "./patch-parser";

// StreamingThinkScrubber — 流式推理块剥离状态机（对标 Hermes agent/think_scrubber.py）
export { StreamingThinkScrubber, stripThinkBlocks } from "./think-scrubber";

// FileStateRegistry — 跨 agent 文件状态协调（对标 Hermes tools/file_state.py）
export { FileStateRegistry, assertNotStale } from "./file-state-registry";
export type { StaleResult } from "./file-state-registry";

// ToolSearch — 渐进式工具披露 BM25（对标 Hermes tools/tool_search.py）
export { ToolSearchEngine, estimateTokens, estimateToolTokens, estimateTotalTokens } from "./tool-search";
export type { ToolMeta, ToolSearchConfig, ToolSearchResult } from "./tool-search";

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
export { StreamingRecoveryManager, getStreamingRecoveryManager, resetStreamingRecoveryManager, hasContentAfterThinkBlock, PARTIAL_STREAM_STUB_ID, DEFAULT_STREAMING_RECOVERY_CONFIG } from "./streaming-recovery";
export type { StreamRecoveryContext, StreamRecoveryResult, StreamingRecoveryConfig } from "./streaming-recovery";

// Tool Result Middleware — 工具结果后处理中间件
// 借鉴 hermes-agent hermes_cli/middleware.py + model_tools.py transform_tool_result：
//   请求中间件 + 执行中间件 + 结果转换 hook + 终端输出转换
export { ToolResultMiddleware, getToolResultMiddleware, resetToolResultMiddleware, DownstreamExecutionError, MiddlewareAlreadyConsumedError, createRedactionTransform, createSizeLimitTransform, createJsonFormatTransform, DEFAULT_MIDDLEWARE_CONFIG } from "./tool-result-middleware";
export type { ToolCallContext, ToolResultContext, ToolRequestMiddleware, ToolExecutionMiddleware, ToolResultTransform, TerminalOutputTransform, MiddlewareConfig } from "./tool-result-middleware";

// F9: ReasoningTimeouts — 推理模型感知 stale-timeout 下限（对标 Hermes agent/reasoning_timeouts.py）
export {
  getReasoningStaleTimeoutFloor,
  applyReasoningFloor,
  isKnownReasoningModel,
  REASONING_STALE_TIMEOUT_FLOORS,
} from "./reasoning-timeouts";

// F10: CodingContext — 工作区检测 + 编码姿态注入（对标 Hermes agent/coding_context.py）
export {
  resolveRuntimeMode,
  isCodingMode,
  isCodingContext,
  detectProjectFacts,
  buildCodingWorkspaceBlock,
  codingSystemBlocks,
  codingCompactSkillCategories,
  projectFactsFor,
  editFormatLine,
  getProfile,
  PROJECT_MARKERS,
  CODE_EXTENSIONS,
  CODE_SCAN_SKIP_DIRS,
  CODING_TOOLSET,
  CODING_AGENT_GUIDANCE,
  GENERAL_PROFILE,
  CODING_PROFILE,
} from "./coding-context";
export type {
  RuntimeMode,
  ContextProfile,
  ProjectFacts,
} from "./coding-context";

// F11: BackgroundReview — turn 后自我反思 fork（对标 Hermes agent/background_review.py）
export {
  runBackgroundReview,
  shouldRunBackgroundReview,
  summarizeBackgroundReviewActions,
  MEMORY_REVIEW_PROMPT,
  SKILL_REVIEW_PROMPT,
  COMBINED_REVIEW_PROMPT,
  DEFAULT_REVIEW_CONFIG,
} from "./background-review";
export type {
  BackgroundReviewConfig,
  ReviewAction,
  ReviewRuntime,
  ReviewMessage,
  ReviewChatFn,
} from "./background-review";

// F12: AuxiliaryClient — 统一 side-task LLM 回退链（对标 Hermes agent/auxiliary_client.py）
// NOTE: isRateLimitError 在 error-classifier 已导出，此处不重复导出
export {
  resolveAuxRuntime,
  callAuxLLM,
  collectAllRuntimes,
  isCreditExhaustedError,
  classifyProvider,
  withInterruptProtection,
} from "./auxiliary-client";
export type {
  AuxRuntime,
  AuxCallRequest,
  AuxCallResult,
  AuxChatFn,
  MainRuntimeContext,
  AuxiliaryConfig,
  ProviderKind,
} from "./auxiliary-client";

// F15a: CreditsTracker — 响应头积分追踪 + 通知策略（对标 Hermes agent/credits_tracker.py）
export {
  parseCreditsHeaders,
  evaluateCreditsNotices,
  createLatch,
  hasData,
  ageSeconds,
  isDepleted,
  usedFraction,
  isFreeTierModel,
  creditsStateFromAccount,
  makeNotice,
  CREDITS_NOTICE_KIND,
  CREDITS_RESTORED_TTL_MS,
  CREDITS_USAGE_BANDS,
  CREDITS_USAGE_KEY,
} from "./credits-tracker";
export type {
  CreditsState,
  CreditsLatch,
  AgentNotice,
  NoticeDelta,
  AccountCreditsInput,
  HeaderMap,
} from "./credits-tracker";

// F15b: UsagePricing — 模型定价表 + 成本估算（对标 Hermes agent/usage_pricing.py）
export {
  resolveBillingRoute,
  getPricingEntry,
  normalizeUsage,
  estimateUsageCost,
  hasKnownPricing,
  emptyUsage,
  promptTokens,
  totalTokens,
  sumUsage,
  formatDurationCompact,
  formatTokenCountCompact,
  makePricingEntry,
} from "./usage-pricing";
export type {
  CanonicalUsage,
  BillingRoute,
  BillingMode,
  PricingEntry,
  CostResult,
  CostStatus,
  CostSource,
  RawUsageLike,
} from "./usage-pricing";

// F16: ClarifyTool — 结构化用户提问原语（对标 Hermes tools/clarify_tool.py + clarify_gateway.py）
export {
  clarifyTool,
  flattenChoice,
  clarifyError,
  clarifySuccess,
  checkClarifyRequirements,
  ClarifyGateway,
  getClarifyGateway,
  _resetClarifyGatewayForTests,
  CLARIFY_SCHEMA,
  MAX_CHOICES,
  DEFAULT_CLARIFY_TIMEOUT_MS,
} from "./clarify-tool";
export type {
  ClarifyCallback,
  ClarifyResult,
  ClarifyEntry,
} from "./clarify-tool";

// AutoFixer — LLM 响应格式自动修复（借鉴 page-agent normalizeResponse）
export {
  normalizeResponse,
  formatReflection,
} from "./auto-fixer";
export type {
  NormalizeResult,
  NormalizedToolCall,
  ToolCall as LLMToolCall,
  LLMMessage,
} from "./auto-fixer";

// ReflectionContract — MacroTool "Reflection-Before-Action" 契约（借鉴 page-agent）
export {
  buildMacroToolSchema,
  extractReflectionAndAction,
  renderHistoryEntry,
  MACRO_TOOL_SYSTEM_PROMPT,
  observeUrlChange,
  observeWaitBudget,
  observeStepBudget,
  observeStuckWarning,
} from "./reflection-contract";
export type {
  ReflectionFields,
  ReflectionHistoryEntry,
  DualStreamEvent,
  ToolSchema as MacroToolSchemaDef,
  ObservationEvent,
} from "./reflection-contract";

// ToolResultCache — 工具结果缓存（借鉴 Cursor / Continue / Aider）
//   LRU + TTL + 黑白名单 + 统计，减少重复工具调用的 API 成本
export { ToolResultCache } from "./tool-result-cache";
export type { ToolResultCacheOptions, CacheStats as ToolResultCacheStats } from "./tool-result-cache";

// ToolRetry — 工具调用重试与指数退避（借鉴 LangChain / AutoGPT / OpenAI SDK）
//   瞬时错误自动重试 + 指数退避 + 抖动 + 可重试错误判定
export {
  withRetry,
  createRetryExecutor,
  defaultIsRetryable,
  computeBackoff as computeRetryBackoff,
} from "./tool-retry";
export type { RetryOptions } from "./tool-retry";

// TokenBudgetOptimizer — 动态 token 预算分配（借鉴 Claude Code / Cursor / Continue）
//   按优先级为 system/memory/history/tool/user 分配 context window 预算
export {
  TokenBudgetOptimizer,
  estimateTokens as estimateBudgetTokens,
  estimateMessagesTokens as estimateBudgetMessagesTokens,
} from "./token-budget";
export type {
  BudgetAllocation,
  TokenBudgetOptions,
  BudgetReport,
} from "./token-budget";

// ToolQualityManager — 工具质量跟踪 + 惩罚式排序（借鉴 OpenSpace ToolQualityManager）
//   recordExecution / getPenalty / adjustRanking / recordLlmToolIssues / getQualityReport
export { ToolQualityManager } from "./tool-quality-manager";
export type {
  ToolExecutionRecord,
  ToolQualityRecord,
  ToolPenaltyInfo,
  ToolQualityReport,
  ToolQualityManagerOptions,
} from "./tool-quality-manager";

// ConversationFormatter — 对话优先级截断（借鉴 OpenSpace conversation_formatter）
//   0-5 级优先级（用户指令=0，最终迭代=1，工具错误=2...），截断时优先保留低数字
export { ConversationFormatter, MessagePriority } from "./conversation-formatter";
export type { PrioritizedMessage, TruncationResult, TruncationOptions } from "./conversation-formatter";

// RecordingManager — 任务执行录制（借鉴 OpenSpace RecordingManager）
//   三件套：conversations.jsonl + traj.jsonl + metadata.json
export { RecordingManager } from "./recording-manager";
export type {
  ConversationSetupRecord,
  IterationContextRecord,
  ToolExecutionRecord as RecordingToolExecutionRecord,
  SkillSelectionRecord,
  RetrievedToolsRecord,
  RecordingRecord,
  RecordingMetadata,
} from "./recording-manager";

// IterationContextPolicy — 基于迭代轮次的渐进式上下文裁剪（借鉴 OpenSpace grounding_agent）
//   第 2 轮起 cap 单条消息；第 5 轮起 truncate 历史；首轮后剥离技能上下文
export { IterationContextPolicy } from "./iteration-context-policy";
export type { IterationPolicyConfig, PolicyMessage, PolicyResult } from "./iteration-context-policy";

// MessageUtils — 消息工具函数（借鉴 OpenSpace message_utils.py）
//   cap_message_content 头尾保留 + 截断通知注入 + 分节截断常量
export {
  capMessageContent,
  injectTruncationNotice,
  capMessages,
  extractErrorFirstLine,
  SECTION_MAX_CHARS,
  getMaxLenForMessage,
} from "./message-utils";
export type { AgentMessage } from "./message-utils";

// ────────────────────────────────────────────────────────────────────────────
// v0.70: 一线 AI Agent 能力对齐模块
// 对标 Claude Code / Cursor / Devin / Manus 的核心能力域
// ────────────────────────────────────────────────────────────────────────────

// GitOperations — Git 一等公民工具集（对标 Claude Code git 工具）
//   status/diff/log/blame/show/branch/add/commit/push/pull/checkout/merge/rebase
export { GitOperations } from "./git-operations";
export type {
  GitOptions,
  GitDiffResult,
  GitLogEntry,
  GitBlameLine,
  GitStatusEntry,
} from "./git-operations";

// CodeIntelligence — 代码智能（对标 Cursor 代码库语义索引）
//   parseSymbols/searchSymbols/findReferences/planRename/applyRename
export { CodeIntelligence } from "./code-intelligence";
export type {
  CodeSymbol,
  CodeSearchResult,
  ReferenceResult,
  RenamePlan,
} from "./code-intelligence";

// apply-patch-tool — 通用 SEARCH/REPLACE patch 应用工具（对标 Claude Code Edit/MultiEdit）
//   4-pass 匹配 + 路径逃逸检查 + 两阶段原子应用
export { parsePatch, applyPatch } from "./apply-patch-tool";
export type { PatchHunk, PatchResult } from "./apply-patch-tool";

// VisionAnalyzer — VLM 视觉分析（对标 Claude Computer Use / Manus）
//   analyze/describeScreen/findElements/detectUIIssues/compareImages
export { VisionAnalyzer } from "./vision-analyzer";
export type {
  VisionAnalysisRequest,
  BoundingBox,
  UIElement,
  VisionAnalysisResult,
  VisionAnalyzerConfig,
  VisionChatFn,
} from "./vision-analyzer";

// BatchExecutor — 批量并发执行（对标 Devin 多步并行）
//   executeParallel/executeSequential/executeDAG + 限速 + 重试 + 失败隔离
export { BatchExecutor } from "./batch-executor";
export type {
  BatchTask,
  BatchTaskResult,
  BatchResult,
  BatchExecutorConfig,
  BatchToolExecutorFn,
} from "./batch-executor";

// WorkflowEngine — DAG 工作流引擎（对标 Manus 长程任务编排）
//   validate/execute/resume/saveCheckpoint + 条件分支 + 并行节点 + 状态持久化
export { WorkflowEngine } from "./workflow-engine";
export type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowDefinition,
  WorkflowNodeResult,
  WorkflowExecutionResult,
  WorkflowExecutorFn,
  WorkflowEngineConfig,
} from "./workflow-engine";

// SessionCheckpointManager — 会话检查点（对标 Devin session resume）
//   save/restore/list/delete/diff + FileCheckpointStore
export { SessionCheckpointManager, FileCheckpointStore } from "./session-checkpoint";
export type {
  SessionCheckpoint,
  CheckpointStore,
  CheckpointMeta,
} from "./session-checkpoint";

// DLQBatchRetry — 死信队列批量重试（对标生产级 MQ 治理）
//   retryAll/retryByTopic/retryWithFilter + 指数退避 + 失败隔离
export { DLQBatchRetry } from "./dlq-batch-utils";
export type {
  DLQEntry,
  DLQBatchRetryResult,
  DLQRetryHandler,
  DLQBatchConfig,
} from "./dlq-batch-utils";