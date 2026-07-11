import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { KanbanBoard } from "./kanban-board";
import type { Task, TaskInput } from "./kanban-board";

// better-sqlite3 是项目根级可选依赖；部分环境 native binding 可能未编译，
// 此时优雅跳过依赖它的测试（与 infrastructure/sqlite-pragma.test.ts 同模式）。
function loadDatabaseCtor(): { new (path: string): unknown } | null {
  try {
    const Ctor = require("better-sqlite3") as { new (path: string): unknown };
    const probe = new Ctor(":memory:");
    try {
      (probe as { close?: () => void }).close?.();
    } catch {
      /* ignore */
    }
    return Ctor;
  } catch {
    return null;
  }
}

const DatabaseCtor = loadDatabaseCtor();
const itOrSkip = DatabaseCtor ? it : it.skip;

function makeTask(partial: Partial<TaskInput> & { title: string }): TaskInput {
  return {
    title: partial.title,
    description: partial.description ?? "",
    priority: partial.priority,
    dependencies: partial.dependencies,
    tenant: partial.tenant,
  };
}

describe("KanbanBoard", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let board: KanbanBoard;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kanban-test-"));
    dbPath = join(tmpDir, "kanban.db");
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    board = new KanbanBoard(registry, eventBus, dbPath);
    await board.init();
    await board.createBoard("board-1");
  });

  afterEach(() => {
    board.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  // ── 1. Board 创建/删除 ──────────────────────────────────

  itOrSkip("创建 board 并注册到 ServiceRegistry", () => {
    expect(registry.hasService("kanbanBoard")).toBe(true);
    const resolved = registry.resolveService<KanbanBoard>("kanbanBoard");
    expect(resolved).toBe(board);
  });

  itOrSkip("创建并删除 board，删除后任务一并清除", async () => {
    await board.createBoard("board-x");
    await board.addTask("board-x", makeTask({ title: "T1" }));
    await board.deleteBoard("board-x");
    const tasks = board.listTasks("board-x");
    expect(tasks).toHaveLength(0);
  });

  // ── 2. 添加任务 ─────────────────────────────────────────

  itOrSkip("添加任务后初始状态为 pending", async () => {
    const task = await board.addTask("board-1", makeTask({ title: "Setup", description: "init project" }));
    expect(task.id).toBeTruthy();
    expect(task.status).toBe("pending");
    expect(task.priority).toBe("medium");
    expect(task.dependencies).toEqual([]);
    expect(task.assignedAgent).toBeNull();
    const fetched = board.getTask(task.id);
    expect(fetched?.title).toBe("Setup");
  });

  itOrSkip("向不存在的 board 添加任务应抛错", async () => {
    await expect(
      board.addTask("no-such-board", makeTask({ title: "X" })),
    ).rejects.toThrow(/does not exist/);
  });

  // ── 3. 任务状态流转 pending → ready → claimed → in_progress → done ──

  itOrSkip("完整状态流转：pending → ready → claimed → in_progress → done", async () => {
    const task = await board.addTask("board-1", makeTask({ title: "Flow" }));
    expect(task.status).toBe("pending");

    // pending → ready（dispatch cycle 推进，无依赖）
    const cycle1 = await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    expect(cycle1.promoted).toContain(task.id);
    expect(board.getTask(task.id)?.status).toBe("ready");

    // ready → claimed（乐观锁领取）
    const claimed = await board.claimTask("agent-A", task.id);
    expect(claimed.status).toBe("claimed");
    expect(claimed.assignedAgent).toBe("agent-A");
    expect(claimed.claimedAt).not.toBeNull();

    // claimed → in_progress
    const inProgress = await board.updateTask(task.id, { status: "in_progress" });
    expect(inProgress.status).toBe("in_progress");

    // in_progress → done
    const done = await board.completeTask(task.id, { files: 3 });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    expect(done.result).toEqual({ files: 3 });
  });

  // ── 4/5. 依赖管理 ───────────────────────────────────────

  itOrSkip("依赖未完成时任务不能 ready", async () => {
    const dep = await board.addTask("board-1", makeTask({ title: "Dep" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    expect(board.getTask(dep.id)?.status).toBe("ready");

    const blocked = await board.addTask("board-1", makeTask({ title: "Blocked", dependencies: [dep.id] }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    // 依赖未 done，blocked 仍为 pending
    expect(board.getTask(blocked.id)?.status).toBe("pending");
    expect(board.listReadyTasks("board-1").map((t) => t.id)).not.toContain(blocked.id);
  });

  itOrSkip("依赖满足后自动 ready（completeTask 触发 promote）", async () => {
    const dep = await board.addTask("board-1", makeTask({ title: "Dep" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    await board.claimTask("agent-A", dep.id);

    const dependent = await board.addTask("board-1", makeTask({ title: "Waiting", dependencies: [dep.id] }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    expect(board.getTask(dependent.id)?.status).toBe("pending");

    // 完成依赖任务 → dependent 自动 promote 到 ready
    await board.completeTask(dep.id, "done-result");
    expect(board.getTask(dependent.id)?.status).toBe("ready");
  });

  // ── 6. 优先级排序 ───────────────────────────────────────

  itOrSkip("listReadyTasks 按优先级排序（high → medium → low）", async () => {
    const low = await board.addTask("board-1", makeTask({ title: "low", priority: "low" }));
    const high = await board.addTask("board-1", makeTask({ title: "high", priority: "high" }));
    const med = await board.addTask("board-1", makeTask({ title: "med", priority: "medium" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });

    const ready = board.listReadyTasks("board-1");
    expect(ready.map((t) => t.id)).toEqual([high.id, med.id, low.id]);
  });

  // ── 7. claimTask 乐观锁 ─────────────────────────────────

  itOrSkip("两个 Agent 同时领取同一任务只有一个成功", async () => {
    const task = await board.addTask("board-1", makeTask({ title: "Race" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });

    const [a, b] = await Promise.allSettled([
      board.claimTask("agent-A", task.id),
      board.claimTask("agent-B", task.id),
    ]);
    const successes = [a, b].filter((r) => r.status === "fulfilled");
    const failures = [a, b].filter((r) => r.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const winner = (successes[0] as PromiseFulfilledResult<Task>).value;
    expect(winner.assignedAgent).toMatch(/agent-[AB]/);
    expect(board.getTask(task.id)?.status).toBe("claimed");
  });

  // ── 8. heartbeat ────────────────────────────────────────

  itOrSkip("heartbeat 更新 claimedAt", async () => {
    const task = await board.addTask("board-1", makeTask({ title: "HB" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    const claimed = await board.claimTask("agent-A", task.id);
    const originalClaimedAt = claimed.claimedAt;

    // 等待一小段时间确保时间戳不同
    await new Promise((r) => setTimeout(r, 15));
    await board.heartbeat("agent-A", task.id);
    const after = board.getTask(task.id);
    expect(after?.claimedAt).not.toBe(originalClaimedAt);
    expect(after?.claimedAt).not.toBeNull();
  });

  itOrSkip("非所属 agent 的 heartbeat 应被拒绝", async () => {
    const task = await board.addTask("board-1", makeTask({ title: "HB2" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    await board.claimTask("agent-A", task.id);
    await expect(board.heartbeat("agent-B", task.id)).rejects.toThrow();
  });

  // ── 9. stale claim 回收（mock 时间） ─────────────────────

  itOrSkip("stale claim 超时后被 dispatch cycle 回收", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const task = await board.addTask("board-1", makeTask({ title: "Stale" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    await board.claimTask("agent-A", task.id);
    expect(board.getTask(task.id)?.status).toBe("claimed");

    // 推进时间超过 stale 阈值（61s）
    vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
    const result = await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    expect(result.reclaimed).toContain(task.id);
    const after = board.getTask(task.id);
    expect(after?.status).toBe("ready");
    expect(after?.assignedAgent).toBeNull();
    expect(after?.claimedAt).toBeNull();
  });

  // ── 10. completeTask 存储 result ─────────────────────────

  itOrSkip("completeTask 存储复杂 result 对象", async () => {
    const task = await board.addTask("board-1", makeTask({ title: "Res" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    await board.claimTask("agent-A", task.id);
    const result = { summary: "ok", metrics: { latency: 42, ok: true }, items: [1, 2, 3] };
    const done = await board.completeTask(task.id, result);
    expect(done.result).toEqual(result);
    expect(done.error).toBeNull();
  });

  // ── 11. failTask 存储 error ──────────────────────────────

  itOrSkip("failTask 存储 error 并置 failed 状态", async () => {
    const task = await board.addTask("board-1", makeTask({ title: "Fail" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    await board.claimTask("agent-A", task.id);
    const failed = await board.failTask(task.id, "boom: connection refused");
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("boom: connection refused");
  });

  // ── 12. listReadyTasks ───────────────────────────────────

  itOrSkip("listReadyTasks 仅返回 ready 且未领取的任务", async () => {
    const t1 = await board.addTask("board-1", makeTask({ title: "T1" }));
    const t2 = await board.addTask("board-1", makeTask({ title: "T2" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    await board.claimTask("agent-A", t1.id);

    const ready = board.listReadyTasks("board-1");
    expect(ready.map((t) => t.id)).toEqual([t2.id]);
  });

  // ── 13. listTasks 按状态过滤 ─────────────────────────────

  itOrSkip("listTasks 按状态过滤", async () => {
    const t1 = await board.addTask("board-1", makeTask({ title: "P1" }));
    const t2 = await board.addTask("board-1", makeTask({ title: "P2" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    await board.claimTask("agent-A", t1.id);

    const pending = board.listTasks("board-1", "pending");
    const claimed = board.listTasks("board-1", "claimed");
    expect(pending).toHaveLength(0);
    expect(claimed.map((t) => t.id)).toEqual([t1.id]);
  });

  // ── 14. getStats 统计 ────────────────────────────────────

  itOrSkip("getStats 正确统计各状态与优先级数量", async () => {
    await board.addTask("board-1", makeTask({ title: "H1", priority: "high" }));
    await board.addTask("board-1", makeTask({ title: "M1", priority: "medium" }));
    await board.addTask("board-1", makeTask({ title: "L1", priority: "low" }));
    const t = await board.addTask("board-1", makeTask({ title: "ClaimMe", priority: "high" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    await board.claimTask("agent-A", t.id);

    const stats = board.getStats("board-1");
    expect(stats.total).toBe(4);
    expect(stats.byStatus.ready).toBe(3);
    expect(stats.byStatus.claimed).toBe(1);
    expect(stats.byPriority.high).toBe(2);
    expect(stats.byPriority.medium).toBe(1);
    expect(stats.byPriority.low).toBe(1);
    // 所有状态字段都应存在
    expect(stats.byStatus.failed).toBe(0);
    expect(stats.byStatus.done).toBe(0);
  });

  // ── 15. Dispatcher start/stop ───────────────────────────

  itOrSkip("Dispatcher start/stop 触发 dispatch cycle", async () => {
    vi.useFakeTimers();
    const task = await board.addTask("board-1", makeTask({ title: "Disp" }));
    expect(board.getTask(task.id)?.status).toBe("pending");

    board.startDispatcher(100, 60_000);
    // 推进 fake timer 触发定时器回调 + 微任务
    await vi.advanceTimersByTimeAsync(150);
    expect(board.getTask(task.id)?.status).toBe("ready");

    board.stopDispatcher();
    // stop 后再推进不应有副作用（无定时器）
    const before = board.getTask(task.id)?.status;
    await vi.advanceTimersByTimeAsync(200);
    expect(board.getTask(task.id)?.status).toBe(before);
  });

  itOrSkip("stopDispatcher 幂等，未启动时调用不抛错", () => {
    expect(() => board.stopDispatcher()).not.toThrow();
  });

  // ── 16. Tenant 命名空间过滤 ───────────────────────────────

  itOrSkip("listTasks 按 tenant 过滤", async () => {
    await board.addTask("board-1", makeTask({ title: "T-A", tenant: "tenantA" }));
    await board.addTask("board-1", makeTask({ title: "T-B", tenant: "tenantB" }));
    await board.addTask("board-1", makeTask({ title: "T-none" }));

    const aTasks = board.listTasks("board-1", undefined, "tenantA");
    expect(aTasks.map((t) => t.title)).toEqual(["T-A"]);
    const noneTasks = board.listTasks("board-1", undefined, null);
    expect(noneTasks.map((t) => t.title)).toEqual(["T-none"]);
  });

  // ── 17. Board 隔离 ──────────────────────────────────────

  itOrSkip("Board 隔离：A board 的任务不出现在 B board", async () => {
    await board.createBoard("board-2");
    await board.addTask("board-1", makeTask({ title: "A1" }));
    await board.addTask("board-2", makeTask({ title: "B1" }));

    expect(board.listTasks("board-1").map((t) => t.title)).toEqual(["A1"]);
    expect(board.listTasks("board-2").map((t) => t.title)).toEqual(["B1"]);
    expect(board.listReadyTasks("board-1")).toHaveLength(0);
  });

  itOrSkip("Board 隔离：B board 的 dispatch 不影响 A board 任务", async () => {
    await board.createBoard("board-2");
    const a = await board.addTask("board-1", makeTask({ title: "A1" }));
    const b = await board.addTask("board-2", makeTask({ title: "B1" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });

    expect(board.getTask(a.id)?.status).toBe("ready");
    expect(board.getTask(b.id)?.status).toBe("ready");
    // ready 任务各自归属自己的 board
    expect(board.listReadyTasks("board-1").map((t) => t.id)).toEqual([a.id]);
    expect(board.listReadyTasks("board-2").map((t) => t.id)).toEqual([b.id]);
  });

  // ── 18. 持久化：重新打开同一 DB 恢复数据 ─────────────────

  itOrSkip("持久化：关闭后重新打开同一 DB 文件恢复任务", async () => {
    const task = await board.addTask("board-1", makeTask({ title: "Persist" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    await board.claimTask("agent-A", task.id);
    board.close();

    // 用新的实例重新打开同一 dbPath
    const registry2 = new ServiceRegistry();
    const eventBus2 = new EventBus();
    const board2 = new KanbanBoard(registry2, eventBus2, dbPath);
    await board2.init();
    try {
      const restored = board2.getTask(task.id);
      expect(restored?.title).toBe("Persist");
      expect(restored?.status).toBe("claimed");
      expect(restored?.assignedAgent).toBe("agent-A");
      const boardTasks = board2.listTasks("board-1");
      expect(boardTasks.map((t) => t.title)).toContain("Persist");
    } finally {
      board2.close();
    }
  });

  // ── 19. agent.stopped 事件释放任务 ───────────────────────

  itOrSkip("agent.stopped 事件触发该 agent 的任务释放", async () => {
    const task = await board.addTask("board-1", makeTask({ title: "Release" }));
    await board.runDispatchCycle({ staleTimeoutMs: 60_000 });
    await board.claimTask("agent-A", task.id);
    expect(board.getTask(task.id)?.status).toBe("claimed");

    // 发布 agent.stopped 事件，携带 agentId
    await eventBus.publish("agent.stopped", { agentId: "agent-A" }, "test");
    // 事件处理是 async，await 后任务应被释放回 ready
    expect(board.getTask(task.id)?.status).toBe("ready");
    expect(board.getTask(task.id)?.assignedAgent).toBeNull();
  });
});
