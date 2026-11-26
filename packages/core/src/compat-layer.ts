/**
 * Compatibility Layer — OpenClaw parity.
 *
 * Provides aliases and adapters for legacy API names to ease migration
 * and maintain backward compatibility. This is intentionally thin:
 * it maps old names to new equivalents so that existing code and
 * channel integrations don't break.
 *
 * OpenClaw uses this pattern for:
 *   - Legacy environment variable names
 *   - Deprecated config keys → new config keys
 *   - Old tool names → new tool names
 *   - Renamed API endpoints
 */

// ──────────────────────────────────────────────────────────────
// Env var aliases
// ──────────────────────────────────────────────────────────────

/**
 * Map of legacy env var names → current env var names.
 * When looking up a value, check both the current and legacy names.
 */
export const ENV_ALIASES: Record<string, string> = {
  // OpenAI legacy
  OPENAI_API_KEY: "OPENAI_API_KEY",
  OPENAI_ORG_ID: "OPENAI_ORG_ID",
  // Anthropic legacy  
  ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
  CLAUDE_API_KEY: "ANTHROPIC_API_KEY",
  // Google legacy
  GEMINI_API_KEY: "GOOGLE_API_KEY",
  GOOGLE_GEMINI_API_KEY: "GOOGLE_API_KEY",
  // DeepSeek legacy
  DEEPSEEK_API_KEY: "DEEPSEEK_API_KEY",
  // Web UI
  UI_TOKEN: "WEB_UI_TOKEN",
  WEBUI_TOKEN: "WEB_UI_TOKEN",
  WEB_TOKEN: "WEB_UI_TOKEN",
  // Log level
  LOGLEVEL: "LOG_LEVEL",
  DEBUG: "LOG_LEVEL",
  // Port
  PORT: "GATEWAY_PORT",
  HOST: "GATEWAY_HOST",
  // Data
  DATA_PATH: "EVOCLAW_DATA_DIR",
  WORKSPACE: "EVOCLAW_WORKSPACE",
  // DM policy
  DM_MODE: "DM_POLICY",
  DM_STRATEGY: "DM_POLICY",
};

/**
 * Look up an environment variable, trying the legacy name first,
 * then the current name.
 */
export function getEnvWithCompat(key: string): string | undefined {
  // Direct lookup first
  const direct = process.env[key];
  if (direct !== undefined) return direct;

  // Check if this key has an alias
  const currentName = ENV_ALIASES[key];
  if (currentName) {
    const aliased = process.env[currentName];
    if (aliased !== undefined) return aliased;
  }

  return undefined;
}

// ──────────────────────────────────────────────────────────────
// Config key aliases
// ──────────────────────────────────────────────────────────────

/**
 * Map of legacy config keys → current config keys.
 */
export const CONFIG_ALIASES: Record<string, string> = {
  llm: "providers",
  "llm.default": "providers.default",
  "llm.openai": "providers.openai",
  "llm.anthropic": "providers.anthropic",
  "llm.google": "providers.google",
  channels: "channels",
  "channels.telegram": "channels.telegram",
  "channels.discord": "channels.discord",
  "channels.whatsapp": "channels.whatsapp",
  "channels.slack": "channels.slack",
  "web_ui.enabled": "gateway.webUi",
  "web_ui.port": "gateway.port",
  system: "core",
  "system.name": "core.agentName",
  "system.language": "core.defaultLanguage",
  "system.timezone": "core.timezone",
  persona: "core.persona",
  "persona.name": "core.persona.name",
  "persona.description": "core.persona.description",
  security: "security",
  "security.dm_policy": "security.dmPolicy",
  "security.tool_policy": "security.toolPolicy",
};

/**
 * Translate a legacy config key to its current equivalent.
 */
export function translateLegacyKey(legacyKey: string): string {
  return CONFIG_ALIASES[legacyKey] || legacyKey;
}

// ──────────────────────────────────────────────────────────────
// Tool name aliases
// ──────────────────────────────────────────────────────────────

/**
 * Map of legacy tool names → current tool names.
 * Used when LLMs may request tools by old names.
 */
