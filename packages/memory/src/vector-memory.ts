import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { type LongTermMemory, type MemoryEntry, type MemorySearchQuery, type MemorySearchResult, DEFAULT_EMBEDDING_DIMENSION, COSINE_SIMILARITY_THRESHOLD } from "@evoclaw/core";
import { v4 as uuid } from "uuid";

// ─── EmbeddingProvider Interface ─────────────────────────────────────────────

/**
 * Pluggable interface for embedding generation.
 * Implementations can range from remote API calls to local offline models.
 */
export interface EmbeddingProvider {
  /** Generate an embedding vector for a single text. */
  embed(text: string): Promise<number[]>;

  /** Generate embedding vectors for multiple texts. */
  embedBatch(texts: string[]): Promise<number[][]>;

  /** The dimensionality of the embedding vectors produced by this provider. */
  readonly dimensions: number;
}

// ─── OpenAIEmbeddingProvider ─────────────────────────────────────────────────

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private apiKey: string | undefined;
  private model: string;
  private baseUrl: string;

  constructor(options?: {
    apiKey?: string;
    model?: string;
    dimensions?: number;
    baseUrl?: string;
  }) {
    this.apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY;
    this.model = options?.model ?? "text-embedding-3-small";
    this.dimensions = options?.dimensions ?? 1536;
    this.baseUrl = options?.baseUrl ?? "https://api.openai.com/v1/embeddings";
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error(
        "OpenAI API key not set. Provide apiKey in constructor or set OPENAI_API_KEY env var."
      );
    }

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `OpenAI Embeddings API error (${response.status}): ${body}`
      );
    }

    const data = (await response.json()) as {
      data: { embedding: number[]; index: number }[];
    };

    // Sort by index to ensure order matches input
    const sorted = data.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }
}

// ─── LocalEmbeddingProvider ──────────────────────────────────────────────────

/**
 * A TF-IDF style embedding provider that works offline.
 * Uses word hashing to generate 256-dim vectors.
 * Supports both English and Chinese text.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 256;

  // Common English stop words to skip (reduces noise)
  private static readonly STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
    "neither", "each", "every", "all", "any", "few", "more", "most", "other",
    "some", "such", "no", "only", "own", "same", "than", "too", "very",
    "just", "because", "if", "when", "where", "how", "what", "which", "who",
    "that", "this", "these", "those", "i", "me", "my", "we", "our", "you",
    "your", "he", "him", "his", "she", "her", "it", "its", "they", "them",
  ]);

  // Common Chinese stop words
  private static readonly CN_STOP_WORDS = new Set([
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
    "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有",
    "看", "好", "自己", "这", "他", "她", "它", "们", "那", "些", "什么",
    "怎么", "如何", "可以", "因为", "所以", "但是", "如果", "虽然", "而且",
    "或者", "以及", "还是", "已经", "正在", "将要", "应该", "能够", "可能",
    "这个", "那个", "这些", "那些", "这里", "那里", "为什么", "多少", "几个",
    "没", "把", "被", "让", "给", "从", "向", "对", "与", "等", "之",
  ]);

  async embed(text: string): Promise<number[]> {
    return this.textToVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.textToVector(t));
  }

  /**
   * Tokenize text into words, supporting both English and Chinese.
   * - English: lowercase, split on non-alphanumeric, filter stop words
   * - Chinese: each CJK character becomes a separate token (bigram pairs also generated)
   */
  private tokenize(text: string): string[] {
    const words: string[] = [];
    const lower = text.toLowerCase();
    let i = 0;
    let buffer = "";

    while (i < lower.length) {
      const ch = lower[i];
      const code = ch.codePointAt(0)!;

      // CJK Unified Ideographs
      const isCJK = (code >= 0x4e00 && code <= 0x9fff) ||
                    (code >= 0x3400 && code <= 0x4dbf);

      if (isCJK) {
        // Flush any buffered alphanumeric token
        if (buffer.length > 1 && !LocalEmbeddingProvider.STOP_WORDS.has(buffer)) {
          words.push(buffer);
        }
        buffer = "";

        // Add individual CJK character as token (if not a stop word)
        if (!LocalEmbeddingProvider.CN_STOP_WORDS.has(ch)) {
          words.push(ch);
        }

        // Generate bigram for consecutive CJK characters
        if (i + 1 < lower.length) {
          const nextCode = lower.codePointAt(i + 1)!;
          const nextIsCJK = (nextCode >= 0x4e00 && nextCode <= 0x9fff) ||
                            (nextCode >= 0x3400 && nextCode <= 0x4dbf);
          if (nextIsCJK) {
            const bigram = ch + lower[i + 1];
            words.push(bigram);
          }
        }
      } else if (/[a-z0-9]/.test(ch)) {
        buffer += ch;
      } else {
        // Non-alphanumeric, non-CJK: flush buffer
        if (buffer.length > 1 && !LocalEmbeddingProvider.STOP_WORDS.has(buffer)) {
          words.push(buffer);
        }
        buffer = "";
      }

      i++;
    }

    // Flush remaining buffer
    if (buffer.length > 1 && !LocalEmbeddingProvider.STOP_WORDS.has(buffer)) {
      words.push(buffer);
    }

    return words;
  }

  private textToVector(text: string): number[] {
    const dim = this.dimensions;
    const vector = new Float64Array(dim);

    const words = this.tokenize(text);

    if (words.length === 0) {
      // Fallback: hash the entire string
      const hash = this.hashString(text);
      for (let i = 0; i < dim; i++) {
        const x = Math.sin(hash * (i + 1) * 1.137 + i * 0.731) * 10000;
        vector[i] = (x - Math.floor(x) - 0.5) * 2;
      }
    } else {
      // TF-IDF style: each word contributes to multiple buckets via character n-grams
      for (const word of words) {
        // Generate character trigrams (and bigrams for short words)
        const ngrams = this.getNgrams(word, 3);
        if (word.length < 3) {
          ngrams.push(...this.getNgrams(word, 2));
        }

        for (const ngram of ngrams) {
          const bucket = this.hashString(ngram) % dim;
          // Use a secondary hash for sign to reduce collision correlation
          const sign = this.hashString(ngram + "_sign") % 2 === 0 ? 1 : -1;
          vector[bucket] += sign * (1 / words.length); // TF weighting
        }

        // Also add whole-word hash for exact match signal
        const wordBucket = this.hashString("word_" + word) % dim;
        vector[wordBucket] += 1.0 / words.length;
      }
    }

    // L2 normalize
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        vector[i] /= norm;
      }
    }

    return Array.from(vector);
  }

  private getNgrams(str: string, n: number): string[] {
    if (str.length < n) return [str];
    const result: string[] = [];
    for (let i = 0; i <= str.length - n; i++) {
      result.push(str.substring(i, i + n));
    }
    return result;
  }

  private hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }
}

