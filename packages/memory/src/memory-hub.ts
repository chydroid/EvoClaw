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

// ── R1-4: 记忆上下文 sanitize + fence 标签协议（借鉴 hermes-agent sanitize_context） ──

/**
 * 记忆上下文 fence 标签。注入到 prompt 时用此标签包裹，
 * 明确界定记忆边界，防止 LLM 将记忆误读为新用户输入。
 */
export const MEMORY_CONTEXT_FENCE_OPEN = "<memory-context>";
export const MEMORY_CONTEXT_FENCE_CLOSE = "</memory-context>";

/**
 * 需要从记忆上下文中剥离的注入标签模式。
 *
 * 借鉴 hermes-agent memory_manager.py 的 sanitize_context：
 *   - <memory-context>...</memory-context>
 *   - [System note: ...]
 *   - [Context from memory: ...]
 *   - 旧版 [Compacted ...] 标签
 */
const SANITIZE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // <memory-context>...</memory-context>（含跨行）
  { pattern: /<memory-context>[\s\S]*?<\/memory-context>/gi, replacement: "" },
  // [System note: ...] 系统注释（到行尾或下一个 ] ）
  { pattern: /\[System note:[^\]]*\]/gi, replacement: "" },
  // [Context from memory: ...]
  { pattern: /\[Context from memory:[^\]]*\]/gi, replacement: "" },
  // [Compacted ...]（旧版压缩标记）
  { pattern: /\[Compacted[^\]]*\]/gi, replacement: "" },
  // [This is a continuation of session ...]（旧版 successor 标记）
  { pattern: /\[This is a continuation of session[^\]]*\]/gi, replacement: "" },
];

/**
 * 清洗记忆上下文：剥离注入的 fence 标签和系统注释。
 *
 * 借鉴 hermes-agent sanitize_context：
 *   - 防止 memory provider 注入的 fence 标签泄漏到用户可见输出
 *   - 防止旧的压缩标记嵌入正文持续劫持回复
 *
 * @param text 待清洗的文本
 * @returns 清洗后的文本
 */
export function sanitizeMemoryContext(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SANITIZE_PATTERNS) {
    // 重置 lastIndex 防止 g flag 累积
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result.trim();
}

/**
 * 用 fence 标签包裹记忆上下文。
 *
 * @param content 记忆内容
 * @returns 包裹后的文本：<memory-context>content</memory-context>
 */
