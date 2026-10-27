import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import type { AgentModelExecutor } from "@evoclaw/agent";
import type { SkillManager } from "@evoclaw/skills";
import type { ServiceRegistry } from "@evoclaw/core";
import type { BrowserController } from "@evoclaw/infrastructure";
import { extractClaimsFromEvidence } from "@evoclaw/intelligence";
import { fetchJsonFromUrl } from "./browser-tools";
// scrapling_fetch 合并进 web_fetch(action=stealth)；其脚本执行辅助函数复用 shell-media-tools 的实现
import { findPythonPaths, runPythonScriptAsync } from "./shell-media-tools";

// ── HTML entity decoder ──
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (match, n) => {
      const code = Math.min(parseInt(n, 10), 0x10FFFF);
      if (Number.isNaN(code) || code < 0 || code > 0x10FFFF) return match;
      return String.fromCodePoint(code);
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, n) => {
      const code = Math.min(parseInt(n, 16), 0x10FFFF);
      if (Number.isNaN(code) || code < 0 || code > 0x10FFFF) return match;
      return String.fromCodePoint(code);
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&ensp;/g, " ")
    .replace(/&emsp;/g, "  ")
    .replace(/&nbsp;/g, " ")
    .replace(/&thinsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&amp;/g, "&");
}

// ── Clean snippet/title text ──
function cleanText(text: string): string {
  return decodeHtmlEntities(text.replace(/<\/?[^>]+>/g, "").trim().slice(0, 500));
}

