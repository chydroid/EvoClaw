import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { type LongTermMemory, type MemoryEntry, type MemorySearchQuery, type MemorySearchResult, DEFAULT_EMBEDDING_DIMENSION, COSINE_SIMILARITY_THRESHOLD } from "@evoclaw/core";
import { v4 as uuid } from "uuid";

interface VectorEntry {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export class VectorMemoryStore {
  private vectors = new Map<string, VectorEntry>();
  private dimension = DEFAULT_EMBEDDING_DIMENSION;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    if (registry) {
      registry.registerService("vectorMemory", this);
    }
  }

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

export class EmbeddingSimulator {
  private dim: number;

  constructor(dimension = DEFAULT_EMBEDDING_DIMENSION) {
    this.dim = dimension;
  }

  async generate(text: string): Promise<number[]> {
    return this.textToVector(text, this.dim);
  }

  async batchGenerate(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.textToVector(t, this.dim));
  }

  dimension(): number {
    return this.dim;
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