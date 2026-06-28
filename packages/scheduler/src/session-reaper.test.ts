import { describe, it, expect, beforeEach } from "vitest";
import {
  SessionReaper,
  isZombieSession,
  type ReaperSession,
  type ReaperDecision,
} from "./session-reaper";

describe("SessionReaper", () => {
  let reaper: SessionReaper;

  beforeEach(() => {
    reaper = new SessionReaper({
      maxAgeMs: 24 * 60 * 60 * 1000,        // 24h
      maxIdleMs: 60 * 60 * 1000,             // 1h
      failedRetentionMs: 7 * 24 * 60 * 60 * 1000,  // 7d
      maxRunningMs: 6 * 60 * 60 * 1000,     // 6h
    });
  });

  function makeSession(overrides: Partial<ReaperSession> = {}): ReaperSession {
    const now = new Date("2026-06-28T10:00:00Z");
    return {
      id: "sess-1",
      status: "running",
      startedAt: now,
      lastActivityAt: now,
      ...overrides,
    };
  }

  describe("evaluate", () => {
    it("running 状态超过 maxRunningMs 应返回 kill", () => {
      const now = new Date("2026-06-28T16:30:00Z"); // 6.5h 后
      const session = makeSession({
        status: "running",
        startedAt: new Date("2026-06-28T10:00:00Z"),
        lastActivityAt: new Date("2026-06-28T16:00:00Z"), // 30 分钟前活动
      });

      const decision = reaper.evaluate(session, now);
      expect(decision.action).toBe("kill");
      expect(decision.reason).toContain("maxRunningMs");
    });

    it("running 状态空闲超过 maxIdleMs 应返回 kill（僵尸）", () => {
      const now = new Date("2026-06-28T11:30:00Z");
      const session = makeSession({
        status: "running",
        startedAt: new Date("2026-06-28T10:00:00Z"),
        lastActivityAt: new Date("2026-06-28T10:15:00Z"), // 1h15m 前活动
      });

      const decision = reaper.evaluate(session, now);
      expect(decision.action).toBe("kill");
      expect(decision.reason).toContain("zombie");
    });

    it("failed 状态超过 failedRetentionMs 应返回 archive", () => {
      const now = new Date("2026-07-06T10:00:00Z"); // 8 天后（> failedRetentionMs 7d）
      const session = makeSession({
        status: "failed",
        startedAt: new Date("2026-06-28T10:00:00Z"),
        lastActivityAt: new Date("2026-06-28T10:05:00Z"),
      });

      const decision = reaper.evaluate(session, now);
      expect(decision.action).toBe("archive");
      expect(decision.reason).toContain("retention");
    });

    it("任意状态超过 maxAgeMs 应返回 close", () => {
      const now = new Date("2026-06-29T11:00:00Z"); // 25h 后
      const session = makeSession({
        status: "completed",
        startedAt: new Date("2026-06-28T10:00:00Z"),
        lastActivityAt: new Date("2026-06-28T10:05:00Z"),
      });

      const decision = reaper.evaluate(session, now);
      expect(decision.action).toBe("close");
      expect(decision.reason).toContain("maxAgeMs");
    });

    it("running 状态正常范围内应返回 keep", () => {
      const now = new Date("2026-06-28T10:30:00Z"); // 30 分钟后
      const session = makeSession({
        status: "running",
        startedAt: new Date("2026-06-28T10:00:00Z"),
        lastActivityAt: new Date("2026-06-28T10:25:00Z"), // 5 分钟前活动
      });

      const decision = reaper.evaluate(session, now);
      expect(decision.action).toBe("keep");
    });

    it("failed 状态未过保留期应返回 keep", () => {
      const now = new Date("2026-06-28T11:00:00Z"); // 1 小时后
      const session = makeSession({
        status: "failed",
        startedAt: new Date("2026-06-28T10:00:00Z"),
        lastActivityAt: new Date("2026-06-28T10:05:00Z"),
      });

      const decision = reaper.evaluate(session, now);
      expect(decision.action).toBe("keep");
    });

    it("completed 状态未超 maxAgeMs 应返回 keep", () => {
      const now = new Date("2026-06-28T15:00:00Z"); // 5 小时后
      const session = makeSession({
        status: "completed",
        startedAt: new Date("2026-06-28T10:00:00Z"),
        lastActivityAt: new Date("2026-06-28T10:05:00Z"),
      });

      const decision = reaper.evaluate(session, now);
      expect(decision.action).toBe("keep");
    });

    it("cancelled 状态未超 maxAgeMs 应返回 keep", () => {
      const now = new Date("2026-06-28T15:00:00Z");
      const session = makeSession({
        status: "cancelled",
        startedAt: new Date("2026-06-28T10:00:00Z"),
        lastActivityAt: new Date("2026-06-28T10:05:00Z"),
      });

      const decision = reaper.evaluate(session, now);
      expect(decision.action).toBe("keep");
    });

    it("running 同时超 maxRunningMs 和 maxIdleMs 应优先返回 maxRunningMs 决策", () => {
      const now = new Date("2026-06-29T10:00:00Z"); // 24 小时后
      const session = makeSession({
        status: "running",
        startedAt: new Date("2026-06-28T10:00:00Z"),
        lastActivityAt: new Date("2026-06-28T11:00:00Z"), // 23 小时前活动
      });

      const decision = reaper.evaluate(session, now);
      expect(decision.action).toBe("kill");
      // maxRunningMs 优先级更高
      expect(decision.reason).toContain("maxRunningMs");
    });
  });

  describe("evaluateAll", () => {
    it("应批量评估所有会话", () => {
      const now = new Date("2026-06-28T11:30:00Z");
      const sessions = [
        makeSession({ id: "s1", status: "running", lastActivityAt: new Date("2026-06-28T10:00:00Z") }),
        makeSession({ id: "s2", status: "completed" }),
      ];

      const decisions = reaper.evaluateAll(sessions, now);
      expect(decisions).toHaveLength(2);
      const s1Decision = decisions.find((d) => d.sessionId === "s1");
      const s2Decision = decisions.find((d) => d.sessionId === "s2");
      expect(s1Decision?.action).toBe("kill");
      expect(s2Decision?.action).toBe("keep");
    });
  });

  describe("reap", () => {
    it("应对每个非 keep 决策调用对应处理器", async () => {
      const now = new Date("2026-06-29T11:00:00Z"); // 25h 后（> maxAgeMs 24h）
      const killed: string[] = [];
      const closed: string[] = [];
      const archived: string[] = [];

      const sessions = [
        makeSession({
          id: "running-zombie",
          status: "running",
          startedAt: new Date("2026-06-28T10:00:00Z"),
          lastActivityAt: new Date("2026-06-28T11:00:00Z"), // 23h 前活动
        }),
        makeSession({
          id: "completed-old",
          status: "completed",
          startedAt: new Date("2026-06-28T10:00:00Z"),
          lastActivityAt: new Date("2026-06-28T10:05:00Z"),
        }),
        makeSession({
          id: "failed-old",
          status: "failed",
          startedAt: new Date("2026-06-28T10:00:00Z"),
          lastActivityAt: new Date("2026-06-28T10:05:00Z"),
        }),
      ];

      // running-zombie 已超 maxRunningMs (6h) → kill
      // completed-old 已超 maxAgeMs (24h) → close
      // failed-old 仅 25h，未到 failedRetentionMs (7d)；
      //   但超 maxAgeMs (24h) → 触发 close（maxAgeMs 检查在 failedRetentionMs 之后）

      const decisions = await reaper.reap(sessions, {
        kill: async (id) => { killed.push(id); },
        close: async (id) => { closed.push(id); },
        archive: async (id) => { archived.push(id); },
      }, now);

      expect(killed).toContain("running-zombie");
      // completed-old 和 failed-old 都超过 maxAgeMs(24h) → 都触发 close
      expect(closed).toContain("completed-old");
      expect(closed).toContain("failed-old");
      // failed-old 未到 7d retention，不应 archive
      expect(archived).not.toContain("failed-old");
      // actionable 决策应不包含 keep
      expect(decisions.every((d) => d.action !== "keep")).toBe(true);
    });

    it("处理器抛错时不应中断后续回收", async () => {
      const now = new Date("2026-06-29T11:00:00Z"); // 25h 后
      const closed: string[] = [];

      const sessions = [
        makeSession({
          id: "kill-fail",
          status: "running",
          startedAt: new Date("2026-06-28T10:00:00Z"),
          lastActivityAt: new Date("2026-06-28T11:00:00Z"),
        }),
        makeSession({
          id: "close-ok",
          status: "completed",
          startedAt: new Date("2026-06-28T10:00:00Z"),
          lastActivityAt: new Date("2026-06-28T10:05:00Z"),
        }),
      ];

      // kill 处理器抛错
      await reaper.reap(sessions, {
        kill: async () => { throw new Error("kill failed"); },
        close: async (id) => { closed.push(id); },
      }, now);

      // close 处理器仍应被调用
      expect(closed).toContain("close-ok");
    });

    it("缺少对应处理器时应跳过而不报错", async () => {
      const now = new Date("2026-06-29T11:00:00Z");
      const sessions = [
        makeSession({
          id: "kill-target",
          status: "running",
          startedAt: new Date("2026-06-28T10:00:00Z"),
          lastActivityAt: new Date("2026-06-28T11:00:00Z"),
        }),
      ];

      // 不提供 kill 处理器
      const decisions = await reaper.reap(sessions, {}, now);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].action).toBe("kill");
    });
  });

  describe("configure", () => {
    it("应能运行时更新配置", () => {
      reaper.configure({ maxAgeMs: 1000, maxRunningMs: 2000 });
      expect(reaper.config.maxAgeMs).toBe(1000);
      expect(reaper.config.maxRunningMs).toBe(2000);
      expect(reaper.config.maxIdleMs).toBe(60 * 60 * 1000); // 未更新保持原值
    });
  });
});

