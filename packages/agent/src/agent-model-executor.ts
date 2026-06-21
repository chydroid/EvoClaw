import { ServiceRegistry, EventBus, type DAGNode, type Skill, type PersonaConfig } from "@evoclaw/core";
import type { Span } from "@opentelemetry/api";
import { buildAgentSystemPrompt, buildCompactSkillsPrompt, type SystemPromptParams, type PromptMode } from "./system-prompt";
import { classifyLLMError, LLMErrorType, type ClassifiedError } from "./error-classifier";
import type { LedgerEntry, LedgerEventType } from "./event-ledger";
import type { ChatContent } from "@evoclaw/plugin-sdk";
import { tryCallLLM as tryCallLLMFn, callLLMOnce as callLLMOnceFn, parseStreamingResponse as parseStreamingResponseFn, buildOpenAITools as buildOpenAIToolsFn, nativeFetch, type LLMCallerDeps, type NativeFetchResponse } from "./llm-caller";
import * as fs from "fs";
import * as path from "path";
import {
  handleSkillInstall as handleSkillInstallFn,
  extractSkillNames as extractSkillNamesFn,
  extractApiKey as extractApiKeyFn,
  configureSkillApiKey as configureSkillApiKeyFn,
  handleBatchSkillInstall as handleBatchSkillInstallFn,
  downloadAndExtractSkill as downloadAndExtractSkillFn,
  downloadFile as downloadFileFn,
  extractZip as extractZipFn,
  execCommand as execCommandFn,
  findSkillMd as findSkillMdFn,
  type SkillInstallerDeps,
} from "./skill-installer";
import { ModelConfig, ProviderConfig, AgentExecutionResult, ToolDefinition, DEFAULT_PERSONA, DEFAULT_MODEL_CONFIG, TaskStatus, AgentProgressEvent, AgentProgressCallback, AutoSplitConfig } from "./types";
import { taskStatusTracker } from "./task-status-tracker";
import { TaskCheckpoint, taskCheckpointManager } from "./task-checkpoint-manager";
import { ExecutionCheckpointStore } from "./execution-checkpoint";
import { collapseNewlines as collapseNewlinesImpl, stripWebNoise as stripWebNoiseImpl, summarizeToolResult as summarizeToolResultFn, stripHtml, compactJson, compactJsonValue, smartTruncateString, filterPlainText, normalizeUrls, groupSimilarLines, extractCodeSignatures, deduplicateLines, smartTruncate } from "./text-processor";
import { tryQuickReply as tryQuickReplyFn, tryQuickReplyExtended as tryQuickReplyExtendedFn, tryUtilityReply as tryUtilityReplyFn, tryAstronomyReply as tryAstronomyReplyFn, generateChatResponse as generateChatResponseFn, hasActionIntent as hasActionIntentFn, type QuickReplyDeps, type SkillManagerLike } from "./quick-reply";
import { handleSlashCommand as handleSlashCommandFn, type SlashCommandDeps, type SlashCommandResult } from "./slash-commands";
import { HeartbeatManager, type HeartbeatHandlerDeps } from "./heartbeat";
import { sessionFilePath as sessionFilePathFn, persistSessionTurn as persistSessionTurnFn, persistEarlyReturn as persistEarlyReturnFn, loadSessionHistory as loadSessionHistoryFn, needsCompaction as needsCompactionFn, compactConversationHistory as compactConversationHistoryFn, type SessionPersistenceDeps } from "./session-persistence";
import { detectAndConfigureEmailAccount as detectAndConfigureEmailAccountFn, handleEmailOperation as handleEmailOperationFn, type EmailHandlerDeps } from "./email-handler";
import { onPermissionApproved as onPermissionApprovedFn, approveAndExecute as approveAndExecuteFn, rejectPermission as rejectPermissionFn, type PermissionHandlerDeps, type PendingOperation } from "./permission-handler";
import { handleSystemConfigQuery as handleSystemConfigQueryFn, type ConfigQueryDeps } from "./config-query";
import { analyzeUserIntent as analyzeUserIntentFn, decomposeTaskWithLLM as decomposeTaskWithLLMFn, parseMultipleTasks as parseMultipleTasksFn, handleMultipleTasks as handleMultipleTasksFn, decomposeTaskForAutoSplit as decomposeTaskForAutoSplitFn, executeSubtasksFromCheckpoint as executeSubtasksFromCheckpointFn, computeDynamicToolLimit as computeDynamicToolLimitFn, type TaskAnalyzerDeps } from "./task-analyzer";
import { preprocessSearch as preprocessSearchFn, buildEnhancedMessage as buildEnhancedMessageFn, type SearchPreprocessorDeps } from "./search-preprocessor";
import { generateBriefUnderstanding as generateBriefUnderstandingFn, type BriefUnderstandingDeps } from "./brief-understanding";
import { registerSequentialThinkingTool as registerSequentialThinkingToolFn, type ThinkingHistoryMap } from "./sequential-thinking-tool";
import { execute as dagExecute, executeSkillDirectly as dagExecuteSkillDirectly, generateReasoning as dagGenerateReasoning, extractToolParams as dagExtractToolParams, generateDefaultOutput as dagGenerateDefaultOutput, extractKeywords as dagExtractKeywords, type DAGExecutionDeps } from "./dag-execution";
import { HumanApprovalManager, type PendingApproval, type ApprovalConfig, type TrustRule, type RiskLevel } from "./human-approval";
import { SemanticQuickReply } from "./semantic-quick-reply";
import { CopilotRouter, type CopilotRouterConfig, type RoutingDecision } from "./copilot-router";
import { IterationBudget, type IterationBudgetConfig, type IterationBudgetStatus } from "./iteration-budget";
import { classifySkillError, isEmptySkillOutput, formatSkillReply, sanitizeSkillOutput } from "./skill-dispatch-error-handler";

// Re-export types and singletons from extracted modules for backward compatibility
export type { ModelConfig, ProviderConfig, AgentExecutionResult, ToolDefinition, TaskStatus, AgentProgressEvent, AgentProgressCallback, AutoSplitConfig } from "./types";
export { DEFAULT_PERSONA, DEFAULT_MODEL_CONFIG } from "./types";
export { taskStatusTracker } from "./task-status-tracker";
export type { TaskCheckpoint } from "./task-checkpoint-manager";
export { taskCheckpointManager } from "./task-checkpoint-manager";
export type { LLMCallerDeps, TryCallLLMOptions, TryCallLLMResult, CallLLMOnceResult, ParseStreamingResponseResult, OpenAIToolEntry, ConversationMessage, ToolCallEntry, LLMMessage } from "./llm-caller";
export { tryCallLLM, callLLMOnce, parseStreamingResponse, buildOpenAITools } from "./llm-caller";
export { HumanApprovalManager } from "./human-approval";
export type { PendingApproval, ApprovalConfig, TrustRule, RiskLevel } from "./human-approval";

