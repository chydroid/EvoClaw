/**
 * Memory Provider 插件系统 — 借鉴 hermes-agent 的 MemoryProvider ABC 设计。
 *
 * 设计目标：为 EvoClaw 提供声明式记忆 provider 接口，允许外部插件接入
 * 自定义记忆后端（向量数据库、知识图谱、外部记忆服务等）。
 *
 * 核心约束：
 * - 单一外部 provider 限制：activeProvider 只能有一个，防止工具 schema 膨胀和冲突。
 * - 代理模式：MemoryProviderManager 的所有方法代理到 activeProvider，
 *   若 activeProvider 为 null 则返回空值/空数组。
 */

// ── 上下文与数据类型 ──────────────────────────────────────────────

/** Provider 初始化时传入的上下文。 */
export interface MemoryProviderContext {
  /** EvoClaw 数据根目录（等价 hermes-agent 的 HERMES_HOME）。 */
  hermesHome: string;
  sessionId: string;
  userId?: string;
}

/** 一轮对话的数据快照，供 syncTurn 持久化。 */
export interface TurnData {
  sessionId: string;
  userMessage: string;
  assistantMessage: string;
  toolCalls?: Array<{ name: string; args: unknown; result: unknown }>;
  timestamp: string;
}

/** Provider 暴露给 LLM 的工具 schema。 */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema 形式的参数定义。 */
  parameters: Record<string, unknown>;
}

// ── Provider 接口 ────────────────────────────────────────────────

/**
 * 记忆 Provider 抽象接口。
 *
 * 必需钩子由 MemoryProviderManager 强制代理；可选钩子若 provider 未实现，
 * Manager 使用默认空实现。
 */
export interface MemoryProvider {
  readonly name: string;

  // ── 必需钩子 ──
  initialize(ctx: MemoryProviderContext): Promise<void>;
  /** 返回注入到 system prompt 的记忆块（用 <memory> 等标签包裹）。 */
  systemPromptBlock(): string;
  /** 在查询前预取相关记忆（如 FTS5/向量检索）。 */
  prefetch(query: string): Promise<void>;
  /** 同步一轮对话到记忆后端。 */
  syncTurn(turnData: TurnData): Promise<void>;
  /** 暴露给 LLM 的工具 schema 列表。 */
  getToolSchemas(): ToolSchema[];
  /** 处理 LLM 发起的工具调用。 */
  handleToolCall(name: string, args: unknown): Promise<unknown>;
  /** 关闭 provider，释放资源。 */
  shutdown(): Promise<void>;

  // ── 可选钩子（默认空实现）──
  onTurnStart?(sessionId: string): Promise<void>;
  onSessionEnd?(sessionId: string): Promise<void>;
  /** 压缩前对消息列表做变换，默认返回原数组。 */
  onPreCompress?(messages: unknown[]): Promise<unknown[]>;
  onDelegation?(taskDescription: string): Promise<void>;
  /** 需要备份的文件路径列表，默认返回空数组。 */
  backupPaths?(): string[];
}

// ── Manager ──────────────────────────────────────────────────────

/**
 * Memory Provider 管理器。
 *
 * 强制单一外部 provider 限制：activeProvider 只能有一个。
 * 所有钩子代理到 activeProvider；若为 null 返回安全默认值。
 */
export class MemoryProviderManager {
  private providers = new Map<string, MemoryProvider>();
  private activeProvider: MemoryProvider | null = null;

  /** 注册 provider 到 providers Map。 */
  registerProvider(provider: MemoryProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * 注销 provider。若被注销的正是 activeProvider，则清空 activeProvider。
   */
  unregisterProvider(name: string): void {
    this.providers.delete(name);
    if (this.activeProvider?.name === name) {
      this.activeProvider = null;
    }
  }

  /**
   * 从已注册的 providers 中选择一个作为 activeProvider。
   * 若名称不存在则抛错。
   */
  setActiveProvider(name: string): void {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`MemoryProvider "${name}" is not registered`);
    }
    this.activeProvider = provider;
  }

  /** 获取当前活跃 provider（可能为 null）。 */
  getActiveProvider(): MemoryProvider | null {
    return this.activeProvider;
  }

  /** 获取所有已注册 provider 列表。 */
  getProviders(): MemoryProvider[] {
    return Array.from(this.providers.values());
  }

  // ── 钩子代理 ──

  async initialize(ctx: MemoryProviderContext): Promise<void> {
    if (this.activeProvider) {
      await this.activeProvider.initialize(ctx);
    }
  }

  systemPromptBlock(): string {
    return this.activeProvider?.systemPromptBlock() ?? "";
  }

  async prefetch(query: string): Promise<void> {
    if (this.activeProvider) {
      await this.activeProvider.prefetch(query);
    }
  }

  async syncTurn(turnData: TurnData): Promise<void> {
    if (this.activeProvider) {
      await this.activeProvider.syncTurn(turnData);
    }
  }

  getToolSchemas(): ToolSchema[] {
    return this.activeProvider?.getToolSchemas() ?? [];
  }

  async handleToolCall(name: string, args: unknown): Promise<unknown> {
    if (this.activeProvider) {
      return this.activeProvider.handleToolCall(name, args);
    }
    return null;
  }

  async shutdown(): Promise<void> {
    if (this.activeProvider) {
      await this.activeProvider.shutdown();
    }
  }

  // ── 可选钩子代理（带默认实现）──

  async onTurnStart(sessionId: string): Promise<void> {
    if (this.activeProvider?.onTurnStart) {
      await this.activeProvider.onTurnStart(sessionId);
    }
  }

  async onSessionEnd(sessionId: string): Promise<void> {
    if (this.activeProvider?.onSessionEnd) {
      await this.activeProvider.onSessionEnd(sessionId);
    }
  }

  /**
   * 压缩前钩子。默认返回原 messages（不做修改）。
   */
  async onPreCompress(messages: unknown[]): Promise<unknown[]> {
    if (this.activeProvider?.onPreCompress) {
      return this.activeProvider.onPreCompress(messages);
    }
    return messages;
  }

  async onDelegation(taskDescription: string): Promise<void> {
    if (this.activeProvider?.onDelegation) {
      await this.activeProvider.onDelegation(taskDescription);
    }
  }

  /**
   * 备份路径列表。默认返回空数组。
   */
  backupPaths(): string[] {
    return this.activeProvider?.backupPaths?.() ?? [];
  }
}
