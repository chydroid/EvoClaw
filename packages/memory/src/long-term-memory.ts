import { type LongTermMemory, type MemoryEntry, type MemorySearchQuery, type MemorySearchResult, DEFAULT_EMBEDDING_DIMENSION, COSINE_SIMILARITY_THRESHOLD } from "@evoclaw/core";
import { v4 as uuid } from "uuid";

export class LongTermMemoryStore implements LongTermMemory {
  private entries = new Map<string, MemoryEntry>();

  async store(entry: MemoryEntry): Promise<MemoryEntry> {
    const fullEntry: MemoryEntry = {
      ...entry,
      id: entry.id || uuid(),
      createdAt: entry.createdAt || new Date(),
      accessedAt: entry.accessedAt || new Date(),
    };
    this.entries.set(fullEntry.id, fullEntry);
    return fullEntry;
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    const results: MemorySearchResult[] = [];

    for (const entry of this.entries.values()) {
      let score = 0;
      const matchedFields: string[] = [];

      if (query.type && entry.type !== query.type) continue;

      if (query.tags?.length) {
        const tagMatch = query.tags.some((t) => entry.metadata.tags.includes(t));
        if (!tagMatch) continue;
        matchedFields.push("tags");
        score += 0.3;
      }

      if (query.minImportance && entry.metadata.importance < query.minImportance) continue;

      if (query.query && entry.content.toLowerCase().includes(query.query.toLowerCase())) {
        score += 0.5;
        matchedFields.push("content");
      }

      if (query.embedding && entry.embedding) {
        const similarity = this.cosineSimilarity(query.embedding, entry.embedding);
        if (similarity >= (query.threshold || COSINE_SIMILARITY_THRESHOLD)) {
          score += similarity * 0.5;
          matchedFields.push("embedding");
        } else if (!matchedFields.length) {
          continue;
        }
      }

      if (score > 0) {
        results.push({ entry, score, matchedFields });
      }
    }

    results.sort((a, b) => b.score - a.score);

    return query.limit ? results.slice(0, query.limit) : results;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const entry = this.entries.get(id);
    if (entry) {
      entry.accessedAt = new Date();
    }
    return entry || null;
  }

  async update(id: string, updates: Partial<MemoryEntry>): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      this.entries.set(id, { ...entry, ...updates, accessedAt: new Date() });
    }
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async expire(): Promise<number> {
    let expired = 0;
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.createdAt.getTime() + entry.ttl < now) {
        this.entries.delete(id);
        expired++;
      }
    }
    return expired;
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
}