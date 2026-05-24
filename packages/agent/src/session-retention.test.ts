import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionRetentionManager } from "./session-retention";
import type { SessionEntry } from "./session-retention";

function makeSession(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    messageCount: 10,
    isCronSession: false,
    ...overrides,
  };
}

describe("SessionRetentionManager", () => {
  let srm: SessionRetentionManager;

  beforeEach(() => {
    srm = new SessionRetentionManager({
      defaultPolicy: {
        maxSessions: 10,
        maxAgeMs: 30 * 24 * 60 * 60 * 1000,
        idleTimeoutMs: 7 * 24 * 60 * 60 * 1000,
        enabled: true,
      },
      keepMinimum: 2,
      dryRun: false,
    });
  });

  describe("prune by count", () => {
    it("should prune excess sessions", async () => {
      const sessions: SessionEntry[] = Array.from({ length: 15 }, (_, i) =>
        makeSession({
          sessionId: `s-${i}`,
          lastActiveAt: Date.now() - i * 1000,
        }),
      );

      let deleted: string[] = [];
      const result = await srm.prune(sessions, async (id) => {
        deleted.push(id);
        return true;
      });

      expect(result.toDelete).toBeGreaterThan(0);
      expect(result.deleted).toBeGreaterThan(0);
    });

    it("should keep minimum sessions", async () => {
      const sessions: SessionEntry[] = Array.from({ length: 100 }, (_, i) =>
        makeSession({
          sessionId: `s-${i}`,
          lastActiveAt: Date.now() - i * 1000,
        }),
      );

      const result = await srm.prune(sessions, async () => true);

      // Should have deleted many but kept at least keepMinimum
      expect(result.deleted + srm["config"].keepMinimum).toBeLessThanOrEqual(100);
    });

    it("should return empty result when under limit", async () => {
      const sessions: SessionEntry[] = Array.from({ length: 3 }, (_, i) =>
        makeSession({ sessionId: `s-${i}` }),
      );

      const result = await srm.prune(sessions, async () => true);
      expect(result.toDelete).toBe(0);
      expect(result.deleted).toBe(0);
    });
  });

  describe("prune by age", () => {
    it("should prune old sessions", async () => {
      const srmAge = new SessionRetentionManager({
        defaultPolicy: { maxAgeMs: 1000, enabled: true },
        keepMinimum: 0,
      });

      const sessions = [
        makeSession({ sessionId: "old", createdAt: Date.now() - 5000, lastActiveAt: Date.now() - 5000 }),
        makeSession({ sessionId: "new", createdAt: Date.now(), lastActiveAt: Date.now() }),
      ];

      let deleted: string[] = [];
      const result = await srmAge.prune(sessions, async (id) => {
        deleted.push(id);
        return true;
      });

      expect(deleted).toContain("old");
    });
  });

  describe("prune by idle", () => {
    it("should prune idle sessions", async () => {
      const srmIdle = new SessionRetentionManager({
        defaultPolicy: { idleTimeoutMs: 2000, enabled: true },
        keepMinimum: 0,
      });

      const sessions = [
        makeSession({ sessionId: "idle", lastActiveAt: Date.now() - 10000 }),
        makeSession({ sessionId: "active", lastActiveAt: Date.now() }),
      ];

      let deleted: string[] = [];
      const result = await srmIdle.prune(sessions, async (id) => {
        deleted.push(id);
        return true;
      });

      expect(deleted).toContain("idle");
      expect(deleted).not.toContain("active");
    });
  });

  describe("cron sessions", () => {
    it("should age out cron sessions faster", async () => {
      const srmCron = new SessionRetentionManager({
        defaultPolicy: { maxAgeMs: 20000, enabled: true },
        keepMinimum: 0,
      });

      const sessions = [
        makeSession({ sessionId: "cron-old", createdAt: Date.now() - 15000, isCronSession: true, lastActiveAt: Date.now() }),
        makeSession({ sessionId: "normal", createdAt: Date.now() - 15000, lastActiveAt: Date.now() }),
      ];

      let deleted: string[] = [];
      const result = await srmCron.prune(sessions, async (id) => {
        deleted.push(id);
        return true;
      });

      // Cron session should be aged out at half maxAge (10s cutoff: 20s/2 = 10s, session is 15s old)
      expect(deleted).toContain("cron-old");
      expect(deleted).not.toContain("normal");
    });
  });

  describe("channel policies", () => {
    it("should apply channel-specific policy", async () => {
      srm.setChannelPolicy("telegram", { maxSessions: 2 });

      const sessions = [
        makeSession({ sessionId: "tg-1", channel: "telegram" }),
        makeSession({ sessionId: "tg-2", channel: "telegram" }),
        makeSession({ sessionId: "tg-3", channel: "telegram" }),
      ];

      let deleted: string[] = [];
      const result = await srm.prune(sessions, async (id) => {
        deleted.push(id);
        return true;
      });

      expect(deleted.length).toBeGreaterThan(0);
    });

    it("should remove channel policy", () => {
      srm.setChannelPolicy("discord", { maxSessions: 5 });
      expect(srm.removeChannelPolicy("discord")).toBe(true);
      expect(srm.removeChannelPolicy("discord")).toBe(false);
    });
  });

  describe("dry run", () => {
    it("should report but not delete in dry run", async () => {
      const drySrm = new SessionRetentionManager({
        defaultPolicy: { maxSessions: 1, enabled: true },
        keepMinimum: 0,
        dryRun: true,
      });

      const sessions = [
        makeSession({ sessionId: "a" }),
        makeSession({ sessionId: "b" }),
      ];

      let deleteCalled = false;
      const result = await drySrm.prune(sessions, async () => {
        deleteCalled = true;
        return true;
      });

      expect(result.toDelete).toBeGreaterThan(0);
      expect(result.dryRun).toBe(true);
      expect(deleteCalled).toBe(false);
    });
  });

  describe("listPolicies", () => {
    it("should list all policies", () => {
      srm.setChannelPolicy("discord", { maxSessions: 50 });
      const policies = srm.listPolicies();
      expect(policies.length).toBe(2); // default + discord
    });
  });

  describe("configure", () => {
    it("should update config", () => {
      srm.configure({ keepMinimum: 10 });
    });
  });
});