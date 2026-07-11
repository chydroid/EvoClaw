/**
 * MCPClientManager — 管理外部 MCP server 的生命周期。
 *
 * 职责：
 * 1. 从配置文件加载外部 MCP server 声明
 * 2. 启动并连接每个 server
 * 3. 发现工具并注册到 MCPGateway + agentModelExecutor
 * 4. 提供 API 端点管理 server（list/add/remove/reconnect）
 * 5. 优雅关闭所有 server
 *
 * 配置文件位置：data/mcp-servers.json（运行时可修改）
 * 示例文件：config/mcp-servers.example.json
 *
 * 配置格式（与 IDE 的 mcpServers 格式一致）：
 * {
 *   "mcpServers": {
 *     "firecrawl": {
 *       "type": "stdio",
 *       "command": "npx",
 *       "args": ["-y", "firecrawl-mcp"],
 *       "env": { "FIRECRAWL_API_KEY": "fc-xxx" }
 *     }
 *   }
 * }
 */
import * as fs from "fs";
import * as path from "path";
import { MCPClientTransport, ExternalMCPServerConfig, DiscoveredTool } from "./mcp-client-transport.js";
import { MCPGateway } from "./mcp-gateway.js";
import { MCPTool } from "@evoclaw/core";
import { atomicWriteFileSync } from "./atomic-write";
import { validateMCPServerConfig } from "@evoclaw/security";

/** 单个 server 的运行时状态 */
interface ServerState {
  /** 配置名称 */
  name: string;
  /** 传输实例 */
  transport: MCPClientTransport;
  /** 是否已连接 */
  connected: boolean;
  /** 发现到的工具列表 */
  tools: DiscoveredTool[];
  /** 最后错误 */
  lastError?: string;
  /** 最后连接时间 */
  connectedAt?: number;
}

/** 配置文件结构 */
interface MCPServersConfig {
  mcpServers: Record<string, ExternalMCPServerConfig>;
}

export class MCPClientManager {
  private servers = new Map<string, ServerState>();
  /** per-name 的 in-flight 连接 Promise，序列化同名 server 的并发连接，避免 TOCTOU 竞态。 */
  private connectInflight = new Map<string, Promise<ServerState>>();
  private configPath: string;
  private mcpGateway: MCPGateway | null = null;
  private agentExecutor: {
    registerTool: (
      name: string,
      definition: { name: string; description: string; parameters: Record<string, unknown> },
      handler: (params: Record<string, unknown>) => Promise<unknown>,
      checkFn?: () => boolean,
    ) => void;
    unregisterTool: (name: string) => void;
    registeredTools: Map<string, unknown>;
  } | null = null;

  constructor(dataDir: string) {
    this.configPath = path.join(dataDir, "mcp-servers.json");
  }

  /** 设置依赖服务 */
  setDependencies(mcpGateway: MCPGateway, agentExecutor: unknown): void {
    this.mcpGateway = mcpGateway;
    this.agentExecutor = agentExecutor as MCPClientManager["agentExecutor"];
  }

