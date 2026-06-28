import { describe, it, expect, beforeEach } from "vitest";
import {
  StaggerCoordinator,
  isTopOfHourCronExpr,
  normalizeCronStaggerMs,
  resolveDefaultCronStaggerMs,
  DEFAULT_TOP_OF_HOUR_STAGGER_MS,
  type StaggerEntry,
} from "./stagger";

describe("StaggerCoordinator", () => {
  let coord: StaggerCoordinator;

  beforeEach(() => {
    coord = new StaggerCoordinator({ windowMs: 60_000, maxJitterMs: 5_000, maxConcurrent: 3 });
  });

  describe("schedule", () => {
    it("同窗口内的任务应按 priority 降序排队", () => {
      const t = new Date("2026-06-28T10:00:00Z");
      const entries: StaggerEntry[] = [
        { jobId: "low", scheduledTime: t, priority: 1 },
        { jobId: "high", scheduledTime: t, priority: 10 },
        { jobId: "mid", scheduledTime: t, priority: 5 },
      ];

      const decisions = coord.schedule(entries);
      expect(decisions).toHaveLength(3);
      // priority 最高的 queuePosition=0
      const high = decisions.find((d) => d.jobId === "high")!;
      expect(high.queuePosition).toBe(0);
      const mid = decisions.find((d) => d.jobId === "mid")!;
      expect(mid.queuePosition).toBe(1);
      const low = decisions.find((d) => d.jobId === "low")!;
      expect(low.queuePosition).toBe(2);
    });

    it("同窗口内任务的 delayMs 应单调递增", () => {
      const t = new Date("2026-06-28T10:00:00Z");
      const entries: StaggerEntry[] = [
        { jobId: "a", scheduledTime: t, priority: 5 },
        { jobId: "b", scheduledTime: t, priority: 5 },
        { jobId: "c", scheduledTime: t, priority: 5 },
      ];

      const decisions = coord.schedule(entries);
      // 三任务的 delayMs 应满足 a <= b <= c
      const delays = decisions.map((d) => d.delayMs);
      expect(delays[0]).toBeLessThanOrEqual(delays[1]);
      expect(delays[1]).toBeLessThanOrEqual(delays[2]);
    });

    it("不同窗口的任务应分别排队", () => {
      const t1 = new Date("2026-06-28T10:00:00Z");
      const t2 = new Date("2026-06-28T11:00:00Z"); // 不同小时，不同窗口
      const entries: StaggerEntry[] = [
        { jobId: "w1a", scheduledTime: t1, priority: 1 },
        { jobId: "w1b", scheduledTime: t1, priority: 2 },
        { jobId: "w2a", scheduledTime: t2, priority: 1 },
      ];

      const decisions = coord.schedule(entries);
      expect(decisions).toHaveLength(3);
      // 窗口 1 的任务 delayMs 都在 maxJitterMs 范围内
      const w1 = decisions.filter((d) => d.jobId.startsWith("w1"));
      expect(w1.every((d) => d.delayMs <= 5_000)).toBe(true);
      // 窗口 2 的任务 delayMs 也都在 maxJitterMs 范围内（独立排队）
      const w2 = decisions.filter((d) => d.jobId.startsWith("w2"));
      expect(w2.length).toBe(1);
      expect(w2[0].delayMs).toBeLessThanOrEqual(5_000);
    });

    it("组内任务数超过 maxConcurrent 时应将超出任务延迟到下一窗口", () => {
      const t = new Date("2026-06-28T10:00:00Z");
      const entries: StaggerEntry[] = [
        { jobId: "j1", scheduledTime: t, priority: 10 },
        { jobId: "j2", scheduledTime: t, priority: 9 },
        { jobId: "j3", scheduledTime: t, priority: 8 },
        { jobId: "j4", scheduledTime: t, priority: 7 }, // 超出 maxConcurrent=3
        { jobId: "j5", scheduledTime: t, priority: 6 }, // 超出 maxConcurrent=3
      ];

      const decisions = coord.schedule(entries);
      // 前 3 个在当前窗口，后 2 个延迟到下一窗口（windowMs = 60s）
      const inWindow = decisions.filter((d) => d.delayMs < 60_000);
      const deferred = decisions.filter((d) => d.delayMs >= 60_000);
      expect(inWindow).toHaveLength(3);
      expect(deferred).toHaveLength(2);
      // 延迟任务的 reason 应包含 over-capacity
      expect(deferred.every((d) => d.reason.includes("over-capacity"))).toBe(true);
      // 延迟任务的 executeAt 应为 t + windowMs
      for (const d of deferred) {
        expect(d.executeAt.getTime()).toBe(t.getTime() + 60_000);
      }
    });

    it("delayMs 应不超过 maxJitterMs（窗口内任务）", () => {
      const t = new Date("2026-06-28T10:00:00Z");
      const entries: StaggerEntry[] = [
        { jobId: "j1", scheduledTime: t, priority: 1 },
        { jobId: "j2", scheduledTime: t, priority: 2 },
        { jobId: "j3", scheduledTime: t, priority: 3 },
      ];

      const decisions = coord.schedule(entries);
      for (const d of decisions) {
        expect(d.delayMs).toBeGreaterThanOrEqual(0);
        expect(d.delayMs).toBeLessThanOrEqual(5_000);
      }
    });

    it("空数组应返回空数组", () => {
      expect(coord.schedule([])).toEqual([]);
    });

    it("priority 相同时应按 jobId 字典序稳定排序", () => {
      const t = new Date("2026-06-28T10:00:00Z");
      const entries: StaggerEntry[] = [
        { jobId: "zeta", scheduledTime: t, priority: 5 },
        { jobId: "alpha", scheduledTime: t, priority: 5 },
        { jobId: "mid", scheduledTime: t, priority: 5 },
      ];

      const decisions = coord.schedule(entries);
      expect(decisions[0].jobId).toBe("alpha");
      expect(decisions[1].jobId).toBe("mid");
      expect(decisions[2].jobId).toBe("zeta");
    });
  });

  describe("markExecuted / getRecentExecutions", () => {
    it("应记录并返回最近的执行时间", () => {
      const now = new Date("2026-06-28T10:00:00Z");
      coord.markExecuted("job-1", new Date(now.getTime() - 5000));
      coord.markExecuted("job-1", new Date(now.getTime() - 1000));

      const recent = coord.getRecentExecutions("job-1", 10_000, now);
      expect(recent).toHaveLength(2);
      // 应按时间升序返回
      expect(recent[0].getTime()).toBeLessThan(recent[1].getTime());
    });

    it("超过 withinMs 的执行记录应被过滤", () => {
      const now = new Date("2026-06-28T10:00:00Z");
      coord.markExecuted("job-1", new Date(now.getTime() - 20_000)); // 20s 前
      coord.markExecuted("job-1", new Date(now.getTime() - 5_000));  // 5s 前

      const recent = coord.getRecentExecutions("job-1", 10_000, now);
      expect(recent).toHaveLength(1);
    });

    it("未知 jobId 应返回空数组", () => {
      expect(coord.getRecentExecutions("unknown", 10_000)).toEqual([]);
    });
  });

  describe("prune", () => {
    it("应清理过期执行记录并返回清理数", () => {
      const now = new Date("2026-06-28T10:00:00Z");
      coord.markExecuted("job-old", new Date(now.getTime() - 2 * 60 * 60 * 1000)); // 2h 前
      coord.markExecuted("job-recent", new Date(now.getTime() - 5_000)); // 5s 前

      const pruned = coord.prune(60 * 60 * 1000, now); // 清理 1h 之前的
      expect(pruned).toBe(1);
      // job-recent 应保留
      expect(coord.getRecentExecutions("job-recent", 60_000, now)).toHaveLength(1);
      // job-old 应被清理（无记录）
      expect(coord.getRecentExecutions("job-old", 60 * 60 * 1000, now)).toHaveLength(0);
    });

    it("无过期记录时应返回 0", () => {
      const now = new Date("2026-06-28T10:00:00Z");
      coord.markExecuted("job-1", now);
      expect(coord.prune(60 * 60 * 1000, now)).toBe(0);
    });
  });

  describe("reset", () => {
    it("应清空所有内部状态", () => {
      const now = new Date("2026-06-28T10:00:00Z");
      coord.markExecuted("job-1", now);
      expect(coord.getRecentExecutions("job-1", 10_000, now)).toHaveLength(1);
      coord.reset();
      expect(coord.getRecentExecutions("job-1", 10_000, now)).toHaveLength(0);
    });
  });
});

