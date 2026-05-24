import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { GracefulShutdownManager } from "./graceful-shutdown";

describe("GracefulShutdownManager", () => {
  let gsm: GracefulShutdownManager;

  beforeEach(() => {
    gsm = new GracefulShutdownManager({
      trapSignals: false, // Don't trap process signals in tests
      totalTimeoutMs: 5000,
      defaultTaskTimeoutMs: 1000,
      exitCode: 0,
    });
  });

  afterEach(() => {
    gsm.dispose();
  });

  describe("register", () => {
    it("should register a shutdown task", () => {
      gsm.register({
        name: "cleanup",
        handler: async () => true,
        priority: 10,
        timeoutMs: 1000,
      });

      const status = gsm.getStatus();
      expect(status.totalTasks).toBe(1);
      expect(status.pendingTasks).toContain("cleanup");
    });

    it("should register a simple hook", () => {
      gsm.registerHook("db-close", async () => {}, {
        priority: 5,
        timeoutMs: 2000,
      });

      expect(gsm.getStatus().totalTasks).toBe(1);
    });

    it("should unregister a task", () => {
      gsm.registerHook("temp", async () => {});
      expect(gsm.unregister("temp")).toBe(true);
      expect(gsm.getStatus().totalTasks).toBe(0);
    });
  });

  describe("shutdown", () => {
    it("should execute registered tasks", async () => {
      const order: string[] = [];

      gsm.registerHook("a", async () => { order.push("a"); }, { priority: 10 });
      gsm.registerHook("b", async () => { order.push("b"); }, { priority: 5 });
      gsm.registerHook("c", async () => { order.push("c"); }, { priority: 15 });

      await gsm.shutdown();

      // Lower priority = earlier shutdown
      expect(order).toEqual(["b", "a", "c"]);
      expect(gsm.getStatus().phase).toBe("complete");
      expect(gsm.getStatus().completedTasks).toBe(3);
    });

    it("should not restart if already shutting down", async () => {
      gsm.registerHook("slow", async () => {
        await new Promise((r) => setTimeout(r, 200));
      }, { timeoutMs: 5000 });

      // Start shutdown
      const p1 = gsm.shutdown();

      // Try starting again
      await gsm.shutdown();
      await p1;

      // Only executed once
      expect(gsm.getStatus().completedTasks).toBe(1);
    });

    it("should handle task timeout", async () => {
      gsm.register({
        name: "timeout-task",
        handler: async () => {
          await new Promise((r) => setTimeout(r, 5000)); // Never resolves in time
          return true;
        },
        priority: 10,
        timeoutMs: 100, // Very short timeout
      });

      await gsm.shutdown();
      expect(gsm.getStatus().failedTasks).toBe(1);
    });

    it("should handle task that throws", async () => {
      gsm.register({
        name: "error-task",
        handler: async () => {
          throw new Error("Boom");
        },
        priority: 10,
        timeoutMs: 1000,
      });

      await gsm.shutdown();
      expect(gsm.getStatus().failedTasks).toBe(1);
    });

    it("should test status after shutdown", async () => {
      gsm.registerHook("cleanup", async () => {});
      await gsm.shutdown();

      const status = gsm.getStatus();
      expect(status.phase).toBe("complete");
      expect(status.completedTasks).toBe(1);
      expect(status.failedTasks).toBe(0);
      expect(status.pendingTasks).toHaveLength(0);
      expect(status.currentTask).toBeNull();
    });
  });

  describe("isShuttingDown", () => {
    it("should return false when idle", () => {
      expect(gsm.isShuttingDown()).toBe(false);
    });

    it("should return true during shutdown", () => {
      // Fire off shutdown without awaiting
      gsm.registerHook("delayed", async () => {
        await new Promise((r) => setTimeout(r, 200));
      }, { timeoutMs: 5000 });

      const p = gsm.shutdown();
      expect(gsm.isShuttingDown()).toBe(true);
      return p;
    });
  });

  describe("events", () => {
    it("should emit shutdown:start", async () => {
      const handler = vi.fn();
      gsm.on("shutdown:start", handler);

      gsm.registerHook("x", async () => {});
      await gsm.shutdown();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should emit shutdown:complete", async () => {
      const handler = vi.fn();
      gsm.on("shutdown:complete", handler);

      gsm.registerHook("x", async () => {});
      await gsm.shutdown();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should emit shutdown:task:start and shutdown:task:done", async () => {
      const startHandler = vi.fn();
      const doneHandler = vi.fn();

      gsm.on("shutdown:task:start", startHandler);
      gsm.on("shutdown:task:done", doneHandler);

      gsm.registerHook("task-a", async () => {});
      await gsm.shutdown();

      expect(startHandler).toHaveBeenCalled();
      expect(doneHandler).toHaveBeenCalled();
    });

    it("should emit shutdown:task:failed", async () => {
      const handler = vi.fn();
      gsm.on("shutdown:task:failed", handler);

      gsm.register({
        name: "fail-task",
        handler: async () => { throw new Error("Boom"); },
        priority: 10,
        timeoutMs: 500,
      });

      await gsm.shutdown();
      expect(handler).toHaveBeenCalled();
    });
  });

  describe("configure", () => {
    it("should update config", () => {
      gsm.configure({ totalTimeoutMs: 60_000 });
    });
  });
});