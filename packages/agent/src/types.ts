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
  type: "status" | "tool_call" | "tool_result" | "llm_call" | "final" | "error" | "subtask_start" | "subtask_done" | "subtask_error" | "checkpoint_saved" | "task_resumed" | "approval_pending" | "token" | "budget_warning" | "rounds_warning" | "budget_exhausted" | "done";
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
}

export type AgentProgressCallback = (event: AgentProgressEvent) => void;

export interface AutoSplitConfig {
  complexity: "simple" | "medium" | "complex" | "very_complex";
  shouldAutoSplit: boolean;
  maxSubtasks: number;
}
