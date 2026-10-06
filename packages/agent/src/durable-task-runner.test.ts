/**
 * DurableTaskRunner 单元测试
 *
 * 覆盖用户核心诉求的使能点：
 *   - 任务创建即落盘（paused 态，可恢复）
 *   - 进度追加与持久化
 *   - resume driver 续跑 → complete，并投递 durable_task_completed
 *   - fail / cancel 状态转移与事件投递
 *   - resumeAll() 重启续跑（含 running→paused 归位）
 *   - 跨进程重载：新实例从磁盘恢复未完成任务
 *   - 单例 getter / resetDurableTaskRunner
 *
 * 每个用例使用独立临时目录，不依赖单例，避免相互污染。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DurableTaskRunner,
  getDurableTaskRunner,
  resetDurableTaskRunner,
} from "./durable-task-runner";

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "durable-task-test-"));
}

describe("DurableTaskRunner — 持久化与状态机", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resetDurableTaskRunner();
  });

  it("create 落盘为 paused 态，且 index.json 存在", () => {
    const runner = new DurableTaskRunner(dir);
    const task = runner.create("帮我写一份长报告", "sess-1", "web-ui");
    expect(task.status).toBe("paused");
    expect(task.userRequest).toBe("帮我写一份长报告");
    expect(task.sessionId).toBe("sess-1");
    expect(task.resumeCount).toBe(0);

    const file = path.join(dir, "index.json");
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Array<{ id: string; status: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(task.id);
    expect(parsed[0].status).toBe("paused");
  });

  it("get / list 能正确检索，且仅返回不变量", () => {
    const runner = new DurableTaskRunner(dir);
    const t1 = runner.create("任务A", "sess-1", "web-ui");
    runner.create("任务B", "sess-2", "web-ui");
    expect(runner.get(t1.id)?.id).toBe(t1.id);
    expect(runner.list()).toHaveLength(2);
    expect(runner.list("sess-1")).toHaveLength(1);
    expect(runner.get("nope")).toBeUndefined();
  });

  it("appendProgress 追加并持久化，且上限封顶 200", () => {
    const runner = new DurableTaskRunner(dir);
    const t = runner.create("长任务", "sess-1", "web-ui");
    for (let i = 0; i < 250; i++) runner.appendProgress(t.id, `step-${i}`);
    const reloaded = new DurableTaskRunner(dir).get(t.id);
    expect(reloaded?.progress.length).toBe(200);
    expect(reloaded?.progress[reloaded.progress.length - 1]).toContain("step-249");
  });

  it("resume 驱动续跑后 → complete，并投递 durable_task_completed", async () => {
    const runner = new DurableTaskRunner(dir);
    const events: Array<{ ev: string; status: string }> = [];
    runner.setDeliver((_sid, ev, payload) => events.push({ ev, status: payload.status as string }));
    runner.setResumeDriver(async (task) => `完成：${task.userRequest}`);

    const t = runner.create("长任务", "sess-1", "web-ui");
    await runner.resume(t.id);

    const after = runner.get(t.id);
    expect(after?.status).toBe("completed");
    expect(after?.finalReply).toBe("完成：长任务");
    expect(after?.completedAt).toBeTypeOf("number");
    expect(events).toEqual([{ ev: "durable_task_completed", status: "completed" }]);
  });

  it("续跑抛错 → fail 并投递 durable_task_failed", async () => {
    const runner = new DurableTaskRunner(dir);
    const events: string[] = [];
    runner.setDeliver((_sid, ev) => events.push(ev));
    runner.setResumeDriver(async () => {
      throw new Error("boom");
    });
    const t = runner.create("会失败的任务", "sess-1", "web-ui");
    await runner.resume(t.id);
    expect(runner.get(t.id)?.status).toBe("failed");
    expect(runner.get(t.id)?.error).toBe("boom");
    expect(events).toContain("durable_task_failed");
  });

  it("cancel 取消任务并投递 durable_task_cancelled（终态不可再续跑）", async () => {
    const runner = new DurableTaskRunner(dir);
    const events: string[] = [];
    runner.setDeliver((_sid, ev) => events.push(ev));
    runner.setResumeDriver(async () => "should-not-run");
    const t = runner.create("可取消任务", "sess-1", "web-ui");
    expect(runner.cancel(t.id)).toBe(true);
    expect(runner.get(t.id)?.status).toBe("cancelled");
    expect(events).toContain("durable_task_cancelled");
    // 已取消的任务不会被续跑
    await runner.resume(t.id);
    expect(runner.get(t.id)?.status).toBe("cancelled");
  });

  it("无 resume driver 时 resume 把任务 parked（不抛错）", async () => {
    const runner = new DurableTaskRunner(dir);
    const t = runner.create("无驱动任务", "sess-1", "web-ui");
    await expect(runner.resume(t.id)).resolves.toBeUndefined();
    // 状态保持 paused，等待后续注入 driver 再续跑
    expect(runner.get(t.id)?.status).toBe("paused");
  });

  it("resumeAll 把 paused/running 任务批量续跑（模拟重启恢复）", async () => {
    const runner = new DurableTaskRunner(dir);
    runner.setResumeDriver(async (task) => `done:${task.id}`);
    const a = runner.create("A", "sess-1", "web-ui");
    const b = runner.create("B", "sess-2", "web-ui");
    // 模拟其中一个在重启前处于 running 态
    runner.markRunning(a.id);

    // 模拟「进程重启」：新建实例，加载磁盘上的任务
    const restarted = new DurableTaskRunner(dir);
    restarted.setResumeDriver(async (task) => `done:${task.id}`);
    restarted.resumeAll();

    // 轮询等待续跑完成
    for (let i = 0; i < 50; i++) {
      if (restarted.get(a.id)?.status === "completed" && restarted.get(b.id)?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(restarted.get(a.id)?.status).toBe("completed");
    expect(restarted.get(b.id)?.status).toBe("completed");
    // running 在重载时被归位为 paused 再续跑
    expect(restarted.get(a.id)?.finalReply).toBe(`done:${a.id}`);
  });

  it("跨进程重载：新实例从磁盘恢复未完成任务", () => {
    const runner = new DurableTaskRunner(dir);
    const t = runner.create("持久化任务", "sess-1", "web-ui");
    runner.markRunning(t.id);

    const reloaded = new DurableTaskRunner(dir);
    const recovered = reloaded.get(t.id);
    expect(recovered).toBeDefined();
    // 重载时 running 归位为 paused（重启必然已中断）
    expect(recovered?.status).toBe("paused");
    expect(recovered?.userRequest).toBe("持久化任务");
  });

  it("单例 getter 返回同一实例，reset 后换新", () => {
    const a = getDurableTaskRunner(dir);
    const b = getDurableTaskRunner("/some/other/dir"); // 单例忽略后续 dataDir
    expect(a).toBe(b);
    resetDurableTaskRunner();
    const c = getDurableTaskRunner(dir);
    expect(c).not.toBe(a);
  });
});
