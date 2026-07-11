/**
 * AcpServer — Agent Client Protocol (ACP) 服务器。
 *
 * 基于 JSON-RPC 2.0 over stdio，面向 IDE 集成（VS Code / Zed / JetBrains）。
 * 借鉴 hermes-agent 的 acp_adapter，将 EvoClaw 能力暴露给编辑器：
 * - 会话管理（创建 / 列表 / 关闭）
 * - 消息发送（流式响应，通过 notification 推送增量）
 * - 工具活动通知（工具调用 / 结果实时推送）
 * - 文件 diff 推送
 * - 终端命令执行通知
 * - 取消操作
 *
 * 协议方法（均以 `acp.` 前缀）：
 * - acp.getCapabilities
 * - acp.createSession / acp.listSessions / acp.closeSession
 * - acp.sendMessage / acp.cancelMessage
 *
 * 通知（server → client）：
 * - acp.messageChunk / acp.toolActivity / acp.fileDiff / acp.terminalCommand
 */

import { EventEmitter } from "events";
import { randomUUID } from "crypto";

// ─── JSON-RPC 2.0 基础类型 ───────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ─── ACP 协议类型 ────────────────────────────────────────────────────────────

export interface AcpCapabilities {
  streaming: true;
  toolActivity: true;
  fileDiff: true;
  terminalCommands: true;
  cancellation: true;
}

export interface AcpSession {
  id: string;
  createdAt: string;
  status: "active" | "closed";
  metadata?: Record<string, string>;
}

export interface AcpMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  toolCalls?: Array<{ name: string; args: unknown; result: unknown }>;
}

export interface AcpNotification {
  method: string;
  params: unknown;
}

export interface ToolActivity {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  status: "started" | "completed" | "failed";
  error?: string;
  durationMs?: number;
}

export interface FileDiff {
  filePath: string;
  oldContent?: string;
  newContent?: string;
  diff: string;
  changeType: "create" | "modify" | "delete";
}

export interface TerminalCommand {
  command: string;
  cwd?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

// ─── JSON-RPC 错误码 ─────────────────────────────────────────────────────────

const RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** buffer 最大字节数（与 MCP 对齐，防止恶意客户端耗尽内存） */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB

/** 默认能力声明 */
const DEFAULT_CAPABILITIES: AcpCapabilities = {
  streaming: true,
  toolActivity: true,
  fileDiff: true,
  terminalCommands: true,
  cancellation: true,
};

/** 消息处理委托函数签名 —— 由 AcpAdapter 注入，桥接到 AgentModelExecutor */
export type SendMessageHandler = (
  sessionId: string,
  content: string,
  signal: AbortSignal
) => AsyncGenerator<AcpMessage>;

// ─── AcpServer ───────────────────────────────────────────────────────────────

/**
 * AcpServer — ACP 协议的 stdio 服务器实现。
 *
 * 生命周期：
 * 1. `start()` — 绑定 stdin data 监听，进入 JSON-RPC 循环
 * 2. 外部通过 `notifyToolActivity` / `notifyFileDiff` / `notifyTerminalCommand` 推送活动
 * 3. `stop()` — 解绑监听，清理未完成会话
 *
 * 消息处理委托：
 * - 默认实现为 echo（用于测试与独立运行）
 * - 通过 `setMessageHandler()` 注入真实实现（由 AcpAdapter 设置）
 */
export class AcpServer extends EventEmitter {
  private sessions = new Map<string, AcpSession>();
  private buffer = "";
  private running = false;
  private readHandler: ((chunk: Buffer | string) => void) | null = null;

  /** 每个会话的取消控制器 —— sessionId → AbortController */
  private abortControllers = new Map<string, AbortController>();

  /** 消息处理委托（默认 echo） */
  private messageHandler: SendMessageHandler | null = null;

  private readonly capabilities: AcpCapabilities;

  constructor(
    private readonly stdin: NodeJS.ReadableStream = process.stdin,
    private readonly stdout: NodeJS.WritableStream = process.stdout,
    capabilities?: Partial<AcpCapabilities>
  ) {
    super();
    // 能力声明是不可变结构；默认全开，允许调用方覆盖（但字段类型限定为 true）
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...capabilities } as AcpCapabilities;
    this.on("error", (err) => {
      process.stderr.write(
        `[AcpServer] error: ${err instanceof Error ? err.message : String(err)}\n`
      );
    });
  }

