/**
 * AcpAdapter — 将 ACP 协议适配到 EvoClaw 内部子系统。
 *
 * 桥接关系：
 * - ACP 会话 ⇄ SessionManager（创建 / 关闭 EvoClaw session）
 * - ACP 消息 ⇄ AgentModelExecutor.chat()（流式推送 assistant 响应）
 * - EventBus 工具 / 文件 / 终端事件 → AcpServer.notifyXxx
 *
 * 使用最小接口（鸭子类型），避免跨包循环依赖：
 * - SessionManagerLike — 仅用 createSession / closeSession
 * - AgentExecutorLike — 仅用 chat 方法
 * - EventBusLike — 仅用 on / off
 */

import type {
  AcpMessage,
  AcpServer,
  FileDiff,
  TerminalCommand,
  ToolActivity,
} from "./acp-server.js";

// ─── 最小依赖接口（避免循环导入） ─────────────────────────────────────────────

export interface SessionManagerLike {
  createSession(
    agentId: string,
    options?: { sessionId?: string; predecessorSessionId?: string }
  ): { sessionId: string; agentId: string; status: string };
  archiveSession?(agentId: string, sessionId: string, reason: string): void;
}

export interface AgentExecutorLike {
  chat(
    message: string,
    context?: Record<string, unknown>,
    onProgress?: (event: unknown) => void
  ): Promise<{ reply: string; tokensUsed: number }>;
}

export interface EventBusLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  emit?(event: string, ...args: unknown[]): boolean;
}

// ─── 事件名常量 ───────────────────────────────────────────────────────────────

/** AgentModelExecutor / 工具执行器发出的事件名（与 packages/agent 对齐） */
const AGENT_EVENTS = {
  TOOL_START: "tool:execute:start",
  TOOL_COMPLETE: "tool:execute:complete",
  TOOL_FAILED: "tool:execute:failed",
  FILE_CHANGED: "file:changed",
  TERMINAL_COMMAND: "terminal:command",
} as const;

// ─── AcpAdapter ──────────────────────────────────────────────────────────────

/**
 * AcpAdapter — 桥接 AcpServer 与 EvoClaw 内部子系统。
 *
 * 装配流程：
 * 1. 构造时传入 AcpServer + 内部子系统（SessionManager / AgentExecutor / EventBus）
 * 2. `attach()` — 注册消息处理委托 + EventBus 监听器
 * 3. `detach()` — 解绑监听器（不关闭 AcpServer）
 *
 * 消息处理委托：
 * - 将 ACP sessionId 映射到 EvoClaw sessionId
 * - 调用 AgentModelExecutor.chat() 获取响应
 * - 将响应包装为 AcpMessage 并流式 yield
 * - 支持 AbortSignal 取消
 */
export class AcpAdapter {
  /** ACP sessionId → EvoClaw 内部 sessionId */
  private sessionMap = new Map<string, string>();

  /** ACP sessionId → agentId（默认 "acp-agent"） */
  private readonly agentId: string;

  /** EventBus 监听器引用（用于 detach） */
  private listeners: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

  private attached = false;

  constructor(
    private readonly server: AcpServer,
    private readonly sessionManager: SessionManagerLike | null,
    private readonly agentExecutor: AgentExecutorLike | null,
    private readonly eventBus: EventBusLike | null = null,
    options?: { agentId?: string }
  ) {
    this.agentId = options?.agentId ?? "acp-agent";
  }

  // ─── 装配 / 拆卸 ────────────────────────────────────────────────────────

  /** 装配：注册消息处理委托 + EventBus 监听器 */
  attach(): void {
    if (this.attached) return;
    this.attached = true;

    // 注册消息处理委托 —— 返回 handleMessage 生成的 AsyncGenerator
    this.server.setMessageHandler((sessionId, content, signal) =>
      this.handleMessage(sessionId, content, signal)
    );

    // 注册 EventBus 监听器（桥接工具 / 文件 / 终端事件）
    if (this.eventBus) {
      this.registerEventListeners(this.eventBus);
    }
  }

  /** 拆卸：解绑监听器（不关闭 AcpServer） */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;

