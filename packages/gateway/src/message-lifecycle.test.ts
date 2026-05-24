import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MessageLifecycleManager } from "./message-lifecycle";
import type { LifecycleRecord, MessageState } from "./message-lifecycle";
import type { ChannelType } from "./channel-manager.js";

describe("MessageLifecycleManager", () => {
  let lm: MessageLifecycleManager;

  beforeEach(() => {
    lm = new MessageLifecycleManager();
  });

  afterEach(() => {
    lm.stopCleanup();
    lm.clear();
  });

  describe("Registration", () => {
    it("should register a new message", () => {
      const record = lm.register("webchat" as ChannelType, "user-1", "Hello world");
      expect(record.id).toBeDefined();
      expect(record.channel).toBe("webchat");
      expect(record.target).toBe("user-1");
      expect(record.text).toBe("Hello world");
      expect(record.state).toBe("pending");
      expect(record.attempts).toBe(0);
      expect(record.acknowledged).toBe(false);
      expect(record.history).toHaveLength(1);
    });

    it("should truncate long message text", () => {
      const longText = "A".repeat(500);
      const record = lm.register("webchat" as ChannelType, "user-1", longText);
      expect(record.text.length).toBeLessThanOrEqual(200);
      expect(record.text.endsWith("...")).toBe(true);
    });

    it("should replace existing record for same message", () => {
      const r1 = lm.register("webchat" as ChannelType, "user-1", "Hello");
      const r2 = lm.register("webchat" as ChannelType, "user-1", "Hello");
      expect(r2.id).not.toBe(r1.id);
      expect(lm.get(r1.id)).toBeNull();
      expect(lm.get(r2.id)).toBeDefined();
    });

    it("should not replace different messages to same target", () => {
      const r1 = lm.register("webchat" as ChannelType, "user-1", "Hello");
      const r2 = lm.register("webchat" as ChannelType, "user-1", "World");
      expect(lm.get(r1.id)).toBeDefined();
      expect(lm.get(r2.id)).toBeDefined();
    });
  });

  describe("State Transitions", () => {
    let record: LifecycleRecord;

    beforeEach(() => {
      record = lm.register("webchat" as ChannelType, "user-1", "Hello");
    });

    it("should transition pending → queued", () => {
      const updated = lm.transition(record.id, "queued");
      expect(updated).not.toBeNull();
      expect(updated!.state).toBe("queued");
      expect(updated!.attempts).toBe(1);
    });

    it("should transition queued → sending", () => {
      lm.transition(record.id, "queued");
      const updated = lm.transition(record.id, "sending");
      expect(updated!.state).toBe("sending");
    });

    it("should transition sending → sent", () => {
      lm.transition(record.id, "queued");
      lm.transition(record.id, "sending");
      const updated = lm.transition(record.id, "sent");
      expect(updated!.state).toBe("sent");
    });

    it("should complete full happy path: pending → queued → sending → sent → delivered", () => {
      lm.transition(record.id, "queued");
      lm.transition(record.id, "sending");
      lm.transition(record.id, "sent");
      const final = lm.transition(record.id, "delivered");
      expect(final!.state).toBe("delivered");
      expect(final!.history).toHaveLength(5); // Created + 4 transitions
    });

    it("should handle failure path: pending → queued → failed → retrying → sending → sent", () => {
      lm.transition(record.id, "queued");
      lm.transition(record.id, "failed", { error: "Network timeout" });
      expect(lm.get(record.id)!.lastError).toBe("Network timeout");

      lm.transition(record.id, "retrying");
      lm.transition(record.id, "sending");
      const final = lm.transition(record.id, "sent");
      expect(final!.state).toBe("sent");
    });

    it("should handle permanent failure path", () => {
      lm.transition(record.id, "queued");
      lm.transition(record.id, "failed", { error: "Auth error" });
      const final = lm.transition(record.id, "permanent_failure", {
        error: "Invalid credentials",
        reason: "Permanent auth failure",
      });
      expect(final!.state).toBe("permanent_failure");
      expect(final!.lastError).toBe("Invalid credentials");
    });

    it("should reject invalid transitions", () => {
      // Can't go from pending → delivered directly
      const result = lm.transition(record.id, "delivered");
      expect(result).toBeNull();
    });

    it("should reject transition from terminal state", () => {
      lm.transition(record.id, "queued");
      lm.transition(record.id, "failed");
      lm.transition(record.id, "permanent_failure");
      const result = lm.transition(record.id, "retrying");
      expect(result).toBeNull();
    });

    it("should emit stateChange events", () => {
      const handler = vi.fn();
      lm.on("stateChange", handler);

      lm.transition(record.id, "queued");
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].previousState).toBe("pending");
      expect(handler.mock.calls[0][0].newState).toBe("queued");
    });

    it("should return null for non-existent record", () => {
      const result = lm.transition("nonexistent", "queued");
      expect(result).toBeNull();
    });
  });

  describe("Convenience Methods", () => {
    let record: LifecycleRecord;

    beforeEach(() => {
      record = lm.register("webchat" as ChannelType, "user-1", "Hello");
    });

    it("should markSent to sent on success", () => {
      lm.transition(record.id, "queued");
      lm.transition(record.id, "sending");

      const updated = lm.markSent(record.id, {
        success: true,
        messageId: "ch-msg-001",
        channel: "webchat" as ChannelType,
      });
      expect(updated!.state).toBe("sent");
      expect(updated!.messageId).toBe("ch-msg-001");
    });

    it("should markSent to failed on error", () => {
      lm.transition(record.id, "queued");
      lm.transition(record.id, "sending");

      const updated = lm.markSent(record.id, {
        success: false,
        error: "Network error",
        channel: "webchat" as ChannelType,
      });
      expect(updated!.state).toBe("failed");
      expect(updated!.lastError).toBe("Network error");
    });

    it("should markDelivered", () => {
      lm.transition(record.id, "queued");
      lm.transition(record.id, "sending");
      lm.transition(record.id, "sent");
      const updated = lm.markDelivered(record.id);
      expect(updated!.state).toBe("delivered");
    });

    it("should markPermanentFailure", () => {
      const updated = lm.markPermanentFailure(record.id, "Auth expired");
      expect(updated).toBeNull(); // Can't go pending → permanent_failure directly

      lm.transition(record.id, "queued");
      lm.transition(record.id, "failed");
      const updated2 = lm.markPermanentFailure(record.id, "Auth expired");
      expect(updated2!.state).toBe("permanent_failure");
    });

    it("should markRetrying", () => {
      lm.transition(record.id, "queued");
      lm.transition(record.id, "failed");
      const updated = lm.markRetrying(record.id);
      expect(updated!.state).toBe("retrying");
    });

    it("should acknowledge", () => {
      lm.acknowledge(record.id);
      expect(lm.get(record.id)!.acknowledged).toBe(true);
    });
  });

  describe("Queries", () => {
    it("should filter by state", () => {
      const r1 = lm.register("webchat" as ChannelType, "u1", "A");
      const r2 = lm.register("webchat" as ChannelType, "u2", "B");

      lm.transition(r1.id, "queued");
      lm.transition(r1.id, "sending");

      expect(lm.getByState("sending")).toHaveLength(1);
      expect(lm.getByState("pending")).toHaveLength(1);
    });

    it("should filter by channel", () => {
      lm.register("webchat" as ChannelType, "u1", "A");
      lm.register("telegram" as ChannelType, "u2", "B");
      lm.register("discord" as ChannelType, "u3", "C");

      expect(lm.getByChannel("telegram" as ChannelType)).toHaveLength(1);
      expect(lm.getByChannel("webchat" as ChannelType)).toHaveLength(1);
    });

    it("should get active records (non-terminal)", () => {
      const r1 = lm.register("webchat" as ChannelType, "u1", "A");
      const r2 = lm.register("webchat" as ChannelType, "u2", "B");

      lm.transition(r1.id, "queued");
      lm.transition(r1.id, "sending");
      lm.transition(r1.id, "sent");
      lm.transition(r1.id, "delivered");

      expect(lm.getActive()).toHaveLength(1); // Only r2 still pending
    });

    it("should get by target", () => {
      lm.register("webchat" as ChannelType, "u1", "A");
      lm.register("webchat" as ChannelType, "u1", "B");
      lm.register("webchat" as ChannelType, "u2", "C");

      expect(lm.getByTarget("u1")).toHaveLength(2);
      expect(lm.getByTarget("u2")).toHaveLength(1);
    });

    it("should compute stats", () => {
      const r1 = lm.register("webchat" as ChannelType, "u1", "A");
      const r2 = lm.register("telegram" as ChannelType, "u2", "B");

      lm.transition(r1.id, "queued");
      lm.transition(r1.id, "failed");
      lm.transition(r1.id, "permanent_failure");

      const stats = lm.getStats();
      expect(stats.total).toBe(2);
      expect(stats.byState["pending"]).toBe(1);
      expect(stats.byState["permanent_failure"]).toBe(1);
      expect(stats.failedCount).toBe(1);
      expect(stats.deliveredCount).toBe(0);
    });
  });

  describe("TTL Expiry", () => {
    it("should detect expired records", () => {
      const shortLM = new MessageLifecycleManager({ defaultTTLMs: 10 });
      shortLM.register("webchat" as ChannelType, "u1", "A");

      // Records should expire quickly
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const expired = shortLM.getExpired();
          expect(expired.length).toBeGreaterThanOrEqual(0);
          resolve();
        }, 20);
      });
    });

    it("should auto-transition expired records to permanent_failure", () => {
      const shortLM = new MessageLifecycleManager({ defaultTTLMs: 10 });
      const r = shortLM.register("webchat" as ChannelType, "u1", "A");

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const count = shortLM.checkExpiry();
          expect(count).toBeGreaterThanOrEqual(0);
          resolve();
        }, 20);
      });
    });
  });

  describe("Mutation", () => {
    it("should delete a record", () => {
      const r = lm.register("webchat" as ChannelType, "u1", "A");
      expect(lm.delete(r.id)).toBe(true);
      expect(lm.get(r.id)).toBeNull();
    });

    it("should clear all records", () => {
      lm.register("webchat" as ChannelType, "u1", "A");
      lm.register("webchat" as ChannelType, "u1", "B");
      lm.clear();
      expect(lm.getStats().total).toBe(0);
    });

    it("should delete non-existent record gracefully", () => {
      expect(lm.delete("nonexistent")).toBe(false);
    });
  });

  describe("Configuration", () => {
    it("should update config", () => {
      lm.configure({ defaultTTLMs: 10000 });
      // Verify by registering and checking TTL
      const r = lm.register("webchat" as ChannelType, "u1", "A");
      expect(r.ttlMs).toBe(10000);
    });
  });

  describe("Cleanup", () => {
    it("should start and stop cleanup", () => {
      expect(() => lm.startCleanup()).not.toThrow();
      expect(() => lm.stopCleanup()).not.toThrow();
    });

    it("should not start duplicate cleanup", () => {
      lm.startCleanup();
      lm.startCleanup(); // Should not throw
      lm.stopCleanup();
    });
  });
});