  // ─── 生命周期 ────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.setupStdinListener();
    this.emit("status", "connected");
  }

  stop(): void {
    this.running = false;

    if (this.readHandler) {
      this.stdin.removeListener("data", this.readHandler);
      this.readHandler = null;
    }

    // 取消所有进行中的消息
    for (const [, controller] of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();

    // 标记所有活跃会话为已关闭
    for (const session of this.sessions.values()) {
      if (session.status === "active") {
        session.status = "closed";
      }
    }

    this.emit("status", "disconnected");
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── 会话管理 ────────────────────────────────────────────────────────────

  async createSession(metadata?: Record<string, string>): Promise<AcpSession> {
    const id = randomUUID();
    const session: AcpSession = {
      id,
      createdAt: new Date().toISOString(),
      status: "active",
      ...(metadata ? { metadata } : {}),
    };
    this.sessions.set(id, session);
    return session;
  }

  async listSessions(): Promise<AcpSession[]> {
    return Array.from(this.sessions.values()).filter((s) => s.status === "active");
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    // 取消进行中的消息
    this.cancelMessage(sessionId);
    session.status = "closed";
  }

  // ─── 消息处理 ────────────────────────────────────────────────────────────

  /**
   * 发送用户消息，流式返回 Agent 响应。
   *
   * 默认实现为 echo（回显用户消息 + 一条 assistant 消息），便于测试。
   * 通过 `setMessageHandler()` 注入真实实现后，委托给 AgentModelExecutor。
   */
  async *sendMessage(
    sessionId: string,
    content: string
  ): AsyncGenerator<AcpMessage> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.status !== "active") {
      throw new Error(`Session is not active: ${sessionId}`);
    }

    // 在首次 yield 之前创建取消控制器，确保调用方可立即取消
    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);

    try {
      // 先 yield 用户消息（记录到历史）
      yield {
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      };

      if (this.messageHandler) {
        // 委托给注入的 handler（AcpAdapter 桥接到 AgentModelExecutor）
        yield* this.messageHandler(sessionId, content, controller.signal);
      } else {
        // 默认 echo 实现（测试 / 独立运行）
        yield {
          role: "assistant",
          content: `[echo] ${content}`,
          timestamp: new Date().toISOString(),
        };
      }
    } finally {
      this.abortControllers.delete(sessionId);
    }
  }

  cancelMessage(sessionId: string): void {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
    }
  }

  // ─── 活动通知（server → client 推送） ────────────────────────────────────

  notifyToolActivity(sessionId: string, activity: ToolActivity): void {
    this.sendNotification({
      method: "acp.toolActivity",
      params: { sessionId, activity },
    });
  }

  notifyFileDiff(sessionId: string, diff: FileDiff): void {
    this.sendNotification({
      method: "acp.fileDiff",
      params: { sessionId, diff },
    });
  }

  notifyTerminalCommand(sessionId: string, cmd: TerminalCommand): void {
    this.sendNotification({
      method: "acp.terminalCommand",
      params: { sessionId, command: cmd },
    });
  }

  // ─── 委托注入 ────────────────────────────────────────────────────────────

  /** 注入消息处理委托（由 AcpAdapter 调用，桥接到 AgentModelExecutor） */
  setMessageHandler(handler: SendMessageHandler): void {
    this.messageHandler = handler;
  }

  // ─── JSON-RPC 核心 ────────────────────────────────────────────────────────

  /** 推送通知（不期待响应） */
  private sendNotification(notification: AcpNotification): void {
    if (!this.running) return;
    const message = {
      jsonrpc: "2.0" as const,
      method: notification.method,
      params: notification.params,
    };
    this.stdout.write(JSON.stringify(message) + "\n");
  }

  /** 发送响应 */
  private sendResponse(res: JsonRpcResponse): void {
    this.stdout.write(JSON.stringify(res) + "\n");
  }

  /** 处理 JSON-RPC 请求 */
  private async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    // 通知（无 id）—— 不需要响应
    if (req.id === undefined || req.id === null) {
      this.emit("notification", req.method, req.params);
      return null;
    }

    try {
      let result: unknown;

      switch (req.method) {
        case "acp.getCapabilities":
          result = await this.handleGetCapabilities();
          break;

        case "acp.createSession": {
          const params = req.params as { metadata?: Record<string, string> } | undefined;
          const session = await this.createSession(params?.metadata);
          result = session;
          break;
        }

        case "acp.listSessions":
          result = await this.listSessions();
          break;

        case "acp.closeSession": {
          const params = req.params as { sessionId?: string } | undefined;
          if (!params?.sessionId) {
            return this.errorResponse(req.id, RPC_ERROR.INVALID_PARAMS, "Missing sessionId");
          }
          await this.closeSession(params.sessionId);
          result = { sessionId: params.sessionId, status: "closed" };
          break;
        }

        case "acp.sendMessage": {
          const params = req.params as { sessionId?: string; content?: string } | undefined;
          if (!params?.sessionId) {
            return this.errorResponse(req.id, RPC_ERROR.INVALID_PARAMS, "Missing sessionId");
          }
          if (params.content === undefined || params.content === null) {
            return this.errorResponse(req.id, RPC_ERROR.INVALID_PARAMS, "Missing content");
          }
          // 流式推送：逐条 message 通过 notification 推送，最终汇总作为响应
          const messages: AcpMessage[] = [];
          try {
            for await (const msg of this.sendMessage(params.sessionId, params.content)) {
              messages.push(msg);
              this.sendNotification({
                method: "acp.messageChunk",
                params: { sessionId: params.sessionId, message: msg },
              });
            }
            result = { sessionId: params.sessionId, messages };
          } catch (err) {
            return this.errorResponse(
              req.id,
              RPC_ERROR.INTERNAL_ERROR,
              err instanceof Error ? err.message : String(err)
            );
          }
          break;
        }

        case "acp.cancelMessage": {
          const params = req.params as { sessionId?: string } | undefined;
          if (!params?.sessionId) {
            return this.errorResponse(req.id, RPC_ERROR.INVALID_PARAMS, "Missing sessionId");
          }
          this.cancelMessage(params.sessionId);
          result = { sessionId: params.sessionId, cancelled: true };
          break;
        }

        default:
          return this.errorResponse(
            req.id,
            RPC_ERROR.METHOD_NOT_FOUND,
            `Method not found: ${req.method}`
          );
      }

      return { jsonrpc: "2.0", id: req.id, result };
    } catch (err) {
      return this.errorResponse(
        req.id,
        RPC_ERROR.INTERNAL_ERROR,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private async handleGetCapabilities(): Promise<{ capabilities: AcpCapabilities }> {
    return { capabilities: this.capabilities };
  }

  private errorResponse(
    id: string | number,
    code: number,
    message: string
  ): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  // ─── stdio 读写 ──────────────────────────────────────────────────────────

  private setupStdinListener(): void {
    this.readHandler = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : chunk;
      this.buffer += data;

      // buffer 上限保护（与 MCP 对齐）
      if (this.buffer.length > MAX_BUFFER_SIZE) {
        const lastNewline = this.buffer.lastIndexOf("\n");
        if (lastNewline >= 0) {
          this.buffer = this.buffer.slice(lastNewline + 1);
        } else {
          this.buffer = "";
        }
      }

      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        this.processLine(line.trim()).catch((err) => {
          this.emit("error", err);
        });
      }
    };

    this.stdin.on("data", this.readHandler);
  }

  private async processLine(line: string): Promise<void> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      this.sendResponse({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: RPC_ERROR.PARSE_ERROR,
          message: "Parse error",
        },
      });
      return;
    }

    // 协议版本校验
    if (req.jsonrpc !== "2.0") {
      this.sendResponse({
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: {
          code: RPC_ERROR.INVALID_REQUEST,
          message: 'Invalid Request: jsonrpc must be "2.0"',
        },
      });
      return;
    }

    // 方法必须存在
    if (!req.method || typeof req.method !== "string") {
      this.sendResponse({
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: {
          code: RPC_ERROR.INVALID_REQUEST,
          message: "Invalid Request: method is required",
        },
      });
      return;
    }

    const response = await this.handleRequest(req);
    if (response) {
      this.sendResponse(response);
    }
  }

  // ─── 测试辅助 ────────────────────────────────────────────────────────────

  /** 同步喂入一行（测试用，不经过 stdin） */
  async processRequestLine(line: string): Promise<JsonRpcResponse | null> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_ERROR.PARSE_ERROR, message: "Parse error" },
      };
    }
    if (req.jsonrpc !== "2.0" || !req.method) {
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: RPC_ERROR.INVALID_REQUEST, message: "Invalid Request" },
      };
    }
    return this.handleRequest(req);
  }

  /** 获取会话（测试用） */
  getSession(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** 获取会话数（测试用） */
  get sessionCount(): number {
    return this.sessions.size;
  }
}
