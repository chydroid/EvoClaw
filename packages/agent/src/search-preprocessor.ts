/**
 * Search pre-processing module — extracted from AgentModelExecutor.chat()
 *
 * Handles:
 * 1. TaskClassifier semantic intent detection
 * 2. Keyword-based fallback detection
 * 3. Multi-round search with sub-query generation
 * 4. Multi-round web_search execution
 * 5. Page fetching with fetch_node_page
 * 6. Enhanced message construction (URL priority hints, download task hints, news context injection)
 */

import type { ServiceRegistry } from "@evoclaw/core";
import type { Span } from "@opentelemetry/api";
import type { ToolDefinition, AgentProgressEvent } from "./types";
import { stripWebNoise } from "./text-processor";

// ── Types ──

export interface SearchPreprocessorDeps {
  /** Service registry for resolving TaskClassifier */
  registry: ServiceRegistry;
  /** Registered tools map (needs web_search and fetch_node_page) */
  registeredTools: Map<string, {
    definition: ToolDefinition;
    handler: (params: Record<string, unknown>) => Promise<unknown>;
  }>;
  /** Strip web noise function (defaults to imported stripWebNoise) */
  stripWebNoiseFn?: (input: string) => string;
}

export interface SearchPreprocessResult {
  /** The constructed enhanced message (includes search context + hints) */
  enhancedMessage: string;
  /** Raw search results text (null if no search was performed or no results found) */
  searchResults: string | null;
  /** Whether search was deemed necessary */
  shouldSearch: boolean;
  /** Reason why search was triggered */
  searchReason: string;
}

// ── Sub-query generation ──

function generateSubQueries(query: string): string[] {
  const subQueries: string[] = [query];
  const isChinese = /[\u4e00-\u9fff]/.test(query);

  if (isChinese) {
    const aspectPatterns: Array<{ pattern: RegExp; queries: string[] }> = [
      {
        pattern: /下载|download|爬取|scrape|抓取|小说|novel|批量|下载小说|下载视频/i,
        queries: [
          query.replace(/下载|download|爬取|scrape|抓取|搜索|搜一下|搜|保存.*文件|保存为.*/gi, "") + " 章节列表 目录",
          query.replace(/下载|download|爬取|scrape|抓取|搜索|搜一下|搜|保存.*文件|保存为.*/gi, "") + " 在线阅读",
          query.replace(/下载|download|爬取|scrape|抓取|搜索|搜一下|搜|保存.*文件|保存为.*/gi, "") + " txt下载",
        ],
      },
      {
        pattern: /横评|对比|比较|评测|测评|性价比/i,
        queries: [
          query + " 价格 定价 API",
          query + " 性能 评测 排名",
          query + " 最新 2026",
        ],
      },
      {
        pattern: /大模型|LLM|AI模型/i,
        queries: [
          query.replace(/横评|对比|比较|评测|测评|性价比/g, "") + " 价格表 API定价",
          query.replace(/横评|对比|比较|评测|测评|性价比/g, "") + " benchmark 性能排名",
        ],
      },
      {
        pattern: /报告|分析|调研/i,
        queries: [
          query + " 数据 统计",
          query + " 行业趋势 最新",
        ],
      },
      {
        pattern: /看看|怎么样|如何|好不好|好用吗|值得|评价|评估|介绍|了解|说说|聊聊|讲讲/i,
        queries: [
          query.replace(/你看看|看看如何|怎么样|好不好|好用吗|值得吗|评价|评估/g, "") + " 评测 体验",
          query.replace(/你看看|看看如何|怎么样|好不好|好用吗|值得吗|评价|评估/g, "") + " 最新消息 2026",
        ],
      },
    ];

    for (const { pattern, queries } of aspectPatterns) {
      if (pattern.test(query)) {
        subQueries.push(...queries);
      }
    }

    const modelNames = query.match(/(?:DeepSeek|Qwen|GLM|MiMo|Mimo|Kimi|MiniMax|Seed|混元|Hunyuan|通义|文心|豆包|ChatGLM|Yi|Baichuan)[\s\-]?[Vv]?[\d.]*(?:\s*(?:Pro|Max|Flash|Lite|Plus|Turbo))?/gi);
    if (modelNames && modelNames.length > 0) {
      for (const model of [...new Set(modelNames)]) {
        subQueries.push(`${model} 价格 性能 2026`);
        subQueries.push(`${model} API 定价 benchmark`);
      }
    }
  } else {
    if (/compar|review|benchmark|versus/i.test(query)) {
      subQueries.push(query + " pricing cost API");
      subQueries.push(query + " performance benchmark 2026");
    }
  }

  return [...new Set(subQueries)].slice(0, 3);  // Reduced from 6 to 3 for faster response
}

