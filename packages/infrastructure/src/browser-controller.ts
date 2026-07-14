import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { SSRFProtection } from "@evoclaw/security";

export interface BrowserPage {
  url: string;
  title: string;
  status: number;
  headers: Record<string, string>;
}

export interface BrowserElement {
  tag: string;
  text: string;
  attributes: Record<string, string>;
  selector: string;
}

export interface NavigationResult {
  success: boolean;
  url: string;
  title: string;
  status: number;
  bodyPreview: string;
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string; method: string; fields: string[] }>;
  error?: string;
}

export interface FormData {
  action: string;
  method: string;
  fields: Record<string, string>;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class BrowserController {
  private static readonly MAX_COOKIES = 1000;
  private cookies: Map<string, string> = new Map();
  private userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 EvoClaw/1.0";
  private currentPage: NavigationResult | null = null;
  private tabs: Map<string, NavigationResult> = new Map();
  private activeTabId: string = "default";
  /** SSRF 防护：阻止浏览器导航到内网 IP / 元数据端点 */
  private ssrfProtection = new SSRFProtection();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  setUserAgent(ua: string): void {
    this.userAgent = ua;
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
    this.enforceCookieLimit();
  }

  private enforceCookieLimit(): void {
    while (this.cookies.size > BrowserController.MAX_COOKIES) {
      const firstKey = this.cookies.keys().next().value;
      if (!firstKey) break;
      this.cookies.delete(firstKey);
    }
  }

  private getCookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  async navigate(url: string): Promise<NavigationResult> {
    try {
      const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;

      // SSRF 防护：阻止导航到内网 IP / 元数据端点（如 169.254.169.254）
      const ssrfCheck = await this.ssrfProtection.checkURL(normalizedUrl);
      if (!ssrfCheck.allowed) {
        return {
          success: false,
          url: normalizedUrl,
          title: "",
          status: 0,
          bodyPreview: "",
          links: [],
          forms: [],
          error: `Blocked by SSRF protection: ${ssrfCheck.reason}`,
        };
      }

      const headers: Record<string, string> = {
        "User-Agent": this.userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      };

      const cookieHeader = this.getCookieHeader();
      if (cookieHeader) {
        headers["Cookie"] = cookieHeader;
      }

      const response = await fetch(normalizedUrl, {
        method: "GET",
        headers,
        // 手动处理重定向：对每个 3xx Location 执行 SSRF 二次检查，
        // 防止外部服务器 302 到内网/元数据端点绕过初始 URL 校验。
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });

      // 手动跟随重定向链（最多 5 跳），每跳都做 SSRF 检查
      let finalResponse = response;
      let currentUrl = normalizedUrl;
      let redirectCount = 0;
      while ([301, 302, 303, 307, 308].includes(finalResponse.status) && redirectCount < 5) {
        const location = finalResponse.headers.get("location");
        if (!location) break;
        const redirectUrl = new URL(location, currentUrl).toString();
        const redirectSsrf = await this.ssrfProtection.checkURL(redirectUrl);
        if (!redirectSsrf.allowed) {
          return {
            success: false,
            url: redirectUrl,
            title: "",
            status: finalResponse.status,
            bodyPreview: "",
            links: [],
            forms: [],
            error: `Blocked by SSRF protection on redirect: ${redirectSsrf.reason}`,
          };
        }
        currentUrl = redirectUrl;
        finalResponse = await fetch(redirectUrl, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
        redirectCount++;
      }

      const body = await finalResponse.text();

      const titleMatch = body.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : currentUrl;

      const setCookie = finalResponse.headers.get("set-cookie");
      if (setCookie) {
        const match = setCookie.match(/^([^=]+)=([^;]+)/);
        if (match) {
          this.cookies.set(match[1], match[2]);
          this.enforceCookieLimit();
        }
      }

      const links = this.extractLinks(body);
      const forms = this.extractForms(body);

      const bodyText = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const bodyPreview = bodyText.slice(0, 2000);

      const result: NavigationResult = {
        success: finalResponse.ok,
        url: currentUrl,
        title,
        status: finalResponse.status,
        bodyPreview,
        links,
        forms,
      };

      this.currentPage = result;
      this.tabs.set(this.activeTabId, result);

      this.eventBus?.publish(
        "browser.navigated",
        { url: currentUrl, status: finalResponse.status, title },
        "browser-controller"
      )?.catch((err) => process.stderr.write('[BrowserController] event publish failed: ' + err + '\n'));

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        url,
        title: "",
        status: 0,
        bodyPreview: "",
        links: [],
        forms: [],
        error: message,
      };
    }
  }

  async getPageContent(url?: string): Promise<string> {
    const targetUrl = url || this.currentPage?.url;
    if (!targetUrl) throw new Error("No URL specified and no current page");
    return this.navigate(targetUrl).then((r) => r.bodyPreview);
  }

  async findElements(selector: string): Promise<BrowserElement[]> {
    if (!this.currentPage) throw new Error("No page loaded. Call navigate() first.");

    const result = this.currentPage;
    const body = result.bodyPreview;

    const elements: BrowserElement[] = [];

    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      const regex = new RegExp(`class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["']`, "gi");
      const matches = body.match(regex);
      if (matches) {
        elements.push({
          tag: "element",
          text: `Elements with class "${className}"`,
          attributes: { class: className },
          selector,
        });
      }
    } else if (selector.startsWith("#")) {
      const id = selector.slice(1);
      const regex = new RegExp(`id=["']${escapeRegExp(id)}["']`, "gi");
      const matches = body.match(regex);
      if (matches) {
        elements.push({
          tag: "element",
          text: `Element with id "${id}"`,
          attributes: { id },
          selector,
        });
      }
    } else {
      const tagRegex = new RegExp(`<${escapeRegExp(selector)}[^>]*>.*?</${escapeRegExp(selector)}>|<${escapeRegExp(selector)}[^>]*/>`, "gis");
      const matches = body.match(tagRegex);
      if (matches) {
        for (const match of matches) {
          const textMatch = match.match(/>([^<]*)</);
          elements.push({
            tag: selector,
            text: textMatch ? textMatch[1].trim().slice(0, 200) : "",
            attributes: {},
            selector,
          });
        }
      }
    }

    return elements;
  }

