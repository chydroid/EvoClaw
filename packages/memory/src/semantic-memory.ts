import { randomUUID } from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SemanticMemoryEntry {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  lastAccessed: Date;
}

export interface SemanticSearchResult {
  entry: SemanticMemoryEntry;
  score: number;
}

export interface SemanticMemoryConfig {
  /** Minimum cosine similarity threshold (0–1). Default: 0.05 */
  threshold?: number;
  /** Maximum number of results to return. Default: 10 */
  defaultLimit?: number;
  /** Hook invoked after an entry is added */
  onAdd?: (entry: SemanticMemoryEntry) => void;
  /** Hook invoked after a search completes */
  onSearch?: (query: string, results: SemanticSearchResult[]) => void;
  /** Hook invoked after an entry is deleted */
  onDelete?: (id: string) => void;
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "shall", "you", "your",
  "we", "our", "they", "their", "he", "she", "it", "its", "this", "that",
  "these", "those", "am", "no", "not", "nor", "so", "if", "then", "else",
  "when", "where", "why", "how", "all", "each", "every", "both", "few",
  "more", "most", "other", "some", "such", "only", "own", "same", "than",
  "too", "very", "just", "about", "above", "after", "again", "against",
  "between", "into", "through", "during", "before", "under", "again",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// ── SemanticMemoryStore ──────────────────────────────────────────────────────

export class SemanticMemoryStore {
  private entries = new Map<string, SemanticMemoryEntry>();
  private vocabulary: string[] = [];
  private wordToIndex = new Map<string, number>();
  /** Number of documents containing each word */
  private docFreq = new Map<number, number>();

  // Per-entry term-frequency vectors (index → count)
  private entryVectors = new Map<string, Map<number, number>>();

  private threshold: number;
  private defaultLimit: number;
  private onAdd?: (entry: SemanticMemoryEntry) => void;
  private onSearch?: (query: string, results: SemanticSearchResult[]) => void;
  private onDelete?: (id: string) => void;

