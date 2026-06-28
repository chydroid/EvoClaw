import { ServiceRegistry, EventBus, MCPTransport, MCPCapabilities } from "@evoclaw/core";

/** 工具调用请求。 */
export interface MCPToolCallRequest {
  /** 传输名称（如 "stdio" / "http"） */
  transportName: string;
  /** 工具名 */
  toolName: string;
  /** 工具参数 */
  args: Record<string, unknown>;
  /** 调用方 ID（用于 cancel 路由） */
  callerId?: string;
  /** 超时毫秒（默认 30 秒） */
  timeoutMs?: number;
  /** 外部 AbortSignal（用于取消） */
  signal?: AbortSignal;
}

/** 工具调用结果。 */
export interface MCPToolCallResult {
  success: boolean;
  /** 工具输出 */
  output?: unknown;
  /** 错误信息 */
  error?: string;
  /** 是否被取消 */
  cancelled?: boolean;
  /** 耗时毫秒 */
  durationMs: number;
}

/** 进行中的工具调用条目（用于 cancel 路由）。 */
interface PendingCall {
  /** 调用 ID */
  callId: string;
  /** 调用方 ID */
  callerId: string;
  /** 关联的 AbortController */
  controller: AbortController;
  /** 开始时间 */
  startTimeMs: number;
  /** 超时计时器 */
  timeoutHandle?: ReturnType<typeof setTimeout>;
  /** 工具名（用于诊断） */
  toolName: string;
}

/**
 * MCP Gateway — 管理所有 MCP 传输与工具调用。
 *
 * 在原 MCPGateway 基础上扩展（对齐 openclaw-main 的 plugin-tools-handlers cancel 支持 + channel-bridge）：
 * - callTool：支持 AbortSignal + 超时 + cancel 路由
 * - cancelToolCall：按 callId 或 callerId 取消进行中的调用
 * - channel-bridge：将 MCP 工具调用桥接到渠道消息
 */
export class MCPGateway {
  private transports = new Map<string, MCPTransport>();
  private capabilities = new Map<string, MCPCapabilities>();
  /** 进行中的工具调用（callId → PendingCall） */
  private pendingCalls = new Map<string, PendingCall>();
  /** callerId → Set<callId>（用于按调用方批量取消） */
  private callerIndex = new Map<string, Set<string>>();
  /** callId 自增计数器 */
  private callIdCounter = 0;
  /** 默认超时（30 秒） */
  private static readonly DEFAULT_TIMEOUT_MS = 30_000;
  /** 最大并发调用数（防止资源耗尽） */
  private static readonly MAX_CONCURRENT_CALLS = 100;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  initialize(): void {
    process.stdout.write("[MCP Gateway] Initializing MCP protocol support");
    this.registry.registerService("mcpGateway", this);
  }

  registerTransport(name: string, transport: MCPTransport): void {
    this.transports.set(name, transport);
    process.stdout.write(`[MCP Gateway] Registered transport "${name}" (${transport.type})`);
  }

  unregisterTransport(name: string): void {
    this.transports.delete(name);
  }

  registerCapabilities(source: string, capabilities: MCPCapabilities): void {
    this.capabilities.set(source, capabilities);
  }

  getRegisteredTransports(): string[] {
    return Array.from(this.transports.keys());
  }

  async discoverTools(): Promise<Record<string, MCPCapabilities>> {
    return Object.fromEntries(this.capabilities);
  }