// ─── FallbackEmbeddingProvider ───────────────────────────────────────────────

/**
 * Wraps a primary EmbeddingProvider and falls back to LocalEmbeddingProvider
 * if the primary fails (e.g. network error, missing API key).
 *
 * If no primary is provided, defaults to OpenAIEmbeddingProvider.
 * To use local semantic embeddings, explicitly pass a TransformersEmbeddingProvider:
 * ```ts
 * import { TransformersEmbeddingProvider } from "./transformers-embedding";
 * const provider = new FallbackEmbeddingProvider(new TransformersEmbeddingProvider());
 * ```
 */
export class FallbackEmbeddingProvider implements EmbeddingProvider {
  private primary: EmbeddingProvider;
  private fallback: LocalEmbeddingProvider;

  constructor(primary?: EmbeddingProvider) {
    this.primary = primary ?? new OpenAIEmbeddingProvider();
    this.fallback = new LocalEmbeddingProvider();
  }

  get dimensions(): number {
    return this.primary.dimensions;
  }

  async embed(text: string): Promise<number[]> {
    try {
      return await this.primary.embed(text);
    } catch {
      return this.fallback.embed(text);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      return await this.primary.embedBatch(texts);
    } catch {
      return this.fallback.embedBatch(texts);
    }
  }
}

// ─── VectorEntry ─────────────────────────────────────────────────────────────

interface VectorEntry {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
  createdAt: Date;
}

// ─── VectorMemoryStore ──────────────────────────────────────────────────────

