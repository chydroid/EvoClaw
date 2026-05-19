import { ServiceRegistry, EventBus, type DAGNode, type Skill, type SkillExecutionResult, type PersonaConfig } from "@evoclaw/core";
import { buildAgentSystemPrompt, buildCompactSkillsPrompt, type SystemPromptParams, type PromptMode } from "./system-prompt";
import { classifyLLMError, estimateMessagesTokens, LLMErrorType, type ClassifiedError } from "./error-classifier";
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

export class AgentModelExecutor {
  private config: ModelConfig;
  private providers: ProviderConfig[] = [];
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
  private runIdCounter = 0;
  private workspacePath: string;
  private bootstrapFiles: Array<{ path: string; content: string }> = [];
  private _cachedSkillNames: Set<string> = new Set();
  
  private pendingOperations = new Map<string, { sessionId: string; message: string; requestId: string }>();
  private isProcessingQueue = false;

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

    const compactNotice: Array<{ role: string; content: string | null }> = [
      { role: "system", content: "[Previous conversation has been compacted. Key context is summarized above.]" },
    ];

    const recentEntries = history.slice(-keepRecentTurns * 2);
    const olderEntries = history.slice(0, -(keepRecentTurns * 2));

    const userMessages = olderEntries
      .filter((e) => e.role === "user" && e.content)
      .map((e) => e.content as string);

    const assistantMessages = olderEntries
      .filter((e) => e.role === "assistant" && e.content)
      .map((e) => e.content as string);

    let summary = "";
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

    const compacted: Array<{ role: string; content: string | null }> = [
      ...compactNotice,
      { role: "system", content: summary },
      ...recentEntries,
    ];