  /** 加载配置文件（不存在则返回空配置） */
  loadConfig(): Record<string, ExternalMCPServerConfig> {
    try {
      if (!fs.existsSync(this.configPath)) {
        return {};
      }
      const raw = fs.readFileSync(this.configPath, "utf-8");
      const parsed = JSON.parse(raw) as MCPServersConfig;
      return parsed.mcpServers ?? {};
    } catch (err) {
      process.stderr.write(
        `[MCPClientManager] Failed to load config: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return {};
    }
  }

  /** 保存配置文件（原子写入：temp + fsync + rename，自动处理 EXDEV 跨设备回退） */
  saveConfig(servers: Record<string, ExternalMCPServerConfig>): void {
    const data = JSON.stringify({ mcpServers: servers }, null, 2);
    atomicWriteFileSync(this.configPath, data);
  }

  /** 启动并连接所有已配置的 server */
  async connectAll(): Promise<void> {
    if (!this.mcpGateway) {
      process.stderr.write("[MCPClientManager] MCPGateway not set, skipping\n");
      return;
    }

    const configs = this.loadConfig();
    let successCount = 0;
    let failCount = 0;

    for (const [name, config] of Object.entries(configs)) {
      if (config.enabled === false) {
        process.stdout.write(`[MCPClientManager] Skipping disabled server "${name}"\n`);
        continue;
      }
      try {
        await this.connectServer(name, config);
        successCount++;
      } catch (err) {
        failCount++;
        process.stderr.write(
          `[MCPClientManager] Failed to connect "${name}": ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    process.stdout.write(
      `[MCPClientManager] Connected ${successCount} MCP server(s)${failCount > 0 ? `, ${failCount} failed` : ""}\n`,
    );
  }

  /** 连接单个 server */
  async connectServer(name: string, config: ExternalMCPServerConfig): Promise<ServerState> {
    // 安全校验：检查命令注入风险
    if (config.type === "stdio" && config.command) {
      const validation = validateMCPServerConfig(config.command, config.args ?? []);
      if (!validation.safe) {
        const reasons = validation.threats.map((t) => t.description).join("; ");
        throw new Error(`MCP server "${name}" config validation failed: ${reasons}`);
      }
    }

    // per-name 互斥：同名 server 并发连接时，复用 in-flight 的连接结果，
    // 避免 disconnect 与 connect 交错导致状态不一致（TOCTOU 竞态）。
    const inflight = this.connectInflight.get(name);
    if (inflight) {
      return inflight;
    }
    const connectPromise = (async () => {
    // 如果已存在同名 server，先断开
    const existing = this.servers.get(name);
    if (existing) {
      await existing.transport.disconnect();
      this.unregisterServerTools(name);
      this.servers.delete(name);
    }

    // 创建并连接
    const transport = new MCPClientTransport(name, config);
    await transport.connect();

    // 发现工具
    const tools = await transport.listTools();

    // 注册到 MCPGateway
    const capsTools: Record<string, MCPTool> = {};
    for (const tool of tools) {
      capsTools[tool.name] = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as unknown as import("@evoclaw/core").MCPJsonSchema,
      };
    }
    this.mcpGateway?.registerTransport(name, transport);
    this.mcpGateway?.registerCapabilities(name, { tools: capsTools });

    // 注册到 agentModelExecutor（让 agent 能直接调用）
    this.registerServerTools(name, transport, tools);

    const state: ServerState = {
      name,
      transport,
      connected: true,
      tools,
      connectedAt: Date.now(),
    };
    this.servers.set(name, state);

    process.stdout.write(
      `[MCPClientManager] Server "${name}" connected with ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}\n`,
    );

    return state;
    })();

    this.connectInflight.set(name, connectPromise);
    connectPromise.finally(() => {
      this.connectInflight.delete(name);
    });
    return connectPromise;
  }

  /** 把外部工具注册到 agentModelExecutor */
  private registerServerTools(
    serverName: string,
    transport: MCPClientTransport,
    tools: DiscoveredTool[],
  ): void {
    if (!this.agentExecutor) return;

    for (const tool of tools) {
      // 工具名加前缀避免冲突：mcp__<server>__<tool>
      const registeredName = `mcp__${serverName}__${tool.name}`;
      this.agentExecutor.registerTool(
        registeredName,
        {
          name: registeredName,
          description: `[MCP:${serverName}] ${tool.description}`,
          parameters: tool.inputSchema,
        },
        async (params: Record<string, unknown>) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30_000);
          timeout.unref?.();
          try {
            const result = await transport.callTool({
              toolName: tool.name,
              args: params,
              signal: controller.signal,
            });
            // MCP 工具返回 { content: [{ type: "text", text: "..." }], isError?: boolean }
            const mcpResult = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
            if (mcpResult?.isError) {
              const errText = mcpResult.content?.map((c) => c.text ?? "").join("\n") ?? "MCP tool error";
              return JSON.stringify({ error: errText });
            }
            // 提取文本内容
            const textParts = mcpResult?.content
              ?.filter((c) => c.type === "text" && c.text)
              .map((c) => c.text!) ?? [];
            if (textParts.length > 0) {
              return textParts.join("\n");
            }
            // 非文本内容（image/resource）返回原始 JSON
            return JSON.stringify(result);
          } finally {
            clearTimeout(timeout);
          }
        },
      );
    }
  }

  /** 注销 server 的所有工具 */
  private unregisterServerTools(serverName: string): void {
    if (!this.agentExecutor) return;
    const state = this.servers.get(serverName);
    if (!state) return;
    for (const tool of state.tools) {
      const registeredName = `mcp__${serverName}__${tool.name}`;
      this.agentExecutor.unregisterTool(registeredName);
    }
  }

  /** 断开单个 server */
  async disconnectServer(name: string): Promise<boolean> {
    const state = this.servers.get(name);
    if (!state) return false;
    this.unregisterServerTools(name);
    this.mcpGateway?.unregisterTransport(name);
    await state.transport.disconnect();
    this.servers.delete(name);
    process.stdout.write(`[MCPClientManager] Server "${name}" disconnected\n`);
    return true;
  }

  /** 断开所有 server */
  async disconnectAll(): Promise<void> {
    const names = Array.from(this.servers.keys());
    for (const name of names) {
      try {
        await this.disconnectServer(name);
      } catch (err) {
        process.stderr.write(
          `[MCPClientManager] Error disconnecting "${name}": ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  /** 列出所有 server 状态 */
  listServers(): Array<{
    name: string;
    type: string;
    connected: boolean;
    toolCount: number;
    tools: string[];
    lastError?: string;
    connectedAt?: number;
  }> {
    return Array.from(this.servers.values()).map((s) => ({
      name: s.name,
      type: s.transport.type,
      connected: s.connected,
      toolCount: s.tools.length,
      tools: s.tools.map((t) => t.name),
      lastError: s.lastError,
      connectedAt: s.connectedAt,
    }));
  }

  /** 添加 server 配置并连接 */
  async addServer(name: string, config: ExternalMCPServerConfig): Promise<ServerState> {
    const configs = this.loadConfig();
    configs[name] = config;
    this.saveConfig(configs);
    return this.connectServer(name, config);
  }

  /** 移除 server（断开 + 删除配置） */
  async removeServer(name: string): Promise<boolean> {
    await this.disconnectServer(name);
    const configs = this.loadConfig();
    if (name in configs) {
      delete configs[name];
      this.saveConfig(configs);
      return true;
    }
    return false;
  }

  /** 重新连接 server */
  async reconnectServer(name: string): Promise<ServerState | null> {
    const configs = this.loadConfig();
    const config = configs[name];
    if (!config) return null;
    await this.disconnectServer(name);
    return this.connectServer(name, config);
  }

  /** 获取配置文件路径 */
  getConfigPath(): string {
    return this.configPath;
  }
}
