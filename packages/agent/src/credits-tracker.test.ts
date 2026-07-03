import { describe, it, expect, beforeEach } from "vitest";
import {
  parseCreditsHeaders,
  evaluateCreditsNotices,
  createLatch,
  hasData,
  ageSeconds,
  isDepleted,
  usedFraction,
  isFreeTierModel,
  creditsStateFromAccount,
  makeNotice,
  CREDITS_NOTICE_KIND,
  CREDITS_RESTORED_TTL_MS,
  CREDITS_USAGE_BANDS,
  CREDITS_USAGE_KEY,
  type CreditsState,
  type CreditsLatch,
} from "./credits-tracker";

function makeState(overrides: Partial<CreditsState> = {}): CreditsState {
  return {
    version: 1,
    remainingMicros: 5_000_000,
    remainingUsd: "5.00",
    subscriptionMicros: 5_000_000,
    subscriptionUsd: "5.00",
    subscriptionLimitMicros: null,
    subscriptionLimitUsd: null,
    rolloverMicros: 0,
    purchasedMicros: 0,
    purchasedUsd: "0.00",
    toolPoolMicros: 0,
    toolPoolGatedOff: false,
    denominatorKind: "none",
    paidAccess: true,
    disabledReason: null,
    asOfMs: 1000,
    capturedAt: Date.now(),
    fromHeader: false,
    ...overrides,
  };
}

