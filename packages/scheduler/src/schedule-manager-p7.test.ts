/**
 * P7 cron 持久化 pendingSlot + 配额测试。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { ScheduleManager, type ScheduledTask } from "./schedule-manager";

const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

describe("ScheduleManager P7（pendingSlot/配额/恢复）", () => {
  let tmpDir: string;
  let manager: ScheduleManager | null = null;
  let registry: ServiceRegistry;
  let eventBus: EventBus;

  const tasksFile = (): string => path.join(tmpDir, "tasks.json");

  const readTasks = (): ScheduledTask[] =>
    JSON.parse(fs.readFileSync(tasksFile(), "utf-8")) as ScheduledTask[];

  const writeTask = (task: Partial<ScheduledTask> & Pick<ScheduledTask, "id">): void => {
    const base: ScheduledTask = {
      name: task.name ?? "test task",
      cronExpression: "0 0 1 1 *",
      description: "",
      handlerType: "custom",
      handlerConfig: {},
      enabled: true,
      runCount: 0,
      errorCount: 0,
      failureStreak: 0,
      maxRetries: 0,
      retryDelayMs: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...task,
    };
    fs.writeFileSync(tasksFile(), JSON.stringify([base], null, 2));
  };

  const makeManager = async (): Promise<ScheduleManager> => {
    manager = new ScheduleManager(registry, eventBus, {
      dataDir: tmpDir,
      failureNudgeThreshold: 0,
    });
    await manager.initialize();
    return manager;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-p7-"));
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    manager = null;
  });

  afterEach(async () => {
    await manager?.stop();
    manager = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("崩溃后重启只补跑一次，随后窗口清除", async () => {
    writeTask({
      id: "crash-1",
      pendingSlot: { scheduledAt: iso(-60_000), stampedAt: iso(-30_000), owner: 999_999 },
    });

    const first = await makeManager();
    const handler = vi.fn(async () => {});
    first.registerHandler("custom", handler);
    first.start();

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(readTasks()[0].pendingSlot).toBeUndefined());
    await first.stop();

    // 第二次启动：没有 pendingSlot，不应再补跑
    manager = null;
    const second = await makeManager();
    const handler2 = vi.fn(async () => {});
    second.registerHandler("custom", handler2);
    second.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(handler2).not.toHaveBeenCalled();
  });

  it("owner 存活且窗口新鲜时不恢复（不抢占）", async () => {
    writeTask({
      id: "live-1",
      pendingSlot: { scheduledAt: iso(-10_000), stampedAt: iso(-1_000), owner: process.pid },
    });

    const m = await makeManager();
    const handler = vi.fn(async () => {});
    m.registerHandler("custom", handler);
    m.start();

    await new Promise((r) => setTimeout(r, 150));
    expect(handler).not.toHaveBeenCalled();
    expect(readTasks()[0].pendingSlot).toMatchObject({ owner: process.pid, stampedAt: expect.any(String) });
  });

  it("owner 存活但超过 TTL 时恢复一次", async () => {
    writeTask({
      id: "stale-1",
      pendingSlot: { scheduledAt: iso(-600_000), stampedAt: iso(-400_000), owner: process.pid },
    });

    const m = await makeManager();
    const handler = vi.fn(async () => {});
    m.registerHandler("custom", handler);
    m.start();

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });

  it("停用任务只清窗口、不补跑", async () => {
    writeTask({
      id: "disabled-1",
      enabled: false,
      pendingSlot: { scheduledAt: iso(-60_000), stampedAt: iso(-30_000), owner: 999_999 },
    });

    const m = await makeManager();
    const handler = vi.fn(async () => {});
    m.registerHandler("custom", handler);
    m.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(handler).not.toHaveBeenCalled();
    expect(readTasks()[0].pendingSlot).toBeUndefined();
  });

  it("派发前同步落盘 pendingSlot，完成后清除", async () => {
    const m = await makeManager();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handler = vi.fn(async () => { await gate; });
    m.registerHandler("custom", handler);

    const task = m.createTask({
      name: "stamp",
      cronExpression: "0 0 1 1 *",
      handlerType: "custom",
      enabled: false,
    });

    const running = m.executeTask(task.id);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    const during = readTasks().find((t) => t.id === task.id);
    expect(during?.pendingSlot).toMatchObject({
      owner: process.pid,
      scheduledAt: expect.any(String),
      stampedAt: expect.any(String),
    });

    release();
    await running;

    const after = readTasks().find((t) => t.id === task.id);
    expect(after?.pendingSlot).toBeUndefined();
    expect(after?.runCount).toBe(1);
  });

  it("配额窗口：limit 用尽后跳过且不调用 handler", async () => {
    const m = await makeManager();
    const handler = vi.fn(async () => {});
    m.registerHandler("custom", handler);

    const task = m.createTask({
      name: "quota",
      cronExpression: "0 0 1 1 *",
      handlerType: "custom",
      enabled: false,
      quota: { windowMs: 60_000, limit: 1 },
    });

    const first = await m.executeTask(task.id);
    expect(first.success).toBe(true);

    const second = await m.executeTask(task.id);
    expect(second.success).toBe(false);
    expect(second.error).toBe("Quota exceeded");

    expect(handler).toHaveBeenCalledTimes(1);
    const persisted = readTasks().find((t) => t.id === task.id);
    expect(persisted?.quota?.used).toBe(1);
    expect(persisted?.quota?.windowStart).toBeTruthy();
  });

  it("配额窗口滚动后恢复可用", async () => {
    const m = await makeManager();
    const handler = vi.fn(async () => {});
    m.registerHandler("custom", handler);

    const task = m.createTask({
      name: "quota-roll",
      cronExpression: "0 0 1 1 *",
      handlerType: "custom",
      enabled: false,
      quota: { windowMs: 60_000, limit: 1 },
    });

    // 手动把窗口推到过去
    const persisted = readTasks();
    persisted[0].quota = { windowMs: 60_000, limit: 1, windowStart: iso(-120_000), used: 1 };
    fs.writeFileSync(tasksFile(), JSON.stringify(persisted, null, 2));

    // 重新加载任务定义（配额来自磁盘）
    const m2 = new ScheduleManager(registry, eventBus, { dataDir: tmpDir, failureNudgeThreshold: 0 });
    await m2.initialize();
    m2.registerHandler("custom", handler);
    const result = await m2.executeTask(task.id);

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    await m2.stop();
  });

  it("时区字段随任务持久化", async () => {
    const m = await makeManager();
    const task = m.createTask({
      name: "tz",
      cronExpression: "0 0 1 1 *",
      handlerType: "custom",
      timezone: "America/New_York",
      enabled: false,
    });

    expect(task.timezone).toBe("America/New_York");
    expect(readTasks().find((t) => t.id === task.id)?.timezone).toBe("America/New_York");
  });
});
