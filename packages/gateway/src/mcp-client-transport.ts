/**
 * MCPClientTransport — 消费外部 MCP server 的客户端传输层。
 *
 * 基于 @modelcontextprotocol/sdk 的 Client + StdioClientTransport / SSEClientTransport /
 * StreamableHTTPClientTransport，启动并连接外部 MCP server 进程，通过标准 MCP 协议
 * 调用其全部工具。保留原版 server 的完整功能，不做任何功能裁剪。
 *
 * 支持三种传输方式：
 * - stdio: spawn 子进程（如 npx -y firecrawl-mcp），通过 stdin/stdout JSON-RPC 通信
 * - sse: 连接 HTTP SSE 端点
 * - streamable-http: 连接 Streamable HTTP 端点（MCP 协议默认 HTTP 传输）
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createSamplingHandler,
  type McpSamplingConfig,
  type SamplingLlm,
  type SamplingMetrics,
  type SamplingParamsLike,
} from "./mcp-sampling.js";

/** 外部 MCP server 配置（与 IDE 的 mcpServers 配置格式一致） */
export interface ExternalMCPServerConfig {
  /** 传输类型 */
  type: "stdio" | "sse" | "streamable-http";
  /** stdio 模式：要执行的命令（如 "npx"、"node"、"python"） */
  command?: string;
  /** stdio 模式：命令参数（如 ["-y", "firecrawl-mcp"]） */
  args?: string[];
  /** stdio 模式：环境变量（如 { FIRECRAWL_API_KEY: "fc-xxx" }） */
  env?: Record<string, string>;
  /** stdio 模式：工作目录 */
  cwd?: string;
  /** sse / streamable-http 模式：MCP server 的 URL */
  url?: string;
  /**
   * streamable-http 模式：自定义 HTTP 请求头（认证等）。
   * 对标 Hermes headers 配置，用于传递 API Key / Bearer token。
   */
  headers?: Record<string, string>;
  /** 是否启用（默认 true） */
  enabled?: boolean;
  /**
   * 工具级过滤（P1-4 MCP 指挥中心）：
   * - allowlist 模式：仅注册 tools 列表内的工具
   * - denylist 模式：排除 tools 列表内的工具
   * 不配置时默认放行全部工具（向后兼容）。
   */
  toolFilter?: { mode: "allowlist" | "denylist"; tools: string[] };
  /**
   * 按 agent 的细粒度工具范围（agentId → 该 agent 可见的工具 allow/deny）。
   * 与 toolFilter 取交集：最终注册集合 = toolFilter 过滤后 ∩ 各 perAgent 规则。
   * 用于多智能体场景下按 agent 裁剪外部工具集。
   */
  perAgent?: Record<string, { allow?: string[]; deny?: string[] }>;
  /**
   * OAuth（P5）：sse / streamable-http 连接前/401 时取 Bearer token。
   * stdio 不支持 OAuth（用 env 传 API Key）。默认关闭。
   */
  oauth?: {
    enabled: boolean;
    scopes?: string[];
    clientId?: string;
  };
  /**
   * Sampling（P6）：允许远端 server 请求本客户端调用 LLM。默认关闭。
   * 只有 `enabled === true` 时才声明 sampling 能力并注册 handler。
   */
  sampling?: McpSamplingConfig;
}

/**
 * OAuth token provider（由 McpOAuthManager 适配，P5）。
 * getToken 负责过期前刷新；refreshToken 用于收到 401 后强制刷新一次。
 */
export interface McpOAuthTokenProvider {
  getToken(): Promise<string | null>;
  refreshToken(): Promise<string | null>;
}

/** 与 SDK FetchLike 兼容（复用 SDK 导出的类型，避免依赖 DOM lib） */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type HeadersInitLike = ConstructorParameters<typeof Headers>[0];

/**
 * 构造 auth-aware fetch（P5）：
 * - 每个请求合并静态 headers + Bearer token（token 优先）；
 * - 收到 401 时强制刷新一次并重试（body 可重放的请求才重试）；
 * - 刷新失败返回原始 401 响应（fail-closed，不静默重试）。
 */
export function createMcpAuthFetch(
  provider: McpOAuthTokenProvider,
  staticHeaders?: Record<string, string>,
  baseFetch: FetchLike = fetch,
): FetchLike {
  const buildInit = async (init: RequestInit | undefined, token: string | null): Promise<RequestInit> => {
    const headers = new Headers(staticHeaders ?? {});
    if (init?.headers) {
      new Headers(init.headers as HeadersInitLike).forEach((value, key) => headers.set(key, value));
    }
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return { ...init, headers };
  };

  return async (input, init) => {
    const token = await provider.getToken().catch(() => null);
    const response = await baseFetch(input, await buildInit(init, token));
    if (response.status !== 401) return response;

    // 只能重放确定可重放 body 的请求；流式 body 重放会抛错并产生难懂的异常
    const body = init?.body;
    const replayable = body === undefined || body === null ||
      typeof body === "string" ||
      body instanceof Uint8Array ||
      body instanceof ArrayBuffer ||
      body instanceof URLSearchParams ||
      body instanceof Blob ||
      body instanceof FormData;
    if (!replayable) return response;

    const refreshed = await provider.refreshToken().catch(() => null);
    if (!refreshed) return response;

    // 丢弃 401 响应体，避免连接泄漏
    try { await response.body?.cancel(); } catch { /* ignore */ }
    return baseFetch(input, await buildInit(init, refreshed));
  };
}

