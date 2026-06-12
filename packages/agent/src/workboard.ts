/**
 * Workboard — multi-agent task board for coordinated orchestration
 * Inspired by OpenClaw 2026.6.1: "Workboard orchestration primitives"
 *
 * Provides a shared task board where multiple agents can coordinate work,
 * claim tasks, report progress, and see each other's status.
 */

export interface BoardTask {
  id: string;
  title: string;
  description: string;
  status: "backlog" | "todo" | "in_progress" | "review" | "done" | "blocked";
  assignee?: string; // agent ID
  priority: "low" | "normal" | "high" | "critical";
  tags: string[];
  createdAt: number;
  updatedAt: number;
  dueDate?: number;
  parentTaskId?: string;
  subtaskIds: string[];
  comments: BoardComment[];
  dependencies: string[]; // task IDs this depends on
  metadata: Record<string, unknown>;
}

export interface BoardComment {
  id: string;
  author: string; // agent ID or "user"
  content: string;
  timestamp: number;
}

export interface BoardRun {
  id: string;
  name: string;
  description: string;
  tasks: string[]; // task IDs
  status: "planning" | "running" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
  participatingAgents: string[];
}

export interface BoardColumn {
  id: string;
  name: string;
  taskStatuses: BoardTask["status"][];
  wipLimit?: number;
}

export const DEFAULT_COLUMNS: BoardColumn[] = [
  { id: "backlog", name: "Backlog", taskStatuses: ["backlog"] },
  { id: "todo", name: "To Do", taskStatuses: ["todo"] },
  { id: "in_progress", name: "In Progress", taskStatuses: ["in_progress"], wipLimit: 3 },
  { id: "review", name: "Review", taskStatuses: ["review"] },
  { id: "done", name: "Done", taskStatuses: ["done"] },
];

export class Workboard {
  private tasks: Map<string, BoardTask> = new Map();
  private runs: Map<string, BoardRun> = new Map();
  private columns: BoardColumn[];

  constructor(columns?: BoardColumn[]) {
    this.columns = columns ?? DEFAULT_COLUMNS;
  }

  // ── Task Management ──

  createTask(options: Omit<BoardTask, "id" | "createdAt" | "updatedAt" | "comments" | "subtaskIds" | "metadata"> & { metadata?: Record<string, unknown> }): BoardTask {
    const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const task: BoardTask = {
      ...options,
      id,
      createdAt: now,
      updatedAt: now,
      comments: [],
      subtaskIds: [],
      metadata: options.metadata ?? {},
    };
    this.tasks.set(id, task);
    return task;
  }

