export function collapseNewlines(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .replace(/🦞/g, "🧬")
    .trim();
}

export function stripWebNoise(input: string): string {
  if (!input || input.length < 20) return input;
  const originalLen = input.length;

  let text = input;

  if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
    text = compactJson(text);
  } else if (/<[a-zA-Z][^>]*>/.test(text)) {
    text = stripHtml(text);
  }

  text = filterPlainText(text);

  text = normalizeUrls(text);

  text = groupSimilarLines(text);

  text = deduplicateLines(text);

  text = extractCodeSignatures(text);

  text = smartTruncate(text, 8000);

  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  if (originalLen > 200 && text.length < originalLen * 0.95) {
    const savedPct = Math.round((1 - text.length / originalLen) * 100);
    console.debug(`[stripWebNoise] ${originalLen} → ${text.length} chars (saved ${savedPct}%)`);
  }

  return text;
}

/**
 * 智能摘要工具结果，减少 token 用量。
 *
 * 增强策略：
 * 1. web_search: 提取结构化数据（标题+摘要+URL），限制结果数
 * 2. web_fetch/browser: 保留首尾+中间关键段落
 * 3. shell_exec: 保留首尾输出行，压缩重复行
 * 4. email: 保留邮件头+正文摘要
 * 5. JSON结果: 紧凑化+截断长字段
 * 6. 其他: 智能截断保留首尾
 */
export function summarizeToolResult(toolName: string, result: string): string {
  if (!result || result.length < 2000) return result;

  // shell_exec: 保留首尾行，压缩中间重复
  if (toolName === "shell_exec") {
    return summarizeShellOutput(result);
  }

  // web_search 结果：提取结构化数据
  if (toolName === "web_search") {
    return summarizeSearchResults(result);
  }

  // web_fetch / browser 结果：保留首尾+中间关键段落
  if (toolName === "web_fetch" || toolName === "fetch_node_page" || toolName.startsWith("browser_")) {
    return summarizeWebContent(result);
  }

  // email 结果：保留邮件头+正文摘要
  if (toolName.startsWith("email_")) {
    return summarizeEmailResult(result);
  }

  // JSON 结果：紧凑化
  if (result.trimStart().startsWith("{") || result.trimStart().startsWith("[")) {
    const compacted = compactJson(result);
    if (compacted.length < result.length) return compacted;
  }

  // 默认：智能截断并保留首尾重叠
  const maxLen = 8000;
  if (result.length > maxLen) {
    const halfLen = Math.floor(maxLen / 2);
    return result.substring(0, halfLen) + "\n\n... [truncated] ...\n\n" + result.substring(result.length - halfLen);
  }

  return result;
}

/** Summarize shell output: keep first/last lines, compress repeated patterns */
function summarizeShellOutput(result: string): string {
  const maxLen = 8000;
  if (result.length <= maxLen) return result;

  const lines = result.split("\n");
  if (lines.length <= 50) {
    // Not many lines but long content — truncate each line
    return lines.map(l => l.length > 500 ? l.slice(0, 500) + "...[truncated]" : l).join("\n").slice(0, maxLen);
  }

  // Keep first 20 + last 15 lines, summarize middle
  const head = lines.slice(0, 20);
  const tail = lines.slice(-15);
  const middleCount = lines.length - 20 - 15;
  const summary = middleCount > 0
    ? [`  ... [${middleCount} lines omitted, showing first 20 and last 15] ...`]
    : [];
  const combined = [...head, ...summary, ...tail].join("\n");

  if (combined.length > maxLen) {
    const halfLen = Math.floor(maxLen / 2);
    return combined.substring(0, halfLen) + "\n\n... [truncated] ...\n\n" + combined.substring(combined.length - halfLen);
  }
  return combined;
}

