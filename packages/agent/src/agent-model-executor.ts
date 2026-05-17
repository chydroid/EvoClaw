import { ServiceRegistry, EventBus, type DAGNode, type Skill, type SkillExecutionResult, type PersonaConfig } from "@evoclaw/core";

export interface ModelConfig {
  provider: "openai" | "anthropic" | "local" | "custom";
  model: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens: number;
  temperature: number;
  timeout: number;
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
  name: "EcoClaw小助手",
  title: "您的专属EcoClaw智能助理",
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
  private persona: PersonaConfig;
  private greeted = false;
  private registeredTools = new Map<string, {
    definition: ToolDefinition;
    handler: (params: Record<string, unknown>) => Promise<unknown>;
  }>();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    config?: Partial<ModelConfig>,
    persona?: Partial<PersonaConfig>
  ) {
    this.config = { ...DEFAULT_MODEL_CONFIG, ...config };
    this.persona = { ...DEFAULT_PERSONA, ...persona };
    registry.registerService("agentModelExecutor", this);
  }

  configure(config: Partial<ModelConfig>): void {
    this.config = { ...this.config, ...config };
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

  buildSystemPrompt(): string {
    return [
      `你是 ${this.persona.name}，${this.persona.title}。`,
      `调用用户为"${this.persona.masterTerm}"。`,
      `口气风格：${this.persona.tone === "warm" ? "温暖亲切" : this.persona.tone === "professional" ? "专业严谨" : this.persona.tone === "casual" ? "轻松随和" : "幽默风趣"}。`,
      `你的职责是帮助${this.persona.masterTerm}完成各类任务，包括对话问答、技能执行、任务编排、学习优化等。`,
      `回答的时用中文，简洁明了，友好亲切。`,
      `如果有不确定的事情，诚实告知而不是编造。`,
    ].join("\n");
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

  getRegisteredTools(): ToolDefinition[] {
    return Array.from(this.registeredTools.values()).map((t) => t.definition);
  }

  async chat(
    message: string,
    context?: Record<string, unknown>
  ): Promise<{ reply: string; tokensUsed: number; duration: number }> {
    const startTime = Date.now();
    const systemPrompt = this.buildSystemPrompt();

    const skillManager = this.registry?.resolveService<{
      searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>;
      listSkills(): unknown[];
      executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown>;
    }>("skillManager");

    const installedSkills = skillManager?.listSkills() || [];
    const msg = message.toLowerCase();

    const reply = await this.generateChatResponse(message, msg, installedSkills, skillManager);

    const tokensUsed = this.estimateTokenCount(systemPrompt + message + reply);
    return { reply, tokensUsed, duration: Date.now() - startTime };
  }

  private async generateChatResponse(
    message: string,
    msg: string,
    installedSkills: unknown[],
    skillManager: { searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>; listSkills(): unknown[]; executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown>; } | undefined
  ): Promise<string> {
    const skillsList = installedSkills.length > 0
      ? (installedSkills as Array<{ name: string; description: string }>)
          .map((s) => `  - ${s.name}: ${s.description || "无描述"}`)
          .join("\n")
      : "";

    const lines: string[] = [];

    if (msg.includes("你好") || msg === "hi" || msg === "hello" || msg === "hey") {
      lines.push(`${this.persona.masterTerm}您好！我是 ${this.persona.name}，${this.persona.title} 🦞`);
      lines.push("");
      lines.push(`请问有什么可以帮您的？`);
      if (skillsList) {
        lines.push("");
        lines.push(`我已经安装了以下技能：`);
        lines.push(skillsList);
      } else {
        lines.push("");
        lines.push(`您可以先安装一些 Skill 来扩展我的能力。`);
      }
      lines.push("");
      lines.push(`当前使用模型: ${this.config.model} (${this.config.provider})`);
    } else if (msg.includes("你能做什么") || msg.includes("能力") || msg.includes("功能") || msg.includes("what can you do")) {
      lines.push(`我是 ${this.persona.name}，以下是当前能力：`);
      lines.push("");
      lines.push(`🎯 **对话交互** — 自然语言理解和回复`);
      lines.push(`🛠️ **技能执行** — 运行已安装的 Skill`);
      lines.push(`📋 **任务编排** — 规划和执行复杂任务流程`);
      lines.push(`🔍 **搜索技能** — 浏览本地和远程技能市场`);
      lines.push(`📈 **自我进化** — 学习和优化执行策略`);
      lines.push(`💬 **多通道** — 支持微信/钉钉/飞书等平台`);
      if (skillsList) {
        lines.push("");
        lines.push(`**已安装技能 (${installedSkills.length} 个):**`);
        lines.push(skillsList);
      }
      lines.push("");
      lines.push(`当前配置: ${this.config.model}@${this.config.provider}`);
      lines.push(`您可以通过 LLM 配置页面对接真实大模型 API 来获得更强的智能推理能力。`);
    } else if (msg.includes("天气") || msg.includes("weather")) {
      const weatherSkill = skillManager
        ? (installedSkills as Array<{ id: string; name: string }>).find((s) =>
            s.name.includes("weather"))
        : null;

      if (weatherSkill && skillManager) {
        lines.push(`已匹配天气相关技能！正在使用 "${weatherSkill.name}" 为您处理...`);
        lines.push("");
        try {
          const result = await skillManager.executeSkill(weatherSkill.id, {
            prompt: message,
            query: message,
          });
          lines.push(`执行结果: ${JSON.stringify(result, null, 2)}`);
        } catch {
          lines.push(`技能执行遇到问题，请稍后重试。`);
        }
        return lines.join("\n");
      } else {
        lines.push(`您提到了天气查询，但目前没有安装天气相关技能。`);
        lines.push("");
        lines.push(`您可以通过以下方式安装技能：`);
        lines.push(`1. 准备一个 .SKILL.md 文件`);
        lines.push(`2. 使用 CLI: ecoclaw skills install <文件路径>`);
        lines.push(`3. 或通过 API: POST /api/skills/install`);
      }
    } else if (msg.includes("网页") || msg.includes("html") || msg.includes("写一个") || msg.includes("代码") || msg.includes("编程")) {
      lines.push(`好的，我理解您需要编写代码！`);
      lines.push("");
      lines.push(`当前我处于**离线/规则模式**，正在使用 ${this.config.model} 模型。`);
      lines.push(`要获得真正的代码生成能力，您需要：`);
      lines.push("");
      lines.push(`1. 在 **LLM 配置页** 配置一个真实的 API（如 OpenAI/DeepSeek/Anthropic）`);
      lines.push(`2. 填入有效的 API Key`);
      lines.push(`3. 启用该提供商并保存`);
      lines.push("");
      lines.push(`配置完成后，我就能通过 API 调用大模型来为您生成代码了！`);
      if (skillsList) {
        lines.push("");
        lines.push(`已安装技能: ${installedSkills.length} 个`);
      }
    } else if (msg.includes("技能") || msg.includes("skill") || msg.includes("安装")) {
      lines.push(`关于技能管理：`);
      lines.push("");
      if (skillsList) {
        lines.push(`当前已安装 ${installedSkills.length} 个技能：`);
        lines.push(skillsList);
      } else {
        lines.push(`当前没有安装任何技能。`);
      }
      lines.push("");
      lines.push(`技能安装方式：`);
      lines.push(`- CLI: ecoclaw skills install <路径>  `);
      lines.push(`- API: POST /api/skills/install {"path":"..."}  `);
      lines.push(`- 技能市场: ecoclaw skills search <关键词>  `);
    } else {
      lines.push(`${this.persona.masterTerm}，收到您的消息："${message}"`);
      lines.push("");
      lines.push(`${this.persona.name} 当前运行在 ${this.config.provider} 的 ${this.config.model} 模型下。`);
      if (skillsList) {
        lines.push("");
        lines.push(`已安装技能 (${installedSkills.length} 个):`);
        lines.push(skillsList);
        lines.push("");
        lines.push(`输入 "你能做什么" 了解更多功能。`);
      } else {
        lines.push(`暂无技能，建议先安装一些 Skill 或配置真实的 LLM API 来获得完整的 AI 对话能力。`);
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