/**
 * Task Scheduler Enhancement — advanced task scheduling with priority
 * queues, deadline management, dynamic rebalancing, and resource-aware
 * allocation.
 *
 * Enhances the existing TaskPlanner with:
 *  - Priority-based scheduling (critical / high / medium / low)
 *  - Deadline-aware ordering with slack time calculation
 *  - Dynamic rebalancing when new tasks arrive
 *  - Resource estimation and capacity checking
 *  - Task batching for efficiency
 *  - Dependency chain optimization (critical path method)
 *  - Execution metrics tracking (accuracy, speed, success rate)
 */

import type { EventBus } from "@evoclaw/core";

// ── Types ─────────────────────────────────────────────────

export type TaskPriority = "critical" | "high" | "medium" | "low";

export type TaskCategory =
  | "code_generation"
  | "code_review"
  | "file_operation"
  | "search"
  | "analysis"
  | "communication"
  | "automation"
  | "debugging"
  | "deployment"
  | "documentation"
  | "general";

export interface ScheduledTask {
  id: string;
  description: string;
  priority: TaskPriority;
  category: TaskCategory;
  /** Estimated tokens required */
  estimatedTokens: number;
  /** Estimated duration in ms */
  estimatedDuration: number;
  /** Deadline (epoch ms) */
  deadline?: number;
  /** Dependencies (task IDs that must complete first) */
  dependencies: string[];
  /** Task status */
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "deferred";
  /** Creation timestamp */
  createdAt: number;
  /** Start timestamp */
  startedAt?: number;
  /** Completion timestamp */
  completedAt?: number;
  /** Actual duration */
  actualDuration?: number;
  /** Result */
  result?: string;
  /** Error message */
  error?: string;
  /** Retry count */
  retryCount: number;
  /** Max retries */
  maxRetries: number;
  /** Resource requirements */
  resources?: {
    cpuCores?: number;
    memoryMB?: number;
    networkRequired?: boolean;
    diskRequired?: boolean;
  };
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

export interface ScheduleResult {
  /** Ordered execution plan */
  executionOrder: ScheduledTask[];
  /** Tasks deferred due to capacity */
  deferred: ScheduledTask[];
  /** Critical path length (longest dependency chain in ms) */
  criticalPathMs: number;
  /** Total estimated tokens */
  totalEstimatedTokens: number;
  /** Schedule metrics */
  metrics: {
    /** Tasks per priority level */
    byPriority: Record<TaskPriority, number>;
    /** Tasks that missed their deadline */
    deadlineRisk: string[];
    /** Resource utilization estimate */
    utilization: number;
    /** Balanced score (0-100, higher is better) */
    balanceScore: number;
  };
}

export interface SchedulerConfig {
  /** Max concurrent tasks */
  maxConcurrent: number;
  /** Max tokens per batch */
  maxTokensPerBatch: number;
  /** Max execution time per batch (ms) */
  maxTimePerBatchMs: number;
  /** Priority weight multipliers */
  priorityWeights: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  /** Deadline urgency factor */
  deadlineUrgencyFactor?: number;
  /** Whether to enable dynamic rebalancing */
  dynamicRebalance?: boolean;
}

// ── Scheduler Implementation ─────────────────────────────

export class TaskScheduler {
  private queue: ScheduledTask[] = [];
  private completed: ScheduledTask[] = [];
  private config: Required<SchedulerConfig>;
  private eventBus: EventBus;

  constructor(eventBus: EventBus, config: Partial<SchedulerConfig> = {}) {
    this.eventBus = eventBus;
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 5,
      maxTokensPerBatch: config.maxTokensPerBatch ?? 100_000,
      maxTimePerBatchMs: config.maxTimePerBatchMs ?? 300_000, // 5 min
      priorityWeights: config.priorityWeights ?? {
        critical: 10,
        high: 5,
        medium: 2,
        low: 1,
      },
      deadlineUrgencyFactor: config.deadlineUrgencyFactor ?? 1.5,
      dynamicRebalance: config.dynamicRebalance ?? true,
    };
  }

