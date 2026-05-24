import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ProgressDraftsManager } from "../src/progress-drafts";
import type { ProgressDraft } from "../src/progress-drafts";

describe("ProgressDraftsManager", () => {
  let manager: ProgressDraftsManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new ProgressDraftsManager({
      maxHistory: 10,
      historyTTLMs: 5000,
      autoCompleteStuckMs: 1000,
      gcIntervalMs: 500,
    });
  });

  afterEach(() => {
    manager.stopGC();
    vi.useRealTimers();
  });

  // ── Draft Creation ──────────────────────────────────────

  describe("draft creation", () => {
    it("should create a draft with pending status", () => {
      const draft = manager.createDraft("Test task");
      expect(draft.status).toBe("pending");
      expect(draft.progress).toBe(0);
      expect(draft.label).toBe("Test task");
      expect(draft.id).toMatch(/^draft_/);
    });

    it("should create a draft with options", () => {
      const draft = manager.createDraft("Task", {
        totalSteps: 5,
        description: "Doing something",
        metadata: { key: "value" },
      });
      expect(draft.totalSteps).toBe(5);
      expect(draft.description).toBe("Doing something");
      expect(draft.metadata).toEqual({ key: "value" });
    });

    it("should emit draft:created event", () => {
      const spy = vi.fn();
      manager.on("draft:created", spy);
      const draft = manager.createDraft("Test");
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "created",
          draft: expect.objectContaining({ label: "Test" }),
        })
      );
    });
  });

  // ── Draft Updates ───────────────────────────────────────

  describe("draft updates", () => {
    it("should update progress", () => {
      const draft = manager.createDraft("Task");
      manager.updateDraft(draft.id, { progress: 50 });
      const updated = manager.getDraft(draft.id);
      expect(updated?.progress).toBe(50);
    });

    it("should clamp progress between 0 and 100", () => {
      const draft = manager.createDraft("Task");
      manager.updateDraft(draft.id, { progress: 150 });
      expect(manager.getDraft(draft.id)?.progress).toBe(100);

      manager.updateDraft(draft.id, { progress: -20 });
      expect(manager.getDraft(draft.id)?.progress).toBe(0);
    });

    it("should update status", () => {
      const draft = manager.createDraft("Task");
      manager.updateDraft(draft.id, { status: "running" });
      expect(manager.getDraft(draft.id)?.status).toBe("running");
    });

    it("should update currentStep", () => {
      const draft = manager.createDraft("Task", { totalSteps: 5 });
      manager.updateDraft(draft.id, { currentStep: 3 });
      expect(manager.getDraft(draft.id)?.currentStep).toBe(3);
    });

    it("should emit draft:updated event", () => {
      const spy = vi.fn();
      manager.on("draft:updated", spy);
      const draft = manager.createDraft("Task");
      manager.updateDraft(draft.id, { progress: 50 });
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "updated",
          previous: expect.objectContaining({ progress: 0 }),
        })
      );
    });

    it("should return null for non-existent draft", () => {
      const result = manager.updateDraft("nonexistent", { progress: 50 });
      expect(result).toBeNull();
    });
  });

  // ── Draft Lifecycle ─────────────────────────────────────

  describe("draft lifecycle", () => {
    it("should complete a draft", () => {
      const draft = manager.createDraft("Task");
      manager.completeDraft(draft.id, "Done!");

      const completed = manager.getDraft(draft.id);
      expect(completed).toBeUndefined(); // moved to history

      const history = manager.getByStatus("completed");
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe("completed");
      expect(history[0].progress).toBe(100);
      expect(history[0].result).toBe("Done!");
    });

    it("should fail a draft", () => {
      const draft = manager.createDraft("Task");
      manager.failDraft(draft.id, "Something broke");

      const failed = manager.getByStatus("failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].error).toBe("Something broke");
    });

    it("should cancel a draft", () => {
      const draft = manager.createDraft("Task");
      manager.cancelDraft(draft.id, "No longer needed");

      const cancelled = manager.getByStatus("cancelled");
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].result).toBe("No longer needed");
    });

    it("should emit completion events", () => {
      const spy = vi.fn();
      manager.on("draft:completed", spy);
      const draft = manager.createDraft("Task");
      manager.completeDraft(draft.id);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "completed" })
      );
    });

    it("should set completedAt on terminal states", () => {
      const draft = manager.createDraft("Task");
      manager.completeDraft(draft.id);
      const history = manager.getByStatus("completed");
      expect(history[0].completedAt).toBeDefined();
    });
  });

  // ── Queries ─────────────────────────────────────────────

  describe("queries", () => {
    it("should get active drafts sorted by updatedAt", () => {
      const d1 = manager.createDraft("Task 1");
      const d2 = manager.createDraft("Task 2");
      vi.advanceTimersByTime(100);
      manager.updateDraft(d1.id, { progress: 50 });

      const active = manager.getActiveDrafts();
      expect(active[0].label).toBe("Task 1"); // most recently updated
    });

    it("should get all drafts including history", () => {
      const d1 = manager.createDraft("Task 1");
      manager.completeDraft(d1.id);
      manager.createDraft("Task 2");

      const all = manager.getAllDrafts();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it("should get drafts by status", () => {
      const d1 = manager.createDraft("Task 1");
      manager.updateDraft(d1.id, { status: "running" });
      manager.createDraft("Task 2"); // pending

      expect(manager.getByStatus("running")).toHaveLength(1);
      expect(manager.getByStatus("pending")).toHaveLength(1);
    });

    it("should generate active summary with progress bars", () => {
      const d1 = manager.createDraft("Download", { description: "Fetching..." });
      manager.updateDraft(d1.id, { progress: 50, status: "running" });

      const summary = manager.getActiveSummary();
      expect(summary).toContain("Download");
      expect(summary).toContain("50%");
      expect(summary).toContain("Fetching...");
    });
  });

  // ── Parent-Child Hierarchy ──────────────────────────────

  describe("parent-child hierarchy", () => {
    it("should associate children with parent", () => {
      const parent = manager.createDraft("Parent task");
      const child = manager.createDraft("Child task", { parentId: parent.id });

      const children = manager.getChildren(parent.id);
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(child.id);
    });

    it("should return empty for parent with no children", () => {
      const children = manager.getChildren("nonexistent");
      expect(children).toEqual([]);
    });
  });

  // ── Batch Operations ────────────────────────────────────

  describe("batch operations", () => {
    it("should create sub-tasks", () => {
      const parent = manager.createDraft("Main");
      const subs = manager.createSubTasks(parent.id, [
        { label: "Sub 1" },
        { label: "Sub 2" },
        { label: "Sub 3" },
      ]);

      expect(subs).toHaveLength(3);
      expect(manager.getChildren(parent.id)).toHaveLength(3);
    });

    it("should run step with progress tracking", async () => {
      const draft = manager.createDraft("Multi-step", { totalSteps: 3 });

      const result = await manager.runStep(draft.id, 1, "Step 1", async () => {
        return "step1-done";
      });

      expect(result).toBe("step1-done");
      const updated = manager.getDraft(draft.id);
      expect(updated?.status).toBe("running");
      expect(updated?.currentStep).toBe(1);
    });

    it("should fail draft on runStep error", async () => {
      const draft = manager.createDraft("Failing task");

      await expect(
        manager.runStep(draft.id, 1, "Bad step", async () => {
          throw new Error("Step failed");
        })
      ).rejects.toThrow("Step failed");

      const failed = manager.getByStatus("failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].error).toBe("Step failed");
    });
  });

  // ── Garbage Collection ──────────────────────────────────

  describe("garbage collection", () => {
    it("should clean expired history entries", () => {
      const draft = manager.createDraft("Old task");
      manager.completeDraft(draft.id);

      expect(manager.getByStatus("completed")).toHaveLength(1);

      manager.startGC();
      vi.advanceTimersByTime(6000); // Beyond historyTTLMs

      expect(manager.getByStatus("completed")).toHaveLength(0);
    });

    it("should auto-complete stuck drafts", () => {
      const draft = manager.createDraft("Stuck task");
      manager.updateDraft(draft.id, { status: "running", progress: 100 });

      manager.startGC();
      vi.advanceTimersByTime(1500); // Beyond autoCompleteStuckMs

      const completed = manager.getByStatus("completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].result).toContain("Auto-completed");
    });

    it("should only run GC once if startGC called twice", () => {
      manager.startGC();
      manager.startGC(); // should be no-op
      manager.stopGC();
    });
  });

  // ── Count Properties ────────────────────────────────────

  describe("count properties", () => {
    it("should track active and history counts", () => {
      expect(manager.activeCount).toBe(0);
      expect(manager.historyCount).toBe(0);

      const d1 = manager.createDraft("Task 1");
      const d2 = manager.createDraft("Task 2");
      expect(manager.activeCount).toBe(2);

      manager.completeDraft(d1.id);
      expect(manager.activeCount).toBe(1);
      expect(manager.historyCount).toBe(1);
    });
  });

  // ── Event Subscription ──────────────────────────────────

  describe("event subscription", () => {
    it("should subscribe to all draft events", () => {
      const spy = vi.fn();
      const unsubscribe = manager.onEvent(spy);

      const draft = manager.createDraft("Task");
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "created" })
      );

      manager.updateDraft(draft.id, { progress: 50 });
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "updated" })
      );

      manager.completeDraft(draft.id);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "completed" })
      );
    });

    it("should unsubscribe from events", () => {
      const spy = vi.fn();
      const unsubscribe = manager.onEvent(spy);
      unsubscribe();

      manager.createDraft("Task");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── Clear ───────────────────────────────────────────────

  describe("clear", () => {
    it("should clear all drafts and history", () => {
      const d1 = manager.createDraft("Task 1");
      manager.completeDraft(d1.id);
      manager.createDraft("Task 2");

      manager.clear();
      expect(manager.activeCount).toBe(0);
      expect(manager.historyCount).toBe(0);
    });
  });
});