describe("isZombieSession", () => {
  it("running 且空闲超阈值应返回 true", () => {
    const now = new Date("2026-06-28T11:30:00Z");
    const session: ReaperSession = {
      id: "s1",
      status: "running",
      startedAt: new Date("2026-06-28T10:00:00Z"),
      lastActivityAt: new Date("2026-06-28T10:15:00Z"), // 1h15m 前
    };
    expect(isZombieSession(session, 60 * 60 * 1000, now)).toBe(true);
  });

  it("非 running 状态应返回 false", () => {
    const now = new Date("2026-06-28T11:30:00Z");
    const session: ReaperSession = {
      id: "s1",
      status: "completed",
      startedAt: new Date("2026-06-28T10:00:00Z"),
      lastActivityAt: new Date("2026-06-28T10:15:00Z"),
    };
    expect(isZombieSession(session, 60 * 60 * 1000, now)).toBe(false);
  });

  it("running 但未超阈值应返回 false", () => {
    const now = new Date("2026-06-28T10:30:00Z");
    const session: ReaperSession = {
      id: "s1",
      status: "running",
      startedAt: new Date("2026-06-28T10:00:00Z"),
      lastActivityAt: new Date("2026-06-28T10:25:00Z"), // 5 分钟前活动
    };
    expect(isZombieSession(session, 60 * 60 * 1000, now)).toBe(false);
  });
});
