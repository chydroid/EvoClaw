import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  RunLogStore,
  asSqliteDatabase,
  type SqliteDatabaseLike,
} from "./run-log-store";

// better-sqlite3 是项目根级依赖（仅在 root package.json 中声明）。
// scheduler 包未声明其类型，因此通过 require 加载并强转为本地接口。
// scheduler package.json 没有 "type": "module"，编译为 CommonJS，require 可用。
// 部分环境下 native binding 可能未编译，此时优雅跳过依赖它的测试。
function loadDatabase(): { new (path: string): SqliteDatabaseLike } | null {
  try {
    const Ctor = require("better-sqlite3") as { new (path: string): SqliteDatabaseLike };
    // 实际尝试创建内存数据库，验证 native binding 可用
    const probe = new Ctor(":memory:");
    try { probe.close?.(); } catch { /* ignore */ }
    return Ctor;
  } catch {
    return null;
  }
}

const DatabaseCtor = loadDatabase();

// 当 better-sqlite3 native binding 不可用时，跳过依赖它的测试。
// asSqliteDatabase 工具函数的"非对象/缺方法"分支不依赖 native binding，单独运行。
describe.skipIf(!DatabaseCtor)("RunLogStore (sqlite)", () => {
  let db: SqliteDatabaseLike;
  let store: RunLogStore;

  beforeEach(() => {
    db = new DatabaseCtor!(":memory:");
    store = new RunLogStore(db);
    store.init();
  });

  afterEach(() => {
    try { db.close?.(); } catch { /* ignore */ }
  });

  describe("init", () => {
    it("应创建 cron_run_logs 表和索引（幂等）", () => {
      // 第二次调用应不报错
      expect(() => store.init()).not.toThrow();

      // 验证表存在：通过 query 空查询不抛错
      const results = store.query();
      expect(results).toEqual([]);
    });
  });

  describe("startRun", () => {
    it("应插入 running 状态的运行记录", () => {
      store.startRun({ runId: "r1", jobId: "j1" });

      const run = store.getRun("r1");
      expect(run).toBeDefined();
      expect(run!.jobId).toBe("j1");
      expect(run!.status).toBe("running");
      expect(run!.startedAt).toBeInstanceOf(Date);
    });

    it("重复插入相同 runId 应被忽略（幂等）", () => {
      store.startRun({ runId: "r1", jobId: "j1" });
      store.startRun({ runId: "r1", jobId: "j1" }); // 不应报错也不应重复

      const results = store.query({ jobId: "j1" });
      expect(results).toHaveLength(1);
    });
  });

  describe("completeRun", () => {
    beforeEach(() => {
      store.startRun({ runId: "r1", jobId: "j1" });
    });

    it("应将运行状态更新为 completed 并设置 durationMs", () => {
      store.completeRun({
        runId: "r1",
        status: "completed",
        exitCode: 0,
        outputSummary: "all good",
      });

      const run = store.getRun("r1");
      expect(run!.status).toBe("completed");
      expect(run!.exitCode).toBe(0);
      expect(run!.outputSummary).toBe("all good");
      expect(run!.completedAt).toBeInstanceOf(Date);
      expect(run!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("应将运行状态更新为 failed 并记录 error", () => {
      store.completeRun({
        runId: "r1",
        status: "failed",
        exitCode: 1,
        error: "something broke",
      });

      const run = store.getRun("r1");
      expect(run!.status).toBe("failed");
      expect(run!.error).toBe("something broke");
      expect(run!.exitCode).toBe(1);
    });

    it("应能记录 triggeredSubtasks 列表", () => {
      store.completeRun({
        runId: "r1",
        status: "completed",
        triggeredSubtasks: ["sub-1", "sub-2"],
      });

      const run = store.getRun("r1");
      expect(run!.triggeredSubtasks).toEqual(["sub-1", "sub-2"]);
    });

    it("不存在的 runId 应静默忽略", () => {
      expect(() =>
        store.completeRun({ runId: "nonexistent", status: "completed" }),
      ).not.toThrow();
    });

    it("error 字段应被截断到 1KB", () => {
      const longError = "x".repeat(2000);
      store.completeRun({
        runId: "r1",
        status: "failed",
        error: longError,
      });

      const run = store.getRun("r1");
      expect(run!.error!.length).toBe(1024);
    });
  });

  describe("query", () => {
    beforeEach(() => {
      // 插入 3 条记录
      const t1 = new Date("2026-06-28T10:00:00Z");
      const t2 = new Date("2026-06-28T11:00:00Z");
      const t3 = new Date("2026-06-28T12:00:00Z");

      store.startRun({ runId: "r1", jobId: "j1", startedAt: t1 });
      store.completeRun({ runId: "r1", completedAt: t1, status: "completed" });

      store.startRun({ runId: "r2", jobId: "j1", startedAt: t2 });
      store.completeRun({ runId: "r2", completedAt: t2, status: "failed", error: "err" });

      store.startRun({ runId: "r3", jobId: "j2", startedAt: t3 });
      store.completeRun({ runId: "r3", completedAt: t3, status: "completed" });
    });

    it("应按 startedAt 降序返回所有记录", () => {
      const results = store.query();
      expect(results).toHaveLength(3);
      expect(results[0].runId).toBe("r3");
      expect(results[2].runId).toBe("r1");
    });

    it("应按 jobId 过滤", () => {
      const results = store.query({ jobId: "j1" });
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.jobId === "j1")).toBe(true);
    });

    it("应按 status 过滤", () => {
      const results = store.query({ status: "failed" });
      expect(results).toHaveLength(1);
      expect(results[0].runId).toBe("r2");
    });

    it("应按时间范围过滤", () => {
      const after = new Date("2026-06-28T10:30:00Z");
      const before = new Date("2026-06-28T11:30:00Z");
      const results = store.query({ startedAfter: after, startedBefore: before });
      expect(results).toHaveLength(1);
      expect(results[0].runId).toBe("r2");
    });

    it("应支持 limit", () => {
      const results = store.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });
  });

  describe("getRun", () => {
    it("应返回指定 runId 的记录", () => {
      store.startRun({ runId: "r1", jobId: "j1" });
      const run = store.getRun("r1");
      expect(run).toBeDefined();
      expect(run!.runId).toBe("r1");
    });

    it("不存在的 runId 应返回 undefined", () => {
      expect(store.getRun("nonexistent")).toBeUndefined();
    });
  });

  describe("prune", () => {
    it("应清理指定时间之前的记录并返回清理数", () => {
      const oldTime = new Date("2026-06-01T00:00:00Z");
      const recentTime = new Date("2026-06-28T00:00:00Z");

      store.startRun({ runId: "old", jobId: "j1", startedAt: oldTime });
      store.startRun({ runId: "recent", jobId: "j1", startedAt: recentTime });

      const now = new Date("2026-06-28T12:00:00Z");
      const olderThanMs = 7 * 24 * 60 * 60 * 1000; // 7 天
      const pruned = store.prune(olderThanMs, now);

      expect(pruned).toBe(1);
      expect(store.getRun("old")).toBeUndefined();
      expect(store.getRun("recent")).toBeDefined();
    });

    it("无过期记录时应返回 0", () => {
      store.startRun({ runId: "r1", jobId: "j1" });
      expect(store.prune(60 * 60 * 1000)).toBe(0);
    });
  });

  describe("stats", () => {
    it("应返回正确的统计信息", () => {
      const t1 = new Date("2026-06-28T10:00:00Z");
      const t2 = new Date("2026-06-28T10:00:01Z");
      const t3 = new Date("2026-06-28T10:00:02Z");

      store.startRun({ runId: "r1", jobId: "j1", startedAt: t1 });
      store.completeRun({ runId: "r1", completedAt: t2, status: "completed" });

      store.startRun({ runId: "r2", jobId: "j1", startedAt: t2 });
      store.completeRun({ runId: "r2", completedAt: t3, status: "failed", error: "err" });

      store.startRun({ runId: "r3", jobId: "j1", startedAt: t3 });
      // r3 仍 running

      const stats = store.stats();
      expect(stats.totalRuns).toBe(3);
      expect(stats.running).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.cancelled).toBe(0);
      expect(stats.failureRate).toBeCloseTo(1 / 3, 5);
      expect(stats.avgDurationMs).toBeGreaterThanOrEqual(0);
    });

    it("无记录时应返回零值统计", () => {
      const stats = store.stats();
      expect(stats.totalRuns).toBe(0);
      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.cancelled).toBe(0);
      expect(stats.failureRate).toBe(0);
      expect(stats.avgDurationMs).toBeUndefined();
    });
  });
});

// asSqliteDatabase 工具函数测试：不依赖 native binding，单独运行
describe("asSqliteDatabase", () => {
  it("应接受合法的 Database 实例", () => {
    if (!DatabaseCtor) return; // 无 native binding 时跳过本用例
    const db = new DatabaseCtor(":memory:");
    try {
      const wrapped = asSqliteDatabase(db);
      expect(typeof wrapped.exec).toBe("function");
      expect(typeof wrapped.prepare).toBe("function");
    } finally {
      try { db.close?.(); } catch { /* ignore */ }
    }
  });

  it("应拒绝非对象输入", () => {
    expect(() => asSqliteDatabase(null)).toThrow();
    expect(() => asSqliteDatabase("string")).toThrow();
    expect(() => asSqliteDatabase(42)).toThrow();
  });

  it("应拒绝缺少 exec/prepare 的对象", () => {
    expect(() => asSqliteDatabase({})).toThrow();
    expect(() => asSqliteDatabase({ exec: () => {} })).toThrow();
  });
});
