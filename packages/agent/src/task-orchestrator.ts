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

const LOG = "task-orchestrator";

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

    await this.eventBus.publish(SystemEvents.TASK_CREATED, task, LOG);

    this.processQueue().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[${LOG}] Queue processing error: ${msg}\n`);
    });

    return task;
  }

  async execute(task: Task): Promise<Task> {
    task.status = "running";
    task.updatedAt = new Date();
    this.activeTasks.set(task.id, task);

    await this.eventBus.publish(SystemEvents.TASK_STARTED, task, LOG);

    try {
      if (task.dag.length > 0) {
        const result = await this.dagExecutor.executeDAG(task);
        task.output = result.output;
        task.executionPlan = result.steps;
        // Check if any DAG nodes failed — treat as task failure
        const failedNodes = result.steps.filter((s) => s.status === "failed");
        if (failedNodes.length > 0) {
          const failedIds = failedNodes.map((s) => s.nodeId).join(", ");
          throw new Error(`DAG execution had ${failedNodes.length} failed node(s): ${failedIds}`);
        }
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

      await this.eventBus.publish(SystemEvents.TASK_COMPLETED, task, LOG);
    } catch (err) {
      task.status = "failed";
      task.updatedAt = new Date();
      const message = err instanceof Error ? err.message : String(err);

      await this.eventBus.publish(SystemEvents.TASK_FAILED, { task, error: message }, LOG);

      if (task.retryCount < task.maxRetries) {
        task.retryCount++;
        task.status = "queued";
        await this.taskQueue.enqueue(task);
        await this.eventBus.publish(SystemEvents.TASK_RETRYING, task, LOG);
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
      await this.eventBus.publish(SystemEvents.TASK_CANCELLED, task, LOG);
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
      this.processQueue().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${LOG}] Queue processing error on resume: ${msg}\n`);
      });
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
      process.stderr.write(`[${LOG}] Queue processing reached max iterations, stopping to prevent infinite loop\n`);
    }
  }
}

class InMemoryTaskQueue implements TaskQueue {
  private queues = new Map<string, Task[]>();
  private head = new Map<string, number>();

  constructor() {
    for (const p of ["critical", "high", "normal", "low", "background"]) {
      this.queues.set(p, []);
      this.head.set(p, 0);
    }
  }

  async enqueue(task: Task): Promise<void> {
    const queue = this.queues.get(task.priority) || this.queues.get("normal")!;
    queue.push(task);
  }

  async dequeue(): Promise<Task | null> {
    for (const priority of ["critical", "high", "normal", "low", "background"]) {
      const queue = this.queues.get(priority)!;
      const h = this.head.get(priority)!;
      if (h < queue.length) {
        const task = queue[h];
        this.head.set(priority, h + 1);
        // Compact when queue is mostly consumed
        if (h + 1 > 64 && h + 1 > queue.length >> 1) {
          this.queues.set(priority, queue.slice(h + 1));
          this.head.set(priority, 0);
        }
        return task;
      }
    }
    return null;
  }

  async peek(): Promise<Task | null> {
    for (const priority of ["critical", "high", "normal", "low", "background"]) {
      const queue = this.queues.get(priority)!;
      const h = this.head.get(priority)!;
      if (h < queue.length) {
        return queue[h];
      }
    }
    return null;
  }

  async size(): Promise<number> {
    let total = 0;
    for (const [priority, queue] of this.queues) {
      total += queue.length - this.head.get(priority)!;
    }
    return total;
  }

  async remove(taskId: string): Promise<boolean> {
    for (const [priority, queue] of this.queues) {
      const h = this.head.get(priority)!;
      for (let i = h; i < queue.length; i++) {
        if (queue[i].id === taskId) {
          queue.splice(i, 1);
          return true;
        }
      }
    }
    return false;
  }

  async reorder(taskId: string, priority: string): Promise<void> {
    for (const [p, queue] of this.queues) {
      const h = this.head.get(p)!;
      for (let i = h; i < queue.length; i++) {
        if (queue[i].id === taskId) {
          const [task] = queue.splice(i, 1);
          task.priority = priority as Task["priority"];
          await this.enqueue(task);
          return;
        }
      }
    }
  }
}