import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  type Task,
  type TaskStatus,
  type ITaskExecutor,
  type TaskQueue,
  type DAGNode,
  type ExecutionStep,
} from "@evoclaw/core";
import { v4 as uuid } from "uuid";
import { DAGExecutor } from "./dag-executor";
import { AgentPoolManager } from "./agent-pool";

export class TaskOrchestrator implements ITaskExecutor {
  private taskQueue: TaskQueue;
  private activeTasks = new Map<string, Task>();
  private dagExecutor: DAGExecutor;
  private agentPool: AgentPoolManager;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.taskQueue = new InMemoryTaskQueue();
    this.dagExecutor = new DAGExecutor(registry, eventBus);
    this.agentPool = new AgentPoolManager(registry, eventBus);
  }

  async createTask(input: {
    type: string;
    input: Record<string, unknown>;
    priority?: string;
    context?: {
      sessionId?: string;
      userId?: string;
      workspace?: string;
      variables?: Record<string, unknown>;
      tags?: string[];
    };
  }): Promise<Task> {
    const task: Task = {
      id: uuid(),
      type: (input.type as Task["type"]) || "chat",
      priority: (input.priority as Task["priority"]) || "normal",
      status: "pending",
      input: input.input,
      output: null,
      context: {
        sessionId: input.context?.sessionId || "default",
        userId: input.context?.userId || "anonymous",
        workspace: input.context?.workspace || "default",
        variables: input.context?.variables || {},
        tags: input.context?.tags || [],
        traceId: uuid(),
      },
      dag: [],
      executionPlan: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      retryCount: 0,
      maxRetries: 3,
    };

    await this.taskQueue.enqueue(task);
    this.activeTasks.set(task.id, task);

    await this.eventBus.publish(SystemEvents.TASK_CREATED, task, "task-orchestrator");

    this.processQueue().catch((err) => {
      console.error("[TaskOrchestrator] Queue processing error:", err);
    });

    return task;
  }

  async execute(task: Task): Promise<Task> {
    task.status = "running";
    task.updatedAt = new Date();
    this.activeTasks.set(task.id, task);

    await this.eventBus.publish(SystemEvents.TASK_STARTED, task, "task-orchestrator");

    try {
      if (task.dag.length > 0) {
        const result = await this.dagExecutor.executeDAG(task);
        task.output = result.output;
        task.executionPlan = result.steps;
      } else {
        task.output = { message: "Task processed successfully" };
        task.executionPlan = [
          {
            nodeId: "root",
            status: "completed",
            attempt: 1,
            result: { success: true, data: task.output, artifacts: [], metrics: { startTime: new Date(), endTime: new Date(), durationMs: 0, cpuUsage: 0, memoryUsageMB: 0 } },
          },
        ];
      }

      task.status = "completed";
      task.completedAt = new Date();
      task.updatedAt = new Date();

      await this.eventBus.publish(SystemEvents.TASK_COMPLETED, task, "task-orchestrator");
    } catch (err) {
      task.status = "failed";
      task.updatedAt = new Date();
      const message = err instanceof Error ? err.message : String(err);

      await this.eventBus.publish(SystemEvents.TASK_FAILED, { task, error: message }, "task-orchestrator");

      if (task.retryCount < task.maxRetries) {
        task.retryCount++;
        task.status = "queued";
        await this.taskQueue.enqueue(task);
        await this.eventBus.publish(SystemEvents.TASK_RETRYING, task, "task-orchestrator");
      }
    }

    return task;
  }

  async cancel(taskId: string): Promise<void> {
    const task = this.activeTasks.get(taskId);
    if (task && (task.status === "pending" || task.status === "queued" || task.status === "running")) {
      task.status = "cancelled";
      task.updatedAt = new Date();
      await this.taskQueue.remove(taskId);
      await this.eventBus.publish(SystemEvents.TASK_CANCELLED, task, "task-orchestrator");
    }
  }

  async pause(taskId: string): Promise<void> {
    const task = this.activeTasks.get(taskId);
    if (task && task.status === "running") {
      task.status = "paused";
      task.updatedAt = new Date();
    }
  }

  async resume(taskId: string): Promise<void> {
    const task = this.activeTasks.get(taskId);
    if (task && task.status === "paused") {
      task.status = "queued";
      task.updatedAt = new Date();
      await this.taskQueue.enqueue(task);
      this.processQueue().catch(console.error);
    }
  }

  async getStatus(taskId: string): Promise<TaskStatus> {
    return this.activeTasks.get(taskId)?.status || "failed";
  }

  async getProgress(taskId: string): Promise<number> {
    const task = this.activeTasks.get(taskId);
    if (!task || task.executionPlan.length === 0) return 0;
    const completed = task.executionPlan.filter((s) => s.status === "completed").length;
    return completed / task.executionPlan.length;
  }

  getTaskStatus(taskId: string): Task | undefined {
    return this.activeTasks.get(taskId);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  private async processQueue(): Promise<void> {
    const maxIterations = 1000;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;
      const task = await this.taskQueue.dequeue();
      if (!task) break;

      const agent = await this.agentPool.acquire();
      if (!agent) {
        await this.taskQueue.enqueue(task);
        await new Promise((resolve) => setTimeout(resolve, 100));
        break;
      }

      try {
        await this.execute(task);
      } finally {
        await this.agentPool.release(agent.id);
      }
    }

    if (iterations >= maxIterations) {
      console.warn("[TaskOrchestrator] Queue processing reached max iterations, stopping to prevent infinite loop");
    }
  }
}

class InMemoryTaskQueue implements TaskQueue {
  private queues = new Map<string, Task[]>();

  constructor() {
    this.queues.set("critical", []);
    this.queues.set("high", []);
    this.queues.set("normal", []);
    this.queues.set("low", []);
    this.queues.set("background", []);
  }

  async enqueue(task: Task): Promise<void> {
    const queue = this.queues.get(task.priority) || this.queues.get("normal")!;
    queue.push(task);
  }

  async dequeue(): Promise<Task | null> {
    for (const priority of ["critical", "high", "normal", "low", "background"]) {
      const queue = this.queues.get(priority)!;
      if (queue.length > 0) {
        return queue.shift()!;
      }
    }
    return null;
  }

  async peek(): Promise<Task | null> {
    for (const priority of ["critical", "high", "normal", "low", "background"]) {
      const queue = this.queues.get(priority)!;
      if (queue.length > 0) {
        return queue[0];
      }
    }
    return null;
  }

  async size(): Promise<number> {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  async remove(taskId: string): Promise<boolean> {
    for (const queue of this.queues.values()) {
      const index = queue.findIndex((t) => t.id === taskId);
      if (index !== -1) {
        queue.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  async reorder(taskId: string, priority: string): Promise<void> {
    for (const queue of this.queues.values()) {
      const index = queue.findIndex((t) => t.id === taskId);
      if (index !== -1) {
        const task = queue.splice(index, 1)[0];
        task.priority = priority as Task["priority"];
        await this.enqueue(task);
        return;
      }
    }
  }
}