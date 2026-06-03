import { ServiceRegistry, EventBus, type DAGNode, type Skill, type SkillExecutionResult, type PersonaConfig } from "@evoclaw/core";
import { buildAgentSystemPrompt, buildCompactSkillsPrompt, type SystemPromptParams, type PromptMode } from "./system-prompt";
import { classifyLLMError, estimateMessagesTokens, LLMErrorType, type ClassifiedError } from "./error-classifier";
import type { LedgerEntry, LedgerEventType } from "./event-ledger";
import type { ChatContent } from "@evoclaw/plugin-sdk";
import * as fs from "fs";
import * as path from "path";

export interface ModelConfig {
  provider: "openai" | "anthropic" | "deepseek" | "local" | "custom";
  model: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens: number;
  temperature: number;
  timeout: number;
  topP?: number;
}

export interface ProviderConfig extends ModelConfig {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  successCount?: number;
  failureCount?: number;
  lastError?: string;
  lastErrorType?: string;
}

export interface AgentExecutionResult {
  success: boolean;
  output: unknown;
  reasoning: string;
  tokensUsed: number;
  duration: number;
  toolCalls: Array<{ name: string; result: unknown }>;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const DEFAULT_PERSONA: PersonaConfig = {
  name: "EvoClaw小助手",
  title: "您的专属EvoClaw智能助理",
  masterTerm: "主人",
  tone: "warm",
  introduction: "",
};

const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: "custom",
  model: "evoclaw-default",
  maxTokens: 4096,
  temperature: 0.3,
  timeout: 60000,
};

// ── Task Status Tracker: real-time progress feedback for long-running tasks ──
export interface TaskStatus {
  phase: "thinking" | "tool_calling" | "generating" | "done" | "error" | "splitting" | "subtask_executing" | "resuming";
  detail: string;
  progress: number; // 0-100
  updatedAt: number;
  subtaskIndex?: number;
  subtaskTotal?: number;
  subtaskLabel?: string;
}

export interface AgentProgressEvent {
  type: "status" | "tool_call" | "tool_result" | "llm_call" | "final" | "error" | "subtask_start" | "subtask_done" | "subtask_error" | "checkpoint_saved" | "task_resumed";
  phase?: TaskStatus["phase"];
  detail: string;
  progress?: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolError?: boolean;
  providerName?: string;
  round?: number;
  reply?: string;
  tokensUsed?: number;
  duration?: number;
  subtaskIndex?: number;
  subtaskTotal?: number;
}

export type AgentProgressCallback = (event: AgentProgressEvent) => void;

class TaskStatusTracker {
  private statuses = new Map<string, TaskStatus>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  set(sessionId: string, phase: TaskStatus["phase"], detail: string, progress: number, subtaskIndex?: number, subtaskTotal?: number, subtaskLabel?: string): void {
    this.statuses.set(sessionId, { phase, detail, progress, updatedAt: Date.now(), subtaskIndex, subtaskTotal, subtaskLabel });
    // Auto-cleanup stale entries every 5 minutes
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, val] of this.statuses) {
          if (now - val.updatedAt > 300_000) this.statuses.delete(key);
        }
        if (this.statuses.size === 0 && this.cleanupTimer) {
          clearInterval(this.cleanupTimer);
          this.cleanupTimer = null;
        }
      }, 60_000);
    }
  }

  get(sessionId: string): TaskStatus | null {
    return this.statuses.get(sessionId) || null;
  }

  delete(sessionId: string): void {
    this.statuses.delete(sessionId);
  }

  /** Get all active statuses (for monitoring) */
  getAll(): Array<{ sessionId: string; status: TaskStatus }> {
    return Array.from(this.statuses.entries()).map(([sessionId, status]) => ({ sessionId, status }));
  }
}

export const taskStatusTracker = new TaskStatusTracker();

export interface TaskCheckpoint {
  sessionId: string;
  originalMessage: string;
  subtasks: Array<{
    id: string;
    description: string;
    status: "pending" | "completed" | "failed";
    result?: string;
    error?: string;
  }>;
  completedCount: number;
  totalSubtasks: number;
  createdAt: number;
  updatedAt: number;
  overallResult?: string;
}

class TaskCheckpointManager {
  private checkpoints = new Map<string, TaskCheckpoint>();
  private checkpointDir: string;

  constructor(baseDir?: string) {
    this.checkpointDir = baseDir || path.resolve(process.cwd(), "data", "checkpoints");
    if (!fs.existsSync(this.checkpointDir)) {
      fs.mkdirSync(this.checkpointDir, { recursive: true });
    }
    this.loadFromDisk();
  }

  save(sessionId: string, checkpoint: TaskCheckpoint): void {
    checkpoint.updatedAt = Date.now();
    this.checkpoints.set(sessionId, checkpoint);
    this.persistToDisk(sessionId, checkpoint);
  }

  get(sessionId: string): TaskCheckpoint | undefined {
    return this.checkpoints.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.checkpoints.has(sessionId);
  }

  delete(sessionId: string): void {
    this.checkpoints.delete(sessionId);
    try {
      const filePath = path.join(this.checkpointDir, `${sessionId}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* ignore */ }
  }

  updateSubtask(sessionId: string, subtaskId: string, status: "completed" | "failed", result?: string, error?: string): void {
    const cp = this.checkpoints.get(sessionId);
    if (!cp) return;
    const st = cp.subtasks.find(s => s.id === subtaskId);
    if (!st) return;
    st.status = status;
    if (result !== undefined) st.result = result;
    if (error !== undefined) st.error = error;
    cp.completedCount = cp.subtasks.filter(s => s.status === "completed").length;
    cp.updatedAt = Date.now();
    this.persistToDisk(sessionId, cp);
  }

  getNextPendingSubtask(sessionId: string): TaskCheckpoint["subtasks"][number] | undefined {
    const cp = this.checkpoints.get(sessionId);
    if (!cp) return undefined;
    return cp.subtasks.find(s => s.status === "pending");
  }

  private persistToDisk(sessionId: string, checkpoint: TaskCheckpoint): void {
    try {
      const filePath = path.join(this.checkpointDir, `${sessionId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
    } catch (err) {
      console.warn(`[TaskCheckpointManager] Failed to persist checkpoint for ${sessionId}:`, err);
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.checkpointDir)) return;
      const files = fs.readdirSync(this.checkpointDir).filter(f => f.endsWith(".json"));
      const now = Date.now();
      const MAX_AGE = 24 * 60 * 60 * 1000;
      for (const file of files) {
        try {
          const data = fs.readFileSync(path.join(this.checkpointDir, file), "utf-8");
          const cp = JSON.parse(data) as TaskCheckpoint;
          if (now - cp.updatedAt < MAX_AGE) {
            this.checkpoints.set(cp.sessionId, cp);
          } else {
            fs.unlinkSync(path.join(this.checkpointDir, file));
          }
        } catch { /* skip corrupt files */ }
      }
    } catch { /* ignore */ }
    console.log(`[TaskCheckpointManager] Loaded ${this.checkpoints.size} checkpoints from disk`);
  }
}

export const taskCheckpointManager = new TaskCheckpointManager();

