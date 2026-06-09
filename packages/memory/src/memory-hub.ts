import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  type ShortTermMemory,
  type LongTermMemory,
  type KnowledgeGraph,
  type MemoryEntry,
  type MemorySearchQuery,
  type MemorySearchResult,
} from "@evoclaw/core";
import { ShortTermMemoryStore } from "./short-term-memory";
import { LongTermMemoryStore } from "./long-term-memory";
import { KnowledgeGraphStore } from "./knowledge-graph";
import { FTS5SearchEngine, type FTS5SearchResult } from "./fts5-search";
import { MemoryCurator, type MemorySnapshot } from "./memory-curator";
import { VectorMemoryStore } from "./vector-memory";
import { TransformersEmbeddingProvider, type TransformersEmbeddingProviderOptions } from "./transformers-embedding";

/** Options for configuring the MemoryHub's embedding provider. */
export interface MemoryHubEmbeddingOptions {
  /** When true, use the local Transformers embedding provider (all-MiniLM-L6-v2, 384-dim).
   *  Defaults to true when `@huggingface/transformers` is installed. */
  useTransformers?: boolean;
  /** Custom options forwarded to the Transformers provider. */
  transformersOptions?: TransformersEmbeddingProviderOptions;
}

export class MemoryHub {
  private shortTerm: ShortTermMemory;
  private longTerm: LongTermMemory;
  private graph: KnowledgeGraph;
  private fts5: FTS5SearchEngine;
  private curator: MemoryCurator;
  private vectorStore: VectorMemoryStore | null = null;
  private embeddingProvider: TransformersEmbeddingProvider | null = null;
  private embeddingProviderStatus: "transformers" | "unavailable" | "disabled" = "unavailable";

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    embeddingOptions?: MemoryHubEmbeddingOptions
  ) {
    this.shortTerm = new ShortTermMemoryStore();
    this.longTerm = new LongTermMemoryStore();
    this.graph = new KnowledgeGraphStore();
    this.fts5 = new FTS5SearchEngine();
    this.fts5.initialize();
    this.curator = new MemoryCurator(this.fts5);

    // Wire the embedding provider. We prefer the local Transformers pipeline
    // (all-MiniLM-L6-v2, 384-dim) when available so semantic search works
    // out of the box without an external API key. The provider is exposed via
    // getVectorStore() so RAG pipelines, semantic recall, and the Web UI can
    // use real neural embeddings rather than the hash-based simulator.
    const wantTransformers = embeddingOptions?.useTransformers ?? true;
    if (wantTransformers && TransformersEmbeddingProvider.isAvailable()) {
      try {
        this.embeddingProvider = new TransformersEmbeddingProvider(embeddingOptions?.transformersOptions);
        this.vectorStore = new VectorMemoryStore(registry, eventBus, this.embeddingProvider);
        this.embeddingProviderStatus = "transformers";
      } catch (err) {
        // Construction never throws (lazy loading), but be defensive.
        this.embeddingProviderStatus = "unavailable";
        this.embeddingProvider = null;
        this.vectorStore = null;
      }
    } else if (wantTransformers) {
      this.embeddingProviderStatus = "unavailable";
    } else {
      this.embeddingProviderStatus = "disabled";
    }

    registry.registerService("memoryHub", this);
    // Note: VectorMemoryStore's constructor already registers itself as
    // "vectorMemory" in the registry, so we do not register it again here.
  }

  getShortTerm(): ShortTermMemory {
    return this.shortTerm;
  }

  getLongTerm(): LongTermMemory {
    return this.longTerm;
  }

  getKnowledgeGraph(): KnowledgeGraph {
    return this.graph;
  }

  getFTS5(): FTS5SearchEngine {
    return this.fts5;
  }

  getCurator(): MemoryCurator {
    return this.curator;
  }

  /** Get the vector store (uses local Transformers embeddings by default).
   *  Returns null when the Transformers provider is unavailable. */
  getVectorStore(): VectorMemoryStore | null {
    return this.vectorStore;
  }

  /** Get the embedding provider instance (TransformersEmbeddingProvider). */
  getEmbeddingProvider(): TransformersEmbeddingProvider | null {
    return this.embeddingProvider;
  }

  /** Describe which embedding backend is active:
   *  - "transformers": all-MiniLM-L6-v2 via @huggingface/transformers
   *  - "unavailable": requested but @huggingface/transformers not installed
   *  - "disabled": explicitly disabled via MemoryHubEmbeddingOptions */
  getEmbeddingProviderStatus(): "transformers" | "unavailable" | "disabled" {
    return this.embeddingProviderStatus;
  }

  /**
   * Semantic search using the local Transformers embeddings.
   * Falls back to FTS5 search when the embedding provider is unavailable.
   */
  async semanticSearch(query: string, limit = 10): Promise<Array<{ id: string; score: number; text: string; metadata: Record<string, unknown> }>> {
    if (!this.vectorStore || !this.embeddingProvider) {
      // Fallback: FTS5 lexical search. FTS5 ranks lower-better (negated bm25),
      // so we surface |rank| so callers can sort score-descending.
      const fts5Results = this.searchFullText(query, limit);
      return fts5Results.map((r) => ({
        id: String(r.rowid),
        score: Math.abs(r.rank),
        text: r.content,
        metadata: (r.metadata ?? {}) as Record<string, unknown>,
      }));
    }
    try {
      const queryVec = await this.embeddingProvider.embed(query);
      const results = await this.vectorStore.search(queryVec, { limit, threshold: 0 });
      return results.map((r) => ({
        id: r.id,
        score: r.score,
        text: (r.metadata._sourceText as string) ?? "",
        metadata: r.metadata,
      }));
    } catch (err) {
      // Inference failure (e.g. native lib missing) — fall back gracefully
      return this.searchFullText(query, limit).map((r) => ({
        id: String(r.rowid),
        score: Math.abs(r.rank),
        text: r.content,
        metadata: (r.metadata ?? {}) as Record<string, unknown>,
      }));
    }
  }

  async remember(entry: Omit<MemoryEntry, "id" | "createdAt" | "accessedAt">): Promise<MemoryEntry> {
    const fullEntry: MemoryEntry = {
      ...entry,
      id: "",
      createdAt: new Date(),
      accessedAt: new Date(),
    };
    const storedEntry = await this.longTerm.store(fullEntry);
    this.fts5.indexEntry(storedEntry.id, storedEntry.content, {
      sessionId: storedEntry.metadata.sessionId,
      type: storedEntry.type,
      createdAt: storedEntry.createdAt,
    });
    // Mirror into the vector store so semantic search can recall this memory.
    // Failures are non-fatal — the entry is still retrievable via FTS5/lexical.
    if (this.vectorStore && this.embeddingProvider) {
      void this.indexMemoryVector(storedEntry).catch(() => {
        /* swallow — best-effort indexing */
      });
    }
    await this.eventBus.publish(SystemEvents.MEMORY_STORED, storedEntry, "memory-hub");
    return storedEntry;
  }

  /** Embed + index a stored memory entry into the vector store. */
  private async indexMemoryVector(entry: MemoryEntry): Promise<void> {
    if (!this.vectorStore || !this.embeddingProvider) return;
    const vec = await this.embeddingProvider.embed(entry.content);
    await this.vectorStore.addVector(entry.id, vec, {
      _sourceText: entry.content,
      _memoryType: entry.type,
      _sessionId: entry.metadata.sessionId,
      _createdAt: entry.createdAt instanceof Date ? entry.createdAt.toISOString() : String(entry.createdAt),
    });
  }

  async recall(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    const results = await this.longTerm.search(query);
    await this.eventBus.publish(SystemEvents.MEMORY_RETRIEVED, { query, results }, "memory-hub");
    return results;
  }

  searchFullText(query: string, limit?: number): FTS5SearchResult[] {
    return this.fts5.search({ query, limit });
  }

  async curateFromTurn(
    userMessage: string,
    agentResponse: string,
    context: Record<string, unknown>
  ): Promise<MemoryEntry | null> {
    return this.curator.curateFromTurn(userMessage, agentResponse, context, {
      store: (entry: MemoryEntry) => this.remember(entry),
    });
  }

  async freezeMemorySnapshot(): Promise<MemorySnapshot> {
    const allResults = await this.longTerm.search({ query: "", limit: 10000 });
    const allMemories = allResults.map((r) => r.entry);
    return this.curator.freezeSnapshot(allMemories);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async clearShortTerm(): Promise<void> {
    if (this.shortTerm) {
      this.shortTerm.clear();
    }
  }
}
