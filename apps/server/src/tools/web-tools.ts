import type { AgentModelExecutor } from "@evoclaw/agent";
import type { SkillManager } from "@evoclaw/skills";
import type { ServiceRegistry } from "@evoclaw/core";

// ── HTML entity decoder ──
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
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
    .replace(/&rdquo;/g, '"');
}

// ── Clean snippet/title text ──
function cleanText(text: string): string {
  return decodeHtmlEntities(text.replace(/<\/?[^>]+>/g, "").trim().slice(0, 500));
}

async function trySearchBing(q: string, limit: number, ua: string, isChinese: boolean = false, freshness?: string): Promise<{ results?: Array<{ title: string; url: string; snippet: string }>; error?: string; source?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
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
      return { error: `Bing HTTP ${response.status}` };
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
    return { error: "No results found in Bing" };
    } finally { clearTimeout(timeout); }
  } catch (err: any) {
    return { error: err.name === "AbortError" ? "Bing search timed out" : `Bing error: ${err.message || String(err)}` };
  }
}

async function trySearchGoogle(q: string, limit: number, ua: string, freshness?: string): Promise<{ results?: Array<{ title: string; url: string; snippet: string }>; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
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
      return { error: `Google HTTP ${response.status}` };
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
    return { error: "No results found in Google" };
    } finally { clearTimeout(timeout); }
  } catch (err: any) {
    return { error: err.name === "AbortError" ? "Google search timed out" : `Google error: ${err.message || String(err)}` };
  }
}

async function trySearchBaiduHTML(q: string, limit: number, ua: string, freshness?: string): Promise<{ results?: Array<{ title: string; url: string; snippet: string }>; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
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
      return { error: `Baidu HTML HTTP ${response.status}` };
    }

    const html = await response.text();
    clearTimeout(timeout);
    if (html.length < 5000) {
      return { error: "Baidu returned minimal content (possible anti-bot block)" };
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
    return { error: "No results found in Baidu HTML" };
    } finally { clearTimeout(timeout); }
  } catch (err: any) {
    return { error: err.name === "AbortError" ? "Baidu HTML search timed out" : `Baidu HTML error: ${err.message || String(err)}` };
  }
}

async function trySearchDDG(q: string, limit: number, ua: string): Promise<{ results?: Array<{ title: string; url: string; snippet: string }>; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
    // Use DuckDuckGo Lite for simpler HTML structure
    const response = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, {
      headers: { "User-Agent": ua, "Accept": "text/html", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      clearTimeout(timeout);
      return { error: `DuckDuckGo HTTP ${response.status}` };
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
    return { error: "No results found in DuckDuckGo" };
    } finally { clearTimeout(timeout); }
  } catch (err: any) {
    return { error: err.name === "AbortError" ? "DuckDuckGo search timed out" : `DuckDuckGo error: ${err.message || String(err)}` };
  }
}