export function wrapMemoryContext(content: string): string {
  return `${MEMORY_CONTEXT_FENCE_OPEN}\n${content}\n${MEMORY_CONTEXT_FENCE_CLOSE}`;
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
  /** Transformers warmup 超时定时器句柄；close() 时清理，避免阻止 Node 优雅退出 */
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;
  private memoryCuratorV2: import("./memory-curator-v2").MemoryCuratorV2 | null = null;
  /** curateMemories 串行化链：避免并发调用产生重复压缩条目。 */
  private curateChain: Promise<unknown> = Promise.resolve();
  private memoryDreaming: import("./memory-dreaming").MemoryDreaming | null = null;
  /**
   * 分层记忆系统（L0→L1→L2→L3 + 符号画布），借鉴 TencentDB-Agent-Memory。
   * 通过 captureTurn 写入、recall 注入到 prompt。可选启用——若构造失败
   * （如 dataDir 不可写），MemoryHub 仍可降级到原有 vector/FTS5 链路。
   */
  private layeredMemory: import("./layered").LayeredMemory | null = null;

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

    // 分层记忆（L0→L1→L2→L3 + 符号画布）—— 借鉴 TencentDB-Agent-Memory。
    // 失败时降级到原有 vector/FTS5 链路，不影响 MemoryHub 主功能。
    try {
      const { LayeredMemory } = require("./layered");
      this.layeredMemory = new LayeredMemory(dataDir);
    } catch (err) {
      process.stderr.write('[memory-hub] LayeredMemory init failed, falling back to flat memory: ' + err + '\n');
      this.layeredMemory = null;
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
      this.warmupTimer = null;
      this.embeddingLoadError = `Transformers warmup timed out after ${TIMEOUT_MS}ms`;
      this.installLocalFallback(transformers);
    }, TIMEOUT_MS);
    // unref 防止 warmup 阻止 Node.js 优雅退出
    timer.unref();
    this.warmupTimer = timer;

    transformers
      .warmUp()
      .then((ok) => {
        clearTimeout(timer);
        this.warmupTimer = null;
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
        this.warmupTimer = null;
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

  /**
   * 获取分层记忆系统（L0→L1→L2→L3 + 符号画布）。
   * 若构造失败则返回 null，调用方需判空。
   */
  getLayeredMemory(): import("./layered").LayeredMemory | null {
    return this.layeredMemory;
  }

  /**
   * 捕获一轮对话到分层记忆系统（L0→L1→L2→L3）。
   * 若分层记忆未启用，返回 null。失败不抛错（best-effort）。
   */
  async captureTurnToLayeredMemory(turn: {
    userText: string;
    assistantText: string;
    sessionKey: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<import("./layered").LayeredRecallResult | null> {
    if (!this.layeredMemory) return null;
    try {
      await this.layeredMemory.captureTurn(turn);
      return this.layeredMemory.recall(turn.userText);
    } catch (err) {
      process.stderr.write(`[memory-hub] captureTurnToLayeredMemory failed: ${err}\n`);
      return null;
    }
  }

  /**
   * 召回分层记忆（L1 + L3 画像），返回可注入到 prompt 的上下文。
   * 若分层记忆未启用，返回 null。
   */
  recallFromLayeredMemory(query: string): import("./layered").LayeredRecallResult | null {
    if (!this.layeredMemory) return null;
    try {
      return this.layeredMemory.recall(query);
    } catch (err) {
      process.stderr.write(`[memory-hub] recallFromLayeredMemory failed: ${err}\n`);
      return null;
    }
  }

  /**
   * 记录工具调用节点到符号画布（Agent 执行流程的 hook）。
   * 借鉴 Infinite-Canvas 的 CanvasAgentOp 思路：Agent 操作 → 画布节点。
   * 失败不抛错（best-effort）。
   */
  recordToolNodeToCanvas(params: {
    toolName: string;
    params?: Record<string, unknown>;
    success: boolean;
    error?: string;
    resultPreview?: string;
    sessionId: string;
  }): { nodeId: string; mermaid: string } | null {
    if (!this.layeredMemory) return null;
    try {
      return this.layeredMemory.recordToolNode(params);
    } catch (err) {
      process.stderr.write(`[memory-hub] recordToolNodeToCanvas failed: ${err}\n`);
      return null;
    }
  }

  /** 获取符号画布快照（用于前端节点图渲染）。 */
  getCanvasSnapshot(): { nodes: unknown[]; edges: unknown[]; sessionKey: string; createdAt: number } | null {
    if (!this.layeredMemory) return null;
    try {
      return this.layeredMemory.getCanvasSnapshot();
    } catch (err) {
      process.stderr.write(`[memory-hub] getCanvasSnapshot failed: ${err}\n`);
      return null;
    }
  }

  /**
   * 应用 CanvasAgentOp 数组到画布（借鉴 Infinite-Canvas 的 applyCanvasAgentOps）。
   * 失败不抛错（best-effort）。
   */
  applyCanvasOps(ops: unknown[]): { nodes: unknown[]; edges: unknown[] } | null {
    if (!this.layeredMemory) return null;
    try {
      return this.layeredMemory.applyCanvasOps(ops as never);
    } catch (err) {
      process.stderr.write(`[memory-hub] applyCanvasOps failed: ${err}\n`);
      return null;
    }
  }

  /** 获取符号画布 Mermaid 文本。 */
  getCanvasMermaid(): string {
    if (!this.layeredMemory) return "";
    try {
      return this.layeredMemory.getCanvasMermaid();
    } catch {
      return "";
    }
  }

  /** 获取分层记忆统计快照（用于 WebUI）。失败返回 null。 */
  getLayeredStats(): {
    turnCount: number;
    l0: { sessionCount: number; totalMessages: number; sessions: Array<{ key: string; messageCount: number }> };
    l1: { totalMemories: number; pendingCount: number; dedupSkippedTotal: number; byType: Record<string, number>; byPriority: Record<string, number> };
    l2: { sceneCount: number; lastTrigger: unknown };
    l3: { personaEntries: number; lastUpdatedAt: number | null };
    canvas: { nodeCount: number; edgeCount: number; active: boolean; sessionKey: string | null };
    config: Record<string, unknown>;
  } | null {
    if (!this.layeredMemory) return null;
    try {
      return this.layeredMemory.getStats();
    } catch (err) {
      process.stderr.write(`[memory-hub] getLayeredStats failed: ${err}\n`);
      return null;
    }
  }

  /**
   * 剥离消息历史中的召回标签（<relevant-memories> / <task-canvas>）。
   *
   * 借鉴 TencentDB-Agent-Memory 的 before_message_write hook：
   * 写入 L0 / LongTermMemory 前调用此方法，防止召回内容污染历史。
   * 失败不抛错（best-effort）。
   */
  stripRecallTagsFromHistory(messages: Array<{ role?: string; content?: string | unknown }>): void {
    try {
      const { stripRecallTagsFromMessages } = require("./layered");
      stripRecallTagsFromMessages(messages);
    } catch (err) {
      process.stderr.write(`[memory-hub] stripRecallTagsFromHistory failed: ${err}\n`);
    }
  }

  /**
   * 等待所有后台任务完成（进程关闭前调用）。
   *
   * 借鉴 TencentDB-Agent-Memory 的 destroy() drain 模式：
   * - 5 秒超时保护
   * - 超时后强制返回，未完成任务继续在后台跑（不杀）
   *
   * @returns drain 统计信息（completed/timedOut/errors）
   */
  async drainLayeredMemory(): Promise<{
    completed: number;
    timedOut: number;
    errors: Array<{ description: string; error: unknown }>;
  }> {
    if (!this.layeredMemory) {
      return { completed: 0, timedOut: 0, errors: [] };
    }
    try {
      return await this.layeredMemory.drain();
    } catch (err) {
      process.stderr.write(`[memory-hub] drainLayeredMemory failed: ${err}\n`);
      return { completed: 0, timedOut: 0, errors: [{ description: "drain", error: err }] };
    }
  }

  /**
   * 检查场景数量三级预警（red/orange/yellow/green）。
   *
   * 借鉴 TencentDB-Agent-Memory 的 scene-extractor 三级预警：
   * - red：必须先 MERGE，不允许 CREATE
   * - orange：只能 UPDATE
   * - yellow：优先 UPDATE 或 MERGE
   * - green：可自由 CREATE
   *
   * @returns 预警级别 + 当前场景数 + 推荐操作
   */
  checkSceneWarning(): {
    level: "green" | "yellow" | "orange" | "red";
    currentCount: number;
    maxScenes: number;
    recommendation: string;
  } | null {
    if (!this.layeredMemory) return null;
    try {
      return this.layeredMemory.getAggregator().checkSceneWarning();
    } catch (err) {
      process.stderr.write(`[memory-hub] checkSceneWarning failed: ${err}\n`);
      return null;
    }
  }

  /**
   * 扫描所有场景，提取 Persona Update Signal（[PERSONA_UPDATE_REQUEST] 标签）。
   *
   * 借鉴 TencentDB-Agent-Memory 的 parsePersonaUpdateSignal：
   * - 检测场景内容中的 [PERSONA_UPDATE_REQUEST] 标签
   * - 提取标签后的指令文本
   * - 用于触发 L3 画像刷新
   *
   * @returns 所有场景中检测到的画像更新指令
   */
  collectPersonaUpdateSignals(): string[] {
    if (!this.layeredMemory) return [];
    try {
      return this.layeredMemory.getAggregator().collectPersonaUpdateSignals();
    } catch (err) {
      process.stderr.write(`[memory-hub] collectPersonaUpdateSignals failed: ${err}\n`);
      return [];
    }
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
    // 内容大小限制：防止超大文本（如整个文件内容被误存）导致 OOM 或
    // embedding 接口超时。32KB 足以容纳典型对话片段和摘要。
    const MAX_MEMORY_CONTENT_LEN = 32_000;
    if (entry.content && entry.content.length > MAX_MEMORY_CONTENT_LEN) {
      const truncated = entry.content.slice(0, MAX_MEMORY_CONTENT_LEN) +
        `\n\n[系统提示：原始记忆内容过长（${entry.content.length} 字符），已截断至 ${MAX_MEMORY_CONTENT_LEN} 字符]`;
      // 在 reassignment 前保存原始长度，否则日志会读到截断后的长度
      const originalLen = entry.content.length;
      entry = { ...entry, content: truncated };
      process.stderr.write(`[MemoryHub] Memory entry content truncated from ${originalLen} to ${MAX_MEMORY_CONTENT_LEN} chars\n`);
    }
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
    // 串行化：remember 与 delete 之间无事务保护，并发 curateMemories 会产生重复压缩条目。
    // 用 Promise 链串行化，确保同一时刻只有一个 curate 在执行。
    const run = this.curateChain.then(() => this.doCurateMemories());
    this.curateChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doCurateMemories(): Promise<{ retained: number; decayed: number; compressed: number }> {
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

  /** 释放底层 SQLite 句柄、定时器与未落盘的脏数据，防止文件描述符泄漏和数据丢失 */
  async close(): Promise<void> {
    // 0. 清理 transformers warmup 超时定时器
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }

    // 1. 先 drain 分层记忆的后台任务（L1 持久化等），防止未落盘的 JSONL 行丢失
    // 安全：await drain/flush 完成后再关闭底层句柄，旧实现用 void 丢弃导致数据丢失
    try {
      const lm = this.layeredMemory as unknown as { drain?: () => Promise<unknown> };
      if (typeof lm?.drain === "function") {
        await lm.drain().catch(() => { /* ignore */ });
      }
    } catch { /* ignore */ }

    // 2. flush 向量存储的 dirty 数据，防止未落盘的向量丢失
    try {
      const vs = this.vectorStore as unknown as { flush?: () => Promise<unknown> };
      if (typeof vs?.flush === "function") {
        await vs.flush().catch(() => { /* ignore */ });
      }
    } catch { /* ignore */ }

    // 3. 释放知识图谱（dispose 会 save dirty + clear timer）
    try {
      const g = this.graph as unknown as { dispose?: () => void };
      if (typeof g?.dispose === "function") g.dispose();
    } catch { /* ignore */ }

    // 4. 释放短期记忆的 cleanupInterval
    try {
      const st = this.shortTerm as unknown as { destroy?: () => void };
      if (typeof st?.destroy === "function") st.destroy();
    } catch { /* ignore */ }

    // 5. 关闭 FTS5
    try { this.fts5.close(); } catch { /* ignore */ }

    // 6. 关闭长期记忆（SQLite）
    try {
      const lt = this.longTerm as unknown as { close?: () => void | Promise<void> };
      if (typeof lt?.close === "function") {
        const r = lt.close();
        if (r instanceof Promise) await r.catch(() => { /* ignore */ });
      }
    } catch { /* ignore */ }
  }
}
