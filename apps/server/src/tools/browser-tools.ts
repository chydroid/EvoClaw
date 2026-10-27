import * as path from "path";
import * as fs from "fs";
import type { AgentModelExecutor } from "@evoclaw/agent";
import type { ServiceRegistry, EventBus } from "@evoclaw/core";
import type { BrowserController, PlaywrightBrowser, FileSystemManager } from "@evoclaw/infrastructure";

/** Validate that a resolved path stays within the allowed base directory.
 *  Prevents path traversal attacks (e.g. `../../etc/passwd`).
 *
 *  Bug 9 修复：原实现仅做词法检查，不解析符号链接。改为词法检查通过后
 *  再用 fs.realpathSync 解析符号链接，防止 workspace 内 symlink 指向外部目录。 */
function validatePathWithinBase(resolvedPath: string, baseDir: string): string | null {
  const normalizedBase = path.resolve(baseDir);
  const normalizedTarget = path.resolve(resolvedPath);

  // 先做词法检查：若词法上已超出 base，直接拒绝（避免 realpath 浪费 IO）
  if (!normalizedTarget.startsWith(normalizedBase + path.sep) && normalizedTarget !== normalizedBase) {
    return `Path traversal blocked: "${resolvedPath}" is outside the allowed workspace "${normalizedBase}". Use relative paths within the workspace only.`;
  }

  // 词法检查通过后，再用 realpath 解析符号链接，防止 workspace 内 symlink 指向外部目录
  try {
    let realTarget: string;
    if (fs.existsSync(normalizedTarget)) {
      realTarget = fs.realpathSync(normalizedTarget);
    } else {
      // 路径不存在（如 file_create）：realpath 父目录后拼接 basename
      const parentDir = path.dirname(normalizedTarget);
      if (fs.existsSync(parentDir)) {
        const realParent = fs.realpathSync(parentDir);
        realTarget = path.join(realParent, path.basename(normalizedTarget));
      } else {
        // 父目录也不存在：信任词法检查结果
        return null;
      }
    }
    // 对 realpath 结果再做一次词法检查
    if (!realTarget.startsWith(normalizedBase + path.sep) && realTarget !== normalizedBase) {
      return `Path traversal blocked (symlink escape): "${resolvedPath}" resolves to "${realTarget}" which is outside the allowed workspace "${normalizedBase}".`;
    }
  } catch {
    // realpath 失败（权限/IO 错误）：保守拒绝，避免误放行
    return `Path validation failed (realpath error): "${resolvedPath}".`;
  }
  return null;
}

/** fetchJSON 的模块级纯函数版本 —— 从 BrowserController.fetchJSON 逐字抽出，
 *  供 web-tools 的 web_fetch(action=json) 复用（BrowserController 只能从
 *  browser-tools 的注册闭包里取到）。
 *
 *  与 BrowserController.fetchJSON 的唯一行为差异：deps.getCookieHeader 未提供时
 *  退化为不带浏览器 cookie 的匿名请求。 */