describe("credits-tracker", () => {
  describe("constants", () => {
    it("exposes the documented policy constants", () => {
      expect(CREDITS_NOTICE_KIND).toBe("sticky");
      expect(CREDITS_RESTORED_TTL_MS).toBe(8000);
      expect(CREDITS_USAGE_KEY).toBe("credits.usage");
      expect(Array.isArray(CREDITS_USAGE_BANDS)).toBe(true);
      expect(CREDITS_USAGE_BANDS.length).toBeGreaterThan(0);
    });
  });

  describe("parseCreditsHeaders", () => {
    it("returns null when no version header is present", () => {
      expect(parseCreditsHeaders({})).toBeNull();
      expect(parseCreditsHeaders({ "x-some-other": "1" })).toBeNull();
    });

    it("parses a valid header set into a CreditsState", () => {
      const state = parseCreditsHeaders({
        "x-nous-credits-version": "1",
        "x-nous-credits-remaining-micros": "5000000",
        "x-nous-credits-remaining-usd": "5.00",
        "x-nous-credits-subscription-micros": "5000000",
        "x-nous-credits-subscription-usd": "5.00",
        "x-nous-credits-rollover-micros": "0",
        "x-nous-credits-purchased-micros": "0",
        "x-nous-credits-purchased-usd": "0.00",
        "x-nous-credits-as-of-ms": "1000",
      });
      expect(state).not.toBeNull();
      expect(state!.version).toBe(1);
      expect(state!.remainingMicros).toBe(5_000_000);
      expect(state!.remainingUsd).toBe("5.00");
      expect(state!.paidAccess).toBe(true); // fail-open default
      expect(state!.fromHeader).toBe(true);
    });

    it("returns null when version != 1", () => {
      expect(
        parseCreditsHeaders({ "x-nous-credits-version": "2" }),
      ).toBeNull();
    });

    it("returns null when a micros field is a float-shaped string", () => {
      expect(
        parseCreditsHeaders({
          "x-nous-credits-version": "1",
          "x-nous-credits-remaining-micros": "5.5",
          "x-nous-credits-remaining-usd": "5.00",
          "x-nous-credits-subscription-micros": "0",
          "x-nous-credits-subscription-usd": "0.00",
          "x-nous-credits-rollover-micros": "0",
          "x-nous-credits-purchased-micros": "0",
          "x-nous-credits-purchased-usd": "0.00",
          "x-nous-credits-as-of-ms": "1000",
        }),
      ).toBeNull();
    });

    it("returns null when a USD field does not match the format", () => {
      expect(
        parseCreditsHeaders({
          "x-nous-credits-version": "1",
          "x-nous-credits-remaining-micros": "0",
          "x-nous-credits-remaining-usd": "5.5",
          "x-nous-credits-subscription-micros": "0",
          "x-nous-credits-subscription-usd": "0.00",
          "x-nous-credits-rollover-micros": "0",
          "x-nous-credits-purchased-micros": "0",
          "x-nous-credits-purchased-usd": "0.00",
          "x-nous-credits-as-of-ms": "1000",
        }),
      ).toBeNull();
    });
  });

  describe("isFreeTierModel", () => {
    it("returns true for the :free suffix", () => {
      expect(isFreeTierModel("gpt-4:free")).toBe(true);
      expect(isFreeTierModel("llama-3:free")).toBe(true);
    });

    it("returns false for paid models and empty input", () => {
      expect(isFreeTierModel("gpt-4o")).toBe(false);
      expect(isFreeTierModel("claude-opus-4")).toBe(false);
      expect(isFreeTierModel("")).toBe(false);
    });
  });

  describe("createLatch", () => {
    it("returns a fresh latch with empty active set and null usageBand", () => {
      const latch = createLatch();
      expect(latch.active.size).toBe(0);
      expect(latch.seenBelow90).toBe(false);
      expect(latch.usageBand).toBeNull();
    });
  });

  describe("hasData / ageSeconds / isDepleted", () => {
    it("hasData keys off capturedAt > 0", () => {
      expect(hasData(makeState({ capturedAt: 1000 }))).toBe(true);
      expect(hasData(makeState({ capturedAt: 0 }))).toBe(false);
    });

    it("isDepleted keys off paidAccess === false (NOT remainingMicros === 0)", () => {
      // Zero balance but paid access still live → NOT depleted.
      expect(isDepleted(makeState({ paidAccess: true, remainingMicros: 0 }))).toBe(false);
      // Negative/missing balance but paidAccess false → depleted.
      expect(isDepleted(makeState({ paidAccess: false }))).toBe(true);
    });

    it("ageSeconds reports the age of the captured state", () => {
      const capturedAt = Date.now() - 5_000;
      const state = makeState({ capturedAt });
      const age = ageSeconds(state);
      expect(age).toBeGreaterThanOrEqual(4);
      expect(age).toBeLessThan(60);
    });

    it("ageSeconds is Infinity when there is no data", () => {
      expect(ageSeconds(makeState({ capturedAt: 0 }))).toBe(Number.POSITIVE_INFINITY);
    });
  });

  describe("usedFraction", () => {
    it("returns null when there is no subscription limit", () => {
      expect(usedFraction(makeState({ subscriptionLimitMicros: null }))).toBeNull();
      expect(usedFraction(makeState({ subscriptionLimitMicros: 0 }))).toBeNull();
    });

    it("computes the consumed fraction of the subscription cap", () => {
      // limit 1M, subscription 500k → used 500k → 0.5
      const state = makeState({
        subscriptionLimitMicros: 1_000_000,
        subscriptionMicros: 500_000,
      });
      expect(usedFraction(state)).toBeCloseTo(0.5, 5);
    });

    it("clamps to [0, 1]", () => {
      // subscription > limit → fraction would be negative → clamped to 0.
      expect(
        usedFraction(makeState({ subscriptionLimitMicros: 1_000_000, subscriptionMicros: 1_500_000 })),
      ).toBe(0);
      // subscription negative (debt) → fraction > 1 → clamped to 1.
      expect(
        usedFraction(makeState({ subscriptionLimitMicros: 1_000_000, subscriptionMicros: -500_000 })),
      ).toBe(1);
    });
  });

  describe("creditsStateFromAccount", () => {
    it("maps account dollars to a header-shaped state", () => {
      const state = creditsStateFromAccount({
        totalUsableCredits: 5,
        subscriptionCreditsRemaining: 4,
        monthlyCredits: 10,
        paidServiceAccess: true,
      });
      expect(state).not.toBeNull();
      expect(state!.remainingMicros).toBe(5_000_000);
      expect(state!.subscriptionLimitMicros).toBe(10_000_000);
      expect(state!.denominatorKind).toBe("subscription_cap");
      expect(state!.paidAccess).toBe(true);
    });

    it("defaults paidAccess to true when absent", () => {
      const state = creditsStateFromAccount({});
      expect(state).not.toBeNull();
      expect(state!.paidAccess).toBe(true);
    });
  });

  describe("makeNotice", () => {
    it("fills defaults for level and kind", () => {
      const n = makeNotice({ text: "hi" });
      expect(n.text).toBe("hi");
      expect(n.level).toBe("info");
      expect(n.kind).toBe("sticky");
    });

    it("honours provided overrides", () => {
      const n = makeNotice({ text: "warn", level: "warn", kind: "ttl", ttlMs: 1000 });
      expect(n.level).toBe("warn");
      expect(n.kind).toBe("ttl");
      expect(n.ttlMs).toBe(1000);
    });
  });

  describe("evaluateCreditsNotices", () => {
    let latch: CreditsLatch;

    beforeEach(() => {
      latch = createLatch();
    });

    it("emits a depleted notice when paidAccess is false", () => {
      const state = makeState({ paidAccess: false });
      const delta = evaluateCreditsNotices(state, latch, { modelIsFree: false });
      expect(delta.toShow.some((n) => n.id === "credits.depleted")).toBe(true);
      expect(latch.active.has("credits.depleted")).toBe(true);
    });

    it("suppresses the depleted notice when the active model is free", () => {
      const state = makeState({ paidAccess: false });
      const delta = evaluateCreditsNotices(state, latch, { modelIsFree: true });
      expect(delta.toShow.some((n) => n.id === "credits.depleted")).toBe(false);
    });

    it("on recovery (paidAccess flips true), clears depleted and emits restored", () => {
      // Seed the latch with an active depleted notice.
      evaluateCreditsNotices(makeState({ paidAccess: false }), latch, { modelIsFree: false });
      expect(latch.active.has("credits.depleted")).toBe(true);

      // Recover.
      const delta = evaluateCreditsNotices(makeState({ paidAccess: true }), latch, {
        modelIsFree: false,
      });
      expect(delta.toClear).toContain("credits.depleted");
      expect(delta.toShow.some((n) => n.id === "credits.restored")).toBe(true);
      expect(delta.toShow.some((n) => n.level === "success")).toBe(true);
    });

    it("does not emit a restored notice when clearing due to switching to a free model", () => {
      // Seed depleted.
      evaluateCreditsNotices(makeState({ paidAccess: false }), latch, { modelIsFree: false });
      // Still depleted, but now modelIsFree → clear without "restored".
      const delta = evaluateCreditsNotices(makeState({ paidAccess: false }), latch, {
        modelIsFree: true,
      });
      expect(delta.toClear).toContain("credits.depleted");
      expect(delta.toShow.some((n) => n.id === "credits.restored")).toBe(false);
    });
  });
});
