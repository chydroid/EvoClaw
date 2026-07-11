/**
 * MCPClientTransport — 消费外部 MCP server 的客户端传输层。
 *
 * 基于 @modelcontextprotocol/sdk 的 Client + StdioClientTransport / SSEClientTransport，
 * 启动并连接外部 MCP server 进程，通过标准 MCP 协议调用其全部工具。
 * 保留原版 server 的完整功能，不做任何功能裁剪。
 *
 * 支持两种传输方式：
 * - stdio: spawn 子进程（如 npx -y firecrawl-mcp），通过 stdin/stdout JSON-RPC 通信
 * - sse: 连接 HTTP SSE 端点
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** 外部 MCP server 配置（与 IDE 的 mcpServers 配置格式一致） */
export interface ExternalMCPServerConfig {
  /** 传输类型 */
  type: "stdio" | "sse";
  /** stdio 模式：要执行的命令（如 "npx"、"node"、"python"） */
  command?: string;
  /** stdio 模式：命令参数（如 ["-y", "firecrawl-mcp"]） */
  args?: string[];
  /** stdio 模式：环境变量（如 { FIRECRAWL_API_KEY: "fc-xxx" }） */
  env?: Record<string, string>;
  /** stdio 模式：工作目录 */
  cwd?: string;
  /** sse 模式：MCP server 的 URL */
  url?: string;
  /** 是否启用（默认 true） */
  enabled?: boolean;
}

/** 发现到的工具信息 */
export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * MCPClientTransport — 连接单个外部 MCP server。
 *
 * 生命周期：
 * 1. connect() — 创建 SDK Client + Transport，发起 MCP initialize 握手
 * 2. listTools() — 调用 tools/list 发现可用工具
 * 3. callTool(name, args) — 调用 tools/call 执行工具
 * 4. disconnect() — 关闭连接，终止子进程
 */
export class MCPClientTransport {
  /** 传输类型（满足 MCPGateway 的鸭子类型检查） */
  readonly type: "stdio" | "sse";

  private client: Client | null = null;
  private transport: Transport | null = null;
  private connected = false;
  private tools: DiscoveredTool[] = [];
  private readonly name: string;
  private readonly config: ExternalMCPServerConfig;

  constructor(name: string, config: ExternalMCPServerConfig) {
    this.name = name;
    this.config = config;
    this.type = config.type;
  }

  /** 连接到外部 MCP server */
  async connect(): Promise<void> {
    if (this.connected) {
      throw new Error(`MCP server "${this.name}" is already connected`);
    }

    // 创建传输层
    if (this.config.type === "stdio") {
      if (!this.config.command) {
        throw new Error(`stdio MCP server "${this.name}" requires "command"`);
      }
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: { ...process.env, ...this.config.env } as Record<string, string>,
        cwd: this.config.cwd,
        stderr: "pipe",
      });
    } else if (this.config.type === "sse") {
      if (!this.config.url) {
        throw new Error(`sse MCP server "${this.name}" requires "url"`);
      }
      this.transport = new SSEClientTransport(new URL(this.config.url));
    } else {
      throw new Error(`Unknown MCP transport type: ${(this.config as { type: string }).type}`);
    }

    // 创建 Client 并发起 initialize 握手
    this.client = new Client(
      { name: "evoclaw-mcp-client", version: "1.0.0" },
      { capabilities: {} },
    );

    this.client.onerror = (err: Error) => {
      process.stderr.write(`[MCPClient:${this.name}] Error: ${err.message}\n`);
    };

    this.client.onclose = () => {
      this.connected = false;
      process.stdout.write(`[MCPClient:${this.name}] Connection closed\n`);
    };

    await this.client.connect(this.transport);
    this.connected = true;

    const serverInfo = this.client.getServerVersion?.();
    const serverCaps = this.client.getServerCapabilities?.();
    process.stdout.write(
      `[MCPClient:${this.name}] Connected to ${serverInfo?.name ?? "unknown"} v${serverInfo?.version ?? "?"}` +
      ` (tools: ${serverCaps?.tools ? "yes" : "no"}, resources: ${serverCaps?.resources ? "yes" : "no"}, prompts: ${serverCaps?.prompts ? "yes" : "no"})\n`,
    );
  }

  /** 发现可用工具 */
  async listTools(): Promise<DiscoveredTool[]> {
    if (!this.client || !this.connected) {
      throw new Error(`MCP server "${this.name}" is not connected`);
    }
    const result = await this.client.listTools();
    this.tools = (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));
    return this.tools;
  }

  /**
   * 调用工具（满足 MCPGateway.callTool 的鸭子类型检查）。
   * @returns 工具输出（MCP CallToolResult 格式）
   */
  async callTool(params: {
    toolName: string;
    args: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<unknown> {
    if (!this.client || !this.connected) {
      throw new Error(`MCP server "${this.name}" is not connected`);
    }
    const result = await this.client.callTool(
      { name: params.toolName, arguments: params.args },
      undefined,
      { signal: params.signal },
    );
    return result;
  }

  /** 是否已连接 */
  isConnected(): boolean {
    return this.connected;
  }

  /** 获取已发现的工具列表 */
  getDiscoveredTools(): DiscoveredTool[] {
    return this.tools;
  }

  /** 断开连接，终止子进程 */
  async disconnect(): Promise<void> {
    this.connected = false;
    this.tools = [];
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // best-effort
      }
      this.client = null;
    }
    // 显式关闭 transport，防止 client 为 null 时 transport 泄漏（子进程残留）
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // best-effort
      }
      this.transport = null;
    }
    process.stdout.write(`[MCPClient:${this.name}] Disconnected\n`);
  }

  /** 获取 server 名称 */
  getName(): string {
    return this.name;
  }
}
