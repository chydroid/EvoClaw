import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { type LongTermMemory, type MemoryEntry, type MemorySearchQuery, type MemorySearchResult, DEFAULT_EMBEDDING_DIMENSION, COSINE_SIMILARITY_THRESHOLD } from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

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
      signal: AbortSignal.timeout(30_000),
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
    // 使用 SHA256 替代 DJB2，满足项目安全规范对哈希算法的要求。
    const digest = createHash("sha256").update(str, "utf-8").digest();
    return digest.readUInt32BE(0);
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
  /**
   * 持久化相关字段。
   *
   * VectorMemoryStore 默认纯内存，进程重启向量索引全部丢失，语义检索降级为 FTS5。
   * 启用 storePath 后，addVector/delete 操作会触发防抖落盘（原子写入 temp+fsync+rename），
   * 启动时调用 loadFromDisk() 恢复，避免重建嵌入的开销。
   */
  private storePath: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** 标记是否有未落盘的修改，配合 isPersisting 串行化避免并发写入同一 .tmp 文件 */
  private dirty = false;
  /** 是否正在落盘；防止 schedulePersist/flush 与后台 timer 触发的 persistToDisk 并发执行 */
  private isPersisting = false;
  private static readonly PERSIST_DEBOUNCE_MS = 2000;
  private static readonly MAX_PERSIST_ENTRIES = 50_000;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    provider?: EmbeddingProvider,
    storePath?: string
  ) {
    this.provider = provider ?? new FallbackEmbeddingProvider();
    if (storePath) {
      this.storePath = path.resolve(storePath);
      this.loadFromDisk();
    }
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
    this.validateVector(id, vector);
    this.vectors.set(id, {
      id,
      vector,
      metadata,
      createdAt: new Date(),
    });
    this.schedulePersist();
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
      this.validateVector(entry.id, entry.vector);
      await this.addVector(entry.id, entry.vector, entry.metadata);
    }
    this.schedulePersist();
  }

  delete(id: string): boolean {
    const deleted = this.vectors.delete(id);
    if (deleted) this.schedulePersist();
    return deleted;
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
    this.schedulePersist();
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
    this.schedulePersist();
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

  private validateVector(id: string, vector: number[]): void {
    if (this.vectors.size === 0) {
      // 第一条向量决定当前 store 的维度；后续向量必须与此保持一致。
      // 这比强制匹配 provider.dimensions 更灵活，因为 store 可能接收来自不同 provider 的预计算向量。
      this.dimension = vector.length;
    } else if (vector.length !== this.dimension) {
      throw new Error(
        `Vector dimension mismatch for "${id}": expected ${this.dimension}, got ${vector.length}`
      );
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  // ── 持久化（原子写入 temp+fsync+rename，跨设备 EXDEV/EBUSY 回退） ──

  /**
   * 标记 dirty，2 秒防抖后落盘。避免高频 addVector 导致 IO 风暴。
   */
  private schedulePersist(): void {
    if (!this.storePath) return;
    this.dirty = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistToDisk().catch((err) => {
        process.stderr.write(`[VectorMemoryStore] persist failed: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }, VectorMemoryStore.PERSIST_DEBOUNCE_MS);
    // unref 防止 persist 防抖定时器阻止 Node.js 优雅退出
    this.persistTimer.unref();
  }

  /**
   * 强制立即落盘（用于 shutdown / 测试）。
   */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirty = true;
    await this.persistToDisk();
  }

  /**
   * 将当前 vectors Map 序列化为 JSON 并原子写入 storePath。
   * 超过 MAX_PERSIST_ENTRIES 时仅保留最近 entries（按 createdAt 排序），防止文件无限增长。
   * 使用 isPersisting + dirty 串行化：并发调用时仅一个执行实际写入，其他标记 dirty 等待重试。
   */
  private async persistToDisk(): Promise<void> {
    if (!this.storePath) return;
    if (this.isPersisting) {
      // 已有 persist 在进行；本次 dirty 已标记，当前 persist 完成后会检查 dirty 并再次落盘
      return;
    }
    this.isPersisting = true;
    try {
      // 循环处理在落盘期间产生的新修改
      while (this.dirty) {
        // 安全：先暂存 dirty，仅在成功写入后才清除。
        // 旧实现在写入前就 dirty=false，写入失败时向量数据永久丢失。
        try {
          let entries = Array.from(this.vectors.values());
          if (entries.length > VectorMemoryStore.MAX_PERSIST_ENTRIES) {
            entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
            entries = entries.slice(0, VectorMemoryStore.MAX_PERSIST_ENTRIES);
          }

          const serialized = {
            version: 1,
            dimension: this.dimension,
            count: entries.length,
            entries: entries.map((e) => ({
              id: e.id,
              vector: e.vector,
              metadata: e.metadata,
              createdAt: e.createdAt.toISOString(),
            })),
          };

          const json = JSON.stringify(serialized);
          const dir = path.dirname(this.storePath);
          try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* best-effort */ }

          const tmp = `${this.storePath}.tmp`;
          // 使用文件句柄写入以便 fsync，确保数据落盘后再 rename
          const fh = await fs.promises.open(tmp, "w");
          try {
            await fh.writeFile(json, "utf8");
            await fh.sync();
          } finally {
            await fh.close();
          }
          try {
            await fs.promises.rename(tmp, this.storePath);
          } catch (renameErr) {
            // rename 失败时清理临时文件，避免残留泄漏
            try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
            throw renameErr;
          }
          // 仅在成功写入后才清除 dirty
          this.dirty = false;

          // 同步裁剪内存中的 vectors Map：磁盘已按 createdAt 排序保留最近
          // MAX_PERSIST_ENTRIES 条，但内存 Map 此前从不裁剪，会持续增长。
          // 在落盘成功后裁剪一次，保持内存与磁盘一致，避免无界增长。
          if (this.vectors.size > VectorMemoryStore.MAX_PERSIST_ENTRIES) {
            const all = Array.from(this.vectors.values()).sort(
              (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
            );
            const kept = new Set(all.slice(0, VectorMemoryStore.MAX_PERSIST_ENTRIES).map((e) => e.id));
            for (const id of this.vectors.keys()) {
              if (!kept.has(id)) this.vectors.delete(id);
            }
          }
        } catch (persistErr) {
          // 写入失败：保持 dirty=true，退出循环避免无限重试
          process.stderr.write(`[VectorMemoryStore] Failed to persist (will retry next schedule): ${persistErr instanceof Error ? persistErr.message : String(persistErr)}\n`);
          break;
        }
      }
    } finally {
      this.isPersisting = false;
    }
  }

  /**
   * 启动时从 storePath 恢复 vectors Map。
   * 文件不存在或解析失败时静默跳过（不影响启动）。
   */
  private loadFromDisk(): void {
    if (!this.storePath) return;
    try {
      if (!fs.existsSync(this.storePath)) return;
      const raw = fs.readFileSync(this.storePath, "utf8");
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.entries)) return;

      // 使用持久化文件中记录的维度；缺失时由第一条向量自动决定。
      if (typeof data.dimension === "number" && data.dimension > 0) {
        this.dimension = data.dimension;
      }

      let loaded = 0;
      for (const e of data.entries) {
        if (!e.id || !Array.isArray(e.vector)) continue;
        this.validateVector(e.id, e.vector);
        this.vectors.set(e.id, {
          id: e.id,
          vector: e.vector,
          metadata: e.metadata ?? {},
          createdAt: e.createdAt ? new Date(e.createdAt) : new Date(),
        });
        loaded++;
      }
      if (loaded > 0) {
        process.stdout.write(`[VectorMemoryStore] loaded ${loaded} vectors from ${this.storePath}\n`);
      }
    } catch (err) {
      process.stderr.write(`[VectorMemoryStore] loadFromDisk failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
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
    // 使用 SHA256 替代 DJB2，满足项目安全规范对哈希算法的要求。
    const digest = createHash("sha256").update(str, "utf-8").digest();
    return digest.readUInt32BE(0);
  }
}
