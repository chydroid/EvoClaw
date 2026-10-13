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

/** 投毒扫描结果（MCPToolPoisoningScanner.scan 的返回契约，鸭子类型避免 gateway 直接依赖 security） */
interface ToolPoisoningResult {
  safe: boolean;
  riskScore: number;
  recommendation: "allow" | "warn" | "block";
  threats: Array<{ type: string; severity: string; description: string }>;
}

/** 投毒扫描器接口（与 MCPToolPoisoningScanner.scan 鸭子类型兼容，便于测试注入） */
export interface ToolPoisoningScanner {
  scan(tool: { name: string; description: string }): ToolPoisoningResult;
}

/** 投毒扫描结果（MCPToolPoisoningScanner.scan 的返回契约，鸭子类型避免 gateway 直接依赖 security） */
interface ToolPoisoningResult {
  safe: boolean;
  riskScore: number;
  recommendation: "allow" | "warn" | "block";
  threats: Array<{ type: string; severity: string; description: string }>;
}

/** 投毒扫描器接口（与 MCPToolPoisoningScanner.scan 鸭子类型兼容） */
export interface ToolPoisoningScanner {
  scan(tool: { name: string; description: string; inputSchema?: string }): ToolPoisoningResult;
}

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
    invalidateCheckFnCache?: () => void;
  } | null = null;
  /** 投毒扫描器（可选注入；未注入时注册门关闭投毒检查） */
  private poisoningScanner: ToolPoisoningScanner | null = null;
  /** 被投毒扫描拒绝的工具（serverName → toolName 列表），持久保留供仪表盘展示 */
  private poisonedTools = new Map<string, string[]>();
  /**
   * 工具动态挂载开关（P1-4 toggleTool）：registeredName → 显式启用状态。
   * 未设置（undefined）表示默认开启；显式 false 表示被 toggle 关闭。
   * 仅影响下一轮工具列表构建，不重注册，遵守"延迟失效"约定。
   */
  private toolToggleState = new Map<string, boolean>();

  /** 注入投毒扫描器（MCPToolPoisoningScanner 鸭子类型兼容） */
  setPoisoningScanner(scanner: ToolPoisoningScanner): void {
    this.poisoningScanner = scanner;
  }

  constructor(dataDir: string) {
    this.configPath = path.join(dataDir, "mcp-servers.json");
  }

  /** 设置依赖服务 */
  setDependencies(mcpGateway: MCPGateway, agentExecutor: unknown): void {
    this.mcpGateway = mcpGateway;
    this.agentExecutor = agentExecutor as MCPClientManager["agentExecutor"];
  }

  /**
   * 过滤出应注册到 agent executor 的工具列表。
   * 优先级：perAgent[agentId] > toolFilter > 全量。
   */
  filterToolsForAgent(
    tools: DiscoveredTool[],
    config: ExternalMCPServerConfig,
    agentId?: string,
  ): DiscoveredTool[] {
    let allowed: Set<string> | null = null;
    let denied: Set<string> = new Set();

    if (agentId && config.perAgent?.[agentId]) {
      const pa = config.perAgent[agentId];
      if (pa.allow && pa.allow.length > 0) {
        allowed = new Set(pa.allow);
      }
      if (pa.deny && pa.deny.length > 0) {
        denied = new Set(pa.deny);
      }
    } else {
      if (config.toolFilter) {
        if (config.toolFilter.mode === "allowlist" && config.toolFilter.tools.length > 0) {
          allowed = new Set(config.toolFilter.tools);
        } else if (config.toolFilter.mode === "denylist") {
          denied = new Set(config.toolFilter.tools);
        }
      }
    }

    return tools.filter((t) => {
      if (denied.has(t.name)) return false;
      if (allowed !== null && !allowed.has(t.name)) return false;
      return true;
    });
  }

  /** 投毒门：对单个工具执行扫描，返回是否应拒绝注册 */
  private shouldRejectByPoisoning(tool: DiscoveredTool, serverName: string): boolean {
    if (!this.poisoningScanner) return false;
    const result = this.poisoningScanner.scan({
      name: tool.name,
      description: tool.description,
    });
    if (result.recommendation === "block" || !result.safe) {
      const existing = this.poisonedTools.get(serverName) ?? [];
      if (!existing.includes(tool.name)) existing.push(tool.name);
      this.poisonedTools.set(serverName, existing);
      process.stderr.write(
        `[MCPClientManager] Tool "${tool.name}" from server "${serverName}" rejected by poisoning scan: ` +
        `riskScore=${result.riskScore}, threats=${result.threats.length}\n`,
      );
      return true;
    }
    return false;
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

    // 注册到 agentModelExecutor（让 agent 能直接调用，经 toolFilter 过滤）
    // 优先用本次连接传入的 config（reconnect/addServer 路径最准确），缺省回退到配置文件
    const effectiveConfig = config ?? this.loadConfig()[name];
    const filteredTools = effectiveConfig ? this.filterToolsForAgent(tools, effectiveConfig) : tools;
    this.registerServerTools(name, transport, filteredTools);

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

  /** 把外部工具注册到 agentModelExecutor（经 toolFilter + 投毒门过滤） */
  private registerServerTools(
    serverName: string,
    transport: MCPClientTransport,
    tools: DiscoveredTool[],
  ): void {
    if (!this.agentExecutor) return;

    for (const tool of tools) {
      // 工具名加前缀避免冲突：mcp__<server>__<tool>
      const registeredName = `mcp__${serverName}__${tool.name}`;

      // 投毒门：拒绝恶意描述的工具（不注册）
      if (this.shouldRejectByPoisoning(tool, serverName)) {
        continue;
      }

      // 注册 checkFn 实现动态挂载（toggleTool 通过修改 enabledTools 集合控制，避免重注册破坏 prompt-cache）
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
        // checkFn：动态挂载开关——toggleTool 关闭后，下一轮工具列表构建时本工具不再可见；
        // 未显式 toggle 过（undefined）默认开启。走"延迟失效"约定，不重注册。
        () => this.toolToggleState.get(registeredName) !== false,
      );
    }
  }

  /**
   * 动态挂载/卸载单个 MCP 工具（P1-4 指挥中心）。
   * 只切换工具在下一轮 prompt 构建时的可见性，不改注册集合，
   * 遵守 AGENTS.md 的"延迟失效"约定（当前会话已缓存的工具列表不受影响，下轮生效）。
   * @returns 是否成功切换（false 表示工具名不存在）
   */
  toggleTool(serverName: string, toolName: string, enabled: boolean): boolean {
    const registeredName = `mcp__${serverName}__${toolName}`;
    const state = this.servers.get(serverName);
    if (!state) return false;
    const exists = state.tools.some((t) => t.name === toolName);
    if (!exists) return false;
    this.toolToggleState.set(registeredName, enabled);
    this.agentExecutor?.invalidateCheckFnCache?.();
    process.stdout.write(
      `[MCPClientManager] Tool "${registeredName}" toggled ${enabled ? "ON" : "OFF"} (effective next tool-list build)\n`,
    );
    return true;
  }

  /** 查询指定工具当前 toggle 状态（未显式 toggle 过则返回 undefined=默认开启） */
  getToolToggle(serverName: string, toolName: string): boolean | undefined {
    return this.toolToggleState.get(`mcp__${serverName}__${toolName}`);
  }

  /** 仪表盘数据：server 状态 + 每个工具当前 toggle 态 + 被投毒门拒绝的列表 */
  getDashboard(): Array<{
    name: string;
    type: string;
    connected: boolean;
    toolCount: number;
    tools: Array<{ name: string; enabled: boolean; poisoned: boolean }>;
    lastError?: string;
    connectedAt?: number;
  }> {
    return Array.from(this.servers.values()).map((s) => {
      const poisoned = new Set(this.poisonedTools.get(s.name) ?? []);
      return {
        name: s.name,
        type: s.transport.type,
        connected: s.connected,
        toolCount: s.tools.length,
        tools: s.tools.map((t) => ({
          name: t.name,
          enabled: this.getToolToggle(s.name, t.name) ?? !poisoned.has(t.name),
          poisoned: poisoned.has(t.name),
        })),
        lastError: s.lastError,
        connectedAt: s.connectedAt,
      };
    });
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
