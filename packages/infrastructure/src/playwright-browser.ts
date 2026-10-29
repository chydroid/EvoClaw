import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { ServiceRegistry, EventBus, atomicWriteFileSync } from "@evoclaw/core";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface PlaywrightTab {
  id: string;
  page: Page;
  url: string;
  createdAt: Date;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  selector?: string;
  quality?: number;
  type?: "png" | "jpeg";
}

export interface CookieData {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface LoginResult {
  success: boolean;
  currentUrl: string;
  pageTitle: string;
  cookies: CookieData[];
  error?: string;
}

export interface FormFillOptions {
  selector: string;
  value: string;
  delay?: number;
  submitAfter?: boolean;
  clearFirst?: boolean;
}

/** 索引化 DOM 提取结果（借鉴 page-agent 的 flatTreeToString 思路）。 */
export interface DomSelectorInfo {
  tag: string;
  role: string;
  text: string;
  href: string;
  type: string;
  name: string;
  selector: string;
}

export interface DomExtractResult {
  /** 扁平化 DOM 文本，形如 `[0]<button>登录</button>`。 */
  flatTree: string;
  /** index → 元素信息映射。 */
  selectorMap: Record<number, DomSelectorInfo>;
  /** 提取到的元素总数。 */
  count: number;
  /** 当前页面 URL。 */
  url: string;
  /** 当前页面标题。 */
  title: string;
}

/** 原生 JS 对话框（alert/confirm/prompt/beforeunload）的公开视图（对标 Hermes
 *  browser_snapshot.pending_dialogs 条目）。不含内部句柄，可安全返回给模型。 */
export interface PendingDialogInfo {
  id: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  appearedAt: number;
  /** 是否因超时被自动 dismiss（未等 agent 响应）。 */
  autoDismissed?: boolean;
}

/** Hermes browser.dialog_timeout_s 默认值（300s）：对话框挂起后若 agent 一直不响应，
 *  超时自动 dismiss，避免页面被永久阻塞。 */
export const DEFAULT_DIALOG_TIMEOUT_MS = 300_000;

export class PlaywrightBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private tabs: Map<string, PlaywrightTab> = new Map();
  private activeTabId: string | null = null;
  private cookieFile: string;
  private launched = false;
  private headless = true;
  private dialogTimeoutMs: number;
  /** 原生对话框队列（对标 Hermes CDP supervisor 的 pending_dialogs）。 */
  private pendingDialogs = new Map<
    string,
    {
      info: PendingDialogInfo;
      /** Playwright Dialog 句柄：accept/dismiss 必须经它完成（不能重新构造）。 */
      dialog: { accept: (promptText?: string) => Promise<void>; dismiss: () => Promise<void> };
      /** 超时自动 dismiss 的定时器。 */
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** page → 持久 CDPSession（browser_cdp 复用，避免每次调用重建连接）。 */
  private cdpSessions = new WeakMap<Page, CDPSession>();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    options?: { headless?: boolean; cookieStorageDir?: string; dialogTimeoutMs?: number }
  ) {
    this.headless = options?.headless ?? true;
    this.dialogTimeoutMs = options?.dialogTimeoutMs ?? DEFAULT_DIALOG_TIMEOUT_MS;
    this.cookieFile = path.join(options?.cookieStorageDir || process.cwd(), ".evoclaw-cookies.json");
  }

  async launch(): Promise<void> {
    if (this.launched) return;

    let playwright: typeof import("playwright");
    try {
      playwright = await import("playwright");
    } catch {
      throw new Error(
        "Playwright is not installed. Install with: pnpm add playwright (optional dependency)"
      );
    }

    this.browser = await playwright.chromium.launch({
      headless: this.headless,
      // 安全：仅在以 root 运行时才禁用沙箱（兼容容器环境），
      // 非 root 环境保留 Chromium 沙箱防止浏览器漏洞逃逸至宿主。
      args: process.getuid?.() === 0
        ? ["--no-sandbox", "--disable-setuid-sandbox"]
        : [],
    });

    const contextOptions: Record<string, unknown> = {
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    };

    await this.loadCookies(contextOptions);

    this.context = await this.browser.newContext(
      contextOptions as Parameters<Browser["newContext"]>[0]
    );

    this.launched = true;

    this.eventBus.publish(
      "playwright.launched",
      { headless: this.headless },
      "playwright-browser"
    );
  }