  async getText(selector: string): Promise<string> {
    const elements = await this.findElements(selector);
    return elements.map((e) => e.text).join("\n");
  }

  async submitForm(formData: FormData): Promise<NavigationResult> {
    if (!formData.action) throw new Error("Form action URL is required");

    try {
      const url = formData.action.startsWith("http")
        ? formData.action
        : this.currentPage?.url
          ? new URL(formData.action, this.currentPage.url).href
          : formData.action;

      // 安全：SSRF 校验，防止表单提交到内网/元数据端点
      const ssrfCheck = await this.ssrfProtection.checkURL(url);
      if (!ssrfCheck.allowed) {
        return { success: false, url, title: "", status: 0, bodyPreview: "", links: [], forms: [], error: `Blocked by SSRF protection: ${ssrfCheck.reason}` };
      }

      const headers: Record<string, string> = {
        "User-Agent": this.userAgent,
        "Content-Type": formData.method === "post" ? "application/x-www-form-urlencoded" : "text/plain",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      };

      const cookieHeader = this.getCookieHeader();
      if (cookieHeader) headers["Cookie"] = cookieHeader;

      const method = formData.method || "get";

      // 手动处理重定向：对每个 3xx Location 执行 SSRF 二次检查，
      // 防止外部服务器 302 到内网/元数据端点绕过初始 URL 校验。
      // 与 navigate() 一致。
      const fetchOpts: RequestInit = { method, headers, redirect: "manual", signal: AbortSignal.timeout(30_000) };
      if (method === "post") {
        fetchOpts.body = new URLSearchParams(formData.fields).toString();
      }

      let response = await fetch(
        method === "post" ? url : `${url}?${new URLSearchParams(formData.fields).toString()}`,
        fetchOpts
      );

      // 手动跟随重定向链（最多 5 跳），每跳都做 SSRF 检查
      let currentUrl = url;
      let redirectCount = 0;
      while ([301, 302, 303, 307, 308].includes(response.status) && redirectCount < 5) {
        const location = response.headers.get("location");
        if (!location) break;
        const redirectUrl = new URL(location, currentUrl).toString();
        const redirectSsrf = await this.ssrfProtection.checkURL(redirectUrl);
        if (!redirectSsrf.allowed) {
          return {
            success: false,
            url: redirectUrl,
            title: "",
            status: response.status,
            bodyPreview: "",
            links: [],
            forms: [],
            error: `Blocked by SSRF protection on redirect: ${redirectSsrf.reason}`,
          };
        }
        currentUrl = redirectUrl;
        response = await fetch(redirectUrl, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
        redirectCount++;
      }

      const body = await response.text();
      const titleMatch = body.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : currentUrl;
      const bodyText = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const bodyPreview = bodyText.slice(0, 2000);

      const result: NavigationResult = {
        success: response.ok,
        url: currentUrl,
        title,
        status: response.status,
        bodyPreview,
        links: this.extractLinks(body),
        forms: this.extractForms(body),
      };

      this.currentPage = result;

      this.eventBus?.publish(
        "browser.form_submitted",
        { url: currentUrl, method, status: response.status },
        "browser-controller"
      )?.catch((err) => process.stderr.write('[BrowserController] event publish failed: ' + err + '\n'));

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        url: formData.action,
        title: "",
        status: 0,
        bodyPreview: "",
        links: [],
        forms: [],
        error: message,
      };
    }
  }