    if (this.eventBus?.off) {
      for (const { event, handler } of this.listeners) {
        this.eventBus.off(event, handler);
      }
    }
    this.listeners = [];
  }

  // ─── 会话映射 ────────────────────────────────────────────────────────────

  /**
   * 将 ACP 会话创建桥接到 SessionManager。
   * 在 AcpServer.createSession 之后调用，建立映射。
   */
  linkSession(acpSessionId: string): string | null {
    if (!this.sessionManager) return null;

    // 幂等：已映射则直接返回
    const existing = this.sessionMap.get(acpSessionId);
    if (existing) return existing;

    const session = this.sessionManager.createSession(this.agentId, {
      sessionId: acpSessionId,
    });
    this.sessionMap.set(acpSessionId, session.sessionId);
    return session.sessionId;
  }

  /** 将 ACP 会话关闭桥接到 SessionManager */
  unlinkSession(acpSessionId: string): void {
    const internalId = this.sessionMap.get(acpSessionId);
    if (!internalId) return;
    if (this.sessionManager?.archiveSession) {
      this.sessionManager.archiveSession(this.agentId, internalId, "ACP session closed");
    }
    this.sessionMap.delete(acpSessionId);
  }

  /** 获取内部 sessionId（测试用） */
  getInternalSessionId(acpSessionId: string): string | undefined {
    return this.sessionMap.get(acpSessionId);
  }

  // ─── 消息处理（桥接到 AgentModelExecutor） ────────────────────────────────

  private async *handleMessage(
    acpSessionId: string,
    content: string,
    signal: AbortSignal
  ): AsyncGenerator<AcpMessage> {
    if (!this.agentExecutor) {
      yield {
        role: "assistant",
        content: "[AcpAdapter] No agent executor configured",
        timestamp: new Date().toISOString(),
      };
      return;
    }

    // 确保 EvoClaw 内部会话存在
    this.linkSession(acpSessionId);
    const internalSessionId = this.sessionMap.get(acpSessionId) ?? acpSessionId;

    try {
      const context: Record<string, unknown> = {
        sessionId: internalSessionId,
        channel: "acp",
      };

      const result = await this.agentExecutor.chat(content, context);

      // 检查取消
      if (signal.aborted) {
        return;
      }

      yield {
        role: "assistant",
        content: result.reply,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      // 检查取消 —— 取消导致的错误不报错
      if (signal.aborted) return;

      yield {
        role: "assistant",
        content: `[error] ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // ─── EventBus 监听器注册 ──────────────────────────────────────────────────

  private registerEventListeners(bus: EventBusLike): void {
    // 工具开始
    const onToolStart = (...args: unknown[]): void => {
      const { sessionId, toolName, args: toolArgs } = extractToolEvent(args);
      if (!sessionId) return;
      const acpSessionId = this.findAcpSessionByInternal(sessionId);
      if (!acpSessionId) return;

      const activity: ToolActivity = {
        toolName,
        args: toolArgs,
        status: "started",
      };
      this.server.notifyToolActivity(acpSessionId, activity);
    };

    // 工具完成
    const onToolComplete = (...args: unknown[]): void => {
      const { sessionId, toolName, args: toolArgs, result, durationMs } = extractToolEvent(args);
      if (!sessionId) return;
      const acpSessionId = this.findAcpSessionByInternal(sessionId);
      if (!acpSessionId) return;

      const activity: ToolActivity = {
        toolName,
        args: toolArgs,
        result,
        status: "completed",
        durationMs,
      };
      this.server.notifyToolActivity(acpSessionId, activity);
    };

    // 工具失败
    const onToolFailed = (...args: unknown[]): void => {
      const { sessionId, toolName, args: toolArgs, error } = extractToolEvent(args);
      if (!sessionId) return;
      const acpSessionId = this.findAcpSessionByInternal(sessionId);
      if (!acpSessionId) return;

      const activity: ToolActivity = {
        toolName,
        args: toolArgs,
        status: "failed",
        error,
      };
      this.server.notifyToolActivity(acpSessionId, activity);
    };

    // 文件变更
    const onFileChanged = (...args: unknown[]): void => {
      const { sessionId, filePath, diff, changeType, oldContent, newContent } =
        extractFileEvent(args);
      if (!sessionId) return;
      const acpSessionId = this.findAcpSessionByInternal(sessionId);
      if (!acpSessionId) return;

      const fileDiff: FileDiff = {
        filePath,
        diff,
        changeType: changeType ?? "modify",
        ...(oldContent !== undefined ? { oldContent } : {}),
        ...(newContent !== undefined ? { newContent } : {}),
      };
      this.server.notifyFileDiff(acpSessionId, fileDiff);
    };

    // 终端命令
    const onTerminalCommand = (...args: unknown[]): void => {
      const { sessionId, command, cwd, exitCode, stdout, stderr, durationMs } =
        extractTerminalEvent(args);
      if (!sessionId) return;
      const acpSessionId = this.findAcpSessionByInternal(sessionId);
      if (!acpSessionId) return;

      const cmd: TerminalCommand = {
        command,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(stdout !== undefined ? { stdout } : {}),
        ...(stderr !== undefined ? { stderr } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
      this.server.notifyTerminalCommand(acpSessionId, cmd);
    };

    bus.on(AGENT_EVENTS.TOOL_START, onToolStart);
    bus.on(AGENT_EVENTS.TOOL_COMPLETE, onToolComplete);
    bus.on(AGENT_EVENTS.TOOL_FAILED, onToolFailed);
    bus.on(AGENT_EVENTS.FILE_CHANGED, onFileChanged);
    bus.on(AGENT_EVENTS.TERMINAL_COMMAND, onTerminalCommand);

    this.listeners = [
      { event: AGENT_EVENTS.TOOL_START, handler: onToolStart },
      { event: AGENT_EVENTS.TOOL_COMPLETE, handler: onToolComplete },
      { event: AGENT_EVENTS.TOOL_FAILED, handler: onToolFailed },
      { event: AGENT_EVENTS.FILE_CHANGED, handler: onFileChanged },
      { event: AGENT_EVENTS.TERMINAL_COMMAND, handler: onTerminalCommand },
    ];
  }

  /** 通过内部 sessionId 反查 ACP sessionId */
  private findAcpSessionByInternal(internalSessionId: string): string | undefined {
    for (const [acpId, internalId] of this.sessionMap) {
      if (internalId === internalSessionId) return acpId;
    }
    return undefined;
  }
}

// ─── 事件参数提取工具函数 ─────────────────────────────────────────────────────

interface ExtractedToolEvent {
  sessionId: string | undefined;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

/** 从 EventBus 参数中提取工具事件字段（兼容多种事件 payload 结构） */
function extractToolEvent(args: unknown[]): ExtractedToolEvent {
  // 常见结构：{ sessionId, toolName, args, result?, error?, durationMs? }
  // 或：(sessionId, toolName, args, result?)
  if (args.length >= 1 && typeof args[0] === "object" && args[0] !== null) {
    const obj = args[0] as Record<string, unknown>;
    return {
      sessionId: typeof obj.sessionId === "string" ? obj.sessionId : undefined,
      toolName: typeof obj.toolName === "string" ? obj.toolName : "unknown",
      args: (obj.args as Record<string, unknown>) ?? {},
      result: obj.result,
      error: typeof obj.error === "string" ? obj.error : undefined,
      durationMs: typeof obj.durationMs === "number" ? obj.durationMs : undefined,
    };
  }
  // 位置参数模式
  const sessionId = typeof args[0] === "string" ? args[0] : undefined;
  const toolName = typeof args[1] === "string" ? args[1] : "unknown";
  const toolArgs =
    typeof args[2] === "object" && args[2] !== null
      ? (args[2] as Record<string, unknown>)
      : {};
  const result = args[3];
  return {
    sessionId,
    toolName,
    args: toolArgs,
    result,
  };
}

interface ExtractedFileEvent {
  sessionId: string | undefined;
  filePath: string;
  diff: string;
  changeType?: "create" | "modify" | "delete";
  oldContent?: string;
  newContent?: string;
}

/** 从 EventBus 参数中提取文件变更事件字段 */
function extractFileEvent(args: unknown[]): ExtractedFileEvent {
  if (args.length >= 1 && typeof args[0] === "object" && args[0] !== null) {
    const obj = args[0] as Record<string, unknown>;
    const changeType = obj.changeType as "create" | "modify" | "delete" | undefined;
    return {
      sessionId: typeof obj.sessionId === "string" ? obj.sessionId : undefined,
      filePath: typeof obj.filePath === "string" ? obj.filePath : "unknown",
      diff: typeof obj.diff === "string" ? obj.diff : "",
      changeType,
      oldContent: typeof obj.oldContent === "string" ? obj.oldContent : undefined,
      newContent: typeof obj.newContent === "string" ? obj.newContent : undefined,
    };
  }
  return { sessionId: undefined, filePath: "unknown", diff: "" };
}

interface ExtractedTerminalEvent {
  sessionId: string | undefined;
  command: string;
  cwd?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

/** 从 EventBus 参数中提取终端命令事件字段 */
function extractTerminalEvent(args: unknown[]): ExtractedTerminalEvent {
  if (args.length >= 1 && typeof args[0] === "object" && args[0] !== null) {
    const obj = args[0] as Record<string, unknown>;
    return {
      sessionId: typeof obj.sessionId === "string" ? obj.sessionId : undefined,
      command: typeof obj.command === "string" ? obj.command : "",
      cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
      exitCode: typeof obj.exitCode === "number" ? obj.exitCode : undefined,
      stdout: typeof obj.stdout === "string" ? obj.stdout : undefined,
      stderr: typeof obj.stderr === "string" ? obj.stderr : undefined,
      durationMs: typeof obj.durationMs === "number" ? obj.durationMs : undefined,
    };
  }
  return { sessionId: undefined, command: "" };
}

export type { AcpMessage };
