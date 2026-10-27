/**
 * Kanban Tools — 持久化多 Agent 工作队列看板工具集（复合工具）
 *
 * 对标 hermes-agent Kanban 插件，原六个细粒度工具合并为单一复合工具 `kanban`，
 * 通过 `action` 判别字段分发（保持 schema 紧凑、降低每轮 token 成本）：
 *   - kanban (action=create_board)   创建看板
 *   - kanban (action=add_task)       添加任务
 *   - kanban (action=claim_task)     领取任务（乐观锁）
 *   - kanban (action=complete_task)  完成任务
 *   - kanban (action=list_tasks)     列出任务（可按 status / tenant 过滤）
 *   - kanban (action=get_stats)      获取看板统计
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

  // ── action=create_board（原 kanban_create_board）──────────────
  const handleCreateBoard = async (params: Record<string, unknown>) => {
    try {
      const boardId = String(params.boardId || "");
      if (!boardId) return { success: false, error: "boardId is required" };
      const tenant = params.tenant ? String(params.tenant) : undefined;
      await kanbanBoard.createBoard(boardId, tenant ? { tenant } : undefined);
      return { success: true, boardId, tenant: tenant ?? null };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  // ── action=add_task（原 kanban_add_task）─────────────────────
  const handleAddTask = async (params: Record<string, unknown>) => {
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
  };

  // ── action=claim_task（原 kanban_claim_task）─────────────────
  const handleClaimTask = async (params: Record<string, unknown>) => {
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
  };

  // ── action=complete_task（原 kanban_complete_task）───────────
  const handleCompleteTask = async (params: Record<string, unknown>) => {
    try {
      const taskId = String(params.taskId || "");
      if (!taskId) return { success: false, error: "taskId is required" };
      const result = params.result;
      const task = await kanbanBoard.completeTask(taskId, result);
      return { success: true, task };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  // ── action=list_tasks（原 kanban_list_tasks）─────────────────
  const handleListTasks = async (params: Record<string, unknown>) => {
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
  };

  // ── action=get_stats（原 kanban_get_stats）───────────────────
  const handleGetStats = async (params: Record<string, unknown>) => {
    try {
      const boardId = String(params.boardId || "");
      if (!boardId) return { success: false, error: "boardId is required" };
      const stats = kanbanBoard.getStats(boardId);
      return { success: true, stats };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  executor.registerTool(
    "kanban",
    {
      name: "kanban",
      description:
        "Kanban board operations for a persistent multi-agent work queue. " +
        "action=create_board: create a board (hard isolation boundary, optional tenant); " +
        "action=add_task: add a task with dependencies and priority; " +
        "action=claim_task: claim a ready task for an agent (optimistic locking); " +
        "action=complete_task: mark a claimed/in-progress task done and store its result; " +
        "action=list_tasks: list tasks filtered by status/tenant, ordered by priority; " +
        "action=get_stats: aggregated board statistics.",
      parameters: {
        action: {
          type: "string",
          description: "kanban 操作类型",
          required: true,
          enum: ["create_board", "add_task", "claim_task", "complete_task", "list_tasks", "get_stats"],
        },
        boardId: { type: "string", description: "Board identifier（create_board/add_task/list_tasks/get_stats 使用）", required: false },
        tenant: { type: "string", description: "Optional tenant namespace（create_board/add_task/list_tasks 使用）", required: false },
        title: { type: "string", description: "Short task title（add_task 使用）", required: false },
        description: { type: "string", description: "Detailed task description（add_task 使用，default: \"\"）", required: false, default: "" },
        priority: {
          type: "string",
          description: "Priority: high | medium | low（add_task 使用，default: medium）",
          required: false,
          enum: ["high", "medium", "low"],
          default: "medium",
        },
        dependencies: {
          type: "array",
          description: "Task IDs this task depends on（add_task 使用）",
          required: false,
        },
        agentId: { type: "string", description: "Agent claiming the task（claim_task 使用）", required: false },
        taskId: { type: "string", description: "Task ID（claim_task / complete_task 使用）", required: false },
        result: { type: "object", description: "Arbitrary JSON result payload to persist with the task（complete_task 使用）", required: false },
        status: {
          type: "string",
          description: "Filter by status: pending | ready | claimed | in_progress | review | done | blocked | failed（list_tasks 使用）",
          required: false,
          enum: ["pending", "ready", "claimed", "in_progress", "review", "done", "blocked", "failed"],
        },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "create_board");
      if (action === "create_board") return await handleCreateBoard(params);
      if (action === "add_task") return await handleAddTask(params);
      if (action === "claim_task") return await handleClaimTask(params);
      if (action === "complete_task") return await handleCompleteTask(params);
      if (action === "list_tasks") return await handleListTasks(params);
      if (action === "get_stats") return await handleGetStats(params);
      return { success: false, error: `未知 kanban action: ${action}（仅支持 create_board / add_task / claim_task / complete_task / list_tasks / get_stats）` };
    },
  );
}
