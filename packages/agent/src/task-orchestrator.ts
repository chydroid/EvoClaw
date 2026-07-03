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

/**
 * TracingService 类型（最小接口，避免引入 @opentelemetry/api 类型耦合）。
 * 仅声明 TaskOrchestrator 用到的方法，与 AgentModelExecutor 的获取方式一致。
 */
interface TracingLike {
  isEnabled(): boolean;
  withSpan<T>(name: string, fn: (span: {
    setAttribute(key: string, value: string | number | boolean): void;
    addEvent(name: string, attributes?: Record<string, unknown>): void;
    recordException(err: Error): void;
    setStatus(status: { code: number; message?: string }): void;
  }) => Promise<T>, options?: { attributes?: Record<string, unknown> }): Promise<T>;
}

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
    this.agentPool = registry.resolveService<AgentPoolManager>("agentPool") ?? new AgentPoolManager(registry, eventBus);
  }

  /**
   * 获取 TracingService（与 AgentModelExecutor 一致的懒解析模式）。
   * observability 服务由 apps/server 注册，可选；缺失时返回 undefined，tracing 静默跳过。
   */
  private getTracing(): TracingLike | undefined {
    const observability = this.registry?.resolveService?.("observability") as
      | { getTracingService?: () => TracingLike }
      | undefined;
    const tracing = observability?.getTracingService?.();
    return tracing?.isEnabled() ? tracing : undefined;
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

    this.processQueueTraced().catch((err) => {
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

    const tracing = this.getTracing();
    const runWithSpan = async (): Promise<void> => {
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
    };

    if (tracing) {
      await tracing.withSpan(
        "task.execute",
        async (span) => {
          span.setAttribute("task.id", task.id);
          span.setAttribute("task.type", task.type);
          span.setAttribute("task.priority", task.priority);
          span.setAttribute("task.dag_nodes", task.dag.length);
          span.setAttribute("task.retry_count", task.retryCount);
          if (task.context.sessionId) span.setAttribute("task.session_id", task.context.sessionId);
          await runWithSpan();
          span.setAttribute("task.final_status", task.status);
          if (task.status === "failed") {
            span.setStatus({ code: 2, message: "Task ended in failed state" });
          }
        },
        { attributes: { "task.id": task.id, "task.type": task.type } }
      );
    } else {
      await runWithSpan();
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
      this.processQueueTraced().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${LOG}] Queue processing error on resume: ${msg}\n`);
      });
    }
  }

  async getStatus(taskId: string): Promise<TaskStatus | undefined> {
    return this.activeTasks.get(taskId)?.status;
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
        // 继续尝试下一个任务，避免因单个任务无法获取 agent 而使后续任务饥饿。
        // 若队列已空，下一次 dequeue 返回 null 会自然 break。
        continue;
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

  /**
   * 带 tracing 的队列处理包装（每个 task 一个子 span，便于在 trace 视图中看到队列消费节奏）。
   * 当前 processQueue 内部已通过 execute() 的 span 覆盖，此方法预留给外部显式调用场景。
   */
  private async processQueueTraced(): Promise<void> {
    const tracing = this.getTracing();
    if (tracing) {
      await tracing.withSpan("task.process_queue", async () => {
        await this.processQueue();
      });
    } else {
      await this.processQueue();
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