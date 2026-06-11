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
   */
  findRelevantChain(userMessage: string): ToolChainDefinition | null {
    const message = userMessage.toLowerCase();

    let bestMatch: ToolChainDefinition | null = null;
    let bestScore = 0;

    for (const chain of Array.from(this.chains.values())) {
      const keywords = this.extractKeywords(chain);
      let score = 0;
      for (const keyword of keywords) {
        if (message.includes(keyword)) {
          score++;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = chain;
      }
    }

    return bestScore > 0 ? bestMatch : null;
  }

  private extractKeywords(chain: ToolChainDefinition): string[] {
    const text = `${chain.name} ${chain.description}`.toLowerCase();
    // Split on non-alphanumeric characters and filter short tokens
    const tokens = text.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    // Deduplicate
    return Array.from(new Set(tokens));
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
