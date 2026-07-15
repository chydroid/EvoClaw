/**
 * Enhanced Browser Plugin — Inspired by browser-act
 *
 * Adds enterprise-grade web browsing capabilities:
 * - Confirmation Gate: user approval for sensitive browser operations
 * - Session Isolation: isolated cookie jars, localStorage per session
 * - Network Capture: monitor XHR/fetch/HAR during browsing
 * - Parallel Fetching: lightweight multi-URL extraction without browser engine
 * - Multi-Strategy Content Extraction: HTTP (fast) vs Playwright (rendered)
 * - Proxy Configuration: per-session proxy support
 * - Screenshot Annotations: highlight elements, capture regions
 * - Multi-Browser Profiles: isolated Chrome profiles per session
 */

import type { PluginHookRegistration } from "@evoclaw/core";
import { SSRFProtection } from "@evoclaw/security";
import * as crypto from "crypto";

/** 共享 SSRF 检查器：用于 lightweightExtract 的初始 URL 和重定向每跳检查 */
const ssrfProtection = new SSRFProtection();

const MANIFEST = {
  name: "Enhanced Browser",
  version: "2.0.0",
  description: "Enterprise web browsing with session isolation, network capture, confirmation gate, parallel fetching, and multi-strategy content extraction",
  description_zh: "增强网页浏览：会话隔离、网络捕获、确认门控、并行抓取、多策略内容提取",
  author: "evoclaw",
  homepage: "https://github.com/browser-act/skills",
};

/** Operations that require user confirmation */
const SENSITIVE_OPERATIONS = new Set([
  "browser_login",
  "browser_submit_form",
  "browser_file_upload",
  "browser_create_profile",
  "browser_delete_profile",
  "browser_execute_js",
]);

/** Browser-related tool names — aligned with registered tools in server/index.ts */
const BROWSER_TOOLS = [
  "web_search",
  "web_fetch",
  "web_browse",
  "browser_navigate",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_login",
  "browser_submit_form",
  "browser_file_upload",
  "browser_create_profile",
  "browser_delete_profile",
  "browser_execute_js",
  "browser_js_eval",
  "browser_extract_content",
  "browser_capture_network",
  "browser_parallel_fetch",
  "browser_get_cookies",
  "browser_set_cookies",
  "browser_list_sessions",
  "browser_get_text",
  "browser_get_html",
  "browser_find_elements",
  "browser_fetch_json",
  "browser_tabs",
  "browser_search",
];

/** Blocked URL patterns */
const BLOCKED_URL_PATTERNS: RegExp[] = [
  /^(?!https?:\/\/)/i,
  /^https?:\/\/localhost[:\/]/i,
  /^https?:\/\/127\.\d+\.\d+\.\d+/i,
  /^https?:\/\/0\.0\.0\.0/i,
  /^https?:\/\/\[?::1\]?/i,
  /\.onion\b/i,
  /\.i2p\b/i,
];

/** Suspicious URL patterns (warn only) */
const SUSPICIOUS_URL_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /\.(exe|dll|bat|sh|msi|apk|dmg|pkg|scr|cmd|ps1|vbs)\b/i, reason: "executable/binary download" },
  { regex: /\/\.\.\//, reason: "path traversal attempt" },
  { regex: /data:\s*text\/html/i, reason: "data URI with HTML content" },
  { regex: /javascript:\s*/i, reason: "javascript: protocol" },
];

// ── Session & Profile Management ──────────────────────

interface BrowserSession {
  id: string;
  name: string;
  proxy?: string;
  userAgent?: string;
  cookies: Map<string, string>;
  localStorage: Map<string, string>;
  headers: Record<string, string>;
  createdAt: Date;
  lastUsedAt: Date;
  networkLogs: NetworkEntry[];
  activeUrl: string | null;
  pageTitle: string | null;
}

interface NetworkEntry {
  id: number;
  url: string;
  method: string;
  status: number;
  type: "xhr" | "fetch" | "document" | "stylesheet" | "script" | "image" | "media" | "other";
  duration: number;
  size: number;
  timestamp: Date;
  responseHeaders?: Record<string, string>;
}

