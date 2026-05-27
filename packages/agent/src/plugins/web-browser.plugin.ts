/**
 * Web Browser Plugin
 * 
 * Provides safety checks and result formatting for web browsing tools.
 * Hooks into:
 * - before_tool_call: validates URLs for safety before browser/playwright tools
 * - after_tool_call: formats web results into structured summaries
 */

import type { Plugin, PluginHookRegistration, BeforeToolCallHook, AfterToolCallHook } from "@evoclaw/core";

const MANIFEST = {
  name: "Web Browser",
  version: "1.0.0",
  description: "Full web browsing capabilities with Playwright integration and URL safety",
  author: "evoclaw",
};

/** Browser-related tool names that this plugin monitors */
const BROWSER_TOOLS = [
  "web_search",
  "web_fetch",
  "web_browse",
  "browser_navigate",
  "browser_screenshot",
  "browser_click",
  "browser_type",
];

/** Blocked URL patterns for safety */
const BLOCKED_URL_PATTERNS: RegExp[] = [
  /^(?!https?:\/\/)/i,  // Only allow http/https URLs
];

/** Suspicious URL patterns to warn about */
const SUSPICIOUS_URL_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /\.(exe|dll|bat|sh|msi|apk|dmg|pkg)\b/i, reason: "URL points to executable/binary" },
  { regex: /localhost|127\.0\.0\.1|0\.0\.0\.0|::1/, reason: "URL targets local/loopback address" },
  { regex: /\.(onion|i2p)\b/i, reason: "URL uses anonymous/onion routing" },
];

function extractUrl(params: Record<string, unknown>): string | null {
  return (params.url as string) || (params.search_url as string) || (params.query as string) || null;
}

function formatWebResult(toolName: string, result: unknown): string | null {
  try {
    const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    if (!resultStr || resultStr.length < 10) return null;

    // Truncate very long results
    const maxLength = 5000;
    const truncated = resultStr.length > maxLength 
      ? resultStr.substring(0, maxLength) + `\n...(truncated, ${resultStr.length} total chars)`
      : resultStr;

    return `[Web Browser] ${toolName} result:\n${truncated}`;
  } catch {
    return null;
  }
}

export function createWebBrowserPlugin(): Plugin {
  let browseCount = 0;

  const hooks: PluginHookRegistration[] = [
    {
      hookType: "before_tool_call",
      priority: "first",
      handler: async (hook) => {
        const h = hook as BeforeToolCallHook;
        if (!BROWSER_TOOLS.includes(h.toolName)) return {};

        const url = extractUrl(h.params || {});
        if (!url) return {};

        // Block unsafe URL schemes
        for (const pattern of BLOCKED_URL_PATTERNS) {
          if (pattern.test(url)) {
            console.log(`[Web Browser] Blocked unsafe URL: ${url}`);
            return { block: true, error: "URL blocked by Web Browser plugin: invalid protocol or format" };
          }
        }

        // Warn about suspicious URLs
        for (const { regex, reason } of SUSPICIOUS_URL_PATTERNS) {
          if (regex.test(url)) {
            console.log(`[Web Browser] Warning: ${reason} - ${url}`);
          }
        }

        browseCount++;
        console.log(`[Web Browser] Allowing ${h.toolName}: ${url} (total: ${browseCount})`);
        return {};
      },
    },
    {
      hookType: "after_tool_call",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as AfterToolCallHook;
        if (!BROWSER_TOOLS.includes(h.toolName) || h.errored) return {};

        const formatted = formatWebResult(h.toolName, h.result);
        if (formatted) {
          // Transform result to include structured formatting
          return { result: formatted };
        }
        return {};
      },
    },
  ];

  return {
    manifest: MANIFEST,
    hooks,
    async shutdown() {
      console.log(`[Web Browser] Shutting down — ${browseCount} requests served`);
    },
    async healthCheck() {
      return { healthy: true, message: `Active (${browseCount} URLs browsed)` };
    },
  };
}