async function trySearchBing(q: string, limit: number, ua: string, isChinese: boolean = false, freshness?: string): Promise<{ success?: boolean; results?: Array<{ title: string; url: string; snippet: string }>; error?: string; source?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    timeout.unref?.();
    try {
    const bingHost = isChinese ? "https://cn.bing.com" : "https://www.bing.com";
    let url = `${bingHost}/search?q=${encodeURIComponent(q)}&count=${limit}`;
    if (isChinese) {
      url += "&setlang=zh-CN&cc=cn&qs=n&form=QBRE";
    }
    if (freshness) {
      const bingFreshness = freshness === "pd" ? "day" : freshness === "pw" ? "week" : freshness === "pm" ? "month" : "";
      if (bingFreshness) url += `&filters=ex1:"ez${bingFreshness}"`;
    }
    const response = await fetch(url, {
      headers: { "User-Agent": ua, "Accept": "text/html,application/xhtml+xml", "Accept-Language": isChinese ? "zh-CN,zh;q=0.9,en;q=0.8" : "en-US,en;q=0.9" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) {
      clearTimeout(timeout);
      return { success: false, error: `Bing HTTP ${response.status}` };
    }

    const html = await response.text();
    clearTimeout(timeout);
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    const algoRegex = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let match;
    while ((match = algoRegex.exec(html)) !== null && results.length < limit) {
      const block = match[1];
      const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const snippetMatch = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
        || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (titleMatch) {
        results.push({
          title: cleanText(titleMatch[2]),
          url: titleMatch[1],
          snippet: snippetMatch ? cleanText(snippetMatch[1]) : "",
        });
      }
    }

    if (results.length > 0) return { results, source: isChinese ? "Bing CN" : "Bing" };

    const captionRegex = /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    while ((match = captionRegex.exec(html)) !== null && results.length < limit) {
      const block = match[1];
      const titleMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (titleMatch) {
        results.push({
          title: cleanText(titleMatch[2]),
          url: titleMatch[1],
          snippet: snippetMatch ? cleanText(snippetMatch[1]) : "",
        });
      }
    }

    if (results.length > 0) return { results, source: isChinese ? "Bing CN" : "Bing" };
    return { success: false, error: "No results found in Bing" };
    } finally { clearTimeout(timeout); }
  } catch (err: any) {
    return { success: false, error: err.name === "AbortError" ? "Bing search timed out" : `Bing error: ${err.message || String(err)}` };
  }
}

async function trySearchGoogle(q: string, limit: number, ua: string, freshness?: string): Promise<{ success?: boolean; results?: Array<{ title: string; url: string; snippet: string }>; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    timeout.unref?.();
    try {
    let url = `https://www.google.com/search?q=${encodeURIComponent(q)}&num=${limit}&hl=zh-CN`;
    if (freshness) {
      const tbs = freshness === "pd" ? "qdr:d" : freshness === "pw" ? "qdr:w" : freshness === "pm" ? "qdr:m" : freshness === "py" ? "qdr:y" : "";
      if (tbs) url += `&tbs=${tbs}`;
    }
    const response = await fetch(url, {
      headers: { "User-Agent": ua, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) {
      clearTimeout(timeout);
      return { success: false, error: `Google HTTP ${response.status}` };
    }

    const html = await response.text();
    clearTimeout(timeout);
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    const resultRegex = /<div[^>]*class="[^"]*g[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < limit) {
      const block = match[1];
      const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      const linkMatch = block.match(/<a[^>]*href="\/url\?q=(https?:\/\/[^&"]+)[^"]*"[^>]*>/i)
        || block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/i);
      const snippetMatch = block.match(/<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
        || block.match(/<span[^>]*class="[^"]*aCOpRe[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      if (titleMatch && linkMatch && linkMatch[1] && !linkMatch[1].includes("google.com")) {
        results.push({
          title: cleanText(titleMatch[1]),
          url: linkMatch[1],
          snippet: snippetMatch ? cleanText(snippetMatch[1]) : "",
        });
      }
    }

    if (results.length > 0) return { results };
    return { success: false, error: "No results found in Google" };
    } finally { clearTimeout(timeout); }
  } catch (err: any) {
    return { success: false, error: err.name === "AbortError" ? "Google search timed out" : `Google error: ${err.message || String(err)}` };
  }
}

async function trySearchBaiduHTML(q: string, limit: number, ua: string, freshness?: string): Promise<{ success?: boolean; results?: Array<{ title: string; url: string; snippet: string }>; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    timeout.unref?.();
    try {
    let baiduUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=${limit}`;
    if (freshness) {
      const baiduFreshness: Record<string, string> = { pd: "1", pw: "2", pm: "3", py: "4" };
      const gpc = baiduFreshness[freshness];
      if (gpc) baiduUrl += `&gpc=stf=${gpc}`;
    }
    const response = await fetch(baiduUrl, {
      headers: { "User-Agent": ua, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "zh-CN,zh;q=0.9", "Accept-Encoding": "gzip, deflate" },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      clearTimeout(timeout);
      return { success: false, error: `Baidu HTML HTTP ${response.status}` };
    }

    const html = await response.text();
    clearTimeout(timeout);
    if (html.length < 5000) {
      return { success: false, error: "Baidu returned minimal content (possible anti-bot block)" };
    }

    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const seenUrls = new Set<string>();

    const titleRegex = /<h3[^>]*class="[^"]*(?:t|c-title)[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = titleRegex.exec(html)) !== null && results.length < limit) {
      const url = match[1];
      const title = cleanText(match[2]);
      if (title && url && !url.includes("baidu.com/baidu.php") && !seenUrls.has(url)) {
        seenUrls.add(url);
        results.push({ title, url, snippet: "" });
      }
    }

    if (results.length === 0) {
      const altTitleRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((match = altTitleRegex.exec(html)) !== null && results.length < limit) {
        const url = match[1];
        const title = cleanText(match[2]);
        if (title && url && !url.includes("baidu.com/baidu.php") && !seenUrls.has(url)) {
          seenUrls.add(url);
          results.push({ title, url, snippet: "" });
        }
      }
    }

    const snippetRegex = /<div[^>]*class="[^"]*(?:c-abstract|content-right_[^"]*|c-span-last)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let snippetIdx = 0;
    while ((match = snippetRegex.exec(html)) !== null && snippetIdx < results.length) {
      if (results[snippetIdx].snippet === "") {
        results[snippetIdx].snippet = cleanText(match[1]);
      }
      snippetIdx++;
    }

    if (results.length > 0) return { results };
    return { success: false, error: "No results found in Baidu HTML" };
    } finally { clearTimeout(timeout); }
  } catch (err: any) {
    return { success: false, error: err.name === "AbortError" ? "Baidu HTML search timed out" : `Baidu HTML error: ${err.message || String(err)}` };
  }
}

async function trySearchDDG(q: string, limit: number, ua: string): Promise<{ success?: boolean; results?: Array<{ title: string; url: string; snippet: string }>; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    timeout.unref?.();
    try {
    // Use DuckDuckGo Lite for simpler HTML structure
    const response = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, {
      headers: { "User-Agent": ua, "Accept": "text/html", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      clearTimeout(timeout);
      return { success: false, error: `DuckDuckGo HTTP ${response.status}` };
    }

    const html = await response.text();
    clearTimeout(timeout);
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    // DuckDuckGo Lite results are in <tr class="result-snippet"> blocks
    // containing <a rel="nofollow" href="URL">Title</a> and <td class="result-snippet">snippet</td>
    const rowRegex = /<tr[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
    let match;
    while ((match = rowRegex.exec(html)) !== null && results.length < limit) {
      const row = match[1];
      const linkMatch = row.match(/<a[^>]*rel="nofollow"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
        || row.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const snippetMatch = row.match(/<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
      if (linkMatch && linkMatch[1] && !linkMatch[1].includes("duckduckgo.com")) {
        results.push({
          title: cleanText(linkMatch[2]),
          url: linkMatch[1],
          snippet: snippetMatch ? cleanText(snippetMatch[1]) : "",
        });
      }
    }

    if (results.length > 0) return { results };
    return { success: false, error: "No results found in DuckDuckGo" };
    } finally { clearTimeout(timeout); }
  } catch (err: any) {
    return { success: false, error: err.name === "AbortError" ? "DuckDuckGo search timed out" : `DuckDuckGo error: ${err.message || String(err)}` };
  }
}

export function registerWebTools(
  executor: AgentModelExecutor,
  skillManager: SkillManager,
  registry?: ServiceRegistry,
  browserController?: BrowserController
): void {
  // SSRF 防护：在 fetch 前校验 URL 是否为内网地址，防止 agent 被诱导访问元数据端点等
  const ssrfProtection = registry?.resolveService<{ checkURL(url: string): Promise<{ allowed: boolean; reason?: string }> }>("ssrfProtection");
  const checkSsrf = async (url: string): Promise<string | null> => {
    if (!ssrfProtection) return "SSRF protection service unavailable";
    try {
      const result = await ssrfProtection.checkURL(url);
      if (!result.allowed) return result.reason ?? "blocked by SSRF policy";
      return null;
    } catch {
      return "SSRF check failed";
    }
  };

  // BrowserController 原先只能从 browser-tools 的注册闭包里取；合并后 web_search
  // (action=browser) / web_fetch (action=json) 需要它，故新增可选注入参数，
  // 并保留服务注册表回退（两条路都拿不到时由各 action 的降级分支处理）。
  const resolveBrowserController = (): BrowserController | undefined =>
    browserController ?? registry?.resolveService<BrowserController>("browserController");

  // ============ Web Search & Fetch Tools ============
  // 大部分 action 不依赖浏览器控制器；action=browser / action=json 需要时走上面的解析器

  // ── web_fetch：复合网页抓取工具（action 判别）──
  // 合并自原 web_fetch（通用抓取）、fetch_node_page（新闻预处理取页）、
  // scrapling_fetch（Scrapling 反爬抓取，实现从 shell-media-tools.ts 原样搬来）、
  // browser_fetch_json（浏览器后端取 JSON，实现从 browser-tools.ts 搬来）：
  // 一个工具 + action 字段，保持 schema 紧凑、降低每轮 token 成本。

  /** 原 web_fetch */
  const handleWebFetch = async (params: Record<string, unknown>) => {
    const url = String(params.url || "");
    const format = String(params.format || "text");
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { success: false, error: "Invalid URL format" };
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return { success: false, error: "Only http and https URLs are allowed" };
    }
    // SSRF 防护：校验 URL 不指向内网/元数据端点
    const ssrfReason = await checkSsrf(url);
    if (ssrfReason) {
      return { success: false, error: `URL blocked by security policy: ${ssrfReason}`, url };
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      timeout.unref?.();
      try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; EvoClaw/1.0)",
          "Accept": format === "json" ? "application/json" : "text/html,text/plain,*/*",
        },
        signal: controller.signal,
        redirect: "manual",
      });
      // 处理重定向：对每个 Location 都重新做 SSRF 校验，防止重定向绕过
      let finalResponse = response;
      let redirectUrl = url;
      let redirectCount = 0;
      while ([301, 302, 303, 307, 308].includes(finalResponse.status) && redirectCount < 5) {
        const location = finalResponse.headers.get("location");
        if (!location) break;
        redirectUrl = new URL(location, redirectUrl).href;
        // 重定向目标必须 http/https
        let parsedRedirect: URL;
        try { parsedRedirect = new URL(redirectUrl); } catch { break; }
        if (parsedRedirect.protocol !== "http:" && parsedRedirect.protocol !== "https:") break;
        // 重新 SSRF 校验重定向目标
        const redirectSsrfReason = await checkSsrf(redirectUrl);
        if (redirectSsrfReason) {
          clearTimeout(timeout);
          return { success: false, error: `Redirect blocked by security policy: ${redirectSsrfReason}`, url: redirectUrl };
        }
        finalResponse = await fetch(redirectUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; EvoClaw/1.0)",
            "Accept": format === "json" ? "application/json" : "text/html,text/plain,*/*",
          },
          signal: controller.signal,
          redirect: "manual",
        });
        redirectCount++;
      }
      if (!finalResponse.ok) {
        clearTimeout(timeout);
        return { success: false, error: `HTTP ${finalResponse.status}`, url: redirectUrl };
      }

      if (format === "json") {
        const data = await finalResponse.json();
        clearTimeout(timeout);
        return { url: redirectUrl, status: finalResponse.status, data };
      }

      const text = await finalResponse.text();
      clearTimeout(timeout);
      if (format === "html") {
        return { url: redirectUrl, status: finalResponse.status, html: text.slice(0, 8000), length: text.length };
      }

      // Extract readable text from HTML with full entity decoding
      const plainText = decodeHtmlEntities(
        text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
      ).replace(/\s+/g, " ").trim();

      const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
      return {
        url: redirectUrl,
        title: titleMatch ? titleMatch[1].trim() : redirectUrl,
        status: finalResponse.status,
        text: plainText.slice(0, 5000),
        length: plainText.length,
      };
    } catch (err: any) {
      return { success: false, error: err.name === "AbortError" ? "Request timed out" : (err.message || String(err)), url };
    } finally { clearTimeout(timeout); }
  } catch (err: any) { return { success: false, error: err.message || String(err), url }; }
  };

  /** 原 fetch_node_page */
  const handleFetchNodePage = async (params: Record<string, unknown>) => {
    const url = String(params.url || "");
    const maxLengthRaw = Number(params.maxLength);
    const maxLength = Math.max(1, Number.isFinite(maxLengthRaw) && maxLengthRaw > 0 ? maxLengthRaw : 5000);
    if (!url || !url.startsWith("http")) {
      return { success: false, error: "Valid HTTP/HTTPS URL is required", url };
    }
    // SSRF 防护
    const ssrfReason = await checkSsrf(url);
    if (ssrfReason) {
      return { success: false, error: `URL blocked by security policy: ${ssrfReason}`, url };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    timeout.unref?.();
    try {
      // 安全：使用 redirect: "manual" 并对每个重定向目标重新 SSRF 校验，
      // 防止 302 重定向到内网/元数据端点绕过初始 SSRF 检查
      let currentUrl = url;
      let response = await fetch(currentUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; EvoClaw/1.0)",
          "Accept": "text/html,text/plain,*/*",
        },
        signal: controller.signal,
        redirect: "manual",
      });
      // 跟随重定向（最多 5 次），每次重新校验 SSRF
      let redirectCount = 0;
      while ([301, 302, 303, 307, 308].includes(response.status) && redirectCount < 5) {
        const location = response.headers.get("location");
        if (!location) break;
        currentUrl = new URL(location, currentUrl).href;
        const redirectSsrfReason = await checkSsrf(currentUrl);
        if (redirectSsrfReason) {
          clearTimeout(timeout);
          return { success: false, error: `Redirect blocked by security policy: ${redirectSsrfReason}`, url: currentUrl };
        }
        response = await fetch(currentUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; EvoClaw/1.0)",
            "Accept": "text/html,text/plain,*/*",
          },
          signal: controller.signal,
          redirect: "manual",
        });
        redirectCount++;
      }
      if (!response.ok) {
        clearTimeout(timeout);
        return { success: false, error: `HTTP ${response.status}`, url: currentUrl };
      }
      const text = await response.text();
      clearTimeout(timeout);
      // Full entity decode + strip tags
      const content = decodeHtmlEntities(
        text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
      ).replace(/\s+/g, " ").trim();
      const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
      return {
        url,
        title: titleMatch ? titleMatch[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"') : url,
        content: content.slice(0, maxLength),
        length: content.length,
      };
    } catch (err: any) {
      return { success: false, error: err.name === "AbortError" ? "Request timed out" : (err.message || String(err)), url };
    } finally {
      // 始终清理 timeout，防止非超时错误（如 DNS 失败、连接重置）下 timer 句柄泄漏
      clearTimeout(timeout);
    }
  };

  /** 原 scrapling_fetch（实现原样从 shell-media-tools.ts 搬来；SSRF 校验复用本文件的
   *  checkSsrf，脚本执行复用 shell-media-tools 导出的 findPythonPaths / runPythonScriptAsync） */
  const handleScraplingFetch = async (params: Record<string, unknown>) => {
    const url = String(params.url || "");
    if (!url) return { success: false, error: "URL is required" };
    const selector = params.selector ? String(params.selector) : "";
    const extractLinks = String(params.extractLinks || "") === "true";
    const headless = String(params.headless || "") !== "false";

    // SSRF 防护：阻止访问内网/元数据端点
    const ssrfReason = await checkSsrf(url);
    if (ssrfReason) {
      return { success: false, error: `URL blocked by security policy: ${ssrfReason}`, url };
    }

    const workspaceDir = path.resolve(__dirname, "..", "..", "..", "..", "data", "workspace");
    const pythonPaths = findPythonPaths();
    const existingPath = process.env.PATH || process.env.Path || "";
    const extendedPath = [...pythonPaths, existingPath].join(path.delimiter);

    const script = `#!/usr/bin/env python3
import json, sys
try:
    from scrapling.fetchers import StealthyFetcher
    page = StealthyFetcher.fetch(${JSON.stringify(url)}, headless=${headless ? "True" : "False"})
    result = {
        "title": page.css("title::text").get(""),
        "url": str(page.url),
        "status": page.status,
        "text_preview": page.text_content()[:3000],
    }
    ${selector ? `result["selected"] = [el.text_content().strip()[:500] for el in page.css(${JSON.stringify(selector)})[:10]]` : ""}
    ${extractLinks ? `result["links"] = [{"href": l.attrib.get("href", ""), "text": l.text_content().strip()[:100]} for l in page.css("a[href]")[:30]]` : ""}
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}, ensure_ascii=False))
    sys.exit(1)