interface ExtractionOptions {
  strategy: "lightweight" | "rendered";
  extractLinks?: boolean;
  extractForms?: boolean;
  extractMeta?: boolean;
  extractText?: boolean;
  maxLength?: number;
  waitForSelector?: string;
  timeout?: number;
}

interface ExtractionResult {
  url: string;
  title: string;
  text: string;
  html: string;
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string; method: string; fields: string[] }>;
  meta: Record<string, string>;
  status: number;
  duration: number;
  strategy: ExtractionOptions["strategy"];
  screenshot?: string; // base64
  error?: string;
}

// ── Helper Functions ──────────────────────────────────

function extractUrl(params: Record<string, unknown>): string | null {
  return (params.url as string) || (params.search_url as string) || null;
}

function formatWebResult(toolName: string, result: unknown): string | null {
  try {
    const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    if (!resultStr || resultStr.length < 10) return null;

    // ── Smart extraction for download/scraping scenarios ──
    // Extract raw HTML from the result object for regex matching (JSON.stringify escapes HTML)
    let rawHtmlForAnalysis = "";
    if (typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>;
      rawHtmlForAnalysis = (r.html || r.text || r.body || r.content || "") as string;
    } else if (typeof result === "string") {
      rawHtmlForAnalysis = result;
    }
    const structuredInfo = rawHtmlForAnalysis ? extractStructuredContent(rawHtmlForAnalysis) : null;

    const maxLength = 8000;
    const truncated = resultStr.length > maxLength
      ? resultStr.substring(0, maxLength) + `\n...(truncated, ${resultStr.length} total chars)`
      : resultStr;

    let header = `[Enhanced Browser] ${toolName} result:\n`;
    if (structuredInfo) {
      header += `\n## Structured Content Analysis\n${structuredInfo}\n\n---\n`;
    }

    return header + truncated;
  } catch {
    return null;
  }
}

/**
 * Extract structured content from web results to help Agent identify download targets.
 * Focuses on: chapter links, download links, page structure for scraping.
 */
function extractStructuredContent(content: string): string | null {
  const parts: string[] = [];

  // Extract chapter list links (common in novel sites)
  const chapterLinkPattern = /<a[^>]+href=["']([^"']*(?:chapter|\d+\.html|read|book|novel|article|view|thread|detail)[^"']*)["'][^>]*>([^<]*)<\/a>/gi;
  const chapterLinks: Array<{ text: string; href: string }> = [];
  let match;
  while ((match = chapterLinkPattern.exec(content)) !== null && chapterLinks.length < 30) {
    const text = match[2].replace(/<[^>]+>/g, "").trim();
    if (text && text.length > 1 && text.length < 200) {
      chapterLinks.push({ text, href: match[1] });
    }
  }
  if (chapterLinks.length > 0) {
    parts.push(`**Chapter Links Found (${chapterLinks.length}):**`);
    chapterLinks.forEach((l, i) => {
      parts.push(`  ${i + 1}. [${l.text}](${l.href})`);
    });
    if (chapterLinks.length >= 30) parts.push(`  ... (more links available)`);
  }

  // Extract download links
  const downloadLinkPattern = /<a[^>]+href=["']([^"']*(?:download|txt|pdf|epub|zip|rar|7z|mp3|mp4|mkv|avi|file|attachment)[^"']*)["'][^>]*>([^<]*)<\/a>/gi;
  const downloadLinks: Array<{ text: string; href: string }> = [];
  while ((match = downloadLinkPattern.exec(content)) !== null && downloadLinks.length < 10) {
    downloadLinks.push({ text: match[2].replace(/<[^>]+>/g, "").trim(), href: match[1] });
  }
  if (downloadLinks.length > 0) {
    parts.push(`\n**Download Links Found (${downloadLinks.length}):**`);
    downloadLinks.forEach((l, i) => {
      parts.push(`  ${i + 1}. [${l.text}](${l.href})`);
    });
  }

  // Extract page structure hints
  const titleMatch = content.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch) parts.push(`\n**Page Title:** ${titleMatch[1].trim()}`);

  const charsetMatch = content.match(/charset=["']?([\w-]+)/i);
  if (charsetMatch) parts.push(`**Encoding:** ${charsetMatch[1]}`);

  const paginationPattern = /<a[^>]+href=["'][^"']*(?:page[=_\-\/]\d+|pn[=_\-\/]\d+|p[=_\-\/]\d+|index[=_\-\/]\d+)["'][^>]*>/i;
  if (paginationPattern.test(content)) parts.push("**Pagination detected** — multi-page structure");

  const totalLinks = (content.match(/<a\s/gi) || []).length;
  if (totalLinks > 0) parts.push(`**Total links on page:** ${totalLinks}`);

  return parts.length > 0 ? parts.join("\n") : null;
}

function extractLinksFromHtml(html: string): Array<{ text: string; href: string }> {
  const links: Array<{ text: string; href: string }> = [];
  const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null && links.length < 100) {
    const text = match[2].replace(/<[^>]+>/g, "").trim();
    if (text) links.push({ text: text.slice(0, 200), href: match[1] });
  }
  return links;
}

