// Core type definitions for AgentModelExecutor

import type { PersonaConfig } from "@evoclaw/core";

export interface ModelConfig {
  provider: "openai" | "anthropic" | "deepseek" | "local" | "custom";
  model: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens: number;
  temperature: number;
  timeout: number;
  topP?: number;
  /** ReAct 循环最大迭代次数（默认 20，复杂任务可调高） */
  maxIterations?: number;
  /** 单次 chat() 整体超时（毫秒），默认 0 = 禁用（靠 max_iterations 限制 + 用户中断）。
   * 对于需要长时间运行的编程任务，建议设为 0 或很大的值。 */
  chatTimeoutMs?: number;
}

export interface ProviderConfig extends ModelConfig {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  successCount?: number;
  failureCount?: number;
  lastError?: string;
  lastErrorType?: string;
  /** Ordered list of model names (first = highest priority, used as fallback cascade) */
  models?: string[];
}

export interface AgentExecutionResult {
  success: boolean;
  output: unknown;
  reasoning: string;
  tokensUsed: number;
  duration: number;
  toolCalls: Array<{ name: string; result: unknown }>;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Optional output schema (JSON Schema compatible) describing the shape of
   * the value returned by the tool handler. When present, the runtime
   * validates the tool's return value against this schema and surfaces
   * mismatches to the LLM as a tool error so it can retry / self-correct.
   *
   * Inspired by LangChain `Tool.args_schema` (input) and OpenAI function
   * calling's strict-mode result schema.
   */
  outputSchema?: import("./tool-types").ToolInputSchema;
}

export const DEFAULT_PERSONA: PersonaConfig = {
  name: "EvoClaw小助手",
  title: "您的专属EvoClaw智能助理",
  masterTerm: "主人",
  tone: "warm",
  introduction: "",
};

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: "custom",
  model: "evoclaw-default",
  maxTokens: 4096,
  temperature: 0.3,
  timeout: 60000,
  chatTimeoutMs: 0, // 禁用整体超时，靠 max_iterations + 用户中断
};

// ── Task Status Tracker: real-time progress feedback for long-running tasks ──
export interface TaskStatus {
  phase: "thinking" | "tool_calling" | "generating" | "done" | "error" | "splitting" | "subtask_executing" | "resuming" | "waiting_approval" | "planning" | "reflecting";
  detail: string;
  progress: number; // 0-100
  updatedAt: number;
  subtaskIndex?: number;
  subtaskTotal?: number;
  subtaskLabel?: string;
}

export interface AgentProgressEvent {
  type: "status" | "tool_call" | "tool_result" | "llm_call" | "final" | "error" | "subtask_start" | "subtask_done" | "subtask_error" | "checkpoint_saved" | "task_resumed" | "approval_pending" | "token" | "budget_warning" | "rounds_warning" | "budget_exhausted" | "auto_continue" | "done"
    /** 模型推理原文流（2026-10-08）：reasoning_content / <think> 的增量下发 */
    | "reasoning";
  phase?: TaskStatus["phase"];
  detail: string;
  progress?: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolError?: boolean;
  providerName?: string;
  round?: number;
  /** Accumulated reply content (sent for backward-compat with status events). */
  reply?: string;
  /**
   * Token-level delta: the new text fragment produced since the last event.
   * Sent with `type: "token"` events to enable incremental rendering on the
   * client without diffing the accumulated `reply`. Inspired by OpenAI's
   * ResponseTextDeltaEvent and LangChain's astream_events token deltas.
   */
  delta?: string;
  tokensUsed?: number;
  duration?: number;
  subtaskIndex?: number;
  subtaskTotal?: number;
  /**
   * 思考轨迹快照（截至本次事件的完整轨迹）。
   *
   * 用户诉求（2026-10-08）：思考过程要**实时可见**、完成后**完整保留**。
   * 前端据此在执行过程中逐步渲染，并在消息落盘时一并保存。
   */
  thinkingSteps?: import("./thinking-trace").ThinkingStep[];
  /**
   * 新一轮 LLM 输出的开始标记（2026-10-08）。
   *
   * 用户反馈：「输出框多次变化，下一个变化总是会冲掉上一个页面的内容」。
   * 根因：前端靠"新回复长度 < 旧内容一半"这种**猜测**来判断是否换轮，
   * 换轮时把旧内容塞进同一个气泡的折叠区 → 看起来就是被冲掉。
   *
   * 现在由后端在每轮首个 token 事件上显式声明 `roundIndex`，
   * 前端据此**新建气泡**，不再猜测。
   * 仅在「本轮确实产出了正文」时携带；纯工具调用轮不带（不产生空气泡）。
   */
  roundIndex?: number;
  /**
   * 模型推理原文增量（2026-10-08 增补）。
   *
   * 用户反馈：用小米模型时「展开执行过程只看到大量『正在生成回复...』，
   * 看不到大模型的思考和分析过程」。根因是推理内容（reasoning_content /
   * `<think>`）只被写进轨迹对象，**从未通过 progress 事件下发** ——
   * 落盘了不等于用户看得到。
   *
   * 现在每来一段推理就发一个 `type: "reasoning"` 事件：
   * - `reasoningDelta`：本次增量（几字符，前端逐字追加，出流式打字效果）
   * - `reasoningText`：本轮累积全文（前端可直接整体覆盖，便于纠偏）
   * - `roundIndex`：属于第几轮 LLM 调用
   */
  reasoningDelta?: string;
  /** 本轮推理累积全文 */
  reasoningText?: string;
}

export type AgentProgressCallback = (event: AgentProgressEvent) => void;

export interface AutoSplitConfig {
  complexity: "simple" | "medium" | "complex" | "very_complex";
  shouldAutoSplit: boolean;
  maxSubtasks: number;
}
