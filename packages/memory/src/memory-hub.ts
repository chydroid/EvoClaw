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
  inferCognitiveLayer,
} from "@evoclaw/core";
import * as path from "path";
import { ShortTermMemoryStore } from "./short-term-memory";
import { LongTermMemoryStore } from "./long-term-memory";
import { KnowledgeGraphStore } from "./knowledge-graph";
import { FTS5SearchEngine, type FTS5SearchResult } from "./fts5-search";
import { MemoryCurator, type MemorySnapshot } from "./memory-curator";
import { VectorMemoryStore, LocalEmbeddingProvider, type EmbeddingProvider } from "./vector-memory";
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
  /**
   * 向量索引持久化路径（与 LongTermMemoryStore 同目录）。
   * 启用后 VectorMemoryStore 在 addVector/delete 时防抖落盘，
   * 启动时自动 loadFromDisk 恢复，避免重启后语义检索降级为 FTS5。
   */
  private readonly vectorStorePath: string;
  private embeddingProvider: EmbeddingProvider | null = null;
  /** Provider label for /api/memory/status and diagnostics. */
  private embeddingProviderLabel: "transformers" | "local-tfidf" | "unavailable" | "disabled" = "unavailable";
  /** Optional transformers provider instance for isLoaded() reporting. */
  private transformersProvider: TransformersEmbeddingProvider | null = null;
  /** Tracked when transformers warmup fails — surfaced via status. */
  private embeddingLoadError: string | null = null;
  private memoryCuratorV2: import("./memory-curator-v2").MemoryCuratorV2 | null = null;
  private memoryDreaming: import("./memory-dreaming").MemoryDreaming | null = null;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    embeddingOptions?: MemoryHubEmbeddingOptions
  ) {
    // 向量索引持久化路径：${DATA_DIR}/memory/vector-index.json
    const dataDir = process.env.EVOCLAW_DATA_DIR || path.join(process.cwd(), "data");
    this.vectorStorePath = path.join(dataDir, "memory", "vector-index.json");

    this.shortTerm = new ShortTermMemoryStore();
    this.longTerm = new LongTermMemoryStore();
    this.graph = new KnowledgeGraphStore();
    this.fts5 = new FTS5SearchEngine();
    this.fts5.initialize();
    this.curator = new MemoryCurator(this.fts5);

    try {
      const { MemoryCuratorV2 } = require("./memory-curator-v2");
      this.memoryCuratorV2 = new MemoryCuratorV2();
    } catch (err) {
      process.stderr.write('[memory-hub] operation failed: ' + err + '\n');
    }

    try {
      const { MemoryDreaming } = require("./memory-dreaming");
      this.memoryDreaming = new MemoryDreaming(this);
    } catch (err) {
      process.stderr.write('[memory-hub] operation failed: ' + err + '\n');
    }

    // Wire the embedding provider. We prefer the local Transformers pipeline
    // (all-MiniLM-L6-v2, 384-dim) when the model can be loaded. The status
    // reflects what's actually usable: "transformers" (model loaded),
    // "local-tfidf" (fallback to TF-IDF when transformers can't load,
    // e.g. offline / no model weights), "unavailable" (no embedding at all),
    // or "disabled" (explicitly turned off).
    const wantTransformers = embeddingOptions?.useTransformers ?? true;

    if (wantTransformers && TransformersEmbeddingProvider.isAvailable()) {
      try {
        const transformers = new TransformersEmbeddingProvider({
          // transformers.js v4 ships ONNX-converted models under the
          // `Xenova/` namespace on HF Hub. Using bare "all-MiniLM-L6-v2"
          // resolves to the original (PyTorch) repo and returns 404. The
          // Xenova/all-MiniLM-L6-v2 model is the canonical ONNX one and
          // is mirrored on hf-mirror.com.
          ...(embeddingOptions?.transformersOptions ?? {}),
          model: embeddingOptions?.transformersOptions?.model ?? "Xenova/all-MiniLM-L6-v2",
        });
        this.transformersProvider = transformers;
        this.embeddingProvider = transformers;
        this.vectorStore = new VectorMemoryStore(registry, eventBus, transformers, this.vectorStorePath);
        this.embeddingProviderLabel = "transformers";
        this.embeddingLoadError = null;
        // Eagerly verify the model actually loads. The first call downloads
        // weights from huggingface.co, which can take 5–30s on a cold cache.
        // We do not block the constructor — the provider stays attached and
        // the status flips to "local-tfidf" if warmup ultimately fails.
        this.warmUpTransformers(transformers);
      } catch (err) {
        this.embeddingProviderLabel = "unavailable";
        this.embeddingProvider = null;
        this.vectorStore = null;
        this.embeddingLoadError = err instanceof Error ? err.message : String(err);
      }
    } else if (wantTransformers) {
      // Package not installed — fall back to local TF-IDF so we still have
      // vector-backed semantic-ish search instead of pure lexical.
      this.installLocalFallback();
    } else {
      this.embeddingProviderLabel = "disabled";
    }

    registry.registerService("memoryHub", this);
    // Note: VectorMemoryStore's constructor already registers itself as
    // "vectorMemory" in the registry, so we do not register it again here.
  }

  /**
   * Try to load the transformers model in the background. On failure, swap
   * the embedding provider to a local TF-IDF implementation so the system
   * still has a working vector store (with semantic-ish search via word
   * n-gram hashing) instead of silently doing nothing.
   */
  private warmUpTransformers(transformers: TransformersEmbeddingProvider): void {
    // Hard cap the warmup so a stalled download doesn't keep the status
    // stuck on "transformers" forever.
    const TIMEOUT_MS = 60_000;
    const timer = setTimeout(() => {
      this.embeddingLoadError = `Transformers warmup timed out after ${TIMEOUT_MS}ms`;
      this.installLocalFallback(transformers);
    }, TIMEOUT_MS);

    transformers
      .warmUp()
      .then((ok) => {
        clearTimeout(timer);
        if (ok) {
          process.stdout.write("[MemoryHub] Transformers embedding model loaded successfully\n");
          return;
        }
        // Warmup failed — switch to local TF-IDF
        const err = transformers.getLoadError();
        this.embeddingLoadError = err ? err.message : "Transformers warmup failed";
        process.stderr.write(
          `[MemoryHub] Transformers warmup failed (${this.embeddingLoadError}); falling back to local TF-IDF embeddings\n`
        );
        this.installLocalFallback(transformers);
      })
      .catch((err) => {
        clearTimeout(timer);
        this.embeddingLoadError = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[MemoryHub] Transformers warmup threw: ${this.embeddingLoadError}\n`);
        this.installLocalFallback(transformers);
      });
  }

  /**
   * Swap in the local TF-IDF embedding provider. Uses the same 384-dim
   * vector store so callers don't need to know which backend is active.
   */
  private installLocalFallback(transformersToReplace?: TransformersEmbeddingProvider): void {
    if (this.embeddingProviderLabel === "local-tfidf") return; // already installed
    const local = new LocalEmbeddingProvider();
    this.embeddingProvider = local;
    this.transformersProvider = null;
    this.embeddingProviderLabel = "local-tfidf";
    // The first VectorMemoryStore already registered "vectorMemory" with
    // the service registry. We need to construct a new one (so its
    // internal provider points at the local TF-IDF) and replace the
    // registry pointer. The VectorMemoryStore constructor calls
    // registerService() unconditionally, which throws if the key still
    // exists — so we delete the old key first, then let the constructor
    // register, then re-assert via replaceService() to keep the API
    // explicit.
    if (this.registry.hasService("vectorMemory")) {
      this.registry.unregisterService("vectorMemory");
    }
    this.vectorStore = new VectorMemoryStore(this.registry, this.eventBus, local, this.vectorStorePath);
    this.registry.replaceService("vectorMemory", this.vectorStore);
    if (transformersToReplace) {
      // Drop the transformers reference so the heavy static pipeline cache
      // can be GC'd if no other provider holds it.
      void transformersToReplace;
    }
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

  /** Get the vector store. Returns null when no embedding backend is wired. */
  getVectorStore(): VectorMemoryStore | null {
    return this.vectorStore;
  }

  /** Get the active embedding provider (Transformers or Local TF-IDF). */
  getEmbeddingProvider(): EmbeddingProvider | null {
    return this.embeddingProvider;
  }

  /** Describe which embedding backend is active:
   *  - "transformers": all-MiniLM-L6-v2 via @huggingface/transformers (model loaded)
   *  - "local-tfidf": local TF-IDF (used when transformers can't load)
   *  - "unavailable": no embedding backend available
   *  - "disabled": explicitly disabled via MemoryHubEmbeddingOptions */
  getEmbeddingProviderStatus(): "transformers" | "local-tfidf" | "unavailable" | "disabled" {
    return this.embeddingProviderLabel;
  }

  /** Error message from the most recent failed embedding warmup, or null. */
  getEmbeddingLoadError(): string | null {
    return this.embeddingLoadError;
  }

  /** True when the active embedding provider has been warmed up successfully. */
  isEmbeddingReady(): boolean {
    if (this.embeddingProviderLabel === "transformers") {
      return !!this.transformersProvider?.isLoaded();
    }
    if (this.embeddingProviderLabel === "local-tfidf") {
      return true; // TF-IDF is always ready (no model load required)
    }
    return false;
  }

  /** Number of vectors currently stored (for /api/memory/status diagnostics). */
  getVectorIndexSize(): number {
    return this.vectorStore?.size() ?? 0;
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
    // 若调用方未指定 cognitiveLayer，由 type + metadata 推断（认知三层分层）
    if (!fullEntry.cognitiveLayer) {
      fullEntry.cognitiveLayer = inferCognitiveLayer(fullEntry);
    }
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
    // 客户端按 cognitiveLayer 过滤（LongTermMemoryStore 的 SQLite/JSON 实现未感知此字段）
    // 推断每条结果的 cognitiveLayer（若存储时未设置），再按查询条件过滤
    const filtered = query.cognitiveLayer
      ? results.filter((r) => {
          const layer = r.entry.cognitiveLayer ?? inferCognitiveLayer(r.entry);
          return layer === query.cognitiveLayer;
        })
      : results;
    await this.eventBus.publish(SystemEvents.MEMORY_RETRIEVED, { query, results: filtered }, "memory-hub");
    return filtered;
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

  async curateMemories(): Promise<{ retained: number; decayed: number; compressed: number }> {
    if (!this.memoryCuratorV2) return { retained: 0, decayed: 0, compressed: 0 };
    // Get all memories from long-term store
    const memories = await this.longTerm.search({ query: "", limit: 1000 });
    const DAY_MS = 24 * 60 * 60 * 1000;
    // 统一的年龄计算：非法 createdAt 视为 age=0（新条目），避免 NaN 导致后续 age>30 永远为 false
    // 而旧记忆永不压缩（违反 Map 无限增长约束）。
    const computeAge = (createdAt: unknown): number => {
      if (!createdAt) return 0;
      const t = new Date(createdAt as string).getTime();
      return Number.isNaN(t) ? 0 : (Date.now() - t) / DAY_MS;
    };
    const entries = memories.map(m => ({
      id: m.entry.id,
      content: m.entry.content,
      type: m.entry.type as string || "conversation",
      accessCount: 0,
      age: computeAge(m.entry.createdAt),
      importance: m.entry.metadata?.importance as number | undefined,
    }));
    const curation = this.memoryCuratorV2.curateMemories(entries);
    // Remove decayed memories
    for (const id of curation.decay) {
      await this.longTerm.delete(id);
    }
    // Re-fetch surviving entries — the `entries` array above is stale after
    // deletion and would reference ids that no longer exist.
    const surviving = await this.longTerm.search({ query: "", limit: 1000 });
    // Compress old memories (age is in days, 30 days threshold)
    const oldEntries = surviving
      .filter(m => {
        const age = computeAge(m.entry.createdAt);
        return age > 30;
      })
      .map(m => ({
        id: m.entry.id,
        content: m.entry.content,
        type: (m.entry.type as string) || "conversation",
        age: computeAge(m.entry.createdAt),
      }));
    const compressed = this.memoryCuratorV2.compressOldMemories(oldEntries);
    // Persist compressed memories back: add the summary as a new entry and
    // remove the original. Otherwise the compression result is lost.
    for (const c of compressed) {
      await this.remember({
        type: "knowledge",
        content: c.summary,
        embedding: null,
        metadata: {
          source: "memory-curator:compression",
          sessionId: "",
          userId: "",
          tags: ["compressed"],
          importance: 0.5,
          associations: [],
          entities: [],
        },
        ttl: 0,
      });
      await this.longTerm.delete(c.id);
    }
    return {
      retained: curation.retain.length,
      decayed: curation.decay.length,
      compressed: compressed.length,
    };
  }

  async reasonWithKnowledgeGraph(query: string): Promise<import("@evoclaw/core").ReasoningResult | null> {
    const kg = this.graph;
    if (!kg || typeof (kg as any).reason !== "function") return null;
    try {
      return await (kg as any).reason(query);
    } catch (err) {
      process.stderr.write('[memory-hub] operation failed: ' + err + '\n');
      return null;
    }
  }

  async dream(phase?: import("./memory-dreaming").DreamPhase): Promise<import("./memory-dreaming").DreamSession | null> {
    if (!this.memoryDreaming) return null;
    return this.memoryDreaming.dream(phase);
  }

  getDreamDiary(): import("./memory-dreaming").DreamDiary | null {
    if (!this.memoryDreaming) return null;
    return this.memoryDreaming.getDiary();
  }

  shouldDream(): boolean {
    if (!this.memoryDreaming) return false;
    return this.memoryDreaming.shouldDream();
  }

  /** 释放底层 SQLite 句柄与定时器，防止文件描述符泄漏 */
  close(): void {
    try { this.fts5.close(); } catch { /* ignore */ }
    try {
      const lt = this.longTerm as unknown as { close?: () => void | Promise<void> };
      if (typeof lt?.close === "function") {
        const r = lt.close();
        if (r instanceof Promise) r.catch(() => { /* ignore */ });
      }
    } catch { /* ignore */ }
  }
}