export const TOOL_ALIASES: Record<string, string> = {
  read_file: "file_read",
  write_file: "file_write",
  edit_file: "file_write",
  file_create: "file_write",
  file_modify: "file_write",
  file_edit: "file_write",
  delete_file: "file_delete",
  list_files: "file_list",
  run_shell: "shell_exec",
  execute_command: "shell_exec",
  fetch_url: "web_fetch",
  google_search: "web_search",
  search_web: "web_search",
  send_mail: "email",
  take_screenshot: "browser_screenshot",
  // memory 复合工具（原 memory_search / memory_stats / memory_get 已合并为
  // action 判别）。模型仍会按旧名调用——v25 会话实证 `memory_get` 直接
  // 「Tool not registered」，参数完全够用却整轮报废。
  memory_search: "memory",
  memory_stats: "memory",
  memory_get: "memory",
  memory_add: "memory",
};

/**
 * 旧工具名隐含的复合工具 action。
 *
 * file_write 合并了 file_create/file_modify/file_edit 后 action 必填；
 * 模型沿用旧名调用时通常不带 action（v26 T7 R5 实证：file_edit 直接
 * 「not registered」，write_file/edit_file 即使改名成功也会因缺 action 失败）。
 * memory 复合工具同理：旧名 memory_search / memory_stats 隐含对应 action。
 */
export const TOOL_ALIAS_IMPLIED_ACTION: Record<string, string> = {
  write_file: "create",
  edit_file: "edit",
  file_create: "create",
  file_modify: "modify",
  file_edit: "edit",
  memory_search: "search",
  memory_stats: "stats",
  memory_add: "add",
};

/**
 * 别名改名成功后补齐隐含 action。
 * 只对 file_write / memory 生效；模型显式给了 action 或参数里带
 * old_string/new_string（语义明确是定点编辑）时以其为准。
 */
export function applyImpliedToolAction(
  originalName: string,
  resolvedName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (resolvedName !== "file_write" && resolvedName !== "memory") return args;
  if (typeof args.action === "string" && args.action.trim() !== "") return args;
  if (resolvedName === "memory") {
    // memory 没有 old_string 语义歧义：只按旧名推断；推断不出就让 handler
    // 用它自己的默认 action=search。
    const inferredMemory = TOOL_ALIAS_IMPLIED_ACTION[originalName];
    return inferredMemory ? { ...args, action: inferredMemory } : args;
  }
  const inferred = typeof args.old_string === "string" || typeof args.new_string === "string"
    ? "edit"
    : TOOL_ALIAS_IMPLIED_ACTION[originalName];
  return inferred ? { ...args, action: inferred } : args;
}

/**
 * Resolve a tool name through aliases.
 */
export function resolveToolName(name: string): string {
  return TOOL_ALIASES[name] || name;
}

/**
 * 把模型给出的工具名解析为**已注册**工具名。
 *
 * 只在「原名未注册、别名目标已注册」时改写：原名本身可用时绝不覆盖
 * （避免把真实存在的同名工具错误指向别名目标）；两者都不可用时原样返回，
 * 由调用方走「未注册」错误路径。
 *
 * 对标 hermes agent/turn_tool_validation.py：模型偶尔用旧名/别名
 * （write_file、read_file、send_mail…）调用工具，一次靠谱的本地修复
 * 比让模型从「Tool not registered」里自行猜测便宜得多。
 */
export function resolveRegisteredToolName(
  name: string,
  isRegistered: (candidate: string) => boolean,
): string {
  if (isRegistered(name)) return name;
  const alias = TOOL_ALIASES[name];
  return alias && isRegistered(alias) ? alias : name;
}

// ──────────────────────────────────────────────────────────────
// Migration helper
// ──────────────────────────────────────────────────────────────

/**
 * Check if any legacy env vars are set and log migration hints.
 */
export function detectLegacyEnv(): string[] {
  const hints: string[] = [];

  for (const [legacy, current] of Object.entries(ENV_ALIASES)) {
    if (process.env[legacy] !== undefined && legacy !== current) {
      hints.push(`Env var "${legacy}" is deprecated, use "${current}" instead`);
    }
  }

  return hints;
}

/**
 * Print migration hints to the console.
 */
export function printMigrationHints(): void {
  const hints = detectLegacyEnv();
  if (hints.length > 0) {
    process.stderr.write("\n[Migration Hints]\n");
    for (const hint of hints) {
      process.stderr.write(`  - ${hint}\n`);
    }
    process.stderr.write("\n");
  }
}