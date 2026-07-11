/**
 * Slash Command 注册中心
 *
 * 借鉴 hermes-agent 的 COMMAND_REGISTRY 设计：单一注册源，所有命令的元数据
 * （名称、描述、类别、别名、子命令）集中管理，避免散落在多个文件中。
 *
 * 提供派生查找表：
 * - COMMAND_LOOKUP: name + alias → CommandDef
 * - COMMANDS_BY_CATEGORY: category → CommandDef[]
 * - GATEWAY_KNOWN_COMMANDS: gateway 可识别的命令集合
 *
 * 辅助函数：
 * - resolveCommand(name): 通过 name 或 alias 查找命令
 * - isGatewayKnownCommand(name): 判断 gateway 是否识别该命令
 * - shouldBypassActiveSession(name): 判断命令是否应跳过会话排队
 */

/** 命令定义 */
export interface CommandDef {
  /** 命令名称 */
  name: string;
  /** 命令描述 */
  description: string;
  /** 命令类别（用于分组展示） */
  category?: string;
  /** 命令别名 */
  aliases?: string[];
  /** 子命令名称列表 */
  subcommands?: string[];
  /** 仅 CLI 可用（不需要 Gateway 服务器） */
  cliOnly?: boolean;
  /** 仅 Gateway 上下文可用 */
  gatewayOnly?: boolean;
  /** 需要启用的功能开关名称 */
  configGate?: string;
}

/**
 * 命令注册表 — 所有命令的元数据单一来源。
 *
 * 命令列表从 apps/cli/src/index.ts 的 commandModules 数组推导，
 * 描述和别名从各命令文件中提取。
 */
export const COMMAND_REGISTRY: CommandDef[] = [
  // ── Setup & Onboarding ──
  { name: "setup", description: "Create base configuration and workspace", category: "setup", cliOnly: true },
  { name: "onboard", description: "Run guided onboarding to get started", category: "setup", cliOnly: true },

  // ── Configuration ──
  {
    name: "config",
    description: "Read and write EvoClaw configuration",
    category: "config",
    subcommands: ["get", "set", "list", "validate", "fix", "path", "remove", "schema"],
  },
  { name: "models", description: "Manage LLM model configurations", category: "config" },
  {
    name: "configure",
    description: "Interactive configuration (OpenClaw compatible)",
    category: "config",
    subcommands: ["model", "channels", "keys", "gateway"],
    cliOnly: true,
  },

  // ── System & Diagnostics ──
  { name: "doctor", description: "Run system diagnostics and auto-repair", category: "system", cliOnly: true },
  { name: "dashboard", description: "Open the EvoClaw Web Dashboard", category: "system", cliOnly: true },
  { name: "health", description: "Quick health check of the Gateway service", category: "system" },
  { name: "status", description: "Service and system status", category: "system" },
  { name: "system", description: "System events, heartbeat, and presence", category: "system" },
  { name: "logs", description: "View Gateway logs", category: "system" },
  { name: "hooks", description: "Manage system event hooks", category: "system" },

  // ── Shell & UI ──
  {
    name: "completion",
    description: "Generate shell completion scripts",
    category: "shell",
    subcommands: ["bash", "zsh", "fish"],
    cliOnly: true,
  },
  { name: "tui", description: "Interactive terminal chat interface", category: "ui", aliases: ["terminal"], cliOnly: true },
  { name: "qr", description: "Generate QR code in terminal (OpenClaw compatible)", category: "ui", cliOnly: true },

  // ── Agent & Chat ──
  { name: "chat", description: "Interactive chat with the agent (REPL mode) or one-shot message", category: "agent" },
  { name: "agent", description: "Send a message to the Agent and get a response", category: "agent" },
  { name: "agents", description: "List and manage agents", category: "agent" },
  { name: "message", description: "Send messages through communication channels", category: "agent" },
  { name: "acp", description: "Agent Communication Protocol bridge for IDE integration", category: "agent" },
  {
    name: "commitments",
    description: "Manage commitments the agent has made to the user",
    category: "agent",
    subcommands: ["list", "dismiss", "show", "summary"],
  },

  // ── Session ──
  { name: "sessions", description: "Manage chat sessions", category: "session" },
  { name: "transcripts", description: "Manage session transcripts (OpenClaw compatible)", category: "session" },

  // ── Skills & Memory ──
  { name: "skills", description: "Manage skills via server API", category: "skills" },
  { name: "memory", description: "Manage vector memory and semantic search", category: "memory" },

  // ── Gateway ──
  {
    name: "gateway",
    description: "Manage the EvoClaw Gateway service",
    category: "gateway",
    subcommands: ["start", "stop", "restart", "run", "status", "health", "install", "uninstall", "call", "usage-cost", "stability", "diagnostics"],
  },

  // ── Channels ──
  {
    name: "channels",
    description: "Manage communication channels (WhatsApp, Telegram, etc.)",
    category: "channels",
    subcommands: ["list", "status", "logs", "add", "remove", "login", "logout", "capabilities", "resolve"],
  },

  // ── Security ──
  { name: "security", description: "Security audit and management", category: "security" },
  { name: "secrets", description: "Manage security secrets", category: "security" },
  {
    name: "approvals",
    description: "Manage execution approval policies",
    category: "security",
    subcommands: ["get", "approve", "deny", "allowlist", "policy"],
  },
  { name: "pairing", description: "Manage device and channel pairing", category: "security" },
  { name: "sandbox", description: "Manage sandbox environments", category: "security" },
  {
    name: "exec-policy",
    description: "Show or synchronize requested exec policy with host approvals",
    category: "security",
    subcommands: ["show", "preset", "set"],
  },
  {
    name: "devices",
    description: "Device pairing and auth tokens",
    category: "security",
    subcommands: ["list", "remove", "clear", "approve", "reject", "rotate", "revoke"],
  },

  // ── Tasks ──
  { name: "tasks", description: "View and manage tasks, agent executions, and evolution cycles", category: "tasks" },

  // ── Scheduler ──
  {
    name: "cron",
    description: "Manage scheduled cron tasks (requires running Gateway server)",
    category: "scheduler",
    subcommands: ["status", "list", "add", "edit", "remove", "enable", "disable", "trigger", "history", "get"],
  },
  { name: "webhooks", description: "Manage webhook integrations", category: "integrations" },

  // ── Plugins & MCP ──
  { name: "plugins", description: "Plugin management", category: "plugins" },
  { name: "mcp", description: "Manage MCP (Model Context Protocol) servers", category: "integrations" },

  // ── Contacts ──
  {
    name: "directory",
    description: "Manage contact directory",
    category: "contacts",
    subcommands: ["self", "peers", "groups"],
  },

  // ── LLM ──
  { name: "infer", description: "Send a prompt to LLM and display the response", category: "llm", aliases: ["capability"] },

  // ── Network ──
  { name: "dns", description: "DNS lookup tool (OpenClaw compatible)", category: "network", cliOnly: true },
  { name: "node", description: "Run and manage the headless node host service", category: "network" },
  { name: "nodes", description: "Manage gateway-owned nodes (pairing, status, invoke, and media)", category: "network" },
  { name: "proxy", description: "Run the EvoClaw debug proxy and inspect captured traffic", category: "network" },

  // ── Help & Info ──
  { name: "docs", description: "Search and display documentation", category: "help" },
  { name: "enhancements", description: "Show recent capability enhancements (v0.56/v0.57)", category: "help", cliOnly: true },

  // ── Maintenance ──
  { name: "update", description: "Check for and apply updates", category: "maintenance", cliOnly: true },
  { name: "backup", description: "Create and verify backups", category: "maintenance", cliOnly: true },
  { name: "uninstall", description: "Remove EvoClaw components", category: "maintenance", cliOnly: true },
  { name: "reset", description: "Reset all local data", category: "maintenance", cliOnly: true },
  { name: "migrate", description: "Import state from another agent system", category: "maintenance", cliOnly: true },
];