/** Summarize search results: extract title+snippet+URL, limit to top results */
function summarizeSearchResults(result: string): string {
  const maxLen = 6000;

  // Try to parse as JSON (structured search results)
  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed)) {
      // Array of search results
      const summarized = parsed.slice(0, 8).map((item: Record<string, unknown>, i: number) => {
        const title = String(item.title || item.name || `Result ${i + 1}`);
        const snippet = String(item.snippet || item.content || item.description || "").slice(0, 200);
        const url = String(item.url || item.link || item.href || "");
        return `${i + 1}. ${title}\n   ${snippet}${url ? `\n   URL: ${url}` : ""}`;
      });
      const totalHint = parsed.length > 8 ? `\n\n... [${parsed.length - 8} more results omitted]` : "";
      return summarized.join("\n\n") + totalHint;
    }
    if (parsed.results && Array.isArray(parsed.results)) {
      const summarized = parsed.results.slice(0, 8).map((item: Record<string, unknown>, i: number) => {
        const title = String(item.title || item.name || `Result ${i + 1}`);
        const snippet = String(item.snippet || item.content || item.description || "").slice(0, 200);
        const url = String(item.url || item.link || item.href || "");
        return `${i + 1}. ${title}\n   ${snippet}${url ? `\n   URL: ${url}` : ""}`;
      });
      const totalHint = parsed.results.length > 8 ? `\n\n... [${parsed.results.length - 8} more results omitted]` : "";
      return summarized.join("\n\n") + totalHint;
    }
  } catch {
    // Not JSON — fall through to text-based extraction
  }

  // Text-based: extract lines with URLs or numbered items
  const lines = result.split("\n");
  const summaryLines: string[] = [];
  for (const line of lines) {
    if (/^\d+\.\s/.test(line) || line.includes("http") || line.startsWith("[") || line.startsWith("*")) {
      summaryLines.push(line.slice(0, 300));
    }
  }
  if (summaryLines.length > 0 && summaryLines.length < lines.length) {
    const combined = summaryLines.join("\n");
    return combined.length > maxLen ? combined.slice(0, maxLen) + "\n\n... [truncated]" : combined;
  }

  return result.length > maxLen ? result.slice(0, maxLen) + "\n\n... [truncated]" : result;
}

/** Summarize web content: keep first/last + key paragraphs in the middle */
function summarizeWebContent(result: string): string {
  const maxLen = 6000;
  if (result.length <= maxLen) return result;

  // Try JSON first
  try {
    const parsed = JSON.parse(result);
    if (typeof parsed === "object" && parsed !== null) {
      const r = parsed as Record<string, unknown>;
      // For web fetch results, keep content summary
      if (typeof r.content === "string" && r.content.length > maxLen) {
        r.content = summarizeTextBody(r.content, maxLen);
      }
      if (typeof r.text === "string" && r.text.length > maxLen) {
        r.text = summarizeTextBody(r.text, maxLen);
      }
      const compacted = JSON.stringify(r);
      return compacted.length < result.length ? compacted : result.slice(0, maxLen);
    }
  } catch {
    // Not JSON
  }

  // Plain text: summarize body
  return summarizeTextBody(result, maxLen);
}

/** Summarize a text body: keep first N chars + last M chars + key paragraphs */
function summarizeTextBody(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  const paragraphs = text.split(/\n\n+/);
  if (paragraphs.length <= 5) {
    // Few paragraphs but long — truncate first and last
    const firstPart = text.substring(0, Math.floor(maxLen * 0.6));
    const lastPart = text.substring(text.length - Math.floor(maxLen * 0.3));
    return firstPart + "\n\n... [content truncated] ...\n\n" + lastPart;
  }

  // Many paragraphs: keep first 2, last 1, and sample middle ones
  const head = paragraphs.slice(0, 2).join("\n\n");
  const tail = paragraphs[paragraphs.length - 1];
  const middleParagraphs = paragraphs.slice(2, -1);

  // Sample every Nth middle paragraph
  const sampleRate = Math.max(1, Math.floor(middleParagraphs.length / 3));
  const sampledMiddle = middleParagraphs
    .filter((_, i) => i % sampleRate === 0)
    .map(p => p.slice(0, 200))
    .join("\n\n");

  const combined = head + "\n\n... [middle content sampled] ...\n\n" + sampledMiddle + "\n\n... [content truncated] ...\n\n" + tail;
  return combined.length > maxLen ? combined.slice(0, maxLen) : combined;
}