    this.conversationHistory.set(sessionId, compacted);
    console.log(`[AgentModelExecutor] Compacted session "${sessionId}": ${olderEntries.length} older turns summarized, ${recentEntries.length} recent turns kept.`);
  }

  private async onPermissionApproved(requestId: string): Promise<void> {
    const pending = this.pendingOperations.get(requestId);
    if (!pending) return;
    this.pendingOperations.delete(requestId);
    console.log(`[AgentModelExecutor] Permission approved for request "${requestId}". Frontend will auto-resume the task.`);
  }

  configure(config: Partial<ModelConfig>): void {
    this.config = { ...this.config, ...config };
  }

  configureProviders(providers: ProviderConfig[]): void {
    this.providers = providers
      .filter((p) => p.enabled)
      .sort((a, b) => a.order - b.order);
  }

  getProviders(): ProviderConfig[] {
    return [...this.providers];
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

  buildSystemPrompt(promptMode?: PromptMode, context?: { skillsPrompt?: string; workspacePath?: string; bootstrapFiles?: Array<{ path: string; content: string }> }): string {
    const toolNames = Array.from(this.registeredTools.keys());
    const mode = promptMode || "full";

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

    return buildAgentSystemPrompt({
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

  async chat(
    message: string,
    context?: Record<string, unknown>
  ): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }> }> {
    const startTime = Date.now();
    const sessionId = (context?.sessionId as string) || "default";
    const pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }> = [];

    const tasks = this.parseMultipleTasks(message);
    
    if (tasks.length > 1) {
      const multiResult = await this.handleMultipleTasks(tasks, sessionId, pendingPermissions, startTime);
      multiResult.reply = AgentModelExecutor.collapseNewlines(multiResult.reply);
      return multiResult;
    }

    const systemPrompt = this.buildSystemPrompt();
    const skillManager = this.registry?.resolveService<{
      searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>;
      listSkills(): unknown[];
      executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown>;
    }>("skillManager");

    const installedSkills = skillManager?.listSkills() || [];

    const enabledProviders = this.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);

    if (enabledProviders.length > 0) {
      const result = await this.tryCallLLM(message, systemPrompt, installedSkills, enabledProviders, startTime, sessionId, pendingPermissions);
      if (result) {
        if (result.toolsExecuted || !this.hasActionIntent(message)) {
          if (pendingPermissions.length > 0) {
            return { reply: AgentModelExecutor.collapseNewlines(result.reply), tokensUsed: result.tokensUsed, duration: result.duration, permissionRequests: [...pendingPermissions] };
          }
          return { reply: AgentModelExecutor.collapseNewlines(result.reply), tokensUsed: result.tokensUsed, duration: result.duration, permissionRequests: [] };
        }
        const msg = message.toLowerCase();
        const fallbackReply = await this.generateChatResponse(message, msg, installedSkills, skillManager, pendingPermissions);
        const combined = AgentModelExecutor.collapseNewlines(result.reply + "\n" + fallbackReply);
        return { reply: combined, tokensUsed: result.tokensUsed, duration: result.duration, permissionRequests: [...pendingPermissions] };
      }
    }

    const msg = message.toLowerCase();
    const reply = AgentModelExecutor.collapseNewlines(await this.generateChatResponse(message, msg, installedSkills, skillManager, pendingPermissions));
    const tokensUsed = this.estimateTokenCount(systemPrompt + message + reply);
    return { reply, tokensUsed, duration: Date.now() - startTime, permissionRequests: [...pendingPermissions] };
  }

  private parseMultipleTasks(message: string): string[] {
    const separators = [/[。！？]/g, /[.!?]/g];
    const tasks: string[] = [];
    
    let remaining = message.trim();
    
    for (const sep of separators) {
      const parts = remaining.split(sep);
      if (parts.length > 1) {
        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed && trimmed.length > 2) {
            tasks.push(trimmed);
          }
        }
        return tasks;
      }
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
    startTime: number
  ): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests: Array<{ id: string; operation: string; description: string; target: string }> }> {
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
      const installedSkills = skillManager?.listSkills() || [];
      const enabledProviders = this.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);

      let taskResult: string = "";
      let tokensUsed = 0;

      if (enabledProviders.length > 0) {
        const result = await this.tryCallLLM(task, systemPrompt, installedSkills, enabledProviders, startTime, sessionId, pendingPermissions);
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
      permissionRequests: [...pendingPermissions]
    };
  }

  private hasActionIntent(message: string): boolean {
    const lower = message.toLowerCase();
    const actionKeywords = [
      "创建", "生成", "删除", "修改", "写入", "读取", "列出", "查询",
      "create", "generate", "delete", "modify", "write", "read", "list",
      "文件夹", "文件", "html", "css", "js", "网页", "代码",
      "folder", "file", "directory", "mkdir", "touch",
      "安装", "卸载", "install", "uninstall", "搜索", "search",
      "在", "到", "放进", "保存", "save",
      "搜", "查", "找", "获取", "总结", "分析", "整理",
      "新闻", "热搜", "天气", "邮件",
    ];
    return actionKeywords.some((kw) => lower.includes(kw));
  }

  private async tryCallLLM(
    message: string,
    systemPrompt: string,
    installedSkills: unknown[],
    providers: ProviderConfig[],
    startTime: number,
    sessionId: string,
    pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>
  ): Promise<{ reply: string; tokensUsed: number; duration: number; toolsExecuted: boolean } | null> {
    const MAX_TOOL_ROUNDS = 10;
    const MAX_CONSECUTIVE_ERRORS = 3;
    let totalTokensUsed = 0;
    let anyToolExecuted = false;

    const skillsPrompt = await this.buildSkillsPromptForRun();

    for (const provider of providers) {
      let consecutiveErrors = 0;

      try {
        const history = this.conversationHistory.get(sessionId) || [];

        const fullSystemPrompt = skillsPrompt
          ? `${systemPrompt}\n\n## Skills\nScan <available_skills>. If one clearly applies, read its SKILL.md at the exact <location> with the read tool, then follow it.\nIf several apply, choose the most specific. If none clearly apply, read none.\nOne skill up front max. Never guess or fabricate skill paths.\nExternal API writes: batch when safe, respect 429/Retry-After.\n${skillsPrompt}`
          : systemPrompt;

        if (this.needsCompaction(sessionId, fullSystemPrompt, this.config.maxTokens)) {
          console.log(`[AgentModelExecutor] Auto-compaction triggered for session "${sessionId}"`);
          this.compactConversationHistory(sessionId);
        }

        const messages: Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }> = [
          { role: "system", content: fullSystemPrompt },
        ];

        messages.push(...history);
        messages.push({ role: "user", content: message });

        const tools = this.buildOpenAITools();
        const isAction = this.hasActionIntent(message);

        let conversationMessages = [...messages];
        let finalReply = "";

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const tc: "auto" | "required" = (round === 0 && isAction) ? "required" : "auto";
          const result = await this.callLLMOnce(provider, conversationMessages, tools, tc);

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
                { role: "user", content: message },
              ];
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
            const toolName = tc.function.name;
            const toolEntry = this.registeredTools.get(toolName);

            let toolResult: string;
            if (toolEntry) {
              try {
                const args = JSON.parse(tc.function.arguments || "{}");
                const result = await toolEntry.handler(args);
                toolResult = JSON.stringify(result);
                anyToolExecuted = true;

                // Truncate huge tool results to prevent context overflow
                const isBrowser = toolName.startsWith("browser_");
                const MAX_RESULT_LEN = isBrowser ? 8000 : 16000;
                if (toolResult.length > MAX_RESULT_LEN) {
                  const truncated = JSON.stringify({ truncated: true, originalLength: toolResult.length, preview: toolResult.slice(0, MAX_RESULT_LEN), hint: `结果已截断(原${toolResult.length}字符)，请使用 browser_get_text 获取特定内容` });
                  toolResult = truncated;
                }
                if (result && typeof result === "object" && (result as Record<string, unknown>).requiresPermission) {
                  const r = result as Record<string, unknown>;
                  const requestId = (r.requestId as string) || (r.id as string) || "";
                  pendingPermissions.push({
                    id: requestId,
                    operation: (r.operation as string) || toolName,
                    description: (r.description as string) || "需要权限确认",
                    target: (r.target as string) || tc.function.name,
                  });
                  
                  if (requestId) {
                    this.pendingOperations.set(requestId, { sessionId, message, requestId });
                  }
                }
                console.log(`[AgentModelExecutor] Tool "${toolName}" executed successfully`);
              } catch (err: unknown) {
                toolResult = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
                console.warn(`[AgentModelExecutor] Tool "${toolName}" failed:`, toolResult);
              }
            } else {
              toolResult = JSON.stringify({ error: `Tool "${toolName}" not found` });
            }

            conversationMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: toolName,
              content: toolResult,
            });
          }

          if (!finalReply && round === MAX_TOOL_ROUNDS - 1) {
            finalReply = "工具已执行完毕。";
          }
        }

        if (finalReply) {
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

          return {
            reply: finalReply,
            tokensUsed: totalTokensUsed,
            duration: Date.now() - startTime,
            toolsExecuted: anyToolExecuted,
          };
        }

        console.warn(`[AgentModelExecutor] LLM provider "${provider.name}" returned empty response`);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          console.warn(`[AgentModelExecutor] LLM provider "${provider.name}" timed out`);
        } else if (err instanceof Error) {
          console.warn(`[AgentModelExecutor] LLM provider "${provider.name}" error: ${err.message}`);
        }
      }
    }

    return null;
  }

  private buildOpenAITools(): Array<{ type: string; function: { name: string; description: string; parameters: { type: string; properties: Record<string, unknown>; required: string[] } } }> {
    return Array.from(this.registeredTools.values()).map((t) => {
      const props: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, paramDef] of Object.entries(t.definition.parameters)) {
        const p = paramDef as Record<string, unknown>;
        props[key] = {
          type: p.type || "string",
          description: p.description || key,
        };
        required.push(key);
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
    messages: Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
    tools: Array<{ type: string; function: Record<string, unknown> }>,
    toolChoice: "auto" | "required" = "auto"
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
        return {
          message: { role: "assistant", content: null },
          tokensUsed: 0,
          classifiedError: classified,
        };
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
      let classified: ClassifiedError | undefined;
      if (err instanceof DOMException && err.name === "AbortError") {
        const msg = `LLM provider "${provider.name}" timed out after ${timeout}ms`;
        console.warn(`[AgentModelExecutor] ${msg}`);
        classified = classifyLLMError(undefined, undefined, msg);
      } else if (err instanceof Error) {
        const msg = err.message;
        console.error(`[AgentModelExecutor] ❌ LLM fetch failed for "${provider.name}": ${msg}`);
        console.error(`  URL: ${apiURL}, Model: ${provider.model}, Timeout: ${timeout}ms`);
        classified = classifyLLMError(undefined, undefined, msg);
      }
      return {
        message: { role: "assistant", content: null },
        tokensUsed: 0,
        classifiedError: classified,
      };
    }
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
    } else if (msg.includes("新闻") || msg.includes("热搜") || msg.includes("新闻事件") || msg.includes("news") || msg.includes("hot") || (msg.includes("搜") && msg.includes("热"))) {
      addLine(`🔍 收到新闻搜索请求，我将全力为您搜集信息！`);
      addLine(``);
      
      // Step 1: Try web_search tool
      if (this.registeredTools.has("web_search")) {
        addLine(`📡 步骤1: 尝试使用 web_search 工具搜索新闻...`);
        try {
          const entry = this.registeredTools.get("web_search")!;
          const result = await entry.handler({ query: message, limit: 10 });
          const resultObj = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : null;
          if (resultObj && resultObj.success !== false) {
            addLine(`✅ web_search 成功！`);
            const results = resultObj.results || resultObj.data || resultObj;
            addLine(`搜索结果:\n${JSON.stringify(results, null, 2).slice(0, 3000)}`);
            return lines.join("\n");
          }
          addLine(`⚠ web_search 返回异常，尝试下一个方法...`);
        } catch (err) {
          addLine(`⚠ web_search 失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      
      // Step 2: Try news_search tool or search tool
      if (this.registeredTools.has("news_search")) {
        addLine(`📡 步骤2: 尝试使用 news_search 工具...`);
        try {
          const entry = this.registeredTools.get("news_search")!;
          const result = await entry.handler({ query: message, limit: 10 });
          const resultObj = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : null;
          if (resultObj && resultObj.success !== false) {
            addLine(`✅ news_search 成功！`);
            addLine(`搜索结果:\n${JSON.stringify(resultObj, null, 2).slice(0, 3000)}`);
            return lines.join("\n");
          }
          addLine(`⚠ news_search 返回异常`);
        } catch (err) {
          addLine(`⚠ news_search 失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      
      // Step 3: Try to find and execute a news-related skill
      if (skillManager) {
        const skills = installedSkills as Array<{ id: string; name: string; description?: string }>;
        const newsSkill = skills.find((s) => 
          s.name.toLowerCase().includes("news") || 
          s.name.includes("新闻") ||
          (s.description && (s.description.includes("新闻") || s.description.includes("news")))
        );
        if (newsSkill) {
          addLine(`📦 步骤3: 找到技能 "${newsSkill.name}"，正在执行...`);
          try {
            const result = await skillManager.executeSkill(newsSkill.id, { prompt: message, query: message });
            addLine(`✅ 技能执行完成！`);
            addLine(`结果: ${JSON.stringify(result, null, 2).slice(0, 3000)}`);
            return lines.join("\n");
          } catch (err) {
            addLine(`⚠ 技能执行失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          // Try ANY available skill that might help
          const allSkills = skills;
          addLine(`📦 步骤3: 搜索相关技能...`);
          if (allSkills.length > 0) {
            addLine(`当前已安装 ${allSkills.length} 个技能: ${allSkills.map(s => `"${s.name}"`).join(", ")}`);
            // Try the first available skill that looks useful
            for (const skill of allSkills) {
              addLine(`🔄 尝试执行 "${skill.name}"...`);
              try {
                const result = await skillManager.executeSkill(skill.id, { prompt: message, query: message });
                addLine(`✅ "${skill.name}" 执行完成！`);
                addLine(`结果: ${JSON.stringify(result, null, 2).slice(0, 3000)}`);
                return lines.join("\n");
              } catch {
                addLine(`⚠ "${skill.name}" 不适用于此任务，继续尝试...`);
              }
            }
            addLine(`⚠ 所有已安装技能均不适用于新闻搜索。`);
          } else {
            addLine(`⚠ 未安装任何技能。`);
          }
        }
      }
      
      // Step 4: As a last resort, provide guidance
      addLine(``);
      addLine(`---`);
      addLine(`🔄 所有自动化方法已尝试完毕。为了完成新闻搜索，建议：`);
      addLine(`1. 安装一个新闻搜索 Skill: \`EvoClaw skills install <skill-path>\``);
      addLine(`2. 或配置真实 LLM API（如 DeepSeek）来获得联网搜索能力`);
      addLine(`3. 或使用 CLI: \`EvoClaw web search "热搜新闻"\``);
      addLine(``);
      addLine(`我将继续等待您的指示，不会放弃这个任务！`);
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