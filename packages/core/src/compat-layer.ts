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
  write_file: "file_create",
  edit_file: "file_modify",
  delete_file: "file_delete",
  list_files: "file_list",
  run_shell: "shell_exec",
  execute_command: "shell_exec",
  fetch_url: "web_fetch",
  google_search: "web_search",
  search_web: "web_search",
  send_mail: "email_send",
  take_screenshot: "browser_screenshot",
};

/**
 * Resolve a tool name through aliases.
 */
export function resolveToolName(name: string): string {
  return TOOL_ALIASES[name] || name;
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