// ── Main search pre-processing ──

export async function preprocessSearch(
  deps: SearchPreprocessorDeps,
  userMessage: string,
  onProgress?: (event: AgentProgressEvent) => void,
): Promise<{ newsContext: string; searchReason: string; shouldSearch: boolean }> {
  const observability = deps.registry?.resolveService?.("observability") as any;
  const tracing = observability?.getTracingService?.();

  const doPreprocess = async (): Promise<{ newsContext: string; searchReason: string; shouldSearch: boolean }> => {
  const { registry, registeredTools } = deps;
  const stripNoise = deps.stripWebNoiseFn ?? stripWebNoise;

  let newsContext = "";
  let searchReason = "";
  let shouldSearch = false;

  // If user provided a URL, skip search pre-processing entirely
  const userProvidedUrl = /https?:\/\/[^\s<>"']+/i.test(userMessage);

  if (userProvidedUrl) {
    process.stdout.write(`[SearchPreprocessor] User provided URL in message — skipping search pre-processing`);
    return { newsContext, searchReason, shouldSearch };
  }

  // Try to use TaskClassifier for semantic intent detection
  const taskClassifier = registry.resolveService<{
    classify(task: string): { primaryCategory: string; confidence: number; intentSimilarity?: Record<string, number> };
    needsWebSearch(task: string): { needed: boolean; confidence: number; reason: string };
  }>("taskClassifier");

  if (taskClassifier) {
    try {
      const searchCheck = taskClassifier.needsWebSearch(userMessage);
      shouldSearch = searchCheck.needed && searchCheck.confidence > 0.35;
      if (shouldSearch) {
        searchReason = searchCheck.reason;
        process.stdout.write(`[SearchPreprocessor] Semantic intent detection: ${searchCheck.reason} (confidence: ${(searchCheck.confidence * 100).toFixed(0)}%)`);
      }
    } catch (err) {
      process.stderr.write(`[SearchPreprocessor] TaskClassifier failed: ${err}`);
    }
  }

  // Fallback to keyword-based detection if TaskClassifier is not available
  if (!shouldSearch) {
    const lowerMsg = userMessage.toLowerCase();
    const isNewsQuery = (lowerMsg.includes("新闻") || lowerMsg.includes("热搜") || lowerMsg.includes("热点") ||
                        lowerMsg.includes("AI") || lowerMsg.includes("人工智能") || lowerMsg.includes("科技") ||
                        lowerMsg.includes("分析报告") || lowerMsg.includes("发展情况") || lowerMsg.includes("分析") ||
                        lowerMsg.includes("横评") || lowerMsg.includes("评测") || lowerMsg.includes("对比") ||
                        lowerMsg.includes("性价比") || lowerMsg.includes("排名") || lowerMsg.includes("推荐") ||
                        lowerMsg.includes("测评") || lowerMsg.includes("比较")) &&
      (lowerMsg.includes("搜索") || lowerMsg.includes("整理") || lowerMsg.includes("找") || lowerMsg.includes("查") ||
       lowerMsg.includes("分析") || lowerMsg.includes("报告") || lowerMsg.includes("情况") || lowerMsg.includes("做个") ||
       lowerMsg.includes("横评") || lowerMsg.includes("评测") || lowerMsg.includes("对比") || lowerMsg.includes("性价比") ||
       lowerMsg.includes("排名") || lowerMsg.includes("推荐") || lowerMsg.includes("测评") || lowerMsg.includes("比较"));
    const isSearchIntent = /(?:搜索|查找|搜一下|查一下|有没有|最新|最近.*?(?:火|热门|上升|流行)|本周.*?(?:重大|热门|重要)|github.*?(?:开源|项目|上升)|开源.*?项目|比较火|上升快|横评|评测|性价比|排名|对比|测评)/i.test(userMessage);
    const isEvaluationQuery = /(?:看看|怎么样|如何|好不好|好用吗|值得|评价|评估|介绍|了解|说说|聊聊|讲讲|分析下|看下|了解下|介绍下)/i.test(userMessage);
    const isEntityInfoQuery = /(?:情况|信息|动态|新闻|进展|发布|新品|产品|公告|财报|动向|近况|现状|趋势|发展)/i.test(userMessage);
    const isModelOrProductQuery = /(?:模型|大模型|LLM|GPT|Claude|Gemini|Qwen|DeepSeek|Llama|Mistral|MiMo|GLM|文心|通义|千问|豆包|Kimi|MiniMax|百川|Yi|零一|商汤|讯飞|智谱|小米|华为|百度|阿里|腾讯|字节|OpenAI|Anthropic|Google|Meta|Microsoft|NVIDIA|苹果|三星|比亚迪|蔚来|理想|小鹏|大疆|OPPO|vivo|荣耀|中兴)/i.test(userMessage);
    shouldSearch = isNewsQuery || isSearchIntent || (isEvaluationQuery && isModelOrProductQuery) || (isEntityInfoQuery && isModelOrProductQuery);
    searchReason = shouldSearch ? (isSearchIntent ? "搜索意图检测触发" : isEvaluationQuery && isModelOrProductQuery ? "实体评价查询触发" : isEntityInfoQuery && isModelOrProductQuery ? "实体信息查询触发" : "关键词匹配触发") : "";
  }

  if (shouldSearch && registeredTools.has("web_search")) {
    try {
      const searchQuery = userMessage
        .replace(/^(请问|请问一下|麻烦|帮忙|帮我|能不能|可以|请|我想|我想要|我想看|我想了解|我想知道)\s*/g, "")
        .replace(/^(搜索|帮我搜|帮我搜索|帮我查|查一下|搜一下|搜搜|查查)[：:\s]*/i, "")
        .replace(/(并整理后发给我|整理后发给我|整理一下|并整理|并总结|并汇总|是什么|怎么样|有哪些|有没有|的?情况|的?信息).*/i, "")
        .replace(/[？?！!。.，,]+$/g, "")
        .trim();

      const lowerQuery = searchQuery.toLowerCase();
      let freshness: string | undefined;
      if (/(今天|今日|today)/i.test(lowerQuery)) freshness = "pd";
      else if (/(本周|这周|最近|this week)/i.test(lowerQuery)) freshness = "pw";
      else if (/(本月|这个月|this month)/i.test(lowerQuery)) freshness = "pm";
      else if (/\d{4}年/.test(searchQuery) || /最新|current|latest|recent/i.test(lowerQuery)) freshness = "py";

      const subQueries = generateSubQueries(searchQuery);
      process.stdout.write(`[SearchPreprocessor] Multi-round search: ${subQueries.length} sub-queries for "${searchQuery}"`);

      const entry = registeredTools.get("web_search")!;
      let allSearchResults: Array<{ title: string; url: string; snippet: string }> = [];
      let allFetchedContent: Array<{ title: string; url: string; content: string }> = [];
      let searchRound = 0;

      for (const subQ of subQueries) {
        searchRound++;
        onProgress?.({
          type: "tool_call",
          phase: "tool_calling",
          detail: `正在搜索 (第${searchRound}/${subQueries.length}轮): ${subQ}`,
          progress: 20 + searchRound * 5,
          toolName: "web_search",
          toolArgs: { query: subQ, freshness },
        });

        const searchParams: Record<string, unknown> = { query: subQ, limit: 8 };
        if (freshness) searchParams.freshness = freshness;

        try {
          const searchResult = await entry.handler(searchParams);
          const resultObj = typeof searchResult === "object" && searchResult !== null ? (searchResult as Record<string, unknown>) : null;
          const results = (resultObj?.results as Array<{ title: string; url: string; snippet: string }>) || [];

          const seenUrls = new Set(allSearchResults.map(r => r.url));
          for (const r of results) {
            if (!seenUrls.has(r.url)) {
              allSearchResults.push(r);
              seenUrls.add(r.url);
            }
          }

          onProgress?.({
            type: "tool_result",
            phase: "tool_calling",
            detail: `搜索完成 (第${searchRound}轮): 找到 ${results.length} 条结果`,
            progress: 25 + searchRound * 5,
            toolName: "web_search",
            toolResult: `Found ${results.length} results for "${subQ}"`,
          });
        } catch (err) {
          process.stderr.write(`[SearchPreprocessor] Sub-query "${subQ}" failed: ${err}`);
        }
      }

      if (allSearchResults.length > 0) {
        let allNewsContent = `## 搜索关键词: ${subQueries.join(" | ")}\n## 共 ${allSearchResults.length} 条搜索结果:\n\n`;
        allSearchResults.forEach((r, i) => {
          allNewsContent += `### ${i + 1}. ${r.title}\n- URL: ${r.url}\n- 摘要: ${r.snippet}\n\n`;
        });

        // Smart page fetching: skip for download/scrape tasks (Agent will write its own crawler)
        const isDownloadTask = /(?:下载|download|爬取|scrape|抓取|批量|小说|novel|视频|video|mp3|mp4|文件|file)/i.test(userMessage);
        const shouldPrefetchPages = !isDownloadTask;

        if (shouldPrefetchPages && registeredTools.has("fetch_node_page")) {
          const fetchTool = registeredTools.get("fetch_node_page")!;
          const urlsToFetch = allSearchResults
            .filter(r => r.url && r.url.startsWith("http") && !r.url.includes("baidu.com/link"))
            .slice(0, 3);  // Reduced from 8 to 3 for faster response
          let fetchedCount = 0;

          for (const r of urlsToFetch) {
            try {
              onProgress?.({
                type: "tool_call",
                phase: "tool_calling",
                detail: `正在抓取网页内容: ${r.title.slice(0, 40)}`,
                progress: 50 + fetchedCount * 10,
                toolName: "fetch_node_page",
                toolArgs: { url: r.url },
              });

              const fetchResult = await Promise.race([
                fetchTool.handler({ url: r.url, maxLength: 5000 }),
                new Promise<null>((_, reject) => setTimeout(() => reject(new Error("fetch timeout")), 10000)),
              ]);
              const fetchObj = typeof fetchResult === "object" && fetchResult !== null ? (fetchResult as Record<string, unknown>) : null;
              const content = (fetchObj?.content || fetchObj?.text || fetchObj?.body || "") as string;
              const cleanedContent = stripNoise(content);
              if (cleanedContent && cleanedContent.length > 50) {
                fetchedCount++;
                allFetchedContent.push({ title: r.title, url: r.url, content: cleanedContent.slice(0, 5000) });
                allNewsContent += `## 网页正文 ${fetchedCount}: ${r.title}\n${cleanedContent.slice(0, 5000)}\n\n`;
              }
            } catch (fetchErr) {
              process.stderr.write(`[SearchPreprocessor] Failed to fetch URL ${r.url}: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
            }
          }
        }
        newsContext = allNewsContent;
        process.stdout.write(`[SearchPreprocessor] Multi-round search complete: ${subQueries.length} queries, ${allSearchResults.length} results, ${allFetchedContent.length} pages fetched, ${newsContext.length} chars`);
      }
    } catch (err) {
      process.stderr.write(`[SearchPreprocessor] Multi-round search failed: ${err}`);
    }
  }

  return { newsContext, searchReason, shouldSearch };
  }; // end doPreprocess

  if (tracing?.isEnabled()) {
    return tracing.withSpan("search.preprocess", async (span: Span) => {
      span.setAttribute("message.length", userMessage.length);
      return doPreprocess();
    });
  } else {
    return doPreprocess();
  }
}

// ── Enhanced message construction ──

export function buildEnhancedMessage(
  userMessage: string,
  newsContext: string,
  searchReason: string,
  shouldSearch: boolean,
): string {
  const isDownloadTask = /(?:下载|download|爬取|scrape|抓取|批量|小说|novel|视频|video|mp3|mp4|文件|file)/i.test(userMessage);

  // When user provided a URL, inject strong URL-priority guidance
  const userProvidedUrl = /https?:\/\/[^\s<>"']+/i.test(userMessage);
  let urlPriorityHint = "";
  if (userProvidedUrl) {
    const urlMatch = userMessage.match(/https?:\/\/[^\s<>"']+/i);
    const userUrl = urlMatch ? urlMatch[0] : "";
    urlPriorityHint = `\n\n[⚠ 系统检测到用户提供了URL: ${userUrl}。你必须：
1. 直接使用 web_fetch 或 scrapling_fetch 抓取该URL页面内容
2. 分析页面HTML结构，找到章节列表或内容选择器
3. 编写Python爬虫脚本，使用该URL作为起始页
4. 用 shell_exec 运行脚本（timeout: '1200'）
5. 验证输出文件存在，报告文件路径

禁止搜索其他来源！用户已经提供了精确的URL，直接使用它！
禁止说"技术上不可行"或"网站有反爬"——先尝试再说！]`;
  }

  const newsEnhancedMessage = newsContext
    ? isDownloadTask
      ? `${userMessage}\n\n[系统已完成搜索，找到相关资源。你必须立即执行以下步骤：

1. 分析搜索结果中的URL，找到包含章节列表的页面
2. 使用 web_fetch 抓取章节列表页面，分析HTML结构
3. 使用 file_create 创建Python爬虫脚本（requests/BeautifulSoup）
4. 使用 shell_exec 运行脚本
5. 使用 file_list 检查输出的txt文件是否存在
6. 向用户报告文件路径

禁止说"技术上不可行"、"网站有反爬"、"这是商业内容"——这些都是借口。
你必须先尝试，失败后再换方法。不尝试就拒绝是绝对不允许的。
如果搜索2-3次后仍找不到合适的章节页面URL，直接向用户提问，让用户提供网址——这更高效。]

\n\n${newsContext.slice(0, 60000)}`
      : `${userMessage}\n\n[系统已通过${searchReason}完成多轮搜索，共获取了相关资料。请基于以下搜索结果中的真实数据来${userMessage.includes("报告") ? "撰写一份结构清晰的分析报告" : "整理并分析后回复用户"}。

要求：
1. 优先使用搜索结果中的具体数据（价格、评分、排名等），不要使用模糊描述
2. 如有表格数据，请用Markdown表格呈现，包含具体数值
3. 不要声称无法获取实时信息——搜索结果就是实时数据
4. 如果搜索结果中缺少某些信息，请如实说明"在当前搜索结果中未找到"，不要编造数据
5. 报告类任务请包含：核心摘要、详细对比表格、场景化建议、数据来源说明
6. 下载链接格式：请使用标准Markdown链接格式 [点击下载](链接)，例如 [点击下载](/api/files/download/文件名)，确保链接正确包裹在方括号和圆括号中]

\n\n${newsContext.slice(0, 60000)}`
    : shouldSearch
      ? `${userMessage}\n\n[系统提示：自动搜索预处理未能获取到有效结果。你必须使用 web_search 工具进行搜索以获取最新实时信息，绝对不能仅凭训练数据回答。如果 web_search 失败，请尝试 browser_launch + browser_navigate 使用真实浏览器搜索。禁止声称"无法获取实时信息"或"网络访问受限"——你有多种搜索工具可用，必须至少尝试一种。]`
      : userMessage;

  // Append URL priority hint when user provided a URL
  const finalEnhancedMessage = urlPriorityHint
    ? newsEnhancedMessage + urlPriorityHint
    : newsEnhancedMessage;

  if (newsContext) {
    process.stdout.write(`[SearchPreprocessor] News context added: ${newsContext.length} chars`);
  }
  if (urlPriorityHint) {
    process.stdout.write(`[SearchPreprocessor] URL priority hint injected`);
  }

  return finalEnhancedMessage;
}