`;

    try {
      // Write script to temp file instead of using python -c (which fails with multiline scripts)
      const scriptPath = path.join(workspaceDir, `_scrapling_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.py`);
      fs.writeFileSync(scriptPath, script, "utf-8");
      try {
        const result = await runPythonScriptAsync(
          path.basename(scriptPath),
          workspaceDir,
          { ...process.env, PYTHONIOENCODING: "utf-8", Path: extendedPath, PATH: extendedPath },
          60000,
        );
        const parsed = JSON.parse(result.trim());
        return { success: true, ...parsed };
      } catch (err: any) {
        const stderr = err.stderr?.toString() || err.message || String(err);
        return { success: false, error: stderr.slice(0, 5000) };
      } finally {
        try { fs.unlinkSync(scriptPath); } catch { /* non-critical */ }
      }
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message || String(err);
      return { success: false, error: stderr.slice(0, 5000) };
    }
  };

  /** 原 browser_fetch_json（实现原样从 browser-tools.ts 搬来）
   *  优先用注入/注册的 BrowserController.fetchJSON（自带浏览器 cookie）；
   *  后端不可用时退化到模块级 fetchJsonFromUrl（匿名请求，无 cookie）。 */
  const handleBrowserFetchJson = async (params: Record<string, unknown>) => {
    const url = String(params.url || "");
    if (!url) return { success: false, error: "URL is required" };
    // SSRF 防护：与原 browser_fetch_json 一致，先校验再取数
    const ssrfReason = await checkSsrf(url);
    if (ssrfReason) {
      return { success: false, error: `URL blocked by security policy: ${ssrfReason}`, url };
    }
    const browserCtl = resolveBrowserController();
    if (browserCtl?.fetchJSON) {
      return await browserCtl.fetchJSON(url);
    }
    return await fetchJsonFromUrl(url, {
      checkUrl: async (u) => {
        const r = await checkSsrf(u);
        return r ? { allowed: false, reason: r } : { allowed: true };
      },
    });
  };

  executor.registerTool(
    "web_fetch",
    {
      name: "web_fetch",
      description:
        "复合网页抓取工具（composite web fetch tool），通过 action 参数选择具体操作。" +
        "actions: " +
        "fetch（默认，抓取 URL 并提取可读文本，format 支持 text/html/json；手动跟随重定向且每跳重新做 SSRF 校验） / " +
        "stealth（用 Scrapling StealthyFetcher 抓取，可绕过 Cloudflare 等反爬；selector 提取指定内容，extractLinks 提取链接） / " +
        "json（抓取 API 端点的 JSON 数据，优先走浏览器后端并带浏览器 cookie，后端不可用时退化为匿名请求）",
      parameters: {
        action: {
          type: "string",
          description: "抓取操作类型：fetch（默认）/ stealth / json",
          required: true,
          enum: ["fetch", "stealth", "json"],
        },
        url: { type: "string", description: "要抓取的 URL（fetch / stealth / json 使用）" },
        format: { type: "string", description: "响应格式：'text'（纯文本）、'html'（原始 HTML）、'json'（解析后的 JSON）；默认 'text'（fetch 使用）" },
        selector: { type: "string", description: "可选 CSS 选择器，提取指定内容（stealth 使用）" },
        extractLinks: { type: "string", description: "设为 'true' 提取页面全部链接（stealth 使用）" },
        headless: { type: "string", description: "设为 'false' 使用非 headless 模式（默认 true）（stealth 使用）" },
        maxLength: { type: "number", description: "返回的最大字符数（默认 5000）（fetch 使用；原 fetch_node_page 参数）" },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "fetch");
      if (action === "fetch") return await handleWebFetch(params);
      if (action === "stealth") return await handleScraplingFetch(params);
      if (action === "json") return await handleBrowserFetchJson(params);
      return { success: false, error: `未知 web_fetch action: ${action}（仅支持 fetch / stealth / json）` };
    }
  );

  // ── web_search：复合搜索工具（action 判别）──
  // 合并自原 web_search（多引擎搜索）、grounded_research（带引用的事实核查研究）
  // 与 browser_search（浏览器后端搜索，实现从 browser-tools.ts 搬来）：
  // 一个工具 + action 字段，保持 schema 紧凑、降低每轮 token 成本。

  /** 原 web_search */
  const handleWebSearch = async (params: Record<string, unknown>) => {
    const query = String(params.query || "");
    // 上限 clamp：原先只有下限，模型传 limit:100000 会原样透传给 provider，
    // 造成超量请求/费用浪费与长时间挂起。
    const limitRaw = parseInt(String(params.limit ?? "10"), 10);
    const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10, 50));
    const freshness = String(params.freshness || "");
    if (!query) return { success: false, error: "Search query is required" };

    const optimizeChineseQuery = (q: string): string[] => {
      const queries = [q];
      const techTerms = ["大模型", "LLM", "AI", "人工智能", "深度学习", "机器学习", "神经网络", "GPT", "Claude", "Gemini", "开源模型"];
      const hasTechTerm = techTerms.some(t => q.includes(t));
      if (hasTechTerm) {
        const cleaned = q.replace(/国产/g, "").replace(/中国/g, "").replace(/国内/g, "").trim();
        if (cleaned.length > 2) queries.push(cleaned);
        const withEnglish = q.replace(/大模型/g, "LLM大模型").replace(/性价比/g, "价格 性能 对比").replace(/横评/g, "对比 评测").replace(/评测/g, "评测 对比");
        queries.push(withEnglish);
      }
      return [...new Set(queries)];
    };

    const isChineseQuery = /[\u4e00-\u9fff]/.test(query);
    const searchSkills = isChineseQuery
      ? ["baidu-search", "tavily-search"]
      : ["tavily-search", "baidu-search"];
    for (const skillName of searchSkills) {
      try {
        const skills = await skillManager.listSkills();
        const skill = skills.find((s: { name: string }) => s.name === skillName);
        if (!skill) continue;
        const skillParams: Record<string, unknown> = { query, prompt: query, limit };
        if (freshness) skillParams.freshness = freshness;
        const result = await skillManager.executeSkill(skill.id || skillName, skillParams);
        if (result && result.success && result.output) {
          const outputStr = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
          if (outputStr.length > 50) {
            console.log(`[web_search] Used ${skillName} skill successfully`);
            return { query, source: skillName, count: 1, results: [{ title: `${skillName} result`, url: "", snippet: outputStr.slice(0, 8000) }], rawOutput: result.output };
          }
        }
      } catch (err) {
        console.debug(`[web_search] ${skillName} skill failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    const allQueries = isChineseQuery ? optimizeChineseQuery(query) : [query];
    let allResults: Array<{ title: string; url: string; snippet: string }> = [];
    let usedSource = "";

    const trySearchTavilyAPI = async (searchQuery: string, maxResults: number): Promise<{ results: Array<{ title: string; url: string; snippet: string }> }> => {
      const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey || tavilyKey === "your_api_key") return { results: [] };
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      timeoutId.unref?.();
      try {
        const resp = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: tavilyKey,
            query: searchQuery,
            max_results: maxResults,
            include_answer: false,
            search_depth: "basic",
          }),
          signal: controller.signal,
        });
        if (!resp.ok) return { results: [] };
        const data = await resp.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
        if (!data.results || !Array.isArray(data.results)) return { results: [] };
        return {
          results: data.results
            .filter((r) => r.url)
            .map((r) => ({ title: r.title || "", url: r.url!, snippet: (r.content || "").slice(0, 300) })),
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      return { results: [] };
    }
    };

    for (const q of allQueries) {
      if (allResults.length >= limit) break;

      const addResults = (newResults: Array<{ title: string; url: string; snippet: string }>, source: string) => {
        const seen = new Set(allResults.map(r => r.url));
        for (const r of newResults) {
          if (!seen.has(r.url) && allResults.length < limit) {
            allResults.push(r);
            seen.add(r.url);
          }
        }
        if (!usedSource) usedSource = source;
      };

      if (isChineseQuery) {
        const baiduResult = await trySearchBaiduHTML(q, limit, userAgent, freshness);
        if (baiduResult.results && baiduResult.results.length > 0) {
          addResults(baiduResult.results, "Baidu");
          continue;
        }
      }

      const tavilyResult = await trySearchTavilyAPI(q, limit);
      if (tavilyResult.results && tavilyResult.results.length > 0) {
        addResults(tavilyResult.results, "Tavily");
        continue;
      }

      const bingResult = await trySearchBing(q, limit, userAgent, isChineseQuery, freshness);
      if (bingResult.results && bingResult.results.length > 0) {
        addResults(bingResult.results, bingResult.source || "Bing");
        continue;
      }

      if (!isChineseQuery) {
        const baiduResult = await trySearchBaiduHTML(q, limit, userAgent, freshness);
        if (baiduResult.results && baiduResult.results.length > 0) {
          addResults(baiduResult.results, "Baidu");
          continue;
        }
      }

      const googleResult = await trySearchGoogle(q, limit, userAgent, freshness);
      if (googleResult.results && googleResult.results.length > 0) {
        addResults(googleResult.results, "Google");
        continue;
      }

      const ddgResult = await trySearchDDG(q, limit, userAgent);
      if (ddgResult.results && ddgResult.results.length > 0) {
        addResults(ddgResult.results, "DuckDuckGo");
        continue;
      }
    }

    if (allResults.length > 0) {
      console.log(`[WebSearch] Success: ${allResults.length} results from ${usedSource} for query variants: ${allQueries.join(", ")}`);
      return { query, source: usedSource, count: allResults.length, results: allResults.slice(0, limit) };
    }

    console.warn(`[WebSearch] All search providers failed for query variants: ${allQueries.join(", ")}`);
    const errorMsg = "All search providers failed for all query variants";
    return { success: false, error: errorMsg, query, source: "none", results: [] };
  };

  /** 原 grounded_research（内部 runTool("web_search" / "web_fetch") 仍指向上面的复合工具，
   *  两者默认 action 不变，故编排逻辑无需改动） */
  const handleGroundedResearch = async (params: Record<string, unknown>) => {
    const question = String(params.question || "").trim();
    if (!question) return { success: false, error: "question is required" };
    const maxSources = Math.max(
      1,
      Math.min(parseInt(String(params.maxSources ?? "5"), 10) || 5, 10),
    );
    const maxSearchResults = Math.max(
      1,
      Math.min(parseInt(String(params.maxSearchResults ?? "10"), 10) || 10, 20),
    );

    // Resolve the agent executor's raw tool registry to call web_search/web_fetch
    // by name (skips the LLM loop, reuses registered handlers).
    const executorAny = executor as unknown as {
      registeredTools?: Map<
        string,
        {
          definition: Record<string, unknown>;
          handler: (p: Record<string, unknown>) => Promise<unknown>;
        }
      >;
    };
    const runTool = async (
      name: string,
      p: Record<string, unknown>,
    ): Promise<unknown> => {
      const entry = executorAny.registeredTools?.get(name);
      if (!entry) return { success: false, error: `tool ${name} not registered` };
      try {
        return await entry.handler(p);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    };

    // 1. Search
    const searchRes = (await runTool("web_search", {
      query: question,
      limit: maxSearchResults,
    })) as
      | { results?: Array<{ title: string; url: string; snippet: string }>; success?: boolean; error?: string }
      | undefined;
    const rawResults: Array<{ title: string; url: string; snippet: string }> =
      searchRes?.results ?? [];

    // 2. Fetch top sources for full-text evidence
    const seenUrls = new Set<string>();
    const sources: Array<{
      url: string;
      title: string;
      content: string;
      status: number;
    }> = [];
    for (const r of rawResults) {
      if (sources.length >= maxSources) break;
      if (!r.url || seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);
      const fetchRes = (await runTool("web_fetch", {
        url: r.url,
        format: "text",
      })) as
        | { text?: string; title?: string; status?: number; success?: boolean }
        | undefined;
      const text = (fetchRes?.text ?? "").trim();
      if (text.length > 0) {
        sources.push({
          url: r.url,
          title: fetchRes?.title ?? r.title,
          content: text.slice(0, 4000),
          status: fetchRes?.status ?? 200,
        });
      }
    }

    // 3. Build evidence documents for claim extraction
    const evidenceDocs = sources.map((s, i) => ({
      id: `src-${i + 1}`,
      url: s.url,
      title: s.title,
      content: s.content,
    }));

    // 4. 抽取 + 跨源核实（纯逻辑在 @evoclaw/intelligence；extractClaimsFromEvidence 内部已核实）
    const { claims } = extractClaimsFromEvidence(evidenceDocs, { maxClaims: 30 });

    const totalSources = sources.length;
    const verifiedCount = claims.filter((c) => c.status === "verified").length;
    const contradictedCount = claims.filter((c) => c.status === "contradicted").length;
    const unverifiedCount = claims.length - verifiedCount - contradictedCount;

    return {
      success: true,
      question,
      totalSources,
      totalClaims: claims.length,
      verifiedCount,
      contradictedCount,
      unverifiedCount,
      confidence: totalSources > 0 ? Math.min(1, verifiedCount / Math.max(1, claims.length)) : 0,
      claims,
      sources: sources.map((s) => ({ url: s.url, title: s.title, status: s.status })),
      degraded: totalSources === 0,
    };
  };

  /** 原 browser_search（实现原样从 browser-tools.ts 搬来）
   *  需要 BrowserController；后端不可用时如实报失败，不静默降级。 */
  const handleBrowserSearch = async (params: Record<string, unknown>) => {
    const query = String(params.query || "");
    const sitesStr = String(params.sites || "duckduckgo");
    const sites = sitesStr.split(",").map((s) => s.trim()).filter(Boolean);
    const browserCtl = resolveBrowserController();
    if (!browserCtl?.searchAndScrape) {
      return { success: false, error: "浏览器后端不可用（browserController 未注入/未注册），无法执行 browser 搜索", query };
    }
    return await browserCtl.searchAndScrape(query, sites);
  };

  executor.registerTool(
    "web_search",
    {
      name: "web_search",
      description:
        "复合搜索工具（composite web search tool），通过 action 参数选择具体操作。" +
        "actions: " +
        "search（默认，多引擎搜索：优先 Tavily/Baidu skill，再回退 Bing/Google/DuckDuckGo；支持 freshness 时间过滤） / " +
        "research（带引用的事实核查研究：搜索 → 抓取 top N 源 → 抽取事实声明 → 跨源核实，返回带引用与置信度的证据包） / " +
        "browser（用浏览器后端跨多个搜索引擎搜索并抓取结果）",
      parameters: {
        action: {
          type: "string",
          description: "搜索操作类型：search（默认）/ research / browser",
          required: true,
          enum: ["search", "research", "browser"],
        },
        query: { type: "string", description: "搜索关键词（search / browser 使用）" },
        limit: { type: "number", description: "最大结果数（默认 10，上限 50）（search 使用）" },
        freshness: { type: "string", description: "时间过滤：pd（24h）、pw（7d）、pm（31d）、py（365d）或 YYYY-MM-DDtoYYYY-MM-DD（search 使用）" },
        sites: { type: "string", description: "逗号分隔的搜索引擎（google、bing、duckduckgo）（browser 使用；默认 duckduckgo）" },
        question: { type: "string", description: "要研究的问题（research 使用）" },
        maxSources: { type: "number", description: "抓取用于取证的网页数上限（默认 5，上限 10）（research 使用）" },
        maxSearchResults: { type: "number", description: "考虑的搜索结果数上限（默认 10，上限 20）（research 使用）" },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "search");
      if (action === "search") return await handleWebSearch(params);
      if (action === "research") return await handleGroundedResearch(params);
      if (action === "browser") return await handleBrowserSearch(params);
      return { success: false, error: `未知 web_search action: ${action}（仅支持 search / research / browser）` };
    }
  );
}
