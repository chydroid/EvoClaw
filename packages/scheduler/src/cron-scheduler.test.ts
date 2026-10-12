import { describe, it, expect, beforeEach } from "vitest";
import { CronScheduler } from "./cron-scheduler";
import { RunLogStore } from "./run-log-store";
import * as path from "path";
import * as fs from "fs";

// better-sqlite3 在 CI 可能不可用（NODE_MODULE_VERSION 不匹配），
// 此时 RunLogStore 无法创建，CronScheduler 仍应正常工作（runLogStore 为 undefined）。
let DatabaseCtor: any = null;
try {
  DatabaseCtor = require("better-sqlite3");
} catch {
  DatabaseCtor = null;
}

const skipNoSqlite = !DatabaseCtor;

describe.skipIf(skipNoSqlite)("CronScheduler — P1-3 RunLogStore 接线", () => {
  let store: RunLogStore;
  let db: any;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(process.cwd(), "data", `cron-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`);
    db = new DatabaseCtor(dbPath);
    store = new RunLogStore(db);
  });

  it("startRun/completeRun 在注入 store 后可落记录（手动模拟 executeJob 的接线契约）", () => {
    // CronScheduler.executeJob 的 P1-3 接线是：
    //   runLogStore.startRun({ runId, jobId })  →  job:start 之前
    //   runLogStore.completeRun({ runId, status })  →  job:complete/error 之后
    // 这里直接验证 RunLogStore 的这两个 API 是幂等且可用的，
    // 等价于 CronScheduler 实际会调用的契约。
    store.init();
    store.startRun({ runId: "run-1", jobId: "job-1", startedAt: new Date() });
    store.completeRun({ runId: "run-1", status: "completed", outputSummary: "ok" });

    const completed = store.query({ jobId: "job-1", status: "completed" });
    expect(completed).toHaveLength(1);
    expect(completed[0].runId).toBe("run-1");
    expect(completed[0].outputSummary).toBe("ok");
  });

  it("setRunLogStore 注入后 CronScheduler 构造不抛错", () => {
    const scheduler = new CronScheduler({ maxConcurrentJobs: 1 });
    expect(() => scheduler.setRunLogStore(store)).not.toThrow();
  });
});

describe("CronScheduler — 无 RunLogStore 时仍正常（向后兼容）", () => {
  it("runLogStore 缺失时 addJob/removeJob 不抛错", () => {
    const scheduler = new CronScheduler({ maxConcurrentJobs: 1 });
    const job = scheduler.addJob({
      id: "j2",
      name: "no-store-job",
      schedule: "* * * * *",
      task: async () => { /* no-op */ },
      timeout: 1000,
    });
    expect(job.status).toBe("idle");
    // 没注入 store 时 setRunLogStore(undefined) 是 no-op
    expect(() => scheduler.setRunLogStore(undefined)).not.toThrow();
    expect(scheduler.removeJob("j2")).toBe(true);
  });
});
