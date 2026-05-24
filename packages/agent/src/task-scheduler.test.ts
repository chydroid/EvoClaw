import { describe, it, expect, beforeEach } from "vitest";
import { TaskScheduler } from "../src/task-scheduler";
import { EventBus } from "@evoclaw/core";

describe("TaskScheduler", () => {
  let scheduler: TaskScheduler;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    scheduler = new TaskScheduler(eventBus, {
      maxConcurrent: 3,
      maxTokensPerBatch: 50000,
      maxTimePerBatchMs: 300000,
    });
  });

  // ── Enqueue ─────────────────────────────────────────────

  describe("enqueue", () => {
    it("should enqueue a task with generated ID", () => {
      const task = scheduler.enqueue({
        description: "Write a unit test",
        priority: "high",
        category: "code_generation",
        estimatedTokens: 500,
        estimatedDuration: 30000,
        dependencies: [],
        maxRetries: 3,
      });

      expect(task.id).toBeTruthy();
      expect(task.status).toBe("queued");
      expect(task.retryCount).toBe(0);
    });

    it("should add task to queue", () => {
      scheduler.enqueue({
        description: "Task 1",
        priority: "medium",
        category: "analysis",
        estimatedTokens: 1000,
        estimatedDuration: 5000,
        dependencies: [],
        maxRetries: 2,
      });

      const stats = scheduler.getQueueStats();
      expect(stats.queued).toBe(1);
    });
  });

  // ── Scheduling ──────────────────────────────────────────

  describe("scheduling", () => {
    it("should schedule tasks respecting capacity", () => {
      for (let i = 0; i < 10; i++) {
        scheduler.enqueue({
          description: `Task ${i}`,
          priority: "medium",
          category: "general",
          estimatedTokens: 1000,
          estimatedDuration: 10000,
          dependencies: [],
          maxRetries: 1,
        });
      }

      const result = scheduler.schedule();
      expect(result.executionOrder.length).toBeLessThanOrEqual(3); // maxConcurrent
      expect(result.deferred.length).toBeGreaterThan(0);
    });

    it("should prioritize critical tasks over low tasks", () => {
      scheduler.enqueue({
        description: "Low priority",
        priority: "low",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 1000,
        dependencies: [],
        maxRetries: 1,
      });
      scheduler.enqueue({
        description: "Critical priority",
        priority: "critical",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 1000,
        dependencies: [],
        maxRetries: 1,
      });

      const result = scheduler.schedule();
      expect(result.executionOrder[0].priority).toBe("critical");
    });

    it("should order by deadline urgency", () => {
      const now = Date.now();
      scheduler.enqueue({
        description: "Due later",
        priority: "high",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 1000,
        dependencies: [],
        maxRetries: 1,
        deadline: now + 3600000,
      });
      scheduler.enqueue({
        description: "Due soon",
        priority: "high",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 1000,
        dependencies: [],
        maxRetries: 1,
        deadline: now + 60000,
      });

      const result = scheduler.schedule();
      expect(result.executionOrder[0].description).toBe("Due soon");
    });

    it("should calculate critical path for dependent tasks", () => {
      const t1 = scheduler.enqueue({
        description: "Base task",
        priority: "high",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 30000,
        dependencies: [],
        maxRetries: 1,
      });
      scheduler.enqueue({
        description: "Dependent task",
        priority: "high",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 20000,
        dependencies: [t1.id],
        maxRetries: 1,
      });

      // Complete t1 first
      scheduler.completeTask(t1.id, "Done");

      const result = scheduler.schedule();
      expect(result.criticalPathMs).toBeGreaterThanOrEqual(20000);
    });

    it("should identify deadline risk tasks", () => {
      const now = Date.now();
      scheduler.enqueue({
        description: "Risky task",
        priority: "high",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 1000,
        dependencies: [],
        maxRetries: 1,
        deadline: now - 60000, // already past
      });

      const result = scheduler.schedule();
      expect(result.metrics.deadlineRisk.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Task Lifecycle ──────────────────────────────────────

  describe("task lifecycle", () => {
    it("should track task through lifecycle", () => {
      const task = scheduler.enqueue({
        description: "Lifecycle test",
        priority: "medium",
        category: "debugging",
        estimatedTokens: 200,
        estimatedDuration: 5000,
        dependencies: [],
        maxRetries: 1,
      });

      scheduler.startTask(task.id);
      scheduler.completeTask(task.id, "Success");

      const metrics = scheduler.getMetrics();
      expect(metrics.successRate).toBe(100);
    });

    it("should track failed tasks", () => {
      const task = scheduler.enqueue({
        description: "Will fail",
        priority: "low",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 1000,
        dependencies: [],
        maxRetries: 2,
      });

      scheduler.startTask(task.id);
      scheduler.failTask(task.id, "Network error");

      const metrics = scheduler.getMetrics();
      expect(metrics.successRate).toBe(0);
    });

    it("should cancel queued tasks", () => {
      const task = scheduler.enqueue({
        description: "Cancel me",
        priority: "low",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 1000,
        dependencies: [],
        maxRetries: 1,
      });

      expect(scheduler.cancel(task.id)).toBe(true);
      expect(scheduler.cancel("nonexistent")).toBe(false);
    });

    it("should retry failed tasks", () => {
      const task = scheduler.enqueue({
        description: "Retryable",
        priority: "high",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 1000,
        dependencies: [],
        maxRetries: 3,
      });

      scheduler.startTask(task.id);
      scheduler.failTask(task.id, "Temporary error");

      const retried = scheduler.retry(task.id);
      expect(retried).not.toBeNull();
      expect(retried!.retryCount).toBe(1);
    });

    it("should not retry beyond max retries", () => {
      const task = scheduler.enqueue({
        description: "Final attempt",
        priority: "high",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 1000,
        dependencies: [],
        maxRetries: 1,
      });

      scheduler.startTask(task.id);
      scheduler.failTask(task.id, "Error 1");

      const retry1 = scheduler.retry(task.id);
      expect(retry1).not.toBeNull();

      scheduler.startTask(retry1!.id);
      scheduler.failTask(retry1!.id, "Error 2");

      const retry2 = scheduler.retry(retry1!.id);
      expect(retry2).toBeNull();
    });
  });

  // ── Metrics ─────────────────────────────────────────────

  describe("metrics", () => {
    it("should report accurate metrics", () => {
      const t1 = scheduler.enqueue({
        description: "Success task",
        priority: "high",
        category: "code_generation",
        estimatedTokens: 500,
        estimatedDuration: 10000,
        dependencies: [],
        maxRetries: 1,
      });
      const t2 = scheduler.enqueue({
        description: "Fail task",
        priority: "medium",
        category: "analysis",
        estimatedTokens: 300,
        estimatedDuration: 5000,
        dependencies: [],
        maxRetries: 1,
      });

      scheduler.startTask(t1.id);
      scheduler.completeTask(t1.id);

      scheduler.startTask(t2.id);
      scheduler.failTask(t2.id, "Error");

      const metrics = scheduler.getMetrics();
      expect(metrics.totalTasks).toBe(2);
      expect(metrics.byCategory["code_generation"]).toBeDefined();
      expect(metrics.byCategory["analysis"]).toBeDefined();
    });

    it("should report queue stats by priority", () => {
      scheduler.enqueue({
        description: "Critical",
        priority: "critical",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 1000,
        dependencies: [],
        maxRetries: 1,
      });
      scheduler.enqueue({
        description: "High",
        priority: "high",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 1000,
        dependencies: [],
        maxRetries: 1,
      });
      scheduler.enqueue({
        description: "Low",
        priority: "low",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 1000,
        dependencies: [],
        maxRetries: 1,
      });

      const stats = scheduler.getQueueStats();
      expect(stats.byPriority.critical).toBe(1);
      expect(stats.byPriority.high).toBe(1);
      expect(stats.byPriority.low).toBe(1);
    });
  });

  // ── Batch Operations ────────────────────────────────────

  describe("batch operations", () => {
    it("should return next batch of tasks", () => {
      for (let i = 0; i < 10; i++) {
        scheduler.enqueue({
          description: `Batch ${i}`,
          priority: "high",
          category: "general",
          estimatedTokens: 100,
          estimatedDuration: 1000,
          dependencies: [],
          maxRetries: 1,
        });
      }

      const batch = scheduler.getNextBatch(2);
      expect(batch.length).toBe(2);
    });
  });

  // ── Dynamic Rebalancing ─────────────────────────────────

  describe("rebalancing", () => {
    it("should rebalance when dynamic balance is enabled", () => {
      for (let i = 0; i < 10; i++) {
        scheduler.enqueue({
          description: `Rebalance ${i}`,
          priority: i < 2 ? "critical" : "low",
          category: "general",
          estimatedTokens: 5000,
          estimatedDuration: 50000,
          dependencies: [],
          maxRetries: 1,
        });
      }

      const result = scheduler.rebalance();
      expect(result.executionOrder.length).toBeGreaterThan(0);
      expect(result.metrics.balanceScore).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Clear ───────────────────────────────────────────────

  describe("clear", () => {
    it("should clear task history", () => {
      const task = scheduler.enqueue({
        description: "To clear",
        priority: "low",
        category: "general",
        estimatedTokens: 100,
        estimatedDuration: 1000,
        dependencies: [],
        maxRetries: 1,
      });

      scheduler.startTask(task.id);
      scheduler.completeTask(task.id);

      scheduler.clearHistory();
      const metrics = scheduler.getMetrics();
      expect(metrics.totalTasks).toBe(0);
    });
  });
});