/** Summarize email results: keep headers + body summary */
function summarizeEmailResult(result: string): string {
  const maxLen = 6000;
  if (result.length <= maxLen) return result;

  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed)) {
      // Array of emails — keep subject + from + date + first 100 chars of body
      const summarized = parsed.slice(0, 10).map((email: Record<string, unknown>, i: number) => {
        const subject = String(email.subject || "(no subject)");
        const from = String(email.from || email.sender || "");
        const date = String(email.date || email.receivedAt || "");
        const body = String(email.body || email.text || email.content || "").slice(0, 150);
        return `${i + 1}. [${date}] ${from}: ${subject}\n   ${body}${body.length >= 150 ? "..." : ""}`;
      });
      const totalHint = parsed.length > 10 ? `\n\n... [${parsed.length - 10} more emails omitted]` : "";
      return summarized.join("\n\n") + totalHint;
    }
  } catch {
    // Not JSON
  }

  return result.length > maxLen ? result.slice(0, maxLen) + "\n\n... [truncated]" : result;
}

export function stripHtml(input: string): string {
  let text = input;

  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "");
  text = text.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, "");
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<form[^>]*>[\s\S]*?<\/form>/gi, "");
  text = text.replace(/<button[^>]*>[\s\S]*?<\/button>/gi, "");
  text = text.replace(/<input[^>]*\/?>/gi, "");
  text = text.replace(/<select[^>]*>[\s\S]*?<\/select>/gi, "");
  text = text.replace(/<textarea[^>]*>[\s\S]*?<\/textarea>/gi, "");
  text = text.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "");

  text = text.replace(/\bclass\s*=\s*["'][^"']*["']/gi, "");
  text = text.replace(/\bid\s*=\s*["'][^"']*["']/gi, "");
  text = text.replace(/\bstyle\s*=\s*["'][^"']*["']/gi, "");
  text = text.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, "");
  text = text.replace(/\bdata-\w+\s*=\s*["'][^"']*["']/gi, "");
  text = text.replace(/\bhref\s*=\s*["']javascript:[^"']*["']/gi, "");
  text = text.replace(/\btarget\s*=\s*["'][^"']*["']/gi, "");
  text = text.replace(/\brel\s*=\s*["'][^"']*["']/gi, "");
  text = text.replace(/\brole\s*=\s*["'][^"']*["']/gi, "");
  text = text.replace(/\baria-\w+\s*=\s*["'][^"']*["']/gi, "");

  text = text.replace(/<\/?(?:div|span|section|article|main|figure|figcaption|details|summary|time|mark|small|strong|em|b|i|u|sub|sup|abbr|cite|dfn|kbd|samp|var|address|blockquote|pre|code|dl|dt|dd|ol|ul|li|table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col|form|input|button|select|option|textarea|label|fieldset|legend)\b[^>]*>/gi, (match) => {
    if (/^<\/?(?:p|h[1-6]|div|li|tr|blockquote|pre|dt|dd)\b/i.test(match)) return "\n";
    return "";
  });

  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
    const prefix = "#".repeat(parseInt(level, 10));
    return `\n${prefix} ${content.trim()}\n`;
  });
  text = text.replace(/<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
    const label = content.replace(/<[^>]+>/g, "").trim();
    return label && href && !href.startsWith("#") ? `[${label}](${href})` : label;
  });
  text = text.replace(/<img[^>]*alt\s*=\s*["']([^"']*)["'][^>]*\/?>/gi, (_, alt) => alt ? `[图片: ${alt}]` : "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

  text = text.replace(/<[^>]+>/g, "");

  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&#\d+;/g, "");
  text = text.replace(/&\w+;/g, "");

  text = text.replace(/\{[^}]*(?:color|background|font|margin|padding|border|display|position|width|height|overflow|flex|grid|align|justify|gap|opacity|z-index|transition|animation|transform|box-shadow|text-shadow|cursor|outline|visibility|float|clear|content|list-style|white-space|word-break|line-height|letter-spacing|vertical-align)[^}]*\}/gi, "");

  const codeBlockPlaceholders: string[] = [];
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlockPlaceholders.push(match);
    return `\x00CODEBLOCK${codeBlockPlaceholders.length - 1}\x00`;
  });

  text = text.replace(/\/\/[^\n]*$/gm, "");
  text = text.replace(/\/\*[\s\S]*?\*\//g, "");
  text = text.replace(/\b(function|var|let|const|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|this|class|extends|import|export|default|from|async|await|yield|typeof|instanceof|void|delete|in|of)\b[^;{}]*[;{}]/g, "");
  text = text.replace(/\b(window|document|console|navigator|localStorage|sessionStorage|fetch|XMLHttpRequest|addEventListener|querySelector|getElementById|createElement|appendChild|removeChild|setAttribute|getAttribute|classList|innerHTML|textContent|innerText|style|dataset)\b\.?\w*\s*[\(\[=;{]/g, "");

  text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => codeBlockPlaceholders[parseInt(idx, 10)] || "");

  text = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  text = text.replace(/\u200B|\u200C|\u200D|\uFEFF/g, "");

  return text;
}

export function compactJson(input: string): string {
  try {
    const obj = JSON.parse(input);
    return compactJsonValue(obj, 0);
  } catch {
    let text = input;
    text = text.replace(/"[^"]*"\s*:\s*"[^"]{200,}"/g, (match) => {
      const colonIdx = match.indexOf(":");
      const key = match.slice(0, colonIdx).trim();
      return `${key}: "..."`;
    });
    text = text.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{50,}/g, "data:image/[base64-truncated]");
    return text;
  }
}

export function compactJsonValue(obj: unknown, depth: number): string {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj === "string") {
    if (obj.length > 500 && (obj.includes("<") && obj.includes(">"))) {
      return JSON.stringify(stripHtml(obj).slice(0, 300) + "...");
    }
    if (obj.length > 2000) {
      const truncated = smartTruncateString(obj, 200);
      return JSON.stringify(truncated + `...[truncated ${obj.length} chars]`);
    }
    return JSON.stringify(obj);
  }
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    if (obj.length > 10) {
      const sample = obj.slice(0, 3).map(v => compactJsonValue(v, depth + 1));
      return `[\n  ${sample.join(",\n  ")},\n  ... /* ${obj.length - 3} more items */\n]`;
    }
    const items = obj.map(v => compactJsonValue(v, depth + 1));
    return `[\n  ${items.join(",\n  ")}\n]`;
  }

  if (typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0) return "{}";

    const skipKeys = new Set([
      "css", "styles", "style", "class", "className", "id", "onclick",
      "script", "javascript", "html", "rawHtml", "innerHTML",
      "tracking", "analytics", "ads", "advertisement", "cookie",
      "favicon", "icon", "logo", "thumbnail", "avatar", "banner",
      "sidebar", "footer", "header", "nav", "menu", "breadcrumb",
    ]);

    const entries: string[] = [];
    for (const key of keys) {
      if (skipKeys.has(key.toLowerCase())) continue;
      const val = record[key];
      if (val === null || val === undefined || val === "") continue;
      if (typeof val === "string" && val.length > 2000) {
        const truncated = smartTruncateString(val, 200);
        entries.push(`  ${JSON.stringify(key)}: ${JSON.stringify(truncated + "...[truncated]")}`);
      } else if (typeof val === "object" && val !== null) {
        entries.push(`  ${JSON.stringify(key)}: ${compactJsonValue(val, depth + 1)}`);
      } else {
        entries.push(`  ${JSON.stringify(key)}: ${JSON.stringify(val)}`);
      }
    }
    return `{\n${entries.join(",\n")}\n}`;
  }

  return String(obj);
}