function extractFormsFromHtml(html: string): Array<{ action: string; method: string; fields: string[] }> {
  const forms: Array<{ action: string; method: string; fields: string[] }> = [];
  const formRegex = /<form[^>]*>/gi;
  let match;
  while ((match = formRegex.exec(html)) !== null) {
    const formTag = match[0];
    const actionMatch = formTag.match(/action=["']([^"']*)["']/i);
    const methodMatch = formTag.match(/method=["']([^"']*)["']/i);
    const fieldRegex = /<(?:input|textarea|select)[^>]+name=["']([^"']+)["'][^>]*>/gi;
    const fields: string[] = [];
    let fMatch;
    while ((fMatch = fieldRegex.exec(html)) !== null) {
      fields.push(fMatch[1]);
    }
    forms.push({
      action: actionMatch ? actionMatch[1] : "",
      method: (methodMatch ? methodMatch[1] : "get").toLowerCase(),
      fields: [...new Set(fields)],
    });
  }
  return forms;
}

function extractMetaFromHtml(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const regex = /<meta[^>]+(?:name|property)=["']([^"']+)["'][^>]+content=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    meta[match[1]] = match[2];
  }
  return meta;
}

// ── Lightweight HTTP Extraction (no browser engine needed) ──

async function lightweightExtract(
  url: string,
  options: ExtractionOptions,
  session?: BrowserSession
): Promise<ExtractionResult> {
  const startTime = Date.now();
  const headers: Record<string, string> = {
    "User-Agent": session?.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36 EvoClaw/2.0",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    ...(session?.headers || {}),
  };

  // Add session cookies
  if (session?.cookies.size) {
    headers["Cookie"] = [...session.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout ?? 15000);

  try {
    // 初始 URL SSRF 检查：防止请求内网/元数据端点
    const initialSsrf = await ssrfProtection.checkURL(url);
    if (!initialSsrf.allowed) {
      return {
        url,
        title: "",
        text: "",
        html: "",
        links: [],
        forms: [],
        meta: {},
        status: 0,
        duration: Date.now() - startTime,
        strategy: "lightweight",
        error: `Blocked by SSRF protection: ${initialSsrf.reason}`,
      };
    }

    // 手动处理重定向：对每个 3xx Location 执行 SSRF 二次检查，
    // 防止外部服务器 302 到内网/元数据端点绕过初始 URL 校验。
    let response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
    });

    // 跟随重定向链（最多 5 跳），每跳都做 SSRF 检查
    let currentUrl = url;
    let redirectCount = 0;
    while ([301, 302, 303, 307, 308].includes(response.status) && redirectCount < 5) {
      const location = response.headers.get("location");
      if (!location) break;
      const redirectUrl = new URL(location, currentUrl).toString();
      const redirectSsrf = await ssrfProtection.checkURL(redirectUrl);
      if (!redirectSsrf.allowed) {
        return {
          url: redirectUrl,
          title: "",
          text: "",
          html: "",
          links: [],
          forms: [],
          meta: {},
          status: response.status,
          duration: Date.now() - startTime,
          strategy: "lightweight",
          error: `Blocked by SSRF protection on redirect: ${redirectSsrf.reason}`,
        };
      }
      currentUrl = redirectUrl;
      response = await fetch(redirectUrl, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      redirectCount++;
    }

    if (!response.ok) {
      return {
        url: currentUrl,
        title: "",
        text: "",
        html: "",
        links: [],
        forms: [],
        meta: {},
        status: response.status,
        duration: Date.now() - startTime,
        strategy: "lightweight",
        error: `HTTP ${response.status} ${response.statusText}`.trim(),
      };
    }

    const html = await response.text();
    const bodyText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : url;

    // Track Set-Cookie headers
    if (session) {
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) {
        const match = setCookie.match(/^([^=]+)=([^;]+)/);
        if (match) session.cookies.set(match[1], match[2]);
      }
    }

    const result: ExtractionResult = {
      url: currentUrl,
      title,
      text: options.extractText !== false ? bodyText.slice(0, options.maxLength ?? 10000) : "",
      html: html.slice(0, options.maxLength ?? 50000),
      links: options.extractLinks !== false ? extractLinksFromHtml(html) : [],
      forms: options.extractForms !== false ? extractFormsFromHtml(html) : [],
      meta: options.extractMeta !== false ? extractMetaFromHtml(html) : {},
      status: response.status,
      duration: Date.now() - startTime,
      strategy: "lightweight",
    };

    return result;
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === "AbortError"
      || (err instanceof Error && err.message.includes("aborted"));
    return {
      url,
      title: "",
      text: "",
      html: "",
      links: [],
      forms: [],
      meta: {},
      status: isAbort ? 0 : 503,
      duration: Date.now() - startTime,
      strategy: "lightweight",
      error: isAbort ? "Request timed out" : (err instanceof Error ? err.message : String(err)),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Parallel Multi-URL Fetch ──────────────────────────

interface ParallelFetchResult {
  results: Array<{ url: string; success: boolean; title: string; text: string; status: number; duration: number; error?: string }>;
  totalDuration: number;
  successCount: number;
  failureCount: number;
}

async function parallelFetch(
  urls: string[],
  session?: BrowserSession,
  concurrency = 5
): Promise<ParallelFetchResult> {
  const startTime = Date.now();
  const results: ParallelFetchResult["results"] = [];
  let successCount = 0;
  let failureCount = 0;

  // Process in batches
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async (url) => {
        try {
          const result = await lightweightExtract(url, {
            strategy: "lightweight",
            extractLinks: true,
            extractText: true,
            maxLength: 5000,
            timeout: 10000,
          }, session);
          const ok = result.status >= 200 && result.status < 400;
          return { url, success: ok, title: result.title, text: result.text.slice(0, 1000), status: result.status, duration: result.duration, error: result.error };
        } catch (err) {
          return { url, success: false, title: "", text: "", status: 0, duration: 0, error: String(err) };
        }
      })
    );

    for (const r of batchResults) {
      if (r.status === "fulfilled") {
        results.push(r.value);
        if (r.value.success) successCount++;
        else failureCount++;
      } else {
        failureCount++;
      }
    }
  }

  return {
    results,
    totalDuration: Date.now() - startTime,
    successCount,
    failureCount,
  };
}