/**
 * 校验 OAuth 配置形状（P5）。返回错误列表，空数组表示通过。
 * 不涉及网络，供 connectServer 在建立连接前 fail-fast。
 */
export function validateMcpOAuthConfig(config: ExternalMCPServerConfig): string[] {
  const oauth = config.oauth;
  if (!oauth) return [];
  const errors: string[] = [];
  if (typeof oauth.enabled !== "boolean") {
    errors.push("oauth.enabled must be a boolean");
  }
  if (oauth.enabled && config.type === "stdio") {
    errors.push("oauth is only supported for sse / streamable-http transports");
  }
  if (oauth.enabled && !config.url) {
    errors.push("oauth requires config.url");
  }
  if (oauth.enabled && config.url) {
    try {
      new URL(config.url);
    } catch {
      errors.push("oauth requires a valid absolute config.url");
    }
  }
  if (oauth.scopes !== undefined) {
    if (!Array.isArray(oauth.scopes) || oauth.scopes.some((s) => typeof s !== "string" || s.length === 0)) {
      errors.push("oauth.scopes must be an array of non-empty strings");
    }
  }
  if (oauth.clientId !== undefined && (typeof oauth.clientId !== "string" || oauth.clientId.length === 0)) {
    errors.push("oauth.clientId must be a non-empty string");
  }
  return errors;
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
  readonly type: "stdio" | "sse" | "streamable-http";

  private client: Client | null = null;
  private transport: Transport | null = null;
  private connected = false;
  private tools: DiscoveredTool[] = [];
  private readonly name: string;
  private readonly config: ExternalMCPServerConfig;
  /** OAuth token provider（P5；stdio / 未启用时为 undefined） */
  private readonly oauth: McpOAuthTokenProvider | undefined;
  /** Sampling setup（P6；未启用时为 undefined） */
  private readonly sampling: { config: McpSamplingConfig; llm: SamplingLlm } | undefined;
  private samplingHandler: ReturnType<typeof createSamplingHandler> | null = null;

  constructor(
    name: string,
    config: ExternalMCPServerConfig,
    oauth?: McpOAuthTokenProvider,
    sampling?: { config: McpSamplingConfig; llm: SamplingLlm },
  ) {
    this.name = name;
    this.config = config;
    this.type = config.type;
    this.oauth = oauth;
    this.sampling = sampling;
  }

  /** Sampling 指标（P6；未启用返回 null） */
  getSamplingMetrics(): SamplingMetrics | null {
    return this.samplingHandler?.getMetrics() ?? null;
  }

  /** 连接到外部 MCP server */
  async connect(): Promise<void> {
    if (this.connected) {
      throw new Error(`MCP server "${this.name}" is already connected`);
    }

    // OAuth（P5）：HTTP 传输把 auth-aware fetch 交给 SDK，连接与每次请求都会
    // 自动带 Bearer token，401 时刷新一次并重试。
    const authFetch = this.oauth
      ? createMcpAuthFetch(this.oauth, this.config.headers)
      : undefined;

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
      if (!this.config.url) {
        throw new Error(`sse MCP server "${this.name}" requires "url"`);
      }
      this.transport = new SSEClientTransport(new URL(this.config.url), {
        requestInit: { headers: this.config.headers ?? {} },
        ...(authFetch ? { fetch: authFetch } : {}),
      });
    } else if (this.config.type === "streamable-http") {
      if (!this.config.url) {
        throw new Error(`streamable-http MCP server "${this.name}" requires "url"`);
      }
      this.transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: {
          headers: this.config.headers ?? {},
        },
        ...(authFetch ? { fetch: authFetch } : {}),
      });
    } else {
      throw new Error(`Unknown MCP transport type: ${(this.config as { type: string }).type}`);
    }

    // P6：sampling 默认关闭；只有显式启用才声明能力并注册 handler。
    const samplingEnabled = this.sampling?.config.enabled === true;
    if (samplingEnabled) {
      this.samplingHandler = createSamplingHandler(this.name, this.sampling!.config, this.sampling!.llm);
    }
    const capabilities = samplingEnabled
      ? { sampling: this.sampling!.config.exposeClientTools ? { tools: {} } : {} }
      : {};

    // 创建 Client 并发起 initialize 握手
    this.client = new Client(
      { name: "evoclaw-mcp-client", version: "1.0.0" },
      { capabilities },
    );

    if (this.samplingHandler) {
      const handler = this.samplingHandler;
      this.client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
        const result = await handler.handler(request.params as unknown as SamplingParamsLike);
        return result as never;
      });
    }

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