  async shutdown(): Promise<void> {
    await this.saveCookies();

    // 清理对话框队列：超时定时器已 unref，但主动清空避免悬挂句柄。
    for (const [, rec] of this.pendingDialogs) {
      clearTimeout(rec.timer);
      rec.dialog.dismiss().catch(() => { /* 页面可能已销毁 */ });
    }
    this.pendingDialogs.clear();

    for (const [, tab] of this.tabs) {
      try {
        await tab.page.close();
      } catch {}
    }
    this.tabs.clear();
    this.cdpSessions = new WeakMap();

    if (this.context) {
      await this.context.close();
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    this.launched = false;
    this.activeTabId = null;

    this.eventBus.publish("playwright.shutdown", {}, "playwright-browser");
  }

  private get activePage(): Page | null {
    if (!this.activeTabId || !this.context) return null;
    const tab = this.tabs.get(this.activeTabId);
    return tab?.page || null;
  }

  /**
   * 注册原生对话框钩子（对标 Hermes CDP supervisor 的对话框捕获）。
   * Playwright 默认自动 dismiss 未处理的对话框；这里改为捕获入队 + 超时自动
   * dismiss（对齐 Hermes dialog_policy=must_respond + dialog_timeout_s 默认 300s），
   * 由 browser_dialog 工具响应。每个新建 page 必须调用（launch/navigate/login/newTab）。
   */
  private registerDialogHooks(page: Page): void {
    page.on("dialog", (dialog) => {
      const id = `dialog-${randomUUID()}`;
      const info: PendingDialogInfo = {
        id,
        type: dialog.type() as PendingDialogInfo["type"],
        message: dialog.message(),
        appearedAt: Date.now(),
      };
      const record = {
        info,
        dialog,
        timer: setTimeout(() => {
          // 超时自动 dismiss：页面不被永久阻塞；标记 autoDismissed 供后续查询。
          const cur = this.pendingDialogs.get(id);
          if (cur && cur.info === info) {
            cur.info.autoDismissed = true;
            this.pendingDialogs.delete(id);
            dialog.dismiss().catch(() => { /* 页面可能已销毁 */ });
          }
        }, this.dialogTimeoutMs),
      };
      record.timer.unref?.();
      this.pendingDialogs.set(id, record);
    });
  }

  /**
   * SSRF 校验：在 page.goto 前拦截内网 IP / 元数据端点 / 危险协议。
   * 优先使用注册表中的 ssrfProtection 服务；未注册时退化为协议白名单。
   */
  private async assertSafeUrl(url: string): Promise<void> {
    const ssrfProtection = this.registry.resolveService<{
      checkURL(url: string): Promise<{ allowed: boolean; reason?: string }>;
    }>("ssrfProtection");
    if (!ssrfProtection) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`Invalid URL format: ${url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Unsupported protocol: ${parsed.protocol}. Only http/https allowed.`);
      }
      return;
    }
    const result = await ssrfProtection.checkURL(url);
    if (!result.allowed) {
      throw new Error(`URL blocked by security policy: ${result.reason}`);
    }
  }

  async navigate(url: string): Promise<{ url: string; title: string; status: number; content: string }> {
    await this.ensureLaunched();

    // SSRF 检查：在发起请求前拦截内网/元数据端点
    await this.assertSafeUrl(url);

    let page = this.activePage;
    if (!page) {
      page = await this.context!.newPage();
      this.registerDialogHooks(page);
      const tabId = `tab-${Date.now()}`;
      this.tabs.set(tabId, {
        id: tabId,
        page,
        url,
        createdAt: new Date(),
      });
      this.activeTabId = tabId;
    }

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const status = response ? response.status() : 0;
    const title = await page.title();
    const content = await page.content();

    const tab = [...this.tabs.values()].find((t) => t.page === page);
    if (tab) {
      tab.url = page.url();
    }

    this.eventBus.publish(
      "playwright.navigated",
      { url: page.url(), title, status },
      "playwright-browser"
    ).catch((err) => process.stderr.write('[PlaywrightBrowser] event publish failed: ' + err + '\n'));

    return { url: page.url(), title, status, content };
  }

  async getText(): Promise<string> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");

    return await page.evaluate(() => document.body.innerText);
  }

  async getHTML(): Promise<string> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");

    return await page.content();
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");

    if (options.selector) {
      const el = await page.$(options.selector);
      if (!el) throw new Error(`Element not found: ${options.selector}`);
      return await el.screenshot({ type: options.type || "png" });
    }

    return await page.screenshot({
      fullPage: options.fullPage ?? true,
      type: options.type || "png",
      quality: options.type === "jpeg" ? options.quality : undefined,
    });
  }

  async evaluateJS<T = unknown>(expression: string): Promise<T> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");

    // 安全：阻止任意 JS 执行中可能逃逸浏览器沙箱的危险全局对象/构造器。
    // 虽然页面上下文本身无 Node.js 的 require/process，但保留校验作为纵深防御，
    // 防止通过注入片段访问页面中可能被 polyfill 的这些标识符。
    // 注意：正则黑名单无法可靠阻止所有绕过方式（如字符串拼接 window["req"+"ire"]）。
    // 此检查仅作为第一道防线，真正的隔离应依赖页面沙箱/CSP。
    const FORBIDDEN_JS_PATTERNS = [/\brequire\s*\(/, /\bprocess\b/, /\beval\s*\(/, /\bFunction\s*\(/];
    // 基本的字符串拼接检测，作为黑名单的补充（仍无法覆盖所有变体）。
    const CONCAT_PATTERNS = [
      /\[[\s"'+]*['"][a-z_]+['"][\s"'+]*\+[\s"'+]*['"][a-z_]+['"]/i,
    ];
    for (const pattern of [...FORBIDDEN_JS_PATTERNS, ...CONCAT_PATTERNS]) {
      if (pattern.test(expression)) {
        process.stderr.write(
          `[PlaywrightBrowser] evaluateJS rejected expression containing forbidden token: ${pattern.source}\n`
        );
        throw new Error(`evaluateJS blocked: expression contains forbidden token (${pattern.source})`);
      }
    }

    process.stderr.write(
      `[PlaywrightBrowser] evaluateJS executing user-provided expression (len=${expression.length})\n`
    );

    const result = await page.evaluate(expression);
    return result as T;
  }

  async click(selector: string): Promise<void> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");

    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector);
  }

  async fillForm(fields: FormFillOptions[]): Promise<void> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");

    for (const field of fields) {
      await page.waitForSelector(field.selector, { timeout: 10000 });

      if (field.clearFirst !== false) {
        await page.fill(field.selector, "");
      }

      if (field.delay && field.delay > 0) {
        await page.type(field.selector, field.value, { delay: field.delay });
      } else {
        await page.fill(field.selector, field.value);
      }

      if (field.submitAfter) {
        await page.press(field.selector, "Enter");
      }
    }
  }

  async selectOption(selector: string, value: string): Promise<string[]> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    await page.waitForSelector(selector, { timeout: 10000 });
    return await page.selectOption(selector, value);
  }

  async checkCheckbox(selector: string, checked: boolean = true): Promise<void> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    await page.waitForSelector(selector, { timeout: 10000 });
    const isChecked = await page.isChecked(selector);
    if (isChecked !== checked) {
      await page.click(selector);
    }
  }

  async waitForElement(selector: string, timeout: number = 30000, state: "attached" | "visible" | "hidden" | "detached" = "visible"): Promise<boolean> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    try {
      await page.waitForSelector(selector, { timeout, state });
      return true;
    } catch {
      return false;
    }
  }

  async hover(selector: string): Promise<void> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.hover(selector);
  }

  async scroll(selector: string | null, direction: "up" | "down" | "left" | "right", amount: number = 300): Promise<void> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    const scrollMap: Record<string, [number, number]> = {
      up: [0, -amount],
      down: [0, amount],
      left: [-amount, 0],
      right: [amount, 0],
    };
    const [dx, dy] = scrollMap[direction] || [0, amount];
    if (selector) {
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.evaluate(
        ([sel, ddx, ddy]) => {
          const el = document.querySelector(sel as string);
          if (el) el.scrollBy(ddx as number, ddy as number);
        },
        [selector, dx, dy] as [string, number, number]
      );
    } else {
      await page.evaluate(
        ([ddx, ddy]) => window.scrollBy(ddx as number, ddy as number),
        [dx, dy] as [number, number]
      );
    }
  }

  // ── 索引化 DOM 提取与操作（借鉴 page-agent 的 flatTreeToString 思路）──
  // 通过 page.evaluate 在浏览器里跑提取脚本，给交互元素打 data-pa-idx 属性，
  // LLM 通过 [index] 操作元素，比 CSS selector 更直观可靠。

  async extractDom(options?: { maxElements?: number }): Promise<DomExtractResult> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    const maxElements = options?.maxElements ?? 200;
    const result = await page.evaluate(
      (maxN: number) => {
        const seen = new Set<Element>();
        const selectorMap: Record<number, DomSelectorInfo> = {};
        const lines: string[] = [];

        function isInteractive(el: Element): boolean {
          if (seen.has(el)) return false;
          const tag = el.tagName.toLowerCase();
          if (["a", "button", "input", "select", "textarea"].includes(tag)) return true;
          const role = el.getAttribute("role");
          if (["button", "link", "checkbox", "tab", "menuitem", "option", "combobox", "textbox", "switch", "radio"].includes(role || "")) return true;
          if (el.getAttribute("contenteditable") === "true") return true;
          if (el.hasAttribute("onclick")) return true;
          const tabIdx = el.getAttribute("tabindex");
          if (tabIdx !== null && parseInt(tabIdx, 10) >= 0) return true;
          try {
            const cursor = window.getComputedStyle(el as HTMLElement).cursor;
            if (cursor === "pointer") return true;
          } catch { /* ignore */ }
          return false;
        }

        function isVisible(el: Element): boolean {
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const style = window.getComputedStyle(el as HTMLElement);
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (parseFloat(style.opacity) === 0) return false;
          return true;
        }

        function getText(el: Element): string {
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel) return ariaLabel.trim().slice(0, 80);
          const title = el.getAttribute("title");
          if (title) return title.trim().slice(0, 80);
          const placeholder = el.getAttribute("placeholder");
          if (placeholder) return placeholder.trim().slice(0, 80);
          const alt = el.getAttribute("alt");
          if (alt) return alt.trim().slice(0, 80);
          const text = el.textContent?.trim();
          if (text) return text.slice(0, 80);
          const value = (el as HTMLInputElement).value;
          if (value) return String(value).slice(0, 80);
          return "";
        }

        const all = Array.from(document.querySelectorAll("*"));
        let idx = 0;
        for (const el of all) {
          if (idx >= maxN) break;
          if (!isInteractive(el) || !isVisible(el)) continue;
          seen.add(el);
          el.setAttribute("data-pa-idx", String(idx));
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role") || "";
          const text = getText(el);
          const href = el.getAttribute("href") || "";
          const type = el.getAttribute("type") || "";
          const name = el.getAttribute("name") || "";

          const parts: string[] = [`[${idx}]`];
          parts.push(`<${tag}`);
          if (role) parts.push(`role=${role}`);
          if (type) parts.push(`type=${type}`);
          if (name) parts.push(`name=${name}`);
          if (href) parts.push(`href="${href.slice(0, 50)}"`);
          parts.push(">");
          if (text) parts.push(text);
          lines.push(parts.join(" "));

          selectorMap[idx] = { tag, role, text, href: href.slice(0, 120), type, name, selector: `[data-pa-idx="${idx}"]` };
          idx++;
        }

        return {
          flatTree: lines.join("\n"),
          selectorMap,
          count: idx,
          url: location.href,
          title: document.title,
        } as DomExtractResult;
      },
      maxElements
    );
    return result;
  }

  async clickByIndex(index: number): Promise<{ ok: true; index: number; selector: string } | { ok: false; error: string }> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    const selector = `[data-pa-idx="${index}"]`;
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.click(selector);
      return { ok: true, index, selector };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async inputByIndex(index: number, text: string, options?: { clearFirst?: boolean; delay?: number }): Promise<{ ok: true; index: number } | { ok: false; error: string }> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    const selector = `[data-pa-idx="${index}"]`;
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      if (options?.clearFirst !== false) {
        await page.fill(selector, "");
      }
      if (options?.delay && options.delay > 0) {
        await page.type(selector, text, { delay: options.delay });
      } else {
        await page.fill(selector, text);
      }
      return { ok: true, index };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async scrollByIndex(index: number, direction: "up" | "down" | "left" | "right", amount: number = 300): Promise<{ ok: true; index: number } | { ok: false; error: string }> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    const selector = `[data-pa-idx="${index}"]`;
    const scrollMap: Record<string, [number, number]> = {
      up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0],
    };
    const [dx, dy] = scrollMap[direction] || [0, amount];
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.evaluate(
        ([sel, ddx, ddy]) => {
          const el = document.querySelector(sel as string);
          if (el) el.scrollBy(ddx as number, ddy as number);
        },
        [selector, dx, dy] as [string, number, number]
      );
      return { ok: true, index };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async clearDomIndexes(): Promise<void> {
    const page = this.activePage;
    if (!page) return;
    try {
      await page.evaluate(() => {
        document.querySelectorAll("[data-pa-idx]").forEach((el) => el.removeAttribute("data-pa-idx"));
      });
    } catch { /* ignore */ }
  }

  async login(
    loginUrl: string,
    usernameSelector: string,
    passwordSelector: string,
    username: string,
    password: string,
    submitSelector: string,
    successIndicator?: { selector?: string; urlContains?: string }
  ): Promise<LoginResult> {
    await this.ensureLaunched();

    let page = this.activePage;
    if (!page) {
      page = await this.context!.newPage();
      this.registerDialogHooks(page);
      const tabId = `tab-${Date.now()}`;
      this.tabs.set(tabId, { id: tabId, page, url: loginUrl, createdAt: new Date() });
      this.activeTabId = tabId;
    }

    try {
      // SSRF 检查：与 navigate() 一致，在 page.goto 前拦截内网/元数据端点。
      await this.assertSafeUrl(loginUrl);
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

      await page.waitForSelector(usernameSelector, { timeout: 10000 });
      await page.fill(usernameSelector, username);

      await page.waitForSelector(passwordSelector, { timeout: 5000 });
      await page.fill(passwordSelector, password);

      await page.click(submitSelector);

      await page.waitForLoadState("networkidle", { timeout: 15000 });

      let loginSuccess = false;
      if (successIndicator?.selector) {
        try {
          await page.waitForSelector(successIndicator.selector, { timeout: 10000 });
          loginSuccess = true;
        } catch {
          loginSuccess = false;
        }
      } else if (successIndicator?.urlContains) {
        await page.waitForTimeout(3000);
        loginSuccess = page.url().includes(successIndicator.urlContains);
      } else {
        await page.waitForTimeout(2000);
        loginSuccess = page.url() !== loginUrl && !page.url().includes("login");
      }

      const currentUrl = page.url();
      const pageTitle = await page.title();
      const cookies = await this.getCookies();

      if (loginSuccess) {
        await this.saveCookies();
        this.eventBus.publish(
          "playwright.login_success",
          { url: currentUrl, title: pageTitle },
          "playwright-browser"
        );
      } else {
        this.eventBus.publish(
          "playwright.login_failed",
          { url: currentUrl },
          "playwright-browser"
        );
      }

      return { success: loginSuccess, currentUrl, pageTitle, cookies };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.eventBus.publish(
        "playwright.login_error",
        { error: errorMsg },
        "playwright-browser"
      ).catch((err2) => process.stderr.write('[PlaywrightBrowser] event publish failed: ' + err2 + '\n'));
      return {
        success: false,
        currentUrl: page.url(),
        pageTitle: await page.title().catch(() => ""),
        cookies: [],
        error: errorMsg,
      };
    }
  }

  async getCookies(): Promise<CookieData[]> {
    if (!this.context) return [];
    const cookies = await this.context.cookies();
    return cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite as CookieData["sameSite"],
    }));
  }

  async setCookies(cookies: CookieData[]): Promise<void> {
    if (!this.context) throw new Error("Browser not launched");
    await this.context.addCookies(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite || "Lax",
      }))
    );
  }

  private async loadCookies(contextOptions: Record<string, unknown>): Promise<void> {
    try {
      if (fs.existsSync(this.cookieFile)) {
        const raw = fs.readFileSync(this.cookieFile, "utf-8");
        const cookies = JSON.parse(raw) as CookieData[];
        if (Array.isArray(cookies) && cookies.length > 0) {
          (contextOptions as Record<string, unknown>).storageState = {
            cookies: cookies.map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path || "/",
              expires: c.expires,
              httpOnly: c.httpOnly,
              secure: c.secure,
              sameSite: c.sameSite || "Lax",
            })),
          };
        }
      }
    } catch (err) {
      process.stderr.write(`[PlaywrightBrowser] Failed to load cookies: ${err instanceof Error ? err.message : String(err)}` + "\n");
    }
  }

  private async saveCookies(): Promise<void> {
    try {
      const cookies = await this.getCookies();
      if (cookies.length > 0) {
        // 安全：cookie 文件含会话凭据，必须设置 0o600 权限防止同机其他用户读取
        atomicWriteFileSync(this.cookieFile, JSON.stringify(cookies, null, 2), { encoding: "utf-8", mode: 0o600 });
      }
    } catch (err) {
      process.stderr.write(`[PlaywrightBrowser] Failed to save cookies: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  async newTab(url?: string): Promise<string> {
    await this.ensureLaunched();

    const page = await this.context!.newPage();
    this.registerDialogHooks(page);
    const tabId = `tab-${randomUUID()}`;

    this.tabs.set(tabId, {
      id: tabId,
      page,
      url: url || "about:blank",
      createdAt: new Date(),
    });

    this.activeTabId = tabId;

    if (url) {
      // SSRF 检查：与 navigate() 一致，防止新标签页访问内网/元数据端点。
      await this.assertSafeUrl(url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    }

    return tabId;
  }

  async switchTab(tabId: string): Promise<void> {
    if (!this.tabs.has(tabId)) throw new Error(`Tab not found: ${tabId}`);
    this.activeTabId = tabId;
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Tab not found: ${tabId}`);

    await tab.page.close();
    this.tabs.delete(tabId);

    if (this.activeTabId === tabId) {
      const remaining = [...this.tabs.keys()];
      this.activeTabId = remaining.length > 0 ? remaining[0] : null;
    }
  }

  /**
   * 列出所有标签页。title 惰性读取 page.title()（可能为空串），
   * 结果中的 title 字段为「读取时点的快照」，调用方自行处理刷新。
   */
  async listTabs(): Promise<Array<{ id: string; url: string; title: string; active: boolean }>> {
    const out: Array<{ id: string; url: string; title: string; active: boolean }> = [];
    for (const t of this.tabs.values()) {
      let title = "";
      try { title = await t.page.title(); } catch { /* 标签页可能已销毁 */ }
      out.push({ id: t.id, url: t.url, title, active: t.id === this.activeTabId });
    }
    return out;
  }

  async findElements(selector: string): Promise<
    Array<{
      tag: string;
      text: string;
      href?: string;
      src?: string;
      visible: boolean;
    }>
  > {
    const page = this.activePage;
    if (!page) throw new Error("No active page");

    return await page.$$eval(selector, (elements) =>
      elements.map((el) => {
        const htmlEl = el as HTMLElement;
        const anchor = el as HTMLAnchorElement;
        const img = el as HTMLImageElement;
        return {
          tag: el.tagName.toLowerCase(),
          text: htmlEl.innerText?.trim().slice(0, 200) || "",
          href: anchor.href || undefined,
          src: img.src || undefined,
          visible:
            htmlEl.offsetWidth > 0 &&
            htmlEl.offsetHeight > 0 &&
            htmlEl.style.display !== "none" &&
            htmlEl.style.visibility !== "hidden",
        };
      })
    );
  }

  async submitForm(
    formSelector: string,
    fields: Record<string, string>,
    submitButtonSelector?: string,
    waitForNavigation = true
  ): Promise<{ url: string; title: string }> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");

    for (const [name, value] of Object.entries(fields)) {
      const sel = `[name="${name}"], #${name}, ${name}`;
      try {
        await page.waitForSelector(sel, { timeout: 5000 });
        await page.fill(sel, value);
      } catch {
        throw new Error(`Form field not found: ${name}`);
      }
    }

    if (submitButtonSelector) {
      if (waitForNavigation) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
          page.click(submitButtonSelector),
        ]);
      } else {
        await page.click(submitButtonSelector);
        await page.waitForLoadState("domcontentloaded");
      }
    }

    return {
      url: page.url(),
      title: await page.title(),
    };
  }

  // ── 对标 Hermes browser_tool.py 的导航/键盘/图片原语 ──

  /** browser_back：历史后退。返回新页面 URL/标题（供 SSRF 复查）。 */
  async goBack(): Promise<{ url: string; title: string }> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
    const url = page.url();
    const title = await page.title();
    const tab = [...this.tabs.values()].find((t) => t.page === page);
    if (tab) tab.url = url;
    this.eventBus.publish("playwright.navigated", { url, title, status: 0 }, "playwright-browser")
      .catch((err) => process.stderr.write('[PlaywrightBrowser] event publish failed: ' + err + '\n'));
    return { url, title };
  }

  /** browser_press：键盘按键（Enter 提交表单 / Tab 导航 / Escape 等）。 */
  async pressKey(key: string): Promise<void> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    await page.keyboard.press(key);
  }

  /** browser_get_images：列出页面图片（src/alt/自然尺寸），排除 data: URI。
   *  JS 片段逐字移植自 Hermes browser_tool._GET_IMAGES_JS。 */
  async getImages(): Promise<Array<{ src: string; alt: string; width: number; height: number }>> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    const raw = await page.evaluate(
      "JSON.stringify([...document.images].map(img => ({src: img.src, alt: img.alt || '', width: img.naturalWidth, height: img.naturalHeight})).filter(img => img.src && !img.src.startsWith('data:')))"
    );
    try {
      return JSON.parse(raw as string) as Array<{ src: string; alt: string; width: number; height: number }>;
    } catch {
      return [];
    }
  }

  // ── browser_cdp：原始 CDP 通道（Playwright CDPSession，Chromium only）──
  // 与 Hermes 直连外部 CDP WebSocket 不同：EvoClaw 的 browser_cdp 作用于自身
  // Playwright Chromium 实例，按 page 复用持久 CDPSession（免每次重建连接）。

  async cdpSend(
    method: string,
    params: Record<string, unknown> = {},
    opts?: { targetId?: string; timeoutMs?: number }
  ): Promise<unknown> {
    const page = opts?.targetId ? this.tabs.get(opts.targetId)?.page ?? null : this.activePage;
    if (!page) throw new Error(opts?.targetId ? `Tab not found: ${opts.targetId}` : "No active page");
    if (!this.context) throw new Error("Browser not launched");
    let session = this.cdpSessions.get(page);
    if (!session) {
      session = await this.context.newCDPSession(page);
      this.cdpSessions.set(page, session);
    }
    // CDPSession.send 类型只接受 (method, params) 两参（method 有 Protocol 泛型约束）；
    // 超时用 Promise.race 实现（对齐 Hermes browser_cdp timeout 语义）。
    // 超时后底层 send promise 可能仍悬空（session 复用，不阻断后续调用）。
    const send = session.send as (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const promise = send(method, params);
    if (!timeoutMs || timeoutMs <= 0) return await promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`CDP command ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── 原生对话框（browser_dialog）──

  /** 当前挂起的对话框公开视图列表（browser_snapshot.pending_dialogs 等价物）。 */
  listDialogs(): PendingDialogInfo[] {
    return [...this.pendingDialogs.values()].map((r) => ({ ...r.info }));
  }

  /** 响应挂起的对话框。dialogId 缺省时取最早挂起的一个；prompt 型 accept 需带 promptText。 */
  async respondToDialog(
    action: "accept" | "dismiss",
    promptText?: string,
    dialogId?: string
  ): Promise<{ ok: true; dialog: PendingDialogInfo } | { ok: false; error: string }> {
    const record = dialogId
      ? this.pendingDialogs.get(dialogId)
      : [...this.pendingDialogs.values()][0];
    if (!record) {
      return { ok: false, error: "No pending dialog. Native dialogs appear as pending_dialogs in browser_extract_dom output; respond with action accept/dismiss." };
    }
    clearTimeout(record.timer);
    this.pendingDialogs.delete(record.info.id);
    try {
      if (action === "accept") await record.dialog.accept(promptText);
      else await record.dialog.dismiss();
      return { ok: true, dialog: { ...record.info } };
    } catch (err) {
      return { ok: false, error: `Dialog ${action} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ── browser_vision / vault 支撑原语 ──

  /** 截图落盘（原子写）。filename 必须为 uuid.png 形式（工具侧校验）。 */
  async saveScreenshotToFile(dir: string, filename: string): Promise<{ path: string; size: number }> {
    const buf = await this.screenshot({ fullPage: true, type: "png" });
    await fs.promises.mkdir(dir, { recursive: true });
    const resolved = path.resolve(dir, filename);
    const tmp = `${resolved}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, resolved);
    return { path: resolved, size: buf.length };
  }

  /** 当前页 origin（规范化前原始值；about:blank 返回 null）。 */
  async getPageOrigin(): Promise<string | null> {
    const page = this.activePage;
    if (!page) return null;
    try {
      const href = await page.evaluate(() => window.location.href);
      if (!href || href === "about:blank") return null;
      return new URL(href).origin;
    } catch {
      return null;
    }
  }

  /** 服务端读取登录表单已填值（vault save_login 用；值只返回给工具 handler，
   *  绝不写入工具结果）。无密码字段时返回 null。 */
  async readCredentialsFromForm(): Promise<{ identifier: string; password: string } | null> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    return await page.evaluate(() => {
      const pw = document.querySelector('input[type="password"]') as HTMLInputElement | null;
      if (!pw) return null;
      const idEl = document.querySelector(
        'input[autocomplete="username"], input[autocomplete="email"], input[type="email"], input[name*="user" i], input[name*="email" i]'
      ) as HTMLInputElement | null;
      return { password: pw.value || "", identifier: idEl?.value || "" };
    });
  }

  /** 服务端填入密码字段（secret 只经服务端内存，不进模型上下文）。 */
  async fillPassword(secret: string): Promise<boolean> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    try {
      const loc = page.locator('input[type="password"]').first();
      await loc.waitFor({ state: "attached", timeout: 5000 });
      await loc.fill(secret);
      return true;
    } catch {
      return false;
    }
  }

  /** 服务端填入 OTP/验证码字段（vault enter_code 用）。 */
  async fillOtp(code: string): Promise<boolean> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    const selectors = [
      'input[autocomplete="one-time-code"]',
      'input[inputmode*="numeric" i]',
      'input[name*="otp" i]',
      'input[name*="code" i]',
      'input[name*="verification" i]',
      'input[maxlength="6"]',
    ];
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        await loc.waitFor({ state: "attached", timeout: 2000 });
        await loc.fill(code);
        return true;
      } catch { /* 试下一个选择器 */ }
    }
    return false;
  }

  /** W3C autocomplete token → 选择器链映射（vault payment/address fill 用）。 */
  private static readonly AUTOCOMPLETE_SELECTORS: Record<string, string> = {
    username: 'input[autocomplete="username"], input[autocomplete="email"], input[type="email"]',
    cc_number: 'input[autocomplete="cc-number"], input[name*="cardnumber" i], input[name*="cc-number" i]',
    cc_csc: 'input[autocomplete="cc-csc"], input[name*="cvc" i], input[name*="cvv" i], input[name*="cc-csc" i]',
    cc_exp: 'input[autocomplete="cc-exp"], input[name*="expiry" i], input[name*="expiration" i]',
    cc_exp_month: 'input[autocomplete="cc-exp-month"], select[name*="expmonth" i]',
    cc_exp_year: 'input[autocomplete="cc-exp-year"], select[name*="expyear" i]',
    cc_name: 'input[autocomplete="cc-name"], input[name*="ccname" i]',
    cc_address: 'input[autocomplete="cc-address"], input[name*="address" i]',
    cc_zip: 'input[autocomplete="cc-postal-code"], input[name*="zip" i], input[name*="postal" i]',
    cc_country: 'input[autocomplete="cc-country"], select[name*="country" i]',
    given_name: 'input[autocomplete="given-name"]',
    family_name: 'input[autocomplete="family-name"]',
    street_address: 'input[autocomplete="street-address"]',
    postal_code: 'input[autocomplete="postal-code"], input[name*="zip" i]',
    country: 'input[autocomplete="country"], select[name*="country" i]',
    city: 'input[autocomplete="address-level2"]',
    email: 'input[autocomplete="email"], input[type="email"]',
    telephone: 'input[autocomplete="tel"]',
  };

  /** 服务端批量填入 autocomplete token 字段。返回命中并填写的 token 列表
   *  （只报 token 名，绝不回显值）。 */
  async fillAutofillFields(fields: Record<string, string>): Promise<{ filled: string[]; missing: string[] }> {
    const page = this.activePage;
    if (!page) throw new Error("No active page");
    const filled: string[] = [];
    const missing: string[] = [];
    for (const [token, value] of Object.entries(fields)) {
      const selectors = PlaywrightBrowser.AUTOCOMPLETE_SELECTORS[token];
      if (!selectors) {
        missing.push(token);
        continue;
      }
      let done = false;
      for (const sel of selectors.split(",").map((s) => s.trim())) {
        try {
          const loc = page.locator(sel).first();
          await loc.waitFor({ state: "attached", timeout: 2000 });
          await loc.fill(value);
          done = true;
          break;
        } catch { /* 试下一个选择器 */ }
      }
      if (done) filled.push(token);
      else missing.push(token);
    }
    return { filled, missing };
  }

  private async ensureLaunched(): Promise<void> {
    if (!this.launched) {
      await this.launch();
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.launched;
  }

  /** 同步可用性检查（checkFn 不支持 async，handler 内部亦可用）。 */
  get isLaunched(): boolean {
    return this.launched;
  }
}