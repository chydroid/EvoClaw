/**
 * Registry for predefined tool chains with keyword-based lookup.
 */

import type { ToolChainDefinition } from './tool-chain';

export class ToolChainRegistry {
  private readonly chains = new Map<string, ToolChainDefinition>();

  register(chain: ToolChainDefinition): void {
    this.chains.set(chain.name, chain);
  }

  get(name: string): ToolChainDefinition | undefined {
    return this.chains.get(name);
  }

  list(): Array<{ name: string; description: string; stepCount: number }> {
    const result: Array<{ name: string; description: string; stepCount: number }> = [];
    for (const chain of Array.from(this.chains.values())) {
      result.push({
        name: chain.name,
        description: chain.description,
        stepCount: chain.steps.length,
      });
    }
    return result;
  }

  /**
   * Simple keyword matching: check if userMessage contains keywords
   * extracted from chain name and description.
   *
   * ★ 2026-11-22（v25 Task 2/3/6/9/10 实证）：旧实现用裸子串 `includes` +
   *   单关键词命中即匹配（score > 0）。内置链描述里的通用英文词
   *   （and/the/key/web/page…）会命中中文工程任务——T2 仅因 `KeyError`
   *   包含 "key" 就被建议「用 web_fetch 抓网页」，5/10 个本地任务收到了
   *   错误的工具链指令并注入 dynamic tail（击穿缓存）。
   *   现在：ASCII 关键词须整词边界匹配、忽略停用词，且至少命中 2 个词
   *   才认为相关。宁可漏报（建议性增强），不可误报。
   */
  findRelevantChain(userMessage: string): ToolChainDefinition | null {
    const message = userMessage.toLowerCase();

    let bestMatch: ToolChainDefinition | null = null;
    let bestScore = 0;

    for (const chain of Array.from(this.chains.values())) {
      const keywords = this.extractKeywords(chain);
      let score = 0;
      for (const keyword of keywords) {
        if (this.containsWord(message, keyword)) {
          score++;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = chain;
      }
    }

    return bestScore >= 2 ? bestMatch : null;
  }

  /** 整词匹配（ASCII 词以非字母数字为边界；中文等非 ASCII 词直接子串匹配）。 */
  private containsWord(message: string, keyword: string): boolean {
    if (!/^[a-z0-9]+$/.test(keyword)) return message.includes(keyword);
    const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`).test(message);
  }

  private extractKeywords(chain: ToolChainDefinition): string[] {
    const text = `${chain.name} ${chain.description}`.toLowerCase();
    // Split on non-alphanumeric characters and filter short tokens
    const tokens = text.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    // 停用词 + 过度泛化的名词：单靠它们不足以判定「该用这条网页链」
    const STOPWORDS = new Set([
      "and", "the", "for", "with", "from", "this", "that",
      "key", "web", "page", "information", "result", "results",
    ]);
    return Array.from(new Set(tokens.filter((t) => !STOPWORDS.has(t))));
  }
}

/** Built-in chain: search the web and summarize the result */
const searchAndSummarize: ToolChainDefinition = {
  name: 'search-and-summarize',
  description: 'Search the web and summarize the results',
  steps: [
    {
      tool: 'web_search',
      params: {},
      mapFromPrevious: { query: '$.query' },
    },
    {
      tool: 'summarize',
      params: {},
      mapFromPrevious: { content: '$.result' },
    },
  ],
  stopOnError: true,
};

/** Built-in chain: fetch a URL and extract key information */
const fetchAndExtract: ToolChainDefinition = {
  name: 'fetch-and-extract',
  description: 'Fetch a web page and extract key information',
  steps: [
    {
      tool: 'web_fetch',
      params: {},
      mapFromPrevious: { url: '$.url' },
    },
    {
      tool: 'extract',
      params: {},
      mapFromPrevious: { content: '$.content' },
    },
  ],
  stopOnError: true,
};

/** Built-in chain: navigate to a URL and take a screenshot */
const navigateAndScreenshot: ToolChainDefinition = {
  name: 'navigate-and-screenshot',
  description: 'Navigate to a URL in the browser and take a screenshot',
  steps: [
    {
      tool: 'browser_navigate',
      params: {},
      mapFromPrevious: { url: '$.url' },
    },
    {
      tool: 'browser_screenshot',
      params: {},
    },
  ],
  stopOnError: true,
};

/** Built-in chain: research a topic by searching, fetching the top result, and summarizing */
const researchTopic: ToolChainDefinition = {
  name: 'research-topic',
  description: 'Research a topic by searching the web, fetching the top result, and summarizing',
  steps: [
    {
      tool: 'web_search',
      params: {},
      mapFromPrevious: { query: '$.query' },
    },
    {
      tool: 'web_fetch',
      params: {},
      mapFromPrevious: { url: '$.result.results[0].url' },
    },
    {
      tool: 'summarize',
      params: {},
      mapFromPrevious: { content: '$.content' },
    },
  ],
  stopOnError: true,
};

/**
 * Create a ToolChainRegistry pre-loaded with built-in chains.
 */
export function createBuiltinToolChainRegistry(): ToolChainRegistry {
  const registry = new ToolChainRegistry();
  registry.register(searchAndSummarize);
  registry.register(fetchAndExtract);
  registry.register(navigateAndScreenshot);
  registry.register(researchTopic);
  return registry;
}
