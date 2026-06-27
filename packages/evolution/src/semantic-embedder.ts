/**
 * SemanticEmbedder — 语义向量嵌入生成器
 * 
 * 替代原有的三角函数哈希嵌入，支持真正的语义相似度计算。
 * 
 * 优先级：
 *   1. LLM API Embedding（OpenAI/兼容接口 /v1/embeddings）
 *   2. 本地哈希嵌入（降级方案，保持向后兼容）
 * 
 * 缓存策略：嵌入向量按文本哈希缓存，避免重复API调用。
 */

import { ServiceRegistry } from "@evoclaw/core";

// ── Types ──────────────────────────────────────────────────

export interface SemanticEmbedderConfig {
  /** 嵌入维度（默认 384） */
  dimension: number;
  /** 是否启用 API embedding */
  apiEnabled: boolean;
  /** 缓存大小上限 */
  maxCacheSize: number;
  /** API 超时（毫秒） */
  apiTimeoutMs: number;
  /** 最小文本长度（过短文本直接用哈希） */
  minTextLengthForApi: number;
}

export const DEFAULT_EMBEDDER_CONFIG: SemanticEmbedderConfig = {
  dimension: 384,
  apiEnabled: true,
  maxCacheSize: 1000,
  apiTimeoutMs: 15000,
  minTextLengthForApi: 20,
};

// ── SemanticEmbedder ────────────────────────────────────────

export class SemanticEmbedder {
  private config: SemanticEmbedderConfig;
  private cache: Map<string, number[]> = new Map();
  private registry?: ServiceRegistry;
  private apiCallCount = 0;
  private cacheHitCount = 0;
  private fallbackCount = 0;

  /** The dimensionality of the embedding vectors produced by this embedder. */
  get dimensions(): number {
    return this.config.dimension;
  }

  constructor(registry?: ServiceRegistry, config?: Partial<SemanticEmbedderConfig>) {
    this.registry = registry;
    this.config = { ...DEFAULT_EMBEDDER_CONFIG, ...config };
  }

  /**
   * 生成文本的语义嵌入向量。
   * 优先使用 API embedding，不可用时降级为哈希嵌入。
   */
  async embed(text: string): Promise<number[]> {
    if (!text) {
      return this.hashEmbedding(text);
    }

    // 从缓存中查找
    const cacheKey = this.computeCacheKey(text);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.cacheHitCount++;
      return cached;
    }

    let embedding: number[] | null;

    // 尝试 API embedding
    if (
      this.config.apiEnabled &&
      text.length >= this.config.minTextLengthForApi
    ) {
      embedding = await this.tryApiEmbedding(text);
      if (embedding) {
        this.apiCallCount++;
        this.addToCache(cacheKey, embedding);
        return embedding;
      }
    }

    // 降级到哈希嵌入
    this.fallbackCount++;
    embedding = this.hashEmbedding(text);
    this.addToCache(cacheKey, embedding);
    return embedding;
  }

  /**
   * 批量生成嵌入向量（并发）
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    const pendingApi: Array<{ index: number; text: string }> = [];

    // 第一遍：缓存命中直接返回
    for (let i = 0; i < texts.length; i++) {
      const cacheKey = this.computeCacheKey(texts[i]);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.cacheHitCount++;
        results[i] = cached;
      } else {
        pendingApi.push({ index: i, text: texts[i] });
      }
    }

    // 第二遍：并发请求 API
    // 每个 Promise 内部捕获所有错误并降级到 hashEmbedding，确保不会 reject。
    // 否则 Promise.all 会 fail-fast，但其他已启动的 Promise 仍会继续修改共享的
    // results 和 cache，导致缓存/结果状态不一致。
    const apiPromises = pendingApi.map(async ({ index, text }) => {
      let embedding: number[] | null;

      try {
        if (
          this.config.apiEnabled &&
          text.length >= this.config.minTextLengthForApi
        ) {
          embedding = await this.tryApiEmbedding(text);
          if (embedding) {
            this.apiCallCount++;
            const cacheKey = this.computeCacheKey(text);
            this.addToCache(cacheKey, embedding);
            results[index] = embedding;
            return;
          }
        }
      } catch (err) {
        // API 调用抛错时降级到哈希嵌入，不让 Promise reject
        process.stderr.write(`[SemanticEmbedder] API embedding failed, falling back to hash: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      // 降级
      this.fallbackCount++;
      embedding = this.hashEmbedding(text);
      const cacheKey = this.computeCacheKey(text);
      this.addToCache(cacheKey, embedding);
      results[index] = embedding;
    });

    await Promise.all(apiPromises);
    return results;
  }

  /**
   * 计算两个嵌入向量的余弦相似度
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    apiCalls: number;
    cacheHits: number;
    fallbacks: number;
    cacheSize: number;
    apiEnabled: boolean;
  } {
    return {
      apiCalls: this.apiCallCount,
      cacheHits: this.cacheHitCount,
      fallbacks: this.fallbackCount,
      cacheSize: this.cache.size,
      apiEnabled: this.config.apiEnabled,
    };
  }

  /**
   * 配置更新
   */
  configure(config: Partial<SemanticEmbedderConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ── Private Methods ──────────────────────────────────────

  private async tryApiEmbedding(text: string): Promise<number[] | null> {
    try {
      const executor = this.resolveLLMExecutor();
      if (!executor) return null;

      const providers = executor.getProviders().filter((p) => p.enabled);
      if (providers.length === 0) return null;

      const provider = providers[0];
      const apiKey = provider.apiKey;
      if (!apiKey) return null;

      const baseURL = provider.baseURL || "https://api.openai.com/v1";
      const apiUrl = `${baseURL.replace(/\/+$/, "")}/embeddings`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.apiTimeoutMs);

      try {
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: text.slice(0, 8000),
          }),
          signal: controller.signal,
        });

        if (!response.ok) return null;

        const data = (await response.json()) as {
          data: Array<{ embedding: number[] }>;
        };

        if (data.data && data.data.length > 0 && Array.isArray(data.data[0].embedding)) {
          return data.data[0].embedding;
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      process.stderr.write('[semantic-embedder] operation failed: ' + err + '\n');
    }

    return null;
  }

  /**
   * 哈希嵌入（公开方法，供向后兼容）
   */
  hashEmbedding(text: string): number[] {
    const hash = this.simpleHash(text);
    const embedding = new Array(this.config.dimension);

    for (let i = 0; i < this.config.dimension; i++) {
      embedding[i] = Math.sin((hash + i) * 0.0174533) * 0.5 + 0.5;
    }

    // L2 normalization
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= norm;
      }
    }

    return embedding;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash);
  }

  private computeCacheKey(text: string): string {
    return `emb_${this.simpleHash(text)}_${text.length}`;
  }

  private addToCache(key: string, embedding: number[]): void {
    if (this.cache.size >= this.config.maxCacheSize) {
      // 淘汰最旧的条目（Map 维护插入顺序）
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, embedding);
  }

  private resolveLLMExecutor(): LLMExecutor | null {
    if (!this.registry) return null;
    try {
      const executor = this.registry.resolveService<LLMExecutor>("agentModelExecutor");
      if (!executor || typeof executor.getProviders !== "function") return null;
      return executor;
    } catch (err) {
      process.stderr.write('[semantic-embedder] operation failed: ' + err + '\n');
      return null;
    }
  }
}

// ── Internal Types ─────────────────────────────────────────

interface LLMExecutor {
  getProviders(): Array<{
    apiKey?: string;
    baseURL?: string;
    enabled: boolean;
    order: number;
  }>;
}