export async function fetchJsonFromUrl(
  url: string,
  deps: {
    checkUrl: (url: string) => Promise<{ allowed: boolean; reason?: string }>;
    getCookieHeader?: () => string;
    userAgent?: string;
  }
): Promise<unknown> {
  try {
    const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;
    // 安全：SSRF 校验，防止 JSON 请求到内网/元数据端点
    const ssrfCheck = await deps.checkUrl(normalizedUrl);
    if (!ssrfCheck.allowed) {
      return { error: `Blocked by SSRF protection: ${ssrfCheck.reason}`, url: normalizedUrl };
    }
    const headers: Record<string, string> = {
      "User-Agent": deps.userAgent ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 EvoClaw/1.0",
      "Accept": "application/json",
    };
    const cookieHeader = deps.getCookieHeader?.() || "";
    if (cookieHeader) headers["Cookie"] = cookieHeader;

    const response = await fetch(normalizedUrl, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });

    // 手动跟随重定向链（最多 5 跳），每跳都做 SSRF 检查
    // 与 navigate()/submitForm() 一致，防止重定向到内网/元数据端点
    let finalResponse = response;
    let currentUrl = normalizedUrl;
    let redirectCount = 0;
    while ([301, 302, 303, 307, 308].includes(finalResponse.status) && redirectCount < 5) {
      const location = finalResponse.headers.get("location");
      if (!location) break;
      const redirectUrl = new URL(location, currentUrl).toString();
      const redirectSsrf = await deps.checkUrl(redirectUrl);
      if (!redirectSsrf.allowed) {
        return { error: `Blocked by SSRF protection on redirect: ${redirectSsrf.reason}`, url: redirectUrl };
      }
      currentUrl = redirectUrl;
      finalResponse = await fetch(redirectUrl, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      redirectCount++;
    }

    if (!finalResponse.ok) {
      return { error: `HTTP ${finalResponse.status}`, url: currentUrl };
    }
    return await finalResponse.json();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerBrowserTools(
  executor: AgentModelExecutor,
  browserController: BrowserController,
  playwrightBrowser: PlaywrightBrowser,
  registry: ServiceRegistry,
  eventBus: EventBus,
  fileSystemManager: FileSystemManager
): () => void {
  const browser = browserController;
  let pwBrowser = playwrightBrowser;

  // ── 统一审批闸门 ──
  // permission-manager 已为 browser_navigate / browser_submit_form 配置了
  // requireExplicitConsent:true，但此前没有任何 handler 调用 requestPermission，
  // 导致配置形同虚设、真实表单提交可在无审批下执行。此处补上，
  // 返回 requiresPermission 后由 llm-caller 转成 pendingPermissions，
  // 用户批准后 approveAndExecute 会重新执行本 handler。
  const requestApproval = async (
    operation: string,
    target: string,
    details: Record<string, unknown>
  ): Promise<{ blocked: true; result: Record<string, unknown> } | null> => {
    try {
      const permMgr = registry?.resolveService<{
        requestPermission(op: string, t: string, d: Record<string, unknown>, by?: string): { id: string; status: string };
      }>("permissionManager");
      // 权限服务不可用时不阻断浏览器只读操作，交由 HITL 层（human-approval）兜底
      if (!permMgr) return null;
      const perm = permMgr.requestPermission(operation, target, details, "tool");
      if (perm.status === "denied") {
        return { blocked: true, result: { success: false, error: `Permission denied: ${operation}`, target } };
      }
      if (perm.status === "pending") {
        return {
          blocked: true,
          result: {
            success: false,
            requiresPermission: true,
            requestId: perm.id,
            operation,
            description: details.description as string,
            target: target.slice(0, 200),
            error: `Awaiting approval: ${operation}`,
          },
        };
      }
      return null;
    } catch (err) {
      // 审批服务异常时保守放行给 HITL 层，不阻断主流程
      console.warn(`[browser-tools] approval check failed for ${operation}:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  };

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
  const browserHealthInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, info] of browserSessions) {
      if (now - info.lastActivityAt > MAX_BROWSER_IDLE_MS) {
        console.log(`[BrowserHealth] Auto-closing idle session: ${sessionId} (idle ${Math.round((now - info.lastActivityAt) / 60000)}min)`);
        browserSessions.delete(sessionId);
      }
    }
  }, 60_000); // check every minute
  browserHealthInterval.unref();

  function touchBrowserSession(): void {
    const info = browserSessions.get("default");
    if (info) info.lastActivityAt = Date.now();
  }

  // SSRF 校验：对浏览器工具访问的 URL 做安全检查。
  // 安全：服务未注册时 fail-closed（拒绝请求），防止内网地址绕过。
  async function validateUrlSsrf(url: string): Promise<{ ok: boolean; error?: string }> {
    const ssrfProtection = registry.resolveService<import("@evoclaw/security").SSRFProtection>("ssrfProtection");
    if (!ssrfProtection) {
      return { ok: false, error: "SSRF protection service unavailable" };
    }
    const result = await ssrfProtection.checkURL(url);
    if (!result.allowed) {
      return { ok: false, error: `URL blocked by security policy: ${result.reason}` };
    }
    return { ok: true };
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
      const ssrfCheck = await validateUrlSsrf(url);
      if (!ssrfCheck.ok) {
        return { success: false, error: ssrfCheck.error, url };
      }
      const gate = await requestApproval("browser_navigate", url, { description: "访问网页URL" });
      if (gate) return gate.result;
      const navResult = await browser.navigate(url);
      // 回归（2026-10-15 browser-eval）：只读类工具走 BrowserController（HTTP 抓取），
      // 而 browser_js_eval/click/fill_form 走 PlaywrightBrowser。两者状态独立，
      // 模型「navigate 后 js_eval」会得到 Playwright 侧的 "No active page"。
      // 这里把只读导航也镜像到 Playwright 活动标签（首次调用会懒启动浏览器；
      // 启动/镜像失败不阻断只读结果返回）。
      if (navResult.success && pwBrowser) {
        try {
          await pwBrowser.navigate(url);
        } catch (err) {
          console.warn(`[browser-tools] mirror navigate to playwright failed:`, err instanceof Error ? err.message : String(err));
        }
      }
      // rawHtml 仅供内部 findElements/getText 匹配，不进工具结果（避免 200KB 灌进 LLM 上下文）
      const { rawHtml: _raw, ...publicResult } = navResult;
      return publicResult;
    }
  );

  // ── browser_get：复合只读取数工具（action 判别）──
  // 合并自原 browser_get_text / browser_get_html / browser_find_elements：
  // 一个工具 + action 字段，保持 schema 紧凑、降低每轮 token 成本。

  /** 原 browser_get_text */
  const handleBrowserGetText = async (params: Record<string, unknown>) => {
    touchBrowserSession();
    const selector = String(params.selector || "body");
    if (!browser.getCurrentPage()) {
      return { success: false, error: "No page loaded. Use browser_navigate first." };
    }
    const text = await browser.getText(selector);
    return { selector, text, length: text.length };
  };

  /** 原 browser_get_html */
  const handleBrowserGetHtml = async () => {
    const html = await pwBrowser.getHTML();
    return { success: true, length: html.length, html: html.substring(0, 10000) + (html.length > 10000 ? "... [truncated]" : "") };
  };

  /** 原 browser_find_elements */
  const handleBrowserFindElements = async (params: Record<string, unknown>) => {
    touchBrowserSession();
    const selector = String(params.selector || "");
    if (!browser.getCurrentPage()) {
      return { success: false, error: "No page loaded. Use browser_navigate first." };
    }
    const elements = await browser.findElements(selector);
    return { selector, count: elements.length, elements };
  };

  executor.registerTool(
    "browser_get",
    {
      name: "browser_get",
      description:
        "复合浏览器取数工具（composite browser read tool），通过 action 参数选择具体操作。" +
        "actions: " +
        "text（默认，按 CSS 选择器取匹配元素的文本内容） / " +
        "html（取当前页完整 HTML 源码，超 10000 字符截断） / " +
        "elements（按 CSS 选择器查找元素，返回数量与元素列表）。",
      parameters: {
        action: {
          type: "string",
          description: "取数操作类型：text（默认）/ html / elements",
          required: true,
          enum: ["text", "html", "elements"],
        },
        selector: { type: "string", description: "CSS 选择器（text / elements 使用；text 缺省为 'body'）" },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "text");
      if (action === "text") return await handleBrowserGetText(params);
      if (action === "html") return await handleBrowserGetHtml();
      if (action === "elements") return await handleBrowserFindElements(params);
      return { success: false, error: `未知 browser_get action: ${action}（仅支持 text / html / elements）` };
    }
  );

  // ── browser_tabs: 管理浏览器标签页（list / new / switch / close） ──
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
      touchBrowserSession();
      const action = String(params.action || "list");
      const tabId = String(params.tabId || "");

      // 标签管理统一走 PlaywrightBrowser（真实标签页）：
      // browser_navigate 的镜像导航让只读浏览也活在 Playwright 侧，
      // 若此处仍列 BrowserController 的旧 tabs，会漏掉后续导航（评测 b05：
      // navigate quotes → navigate example，list 只返回 1 个旧 tab）。
      if (action === "list") {
        try {
          const tabs = (await pwBrowser.listTabs()).map((t) => ({ ...t, title: t.title || t.url }));
          return { tabs, activeTab: tabs.find((t) => t.active)?.url || "" };
        } catch {
          // 浏览器未启动：退回只读控制器记录（兼容旧会话）
          return { tabs: browser.listTabs(), activeTab: (browser.getCurrentPage()?.url || "") };
        }
      }
      if (action === "new") {
        const sessionInfo = browserSessions.get("default");
        if (sessionInfo && sessionInfo.tabCount >= MAX_TABS_PER_SESSION) {
          return { success: false, error: `Maximum tab limit (${MAX_TABS_PER_SESSION}) reached. Close an existing tab before opening a new one.`, tabCount: sessionInfo.tabCount };
        }
        const newTabId = await pwBrowser.newTab(tabId || undefined);
        if (sessionInfo) sessionInfo.tabCount++;
        return { success: true, action: "new", tabId: newTabId };
      }
      if (action === "switch") {
        if (!tabId) return { success: false, error: "tabId is required for switch" };
        await pwBrowser.switchTab(tabId);
        return { success: true, action: "switch", tabId };
      }
      if (action === "close") {
        if (!tabId) return { success: false, error: "tabId is required for close" };
        await pwBrowser.closeTab(tabId);
        const sessionInfo = browserSessions.get("default");
        if (sessionInfo) sessionInfo.tabCount = Math.max(0, sessionInfo.tabCount - 1);
        return { success: true, action: "close", tabId };
      }
      return { success: false, error: `Unknown action: ${action}` };
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
      const oldBrowser = pwBrowser;
      try {
        await oldBrowser.shutdown();
      } catch { /* old browser may already be closed */ }
      try {
        const { PlaywrightBrowser: PlaywrightBrowserClass } = await import("@evoclaw/infrastructure");
        const newBrowser = new PlaywrightBrowserClass(registry, eventBus, {
          headless,
          cookieStorageDir: path.resolve(__dirname, "..", "..", "..", ".."),
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
      } catch (err) {
        // Try to restore old browser
        try { await oldBrowser.launch(); pwBrowser = oldBrowser; registry.replaceService("playwrightBrowser", oldBrowser); } catch { /* give up recovery */ }
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
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
        const fs = await import("node:fs");
        const workspaceDir = path.resolve(__dirname, "..", "..", "..", "..", "data", "workspace");
        const resolved = path.resolve(workspaceDir, filename);
        const pathError = validatePathWithinBase(resolved, workspaceDir);
        if (pathError) return { success: false, error: pathError };
        await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
        // 安全：原子写入（temp + rename），避免截断的截图文件
        const tmpPath = `${resolved}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmpPath, buf);
        await fs.promises.rename(tmpPath, resolved);
        return { success: true, file: filename, size: buf.length, format: "png" };
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
      const ssrfCheck = await validateUrlSsrf(url);
      if (!ssrfCheck.ok) {
        return { success: false, error: ssrfCheck.error, url };
      }
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

  // ── Advanced browser automation tools ──

  // ── browser_act：复合页面操作工具（action 判别）──
  // 合并自原 browser_click / browser_click_by_index / browser_hover / browser_check /
  // browser_select / browser_fill_form / browser_input_by_index / browser_submit_form：
  // 一个工具 + action 字段，保持 schema 紧凑、降低每轮 token 成本。
  // 兼容策略：click 未传 index 时走原 browser_click（CSS 选择器）；fill 未传 index
  // 时走原 browser_fill_form。带 index 时分别落到 clickByIndex / inputByIndex。

  /** 原 browser_click */
  const handleBrowserClick = async (params: Record<string, unknown>) => {
    touchBrowserSession();
    const selector = String(params.selector || "");
    await pwBrowser.click(selector);
    return { success: true, selector };
  };

  /** 原 browser_click_by_index */
  const handleBrowserClickByIndex = async (params: Record<string, unknown>) => {
    touchBrowserSession();
    const index = parseInt(String(params.index || ""), 10);
    if (Number.isNaN(index) || index < 0) {
      return { success: false, error: "Invalid index. Provide a non-negative integer." };
    }
    try {
      const result = await pwBrowser.clickByIndex(index);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `clickByIndex failed: ${msg}` };
    }
  };

  /** 原 browser_fill_form */
  const handleBrowserFillForm = async (params: Record<string, unknown>) => {
    let fields: Array<{ selector: string; value: string; delay?: number; submitAfter?: boolean }> = [];
    try {
      fields = JSON.parse(String(params.fields || "[]"));
    } catch {
      return { success: false, error: "Invalid fields JSON array" };
    }
    await pwBrowser.fillForm(fields);
    return { success: true, fieldCount: fields.length };
  };

  /** 原 browser_input_by_index */
  const handleBrowserInputByIndex = async (params: Record<string, unknown>) => {
    touchBrowserSession();
    const index = parseInt(String(params.index || ""), 10);
    if (Number.isNaN(index) || index < 0) {
      return { success: false, error: "Invalid index. Provide a non-negative integer." };
    }
    const text = String(params.text || "");
    const clearFirst = String(params.clear_first || "true").toLowerCase() !== "false";
    const delay = parseInt(String(params.delay || "0"), 10) || 0;
    try {
      const result = await pwBrowser.inputByIndex(index, text, { clearFirst, delay });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `inputByIndex failed: ${msg}` };
    }
  };

  /** 原 browser_hover */
  const handleBrowserHover = async (params: Record<string, unknown>) => {
    touchBrowserSession();
    const selector = String(params.selector || "");
    if (!selector) return { success: false, error: "CSS selector is required" };
    try {
      await pwBrowser.hover(selector);
      return { success: true, selector };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Hover failed: ${msg}`, selector };
    }
  };

  /** 原 browser_check */
  const handleBrowserCheck = async (params: Record<string, unknown>) => {
    touchBrowserSession();
    const selector = String(params.selector || "");
    const checked = String(params.checked || "true") !== "false";
    if (!selector) return { success: false, error: "CSS selector is required" };
    try {
      await pwBrowser.checkCheckbox(selector, checked);
      return { success: true, selector, checked };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Check/uncheck failed: ${msg}`, selector };
    }
  };

  /** 原 browser_select */
  const handleBrowserSelect = async (params: Record<string, unknown>) => {
    touchBrowserSession();
    const selector = String(params.selector || "");
    const value = String(params.value || "");
    if (!selector) return { success: false, error: "CSS selector is required" };
    if (!value) return { success: false, error: "Option value is required" };
    try {
      const selected = await pwBrowser.selectOption(selector, value);
      return { success: true, selector, value, selectedValues: selected };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Select failed: ${msg}`, selector, value };
    }
  };

  /** 原 browser_submit_form
   *  注意：原参数名为 action（表单 action URL），与复合工具的 action 判别字段冲突，
   *  故表单 URL 改由 formAction 传入；requestApproval 的 operation 名仍为
   *  browser_submit_form（permission-manager 的 requireExplicitConsent 依赖该名）。 */
  const handleBrowserSubmitForm = async (params: Record<string, unknown>) => {
    touchBrowserSession();
    const action = String(params.formAction || "");
    const method = String(params.method || "get");
    let fields: Record<string, string> = {};
    try {
      fields = JSON.parse(String(params.fields || "{}"));
    } catch {
      return { success: false, error: "Invalid fields JSON" };
    }
    if (action) {
      const ssrfCheck = await validateUrlSsrf(action);
      if (!ssrfCheck.ok) {
        return { success: false, error: ssrfCheck.error, action };
      }
    }
    // 表单提交会对外产生真实副作用（登录/下单/发帖等），必须显式审批
    const gate = await requestApproval("browser_submit_form", action || "(当前页)", {
      description: "提交网页表单",
      method,
      fieldNames: Object.keys(fields).slice(0, 20),
    });
    if (gate) return gate.result;
    return await browser.submitForm({ action, method, fields });
  };

  executor.registerTool(
    "browser_act",
    {
      name: "browser_act",
      description:
        "复合浏览器页面操作工具（composite browser action tool），通过 action 参数选择具体操作。" +
        "actions: " +
        "click（默认，点击元素；未传 index 时用 selector 点击，传 index 时按 browser_extract_dom 的索引点击） / " +
        "hover（悬停元素） / " +
        "check（勾选/取消勾选 checkbox 或 radio） / " +
        "select（在 select 下拉框中按 value 或 label 选择选项） / " +
        "fill（填写表单；未传 index 时用 fields 批量填写，传 index 时按索引输入文本） / " +
        "submit（提交表单，formAction 为表单 action URL，method 为 get/post，fields 为 JSON 字符串；会产生真实副作用，需显式审批）",
      parameters: {
        action: {
          type: "string",
          description: "页面操作类型：click（默认）/ hover / check / select / fill / submit",
          required: true,
          enum: ["click", "hover", "check", "select", "fill", "submit"],
        },
        selector: { type: "string", description: "CSS 选择器（click / hover / check / select / fill 使用）" },
        index: { type: "string", description: "元素索引（click / fill 使用；来自 browser_extract_dom 的 [index]）" },
        value: { type: "string", description: "选项值或标签（select 使用）" },
        checked: { type: "string", description: "true 勾选，false 取消（默认 true）（check 使用）" },
        fields: { type: "string", description: "JSON 字符串：fill 时为 [{selector,value,delay,submitAfter}] 数组；submit 时为 {name:value} 对象" },
        text: { type: "string", description: "要输入的文本（fill 且使用 index 时使用）" },
        clear_first: { type: "string", description: "输入前先清空字段（'true' 默认，'false' 跳过）（fill 且使用 index 时使用）" },
        delay: { type: "string", description: "按键间隔毫秒（fill 且使用 index 时使用）" },
        formAction: { type: "string", description: "表单 action URL（submit 使用；原参数名为 action，因与本字段冲突改名）" },
        method: { type: "string", description: "HTTP 方法 get 或 post（submit 使用）" },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "click");
      if (action === "click") {
        // 兼容原 browser_click：无 index 时走 CSS 选择器；有 index 时走索引点击
        if (params.index !== undefined && String(params.index) !== "") {
          return await handleBrowserClickByIndex(params);
        }
        return await handleBrowserClick(params);
      }
      if (action === "hover") return await handleBrowserHover(params);
      if (action === "check") return await handleBrowserCheck(params);
      if (action === "select") return await handleBrowserSelect(params);
      if (action === "fill") {
        // 兼容原 browser_fill_form：无 index 时走 fields 批量填写；有 index 时走索引输入
        if (params.index !== undefined && String(params.index) !== "") {
          return await handleBrowserInputByIndex(params);
        }
        return await handleBrowserFillForm(params);
      }
      if (action === "submit") return await handleBrowserSubmitForm(params);
      return { success: false, error: `未知 browser_act action: ${action}（仅支持 click / hover / check / select / fill / submit）` };
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
      const timeoutRaw = parseInt(String(params.timeout ?? "30000"), 10);
      const timeout = Number.isFinite(timeoutRaw) ? timeoutRaw : 30000;
      if (!selector) return { success: false, error: "CSS selector is required" };
      try {
        const found = await pwBrowser.waitForElement(selector, timeout, state);
        return { success: found, selector, state, timeout, found };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Wait failed: ${msg}`, selector, state, timeout };
      }
    }
  );

  // ── browser_scroll：复合滚动工具（action 判别）──
  // 合并自原 browser_scroll / browser_scroll_by_index：未传 index 时按 CSS 选择器/页面滚动，
  // 传 index 时按 browser_extract_dom 的索引滚动可滚动元素。

  /** 原 browser_scroll */
  const handleBrowserScroll = async (params: Record<string, unknown>) => {
    touchBrowserSession();
    const selector = String(params.selector || "") || null;
    const direction = String(params.direction || "down") as "up" | "down" | "left" | "right";
    const amountRaw = parseInt(String(params.amount ?? "300"), 10);
    const amount = Number.isFinite(amountRaw) ? amountRaw : 300;
    try {
      await pwBrowser.scroll(selector, direction, amount);
      return { success: true, selector: selector || "page", direction, amount };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Scroll failed: ${msg}` };
    }
  };

  /** 原 browser_scroll_by_index */
  const handleBrowserScrollByIndex = async (params: Record<string, unknown>) => {
    touchBrowserSession();
    const index = parseInt(String(params.index || ""), 10);
    if (Number.isNaN(index) || index < 0) {
      return { success: false, error: "Invalid index. Provide a non-negative integer." };
    }
    const direction = String(params.direction || "down") as "up" | "down" | "left" | "right";
    const amountRaw = parseInt(String(params.amount ?? "300"), 10);
    const amount = Number.isFinite(amountRaw) ? amountRaw : 300;
    try {
      const result = await pwBrowser.scrollByIndex(index, direction, amount);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `scrollByIndex failed: ${msg}` };
    }
  };

  executor.registerTool(
    "browser_scroll",
    {
      name: "browser_scroll",
      description:
        "复合浏览器滚动工具（composite browser scroll tool）。" +
        "未传 index 时按 selector（缺省滚动整页）与方向滚动；传 index 时按 browser_extract_dom 的索引滚动可滚动元素。",
      parameters: {
        action: {
          type: "string",
          description: "滚动操作类型（保留 action 判别字段，当前仅支持 scroll）",
          required: true,
          enum: ["scroll"],
        },
        selector: { type: "string", description: "CSS 选择器（滚动目标元素，缺省滚动整页）" },
        index: { type: "string", description: "元素索引（来自 browser_extract_dom；传入时按索引滚动）" },
        direction: { type: "string", description: "方向：up、down、left、right（默认 down）" },
        amount: { type: "string", description: "滚动像素数（默认 300）" },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "scroll");
      if (action === "scroll") {
        if (params.index !== undefined && String(params.index) !== "") {
          return await handleBrowserScrollByIndex(params);
        }
        return await handleBrowserScroll(params);
      }
      return { success: false, error: `未知 browser_scroll action: ${action}（仅支持 scroll）` };
    }
  );

  // ── 索引化 DOM 操作工具（借鉴 page-agent 的 flatTreeToString 思路）──
  // 先调用 browser_extract_dom 提取，再用 [index] 调用 click/input/scroll。
  // 比传统的 CSS selector 方式更直观，LLM 可以从扁平化文本中直接读出可操作元素。

  // ── browser_extract_dom：复合 DOM 提取工具（action 判别）──
  // 合并自原 browser_extract_dom / browser_clear_dom_indexes：
  // 提取索引化扁平 DOM 树 / 清除 data-pa-idx 索引。

  /** 原 browser_extract_dom */
  const handleBrowserExtractDom = async (params: Record<string, unknown>) => {
    touchBrowserSession();
    const maxElements = Math.max(0, parseInt(String(params.max_elements ?? "200"), 10) || 200);
    try {
      const result = await pwBrowser.extractDom({ maxElements });
      return {
        success: true,
        url: result.url,
        title: result.title,
        count: result.count,
        flatTree: result.flatTree,
        selectorMap: result.selectorMap,
        hint: "Use browser_act with action=click (or action=fill) and the [index] numbers above; browser_scroll also accepts an index.",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `extractDom failed: ${msg}` };
    }
  };

  /** 原 browser_clear_dom_indexes */
  const handleBrowserClearDomIndexes = async () => {
    try {
      await pwBrowser.clearDomIndexes();
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `clearDomIndexes failed: ${msg}` };
    }
  };

  executor.registerTool(
    "browser_extract_dom",
    {
      name: "browser_extract_dom",
      description:
        "复合 DOM 提取工具（composite DOM extraction tool），通过 action 参数选择具体操作。" +
        "actions: " +
        "extract（默认，提取当前页的索引化扁平 DOM 树，返回形如 '[0]<button>登录</button>' 的文本与 selectorMap） / " +
        "clear（清除 browser_extract_dom 设置的所有 data-pa-idx 属性；重新提取前调用以避免索引错乱）",
      parameters: {
        action: {
          type: "string",
          description: "操作类型：extract（默认）/ clear",
          required: true,
          enum: ["extract", "clear"],
        },
        max_elements: { type: "string", description: "提取的最大交互元素数量（默认 200）（extract 使用）" },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "extract");
      if (action === "extract") return await handleBrowserExtractDom(params);
      if (action === "clear") return await handleBrowserClearDomIndexes();
      return { success: false, error: `未知 browser_extract_dom action: ${action}（仅支持 extract / clear）` };
    }
  );
  // 返回清理函数，供宿主在 shutdown 时 clearInterval，避免 interval 泄漏
  return () => {
    clearInterval(browserHealthInterval);
  };
}
