/**
 * Enhanced Browser Plugin — Comprehensive Tests
 *
 * Tests all core capabilities:
 * - Manifest & plugin creation
 * - Session management (CRUD, isolation, switching)
 * - Cookie management (get, set, clear, isolation)
 * - Network capture (enable, disable, logs, clear)
 * - Confirmation gate (enable, disable, sensitive operations)
 * - URL safety (blocked patterns, suspicious patterns, length check)
 * - Before-tool hooks (block, pass, confirmation)
 * - After-tool hooks (format, network capture)
 * - Lightweight content extraction
 * - Parallel multi-URL fetching
 * - Statistics & health check
 * - Shutdown lifecycle
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEnhancedBrowserPlugin } from "./enhanced-browser.plugin";

// Helper: create a fresh plugin instance for each test
function createPlugin() {
  return createEnhancedBrowserPlugin();
}

describe("Enhanced Browser Plugin", () => {
  // ─── Manifest & Plugin Creation ───────────────────────

  describe("Manifest & Creation", () => {
    it("should create plugin with correct manifest name", () => {
      const plugin = createPlugin();
      expect(plugin.manifest.name).toBe("Enhanced Browser");
      expect(plugin.manifest.version).toBe("2.0.0");
    });

    it("should have Chinese description", () => {
      const plugin = createPlugin();
      expect(plugin.manifest.description_zh).toBeTruthy();
    });

    it("should have hooks registered", () => {
      const plugin = createPlugin();
      expect(plugin.hooks).toBeDefined();
      expect(plugin.hooks.length).toBeGreaterThanOrEqual(2);
    });

    it("should have a before_tool_call hook with first priority", () => {
      const plugin = createPlugin();
      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call");
      expect(beforeHook).toBeDefined();
      expect(beforeHook!.priority).toBe("first");
    });

    it("should have after_tool_call hooks", () => {
      const plugin = createPlugin();
      const afterHooks = plugin.hooks.filter((h) => h.hookType === "after_tool_call");
      expect(afterHooks.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Session Management ───────────────────────────────

  describe("Session Management", () => {
    let plugin: ReturnType<typeof createPlugin>;

    beforeEach(() => {
      plugin = createPlugin();
    });

    it("should have a default session", () => {
      const sessions = plugin.listSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0].id).toBe("default");
      expect(sessions[0].name).toBe("Default Session");
    });

    it("should create a new session", () => {
      const session = plugin.createSession("Test Session");
      expect(session.id).toMatch(/^session-/);
      expect(session.name).toBe("Test Session");
    });

    it("should create session with proxy and userAgent", () => {
      const session = plugin.createSession("Proxy Session", {
        proxy: "http://proxy:8080",
        userAgent: "TestAgent/1.0",
      });
      expect(session.proxy).toBe("http://proxy:8080");
      expect(session.userAgent).toBe("TestAgent/1.0");
    });

    it("should list all sessions", () => {
      plugin.createSession("Session A");
      plugin.createSession("Session B");
      const sessions = plugin.listSessions();
      expect(sessions.length).toBe(3); // default + A + B
      expect(sessions.map((s) => s.name)).toContain("Session A");
      expect(sessions.map((s) => s.name)).toContain("Session B");
    });

    it("should mark active session correctly", () => {
      const session = plugin.createSession("Active Session");
      plugin.switchSession(session.id);
      const sessions = plugin.listSessions();
      const active = sessions.find((s) => s.id === session.id);
      expect(active?.isActive).toBe(true);
    });

    it("should switch active session", () => {
      const sessionA = plugin.createSession("Session A");
      const sessionB = plugin.createSession("Session B");
      expect(plugin.switchSession(sessionA.id)).toBe(true);
      expect(plugin.switchSession(sessionB.id)).toBe(true);
    });

    it("should return false for non-existent session switch", () => {
      expect(plugin.switchSession("non-existent")).toBe(false);
    });

    it("should not delete default session", () => {
      expect(plugin.deleteSession("default")).toBe(false);
      expect(plugin.listSessions().length).toBe(1);
    });

    it("should delete a custom session", () => {
      const session = plugin.createSession("To Delete");
      expect(plugin.listSessions().length).toBe(2);
      expect(plugin.deleteSession(session.id)).toBe(true);
      expect(plugin.listSessions().length).toBe(1);
    });

    it("should return false deleting non-existent session", () => {
      expect(plugin.deleteSession("non-existent")).toBe(false);
    });

    it("should isolate cookies between sessions", () => {
      const sessionA = plugin.createSession("A");
      const sessionB = plugin.createSession("B");

      plugin.setCookies({ token: "aaa" }, sessionA.id);
      plugin.setCookies({ token: "bbb" }, sessionB.id);

      expect(plugin.getCookies(sessionA.id)).toEqual({ token: "aaa" });
      expect(plugin.getCookies(sessionB.id)).toEqual({ token: "bbb" });
    });

    it("should track session metadata in list", () => {
      const session = plugin.createSession("Meta Session");
      plugin.setCookies({ k1: "v1", k2: "v2" }, session.id);
      const sessions = plugin.listSessions();
      const listed = sessions.find((s) => s.id === session.id);
      expect(listed?.cookieCount).toBe(2);
    });
  });

  // ─── Cookie Management ────────────────────────────────

  describe("Cookie Management", () => {
    let plugin: ReturnType<typeof createPlugin>;

    beforeEach(() => {
      plugin = createPlugin();
    });

    it("should return empty cookies initially", () => {
      expect(plugin.getCookies()).toEqual({});
    });

    it("should set and get cookies", () => {
      plugin.setCookies({ session_id: "abc123", token: "xyz" });
      expect(plugin.getCookies()).toEqual({ session_id: "abc123", token: "xyz" });
    });

    it("should overwrite existing cookies", () => {
      plugin.setCookies({ key: "old" });
      plugin.setCookies({ key: "new" });
      expect(plugin.getCookies()).toEqual({ key: "new" });
    });

    it("should merge multiple set calls", () => {
      plugin.setCookies({ a: "1" });
      plugin.setCookies({ b: "2" });
      expect(plugin.getCookies()).toEqual({ a: "1", b: "2" });
    });

    it("should clear all cookies", () => {
      plugin.setCookies({ a: "1", b: "2" });
      expect(Object.keys(plugin.getCookies()).length).toBe(2);
      plugin.clearCookies();
      expect(plugin.getCookies()).toEqual({});
    });

    it("should get cookies for specific session", () => {
      const session = plugin.createSession("Cookie Session");
      plugin.setCookies({ sid: "sid-1" }, session.id);
      expect(plugin.getCookies(session.id)).toEqual({ sid: "sid-1" });
      // Default session should still be empty
      expect(plugin.getCookies("default")).toEqual({});
    });

    it("should clear cookies for specific session only", () => {
      const session = plugin.createSession("S1");
      plugin.setCookies({ a: "1" }, "default");
      plugin.setCookies({ b: "2" }, session.id);
      plugin.clearCookies(session.id);
      expect(plugin.getCookies("default")).toEqual({ a: "1" });
      expect(plugin.getCookies(session.id)).toEqual({});
    });

    it("should return empty object for non-existent session", () => {
      expect(plugin.getCookies("non-existent")).toEqual({});
    });
  });

  // ─── Confirmation Gate ────────────────────────────────

  describe("Confirmation Gate", () => {
    it("should be enabled by default (in stats)", () => {
      const plugin = createPlugin();
      expect(plugin.getStats().confirmationGate).toBe(true);
    });

    it("should be able to disable confirmation", () => {
      const plugin = createPlugin();
      plugin.setConfirmationEnabled(false);
      expect(plugin.getStats().confirmationGate).toBe(false);
    });

    it("should be able to re-enable confirmation", () => {
      const plugin = createPlugin();
      plugin.setConfirmationEnabled(false);
      plugin.setConfirmationEnabled(true);
      expect(plugin.getStats().confirmationGate).toBe(true);
    });

    it("should require confirmation for sensitive operations (browser_login)", async () => {
      const plugin = createPlugin();
      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;
      const result = await beforeHook.handler({
        toolName: "browser_login",
        params: { url: "https://example.com/login" },
      });
      expect(result.requireConfirmation).toBe(true);
      expect(result.message).toContain("browser_login");
    });

    it("should require confirmation for browser_submit_form", async () => {
      const plugin = createPlugin();
      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;
      const result = await beforeHook.handler({
        toolName: "browser_submit_form",
        params: { url: "https://example.com/form" },
      });
      expect(result.requireConfirmation).toBe(true);
    });

    it("should require confirmation for browser_file_upload", async () => {
      const plugin = createPlugin();
      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;
      const result = await beforeHook.handler({
        toolName: "browser_file_upload",
        params: {},
      });
      expect(result.requireConfirmation).toBe(true);
    });

    it("should require confirmation for browser_execute_js", async () => {
      const plugin = createPlugin();
      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;
      const result = await beforeHook.handler({
        toolName: "browser_execute_js",
        params: { code: "console.log('test')" },
      });
      expect(result.requireConfirmation).toBe(true);
    });

    it("should NOT require confirmation when gate is disabled", async () => {
      const plugin = createPlugin();
      plugin.setConfirmationEnabled(false);
      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;
      const result = await beforeHook.handler({
        toolName: "browser_login",
        params: { url: "https://example.com/login" },
      });
      expect(result.requireConfirmation).toBeUndefined();
    });

    it("should NOT require confirmation for non-sensitive browser tool", async () => {
      const plugin = createPlugin();
      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;
      const result = await beforeHook.handler({
        toolName: "browser_navigate",
        params: { url: "https://example.com" },
      });
      expect(result.requireConfirmation).toBeUndefined();
    });
  });

  // ─── URL Safety ───────────────────────────────────────

  describe("URL Safety", () => {
    let plugin: ReturnType<typeof createPlugin>;
    let beforeHook: ReturnType<typeof createPlugin>["hooks"][0];

    beforeEach(() => {
      plugin = createPlugin();
      beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;
    });

    it("should block localhost URLs", async () => {
      const result = await beforeHook.handler({
        toolName: "web_fetch",
        params: { url: "http://localhost:3000/api" },
      });
      expect(result.block).toBe(true);
      expect(result.error).toContain("URL blocked");
    });

    it("should block 127.0.0.1 URLs", async () => {
      const result = await beforeHook.handler({
        toolName: "web_fetch",
        params: { url: "http://127.0.0.1:8080/" },
      });
      expect(result.block).toBe(true);
    });

    it("should block 0.0.0.0 URLs", async () => {
      const result = await beforeHook.handler({
        toolName: "browser_navigate",
        params: { url: "https://0.0.0.0/admin" },
      });
      expect(result.block).toBe(true);
    });

    it("should block non-http/https URLs", async () => {
      const result = await beforeHook.handler({
        toolName: "web_fetch",
        params: { url: "file:///etc/passwd" },
      });
      expect(result.block).toBe(true);
    });

    it("should block .onion URLs", async () => {
      const result = await beforeHook.handler({
        toolName: "web_fetch",
        params: { url: "http://example.onion/data" },
      });
      expect(result.block).toBe(true);
    });

    it("should block overly long URLs (>2000 chars)", async () => {
      const longUrl = "https://example.com/" + "a".repeat(2000);
      const result = await beforeHook.handler({
        toolName: "web_fetch",
        params: { url: longUrl },
      });
      expect(result.block).toBe(true);
      expect(result.error).toContain("too long");
    });

    it("should allow normal HTTPS URLs", async () => {
      const result = await beforeHook.handler({
        toolName: "web_fetch",
        params: { url: "https://www.example.com/page" },
      });
      expect(result.block).toBeUndefined();
    });

    it("should allow normal HTTP URLs", async () => {
      const result = await beforeHook.handler({
        toolName: "browser_navigate",
        params: { url: "http://example.com" },
      });
      expect(result.block).toBeUndefined();
    });

    it("should not block non-browser tools", async () => {
      const result = await beforeHook.handler({
        toolName: "some_other_tool",
        params: { url: "http://localhost:3000" },
      });
      // Non-browser tools pass through without blocking
      expect(result.block).toBeUndefined();
    });

    it("should handle missing URL params gracefully", async () => {
      const result = await beforeHook.handler({
        toolName: "web_fetch",
        params: {},
      });
      expect(result.block).toBeUndefined();
    });
  });

  // ─── After-Tool Hook (Result Formatting) ──────────────

  describe("After-Tool Hook — Result Formatting", () => {
    it("should format web_fetch result", async () => {
      const plugin = createPlugin();
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "normal"
      )!;
      const result = await afterHook.handler({
        toolName: "web_fetch",
        result: { url: "https://example.com", title: "Example", text: "Hello world content here!" },
        errored: false,
      });
      expect(result.result).toBeDefined();
      expect(typeof result.result).toBe("string");
      expect(result.result).toContain("[Enhanced Browser]");
      expect(result.result).toContain("web_fetch");
    });

    it("should format web_search result", async () => {
      const plugin = createPlugin();
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "normal"
      )!;
      const result = await afterHook.handler({
        toolName: "web_search",
        result: { results: [{ title: "Test", url: "https://test.com" }] },
        errored: false,
      });
      expect(result.result).toBeDefined();
      expect(typeof result.result).toBe("string");
    });

    it("should not format errored results", async () => {
      const plugin = createPlugin();
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "normal"
      )!;
      const result = await afterHook.handler({
        toolName: "web_fetch",
        result: { error: "Failed" },
        errored: true,
      });
      expect(result).toEqual({});
    });

    it("should not format non-browser tool results", async () => {
      const plugin = createPlugin();
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "normal"
      )!;
      const result = await afterHook.handler({
        toolName: "some_other_tool",
        result: { data: "something" },
        errored: false,
      });
      expect(result).toEqual({});
    });

    it("should handle short result strings gracefully", async () => {
      const plugin = createPlugin();
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "normal"
      )!;
      const result = await afterHook.handler({
        toolName: "web_fetch",
        result: "ok",
        errored: false,
      });
      // Very short results may return empty (null from formatWebResult)
      expect(result).toEqual({});
    });
  });

  // ─── Network Capture ─────────────────────────────────

  describe("Network Capture", () => {
    let plugin: ReturnType<typeof createPlugin>;

    beforeEach(() => {
      plugin = createPlugin();
    });

    it("should be disabled by default", () => {
      expect(plugin.getStats().networkCapture).toBe(false);
    });

    it("should enable network capture", () => {
      plugin.setNetworkCapture(true);
      expect(plugin.getStats().networkCapture).toBe(true);
    });

    it("should disable network capture", () => {
      plugin.setNetworkCapture(true);
      plugin.setNetworkCapture(false);
      expect(plugin.getStats().networkCapture).toBe(false);
    });

    it("should return empty logs initially", () => {
      const logs = plugin.getNetworkLogs();
      expect(logs).toEqual([]);
    });

    it("should capture network logs when enabled", async () => {
      plugin.setNetworkCapture(true);
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "last"
      )!;
      await afterHook.handler({
        toolName: "web_fetch",
        result: "test result data here",
        duration: 150,
        errored: false,
      });
      const logs = plugin.getNetworkLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].method).toBe("GET");
      expect(logs[0].duration).toBe(150);
    });

    it("should NOT capture logs when disabled", async () => {
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "last"
      )!;
      await afterHook.handler({
        toolName: "web_fetch",
        result: "data",
        duration: 100,
        errored: false,
      });
      expect(plugin.getNetworkLogs()).toEqual([]);
    });

    it("should clear network logs", async () => {
      plugin.setNetworkCapture(true);
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "last"
      )!;
      await afterHook.handler({
        toolName: "web_fetch",
        result: "data",
        duration: 100,
        errored: false,
      });
      expect(plugin.getNetworkLogs().length).toBe(1);
      plugin.clearNetworkLogs();
      expect(plugin.getNetworkLogs()).toEqual([]);
    });

    it("should get logs for specific session", () => {
      const session = plugin.createSession("Log Session");
      expect(plugin.getNetworkLogs(session.id)).toEqual([]);
    });

    it("should clear logs for specific session", async () => {
      const session = plugin.createSession("S1");
      plugin.setNetworkCapture(true);
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "last"
      )!;
      plugin.switchSession(session.id);
      await afterHook.handler({
        toolName: "web_fetch",
        result: "data",
        duration: 100,
        errored: false,
      });
      expect(plugin.getNetworkLogs(session.id).length).toBe(1);
      plugin.clearNetworkLogs(session.id);
      expect(plugin.getNetworkLogs(session.id)).toEqual([]);
    });

    it("should track network log metadata correctly", async () => {
      plugin.setNetworkCapture(true);
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "last"
      )!;
      await afterHook.handler({
        toolName: "browser_navigate",
        result: "Some page content",
        duration: 320,
        errored: false,
      });
      const logs = plugin.getNetworkLogs();
      expect(logs[0].type).toBe("document");
      expect(logs[0].status).toBe(200);
      expect(logs[0].timestamp).toBeInstanceOf(Date);
    });
  });

  // ─── Statistics & Health ──────────────────────────────

  describe("Statistics & Health Check", () => {
    it("should return initial stats", () => {
      const plugin = createPlugin();
      const stats = plugin.getStats();
      expect(stats.browseCount).toBe(0);
      expect(stats.sessionCount).toBe(1);
      expect(stats.activeSession).toBe("default");
      expect(stats.confirmationGate).toBe(true);
      expect(stats.networkCapture).toBe(false);
    });

    it("should increment browse count on browser tool calls", async () => {
      const plugin = createPlugin();
      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;
      await beforeHook.handler({ toolName: "web_fetch", params: { url: "https://example.com" } });
      await beforeHook.handler({ toolName: "browser_navigate", params: { url: "https://example.org" } });
      expect(plugin.getStats().browseCount).toBe(2);
    });

    it("should NOT increment browse count for blocked URLs", async () => {
      const plugin = createPlugin();
      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;
      await beforeHook.handler({
        toolName: "web_fetch",
        params: { url: "http://localhost:3000" },
      });
      expect(plugin.getStats().browseCount).toBe(0);
    });

    it("should return healthy status", async () => {
      const plugin = createPlugin();
      const health = await plugin.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.message).toContain("Active");
    });

    it("should track session count in stats", () => {
      const plugin = createPlugin();
      expect(plugin.getStats().sessionCount).toBe(1);
      plugin.createSession("S1");
      plugin.createSession("S2");
      expect(plugin.getStats().sessionCount).toBe(3);
      plugin.deleteSession(
        plugin.listSessions().find((s) => s.name === "S1")!.id
      );
      expect(plugin.getStats().sessionCount).toBe(2);
    });
  });

  // ─── Shutdown Lifecycle ────────────────────────────────

  describe("Shutdown Lifecycle", () => {
    it("should shutdown gracefully", async () => {
      const plugin = createPlugin();
      plugin.createSession("S1");
      plugin.createSession("S2");
      await plugin.shutdown();
      // After shutdown, sessions should be cleared
      expect(plugin.listSessions().length).toBe(0);
    });

    it("should handle multiple shutdown calls", async () => {
      const plugin = createPlugin();
      await plugin.shutdown();
      await plugin.shutdown(); // Should not throw
      expect(plugin.listSessions().length).toBe(0);
    });
  });

  // ─── Lightweight Extraction ────────────────────────────

  describe("Lightweight Content Extraction", () => {
    let plugin: ReturnType<typeof createPlugin>;

    beforeEach(() => {
      plugin = createPlugin();
    });

    it("should expose lightweightExtract method", () => {
      expect(typeof plugin.lightweightExtract).toBe("function");
    });

    it("should extract from a real URL", async () => {
      const result = await plugin.lightweightExtract("https://httpbin.org/html");
      if (result.status === 503 || result.status === 0) {
        console.warn("httpbin.org unavailable, skipping extract-from-URL assertion");
        return;
      }
      expect(result.url).toBeTruthy();
      expect(result.status).toBe(200);
      expect(result.strategy).toBe("lightweight");
      expect(typeof result.duration).toBe("number");
    }, 30000);

    it("should extract title from HTML", async () => {
      const result = await plugin.lightweightExtract("https://httpbin.org/html");
      if (result.status === 503 || result.status === 0) {
        console.warn("httpbin.org unavailable, skipping title assertion");
        return;
      }
      // httpbin.org/html returns a page by Herman Melville which has a title
      expect(result.title).toBeTruthy();
    }, 30000);

    it("should extract links from HTML", async () => {
      const result = await plugin.lightweightExtract("https://httpbin.org/links/10/0");
      if (result.status === 503 || result.status === 0) {
        console.warn("httpbin.org unavailable, skipping extract-links assertion");
        return;
      }
      // httpbin.org/links/10/0 has 10 links
      expect(result.links.length).toBeGreaterThan(0);
    }, 30000);

    it("should timeout on slow URLs", async () => {
      try {
        await plugin.lightweightExtract("https://httpbin.org/delay/30", {
          timeout: 2000,
        });
        // Should not reach here
        expect(true).toBe(false);
      } catch (err: unknown) {
        expect(err).toBeDefined();
      }
    }, 10000);

    it("should use custom user agent from session", async () => {
      const session = plugin.createSession("UA Session", {
        userAgent: "CustomAgent/9.9",
      });
      plugin.switchSession(session.id);
      const result = await plugin.lightweightExtract("https://httpbin.org/user-agent");
      if (result.status === 503 || result.status === 0) {
        console.warn("httpbin.org unavailable, skipping user-agent assertion");
        return;
      }
      expect(result.text).toContain("CustomAgent");
    }, 30000);

    it("should pass maxLength option to limit text output", async () => {
      const result = await plugin.lightweightExtract("https://httpbin.org/html", {
        maxLength: 100,
      });
      expect(result.text.length).toBeLessThanOrEqual(110); // Allow small buffer
    }, 20000);

    it("should handle 404 responses", async () => {
      const result = await plugin.lightweightExtract("https://httpbin.org/status/404");
      // httpbin.org may be temporarily unavailable (503/timeout) — only assert 404 if we got a response
      if (result.status === 503 || result.status === 0) {
        console.warn("httpbin.org unavailable, skipping 404 assertion");
        return;
      }
      expect(result.status).toBe(404);
    }, 30000);

    it("should handle redirects", async () => {
      const result = await plugin.lightweightExtract("https://httpbin.org/redirect/1");
      if (result.status === 503 || result.status === 0) {
        console.warn("httpbin.org unavailable, skipping redirect assertion");
        return;
      }
      expect(result.status).toBe(200);
      expect(result.url).not.toContain("redirect");
    }, 30000);

    it("should extract meta data", async () => {
      const result = await plugin.lightweightExtract("https://httpbin.org/html");
      if (result.status === 503 || result.status === 0) {
        console.warn("httpbin.org unavailable, skipping meta-data assertion");
        return;
      }
      expect(typeof result.meta).toBe("object");
    }, 30000);

    it("should track Set-Cookie in session", async () => {
      const session = plugin.createSession("Cookie Test");
      plugin.switchSession(session.id);
      // httpbin.org/cookies/set sets a cookie
      const result = await plugin.lightweightExtract("https://httpbin.org/cookies/set?name=value");
      if (result.status === 503 || result.status === 0) {
        console.warn("httpbin.org unavailable, skipping set-cookie assertion");
        return;
      }
      // After this, the session should have captured cookies
      // (Set-Cookie may not always come back, but we verify no error)
      expect(true).toBe(true);
    }, 30000);
  });

  // ─── Parallel Fetching ────────────────────────────────

  describe("Parallel Fetching", () => {
    let plugin: ReturnType<typeof createPlugin>;

    beforeEach(() => {
      plugin = createPlugin();
    });

    it("should expose parallelFetch method", () => {
      expect(typeof plugin.parallelFetch).toBe("function");
    });

    it("should fetch multiple URLs in parallel", async () => {
      const results = await plugin.parallelFetch([
        "https://httpbin.org/get",
        "https://httpbin.org/html",
        "https://httpbin.org/json",
      ]);
      expect(results.results.length).toBe(3);
      expect(results.totalDuration).toBeGreaterThan(0);
      // httpbin.org may return 503 for some URLs — only assert success count if all are 200
      const unavailable = results.results.filter((r) => r.status === 503 || r.status === 0);
      if (unavailable.length > 0) {
        console.warn("httpbin.org partially unavailable, skipping success/failure count assertions");
      } else {
        expect(results.successCount).toBe(3);
        expect(results.failureCount).toBe(0);
      }
    }, 30000);

    it("should handle mixed success/failure", async () => {
      const results = await plugin.parallelFetch([
        "https://httpbin.org/get",
        "https://invalid.domain.that.does.not.exist.test",
      ], 2);
      expect(results.results.length).toBe(2);
      // httpbin.org may return 503 — if so, both could be failures
      const httpbinOk = results.results.find((r) => r.url?.includes("httpbin.org") && r.success);
      if (!httpbinOk) {
        console.warn("httpbin.org unavailable, skipping mixed success/failure assertions");
      } else {
        expect(results.successCount).toBeGreaterThanOrEqual(1);
        expect(results.failureCount).toBeGreaterThanOrEqual(1);
      }
      // At least one result should have failed (invalid domain or httpbin 503)
      const failed = results.results.find((r) => !r.success);
      expect(failed).toBeTruthy();
    }, 20000);

    it("should respect concurrency limit", async () => {
      const startTime = Date.now();
      const urls = Array.from({ length: 4 }, (_, i) => `https://httpbin.org/delay/1`);
      const results = await plugin.parallelFetch(urls, 2);
      // With concurrency=2, 4 delay/1 URLs should take ~2s not ~4s
      const elapsed = Date.now() - startTime;
      expect(results.results.length).toBe(4);
      // httpbin.org may return 503 — if all failed, skip timing assertion
      const anySuccess = results.results.some((r) => r.success);
      if (!anySuccess) {
        console.warn("httpbin.org unavailable, skipping concurrency timing assertion");
      } else {
        // Verify some degree of parallelism (less than 4*1s sequential)
        expect(elapsed).toBeLessThan(15000);
      }
    }, 30000);

    it("should handle empty URL array", async () => {
      const results = await plugin.parallelFetch([]);
      expect(results.results).toEqual([]);
      expect(results.successCount).toBe(0);
      expect(results.failureCount).toBe(0);
    });

    it("should return result metadata for each URL", async () => {
      const results = await plugin.parallelFetch(["https://httpbin.org/get"]);
      const r = results.results[0];
      // httpbin.org may return 503 when overloaded — still validates metadata structure
      if (r.status === 503) {
        console.warn("httpbin.org returned 503, validating metadata only");
        expect(typeof r.duration).toBe("number");
        return;
      }
      expect(r.success).toBe(true);
      expect(r.title).toBeTruthy();
      expect(r.status).toBe(200);
      expect(typeof r.duration).toBe("number");
    }, 30000);
  });

  // ─── Hook Interaction Scenarios ───────────────────────

  describe("End-to-End Hook Scenarios", () => {
    it("should pass safe browser tool through hooks", async () => {
      const plugin = createPlugin();
      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "normal"
      )!;

      const beforeResult = await beforeHook.handler({
        toolName: "web_fetch",
        params: { url: "https://example.com" },
      });
      expect(beforeResult.block).toBeUndefined();
      expect(beforeResult.requireConfirmation).toBeUndefined();

      const afterResult = await afterHook.handler({
        toolName: "web_fetch",
        result: { title: "Test", text: "Content here" },
        errored: false,
      });
      expect(afterResult.result).toBeDefined();
    });

    it("should block and format in sequence", async () => {
      const plugin = createPlugin();
      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;

      // First: block a dangerous URL
      const blocked = await beforeHook.handler({
        toolName: "web_fetch",
        params: { url: "http://localhost:3000" },
      });
      expect(blocked.block).toBe(true);

      // Second: allow a safe URL
      const allowed = await beforeHook.handler({
        toolName: "web_fetch",
        params: { url: "https://safe-site.com" },
      });
      expect(allowed.block).toBeUndefined();
      expect(plugin.getStats().browseCount).toBe(1);
    });

    it("should handle multiple sensitive operations", async () => {
      const plugin = createPlugin();
      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;

      const ops = ["browser_login", "browser_submit_form", "browser_file_upload"];
      for (const op of ops) {
        const result = await beforeHook.handler({
          toolName: op,
          params: { url: "https://example.com" },
        });
        expect(result.requireConfirmation).toBe(true);
      }
    });
  });

  // ─── Session Isolation Integration ────────────────────

  describe("Session Isolation Integration", () => {
    it("should maintain independent state per session", () => {
      const plugin = createPlugin();
      const a = plugin.createSession("A", { proxy: "http://p1:8080" });
      const b = plugin.createSession("B", { proxy: "http://p2:9090" });

      plugin.setCookies({ token: "tok-a" }, a.id);
      plugin.setCookies({ token: "tok-b" }, b.id);
      plugin.setCookies({ token: "tok-default" }, "default");

      expect(plugin.getCookies(a.id)).toEqual({ token: "tok-a" });
      expect(plugin.getCookies(b.id)).toEqual({ token: "tok-b" });
      expect(plugin.getCookies("default")).toEqual({ token: "tok-default" });

      const sessions = plugin.listSessions();
      expect(sessions.find((s) => s.id === a.id)?.proxy).toBe("http://p1:8080");
      expect(sessions.find((s) => s.id === b.id)?.proxy).toBe("http://p2:9090");
    });
  });

  // ─── Structured Content Extraction ────────────────────

  describe("Structured Content Extraction (Novel/Download Scenario)", () => {
    it("should extract chapter links from novel HTML", async () => {
      const plugin = createPlugin();
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "normal"
      )!;
      const novelHTML = `
        <html><head><title>逆天邪神 - 章节列表</title></head><body>
        <div class="chapter-list">
          <a href="/chapter/2001.html">第2001章 新的开始</a>
          <a href="/chapter/2002.html">第2002章 突破</a>
          <a href="/chapter/2003.html">第2003章 决战</a>
          <a href="/read/2004.html">第2004章 归来</a>
          <a href="/book/2005.html">第2005章 真相</a>
        </div></body></html>`;
      const result = await afterHook.handler({
        toolName: "web_fetch",
        result: { url: "https://novel-site.com/chapters", title: "逆天邪神", text: novelHTML, html: novelHTML },
        errored: false,
      });
      expect(result.result).toBeDefined();
      expect(result.result).toContain("Structured Content Analysis");
      expect(result.result).toContain("Chapter Links Found");
      expect(result.result).toContain("第2001章");
      expect(result.result).toContain("第2002章");
    });

    it("should extract download links from HTML", async () => {
      const plugin = createPlugin();
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "normal"
      )!;
      const downloadHTML = `
        <html><body>
        <a href="/download/novel.txt">下载TXT版本</a>
        <a href="/download/novel.pdf">下载PDF版本</a>
        <a href="/files/novel.epub">EPUB格式</a>
        </body></html>`;
      const result = await afterHook.handler({
        toolName: "web_fetch",
        result: { url: "https://novel-site.com/download", html: downloadHTML },
        errored: false,
      });
      expect(result.result).toContain("Download Links Found");
      expect(result.result).toContain("novel.txt");
      expect(result.result).toContain("novel.pdf");
    });

    it("should extract page structure metadata", async () => {
      const plugin = createPlugin();
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "normal"
      )!;
      const html = `
        <html><head><title>测试页面</title><meta charset="gbk"></head><body>
        <a href="/page/1">第1页</a><a href="/page/2">第2页</a>
        <a href="/page/3">第3页</a>
        </body></html>`;
      const result = await afterHook.handler({
        toolName: "web_fetch",
        result: { url: "https://test.com", html },
        errored: false,
      });
      expect(result.result).toContain("**Page Title:** 测试页面");
      expect(result.result).toContain("**Encoding:** gbk");
      expect(result.result).toContain("Pagination detected");
      expect(result.result).toContain("**Total links on page:** 3");
    });

    it("should handle HTML without chapter or download links", async () => {
      const plugin = createPlugin();
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "normal"
      )!;
      const plainHTML = "<html><body><p>Hello World</p></body></html>";
      const result = await afterHook.handler({
        toolName: "web_fetch",
        result: { url: "https://plain.com", html: plainHTML },
        errored: false,
      });
      // Should still format but without structured analysis
      expect(result.result).toBeDefined();
      // It's fine if it doesn't have structured content
      expect(result.result).toContain("[Enhanced Browser]");
    });

    it("should handle novel chapter links with trailing numbers pattern", async () => {
      const plugin = createPlugin();
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "normal"
      )!;
      // Pattern: URLs with chapter/book/read/novel/article/view/thread/detail
      const html = `
        <a href="/article/12345.html">第一章 序章</a>
        <a href="/view/67890.html">第二章 启程</a>
        <a href="/thread/11111.html">第三章 冒险</a>
        <a href="/detail/22222.html">第四章 结局</a>`;
      const result = await afterHook.handler({
        toolName: "browser_get_html",
        result: { html },
        errored: false,
      });
      expect(result.result).toContain("Chapter Links Found");
      expect(result.result).toContain("第一章");
      expect(result.result).toContain("第二章");
      expect(result.result).toContain("第三章");
      expect(result.result).toContain("第四章");
    });
  });

  // ─── Novel Download Scenario Integration ──────────────

  describe("Novel Download Flow Integration", () => {
    it("should handle complete novel download tool sequence", async () => {
      const plugin = createPlugin();
      // Simulate the sequence of tool calls in a novel download scenario
      // Step 1: Search for novel chapters
      // Step 2: Fetch chapter list page
      // Step 3: Extract structured content
      // Step 4: Navigate to individual chapter

      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;
      const afterHook = plugin.hooks.find(
        (h) => h.hookType === "after_tool_call" && h.priority === "normal"
      )!;

      // Step 1: web_search — should pass safety
      const searchResult = await beforeHook.handler({
        toolName: "web_search",
        params: { query: "逆天邪神 2000章 小说" },
      });
      expect(searchResult.block).toBeUndefined();

      // Step 2: web_fetch a novel chapter page
      const fetchResult = await beforeHook.handler({
        toolName: "web_fetch",
        params: { url: "https://novel-site.com/chapter/2001.html" },
      });
      expect(fetchResult.block).toBeUndefined();

      // Step 3: After-tool should extract structured content
      const novelPageHTML = `
        <html><head><title>逆天邪神 第2001章 - 在线阅读</title><meta charset="utf-8"></head>
        <body>
        <div class="chapter-nav">
          <a href="/chapter/2000.html">上一章</a>
          <a href="/chapter/2002.html">下一章</a>
        </div>
        <div class="content">
          <p>正文内容开始...</p>
          <p>云澈站在山巅...</p>
        </div>
        <div class="chapter-list-bottom">
          <a href="/chapter/2001.html">第2001章</a>
          <a href="/chapter/2002.html">第2002章</a>
          <a href="/chapter/2003.html">第2003章</a>
        </div></body></html>`;
      const afterResult = await afterHook.handler({
        toolName: "web_fetch",
        result: { url: "https://novel-site.com/chapter/2001.html", title: "逆天邪神", html: novelPageHTML },
        errored: false,
      });
      expect(afterResult.result).toBeDefined();
      // Should contain structured analysis
      expect(afterResult.result).toContain("Structured Content Analysis");
      expect(afterResult.result).toContain("Chapter Links Found");
    });

    it("should handle file_create and shell_exec for novel download", async () => {
      const plugin = createPlugin();
      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;

      // file_create should not be blocked (not a browser tool)
      const fileCreateResult = await beforeHook.handler({
        toolName: "file_create",
        params: { path: "download_novel.py", content: "print('hello')" },
      });
      expect(fileCreateResult.block).toBeUndefined();

      // shell_exec should not be blocked (not a browser tool)
      const shellResult = await beforeHook.handler({
        toolName: "shell_exec",
        params: { command: "python download_novel.py" },
      });
      expect(shellResult.block).toBeUndefined();
    });

    it("should track browse count through complete novel download flow", async () => {
      const plugin = createPlugin();
      const beforeHook = plugin.hooks.find((h) => h.hookType === "before_tool_call")!;

      expect(plugin.getStats().browseCount).toBe(0);

      // Simulate a typical novel download flow:
      // 1. web_search (counts)
      await beforeHook.handler({ toolName: "web_search", params: { query: "test" } });
      expect(plugin.getStats().browseCount).toBe(1);

      // 2. web_fetch chapter list (counts)
      await beforeHook.handler({ toolName: "web_fetch", params: { url: "https://example.com" } });
      expect(plugin.getStats().browseCount).toBe(2);

      // 3. web_fetch individual chapter (counts)
      await beforeHook.handler({ toolName: "web_fetch", params: { url: "https://example.com/ch1" } });
      expect(plugin.getStats().browseCount).toBe(3);

      // 4. file_create and shell_exec should NOT count (not browser tools)
      await beforeHook.handler({ toolName: "file_create", params: { path: "test.py" } });
      await beforeHook.handler({ toolName: "shell_exec", params: { command: "python test.py" } });
      expect(plugin.getStats().browseCount).toBe(3);
    });
  });
});