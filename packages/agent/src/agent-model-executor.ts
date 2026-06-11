import { ServiceRegistry, EventBus, type DAGNode, type Skill, type PersonaConfig } from "@evoclaw/core";
import type { Span } from "@opentelemetry/api";
import { buildAgentSystemPrompt, buildCompactSkillsPrompt, type SystemPromptParams, type PromptMode } from "./system-prompt";
import { classifyLLMError, LLMErrorType, type ClassifiedError } from "./error-classifier";
import type { LedgerEntry, LedgerEventType } from "./event-ledger";
import type { ChatContent } from "@evoclaw/plugin-sdk";
import { tryCallLLM as tryCallLLMFn, callLLMOnce as callLLMOnceFn, parseStreamingResponse as parseStreamingResponseFn, buildOpenAITools as buildOpenAIToolsFn, type LLMCallerDeps } from "./llm-caller";
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
import { tryQuickReply as tryQuickReplyFn, tryQuickReplyExtended as tryQuickReplyExtendedFn, generateChatResponse as generateChatResponseFn, hasActionIntent as hasActionIntentFn, type QuickReplyDeps, type SkillManagerLike } from "./quick-reply";
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

  /** Eval runner for agent behavior evaluation */
  private evalRunner: import("./evals").EvalRunner | null = null;

  /** 工具结果缓存，避免相同工具+参数的重复 LLM 调用 */
  private toolResultCache = new Map<string, { result: string; timestamp: number }>();
  private static TOOL_CACHE_TTL = 5 * 60 * 1000; // 5 分钟
  private static TOOL_CACHE_MAX = 100;

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
    console.log(`[AgentModelExecutor] Memory hub integrated`);
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
        console.log(`[AgentModelExecutor] Semantic quick-reply enabled (embedding dims=${provider.dimensions ?? "?"})`);
      }
    } catch {
      // Non-fatal: semantic quick reply is best-effort
    }
  }

  /** Set bootstrap manager */
  setBootstrapManager(bm: import("./bootstrap-manager").BootstrapManager): void {
    this.bootstrapManager = bm;
    console.log(`[AgentModelExecutor] Bootstrap manager integrated`);
  }

  /** Get bootstrap manager for tool registration */
  getBootstrapManager(): import("./bootstrap-manager").BootstrapManager | null {
    return this.bootstrapManager;
  }

  /** Set compaction manager */
  setCompactionManager(cm: import("./compaction-manager").CompactionManager): void {
    this.compactionManager = cm;
    console.log(`[AgentModelExecutor] Compaction manager integrated`);
  }

  /** Set lifecycle manager */
  setLifecycleManager(lm: import("./agent-lifecycle").AgentLifecycleManager): void {
    this.lifecycleManager = lm;
    console.log(`[AgentModelExecutor] Lifecycle manager integrated`);
  }

  /** Set queue manager */
  setQueueManager(qm: import("./queue-manager").QueueManager): void {
    this.queueManager = qm;
    console.log(`[AgentModelExecutor] Queue manager integrated`);
  }

  /** Set session manager */
  setSessionManager(sm: import("./session-manager").SessionManager): void {
    this.sessionManager = sm;
    console.log(`[AgentModelExecutor] Session manager integrated`);
  }

  /** Set context engine */
  setContextEngine(ce: import("./context-engine").ContextEngine): void {
    this.contextEngine = ce;
    console.log(`[AgentModelExecutor] Context engine integrated`);
  }

  /** Set plugin manager */
  setPluginManager(pm: import("@evoclaw/core").PluginManager): void {
    this.pluginManager = pm;
    console.log(`[AgentModelExecutor] Plugin manager integrated`);
  }

  /** Set channel manager */
  setChannelManager(cm: { getDMPolicy?: (...args: unknown[]) => unknown; getAllStatuses?: () => Array<unknown> }): void {
    this.channelManager = cm;
    console.log(`[AgentModelExecutor] Channel manager integrated`);
  }

  /** Set human approval manager */
  setHumanApprovalManager(manager: HumanApprovalManager): void {
    this.humanApprovalManager = manager;
    console.log(`[AgentModelExecutor] Human approval manager integrated`);
  }

  /** Set eval runner */
  setEvalRunner(runner: import("./evals").EvalRunner): void {
    this.evalRunner = runner;
    console.log(`[AgentModelExecutor] Eval runner integrated`);
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

    console.log(`[AgentModelExecutor] Resuming execution for session "${sessionId}" from snapshot ${fromSnapshotIndex ?? "latest"}, ${messages.length} messages`);

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
    persona?: Partial<PersonaConfig>
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
      const { PlanningEngine } = require("./planning-engine") as { PlanningEngine: new (providers: ProviderConfig[]) => import("./planning-engine").PlanningEngine };
      this.planningEngine = new PlanningEngine(this.providers);
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
            const resp = await fetch(`${enabled[0].baseURL}/chat/completions`, {
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
      } catch { /* max agents reached */ }
    }
  }

  private registerBuiltinTools(): void {
    registerSequentialThinkingToolFn(this, this.sequentialThinkingHistory);
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
        console.log(`[AgentModelExecutor] Loaded bootstrap file: ${fileName} (${content.length} chars)`);
      } catch (err) {
        console.warn(`[AgentModelExecutor] Failed to read bootstrap file ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
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
    handler: (params: Record<string, unknown>) => Promise<unknown>
  ): void {
    this.registeredTools.set(name, { definition, handler });
  }

  unregisterTool(name: string): void {
    this.registeredTools.delete(name);
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
        console.warn(`[AgentModelExecutor] Failed to load bootstrap context: ${err}`);
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
      userTimezone: "Asia/Shanghai",
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
    } else {
      this.conversationHistory.clear();
      this.sequentialThinkingHistory.clear();
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

    // ── Plugin hook: before_agent_start ──
    let effectiveMessage = message;
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
    const attachments = context?.attachments as Array<{ name: string; type: string; size: number; data?: string | null }> | undefined;
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
          this.conversationHistory.set(sessionId, loadedHistory.filter(t => t.role === "user" || t.role === "assistant").map(t => ({
            role: t.role,
            content: t.content,
          })));
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
        console.warn(`[AgentModelExecutor] Failed to persist user message early: ${err}`);
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
      console.log(`[AgentModelExecutor] Skill install request detected: "${message}"`);
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
      console.log(`[AgentModelExecutor] User provided URL detected — skipping SkillDispatcher, going directly to LLM`);
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
          console.log(`[AgentModelExecutor] SkillDispatcher: analyzing task "${message.slice(0, 60)}"`);
          taskStatusTracker.set(sessionId, "thinking", "技能调度中，正在匹配最合适的技能...", 20);
          const dispatchResult = await skillDispatcher.dispatch({
            task: message,
            sessionId,
            allowAutoInstall: true,
            fallbackToWebSearch: true,
          });

          const outputStr = typeof dispatchResult.output === "string"
            ? AgentModelExecutor.stripWebNoise(dispatchResult.output)
            : (() => {
                const obj = dispatchResult.output as Record<string, unknown>;
                if (obj && typeof obj === "object") {
                  for (const key of ["content", "text", "body", "snippet", "output"]) {
                    if (typeof obj[key] === "string" && (obj[key] as string).length > 100) {
                      obj[key] = AgentModelExecutor.stripWebNoise(obj[key] as string);
                    }
                  }
                  if (Array.isArray(obj.results)) {
                    for (const item of obj.results as Array<Record<string, unknown>>) {
                      if (typeof item.snippet === "string" && (item.snippet as string).length > 100) {
                        item.snippet = AgentModelExecutor.stripWebNoise(item.snippet as string);
                      }
                      if (typeof item.content === "string" && (item.content as string).length > 100) {
                        item.content = AgentModelExecutor.stripWebNoise(item.content as string);
                      }
                    }
                  }
                }
                return JSON.stringify(dispatchResult.output, null, 2);
              })();

          const skillErrorCategories = {
            auth: ["must be set in environment", "api key is required", "authentication failed", "unauthorized", "invalid api key", "api_key is not set", "missing api key"],
            rateLimit: ["rate limit exceeded", "quota exceeded", "too many requests"],
            network: ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "network error", "connection refused"],
            config: ["missing required", "config not found", "not configured"],
          };

          const skillErrorMessages: Record<string, string> = {
            auth: "技能执行失败：API 密钥未配置或无效。请在技能管理页面配置相应的 API Key。",
            rateLimit: "技能执行失败：API 调用频率超限。请稍后重试。",
            network: "技能执行失败：网络连接错误。请检查网络设置。",
            config: "技能执行失败：配置缺失。请在技能管理页面完善配置。",
          };

          const classifiedError = (() => {
            if (dispatchResult.success) return null;
            const lower = outputStr.toLowerCase();
            for (const [category, patterns] of Object.entries(skillErrorCategories)) {
              if (patterns.some(p => lower.includes(p.toLowerCase()))) {
                return { category, userMessage: skillErrorMessages[category] };
              }
            }
            return null;
          })();

          const outputHasError = !dispatchResult.success && classifiedError !== null;

          // Check if skill output is essentially empty/meaningless (e.g. "no scripts defined")
          const isEmptyOutput = (() => {
            if (!dispatchResult.output) return true;
            if (typeof dispatchResult.output === "string") {
              const s = dispatchResult.output.trim();
              return s.length < 50 || s.includes("no scripts defined") || s.includes("executed successfully");
            }
            if (typeof dispatchResult.output === "object") {
              const obj = dispatchResult.output as Record<string, unknown>;
              // Check if it's just a status message with no actual content
              const hasContent = obj.content || obj.text || obj.body || obj.data || obj.results;
              if (!hasContent && obj.message && typeof obj.message === "string") {
                return (obj.message as string).includes("no scripts defined");
              }
              return !hasContent;
            }
            return false;
          })();

          if (dispatchResult.path === "skill" && dispatchResult.success && !isEmptyOutput && !outputHasError) {
            console.log(`[AgentModelExecutor] SkillDispatcher handled via "${dispatchResult.skillName}": ${dispatchResult.output}`);
            const skillReply = `🎯 **技能调度**: \`${dispatchResult.skillName}\`\n\n${outputStr}\n\n---\n<details><summary>📋 调度详情</summary>\n\n${dispatchResult.reasoning}\n</details>`;
            this.persistEarlyReturn(sessionId, message, skillReply);
            return {
              reply: skillReply,
              tokensUsed: 0,
              duration: Date.now() - startTime,
              permissionRequests: [],
              toolsExecuted: true,
            };
          } else if (dispatchResult.path === "web_search" && dispatchResult.success && !isEmptyOutput && !outputHasError) {
            console.log(`[AgentModelExecutor] SkillDispatcher used web_search fallback`);
            const searchReply = `🔍 **网页搜索**: \`${dispatchResult.skillName}\`\n\n${outputStr}`;
            this.persistEarlyReturn(sessionId, message, searchReply);
            return {
              reply: searchReply,
              tokensUsed: 0,
              duration: Date.now() - startTime,
              permissionRequests: [],
              toolsExecuted: true,
            };
          } else if (outputHasError) {
            console.log(`[AgentModelExecutor] SkillDispatcher: skill "${dispatchResult.skillName}" returned ${classifiedError!.category} error — falling through to LLM`);
            const errorReply = `⚠️ ${classifiedError!.userMessage}`;
            this.persistEarlyReturn(sessionId, message, errorReply);
            return {
              reply: errorReply,
              tokensUsed: 0,
              duration: Date.now() - startTime,
              permissionRequests: [],
              toolsExecuted: true,
            };
          } else if (isEmptyOutput && dispatchResult.path === "skill") {
            console.log(`[AgentModelExecutor] SkillDispatcher: skill "${dispatchResult.skillName}" returned empty output — falling through to LLM`);
          } else if (dispatchResult.path === "none") {
            console.log(`[AgentModelExecutor] SkillDispatcher: no matching skill found — falling through to LLM`);
          } else {
            // Skill matched but execution failed — fall through to LLM
            console.log(`[AgentModelExecutor] SkillDispatcher: skill "${dispatchResult.skillName}" matched but execution failed (path=${dispatchResult.path}, success=${dispatchResult.success}) — falling through to LLM`);
          }
        }
      } catch (err) {
        console.warn(`[AgentModelExecutor] SkillDispatcher dispatch failed: ${err}`);
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
      console.log(`[AgentModelExecutor] Auto-split enabled for complexity "${autoSplitConfig.complexity}", maxSubtasks: ${autoSplitConfig.maxSubtasks}`);

      const existingCheckpoint = taskCheckpointManager.get(sessionId);
      if (existingCheckpoint && existingCheckpoint.completedCount < existingCheckpoint.totalSubtasks) {
        console.log(`[AgentModelExecutor] Resuming task from checkpoint: ${existingCheckpoint.completedCount}/${existingCheckpoint.totalSubtasks} completed`);
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
        console.log(`[AgentModelExecutor] Task decomposed into ${subtaskDescriptions.length} subtasks:`, subtaskDescriptions.map(s => s.description.slice(0, 40)));

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
    const installedSkills = await skillManager?.listSkills() || [];

    // ── Planning: generate explicit execution plan for complex tasks ──
    let planContext = "";
    if (this.planningEngine && this.hasActionIntent(effectiveMessage)) {
      const toolNames = Array.from(this.registeredTools.keys());
      try {
        const plan = await this.planningEngine.generatePlan(effectiveMessage, toolNames, sessionId);
        const validation = this.planningEngine.validatePlan(plan);
        if (validation.valid) {
          plan.status = "validated";
          this.activePlans.set(sessionId, plan);
          planContext = this.planningEngine.formatPlanForContext(plan);
          console.log(`[AgentModelExecutor] Plan generated for session "${sessionId}": ${plan.steps.length} steps, complexity=${validation.complexity}`);
          taskStatusTracker.set(sessionId, "planning", `已生成执行计划：${plan.steps.length} 个步骤`, 25);
          onProgress?.({ type: "status", phase: "planning", detail: `已生成执行计划：${plan.steps.length} 个步骤`, progress: 25 });

          // ── Swarm delegation: delegate to specialized agent if plan has clear tool group ──
          if (this.swarmOrchestrator) {
            const delegatedContext = await this.trySwarmDelegation(plan, effectiveMessage, sessionId);
            if (delegatedContext) {
              planContext += "\n\n" + delegatedContext;
            }
          }
        } else {
          console.warn(`[AgentModelExecutor] Plan validation failed: ${validation.issues.join("; ")}`);
        }
      } catch (err) {
        console.warn(`[AgentModelExecutor] Planning failed: ${err}`);
      }
    }

    const enhancedSystemPrompt = systemPrompt + (planContext ? "\n\n[执行计划]\n" + planContext : "");

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
      console.log(`[AgentModelExecutor] News context added: ${newsContext.length} chars for session "${sessionId}"`);
    }

    const enabledProviders = this.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);
    console.log(`[AgentModelExecutor] Session "${sessionId}": ${enabledProviders.length} enabled providers, message length: ${finalEnhancedMessage.length} chars, history turns: ${(this.conversationHistory.get(sessionId) || []).length}`);

    if (enabledProviders.length > 0) {
      const primaryProvider = enabledProviders[0];
      taskStatusTracker.set(sessionId, "thinking", `正在调用 ${primaryProvider.name} (${primaryProvider.model})...`, 30);
      const result = await this.tryCallLLM(finalEnhancedMessage, enhancedSystemPrompt, installedSkills, enabledProviders, startTime, sessionId, pendingPermissions, context?.attachments as Array<{ name: string; type: string; size: number; data?: string | null }> | undefined, onProgress, !!newsContext, channel);
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
        if (pendingPermissions.length > 0) {
          return { reply, tokensUsed: result.tokensUsed, contextTokens: result.contextTokens, duration: result.duration, permissionRequests: [...pendingPermissions], toolsExecuted: result.toolsExecuted, files: result.files };
        }
        return { reply, tokensUsed: result.tokensUsed, contextTokens: result.contextTokens, duration: result.duration, permissionRequests: [], toolsExecuted: result.toolsExecuted, files: result.files };
      }
    }

    // LLM unavailable: try skill-based execution for actionable tasks
    taskStatusTracker.set(sessionId, "error", "模型服务暂不可用，切换到本地规则响应", 60);
    const msg = message.toLowerCase();
    if (this.hasActionIntent(message)) {
      console.log(`[AgentModelExecutor] LLM unavailable, trying skill-based execution for: "${message.slice(0, 80)}"`);
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
    }).catch(err => console.warn(`[AgentModelExecutor] agent_end hook failed: ${err}`));
  }

  /** Asynchronously save an interaction to long-term memory */
  private rememberInteraction(userMsg: string, agentReply: string, sessionId: string): void {
    if (!this.memoryHub) {
      console.warn(`[AgentModelExecutor] rememberInteraction: memoryHub is null`);
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
      console.log(`[AgentModelExecutor] rememberInteraction: session=${sessionId} useRemember=${useRemember}`);
      // Prefer memory hub's remember() so the entry is mirrored into the
      // vector store (Transformers embeddings). Fallback to longTerm.store
      // when remember() is not provided by the injected hub.
      const persist = this.memoryHub.remember
        ? this.memoryHub.remember(entry)
        : this.memoryHub.getLongTerm().store({
            ...entry,
            id: "",
            createdAt: new Date(),
            accessedAt: new Date(),
          } as import("@evoclaw/core").MemoryEntry);
      persist.then((stored) => {
        console.log(`[AgentModelExecutor] Memory saved: id=${stored.id} session=${sessionId}`);
      }, (err) => {
        console.warn(`[AgentModelExecutor] Memory save failed: ${err}`);
      });
    } catch (err) {
      console.warn(`[AgentModelExecutor] rememberInteraction threw: ${err}`);
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
    return computeDynamicToolLimitFn(this.getTaskAnalyzerDeps(), message, baseLimit, cap);
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
    return tryCallLLMFn(this.getLLMCallerDeps(), {
      message, systemPrompt, installedSkills, providers, startTime,
      sessionId, pendingPermissions, attachments, onProgress,
      searchPreDone, channel,
    });
  }

  private buildOpenAITools(): Array<{ type: string; function: { name: string; description: string; parameters: { type: string; properties: Record<string, unknown>; required: string[] } } }> {
    return buildOpenAIToolsFn(this.registeredTools);
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
    response: Response,
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
    return Math.ceil(text.length / 4);
  }

  async healthCheck(): Promise<boolean> {
    return true;
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
        console.log(`[AgentModelExecutor] Swarm delegation: ${bestAgent.name} assigned for session "${sessionId}"`);
      }
    } catch (err) {
      console.warn(`[AgentModelExecutor] Swarm delegation failed: ${err}`);
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
        console.log(`[AgentModelExecutor] Quick reflection triggered: ${quickResult.analysis}`);
        return quickResult;
      }

      // Use LLM-based reflection for deeper analysis
      const result = await this.reflectionEngine.reflect(traces, planContext);
      console.log(`[AgentModelExecutor] Reflection result: continue=${result.shouldContinue}, replan=${result.shouldReplan}, retry=${result.shouldRetry}, confidence=${result.confidence}`);

      // Handle replan
      if (result.shouldReplan && plan && this.planningEngine) {
        const failedSteps = plan.steps.filter(s => s.status === "failed").length;
        if (this.planningEngine.shouldReplan(plan, failedSteps)) {
          const toolNames = Array.from(this.registeredTools.keys());
          const newPlan = await this.planningEngine.replan(plan, plan.goal, toolNames);
          this.activePlans.set(sessionId, newPlan);
          console.log(`[AgentModelExecutor] Replanned: ${newPlan.steps.length} steps (replan #${newPlan.replanCount})`);
        }
      }

      return result;
    } catch (err) {
      console.warn(`[AgentModelExecutor] Reflection failed: ${err}`);
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
}