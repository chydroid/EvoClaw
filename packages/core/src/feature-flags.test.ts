import { describe, it, expect, beforeEach } from "vitest";
import { FeatureFlagStore } from "./feature-flags";
import type { FeatureFlag } from "./feature-flags";

function makeFlag(overrides?: Partial<FeatureFlag>): FeatureFlag {
  return {
    key: "test-flag",
    description: "A test feature flag",
    enabled: true,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("FeatureFlagStore", () => {
  let ffs: FeatureFlagStore;

  beforeEach(() => {
    ffs = new FeatureFlagStore({ environment: "test", auditEvaluations: true });
  });

  describe("register", () => {
    it("should register a flag", () => {
      ffs.register(makeFlag({ key: "feature-x" }));
      const flag = ffs.getFlag("feature-x");
      expect(flag).not.toBeNull();
      expect(flag!.key).toBe("feature-x");
      expect(flag!.enabled).toBe(true);
    });

    it("should batch register flags", () => {
      ffs.registerAll([
        makeFlag({ key: "a" }),
        makeFlag({ key: "b" }),
        makeFlag({ key: "c" }),
      ]);
      expect(ffs.listFlags()).toHaveLength(3);
    });

    it("should unregister a flag", () => {
      ffs.register(makeFlag({ key: "temp" }));
      expect(ffs.unregister("temp")).toBe(true);
      expect(ffs.getFlag("temp")).toBeNull();
    });
  });

  describe("evaluate", () => {
    it("should return default for unregistered flag", () => {
      expect(ffs.evaluate("nonexistent")).toBe(false);
    });

    it("should return custom default when configured", () => {
      const store = new FeatureFlagStore({ defaultEnabled: true });
      expect(store.evaluate("nonexistent")).toBe(true);
    });

    it("should return enabled state", () => {
      ffs.register(makeFlag({ key: "on", enabled: true }));
      ffs.register(makeFlag({ key: "off", enabled: false }));

      expect(ffs.isEnabled("on")).toBe(true);
      expect(ffs.isEnabled("off")).toBe(false);
    });

    it("should enable/disable flags", () => {
      ffs.register(makeFlag({ key: "toggle", enabled: false }));
      expect(ffs.isEnabled("toggle")).toBe(false);

      ffs.enable("toggle");
      expect(ffs.isEnabled("toggle")).toBe(true);

      ffs.disable("toggle");
      expect(ffs.isEnabled("toggle")).toBe(false);
    });
  });

  describe("rollout", () => {
    it("should be on for all at 100% rollout", () => {
      ffs.register(makeFlag({ key: "full", rolloutPercent: 100 }));
      expect(ffs.evaluate("full", { userId: "any" })).toBe(true);
    });

    it("should be off for all at 0% rollout", () => {
      ffs.register(makeFlag({ key: "none", rolloutPercent: 0 }));
      expect(ffs.evaluate("none", { userId: "any" })).toBe(false);
    });

    it("should be deterministic for same user", () => {
      ffs.register(makeFlag({ key: "50pct", rolloutPercent: 50 }));
      const r1 = ffs.evaluate("50pct", { userId: "user-abc" });
      const r2 = ffs.evaluate("50pct", { userId: "user-abc" });
      expect(r1).toBe(r2); // Same user = same result
    });

    it("should set rollout percentage", () => {
      ffs.register(makeFlag({ key: "roll", rolloutPercent: 20 }));
      ffs.setRollout("roll", 80);
      expect(ffs.getFlag("roll")!.rolloutPercent).toBe(80);
    });
  });

  describe("environments", () => {
    it("should work in matching environment", () => {
      ffs.register(makeFlag({ key: "staging-only", environments: ["test", "staging"] }));
      expect(ffs.isEnabled("staging-only")).toBe(true);
    });

    it("should be disabled in non-matching environment", () => {
      ffs.register(makeFlag({ key: "prod-only", environments: ["production"] }));
      expect(ffs.isEnabled("prod-only")).toBe(false);
    });
  });

  describe("allowlist/blocklist", () => {
    it("should allow listed users", () => {
      ffs.register(makeFlag({ key: "alpha", allowlist: ["vip-user"] }));
      expect(ffs.evaluate("alpha", { userId: "vip-user" })).toBe(true);
      expect(ffs.evaluate("alpha", { userId: "normal" })).toBe(false);
    });

    it("should block listed users", () => {
      ffs.register(makeFlag({ key: "beta", enabled: true, blocklist: ["tester"] }));
      expect(ffs.evaluate("beta", { userId: "tester" })).toBe(false);
      expect(ffs.evaluate("beta", { userId: "normal" })).toBe(true);
    });
  });

  describe("dependencies", () => {
    it("should be disabled when dependency is disabled", () => {
      ffs.register(makeFlag({ key: "base", enabled: true }));
      ffs.register(makeFlag({ key: "dep-a", dependsOn: ["base"], enabled: true }));
      ffs.register(makeFlag({ key: "dep-b", dependsOn: ["nonexistent"], enabled: true }));

      expect(ffs.isEnabled("dep-a")).toBe(true);
      expect(ffs.isEnabled("dep-b")).toBe(false);
    });
  });

  describe("expiry", () => {
    it("should disable expired flags", () => {
      ffs.register(makeFlag({
        key: "temp-flag",
        enabled: true,
        expiresAt: Date.now() - 1000, // Already expired
      }));
      expect(ffs.isEnabled("temp-flag")).toBe(false);
    });

    it("should keep non-expired flags", () => {
      ffs.register(makeFlag({
        key: "future",
        enabled: true,
        expiresAt: Date.now() + 86400000, // Tomorrow
      }));
      expect(ffs.isEnabled("future")).toBe(true);
    });
  });

  describe("evaluateAll", () => {
    it("should return all enabled flags", () => {
      ffs.registerAll([
        makeFlag({ key: "a", enabled: true }),
        makeFlag({ key: "b", enabled: false }),
        makeFlag({ key: "c", enabled: true }),
      ]);

      const enabled = ffs.evaluateAll();
      expect(enabled).toEqual(["a", "c"]);
    });
  });

  describe("getGloballyEnabled", () => {
    it("should return flags enabled for all", () => {
      ffs.registerAll([
        makeFlag({ key: "global", enabled: true }),
        makeFlag({ key: "partial", enabled: true, rolloutPercent: 50 }),
        makeFlag({ key: "restricted", enabled: true, allowlist: ["admin"] }),
        makeFlag({ key: "off", enabled: false }),
      ]);

      const global = ffs.getGloballyEnabled();
      expect(global).toContain("global");
      expect(global).not.toContain("partial");
      expect(global).not.toContain("restricted");
      expect(global).not.toContain("off");
    });
  });

  describe("audit", () => {
    it("should record evaluations when audit enabled", () => {
      ffs.register(makeFlag({ key: "audited", enabled: true }));
      ffs.evaluate("audited");

      const evals = ffs.getEvaluations();
      expect(evals.length).toBeGreaterThan(0);
      expect(evals[0].key).toBe("audited");
      expect(evals[0].result).toBe(true);
    });

    it("should not record when audit disabled", () => {
      const noAudit = new FeatureFlagStore({ auditEvaluations: false });
      noAudit.register(makeFlag({ key: "silent", enabled: true }));
      noAudit.evaluate("silent");
      expect(noAudit.getEvaluations()).toHaveLength(0);
    });

    it("should clear evaluations", () => {
      ffs.register(makeFlag({ key: "x", enabled: true }));
      ffs.evaluate("x");
      ffs.clearEvaluations();
      expect(ffs.getEvaluations()).toHaveLength(0);
    });
  });

  describe("stats", () => {
    it("should compute stats", () => {
      ffs.registerAll([
        makeFlag({ key: "a", enabled: true }),
        makeFlag({ key: "b", enabled: false }),
      ]);
      ffs.evaluate("a");
      ffs.evaluate("b");

      const stats = ffs.getStats();
      expect(stats.totalFlags).toBe(2);
      expect(stats.enabledFlags).toBe(1);
      expect(stats.evaluations).toBe(2);
    });
  });

  describe("owner filtering", () => {
    it("should list by owner", () => {
      ffs.registerAll([
        makeFlag({ key: "a", owner: "team-alpha" }),
        makeFlag({ key: "b", owner: "team-beta" }),
        makeFlag({ key: "c", owner: "team-alpha" }),
      ]);
      expect(ffs.listByOwner("team-alpha")).toHaveLength(2);
    });
  });
});