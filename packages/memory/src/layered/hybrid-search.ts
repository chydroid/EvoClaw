/**
 * Hybrid RRF 检索 — BM25 + 向量 + RRF 融合。
 *
 * 借鉴 TencentDB-Agent-Memory 的 `src/core/hooks/auto-recall.ts`：
 * - 三种检索策略：keyword (BM25) / embedding (cosine) / hybrid (RRF k=60)
 * - RRF (Reciprocal Rank Fusion) 把多个检索结果列表融合成一个
 * - 公式：score(d) = Σ 1 / (k + rank_i(d))，k=60 是常用值
 *
 * 解决问题：单一检索策略覆盖率低。BM25 擅长精确关键词匹配，
 * 向量检索擅长语义相似。两者融合能同时覆盖"字面匹配"和"语义相关"。
 */

/** 单个检索结果条目。 */
export interface SearchResult<T = unknown> {
  /** 条目本身。 */
  item: T;
  /** 原始相似度分数（BM25 分数或向量余弦）。 */
  score: number;
  /** 来源检索器名（"bm25" / "vector" / "keyword"）。 */
  source: string;
}

/** RRF 融合后的结果。 */
export interface RrfResult<T = unknown> {
  /** 条目本身。 */
  item: T;
  /** RRF 融合分数。 */
  rrfScore: number;
  /** 在各检索器中的排名。 */
  ranks: Record<string, number>;
  /** 各检索器的原始分数。 */
  scores: Record<string, number>;
}

/** RRF 配置。 */
export interface RrfOptions {
  /** RRF k 参数（默认 60，常用值）。 */
  k?: number;
  /** 每个检索器取 top-N 参与融合（默认 100）。 */
  topNPerSource?: number;
  /** 最终返回 top-K 结果（默认 10）。 */
  finalTopK?: number;
}

const DEFAULT_OPTIONS: Required<RrfOptions> = {
  k: 60,
  topNPerSource: 100,
  finalTopK: 10,
};

/**
 * 用 RRF 融合多个检索结果列表。
 *
 * 公式：score(d) = Σ 1 / (k + rank_i(d))
 * - k=60 是常用值，越大则排名差异越平滑
 * - rank 从 1 开始（rank=1 是第一名）
 *
 * @param resultLists 多个检索器的结果列表
 * @param options RRF 配置
 * @returns 融合后的 top-K 结果
 */
export function fuseWithRrf<T = unknown>(
  resultLists: Array<SearchResult<T>[]>,
  options?: RrfOptions
): RrfResult<T>[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const keyOf = (item: T): string => {
    // 用对象的某个字段做 key（如果有 id 字段）；否则用 JSON 序列化
    if (item && typeof item === "object" && "id" in item) {
      return String((item as { id: unknown }).id);
    }
    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  };

  // 每个 item 的累积 RRF 分数 + 各检索器排名
  const rrfMap = new Map<string, RrfResult<T>>();

  for (const resultList of resultLists) {
    // 取 top-N
    const topN = resultList.slice(0, opts.topNPerSource);
    for (let i = 0; i < topN.length; i++) {
      const result = topN[i];
      const rank = i + 1; // rank 从 1 开始
      const key = keyOf(result.item);
      const rrfContribution = 1 / (opts.k + rank);

      let entry = rrfMap.get(key);
      if (!entry) {
        entry = {
          item: result.item,
          rrfScore: 0,
          ranks: {},
          scores: {},
        };
        rrfMap.set(key, entry);
      }
      entry.rrfScore += rrfContribution;
      entry.ranks[result.source] = rank;
      entry.scores[result.source] = result.score;
    }
  }

  // 按 RRF 分数倒序，取 top-K
  const allResults = [...rrfMap.values()].sort(
    (a, b) => b.rrfScore - a.rrfScore
  );
  return allResults.slice(0, opts.finalTopK);
}

