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
 */

export { ConversationRecorder } from "./conversation-recorder";
export type { ConversationMessage } from "./conversation-recorder";

export { AtomicMemoryExtractor } from "./atomic-memory-extractor";
export type { AtomicMemory, AtomicMemoryType } from "./atomic-memory-extractor";

export { SceneBlockAggregator } from "./scene-block-aggregator";
export type { SceneBlock, SceneAggregationOptions } from "./scene-block-aggregator";

export { PersonaProfileGenerator } from "./persona-profile";
export type { PersonaProfile, PersonaEntry, PersonaTopic, PersonaProfileOptions } from "./persona-profile";

export { SymbolicMemoryCanvas } from "./symbolic-memory-canvas";
export type { MemoryCanvas, CanvasNode, CanvasEdge, CanvasNodeType, CanvasOptions } from "./symbolic-memory-canvas";

export { LayeredMemory } from "./layered-memory";
export type { TurnInput, LayeredRecallResult, LayeredMemoryConfig } from "./layered-memory";