  newTab(tabId: string): void {
    this.activeTabId = tabId;
    this.tabs.set(tabId, this.currentPage ? { ...this.currentPage } : {
      success: false,
      url: "",
      title: "",
      status: 0,
      bodyPreview: "",
      links: [],
      forms: [],
    });
  }

  switchTab(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    this.activeTabId = tabId;
    this.currentPage = tab;
    return true;
  }

  listTabs(): Array<{ id: string; url: string; title: string }> {
    return Array.from(this.tabs.entries()).map(([id, page]) => ({
      id,
      url: page.url,
      title: page.title,
    }));
  }

  closeTab(tabId: string): boolean {
    if (this.tabs.size <= 1) return false;
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      const first = this.tabs.keys().next().value;
      if (first) {
        this.activeTabId = first;
        this.currentPage = this.tabs.get(first) || null;
      }
    }
    return true;
  }

  async fetchJSON(url: string): Promise<unknown> {
    try {
      const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;
      // 安全：SSRF 校验，防止 JSON 请求到内网/元数据端点
      const ssrfCheck = await this.ssrfProtection.checkURL(normalizedUrl);
      if (!ssrfCheck.allowed) {
        return { error: `Blocked by SSRF protection: ${ssrfCheck.reason}`, url: normalizedUrl };
      }
      const headers: Record<string, string> = {
        "User-Agent": this.userAgent,
        "Accept": "application/json",
      };
      const cookieHeader = this.getCookieHeader();
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
        const redirectSsrf = await this.ssrfProtection.checkURL(redirectUrl);
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

  async searchAndScrape(
    query: string,
    sites: string[] = []
  ): Promise<Array<{ site: string; results: Array<{ title: string; url: string; snippet: string }> }>> {
    const results: Array<{ site: string; results: Array<{ title: string; url: string; snippet: string }> }> = [];

    const searchUrls: Record<string, string> = {
      google: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      bing: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      duckduckgo: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    };

    const targetSites = sites.length > 0
      ? sites.filter((s) => searchUrls[s])
      : ["duckduckgo"];

    for (const site of targetSites) {
      try {
        const url = searchUrls[site];
        if (!url) continue;

        const result = await this.navigate(url);
        if (!result.success) continue;

        const snippets = this.extractSearchSnippets(result.bodyPreview);

        results.push({ site, results: snippets });
      } catch {
        continue;
      }
    }

    return results;
  }

  private extractLinks(html: string): Array<{ text: string; href: string }> {
    const links: Array<{ text: string; href: string }> = [];
    const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
    let match;

    while ((match = regex.exec(html)) !== null) {
      links.push({ text: match[2].trim().slice(0, 100), href: match[1] });
      if (links.length >= 50) break;
    }

    return links;
  }

  private extractForms(html: string): Array<{ action: string; method: string; fields: string[] }> {
    const forms: Array<{ action: string; method: string; fields: string[] }> = [];
    const formRegex = /<form[^>]*>([\s\S]*?)<\/form>/gi;
    let match;

    while ((match = formRegex.exec(html)) !== null) {
      const formTag = match[0];
      const formBody = match[1];
      const actionMatch = formTag.match(/action=["']([^"']*)["']/i);
      const methodMatch = formTag.match(/method=["']([^"']*)["']/i);

      const fieldRegex = /<input[^>]+name=["']([^"']+)["'][^>]*>/gi;
      const fields: string[] = [];
      let fieldMatch;
      while ((fieldMatch = fieldRegex.exec(formBody)) !== null) {
        fields.push(fieldMatch[1]);
      }

      const textareaRegex = /<textarea[^>]+name=["']([^"']+)["'][^>]*>/gi;
      let taMatch;
      while ((taMatch = textareaRegex.exec(formBody)) !== null) {
        fields.push(taMatch[1]);
      }

      forms.push({
        action: actionMatch ? actionMatch[1] : "",
        method: (methodMatch ? methodMatch[1] : "get").toLowerCase(),
        fields,
      });
    }

    return forms;
  }

  private extractSearchSnippets(body: string): Array<{ title: string; url: string; snippet: string }> {
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    const resultRegex = /<a[^>]+class=["']result__a["'][^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
    let match;
    while ((match = resultRegex.exec(body)) !== null) {
      results.push({ title: match[2].trim(), url: match[1], snippet: "" });
    }

    if (results.length === 0) {
      const linkRegex = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([^<]+)<\/a>/gi;
      let lMatch;
      let count = 0;
      while ((lMatch = linkRegex.exec(body)) !== null && count < 15) {
        const text = lMatch[2].trim();
        if (text.length > 5 && !text.includes("<")) {
          results.push({ title: text.slice(0, 100), url: lMatch[1], snippet: "" });
          count++;
        }
      }
    }

    return results.slice(0, 10);
  }

  getCurrentPage(): NavigationResult | null {
    return this.currentPage;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}