export interface AutoSplitConfig {
  complexity: "simple" | "medium" | "complex" | "very_complex";
  shouldAutoSplit: boolean;
  maxSubtasks: number;
}

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
  private autoCompactionEnabled = true;
  private memoryHub: { getLongTerm(): { store(entry: import("@evoclaw/core").MemoryEntry): Promise<import("@evoclaw/core").MemoryEntry>; search(query: import("@evoclaw/core").MemorySearchQuery): Promise<import("@evoclaw/core").MemorySearchResult[]> } } | null = null;
  private bootstrapManager: import("./bootstrap-manager").BootstrapManager | null = null;
  private compactionManager: import("./compaction-manager").CompactionManager | null = null;
  private lifecycleManager: import("./agent-lifecycle").AgentLifecycleManager | null = null;
  private queueManager: import("./queue-manager").QueueManager | null = null;
  private sessionManager: import("./session-manager").SessionManager | null = null;
  private contextEngine: import("./context-engine").ContextEngine | null = null;
  private pluginManager: import("@evoclaw/core").PluginManager | null = null;
  // ChannelManager integration — avoids cross-package import using any
  private channelManager: { getDMPolicy?: (...args: unknown[]) => unknown; getAllStatuses?: () => Array<unknown> } | null = null;

  /** Set memory hub for session/memory integration */
  setMemoryHub(hub: { getLongTerm(): { store(entry: import("@evoclaw/core").MemoryEntry): Promise<import("@evoclaw/core").MemoryEntry>; search(query: import("@evoclaw/core").MemorySearchQuery): Promise<import("@evoclaw/core").MemorySearchResult[]> } }): void {
    this.memoryHub = hub;
    console.log(`[AgentModelExecutor] Memory hub integrated`);
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

  private runIdCounter = 0;
  private workspacePath: string;
  private bootstrapFiles: Array<{ path: string; content: string }> = [];
  private _cachedSkillNames: Set<string> = new Set();
  
  private pendingOperations = new Map<string, { sessionId: string; message: string; requestId: string; toolName: string; toolArgs: Record<string, unknown> }>();
  private isProcessingQueue = false;

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
    this.compactionTokenThreshold = Math.floor((this.config.maxTokens || 4096) * 0.75);
    this.loadBootstrapFiles();
    registry.registerService("agentModelExecutor", this);
    this.setupEventListeners();
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
    if (!fs.existsSync(this.sessionDataDir)) {
      fs.mkdirSync(this.sessionDataDir, { recursive: true });
    }
    return path.join(this.sessionDataDir, `${sessionId}.jsonl`);
  }

  private persistSessionTurn(sessionId: string, role: string, content: string | null, metadata?: Record<string, unknown>): void {
    if (!this.sessionPersistenceEnabled) return;
    try {
      const filePath = this.sessionFilePath(sessionId);
      const entry = JSON.stringify({
        role,
        content,
        timestamp: new Date().toISOString(),
        ...(metadata || {}),
      });
      fs.appendFileSync(filePath, entry + "\n", "utf-8");
    } catch (err) {
      console.warn(`[AgentModelExecutor] Failed to persist session turn: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadSessionHistory(sessionId: string): Array<{ role: string; content: string | null }> {
    if (!this.sessionPersistenceEnabled) return [];
    try {
      const filePath = this.sessionFilePath(sessionId);
      if (!fs.existsSync(filePath)) return [];
      const data = fs.readFileSync(filePath, "utf-8");
      const lines = data.split("\n").filter((l) => l.trim());
      return lines.map((line) => {
        try {
          const entry = JSON.parse(line);
          return { role: entry.role, content: entry.content };
        } catch {
          return null;
        }
      }).filter((entry): entry is { role: string; content: string | null } => entry !== null);
    } catch (err) {
      console.warn(`[AgentModelExecutor] Failed to load session history: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private needsCompaction(sessionId: string, systemPrompt: string, maxTokens: number): boolean {
    if (!this.autoCompactionEnabled) return false;
    const history = this.conversationHistory.get(sessionId) || [];
    const systemTokens = estimateMessagesTokens([{ role: "system", content: systemPrompt }]);
    const historyTokens = estimateMessagesTokens(history.map((h) => ({ role: h.role, content: h.content })));
    const totalTokens = systemTokens + historyTokens;
    return totalTokens > this.compactionTokenThreshold;
  }

  private compactConversationHistory(sessionId: string, keepRecentTurns: number = 4): void {
    const history = this.conversationHistory.get(sessionId);
    if (!history || history.length <= keepRecentTurns * 2) return;

    const recentEntries = history.slice(-keepRecentTurns * 2);
    const olderEntries = history.slice(0, -(keepRecentTurns * 2));

    // Use CompactionManager if available for richer summary with successor transcripts
    let summary = "";
    let successorId = sessionId;
    if (this.compactionManager) {
      const compaction = this.compactionManager.buildSummary(
        sessionId,
        olderEntries.map((e) => ({ role: e.role, content: e.content })),
      );
      summary = this.compactionManager.buildSuccessorPrompt(compaction);
      successorId = compaction.successorSessionId;

      // Flush to long-term memory
      if (this.memoryHub) {
        const memEntry = this.compactionManager.buildMemoryEntry(compaction);
        const longTerm = this.memoryHub.getLongTerm();
        longTerm.store({
          content: memEntry.content,
          type: memEntry.type,
          metadata: {
            source: memEntry.metadata.source,
            sessionId,
            userId: "default",
            tags: memEntry.metadata.tags,
            importance: memEntry.metadata.importance,
            associations: [],
            entities: [],
          },
          ttl: 30 * 24 * 3600 * 1000,
          embedding: null,
          id: "",
          createdAt: new Date(),
          accessedAt: new Date(),
        }).catch((err) => console.warn(`[AgentModelExecutor] Memory flush failed: ${err}`));
      }

      // Emit lifecycle event
      if (this.lifecycleManager) {
        this.lifecycleManager.compacted(sessionId, olderEntries.length, successorId);
      }
    } else {
      // Fallback to simple compaction
      const userMessages = olderEntries
        .filter((e) => e.role === "user" && e.content)
        .map((e) => e.content as string);
      const assistantMessages = olderEntries
        .filter((e) => e.role === "assistant" && e.content)
        .map((e) => e.content as string);
      if (userMessages.length > 0 || assistantMessages.length > 0) {
        summary = `[Compacted ${olderEntries.length} turns. `;
        if (userMessages.length > 0) {
          summary += `User discussed: ${userMessages.map((m) => m.slice(0, 80)).join("; ")}. `;
        }
        if (assistantMessages.length > 0) {
          summary += `Assistant covered: ${assistantMessages.map((m) => m.slice(0, 80)).join("; ")}.`;
        }
        summary += "]";
      }
    }

    const compacted: Array<{ role: string; content: string | null }> = [
      { role: "system", content: summary || "[Previous conversation has been compacted.]" },
      ...recentEntries,
    ];

    this.conversationHistory.set(sessionId, compacted);
    console.log(`[AgentModelExecutor] Compacted session "${sessionId}" -> "${successorId}": ${olderEntries.length} older turns summarized, ${recentEntries.length} recent turns kept.`);

    // Fallback: Store compacted summary in long-term memory (only when CompactionManager not available, as it already handles this)
    if (!this.compactionManager && this.memoryHub && summary) {
      const longTerm = this.memoryHub.getLongTerm();
      longTerm.store({
        content: summary,
        type: "system",
        metadata: {
          source: "compaction",
          sessionId: sessionId,
          userId: "default",
          tags: ["conversation", "compacted"],
          importance: 0.6,
          associations: [],
          entities: [],
        },
        ttl: 30 * 24 * 3600 * 1000, // 30 days
        embedding: null,
        id: "",
        createdAt: new Date(),
        accessedAt: new Date(),
      }).catch((err) => console.warn(`[AgentModelExecutor] Failed to store compaction summary: ${err}`));
    }
  }

  private async onPermissionApproved(requestId: string): Promise<void> {
    const pending = this.pendingOperations.get(requestId);
    if (!pending) return;
    this.pendingOperations.delete(requestId);
    console.log(`[AgentModelExecutor] Permission approved for request "${requestId}". Notifying via event...`);
    this.eventBus.publish("permission.approved_fast", {
      requestId,
      sessionId: pending.sessionId,
      toolName: pending.toolName,
    }, "agent-model-executor");
  }

  /**
   * 权限批准快速通道：直接重新执行被阻塞的工具，不经过 LLM
   * 返回工具执行结果，由调用方直接反馈给用户
   */
  async approveAndExecute(requestId: string, addToWhitelist: boolean = true): Promise<{ success: boolean; reply: string; toolName?: string }> {
    const pending = this.pendingOperations.get(requestId);
    if (!pending) {
      return { success: false, reply: "⚠️ 未找到对应的权限请求，可能已过期或已处理。" };
    }
    this.pendingOperations.delete(requestId);

    console.log(`[AgentModelExecutor] approveAndExecute: re-executing tool "${pending.toolName}" for request "${requestId}"`);

    // 1. 先在 PermissionManager 中批准该操作（加入白名单，5分钟内同类操作自动通过）
    const permManager = this.registry?.resolveService<any>("permissionManager");
    if (permManager) {
      try {
        permManager.approveRequest(requestId, addToWhitelist);
      } catch (err) {
        console.warn(`[AgentModelExecutor] approveAndExecute: failed to approve in PermissionManager:`, err);
      }
    }

    // 2. 直接重新执行被阻塞的工具
    const toolEntry = this.registeredTools.get(pending.toolName);
    if (!toolEntry) {
      return { success: false, reply: `⚠️ 工具 "${pending.toolName}" 未找到，无法执行。`, toolName: pending.toolName };
    }

    try {
      const toolStartTime = Date.now();
      const rawResult = await toolEntry.handler(pending.toolArgs);
      const duration = Date.now() - toolStartTime;

      // 记录到 EventLedger
      const ledger = this.getEventLedger();
      if (ledger) {
        ledger.recordToolExecution(pending.toolName, pending.toolArgs, rawResult, duration, { agentId: "default", sessionId: pending.sessionId });
      }

      // 构建用户友好的反馈
      let resultText = "";
      if (rawResult && typeof rawResult === "object") {
        const r = rawResult as Record<string, unknown>;
        if (typeof r.content === "string") resultText = r.content;
        else if (typeof r.text === "string") resultText = r.text;
        else if (typeof r.message === "string") resultText = r.message;
        else resultText = JSON.stringify(rawResult);
      } else if (typeof rawResult === "string") {
        resultText = rawResult;
      } else {
        resultText = JSON.stringify(rawResult);
      }

      // 根据工具类型生成简洁的确认消息
      const toolLabelMap: Record<string, string> = {
        "file_create": "创建文件",
        "file_modify": "修改文件",
        "file_delete": "删除文件",
        "browser_navigate": "浏览器访问",
        "browser_submit_form": "提交表单",
        "skill_find_and_install": "安装技能",
        "email_add_account": "添加邮箱",
        "email_send": "发送邮件",
      };
      const toolLabel = toolLabelMap[pending.toolName] || pending.toolName;

      // 提取目标文件路径（如果有）
      const targetPath = (pending.toolArgs?.path as string) || (pending.toolArgs?.filePath as string) || (pending.toolArgs?.target as string) || "";
      const targetInfo = targetPath ? `: ${targetPath.split("/").pop() || targetPath.split("\\").pop() || targetPath}` : "";

      const reply = `✅ ${toolLabel}${targetInfo} 已完成\n\n${resultText.length > 2000 ? resultText.slice(0, 2000) + "\n...(结果已截断)" : resultText}`;

      console.log(`[AgentModelExecutor] approveAndExecute: tool "${pending.toolName}" executed successfully in ${duration}ms`);
      return { success: true, reply, toolName: pending.toolName };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[AgentModelExecutor] approveAndExecute: tool "${pending.toolName}" failed:`, errMsg);
      return { success: false, reply: `❌ 工具执行失败: ${errMsg}`, toolName: pending.toolName };
    }
  }

  /**
   * 权限拒绝快速通道：清理 pending 状态，返回拒绝确认
   */
  rejectPermission(requestId: string): { success: boolean; reply: string } {
    const pending = this.pendingOperations.get(requestId);
    if (!pending) {
      return { success: false, reply: "⚠️ 未找到对应的权限请求。" };
    }
    this.pendingOperations.delete(requestId);

    const permManager = this.registry?.resolveService<any>("permissionManager");
    if (permManager) {
      try {
        permManager.denyRequest(requestId);
      } catch (err) {
        console.warn(`[AgentModelExecutor] rejectPermission: failed to deny in PermissionManager:`, err);
      }
    }

    console.log(`[AgentModelExecutor] rejectPermission: request "${requestId}" rejected`);
    return { success: true, reply: "❌ 操作已取消。" };
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
    // Don't detect in search results or context messages
    if (message.includes("[系统") || message.includes("已为你搜索")) {
      return null;
    }

    const originalMsg = message;
    const lowerMsg = message.toLowerCase().trim();
    
    // Fix common typos in email domain
    let fixedMsg = lowerMsg
      .replace(/@163\.oom\b/gi, "@163.com")
      .replace(/@qq\.com\.+/gi, "@qq.com")
      .replace(/@gmail\.com\.+/gi, "@gmail.com")
      .replace(/\.oom\b/gi, ".com");

    let email: string | null = null;
    let password: string | null = null;
    let matched = false;

    // Pattern 1: Chinese format with "邮箱账号" or "邮箱地址"
    // Example: "邮箱账号chydroid@163.com 授权码：DCq4QHXN46bMPCc9"
    const accountPrefixPattern = /(?:邮箱账号|邮箱地址|账号)(?:[:：]\s*)?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
    const accountPrefixMatch = originalMsg.match(accountPrefixPattern);
    
    // Pattern 2: Direct email with auth code
    // Example: "chydroid@163.com 授权码：DCq4QHXN46bMPCc9"
    const authCodePattern = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s*(?:授权码|密码|password)[:：]\s*([a-zA-Z0-9a-zA-Z]{10,})/i;
    const authCodeMatch = fixedMsg.match(authCodePattern);
    
    // Pattern 3: Key-value format
    // Example: "邮箱: xxx@xxx.com, 授权码: xxxxx"
    const kvPattern = /(?:邮箱(?:地址)?|email)\s*[:：]\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})[^a-zA-Z0-9]*?(?:授权码|密码|password)\s*[:：]\s*([a-zA-Z0-9a-zA-Z]{6,})/i;
    const kvMatch = originalMsg.match(kvPattern);
    
    // Pattern 4: Simple format "email password"
    // Example: "test@163.com MyPassword123"
    const simplePattern = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s+([a-zA-Z0-9a-zA-Z!@#$%]{6,32})(?:\s|$)/i;
    const simpleMatch = fixedMsg.match(simplePattern);

    // Extract email and password
    if (authCodeMatch) {
      email = authCodeMatch[1];
      password = authCodeMatch[2];
      matched = true;
    } else if (kvMatch) {
      email = kvMatch[1];
      password = kvMatch[2];
      matched = true;
    } else if (simpleMatch) {
      email = simpleMatch[1];
      password = simpleMatch[2];
      matched = true;
    }

    if (!matched || !email || !password) {
      return null;
    }
    
    // Detect email provider from message
    const detectProvider = (msg: string): string => {
      if (msg.includes("163") || /@163\.com$/i.test(msg)) return "163";
      if (msg.includes("qq") || /@qq\.com$/i.test(msg)) return "qq";
      if (msg.includes("126") || /@126\.com$/i.test(msg)) return "126";
      if (msg.includes("gmail") || /@gmail\.com$/i.test(msg)) return "gmail";
      if (msg.includes("outlook") || /@outlook\.(com|org)$/i.test(msg)) return "outlook";
      if (msg.includes("189") || /@189\.cn$/i.test(msg)) return "189";
      if (msg.includes("yahoo") || /@yahoo\.(com|cn)$/i.test(msg)) return "yahoo";
      return "163"; // Default to 163 for Chinese email
    };
    
    console.log(`[AgentModelExecutor] Detected email account configuration: ${email}, password length: ${password.length}`);
    
    const provider = detectProvider(message);
    const displayName = email.split("@")[0];
    
    // Check if email_add_account tool is registered
    if (!this.registeredTools.has("email_add_account")) {
      return {
        reply: `检测到您提供了邮箱账号：${email}\n\n但系统尚未注册邮箱功能。请联系管理员配置邮箱功能。`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }
    
    // Use TaskClassifier to verify this is an email operation
    const taskClassifier = this.registry?.resolveService<{
      classify(task: string): { primaryCategory: string; confidence: number };
    }>("taskClassifier");
    
    if (taskClassifier) {
      try {
        const result = taskClassifier.classify(message);
        // If the primary category is not email_handling, we might have false positive
        // But since we detected email credentials, we should still proceed
        console.log(`[AgentModelExecutor] Email config intent classification: ${result.primaryCategory} (confidence: ${result.confidence})`);
      } catch {
        // Ignore classification errors
      }
    }
    
    // Try to add the email account
    try {
      const emailTool = this.registeredTools.get("email_add_account")!;
      const result = await emailTool.handler({
        email,
        password,
        provider,
        displayName,
      });
      
      const resultObj = typeof result === "object" && result !== null ? result as Record<string, unknown> : null;
      
      if (resultObj?.success) {
        return {
          reply: `✅ 邮箱账号配置成功！\n\n📧 已添加邮箱：${email}\n🏢 邮箱类型：${provider}\n👤 显示名称：${displayName}\n\n现在您可以使用"帮我整理邮件"来整理您的邮箱了！`,
          tokensUsed: 0,
          duration: 0,
          permissionRequests: [],
          toolsExecuted: false,
        };
      } else if (resultObj?.requiresPermission) {
        // Permission is needed, return with pending permission request
        return {
          reply: `检测到您提供了邮箱账号，正在请求授权添加...\n\n📧 邮箱：${email}\n🏢 类型：${provider}`,
          tokensUsed: 0,
          duration: 0,
          permissionRequests: [{
            id: (resultObj.requestId as string) || (resultObj.id as string) || "email-config",
            operation: "email_add_account",
            description: `添加邮箱账号: ${email}`,
            target: email,
          }],
          toolsExecuted: false,
        };
      } else {
        return {
          reply: `⚠️ 邮箱账号配置遇到问题：${resultObj?.error || "未知错误"}\n\n请检查邮箱地址和密码是否正确。`,
          tokensUsed: 0,
          duration: 0,
          permissionRequests: [],
          toolsExecuted: false,
        };
      }
    } catch (err) {
      return {
        reply: `❌ 邮箱账号配置失败：${err instanceof Error ? err.message : String(err)}`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }
  }

  /**
   * Handle email inbox operations: list emails, summarize, analyze
   * This is called when the task classifier detects email_handling intent
   */
  private async handleEmailOperation(message: string): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean } | null> {
    const lowerMsg = message.toLowerCase();

    // Check if this is an email operation
    const emailKeywords = [
      "整理邮件", "整理邮箱", "查看邮件", "读取邮件", "邮件摘要",
      "统计邮件", "生成邮件报告", "邮件报告", "收件箱", "未读邮件",
      "批量处理邮件", "清理邮箱", "整理所有邮件"
    ];

    const sendEmailKeywords = ["发邮件", "发送邮件", "给", "发信", "写信", "发一封", "发e-mail", "发email"];
    const isSendEmailOp = sendEmailKeywords.some(kw => lowerMsg.includes(kw)) && /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(message);
    const isEmailOp = emailKeywords.some(kw => lowerMsg.includes(kw)) || isSendEmailOp;

    if (!isEmailOp) {
      return null;
    }

    // ── Send email branch ──
    if (isSendEmailOp) {
      if (!this.registeredTools.has("email_send")) {
        return {
          reply: `检测到您想发送邮件，但系统尚未配置邮箱发送功能。\n\n请先提供您的邮箱账号信息，例如：\n📧 邮箱账号：yourname@163.com\n🔑 授权码：您的授权码`,
          tokensUsed: 0,
          duration: 0,
          permissionRequests: [],
          toolsExecuted: false,
        };
      }

      // Extract recipient email
      const emailMatch = message.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (!emailMatch) {
        return {
          reply: `请提供收件人邮箱地址，例如：\n给 156231056@qq.com 发邮件，内容是我最近很忙`,
          tokensUsed: 0,
          duration: 0,
          permissionRequests: [],
          toolsExecuted: false,
        };
      }
      const toEmail = emailMatch[1];

      // Extract subject / body from message
      // Patterns:
      // "给 xxx 发邮件，内容是 ..."
      // "发邮件给 xxx，告诉他 ..."
      // "给 xxx 发邮件，主题是 ...，内容是 ..."
      let subject = "";
      let body = "";

      const contentPatterns = [
        /(?:内容|正文|body)[:：]\s*(.+)/i,
        /(?:告诉他|告诉她|说|写|内容)(?:[:：])?\s*(.+)/i,
        /(?:发邮件|发信|写信).*?(?:[,，])\s*(.+)/i,
      ];

      for (const pattern of contentPatterns) {
        const m = message.match(pattern);
        if (m && m[1]) {
          body = m[1].trim();
          break;
        }
      }

      // Clean up noise after extraction: strip leading "是", "想" etc.
      if (body) {
        body = body.replace(/^(是|想|说)[，,。.]?\s*/i, "").trim();
      }

      const subjectPatterns = [
        /(?:主题|标题|subject)[:：]\s*(.+?)(?:[,，]|内容|正文|body)/i,
        /(?:主题|标题|subject)[:：]\s*(.+)/i,
      ];

      for (const pattern of subjectPatterns) {
        const m = message.match(pattern);
        if (m && m[1]) {
          subject = m[1].trim();
          break;
        }
      }

      // If no explicit subject, generate one from body
      if (!subject && body) {
        subject = body.slice(0, 30) + (body.length > 30 ? "..." : "");
      }

      // If still no body, use the whole message after the email as body
      if (!body) {
        const afterEmail = message.slice(message.indexOf(toEmail) + toEmail.length);
        body = afterEmail.replace(/^(\s*[,，]\s*|\s*)/, "").replace(/^(发邮件|发信|写信|，|,)/, "").trim();
      }

      if (!body) {
        return {
          reply: `请提供邮件内容，例如：\n给 ${toEmail} 发邮件，内容是我最近很忙，一直在写EvoClaw`,
          tokensUsed: 0,
          duration: 0,
          permissionRequests: [],
          toolsExecuted: false,
        };
      }

      // Get first available account
      let accountsResult: unknown;
      try {
        const accountsTool = this.registeredTools.get("email_list_accounts")!;
        accountsResult = await accountsTool.handler({});
      } catch (err) {
        return {
          reply: `❌ 获取邮箱账号失败：${err instanceof Error ? err.message : String(err)}`,
          tokensUsed: 0,
          duration: 0,
          permissionRequests: [],
          toolsExecuted: false,
        };
      }

      const accountsData = accountsResult as { success: boolean; accounts?: Array<{ id: string; email: string }> };
      if (!accountsData?.success || !accountsData.accounts?.length) {
        return {
          reply: `📭 您还没有配置任何邮箱账号，无法发送邮件。\n\n请先提供邮箱信息，例如：\n📧 邮箱账号：yourname@163.com\n🔑 授权码：您的授权码`,
          tokensUsed: 0,
          duration: 0,
          permissionRequests: [],
          toolsExecuted: false,
        };
      }

      const accountId = accountsData.accounts[0].id;

      // Call email_send tool
      try {
        const sendTool = this.registeredTools.get("email_send")!;
        const sendResult = await sendTool.handler({
          accountId,
          to: toEmail,
          subject: subject || "无主题",
          body,
        });
        const sendData = sendResult as { success: boolean; messageId?: string; accepted?: string[]; error?: string };
        if (sendData?.success) {
          return {
            reply: `✅ 邮件发送成功！\n\n📧 收件人：${toEmail}\n📌 主题：${subject || "无主题"}\n📝 内容：${body}\n\n邮件已通过 ${accountsData.accounts[0].email} 发送。`,
            tokensUsed: 0,
            duration: 0,
            permissionRequests: [],
            toolsExecuted: false,
          };
        } else {
          return {
            reply: `❌ 邮件发送失败：${sendData?.error || "未知错误"}\n\n请检查邮箱配置和网络连接。`,
            tokensUsed: 0,
            duration: 0,
            permissionRequests: [],
            toolsExecuted: false,
          };
        }
      } catch (err) {
        return {
          reply: `❌ 邮件发送失败：${err instanceof Error ? err.message : String(err)}`,
          tokensUsed: 0,
          duration: 0,
          permissionRequests: [],
          toolsExecuted: false,
        };
      }
    }

    // Check if email tools are available
    if (!this.registeredTools.has("email_list_accounts")) {
      return {
        reply: `检测到您想进行邮件操作，但系统尚未配置邮箱功能。\n\n请先提供您的邮箱账号信息，例如：\n📧 邮箱账号：yourname@163.com\n🔑 授权码：您的授权码`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }

    // List accounts first
    let accountsResult: unknown;
    try {
      const accountsTool = this.registeredTools.get("email_list_accounts")!;
      accountsResult = await accountsTool.handler({});
    } catch (err) {
      return {
        reply: `❌ 获取邮箱账号列表失败：${err instanceof Error ? err.message : String(err)}`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }

    const accountsData = accountsResult as { success: boolean; accounts?: unknown[] };
    if (!accountsData?.success || !accountsData.accounts?.length) {
      return {
        reply: `📭 您还没有配置任何邮箱账号。\n\n请先提供邮箱信息，例如：\n📧 邮箱账号：yourname@163.com\n🔑 授权码：您的授权码`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }

    // Get inbox summary
    if (!this.registeredTools.has("email_get_inbox_summary")) {
      return {
        reply: `⚠️ 邮箱功能未完整配置，无法读取收件箱。请联系管理员。`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }

    let summaryResult: unknown;
    try {
      const summaryTool = this.registeredTools.get("email_get_inbox_summary")!;
      summaryResult = await summaryTool.handler({});
    } catch (err) {
      return {
        reply: `❌ 获取收件箱摘要失败：${err instanceof Error ? err.message : String(err)}`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }

    const summaryData = summaryResult as { success: boolean; summary?: { total: number; unread: number; categories: Record<string, number> }; error?: string };
    if (!summaryData?.success) {
      return {
        reply: `❌ 无法获取邮箱摘要：${summaryData?.error || "未知错误"}\n\n可能是邮箱账号配置有误或网络连接问题。`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }

    const { total, unread, categories } = summaryData.summary!;

    // List recent emails
    let emails: unknown[] = [];
    if (this.registeredTools.has("email_list_inbox")) {
      try {
        const inboxTool = this.registeredTools.get("email_list_inbox")!;
        const inboxResult = await inboxTool.handler({ limit: 20 });
        const inboxData = inboxResult as { success: boolean; emails?: unknown[] };
        if (inboxData?.success && inboxData.emails) {
          emails = inboxData.emails;
        }
      } catch {
        // Ignore errors
      }
    }

    // Generate report
    const now = new Date();
    const reportTime = now.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    let report = `📬 邮箱整理报告\n`;
    report += `━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    report += `📅 生成时间：${reportTime}\n\n`;
    report += `📊 收件箱概览：\n`;
    report += `• 总邮件数：${total} 封\n`;
    report += `• 未读邮件：${unread} 封\n\n`;

    report += `📁 邮件分类统计：\n`;
    for (const [category, count] of Object.entries(categories)) {
      if (count > 0) {
        report += `• ${category}：${count} 封\n`;
      }
    }

    if (emails.length > 0) {
      report += `\n📋 最近邮件：\n`;
      for (let i = 0; i < Math.min(emails.length, 10); i++) {
        const email = emails[i] as { subject: string; from: string; date: Date; snippet: string };
        const date = email.date instanceof Date ? email.date.toLocaleDateString("zh-CN") : new Date(email.date).toLocaleDateString("zh-CN");
        report += `\n${i + 1}. ${email.subject || "(无主题)"}\n`;
        report += `   📤 发件人：${email.from || "未知"}\n`;
        report += `   📅 日期：${date}\n`;
        if (email.snippet) {
          report += `   📝 预览：${email.snippet.substring(0, 100)}...\n`;
        }
      }
    }

    report += `\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
    report += `✅ 邮件整理完成！`;

    return {
      reply: report,
      tokensUsed: 0,
      duration: 0,
      permissionRequests: [],
      toolsExecuted: false,
    };
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

  buildSystemPrompt(promptMode?: PromptMode, context?: { skillsPrompt?: string; workspacePath?: string; bootstrapFiles?: Array<{ path: string; content: string }> }): string {
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
      `您好${this.persona.masterTerm}！我是 ${this.persona.name}，${this.persona.title} 🦞`,
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
    } else {
      this.conversationHistory.clear();
    }
  }

  getChatHistory(sessionId: string): Array<{ role: string; content: string | null }> {
    const history = this.conversationHistory.get(sessionId) || [];
    return history.map((h) => ({ role: h.role, content: h.content }));
  }

  getRegisteredTools(): ToolDefinition[] {
    return Array.from(this.registeredTools.values()).map((t) => t.definition);
  }

  private static collapseNewlines(text: string): string {
    return text
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "")
      .trim();
  }

  static stripWebNoise(input: string): string {
    if (!input || input.length < 20) return input;
    const originalLen = input.length;

    let text = input;

    if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
      text = AgentModelExecutor._compactJson(text);
    } else if (/<[a-zA-Z][^>]*>/.test(text)) {
      text = AgentModelExecutor._stripHtml(text);
    }

    text = AgentModelExecutor._filterPlainText(text);

    text = AgentModelExecutor._normalizeUrls(text);

    text = AgentModelExecutor._groupSimilarLines(text);

    text = AgentModelExecutor._deduplicateLines(text);

    text = AgentModelExecutor._extractCodeSignatures(text);

    text = AgentModelExecutor._smartTruncate(text, 8000);

    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/\n[ \t]+/g, "\n");
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.trim();

    if (originalLen > 200 && text.length < originalLen * 0.95) {
      const savedPct = Math.round((1 - text.length / originalLen) * 100);
      console.debug(`[stripWebNoise] ${originalLen} → ${text.length} chars (saved ${savedPct}%)`);
    }

    return text;
  }

  private static _stripHtml(input: string): string {
    let text = input;

    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");
    text = text.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "");
    text = text.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, "");
    text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");
    text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
    text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
    text = text.replace(/<form[^>]*>[\s\S]*?<\/form>/gi, "");
    text = text.replace(/<button[^>]*>[\s\S]*?<\/button>/gi, "");
    text = text.replace(/<input[^>]*\/?>/gi, "");
    text = text.replace(/<select[^>]*>[\s\S]*?<\/select>/gi, "");
    text = text.replace(/<textarea[^>]*>[\s\S]*?<\/textarea>/gi, "");
    text = text.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "");

    text = text.replace(/\bclass\s*=\s*["'][^"']*["']/gi, "");
    text = text.replace(/\bid\s*=\s*["'][^"']*["']/gi, "");
    text = text.replace(/\bstyle\s*=\s*["'][^"']*["']/gi, "");
    text = text.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, "");
    text = text.replace(/\bdata-\w+\s*=\s*["'][^"']*["']/gi, "");
    text = text.replace(/\bhref\s*=\s*["']javascript:[^"']*["']/gi, "");
    text = text.replace(/\btarget\s*=\s*["'][^"']*["']/gi, "");
    text = text.replace(/\brel\s*=\s*["'][^"']*["']/gi, "");
    text = text.replace(/\brole\s*=\s*["'][^"']*["']/gi, "");
    text = text.replace(/\baria-\w+\s*=\s*["'][^"']*["']/gi, "");

    text = text.replace(/<\/?(?:div|span|section|article|main|figure|figcaption|details|summary|time|mark|small|strong|em|b|i|u|sub|sup|abbr|cite|dfn|kbd|samp|var|address|blockquote|pre|code|dl|dt|dd|ol|ul|li|table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col|form|input|button|select|option|textarea|label|fieldset|legend)\b[^>]*>/gi, (match) => {
      if (/^<\/?(?:p|h[1-6]|div|li|tr|blockquote|pre|dt|dd)\b/i.test(match)) return "\n";
      return "";
    });

    text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
      const prefix = "#".repeat(parseInt(level));
      return `\n${prefix} ${content.trim()}\n`;
    });
    text = text.replace(/<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
      const label = content.replace(/<[^>]+>/g, "").trim();
      return label && href && !href.startsWith("#") ? `[${label}](${href})` : label;
    });
    text = text.replace(/<img[^>]*alt\s*=\s*["']([^"']*)["'][^>]*\/?>/gi, (_, alt) => alt ? `[图片: ${alt}]` : "");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

    text = text.replace(/<[^>]+>/g, "");

    text = text.replace(/&amp;/g, "&");
    text = text.replace(/&lt;/g, "<");
    text = text.replace(/&gt;/g, ">");
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&nbsp;/g, " ");
    text = text.replace(/&#\d+;/g, "");
    text = text.replace(/&\w+;/g, "");

    text = text.replace(/\{[^}]*(?:color|background|font|margin|padding|border|display|position|width|height|overflow|flex|grid|align|justify|gap|opacity|z-index|transition|animation|transform|box-shadow|text-shadow|cursor|outline|visibility|float|clear|content|list-style|white-space|word-break|line-height|letter-spacing|vertical-align)[^}]*\}/gi, "");

    const codeBlockPlaceholders: string[] = [];
    text = text.replace(/```[\s\S]*?```/g, (match) => {
      codeBlockPlaceholders.push(match);
      return `\x00CODEBLOCK${codeBlockPlaceholders.length - 1}\x00`;
    });

    text = text.replace(/\/\/[^\n]*$/gm, "");
    text = text.replace(/\/\*[\s\S]*?\*\//g, "");
    text = text.replace(/\b(function|var|let|const|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|this|class|extends|import|export|default|from|async|await|yield|typeof|instanceof|void|delete|in|of)\b[^;{}]*[;{}]/g, "");
    text = text.replace(/\b(window|document|console|navigator|localStorage|sessionStorage|fetch|XMLHttpRequest|addEventListener|querySelector|getElementById|createElement|appendChild|removeChild|setAttribute|getAttribute|classList|innerHTML|textContent|innerText|style|dataset)\b\.?\w*\s*[\(\[=;{]/g, "");

    text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => codeBlockPlaceholders[parseInt(idx)] || "");

    text = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    text = text.replace(/\u200B|\u200C|\u200D|\uFEFF/g, "");

    return text;
  }

  private static _compactJson(input: string): string {
    try {
      const obj = JSON.parse(input);
      return AgentModelExecutor._compactJsonValue(obj, 0);
    } catch {
      let text = input;
      text = text.replace(/"[^"]*"\s*:\s*"[^"]{200,}"/g, (match) => {
        const colonIdx = match.indexOf(":");
        const key = match.slice(0, colonIdx).trim();
        return `${key}: "..."`;
      });
      text = text.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{50,}/g, "data:image/[base64-truncated]");
      return text;
    }
  }

  private static _compactJsonValue(obj: unknown, depth: number): string {
    if (obj === null || obj === undefined) return String(obj);
    if (typeof obj === "string") {
      if (obj.length > 500 && (obj.includes("<") && obj.includes(">"))) {
        return JSON.stringify(AgentModelExecutor._stripHtml(obj).slice(0, 300) + "...");
      }
      if (obj.length > 2000) {
        const truncated = AgentModelExecutor._smartTruncateString(obj, 200);
        return JSON.stringify(truncated + `...[truncated ${obj.length} chars]`);
      }
      return JSON.stringify(obj);
    }
    if (typeof obj === "number" || typeof obj === "boolean") return String(obj);

    if (Array.isArray(obj)) {
      if (obj.length === 0) return "[]";
      if (obj.length > 10) {
        const sample = obj.slice(0, 3).map(v => AgentModelExecutor._compactJsonValue(v, depth + 1));
        return `[\n  ${sample.join(",\n  ")},\n  ... /* ${obj.length - 3} more items */\n]`;
      }
      const items = obj.map(v => AgentModelExecutor._compactJsonValue(v, depth + 1));
      return `[\n  ${items.join(",\n  ")}\n]`;
    }

    if (typeof obj === "object") {
      const record = obj as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length === 0) return "{}";

      const skipKeys = new Set([
        "css", "styles", "style", "class", "className", "id", "onclick",
        "script", "javascript", "html", "rawHtml", "innerHTML",
        "tracking", "analytics", "ads", "advertisement", "cookie",
        "favicon", "icon", "logo", "thumbnail", "avatar", "banner",
        "sidebar", "footer", "header", "nav", "menu", "breadcrumb",
      ]);

      const entries: string[] = [];
      for (const key of keys) {
        if (skipKeys.has(key.toLowerCase())) continue;
        const val = record[key];
        if (val === null || val === undefined || val === "") continue;
        if (typeof val === "string" && val.length > 2000) {
          const truncated = AgentModelExecutor._smartTruncateString(val, 200);
          entries.push(`  ${JSON.stringify(key)}: ${JSON.stringify(truncated + "...[truncated]")}`);
        } else if (typeof val === "object" && val !== null) {
          entries.push(`  ${JSON.stringify(key)}: ${AgentModelExecutor._compactJsonValue(val, depth + 1)}`);
        } else {
          entries.push(`  ${JSON.stringify(key)}: ${JSON.stringify(val)}`);
        }
      }
      return `{\n${entries.join(",\n")}\n}`;
    }

    return String(obj);
  }

  private static _smartTruncateString(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;

    const repeatMatch = str.match(/^(.{1,20})\1{4,}$/);
    if (repeatMatch) {
      return repeatMatch[1].slice(0, Math.min(50, repeatMatch[1].length));
    }

    const sentenceBreakers = /[。！？.!?\n]/;
    let cutPos = maxLen;
    for (let i = maxLen; i > Math.floor(maxLen * 0.6) && i > 0; i--) {
      if (sentenceBreakers.test(str[i])) {
        cutPos = i + 1;
        break;
      }
    }
    return str.slice(0, cutPos);
  }

  private static _filterPlainText(text: string): string {
    let result = text;

    result = result.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

    result = result.replace(/\[=+\]\s*\d*%?/g, "");
    result = result.replace(/\[[.#*\-]+\]\s*\d*%?/g, "");

    result = result.replace(/[=\-#*~]{5,}/g, "");

    result = result.replace(/[█▓▒░]{3,}/g, "");

    result = result.replace(/(?:accept\s+cookies|we\s+use\s+cookies|this\s+site\s+uses\s+cookies|cookie\s+policy|privacy\s+preferences|manage\s+preferences|do\s+not\s+sell\s+my|california\s+consumer|gdpr|consent\s+to\s+.*?cookies|by\s+continuing\s+to\s+use|by\s+clicking\s+accept|our\s+privacy\s+policy|terms\s+of\s+service|subscribe\s+to\s+our\s+newsletter|sign\s+up\s+for\s+our|enter\s+your\s+email|get\s+notified|follow\s+us\s+on|share\s+this\s+article|related\s+articles|you\s+may\s+also\s+like|recommended\s+for\s+you|trending\s+now|popular\s+posts|advertisement|sponsored\s+content|paid\s+partnership)[\s\S]*?(?:\n|$)/gi, "");

    result = result.replace(/(?:接受cookie|我们使用cookie|本站使用cookie|cookie政策|隐私偏好|管理偏好|不要出售我的|消费者隐私|订阅我们的|注册获取|输入您的邮箱|关注我们|分享本文|相关文章|您可能还喜欢|为您推荐|热门文章|广告|赞助内容|付费合作)[\s\S]*?(?:\n|$)/gi, "");

    result = result.replace(/^\s*(?:share|tweet|pin|like|follow|email\s*this|print)\s*$/gim, "");

    result = result.replace(/^\s*(?:分享|推特|点赞|关注|邮件|打印)\s*$/gim, "");

    result = result.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?\s*(?:ET|PT|CT|MT|GMT|UTC|CST|EST|PST)\b/g, "");

    result = result.replace(/^\s*(?:loading|please\s+wait|just\s+a\s+moment|one\s+moment|loading\.\.\.|loading\.\.\.\s*please\s+wait)\s*$/gim, "");

    result = result.replace(/^\s*(?:加载中|请稍候|稍等|正在加载|加载中\.\.\.\s*请稍候|加载中\.\.\.)\s*$/gim, "");

    result = result.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{20,}/g, "[image-data-removed]");

    return result;
  }

  private static _normalizeUrls(text: string): string {
    const strictTrackingParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "fbclid", "gclid", "gclsrc", "dclid", "msclkid",
      "mc_eid", "mc_cid", "_ga", "_gl", "_hsenc", "_hsmi", "_openstat",
      "vero_id", "oly_anon_id", "oly_enc_id", "otc", "igshid",
      "wickedid", "twclid", "ttclid", "li_fat_id",
    ];
    const strictPattern = new RegExp(
      `[?&](?:${strictTrackingParams.join("|")})=[^&\\s#]+`, "gi"
    );
    let result = text.replace(strictPattern, "");

    const contextTrackingParams = ["spm", "from", "ref", "referrer", "source", "share"];
    const contextPattern = new RegExp(
      `[?&](?:${contextTrackingParams.join("|")})=([^&\\s#]+)`, "gi"
    );
    result = result.replace(contextPattern, (match, val) => {
      const v = val.toLowerCase();
      const businessValues = ["api", "embed", "direct", "app", "cli", "sdk", "web", "desktop",
        "mobile", "internal", "oauth", "callback", "webhook", "feed", "rss", "atom"];
      if (businessValues.some(bv => v === bv)) return match;
      const shortValues = ["nav", "footer", "header", "sidebar", "banner", "popup", "modal",
        "tooltip", "notification", "email", "social", "twitter", "facebook", "wechat",
        "weibo", "linkedin", "reddit", "hackernews", "newsletter", "blog", "article",
        "search", "google", "bing", "baidu", "organic", "cpc", "paid", "affiliate"];
      if (shortValues.some(sv => v.includes(sv))) return "";
      return "";
    });

    result = result.replace(/\?[&]+/g, "?");
    result = result.replace(/\?(\s|$)/g, "$1");
    result = result.replace(/&{2,}/g, "&");
    result = result.replace(/[?&]\s*$/gm, "");
    return result;
  }

  private static _groupSimilarLines(text: string): string {
    const lines = text.split("\n");
    if (lines.length < 8) return text;

    const errorPattern = /^(?:error|warning|fail|exception|err|错误|警告|异常)\s*[:：]\s*(.+)$/i;
    const logPattern = /^(\d{4}[-/]\d{2}[-/]\d{2}[\sT]\d{2}:\d{2}(:\d{2})?)\s+\[?(\w+)\]?\s+(.+)$/;

    const groups: Map<string, { pattern: string; count: number; example: string; firstOutput: boolean }> = new Map();
    const result: string[] = [];
    let inGroup = false;
    let groupKey = "";

    const flushGroup = () => {
      if (!inGroup) return;
      const g = groups.get(groupKey);
      if (g && g.count > 1) {
        result.push(g.example);
        result.push(`  ... (${g.count} similar ${g.pattern} messages)`);
      } else if (g && g.count === 1) {
        result.push(g.example);
      }
      groups.delete(groupKey);
      inGroup = false;
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        flushGroup();
        result.push("");
        continue;
      }

      const errorMatch = trimmed.match(errorPattern);
      if (errorMatch) {
        const msgBody = errorMatch[1].replace(/\d+/g, "N").replace(/['"][^'"]+['"]/g, "'...'").slice(0, 60);
        const key = `error:${msgBody}`;
        const existing = groups.get(key);
        if (existing) {
          existing.count++;
          inGroup = true;
          groupKey = key;
          continue;
        } else {
          flushGroup();
          groups.set(key, { pattern: "error/warning", count: 1, example: trimmed, firstOutput: true });
          inGroup = true;
          groupKey = key;
          continue;
        }
      }

      const logMatch = trimmed.match(logPattern);
      if (logMatch) {
        const level = logMatch[3];
        const msgBody = logMatch[4].replace(/\d+/g, "N").replace(/['"][^'"]+['"]/g, "'...'").slice(0, 60);
        const key = `log:${level}:${msgBody}`;
        const existing = groups.get(key);
        if (existing) {
          existing.count++;
          inGroup = true;
          groupKey = key;
          continue;
        } else {
          flushGroup();
          groups.set(key, { pattern: `${level} log`, count: 1, example: trimmed, firstOutput: true });
          inGroup = true;
          groupKey = key;
          continue;
        }
      }

      flushGroup();
      result.push(line);
    }

    flushGroup();

    const phase1 = result.join("\n");
    const phase1Lines = phase1.split("\n");

    const globalGroups: Map<string, { pattern: string; count: number; example: string; lineIndices: number[] }> = new Map();
    for (let i = 0; i < phase1Lines.length; i++) {
      const trimmed = phase1Lines[i].trim();
      if (!trimmed) continue;

      const errM = trimmed.match(errorPattern);
      if (errM) {
        const msgBody = errM[1].replace(/\d+/g, "N").replace(/['"][^'"]+['"]/g, "'...'").slice(0, 60);
        const key = `gerror:${msgBody}`;
        const g = globalGroups.get(key);
        if (g) { g.count++; g.lineIndices.push(i); }
        else globalGroups.set(key, { pattern: "error/warning", count: 1, example: trimmed, lineIndices: [i] });
        continue;
      }

      const logM = trimmed.match(logPattern);
      if (logM) {
        const level = logM[3];
        const msgBody = logM[4].replace(/\d+/g, "N").replace(/['"][^'"]+['"]/g, "'...'").slice(0, 60);
        const key = `glog:${level}:${msgBody}`;
        const g = globalGroups.get(key);
        if (g) { g.count++; g.lineIndices.push(i); }
        else globalGroups.set(key, { pattern: `${level} log`, count: 1, example: trimmed, lineIndices: [i] });
        continue;
      }
    }

    const linesToRemove = new Set<number>();
    const globalInserts: Map<number, string[]> = new Map();
    for (const [, g] of globalGroups) {
      if (g.count >= 3) {
        const firstIdx = g.lineIndices[0];
        for (let j = 1; j < g.lineIndices.length; j++) {
          linesToRemove.add(g.lineIndices[j]);
        }
        if (!globalInserts.has(firstIdx)) globalInserts.set(firstIdx, []);
        globalInserts.get(firstIdx)!.push(`  ... [global] ${g.count} similar ${g.pattern} messages across sections`);
      }
    }

    if (linesToRemove.size > 0) {
      const finalLines: string[] = [];
      for (let i = 0; i < phase1Lines.length; i++) {
        if (linesToRemove.has(i)) continue;
        const inserts = globalInserts.get(i);
        if (inserts) {
          finalLines.push(phase1Lines[i]);
          finalLines.push(...inserts);
        } else {
          finalLines.push(phase1Lines[i]);
        }
      }
      return finalLines.join("\n");
    }

    return phase1;
  }

  private static _extractCodeSignatures(text: string): string {
    const codeBlockPattern = /```(\w*)\n([\s\S]*?)```/g;
    let result = text;

    result = result.replace(codeBlockPattern, (match, lang, code) => {
      const lines = code.split("\n");

      const langThresholds: Record<string, number> = {
        python: 25, py: 25,
        rust: 25, rs: 25,
        go: 25,
        java: 25,
        kotlin: 25, kt: 25,
        scala: 25,
        c: 25, cpp: 25, cxx: 25, h: 25,
        typescript: 20, ts: 20, tsx: 20,
        javascript: 20, js: 20, jsx: 20,
        ruby: 20, rb: 20,
        php: 20,
        sql: 20,
        shell: 15, bash: 15, sh: 15, zsh: 15,
        yaml: 15, yml: 15,
        json: 15,
        xml: 15,
        html: 15,
        css: 15, scss: 15, less: 15,
      };
      const threshold = langThresholds[lang.toLowerCase()] || 20;
      if (lines.length <= threshold) return match;

      const signatures: { start: number; end: number }[] = [];
      let braceDepth = 0;
      let sigStart = -1;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        const openBraces = (line.match(/\{/g) || []).length;
        const closeBraces = (line.match(/\}/g) || []).length;

        const isSignatureStart = openBraces > 0 ||
          /^(?:export\s+)?(?:function|class|interface|type|enum|const|let|var|def|async|pub\s+fn|fn|impl|mod|struct|trait|public|private|protected|static)\s/.test(trimmed) ||
          /^(?:def|class|async\s+def)\s/.test(trimmed);

        if (sigStart === -1 && isSignatureStart && braceDepth === 0) {
          sigStart = i;
        }

        if (sigStart !== -1) {
          braceDepth += openBraces - closeBraces;
          if (braceDepth <= 0 && openBraces > 0) {
            signatures.push({ start: sigStart, end: i + 1 });
            sigStart = -1;
            braceDepth = 0;
          }
        }
      }

      if (sigStart !== -1) {
        signatures.push({ start: sigStart, end: Math.min(sigStart + 5, lines.length) });
      }

      const maxSigs = 3;
      const keptSigs = signatures.slice(0, maxSigs);
      if (keptSigs.length === 0) return match;

      const keptRanges: Set<number> = new Set();
      for (const sig of keptSigs) {
        for (let i = sig.start; i < sig.end; i++) keptRanges.add(i);
      }

      const tailCount = 3;
      for (let i = Math.max(0, lines.length - tailCount); i < lines.length; i++) {
        keptRanges.add(i);
      }

      keptRanges.add(0);

      const outputLines: string[] = [];
      let inOmitted = false;
      let omittedCount = 0;

      for (let i = 0; i < lines.length; i++) {
        if (keptRanges.has(i)) {
          if (inOmitted) {
            outputLines.push(`  // ... ${omittedCount} lines omitted ...`);
            inOmitted = false;
            omittedCount = 0;
          }
          outputLines.push(lines[i]);
        } else {
          omittedCount++;
          if (!inOmitted) inOmitted = true;
        }
      }

      if (inOmitted) {
        outputLines.push(`  // ... ${omittedCount} lines omitted ...`);
      }

      return `\`\`\`${lang}\n${outputLines.join("\n")}\n\`\`\``;
    });

    return result;
  }

  private static _deduplicateLines(text: string): string {
    const lines = text.split("\n");
    if (lines.length < 5) return text;

    const result: string[] = [];
    let prevLine = "";
    let repeatCount = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (repeatCount > 0) {
          result.push(`  (×${repeatCount})`);
          repeatCount = 0;
        }
        result.push("");
        prevLine = "";
        continue;
      }

      if (trimmed === prevLine) {
        repeatCount++;
      } else {
        if (repeatCount > 0) {
          result.push(`  (×${repeatCount})`);
          repeatCount = 0;
        }
        result.push(line);
        prevLine = trimmed;
      }
    }

    if (repeatCount > 0) {
      result.push(`  (×${repeatCount})`);
    }

    return result.join("\n");
  }

  private static _smartTruncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;

    const headLen = Math.floor(maxLen * 0.7);
    const tailLen = maxLen - headLen - 50;
    const head = text.slice(0, headLen);
    const tail = text.slice(text.length - tailLen);
    return `${head}\n\n... [truncated ${text.length - maxLen} chars] ...\n\n${tail}`;
  }

  async generateBriefUnderstanding(userMessage: string): Promise<string> {
    const enabledProviders = this.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);
    if (enabledProviders.length === 0) return "";

    const provider = enabledProviders[0];
    const personaName = this.persona.name || "助手";
    const masterTerm = this.persona.masterTerm || "用户";

    const systemPrompt = `你是${personaName}，一个智能助手。用户（${masterTerm}）发来了一条消息，请你：
1. 用一句话简短确认你理解了用户的需求
2. 用1-2句话说明你接下来打算怎么完成这个任务

要求：
- 语气亲切自然，像在跟${masterTerm}对话
- 不要使用引号或代码块
- 总字数控制在60字以内
- 格式：理解确认 + 换行 + 执行计划
- 示例：收到，我来帮您了解小米MiMo模型的情况。\n我将搜索MiMo的最新信息，包括模型能力、评测结果和发布动态。`;

    const baseURL = provider.baseURL || "";
    let apiURL = baseURL;
    if (!apiURL.endsWith("/chat/completions") && !apiURL.endsWith("/v1/chat/completions")) {
      apiURL = apiURL.replace(/\/+$/, "");
      if (!apiURL.endsWith("/v1")) {
        apiURL = `${apiURL}/v1`;
      }
      apiURL = `${apiURL}/chat/completions`;
    }

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (provider.apiKey) {
        if (provider.provider === "anthropic") {
          headers["x-api-key"] = provider.apiKey;
          headers["anthropic-version"] = "2023-06-01";
        } else {
          headers["Authorization"] = `Bearer ${provider.apiKey}`;
        }
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(apiURL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          max_tokens: 200,
          temperature: 0.5,
          stream: false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) return "";

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = data.choices?.[0]?.message?.content?.trim();
      return content || "";
    } catch {
      return "";
    }
  }

  async chat(
    message: string,
    context?: Record<string, unknown>,
    onProgress?: AgentProgressCallback
  ): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean; files?: Array<{ path: string; size: number; downloadUrl: string }> }> {
    const startTime = Date.now();
    const sessionId = (context?.sessionId as string) || "default";
    const pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }> = [];
    const agentId = (context?.agentId as string) || "default";
    const channel = (context?.channel as string) || "web-ui";
    const peerId = (context?.peerId as string) || "user";

    // Record session start in EventLedger
    const ledger = this.getEventLedger();
    if (ledger) {
      ledger.append("session_start", { channel, peerId }, { agentId, sessionId });
    }

    // ── Plugin hook: before_agent_start ──
    let effectiveMessage = message;
    if (this.pluginManager?.hasHooks("before_agent_start")) {
      const { blocked, blockReason, merged } = await this.pluginManager.runHooksMerged({
        type: "before_agent_start",
        context: { sessionId, agentId, channel, peerId },
        message,
        attachments: context?.attachments as Array<{ name: string; type: string; url?: string; data?: Buffer }> | undefined,
      });
      if (blocked) {
        return { reply: blockReason ?? "Message blocked by plugin", tokensUsed: 0, duration: 0, permissionRequests: [], toolsExecuted: false, files: [] };
      }
      const mergedBA = merged as Partial<import("@evoclaw/core").BeforeAgentStartResult>;
      if (mergedBA.syntheticReply) {
        return { reply: mergedBA.syntheticReply, tokensUsed: 0, duration: Date.now() - startTime, permissionRequests: [], toolsExecuted: false, files: [] };
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
      return slashResult;
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
      return await this.handleSkillInstall(message, skillManager, startTime, sessionId);
    }

    // ── System config query: handle "查配置", "check config", "system info" etc. ──
    const configQueryResult = this.handleSystemConfigQuery(message, skillManager, startTime, sessionId);
    if (configQueryResult) {
      return configQueryResult;
    }

    // ── Email account detection: detect email credentials in user input ──
    const emailAccountResult = await this.detectAndConfigureEmailAccount(message);
    if (emailAccountResult) {
      return emailAccountResult;
    }

    // ── Email inbox operations: handle email list/summarize/analyze requests ──
    const emailOperationResult = await this.handleEmailOperation(message);
    if (emailOperationResult) {
      return emailOperationResult;
    }

    // ── SkillDispatcher: try to auto-dispatch task via skill matching (before LLM) ──
    // Skip SkillDispatcher when user explicitly requests a claude-code-tools tool
    const claudeCodeToolNames = ["execute_programming_task", "decompose_programming_task", "assess_coding_capability", "get_task_result"];
    const isExplicitToolCall = claudeCodeToolNames.some(name => message.includes(name));
    if (this.hasActionIntent(message) && !isExplicitToolCall) {
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

          if (dispatchResult.path === "skill" && dispatchResult.success && dispatchResult.output && !outputHasError) {
            console.log(`[AgentModelExecutor] SkillDispatcher handled via "${dispatchResult.skillName}": ${dispatchResult.output}`);
            
            return {
              reply: `🎯 **技能调度**: \`${dispatchResult.skillName}\`\n\n${outputStr}\n\n---\n<details><summary>📋 调度详情</summary>\n\n${dispatchResult.reasoning}\n</details>`,
              tokensUsed: 0,
              duration: Date.now() - startTime,
              permissionRequests: [],
              toolsExecuted: true,
            };
          } else if (dispatchResult.path === "web_search" && dispatchResult.success && dispatchResult.output && !outputHasError) {
            console.log(`[AgentModelExecutor] SkillDispatcher used web_search fallback`);
            
            return {
              reply: `🔍 **网页搜索**: \`${dispatchResult.skillName}\`\n\n${outputStr}`,
              tokensUsed: 0,
              duration: Date.now() - startTime,
              permissionRequests: [],
              toolsExecuted: true,
            };
          } else if (outputHasError) {
            console.log(`[AgentModelExecutor] SkillDispatcher: skill "${dispatchResult.skillName}" returned ${classifiedError!.category} error — falling through to LLM`);
            return {
              reply: `⚠️ ${classifiedError!.userMessage}`,
              tokensUsed: 0,
              duration: Date.now() - startTime,
              permissionRequests: [],
              toolsExecuted: true,
            };
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
    }

    const tasks = this.parseMultipleTasks(effectiveMessage);
    
    if (tasks.length > 1) {
      const multiResult = await this.handleMultipleTasks(tasks, sessionId, pendingPermissions, startTime, context?.attachments as Array<{ name: string; type: string; size: number; data?: string | null }> | undefined, onProgress);
      multiResult.reply = AgentModelExecutor.collapseNewlines(multiResult.reply);
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

        const resumeResult = await this.executeSubtasksFromCheckpoint(existingCheckpoint, sessionId, pendingPermissions, startTime, context?.attachments as Array<{ name: string; type: string; size: number; data?: string | null }> | undefined, onProgress);
        if (resumeResult) {
          taskCheckpointManager.delete(sessionId);
          return resumeResult;
        }
      }

      const subtaskDescriptions = this.decomposeTaskForAutoSplit(effectiveMessage, autoSplitConfig.maxSubtasks);
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

        const splitResult = await this.executeSubtasksFromCheckpoint(checkpoint, sessionId, pendingPermissions, startTime, context?.attachments as Array<{ name: string; type: string; size: number; data?: string | null }> | undefined, onProgress);
        if (splitResult) {
          taskCheckpointManager.delete(sessionId);
          return splitResult;
        }
      }
    }

    // Recall relevant past memories for contextual awareness
    let memoryContext = "";
    if (this.memoryHub) {
      try {
        const longTerm = this.memoryHub.getLongTerm();
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
    }

    const systemPrompt = this.buildSystemPrompt() + memoryContext;
    const installedSkills = await skillManager?.listSkills() || [];

    // ── Semantic intent detection + real-time search pre-processing ──
    let newsContext = "";
    let searchReason = "";
    
    // Try to use TaskClassifier for semantic intent detection
    const taskClassifier = this.registry?.resolveService<{
      classify(task: string): { primaryCategory: string; confidence: number; intentSimilarity?: Record<string, number> };
      needsWebSearch(task: string): { needed: boolean; confidence: number; reason: string };
    }>("taskClassifier");
    
    let shouldSearch = false;
    
    if (taskClassifier) {
      try {
        const searchCheck = taskClassifier.needsWebSearch(message);
        shouldSearch = searchCheck.needed && searchCheck.confidence > 0.35;
        if (shouldSearch) {
          searchReason = searchCheck.reason;
          console.log(`[AgentModelExecutor] Semantic intent detection: ${searchCheck.reason} (confidence: ${(searchCheck.confidence * 100).toFixed(0)}%)`);
        }
      } catch (err) {
        console.warn(`[AgentModelExecutor] TaskClassifier failed: ${err}`);
      }
    }
    
    // Fallback to keyword-based detection if TaskClassifier is not available
    if (!shouldSearch) {
      const lowerMsg = message.toLowerCase();
      const isNewsQuery = (lowerMsg.includes("新闻") || lowerMsg.includes("热搜") || lowerMsg.includes("热点") || 
                          lowerMsg.includes("AI") || lowerMsg.includes("人工智能") || lowerMsg.includes("科技") ||
                          lowerMsg.includes("分析报告") || lowerMsg.includes("发展情况") || lowerMsg.includes("分析") ||
                          lowerMsg.includes("横评") || lowerMsg.includes("评测") || lowerMsg.includes("对比") ||
                          lowerMsg.includes("性价比") || lowerMsg.includes("排名") || lowerMsg.includes("推荐") ||
                          lowerMsg.includes("测评") || lowerMsg.includes("比较")) &&
        (lowerMsg.includes("搜索") || lowerMsg.includes("整理") || lowerMsg.includes("找") || lowerMsg.includes("查") ||
         lowerMsg.includes("分析") || lowerMsg.includes("报告") || lowerMsg.includes("情况") || lowerMsg.includes("做个") ||
         lowerMsg.includes("横评") || lowerMsg.includes("评测") || lowerMsg.includes("对比") || lowerMsg.includes("性价比") ||
         lowerMsg.includes("排名") || lowerMsg.includes("推荐") || lowerMsg.includes("测评") || lowerMsg.includes("比较"));
      const isSearchIntent = /(?:搜索|查找|搜一下|查一下|有没有|最新|最近.*?(?:火|热门|上升|流行)|本周.*?(?:重大|热门|重要)|github.*?(?:开源|项目|上升)|开源.*?项目|比较火|上升快|横评|评测|性价比|排名|对比|测评)/i.test(message);
      const isEvaluationQuery = /(?:看看|怎么样|如何|好不好|好用吗|值得|评价|评估|介绍|了解|说说|聊聊|讲讲|分析下|看下|了解下|介绍下)/i.test(message);
      const isEntityInfoQuery = /(?:情况|信息|动态|新闻|进展|发布|新品|产品|公告|财报|动向|近况|现状|趋势|发展)/i.test(message);
      const isModelOrProductQuery = /(?:模型|大模型|LLM|GPT|Claude|Gemini|Qwen|DeepSeek|Llama|Mistral|MiMo|GLM|文心|通义|千问|豆包|Kimi|MiniMax|百川|Yi|零一|商汤|讯飞|智谱|小米|华为|百度|阿里|腾讯|字节|OpenAI|Anthropic|Google|Meta|Microsoft|NVIDIA|苹果|三星|比亚迪|蔚来|理想|小鹏|大疆|OPPO|vivo|荣耀|中兴)/i.test(message);
      shouldSearch = isNewsQuery || isSearchIntent || (isEvaluationQuery && isModelOrProductQuery) || (isEntityInfoQuery && isModelOrProductQuery);
      searchReason = shouldSearch ? (isSearchIntent ? "搜索意图检测触发" : isEvaluationQuery && isModelOrProductQuery ? "实体评价查询触发" : isEntityInfoQuery && isModelOrProductQuery ? "实体信息查询触发" : "关键词匹配触发") : "";
    }
    
    if (shouldSearch && this.registeredTools.has("web_search")) {
      try {
        const searchQuery = message
          .replace(/^(请问|请问一下|麻烦|帮忙|帮我|能不能|可以|请|我想|我想要|我想看|我想了解|我想知道)\s*/g, "")
          .replace(/^(搜索|帮我搜|帮我搜索|帮我查|查一下|搜一下|搜搜|查查)[：:\s]*/i, "")
          .replace(/(并整理后发给我|整理后发给我|整理一下|并整理|并总结|并汇总|是什么|怎么样|有哪些|有没有|的?情况|的?信息).*/i, "")
          .replace(/[？?！!。.，,]+$/g, "")
          .trim();

        const lowerQuery = searchQuery.toLowerCase();
        let freshness: string | undefined;
        if (/(今天|今日|today)/i.test(lowerQuery)) freshness = "pd";
        else if (/(本周|这周|最近|this week)/i.test(lowerQuery)) freshness = "pw";
        else if (/(本月|这个月|this month)/i.test(lowerQuery)) freshness = "pm";
        else if (/\d{4}年/.test(searchQuery) || /最新|current|latest|recent/i.test(lowerQuery)) freshness = "py";

        const generateSubQueries = (query: string): string[] => {
          const subQueries: string[] = [query];
          const isChinese = /[\u4e00-\u9fff]/.test(query);

          if (isChinese) {
            const aspectPatterns: Array<{ pattern: RegExp; queries: string[] }> = [
              {
                pattern: /横评|对比|比较|评测|测评|性价比/i,
                queries: [
                  query + " 价格 定价 API",
                  query + " 性能 评测 排名",
                  query + " 最新 2026",
                ],
              },
              {
                pattern: /大模型|LLM|AI模型/i,
                queries: [
                  query.replace(/横评|对比|比较|评测|测评|性价比/g, "") + " 价格表 API定价",
                  query.replace(/横评|对比|比较|评测|测评|性价比/g, "") + " benchmark 性能排名",
                ],
              },
              {
                pattern: /报告|分析|调研/i,
                queries: [
                  query + " 数据 统计",
                  query + " 行业趋势 最新",
                ],
              },
              {
                pattern: /看看|怎么样|如何|好不好|好用吗|值得|评价|评估|介绍|了解|说说|聊聊|讲讲/i,
                queries: [
                  query.replace(/你看看|看看如何|怎么样|好不好|好用吗|值得吗|评价|评估/g, "") + " 评测 体验",
                  query.replace(/你看看|看看如何|怎么样|好不好|好用吗|值得吗|评价|评估/g, "") + " 最新消息 2026",
                ],
              },
            ];

            for (const { pattern, queries } of aspectPatterns) {
              if (pattern.test(query)) {
                subQueries.push(...queries);
              }
            }

            const modelNames = query.match(/(?:DeepSeek|Qwen|GLM|MiMo|Mimo|Kimi|MiniMax|Seed|混元|Hunyuan|通义|文心|豆包|ChatGLM|Yi|Baichuan)[\s\-]?[Vv]?[\d.]*(?:\s*(?:Pro|Max|Flash|Lite|Plus|Turbo))?/gi);
            if (modelNames && modelNames.length > 0) {
              for (const model of [...new Set(modelNames)]) {
                subQueries.push(`${model} 价格 性能 2026`);
                subQueries.push(`${model} API 定价 benchmark`);
              }
            }
          } else {
            if (/compar|review|benchmark|versus/i.test(query)) {
              subQueries.push(query + " pricing cost API");
              subQueries.push(query + " performance benchmark 2026");
            }
          }

          return [...new Set(subQueries)].slice(0, 6);
        };

        const subQueries = generateSubQueries(searchQuery);
        console.log(`[AgentModelExecutor] Multi-round search: ${subQueries.length} sub-queries for "${searchQuery}"`);

        const entry = this.registeredTools.get("web_search")!;
        let allSearchResults: Array<{ title: string; url: string; snippet: string }> = [];
        let allFetchedContent: Array<{ title: string; url: string; content: string }> = [];
        let searchRound = 0;

        for (const subQ of subQueries) {
          searchRound++;
          onProgress?.({
            type: "tool_call",
            phase: "tool_calling",
            detail: `正在搜索 (第${searchRound}/${subQueries.length}轮): ${subQ}`,
            progress: 20 + searchRound * 5,
            toolName: "web_search",
            toolArgs: { query: subQ, freshness },
          });

          const searchParams: Record<string, unknown> = { query: subQ, limit: 8 };
          if (freshness) searchParams.freshness = freshness;

          try {
            const searchResult = await entry.handler(searchParams);
            const resultObj = typeof searchResult === "object" && searchResult !== null ? (searchResult as Record<string, unknown>) : null;
            const results = (resultObj?.results as Array<{ title: string; url: string; snippet: string }>) || [];

            const seenUrls = new Set(allSearchResults.map(r => r.url));
            for (const r of results) {
              if (!seenUrls.has(r.url)) {
                allSearchResults.push(r);
                seenUrls.add(r.url);
              }
            }

            onProgress?.({
              type: "tool_result",
              phase: "tool_calling",
              detail: `搜索完成 (第${searchRound}轮): 找到 ${results.length} 条结果`,
              progress: 25 + searchRound * 5,
              toolName: "web_search",
              toolResult: `Found ${results.length} results for "${subQ}"`,
            });
          } catch (err) {
            console.warn(`[AgentModelExecutor] Sub-query "${subQ}" failed: ${err}`);
          }
        }

        if (allSearchResults.length > 0) {
          let allNewsContent = `## 搜索关键词: ${subQueries.join(" | ")}\n## 共 ${allSearchResults.length} 条搜索结果:\n\n`;
          allSearchResults.forEach((r, i) => {
            allNewsContent += `### ${i + 1}. ${r.title}\n- URL: ${r.url}\n- 摘要: ${r.snippet}\n\n`;
          });

          if (this.registeredTools.has("fetch_node_page")) {
            const fetchTool = this.registeredTools.get("fetch_node_page")!;
            const urlsToFetch = allSearchResults
              .filter(r => r.url && r.url.startsWith("http") && !r.url.includes("baidu.com/link"))
              .slice(0, 8);
            let fetchedCount = 0;

            for (const r of urlsToFetch) {
              try {
                onProgress?.({
                  type: "tool_call",
                  phase: "tool_calling",
                  detail: `正在抓取网页内容: ${r.title.slice(0, 40)}`,
                  progress: 50 + fetchedCount * 3,
                  toolName: "fetch_node_page",
                  toolArgs: { url: r.url },
                });

                const fetchResult = await fetchTool.handler({ url: r.url, maxLength: 5000 });
                const fetchObj = typeof fetchResult === "object" && fetchResult !== null ? (fetchResult as Record<string, unknown>) : null;
                const content = (fetchObj?.content || fetchObj?.text || fetchObj?.body || "") as string;
                const cleanedContent = AgentModelExecutor.stripWebNoise(content);
                if (cleanedContent && cleanedContent.length > 50) {
                  fetchedCount++;
                  allFetchedContent.push({ title: r.title, url: r.url, content: cleanedContent.slice(0, 5000) });
                  allNewsContent += `## 网页正文 ${fetchedCount}: ${r.title}\n${cleanedContent.slice(0, 5000)}\n\n`;
                }
              } catch {
              }
            }
          }
          newsContext = allNewsContent;
          console.log(`[AgentModelExecutor] Multi-round search complete: ${subQueries.length} queries, ${allSearchResults.length} results, ${allFetchedContent.length} pages fetched, ${newsContext.length} chars`);
        }
      } catch (err) {
        console.warn(`[AgentModelExecutor] Multi-round search failed: ${err}`);
      }
    }

    const newsEnhancedMessage = newsContext
      ? `${message}\n\n[系统已通过${searchReason}完成多轮搜索，共获取了相关资料。请基于以下搜索结果中的真实数据来${message.includes("报告") ? "撰写一份结构清晰的分析报告" : "整理并分析后回复用户"}。

要求：
1. 优先使用搜索结果中的具体数据（价格、评分、排名等），不要使用模糊描述
2. 如有表格数据，请用Markdown表格呈现，包含具体数值
3. 不要声称无法获取实时信息——搜索结果就是实时数据
4. 如果搜索结果中缺少某些信息，请如实说明"在当前搜索结果中未找到"，不要编造数据
5. 报告类任务请包含：核心摘要、详细对比表格、场景化建议、数据来源说明
6. 下载链接格式：请使用标准Markdown链接格式 [点击下载](链接)，例如 [点击下载](/api/files/download/文件名)，确保链接正确包裹在方括号和圆括号中]

\n\n${newsContext.slice(0, 60000)}`
      : shouldSearch
        ? `${message}\n\n[系统提示：自动搜索预处理未能获取到有效结果。你必须使用 web_search 工具进行搜索以获取最新实时信息，绝对不能仅凭训练数据回答。如果 web_search 失败，请尝试 browser_launch + browser_navigate 使用真实浏览器搜索。禁止声称"无法获取实时信息"或"网络访问受限"——你有多种搜索工具可用，必须至少尝试一种。]`
        : message;

    if (newsContext) {
      console.log(`[AgentModelExecutor] News context added: ${newsContext.length} chars for session "${sessionId}"`);
    }

    const enabledProviders = this.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);
    console.log(`[AgentModelExecutor] Session "${sessionId}": ${enabledProviders.length} enabled providers, message length: ${newsEnhancedMessage.length} chars, history turns: ${(this.conversationHistory.get(sessionId) || []).length}`);

    if (enabledProviders.length > 0) {
      const primaryProvider = enabledProviders[0];
      taskStatusTracker.set(sessionId, "thinking", `正在调用 ${primaryProvider.name} (${primaryProvider.model})...`, 30);
      const result = await this.tryCallLLM(newsEnhancedMessage, systemPrompt, installedSkills, enabledProviders, startTime, sessionId, pendingPermissions, context?.attachments as Array<{ name: string; type: string; size: number; data?: string | null }> | undefined, onProgress);
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
        if (pendingPermissions.length > 0) {
          return { reply, tokensUsed: result.tokensUsed, duration: result.duration, permissionRequests: [...pendingPermissions], toolsExecuted: result.toolsExecuted, files: result.files };
        }
        return { reply, tokensUsed: result.tokensUsed, duration: result.duration, permissionRequests: [], toolsExecuted: result.toolsExecuted, files: result.files };
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
    this.runAgentEndHook(sessionId, agentId, channel, finalResult);

    return finalResult;
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
    if (!this.memoryHub) return;
    try {
      const longTerm = this.memoryHub.getLongTerm();
      const content = `User: ${userMsg}\nAgent: ${agentReply}`;
      longTerm.store({
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
        id: "",
        createdAt: new Date(),
        accessedAt: new Date(),
      }).catch((err) => console.warn(`[AgentModelExecutor] Memory save failed: ${err}`));
    } catch {
      // Silent fallback
    }
  }

  private parseMultipleTasks(message: string): string[] {
    const tasks: string[] = [];
    
    const isShortFollowup = (s: string): boolean => {
      return /^(帮我|给我|请帮我|麻烦|请问|你帮我|能帮我).{0,8}$/.test(s.trim());
    };

    const isQuestionOnly = (s: string): boolean => {
      const trimmed = s.trim();
      return /^(什么|怎么|如何|为什么|哪|几|多少|是不是|能不能|可以|吗|呢|谁|何时|哪里)/.test(trimmed)
        || /^(what|how|why|when|where|who|which|is|can|do|does|are)/i.test(trimmed);
    };
    
    let remaining = message.trim();
    
    // Split on Chinese period/exclamation only (NOT question marks — they indicate
    // conversational questions, not separate tasks)
    const separators = [/[。！]/g];
    
    for (const sep of separators) {
      const parts = remaining.split(sep).filter(p => p.trim().length > 2);
      if (parts.length > 1) {
        const realTasks = parts.map(p => p.trim()).filter(p => !isShortFollowup(p) && !isQuestionOnly(p));
        return realTasks.length >= 2 ? realTasks : [message];
      }
    }
    
    // Also split on double-newline (explicit paragraph separators)
    const paragraphs = remaining.split(/\n\s*\n/).filter(p => p.trim().length > 2);
    if (paragraphs.length > 1) {
      return paragraphs.map(p => p.trim());
    }
    
    const conjunctionPatterns = [
      /(同时|并且|然后|接着|还要|另外|也请)/g,
      /(and|also|then|next)/gi
    ];
    
    for (const pattern of conjunctionPatterns) {
      if (pattern.test(message)) {
        const parts = message.split(pattern);
        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed && trimmed.length > 2) {
            tasks.push(trimmed);
          }
        }
        if (tasks.length > 1) return tasks;
      }
    }
    
    return [message];
  }

  private async handleMultipleTasks(
    tasks: string[],
    sessionId: string,
    pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>,
    startTime: number,
    attachments?: Array<{ name: string; type: string; size: number; data?: string | null }>,
    onProgress?: AgentProgressCallback
  ): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean }> {
    const results: string[] = [];
    let totalTokens = 0;

    results.push(`检测到您有 ${tasks.length} 个任务需要处理，我将依次为您执行：`);

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      results.push(`\n--- 任务 ${i + 1}：${task} ---`);
      
      const systemPrompt = this.buildSystemPrompt();
      const skillManager = this.registry?.resolveService<{
        searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>;
        listSkills(): unknown[];
        executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown>;
      }>("skillManager");
      const installedSkills = await skillManager?.listSkills() || [];
      const enabledProviders = this.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);

      let taskResult: string = "";
      let tokensUsed = 0;

      if (enabledProviders.length > 0) {
        const result = await this.tryCallLLM(task, systemPrompt, installedSkills, enabledProviders, startTime, sessionId, pendingPermissions, attachments, onProgress);
        if (result) {
          taskResult = result.reply;
          tokensUsed = result.tokensUsed;
          if (!result.toolsExecuted && this.hasActionIntent(task)) {
            const msg = task.toLowerCase();
            const fallback = await this.generateChatResponse(task, msg, installedSkills, skillManager, pendingPermissions);
            taskResult = result.reply + "\n\n" + fallback;
          }
        }
      }

      if (!taskResult) {
        const msg = task.toLowerCase();
        taskResult = await this.generateChatResponse(task, msg, installedSkills, skillManager, pendingPermissions);
        tokensUsed = this.estimateTokenCount(systemPrompt + task + taskResult);
      }

      totalTokens += tokensUsed;
      results.push(taskResult);
    }

    results.push(`\n--- 所有任务处理完成 ---`);
    results.push(`共完成 ${tasks.length} 个任务，耗时 ${Math.floor((Date.now() - startTime) / 1000)} 秒。`);

    return {
      reply: results.join("\n"),
      tokensUsed: totalTokens,
      duration: Date.now() - startTime,
      permissionRequests: [...pendingPermissions],
      toolsExecuted: true,
    };
  }

  private decomposeTaskForAutoSplit(message: string, maxSubtasks: number): Array<{ id: string; description: string }> {
    const subtasks: Array<{ id: string; description: string }> = [];
    const lower = message.toLowerCase();

    const codingPatterns: Array<{ test: RegExp; phases: string[] }> = [
      {
        test: /实现|implement|编写|write|开发|develop|创建.*类|create.*class/i,
        phases: ["设计数据结构和接口定义", "实现核心逻辑和算法", "编写错误处理和边界检查", "添加单元测试"],
      },
      {
        test: /算法|algorithm|排序|sort|搜索|search|图|graph/i,
        phases: ["分析算法需求和时间复杂度要求", "实现核心算法逻辑", "处理边界情况和异常", "编写测试用例验证正确性"],
      },
      {
        test: /API|接口|服务|server|路由|route/i,
        phases: ["定义API接口和数据模型", "实现核心路由和业务逻辑", "添加中间件和错误处理", "编写API测试"],
      },
      {
        test: /重构|refactor|优化|optimize|改进|improve/i,
        phases: ["分析现有代码识别问题", "制定重构方案", "逐步实施重构", "验证重构后功能正确性"],
      },
      {
        test: /调试|debug|修复|fix|排错|troubleshoot/i,
        phases: ["复现问题并收集错误信息", "定位问题根因", "实施修复方案", "验证修复效果并添加回归测试"],
      },
    ];

    let matchedPhases: string[] | null = null;
    for (const pattern of codingPatterns) {
      if (pattern.test.test(lower)) {
        matchedPhases = pattern.phases;
        break;
      }
    }

    if (!matchedPhases) {
      if (lower.includes("测试") || lower.includes("test")) {
        matchedPhases = ["分析测试需求和覆盖范围", "编写核心测试用例", "添加边界和异常测试", "运行测试并验证结果"];
      } else if (lower.length > 200 || lower.split("\n").length > 10) {
        matchedPhases = ["分析需求并设计方案", "实现第一部分功能", "实现第二部分功能", "整合测试和验证"];
      } else {
        matchedPhases = ["分析需求并设计方案", "实现核心功能", "测试验证和完善"];
      }
    }

    const selectedPhases = matchedPhases.slice(0, maxSubtasks);
    for (let i = 0; i < selectedPhases.length; i++) {
      subtasks.push({
        id: `sub-${i + 1}`,
        description: selectedPhases[i],
      });
    }

    return subtasks;
  }

  private async executeSubtasksFromCheckpoint(
    checkpoint: TaskCheckpoint,
    sessionId: string,
    pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>,
    startTime: number,
    attachments: Array<{ name: string; type: string; size: number; data?: string | null }> | undefined,
    onProgress?: AgentProgressCallback
  ): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean; files?: Array<{ path: string; size: number; downloadUrl: string }> } | null> {
    const subtaskResults: string[] = [];
    let totalTokensUsed = 0;
    const allFiles: Array<{ path: string; size: number; downloadUrl: string }> = [];
    let failedCount = 0;

    const systemPrompt = this.buildSystemPrompt();
    const skillManager = this.registry?.resolveService<{
      searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>;
      listSkills(): unknown[];
      executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown>;
    }>("skillManager");
    const installedSkills = await skillManager?.listSkills() || [];
    const enabledProviders = this.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);

    if (enabledProviders.length === 0) {
      return null;
    }

    const completedContext = checkpoint.subtasks
      .filter(s => s.status === "completed" && s.result)
      .map(s => `### ${s.description}\n${s.result}`)
      .join("\n\n");

    for (let i = 0; i < checkpoint.subtasks.length; i++) {
      const subtask = checkpoint.subtasks[i];
      if (subtask.status === "completed") {
        subtaskResults.push(`✅ **${subtask.description}**: 已完成`);
        continue;
      }

      const baseProgress = 20 + Math.floor((i / checkpoint.totalSubtasks) * 70);
      taskStatusTracker.set(sessionId, "subtask_executing", `执行子任务 ${i + 1}/${checkpoint.totalSubtasks}: ${subtask.description}`, baseProgress, i, checkpoint.totalSubtasks, subtask.description);
      onProgress?.({ type: "subtask_start", phase: "subtask_executing", detail: `开始子任务 ${i + 1}/${checkpoint.totalSubtasks}: ${subtask.description}`, progress: baseProgress, subtaskIndex: i, subtaskTotal: checkpoint.totalSubtasks });

      const subtaskPrompt = completedContext
        ? `${checkpoint.originalMessage}\n\n## 已完成的子任务结果\n\n${completedContext}\n\n## 当前子任务\n请完成以下子任务: ${subtask.description}\n\n注意：这是拆分后的子任务之一，请专注于完成当前子任务，不要重复已完成的工作。`
        : `${checkpoint.originalMessage}\n\n请完成以下子任务: ${subtask.description}\n\n注意：这是拆分后的子任务之一，请专注于完成当前子任务。`;

      const SUBTASK_TIMEOUT = 300_000;
      let subtaskResult: string | null = null;
      let subtaskTokens = 0;

      try {
        const resultPromise = this.tryCallLLM(
          subtaskPrompt, systemPrompt, installedSkills, enabledProviders,
          startTime, sessionId, pendingPermissions, attachments, onProgress
        );
        const timeoutPromise = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), SUBTASK_TIMEOUT)
        );
        const result = await Promise.race([resultPromise, timeoutPromise]);

        if (result) {
          subtaskResult = result.reply;
          subtaskTokens = result.tokensUsed;
          if (result.files) allFiles.push(...result.files);
        }
      } catch (err) {
        console.warn(`[AgentModelExecutor] Subtask "${subtask.description}" failed:`, err);
      }

      if (subtaskResult) {
        taskCheckpointManager.updateSubtask(sessionId, subtask.id, "completed", subtaskResult.slice(0, 2000));
        subtaskResults.push(`✅ **${subtask.description}**:\n${subtaskResult}`);
        totalTokensUsed += subtaskTokens;
        onProgress?.({ type: "subtask_done", phase: "subtask_executing", detail: `子任务 ${i + 1} 完成: ${subtask.description}`, progress: baseProgress + Math.floor(70 / checkpoint.totalSubtasks) });
      } else {
        let retryCount = 0;
        while (retryCount < 2) {
          retryCount++;
          console.log(`[AgentModelExecutor] Retrying subtask "${subtask.description}" (attempt ${retryCount + 1})`);
          try {
            const retryResult = await this.tryCallLLM(
              subtaskPrompt, systemPrompt, installedSkills, enabledProviders,
              startTime, sessionId, pendingPermissions, attachments, onProgress
            );
            if (retryResult) {
              taskCheckpointManager.updateSubtask(sessionId, subtask.id, "completed", retryResult.reply.slice(0, 2000));
              subtaskResults.push(`✅ **${subtask.description}** (重试成功):\n${retryResult.reply}`);
              totalTokensUsed += retryResult.tokensUsed;
              if (retryResult.files) allFiles.push(...retryResult.files);
              onProgress?.({ type: "subtask_done", phase: "subtask_executing", detail: `子任务 ${i + 1} 重试成功: ${subtask.description}`, progress: baseProgress + Math.floor(70 / checkpoint.totalSubtasks) });
              break;
            }
          } catch { }
        }

        if (retryCount >= 2) {
          taskCheckpointManager.updateSubtask(sessionId, subtask.id, "failed", undefined, "Subtask execution failed after retry");
          subtaskResults.push(`❌ **${subtask.description}**: 执行失败（已重试）`);
          failedCount++;
          onProgress?.({ type: "subtask_error", phase: "subtask_executing", detail: `子任务 ${i + 1} 失败: ${subtask.description}`, progress: baseProgress });
        }
      }
    }

    const finalProgress = failedCount === 0 ? 100 : Math.floor((checkpoint.totalSubtasks - failedCount) / checkpoint.totalSubtasks * 100);
    taskStatusTracker.set(sessionId, "done", `所有子任务执行完成 (${checkpoint.totalSubtasks - failedCount}/${checkpoint.totalSubtasks} 成功)`, finalProgress);

    const summaryHeader = failedCount === 0
      ? `🎉 所有 ${checkpoint.totalSubtasks} 个子任务已成功完成！`
      : `⚠️ ${checkpoint.totalSubtasks - failedCount}/${checkpoint.totalSubtasks} 个子任务完成，${failedCount} 个失败。`;

    const reply = `${summaryHeader}\n\n${subtaskResults.join("\n\n")}\n\n---\n📊 总耗时: ${Math.floor((Date.now() - startTime) / 1000)}秒 | Token使用: ${totalTokensUsed}`;

    return {
      reply: AgentModelExecutor.collapseNewlines(reply),
      tokensUsed: totalTokensUsed,
      duration: Date.now() - startTime,
      permissionRequests: [...pendingPermissions],
      toolsExecuted: true,
      files: allFiles,
    };
  }

  // ── Slash Command Handler: intercept /command before LLM ──
  private async handleSlashCommand(
    message: string,
    sessionId: string,
    startTime: number,
  ): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean; files?: Array<{ path: string; size: number; downloadUrl: string }> } | null> {
    if (!message.startsWith("/")) return null;

    const spaceIdx = message.indexOf(" ");
    const cmdName = spaceIdx === -1
      ? message.slice(1).toLowerCase()
      : message.slice(1, spaceIdx).toLowerCase();
    const args = spaceIdx === -1 ? [] : message.slice(spaceIdx + 1).split(/\s+/);

    let reply: string;
    let action: "new_session" | "reset_session" | "compact" | null = null;

    switch (cmdName) {
      case "help": {
        reply = [
          "**📋 可用命令**",
          "",
          "`/help` — 显示所有可用命令",
          "`/status` — 查看当前代理与会话状态",
          "`/model` — 查看当前模型信息",
          "`/model list` — 列出所有已配置模型",
          "`/model switch <名称>` — 切换模型",
          "`/health` — 系统健康检查",
          "`/skills` — 列出已安装技能",
          "`/new` — 开始新会话",
          "`/reset` — 完全重置当前会话",
          "`/compact` — 压缩会话上下文",
          "`/clear` — 清空当前对话显示",
          "`/thinking <off|low|medium|high>` — 设置思考级别",
          "`/verbose <on|off>` — 切换详细输出",
          "`/usage <off|tokens|full>` — 控制用量报告",
          "`/memory <查询>` — 语义记忆搜索",
          "`/cron list` — 查看定时任务",
          "`/plugin list` — 查看插件列表",
          "`/focus <type> <id>` — 聚焦上下文目标",
          "`/unfocus` — 取消上下文聚焦",
          "`/agents` — 列出可用上下文目标",
        ].join("\n");
        break;
      }

      case "status": {
        const enabledProviders = this.providers.filter(p => p.enabled).sort((a, b) => a.order - b.order);
        const currentModel = enabledProviders.length > 0
          ? `${enabledProviders[0].name} (${enabledProviders[0].provider}/${enabledProviders[0].model})`
          : "无已启用模型";
        const history = this.conversationHistory.get(sessionId) || [];
        const ts = new Date().toLocaleString("zh-CN", {
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
        reply = [
          `**🦞 代理状态**`,
          ``,
          `📅 ${ts}`,
          `Agent: \`${this.persona.name}\``,
          `Session: \`${sessionId}\``,
          `当前模型: \`${currentModel}\``,
          `已启用模型数: ${enabledProviders.length}`,
          `对话轮次: ${history.length}`,
          `已注册工具: ${this.registeredTools.size}`,
          `自动压缩: ${this.autoCompactionEnabled ? "已启用" : "未启用"}`,
        ].join("\n");
        break;
      }

      case "model": {
        const enabledProviders = this.providers.filter(p => p.enabled).sort((a, b) => a.order - b.order);
        const allProviders = this.providers;

        if (args.length === 0 || args[0] === "list" || args[0] === "ls") {
          const lines: string[] = ["**🤖 模型配置**", ""];
          if (enabledProviders.length === 0) {
            lines.push("⚠ 无已启用模型");
          } else {
            for (let i = 0; i < enabledProviders.length; i++) {
              const p = enabledProviders[i];
              const tag = i === 0 ? " **[当前主模型]**" : "";
              lines.push(`${i + 1}. **${p.name}**${tag}`);
              lines.push(`   - 模型: \`${p.model}\` | 类型: \`${p.provider}\``);
              lines.push(`   - 超时: ${p.timeout / 1000}s | 最大 Token: ${p.maxTokens}`);
              if (p.baseURL) {
                lines.push(`   - 端点: \`${p.baseURL.replace(/\/+$/, "")}\``);
              }
            }
          }
          if (allProviders.length > enabledProviders.length) {
            lines.push(`\n⚠ 已禁用: ${allProviders.length - enabledProviders.length} 个模型`);
          }
          reply = lines.join("\n");
        } else if (args[0] === "current" || args[0] === "active") {
          if (enabledProviders.length > 0) {
            const p = enabledProviders[0];
            reply = `当前主模型: **${p.name}** (\`${p.provider}/${p.model}\`)`;
          } else {
            reply = "⚠ 无已启用模型";
          }
        } else if (args[0] === "switch" || args[0] === "use") {
          if (args.length < 2) {
            reply = "用法: `/model switch <模型名称>`\n使用 `/model list` 查看可用模型";
          } else {
            const targetName = args.slice(1).join(" ");
            const target = allProviders.find(p =>
              p.name.toLowerCase() === targetName.toLowerCase() ||
              p.id?.toLowerCase() === targetName.toLowerCase() ||
              p.model.toLowerCase() === targetName.toLowerCase()
            );
            if (target) {
              const oldOrder = target.order;
              target.order = 0;
              for (const p of allProviders) {
                if (p !== target && p.order <= oldOrder && p.enabled) {
                  p.order += 1;
                }
              }
              allProviders.sort((a, b) => a.order - b.order);
              reply = `✅ 已切换到 **${target.name}** (\`${target.provider}/${target.model}\`)`;
            } else {
              reply = `⚠ 未找到模型 "${targetName}"。使用 \`/model list\` 查看可用模型`;
            }
          }
        } else {
          reply = `未知的 /model 子命令: "${args[0]}"\n可用: list, current, switch <名称>`;
        }
        break;
      }

      case "health": {
        const enabledProviders = this.providers.filter(p => p.enabled);
        const toolCount = this.registeredTools.size;
        const skillManager = this.registry?.resolveService<{ listSkills(): Promise<Array<unknown>> }>("skillManager");
        let skillCount = 0;
        if (skillManager) {
          try { skillCount = (await skillManager.listSkills()).length; } catch { skillCount = 0; }
        }
        const obs = this.registry?.resolveService<any>("observability");
        const ts = new Date().toLocaleString("zh-CN", {
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
        reply = [
          `**🏥 健康检查**`,
          ``,
          `📅 ${ts}`,
          `状态: ✅ 正常运行`,
          `已启用模型: ${enabledProviders.length}`,
          `已注册工具: ${toolCount}`,
          `已安装技能: ${skillCount}`,
          `Observability: ${obs ? "✅ 已集成" : "⚠ 未集成"}`,
          `Memory: ${this.memoryHub ? "✅ 已集成" : "⚠ 未集成"}`,
          `Compaction: ${this.compactionManager ? "✅ 已集成" : "⚠ 未集成"}`,
          `Session Manager: ${this.sessionManager ? "✅ 已集成" : "⚠ 未集成"}`,
        ].join("\n");
        break;
      }

      case "skills": {
        const skillManager = this.registry?.resolveService<{ listSkills(): Promise<Array<{ name: string; description?: string; installed?: boolean }>> }>("skillManager");
        if (!skillManager) {
          reply = "⚠ 技能管理器不可用";
          break;
        }
        let allSkills: Array<{ name: string; description?: string; installed?: boolean }>;
        try { allSkills = await skillManager.listSkills(); } catch { allSkills = []; }
        if (allSkills.length === 0) {
          reply = "📦 暂无已安装技能";
        } else {
          const lines = [`**📦 已安装技能** (${allSkills.length})`, ""];
          for (const s of allSkills.slice(0, 30)) {
            const desc = s.description ? ` — ${s.description}` : "";
            lines.push(`- \`${s.name}\`${desc}`);
          }
          if (allSkills.length > 30) {
            lines.push(`...及其他 ${allSkills.length - 30} 个技能`);
          }
          reply = lines.join("\n");
        }
        break;
      }

      case "new": {
        reply = "✅ 新会话已创建。之前的会话已归档。";
        action = "new_session";
        break;
      }

      case "reset": {
        this.conversationHistory.delete(sessionId);
        reply = "✅ 会话已完全重置。所有上下文已清除。";
        action = "reset_session";
        break;
      }

      case "compact": {
        if (this.compactionManager) {
          const history = this.conversationHistory.get(sessionId) || [];
          if (history.length > 4) {
            this.compactionManager.buildSummary(sessionId, history.filter(t => t.role === "user" || t.role === "assistant").map(t => ({
              role: t.role,
              content: t.content || "",
            })));
            reply = "✅ 对话历史已压缩。旧消息已摘要，最近轮次已保留。";
          } else {
            reply = "ℹ 对话历史较短，无需压缩。";
          }
        } else {
          reply = "⚠ 压缩管理器不可用";
        }
        action = "compact";
        break;
      }

      case "clear": {
        this.conversationHistory.delete(sessionId);
        reply = "✅ 对话显示已清空。";
        break;
      }

      case "thinking": {
        const level = args[0]?.toLowerCase();
        const validLevels = ["off", "low", "medium", "high"];
        if (!level || !validLevels.includes(level)) {
          reply = `用法: \`/thinking <off|low|medium|high>\``;
        } else {
          reply = `✅ 思考级别已设置为 **${level}**。`;
        }
        break;
      }

      case "verbose": {
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") {
          reply = "用法: `/verbose on|off`";
        } else {
          reply = `✅ 详细输出已设置为 **${val}**。`;
        }
        break;
      }

      case "usage": {
        const val = args[0]?.toLowerCase();
        const valid = ["off", "tokens", "full"];
        if (!val || !valid.includes(val)) {
          reply = "用法: `/usage <off|tokens|full>`";
        } else {
          const label = { off: "关闭", tokens: "仅 Token", full: "完整报告" }[val]!;
          reply = `✅ 用量报告已设置为 **${label}**。`;
        }
        break;
      }

      case "memory": {
        if (!this.memoryHub) {
          reply = "⚠ 记忆系统不可用";
          break;
        }
        const query = args.join(" ");
        if (!query) {
          reply = "用法: `/memory <查询关键词>`";
          break;
        }
        try {
          const results = await this.memoryHub.getLongTerm().search({ query, limit: 5 });
          if (results.length === 0) {
            reply = `🔍 未找到与 "${query}" 相关的记忆。`;
          } else {
            const lines = [`**🔍 记忆搜索结果** (${results.length})`, ""];
            for (const r of results) {
              const content = typeof r.entry?.content === "string" ? r.entry.content.slice(0, 200) : String(r.entry?.content ?? "").slice(0, 200);
              lines.push(`- ${content}${content.length >= 200 ? "..." : ""}`);
            }
            reply = lines.join("\n");
          }
        } catch {
          reply = "⚠ 记忆搜索失败";
        }
        break;
      }

      case "cron": {
        const cronScheduler = this.registry?.resolveService<{ listJobs?(): Array<{ id: string; name: string; schedule: string; enabled: boolean; status?: string; lastRun?: Date; nextRun?: Date; runCount?: number; errorCount?: number }> }>("cronScheduler");
        if (!cronScheduler || !cronScheduler.listJobs) {
          reply = "⚠ 定时任务管理器不可用";
          break;
        }
        const jobs = cronScheduler.listJobs();
        if (jobs.length === 0) {
          reply = "⏰ 暂无定时任务";
        } else {
          const lines = [`**⏰ 定时任务** (${jobs.length})`, ""];
          for (const j of jobs) {
            const statusIcon = j.enabled ? "✅" : "⏸";
            const statusStr = j.status ? ` [${j.status}]` : "";
            const runInfo = j.runCount ? ` (运行 ${j.runCount} 次)` : "";
            lines.push(`- ${statusIcon} \`${j.name}\` — ${j.schedule}${statusStr}${runInfo}`);
          }
          reply = lines.join("\n");
        }
        break;
      }

      case "plugin": {
        const pluginManager = this.registry?.resolveService<{ getPlugins(): Array<{ manifest: { name: string; version: string; description: string; author?: string }; status: string; error?: string }> }>("pluginManager");
        if (!pluginManager) {
          reply = "⚠ 插件管理器不可用";
          break;
        }
        const plugins = pluginManager.getPlugins();
        if (plugins.length === 0) {
          reply = "🔌 暂无已安装插件";
        } else {
          const lines = [`**🔌 已安装插件** (${plugins.length})`, ""];
          for (const p of plugins) {
            const statusIcon = p.status === "active" ? "✅" : p.status === "disabled" ? "⏸" : "⚠";
            const author = p.manifest.author ? ` by ${p.manifest.author}` : "";
            const errTag = p.error ? ` — ❌ ${p.error}` : "";
            lines.push(`- ${statusIcon} **${p.manifest.name}** v${p.manifest.version}${author} — ${p.manifest.description}${errTag}`);
          }
          reply = lines.join("\n");
        }
        break;
      }

      case "focus": {
        if (args.length < 2) {
          reply = "用法: `/focus <type> <id>` — type 可以是 `channel`、`session`、`agent` 或 `peer`";
          break;
        }
        const [type, targetId] = args;
        const validTypes = ["channel", "session", "agent", "peer"];
        if (!validTypes.includes(type)) {
          reply = `⚠ 无效的聚焦类型: "${type}"。有效: ${validTypes.join(", ")}`;
        } else {
          reply = `✅ 已聚焦到 ${type}: \`${targetId}\``;
        }
        break;
      }

      case "unfocus": {
        reply = "✅ 已取消聚焦。消息将发送到广播模式。";
        break;
      }

      case "agents": {
        reply = "**📋 可用上下文目标**\n\n使用 `/focus <type> <id>` 聚焦到指定目标。";
        break;
      }

      default: {
        reply = `⚠ 未知命令: \`/${cmdName}\`。输入 \`/help\` 查看可用命令。`;
        break;
      }
    }

    if (action === "new_session" && this.sessionManager) {
      const newId = `sess_${Date.now()}`;
      this.sessionManager.createSession("default", { sessionId: newId });
      this.conversationHistory.delete(sessionId);
    }

    if (action === "reset_session" && this.sessionManager) {
      const resetId = `sess_${Date.now()}`;
      this.sessionManager.createSession("default", { sessionId: resetId });
      this.conversationHistory.delete(sessionId);
    }

    taskStatusTracker.set(sessionId, "done", "命令已执行", 100);

    return {
      reply,
      tokensUsed: 0,
      duration: Date.now() - startTime,
      permissionRequests: [],
      toolsExecuted: false,
      files: [],
    };
  }

  // ── System Config Query: direct response without LLM ──
  private handleSystemConfigQuery(
    message: string,
    skillManager: { searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>; listSkills(): unknown[]; executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown>; } | undefined,
    startTime: number,
    sessionId: string,
  ): { reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean } | null {
    if (message.length > 30) return null;

    const configKeywords = [
      /^(?:查|查看|显示|展示|告诉我)\s*(?:当前\s*)?(?:的\s*)?(?:配置|设置|模型|provider|模型列表|提供商|技能列表)/i,
      /^(?:当前|现在)\s*(?:的\s*)?(?:配置|设置|模型|provider|提供商)/i,
      /^系统(?:配置|设置|信息|模型|状态)/i,
      /^(?:config|configuration|system\s*info|model\s*info|check\s*config)\s*$/i,
      /^(?:什么|哪些)\s*(?:模型|provider|提供商|配置)\s*[？?]?\s*$/i,
      /^(?:how\s*(?:many|to)\s*|what\s*)(?:model|skill|provider|config)/i,
      /^(?:列出|list)\s*(?:模型|技能|配置|系统)/i,
    ];

    const matches = configKeywords.some(re => re.test(message.trim()));
    if (!matches) return null;

    console.log(`[AgentModelExecutor] System config query detected: "${message}" — responding directly`);
    taskStatusTracker.set(sessionId, "done", "配置查询完成", 100);

    const enabledProviders = this.providers.filter(p => p.enabled).sort((a, b) => a.order - b.order);
    const totalProviders = this.providers.length;
    const allSkills = skillManager ? (skillManager.listSkills() as Array<{ name: string; description?: string }>) : [];
    const toolCount = this.registeredTools.size;

    const lines: string[] = [];
    const ts = new Date().toLocaleString("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const separator = "─".repeat(36);

    lines.push(`📅 ${ts}\n`);
    lines.push(`## 🦞 EvoClaw 系统配置\n`);
    lines.push(`### 🤖 推理模型`);
    if (enabledProviders.length > 0) {
      for (let i = 0; i < enabledProviders.length; i++) {
        const p = enabledProviders[i];
        const tag = i === 0 ? " (主)" : "";
        lines.push(`  ${i + 1}. **${p.name}**${tag}`);
        lines.push(`     - 模型: \`${p.model}\``);
        lines.push(`     - 类型: \`${p.provider}\``);
        lines.push(`     - 超时: ${p.timeout / 1000}s | 最大 Token: ${p.maxTokens}`);
        if (p.baseURL) {
          lines.push(`     - 端点: \`${p.baseURL.replace(/\/+$/, "")}\``);
        }
      }
    } else {
      lines.push(`  - ⚠ 无已启用模型`);
    }
    if (totalProviders > enabledProviders.length) {
      lines.push(`  - 已禁用: ${totalProviders - enabledProviders.length} 个`);
    }

    lines.push(`\n### 🛠 可用工具 (${toolCount})`);
    if (toolCount > 0) {
      const toolNames = Array.from(this.registeredTools.keys()).slice(0, 12);
      lines.push(`  ${toolNames.map(t => `\`${t}\``).join(", ")}`);
      if (toolCount > 12) lines.push(`  ...及其他 ${toolCount - 12} 个工具`);
    } else {
      lines.push(`  - 无已注册工具`);
    }

    lines.push(`\n### 📦 技能 (Skills)`);
    if (allSkills.length > 0) {
      const statusMap = new Map<string, "installed" | "available">();
      for (const s of allSkills) {
        const name = s.name || (s as Record<string, unknown>).id as string || "unknown";
        statusMap.set(name, 
          (s as Record<string, unknown>).installed === false || (s as Record<string, unknown>).installed === "false" 
            ? "available" : "installed"
        );
      }
      const installed = Array.from(statusMap.entries()).filter(([, v]) => v === "installed");
      const available = Array.from(statusMap.entries()).filter(([, v]) => v === "available");
      
      if (installed.length > 0) {
        lines.push(`  **已安装** (${installed.length}): ${installed.map(([n]) => `\`${n}\``).join(", ")}`);
      }
      if (available.length > 0) {
        lines.push(`  **可安装** (${available.length}): ${available.map(([n]) => `\`${n}\``).join(", ")}`);
      }
    } else {
      lines.push(`  - 无已扫描技能，可执行"搜索技能"来发现可用技能`);
    }

    lines.push(`\n### 💾 系统信息`);
    lines.push(`  - Agent: ${this.persona.name} (${this.persona.title})`);
    lines.push(`  - 会话历史上限: ${this.maxHistoryLength} 轮`);
    lines.push(`  - 自动压缩: ${this.autoCompactionEnabled ? "已启用" : "未启用"}`);
    lines.push(`  - 压缩阈值: ${this.compactionTokenThreshold} tokens`);
    
    // Memory stats
    if (this.memoryHub) {
      try {
        const mem = this.memoryHub.getLongTerm();
        lines.push(`  - 长期记忆: 已集成`);
      } catch { /* ignore */ }
    }

    lines.push(`\n${separator}`);
    lines.push(`> 查询时间: ${ts} | 响应耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    return {
      reply: lines.join("\n"),
      tokensUsed: 0,
      duration: Date.now() - startTime,
      permissionRequests: [],
      toolsExecuted: false,
    };
  }

  private async handleSkillInstall(
    message: string,
    skillManager: { searchLocalSkills(query: Record<string, unknown>): Promise<unknown>; listSkills(): unknown[]; installSkill?(path: string): Promise<unknown> } | undefined,
    startTime: number,
    sessionId: string
  ): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean }> {
    try {
      // Get currently installed skills
      const installedSkills = await skillManager?.listSkills() || [];
      const installedNames = new Set(
        (installedSkills as Array<Record<string, unknown>>)
          .map((s) => (s.name as string) || "")
          .filter(Boolean)
      );

      // ── Detect if user wants to install specific skills ──
      // Match: "安装 weather, translator" or "安装 skill1 skill2"
      const specificSkillMatch = message.match(/(?:安装|下载|添加)\s*(?:技能)?\s*[:：]?\s*(.+)/i);
      const selectedSkills = this.extractSkillNames(message, specificSkillMatch);

      // ── Batch install mode ──
      if (selectedSkills.length > 0) {
        return await this.handleBatchSkillInstall(selectedSkills, installedNames, startTime);
      }

      // ── Browse mode: show available skills ──
      // Use SkillDispatcher for comprehensive skill discovery
      const skillDispatcher = this.registry?.resolveService<{
        getSkillSummary(): Promise<{
          local: Array<{ name: string; description: string; version: string }>;
          remote: Array<{ name: string; description: string; rating: number; downloads: number }>;
          installed: Array<{ name: string; id: string }>;
        }>;
        searchForTask(task: string, max?: number): Promise<Array<{ skillName: string; description?: string; relevance: number; source: string }>>;
      }>("skillDispatcher");

      let localSkills: Array<{ name: string; path?: string; description: string; version: string }> = [];
      let remoteSkills: Array<{ name: string; description: string; rating: number; downloads: number }> = [];

      if (skillDispatcher) {
        try {
          const summary = await skillDispatcher.getSkillSummary();
          const installedFromSummary = new Set(summary.installed.map(s => s.name));
          // Merge installedNames
          for (const s of summary.installed) { installedNames.add(s.name); }
          localSkills = summary.local.filter(s => !installedFromSummary.has(s.name));
          remoteSkills = summary.remote.filter(s => !installedFromSummary.has(s.name) && !localSkills.some(l => l.name === s.name));
        } catch (err) {
          console.warn(`[AgentModelExecutor] SkillDispatcher summary failed: ${err}`);
        }
      }

      // Fallback: use registry directly
      if (remoteSkills.length === 0) {
        try {
          const skillRegistry = this.registry?.resolveService<{
            searchRemote(query: Record<string, unknown>): Promise<{ entries: Array<{ name: string; description: string; version: string; rating: number; downloads: number; category: string }> }>;
          }>("skillRegistry");
          
          if (skillRegistry) {
            const result = await skillRegistry.searchRemote({ keyword: "", limit: 30, sortBy: "downloads" });
            if (result?.entries) {
              remoteSkills = result.entries
                .filter((s: { name: string }) => !installedNames.has(s.name))
                .map((s: { name: string; description: string; rating: number; downloads: number }) => ({
                  name: s.name,
                  description: s.description,
                  rating: s.rating,
                  downloads: s.downloads,
                }));
            }
          }
        } catch (err) {
          console.warn(`[AgentModelExecutor] Remote skill search failed: ${err}`);
        }
      }

      // Fallback: use AutoSkillManager for local discoverable skills
      if (localSkills.length === 0) {
        const autoSkillManager = this.registry?.resolveService<{
          listDiscoverableSkills(): Array<{ name: string; path: string; description: string; version: string }>;
        }>("autoSkillManager");
        if (autoSkillManager) {
          localSkills = autoSkillManager.listDiscoverableSkills()
            .filter(s => !installedNames.has(s.name));
        }
      }

      // Merge remote into unified list (remote not in local)
      const seenNames = new Set(localSkills.map(s => s.name));
      const allAvailable = [
        ...localSkills.map(s => ({ name: s.name, description: s.description, version: s.version, rating: 0, downloads: 0, source: "本地" as const })),
        ...remoteSkills.filter(s => !seenNames.has(s.name)).map(s => ({ name: s.name, description: s.description, version: "0.1.0", rating: s.rating, downloads: s.downloads, source: "远端" as const })),
      ];

      // Sort: local first, then by downloads
      allAvailable.sort((a, b) => {
        if (a.source !== b.source) return a.source === "本地" ? -1 : 1;
        return b.downloads - a.downloads;
      });

      const notInstalled = allAvailable.filter(s => !installedNames.has(s.name));

      if (notInstalled.length === 0) {
        return {
          reply: "✅ 所有可发现的技能已经安装完成！\n\n当前已安装: " + 
                 Array.from(installedNames).map(n => `\`${n}\``).join(", ") + 
                 "\n\n需要特定技能请告诉我名称，或描述任务我会自动匹配合适的技能。",
          tokensUsed: 0,
          duration: Date.now() - startTime,
          permissionRequests: [],
          toolsExecuted: false,
        };
      }

      // Build response with rich formatting
      let reply = "📦 **技能安装助手**\n\n";
      reply += `发现 **${notInstalled.length}** 个可安装技能：\n\n`;

      // Group: local first, then remote
      const localAvailable = notInstalled.filter(s => s.source === "本地");
      const remoteAvailable = notInstalled.filter(s => s.source === "远端");

      if (localAvailable.length > 0) {
        reply += "📁 **本地可用技能**\n";
        localAvailable.forEach((skill, i) => {
          reply += `${i + 1}. **\`${skill.name}\`** - ${skill.description || "无描述"}\n`;
        });
        reply += "\n";
      }

      if (remoteAvailable.length > 0) {
        reply += "🌐 **远端注册表技能**\n";
        remoteAvailable.forEach((skill, i) => {
          const stars = "★".repeat(Math.min(5, Math.floor(skill.rating))) + "☆".repeat(Math.max(0, 5 - Math.floor(skill.rating)));
          const label = skill.downloads > 20000 ? "🔥" : skill.downloads > 10000 ? "⭐" : "📌";
          reply += `${i + 1}. **\`${skill.name}\`** ${label} ${stars} (${(skill.downloads/1000).toFixed(0)}k) - ${skill.description || "无描述"}\n`;
        });
        reply += "\n";
      }

      reply += "---\n";
      reply += "💡 **安装方式**:\n";
      reply += "• 回复技能名安装: `安装 weather`\n";
      reply += "• 批量安装: `安装 weather, translator, news-search`\n";
      reply += "• 全部安装: `全部安装` 或 `install all`\n\n";
      reply += "已安装: " + (installedNames.size > 0 ? Array.from(installedNames).map(n => `\`${n}\``).join(", ") : "无") + "\n";

      return {
        reply,
        tokensUsed: 0,
        duration: Date.now() - startTime,
        permissionRequests: [],
        toolsExecuted: false,
      };
    } catch (err) {
      return {
        reply: `❌ 获取技能列表时出错: ${err instanceof Error ? err.message : String(err)}`,
        tokensUsed: 0,
        duration: Date.now() - startTime,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }
  }

  /**
   * Extract skill names from user message for batch install.
   */
  private extractSkillNames(message: string, regexMatch: RegExpMatchArray | null): string[] {
    const names: string[] = [];

    // "全部安装" or "install all" → return empty (caller handles)
    if (/全部安装|install\s+all|安装所有/i.test(message)) {
      return ["__ALL__"];
    }

    if (regexMatch && regexMatch[1]) {
      // Strip trailing punctuation and noise
      let raw = regexMatch[1].trim();
      // Remove trailing sentence-ending punctuation
      raw = raw.replace(/[。.!！?？]+$/, "").trim();
      // Remove trailing ", etc" or similar
      raw = raw.replace(/[,，]\s*(etc|等等|之类的)\s*$/i, "").trim();

      // Split by Chinese/English commas, Chinese enumeration markers, or whitespace
      const parts = raw.split(/[,，、，\s]+/).filter(Boolean);
      for (const part of parts) {
        const clean = part.trim();
        if (clean.length < 2) continue;
        if (/^(技能|skill|一个|几个|这些|那些|这个|哪个|帮我|给我|请|需要)$/i.test(clean)) continue;
        // Filter out pure Chinese phrases that are unlikely to be skill names
        // (skill names in this ecosystem use ASCII alphanumeric identifiers)
        if (/^[\u4e00-\u9fff]{2,}$/.test(clean)) continue;
        names.push(clean);
      }
    }

    // Also try to extract skill names from pattern like "安装 skill1 skill2"
    const altMatch = message.match(/安装\s+([\w-]+(?:\s+[\w-]+)*)/i);
    if (altMatch && names.length === 0) {
      const parts = altMatch[1].split(/\s+/).filter(s => s.length >= 2 && s !== "技能" && s !== "skill");
      names.push(...parts);
    }

    return names;
  }

  /**
   * Handle batch installation of specific skills.
   */
  private async handleBatchSkillInstall(
    selectedSkills: string[],
    installedNames: Set<string>,
    startTime: number
  ): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean }> {
    // "全部安装" special case
    if (selectedSkills.length === 1 && selectedSkills[0] === "__ALL__") {
      const autoSkillManager = this.registry?.resolveService<{
        listDiscoverableSkills(): Array<{ name: string }>;
      }>("autoSkillManager");
      
      if (autoSkillManager) {
        const all = autoSkillManager.listDiscoverableSkills()
          .map(s => s.name)
          .filter(n => !installedNames.has(n));
        selectedSkills = all;
      } else {
        // Fallback: try skillManager's list
        const sm = this.registry?.resolveService<{
          listSkills(): Array<{ name: string }>;
        }>("skillManager");
        if (sm) {
          selectedSkills = sm.listSkills().map(s => s.name).filter(n => !installedNames.has(n));
        }
      }

      if (selectedSkills.length === 0) {
        return {
          reply: "❌ 没有找到可安装的技能。请先确保 `skills/` 目录下有 SKILL.md 文件。",
          tokensUsed: 0,
          duration: Date.now() - startTime,
          permissionRequests: [],
          toolsExecuted: false,
        };
      }
    }

    // Filter out already installed
    const toInstall = selectedSkills.filter(s => !installedNames.has(s));

    if (toInstall.length === 0) {
      return {
        reply: "✅ 这些技能都已经安装过了！",
        tokensUsed: 0,
        duration: Date.now() - startTime,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }

    // Use AutoSkillManager for batch install
    const autoSkillManager = this.registry?.resolveService<{
      batchInstall(names: string[], onProgress?: (p: { phase: string; current: number; total: number; skillName: string; status: string; message: string }) => void): Promise<{
        success: Array<{ skillName: string }>;
        failed: Array<{ name: string; reason: string }>;
      }>;
    }>("autoSkillManager");

    if (autoSkillManager) {
      const progressLines: string[] = [];
      const result = await autoSkillManager.batchInstall(toInstall, (progress) => {
        const icon = progress.status === "installed" ? "✅" : progress.status === "failed" ? "❌" : progress.status === "installing" ? "⏳" : "📌";
        progressLines.push(`${icon} [${progress.current}/${progress.total}] ${progress.message}`);
      });

      let reply = `📦 **批量安装结果**\n\n`;
      
      if (result.success.length > 0) {
        reply += `✅ 成功安装 **${result.success.length}** 个技能:\n`;
        result.success.forEach(s => {
          reply += `  • \`${s.skillName}\`\n`;
        });
      }

      if (result.failed.length > 0) {
        reply += `\n❌ **${result.failed.length}** 个失败:\n`;
        result.failed.forEach(f => {
          reply += `  • \`${f.name}\`: ${f.reason}\n`;
        });
      }

      reply += `\n---\n<details><summary>📋 安装进度</summary>\n\n${progressLines.join("\n")}\n</details>`;

      return {
        reply,
        tokensUsed: 0,
        duration: Date.now() - startTime,
        permissionRequests: [],
        toolsExecuted: true,
      };
    }

    // Fallback: try installing one by one via skillManager
    let reply = "📦 **手动安装**\n\n";
    const sm = this.registry?.resolveService<{
      installSkill(path: string): Promise<{ name: string }>;
    }>("skillManager");
    
    if (!sm) {
      return {
        reply: "❌ 技能管理器未就绪，无法安装。",
        tokensUsed: 0,
        duration: Date.now() - startTime,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }

    const successList: string[] = [];
    const failList: Array<{ name: string; reason: string }> = [];

    for (const name of toInstall) {
      try {
        // Resolve path from name
        const autoSm = this.registry?.resolveService<{
          listDiscoverableSkills(): Array<{ name: string; path: string }>;
        }>("autoSkillManager");
        
        let skillPath: string | null = null;
        if (autoSm) {
          const found = autoSm.listDiscoverableSkills().find(s => s.name === name);
          if (found) skillPath = found.path;
        }
        
        if (!skillPath) {
          failList.push({ name, reason: "未找到技能文件" });
          continue;
        }

        const installed = await sm.installSkill(skillPath);
        successList.push(installed.name);
      } catch (err) {
        failList.push({ name, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    if (successList.length > 0) {
      reply += `✅ 成功: ${successList.map(n => `\`${n}\``).join(", ")}\n`;
    }
    if (failList.length > 0) {
      reply += `❌ 失败: ${failList.map(f => `\`${f.name}\` (${f.reason})`).join(", ")}\n`;
    }

    return {
      reply,
      tokensUsed: 0,
      duration: Date.now() - startTime,
      permissionRequests: [],
      toolsExecuted: true,
    };
  }

  private computeDynamicToolLimit(message: string, baseLimit: number, cap: number): number {
    const lower = message.toLowerCase();
    let limit = baseLimit;

    const complexPatterns = [
      /搜索.*新闻|search.*news/i,
      /整理.*报告|compile.*report/i,
      /分析.*代码|analyze.*code/i,
      /调试|debug/i,
      /部署|deploy/i,
      /重构|refactor/i,
      /批量|batch/i,
      /对比.*分析|comparative.*analysis/i,
      /多步|multi.?step/i,
      /完整.*流程|complete.*workflow/i,
    ];
    const veryComplexPatterns = [
      /搜索.*整理.*报告/i,
      /分析.*修复.*测试/i,
      /调研.*对比.*建议/i,
      /全面.*分析.*方案/i,
      /帮我.*搜索.*github/i,
      /本周.*重大.*新闻/i,
    ];

    if (veryComplexPatterns.some(p => p.test(lower))) {
      limit = Math.min(cap, baseLimit + 20);
    } else if (complexPatterns.some(p => p.test(lower))) {
      limit = Math.min(cap, baseLimit + 10);
    }

    if (this.hasActionIntent(message)) {
      limit = Math.min(cap, limit + 5);
    }

    const sessionHistory = this.conversationHistory.get("default") || [];
    if (sessionHistory.length > 20) {
      limit = Math.max(baseLimit, limit - 5);
    }

    return Math.min(cap, limit);
  }

  private hasActionIntent(message: string): boolean {
    const lower = message.toLowerCase();
    const actionKeywords = [
      "创建", "生成", "删除", "修改", "写入", "读取", "列出",
      "create", "generate", "delete", "modify", "write", "read", "list",
      "文件夹", "html", "css", "网页", "代码",
      "folder", "directory", "mkdir",
      "安装", "卸载", "install", "uninstall", "搜索", "search",
      "保存", "save",
      "搜索", "查找", "获取", "总结", "分析", "整理",
      "新闻", "热搜", "天气", "邮件",
    ];
    const excludePatterns = [
      /系统\s*中/i,
      /是否/i,
      /有没有/i,
      /是不是/i,
      /怎么样/i,
      /什么是/i,
      /为什么/i,
      /如何/i,
    ];
    if (excludePatterns.some(p => p.test(message))) return false;
    return actionKeywords.some((kw) => lower.includes(kw));
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
    onProgress?: AgentProgressCallback
  ): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>; toolsExecuted: boolean; files: Array<{ path: string; size: number; downloadUrl: string }> } | null> {
    const BASE_MAX_TOOL_ROUNDS = 20;
    const MAX_TOOL_ROUNDS_CAP = 50;
    const MAX_CONSECUTIVE_ERRORS = 3;

    const maxToolRounds = this.computeDynamicToolLimit(message, BASE_MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS_CAP);
    console.log(`[AgentModelExecutor] Dynamic tool limit for session "${sessionId}": ${maxToolRounds} (base=${BASE_MAX_TOOL_ROUNDS}, cap=${MAX_TOOL_ROUNDS_CAP})`);

    let totalTokensUsed = 0;
    let anyToolExecuted = false;
    const createdFiles: Array<{ path: string; size: number; downloadUrl: string }> = [];

    const skillsPrompt = await this.buildSkillsPromptForRun();

    for (const provider of providers) {
      let consecutiveErrors = 0;

      try {
        const history = this.conversationHistory.get(sessionId) || [];

        const webToolStrategy = `### Web Tool Decision Strategy (ReAct)
Follow this decision tree when handling web-related tasks:

\`\`\`
Have a specific URL?
├─ YES → Is it static content (article/doc/API/RSS)?
│        ├─ YES → web_fetch
│        │        Failed (blank/403/CAPTCHA)? → Try skill_execute with search skills → browser
│        └─ NO (needs JS/login/interaction/screenshot) → browser_navigate
└─ NO  → web_search (or skill_execute with tavily-search/baidu-search)
         ├─ Success → For result URLs, apply the URL logic above
         ├─ Failed → Try skill_execute with tavily-search or baidu-search
         └─ No results → browser_search
\`\`\`

**Key rules:**
1. For search tasks, prefer skill_execute with **tavily-search** (highest quality) or **baidu-search** over web_search
2. When web_search returns no results, try tavily-search or baidu-search via skill_execute before giving up
3. Always inform the user when switching tools — never silently downgrade
4. For Chinese content, baidu-search often works better; for English/global content, tavily-search is preferred`;

        const fullSystemPrompt = skillsPrompt
          ? `${systemPrompt}\n\n## Available Capabilities\n\n### Tools\nYou have access to tools including: **web_search** (search the web for live information), **web_fetch** (fetch and extract content from web pages), **skill_execute** (execute installed skills like tavily-search, baidu-search), and many more.\n\n${webToolStrategy}\n\n### Skills\nScan the available skills below. If one clearly applies, use skill_execute to invoke it. For search tasks, prefer **tavily-search** or **baidu-search** over generic web_search.\nOne skill up front max. Never guess or fabricate skill paths.\n${skillsPrompt}`
          : systemPrompt;

        if (this.needsCompaction(sessionId, fullSystemPrompt, this.config.maxTokens)) {
          console.log(`[AgentModelExecutor] Auto-compaction triggered for session "${sessionId}"`);
          this.compactConversationHistory(sessionId);
        }

        const messages: Array<{ role: string; content: string | null | ChatContent[]; tool_calls?: unknown[]; tool_call_id?: string; name?: string }> = [
          { role: "system", content: fullSystemPrompt },
        ];

        messages.push(...history);

        // Build user message — use multimodal format when images are attached
        const imageAtts = attachments?.filter(a => a.type.startsWith("image/") && a.data?.startsWith("data:"));
        if (imageAtts && imageAtts.length > 0) {
          const contentParts: ChatContent[] = [];
          if (message) {
            contentParts.push({ type: "text", text: message });
          }
          for (const img of imageAtts) {
            contentParts.push({
              type: "image_url",
              image_url: { url: img.data!, detail: "auto" },
            });
          }
          messages.push({ role: "user", content: contentParts });
        } else {
          messages.push({ role: "user", content: message });
        }

        const tools = this.buildOpenAITools();
        const isAction = this.hasActionIntent(message);

        let conversationMessages = [...messages];
        let finalReply = "";

        for (let round = 0; round < maxToolRounds; round++) {
          onProgress?.({ type: "llm_call", phase: "thinking", detail: `正在调用 ${provider.name} (${provider.model})，第 ${round + 1} 轮...`, progress: 30 + round * 3, providerName: provider.name, round: round + 1 });
          const tc: "auto" | "required" = "auto";
          const result = await this.callLLMOnce(provider, conversationMessages, tools, tc, onProgress);

          if (!result) {
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
            continue;
          }

          const classified = result.classifiedError;
          if (classified && classified.type !== LLMErrorType.UNKNOWN) {
            consecutiveErrors++;
            console.warn(`[AgentModelExecutor] Error classified as "${classified.type}" for provider "${provider.name}": ${classified.message}`);

            if (classified.type === LLMErrorType.CONTEXT_OVERFLOW && classified.shouldCompact) {
              console.log(`[AgentModelExecutor] Compacting due to context overflow...`);
              this.compactConversationHistory(sessionId);
              conversationMessages = [
                { role: "system", content: fullSystemPrompt },
                ...(this.conversationHistory.get(sessionId) || []),
              ];
              // Rebuild user message with multimodal support
              if (imageAtts && imageAtts.length > 0) {
                const retryParts: ChatContent[] = [];
                if (message) retryParts.push({ type: "text", text: message });
                for (const img of imageAtts) {
                  retryParts.push({ type: "image_url", image_url: { url: img.data!, detail: "auto" } });
                }
                conversationMessages.push({ role: "user", content: retryParts });
              } else {
                conversationMessages.push({ role: "user", content: message });
              }
            }

            if (classified.type === LLMErrorType.RATE_LIMIT && classified.backoffMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, classified.backoffMs));
            }

            if (classified.type === LLMErrorType.AUTH || classified.type === LLMErrorType.BILLING) {
              console.warn(`[AgentModelExecutor] Skipping provider "${provider.name}" due to ${classified.type}`);
              break;
            }

            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
            continue;
          }

          consecutiveErrors = 0;
          totalTokensUsed += result.tokensUsed;

          const TOKEN_BUDGET = 200000;
          if (totalTokensUsed > TOKEN_BUDGET * 0.8 && totalTokensUsed <= TOKEN_BUDGET * 0.8 + result.tokensUsed) {
            console.warn(`[AgentModelExecutor] Token budget warning: ${totalTokensUsed}/${TOKEN_BUDGET} (80%) for session "${sessionId}"`);
            conversationMessages.push({ role: "user", content: "⚠ 预算提醒：已使用超过 80% 的 token 预算。请尽快总结当前结果并回复用户。" });
          }
          if (totalTokensUsed > TOKEN_BUDGET) {
            console.warn(`[AgentModelExecutor] Token budget exceeded: ${totalTokensUsed}/${TOKEN_BUDGET} for session "${sessionId}". Forcing summary.`);
            break;
          }

          const assistantMsg = result.message;

          if (assistantMsg.content) {
            finalReply = assistantMsg.content;
          }

          const toolCalls = assistantMsg.tool_calls;
          if (!toolCalls || toolCalls.length === 0) {
            conversationMessages.push(assistantMsg);
            break;
          }

          conversationMessages.push(assistantMsg);

          for (const tc of toolCalls) {
            const toolStartTime = Date.now();
            const toolName = tc.function.name;
            const toolEntry = this.registeredTools.get(toolName);

            // ── Task status: executing tool ──
            taskStatusTracker.set(sessionId, "tool_calling", `正在执行: ${toolName}...`, 50 + Math.floor((toolCalls.indexOf(tc) / toolCalls.length) * 20));
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* ignore parse errors */ }
            onProgress?.({ type: "tool_call", phase: "tool_calling", detail: `正在执行工具: ${toolName}`, progress: 50 + Math.floor((toolCalls.indexOf(tc) / toolCalls.length) * 20), toolName, toolArgs: args, round: round + 1 });

            // ── Plugin hook: before_tool_call ──
            let skipWithResult: unknown = undefined;

            if (this.pluginManager?.hasHooks("before_tool_call")) {
              const { blocked, cancelled, merged } = await this.pluginManager.runHooksMerged({
                type: "before_tool_call",
                context: { sessionId, agentId: "default", channel: "web-ui" },
                toolName,
                params: args,
              });
              if (cancelled || blocked) {
                conversationMessages.push({
                  role: "tool",
                  tool_call_id: tc.id,
                  name: toolName,
                  content: JSON.stringify({ skipped: true, reason: blocked ? "blocked" : "cancelled" }),
                });
                continue;
              }
              const mergedBTC = merged as Partial<import("@evoclaw/core").BeforeToolCallResult>;
              if (mergedBTC.params) args = mergedBTC.params as Record<string, unknown>;
              if (mergedBTC.skipWithResult !== undefined) {
                skipWithResult = mergedBTC.skipWithResult;
              }
            }

            let toolResult: string;
            let toolErrored = false;
            let toolError: string | undefined;
            let rawResult: unknown = undefined;

            if (toolEntry) {
              try {
                if (skipWithResult !== undefined) {
                  rawResult = skipWithResult;
                  toolResult = JSON.stringify(skipWithResult);
                } else {
                  // ── Tool execution with timeout ──
                  // Long-running tools get extended timeout
                  const LONG_RUNNING_TOOLS = new Set([
                    "execute_programming_task", "decompose_programming_task",
                    "browser_launch", "browser_screenshot", "browser_login",
                    "get_task_result",
                  ]);
                  const TOOL_TIMEOUT = LONG_RUNNING_TOOLS.has(toolName) ? 300000 : 30000;
                  const toolPromise = toolEntry.handler(args);
                  const toolTimeoutPromise = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${TOOL_TIMEOUT / 1000}s`)), TOOL_TIMEOUT)
                  );
                  rawResult = await Promise.race([toolPromise, toolTimeoutPromise]);
                  toolResult = JSON.stringify(rawResult);
                }
                anyToolExecuted = true;

                if ((toolName === "file_create" || toolName === "file_modify") && rawResult && typeof rawResult === "object") {
                  const r = rawResult as Record<string, unknown>;
                  if (r.path && typeof r.path === "string") {
                    createdFiles.push({
                      path: r.path as string,
                      size: (r.size as number) || 0,
                      downloadUrl: `/api/files/download/${(r.path as string).replace(/\\/g, "/")}`,
                    });
                  }
                }

                // Record successful tool execution in EventLedger
                const ledger = this.getEventLedger();
                if (ledger) {
                  ledger.recordToolExecution(toolName, args, rawResult, Date.now() - toolStartTime, { agentId: "default", sessionId });
                }

                // Truncate huge tool results to prevent context overflow
                const isBrowser = toolName.startsWith("browser_");
                const isWebTool = toolName === "web_search" || toolName === "web_fetch" || toolName === "fetch_node_page" || toolName === "skill_execute" || toolName === "browser_search" || toolName === "browser_navigate";
                if (isWebTool && rawResult && typeof rawResult === "object") {
                  const r = rawResult as Record<string, unknown>;
                  if (typeof r.content === "string" && r.content.length > 100) {
                    r.content = AgentModelExecutor.stripWebNoise(r.content);
                  }
                  if (typeof r.text === "string" && r.text.length > 100) {
                    r.text = AgentModelExecutor.stripWebNoise(r.text);
                  }
                  if (typeof r.body === "string" && r.body.length > 100) {
                    r.body = AgentModelExecutor.stripWebNoise(r.body);
                  }
                  if (typeof r.snippet === "string" && r.snippet.length > 100) {
                    r.snippet = AgentModelExecutor.stripWebNoise(r.snippet);
                  }
                  if (Array.isArray(r.results)) {
                    for (const item of r.results as Array<Record<string, unknown>>) {
                      if (typeof item.snippet === "string" && item.snippet.length > 100) {
                        item.snippet = AgentModelExecutor.stripWebNoise(item.snippet as string);
                      }
                      if (typeof item.content === "string" && item.content.length > 100) {
                        item.content = AgentModelExecutor.stripWebNoise(item.content as string);
                      }
                    }
                  }
                  if (typeof r.output === "string" && r.output.length > 200) {
                    r.output = AgentModelExecutor.stripWebNoise(r.output);
                  }
                  toolResult = JSON.stringify(r);
                }
                const MAX_RESULT_LEN = isBrowser ? 8000 : 16000;
                if (toolResult.length > MAX_RESULT_LEN) {
                  const truncated = JSON.stringify({ truncated: true, originalLength: toolResult.length, preview: toolResult.slice(0, MAX_RESULT_LEN), hint: `结果已截断(原${toolResult.length}字符)，请使用 browser_get_text 获取特定内容` });
                  toolResult = truncated;
                }
                if (rawResult && typeof rawResult === "object" && (rawResult as Record<string, unknown>).requiresPermission) {
                  const r = rawResult as Record<string, unknown>;
                  const requestId = (r.requestId as string) || (r.id as string) || "";
                  pendingPermissions.push({
                    id: requestId,
                    operation: (r.operation as string) || toolName,
                    description: (r.description as string) || "需要权限确认",
                    target: (r.target as string) || tc.function.name,
                  });
                  
                  if (requestId) {
                    this.pendingOperations.set(requestId, { sessionId: sessionId, message: message, requestId: requestId, toolName: toolName, toolArgs: args });
                  }
                }
                console.log(`[AgentModelExecutor] Tool "${toolName}" executed successfully`);
                onProgress?.({ type: "tool_result", phase: "tool_calling", detail: `工具 ${toolName} 执行完成`, progress: 55 + Math.floor((toolCalls.indexOf(tc) / toolCalls.length) * 20), toolName, toolResult: toolResult.slice(0, 200), toolError: false, round: round + 1 });
                try {
                  const toolObs = this.registry?.resolveService<any>("observability");
                  if (toolObs) {
                    const latency = Date.now() - toolStartTime;
                    toolObs.counterIncrement("evoclaw_tool_calls_total", [{ key: "tool", value: toolName || "unknown" }, { key: "status", value: "success" }], 1);
                    toolObs.histogramObserve("evoclaw_tool_latency_ms", latency, [{ key: "tool", value: toolName || "unknown" }, { key: "status", value: "success" }]);
                  }
                } catch { /* observability is best-effort */ }
              } catch (err: unknown) {
                toolResult = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
                toolErrored = true;
                toolError = err instanceof Error ? err.message : String(err);
                console.warn(`[AgentModelExecutor] Tool "${toolName}" failed:`, toolResult);
                onProgress?.({ type: "tool_result", phase: "tool_calling", detail: `工具 ${toolName} 执行失败: ${toolError}`, progress: 55, toolName, toolResult: toolError, toolError: true, round: round + 1 });

                try {
                  const toolErrObs = this.registry?.resolveService<any>("observability");
                  if (toolErrObs) {
                    const latency = Date.now() - toolStartTime;
                    toolErrObs.counterIncrement("evoclaw_tool_calls_total", [{ key: "tool", value: toolName || "unknown" }, { key: "status", value: "error" }], 1);
                    toolErrObs.histogramObserve("evoclaw_tool_latency_ms", latency, [{ key: "tool", value: toolName || "unknown" }, { key: "status", value: "error" }]);
                  }
                } catch { /* observability is best-effort */ }

                // Record failed tool execution in EventLedger
                const ledger = this.getEventLedger();
                if (ledger) {
                  ledger.append("error", { tool: toolName, params: args, error: toolError }, { agentId: "default", sessionId, duration: Date.now() - toolStartTime });
                }
              }
            } else {
              toolResult = JSON.stringify({ error: `Tool "${toolName}" not found` });
              toolErrored = true;
              toolError = `Tool "${toolName}" not found`;
            }

            // ── Plugin hook: after_tool_call ──
            if (this.pluginManager?.hasHooks("after_tool_call")) {
              const { merged } = await this.pluginManager.runHooksMerged({
                type: "after_tool_call",
                context: { sessionId, agentId: "default", channel: "web-ui" },
                toolName,
                params: args,
                result: (() => { try { return JSON.parse(toolResult); } catch { return toolResult; } })(),
                errored: toolErrored,
                error: toolError,
              });
              const mergedATC = merged as Partial<import("@evoclaw/core").AfterToolCallResult>;
              if (mergedATC.result !== undefined) {
                toolResult = typeof mergedATC.result === "string" ? mergedATC.result : JSON.stringify(mergedATC.result);
              }
            }

            conversationMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: toolName,
              content: toolResult,
            });
          }

          if (!finalReply && round === maxToolRounds - 1) {
            try {
              const summaryMessages = [
                ...conversationMessages,
                { role: "user" as const, content: "请根据以上工具执行结果，总结回答用户的问题。" as string | null },
              ];
              const summaryResult = await this.callLLMOnce(provider, summaryMessages, [], "auto", onProgress);
              if (summaryResult && summaryResult.message?.content) {
                finalReply = summaryResult.message.content;
                totalTokensUsed += summaryResult.tokensUsed;
              } else {
                finalReply = "工具已执行完毕，但未能生成总结回复。";
              }
            } catch {
              finalReply = "工具已执行完毕，但未能生成总结回复。";
            }
          }
        }

        if (finalReply) {
          // Persist via SessionManager (primary) + legacy fallback
          if (this.sessionManager) {
            try {
              const agentId = "default";
              this.sessionManager.getOrCreateSession(agentId, sessionId);
              this.sessionManager.appendTurn(agentId, sessionId, {
                turnIndex: 0, role: "user", content: message, timestamp: new Date().toISOString(),
              });
              this.sessionManager.appendTurn(agentId, sessionId, {
                turnIndex: 0, role: "assistant", content: finalReply, timestamp: new Date().toISOString(),
                toolCalls: anyToolExecuted ? [{ id: "tool-call", name: "llm_tools", arguments: {} }] : undefined,
              });
            } catch (err) {
              console.warn(`[AgentModelExecutor] SessionManager persist failed: ${err}`);
            }
          }
          this.persistSessionTurn(sessionId, "user", message);
          this.persistSessionTurn(sessionId, "assistant", finalReply, { tokensUsed: totalTokensUsed });

          const cleanHistory: Array<{ role: string; content: string | null }> = [
            { role: "user", content: message },
            { role: "assistant", content: finalReply },
          ];
          const newHistory = [...history, ...cleanHistory];
          if (newHistory.length > this.maxHistoryLength) {
            newHistory.splice(0, newHistory.length - this.maxHistoryLength);
          }
          this.conversationHistory.set(sessionId, newHistory);

          // Record session end in EventLedger
          const ledgerEnd = this.getEventLedger();
          if (ledgerEnd) {
            ledgerEnd.append("session_end", { toolsExecuted: anyToolExecuted, totalTokens: totalTokensUsed, durationMs: Date.now() - startTime }, { agentId: "default", sessionId });
          }

          return {
            reply: finalReply,
            tokensUsed: totalTokensUsed,
            duration: Date.now() - startTime,
            permissionRequests: pendingPermissions.length > 0 ? pendingPermissions : [],
            toolsExecuted: anyToolExecuted,
            files: createdFiles,
          };
        }

        console.warn(`[AgentModelExecutor] LLM provider "${provider.name}" returned empty response`);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          console.warn(`[AgentModelExecutor] LLM provider "${provider.name}" timed out after ${provider.timeout || 60000}ms`);
        } else if (err instanceof Error) {
          console.warn(`[AgentModelExecutor] LLM provider "${provider.name}" error: ${err.message}`);
          console.warn(`[AgentModelExecutor] Error stack: ${err.stack?.slice(0, 500)}`);
        } else {
          console.warn(`[AgentModelExecutor] LLM provider "${provider.name}" unknown error: ${String(err)}`);
        }
      }
    }

    const fallbackReply = "抱歉，所有已启用的模型提供商均未能响应。请检查：\n1. 模型 API Key 是否正确配置\n2. 模型服务是否在线\n3. 网络连接是否正常\n\n可前往 Ops 页面查看详细诊断信息。";
    console.error(`[AgentModelExecutor] All ${providers.length} provider(s) failed for session "${sessionId}". Provider details: ${providers.map(p => `${p.name}(${p.provider}/${p.model}, baseURL=${p.baseURL?.slice(0, 50)}, timeout=${p.timeout}ms)`).join("; ")}. Returning fallback message.`);
    return {
      reply: fallbackReply,
      tokensUsed: 0,
      duration: Date.now() - startTime,
      permissionRequests: pendingPermissions,
      toolsExecuted: false,
      files: [],
    };
  }

  private buildOpenAITools(): Array<{ type: string; function: { name: string; description: string; parameters: { type: string; properties: Record<string, unknown>; required: string[] } } }> {
    // Only send essential tools to the LLM — too many tools cause decision paralysis.
    // These names MUST match actual registered tools.
    const essentialTools = new Set([
      "web_search", "web_fetch", "fetch_node_page", "file_read", "file_create",
      "file_modify", "file_list", "file_delete", "skill_execute", "skill_install",
      "skill_search", "skill_find_and_install", "skill_view", "skill_index_list",
      "email_send", "email_add_account",
      "browser_navigate", "browser_search", "browser_launch", "browser_screenshot",
      "browser_get_text", "browser_get_html", "browser_click", "browser_fetch_json",
      "execute_programming_task", "decompose_programming_task", "assess_coding_capability", "get_task_result",
      "markitdown_convert",
    ]);
    return Array.from(this.registeredTools.values())
      .filter((t) => essentialTools.has(t.definition.name))
      .map((t) => {
      const props: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, paramDef] of Object.entries(t.definition.parameters)) {
        const p = paramDef as Record<string, unknown>;
        props[key] = {
          type: p.type || "string",
          description: p.description || key,
        };
        // Only mark parameters without defaults as required
        if (p.required !== false && p.default === undefined) {
          required.push(key);
        }
      }

      return {
        type: "function",
        function: {
          name: t.definition.name,
          description: t.definition.description,
          parameters: {
            type: "object",
            properties: props,
            required,
          },
        },
      };
    });
  }

  private async callLLMOnce(
    provider: ProviderConfig,
    messages: Array<{ role: string; content: string | null | ChatContent[]; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
    tools: Array<{ type: string; function: Record<string, unknown> }>,
    toolChoice: "auto" | "required" = "auto",
    onProgress?: AgentProgressCallback
  ): Promise<{ message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }; tokensUsed: number; classifiedError?: ClassifiedError } | null> {
    const timeout = provider.timeout || 60000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const baseURL = provider.baseURL || "";
    let apiURL = baseURL;
    if (!apiURL.endsWith("/chat/completions") && !apiURL.endsWith("/v1/chat/completions")) {
      apiURL = apiURL.replace(/\/+$/, "");
      if (!apiURL.endsWith("/v1")) {
        apiURL = `${apiURL}/v1`;
      }
      apiURL = `${apiURL}/chat/completions`;
    }

    const startTime = Date.now();

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (provider.apiKey) {
        if (provider.provider === "anthropic") {
          headers["x-api-key"] = provider.apiKey;
          headers["anthropic-version"] = "2023-06-01";
        } else {
          headers["Authorization"] = `Bearer ${provider.apiKey}`;
        }
      }

      const useStreaming = !!onProgress;

      const body: Record<string, unknown> = {
        model: provider.model,
        messages: messages.map((m) => {
          const msg: Record<string, unknown> = { role: m.role };
          if (m.content !== undefined) msg.content = m.content;
          if (m.tool_calls) msg.tool_calls = m.tool_calls;
          if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
          if (m.name) msg.name = m.name;
          return msg;
        }),
        max_tokens: provider.maxTokens || 4096,
        temperature: provider.temperature || 0.3,
        top_p: provider.topP ?? 1,
        stream: useStreaming,
      };

      if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = toolChoice;
        
        if (provider.provider === "deepseek" || provider.name.toLowerCase().includes("deepseek")) {
          // Keep the original tool_choice intent; DeepSeek supports "auto" and "required"
          body.reasoning_type = "deepseek_reasoning";
        }
      }

      console.log(`[AgentModelExecutor] 📡 Calling ${provider.name} API: ${apiURL} (model: ${provider.model}, tool_choice: ${body.tool_choice}, tools: ${tools.length})`);
      const response = await fetch(apiURL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const classified = classifyLLMError(response.status, errorText);
        console.error(
          `[AgentModelExecutor] ❌ LLM API FAILED for "${provider.name}": HTTP ${response.status} [${classified.type}]\n` +
          `  URL: ${apiURL}\n` +
          `  Model: ${provider.model}\n` +
          `  Error: ${errorText.slice(0, 500)}`
        );

        // 记录失败统计
        this.recordProviderFailure(provider.id, `HTTP ${response.status}: ${errorText}`, classified.type);

        return {
          message: { role: "assistant", content: null },
          tokensUsed: 0,
          classifiedError: classified,
        };
      }

      if (useStreaming && response.body) {
        return await this.parseStreamingResponse(response, provider, startTime, onProgress!);
      }

      const data = await response.json() as {
        choices?: Array<{
          message?: {
            role?: string;
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              type: string;
              function: { name: string; arguments: string };
            }>;
          };
        }>;
        usage?: { total_tokens?: number };
      };

      const choice = data.choices?.[0];
      const msg = choice?.message;
      if (!msg) return null;

      const obs = this.registry?.resolveService<any>("observability");
      if (obs) {
        const latency = Date.now() - startTime;
        try {
          obs.counterIncrement("evoclaw_llm_calls_total", [{ key: "provider", value: provider.provider || "unknown" }, { key: "model", value: provider.model || "unknown" }, { key: "status", value: "success" }], 1);
          obs.histogramObserve("evoclaw_llm_latency_ms", latency, [{ key: "provider", value: provider.provider || "unknown" }, { key: "model", value: provider.model || "unknown" }, { key: "status", value: "success" }]);
        } catch { /* observability is best-effort */ }
      }

      // 记录成功统计
      this.recordProviderSuccess(provider.id);

      return {
        message: {
          role: msg.role || "assistant",
          content: msg.content ?? null,
          tool_calls: msg.tool_calls,
        },
        tokensUsed: data.usage?.total_tokens || 0,
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const obs = this.registry?.resolveService<any>("observability");
      if (obs) {
        const latency = Date.now() - startTime;
        try {
          obs.counterIncrement("evoclaw_llm_calls_total", [{ key: "provider", value: provider.provider || "unknown" }, { key: "model", value: provider.model || "unknown" }, { key: "status", value: "error" }], 1);
          obs.histogramObserve("evoclaw_llm_latency_ms", latency, [{ key: "provider", value: provider.provider || "unknown" }, { key: "model", value: provider.model || "unknown" }, { key: "status", value: "error" }]);
        } catch { /* observability is best-effort */ }
      }
      let classified: ClassifiedError | undefined;
      let errorMessage = "Unknown error";
      let errorType = "UNKNOWN";
      if (err instanceof DOMException && err.name === "AbortError") {
        const msg = `LLM provider "${provider.name}" timed out after ${timeout}ms`;
        console.warn(`[AgentModelExecutor] ${msg}`);
        classified = classifyLLMError(undefined, undefined, msg);
        errorMessage = msg;
        errorType = "TIMEOUT";
      } else if (err instanceof Error) {
        errorMessage = err.message;
        console.error(`[AgentModelExecutor] ❌ LLM fetch failed for "${provider.name}": ${errorMessage}`);
        console.error(`  URL: ${apiURL}, Model: ${provider.model}, Timeout: ${timeout}ms`);
        classified = classifyLLMError(undefined, undefined, errorMessage);
        errorType = classified?.type || "UNKNOWN";
      }

      // 记录失败统计
      this.recordProviderFailure(provider.id, errorMessage, errorType);

      return {
        message: { role: "assistant", content: null },
        tokensUsed: 0,
        classifiedError: classified,
      };
    }
  }

  private async parseStreamingResponse(
    response: Response,
    provider: ProviderConfig,
    startTime: number,
    onProgress: AgentProgressCallback
  ): Promise<{ message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }; tokensUsed: number } | null> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let content = "";
    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
    let totalTokens = 0;
    let lastChunkTime = Date.now();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === "[DONE]") continue;

          try {
            const chunk = JSON.parse(dataStr) as {
              choices?: Array<{
                delta?: {
                  content?: string | null;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    type?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string;
              }>;
              usage?: { total_tokens?: number };
            };

            const choice = chunk.choices?.[0];
            if (!choice?.delta) continue;

            if (choice.delta.content) {
              content += choice.delta.content;
              const now = Date.now();
              if (now - lastChunkTime > 50) {
                onProgress({
                  type: "status",
                  phase: "generating",
                  detail: "正在生成回复...",
                  progress: 80,
                  reply: content,
                });
                lastChunkTime = now;
              }
            }

            if (choice.delta.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const existing = toolCallsMap.get(tc.index);
                if (!existing) {
                  toolCallsMap.set(tc.index, {
                    id: tc.id || "",
                    name: tc.function?.name || "",
                    arguments: tc.function?.arguments || "",
                  });
                } else {
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.name = tc.function.name;
                  if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                }
              }
            }

            if (chunk.usage?.total_tokens) {
              totalTokens = chunk.usage.total_tokens;
            }
          } catch { /* ignore parse errors in individual chunks */ }
        }
      }
    } catch (readErr) {
      console.warn(`[AgentModelExecutor] Stream read error for ${provider.name}:`, readErr);
    }

    const obs = this.registry?.resolveService<any>("observability");
    if (obs) {
      const latency = Date.now() - startTime;
      try {
        obs.counterIncrement("evoclaw_llm_calls_total", [{ key: "provider", value: provider.provider || "unknown" }, { key: "model", value: provider.model || "unknown" }, { key: "status", value: "success" }], 1);
        obs.histogramObserve("evoclaw_llm_latency_ms", latency, [{ key: "provider", value: provider.provider || "unknown" }, { key: "model", value: provider.model || "unknown" }, { key: "status", value: "success" }]);
      } catch { /* observability is best-effort */ }
    }

    // 记录成功统计
    this.recordProviderSuccess(provider.id);

    const toolCalls = toolCallsMap.size > 0
      ? Array.from(toolCallsMap.entries()).map(([, tc]) => ({
          id: tc.id || `tc_${Date.now()}`,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }))
      : undefined;

    return {
      message: {
        role: "assistant",
        content: content || null,
        tool_calls: toolCalls,
      },
      tokensUsed: totalTokens || Math.ceil(content.length / 4),
    };
  }

  private async generateChatResponse(
    message: string,
    msg: string,
    installedSkills: unknown[],
    skillManager: { searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>; listSkills(): unknown[]; executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown>; } | undefined,
    pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>
  ): Promise<string> {
    const skillsList = installedSkills.length > 0
      ? (installedSkills as Array<{ name: string; description: string }>)
          .map((s) => `  - ${s.name}: ${s.description || "无描述"}`)
          .join("\n")
      : "";

    const lines: string[] = [];
    const addLine = (text: string) => {
      if (text.trim()) lines.push(text);
    };

    if (msg.includes("你好") || msg === "hi" || msg === "hello" || msg === "hey") {
      addLine(`${this.persona.masterTerm}您好！我是 ${this.persona.name}，${this.persona.title} 🦞`);
      addLine(`请问有什么可以帮您的？`);
      if (skillsList) {
        addLine(`我已经安装了以下技能：`);
        addLine(skillsList);
      } else {
        addLine(`您可以先安装一些 Skill 来扩展我的能力。`);
      }
      addLine(`当前使用模型: ${this.config.model} (${this.config.provider})`);
    } else if (msg.includes("你能做什么") || msg.includes("能力") || msg.includes("功能") || msg.includes("what can you do")) {
      addLine(`我是 ${this.persona.name}，以下是当前能力：`);
      addLine(`🎯 **对话交互** — 自然语言理解和回复`);
      addLine(`🛠️ **技能执行** — 运行已安装的 Skill`);
      addLine(`📋 **任务编排** — 规划和执行复杂任务流程`);
      addLine(`🔍 **搜索技能** — 浏览本地和远程技能市场`);
      addLine(`📈 **自我进化** — 学习和优化执行策略`);
      addLine(`💬 **多通道** — 支持微信/钉钉/飞书等平台`);
      if (skillsList) {
        addLine(`**已安装技能 (${installedSkills.length} 个):**`);
        addLine(skillsList);
      }
      addLine(`当前配置: ${this.config.model}@${this.config.provider}`);
      addLine(`您可以通过 LLM 配置页面对接真实大模型 API 来获得更强的智能推理能力。`);
    } else if (msg.includes("天气") || msg.includes("weather")) {
      const weatherSkill = skillManager
        ? (installedSkills as Array<{ id: string; name: string }>).find((s) =>
            s.name.includes("weather"))
        : null;

      if (weatherSkill && skillManager) {
        addLine(`已匹配天气相关技能！正在使用 "${weatherSkill.name}" 为您处理...`);
        try {
          const result = await skillManager.executeSkill(weatherSkill.id, {
            prompt: message,
            query: message,
          });
          addLine(`执行结果: ${JSON.stringify(result, null, 2)}`);
        } catch {
          addLine(`技能执行遇到问题，请稍后重试。`);
        }
        return lines.join("\n");
      } else {
        addLine(`您提到了天气查询，但目前没有安装天气相关技能。`);
        addLine(`您可以通过以下方式安装技能：`);
        addLine(`1. 准备一个 .SKILL.md 文件`);
        addLine(`2. 使用 CLI: EvoClaw skills install <文件路径>`);
        addLine(`3. 或通过 API: POST /api/skills/install`);
      }
    } else if (msg.includes("网页") || msg.includes("html") || msg.includes("写一个") || msg.includes("代码") || msg.includes("编程") || msg.includes("创建") || msg.includes("文件") || msg.includes("文件夹") || msg.includes("生成")) {

      let hasDriveLetter = false;
      let driveRoot = "";
      const driveMatch = message.match(/([A-Za-z])\s*[盘:]/);
      if (driveMatch) {
        hasDriveLetter = true;
        driveRoot = `${driveMatch[1].toUpperCase()}:/`;
      }

      const basePath = process.cwd().replace(/\\/g, "/");
      const targetRoot = driveRoot || `${basePath}/`;

      let folderName = "newweb";
      const folderMatch = message.match(/(?:创建|新建|生成|建立|写|mkdir?\s+)\s*[一个]*\s*[名为]*\s*["'`]?(\w[\w-]*)["'`]?(?:\s*(?:文件夹|目录|网页|网站|directory|folder|网站|website|webpage))/i);
      if (folderMatch) {
        folderName = folderMatch[1];
      } else {
        const cnFolderMatch = message.match(/(\w[\w-]*)\s*(?:文件夹|目录)/);
        if (cnFolderMatch) {
          folderName = cnFolderMatch[1];
        }
      }

      if (hasDriveLetter) {
        addLine(`检测到您指定了 ${driveMatch![1].toUpperCase()} 盘，文件将创建在: \`${targetRoot}${folderName}/\``);
      }

      const toolsToTry: Array<{ name: string; args: Record<string, unknown> }> = [];
      const prefix = `${targetRoot}${folderName}`;

      if (msg.includes("文件夹") || msg.includes("directory") || msg.includes("mkdir")) {
        if (this.registeredTools.has("file_create")) {
          toolsToTry.push({
            name: "file_create",
            args: { path: `${prefix}/.gitkeep`, content: "" },
          });
        }
      }

      if (msg.includes("html") || msg.includes("网页")) {
        if (this.registeredTools.has("file_create")) {
          const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>我的网页</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <h1>欢迎来到我的网页</h1>
    <nav>
      <a href="#">首页</a>
      <a href="#">关于</a>
      <a href="#">联系</a>
    </nav>
  </header>
  <main>
    <section class="hero">
      <h2>Hello World!</h2>
      <p>这是一个由 EvoClaw 自动生成的网页。</p>
      <button id="greetBtn">点击问好</button>
      <p id="greeting"></p>
    </section>
  </main>
  <footer>
    <p>&copy; 2026 My Website. Powered by EvoClaw.</p>
  </footer>
  <script src="script.js"></script>
</body>
</html>`;
          toolsToTry.push({
            name: "file_create",
            args: { path: `${prefix}/index.html`, content: htmlContent },
          });
        }
      }

      if (msg.includes("css")) {
        if (this.registeredTools.has("file_create")) {
          const cssContent = `/* style.css */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  line-height: 1.6;
  color: #333;
  background: #f5f5f5;
}

header {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 1.5rem;
  text-align: center;
}

header h1 {
  margin-bottom: 1rem;
  font-size: 2rem;
}

nav {
  display: flex;
  justify-content: center;
  gap: 1.5rem;
}

nav a {
  color: rgba(255,255,255,0.85);
  text-decoration: none;
  font-weight: 500;
  transition: color 0.2s;
}

nav a:hover {
  color: white;
}

main {
  max-width: 800px;
  margin: 2rem auto;
  padding: 0 1rem;
}

.hero {
  background: white;
  border-radius: 12px;
  padding: 2rem;
  text-align: center;
  box-shadow: 0 2px 12px rgba(0,0,0,0.08);
}

.hero h2 {
  color: #667eea;
  margin-bottom: 1rem;
  font-size: 1.8rem;
}

.hero p {
  color: #666;
  margin-bottom: 1.5rem;
}

button {
  background: #667eea;
  color: white;
  border: none;
  padding: 0.75rem 2rem;
  border-radius: 6px;
  font-size: 1rem;
  cursor: pointer;
  transition: background 0.2s;
}

button:hover {
  background: #5a6fd6;
}

#greeting {
  margin-top: 1rem;
  font-size: 1.1rem;
  color: #764ba2;
  font-weight: 600;
}

footer {
  text-align: center;
  padding: 1.5rem;
  color: #999;
  font-size: 0.9rem;
}`;
          toolsToTry.push({
            name: "file_create",
            args: { path: `${prefix}/style.css`, content: cssContent },
          });
        }
      }

      if (msg.includes("js") || msg.includes("javascript")) {
        if (this.registeredTools.has("file_create")) {
          const jsContent = `// script.js
document.addEventListener('DOMContentLoaded', () => {
  const greetBtn = document.getElementById('greetBtn');
  const greeting = document.getElementById('greeting');

  const messages = [
    '你好！很高兴见到你！',
    '欢迎来到我的网页！',
    '祝你今天过得愉快！',
    'Hello from EvoClaw! 🦞',
    '今天也是个好日子！',
  ];

  greetBtn.addEventListener('click', () => {
    const randomMsg = messages[Math.floor(Math.random() * messages.length)];
    greeting.textContent = randomMsg;
    greeting.style.animation = 'none';
    greeting.offsetHeight;
    greeting.style.animation = 'fadeIn 0.5s ease';
  });
});

const style = document.createElement('style');
style.textContent = \`
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: translateY(0); }
  }
\`;
document.head.appendChild(style);
`;
          toolsToTry.push({
            name: "file_create",
            args: { path: `${prefix}/script.js`, content: jsContent },
          });
        }
      }

      if (toolsToTry.length > 0) {
        let allSuccess = true;
        const actualPaths: string[] = [];
        for (const tt of toolsToTry) {
          try {
            const entry = this.registeredTools.get(tt.name);
            if (entry) {
              const result = await entry.handler(tt.args);
              const resultObj = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : null;
              const isSuccess = resultObj && resultObj.success !== false;
              const icon = isSuccess ? "✅" : "❌";
              if (resultObj && resultObj.requiresPermission) {
                pendingPermissions.push({
                  id: (resultObj.requestId as string) || (resultObj.id as string) || "",
                  operation: (resultObj.operation as string) || tt.name,
                  description: (resultObj.description as string) || "需要权限确认",
                  target: (resultObj.target as string) || (tt.args.path as string) || tt.name,
                });
                addLine(`🔐 **权限请求**: ${resultObj.description || "此操作需要您的授权"}`);
                addLine(`   操作: \`${resultObj.operation || tt.name}\`, 目标: \`${resultObj.target || tt.args.path}\``);
                addLine(`   请在下方权限提示条中选择：本次授权 / 加入白名单 / 拒绝`);
              } else {
                const actualPath = (resultObj?.path as string) || (tt.args.path as string);
                if (isSuccess && actualPath) actualPaths.push(actualPath);
                addLine(`${icon} \`${tt.name}\` → \`${actualPath}\` ${isSuccess ? "执行成功" : "执行失败"}`);
                if (resultObj?.warning) {
                  addLine(`   ⚠ ${resultObj.warning}`);
                }
                if (resultObj?.error) {
                  addLine(`   ${resultObj.error}`);
                }
              }
              if (!isSuccess) allSuccess = false;
            }
          } catch (err) {
            allSuccess = false;
            addLine(`❌ \`${tt.name}\` 执行失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (allSuccess && toolsToTry.length > 1) {
          let hasAnyPermission = false;
          for (const tt of toolsToTry) {
            const pendingForThis = pendingPermissions.length > 0 && pendingPermissions.some((p) => p.target.includes(String(tt.args.path)));
            if (pendingForThis) { hasAnyPermission = true; break; }
          }
          if (hasAnyPermission) {
            addLine("以上操作需要您的授权才能执行。请在下方权限提示条中选择操作。");
          } else {
            addLine("所有操作已完成！");
            if (actualPaths.length > 0) {
              const actualDir = actualPaths[0].replace(/[\\/][^\\/]+$/, "");
              addLine(`文件位置: ${actualDir}/`);
              addLine(`在文件浏览器打开: ${actualDir}/`);
            }
          }
        } else if (!allSuccess) {
          if (pendingPermissions.length > 0) {
            addLine("以上操作需要您的授权才能执行。请在下方权限提示条中选择操作。");
          } else {
            addLine("部分操作未能完成，请检查上述错误信息。");
          }
        }
        return lines.join("\n");
      }

      addLine(`当前我处于**离线/规则模式**，正在使用 ${this.config.model} 模型。`);
      addLine(`要获得真正的代码生成能力，您需要：`);
      addLine(`1. 在 **LLM 配置页** 配置一个真实的 API（如 OpenAI/DeepSeek/Anthropic）`);
      addLine(`2. 填入有效的 API Key`);
      addLine(`3. 启用该提供商并保存`);
      addLine(`配置完成后，我就能通过 API 调用大模型来为您生成代码了！`);
      if (skillsList) {
        addLine(`已安装技能: ${installedSkills.length} 个`);
      }
    } else if (msg.includes("技能") || msg.includes("skill") || msg.includes("安装")) {
      addLine(`关于技能管理：`);
      if (skillsList) {
        addLine(`当前已安装 ${installedSkills.length} 个技能：`);
        addLine(skillsList);
      } else {
        addLine(`当前没有安装任何技能。`);
      }
      addLine(`技能安装方式：`);
      addLine(`- CLI: EvoClaw skills install <路径>`);
      addLine(`- API: POST /api/skills/install {"path":"..."}`);
      addLine(`- 技能市场: EvoClaw skills search <关键词>`);
    } else {
      const activeProviders = this.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);
      addLine(`${this.persona.masterTerm}，收到您的消息："${message}"`);
      
      // Proactive skill search for action-oriented tasks
      const isAction = this.hasActionIntent(message);
      if (isAction && this.registeredTools.has("skill_search")) {
        addLine(`🔍 检测到操作意图，正在搜索匹配的Skill...`);
        try {
          const searchTool = this.registeredTools.get("skill_search")!;
          const searchResult = await searchTool.handler({ task: message });
          const searchObj = typeof searchResult === "object" && searchResult !== null ? (searchResult as Record<string, unknown>) : null;
          if (searchObj?.found) {
            const skillName = String(searchObj.skillName || "");
            const skillPath = String(searchObj.skillPath || "");
            addLine(`✅ 找到匹配Skill: "${skillName}" (路径: ${skillPath})`);
            addLine(`📦 正在安装...`);
            
            if (this.registeredTools.has("skill_install")) {
              const installTool = this.registeredTools.get("skill_install")!;
              const installResult = await installTool.handler({ path: skillPath });
              const installObj = typeof installResult === "object" && installResult !== null ? (installResult as Record<string, unknown>) : null;
              if (installObj?.success) {
                addLine(`✅ Skill "${installObj.skillName || skillName}" 安装成功！`);
                addLine(`🔄 正在执行...`);
                // Try to execute via skillManager
                if (skillManager) {
                  try {
                    const execResult = await skillManager.executeSkill(String(installObj.skillName || skillName), { prompt: message, query: message });
                    addLine(`✅ Skill执行完成！`);
                    addLine(`结果: ${JSON.stringify(execResult, null, 2).slice(0, 3000)}`);
                    return lines.join("\n");
                  } catch (execErr) {
                    addLine(`⚠ Skill执行失败: ${execErr instanceof Error ? execErr.message : String(execErr)}`);
                  }
                }
              } else {
                addLine(`⚠ 安装失败: ${installObj?.error || "未知错误"}`);
              }
            }
          } else {
            addLine(`⚠ 未找到匹配的Skill。`);
            if (this.registeredTools.has("skill_create")) {
              addLine(`💡 您可以说"创建Skill"让我自动生成一个，或配置LLM API后重试。`);
            }
          }
        } catch (err) {
          addLine(`⚠ Skill搜索出错: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      
      if (activeProviders.length > 0) {
        const provNames = activeProviders.map((p) => `${p.name}(${p.model})`).join(", ");
        addLine(`⚠ ${this.persona.name} 的 LLM 调用暂时失败 (${provNames})，但我不会放弃！`);
        addLine(``);
        addLine(`🔄 正在尝试备用方案...`);
        
        // Report actual skill state
        if (skillsList) {
          addLine(`📦 已安装技能 (${installedSkills.length} 个): ${skillsList}`);
        } else {
          addLine(`📦 未检测到已安装技能。`);
        }
        
        // Try common tools
        const availableTools = Array.from(this.registeredTools.keys());
        if (availableTools.length > 0) {
          addLine(`🔧 可用工具 (${availableTools.length} 个): ${availableTools.slice(0, 8).join(", ")}${availableTools.length > 8 ? "..." : ""}`);
        }
        
        addLine(``);
        addLine(`💡 建议操作：`);
        addLine(`1. 检查 LLM API 配置是否正确（API Key、模型名、Base URL）`);
        addLine(`2. 安装专属 Skill 来处理此类任务`);
        addLine(`3. 重试：重新发送指令给我`);
        addLine(``);
        addLine(`请告诉我您想如何继续！`);
      } else {
        addLine(`${this.persona.name} 尚未配置 LLM 提供商。`);
        addLine(``);
        addLine(`要启用 AI 对话能力，请：`);
        addLine(`1. 在 LLM 配置页添加提供商（如 DeepSeek/OpenAI）`);
        addLine(`2. 填入 API Key 和 Base URL`);
        addLine(`3. 启用并保存`);
        if (skillsList) {
          addLine(`📦 已安装技能 (${installedSkills.length} 个): ${skillsList}`);
        }
      }
    }

    return lines.join("\n");
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
    const startTime = Date.now();
    const mergedConfig = { ...this.config, ...options?.modelOverride };

    try {
      const enabledTools = options?.tools
        ? options.tools
            .filter((name) => this.registeredTools.has(name))
            .map((name) => this.registeredTools.get(name)!)
        : [];

      const reasoning = this.generateReasoning(prompt, node, options?.context);
      const toolCalls: Array<{ name: string; result: unknown }> = [];

      let output: unknown = null;

      for (const tool of enabledTools) {
        try {
          const toolParams = this.extractToolParams(prompt, tool.definition);

          const toolResult = await tool.handler(toolParams);
          toolCalls.push({ name: tool.definition.name, result: toolResult });
          output = toolResult;
        } catch (err) {
          console.warn(
            `[AgentModelExecutor] Tool "${tool.definition.name}" failed:`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }

      if (toolCalls.length === 0 && enabledTools.length > 0) {
        const allErrors = enabledTools.map((t) => `"${t.definition.name}": execution failed`)
          .join("; ");
        const result: AgentExecutionResult = {
          success: false,
          output: null,
          reasoning,
          tokensUsed: this.estimateTokenCount(prompt + reasoning),
          duration: Date.now() - startTime,
          toolCalls: [],
          error: `All tools failed to execute — ${allErrors}. Please check tool configurations and retry.`,
        };
        return result;
      }

      if (output === null) {
        output = this.generateDefaultOutput(prompt, reasoning);
      }

      const duration = Date.now() - startTime;

      const result: AgentExecutionResult = {
        success: true,
        output,
        reasoning,
        tokensUsed: this.estimateTokenCount(prompt + reasoning),
        duration,
        toolCalls,
      };

      await this.eventBus?.publish(
        "agent.execution_complete",
        { nodeId: node.id, success: true, duration },
        "agent-model-executor"
      );

      return result;
    } catch (err) {
      const duration = Date.now() - startTime;

      const result: AgentExecutionResult = {
        success: false,
        output: null,
        reasoning: "",
        tokensUsed: 0,
        duration,
        toolCalls: [],
        error: err instanceof Error ? err.message : String(err),
      };

      await this.eventBus?.publish(
        "agent.execution_failed",
        { nodeId: node.id, error: result.error },
        "agent-model-executor"
      );

      return result;
    }
  }

  async executeSkillDirectly(
    skill: Skill,
    params: Record<string, unknown>
  ): Promise<AgentExecutionResult> {
    const startTime = Date.now();

    try {
      const sandbox = this.registry.resolveService<{
        execute: (skill: Skill, params: Record<string, unknown>) => Promise<SkillExecutionResult>;
      }>("skillSandbox");

      if (sandbox) {
        const result = await sandbox.execute(skill, params);

        return {
          success: result.success,
          output: result.output,
          reasoning: `Skill "${skill.name}" executed via sandbox`,
          tokensUsed: 0,
          duration: Date.now() - startTime,
          toolCalls: [{ name: skill.name, result: result.output }],
          error: result.errors?.[0],
        };
      }

      const skillManager = this.registry.resolveService<{
        executeSkill: (skillId: string, params: Record<string, unknown>) => Promise<SkillExecutionResult>;
      }>("skillManager");

      if (skillManager) {
        const result = await skillManager.executeSkill(skill.id, params);

        return {
          success: result.success,
          output: result.output,
          reasoning: `Skill "${skill.name}" executed via skillManager`,
          tokensUsed: 0,
          duration: Date.now() - startTime,
          toolCalls: [{ name: skill.name, result: result.output }],
          error: result.errors?.[0],
        };
      }

      return {
        success: false,
        output: null,
        reasoning: "",
        tokensUsed: 0,
        duration: Date.now() - startTime,
        toolCalls: [],
        error: "No skill executor available",
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        reasoning: "",
        tokensUsed: 0,
        duration: Date.now() - startTime,
        toolCalls: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private generateReasoning(
    prompt: string,
    node: DAGNode,
    context?: Record<string, unknown>
  ): string {
    const parts: string[] = [
      `Agent executing DAG node "${node.id}" (${node.action})`,
    ];

    if (context) {
      const contextKeys = Object.keys(context);
      if (contextKeys.length > 0) {
        parts.push(`Context: ${contextKeys.join(", ")}`);
      }
    }

    const keywords = this.extractKeywords(prompt);
    if (keywords.length > 0) {
      parts.push(`Detected keywords: ${keywords.join(", ")}`);
    }

    parts.push(`Model: ${this.config.model}`);
    parts.push(`Node timeout: ${node.timeout}ms`);

    return parts.join("\n");
  }

  private extractToolParams(
    prompt: string,
    definition: ToolDefinition
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {
      prompt,
      toolName: definition.name,
      timestamp: Date.now(),
    };

    for (const [key, paramDef] of Object.entries(definition.parameters)) {
      const paramInfo = paramDef as Record<string, unknown>;
      const type = paramInfo.type as string;

      if (type === "string") {
        const defaultValue = paramInfo.default as string | undefined;
        params[key] = defaultValue || "";
      } else if (type === "number") {
        params[key] = paramInfo.default as number || 0;
      } else if (type === "boolean") {
        params[key] = paramInfo.default || false;
      }
    }

    return params;
  }

  private generateDefaultOutput(
    prompt: string,
    reasoning: string
  ): unknown {
    return {
      prompt,
      reasoning,
      model: this.config.model,
      provider: this.config.provider,
      timestamp: new Date().toISOString(),
      actions: ["parse_input", "analyze_intent", "plan_execution"],
    };
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been",
      "in", "on", "at", "to", "for", "of", "with", "by", "from",
      "and", "or", "but", "not", "this", "that", "it", "if", "then",
      "the", "i", "you", "he", "she", "we", "they",
    ]);

    const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 2);

    const frequencies = new Map<string, number>();
    for (const word of words) {
      if (stopWords.has(word)) continue;
      frequencies.set(word, (frequencies.get(word) || 0) + 1);
    }

    return Array.from(frequencies.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }

  private estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}