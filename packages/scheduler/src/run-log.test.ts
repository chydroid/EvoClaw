import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CronRunLogger } from "./run-log";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("CronRunLogger", () => {
  let logger: CronRunLogger;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-runlog-"));
    logger = new CronRunLogger({ runsDir: tmpDir, maxEntriesPerJob: 10 });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe("record", () => {
    it("should record an execution entry", () => {
      const entry = logger.record({
        jobId: "job-1",
        jobName: "Daily Report",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1500,
        success: true,
      });

      expect(entry.runId).toContain("run_");
      expect(entry.jobId).toBe("job-1");
      expect(entry.success).toBe(true);
      expect(logger.totalRuns).toBe(1);
    });

    it("should persist to jsonl file", () => {
      logger.record({
        jobId: "backup-job",
        jobName: "Backup",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 500,
        success: true,
      });

      const filePath = path.join(tmpDir, "backup-job.jsonl");
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, "utf-8").trim();
      expect(content).toContain("backup-job");
      expect(content).toContain("success");
    });
  });

  describe("query", () => {
    beforeEach(() => {
      logger.record({ jobId: "a", jobName: "Job A", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z", durationMs: 60000, success: true });
      logger.record({ jobId: "b", jobName: "Job B", startedAt: "2026-01-02T00:00:00Z", completedAt: "2026-01-02T00:02:00Z", durationMs: 120000, success: false, error: "Timeout" });
      logger.record({ jobId: "a", jobName: "Job A", startedAt: "2026-01-03T00:00:00Z", completedAt: "2026-01-03T00:01:00Z", durationMs: 60000, success: true });
    });

    it("should query all runs", () => {
      const results = logger.query();
      expect(results).toHaveLength(3);
    });

    it("should filter by jobId", () => {
      const results = logger.query({ jobId: "a" });
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.jobId === "a")).toBe(true);
    });

    it("should filter by success", () => {
      const results = logger.query({ success: false });
      expect(results).toHaveLength(1);
      expect(results[0].error).toBe("Timeout");
    });

    it("should filter by time range", () => {
      const results = logger.query({ after: "2026-01-02T00:00:00Z" });
      expect(results).toHaveLength(2);
    });

    it("should paginate", () => {
      const results = logger.query({ limit: 1, offset: 0 });
      expect(results).toHaveLength(1);
    });
  });

  describe("getLastRun", () => {
    it("should return the most recent run", () => {
      logger.record({ jobId: "x", jobName: "X", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z", durationMs: 100, success: true });
      logger.record({ jobId: "x", jobName: "X", startedAt: "2026-01-02T00:00:00Z", completedAt: "2026-01-02T00:01:00Z", durationMs: 100, success: false });

      const last = logger.getLastRun("x");
      expect(last).not.toBeNull();
      expect(last!.success).toBe(false);
    });

    it("should return null for unknown job", () => {
      expect(logger.getLastRun("unknown")).toBeNull();
    });
  });

  describe("getJobRuns", () => {
    it("should return limited runs for a job", () => {
      for (let i = 0; i < 15; i++) {
        logger.record({ jobId: "busy", jobName: "Busy", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 100, success: true });
      }

      const runs = logger.getJobRuns("busy", 5);
      expect(runs.length).toBeLessThanOrEqual(5);
    });
  });

  describe("stats", () => {
    it("should compute stats", () => {
      logger.record({ jobId: "a", jobName: "A", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 100, success: true });
      logger.record({ jobId: "a", jobName: "A", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 100, success: false, error: "err" });
      logger.record({ jobId: "b", jobName: "B", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 100, success: true });

      const stats = logger.getStats();
      expect(stats.totalRuns).toBe(3);
      expect(stats.successfulRuns).toBe(2);
      expect(stats.failedRuns).toBe(1);
      expect(stats.byJob["a"].total).toBe(2);
      expect(stats.byJob["b"].total).toBe(1);
    });
  });

  describe("prune", () => {
    it("should prune by max entries per job", () => {
      const small = new CronRunLogger({ runsDir: tmpDir, maxEntriesPerJob: 3 });
      for (let i = 0; i < 10; i++) {
        small.record({ jobId: "overflow", jobName: "O", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 1, success: true });
      }

      const pruned = small.prune();
      expect(pruned).toBeGreaterThan(0);
      expect(small.totalRuns).toBeLessThanOrEqual(3);
    });
  });

  describe("deleteJob", () => {
    it("should delete all logs for a job", () => {
      logger.record({ jobId: "temp", jobName: "Temp", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 1, success: true });

      expect(logger.deleteJob("temp")).toBe(true);
      expect(logger.totalRuns).toBe(0);
    });
  });
});