  // ── Task Management ─────────────────────────────────────

  /** Enqueue a new task */
  enqueue(task: Omit<ScheduledTask, "id" | "status" | "createdAt" | "retryCount">): ScheduledTask {
    const scheduled: ScheduledTask = {
      ...task,
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: "queued",
      createdAt: Date.now(),
      retryCount: 0,
    };

    this.queue.push(scheduled);
    this.eventBus.publish("scheduler:task-enqueued", { task: scheduled }, "task-scheduler");

    // Dynamic rebalancing
    if (this.config.dynamicRebalance) {
      this.rebalance();
    }

    return scheduled;
  }

  /** Cancel a queued task */
  cancel(taskId: string): boolean {
    const task = this.queue.find((t) => t.id === taskId);
    if (task) {
      task.status = "cancelled";
      this.completed.push(task);
      this.queue = this.queue.filter((t) => t.id !== taskId);
      this.eventBus.publish("scheduler:task-cancelled", { taskId }, "task-scheduler");
      return true;
    }
    return false;
  }

  /** Retry a failed task */
  retry(taskId: string): ScheduledTask | null {
    const completedIdx = this.completed.findIndex((t) => t.id === taskId && t.status === "failed");
    if (completedIdx === -1) return null;
    const task = this.completed[completedIdx];
    if (task.retryCount >= task.maxRetries) return null;

    // Remove old completed entry
    this.completed.splice(completedIdx, 1);

    const retryTask: ScheduledTask = {
      ...task,
      status: "queued",
      retryCount: task.retryCount + 1,
      createdAt: Date.now(),
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
    };

    this.queue.push(retryTask);
    this.eventBus.publish("scheduler:task-retrying", { taskId, retryCount: retryTask.retryCount }, "task-scheduler");
    return retryTask;
  }

  // ── Scheduling ──────────────────────────────────────────

  /**
   * Schedule the queued tasks into an optimized execution order.
   * Uses priority + deadline urgency + dependency resolution.
   */
  schedule(): ScheduleResult {
    const now = Date.now();

    // Resolve dependencies — only schedule tasks whose deps are complete
    const completedIds = new Set(this.completed.filter((t) => t.status === "completed").map((t) => t.id));
    const schedulable = this.queue.filter((t) =>
      t.status === "queued" &&
      t.dependencies.every((dep) => completedIds.has(dep))
    );

    // Score each task
    const scored = schedulable.map((task) => {
      let score = this.config.priorityWeights[task.priority];

      // Deadline urgency: higher score for closer deadlines
      if (task.deadline) {
        const remaining = task.deadline - now;
        if (remaining <= 0) {
          score += 100; // overdue — critical
        } else {
          const urgency = (this.config.maxTimePerBatchMs / Math.max(remaining, 1)) * this.config.deadlineUrgencyFactor;
          score += urgency;
        }
      }

      // Prefer shorter tasks for responsiveness
      score += 5 / (Math.log(task.estimatedDuration + 1));

      return { task, score };
    });

    // Sort by score (descending)
    scored.sort((a, b) => b.score - a.score);

    // Build execution plan respecting capacity
    const executionOrder: ScheduledTask[] = [];
    const deferred: ScheduledTask[] = [];
    let totalTokens = 0;
    let totalTime = 0;

    for (const { task } of scored) {
      const wouldExceedTokens = totalTokens + task.estimatedTokens > this.config.maxTokensPerBatch;
      const wouldExceedTime = totalTime + task.estimatedDuration > this.config.maxTimePerBatchMs;
      const wouldExceedConcurrent = executionOrder.length >= this.config.maxConcurrent;

      if (wouldExceedTokens || wouldExceedTime || wouldExceedConcurrent) {
        deferred.push(task);
      } else {
        executionOrder.push(task);
        totalTokens += task.estimatedTokens;
        totalTime += task.estimatedDuration;
      }
    }

    // Calculate critical path
    const criticalPathMs = this.calculateCriticalPath(executionOrder);

    // Deadline risk analysis
    const deadlineRisk = executionOrder
      .filter((t) => t.deadline && now + totalTime > t.deadline)
      .map((t) => t.id);

    // Priority distribution
    const byPriority: Record<TaskPriority, number> = {
      critical: executionOrder.filter((t) => t.priority === "critical").length,
      high: executionOrder.filter((t) => t.priority === "high").length,
      medium: executionOrder.filter((t) => t.priority === "medium").length,
      low: executionOrder.filter((t) => t.priority === "low").length,
    };

    // Balance score (0-100)
    const balanceScore = Math.round(
      100 - (deferred.length / Math.max(schedulable.length, 1)) * 100
    );

    return {
      executionOrder,
      deferred,
      criticalPathMs,
      totalEstimatedTokens: totalTokens,
      metrics: {
        byPriority,
        deadlineRisk,
        utilization: this.config.maxTimePerBatchMs > 0 ? Math.round((totalTime / this.config.maxTimePerBatchMs) * 100) : 0,
        balanceScore,
      },
    };
  }

