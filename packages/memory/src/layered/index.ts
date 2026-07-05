/**
 * Layered Memory Module — 分层记忆系统。
 *
 * 借鉴 TencentDB-Agent-Memory 的 L0→L1→L2→L3 语义金字塔设计：
 * - L0 ConversationRecorder: 原始对话流（JSONL）
 * - L1 AtomicMemoryExtractor: 启发式原子记忆提取
 * - L2 SceneBlockAggregator: 情境块聚合（Markdown）
 * - L3 PersonaProfileGenerator: 跨会话用户画像
 * - SymbolicMemoryCanvas: Mermaid 符号记忆画布（长任务上下文压缩）
 *
 * 主入口：LayeredMemory（统一 facade）
 *
 * 第二轮借鉴新增（v0.68.0）：
 * - atomic-write / jsonl-defense: 原子写 + 四层 JSONL 防御
 * - l1-dedup: L1 智能去重（向量 → FTS → keyword 三层降级）
 * - hybrid-search: BM25 + 向量 + RRF 融合检索
 * - recall-budget: 双重预算控制（单条 + 总量）
 * - relevant-memories-tag: 召回标签管理（防止污染历史）
 * - storage-context: 不可变路径上下文（多 session 隔离）
 * - bg-tasks: 后台任务注册表 + 安全 drain
 * - token-estimate: 快速 token 估算
 * - task-boundary: L1.5 任务边界判定
 * - l2-trigger: L2 Mermaid 独立触发（双触发条件）
 * - compaction-l3: L3 三级压缩（Mild/Aggressive/Emergency）
 */

export { ConversationRecorder } from "./conversation-recorder";
export type { ConversationMessage } from "./conversation-recorder";

export { AtomicMemoryExtractor } from "./atomic-memory-extractor";
export type { AtomicMemory, AtomicMemoryType } from "./atomic-memory-extractor";

export { SceneBlockAggregator, PERSONA_UPDATE_SIGNAL } from "./scene-block-aggregator";
export type { SceneBlock, SceneAggregationOptions, SceneWarningLevel } from "./scene-block-aggregator";

export { PersonaProfileGenerator } from "./persona-profile";
export type { PersonaProfile, PersonaEntry, PersonaTopic, PersonaProfileOptions } from "./persona-profile";

export { SymbolicMemoryCanvas } from "./symbolic-memory-canvas";
export type { MemoryCanvas, CanvasNode, CanvasEdge, CanvasNodeType, CanvasOptions } from "./symbolic-memory-canvas";

export { LayeredMemory } from "./layered-memory";
export type { TurnInput, LayeredRecallResult, LayeredMemoryConfig } from "./layered-memory";

export {
  applyCanvasAgentOps,
  batchAddToolNodes,
  chainConnectOps,
  summarizeCanvasAgentOps,
} from "./canvas-agent-ops";
export type { CanvasAgentOp } from "./canvas-agent-ops";

// 第二轮借鉴（v0.68.0）— 工程鲁棒性 + 召回质量
export { atomicWriteFileSync, appendJsonlAtomic } from "./atomic-write";
export {
  sanitizeText,
  sanitizeJsonLine,
  validateEntry,
  parseJsonlSafe,
  serializeJsonlLine,
} from "./jsonl-defense";
export type { ValidationResult, ParseResult } from "./jsonl-defense";

export {
  L1Dedupifier,
  cosineSimilarity,
  extractKeywords,
  applyDedupDecisions,
} from "./l1-dedup";
export type { DedupAction, DedupDecision, L1DedupOptions, EmbedFn } from "./l1-dedup";

export {
  fuseWithRrf,
  SimpleBM25Searcher,
  VectorSearcher,
  hybridSearch,
} from "./hybrid-search";
export type { SearchResult, RrfResult, RrfOptions } from "./hybrid-search";

export { applyRecallBudget, remainingBudget } from "./recall-budget";
export type { RecallBudgetOptions, BudgetResult } from "./recall-budget";

export {
  RELEVANT_MEMORIES_OPEN,
  RELEVANT_MEMORIES_CLOSE,
  CANVAS_BLOCK_OPEN,
  CANVAS_BLOCK_CLOSE,
  stripRecallTags,
  stripRecallTagsFromMessages,
  wrapRelevantMemories,
  wrapTaskCanvas,
  hasRecallTags,
} from "./relevant-memories-tag";

export { parseSessionKey, safeDirName, createStorageContext, createGlobalStorageContext } from "./storage-context";
export type { StorageContext } from "./storage-context";

export { BackgroundTaskRegistry } from "./bg-tasks";
export type { BgTaskRegistryOptions } from "./bg-tasks";

export { quickTokenEstimate, estimateMessagesTokens, QuickSkipCounter } from "./token-estimate";

export { TaskBoundaryJudge, shouldEndCanvas } from "./task-boundary";
export type { TaskType, TaskBoundaryDecision, TaskBoundaryOptions } from "./task-boundary";

export { L2Trigger } from "./l2-trigger";
export type { L2TriggerOptions, L2TriggerDecision, L2TriggerState } from "./l2-trigger";

export { L3Compactor, computeFingerprint } from "./compaction-l3";
export type { CompactionResult, CompactionLevel, L3CompactionOptions, CompactionMessage } from "./compaction-l3";
