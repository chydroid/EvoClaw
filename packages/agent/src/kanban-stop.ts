/**
 * kanban-stop — Kanban worker 终止门（对标 hermes-agent agent/kanban_stop.py）
 *
 * Kanban worker 必须以终端 board 工具结束（kanban_complete / kanban_block /
 * kanban_request_review / kanban_request_changes），而非仅文字叙述。
 * 若 worker 在未调用终端工具的情况下停止，门会注入合成 nudge 让循环继续。
 *
 * 关键设计（对标 hermes）：
 *   - 仅在 kanban worker 上下文中启用（有 kanban task 所有权）
 *   - session_called_kanban_terminal() 检查对话历史中是否已调用过终端工具
 *   - 最多 2 次 nudge（DEFAULT_MAX_ATTEMPTS）
 *   - 纯策略模块，不直接调用 kanban 工具——只决定「是否需要继续」
 */

/** 终端 kanban 工具名——这些工具结束 worker 对卡片的所有权 */
export const TERMINAL_KANBAN_TOOLS = new Set([
  "kanban_complete",
  "kanban_block",
  "kanban_schedule",
  "kanban_request_review",
  "kanban_request_changes",
]);

/** 最大 nudge 次数 */
const DEFAULT_MAX_ATTEMPTS = 2;

/** Kanban 停止门配置 */
export interface KanbanStopConfig {
  /** 是否启用（默认仅 kanban worker 上下文启用） */
  enabled?: boolean;
  /** 最大 nudge 次数 */
  maxAttempts?: number;
  /** 当前 kanban task ID */
  taskId?: string;
}

/**
 * 判断会话是否已调用过终端 kanban 工具。
 * 检查对话历史中 assistant 消息的 tool_calls 和 tool 消息的 name。
 */
export function sessionCalledKanbanTerminal(
  messages: Array<{ role: string; tool_calls?: unknown; name?: string }>,
): boolean {
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as Array<{ function?: { name?: string }; name?: string }>) {
        const fnName = tc.function?.name ?? tc.name ?? "";
        if (TERMINAL_KANBAN_TOOLS.has(fnName)) return true;
      }
    }
    if (msg.role === "tool" && msg.name && TERMINAL_KANBAN_TOOLS.has(msg.name)) {
      return true;
    }
  }
  return false;
}

/**
 * 构建 kanban 停止门 nudge 消息。
 *
 * @param messages 对话历史
 * @param attempts 已尝试的 nudge 次数
 * @param config 配置
 * @returns nudge 消息，null 表示不需要 nudge
 */
export function buildKanbanStopNudge(
  messages: Array<{ role: string; tool_calls?: unknown; name?: string }>,
  attempts: number,
  config: KanbanStopConfig = {},
): string | null {
  if (config.enabled === false) return null;
  const max = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (attempts >= max) return null;
  if (sessionCalledKanbanTerminal(messages)) return null;

  const tid = config.taskId || "this task";
  return (
    "[System: You are a kanban worker. A plain-text reply is NOT a " +
    "terminal state for the board.\n\n" +
    "Task `" + tid + "` has not been handed off: this session made no terminal board " +
    "call (`kanban_complete` / `kanban_request_review` / `kanban_block`). Ending now " +
    "causes a protocol violation (clean exit with the card still `running`).\n\n" +
    "Do this immediately in your next response — do not narrate intent:\n" +
    "1. Finish any remaining deliverable (write the required file(s) now).\n" +
    "2. Call `kanban_complete(summary=..., artifacts=[...])` if the work is done " +
    "and needs no review, `kanban_request_review(summary=...)` if it is a code " +
    "change that needs same-card review, OR `kanban_block(reason=...)` if you are " +
    "blocked. Reviewers approve with `kanban_complete` or send the card back with " +
    "`kanban_request_changes(reason=...)`.\n\n" +
    "Never end a turn with only a promise of future action. Repeated " +
    "protocol violations will block this task and require manual intervention.]"
  );
}