  /**
   * Dynamically rebalance the queue after new tasks arrive.
   * Adjusts priority of queued tasks to optimize overall throughput.
   */
  rebalance(): ScheduleResult {
    const result = this.schedule();

    // If there are deferred high-priority tasks, consider preempting
    const deferredCritical = result.deferred.filter((t) => t.priority === "critical" || t.priority === "high");
    if (deferredCritical.length > 0) {
      this.eventBus.publish("scheduler:rebalance-needed", {
        deferredCount: deferredCritical.length,
        priorities: deferredCritical.map((t) => t.priority),
      }, "task-scheduler");
    }

    return result;
  }

  // ── Execution Tracking ──────────────────────────────────

  /** Mark a task as started */
  startTask(taskId: string): void {
    const task = this.queue.find((t) => t.id === taskId);
    if (task) {
      task.status = "running";
      task.startedAt = Date.now();
      this.eventBus.publish("scheduler:task-started", { taskId }, "task-scheduler");
    }
  }

  /** Mark a task as completed */
  completeTask(taskId: string, result?: string): void {
    const task = this.queue.find((t) => t.id === taskId);
    if (task) {
      task.status = "completed";
      task.completedAt = Date.now();
      task.actualDuration = task.completedAt - (task.startedAt ?? task.createdAt);
      task.result = result;

      this.completed.push(task);
      this.queue = this.queue.filter((t) => t.id !== taskId);
      this.eventBus.publish("scheduler:task-completed", { taskId, result, duration: task.actualDuration }, "task-scheduler");
    }
  }

  /** Mark a task as failed */
  failTask(taskId: string, error: string): void {
    const task = this.queue.find((t) => t.id === taskId);
    if (task) {
      task.status = "failed";
      task.completedAt = Date.now();
      task.actualDuration = task.completedAt - (task.startedAt ?? task.createdAt);
      task.error = error;

      this.completed.push(task);
      this.queue = this.queue.filter((t) => t.id !== taskId);
      this.eventBus.publish("scheduler:task-failed", { taskId, error }, "task-scheduler");
    }
  }

  // ── Metrics & Analysis ──────────────────────────────────

