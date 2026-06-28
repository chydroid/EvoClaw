/**
 * restart-sentinel.test.ts — 重启授权哨兵测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  RestartSentinel,
  getDefaultRestartSentinel,
  resetDefaultRestartSentinel,
  __testing,
} from "./restart-sentinel";

describe("restart-sentinel", () => {
  let sentinel: RestartSentinel;
  let now: number;

  beforeEach(() => {
    now = 1000;
    sentinel = new RestartSentinel({
      authGraceMs: 5000,
      cooldownMs: 30000,
      nowFn: () => now,
    });
  });

  describe("external policy", () => {
    it("defaults to disallow external", () => {
      expect(sentinel.isExternallyAllowed()).toBe(false);
    });

    it("setExternalPolicy(true) enables external", () => {
      sentinel.setExternalPolicy(true);
      expect(sentinel.isExternallyAllowed()).toBe(true);
    });

    it("setExternalPolicy(false) disables external", () => {
      sentinel.setExternalPolicy(true);
      sentinel.setExternalPolicy(false);
      expect(sentinel.isExternallyAllowed()).toBe(false);
    });
  });

  describe("authorization", () => {
    it("authorize() increments count and sets expiry", () => {
      sentinel.authorize();
      const state = sentinel.getState();
      expect(state.authorizedCount).toBe(1);
      expect(state.authorizedUntil).toBe(now + 5000);
    });

    it("authorize(delay) sets expiry to now + delay + grace", () => {
      sentinel.authorize(2000);
      const state = sentinel.getState();
      expect(state.authorizedCount).toBe(1);
      expect(state.authorizedUntil).toBe(now + 2000 + 5000);
    });

    it("authorize(0) sets expiry to now + grace", () => {
      sentinel.authorize(0);
      expect(sentinel.getState().authorizedUntil).toBe(now + 5000);
    });

    it("multiple authorize() calls accumulate count", () => {
      sentinel.authorize();
      sentinel.authorize();
      sentinel.authorize();
      expect(sentinel.getState().authorizedCount).toBe(3);
    });

    it("multiple authorize() extend expiry to latest", () => {
      sentinel.authorize(1000);
      sentinel.authorize(3000);
      expect(sentinel.getState().authorizedUntil).toBe(now + 3000 + 5000);
    });
  });

  describe("consumeAuthorization", () => {
    it("returns true and decrements count when authorized", () => {
      sentinel.authorize();
      expect(sentinel.consumeAuthorization()).toBe(true);
      expect(sentinel.getState().authorizedCount).toBe(0);
    });

    it("returns false when no authorization", () => {
      expect(sentinel.consumeAuthorization()).toBe(false);
    });

    it("clears expiry when count drops to 0", () => {
      sentinel.authorize();
      sentinel.consumeAuthorization();
      expect(sentinel.getState().authorizedUntil).toBe(0);
    });

    it("preserves expiry when count > 0 after consume", () => {
      sentinel.authorize();
      sentinel.authorize();
      sentinel.consumeAuthorization();
      expect(sentinel.getState().authorizedCount).toBe(1);
      expect(sentinel.getState().authorizedUntil).toBe(now + 5000);
    });

    it("returns false and resets when authorization expired", () => {
      sentinel.authorize();
      now += 10000; // 过期
      expect(sentinel.consumeAuthorization()).toBe(false);
      expect(sentinel.getState().authorizedCount).toBe(0);
      expect(sentinel.getState().authorizedUntil).toBe(0);
    });
  });

  describe("hasPendingAuthorization", () => {
    it("returns false initially", () => {
      expect(sentinel.hasPendingAuthorization()).toBe(false);
    });

    it("returns true after authorize()", () => {
      sentinel.authorize();
      expect(sentinel.hasPendingAuthorization()).toBe(true);
    });

    it("returns false after consume()", () => {
      sentinel.authorize();
      sentinel.consumeAuthorization();
      expect(sentinel.hasPendingAuthorization()).toBe(false);
    });

    it("returns false after expiry", () => {
      sentinel.authorize();
      now += 10000;
      expect(sentinel.hasPendingAuthorization()).toBe(false);
    });
  });

  describe("canExternalSignalTrigger", () => {
    it("returns false when external disallowed", () => {
      sentinel.authorize();
      expect(sentinel.canExternalSignalTrigger()).toBe(false);
    });

    it("returns false when no authorization", () => {
      sentinel.setExternalPolicy(true);
      expect(sentinel.canExternalSignalTrigger()).toBe(false);
    });

    it("returns true when external allowed + authorized", () => {
      sentinel.setExternalPolicy(true);
      sentinel.authorize();
      expect(sentinel.canExternalSignalTrigger()).toBe(true);
    });
  });

  describe("cycle management", () => {
    it("enterCycle returns new token", () => {
      const token1 = sentinel.enterCycle("reason1");
      const token2 = sentinel.enterCycle("reason2");
      expect(token2).toBeGreaterThan(token1);
    });

    it("hasUnconsumedSignal returns true after enterCycle", () => {
      sentinel.enterCycle("test");
      expect(sentinel.hasUnconsumedSignal()).toBe(true);
    });

    it("hasUnconsumedSignal returns false after markConsumed", () => {
      sentinel.enterCycle("test");
      sentinel.markConsumed();
      expect(sentinel.hasUnconsumedSignal()).toBe(false);
    });

    it("peekEmittedReason returns reason when unconsumed", () => {
      sentinel.enterCycle("my-reason");
      expect(sentinel.peekEmittedReason()).toBe("my-reason");
    });

    it("peekEmittedReason returns undefined when consumed", () => {
      sentinel.enterCycle("my-reason");
      sentinel.markConsumed();
      expect(sentinel.peekEmittedReason()).toBeUndefined();
    });

    it("markConsumed without enterCycle is no-op", () => {
      expect(() => sentinel.markConsumed()).not.toThrow();
      expect(sentinel.hasUnconsumedSignal()).toBe(false);
    });

    it("rollbackEmission reverts cycle to consumed", () => {
      sentinel.enterCycle("rollback-test");
      sentinel.rollbackEmission();
      expect(sentinel.hasUnconsumedSignal()).toBe(false);
    });

    it("rollbackEmission consumes one authorization", () => {
      sentinel.authorize();
      sentinel.enterCycle("rollback-test");
      sentinel.rollbackEmission();
      // 授权计数应减少 1
      expect(sentinel.getState().authorizedCount).toBe(0);
    });
  });

  describe("cooldown", () => {
    it("returns 0 initially", () => {
      expect(sentinel.remainingCooldownMs()).toBe(0);
    });

    it("returns full cooldown after markEmitted", () => {
      sentinel.markEmitted();
      expect(sentinel.remainingCooldownMs()).toBe(30000);
    });

    it("decreases as time advances", () => {
      sentinel.markEmitted();
      now += 10000;
      expect(sentinel.remainingCooldownMs()).toBe(20000);
    });

    it("returns 0 after cooldown expires", () => {
      sentinel.markEmitted();
      now += 30000;
      expect(sentinel.remainingCooldownMs()).toBe(0);
    });

    it("returns 0 when cooldownMs is 0", () => {
      const s = new RestartSentinel({ cooldownMs: 0, nowFn: () => now });
      s.enterCycle();
      expect(s.remainingCooldownMs()).toBe(0);
    });
  });

  describe("getState", () => {
    it("returns full state snapshot", () => {
      sentinel.setExternalPolicy(true);
      sentinel.authorize(1000);
      sentinel.enterCycle("snapshot");
      const state = sentinel.getState();
      expect(state).toMatchObject({
        authorizedCount: 1,
        externalAllowed: true,
        cycleToken: 1,
        consumedToken: 0,
        emittedReason: "snapshot",
      });
      expect(typeof state.authorizedUntil).toBe("number");
      expect(typeof state.lastEmitAt).toBe("number");
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      sentinel.setExternalPolicy(true);
      sentinel.authorize();
      sentinel.enterCycle("test");
      sentinel.markEmitted();
      sentinel.reset();
      const state = sentinel.getState();
      expect(state.authorizedCount).toBe(0);
      expect(state.authorizedUntil).toBe(0);
      expect(state.externalAllowed).toBe(false);
      expect(state.cycleToken).toBe(0);
      expect(state.consumedToken).toBe(0);
      expect(state.lastEmitAt).toBe(-1);
      expect(state.emittedReason).toBeUndefined();
    });
  });

  describe("markEmitted", () => {
    it("sets lastEmitAt to now", () => {
      sentinel.markEmitted();
      expect(sentinel.getState().lastEmitAt).toBe(now);
    });

    it("triggers cooldown", () => {
      sentinel.markEmitted();
      expect(sentinel.remainingCooldownMs()).toBe(30000);
    });

    it("does not create unconsumed signal", () => {
      sentinel.markEmitted();
      expect(sentinel.hasUnconsumedSignal()).toBe(false);
    });
  });

  describe("default singleton", () => {
    it("getDefaultRestartSentinel returns same instance", () => {
      resetDefaultRestartSentinel();
      const s1 = getDefaultRestartSentinel();
      const s2 = getDefaultRestartSentinel();
      expect(s1).toBe(s2);
    });

    it("resetDefaultRestartSentinel creates new instance", () => {
      const s1 = getDefaultRestartSentinel();
      resetDefaultRestartSentinel();
      const s2 = getDefaultRestartSentinel();
      expect(s1).not.toBe(s2);
    });

    it("default sentinel uses real Date.now", () => {
      resetDefaultRestartSentinel();
      const s = getDefaultRestartSentinel();
      s.authorize();
      const state = s.getState();
      // authorizedUntil 应该接近 now + grace
      const realNow = Date.now();
      expect(state.authorizedUntil).toBeGreaterThan(realNow);
      expect(state.authorizedUntil).toBeLessThan(realNow + 10000);
    });
  });

  describe("constants", () => {
    it("exports DEFAULT_AUTH_GRACE_MS", () => {
      expect(__testing.DEFAULT_AUTH_GRACE_MS).toBe(5000);
    });

    it("exports DEFAULT_COOLDOWN_MS", () => {
      expect(__testing.DEFAULT_COOLDOWN_MS).toBe(30000);
    });
  });
});
