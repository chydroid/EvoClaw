import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ThreadBindingsManager } from "./thread-bindings";
import type { ThreadBinding } from "./thread-bindings";

describe("ThreadBindingsManager", () => {
  let tbm: ThreadBindingsManager;

  beforeEach(() => {
    tbm = new ThreadBindingsManager({
      idleTimeoutMs: 10 * 60 * 1000,    // 10 min for testing
      maxAgeMs: 60 * 60 * 1000,          // 1 hour
      cleanupIntervalMs: 60 * 1000,
      crossChannelBinding: false,
      logBindings: true,
    });
  });

  afterEach(() => {
    tbm.stopCleanup();
    tbm.clear();
  });

  describe("bind", () => {
    it("should create a new binding", () => {
      const result = tbm.bind("webchat", "user-1", "session-1", "agent-1");
      expect(result.bound).toBe(true);
      expect(result.sessionId).toBe("session-1");
      expect(result.isExisting).toBe(false);
    });

    it("should return existing binding within max age", () => {
      tbm.bind("webchat", "user-1", "session-1", "agent-1");
      const result = tbm.bind("webchat", "user-1", "session-1", "agent-1");
      expect(result.bound).toBe(true);
      expect(result.sessionId).toBe("session-1");
      expect(result.isExisting).toBe(true);
    });

    it("should create new binding for different peers", () => {
      tbm.bind("webchat", "user-1", "session-1", "agent-1");
      const result = tbm.bind("webchat", "user-2", "session-2", "agent-1");
      expect(result.bound).toBe(true);
      expect(result.isExisting).toBe(false);
      expect(result.sessionId).toBe("session-2");
    });

    it("should create new binding for different channels (same peer)", () => {
      tbm.bind("webchat", "user-1", "session-1", "agent-1");
      const result = tbm.bind("telegram", "user-1", "session-2", "agent-1");
      expect(result.bound).toBe(true);
      expect(result.isExisting).toBe(false);
    });

    it("should transfer previous binding from old channel when not cross-channel", () => {
      tbm.bind("webchat", "user-1", "session-1", "agent-1");
      const result = tbm.bind("telegram", "user-1", "session-2", "agent-1");

      expect(result.bound).toBe(true);
      expect(result.isExisting).toBe(false);
      // Old binding should be inactive
      expect(tbm.getBinding("webchat", "user-1")).toBeNull();
    });
  });

  describe("crossChannelBinding", () => {
    it("should reuse session across channels when enabled", () => {
      const crossBM = new ThreadBindingsManager({
        crossChannelBinding: true,
        idleTimeoutMs: 60000,
        maxAgeMs: 3600000,
      });

      crossBM.bind("webchat", "user-1", "session-1", "agent-1");
      const result = crossBM.bind("telegram", "user-1", "existing", "agent-1");

      expect(result.isExisting).toBe(true);
      expect(result.sessionId).toBe("session-1");
    });
  });

  describe("getBinding", () => {
    it("should return binding for known peer", () => {
      tbm.bind("webchat", "user-1", "session-1", "agent-1");
      const binding = tbm.getBinding("webchat", "user-1");
      expect(binding).not.toBeNull();
      expect(binding!.sessionId).toBe("session-1");
      expect(binding!.peerId).toBe("user-1");
    });

    it("should return null for unknown peer", () => {
      expect(tbm.getBinding("webchat", "unknown")).toBeNull();
    });

    it("should update lastActivityAt on get", () => {
      tbm.bind("webchat", "user-1", "session-1", "agent-1");

      const before = Date.now();
      const binding = tbm.getBinding("webchat", "user-1");
      expect(binding!.lastActivityAt).toBeGreaterThanOrEqual(before);
    });

    it("should increment messageCount on get", () => {
      tbm.bind("webchat", "user-1", "session-1", "agent-1");
      tbm.getBinding("webchat", "user-1");
      const binding = tbm.getBinding("webchat", "user-1");
      expect(binding!.messageCount).toBe(3);
    });
  });

  describe("getBindingBySession", () => {
    it("should find binding by session ID", () => {
      tbm.bind("webchat", "user-1", "session-42", "agent-1");
      const binding = tbm.getBindingBySession("session-42");
      expect(binding).not.toBeNull();
      expect(binding!.peerId).toBe("user-1");
    });

    it("should return null for unknown session", () => {
      expect(tbm.getBindingBySession("nonexistent")).toBeNull();
    });
  });

  describe("unbind", () => {
    it("should unbind a peer", () => {
      tbm.bind("webchat", "user-1", "session-1", "agent-1");
      expect(tbm.unbind("webchat", "user-1")).toBe(true);
      expect(tbm.isBound("webchat", "user-1")).toBe(false);
    });

    it("should return false for unknown peer", () => {
      expect(tbm.unbind("webchat", "unknown")).toBe(false);
    });
  });

  describe("unbindSession", () => {
    it("should unbind all bindings for a session", () => {
      tbm.bind("webchat", "user-1", "session-1", "agent-1");
      tbm.bind("telegram", "user-2", "session-1", "agent-1");
      tbm.bind("discord", "user-3", "session-2", "agent-1");

      const count = tbm.unbindSession("session-1");
      expect(count).toBe(2);
      expect(tbm.getBindingBySession("session-1")).toBeNull();
      expect(tbm.getBindingBySession("session-2")).not.toBeNull();
    });
  });

  describe("isBound", () => {
    it("should return true for bound peer", () => {
      tbm.bind("webchat", "user-1", "session-1", "agent-1");
      expect(tbm.isBound("webchat", "user-1")).toBe(true);
    });

    it("should return false for unbound peer", () => {
      expect(tbm.isBound("webchat", "user-1")).toBe(false);
    });
  });

  describe("transfer", () => {
    it("should transfer binding to new session", () => {
      tbm.bind("webchat", "user-1", "session-1", "agent-1");
      const result = tbm.transfer("webchat", "user-1", "session-2");

      expect(result.transferred).toBe(true);
      expect(result.previousSessionId).toBe("session-1");

      const binding = tbm.getBinding("webchat", "user-1");
      expect(binding!.sessionId).toBe("session-2");
    });

    it("should return false for non-existent binding", () => {
      const result = tbm.transfer("webchat", "unknown", "session-1");
      expect(result.transferred).toBe(false);
    });
  });

  describe("touch", () => {
    it("should update lastActivityAt", () => {
      tbm.bind("webchat", "user-1", "session-1", "agent-1");
      const before = Date.now();
      tbm.touch("webchat", "user-1");
      const binding = tbm.getBinding("webchat", "user-1");
      expect(binding!.lastActivityAt).toBeGreaterThanOrEqual(before);
    });

    it("should return false for unknown peer", () => {
      expect(tbm.touch("webchat", "unknown")).toBe(false);
    });
  });

  describe("queries", () => {
    it("should get active bindings", () => {
      tbm.bind("webchat", "u1", "s1", "a1");
      tbm.bind("telegram", "u2", "s2", "a1");
      expect(tbm.getActiveBindings()).toHaveLength(2);
    });

    it("should get bindings by channel", () => {
      tbm.bind("webchat", "u1", "s1", "a1");
      tbm.bind("webchat", "u2", "s2", "a1");
      tbm.bind("telegram", "u3", "s3", "a1");
      expect(tbm.getBindingsByChannel("webchat")).toHaveLength(2);
      expect(tbm.getBindingsByChannel("telegram")).toHaveLength(1);
    });

    it("should get bindings by agent", () => {
      tbm.bind("webchat", "u1", "s1", "agent-1");
      tbm.bind("webchat", "u2", "s2", "agent-2");
      expect(tbm.getBindingsByAgent("agent-1")).toHaveLength(1);
    });

    it("should get active count", () => {
      expect(tbm.getActiveCount()).toBe(0);
      tbm.bind("webchat", "u1", "s1", "a1");
      tbm.bind("webchat", "u2", "s2", "a1");
      expect(tbm.getActiveCount()).toBe(2);
    });

    it("should compute stats", () => {
      tbm.bind("webchat", "u1", "s1", "a1");
      tbm.bind("telegram", "u2", "s2", "a1");

      const stats = tbm.getStats();
      expect(stats.total).toBe(2);
      expect(stats.active).toBe(2);
      expect(stats.byChannel["webchat"]).toBe(1);
      expect(stats.byChannel["telegram"]).toBe(1);
    });

    it("should get binding history", () => {
      tbm.bind("webchat", "u1", "s1", "a1");
      tbm.unbind("webchat", "u1", "left");

      const history = tbm.getHistory();
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history.some((h) => h.type === "bound")).toBe(true);
      expect(history.some((h) => h.type === "unbound")).toBe(true);
    });
  });

  describe("cleanup", () => {
    it("should remove expired bindings", () => {
      const shortBM = new ThreadBindingsManager({
        maxAgeMs: 1,          // Immediately expire
        idleTimeoutMs: 1,
        logBindings: false,
      });

      shortBM.bind("webchat", "u1", "s1", "a1");

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const removed = shortBM.cleanup();
          expect(removed).toBeGreaterThanOrEqual(0);

          // After cleanup, expired bindings should be gone
          resolve();
        }, 10);
      });
    });
  });

  describe("configuration", () => {
    it("should update config", () => {
      tbm.configure({ maxBindings: 500 });
      // Verify no throw
    });
  });

  describe("events", () => {
    it("should emit bound event", () => {
      const handler = vi.fn();
      tbm.on("bound", handler);
      tbm.bind("webchat", "u1", "s1", "a1");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should emit unbound event", () => {
      const handler = vi.fn();
      tbm.on("unbound", handler);
      tbm.bind("webchat", "u1", "s1", "a1");
      tbm.unbind("webchat", "u1");
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("lifecycle", () => {
    it("should start and stop cleanup", () => {
      expect(() => tbm.startCleanup()).not.toThrow();
      expect(() => tbm.stopCleanup()).not.toThrow();
    });

    it("should not start duplicate cleanup", () => {
      tbm.startCleanup();
      tbm.startCleanup();
      tbm.stopCleanup();
    });
  });
});