describe("isTopOfHourCronExpr", () => {
  it("应识别 5 段 top-of-hour 表达式", () => {
    expect(isTopOfHourCronExpr("0 * * * *")).toBe(true);
    expect(isTopOfHourCronExpr("0 */2 * * *")).toBe(true);
  });

  it("应识别 6 段 top-of-hour 表达式", () => {
    expect(isTopOfHourCronExpr("0 0 * * * *")).toBe(true);
    expect(isTopOfHourCronExpr("0 0 */3 * * *")).toBe(true);
  });

  it("非 top-of-hour 表达式应返回 false", () => {
    expect(isTopOfHourCronExpr("30 * * * *")).toBe(false); // minute=30
    expect(isTopOfHourCronExpr("0 5 * * *")).toBe(false);  // hour=5 固定
    expect(isTopOfHourCronExpr("*/5 * * * *")).toBe(false);
  });

  it("段数错误应返回 false", () => {
    expect(isTopOfHourCronExpr("0 * *")).toBe(false);
    expect(isTopOfHourCronExpr("")).toBe(false);
  });
});

describe("normalizeCronStaggerMs", () => {
  it("数字应被规整为非负整数", () => {
    expect(normalizeCronStaggerMs(100)).toBe(100);
    expect(normalizeCronStaggerMs(100.9)).toBe(100);
    expect(normalizeCronStaggerMs(0)).toBe(0);
  });

  it("数字字符串应被解析", () => {
    expect(normalizeCronStaggerMs("500")).toBe(500);
    expect(normalizeCronStaggerMs("  1000  ")).toBe(1000);
  });

  it("负数应返回 undefined", () => {
    expect(normalizeCronStaggerMs(-1)).toBeUndefined();
    expect(normalizeCronStaggerMs("-100")).toBeUndefined();
  });

  it("非数字字符串应返回 undefined", () => {
    expect(normalizeCronStaggerMs("abc")).toBeUndefined();
    expect(normalizeCronStaggerMs("")).toBeUndefined();
  });

  it("非数字类型应返回 undefined", () => {
    expect(normalizeCronStaggerMs(null)).toBeUndefined();
    expect(normalizeCronStaggerMs(undefined)).toBeUndefined();
    expect(normalizeCronStaggerMs({})).toBeUndefined();
  });
});

describe("resolveDefaultCronStaggerMs", () => {
  it("top-of-hour 表达式应返回默认 stagger", () => {
    expect(resolveDefaultCronStaggerMs("0 * * * *")).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("非 top-of-hour 表达式应返回 undefined", () => {
    expect(resolveDefaultCronStaggerMs("*/5 * * * *")).toBeUndefined();
  });
});