export function smartTruncateString(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;

  const repeatMatch = str.match(/^(.{1,20})\1{4,}$/);
  if (repeatMatch) {
    return repeatMatch[1].slice(0, Math.min(50, repeatMatch[1].length));
  }

  const sentenceBreakers = /[。！？.!?\n]/;
  let cutPos = maxLen;
  for (let i = maxLen; i > Math.floor(maxLen * 0.6) && i > 0; i--) {
    if (sentenceBreakers.test(str[i])) {
      cutPos = i + 1;
      break;
    }
  }
  return str.slice(0, cutPos);
}

export function filterPlainText(text: string): string {
  let result = text;

  result = result.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

  result = result.replace(/\[=+\]\s*\d*%?/g, "");
  result = result.replace(/\[[.#*\-]+\]\s*\d*%?/g, "");

  result = result.replace(/[=\-#*~]{5,}/g, "");

  result = result.replace(/[█▓▒░]{3,}/g, "");

  result = result.replace(/(?:accept\s+cookies|we\s+use\s+cookies|this\s+site\s+uses\s+cookies|cookie\s+policy|privacy\s+preferences|manage\s+preferences|do\s+not\s+sell\s+my|california\s+consumer|gdpr|consent\s+to\s+.*?cookies|by\s+continuing\s+to\s+use|by\s+clicking\s+accept|our\s+privacy\s+policy|terms\s+of\s+service|subscribe\s+to\s+our\s+newsletter|sign\s+up\s+for\s+our|enter\s+your\s+email|get\s+notified|follow\s+us\s+on|share\s+this\s+article|related\s+articles|you\s+may\s+also\s+like|recommended\s+for\s+you|trending\s+now|popular\s+posts|advertisement|sponsored\s+content|paid\s+partnership)[\s\S]*?(?:\n|$)/gi, "");

  result = result.replace(/(?:接受cookie|我们使用cookie|本站使用cookie|cookie政策|隐私偏好|管理偏好|不要出售我的|消费者隐私|订阅我们的|注册获取|输入您的邮箱|关注我们|分享本文|相关文章|您可能还喜欢|为您推荐|热门文章|广告|赞助内容|付费合作)[\s\S]*?(?:\n|$)/gi, "");

  result = result.replace(/^\s*(?:share|tweet|pin|like|follow|email\s*this|print)\s*$/gim, "");

  result = result.replace(/^\s*(?:分享|推特|点赞|关注|邮件|打印)\s*$/gim, "");

  result = result.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?\s*(?:ET|PT|CT|MT|GMT|UTC|CST|EST|PST)\b/g, "");

  result = result.replace(/^\s*(?:loading|please\s+wait|just\s+a\s+moment|one\s+moment|loading\.\.\.|loading\.\.\.\s*please\s+wait)\s*$/gim, "");

  result = result.replace(/^\s*(?:加载中|请稍候|稍等|正在加载|加载中\.\.\.\s*请稍候|加载中\.\.\.)\s*$/gim, "");

  result = result.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{20,}/g, "[image-data-removed]");

  return result;
}

export function normalizeUrls(text: string): string {
  const strictTrackingParams = [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "gclsrc", "dclid", "msclkid",
    "mc_eid", "mc_cid", "_ga", "_gl", "_hsenc", "_hsmi", "_openstat",
    "vero_id", "oly_anon_id", "oly_enc_id", "otc", "igshid",
    "wickedid", "twclid", "ttclid", "li_fat_id",
  ];
  const strictPattern = new RegExp(
    `[?&](?:${strictTrackingParams.join("|")})=[^&\\s#]+`, "gi"
  );
  let result = text.replace(strictPattern, "");

  const contextTrackingParams = ["spm", "from", "ref", "referrer", "source", "share"];
  const contextPattern = new RegExp(
    `[?&](?:${contextTrackingParams.join("|")})=([^&\\s#]+)`, "gi"
  );
  result = result.replace(contextPattern, (match, val) => {
    const v = val.toLowerCase();
    const businessValues = ["api", "embed", "direct", "app", "cli", "sdk", "web", "desktop",
      "mobile", "internal", "oauth", "callback", "webhook", "feed", "rss", "atom"];
    if (businessValues.some(bv => v === bv)) return match;
    const shortValues = ["nav", "footer", "header", "sidebar", "banner", "popup", "modal",
      "tooltip", "notification", "email", "social", "twitter", "facebook", "wechat",
      "weibo", "linkedin", "reddit", "hackernews", "newsletter", "blog", "article",
      "search", "google", "bing", "baidu", "organic", "cpc", "paid", "affiliate"];
    if (shortValues.some(sv => v.includes(sv))) return "";
    return "";
  });

  result = result.replace(/\?[&]+/g, "?");
  result = result.replace(/\?(\s|$)/g, "$1");
  result = result.replace(/&{2,}/g, "&");
  result = result.replace(/[?&]\s*$/gm, "");
  return result;
}

export function groupSimilarLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length < 8) return text;

  const errorPattern = /^(?:error|warning|fail|exception|err|错误|警告|异常)\s*[:：]\s*(.+)$/i;
  const logPattern = /^(\d{4}[-/]\d{2}[-/]\d{2}[\sT]\d{2}:\d{2}(:\d{2})?)\s+\[?(\w+)\]?\s+(.+)$/;

  const groups: Map<string, { pattern: string; count: number; example: string; firstOutput: boolean }> = new Map();
  const result: string[] = [];
  let inGroup = false;
  let groupKey = "";

  const flushGroup = () => {
    if (!inGroup) return;
    const g = groups.get(groupKey);
    if (g && g.count > 1) {
      result.push(g.example);
      result.push(`  ... (${g.count} similar ${g.pattern} messages)`);
    } else if (g && g.count === 1) {
      result.push(g.example);
    }
    groups.delete(groupKey);
    inGroup = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushGroup();
      result.push("");
      continue;
    }

    const errorMatch = trimmed.match(errorPattern);
    if (errorMatch) {
      const msgBody = errorMatch[1].replace(/\d+/g, "N").replace(/['"][^'"]+['"]/g, "'...'").slice(0, 60);
      const key = `error:${msgBody}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        inGroup = true;
        groupKey = key;
        continue;
      } else {
        flushGroup();
        groups.set(key, { pattern: "error/warning", count: 1, example: trimmed, firstOutput: true });
        inGroup = true;
        groupKey = key;
        continue;
      }
    }

    const logMatch = trimmed.match(logPattern);
    if (logMatch) {
      const level = logMatch[3];
      const msgBody = logMatch[4].replace(/\d+/g, "N").replace(/['"][^'"]+['"]/g, "'...'").slice(0, 60);
      const key = `log:${level}:${msgBody}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        inGroup = true;
        groupKey = key;
        continue;
      } else {
        flushGroup();
        groups.set(key, { pattern: `${level} log`, count: 1, example: trimmed, firstOutput: true });
        inGroup = true;
        groupKey = key;
        continue;
      }
    }

    flushGroup();
    result.push(line);
  }

  flushGroup();

  const phase1 = result.join("\n");
  const phase1Lines = phase1.split("\n");

  const globalGroups: Map<string, { pattern: string; count: number; example: string; lineIndices: number[] }> = new Map();
  for (let i = 0; i < phase1Lines.length; i++) {
    const trimmed = phase1Lines[i].trim();
    if (!trimmed) continue;

    const errM = trimmed.match(errorPattern);
    if (errM) {
      const msgBody = errM[1].replace(/\d+/g, "N").replace(/['"][^'"]+['"]/g, "'...'").slice(0, 60);
      const key = `gerror:${msgBody}`;
      const g = globalGroups.get(key);
      if (g) { g.count++; g.lineIndices.push(i); }
      else globalGroups.set(key, { pattern: "error/warning", count: 1, example: trimmed, lineIndices: [i] });
      continue;
    }

    const logM = trimmed.match(logPattern);
    if (logM) {
      const level = logM[3];
      const msgBody = logM[4].replace(/\d+/g, "N").replace(/['"][^'"]+['"]/g, "'...'").slice(0, 60);
      const key = `glog:${level}:${msgBody}`;
      const g = globalGroups.get(key);
      if (g) { g.count++; g.lineIndices.push(i); }
      else globalGroups.set(key, { pattern: `${level} log`, count: 1, example: trimmed, lineIndices: [i] });
      continue;
    }
  }

  const linesToRemove = new Set<number>();
  const globalInserts: Map<number, string[]> = new Map();
  for (const [, g] of globalGroups) {
    if (g.count >= 3) {
      const firstIdx = g.lineIndices[0];
      for (let j = 1; j < g.lineIndices.length; j++) {
        linesToRemove.add(g.lineIndices[j]);
      }
      if (!globalInserts.has(firstIdx)) globalInserts.set(firstIdx, []);
      globalInserts.get(firstIdx)!.push(`  ... [global] ${g.count} similar ${g.pattern} messages across sections`);
    }
  }

  if (linesToRemove.size > 0) {
    const finalLines: string[] = [];
    for (let i = 0; i < phase1Lines.length; i++) {
      if (linesToRemove.has(i)) continue;
      const inserts = globalInserts.get(i);
      if (inserts) {
        finalLines.push(phase1Lines[i]);
        finalLines.push(...inserts);
      } else {
        finalLines.push(phase1Lines[i]);
      }
    }
    return finalLines.join("\n");
  }

  return phase1;
}

