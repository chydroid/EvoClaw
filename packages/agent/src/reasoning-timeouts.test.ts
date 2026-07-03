import { describe, it, expect } from "vitest";
import {
  REASONING_STALE_TIMEOUT_FLOORS,
  getReasoningStaleTimeoutFloor,
  applyReasoningFloor,
  isKnownReasoningModel,
} from "./reasoning-timeouts";

describe("reasoning-timeouts", () => {
  describe("REASONING_STALE_TIMEOUT_FLOORS", () => {
    it("is a non-empty readonly table of [slug, floor] tuples", () => {
      expect(Array.isArray(REASONING_STALE_TIMEOUT_FLOORS)).toBe(true);
      expect(REASONING_STALE_TIMEOUT_FLOORS.length).toBeGreaterThan(0);
      for (const entry of REASONING_STALE_TIMEOUT_FLOORS) {
        expect(Array.isArray(entry)).toBe(true);
        expect(typeof entry[0]).toBe("string");
        expect(typeof entry[1]).toBe("number");
        expect(entry[1]).toBeGreaterThan(0);
      }
    });
  });

  describe("isKnownReasoningModel", () => {
    it("returns true for known reasoning models", () => {
      expect(isKnownReasoningModel("o1")).toBe(true);
      expect(isKnownReasoningModel("o3")).toBe(true);
      expect(isKnownReasoningModel("o3-mini")).toBe(true);
      expect(isKnownReasoningModel("deepseek-r1")).toBe(true);
      expect(isKnownReasoningModel("claude-opus-4")).toBe(true);
    });

    it("returns false for non-reasoning models", () => {
      expect(isKnownReasoningModel("gpt-4")).toBe(false);
      expect(isKnownReasoningModel("gpt-4o")).toBe(false);
      expect(isKnownReasoningModel("claude-3-haiku")).toBe(false);
    });

    it("returns false for null / undefined / empty input", () => {
      expect(isKnownReasoningModel(null)).toBe(false);
      expect(isKnownReasoningModel(undefined)).toBe(false);
      expect(isKnownReasoningModel("")).toBe(false);
      expect(isKnownReasoningModel("   ")).toBe(false);
    });
  });

  describe("getReasoningStaleTimeoutFloor", () => {
    it("returns the configured floor for known slugs", () => {
      expect(getReasoningStaleTimeoutFloor("o1")).toBe(600);
      expect(getReasoningStaleTimeoutFloor("o3-mini")).toBe(300);
      expect(getReasoningStaleTimeoutFloor("deepseek-r1")).toBe(600);
    });

    it("returns null for non-reasoning models", () => {
      expect(getReasoningStaleTimeoutFloor("gpt-4o")).toBeNull();
    });

    it("regression: strips aggregator prefixes before matching", () => {
      // The fix strips the `openrouter/` / `openai/` prefix before matching.
      // Without prefix-stripping, these would all return null.
      expect(getReasoningStaleTimeoutFloor("openai/o3-mini")).toBe(300);
      expect(getReasoningStaleTimeoutFloor("openrouter/o1")).toBe(600);
      expect(getReasoningStaleTimeoutFloor("anthropic/claude-opus-4")).toBe(240);
      expect(getReasoningStaleTimeoutFloor("deepseek/deepseek-r1")).toBe(600);
    });

    it("regression: anchoring prevents false positives on look-alike slugs", () => {
      // `olmo-1` must NOT match the `o1` slug — the slug must anchor at the
      // start of the model name (followed by end or a separator).
      expect(getReasoningStaleTimeoutFloor("olmo-1")).toBeNull();
      expect(getReasoningStaleTimeoutFloor("foo-o1")).toBeNull();
      // `o1` followed by a separator still matches.
      expect(getReasoningStaleTimeoutFloor("o1-2024")).toBe(600);
      expect(getReasoningStaleTimeoutFloor("o1_mini")).toBe(600);
    });

    it("longer slugs take priority over shorter prefixes", () => {
      // `o3-mini` (300) must win over `o3` (600) when both could match.
      expect(getReasoningStaleTimeoutFloor("o3-mini")).toBe(300);
      expect(getReasoningStaleTimeoutFloor("o3")).toBe(600);
    });

    it("is case-insensitive", () => {
      expect(getReasoningStaleTimeoutFloor("O1")).toBe(600);
      expect(getReasoningStaleTimeoutFloor("DeepSeek-R1")).toBe(600);
    });
  });

  describe("applyReasoningFloor", () => {
    it("returns the floor when the default is below it", () => {
      // o1 floor is 600s; a 90s default must be raised to 600.
      expect(applyReasoningFloor("o1", 90)).toBe(600);
      expect(applyReasoningFloor("openai/o3-mini", 90)).toBe(300);
    });

    it("regression: leaves the configured timeout unchanged for non-reasoning models", () => {
      expect(applyReasoningFloor("gpt-4", 5000)).toBe(5000);
      expect(applyReasoningFloor("gpt-4o", 90)).toBe(90);
    });

    it("does not lower a default that already exceeds the floor", () => {
      // o1 floor is 600; a 5000 default is above the floor → unchanged (≥ floor).
      expect(applyReasoningFloor("o1", 5000)).toBe(5000);
      expect(applyReasoningFloor("o1", 5000)).toBeGreaterThanOrEqual(600);
    });

    it("returns the default unchanged for null / empty model", () => {
      expect(applyReasoningFloor(null, 120)).toBe(120);
      expect(applyReasoningFloor("", 120)).toBe(120);
    });
  });
});