export function registerWebTools(
  executor: AgentModelExecutor,
  skillManager: SkillManager,
  registry?: ServiceRegistry
): void {
  // SSRF 防护：在 fetch 前校验 URL 是否为内网地址，防止 agent 被诱导访问元数据端点等
  const ssrfProtection = registry?.resolveService<{ checkURL(url: string): Promise<{ allowed: boolean; reason?: string }> }>("ssrfProtection");
  const checkSsrf = async (url: string): Promise<string | null> => {
    if (!ssrfProtection) return null;
    try {
      const result = await ssrfProtection.checkURL(url);
      if (!result.allowed) return result.reason ?? "blocked by SSRF policy";
    } catch {
      return null; // SSRF 检查失败时不阻塞（best-effort）
    }
    return null;
  };
  // ============ Web Search & Fetch Tools ============
  // Standalone web tools not requiring browser controller

  executor.registerTool(
    "web_fetch",
    {
      name: "web_fetch",
      description: "Fetch content from a web URL and extract readable text. Use for getting page content, RSS feeds, or API data.",
      parameters: {
        url: { type: "string", description: "The URL to fetch content from" },
        format: { type: "string", description: "Response format: 'text' (plain), 'html' (raw), or 'json' (parsed JSON). Default: 'text'" },
      },
    },
    async (params: Record<string, unknown>) => {
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
        return { error: `URL blocked by security policy: ${ssrfReason}`, url };
      }
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; EvoClaw/1.0)",
            "Accept": format === "json" ? "application/json" : "text/html,text/plain,*/*",
          },
          signal: controller.signal,
          redirect: "follow",
        });
        if (!response.ok) {
          clearTimeout(timeout);
          return { error: `HTTP ${response.status}`, url };
        }

        if (format === "json") {
          const data = await response.json();
          clearTimeout(timeout);
          return { url, status: response.status, data };
        }

        const text = await response.text();
        clearTimeout(timeout);
        if (format === "html") {
          return { url, status: response.status, html: text.slice(0, 8000), length: text.length };
        }

        // Extract readable text from HTML with full entity decoding
        const plainText = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
          .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
          .replace(/&amp;/g, "&")
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
          .replace(/\s+/g, " ")
          .trim();

        const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
        return {
          url,
          title: titleMatch ? titleMatch[1].trim() : url,
          status: response.status,
          text: plainText.slice(0, 5000),
          length: plainText.length,
        };
      } catch (err: any) {
        return { error: err.name === "AbortError" ? "Request timed out" : (err.message || String(err)), url };
      } finally { clearTimeout(timeout); }
    } catch (err: any) { return { error: err.message || String(err), url }; }
    }
  );

  // ── fetch_node_page: internal tool for news pre-processing (fetches page content) ──
  executor.registerTool(
    "fetch_node_page",
    {
      name: "fetch_node_page",
      description: "Fetch a web page URL and extract its text content. Used internally for news/article content extraction.",
      parameters: {
        url: { type: "string", description: "The URL to fetch content from" },
        maxLength: { type: "number", description: "Maximum characters to return (default 5000)" },
      },
    },
    async (params: Record<string, unknown>) => {
      const url = String(params.url || "");
      const maxLength = Math.max(1, Number(params.maxLength) || 5000);
      if (!url || !url.startsWith("http")) {
        return { error: "Valid HTTP/HTTPS URL is required", url };
      }
      // SSRF 防护
      const ssrfReason = await checkSsrf(url);
      if (ssrfReason) {
        return { error: `URL blocked by security policy: ${ssrfReason}`, url };
      }
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; EvoClaw/1.0)",
            "Accept": "text/html,text/plain,*/*",
          },
          signal: controller.signal,
          redirect: "follow",
        });
        if (!response.ok) {
          clearTimeout(timeout);
          return { error: `HTTP ${response.status}`, url };
        }
        const text = await response.text();
        clearTimeout(timeout);
        // Full entity decode + strip tags
        const content = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
          .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
          .replace(/&amp;/g, "&")
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
          .replace(/\s+/g, " ")
          .trim();
        const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
        return {
          url,
          title: titleMatch ? titleMatch[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"') : url,
          content: content.slice(0, maxLength),
          length: content.length,
        };
      } catch (err: any) {
        return { error: err.name === "AbortError" ? "Request timed out" : (err.message || String(err)), url };
      }
    }
  );

  executor.registerTool(
    "web_search",
    {
      name: "web_search",
      description: "Search the web. Tries Tavily/Baidu skills first (higher quality), then falls back to Bing (cn.bing.com for Chinese queries), Google, DuckDuckGo. Returns titles, URLs, and snippets. Supports freshness parameter for time-filtered results.",
      parameters: {
        query: { type: "string", description: "Search query string" },
        limit: { type: "number", description: "Max results (default 10)" },
        freshness: { type: "string", description: "Time filter: pd (24h), pw (7d), pm (31d), py (365d), or YYYY-MM-DDtoYYYY-MM-DD" },
      },
    },
    async (params: Record<string, unknown>) => {
      const query = String(params.query || "");
      const limit = parseInt(String(params.limit || "10"), 10) || 10;
      const freshness = String(params.freshness || "");
      if (!query) return { error: "Search query is required" };

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
          clearTimeout(timeoutId);
          if (!resp.ok) return { results: [] };
          const data = await resp.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
          if (!data.results || !Array.isArray(data.results)) return { results: [] };
          return {
            results: data.results
              .filter((r) => r.url)
              .map((r) => ({ title: r.title || "", url: r.url!, snippet: (r.content || "").slice(0, 300) })),
          };
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
      return { error: errorMsg, query, source: "none", results: [] };
    }
  );
}
