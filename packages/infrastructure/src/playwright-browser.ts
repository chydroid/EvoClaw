import { chromium, Browser, BrowserContext, Page } from "playwright";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
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

export class PlaywrightBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private tabs: Map<string, PlaywrightTab> = new Map();
  private activeTabId: string | null = null;
  private cookieFile: string;
  private launched = false;
  private headless = true;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    options?: { headless?: boolean; cookieStorageDir?: string }
  ) {
    this.headless = options?.headless ?? true;
    this.cookieFile = path.join(options?.cookieStorageDir || process.cwd(), ".evoclaw-cookies.json");
  }

  async launch(): Promise<void> {
    if (this.launched) return;

    this.browser = await chromium.launch({
      headless: this.headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
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

    for (const [, tab] of this.tabs) {
      try {
        await tab.page.close();
      } catch {}
    }
    this.tabs.clear();

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

  async navigate(url: string): Promise<{ url: string; title: string; status: number; content: string }> {
    await this.ensureLaunched();

    let page = this.activePage;
    if (!page) {
      page = await this.context!.newPage();
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
    );

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
      const tabId = `tab-${Date.now()}`;
      this.tabs.set(tabId, { id: tabId, page, url: loginUrl, createdAt: new Date() });
      this.activeTabId = tabId;
    }

    try {
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
      );
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
        if (cookies.length > 0) {
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
    } catch {}
  }

  private async saveCookies(): Promise<void> {
    try {
      const cookies = await this.getCookies();
      if (cookies.length > 0) {
        const dir = path.dirname(this.cookieFile);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.cookieFile, JSON.stringify(cookies, null, 2), "utf-8");
      }
    } catch (err) {
      console.error("[PlaywrightBrowser] Failed to save cookies:", err);
    }
  }

  async newTab(url?: string): Promise<string> {
    await this.ensureLaunched();

    const page = await this.context!.newPage();
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    this.tabs.set(tabId, {
      id: tabId,
      page,
      url: url || "about:blank",
      createdAt: new Date(),
    });

    this.activeTabId = tabId;

    if (url) {
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

  listTabs(): Array<{ id: string; url: string; active: boolean }> {
    return [...this.tabs.values()].map((t) => ({
      id: t.id,
      url: t.url,
      active: t.id === this.activeTabId,
    }));
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

  private async ensureLaunched(): Promise<void> {
    if (!this.launched) {
      await this.launch();
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.launched;
  }
}