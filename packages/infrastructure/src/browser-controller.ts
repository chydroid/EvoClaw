import { ServiceRegistry, EventBus } from "@evoclaw/core";

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

export class BrowserController {
  private cookies: Map<string, string> = new Map();
  private userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 EvoClaw/1.0";
  private currentPage: NavigationResult | null = null;
  private tabs: Map<string, NavigationResult> = new Map();
  private activeTabId: string = "default";

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  setUserAgent(ua: string): void {
    this.userAgent = ua;
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  private getCookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  async navigate(url: string): Promise<NavigationResult> {
    try {
      const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;

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
        redirect: "follow",
      });

      const body = await response.text();

      const titleMatch = body.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : normalizedUrl;

      const setCookie = response.headers.get("set-cookie");
      if (setCookie) {
        const match = setCookie.match(/^([^=]+)=([^;]+)/);
        if (match) {
          this.cookies.set(match[1], match[2]);
        }
      }

      const links = this.extractLinks(body);
      const forms = this.extractForms(body);

      const bodyText = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const bodyPreview = bodyText.slice(0, 2000);

      const result: NavigationResult = {
        success: response.ok,
        url: normalizedUrl,
        title,
        status: response.status,
        bodyPreview,
        links,
        forms,
      };

      this.currentPage = result;
      this.tabs.set(this.activeTabId, result);

      this.eventBus?.publish(
        "browser.navigated",
        { url: normalizedUrl, status: response.status, title },
        "browser-controller"
      );

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
      const regex = new RegExp(`class=["'][^"']*\\b${className}\\b[^"']*["']`, "gi");
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
      const regex = new RegExp(`id=["']${id}["']`, "gi");
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
      const tagRegex = new RegExp(`<${selector}[^>]*>.*?</${selector}>| <${selector}[^>]*/>`, "gis");
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

      const headers: Record<string, string> = {
        "User-Agent": this.userAgent,
        "Content-Type": formData.method === "post" ? "application/x-www-form-urlencoded" : "text/plain",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      };

      const cookieHeader = this.getCookieHeader();
      if (cookieHeader) headers["Cookie"] = cookieHeader;

      const method = formData.method || "get";
      let response: Response;

      if (method === "post") {
        const body = new URLSearchParams(formData.fields).toString();
        response = await fetch(url, { method: "POST", headers, body });
      } else {
        const params = new URLSearchParams(formData.fields).toString();
        response = await fetch(`${url}?${params}`, { method: "GET", headers });
      }

      const body = await response.text();
      const titleMatch = body.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : url;
      const bodyText = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const bodyPreview = bodyText.slice(0, 2000);

      const result: NavigationResult = {
        success: response.ok,
        url,
        title,
        status: response.status,
        bodyPreview,
        links: this.extractLinks(body),
        forms: this.extractForms(body),
      };

      this.currentPage = result;

      this.eventBus?.publish(
        "browser.form_submitted",
        { url, method, status: response.status },
        "browser-controller"
      );

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
      const headers: Record<string, string> = {
        "User-Agent": this.userAgent,
        "Accept": "application/json",
      };
      const cookieHeader = this.getCookieHeader();
      if (cookieHeader) headers["Cookie"] = cookieHeader;

      const response = await fetch(normalizedUrl, { headers });
      if (!response.ok) {
        return { error: `HTTP ${response.status}`, url: normalizedUrl };
      }
      return await response.json();
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
    const formRegex = /<form[^>]*>/gi;
    let match;

    while ((match = formRegex.exec(html)) !== null) {
      const formTag = match[0];
      const actionMatch = formTag.match(/action=["']([^"']*)["']/i);
      const methodMatch = formTag.match(/method=["']([^"']*)["']/i);

      const fieldRegex = /<input[^>]+name=["']([^"']+)["'][^>]*>/gi;
      const fields: string[] = [];
      let fieldMatch;
      while ((fieldMatch = fieldRegex.exec(html)) !== null) {
        fields.push(fieldMatch[1]);
      }

      const textareaRegex = /<textarea[^>]+name=["']([^"']+)["'][^>]*>/gi;
      let taMatch;
      while ((taMatch = textareaRegex.exec(html)) !== null) {
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