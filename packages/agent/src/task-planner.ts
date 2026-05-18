import { ServiceRegistry, EventBus, SystemEvents } from "@evoclaw/core";
import { v4 as uuid } from "uuid";

export interface SubTask {
  id: string;
  description: string;
  tool?: string;
  parameters?: Record<string, unknown>;
  dependencies: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  result?: unknown;
  error?: string;
  retryCount: number;
  maxRetries: number;
}

export interface TaskPlan {
  id: string;
  task: string;
  subtasks: SubTask[];
  createdAt: Date;
  status: "planned" | "executing" | "completed" | "failed";
  progress: number;
}

export class TaskPlanner {
  private plans = new Map<string, TaskPlan>();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  decompose(task: string): TaskPlan {
    const plan: TaskPlan = {
      id: uuid(),
      task,
      subtasks: [],
      createdAt: new Date(),
      status: "planned",
      progress: 0,
    };

    plan.subtasks = this.analyzeTask(task);

    this.plans.set(plan.id, plan);

    this.eventBus.publish(SystemEvents.TASK_CREATED, { planId: plan.id, subtaskCount: plan.subtasks.length }, "task-planner");

    return plan;
  }

  private analyzeTask(task: string): SubTask[] {
    const lower = task.toLowerCase();
    const subtasks: SubTask[] = [];

    if (lower.includes("file") || lower.includes("文件") || lower.includes("create") || lower.includes("创建") || lower.includes("write") || lower.includes("写入") || lower.includes("生成")) {
      subtasks.push(this.makeSubTask(
        "Validate file path and prepare content",
        "file_create",
        { path: "", content: "" },
        []
      ));
    }

    if (lower.includes("folder") || lower.includes("文件夹") || lower.includes("directory") || lower.includes("目录") || lower.includes("mkdir")) {
      subtasks.push(this.makeSubTask(
        "Ensure target directory exists",
        "file_create",
        { path: ".placeholder", content: "" },
        []
      ));
    }

    if (lower.includes("html") || lower.includes("网页") || lower.includes("web")) {
      subtasks.push(this.makeSubTask(
        "Generate HTML content structure",
        "file_create",
        { path: "", content: "" },
        subtasks.length > 0 ? [subtasks[subtasks.length - 1].id] : []
      ));
    }

    if (lower.includes("skill") || lower.includes("技能") || lower.includes("find") || lower.includes("查找") || lower.includes("install") || lower.includes("安装")) {
      subtasks.push(this.makeSubTask(
        "Search for matching skills",
        "skill_search",
        { task },
        []
      ));
      subtasks.push(this.makeSubTask(
        "Install the best matching skill",
        "skill_find_and_install",
        { task },
        subtasks.length > 0 ? [subtasks[0].id] : []
      ));
    }

    if (lower.includes("read") || lower.includes("读取") || lower.includes("查看") || lower.includes("view")) {
      subtasks.push(this.makeSubTask(
        "Read target file content",
        "file_read",
        { path: "" },
        []
      ));
    }

    if (lower.includes("list") || lower.includes("列出") || lower.includes("ls") || lower.includes("dir")) {
      subtasks.push(this.makeSubTask(
        "List directory contents",
        "file_list",
        { path: "." },
        []
      ));
    }

    if (subtasks.length === 0) {
      subtasks.push(this.makeSubTask(
        "Execute general task",
        undefined,
        {},
        []
      ));
    }

    return subtasks;
  }

  private makeSubTask(
    description: string,
    tool: string | undefined,
    parameters: Record<string, unknown>,
    dependencies: string[]
  ): SubTask {
    return {
      id: uuid().slice(0, 8),
      description,
      tool,
      parameters,
      dependencies,
      status: "pending",
      retryCount: 0,
      maxRetries: 3,
    };
  }

  getPlan(planId: string): TaskPlan | undefined {
    return this.plans.get(planId);
  }

  getPendingSubtasks(planId: string): SubTask[] {
    const plan = this.plans.get(planId);
    if (!plan) return [];
    return plan.subtasks.filter((s) => s.status === "pending");
  }

  getNextExecutableSubtask(planId: string): SubTask | undefined {
    const plan = this.plans.get(planId);
    if (!plan) return undefined;

    const completed = new Set(
      plan.subtasks
        .filter((s) => s.status === "completed")
        .map((s) => s.id)
    );

    return plan.subtasks.find(
      (s) =>
        s.status === "pending" &&
        s.dependencies.every((depId) => completed.has(depId))
    );
  }

  updateSubtaskStatus(
    planId: string,
    subtaskId: string,
    status: SubTask["status"],
    result?: unknown,
    error?: string
  ): void {
    const plan = this.plans.get(planId);
    if (!plan) return;

    const subtask = plan.subtasks.find((s) => s.id === subtaskId);
    if (!subtask) return;

    subtask.status = status;
    if (result !== undefined) subtask.result = result;
    if (error !== undefined) subtask.error = error;

    const completed = plan.subtasks.filter(
      (s) => s.status === "completed" || s.status === "skipped"
    ).length;
    const failed = plan.subtasks.filter((s) => s.status === "failed").length;

    plan.progress =
      plan.subtasks.length > 0
        ? Math.round((completed / plan.subtasks.length) * 100)
        : 0;

    if (completed + failed === plan.subtasks.length) {
      plan.status = failed > 0 ? "failed" : "completed";
    }

    this.eventBus.publish(
      "task.subtask.updated",
      { planId, subtaskId, status, progress: plan.progress },
      "task-planner"
    );
  }

  incrementRetry(planId: string, subtaskId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan) return false;

    const subtask = plan.subtasks.find((s) => s.id === subtaskId);
    if (!subtask) return false;

    if (subtask.retryCount >= subtask.maxRetries) return false;

    subtask.retryCount++;
    subtask.status = "pending";
    subtask.error = undefined;
    return true;
  }

  listPlans(): TaskPlan[] {
    return Array.from(this.plans.values());
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}