// ── 派生查找表 ──

/**
 * 命令查找表：name + alias → CommandDef。
 * 构建一次，O(1) 查找。
 */
export const COMMAND_LOOKUP: Map<string, CommandDef> = (() => {
  const map = new Map<string, CommandDef>();
  for (const cmd of COMMAND_REGISTRY) {
    map.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        map.set(alias, cmd);
      }
    }
  }
  return map;
})();

/**
 * 按类别分组的命令列表。
 */
export const COMMANDS_BY_CATEGORY: Map<string, CommandDef[]> = (() => {
  const map = new Map<string, CommandDef[]>();
  for (const cmd of COMMAND_REGISTRY) {
    if (!cmd.category) continue;
    const list = map.get(cmd.category);
    if (list) {
      list.push(cmd);
    } else {
      map.set(cmd.category, [cmd]);
    }
  }
  return map;
})();

/**
 * Gateway 可识别的命令集合。
 *
 * 包含所有非 cliOnly 的命令。cliOnly 命令仅在本地 CLI 运行，
 * 不需要 Gateway 服务器处理，因此不计入 Gateway 已知命令。
 */
export const GATEWAY_KNOWN_COMMANDS: Set<string> = (() => {
  const set = new Set<string>();
  for (const cmd of COMMAND_REGISTRY) {
    if (cmd.cliOnly) continue;
    set.add(cmd.name);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        set.add(alias);
      }
    }
  }
  return set;
})();

// ── 辅助函数 ──

/**
 * 通过 name 或 alias 查找命令定义。
 *
 * @param name 命令名称或别名
 * @returns 命令定义，未找到返回 null
 */
export function resolveCommand(name: string): CommandDef | null {
  return COMMAND_LOOKUP.get(name) ?? null;
}

/**
 * 判断 Gateway 是否识别该命令。
 *
 * @param name 命令名称或别名
 * @returns true 表示 Gateway 可识别
 */
export function isGatewayKnownCommand(name: string): boolean {
  return GATEWAY_KNOWN_COMMANDS.has(name);
}

/**
 * 不排队的命令集合。
 *
 * 借鉴 hermes-agent 的 should_bypass_active_session：某些命令
 * （config / models / help / status / clear / reset）应立即执行，
 * 不等待活跃会话完成。
 */
const BYPASS_SESSION_COMMANDS = new Set([
  "config",
  "models",
  "help",
  "status",
  "clear",
  "reset",
]);

/**
 * 判断命令是否应跳过会话排队，立即执行。
 *
 * @param name 命令名称
 * @returns true 表示该命令不排队，立即执行
 */
export function shouldBypassActiveSession(name: string): boolean {
  return BYPASS_SESSION_COMMANDS.has(name);
}