export class AgentModelExecutor {
  private config: ModelConfig;
  private providers: ProviderConfig[] = [];
  private providerStats = new Map<string, {
    successCount: number;
    failureCount: number;
    lastError?: string;
    lastErrorType?: string;
  }>();
  private persona: PersonaConfig;
  private greeted = false;
  private registeredTools = new Map<string, {
    definition: ToolDefinition;
    handler: (params: Record<string, unknown>) => Promise<unknown>;
    checkFn?: () => boolean;
    dynamicSchemaOverrides?: () => Partial<ToolDefinition>;
  }>();
  private conversationHistory = new Map<string, Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; tool_call_id?: string; name?: string }>>();
  private maxHistoryLength = 20;
  private sessionDataDir: string;
  private sessionPersistenceEnabled = true;
  private compactionTokenThreshold: number;
  private thinkingLevel: "off" | "low" | "medium" | "high" = "medium";
  private sequentialThinkingHistory: ThinkingHistoryMap = new Map();
  private autoCompactionEnabled = true;
  private memoryHub: {
    getLongTerm(): {
      store(entry: import("@evoclaw/core").MemoryEntry): Promise<import("@evoclaw/core").MemoryEntry>;
      search(query: import("@evoclaw/core").MemorySearchQuery): Promise<import("@evoclaw/core").MemorySearchResult[]>;
    };
    remember?(entry: Omit<import("@evoclaw/core").MemoryEntry, "id" | "createdAt" | "accessedAt">): Promise<import("@evoclaw/core").MemoryEntry>;
  } | null = null;
  private bootstrapManager: import("./bootstrap-manager").BootstrapManager | null = null;
  private compactionManager: import("./compaction-manager").CompactionManager | null = null;
  private lifecycleManager: import("./agent-lifecycle").AgentLifecycleManager | null = null;
  private queueManager: import("./queue-manager").QueueManager | null = null;
  private sessionManager: import("./session-manager").SessionManager | null = null;
  private contextEngine: import("./context-engine").ContextEngine | null = null;
  private copilotRouter: CopilotRouter | null = null;
  private iterationBudgets = new Map<string, IterationBudget>();
  private pluginManager: import("@evoclaw/core").PluginManager | null = null;
  // ChannelManager integration — avoids cross-package import using any
  private channelManager: { getDMPolicy?: (...args: unknown[]) => unknown; getAllStatuses?: () => Array<unknown> } | null = null;

  /** Execution checkpoint store for durable execution & crash recovery */
  private executionCheckpointStore: ExecutionCheckpointStore;

  /** Human-in-the-Loop approval manager for high-risk tool operations */
  private humanApprovalManager: HumanApprovalManager | null = null;

  /** Semantic quick-reply classifier using local Transformers embedding */
  private semanticQuickReply = new SemanticQuickReply();

  /** Planning engine for explicit Plan→Verify→Execute */
  private planningEngine: import("./planning-engine").PlanningEngine | null = null;

  /** Reflection engine for Reflect→Replan mechanism */
  private reflectionEngine: import("./reflection-engine").ReflectionEngine | null = null;

  /** Active execution plans per session */
  private activePlans = new Map<string, import("./planning-engine").ExecutionPlan>();

  /** Tool execution traces per session for reflection */
  private executionTraces = new Map<string, import("./reflection-engine").ToolExecutionTrace[]>();

  /** Swarm orchestrator for multi-agent delegation */
  private swarmOrchestrator: import("./swarm-orchestrator").SwarmOrchestrator | null = null;

  /** ToolChain registry for predefined tool chain matching */
  private toolChainRegistry: import("./tool-chain-registry").ToolChainRegistry | null = null;

  /** Eval runner for agent behavior evaluation */
  private evalRunner: import("./evals").EvalRunner | null = null;

  private guardrailsManager: import("./guardrails").GuardrailsManager | null = null;
  private structuredOutputParser: import("./structured-output").StructuredOutputParser | null = null;
  private schemaRegistry: import("./structured-output").SchemaRegistry | null = null;
  private promptCache: import("./prompt-cache").PromptCache | null = null;
  private acpHandler: import("./acp-delegation").ACPProtocolHandler | null = null;
  private observability: import("./agent-observability").AgentObservability | null = null;
  private computedStatusEngine: import("./computed-status").ComputedStatusEngine | null = null;
  private staleContextManager: import("./stale-context").StaleContextManager | null = null;
  private steerManager: import("./steer-command").SteerManager | null = null;
  private workboard: import("./workboard").Workboard | null = null;

  /** Current observability trace ID for the active chat session */
  private _currentTraceId: string | undefined;

  /** Current ContextEngine result for the active chat session (set by chatInner) */
  private _currentContextEngineResult: import("./context-engine").LayeredContextResult | null = null;

  /** 工具结果缓存，避免相同工具+参数的重复 LLM 调用 */
  private toolResultCache = new Map<string, { result: string; timestamp: number }>();
  private static TOOL_CACHE_TTL = 5 * 60 * 1000; // 5 分钟
  private static TOOL_CACHE_MAX = 100;

  /**
   * Service-gated tools: check_fn TTL 缓存。
   * 灵感来自 hermes-agent registry._check_fn_cached（30s TTL，fail-safe）。
   * check_fn 探测外部状态（API key、服务在线等），在长生命周期进程内
   * 重复探测是浪费；缓存 30s 让环境变量变更在一个 turn 内自然传播。
   */
  private static CHECK_FN_TTL_MS = 30_000;
  private checkFnCache = new Map<() => boolean, { timestamp: number; result: boolean }>();

  /** 生成工具缓存 key，包含工具名和排序后的参数 */
  private getToolCacheKey(toolName: string, params: Record<string, unknown>): string {
    const sortedParams = Object.keys(params).sort().map(k => `${k}=${JSON.stringify(params[k])}`).join("&");
    return `${toolName}:${sortedParams}`;
  }

  /** 清理过期和超量的工具缓存 */
  private cleanToolCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.toolResultCache) {
      if (now - entry.timestamp > AgentModelExecutor.TOOL_CACHE_TTL) {
        this.toolResultCache.delete(key);
      }
    }
    if (this.toolResultCache.size > AgentModelExecutor.TOOL_CACHE_MAX) {
      const entries = Array.from(this.toolResultCache.entries())
        .sort((a, b) => b[1].timestamp - a[1].timestamp);
      this.toolResultCache.clear();
      for (let i = 0; i < AgentModelExecutor.TOOL_CACHE_MAX && i < entries.length; i++) {
        this.toolResultCache.set(entries[i][0], entries[i][1]);
      }
    }
  }

  /** Set memory hub for session/memory integration */
  setMemoryHub(hub: {
    getLongTerm(): { store(entry: import("@evoclaw/core").MemoryEntry): Promise<import("@evoclaw/core").MemoryEntry>; search(query: import("@evoclaw/core").MemorySearchQuery): Promise<import("@evoclaw/core").MemorySearchResult[]> };
    remember?(entry: Omit<import("@evoclaw/core").MemoryEntry, "id" | "createdAt" | "accessedAt">): Promise<import("@evoclaw/core").MemoryEntry>;
    getEmbeddingProvider?(): { embed(text: string): Promise<number[]>; embedBatch?(texts: string[]): Promise<number[][]>; dimensions?: number } | null;
  }): void {
    this.memoryHub = hub;
    process.stdout.write(`[AgentModelExecutor] Memory hub integrated`);
    // Wire up the semantic quick-reply classifier with the embedding provider
    // so it can classify user intent locally without calling the LLM.
    try {
      const provider = hub.getEmbeddingProvider?.();
      if (provider && typeof provider.embed === "function") {
        // Bind the embed method to preserve the `this` context of the
        // original TransformersEmbeddingProvider instance. Without binding,
        // calling embed() loses the `this` pointer and getPipeline() fails.
        const boundEmbed = provider.embed.bind(provider);
        this.semanticQuickReply.setProvider({ embed: boundEmbed, dimensions: provider.dimensions });
        process.stdout.write(`[AgentModelExecutor] Semantic quick-reply enabled (embedding dims=${provider.dimensions ?? "?"})`);
      }
    } catch {
      // Non-fatal: semantic quick reply is best-effort
    }
  }

  /** Set bootstrap manager */
  setBootstrapManager(bm: import("./bootstrap-manager").BootstrapManager): void {
    this.bootstrapManager = bm;
    process.stdout.write(`[AgentModelExecutor] Bootstrap manager integrated`);
  }

  /** Get bootstrap manager for tool registration */
  getBootstrapManager(): import("./bootstrap-manager").BootstrapManager | null {
    return this.bootstrapManager;
  }

  /** Set compaction manager */
  setCompactionManager(cm: import("./compaction-manager").CompactionManager): void {
    this.compactionManager = cm;
    process.stdout.write(`[AgentModelExecutor] Compaction manager integrated`);
  }

  /** Set lifecycle manager */
  setLifecycleManager(lm: import("./agent-lifecycle").AgentLifecycleManager): void {
    this.lifecycleManager = lm;
    process.stdout.write(`[AgentModelExecutor] Lifecycle manager integrated`);
  }

  /** Set queue manager */
  setQueueManager(qm: import("./queue-manager").QueueManager): void {
    this.queueManager = qm;
    process.stdout.write(`[AgentModelExecutor] Queue manager integrated`);
  }

  /** Set session manager */
  setSessionManager(sm: import("./session-manager").SessionManager): void {
    this.sessionManager = sm;
    process.stdout.write(`[AgentModelExecutor] Session manager integrated`);
  }

  /** Set context engine */
  setContextEngine(ce: import("./context-engine").ContextEngine): void {
    this.contextEngine = ce;
    process.stdout.write(`[AgentModelExecutor] Context engine integrated`);
  }

  /** Set copilot router */
  setCopilotRouter(config?: Partial<CopilotRouterConfig>): void {
    this.copilotRouter = new CopilotRouter(config);
    process.stdout.write(`[AgentModelExecutor] Copilot router integrated (enabled=${this.copilotRouter !== null})`);
  }

  /** Token usage tracker for recording LLM call metrics */
  private tokenUsageTracker: import("./token-usage-tracker").TokenUsageTracker | null = null;

  /** Set token usage tracker */
  setTokenUsageTracker(tracker: import("./token-usage-tracker").TokenUsageTracker): void {
    this.tokenUsageTracker = tracker;
  }

  /** Get model cost provider from the gateway metadata cache */
  getModelCostProvider(): import("./token-usage-tracker").ModelCostProvider | undefined {
    return this.tokenUsageTracker ? { getModelCost: () => undefined } : undefined;
  }

  /** Record token usage after an LLM call */
  private recordTokenUsage(sessionId: string, provider: string, model: string, inputTokens: number, outputTokens: number, durationMs: number, channel?: string): void {
    if (!this.tokenUsageTracker) return;
    try {
      this.tokenUsageTracker.record({
        sessionId,
        provider,
        model,
        inputTokens,
        outputTokens,
        durationMs,
        channel: channel || "web-ui",
      });
    } catch {
      // Best-effort: don't break the LLM call flow
    }
  }

  /** Get or create iteration budget for a session */
  getIterationBudget(sessionId: string): IterationBudget {
    let budget = this.iterationBudgets.get(sessionId);
    if (!budget) {
      budget = new IterationBudget({ maxIterations: 20, enableGraceCall: true });
      this.iterationBudgets.set(sessionId, budget);
    }
    return budget;
  }

  /** Reset iteration budget for a session (call at start of new turn) */
  resetIterationBudget(sessionId: string): void {
    const budget = this.iterationBudgets.get(sessionId);
    if (budget) {
      budget.reset();
    }
  }

  /** Set plugin manager */
  setPluginManager(pm: import("@evoclaw/core").PluginManager): void {
    this.pluginManager = pm;
    process.stdout.write(`[AgentModelExecutor] Plugin manager integrated`);
  }

  /** Get guardrails manager */
  getGuardrailsManager(): import("./guardrails").GuardrailsManager | null {
    return this.guardrailsManager;
  }

  /** Set channel manager */
  setChannelManager(cm: { getDMPolicy?: (...args: unknown[]) => unknown; getAllStatuses?: () => Array<unknown> }): void {
    this.channelManager = cm;
    process.stdout.write(`[AgentModelExecutor] Channel manager integrated`);
  }

  /** Set context pruning manager */
  setContextPruningManager(pm: import("./context-pruning").ContextPruningManager): void {
    (this as any).contextPruningManager = pm;
    process.stdout.write(`[AgentModelExecutor] Context pruning manager integrated`);
  }

  /** Set input pipeline */
  setInputPipeline(pipeline: import("./input-pipeline").PipelineRunner): void {
    (this as any).inputPipeline = pipeline;
    process.stdout.write(`[AgentModelExecutor] Input pipeline integrated`);
  }

  /** Set human approval manager */
  setHumanApprovalManager(manager: HumanApprovalManager): void {
    this.humanApprovalManager = manager;
    process.stdout.write(`[AgentModelExecutor] Human approval manager integrated`);
  }

  /** Set eval runner */
  setEvalRunner(runner: import("./evals").EvalRunner): void {
    this.evalRunner = runner;
    process.stdout.write(`[AgentModelExecutor] Eval runner integrated`);
  }

  /** Get the eval runner */
  getEvalRunner(): import("./evals").EvalRunner | null {
    return this.evalRunner;
  }

  /** Get the human approval manager */
  getHumanApprovalManager(): HumanApprovalManager | null {
    return this.humanApprovalManager;
  }

  /** Approve a pending HITL operation */
  approveOperation(approvalId: string, decidedBy: string, trustFuture?: boolean, modifiedArgs?: Record<string, unknown>): boolean {
    if (!this.humanApprovalManager) return false;
    return this.humanApprovalManager.approve(approvalId, decidedBy, trustFuture, modifiedArgs);
  }

  /** Reject a pending HITL operation */
  rejectOperation(approvalId: string, decidedBy: string, reason?: string): boolean {
    if (!this.humanApprovalManager) return false;
    return this.humanApprovalManager.reject(approvalId, decidedBy, reason);
  }

  /** Get pending HITL approvals for a session */
  getPendingApprovals(sessionId?: string): PendingApproval[] {
    if (!this.humanApprovalManager) return [];
    return this.humanApprovalManager.getPendingApprovals(sessionId);
  }

  /** Get the execution checkpoint store for durable execution & crash recovery */
  getExecutionCheckpointStore(): ExecutionCheckpointStore {
    return this.executionCheckpointStore;
  }

  /** List all interrupted/failed executions that can be resumed */
  listResumableExecutions(): Array<{ sessionId: string; originalMessage: string; status: string; snapshotCount: number; lastCheckpointTime: number }> {
    return this.executionCheckpointStore.getResumableExecutions().map(s => ({
      sessionId: s.sessionId,
      originalMessage: s.originalMessage.slice(0, 100),
      status: s.status,
      snapshotCount: s.snapshots.length,
      lastCheckpointTime: s.lastCheckpointTime,
    }));
  }

  /** Resume an interrupted execution from the last checkpoint (or a specific snapshot) */
  async resumeExecution(
    sessionId: string,
    fromSnapshotIndex?: number,
    onProgress?: AgentProgressCallback,
  ): Promise<{ reply: string; tokensUsed: number; contextTokens?: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean; files?: Array<{ path: string; size: number; downloadUrl: string }> } | null> {
    const resumeData = this.executionCheckpointStore.getSnapshotForResume(sessionId, fromSnapshotIndex);
    if (!resumeData) return null;

    const { messages, originalMessage } = resumeData;
    const startTime = Date.now();
    const pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }> = [];

    process.stdout.write(`[AgentModelExecutor] Resuming execution for session "${sessionId}" from snapshot ${fromSnapshotIndex ?? "latest"}, ${messages.length} messages`);

    // Delete the old execution state so a fresh one is created by tryCallLLM
    this.executionCheckpointStore.deleteExecution(sessionId);

    // Re-run chat with the original message — the conversation history will be
    // reconstructed from the snapshot so the LLM continues where it left off.
    // We inject the snapshot messages into conversation history first.
    const historyEntries: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; tool_call_id?: string; name?: string }> = [];
    for (const msg of messages) {
      if (msg.role === "user" || msg.role === "assistant" || msg.role === "tool") {
        historyEntries.push({
          role: msg.role,
          content: msg.content,
          ...(msg.tool_calls ? { tool_calls: msg.tool_calls as Array<{ id: string; type: string; function: { name: string; arguments: string } }> } : {}),
          ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
          ...(msg.name ? { name: msg.name } : {}),
        });
      }
    }
    this.conversationHistory.set(sessionId, historyEntries);

    // Call chat() to continue execution
    return this.chat(originalMessage, { sessionId }, onProgress);
  }

  private runIdCounter = 0;
  private workspacePath: string;
  private bootstrapFiles: Array<{ path: string; content: string }> = [];
  private _cachedSkillNames: Set<string> = new Set();
  
  private pendingOperations = new Map<string, { sessionId: string; message: string; requestId: string; toolName: string; toolArgs: Record<string, unknown> }>();
  private pendingApprovalCommands = new Map<string, { command: string; rejectedAt: number }>();
  private isProcessingQueue = false;

  // ── Heartbeat mechanism ──
  private heartbeatManager = new HeartbeatManager();

  // Lazily resolve EventLedger to avoid circular dependency (it's registered after this class)
  private _eventLedger: { append(type: LedgerEventType, data: Record<string, unknown>, opts?: { agentId?: string; sessionId?: string; causedBy?: number; duration?: number }): number; recordToolExecution(toolName: string, params: Record<string, unknown>, result: unknown, duration: number, opts?: { agentId?: string; sessionId?: string }): { callSeq: number; resultSeq: number }; query(q: Record<string, unknown>): LedgerEntry[]; snapshot(): Record<string, unknown> } | null = null;
  private getEventLedger() {
    if (!this._eventLedger) {
      this._eventLedger = this.registry.resolveService("eventLedger") as typeof this._eventLedger;
    }
    return this._eventLedger;
  }

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    config?: Partial<ModelConfig>,
    persona?: Partial<PersonaConfig>,
    private runtimeOptions: { storeDir?: string } = {}
  ) {
    this.config = { ...DEFAULT_MODEL_CONFIG, ...config };
    this.persona = { ...DEFAULT_PERSONA, ...persona };
    this.sessionDataDir = path.resolve(process.cwd(), "data", "sessions");
    this.workspacePath = path.resolve(process.cwd(), "data", "workspace");
    this.compactionTokenThreshold = 100000; // 100K tokens — trigger compaction when context exceeds this
    this.executionCheckpointStore = new ExecutionCheckpointStore(
      path.resolve(process.cwd(), "data", "execution-checkpoints")
    );
    this.loadBootstrapFiles();
    registry.registerService("agentModelExecutor", this);
    this.setupEventListeners();
    this.registerBuiltinTools();
    this.initPlanningAndReflection();
  }

  /** Initialize Planning and Reflection engines */
  private initPlanningAndReflection(): void {
    try {
      const { PlanningEngine } = require("./planning-engine") as { PlanningEngine: new (deps: import("./planning-engine").PlanningEngineDeps) => import("./planning-engine").PlanningEngine };
      this.planningEngine = new PlanningEngine({
        providers: this.providers,
        persona: this.persona,
        recordProviderSuccess: (id: string) => this.recordProviderSuccess(id),
        recordProviderFailure: (id: string, error: string, errorType?: string) => this.recordProviderFailure(id, error, errorType ?? "UNKNOWN"),
      });
    } catch { /* planning-engine not available in test env */ }

    try {
      const { ReflectionEngine } = require("./reflection-engine") as { ReflectionEngine: new (config?: Partial<import("./reflection-engine").ReflectionConfig>, callLLMFn?: (prompt: string, systemPrompt: string) => Promise<string>) => import("./reflection-engine").ReflectionEngine };
      this.reflectionEngine = new ReflectionEngine(
        { enabled: true, reflectAfterNTools: 3, reflectOnFailure: true, maxReflections: 3, confidenceThreshold: 0.3 },
        async (prompt: string, _systemPrompt: string) => {
          // Use the first enabled provider for reflection LLM calls
          const enabled = this.providers.filter(p => p.enabled).sort((a, b) => a.order - b.order);
          if (enabled.length === 0) return '{"shouldContinue":true,"shouldReplan":false,"shouldRetry":false,"analysis":"No LLM available for reflection","confidence":0.3}';
          try {
            const resp = await nativeFetch(`${enabled[0].baseURL}/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${enabled[0].apiKey}` },
              body: JSON.stringify({ model: enabled[0].model, messages: [{ role: "user", content: prompt }], max_tokens: 500, temperature: 0.3 }),
              signal: AbortSignal.timeout(15000),
            });
            const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
            return json.choices?.[0]?.message?.content ?? '{"shouldContinue":true,"shouldReplan":false,"shouldRetry":false,"analysis":"Empty response","confidence":0.3}';
          } catch {
            return '{"shouldContinue":true,"shouldReplan":false,"shouldRetry":false,"analysis":"Reflection LLM call failed","confidence":0.3}';
          }
        }
      );
    } catch { /* reflection-engine not available in test env */ }

    try {
      const { SwarmOrchestrator } = require("./swarm-orchestrator") as { SwarmOrchestrator: new (eventBus: EventBus, config?: import("./swarm-orchestrator").SwarmConfig) => import("./swarm-orchestrator").SwarmOrchestrator };
      this.swarmOrchestrator = new SwarmOrchestrator(this.eventBus, { maxAgents: 10, defaultTimeoutMs: 60000 });
      this.registerBuiltinSwarmAgents();
    } catch { /* swarm-orchestrator not available in test env */ }

    try {
      const { createBuiltinToolChainRegistry } = require("./tool-chain-registry") as { createBuiltinToolChainRegistry: () => import("./tool-chain-registry").ToolChainRegistry };
      this.toolChainRegistry = createBuiltinToolChainRegistry();
    } catch { /* tool-chain-registry not available */ }

    // Guardrails
    try {
      const { GuardrailsManager } = require("./guardrails");
      this.guardrailsManager = new GuardrailsManager();
    } catch (err) { console.debug("[AgentModelExecutor] guardrails not available:", err instanceof Error ? err.message : String(err)); }

    // Structured Output
    try {
      const { StructuredOutputParser, SchemaRegistry } = require("./structured-output");
      this.structuredOutputParser = new StructuredOutputParser();
      this.schemaRegistry = new SchemaRegistry();
    } catch { /* structured output not available */ }

    // Prompt Cache
    try {
      const { PromptCache } = require("./prompt-cache");
      this.promptCache = new PromptCache();
    } catch { /* prompt cache not available */ }

    // ACP Delegation
    try {
      const { ACPProtocolHandler } = require("./acp-delegation");
      this.acpHandler = new ACPProtocolHandler();
    } catch { /* ACP not available */ }

    // Observability
    try {
      const { AgentObservability } = require("./agent-observability");
      this.observability = new AgentObservability({
        storeDir: this.runtimeOptions.storeDir
          ? path.join(this.runtimeOptions.storeDir, "observability")
          : undefined,
      });
    } catch { /* observability not available */ }

    // Computed Status Engine
    try {
      const { ComputedStatusEngine } = require("./computed-status");
      this.computedStatusEngine = new ComputedStatusEngine();
    } catch (err) { console.debug("[AgentModelExecutor] computed status not available:", err instanceof Error ? err.message : String(err)); }

    // Stale Context Manager
    try {
      const { StaleContextManager } = require("./stale-context");
      this.staleContextManager = new StaleContextManager();
    } catch { /* stale context not available */ }

    // Steer Manager
    try {
      const { SteerManager } = require("./steer-command");
      this.steerManager = new SteerManager();
    } catch { /* steer not available */ }

    // Workboard
    try {
      const { Workboard } = require("./workboard");
      this.workboard = new Workboard();
    } catch { /* workboard not available */ }
  }

  /** Register built-in virtual agents in the swarm */
  private registerBuiltinSwarmAgents(): void {
    if (!this.swarmOrchestrator) return;
    const builtinAgents: Array<{ name: string; role: import("./swarm-orchestrator").AgentRole; capabilities: string[] }> = [
      { name: "PlannerAgent", role: "planner", capabilities: ["planning", "decomposition", "task-analysis"] },
      { name: "ResearchAgent", role: "researcher", capabilities: ["web-search", "web-fetch", "browser-navigate", "information-retrieval"] },
      { name: "CodeAgent", role: "executor", capabilities: ["shell-exec", "file-create", "file-modify", "file-read", "coding", "programming"] },
      { name: "BrowserAgent", role: "executor", capabilities: ["browser-navigate", "browser-click", "browser-fill-form", "browser-select", "browser-check", "browser-wait", "browser-screenshot", "web-automation"] },
      { name: "ReviewAgent", role: "reviewer", capabilities: ["review", "quality-check", "validation", "verification"] },
    ];
    for (const agent of builtinAgents) {
      try {
        this.swarmOrchestrator.registerAgent(agent);
      } catch (err) { console.debug("[AgentModelExecutor] max agents reached:", err instanceof Error ? err.message : String(err)); }
    }
  }

  private registerBuiltinTools(): void {
    registerSequentialThinkingToolFn(this, this.sequentialThinkingHistory);

    this.registeredTools.set("execute_tool_chain", {
      definition: {
        name: "execute_tool_chain",
        description: "Execute a predefined tool chain by name. Use this when the task matches a known workflow pattern.",
        parameters: {
          chain_name: { type: "string", description: "Name of the tool chain to execute" },
          initial_params: { type: "object", description: "Optional initial parameters for the chain" },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        if (!this.toolChainRegistry) return JSON.stringify({ error: "ToolChain system not available" });
        const chain = this.toolChainRegistry.get(params.chain_name as string);
        if (!chain) return JSON.stringify({ error: `Tool chain "${params.chain_name}" not found. Available: ${this.toolChainRegistry.list().map(c => c.name).join(", ")}` });
        const { ToolChainExecutor } = require("./tool-chain") as { ToolChainExecutor: new (registry: Map<string, { handler: (params: Record<string, unknown>) => Promise<unknown> }>) => import("./tool-chain").ToolChainExecutor };
        // Build a compatible map: registeredTools has { definition, handler }, ToolChainExecutor expects { handler }
        const toolMap = new Map<string, { handler: (params: Record<string, unknown>) => Promise<unknown> }>();
        for (const [name, entry] of this.registeredTools) {
          toolMap.set(name, { handler: entry.handler });
        }
        const executor = new ToolChainExecutor(toolMap);
        const result = await executor.execute(chain, params.initial_params as Record<string, unknown> | undefined);
        return JSON.stringify(result);
      },
    });
  }

  private setupEventListeners(): void {
    this.eventBus.subscribe(
      "permission.approved",
      async (event: { data: { requestId: string; operation: string; target: string } }) => {
        await this.onPermissionApproved(event.data.requestId);
      }
    );
  }

  setSessionDataDir(dir: string): void {
    this.sessionDataDir = dir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  setSessionPersistence(enabled: boolean): void {
    this.sessionPersistenceEnabled = enabled;
  }

  setAutoCompaction(enabled: boolean): void {
    this.autoCompactionEnabled = enabled;
  }

  setCompactionTokenThreshold(tokens: number): void {
    this.compactionTokenThreshold = tokens;
  }

  setWorkspacePath(dir: string): void {
    this.workspacePath = dir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.loadBootstrapFiles();
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  private loadBootstrapFiles(): void {
    this.bootstrapFiles = [];
    const fileNames = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"];
    const maxFileChars = 12000;
    let totalChars = 0;
    const totalMaxChars = 60000;

    for (const fileName of fileNames) {
      const filePath = path.join(this.workspacePath, fileName);
      if (!fs.existsSync(filePath)) continue;

      try {
        let content = fs.readFileSync(filePath, "utf-8").trim();
        if (!content) continue;

        if (content.length > maxFileChars) {
          content = content.slice(0, maxFileChars) + "\n\n[Content truncated...]";
        }

        if (totalChars + content.length > totalMaxChars) {
          const remaining = totalMaxChars - totalChars;
          if (remaining > 100) {
            content = content.slice(0, remaining) + "\n\n[Content truncated due to total limit...]";
          } else {
            break;
          }
        }

        totalChars += content.length;
        this.bootstrapFiles.push({ path: fileName, content });
        process.stdout.write(`[AgentModelExecutor] Loaded bootstrap file: ${fileName} (${content.length} chars)`);
      } catch (err) {
        process.stderr.write(`[AgentModelExecutor] Failed to read bootstrap file ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  getBootstrapFiles(): Array<{ path: string; content: string }> {
    return [...this.bootstrapFiles];
  }

  private sessionFilePath(sessionId: string): string {
    return sessionFilePathFn(this.getSessionPersistenceDeps(), sessionId);
  }

  private persistSessionTurn(sessionId: string, role: string, content: string | null, metadata?: Record<string, unknown>): void {
    persistSessionTurnFn(this.getSessionPersistenceDeps(), sessionId, role, content, metadata);
  }

  /** Persist a conversation turn for early-return paths (skill install, config query, etc.) */
  private persistEarlyReturn(sessionId: string, userMessage: string, assistantReply: string): void {
    persistEarlyReturnFn(this.getSessionPersistenceDeps(), sessionId, userMessage, assistantReply);
  }

  private loadSessionHistory(sessionId: string): Array<{ role: string; content: string | null }> {
    return loadSessionHistoryFn(this.getSessionPersistenceDeps(), sessionId);
  }

  private needsCompaction(sessionId: string, systemPrompt: string, maxTokens: number): boolean {
    return needsCompactionFn(this.getSessionPersistenceDeps(), sessionId, systemPrompt, maxTokens);
  }

  private compactConversationHistory(sessionId: string, keepRecentTurns: number = 3): void {
    compactConversationHistoryFn(this.getSessionPersistenceDeps(), sessionId, keepRecentTurns);
  }

  /** Build the deps object for session persistence module */
  private getSessionPersistenceDeps(): SessionPersistenceDeps {
    return {
      sessionDataDir: this.sessionDataDir,
      sessionPersistenceEnabled: this.sessionPersistenceEnabled,
      autoCompactionEnabled: this.autoCompactionEnabled,
      compactionTokenThreshold: this.compactionTokenThreshold,
      conversationHistory: this.conversationHistory,
      compactionManager: this.compactionManager,
      lifecycleManager: this.lifecycleManager,
      sessionManager: this.sessionManager,
      memoryHub: this.memoryHub,
    };
  }

  /** Build the deps object for LLM caller module */
  private getLLMCallerDeps(): LLMCallerDeps {
    return {
      config: this.config,
      providers: this.providers,
      persona: this.persona,
      registeredTools: this.registeredTools,
      conversationHistory: this.conversationHistory,
      maxHistoryLength: this.maxHistoryLength,
      providerStats: this.providerStats,
      pluginManager: this.pluginManager,
      registry: this.registry,
      sessionManager: this.sessionManager,
      pendingOperations: this.pendingOperations,
      pendingApprovalCommands: this.pendingApprovalCommands,
      toolResultCache: this.toolResultCache,
      sessionDataDir: this.sessionDataDir,
      sessionPersistenceEnabled: this.sessionPersistenceEnabled,
      autoCompactionEnabled: this.autoCompactionEnabled,
      compactionTokenThreshold: this.compactionTokenThreshold,
      compactionManager: this.compactionManager,
      lifecycleManager: this.lifecycleManager,
      memoryHub: this.memoryHub,
      recordProviderSuccess: (id: string) => this.recordProviderSuccess(id),
      recordProviderFailure: (id: string, error: string, errorType?: string) => this.recordProviderFailure(id, error, errorType ?? "UNKNOWN"),
      getEventLedger: () => this.getEventLedger(),
      buildSkillsPromptForRun: () => this.buildSkillsPromptForRun(),
      executionCheckpointStore: this.executionCheckpointStore,
      humanApprovalManager: this.humanApprovalManager ?? undefined,
      recordToolTrace: (sessionId: string, toolName: string, params: Record<string, unknown>, result: unknown, success: boolean, duration: number, error?: string) => this.recordToolTrace(sessionId, toolName, params, result, success, duration, error),
      checkAndReflect: (sessionId: string) => this.checkAndReflect(sessionId),
      updatePlanStep: (sessionId: string, stepId: string, update: { status: string; result?: string; error?: string }) => this.updatePlanStep(sessionId, stepId, update),
      checkInputGuardrail: this.guardrailsManager ? (input: string) => this.guardrailsManager!.checkInput(input) : undefined,
      checkOutputGuardrail: this.guardrailsManager ? (output: string) => this.guardrailsManager!.checkOutput(output) : undefined,
      checkToolGuardrail: this.guardrailsManager ? (toolName: string, args: Record<string, unknown>) => this.guardrailsManager!.checkToolCall(toolName, args) : undefined,
      observability: this.observability ?? undefined,
      currentTraceId: this._currentTraceId,
      recordStaleContext: this.staleContextManager ? (sessionId: string, toolName: string) => this.staleContextManager!.recordToolResult(sessionId, toolName) : undefined,
      getSteerMessage: this.steerManager ? (sessionId: string) => this.steerManager!.formatSteerMessage(sessionId) : undefined,
      semanticIntentClassifier: this.semanticQuickReply,
      tokenUsageTracker: this.tokenUsageTracker ?? undefined,
      checkFnEvaluator: (fn: () => boolean) => this.evaluateCheckFn(fn),
    };
  }

  /** Build the deps object for permission handler module */
  private _permissionHandlerDeps(): PermissionHandlerDeps {
    return {
      pendingOperations: this.pendingOperations,
      registeredTools: this.registeredTools,
      registry: this.registry,
      eventBus: this.eventBus,
      getEventLedger: () => this.getEventLedger(),
    };
  }

  /** Build the deps object for email handler module */
  private _emailHandlerDeps(): EmailHandlerDeps {
    return {
      registeredTools: this.registeredTools,
      registry: this.registry,
    };
  }

  /** Build the deps object for config query module */
  private _configQueryDeps(): ConfigQueryDeps {
    return {
      providers: this.providers,
      registeredTools: this.registeredTools,
      persona: this.persona,
      maxHistoryLength: this.maxHistoryLength,
      autoCompactionEnabled: this.autoCompactionEnabled,
      compactionTokenThreshold: this.compactionTokenThreshold,
      memoryHub: this.memoryHub,
    };
  }

  /** Build the deps object for DAG execution module */
  private getDAGExecutionDeps(): DAGExecutionDeps {
    return {
      registeredTools: this.registeredTools,
      config: this.config,
      providers: this.providers,
      eventBus: this.eventBus,
      registry: this.registry,
      estimateTokenCount: (text: string) => this.estimateTokenCount(text),
    };
  }

  private async onPermissionApproved(requestId: string): Promise<void> {
    await onPermissionApprovedFn(this._permissionHandlerDeps(), requestId);
  }

  /**
   * 权限批准快速通道：直接重新执行被阻塞的工具，不经过 LLM
   * 返回工具执行结果，由调用方直接反馈给用户
   */
  async approveAndExecute(requestId: string, addToWhitelist: boolean = true): Promise<{ success: boolean; reply: string; toolName?: string }> {
    return approveAndExecuteFn(this._permissionHandlerDeps(), requestId, addToWhitelist);
  }

  /**
   * 权限拒绝快速通道：清理 pending 状态，返回拒绝确认
   */
  rejectPermission(requestId: string): { success: boolean; reply: string } {
    return rejectPermissionFn(this._permissionHandlerDeps(), requestId);
  }

  /**
   * Detect email credentials in user input and auto-configure email account
   * Supported patterns:
   * - "xxx@163.com 密码是：xxxxx"
   * - "xxx@gmail.com password: xxxxx"
   * - "邮箱地址: xxx@xxx.com, 密码: xxxxx"
   * - "邮箱账号xxx@163.com 授权码：xxxxx"
   */
  private async detectAndConfigureEmailAccount(message: string): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean } | null> {
    return detectAndConfigureEmailAccountFn(this._emailHandlerDeps(), message);
  }

  /**
   * Handle email inbox operations: list emails, summarize, analyze
   * This is called when the task classifier detects email_handling intent
   */
  private async handleEmailOperation(message: string): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean } | null> {
    return handleEmailOperationFn(this._emailHandlerDeps(), message);
  }

  configure(config: Partial<ModelConfig>): void {
    this.config = { ...this.config, ...config };
  }

  configureProviders(providers: ProviderConfig[]): void {
    this.providers = providers
      .filter((p) => p.enabled)
      .sort((a, b) => a.order - b.order);
    
    // 初始化或保留统计数据
    for (const provider of this.providers) {
      if (!this.providerStats.has(provider.id)) {
        this.providerStats.set(provider.id, {
          successCount: 0,
          failureCount: 0,
        });
      }
    }
  }

  getProviders(): ProviderConfig[] {
    return this.providers.map(provider => {
      const stats = this.providerStats.get(provider.id) || { successCount: 0, failureCount: 0 };
      return {
        ...provider,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        lastError: stats.lastError,
        lastErrorType: stats.lastErrorType,
      };
    });
  }

  registerTool(
    name: string,
    definition: ToolDefinition,
    handler: (params: Record<string, unknown>) => Promise<unknown>,
    checkFn?: () => boolean,
    dynamicSchemaOverrides?: () => Partial<ToolDefinition>,
  ): void {
    this.registeredTools.set(name, { definition, handler, checkFn, dynamicSchemaOverrides });
  }

  unregisterTool(name: string): void {
    const entry = this.registeredTools.get(name);
    if (entry?.checkFn) {
      // 清理 checkFn 缓存，避免内存泄漏（旧 fn 引用残留）
      this.checkFnCache.delete(entry.checkFn);
    }
    this.registeredTools.delete(name);
  }

  /**
   * 评估工具的 check_fn，带 TTL 缓存。
   * 异常视为"不可用"（fail-safe），与 hermes-agent 行为一致。
   */
  private evaluateCheckFn(fn: () => boolean): boolean {
    const now = Date.now();
    const cached = this.checkFnCache.get(fn);
    if (cached && now - cached.timestamp < AgentModelExecutor.CHECK_FN_TTL_MS) {
      return cached.result;
    }
    let result: boolean;
    try {
      result = !!fn();
    } catch {
      result = false;
    }
    this.checkFnCache.set(fn, { timestamp: now, result });
    return result;
  }

  /**
   * 清空 check_fn 缓存。在配置变更（如环境变量更新）后调用，
   * 让下一次工具列表构建时重新探测服务可用性。
   */
  invalidateCheckFnCache(): void {
    this.checkFnCache.clear();
  }

  configurePersona(persona: Partial<PersonaConfig>): void {
    this.persona = { ...DEFAULT_PERSONA, ...persona };
  }

  getPersona(): PersonaConfig {
    return { ...this.persona };
  }

  /**
   * 记录 Provider 成功调用
   */
  private recordProviderSuccess(providerId: string): void {
    const stats = this.providerStats.get(providerId) || { successCount: 0, failureCount: 0 };
    stats.successCount += 1;
    this.providerStats.set(providerId, stats);
  }

  /**
   * 记录 Provider 失败调用
   */
  private recordProviderFailure(providerId: string, errorMessage: string, errorType: string): void {
    const stats = this.providerStats.get(providerId) || { successCount: 0, failureCount: 0 };
    stats.failureCount += 1;
    stats.lastError = errorMessage;
    stats.lastErrorType = errorType;
    this.providerStats.set(providerId, stats);
  }

  buildSystemPrompt(promptMode?: PromptMode, context?: { skillsPrompt?: string; workspacePath?: string; bootstrapFiles?: Array<{ path: string; content: string }>; channel?: string }): string {
    const toolNames = Array.from(this.registeredTools.keys());
    const mode = promptMode || "full";

    // Inject bootstrap context (AGENTS.md, SOUL.md, IDENTITY.md, etc.) at the top
    let bootstrapPrefix = "";
    if (this.bootstrapManager) {
      try {
        const ctx = this.bootstrapManager.getContext();
        bootstrapPrefix = this.bootstrapManager.buildSystemPromptInjection(ctx);
        if (bootstrapPrefix.trim()) {
          bootstrapPrefix += "\n\n---\n\n";
        }
      } catch (err) {
        process.stderr.write(`[AgentModelExecutor] Failed to load bootstrap context: ${err}`);
      }
    }

    const skillNames = this.getCachedSkillNames();
    const skillsPrompt = context?.skillsPrompt ||
      (this.registeredTools.size > 0
        ? buildCompactSkillsPrompt(
            Array.from(this.registeredTools.entries())
              .filter(([_, t]) => t.definition.description.includes("skill") || skillNames.has(t.definition.name))
              .map(([name, t]) => ({
                name,
                description: t.definition.description,
                location: `tool://${name}`,
              }))
          )
        : undefined);

    const workspacePath = context?.workspacePath || this.workspacePath;
    const effectiveBootstrapFiles = context?.bootstrapFiles !== undefined ? context.bootstrapFiles : this.bootstrapFiles;

    return bootstrapPrefix + buildAgentSystemPrompt({
      promptMode: mode,
      personaName: this.persona.name,
      personaTitle: this.persona.title,
      masterTerm: this.persona.masterTerm,
      personaTone: this.persona.tone,
      registeredToolNames: toolNames,
      skillsPrompt,
      workspacePath,
      userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
      timeFormat: "24",
      hostInfo: {
        os: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
      },
      repoRoot: workspacePath,
      bootstrapFiles: effectiveBootstrapFiles.length > 0 ? effectiveBootstrapFiles : undefined,
      channel: context?.channel,
      thinkingLevel: this.thinkingLevel,
    });
  }

  private async isSkillTool(name: string): Promise<boolean> {
    const skillManager = this.registry?.resolveService<{ listSkills(): Promise<Array<{ name: string }>> }>("skillManager");
    if (skillManager) {
      const skills = await skillManager.listSkills();
      return Array.isArray(skills) && skills.some((s) => s.name === name);
    }
    return false;
  }

  private getCachedSkillNames(): Set<string> {
    return this._cachedSkillNames;
  }

  async buildSkillsPromptForRun(): Promise<string> {
    const skills: Array<{ name: string; description: string; location: string }> = [];
    const skillManager = this.registry?.resolveService<{ listSkills(): Promise<Array<{ id: string; name: string; description: string; installPath: string }>> }>("skillManager");
    if (skillManager) {
      const installed = await skillManager.listSkills();
      if (Array.isArray(installed)) {
        this._cachedSkillNames = new Set(installed.map((s) => s.name));
        for (const s of installed) {
          skills.push({
            name: s.name,
            description: s.description || `Execute ${s.name} skill`,
            location: s.installPath || `skills/${s.name}/SKILL.md`,
          });
        }
      }
    }
    return buildCompactSkillsPrompt(skills);
  }

  getGreeting(): string | null {
    if (this.greeted) return null;
    this.greeted = true;

    return this.persona.introduction || [
      `您好${this.persona.masterTerm}！我是 ${this.persona.name}，${this.persona.title} 🧬`,
      ``,
      `很高兴为您服务！我可以帮您：`,
      ``,
      `✨ 日常对话与问答`,
      `🛠️ 运行 Skills 技能`,
      `🚀 编排复杂任务`,
      `🔬 自我学习与进化`,
      `📡 多平台消息对接`,
      ``,
      `有什么需要，随时吩咐我！`,
    ].join("\n");
  }

  hasBeenGreeted(): boolean {
    return this.greeted;
  }

  resetGreeting(): void {
    this.greeted = false;
  }

  clearChatHistory(sessionId?: string): void {
    if (sessionId) {
      this.conversationHistory.delete(sessionId);
      this.sequentialThinkingHistory.delete(sessionId);
      this.executionTraces.delete(sessionId);
      this.activePlans.delete(sessionId);
    } else {
      this.conversationHistory.clear();
      this.sequentialThinkingHistory.clear();
      this.executionTraces.clear();
      this.activePlans.clear();
    }
  }

  getChatHistory(sessionId: string): Array<{ role: string; content: string | null }> {
    const history = this.conversationHistory.get(sessionId) || [];
    return history.map((h) => ({ role: h.role, content: h.content }));
  }

  getRegisteredTools(): ToolDefinition[] {
    return Array.from(this.registeredTools.values()).map((t) => t.definition);
  }

  /** Backward-compatible static delegates for extracted text-processor functions */
  static stripWebNoise(input: string): string {
    return stripWebNoiseImpl(input);
  }

  static collapseNewlines(text: string): string {
    return collapseNewlinesImpl(text);
  }

  async generateBriefUnderstanding(userMessage: string): Promise<string> {
    const deps: BriefUnderstandingDeps = {
      providers: this.providers,
      persona: this.persona,
      recordProviderSuccess: (id: string) => this.recordProviderSuccess(id),
      recordProviderFailure: (id: string, error: string, errorType?: string) => this.recordProviderFailure(id, error, errorType ?? "UNKNOWN"),
    };
    return generateBriefUnderstandingFn(deps, userMessage);
  }

  async chat(
    message: string,
    context?: Record<string, unknown>,
    onProgress?: AgentProgressCallback
  ): Promise<{ reply: string; tokensUsed: number; contextTokens?: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean; files?: Array<{ path: string; size: number; downloadUrl: string }> }> {
    const startTime = Date.now();
    const sessionId = (context?.sessionId as string) || "default";
    const pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }> = [];
    const agentId = (context?.agentId as string) || "default";
    const channel = (context?.channel as string) || "web-ui";
    const peerId = (context?.peerId as string) || "user";

    // Resolve TracingService for OpenTelemetry span creation
    const observability = this.registry?.resolveService?.("observability") as any;
    const tracing = observability?.getTracingService?.();

    if (tracing?.isEnabled()) {
      return tracing.withSpan("agent.chat", async (span: Span) => {
        span.setAttribute("session.id", sessionId);
        span.setAttribute("message.length", message.length);
        span.setAttribute("channel", channel);
        return this.chatInner(message, context, onProgress, startTime, sessionId, pendingPermissions, agentId, channel, peerId, tracing, span);
      });
    } else {
      return this.chatInner(message, context, onProgress, startTime, sessionId, pendingPermissions, agentId, channel, peerId, null, null);
    }
  }

  /** Inner implementation of chat() — separated to allow tracing span wrapping */
  private async chatInner(
    message: string,
    context: Record<string, unknown> | undefined,
    onProgress: AgentProgressCallback | undefined,
    startTime: number,
    sessionId: string,
    pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>,
    agentId: string,
    channel: string,
    peerId: string,
    tracing: any,
    parentSpan: any,
  ): Promise<{ reply: string; tokensUsed: number; contextTokens?: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean; files?: Array<{ path: string; size: number; downloadUrl: string }> }> {

    // Mark session as active for heartbeat pausing
    this.markSessionActive(sessionId);

    try {
    // Record session start in EventLedger
    const ledger = this.getEventLedger();
    if (ledger) {
      ledger.append("session_start", { channel, peerId }, { agentId, sessionId });
    }

    // ── Input Pipeline: run through preprocessing stages ──
    // Inspired by OpenClaw's pipeline pattern. The pipeline handles:
    // 1. XSS sanitization
    // 2. System tag sanitization (prevent prompt injection)
    // 3. Length guard
    // 4. Echo detection (prevent self-reply loops)
    // 5. Attachment injection
    // 6. Guardrails input validation
    // 7. Plugin pre-process hooks
    let effectiveMessage = message;
    const attachments = context?.attachments as Array<{ name: string; type: string; size: number; data?: string | null }> | undefined;
    
    const inputPipeline = (this as any).inputPipeline as import("./input-pipeline").PipelineRunner | undefined;
    if (inputPipeline) {
      // Use the registered pipeline instance (OpenClaw-style pluggable design)
      // Pass session context via metadata for stages that need it (e.g., echo detection)
      const pipelineContext = {
        message,
        effectiveMessage: message,
        sessionId,
        channel,
        peerId,
        agentId,
        attachments,
        metadata: {
          conversationHistory: this.conversationHistory.get(sessionId) || [],
          guardrailsManager: this.guardrailsManager,
          pluginManager: this.pluginManager,
        },
        shortCircuit: false,
        warnings: [],
      };
      
      const result = await inputPipeline.run(pipelineContext);
      
      // Handle pipeline warnings
      if (result.warnings.length > 0) {
        process.stdout.write(`[AgentModelExecutor] Input pipeline warnings: ${result.warnings.join("; ")}`);
      }
      
      // Handle short-circuit (echo detection, guardrails block, etc.)
      if (result.shortCircuit && result.shortCircuitReply) {
        this.persistEarlyReturn(sessionId, message, result.shortCircuitReply);
        return { reply: result.shortCircuitReply, tokensUsed: 0, contextTokens: 0, duration: Date.now() - startTime, permissionRequests: [], toolsExecuted: false, files: [] };
      }
      
      effectiveMessage = result.effectiveMessage;
    } else {
      // Fallback: inline processing (original behavior)
      // ── Plugin hook: before_agent_start ──
      if (this.pluginManager?.hasHooks("before_agent_start")) {
        const pluginResult = tracing?.isEnabled()
          ? await tracing.withSpan("agent.plugin.before_start", async (s: Span) => {
              s.setAttribute("session.id", sessionId);
              return this.pluginManager!.runHooksMerged({
                type: "before_agent_start",
                context: { sessionId, agentId, channel, peerId },
                message,
                attachments: context?.attachments as Array<{ name: string; type: string; url?: string; data?: Buffer }> | undefined,
              });
            })
          : await this.pluginManager.runHooksMerged({
              type: "before_agent_start",
              context: { sessionId, agentId, channel, peerId },
              message,
              attachments: context?.attachments as Array<{ name: string; type: string; url?: string; data?: Buffer }> | undefined,
            });
        const { blocked, blockReason, merged } = pluginResult;
        if (blocked) {
          this.persistEarlyReturn(sessionId, message, blockReason ?? "Message blocked by plugin");
          return { reply: blockReason ?? "Message blocked by plugin", tokensUsed: 0, contextTokens: 0, duration: 0, permissionRequests: [], toolsExecuted: false, files: [] };
        }
        const mergedBA = merged as Partial<import("@evoclaw/core").BeforeAgentStartResult>;
        if (mergedBA.syntheticReply) {
          this.persistEarlyReturn(sessionId, message, mergedBA.syntheticReply);
          return { reply: mergedBA.syntheticReply, tokensUsed: 0, contextTokens: 0, duration: Date.now() - startTime, permissionRequests: [], toolsExecuted: false, files: [] };
        }
        if (mergedBA.message) effectiveMessage = mergedBA.message;
      }

      // ── Inject attachment content into the message ──
      if (attachments && attachments.length > 0) {
        const parts: string[] = [];
        parts.push("\n\n---\n📎 **用户上传了以下文件：**\n");
        for (const att of attachments) {
          const sizeStr = att.size > 1024 * 1024 
            ? `${(att.size / (1024 * 1024)).toFixed(1)}MB` 
            : att.size > 1024 
              ? `${(att.size / 1024).toFixed(1)}KB` 
              : `${att.size}B`;
          parts.push(`\n### 📄 ${att.name} (${sizeStr}, ${att.type})`);
          
          if (att.data) {
            if (att.type.startsWith("image/")) {
              // Image: attached as vision input — model can analyze it directly
              parts.push(`  - 类型: 图片 (${att.type})`);
              parts.push(`  - 上传为 vision 输入，请直接分析图片内容`);
            } else if (att.type.startsWith("text/") || att.type === "application/json") {
              // Text file: include content inline (truncated to 8000 chars)
              const maxLen = 8000;
              const content = att.data.length > maxLen 
                ? att.data.substring(0, maxLen) + `\n...(共 ${att.data.length} 字符，已截断)` 
                : att.data;
              parts.push(`\n\`\`\`\n${content}\n\`\`\``);
            } else {
              parts.push(`  - (二进制文件，内容不可直接读取)`);
            }
          } else {
            parts.push(`  - (文件数据不可直接读取)`);
          }
        }
        parts.push("\n---\n");
        
        // Prepend attachment context before user message so LLM knows about files
        const userMsgLine = effectiveMessage.trim() ? `\n\n📝 **用户消息**: ${effectiveMessage}` : "\n\n📝 **用户未附带文字说明**";
        effectiveMessage = parts.join("\n") + userMsgLine;
      }

      // ── Guardrails: input validation ──
      if (this.guardrailsManager) {
        const inputCheck = this.guardrailsManager.checkInput(effectiveMessage);
        if (!inputCheck.passed && inputCheck.severity === "high") {
          return { reply: `[安全拦截] ${inputCheck.reason}`, tokensUsed: 0, contextTokens: 0, duration: 0, permissionRequests: [], toolsExecuted: false, files: [] };
        }
        if (inputCheck.sanitizedInput) {
          effectiveMessage = inputCheck.sanitizedInput;
        }
      }
    }

    // ── Steer: check for real-time instructions ──
    let planContext = "";
    if (this.steerManager) {
      const steerMessage = this.steerManager.formatSteerMessage(sessionId);
      if (steerMessage) {
        planContext += "\n\n" + steerMessage;
      }
    }

    // ── Observability: start trace ──
    let currentTraceId: string | undefined;
    if (this.observability) {
      const trace = this.observability.startTrace(sessionId, { userId: sessionId.split("-")[0] || "unknown" });
      currentTraceId = trace.traceId;
      this._currentTraceId = currentTraceId;
    }

    // ── Session management ──
    const sessionLoadFn = async () => {
      let session = this.sessionManager?.loadSessionMeta(agentId, sessionId) ?? null;
      if (!session) {
        session = this.sessionManager?.createSession(agentId, { sessionId }) ?? null;
        if (session) {
          this.eventBus.publish("session.created", { agentId, sessionId }, "agent-model-executor");
        }
      }
      // If SessionManager is available, use its transcript for history
      if (this.sessionManager && sessionId) {
        const loadedHistory = this.sessionManager.loadTranscript(agentId, sessionId);
        if (loadedHistory.length > 0) {
          this.conversationHistory.set(sessionId, loadedHistory.filter(t => t.role === "user" || t.role === "assistant").map(t => {
            const entry: Record<string, unknown> = {
              role: t.role,
              content: t.content,
            };
            // Preserve tool_calls for assistant messages to maintain conversation context
            if (t.role === "assistant" && (t as any).tool_calls) {
              entry.tool_calls = (t as any).tool_calls;
            }
            return entry as any;
          }));
        }
      }
    };
    if (tracing?.isEnabled()) {
      await tracing.withSpan("agent.session.load", async (s: Span) => {
        s.setAttribute("session.id", sessionId);
        await sessionLoadFn();
      });
    } else {
      await sessionLoadFn();
    }

    // ── Persist user message immediately so it survives page refresh during streaming ──
    if (this.sessionManager && sessionId) {
      try {
        this.sessionManager.getOrCreateSession(agentId, sessionId);
        this.sessionManager.appendTurn(agentId, sessionId, {
          turnIndex: 0, role: "user", content: message, timestamp: new Date().toISOString(),
        });
      } catch (err) {
        process.stderr.write(`[AgentModelExecutor] Failed to persist user message early: ${err}`);
      }
    }
    this.persistSessionTurn(sessionId, "user", message);

    const emitProgress = (event: AgentProgressEvent) => {
      if (event.phase) {
        taskStatusTracker.set(sessionId, event.phase, event.detail, event.progress ?? 0);
      }
      onProgress?.(event);
    };

    // ── Task status: initial thinking phase ──
    taskStatusTracker.set(sessionId, "thinking", "正在分析您的请求...", 10);
    onProgress?.({ type: "status", phase: "thinking", detail: "正在分析您的请求...", progress: 10 });

    // ── Slash command dispatch: intercept /command before LLM ──
    const slashResult = await this.handleSlashCommand(message.trim(), sessionId, startTime);
    if (slashResult) {
      this.persistEarlyReturn(sessionId, message, slashResult.reply);
      return slashResult;
    }

    // ── Chat-based approval: if user says "同意/执行/yes/approve",
    //    auto-execute the pending rejected shell command ──
    //    This MUST run BEFORE SemanticQuickReply, which would otherwise
    //    classify "同意" as a mood/greeting and return a chat reply.
    const APPROVAL_PATTERNS = /^(同意|批准|允许|执行|确认|yes|approve|confirm|go ahead|do it|run it|ok|okay|好的|可以|没问题)[\s!.。！？?]*$/i;
    const isApprovalIntent = APPROVAL_PATTERNS.test(effectiveMessage.trim());
    const pendingCmd = this.pendingApprovalCommands.get(sessionId);
    if (isApprovalIntent && pendingCmd) {
      const PENDING_CMD_TTL = 30 * 60 * 1000;
      if (Date.now() - pendingCmd.rejectedAt > PENDING_CMD_TTL) {
        process.stdout.write(`[AgentModelExecutor] Pending command expired, discarding: ${pendingCmd.command}`);
        this.pendingApprovalCommands.delete(sessionId);
      } else {
        process.stdout.write(`[AgentModelExecutor] User approved pending command: ${pendingCmd.command}`);
        this.pendingApprovalCommands.delete(sessionId);
        // Add temporary trust rule
        if (this.humanApprovalManager) {
          this.humanApprovalManager.addTrustRule({
            toolName: "shell_exec",
            argPattern: { command: pendingCmd.command },
            trustedBy: "chat_approval",
            createdAt: Date.now(),
            expiresAt: Date.now() + 5 * 60 * 1000,
          });
        }
        // Execute the pending command directly
        try {
          const shellExecTool = this.registeredTools.get("shell_exec");
          if (shellExecTool) {
            const execResult = await shellExecTool.handler({ command: pendingCmd.command, timeout: "30" });
            const execStr = typeof execResult === "string" ? execResult : JSON.stringify(execResult);
            const execObj = typeof execResult === "object" ? execResult as Record<string, unknown> : null;
            let reply: string;
            if (execObj?.success !== false && execStr && execStr.length > 0) {
              // Try to format the output as a readable table
              reply = this.formatCommandOutput(execObj, execStr);
            } else {
              reply = `⚠️ 命令执行失败：${execStr.slice(0, 500)}`;
            }
            this.persistEarlyReturn(sessionId, message, reply);
            return { reply, tokensUsed: 0, contextTokens: 0, duration: Date.now() - startTime, permissionRequests: [], toolsExecuted: true, files: [] };
          }
        } catch (err) {
          process.stderr.write(`[AgentModelExecutor] Pending command execution failed: ${err}`);
          const reply = `❌ 命令执行出错：${err instanceof Error ? err.message : String(err)}`;
          this.persistEarlyReturn(sessionId, message, reply);
          return { reply, tokensUsed: 0, contextTokens: 0, duration: Date.now() - startTime, permissionRequests: [], toolsExecuted: false, files: [] };
        }
      }
    }

    // ── Astronomy quick reply (sunrise/sunset — local calculation via Open-Meteo) ──
    // Bypasses LLM content filters and avoids unreliable web search for
    // time-sensitive astronomical calculations.
    const astronomyReply = await tryAstronomyReplyFn(effectiveMessage);
    if (astronomyReply) {
      const timestamp = new Date().toLocaleString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
      const finalReply = `📅 ${timestamp}\n\n${astronomyReply}`;
      this.persistEarlyReturn(sessionId, message, finalReply);
      return { reply: finalReply, tokensUsed: 0, contextTokens: 0, duration: Date.now() - startTime, permissionRequests: [], toolsExecuted: false, files: [] };
    }

    // ── Utility quick reply (date/calculator — no LLM needed) ──
    const utilityReply = tryUtilityReplyFn(effectiveMessage);
    if (utilityReply) {
      const timestamp = new Date().toLocaleString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
      const finalReply = `📅 ${timestamp}\n\n${utilityReply}`;
      this.persistEarlyReturn(sessionId, message, finalReply);
      return { reply: finalReply, tokensUsed: 0, contextTokens: 0, duration: Date.now() - startTime, permissionRequests: [], toolsExecuted: false, files: [] };
    }

    // ── Quick reply for simple greetings and queries (no LLM needed) ──
    // Use the extended version which adds a capability block for hello/identity
    // categories, so first-time users get a useful self-introduction.
    const quickReply = (() => {
      const result = this.tryQuickReplyExtended(effectiveMessage);
      if (result && tracing?.isEnabled()) {
        parentSpan?.setAttribute("agent.quick_reply", true);
        parentSpan?.setAttribute("agent.quick_reply.length", result.length);
      }
      return result;
    })();
    if (quickReply) {
      const timestamp = new Date().toLocaleString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
      const finalReply = `📅 ${timestamp}\n\n${quickReply}`;
      this.persistEarlyReturn(sessionId, message, finalReply);
      return { reply: finalReply, tokensUsed: 0, contextTokens: 0, duration: Date.now() - startTime, permissionRequests: [], toolsExecuted: false, files: [] };
    }

    // ── Semantic quick reply (local Transformers embedding) ──
    // Catches paraphrased greetings / simple intents that the regex table
    // misses (e.g. "你今天有没有空帮我看看", "how are you doing today").
    // Best-effort: if the embedding provider is not ready, this is a no-op.
    const semanticReply = await this.semanticQuickReply.classify(effectiveMessage, this.persona);
    if (semanticReply) {
      const timestamp = new Date().toLocaleString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
      const finalReply = `📅 ${timestamp}\n\n${semanticReply}`;
      if (tracing?.isEnabled()) {
        parentSpan?.setAttribute("agent.semantic_quick_reply", true);
      }
      this.persistEarlyReturn(sessionId, message, finalReply);
      return { reply: finalReply, tokensUsed: 0, contextTokens: 0, duration: Date.now() - startTime, permissionRequests: [], toolsExecuted: false, files: [] };
    }

    // ── Skill install detection: handle skill installation requests early ──
    const skillManager = this.registry?.resolveService<{
      searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>;
      listSkills(): unknown[];
      executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown>;
    }>("skillManager");
    
    // installKeywords: detects "安装技能", "下载技能", "安装 weather", etc.
    const installKeywords = /(?:安装|下载|添加|配置|装)\s*(?:一下|一个)?\s*(?:技能|skill|skills?)/i;
    const installRequest = /(?:给我|帮我|需要|想要|如果).*?(?:安装|下载|添加|配置|装)\s*(?:一下|一个)?\s*.*?(?:技能|skill|skills?)/i;
    const installSpecificSkill = /(?:安装|下载|添加|配置|装)\s+([a-zA-Z][\w\-]{1,})/i;
    const batchInstall = /(?:全部|批量|一键|所有)\s*(?:安装|下载)/i;
    const findAndInstallSkill = /(?:找|查找|搜索|看看|查一下).*(?:技能|skill).*?(?:安装|下载|添加|装)/i;
    if (installKeywords.test(message) || installRequest.test(message) || installSpecificSkill.test(message) || batchInstall.test(message) || findAndInstallSkill.test(message)) {
      process.stdout.write(`[AgentModelExecutor] Skill install request detected: "${message}"`);
      const skillInstallerDeps: SkillInstallerDeps = { registry: this.registry, workspacePath: this.workspacePath };
      const installResult = await handleSkillInstallFn(skillInstallerDeps, message, skillManager, startTime, sessionId);
      if (installResult) {
        // Persist the skill install conversation turn
        this.persistEarlyReturn(sessionId, message, installResult.reply);
        return installResult;
      }
      // If handleSkillInstall returned null, fall through to LLM processing
    }

    // ── System config query: handle "查配置", "check config", "system info" etc. ──
    const configQueryResult = this.handleSystemConfigQuery(message, skillManager, startTime, sessionId);
    if (configQueryResult) {
      this.persistEarlyReturn(sessionId, message, configQueryResult.reply);
      return configQueryResult;
    }

    // ── Email account detection: detect email credentials in user input ──
    const emailAccountResult = await this.detectAndConfigureEmailAccount(message);
    if (emailAccountResult) {
      this.persistEarlyReturn(sessionId, message, emailAccountResult.reply);
      return emailAccountResult;
    }

    // ── Email inbox operations: handle email list/summarize/analyze requests ──
    const emailOperationResult = await this.handleEmailOperation(message);
    if (emailOperationResult) {
      this.persistEarlyReturn(sessionId, message, emailOperationResult.reply);
      return emailOperationResult;
    }

    // ── SkillDispatcher: try to auto-dispatch task via skill matching (before LLM) ──
    // Skip SkillDispatcher when user explicitly requests a claude-code-tools tool
    // Skip SkillDispatcher when user provides a URL — go directly to LLM for URL-based tasks
    const claudeCodeToolNames = ["execute_programming_task", "decompose_programming_task", "assess_coding_capability", "get_task_result"];
    const isExplicitToolCall = claudeCodeToolNames.some(name => message.includes(name));
    const userProvidedUrl = /https?:\/\/[^\s<>"']+/i.test(message);
    if (userProvidedUrl) {
      process.stdout.write(`[AgentModelExecutor] User provided URL detected — skipping SkillDispatcher, going directly to LLM`);
    }
    if (this.hasActionIntent(message) && !isExplicitToolCall && !userProvidedUrl) {
      const skillDispatchFn = async () => {
        try {
        const skillDispatcher = this.registry?.resolveService<{
          dispatch(ctx: { task: string; sessionId: string; allowAutoInstall?: boolean; fallbackToWebSearch?: boolean }): Promise<{
            success: boolean;
            path: string;
            skillName?: string;
            output?: unknown;
            reasoning: string;
            duration: number;
            error?: string;
          }>;
        }>("skillDispatcher");
        
        if (skillDispatcher) {
          process.stdout.write(`[AgentModelExecutor] SkillDispatcher: analyzing task "${message.slice(0, 60)}"`);
          taskStatusTracker.set(sessionId, "thinking", "技能调度中，正在匹配最合适的技能...", 20);
          const dispatchResult = await skillDispatcher.dispatch({
            task: message,
            sessionId,
            allowAutoInstall: true,
            fallbackToWebSearch: true,
          });

          // Use unified error handler
          const outputStr = sanitizeSkillOutput(dispatchResult.output);
          const classifiedError = classifySkillError(dispatchResult, outputStr);
          const outputHasError = !dispatchResult.success && classifiedError !== null;
          const isEmptyOutput = isEmptySkillOutput(dispatchResult.output);

          if (dispatchResult.path === "skill" && dispatchResult.success && !isEmptyOutput && !outputHasError) {
            process.stdout.write(`[AgentModelExecutor] SkillDispatcher handled via "${dispatchResult.skillName}": ${dispatchResult.output}`);
            const skillReply = formatSkillReply(dispatchResult, outputStr);
            this.persistEarlyReturn(sessionId, message, skillReply);
            return {
              reply: skillReply,
              tokensUsed: 0,
              duration: Date.now() - startTime,
              permissionRequests: [],
              toolsExecuted: true,
            };
          } else if (dispatchResult.path === "web_search" && dispatchResult.success && !isEmptyOutput && !outputHasError) {
            process.stdout.write(`[AgentModelExecutor] SkillDispatcher used web_search fallback`);
            const searchReply = formatSkillReply(dispatchResult, outputStr);
            this.persistEarlyReturn(sessionId, message, searchReply);
            return {
              reply: searchReply,
              tokensUsed: 0,
              duration: Date.now() - startTime,
              permissionRequests: [],
              toolsExecuted: true,
            };
          } else if (outputHasError) {
            if (classifiedError!.shouldFallbackToLLM) {
              process.stdout.write(`[AgentModelExecutor] SkillDispatcher: skill "${dispatchResult.skillName}" returned ${classifiedError!.category} error — falling through to LLM without showing error to user`);
              // Do not return an error to the user; let the LLM retry or handle the task.
            } else {
              process.stdout.write(`[AgentModelExecutor] SkillDispatcher: skill "${dispatchResult.skillName}" returned ${classifiedError!.category} error — returning error to user`);
              const errorReply = `⚠️ ${classifiedError!.userMessage}`;
              this.persistEarlyReturn(sessionId, message, errorReply);
              return {
                reply: errorReply,
                tokensUsed: 0,
                duration: Date.now() - startTime,
                permissionRequests: [],
                toolsExecuted: true,
              };
            }
          } else if (isEmptyOutput && dispatchResult.path === "skill") {
            process.stdout.write(`[AgentModelExecutor] SkillDispatcher: skill "${dispatchResult.skillName}" returned empty output — falling through to LLM`);
          } else if (dispatchResult.path === "none") {
            process.stdout.write(`[AgentModelExecutor] SkillDispatcher: no matching skill found — falling through to LLM`);
          } else {
            // Skill matched but execution failed — fall through to LLM
            process.stdout.write(`[AgentModelExecutor] SkillDispatcher: skill "${dispatchResult.skillName}" matched but execution failed (path=${dispatchResult.path}, success=${dispatchResult.success}) — falling through to LLM`);
          }
        }
      } catch (err) {
        process.stderr.write(`[AgentModelExecutor] SkillDispatcher dispatch failed: ${err}`);
        // Fall through to LLM
      }
      };
      if (tracing?.isEnabled()) {
        await tracing.withSpan("agent.skill.dispatch", async (s: Span) => {
          s.setAttribute("session.id", sessionId);
          s.setAttribute("message.length", message.length);
          await skillDispatchFn();
        });
      } else {
        await skillDispatchFn();
      }
    }

    const tasks = await this.analyzeUserIntent(effectiveMessage, sessionId);
    
    if (tasks.length > 1) {
      const multiResult = await this.handleMultipleTasks(tasks, sessionId, pendingPermissions, startTime, context?.attachments as Array<{ name: string; type: string; size: number; data?: string | null }> | undefined, onProgress, channel);
      multiResult.reply = AgentModelExecutor.collapseNewlines(multiResult.reply);
      this.persistEarlyReturn(sessionId, message, multiResult.reply);
      return multiResult;
    }

    // ── Auto-split mechanism for complex tasks ──
    const autoSplitConfig: AutoSplitConfig = {
      complexity: (context?.complexity as AutoSplitConfig["complexity"]) || "simple",
      shouldAutoSplit: (context?.shouldAutoSplit as boolean) || false,
      maxSubtasks: (context?.maxSubtasks as number) || 3,
    };

    if (autoSplitConfig.shouldAutoSplit && autoSplitConfig.complexity !== "simple") {
      process.stdout.write(`[AgentModelExecutor] Auto-split enabled for complexity "${autoSplitConfig.complexity}", maxSubtasks: ${autoSplitConfig.maxSubtasks}`);

      const existingCheckpoint = taskCheckpointManager.get(sessionId);
      if (existingCheckpoint && existingCheckpoint.completedCount < existingCheckpoint.totalSubtasks) {
        process.stdout.write(`[AgentModelExecutor] Resuming task from checkpoint: ${existingCheckpoint.completedCount}/${existingCheckpoint.totalSubtasks} completed`);
        taskStatusTracker.set(sessionId, "resuming", `从检查点恢复任务 (${existingCheckpoint.completedCount}/${existingCheckpoint.totalSubtasks})`, 50);
        onProgress?.({ type: "task_resumed", phase: "resuming", detail: `从检查点恢复任务，已完成 ${existingCheckpoint.completedCount}/${existingCheckpoint.totalSubtasks} 个子任务`, progress: 50 });

        const resumeResult = await this.executeSubtasksFromCheckpoint(existingCheckpoint, sessionId, pendingPermissions, startTime, context?.attachments as Array<{ name: string; type: string; size: number; data?: string | null }> | undefined, onProgress, channel);
        if (resumeResult) {
          taskCheckpointManager.delete(sessionId);
          this.persistEarlyReturn(sessionId, message, resumeResult.reply);
          return resumeResult;
        }
      }

      const subtaskDescriptions = await this.decomposeTaskWithLLM(effectiveMessage, autoSplitConfig.maxSubtasks);
      if (subtaskDescriptions.length > 1) {
        process.stdout.write(`[AgentModelExecutor] Task decomposed into ${subtaskDescriptions.length} subtasks:` + " " + subtaskDescriptions.map(s => s.description.slice(0, 40)));

        taskStatusTracker.set(sessionId, "splitting", `任务已拆分为 ${subtaskDescriptions.length} 个子任务`, 15);
        onProgress?.({ type: "status", phase: "splitting", detail: `任务已拆分为 ${subtaskDescriptions.length} 个子任务，开始逐个执行...`, progress: 15 });

        const checkpoint: TaskCheckpoint = {
          sessionId,
          originalMessage: effectiveMessage,
          subtasks: subtaskDescriptions.map((st, i) => ({
            id: `sub-${i + 1}`,
            description: st.description,
            status: "pending" as const,
          })),
          completedCount: 0,
          totalSubtasks: subtaskDescriptions.length,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        taskCheckpointManager.save(sessionId, checkpoint);

        onProgress?.({ type: "checkpoint_saved", phase: "splitting", detail: `检查点已保存，共 ${subtaskDescriptions.length} 个子任务`, progress: 20 });

        const splitResult = await this.executeSubtasksFromCheckpoint(checkpoint, sessionId, pendingPermissions, startTime, context?.attachments as Array<{ name: string; type: string; size: number; data?: string | null }> | undefined, onProgress, channel);
        if (splitResult) {
          taskCheckpointManager.delete(sessionId);
          this.persistEarlyReturn(sessionId, message, splitResult.reply);
          return splitResult;
        }
      }
    }

    // Recall relevant past memories for contextual awareness
    let memoryContext = "";
    if (this.memoryHub) {
      const memorySearchFn = async () => {
        try {
          const longTerm = this.memoryHub!.getLongTerm();
          const memories = await longTerm.search({
            query: message,
            type: "system",
            limit: 3,
          });
          if (memories.length > 0) {
            memoryContext = "\n[相关历史记忆]\n" + memories.map((m, i) =>
              `  ${i + 1}. ${m.entry.content.slice(0, 300)}`
            ).join("\n") + "\n";
          }
        } catch (err) {
          // Silent fallback - memory is optional
        }
      };
      if (tracing?.isEnabled()) {
        await tracing.withSpan("agent.memory.search", async (s: Span) => {
          s.setAttribute("session.id", sessionId);
          await memorySearchFn();
        });
      } else {
        await memorySearchFn();
      }
    }

    const systemPrompt = this.buildSystemPrompt(undefined, { channel }) + memoryContext;

    // ── ContextEngine: use layered context assembly when available ──
    // This replaces the manual message assembly with ContextEngine.assembleContext()
    // which provides frozen/ephemeral prompt separation, bootstrap file loading,
    // token-aware context truncation, and cache control annotations.
    let contextEngineResult: import("./context-engine").LayeredContextResult | null = null;
    if (this.contextEngine) {
      try {
        const skillsPrompt = await this.buildSkillsPromptForRun();
        const history = this.conversationHistory.get(sessionId) || [];
        contextEngineResult = this.contextEngine.assembleContext({
          conversationHistory: history,
          systemPrompt,
          skillsContext: skillsPrompt || undefined,
          memoryContext: memoryContext || undefined,
          compactionSummary: undefined, // handled by compactionManager separately
          pluginPrependContext: undefined,
          pluginAppendContext: undefined,
          currentTask: effectiveMessage,
        });
        if (contextEngineResult.warnings.length > 0) {
          process.stdout.write(`[AgentModelExecutor] ContextEngine warnings: ${contextEngineResult.warnings.join("; ")}`);
        }
        if (contextEngineResult.truncated) {
          process.stdout.write(`[AgentModelExecutor] ContextEngine truncated history for session "${sessionId}"`);
        }
        process.stdout.write(`[AgentModelExecutor] ContextEngine assembled context: ${contextEngineResult.tokenEstimate} tokens, frozen hash=${contextEngineResult.frozenHash?.slice(0, 12)}...`);
        // Store for use by tryCallLLM
        this._currentContextEngineResult = contextEngineResult;
      } catch (err) {
        process.stderr.write(`[AgentModelExecutor] ContextEngine assembly failed, falling back to manual assembly:` + " " + (err instanceof Error ? err.message : String(err)) + "\n");
        contextEngineResult = null;
      }
    }

    // ── Stale Context: warn about expired tool results ──
    if (this.staleContextManager) {
      const staleWarnings = this.staleContextManager.generateStaleWarnings(sessionId);
      if (staleWarnings.length > 0) {
        planContext += "\n\n" + staleWarnings.join("\n");
      }
    }

    // ── Prompt Cache: check for cached prefix ──
    let cacheEntry: import("./prompt-cache").CacheEntry | null = null;
    let cacheMessages: Array<{role: string; content: string}> = [];
    if (this.promptCache) {
      const historyEntries = (this.conversationHistory.get(sessionId) || []).map(h => ({ role: h.role, content: h.content || "" }));
      cacheMessages = [{ role: "system", content: systemPrompt }, ...historyEntries];
      cacheEntry = this.promptCache.findMatchingPrefix(cacheMessages);
      if (cacheEntry) {
        process.stdout.write(`[AgentModelExecutor] Prompt cache hit: saved ~${cacheEntry.tokenCount} tokens`);
      }
    }

    // ── Prompt Cache: write prefix to cache for future reuse ──
    if (this.promptCache && !cacheEntry && cacheMessages.length > 0) {
      const estimatedTokens = this.promptCache.estimateTokenCount(
        cacheMessages.map(m => m.content || "").join("")
      );
      this.promptCache.cachePrefix(cacheMessages, estimatedTokens);
    }

    const installedSkills = await skillManager?.listSkills() || [];

    // ── ToolChain: check if a predefined tool chain matches this request ──
    let chainContext = "";
    if (this.toolChainRegistry) {
      const matchedChain = this.toolChainRegistry.findRelevantChain(effectiveMessage);
      if (matchedChain) {
        chainContext = `[工具链匹配] 检测到任务可使用预定义工具链 "${matchedChain.name}" (${matchedChain.description})，包含 ${matchedChain.steps.length} 个步骤。建议按此链执行。`;
        process.stdout.write(`[AgentModelExecutor] ToolChain matched: ${matchedChain.name} for session "${sessionId}"`);
        onProgress?.({ type: "status", phase: "planning", detail: `匹配到工具链: ${matchedChain.name}`, progress: 20 });
      }
    }

    // ── Planning: generate explicit execution plan for complex tasks ──
    if (this.planningEngine && this.hasActionIntent(effectiveMessage)) {
      const toolNames = Array.from(this.registeredTools.keys());
      try {
        const plan = await this.planningEngine.generatePlan(effectiveMessage, toolNames, sessionId);
        const validation = this.planningEngine.validatePlan(plan);
        if (validation.valid) {
          plan.status = "validated";
          this.activePlans.set(sessionId, plan);
          planContext = this.planningEngine.formatPlanForContext(plan);
          process.stdout.write(`[AgentModelExecutor] Plan generated for session "${sessionId}": ${plan.steps.length} steps, complexity=${validation.complexity}`);
          taskStatusTracker.set(sessionId, "planning", `已生成执行计划：${plan.steps.length} 个步骤`, 25);
          onProgress?.({ type: "status", phase: "planning", detail: `已生成执行计划：${plan.steps.length} 个步骤`, progress: 25 });

          // ── For complex plans (5+ steps), offer DAG execution context ──
          if (plan.steps.length >= 5) {
            try {
              // Inline DAG conversion: each PlanStep becomes a DAGNode
              const dagNodes = plan.steps.map((step) => ({
                id: step.id,
                action: step.description,
                skill: step.toolHint,
                dependencies: step.dependsOn ?? [],
                params: {},
                timeout: 30000,
              }));
              planContext += `\n\n[DAG任务图] 该计划已转换为DAG任务图，共 ${dagNodes.length} 个节点，支持并行执行无依赖步骤。`;
            } catch { /* dag conversion failed */ }
          }

          // ── Swarm delegation: delegate to specialized agent if plan has clear tool group ──
          if (this.swarmOrchestrator) {
            const delegatedContext = await this.trySwarmDelegation(plan, effectiveMessage, sessionId);
            if (delegatedContext) {
              planContext += "\n\n" + delegatedContext;
            }

            // ── ACP Delegation: try external agent delegation if swarm didn't handle it ──
            if (this.acpHandler && !delegatedContext) {
              try {
                const acpAgent = this.acpHandler.findBestDelegate(effectiveMessage);
                if (acpAgent) {
                  const acpResult = await this.acpHandler.delegate({
                    fromAgent: "evoclaw-main",
                    toAgent: acpAgent.id,
                    task: effectiveMessage,
                    priority: "normal",
                    timeoutMs: 60000,
                  });
                  if (acpResult.success && acpResult.result) {
                    planContext += `\n\n[ACP委派] 任务已委派给 ${acpAgent.name}。${JSON.stringify(acpResult.result)}`;
                  }
                }
              } catch (err) {
                process.stderr.write(`[AgentModelExecutor] ACP delegation failed: ${err}`);
              }
            }
          }
        } else {
          process.stderr.write(`[AgentModelExecutor] Plan validation failed: ${validation.issues.join("; ")}`);
        }
      } catch (err) {
        process.stderr.write(`[AgentModelExecutor] Planning failed: ${err}`);
      }
    }

    const enhancedSystemPrompt = systemPrompt + (planContext ? "\n\n[执行计划]\n" + planContext : "") + (chainContext ? "\n\n" + chainContext : "");

    // ── Structured Output: inject schema instruction if applicable ──
    if (this.structuredOutputParser && this.schemaRegistry) {
      const structuredHint = effectiveMessage.match(/(?:格式|format|json|structured|schema|表格|table)/i);
      if (structuredHint) {
        const schema = this.schemaRegistry.get("task-result");
        if (schema) {
          const schemaInstruction = this.structuredOutputParser.formatSchemaForPrompt(schema);
          planContext += "\n\n" + schemaInstruction;
        }
      }
    }

    // ── Semantic intent detection + real-time search pre-processing ──
    const searchDeps: SearchPreprocessorDeps = {
      registry: this.registry!,
      registeredTools: this.registeredTools,
      stripWebNoiseFn: AgentModelExecutor.stripWebNoise,
    };
    let newsContext: string;
    let searchReason: string;
    let shouldSearch: boolean;
    if (tracing?.isEnabled()) {
      ({ newsContext, searchReason, shouldSearch } = await tracing.withSpan("agent.search.preprocess", async (s: Span) => {
        s.setAttribute("session.id", sessionId);
        s.setAttribute("message.length", message.length);
        return preprocessSearchFn(searchDeps, message, onProgress);
      }));
    } else {
      ({ newsContext, searchReason, shouldSearch } = await preprocessSearchFn(searchDeps, message, onProgress));
    }

    // ── Build enhanced message with search context and task-type hints ──
    const finalEnhancedMessage = buildEnhancedMessageFn(message, newsContext, searchReason, shouldSearch);

    if (newsContext) {
      process.stdout.write(`[AgentModelExecutor] News context added: ${newsContext.length} chars for session "${sessionId}"`);
    }

    const enabledProviders = this.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);
    process.stdout.write(`[AgentModelExecutor] Session "${sessionId}": ${enabledProviders.length} enabled providers, message length: ${finalEnhancedMessage.length} chars, history turns: ${(this.conversationHistory.get(sessionId) || []).length}`);

    // ── CopilotRouter: route simple tasks to cheaper models ──
    // Inspired by Hermes's stable/ephemeral prompt separation and OpenClaw's
    // model routing. When a simple task is detected, downgrade to a cheaper
    // model to save costs while preserving quality for complex tasks.
    let routedProviders = enabledProviders;
    let routingDecision: RoutingDecision | null = null;

    if (this.copilotRouter && enabledProviders.length > 0) {
      const primaryProvider = enabledProviders[0];
      routingDecision = this.copilotRouter.route(
        effectiveMessage,
        primaryProvider.model,
        primaryProvider.provider || "openai",
      );
      if (routingDecision.shouldDowngrade) {
        process.stdout.write(`[AgentModelExecutor] CopilotRouter: downgrading from ${routingDecision.originalModel} to ${routingDecision.routedModel} (${routingDecision.reason})`);
        // Create a modified provider list with the routed model
        routedProviders = enabledProviders.map((p, i) => {
          if (i === 0) {
            return {
              ...p,
              model: routingDecision!.routedModel,
              provider: routingDecision!.routedProvider,
              _originalModel: p.model,
              _originalProvider: p.provider,
            } as ProviderConfig;
          }
          return p;
        });
      } else {
        process.stdout.write(`[AgentModelExecutor] CopilotRouter: no downgrade (${routingDecision.reason})`);
      }
    }

    // ── IterationBudget: reset for new turn ──
    // Each user turn gets a fresh iteration budget. The budget is consumed
    // by tool calls in the LLM loop and supports Grace Call when exhausted.
    this.resetIterationBudget(sessionId);

    if (routedProviders.length > 0) {
      const primaryProvider = routedProviders[0];
      taskStatusTracker.set(sessionId, "thinking", `正在调用 ${primaryProvider.name} (${primaryProvider.model})...`, 30);
      const result = await this.tryCallLLM(finalEnhancedMessage, enhancedSystemPrompt, installedSkills, routedProviders, startTime, sessionId, pendingPermissions, context?.attachments as Array<{ name: string; type: string; size: number; data?: string | null }> | undefined, onProgress, !!newsContext, channel);
      if (result) {
        taskStatusTracker.set(sessionId, "done", "响应完成", 100);
        onProgress?.({ type: "final", phase: "done", detail: "响应完成", progress: 100, reply: result.reply, tokensUsed: result.tokensUsed, duration: result.duration });
        const timestamp = new Date().toLocaleString("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
        const reply = `📅 ${timestamp}\n\n${AgentModelExecutor.collapseNewlines(result.reply)}`;
        // Save the interaction to long-term memory (and mirror into the
        // vector store when the memory hub exposes remember()).
        this.rememberInteraction(message.slice(0, 200), reply.slice(0, 200), sessionId);

        // ── Guardrails: output validation ──
        let guardrailedReply = reply;
        if (this.guardrailsManager && guardrailedReply) {
          const outputCheck = this.guardrailsManager.checkOutput(guardrailedReply);
          if (!outputCheck.passed && outputCheck.severity === "high") {
            guardrailedReply = `[输出安全过滤] ${outputCheck.reason}`;
          } else if (outputCheck.sanitizedOutput) {
            guardrailedReply = outputCheck.sanitizedOutput;
          }
        }

        // ── Structured Output: parse if schema is requested ──
        if (this.structuredOutputParser && this.schemaRegistry) {
          // Check if the conversation hints at structured output need
          const structuredHint = effectiveMessage.match(/(?:格式|format|json|structured|schema|表格|table)/i);
          if (structuredHint) {
            const schema = this.schemaRegistry.get("task-result");
            if (schema && guardrailedReply) {
              const parsed = this.structuredOutputParser.parse(guardrailedReply, schema);
              if (parsed.success && parsed.data) {
                guardrailedReply = JSON.stringify(parsed.data, null, 2);
              }
            }
          }
        }

        // ── Observability: end trace ──
        if (this.observability && currentTraceId) {
          this.observability.endTrace(currentTraceId);
        }

        if (pendingPermissions.length > 0) {
          return { reply: guardrailedReply, tokensUsed: result.tokensUsed, contextTokens: result.contextTokens, duration: result.duration, permissionRequests: [...pendingPermissions], toolsExecuted: result.toolsExecuted, files: result.files };
        }
        return { reply: guardrailedReply, tokensUsed: result.tokensUsed, contextTokens: result.contextTokens, duration: result.duration, permissionRequests: [], toolsExecuted: result.toolsExecuted, files: result.files };
      }
    }

    // LLM unavailable: try skill-based execution for actionable tasks
    taskStatusTracker.set(sessionId, "error", "模型服务暂不可用，切换到本地规则响应", 60);
    const msg = message.toLowerCase();
    if (this.hasActionIntent(message)) {
      process.stdout.write(`[AgentModelExecutor] LLM unavailable, trying skill-based execution for: "${message.slice(0, 80)}"`);
    }
    let reply = AgentModelExecutor.collapseNewlines(await this.generateChatResponse(message, msg, installedSkills, skillManager, pendingPermissions));
    const tokensUsed = this.estimateTokenCount(systemPrompt + message + reply);
    
    // Add timestamp prefix to the reply
    const timestamp = new Date().toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    reply = `📅 ${timestamp}\n\n${reply}`;
    
    // Save important interaction to long-term memory
    this.rememberInteraction(message.slice(0, 200), reply.slice(0, 200), sessionId);

    // ── Guardrails: output validation ──
    if (this.guardrailsManager && reply) {
      const outputCheck = this.guardrailsManager.checkOutput(reply);
      if (!outputCheck.passed && outputCheck.severity === "high") {
        reply = `[输出安全过滤] ${outputCheck.reason}`;
      } else if (outputCheck.sanitizedOutput) {
        reply = outputCheck.sanitizedOutput;
      }
    }

    // ── Observability: end trace ──
    if (this.observability && currentTraceId) {
      this.observability.endTrace(currentTraceId);
    }

    // ── Plugin hook: agent_end ──
    const finalResult = { reply, tokensUsed, duration: Date.now() - startTime, permissionRequests: [...pendingPermissions], toolsExecuted: false };
    if (tracing?.isEnabled()) {
      await tracing.withSpan("agent.plugin.end", async (s: Span) => {
        s.setAttribute("session.id", sessionId);
        s.setAttribute("tokens.used", tokensUsed);
        this.runAgentEndHook(sessionId, agentId, channel, finalResult);
      });
    } else {
      this.runAgentEndHook(sessionId, agentId, channel, finalResult);
    }

    return finalResult;
    } finally {
      // Mark session as idle so heartbeat can resume
      this.markSessionIdle(sessionId);
      this._currentTraceId = undefined;
      // 清除会话级上下文引擎结果，避免跨会话泄漏
      this._currentContextEngineResult = null;
    }
  }

  /** Run the agent_end plugin hook asynchronously (fire and forget) */
  private runAgentEndHook(
    sessionId: string,
    agentId: string,
    channel: string,
    result: { reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }> },
  ): void {
    if (!this.pluginManager?.hasHooks("agent_end")) return;
    this.pluginManager.runHooks({
      type: "agent_end",
      context: { sessionId, agentId, channel },
      messages: [{ role: "assistant", content: result.reply }],
      metadata: {
        tokensUsed: result.tokensUsed,
        duration: result.duration,
        toolCalls: 0,
        success: true,
      },
    }).catch(err => process.stderr.write(`[AgentModelExecutor] agent_end hook failed: ${err}`));
  }

  /** Asynchronously save an interaction to long-term memory */
  private rememberInteraction(userMsg: string, agentReply: string, sessionId: string): void {
    if (!this.memoryHub) {
      process.stderr.write(`[AgentModelExecutor] rememberInteraction: memoryHub is null`);
      return;
    }
    try {
      const content = `User: ${userMsg}\nAgent: ${agentReply}`;
      const entry: Omit<import("@evoclaw/core").MemoryEntry, "id" | "createdAt" | "accessedAt"> = {
        content,
        type: "conversation",
        metadata: {
          source: "chat",
          sessionId,
          userId: "default",
          tags: ["chat"],
          importance: 0.4,
          associations: [],
          entities: [],
        },
        ttl: 7 * 24 * 3600 * 1000, // 7 days
        embedding: null,
      };
      const useRemember = !!this.memoryHub.remember;
      process.stdout.write(`[AgentModelExecutor] rememberInteraction: session=${sessionId} useRemember=${useRemember}`);
      // Prefer memory hub's remember() so the entry is mirrored into the
      // vector store (Transformers embeddings). Fallback to longTerm.store
      // when remember() is not provided by the injected hub.
      const persist = this.memoryHub.remember
        ? this.memoryHub.remember(entry)
        : this.memoryHub.getLongTerm().store({
            ...entry,
            id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date(),
            accessedAt: new Date(),
          } as import("@evoclaw/core").MemoryEntry);
      persist.then((stored) => {
        process.stdout.write(`[AgentModelExecutor] Memory saved: id=${stored.id} session=${sessionId}`);
      }, (err) => {
        process.stderr.write(`[AgentModelExecutor] Memory save failed: ${err}`);
      });
    } catch (err) {
      process.stderr.write(`[AgentModelExecutor] rememberInteraction threw: ${err}`);
    }
  }

  private getTaskAnalyzerDeps(): TaskAnalyzerDeps {
    return {
      providers: this.providers,
      config: this.config,
      persona: this.persona,
      conversationHistory: this.conversationHistory,
      callLLMOnce: this.callLLMOnce.bind(this),
      tryCallLLM: this.tryCallLLM.bind(this),
      buildSystemPrompt: this.buildSystemPrompt.bind(this),
      generateChatResponse: this.generateChatResponse.bind(this),
      estimateTokenCount: this.estimateTokenCount.bind(this),
      resolveService: <T>(name: string) => this.registry?.resolveService<T>(name) as T | undefined,
    };
  }

  /**
   * LLM-driven task understanding: delegates to task-analyzer module.
   */
  private async analyzeUserIntent(message: string, sessionId: string): Promise<string[]> {
    return analyzeUserIntentFn(this.getTaskAnalyzerDeps(), message, sessionId);
  }

  /**
   * LLM-driven task decomposition: delegates to task-analyzer module.
   */
  private async decomposeTaskWithLLM(message: string, maxSubtasks: number): Promise<Array<{ id: string; description: string }>> {
    return decomposeTaskWithLLMFn(this.getTaskAnalyzerDeps(), message, maxSubtasks);
  }

  private parseMultipleTasks(message: string): string[] {
    return parseMultipleTasksFn(message);
  }

  private async handleMultipleTasks(
    tasks: string[],
    sessionId: string,
    pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>,
    startTime: number,
    attachments?: Array<{ name: string; type: string; size: number; data?: string | null }>,
    onProgress?: AgentProgressCallback,
    channel?: string
  ): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean }> {
    return handleMultipleTasksFn(this.getTaskAnalyzerDeps(), tasks, sessionId, pendingPermissions, startTime, attachments, onProgress, channel);
  }

  private decomposeTaskForAutoSplit(message: string, maxSubtasks: number): Array<{ id: string; description: string }> {
    return decomposeTaskForAutoSplitFn(message, maxSubtasks);
  }

  private async executeSubtasksFromCheckpoint(
    checkpoint: TaskCheckpoint,
    sessionId: string,
    pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>,
    startTime: number,
    attachments: Array<{ name: string; type: string; size: number; data?: string | null }> | undefined,
    onProgress?: AgentProgressCallback,
    channel?: string
  ): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean; files?: Array<{ path: string; size: number; downloadUrl: string }> } | null> {
    return executeSubtasksFromCheckpointFn(this.getTaskAnalyzerDeps(), checkpoint, sessionId, pendingPermissions, startTime, attachments, onProgress, channel);
  }

  // ── Slash Command Handler: intercept /command before LLM ──
  private async handleSlashCommand(
    message: string,
    sessionId: string,
    startTime: number,
  ): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean; files?: Array<{ path: string; size: number; downloadUrl: string }> } | null> {
    const deps: SlashCommandDeps = {
      persona: this.persona,
      providers: this.providers,
      config: this.config,
      registeredTools: this.registeredTools,
      conversationHistory: this.conversationHistory,
      sequentialThinkingHistory: this.sequentialThinkingHistory,
      workspacePath: this.workspacePath,
      thinkingLevel: this.thinkingLevel,
      autoCompactionEnabled: this.autoCompactionEnabled,
      registry: this.registry,
      memoryHub: this.memoryHub,
      compactionManager: this.compactionManager,
      sessionManager: this.sessionManager,
      executionCheckpointStore: this.executionCheckpointStore,
      humanApprovalManager: this.humanApprovalManager ?? undefined,
      evalRunner: this.evalRunner ?? undefined,
    };
    const result = await handleSlashCommandFn(deps, message, sessionId, startTime);
    if (!result) return null;
    // Apply side-effect: update thinking level if changed
    if (result.thinkingLevel) {
      this.thinkingLevel = result.thinkingLevel;
    }
    return {
      reply: result.reply,
      tokensUsed: result.tokensUsed,
      duration: result.duration,
      permissionRequests: result.permissionRequests,
      toolsExecuted: result.toolsExecuted,
      files: result.files,
    };
  }

  // ── Format command output into readable text ──
  private formatNum(v: unknown, digits = 2): string {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return n.toFixed(digits);
  }

  private fmtMoney(v: unknown): string {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
    if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
    return n.toFixed(2);
  }

  private formatCommandOutput(execObj: Record<string, unknown> | null, execStr: string): string {
    // Try to parse the output field if it contains JSON
    let outputData: unknown = null;
    const rawOutput = String(execObj?.output || execStr);

    try {
      outputData = JSON.parse(rawOutput);
    } catch {
      // Not JSON, return as-is
      return `✅ 已执行您批准的命令，结果如下：\n\`\`\`\n${rawOutput.slice(0, 4000)}\n\`\`\``;
    }

    // Check if it's a market ranking result (has items array with stock data)
    if (this.isMarketRankingData(outputData)) {
      return this.formatMarketRanking(outputData as Record<string, unknown>);
    }

    // Check if it's a news/hot topics result
    if (this.isNewsData(outputData)) {
      return this.formatNewsData(outputData as Record<string, unknown>);
    }

    // Check if it's financial indicator data
    if (this.isFinanceData(outputData)) {
      return this.formatFinanceData(outputData as Record<string, unknown>);
    }

    // Check if it's an array of items
    if (Array.isArray(outputData)) {
      return this.formatArrayData(outputData);
    }

    // Generic JSON formatting: pretty print with key highlights
    try {
      const pretty = JSON.stringify(outputData, null, 2);
      return `✅ 已执行您批准的命令，结果如下：\n\`\`\`json\n${pretty.slice(0, 4000)}\n\`\`\``;
    } catch {
      return `✅ 已执行您批准的命令，结果如下：\n\`\`\`\n${rawOutput.slice(0, 4000)}\n\`\`\``;
    }
  }

  private isFinanceData(data: unknown): boolean {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const d = data as Record<string, unknown>;
    if (!Array.isArray(d.items) || d.items.length === 0) return false;
    const first = d.items[0];
    if (!first || typeof first !== "object") return false;
    const f = first as Record<string, unknown>;
    return "rq" in f && ("yysr" in f || "jlr" in f || "xsmll" in f || "jzzsyl" in f || "kfjlr" in f);
  }

  private formatFinanceData(data: Record<string, unknown>): string {
    const items = (data.items as Array<Record<string, unknown>>) || [];
    const statementName = String(data.statement_name || "财务数据");
    const code = String(data.code || "");
    const colMap: Array<{ key: string; label: string; fmt?: (v: unknown) => string }> = [
      { key: "rq", label: "报告期" },
      { key: "yysr", label: "营业收入", fmt: (v) => this.fmtMoney(v) },
      { key: "lrze", label: "利润总额", fmt: (v) => this.fmtMoney(v) },
      { key: "kfjlr", label: "扣非净利润", fmt: (v) => this.fmtMoney(v) },
      { key: "mgsy", label: "每股收益", fmt: (v) => `${this.formatNum(v, 2)}元` },
      { key: "xsmll", label: "毛利率", fmt: (v) => `${this.formatNum(v, 2)}%` },
      { key: "xsjll", label: "净利率", fmt: (v) => `${this.formatNum(v, 2)}%` },
      { key: "jzzsyl", label: "ROE", fmt: (v) => `${this.formatNum(v, 2)}%` },
      { key: "zcfzl", label: "资产负债率", fmt: (v) => `${this.formatNum(v, 2)}%` },
    ];
    const activeCols = colMap.filter((c) => items.some((it) => it[c.key] !== undefined && it[c.key] !== ""));
    let result = `📊 **${code} ${statementName}**（最近 ${items.length} 期）\n\n`;
    result += `| ${activeCols.map((c) => c.label).join(" | ")} |\n`;
    result += `|${activeCols.map(() => "---").join("|")}|\n`;
    for (const item of items) {
      const row = activeCols.map((c) => {
        const v = item[c.key];
        if (v === undefined || v === "") return "—";
        return c.fmt ? c.fmt(v) : String(v);
      });
      result += `| ${row.join(" | ")} |\n`;
    }
    return result;
  }

  private isMarketRankingData(data: unknown): boolean {
    if (!data || typeof data !== "object") return false;
    const d = data as Record<string, unknown>;
    return Array.isArray(d.items) && d.items.length > 0 &&
      typeof d.items[0] === "object" && d.items[0] !== null &&
      ("code" in (d.items[0] as object)) && ("name" in (d.items[0] as object));
  }

  private isNewsData(data: unknown): boolean {
    if (!data || typeof data !== "object") return false;
    const d = data as Record<string, unknown>;
    // Direct items array
    if (Array.isArray(d.items) && d.items.length > 0 &&
      typeof d.items[0] === "object" && d.items[0] !== null &&
      ("title" in (d.items[0] as object))) return true;
    // CICC hot-news: data.rsp.content_list
    if (d.data && typeof d.data === "object") {
      const rsp = (d.data as Record<string, unknown>).rsp as Record<string, unknown> | undefined;
      if (rsp && Array.isArray(rsp.content_list) && rsp.content_list.length > 0 &&
        typeof rsp.content_list[0] === "object" &&
        ("title" in (rsp.content_list[0] as object))) return true;
    }
    return false;
  }

  private formatMarketRanking(data: Record<string, unknown>): string {
    const items = (data.items as Array<Record<string, unknown>>) || [];
    const sortName = String(data.sort_name || "排行");
    const total = data.total || items.length;

    let result = `📊 **A股${sortName}**（共 ${total} 只，显示前 ${items.length} 只）\n\n`;
    result += "| # | 代码 | 名称 | 现价 | 昨收 | 涨跌幅 | 成交额 |\n";
    result += "|---|------|------|------|------|--------|--------|\n";

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const prevClose = Number(item.previous_close || 0);
      const currentPrice = Number(item.current_price || 0);
      const changePercent = prevClose > 0 ? ((currentPrice - prevClose) / prevClose * 100) : 0;
      const amount = Number(item.amount || 0);
      const amountStr = amount >= 1e8 ? `${(amount / 1e8).toFixed(2)}亿` : amount >= 1e4 ? `${(amount / 1e4).toFixed(0)}万` : String(amount);
      // A股惯例：红涨绿跌
      const changeText = changePercent >= 0 ? `+${changePercent.toFixed(2)}%` : `${changePercent.toFixed(2)}%`;
      const changeColor = changePercent >= 0 ? "#e74c3c" : "#2ecc71";
      const changeStr = `<span style="color:${changeColor};font-weight:600;">${changeText}</span>`;
      const priceColor = currentPrice >= prevClose ? "#e74c3c" : currentPrice < prevClose ? "#2ecc71" : "inherit";
      const priceStr = `<span style="color:${priceColor};">${currentPrice.toFixed(2)}</span>`;

      result += `| ${i + 1} | ${String(item.code || "")} | ${String(item.name || "")} | ${priceStr} | ${prevClose.toFixed(2)} | ${changeStr} | ${amountStr} |\n`;
    }

    return result;
  }

  private formatNewsData(data: Record<string, unknown>): string {
    // CICC hot-news response wraps content under data.rsp.content_list
    let items: Array<Record<string, unknown>> = [];
    let specName = "";
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.items)) {
      items = d.items as Array<Record<string, unknown>>;
    } else if (d.data && typeof d.data === "object") {
      const inner = (d.data as Record<string, unknown>).rsp as Record<string, unknown> | undefined;
      if (inner && Array.isArray(inner.content_list)) {
        items = inner.content_list as Array<Record<string, unknown>>;
        specName = String(inner.spec_subject_name || "");
      } else if (Array.isArray((d.data as Record<string, unknown>).content_list)) {
        items = (d.data as Record<string, unknown>).content_list as Array<Record<string, unknown>>;
      }
    }

    if (items.length === 0) return "✅ 已执行您批准的命令，资讯接口未返回可用数据。";

    const total = String(data.page_size || items.length);
    let result = `📰 **${specName || "资讯热榜"}**（共 ${total} 条，显示前 ${items.length} 条）\n\n`;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const title = String(item.title || "无标题");
      const link = String(item.redirect_url || item.out_detail_url || item.detail_url || "");
      result += `${i + 1}. **${title}**${link ? ` ([详情](${link}))` : ""}\n`;
      const meta: string[] = [];
      if (item.source) meta.push(`来源：${String(item.source)}`);
      if (item.pub_time) meta.push(`时间：${String(item.pub_time)}`);
      if (Array.isArray(item.stock_info) && (item.stock_info as unknown[]).length > 0) {
        const stocks = (item.stock_info as Array<Record<string, unknown>>)
          .map((s) => s.stock_name || s.stock_code)
          .filter(Boolean)
          .slice(0, 3)
          .join(", ");
        if (stocks) meta.push(`相关：${stocks}`);
      }
      if (meta.length > 0) result += `   ${meta.join(" | ")}\n`;
    }

    return result;
  }

  private formatArrayData(data: unknown[]): string {
    if (data.length === 0) return "✅ 命令执行成功，返回结果为空。";

    let result = `✅ 已执行您批准的命令，返回 ${data.length} 条结果：\n\n`;
    for (let i = 0; i < Math.min(data.length, 20); i++) {
      const item = data[i];
      if (typeof item === "object" && item !== null) {
        const entries = Object.entries(item as Record<string, unknown>).slice(0, 6);
        const summary = entries.map(([k, v]) => `${k}=${String(v).slice(0, 30)}`).join(", ");
        result += `${i + 1}. ${summary}\n`;
      } else {
        result += `${i + 1}. ${String(item).slice(0, 100)}\n`;
      }
    }
    if (data.length > 20) result += `\n... 还有 ${data.length - 20} 条结果`;
    return result;
  }

  // ── System Config Query: direct response without LLM ──
  private handleSystemConfigQuery(
    message: string,
    skillManager: { searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>; listSkills(): unknown[]; executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown>; } | undefined,
    startTime: number,
    sessionId: string,
  ): { reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean } | null {
    return handleSystemConfigQueryFn(this._configQueryDeps(), message, skillManager, startTime, sessionId);
  }

  private async handleSkillInstall(
    message: string,
    skillManager: { searchLocalSkills(query: Record<string, unknown>): Promise<unknown>; listSkills(): unknown[]; installSkill?(path: string): Promise<unknown> } | undefined,
    startTime: number,
    sessionId: string
  ): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean } | null> {
    const deps: SkillInstallerDeps = { registry: this.registry, workspacePath: this.workspacePath };
    return handleSkillInstallFn(deps, message, skillManager, startTime, sessionId);
  }

  /**
   * Extract skill names or URLs from user message for batch install.
   * Supports: skill names, URLs ending in .zip, backtick-wrapped URLs.
   */
  private extractSkillNames(message: string, regexMatch: RegExpMatchArray | null): string[] {
    return extractSkillNamesFn(message, regexMatch);
  }

  /**
   * Extract API key from user message.
   * Matches patterns like "API key为xxx", "API key: xxx", "apikey=xxx", "密钥是xxx", etc.
   */
  private extractApiKey(message: string): string | null {
    return extractApiKeyFn(message);
  }

  /**
   * Configure API key for installed skills.
   * Writes to skill's _config.json and/or external config files declared in SKILL.md.
   */
  private async configureSkillApiKey(skillIds: string[], apiKey: string): Promise<Array<{ skillId: string; configured: boolean; message: string }>> {
    const deps: SkillInstallerDeps = { registry: this.registry, workspacePath: this.workspacePath };
    return configureSkillApiKeyFn(deps, skillIds, apiKey);
  }

  /**
   * Handle batch installation of specific skills.
   * Supports both skill names and URLs (http/https ending in .zip).
   */
  private async handleBatchSkillInstall(
    selectedSkills: string[],
    installedNames: Set<string>,
    startTime: number,
    apiKey?: string | null
  ): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean }> {
    const deps: SkillInstallerDeps = { registry: this.registry, workspacePath: this.workspacePath };
    return handleBatchSkillInstallFn(deps, selectedSkills, installedNames, startTime, apiKey);
  }

  /**
   * Download a skill zip from URL, extract it to the skills directory,
   * and return the path to the SKILL.md file with detailed error info.
   */
  private async downloadAndExtractSkill(url: string): Promise<{ skillPath: string | null; error?: string }> {
    const deps: SkillInstallerDeps = { registry: this.registry, workspacePath: this.workspacePath };
    return downloadAndExtractSkillFn(deps, url);
  }

  /**
   * Download a file from URL to a local path.
   */
  private downloadFile(url: string, destPath: string): Promise<void> {
    return downloadFileFn(url, destPath);
  }

  /**
   * Extract a zip file to a target directory.
   * Uses `tar` (available on Windows 10+ and all Unix) as primary method,
   * falls back to PowerShell Expand-Archive, then adm-zip.
   */
  private async extractZip(zipPath: string, targetDir: string): Promise<void> {
    return extractZipFn(zipPath, targetDir);
  }

  /**
   * Execute a command and return a promise.
   */
  private execCommand(cmd: string, args: string[], timeout: number): Promise<void> {
    return execCommandFn(cmd, args, timeout);
  }

  /**
   * Recursively find SKILL.md in a directory.
   * If a hint is provided, checks hint/SKILL.md first for efficiency.
   */
  private findSkillMd(dir: string, hint?: string): string | null {
    return findSkillMdFn(dir, hint);
  }

  private computeDynamicToolLimit(message: string, baseLimit: number, cap: number): number {
    return computeDynamicToolLimitFn(this.getTaskAnalyzerDeps(), message, baseLimit, cap, "default");
  }

  private hasActionIntent(message: string): boolean {
    return hasActionIntentFn(message);
  }

  private async tryCallLLM(
    message: string,
    systemPrompt: string,
    installedSkills: unknown[],
    providers: ProviderConfig[],
    startTime: number,
    sessionId: string,
    pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>,
    attachments?: Array<{ name: string; type: string; size: number; data?: string | null }>,
    onProgress?: AgentProgressCallback,
    searchPreDone: boolean = false,
    channel?: string
  ): Promise<{ reply: string; tokensUsed: number; contextTokens?: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean; files: Array<{ path: string; size: number; downloadUrl: string }> } | null> {
    const deps = this.getLLMCallerDeps();
    // Inject iteration budget and context engine result for this session
    deps.iterationBudget = this.getIterationBudget(sessionId);
    deps.contextEngineResult = this._currentContextEngineResult ?? undefined;
    return tryCallLLMFn(deps, {
      message, systemPrompt, installedSkills, providers, startTime,
      sessionId, pendingPermissions, attachments, onProgress,
      searchPreDone, channel,
    });
  }

  private buildOpenAITools(): Array<{ type: string; function: { name: string; description: string; parameters: { type: string; properties: Record<string, unknown>; required: string[] } } }> {
    return buildOpenAIToolsFn(this.registeredTools, undefined, (fn: () => boolean) => this.evaluateCheckFn(fn));
  }

  private async callLLMOnce(
    provider: ProviderConfig,
    messages: Array<{ role: string; content: string | null | ChatContent[]; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
    tools: Array<{ type: string; function: Record<string, unknown> }>,
    toolChoice: "auto" | "required" | "none" = "auto",
    onProgress?: AgentProgressCallback
  ): Promise<{ message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }; tokensUsed: number; promptTokens: number; classifiedError?: ClassifiedError } | null> {
    return callLLMOnceFn(provider, messages, tools, toolChoice, onProgress, this.getLLMCallerDeps());
  }

  private async parseStreamingResponse(
    response: NativeFetchResponse,
    provider: ProviderConfig,
    startTime: number,
    onProgress: AgentProgressCallback
  ): Promise<{ message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }; tokensUsed: number; promptTokens: number } | null> {
    return parseStreamingResponseFn(response, provider, startTime, onProgress, this.getLLMCallerDeps());
  }

  /**
   * Quick reply for simple greetings and common queries — no LLM needed.
   * Returns null if the message doesn't match any quick-reply pattern.
   */
  private tryQuickReply(message: string): string | null {
    const deps: QuickReplyDeps = {
      persona: this.persona,
      registeredTools: this.registeredTools,
      config: this.config,
      providers: this.providers,
      hasBeenGreeted: this.greeted,
      workspacePath: this.workspacePath,
    };
    return tryQuickReplyFn(deps, message);
  }

  /**
   * Extended quick reply that also appends a capability block for hello /
   * identity / capability categories so the user gets a useful first-time
   * introduction. Mirrors the WeChat channel's reply style.
   */
  private tryQuickReplyExtended(message: string): string | null {
    const deps: QuickReplyDeps = {
      persona: this.persona,
      registeredTools: this.registeredTools,
      config: this.config,
      providers: this.providers,
      hasBeenGreeted: this.greeted,
      workspacePath: this.workspacePath,
    };
    return tryQuickReplyExtendedFn(deps, message);
  }

  private async generateChatResponse(
    message: string,
    msg: string,
    installedSkills: unknown[],
    skillManager: { searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>; listSkills(): unknown[]; executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown>; } | undefined,
    pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>
  ): Promise<string> {
    const deps: QuickReplyDeps = {
      persona: this.persona,
      registeredTools: this.registeredTools,
      config: this.config,
      providers: this.providers,
      hasBeenGreeted: this.greeted,
      workspacePath: this.workspacePath,
    };
    return generateChatResponseFn(deps, message, msg, installedSkills, skillManager, pendingPermissions);
  }

  async execute(
    prompt: string,
    node: DAGNode,
    options?: {
      tools?: string[];
      context?: Record<string, unknown>;
      modelOverride?: Partial<ModelConfig>;
    }
  ): Promise<AgentExecutionResult> {
    return dagExecute(this.getDAGExecutionDeps(), prompt, node, options);
  }

  async executeSkillDirectly(
    skill: Skill,
    params: Record<string, unknown>
  ): Promise<AgentExecutionResult> {
    return dagExecuteSkillDirectly(this.getDAGExecutionDeps(), skill, params);
  }

  private generateReasoning(
    prompt: string,
    node: DAGNode,
    context?: Record<string, unknown>
  ): string {
    return dagGenerateReasoning(this.config, prompt, node, context);
  }

  private extractToolParams(
    prompt: string,
    definition: ToolDefinition
  ): Record<string, unknown> {
    return dagExtractToolParams(prompt, definition);
  }

  private generateDefaultOutput(
    prompt: string,
    reasoning: string
  ): unknown {
    return dagGenerateDefaultOutput(this.config, prompt, reasoning);
  }

  private extractKeywords(text: string): string[] {
    return dagExtractKeywords(text);
  }

  private estimateTokenCount(text: string): number {
    if (!text) return 0;
    // CJK characters typically use 1-2 tokens each (not 0.25)
    // Count CJK characters separately
    let cjkCount = 0;
    let asciiCount = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if ((code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified Ideographs
          (code >= 0x3040 && code <= 0x30FF) ||   // Japanese Kana
          (code >= 0xAC00 && code <= 0xD7AF) ||   // Korean Hangul
          (code >= 0x3400 && code <= 0x4DBF)) {   // CJK Extension A
        cjkCount++;
      } else {
        asciiCount++;
      }
    }
    // CJK: ~1.5 tokens per character, ASCII: ~0.25 tokens per character
    return Math.ceil(cjkCount * 1.5 + asciiCount / 4);
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Check if core services are available
      if (!this.providers || this.providers.length === 0) return false;
      // Check if at least basic tools are registered
      if (this.registeredTools.size === 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  // ====== Heartbeat Mechanism ======

  /** Configure heartbeat settings */
  configureHeartbeat(config: { intervalMs?: number; enabled?: boolean }): void {
    this.heartbeatManager.configure(config);
  }

  /** Start the heartbeat timer */
  startHeartbeat(): void {
    // Ensure handler deps are set before starting
    this.heartbeatManager.setHandlerDeps({
      registry: this.registry,
      eventBus: this.eventBus,
      queueManager: this.queueManager,
      lifecycleManager: this.lifecycleManager,
      memoryHub: this.memoryHub,
      processChatMessage: (message, options) => this.chat(message, options),
    });
    this.heartbeatManager.start();
  }

  /** Stop the heartbeat timer */
  stopHeartbeat(): void {
    this.heartbeatManager.stop();
  }

  /** Mark a session as actively processing (pauses heartbeat for that session) */
  markSessionActive(sessionId: string): void {
    this.heartbeatManager.markSessionActive(sessionId);
  }

  /** Mark a session as idle (resumes heartbeat eligibility) */
  markSessionIdle(sessionId: string): void {
    this.heartbeatManager.markSessionIdle(sessionId);
  }

  /** Check if the agent is currently idle (no active conversations) */
  isAgentIdle(): boolean {
    return this.heartbeatManager.isIdle();
  }

  /** Get current heartbeat status */
  getHeartbeatStatus(): {
    enabled: boolean;
    active: boolean;
    intervalMs: number;
    lastFireTime: Date | null;
    nextFireTime: Date | null;
    isIdle: boolean;
    activeConversations: number;
  } {
    return this.heartbeatManager.getStatus();
  }

  // ====== Planning & Reflection Integration ======

  /** Try to delegate subtasks to specialized swarm agents */
  private async trySwarmDelegation(
    plan: import("./planning-engine").ExecutionPlan,
    userMessage: string,
    sessionId: string
  ): Promise<string | null> {
    if (!this.swarmOrchestrator) return null;

    // Analyze plan steps to find delegation opportunities
    const delegationHints: string[] = [];
    const toolHints = plan.steps.map(s => s.toolHint).filter(Boolean) as string[];

    // Map tool hints to agent capabilities
    const capabilityMap: Record<string, string> = {
      "web_search": "web-search", "web_fetch": "web-fetch", "browser_navigate": "browser-navigate",
      "browser_click": "browser-click", "browser_fill_form": "browser-fill-form",
      "browser_select": "browser-select", "browser_check": "browser-check",
      "browser_wait": "browser-wait", "browser_screenshot": "browser-screenshot",
      "shell_exec": "shell-exec", "file_create": "file-create", "file_modify": "file-modify",
      "file_read": "file-read", "file_delete": "file-delete",
    };

    const requiredCapabilities = toolHints
      .map(h => capabilityMap[h] || h)
      .filter(Boolean);

    if (requiredCapabilities.length === 0) return null;

    // Find the best agent for these capabilities
    const bestAgent = this.swarmOrchestrator.findBestAgent(requiredCapabilities, "medium");
    if (!bestAgent) return null;

    // Delegate the task
    try {
      const delegationResult = await this.swarmOrchestrator.delegate({
        fromAgentId: "main",
        toAgentId: bestAgent.id,
        task: userMessage,
        context: plan.steps.map(s => s.description).join("; "),
        requiredCapabilities,
        priority: "medium",
        timeoutMs: 60000,
      });

      if (delegationResult.success) {
        delegationHints.push(`[Swarm] 任务已委派给 ${bestAgent.name} (${bestAgent.role})，专长: ${bestAgent.capabilities.join(", ")}`);
        process.stdout.write(`[AgentModelExecutor] Swarm delegation: ${bestAgent.name} assigned for session "${sessionId}"`);
      }
    } catch (err) {
      process.stderr.write(`[AgentModelExecutor] Swarm delegation failed: ${err}`);
    }

    return delegationHints.length > 0 ? delegationHints.join("\n") : null;
  }

  /** Record a tool execution trace for reflection */
  recordToolTrace(sessionId: string, toolName: string, params: Record<string, unknown>, result: unknown, success: boolean, duration: number, error?: string): void {
    const traces = this.executionTraces.get(sessionId) || [];
    traces.push({
      toolName,
      params,
      result: typeof result === "string" ? result.slice(0, 500) : JSON.stringify(result).slice(0, 500),
      success,
      duration,
      timestamp: Date.now(),
      error,
    });
    // Keep last 20 traces per session
    if (traces.length > 20) traces.splice(0, traces.length - 20);
    this.executionTraces.set(sessionId, traces);
  }

  /** Update planning step status after tool execution */
  private updatePlanStep(sessionId: string, toolName: string, update: { status: string; result?: string; error?: string }): void {
    const plan = this.activePlans.get(sessionId);
    if (!plan || !this.planningEngine) return;
    // Find the step that matches this tool
    const matchingStep = plan.steps.find(s => s.toolHint === toolName && s.status === "in_progress");
    if (matchingStep) {
      this.planningEngine.updateStep(plan.id, matchingStep.id, {
        status: update.status as "completed" | "failed",
        result: update.result,
        error: update.error,
      });
    } else {
      // Mark the next pending step as in_progress if this tool matches its hint
      const nextStep = plan.steps.find(s => s.toolHint === toolName && s.status === "pending");
      if (nextStep) {
        this.planningEngine.updateStep(plan.id, nextStep.id, {
          status: update.status as "completed" | "failed",
          result: update.result,
          error: update.error,
        });
      }
    }
  }

  /** Check if reflection should be triggered and execute it */
  async checkAndReflect(sessionId: string): Promise<import("./reflection-engine").ReflectionResult | null> {
    if (!this.reflectionEngine) return null;
    const traces = this.executionTraces.get(sessionId) || [];
    if (!this.reflectionEngine.shouldReflect(traces)) return null;

    const plan = this.activePlans.get(sessionId);
    const planContext = plan ? this.planningEngine?.formatPlanForContext(plan) : undefined;

    try {
      // Try quick reflection first (no LLM cost)
      const quickResult = this.reflectionEngine.quickReflect(traces);
      if (quickResult.shouldReplan || quickResult.shouldRetry) {
        process.stdout.write(`[AgentModelExecutor] Quick reflection triggered: ${quickResult.analysis}`);
        return quickResult;
      }

      // Use LLM-based reflection for deeper analysis
      const result = await this.reflectionEngine.reflect(traces, planContext);
      process.stdout.write(`[AgentModelExecutor] Reflection result: continue=${result.shouldContinue}, replan=${result.shouldReplan}, retry=${result.shouldRetry}, confidence=${result.confidence}`);

      // Handle replan
      if (result.shouldReplan && plan && this.planningEngine) {
        const failedSteps = plan.steps.filter(s => s.status === "failed").length;
        if (this.planningEngine.shouldReplan(plan, failedSteps)) {
          const toolNames = Array.from(this.registeredTools.keys());
          const newPlan = await this.planningEngine.replan(plan, plan.goal, toolNames);
          this.activePlans.set(sessionId, newPlan);
          process.stdout.write(`[AgentModelExecutor] Replanned: ${newPlan.steps.length} steps (replan #${newPlan.replanCount})`);
        }
      }

      return result;
    } catch (err) {
      process.stderr.write(`[AgentModelExecutor] Reflection failed: ${err}`);
      return null;
    }
  }

  /** Get the active plan for a session */
  getActivePlan(sessionId: string): import("./planning-engine").ExecutionPlan | undefined {
    return this.activePlans.get(sessionId);
  }

  /** Get execution traces for a session */
  getExecutionTraces(sessionId: string): import("./reflection-engine").ToolExecutionTrace[] {
    return this.executionTraces.get(sessionId) || [];
  }

  /** Get swarm status */
  getSwarmStatus(): { agentCount: number; activeDelegations: number; agents: Array<{ id: string; name: string; role: string; status: string }> } {
    if (!this.swarmOrchestrator) return { agentCount: 0, activeDelegations: 0, agents: [] };
    return this.swarmOrchestrator.getStatus();
  }

  getGuardrailsStatus(): { enabled: boolean; stats?: import("./guardrails").GuardrailStats } {
    if (!this.guardrailsManager) return { enabled: false };
    return { enabled: true, stats: this.guardrailsManager.getStats() };
  }

  getObservabilityTraces(): import("./agent-observability").Trace[] {
    if (!this.observability) return [];
    return this.observability.getActiveTraces();
  }

  getAgentObservability(): import("./agent-observability").AgentObservability | null {
    return this.observability;
  }

  getPromptCacheStats(): import("./prompt-cache").CacheStats | null {
    if (!this.promptCache) return null;
    return this.promptCache.getCacheStats();
  }

  getACPAgents(): import("./acp-delegation").ACPAgent[] {
    if (!this.acpHandler) return [];
    return this.acpHandler.listAgents();
  }

  getWorkboard(): import("./workboard").Workboard | null {
    return this.workboard;
  }

  getComputedStatus(): import("./computed-status").ComputedStatusEngine | null {
    return this.computedStatusEngine;
  }

  steer(sessionId: string, instruction: string, priority?: "low" | "normal" | "high" | "critical"): import("./steer-command").SteerResult | null {
    if (!this.steerManager) return null;
    return this.steerManager.steer(sessionId, instruction, { priority });
  }
}