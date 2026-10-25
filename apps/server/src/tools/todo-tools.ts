/**
 * Todo Tools — 任务跟踪工具（对标 hermes-agent tools/todo_tool.py）
 *
 * 注册 `todo_list` 工具，让 agent 能跟踪多步任务进度。
 * - 传入 todos 写入（替换或合并），不传则读取当前列表
 * - 每次写入返回完整列表 + revision + summary
 * - TodoStore 每 session 一个，在 context 压缩后重新注入活跃任务
 */

import type { AgentModelExecutor } from "@evoclaw/agent";
import { TodoStore } from "@evoclaw/agent";
import type { TodoItem } from "@evoclaw/agent";

const VALID_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

/** 按 session 存储 TodoStore 实例 */
const stores = new Map<string, TodoStore>();

function getStore(sessionId: string): TodoStore {
  let store = stores.get(sessionId);
  if (!store) {
    store = new TodoStore();
    stores.set(sessionId, store);
  }
  return store;
}

/** 清理指定 session 的 store（session 结束时调用） */
export function clearTodoStore(sessionId: string): void {
  stores.delete(sessionId);
}

/** 获取指定 session 的 TodoStore（供 context 压缩注入使用） */
export function getTodoStore(sessionId: string): TodoStore {
  return getStore(sessionId);
}

export interface TodoToolDeps {
  executor: AgentModelExecutor;
  /** 获取当前 sessionId 的回调 */
  getSessionId: () => string;
}

export function registerTodoTools(deps: TodoToolDeps): void {
  const { executor, getSessionId } = deps;

  executor.registerTool(
    "todo_list",
    {
      name: "todo_list",
      description:
        "Track a task list for multi-step work (3+ steps). Use for complex tasks " +
        "with 3+ steps or when the user provides multiple tasks. " +
        "For 'all N items' tasks, enumerate every instance as its own checklist " +
        "item so none are silently dropped. " +
        "Call with no parameters to read the current list.\n" +
        "List order is priority. Only ONE item in_progress at a time. " +
        "Break large phases into subtasks via parent. " +
        "Mark an item completed only after the work is verified done, never " +
        "based on intent. If something fails, cancel it and add a revised " +
        "item. Always returns the full current list.",
      parameters: {
        todos: {
          type: "array",
          description: "Task items to write.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string", description: "Task description" },
              status: {
                type: "string",
                enum: VALID_STATUSES,
              },
              parent: {
                type: "string",
                description: "Optional id of another item, making this a nested subtask. Omit for top-level.",
              },
            },
            required: ["id", "content", "status"],
          },
        },
        merge: {
          type: "boolean",
          description:
            "true: update existing items by id, add new ones. " +
            "false (default): replace the entire list with a fresh plan.",
          default: false,
        },
      },
    },
    async (params: Record<string, unknown>) => {
      const sessionId = getSessionId();
      const store = getStore(sessionId);

      const todos = params.todos;
      const merge = params.merge === true;

      let items: TodoItem[];
      if (todos === undefined || todos === null) {
        // 读取模式
        items = store.read();
      } else {
        // 写入模式
        if (!Array.isArray(todos)) {
          return JSON.stringify({
            success: false,
            error: `todos must be a list, got ${Array.isArray(todos) ? "array" : typeof todos}`,
          });
        }
        try {
          items = store.write(todos as unknown[], merge);
        } catch (err) {
          return JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 构建 summary
      const summary: Record<string, number> = { total: items.length };
      for (const status of VALID_STATUSES) {
        summary[status] = items.filter((i) => i.status === status).length;
      }

      return JSON.stringify({
        success: true,
        todos: items,
        revision: store.snapshot().revision,
        summary,
      });
    },
  );
}
