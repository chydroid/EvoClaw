export { MemoryHub } from "./memory-hub";
export type { MemoryHubEmbeddingOptions } from "./memory-hub";
export { ShortTermMemoryStore } from "./short-term-memory";
export { LongTermMemoryStore } from "./long-term-memory";
export { KnowledgeGraphStore } from "./knowledge-graph";
export { VectorMemoryStore, EmbeddingSimulator, OpenAIEmbeddingProvider, LocalEmbeddingProvider, FallbackEmbeddingProvider } from "./vector-memory";
export type { EmbeddingProvider } from "./vector-memory";
export { TransformersEmbeddingProvider } from "./transformers-embedding";
export type { TransformersEmbeddingProviderOptions } from "./transformers-embedding";
export { SemanticMemoryStore } from "./semantic-memory";
export type { SemanticMemoryEntry, SemanticSearchResult, SemanticMemoryConfig } from "./semantic-memory";
export { MemoryHost } from "./memory-host-sdk";
export type { MemoryHostEntry, MemoryHostQuery, MemoryHostConfig } from "./memory-host-sdk";
export { MemoryWeaver } from "./memory-weaver";
export type { MemoryFragment, MemoryCluster, ConsolidatedMemory, Timeline, MemoryWeaverConfig } from "./memory-weaver";
export { FTS5SearchEngine } from "./fts5-search";
export type { FTS5SearchResult, FTS5SearchOptions } from "./fts5-search";
export { MemoryCurator } from "./memory-curator";
export type { CurationDecision, MemorySnapshot } from "./memory-curator";
export { MemoryCuratorV2 } from "./memory-curator-v2";
export type { MemoryEntryInput, MemoryEntryWithId, CompressibleEntry, CompressedMemory, CurationResult } from "./memory-curator-v2";
export { MemoryDreaming, DreamPhase } from "./memory-dreaming";
export type { DreamSession, DreamFact, DreamDiary, DreamingConfig } from "./memory-dreaming";
export { chunkDocument, RAGPipeline, SimpleReranker } from "./rag";
export type { ChunkOptions, DocumentChunk, RAGPipelineConfig, RAGDocument, RAGRetrievalResult, RerankInput, RerankResult } from "./rag";

// ── Memory Provider 插件系统 ──
// 借鉴 hermes-agent 的 MemoryProvider ABC 设计，提供声明式记忆 provider 接口
export { MemoryProviderManager } from "./memory-provider";
export type {
  MemoryProvider,
  MemoryProviderContext,
  TurnData,
  ToolSchema,
} from "./memory-provider";
export { BuiltinMemoryProvider } from "./providers/builtin-provider";

// ── Layered Memory (L0→L1→L2→L3 + Symbolic Canvas) ──
// 借鉴 TencentDB-Agent-Memory 的语义金字塔设计
export {
  ConversationRecorder,
  AtomicMemoryExtractor,
  SceneBlockAggregator,
  PERSONA_UPDATE_SIGNAL,
  PersonaProfileGenerator,
  SymbolicMemoryCanvas,
  LayeredMemory,
  applyCanvasAgentOps,
  batchAddToolNodes,
  chainConnectOps,
  summarizeCanvasAgentOps,
  // 第二轮借鉴（v0.68.0）— 工程鲁棒性 + 召回质量
  atomicWriteFileSync,
  appendJsonlAtomic,
  sanitizeText,
  sanitizeJsonLine,
  validateEntry,
  parseJsonlSafe,
  serializeJsonlLine,
  L1Dedupifier,
  cosineSimilarity,
  extractKeywords,
  applyDedupDecisions,
  fuseWithRrf,
  SimpleBM25Searcher,
  VectorSearcher,
  hybridSearch,
  applyRecallBudget,
  remainingBudget,
  RELEVANT_MEMORIES_OPEN,
  RELEVANT_MEMORIES_CLOSE,
  CANVAS_BLOCK_OPEN,
  CANVAS_BLOCK_CLOSE,
  stripRecallTags,
  stripRecallTagsFromMessages,
  wrapRelevantMemories,
  wrapTaskCanvas,
  hasRecallTags,
  parseSessionKey,
  safeDirName,
  createStorageContext,
  createGlobalStorageContext,
  BackgroundTaskRegistry,
  quickTokenEstimate,
  estimateMessagesTokens,
  QuickSkipCounter,
  TaskBoundaryJudge,
  shouldEndCanvas,
  L2Trigger,
  L3Compactor,
  computeFingerprint,
} from "./layered";
export type {
  ConversationMessage,
  AtomicMemory,
  AtomicMemoryType,
  SceneBlock,
  SceneAggregationOptions,
  SceneWarningLevel,
  PersonaProfile,
  PersonaEntry,
  PersonaTopic,
  PersonaProfileOptions,
  MemoryCanvas,
  CanvasNode,
  CanvasEdge,
  CanvasNodeType,
  CanvasOptions,
  TurnInput,
  LayeredRecallResult,
  LayeredMemoryConfig,
  CanvasAgentOp,
  // 第二轮借鉴（v0.68.0）
  ValidationResult,
  ParseResult,
  DedupAction,
  DedupDecision,
  L1DedupOptions,
  EmbedFn,
  SearchResult,
  RrfResult,
  RrfOptions,
  RecallBudgetOptions,
  BudgetResult,
  StorageContext,
  BgTaskRegistryOptions,
  TaskType,
  TaskBoundaryDecision,
  TaskBoundaryOptions,
  L2TriggerOptions,
  L2TriggerDecision,
  L2TriggerState,
  CompactionResult,
  CompactionLevel,
  L3CompactionOptions,
  CompactionMessage,
} from "./layered";