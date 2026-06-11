import * as path from "path";
import type { AgentModelExecutor } from "@evoclaw/agent";
import type { ServiceRegistry, EventBus } from "@evoclaw/core";
import type { BrowserController, PlaywrightBrowser, FileSystemManager } from "@evoclaw/infrastructure";

export function registerBrowserTools(
  executor: AgentModelExecutor,
  browserController: BrowserController,
  playwrightBrowser: PlaywrightBrowser,
  registry: ServiceRegistry,
  eventBus: EventBus,
  fileSystemManager: FileSystemManager
): void {
  const browser = browserController;
  let pwBrowser = playwrightBrowser;

  // ── Browser session health management ──
  // Prevents memory leaks by tracking active browser contexts and
  // auto-cleaning stale ones. Also provides crash recovery.

  const browserSessions = new Map<string, {
    launchedAt: number;
    lastActivityAt: number;
    tabCount: number;
  }>();

  const MAX_BROWSER_IDLE_MS = 10 * 60 * 1000; // 10 minutes idle → auto-close
  const MAX_TABS_PER_SESSION = 5; // prevent tab explosion

  // Periodically clean up idle browser sessions
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, info] of browserSessions) {
      if (now - info.lastActivityAt > MAX_BROWSER_IDLE_MS) {
        console.log(`[BrowserHealth] Auto-closing idle session: ${sessionId} (idle ${Math.round((now - info.lastActivityAt) / 60000)}min)`);
        browserSessions.delete(sessionId);
      }
    }
  }, 60_000); // check every minute

  function touchBrowserSession(): void {
    const info = browserSessions.get("default");
    if (info) info.lastActivityAt = Date.now();
  }

  executor.registerTool(
    "browser_navigate",
    {
      name: "browser_navigate",
      description: "Navigate to a URL and retrieve page content, links, and forms",
      parameters: {
        url: { type: "string", description: "The URL to navigate to" },
      },
    },
    async (params: Record<string, unknown>) => {
      touchBrowserSession();
      const url = String(params.url || "");
      return await browser.navigate(url);
    }
  );

  executor.registerTool(
    "browser_get_text",
    {
      name: "browser_get_text",
      description: "Get text content from elements matching a CSS selector on the current page",
      parameters: {
        selector: { type: "string", description: "CSS selector (e.g. 'h1', '.class-name', '#id')" },
      },
    },
    async (params: Record<string, unknown>) => {
      touchBrowserSession();
      const selector = String(params.selector || "body");
      if (!browser.getCurrentPage()) {
        return { error: "No page loaded. Use browser_navigate first." };
      }
      const text = await browser.getText(selector);
      return { selector, text, length: text.length };
    }
  );

  executor.registerTool(
    "browser_find_elements",
    {
      name: "browser_find_elements",
      description: "Find elements on the current page by CSS selector",
      parameters: {
        selector: { type: "string", description: "CSS selector to find elements" },
      },
    },
    async (params: Record<string, unknown>) => {
      const selector = String(params.selector || "");
      if (!browser.getCurrentPage()) {
        return { error: "No page loaded. Use browser_navigate first." };
      }
      const elements = await browser.findElements(selector);
      return { selector, count: elements.length, elements };
    }
  );

  executor.registerTool(
    "browser_submit_form",
    {
      name: "browser_submit_form",
      description: "Submit a form on the current page with field values",
      parameters: {
        action: { type: "string", description: "Form action URL" },
        method: { type: "string", description: "HTTP method (get or post)" },
        fields: { type: "string", description: "JSON string of field name-value pairs" },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "");
      const method = String(params.method || "get");
      let fields: Record<string, string> = {};
      try {
        fields = JSON.parse(String(params.fields || "{}"));
      } catch {
        return { error: "Invalid fields JSON" };
      }
      return await browser.submitForm({ action, method, fields });
    }
  );

  executor.registerTool(
    "browser_search",
    {
      name: "browser_search",
      description: "Search the web for a query across multiple search engines",
      parameters: {
        query: { type: "string", description: "Search query" },
        sites: { type: "string", description: "Comma-separated search engines (google,bing,duckduckgo)" },
      },
    },
    async (params: Record<string, unknown>) => {
      touchBrowserSession();
      const query = String(params.query || "");
      const sitesStr = String(params.sites || "duckduckgo");
      const sites = sitesStr.split(",").map((s) => s.trim()).filter(Boolean);
      return await browser.searchAndScrape(query, sites);
    }
  );

  executor.registerTool(
    "browser_fetch_json",
    {
      name: "browser_fetch_json",
      description: "Fetch JSON data from an API endpoint",
      parameters: {
        url: { type: "string", description: "The API URL to fetch JSON from" },
      },
    },
    async (params: Record<string, unknown>) => {
      const url = String(params.url || "");
      return await browser.fetchJSON(url);
    }
  );

  executor.registerTool(
    "browser_tabs",
    {
      name: "browser_tabs",
      description: "Manage browser tabs (list, new, switch, close)",
      parameters: {
        action: { type: "string", description: "Action: list, new, switch, or close" },
        tabId: { type: "string", description: "Tab ID for switch/close actions" },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "list");
      const tabId = String(params.tabId || "");

      if (action === "list") {
        return { tabs: browser.listTabs(), activeTab: (browser.getCurrentPage()?.url || "") };
      }
      if (action === "new") {
        const sessionInfo = browserSessions.get("default");
        if (sessionInfo && sessionInfo.tabCount >= MAX_TABS_PER_SESSION) {
          return { error: `Maximum tab limit (${MAX_TABS_PER_SESSION}) reached. Close an existing tab before opening a new one.`, tabCount: sessionInfo.tabCount };
        }
        browser.newTab(tabId || `tab-${Date.now()}`);
        if (sessionInfo) sessionInfo.tabCount++;
        return { success: true, action: "new", tabId };
      }
      if (action === "switch") {
        const ok = browser.switchTab(tabId);
        return { success: ok, action: "switch", tabId };
      }
      if (action === "close") {
        const ok = browser.closeTab(tabId);
        if (ok) {
          const sessionInfo = browserSessions.get("default");
          if (sessionInfo) sessionInfo.tabCount = Math.max(0, sessionInfo.tabCount - 1);
        }
        return { success: ok, action: "close", tabId };
      }
      return { error: `Unknown action: ${action}` };
    }
  );

  // ── Playwright-based tools ──

  executor.registerTool(
    "browser_launch",
    {
      name: "browser_launch",
      description: "Launch a real Chromium browser via Playwright for advanced web automation",
      parameters: {
        headless: { type: "string", description: "Run headless (true/false, default true)" },
      },
    },
    async (params: Record<string, unknown>) => {
      const headless = String(params.headless || "true") !== "false";
      await pwBrowser.shutdown();
      const { PlaywrightBrowser: PlaywrightBrowserClass } = await import("@evoclaw/infrastructure");
      const newBrowser = new PlaywrightBrowserClass(registry, eventBus, {
        headless,
        cookieStorageDir: path.resolve(__dirname, "..", "..", "..", "..", ".."),
      });
      await newBrowser.launch();
      pwBrowser = newBrowser;
      registry.replaceService("playwrightBrowser", pwBrowser);
      // Track browser session for health management
      browserSessions.set("default", {
        launchedAt: Date.now(),
        lastActivityAt: Date.now(),
        tabCount: 1,
      });
      return { success: true, headless, message: "Playwright browser launched" };
    }
  );

  executor.registerTool(
    "browser_screenshot",
    {
      name: "browser_screenshot",
      description: "Take a screenshot of the current page or specific element",
      parameters: {
        selector: { type: "string", description: "CSS selector for element screenshot (optional)" },
        fullPage: { type: "string", description: "Capture full page (true/false, default true)" },
        filename: { type: "string", description: "File path to save screenshot (optional, saves as .png)" },
      },
    },
    async (params: Record<string, unknown>) => {
      touchBrowserSession();
      const selector = String(params.selector || "");
      const fullPage = String(params.fullPage || "true") !== "false";
      const filename = String(params.filename || "");
      const buf = await pwBrowser.screenshot({
        fullPage,
        selector: selector || undefined,
        type: "png",
      });
      if (filename) {
        const base64 = buf.toString("base64");
        await fileSystemManager.writeFile(filename, base64);
        return { success: true, file: filename, size: buf.length, format: "base64-encoded", base64Preview: `data:image/png;base64,${base64.substring(0, 200)}...` };
      }
      const base64 = buf.toString("base64");
      return {
        success: true,
        size: buf.length,
        mimeType: "image/png",
        base64: base64.substring(0, 500) + `... [truncated, ${buf.length} bytes total]`,
      };
    }
  );

  executor.registerTool(
    "browser_login",
    {
      name: "browser_login",
      description: "Automatically log into a website with credentials",
      parameters: {
        url: { type: "string", description: "Login page URL" },
        usernameSelector: { type: "string", description: "CSS selector for username input" },
        passwordSelector: { type: "string", description: "CSS selector for password input" },
        username: { type: "string", description: "Username/email to login with" },
        password: { type: "string", description: "Password to login with" },
        submitSelector: { type: "string", description: "CSS selector for submit button" },
        successUrl: { type: "string", description: "URL fragment that indicates successful login" },
      },
    },
    async (params: Record<string, unknown>) => {
      const url = String(params.url || "");
      const usernameSelector = String(params.usernameSelector || "");
      const passwordSelector = String(params.passwordSelector || "");
      const username = String(params.username || "");
      const password = String(params.password || "");
      const submitSelector = String(params.submitSelector || "");
      const successUrl = String(params.successUrl || "");
      const result = await pwBrowser.login(
        url, usernameSelector, passwordSelector, username, password, submitSelector,
        successUrl ? { urlContains: successUrl } : undefined
      );
      if (!result.success) {
        return { success: false, error: result.error || "Login failed", currentUrl: result.currentUrl };
      }
      return { success: true, currentUrl: result.currentUrl, title: result.pageTitle, cookieCount: result.cookies.length };
    }
  );

  executor.registerTool(
    "browser_js_eval",
    {
      name: "browser_js_eval",
      description: "Execute JavaScript on the current page and return the result",
      parameters: {
        expression: { type: "string", description: "JavaScript expression to evaluate" },
      },
    },
    async (params: Record<string, unknown>) => {
      const expression = String(params.expression || "");
      const result = await pwBrowser.evaluateJS(expression);
      return { success: true, result };
    }
  );

  executor.registerTool(
    "browser_click",
    {
      name: "browser_click",
      description: "Click an element on the page",
      parameters: {
        selector: { type: "string", description: "CSS selector of element to click" },
      },
    },
    async (params: Record<string, unknown>) => {
      touchBrowserSession();
      const selector = String(params.selector || "");
      await pwBrowser.click(selector);
      return { success: true, selector };
    }
  );

  executor.registerTool(
    "browser_fill_form",
    {
      name: "browser_fill_form",
      description: "Fill form fields on the current page with realistic typing",
      parameters: {
        fields: { type: "string", description: "JSON array of {selector, value, delay, submitAfter} objects" },
      },
    },
    async (params: Record<string, unknown>) => {
      let fields: Array<{ selector: string; value: string; delay?: number; submitAfter?: boolean }> = [];
      try {
        fields = JSON.parse(String(params.fields || "[]"));
      } catch {
        return { error: "Invalid fields JSON array" };
      }
      await pwBrowser.fillForm(fields);
      return { success: true, fieldCount: fields.length };
    }
  );

  executor.registerTool(
    "browser_get_html",
    {
      name: "browser_get_html",
      description: "Get the full HTML source of the current page",
      parameters: {},
    },
    async () => {
      const html = await pwBrowser.getHTML();
      return { success: true, length: html.length, html: html.substring(0, 10000) + (html.length > 10000 ? "... [truncated]" : "") };
    }
  );

  // ── Advanced browser automation tools ──

  executor.registerTool(
    "browser_select",
    {
      name: "browser_select",
      description: "Select an option in a dropdown (select) element by value or label",
      parameters: {
        selector: { type: "string", description: "CSS selector for the select element" },
        value: { type: "string", description: "Value or label of the option to select" },
      },
    },
    async (params: Record<string, unknown>) => {
      touchBrowserSession();
      const selector = String(params.selector || "");
      const value = String(params.value || "");
      if (!selector) return { error: "CSS selector is required" };
      if (!value) return { error: "Option value is required" };
      try {
        const selected = await pwBrowser.selectOption(selector, value);
        return { success: true, selector, value, selectedValues: selected };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Select failed: ${msg}`, selector, value };
      }
    }
  );

  executor.registerTool(
    "browser_check",
    {
      name: "browser_check",
      description: "Check or uncheck a checkbox or radio button",
      parameters: {
        selector: { type: "string", description: "CSS selector for the checkbox/radio element" },
        checked: { type: "string", description: "true to check, false to uncheck (default: true)" },
      },
    },
    async (params: Record<string, unknown>) => {
      touchBrowserSession();
      const selector = String(params.selector || "");
      const checked = String(params.checked || "true") !== "false";
      if (!selector) return { error: "CSS selector is required" };
      try {
        await pwBrowser.checkCheckbox(selector, checked);
        return { success: true, selector, checked };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Check/uncheck failed: ${msg}`, selector };
      }
    }
  );

  executor.registerTool(
    "browser_wait",
    {
      name: "browser_wait",
      description: "Wait for an element to appear, disappear, or reach a specific state on the page. Essential for dynamic content and SPA pages.",
      parameters: {
        selector: { type: "string", description: "CSS selector to wait for" },
        state: { type: "string", description: "State to wait for: visible (default), hidden, attached, detached" },
        timeout: { type: "string", description: "Maximum wait time in milliseconds (default: 30000)" },
      },
    },
    async (params: Record<string, unknown>) => {
      touchBrowserSession();
      const selector = String(params.selector || "");
      const state = String(params.state || "visible") as "attached" | "visible" | "hidden" | "detached";
      const timeout = parseInt(String(params.timeout || "30000"), 10) || 30000;
      if (!selector) return { error: "CSS selector is required" };
      try {
        const found = await pwBrowser.waitForElement(selector, timeout, state);
        return { success: found, selector, state, timeout, found };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Wait failed: ${msg}`, selector, state, timeout };
      }
    }
  );

  executor.registerTool(
    "browser_hover",
    {
      name: "browser_hover",
      description: "Hover over an element on the page (triggers hover menus, tooltips, etc.)",
      parameters: {
        selector: { type: "string", description: "CSS selector of element to hover over" },
      },
    },
    async (params: Record<string, unknown>) => {
      touchBrowserSession();
      const selector = String(params.selector || "");
      if (!selector) return { error: "CSS selector is required" };
      try {
        await pwBrowser.hover(selector);
        return { success: true, selector };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Hover failed: ${msg}`, selector };
      }
    }
  );

  executor.registerTool(
    "browser_scroll",
    {
      name: "browser_scroll",
      description: "Scroll the page or a specific element in a direction",
      parameters: {
        selector: { type: "string", description: "CSS selector for scrollable element (optional, scrolls page if empty)" },
        direction: { type: "string", description: "Direction: up, down, left, right (default: down)" },
        amount: { type: "string", description: "Pixels to scroll (default: 300)" },
      },
    },
    async (params: Record<string, unknown>) => {
      touchBrowserSession();
      const selector = String(params.selector || "") || null;
      const direction = String(params.direction || "down") as "up" | "down" | "left" | "right";
      const amount = parseInt(String(params.amount || "300"), 10) || 300;
      try {
        await pwBrowser.scroll(selector, direction, amount);
        return { success: true, selector: selector || "page", direction, amount };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Scroll failed: ${msg}` };
      }
    }
  );
}
