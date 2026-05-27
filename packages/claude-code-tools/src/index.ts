/**
 * EvoClaw Claude Code Tools — 增强工具集
 * 
 * 借鉴 Claude Agent SDK 的 12 大核心优势设计，为 EvoClaw 提供：
 *   - 多轮状态持久化 (Sessions: continue/resume/fork)
 *   - 子代理分层委派 (SubAgents: fork/fresh/aggregate)
 *   - Hook 生命周期拦截 (12 事件: PreToolUse/PostToolUse/Stop...)
 *   - 多层上下文压缩 (MicroCompact → FullCompact)
 *   - 文件变更检查点 (Snapshot → Rollback)
 *   - 智能错误诊断 (Pattern match → Fix suggestion)
 *   - 项目依赖分析 (Deps graph → Vulnerability scan)
 *   - Token 用量追踪 (Cost estimation → Budget alerts)
 */

// ── Session & State Management ──
export {
  createSessionState,
  continueSession,
  resumeSession,
  forkSession,
} from "./session-state-manager";
export type {
  SessionState,
  SessionStore,
  SessionFork,
} from "./session-state-manager";
export { MemorySessionStore } from "./session-state-manager";

// ── Sub-Agent Dispatcher ──
export { SubAgentDispatcher, DispatchMode } from "./subagent-dispatcher";
export type {
  SubAgentTask,
  SubAgentResult,
} from "./subagent-dispatcher";

// ── Hook Pipeline ──
export { HookEvent, HookDecision, HookPipeline, createDefaultHookPipeline } from "./hook-pipeline";
export type {
  HookContext,
  HookHandler,
} from "./hook-pipeline";

// ── Context Compressor ──
export { CompactionLevel, ContextCompressor, estimateTokens } from "./context-compressor";
export type {
  CompactionResult,
} from "./context-compressor";

// ── File Checkpointer ──
export { FileCheckpointer } from "./file-checkpointer";
export type {
  FileSnapshot,
  Checkpoint,
} from "./file-checkpointer";

// ── Error Diagnostician ──
export { ErrorDiagnostician } from "./error-diagnostician";
export type {
  ErrorDiagnosis,
} from "./error-diagnostician";

// ── Dependency Analyzer ──
export { DependencyAnalyzer } from "./dependency-analyzer";
export type {
  DepNode,
  DepGraph,
} from "./dependency-analyzer";

// ── Cost Tracker ──
export { CostTracker, MODEL_PRICING } from "./cost-tracker";
export type {
  TokenUsage,
  CostRecord,
} from "./cost-tracker";

// ── Task Decomposer ──
export { TaskDecomposer, DecompositionStrategy } from "./task-decomposer";
export type {
  TaskPlan,
  SubTask,
  DecompositionContext,
} from "./task-decomposer";

// ── LLM Dispatcher ──
export { LLMDispatcher } from "./llm-dispatcher";

// ── Task Orchestrator ──
export { TaskOrchestrator } from "./task-orchestrator";
export type {
  ExecutionResult,
  ProgressCallback,
  ProgressEvent,
  CapabilityAssessment,
} from "./task-orchestrator";

// ── Capability Upgrade ──
export { CapabilityUpgrader } from "./capability-upgrade";
export type {
  UpgradeAction,
} from "./capability-upgrade";

// ── Claude Code Plugin ──
export { ClaudeCodePlugin, CLAUDE_CODE_PLUGIN_INFO } from "./claude-code-plugin";