  updateTask(taskId: string, updates: Partial<Pick<BoardTask, "title" | "description" | "status" | "assignee" | "priority" | "tags" | "dueDate">>): BoardTask | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    Object.assign(task, updates, { updatedAt: Date.now() });
    return task;
  }

  deleteTask(taskId: string): boolean {
    // Remove from parent's subtaskIds
    const task = this.tasks.get(taskId);
    if (task?.parentTaskId) {
      const parent = this.tasks.get(task.parentTaskId);
      if (parent) {
        parent.subtaskIds = parent.subtaskIds.filter(id => id !== taskId);
      }
    }
    // Delete subtasks recursively
    if (task) {
      for (const subId of task.subtaskIds) {
        this.tasks.delete(subId);
      }
    }
    return this.tasks.delete(taskId);
  }

  getTask(taskId: string): BoardTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Claim a task for an agent (move to in_progress) */
  claimTask(taskId: string, agentId: string): BoardTask | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (task.status !== "todo" && task.status !== "backlog") return null;
    // Check dependencies
    const unmetDeps = task.dependencies.filter(depId => {
      const dep = this.tasks.get(depId);
      return !dep || dep.status !== "done";
    });
    if (unmetDeps.length > 0) return null; // blocked by dependencies
    task.status = "in_progress";
    task.assignee = agentId;
    task.updatedAt = Date.now();
    return task;
  }

  /** Complete a task (move to review or done) */
  completeTask(taskId: string, moveToReview?: boolean): BoardTask | null {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "in_progress") return null;
    task.status = moveToReview ? "review" : "done";
    task.updatedAt = Date.now();
    return task;
  }

  /** Block a task */
  blockTask(taskId: string, reason?: string): BoardTask | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.status = "blocked";
    task.updatedAt = Date.now();
    if (reason) {
      task.comments.push({
        id: `comment-${Date.now().toString(36)}`,
        author: "system",
        content: `Task blocked: ${reason}`,
        timestamp: Date.now(),
      });
    }
    return task;
  }

  /** Add a comment to a task */
  addComment(taskId: string, author: string, content: string): BoardComment | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const comment: BoardComment = {
      id: `comment-${Date.now().toString(36)}`,
      author,
      content,
      timestamp: Date.now(),
    };
    task.comments.push(comment);
    task.updatedAt = Date.now();
    return comment;
  }

  /** Add a subtask */
  addSubtask(parentTaskId: string, options: Omit<BoardTask, "id" | "createdAt" | "updatedAt" | "comments" | "subtaskIds" | "metadata" | "parentTaskId"> & { metadata?: Record<string, unknown> }): BoardTask | null {
    const parent = this.tasks.get(parentTaskId);
    if (!parent) return null;
    const subtask = this.createTask({ ...options, parentTaskId });
    parent.subtaskIds.push(subtask.id);
    parent.updatedAt = Date.now();
    return subtask;
  }

  // ── Board View ──

  /** Get board view organized by columns */
  getBoardView(): Record<string, BoardTask[]> {
    const view: Record<string, BoardTask[]> = {};
    for (const column of this.columns) {
      view[column.id] = Array.from(this.tasks.values())
        .filter(t => column.taskStatuses.includes(t.status))
        .sort((a, b) => {
          const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
          return priorityOrder[a.priority] - priorityOrder[b.priority];
        });
    }
    return view;
  }

  /** Get tasks assigned to a specific agent */
  getAgentTasks(agentId: string): BoardTask[] {
    return Array.from(this.tasks.values()).filter(t => t.assignee === agentId);
  }

  /** Get tasks by status */
  getTasksByStatus(status: BoardTask["status"]): BoardTask[] {
    return Array.from(this.tasks.values()).filter(t => t.status === status);
  }

  /** Get available tasks (todo/backlog with met dependencies) */
  getAvailableTasks(): BoardTask[] {
    return Array.from(this.tasks.values()).filter(t => {
      if (t.status !== "todo" && t.status !== "backlog") return false;
      return t.dependencies.every(depId => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === "done";
      });
    });
  }

  // ── Run Management ──

  createRun(name: string, description: string, participatingAgents: string[]): BoardRun {
    const id = `run-${Date.now().toString(36)}`;
    const run: BoardRun = {
      id,
      name,
      description,
      tasks: [],
      status: "planning",
      createdAt: Date.now(),
      participatingAgents,
    };
    this.runs.set(id, run);
    return run;
  }

  startRun(runId: string, taskIds: string[]): BoardRun | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.tasks = taskIds;
    run.status = "running";
    return run;
  }

  completeRun(runId: string): BoardRun | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.status = "completed";
    run.completedAt = Date.now();
    return run;
  }

  getRun(runId: string): BoardRun | undefined {
    return this.runs.get(runId);
  }

  // ── Stats ──

  getStats(): {
    totalTasks: number;
    byStatus: Record<string, number>;
    byAssignee: Record<string, number>;
    totalRuns: number;
    activeRuns: number;
  } {
    const allTasks = Array.from(this.tasks.values());
    const allRuns = Array.from(this.runs.values());
    const byStatus: Record<string, number> = {};
    const byAssignee: Record<string, number> = {};

    for (const task of allTasks) {
      byStatus[task.status] = (byStatus[task.status] || 0) + 1;
      if (task.assignee) {
        byAssignee[task.assignee] = (byAssignee[task.assignee] || 0) + 1;
      }
    }

    return {
      totalTasks: allTasks.length,
      byStatus,
      byAssignee,
      totalRuns: allRuns.length,
      activeRuns: allRuns.filter(r => r.status === "running").length,
    };
  }
}