export function extractCodeSignatures(text: string): string {
  const codeBlockPattern = /```(\w*)\n([\s\S]*?)```/g;
  let result = text;

  result = result.replace(codeBlockPattern, (match, lang, code) => {
    const lines = code.split("\n");

    const langThresholds: Record<string, number> = {
      python: 25, py: 25,
      rust: 25, rs: 25,
      go: 25,
      java: 25,
      kotlin: 25, kt: 25,
      scala: 25,
      c: 25, cpp: 25, cxx: 25, h: 25,
      typescript: 20, ts: 20, tsx: 20,
      javascript: 20, js: 20, jsx: 20,
      ruby: 20, rb: 20,
      php: 20,
      sql: 20,
      shell: 15, bash: 15, sh: 15, zsh: 15,
      yaml: 15, yml: 15,
      json: 15,
      xml: 15,
      html: 15,
      css: 15, scss: 15, less: 15,
    };
    const threshold = langThresholds[lang.toLowerCase()] || 20;
    if (lines.length <= threshold) return match;

    const signatures: { start: number; end: number }[] = [];
    let braceDepth = 0;
    let sigStart = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const openBraces = (line.match(/\{/g) || []).length;
      const closeBraces = (line.match(/\}/g) || []).length;

      const isSignatureStart = openBraces > 0 ||
        /^(?:export\s+)?(?:function|class|interface|type|enum|const|let|var|def|async|pub\s+fn|fn|impl|mod|struct|trait|public|private|protected|static)\s/.test(trimmed) ||
        /^(?:def|class|async\s+def)\s/.test(trimmed);

      if (sigStart === -1 && isSignatureStart && braceDepth === 0) {
        sigStart = i;
      }

      if (sigStart !== -1) {
        braceDepth += openBraces - closeBraces;
        if (braceDepth <= 0 && openBraces > 0) {
          signatures.push({ start: sigStart, end: i + 1 });
          sigStart = -1;
          braceDepth = 0;
        }
      }
    }

    if (sigStart !== -1) {
      signatures.push({ start: sigStart, end: Math.min(sigStart + 5, lines.length) });
    }

    const maxSigs = 3;
    const keptSigs = signatures.slice(0, maxSigs);
    if (keptSigs.length === 0) return match;

    const keptRanges: Set<number> = new Set();
    for (const sig of keptSigs) {
      for (let i = sig.start; i < sig.end; i++) keptRanges.add(i);
    }

    const tailCount = 3;
    for (let i = Math.max(0, lines.length - tailCount); i < lines.length; i++) {
      keptRanges.add(i);
    }

    keptRanges.add(0);

    const outputLines: string[] = [];
    let inOmitted = false;
    let omittedCount = 0;

    for (let i = 0; i < lines.length; i++) {
      if (keptRanges.has(i)) {
        if (inOmitted) {
          outputLines.push(`  // ... ${omittedCount} lines omitted ...`);
          inOmitted = false;
          omittedCount = 0;
        }
        outputLines.push(lines[i]);
      } else {
        omittedCount++;
        if (!inOmitted) inOmitted = true;
      }
    }

    if (inOmitted) {
      outputLines.push(`  // ... ${omittedCount} lines omitted ...`);
    }

    return `\`\`\`${lang}\n${outputLines.join("\n")}\n\`\`\``;
  });

  return result;
}

export function deduplicateLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length < 5) return text;

  const result: string[] = [];
  let prevLine = "";
  let repeatCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (repeatCount > 0) {
        result.push(`  (×${repeatCount})`);
        repeatCount = 0;
      }
      result.push("");
      prevLine = "";
      continue;
    }

    if (trimmed === prevLine) {
      repeatCount++;
    } else {
      if (repeatCount > 0) {
        result.push(`  (×${repeatCount})`);
        repeatCount = 0;
      }
      result.push(line);
      prevLine = trimmed;
    }
  }

  if (repeatCount > 0) {
    result.push(`  (×${repeatCount})`);
  }

  return result.join("\n");
}

export function smartTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  const headLen = Math.floor(maxLen * 0.7);
  const tailLen = maxLen - headLen - 50;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  return `${head}\n\n... [truncated ${text.length - maxLen} chars] ...\n\n${tail}`;
}
