/**
 * Kanban Tools — 持久化多 Agent 工作队列看板工具集
 *
 * 对标 hermes-agent Kanban 插件，注册以下工具：
 *   - kanban_create_board   创建看板
 *   - kanban_add_task       添加任务
 *   - kanban_claim_task     领取任务（乐观锁）
 *   - kanban_complete_task  完成任务
 *   - kanban_list_tasks     列出任务（可按 status / tenant 过滤）
 *   - kanban_get_stats      获取看板统计
 *
 * 设计原则：
 *   - Board 是硬边界，所有操作显式传入 boardId
 *   - Tenant 是软命名空间，list 可选过滤
 *   - 工具仅做薄封装，状态机/依赖/优先级/回收由 KanbanBoard 负责
 */

import type { AgentModelExecutor, KanbanBoard, KanbanTaskStatus } from "@evoclaw/agent";

const VALID_STATUSES: readonly KanbanTaskStatus[] = [
  "pending", "ready", "claimed", "in_progress", "review", "done", "blocked", "failed",
];

export interface KanbanToolDeps {
  executor: AgentModelExecutor;
  kanbanBoard: KanbanBoard;
}

export function registerKanbanTools(deps: KanbanToolDeps): void {
  const { executor, kanbanBoard } = deps;

  // ── kanban_create_board ───────────────────────────────────
  executor.registerTool(
    "kanban_create_board",
    {
      name: "kanban_create_board",
      description:
        "Create a new Kanban board with a unique board ID. A board is a hard isolation boundary for tasks. Optionally scope it to a tenant (soft namespace).",
      parameters: {
        boardId: { type: "string", description: "Unique board identifier", required: true },
        tenant: { type: "string", description: "Optional tenant namespace for this board", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const boardId = String(params.boardId || "");
        if (!boardId) return { success: false, error: "boardId is required" };
        const tenant = params.tenant ? String(params.tenant) : undefined;
        await kanbanBoard.createBoard(boardId, tenant ? { tenant } : undefined);
        return { success: true, boardId, tenant: tenant ?? null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // ── kanban_add_task ───────────────────────────────────────
  executor.registerTool(
    "kanban_add_task",
    {
      name: "kanban_add_task",
      description:
        "Add a task to a board. New tasks start as 'pending'; the dispatcher promotes them to 'ready' once dependencies are satisfied. Specify dependencies (task IDs) to enforce ordering and priority (high/medium/low).",
      parameters: {
        boardId: { type: "string", description: "Board to add the task to", required: true },
        title: { type: "string", description: "Short task title", required: true },
        description: { type: "string", description: "Detailed task description", required: false, default: "" },
        priority: {
          type: "string",
          description: "Priority: high | medium | low (default: medium)",
          required: false,
          enum: ["high", "medium", "low"],
          default: "medium",
        },
        dependencies: {
          type: "array",
          description: "Task IDs this task depends on (must all be 'done' before this becomes ready)",
          required: false,
        },
        tenant: { type: "string", description: "Optional tenant namespace for this task", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const boardId = String(params.boardId || "");
        const title = String(params.title || "");
        if (!boardId) return { success: false, error: "boardId is required" };
        if (!title) return { success: false, error: "title is required" };
        const priority = params.priority === "high" || params.priority === "medium" || params.priority === "low"
          ? params.priority
          : undefined;
        const dependencies = Array.isArray(params.dependencies) ? params.dependencies.map(String) : undefined;
        const tenant = params.tenant ? String(params.tenant) : undefined;
        const task = await kanbanBoard.addTask(boardId, {
          title,
          description: params.description ? String(params.description) : "",
          priority,
          dependencies,
          tenant,
        });
        return { success: true, task };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // ── kanban_claim_task ─────────────────────────────────────
  executor.registerTool(
    "kanban_claim_task",
    {
      name: "kanban_claim_task",
      description:
        "Claim a ready task for an agent. Uses optimistic locking: only one agent can claim a given task. The task transitions ready → claimed. Call kanban_heartbeat periodically to keep the claim alive, else the dispatcher will reclaim it.",
      parameters: {
        agentId: { type: "string", description: "Agent claiming the task", required: true },
        taskId: { type: "string", description: "Task ID to claim", required: true },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const agentId = String(params.agentId || "");
        const taskId = String(params.taskId || "");
        if (!agentId) return { success: false, error: "agentId is required" };
        if (!taskId) return { success: false, error: "taskId is required" };
        const task = await kanbanBoard.claimTask(agentId, taskId);
        return { success: true, task };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // ── kanban_complete_task ──────────────────────────────────
  executor.registerTool(
    "kanban_complete_task",
    {
      name: "kanban_complete_task",
      description:
        "Mark a claimed/in-progress task as done and store its result. Completing a task auto-promotes dependent pending tasks to ready if all their dependencies are now satisfied.",
      parameters: {
        taskId: { type: "string", description: "Task ID to complete", required: true },
        result: { type: "object", description: "Arbitrary JSON result payload to persist with the task", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const taskId = String(params.taskId || "");
        if (!taskId) return { success: false, error: "taskId is required" };
        const result = params.result;
        const task = await kanbanBoard.completeTask(taskId, result);
        return { success: true, task };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // ── kanban_list_tasks ─────────────────────────────────────
  executor.registerTool(
    "kanban_list_tasks",
    {
      name: "kanban_list_tasks",
      description:
        "List tasks on a board, optionally filtered by status and/or tenant. Tasks are ordered by priority (high → medium → low) then creation time.",
      parameters: {
        boardId: { type: "string", description: "Board to list tasks from", required: true },
        status: {
          type: "string",
          description: "Filter by status: pending | ready | claimed | in_progress | review | done | blocked | failed",
          required: false,
          enum: ["pending", "ready", "claimed", "in_progress", "review", "done", "blocked", "failed"],
        },
        tenant: { type: "string", description: "Filter by tenant namespace", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const boardId = String(params.boardId || "");
        if (!boardId) return { success: false, error: "boardId is required" };
        const rawStatus = typeof params.status === "string" ? params.status : "";
        const status = (VALID_STATUSES as readonly string[]).includes(rawStatus)
          ? (rawStatus as KanbanTaskStatus)
          : undefined;
        const tenant = typeof params.tenant === "string"
          ? params.tenant
          : params.tenant === null
            ? null
            : undefined;
        const tasks = kanbanBoard.listTasks(boardId, status, tenant);
        return { success: true, tasks, count: tasks.length };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // ── kanban_get_stats ──────────────────────────────────────
  executor.registerTool(
    "kanban_get_stats",
    {
      name: "kanban_get_stats",
      description:
        "Get aggregated statistics for a board: total task count, breakdown by status and by priority.",
      parameters: {
        boardId: { type: "string", description: "Board to get stats for", required: true },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const boardId = String(params.boardId || "");
        if (!boardId) return { success: false, error: "boardId is required" };
        const stats = kanbanBoard.getStats(boardId);
        return { success: true, stats };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