/** 简易 BM25 检索器（无外部索引，逐条计算）。 */
export class SimpleBM25Searcher<T = unknown> {
  private docs: Array<{ item: T; tokens: Set<string>; length: number }> = [];
  private avgDocLength = 0;

  constructor(
    private getText: (item: T) => string,
    private k1 = 1.5,
    private b = 0.75
  ) {}

  /** 添加文档到索引。 */
  add(items: T[]): void {
    for (const item of items) {
      const text = this.getText(item) ?? "";
      const tokens = tokenize(text);
      this.docs.push({ item, tokens: new Set(tokens), length: tokens.length });
    }
    this.avgDocLength =
      this.docs.length > 0
        ? this.docs.reduce((sum, d) => sum + d.length, 0) / this.docs.length
        : 0;
  }

  /** 清空索引。 */
  clear(): void {
    this.docs = [];
    this.avgDocLength = 0;
  }

  /** 索引文档数。 */
  get size(): number {
    return this.docs.length;
  }

  /** 搜索。 */
  search(query: string, topK = 10): SearchResult<T>[] {
    if (this.docs.length === 0 || !query.trim()) return [];
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) return [];

    // 计算 IDF（逆文档频率）
    const idf: Record<string, number> = {};
    for (const token of queryTokens) {
      const df = this.docs.filter((d) => d.tokens.has(token)).length;
      idf[token] = Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
    }

    const results: SearchResult<T>[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const token of queryTokens) {
        if (!doc.tokens.has(token)) continue;
        const tf = 1; // 简化：每个 token 在文档中只算 1 次
        const numerator = tf * (this.k1 + 1);
        const denominator =
          tf + this.k1 * (1 - this.b + this.b * (doc.length / (this.avgDocLength || 1)));
        score += idf[token] * (numerator / denominator);
      }
      if (score > 0) {
        results.push({ item: doc.item, score, source: "bm25" });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}

/** 向量余弦检索器。 */
export class VectorSearcher<T = unknown> {
  private docs: Array<{ item: T; vector: number[] }> = [];

  constructor(private getText: (item: T) => string) {}

  /** 添加文档 + 对应向量。 */
  add(items: Array<{ item: T; vector: number[] }>): void {
    for (const { item, vector } of items) {
      this.docs.push({ item, vector });
    }
  }

  /** 清空索引。 */
  clear(): void {
    this.docs = [];
  }

  /** 索引文档数。 */
  get size(): number {
    return this.docs.length;
  }

  /** 用查询向量搜索。 */
  search(queryVector: number[], topK = 10): SearchResult<T>[] {
    if (this.docs.length === 0 || queryVector.length === 0) return [];
    const results: SearchResult<T>[] = [];
    for (const doc of this.docs) {
      const sim = cosineSim(queryVector, doc.vector);
      if (sim > 0) {
        results.push({ item: doc.item, score: sim, source: "vector" });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}

/**
 * 混合检索：BM25 + 向量 + RRF 融合。
 *
 * @param bm25Results BM25 检索结果
 * @param vectorResults 向量检索结果
 * @param options RRF 配置
 * @returns 融合后的 top-K 结果
 */
export function hybridSearch<T = unknown>(
  bm25Results: SearchResult<T>[],
  vectorResults: SearchResult<T>[],
  options?: RrfOptions
): RrfResult<T>[] {
  return fuseWithRrf<T>([bm25Results, vectorResults], options);
}

// ── 辅助函数 ──

/** 简单分词：英文按空格 + 中文按 2-4 字片段。 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  if (!text) return tokens;
  // 英文
  const en = text.toLowerCase().match(/\b[a-z][a-z0-9_-]{2,}\b/g);
  if (en) tokens.push(...en);
  // 中文 2-4 字片段
  const cn = text.match(/[\u4e00-\u9fff]{2,4}/g);
  if (cn) tokens.push(...cn);
  return tokens;
}

/** 余弦相似度。 */
function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