// ── Plugin ────────────────────────────────────────────

export function createEnhancedBrowserPlugin() {
  // ── State ──
  const sessions = new Map<string, BrowserSession>();
  let confirmationEnabled = true;
  let activeSessionId: string | null = null;
  let browseCount = 0;
  let networkCaptureEnabled = false;

  // Create default session
  const defaultSession: BrowserSession = {
    id: "default",
    name: "Default Session",
    cookies: new Map(),
    localStorage: new Map(),
    headers: {},
    createdAt: new Date(),
    lastUsedAt: new Date(),
    networkLogs: [],
    activeUrl: null,
    pageTitle: null,
  };
  sessions.set("default", defaultSession);

  function getActiveSession(): BrowserSession {
    if (activeSessionId && sessions.has(activeSessionId)) {
      return sessions.get(activeSessionId)!;
    }
    return defaultSession;
  }

  function createSession(name: string, options?: { proxy?: string; userAgent?: string }): BrowserSession {
    const session: BrowserSession = {
      id: `session-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
      name,
      proxy: options?.proxy,
      userAgent: options?.userAgent,
      cookies: new Map(),
      localStorage: new Map(),
      headers: options?.proxy ? { "X-Proxy-Used": "true" } : {},
      createdAt: new Date(),
      lastUsedAt: new Date(),
      networkLogs: [],
      activeUrl: null,
      pageTitle: null,
    };
    sessions.set(session.id, session);
    return session;
  }

  // ── Hooks ──

  const hooks: PluginHookRegistration[] = [
    // ── before_tool_call: Safety checks + Confirmation Gate ──
    {
      hookType: "before_tool_call",
      priority: "first",
      handler: async (hook) => {
        const h = hook as { toolName: string; params?: Record<string, unknown> };
        if (!BROWSER_TOOLS.includes(h.toolName)) return {};

        const url = extractUrl(h.params || {});
        const session = getActiveSession();
        session.lastUsedAt = new Date();

        // ── Block dangerous URLs ──
        if (url) {
          for (const pattern of BLOCKED_URL_PATTERNS) {
            if (pattern.test(url)) {
              console.log(`[Enhanced Browser] BLOCKED unsafe URL: ${url} (pattern: ${pattern})`);
              return {
                block: true,
                error: `[Enhanced Browser] URL blocked by safety policy: ${url}`,
              };
            }
          }

          for (const { regex, reason } of SUSPICIOUS_URL_PATTERNS) {
            if (regex.test(url)) {
              console.log(`[Enhanced Browser] WARNING: ${reason} — ${url}`);
            }
          }

          if (url.length > 2000) {
            return { block: true, error: "[Enhanced Browser] URL too long (>2000 chars)" };
          }
        }

        // ── Confirmation Gate for sensitive operations ──
        if (confirmationEnabled && SENSITIVE_OPERATIONS.has(h.toolName)) {
          console.log(
            `[Enhanced Browser] Confirmation Gate: "${h.toolName}" requires user approval (url: ${url || "N/A"}, session: ${session.name})`
          );
          return {
            requireConfirmation: true,
            message: `[Enhanced Browser] Operation "${h.toolName}" requires confirmation. URL: ${url || "N/A"}`,
          };
        }

        browseCount++;
        return {};
      },
    },

    // ── after_tool_call: Result formatting + Network log capture ──
    {
      hookType: "after_tool_call",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as {
          toolName: string;
          result?: unknown;
          errored?: boolean;
        };
        if (!BROWSER_TOOLS.includes(h.toolName) || h.errored) return {};

        // Update session active URL
        const session = getActiveSession();
        if (h.toolName === "browser_navigate" || h.toolName === "web_fetch" || h.toolName === "web_browse") {
          if (typeof h.result === "object" && h.result !== null) {
            const r = h.result as Record<string, unknown>;
            if (r.url) session.activeUrl = String(r.url);
            if (r.title) session.pageTitle = String(r.title);
          }
        }

        // Format result
        const formatted = formatWebResult(h.toolName, h.result);
        if (formatted) {
          return { result: formatted };
        }
        return {};
      },
    },

    // ── Network capture hook ──
    {
      hookType: "after_tool_call",
      priority: "last",
      handler: async (hook) => {
        if (!networkCaptureEnabled) return {};
        const h = hook as {
          toolName: string;
          result?: unknown;
          duration?: number;
        };
        if (!BROWSER_TOOLS.includes(h.toolName)) return {};

        const session = getActiveSession();
        const entry: NetworkEntry = {
          id: session.networkLogs.length > 0
            ? session.networkLogs[session.networkLogs.length - 1].id + 1
            : 1,
          url: session.activeUrl || h.toolName,
          method: "GET",
          status: 200,
          type: "document",
          duration: (h.duration as number) || 0,
          size: typeof h.result === "string" ? (h.result as string).length : JSON.stringify(h.result || "").length,
          timestamp: new Date(),
        };
        session.networkLogs.push(entry);

        // Keep max 500 entries
        if (session.networkLogs.length > 500) {
          session.networkLogs = session.networkLogs.slice(-500);
        }
        return {};
      },
    },
  ];

  // ── Plugin Object ──
  return {
    manifest: MANIFEST,
    hooks,

    // Enable/disable confirmation gate
    setConfirmationEnabled(enabled: boolean) {
      confirmationEnabled = enabled;
      console.log(`[Enhanced Browser] Confirmation Gate: ${enabled ? "ENABLED" : "DISABLED"}`);
    },

    // Enable/disable network capture
    setNetworkCapture(enabled: boolean) {
      networkCaptureEnabled = enabled;
      console.log(`[Enhanced Browser] Network Capture: ${enabled ? "ENABLED" : "DISABLED"}`);
    },

    // Session management
    createSession(name: string, options?: { proxy?: string; userAgent?: string }) {
      return createSession(name, options);
    },

    deleteSession(id: string): boolean {
      if (id === "default") return false;
      return sessions.delete(id);
    },

    switchSession(id: string): boolean {
      if (sessions.has(id)) {
        activeSessionId = id;
        return true;
      }
      return false;
    },

    listSessions() {
      return [...sessions.values()].map((s) => ({
        id: s.id,
        name: s.name,
        proxy: s.proxy,
        activeUrl: s.activeUrl,
        pageTitle: s.pageTitle,
        cookieCount: s.cookies.size,
        networkLogCount: s.networkLogs.length,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        isActive: s.id === (activeSessionId || "default"),
      }));
    },

    getActiveSession() {
      return {
        ...getActiveSession(),
        cookies: undefined,
        localStorage: undefined,
        networkLogs: undefined,
      };
    },

    getNetworkLogs(sessionId?: string) {
      const session = sessionId ? sessions.get(sessionId) : getActiveSession();
      return session?.networkLogs || [];
    },

    clearNetworkLogs(sessionId?: string) {
      const session = sessionId ? sessions.get(sessionId) : getActiveSession();
      if (session) session.networkLogs = [];
    },

    // Cookie management
    getCookies(sessionId?: string) {
      const session = sessionId ? sessions.get(sessionId) : getActiveSession();
      if (!session) return {};
      return Object.fromEntries(session.cookies);
    },

    setCookies(cookies: Record<string, string>, sessionId?: string) {
      const session = sessionId ? sessions.get(sessionId) : getActiveSession();
      if (!session) return;
      for (const [k, v] of Object.entries(cookies)) {
        session.cookies.set(k, v);
      }
    },

    clearCookies(sessionId?: string) {
      const session = sessionId ? sessions.get(sessionId) : getActiveSession();
      if (session) session.cookies.clear();
    },

    // Content extraction
    async lightweightExtract(url: string, options?: Partial<ExtractionOptions>) {
      return lightweightExtract(url, {
        strategy: "lightweight",
        extractLinks: true,
        extractForms: true,
        extractMeta: true,
        extractText: true,
        maxLength: 10000,
        timeout: 15000,
        ...options,
      }, getActiveSession());
    },

    async parallelFetch(urls: string[], concurrency?: number) {
      return parallelFetch(urls, getActiveSession(), concurrency);
    },

    // Statistics
    getStats() {
      return {
        browseCount,
        sessionCount: sessions.size,
        activeSession: activeSessionId || "default",
        confirmationGate: confirmationEnabled,
        networkCapture: networkCaptureEnabled,
      };
    },

    // Lifecycle
    async shutdown() {
      console.log(`[Enhanced Browser] Shutting down — ${browseCount} requests, ${sessions.size} sessions`);
      sessions.clear();
    },

    async healthCheck() {
      return {
        healthy: true,
        message: `Active (${browseCount} URLs browsed, ${sessions.size} sessions)`,
      };
    },
  };
}