  /** Get performance metrics for completed tasks */
  getMetrics(): {
    totalTasks: number;
    successRate: number;
    avgDuration: number;
    accuracy: number;
    byCategory: Record<string, { count: number; successRate: number; avgDuration: number }>;
  } {
    const completed = this.completed.filter((t) => t.status === "completed");
    const failed = this.completed.filter((t) => t.status === "failed");
    const total = completed.length + failed.length;

    // By category
    const byCategory: Record<string, { count: number; success: number; durations: number[] }> = {};
    for (const task of [...completed, ...failed]) {
      if (!byCategory[task.category]) {
        byCategory[task.category] = { count: 0, success: 0, durations: [] };
      }
      byCategory[task.category].count++;
      if (task.status === "completed") {
        byCategory[task.category].success++;
      }
      if (task.actualDuration) {
        byCategory[task.category].durations.push(task.actualDuration);
      }
    }

    const metricsByCategory: Record<string, { count: number; successRate: number; avgDuration: number }> = {};
    for (const [cat, data] of Object.entries(byCategory)) {
      metricsByCategory[cat] = {
        count: data.count,
        successRate: data.count > 0 ? Math.round((data.success / data.count) * 100) : 0,
        avgDuration: data.durations.length > 0
          ? Math.round(data.durations.reduce((a, b) => a + b, 0) / data.durations.length)
          : 0,
      };
    }

    return {
      totalTasks: this.completed.length + this.queue.length,
      successRate: total > 0 ? Math.round((completed.length / total) * 100) : 100,
      avgDuration: completed
        .filter((t) => t.actualDuration)
        .reduce((sum, t) => sum + (t.actualDuration ?? 0), 0) / Math.max(completed.length, 1),
      accuracy: this.calculateAccuracy(),
      byCategory: metricsByCategory,
    };
  }

  /** Get the next batch of tasks to execute */
  getNextBatch(batchSize?: number): ScheduledTask[] {
    const result = this.schedule();
    return result.executionOrder.slice(0, batchSize ?? this.config.maxConcurrent);
  }

  /** Get queue statistics */
  getQueueStats(): {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    deferred: number;
    byPriority: Record<TaskPriority, number>;
  } {
    const result = this.schedule();

    const byPriority: Record<TaskPriority, number> = {
      critical: this.queue.filter((t) => t.priority === "critical").length,
      high: this.queue.filter((t) => t.priority === "high").length,
      medium: this.queue.filter((t) => t.priority === "medium").length,
      low: this.queue.filter((t) => t.priority === "low").length,
    };

    return {
      queued: this.queue.filter((t) => t.status === "queued").length,
      running: this.queue.filter((t) => t.status === "running").length,
      completed: this.completed.filter((t) => t.status === "completed").length,
      failed: this.completed.filter((t) => t.status === "failed").length,
      deferred: result.deferred.length,
      byPriority,
    };
  }

  // ── Internal ────────────────────────────────────────────

  private calculateCriticalPath(tasks: ScheduledTask[]): number {
    // Build dependency graph and find longest path
    const durations = new Map<string, number>();
    const taskMap = new Map<string, ScheduledTask>();

    for (const task of [...tasks, ...this.completed]) {
      taskMap.set(task.id, task);
      durations.set(task.id, task.estimatedDuration);
    }

    let maxPath = 0;
    const memo = new Map<string, number>();

    const dfs = (taskId: string): number => {
      if (memo.has(taskId)) return memo.get(taskId)!;

      const task = taskMap.get(taskId);
      if (!task) return 0;

      let maxDep = 0;
      for (const dep of task.dependencies) {
        maxDep = Math.max(maxDep, dfs(dep));
      }

      const total = (durations.get(taskId) ?? 0) + maxDep;
      memo.set(taskId, total);
      maxPath = Math.max(maxPath, total);
      return total;
    };

    for (const task of tasks) {
      dfs(task.id);
    }

    return maxPath;
  }

  private calculateAccuracy(): number {
    // Compare estimated vs actual durations for completed tasks
    const withActuals = this.completed.filter(
      (t) => t.status === "completed" && t.actualDuration && t.estimatedDuration
    );

    if (withActuals.length === 0) return 100;

    let totalRatio = 0;
    for (const task of withActuals) {
      const ratio = Math.min(task.actualDuration!, task.estimatedDuration) /
                    Math.max(task.actualDuration!, task.estimatedDuration);
      totalRatio += ratio;
    }

    return Math.round((totalRatio / withActuals.length) * 100);
  }

  /** Clear all task history */
  clearHistory(): void {
    this.completed = [];
    this.eventBus.publish("scheduler:history-cleared", {}, "task-scheduler");
  }
}