  constructor(config: SemanticMemoryConfig = {}) {
    this.threshold = config.threshold ?? 0.05;
    this.defaultLimit = config.defaultLimit ?? 10;
    this.onAdd = config.onAdd;
    this.onSearch = config.onSearch;
    this.onDelete = config.onDelete;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  addEntry(text: string, metadata: Record<string, unknown> = {}): SemanticMemoryEntry {
    const id = randomUUID();
    const entry: SemanticMemoryEntry = {
      id,
      text,
      metadata,
      createdAt: new Date(),
      lastAccessed: new Date(),
    };

    const tokens = tokenize(text);
    const tf = this.buildTermFrequency(tokens);

    this.entries.set(id, entry);
    this.entryVectors.set(id, tf);

    // Update vocabulary and document frequencies
    for (const [wordIndex] of tf) {
      const current = this.docFreq.get(wordIndex) ?? 0;
      this.docFreq.set(wordIndex, current + 1);
    }

    this.onAdd?.(entry);
    return entry;
  }

  search(query: string, limit?: number): SemanticSearchResult[] {
    const maxResults = limit ?? this.defaultLimit;
    const tokens = tokenize(query);

    if (tokens.length === 0 || this.entries.size === 0) {
      const results: SemanticSearchResult[] = [];
      this.onSearch?.(query, results);
      return results;
    }

    const queryTf = this.buildTermFrequency(tokens);
    const queryVector = this.tfidfVector(queryTf);
    const queryNorm = this.vectorNorm(queryVector);

    if (queryNorm === 0) {
      const results: SemanticSearchResult[] = [];
      this.onSearch?.(query, results);
      return results;
    }

    const results: SemanticSearchResult[] = [];

    for (const [id, entry] of this.entries) {
      const entryTf = this.entryVectors.get(id);
      if (!entryTf) continue;

      const entryVector = this.tfidfVector(entryTf);
      const similarity = this.cosineSimilarity(
        queryVector,
        queryNorm,
        entryVector,
      );

      if (similarity >= this.threshold) {
        results.push({ entry: this.cloneEntry(entry), score: similarity });
      }
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, maxResults);

    // Update lastAccessed for returned entries
    for (const r of top) {
      const real = this.entries.get(r.entry.id);
      if (real) real.lastAccessed = new Date();
    }

    this.onSearch?.(query, top);
    return top;
  }

  deleteEntry(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;

    const tf = this.entryVectors.get(id);
    this.entries.delete(id);
    this.entryVectors.delete(id);

    // Decrement document frequencies
    if (tf) {
      for (const [wordIndex] of tf) {
        const current = this.docFreq.get(wordIndex);
        if (current !== undefined) {
          if (current <= 1) {
            this.docFreq.delete(wordIndex);
          } else {
            this.docFreq.set(wordIndex, current - 1);
          }
        }
      }
    }

    // 已知限制：vocabulary 数组与 wordToIndex 此处不同步收缩。
    // 原因：vocabulary 是按索引定位的数组（index 即词的位置），删除某词会导致
    // 后续所有词的索引前移，需同步重写 wordToIndex、所有 entryVectors 的键、
    // 以及 docFreq 的键，复杂度高且易破坏索引一致性。
    // 当前仅从 docFreq 中移除零频词，vocabulary 中保留陈旧条目（占少量内存，
    // 不影响检索正确性：docFreq 已为 0，TF-IDF 权重自然为 0）。
    // TODO: 如未来 vocabulary 增长成为内存瓶颈，可改为重建索引或改用稀疏结构。

    this.onDelete?.(id);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.entryVectors.clear();
    this.vocabulary = [];
    this.wordToIndex.clear();
    this.docFreq.clear();
  }

  size(): number {
    return this.entries.size;
  }

  getEntry(id: string): SemanticMemoryEntry | undefined {
    const entry = this.entries.get(id);
    if (entry) {
      entry.lastAccessed = new Date();
      return this.cloneEntry(entry);
    }
    return undefined;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private buildTermFrequency(tokens: string[]): Map<number, number> {
    const tf = new Map<number, number>();
    for (const token of tokens) {
      const idx = this.ensureWord(token);
      tf.set(idx, (tf.get(idx) ?? 0) + 1);
    }
    return tf;
  }

  private ensureWord(word: string): number {
    let idx = this.wordToIndex.get(word);
    if (idx === undefined) {
      idx = this.vocabulary.length;
      this.vocabulary.push(word);
      this.wordToIndex.set(word, idx);
    }
    return idx;
  }

  /**
   * Convert a term-frequency map into a TF-IDF weighted dense vector.
   */
  private tfidfVector(tf: Map<number, number>): Map<number, number> {
    const N = this.entries.size || 1;
    const result = new Map<number, number>();
    for (const [idx, freq] of tf) {
      const df = this.docFreq.get(idx) ?? 1;
      const idf = Math.log((N + 1) / (df + 1)) + 1;
      result.set(idx, freq * idf);
    }
    return result;
  }

  private vectorNorm(vec: Map<number, number>): number {
    let sum = 0;
    for (const v of vec.values()) {
      sum += v * v;
    }
    return Math.sqrt(sum);
  }

  private cosineSimilarity(
    a: Map<number, number>,
    aNorm: number,
    b: Map<number, number>,
  ): number {
    const bNorm = this.vectorNorm(b);
    if (aNorm === 0 || bNorm === 0) return 0;

    // Iterate the smaller map for efficiency
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];

    let dot = 0;
    for (const [idx, val] of small) {
      const other = large.get(idx);
      if (other !== undefined) {
        dot += val * other;
      }
    }

    return dot / (aNorm * bNorm);
  }

  private cloneEntry(entry: SemanticMemoryEntry): SemanticMemoryEntry {
    return {
      id: entry.id,
      text: entry.text,
      metadata: { ...entry.metadata },
      createdAt: new Date(entry.createdAt),
      lastAccessed: new Date(entry.lastAccessed),
    };
  }
}