export class VectorMemoryStore {
  private vectors = new Map<string, VectorEntry>();
  private dimension = DEFAULT_EMBEDDING_DIMENSION;
  private provider: EmbeddingProvider;
  private simulator = new EmbeddingSimulator();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    provider?: EmbeddingProvider
  ) {
    this.provider = provider ?? new FallbackEmbeddingProvider();
    if (registry) {
      registry.registerService("vectorMemory", this);
    }
  }

  /** Get the current embedding provider. */
  getProvider(): EmbeddingProvider {
    return this.provider;
  }

  // ── Sync methods (backward compat, use EmbeddingSimulator) ──

  async addVector(
    id: string,
    vector: number[],
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    this.vectors.set(id, {
      id,
      vector,
      metadata,
      createdAt: new Date(),
    });
  }

  async search(
    queryVector: number[],
    options: {
      threshold?: number;
      limit?: number;
      filter?: (entry: VectorEntry) => boolean;
    } = {}
  ): Promise<{ id: string; score: number; metadata: Record<string, unknown> }[]> {
    const { threshold = COSINE_SIMILARITY_THRESHOLD, limit = 10 } = options;

    const results: { id: string; score: number; vector: VectorEntry }[] = [];

    for (const [, entry] of this.vectors) {
      if (options.filter && !options.filter(entry)) continue;

      const similarity = this.cosineSimilarity(queryVector, entry.vector);
      if (similarity >= threshold) {
        results.push({ id: entry.id, score: similarity, vector: entry });
      }
    }

    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit).map((r) => ({
      id: r.id,
      score: r.score,
      metadata: { ...r.vector.metadata, _score: r.score },
    }));
  }

  async searchByText(
    queryText: string,
    embedder: (text: string) => Promise<number[]>,
    options?: { threshold?: number; limit?: number }
  ): Promise<{ id: string; score: number; text: string }[]> {
    const queryVector = await embedder(queryText);
    const results = await this.search(queryVector, options);

    return results.map((r) => ({
      id: r.id,
      score: r.score,
      text: `${r.id}: score=${r.score.toFixed(3)}`,
    }));
  }

  async batchAdd(
    entries: { id: string; vector: number[]; metadata?: Record<string, unknown> }[]
  ): Promise<void> {
    for (const entry of entries) {
      await this.addVector(entry.id, entry.vector, entry.metadata);
    }
  }

  delete(id: string): boolean {
    return this.vectors.delete(id);
  }

  size(): number {
    return this.vectors.size;
  }

  get(id: string): VectorEntry | undefined {
    return this.vectors.get(id);
  }

  // ── Async methods (use EmbeddingProvider) ──

  /**
   * Add a text entry by generating its embedding via the configured EmbeddingProvider.
   */
  async addVectorAsync(
    id: string,
    text: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    const vector = await this.provider.embed(text);
    this.vectors.set(id, {
      id,
      vector,
      metadata: { ...metadata, _sourceText: text },
      createdAt: new Date(),
    });
  }

  /**
   * Search by text using the configured EmbeddingProvider to generate the query vector.
   */
  async searchByTextAsync(
    queryText: string,
    options?: { threshold?: number; limit?: number }
  ): Promise<{ id: string; score: number; text: string }[]> {
    const queryVector = await this.provider.embed(queryText);
    const results = await this.search(queryVector, options);

    return results.map((r) => ({
      id: r.id,
      score: r.score,
      text: `${r.id}: score=${r.score.toFixed(3)}`,
    }));
  }

  /**
   * Batch add text entries by generating embeddings via the configured EmbeddingProvider.
   */
  async batchAddAsync(
    entries: { id: string; text: string; metadata?: Record<string, unknown> }[]
  ): Promise<void> {
    const texts = entries.map((e) => e.text);
    const vectors = await this.provider.embedBatch(texts);

    for (let i = 0; i < entries.length; i++) {
      this.vectors.set(entries[i].id, {
        id: entries[i].id,
        vector: vectors[i],
        metadata: { ...entries[i].metadata, _sourceText: entries[i].text },
        createdAt: new Date(),
      });
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
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
    if (denominator === 0) return 0;
    return dotProduct / denominator;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

// ─── EmbeddingSimulator (deprecated) ────────────────────────────────────────

/**
 * @deprecated Use EmbeddingProvider instead. This class uses a deterministic
 * hash-based approach that does not capture semantic similarity.
 * Prefer OpenAIEmbeddingProvider, LocalEmbeddingProvider, TransformersEmbeddingProvider,
 * or FallbackEmbeddingProvider.
 */
export class EmbeddingSimulator implements EmbeddingProvider {
  private _dim: number;

  constructor(dimension = DEFAULT_EMBEDDING_DIMENSION) {
    this._dim = dimension;
  }

  get dimensions(): number {
    return this._dim;
  }

  async embed(text: string): Promise<number[]> {
    return this.textToVector(text, this._dim);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.textToVector(t, this._dim));
  }

  /** @deprecated Use `embed()` instead. */
  async generate(text: string): Promise<number[]> {
    return this.embed(text);
  }

  /** @deprecated Use `embedBatch()` instead. */
  async batchGenerate(texts: string[]): Promise<number[][]> {
    return this.embedBatch(texts);
  }

  /** @deprecated Use `dimensions` property instead. */
  dimension(): number {
    return this._dim;
  }

  private textToVector(text: string, dim: number): number[] {
    const seed = this.hashString(text);
    const vector = new Array(dim);

    for (let i = 0; i < dim; i++) {
      const x = Math.sin(seed * (i + 1) * 1.137 + i * 0.731) * 10000;
      vector[i] = x - Math.floor(x);
      vector[i] = (vector[i] - 0.5) * 2;
    }

    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }

  private hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }
}