  /**
   * 调用 MCP 工具（支持 cancel + 超时）。
   *
   * 流程：
   * 1. 生成 callId 与 AbortController
   * 2. 注册到 pendingCalls（含超时计时器）
   * 3. 调用 transport.callTool
   * 4. 完成/取消/超时后从 pendingCalls 移除
   *
   * @returns 调用结果（含 success/output/error/cancelled/durationMs）
   */
  async callTool(request: MCPToolCallRequest): Promise<MCPToolCallResult> {
    const transport = this.transports.get(request.transportName);
    if (!transport) {
      return {
        success: false,
        error: `Transport "${request.transportName}" not registered`,
        durationMs: 0,
      };
    }

    // 并发上限检查
    if (this.pendingCalls.size >= MCPGateway.MAX_CONCURRENT_CALLS) {
      return {
        success: false,
        error: `Too many concurrent MCP calls (${this.pendingCalls.size} >= ${MCPGateway.MAX_CONCURRENT_CALLS})`,
        durationMs: 0,
      };
    }

    const callId = `mcp-call-${++this.callIdCounter}`;
    const callerId = request.callerId ?? "anonymous";
    const controller = new AbortController();
    const startTimeMs = Date.now();
    const timeoutMs = request.timeoutMs ?? MCPGateway.DEFAULT_TIMEOUT_MS;

    // 注册 pending
    const pending: PendingCall = {
      callId,
      callerId,
      controller,
      startTimeMs,
      toolName: request.toolName,
    };
    this.pendingCalls.set(callId, pending);
    // 更新 caller 索引
    if (!this.callerIndex.has(callerId)) {
      this.callerIndex.set(callerId, new Set());
    }
    this.callerIndex.get(callerId)!.add(callId);

    // 设置超时
    pending.timeoutHandle = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }, timeoutMs);
    pending.timeoutHandle.unref?.();

    // 外部信号联动
    if (request.signal) {
      if (request.signal.aborted) {
        controller.abort();
      } else {
        request.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }

    try {
      // 调用 transport.callTool（若 transport 不支持 callTool，发出错误）
      const callToolFn = (transport as unknown as {
        callTool?: (params: { toolName: string; args: Record<string, unknown>; signal: AbortSignal }) => Promise<unknown>;
      }).callTool;
      if (typeof callToolFn !== "function") {
        return {
          success: false,
          error: `Transport "${request.transportName}" does not support callTool`,
          durationMs: Date.now() - startTimeMs,
        };
      }

      const output = await callToolFn.call(transport, {
        toolName: request.toolName,
        args: request.args,
        signal: controller.signal,
      });

      const cancelled = controller.signal.aborted;
      return {
        success: !cancelled,
        output: cancelled ? undefined : output,
        cancelled,
        durationMs: Date.now() - startTimeMs,
      };
    } catch (err) {
      const cancelled = controller.signal.aborted;
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: cancelled ? `Call cancelled: ${errorMsg}` : errorMsg,
        cancelled,
        durationMs: Date.now() - startTimeMs,
      };
    } finally {
      // 清理 pending
      if (pending.timeoutHandle) {
        clearTimeout(pending.timeoutHandle);
      }
      this.pendingCalls.delete(callId);
      const callerSet = this.callerIndex.get(callerId);
      if (callerSet) {
        callerSet.delete(callId);
        if (callerSet.size === 0) {
          this.callerIndex.delete(callerId);
        }
      }
    }
  }

  /**
   * 按 callId 取消进行中的工具调用。
   * @returns 是否成功取消（调用存在且未完成）
   */
  cancelToolCall(callId: string): boolean {
    const pending = this.pendingCalls.get(callId);
    if (!pending) return false;
    if (pending.controller.signal.aborted) return false;
    pending.controller.abort();
    return true;
  }

  /**
   * 按 callerId 取消所有进行中的调用（用于渠道断连时批量取消）。
   * @returns 取消的调用数
   */
  cancelCallsByCaller(callerId: string): number {
    const callIds = this.callerIndex.get(callerId);
    if (!callIds || callIds.size === 0) return 0;
    let cancelled = 0;
    for (const callId of callIds) {
      const pending = this.pendingCalls.get(callId);
      if (pending && !pending.controller.signal.aborted) {
        pending.controller.abort();
        cancelled++;
      }
    }
    return cancelled;
  }

  /** 获取进行中的调用数（用于诊断）。 */
  getPendingCallCount(): number {
    return this.pendingCalls.size;
  }

  /** 列出所有进行中的调用（用于诊断 UI）。 */
  listPendingCalls(): Array<{ callId: string; callerId: string; toolName: string; elapsedMs: number }> {
    const now = Date.now();
    return Array.from(this.pendingCalls.values()).map((p) => ({
      callId: p.callId,
      callerId: p.callerId,
      toolName: p.toolName,
      elapsedMs: now - p.startTimeMs,
    }));
  }

  /**
   * Channel-bridge：将渠道消息桥接到 MCP 工具调用。
   * 当渠道收到特定指令时，转换为 MCP 工具调用并将结果回传给渠道。
   *
   * 用法：
   * ```ts
   * mcpGateway.bridgeChannelMessage({
   *   channelType: "feishu",
   *   sessionId: "session-1",
   *   text: "/mcp call weather city=Beijing",
   * });
   * ```
   */
  async bridgeChannelMessage(params: {
    channelType: string;
    sessionId: string;
    text: string;
    callerId?: string;
  }): Promise<{ handled: boolean; result?: MCPToolCallResult; reply?: string }> {
    // 解析指令：/mcp call <tool> [arg=value ...]
    const match = params.text.match(/^\/mcp\s+call\s+(\S+)\s*(.*)/);
    if (!match) {
      return { handled: false };
    }
    const [, toolName, argsStr] = match;
    if (!toolName) return { handled: false };

    // 解析参数：空格分隔的 key=value
    const args: Record<string, unknown> = {};
    if (argsStr) {
      const argPattern = /(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g;
      let m: RegExpExecArray | null;
      while ((m = argPattern.exec(argsStr)) !== null) {
        const key = m[1];
        const value = m[3] ?? m[4] ?? m[5];
        args[key] = value;
      }
    }

    // 查找支持该工具的传输
    let transportName: string | null = null;
    for (const [name, caps] of this.capabilities.entries()) {
      // caps.tools 是工具列表，查找匹配
      const tools = (caps as unknown as { tools?: Array<{ name: string }> }).tools;
      if (tools && tools.some((t) => t.name === toolName)) {
        transportName = name;
        break;
      }
    }
    if (!transportName) {
      return {
        handled: true,
        reply: `Tool "${toolName}" not found in any MCP transport`,
      };
    }

    const result = await this.callTool({
      transportName,
      toolName,
      args,
      callerId: params.callerId ?? `${params.channelType}:${params.sessionId}`,
    });

    return {
      handled: true,
      result,
      reply: result.success
        ? JSON.stringify(result.output, null, 2)
        : result.cancelled
          ? `Tool call cancelled: ${result.error ?? ""}`
          : `Tool call failed: ${result.error ?? "unknown error"}`,
    };
  }

  /** Release all registered transports and capabilities. */
  dispose(): void {
    // 取消所有进行中的调用
    for (const pending of this.pendingCalls.values()) {
      if (!pending.controller.signal.aborted) {
        pending.controller.abort();
      }
      if (pending.timeoutHandle) {
        clearTimeout(pending.timeoutHandle);
      }
    }
    this.pendingCalls.clear();
    this.callerIndex.clear();
    this.transports.clear();
    this.capabilities.clear();
    process.stdout.write("[MCP Gateway] Disposed");
  }
}
