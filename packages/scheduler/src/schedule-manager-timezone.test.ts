/**
 * P7：每任务时区传给 node-cron；老任务回落全局 EVOCLAW_TIMEZONE。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ServiceRegistry, EventBus } from "@evoclaw/core";

const { scheduleSpy } = vi.hoisted(() => ({ scheduleSpy: vi.fn() }));

vi.mock("node-cron", () => ({
  validate: () => true,
  schedule: (...args: unknown[]) => {
    scheduleSpy(...args);
    return {
      stop: () => {},
      nextDate: () => ({ toJSDate: () => new Date(Date.now() + 3_600_000) }),
    };
  },
}));

import { ScheduleManager } from "./schedule-manager";

describe("ScheduleManager 时区（P7）", () => {
  let tmpDir: string;
  let manager: ScheduleManager;
  const originalTz = process.env.EVOCLAW_TIMEZONE;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-tz-"));
    scheduleSpy.mockClear();
    process.env.EVOCLAW_TIMEZONE = "Europe/Berlin";
    manager = new ScheduleManager(new ServiceRegistry(), new EventBus(), { dataDir: tmpDir });
  });

  afterEach(async () => {
    await manager.stop();
    if (originalTz === undefined) delete process.env.EVOCLAW_TIMEZONE;
    else process.env.EVOCLAW_TIMEZONE = originalTz;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("任务时区优先，缺省回落全局", async () => {
    await manager.initialize();

    const withTz = manager.createTask({
      name: "ny",
      cronExpression: "0 9 * * *",
      handlerType: "custom",
      timezone: "America/New_York",
    });
    const withoutTz = manager.createTask({
      name: "global",
      cronExpression: "0 9 * * *",
      handlerType: "custom",
    });

    manager.start();

    const started = scheduleSpy.mock.calls.filter(
      (call) => (call[2] as { scheduled?: boolean } | undefined)?.scheduled === true,
    );
    const optsFor = (taskId: string) => {
      // schedule 调用顺序与 tasks Map 插入顺序一致
      const index = [withTz.id, withoutTz.id].indexOf(taskId);
      return started[index]?.[2] as { timezone?: string };
    };

    expect(optsFor(withTz.id)?.timezone).toBe("America/New_York");
    expect(optsFor(withoutTz.id)?.timezone).toBe("Europe/Berlin");
  });
});
