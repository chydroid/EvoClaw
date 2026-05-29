import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ModelFailoverManager } from "./model-failover";
import type { FailoverProvider } from "./model-failover";

function makeProvider(overrides: Partial<FailoverProvider> = {}): FailoverProvider {
  return {
    id: "provider-1",
    name: "Test Provider",
    enabled: true,
    order: 1,
    healthCheck: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("ModelFailoverManager", () => {
  let fm: ModelFailoverManager;

  beforeEach(() => {
    fm = new ModelFailoverManager({
      failureThreshold: 3,
      resetTimeoutMs: 60000,
    });
  });

  afterEach(() => {
    fm.dispose();
  });

  // ── Registration ─────────────────────────────────

  it("should register a provider with healthy state and default health score", () => {
    const p = makeProvider();
    fm.registerProvider(p);
    const health = fm.getHealth("provider-1");
    expect(health).toBeDefined();
    expect(health!.circuitState).toBe("closed");
    expect(health!.failureCount).toBe(0);
    expect(health!.active).toBe(true);
    expect(health!.healthScore).toBe(100);
    expect(health!.halfOpenProbeCount).toBe(0);
    expect(health!.currentKeyIndex).toBe(0);
    expect(health!.fallbackChain).toEqual([]);
    expect(health!.dynamicPriority).toBe(1);
  });

  it("should register disabled providers as inactive", () => {
    const p = makeProvider({ enabled: false });
    fm.registerProvider(p);
    const health = fm.getHealth("provider-1");
    expect(health!.active).toBe(false);
  });

  it("should register provider with fallback chain", () => {
    const p = makeProvider({ fallbacks: ["fallback-a", "fallback-b"] });
    fm.registerProvider(p);
    const health = fm.getHealth("provider-1");
    expect(health!.fallbackChain).toEqual(["fallback-a", "fallback-b"]);
  });

  it("should register provider with api keys", () => {
    const p = makeProvider({ apiKeys: ["key1", "key2", "key3"] });
    fm.registerProvider(p);
    const health = fm.getHealth("provider-1");
    expect(health!.currentKeyIndex).toBe(0);
  });

  it("should unregister a provider", () => {
    fm.registerProvider(makeProvider());
    fm.unregisterProvider("provider-1");
    expect(fm.getHealth("provider-1")).toBeUndefined();
  });

  // ── Success / Failure ────────────────────────────

  it("should record success and reset failure count", () => {
    fm.registerProvider(makeProvider());
    fm.recordFailure("provider-1", "error 1");
    fm.recordFailure("provider-1", "error 2");
    fm.recordSuccess("provider-1", 100);

    const health = fm.getHealth("provider-1")!;
    expect(health.failureCount).toBe(0);
    expect(health.circuitState).toBe("closed");
    expect(health.totalRequests).toBe(3);
  });

  it("should track latency via exponential moving average", () => {
    fm.registerProvider(makeProvider());
    fm.recordSuccess("provider-1", 200);
    fm.recordSuccess("provider-1", 100);

    const health = fm.getHealth("provider-1")!;
    expect(health.avgLatencyMs).toBe(170);
  });

  it("should open circuit after failure threshold", () => {
    fm.registerProvider(makeProvider());
    fm.recordFailure("provider-1", "e1");
    fm.recordFailure("provider-1", "e2");
    fm.recordFailure("provider-1", "e3");

    const health = fm.getHealth("provider-1")!;
    expect(health.circuitState).toBe("open");
    expect(health.failureCount).toBe(3);
  });

  it("should not re-open an already open circuit", () => {
    fm.registerProvider(makeProvider());
    fm.recordFailure("provider-1", "e1");
    fm.recordFailure("provider-1", "e2");
    fm.recordFailure("provider-1", "e3");
    fm.recordFailure("provider-1", "e4");

    expect(fm.getHealth("provider-1")!.circuitState).toBe("open");
  });

  it("should track last error", () => {
    fm.registerProvider(makeProvider());
    fm.recordFailure("provider-1", "timeout");
    expect(fm.getHealth("provider-1")!.lastError).toBe("timeout");
  });

  it("should be a no-op for unknown providers", () => {
    fm.recordSuccess("unknown", 100);
    fm.recordFailure("unknown", "err");
    expect(fm.getHealth("unknown")).toBeUndefined();
  });

  it("should recalculate health score on success", () => {
    fm.registerProvider(makeProvider());
    fm.recordSuccess("provider-1", 100);
    expect(fm.getHealthScore("provider-1")).toBeGreaterThan(0);
    expect(fm.getHealthScore("provider-1")).toBeLessThanOrEqual(100);
  });

  it("should decrease health score on failures", () => {
    fm.registerProvider(makeProvider());
    fm.recordSuccess("provider-1", 100);
    const scoreBefore = fm.getHealthScore("provider-1");
    fm.recordFailure("provider-1", "error");
    const scoreAfter = fm.getHealthScore("provider-1");
    expect(scoreAfter).toBeLessThan(scoreBefore);
  });

  it("should open circuit on failure in half-open state", () => {
    fm.registerProvider(makeProvider());
    const health = fm.getHealth("provider-1")!;
    health.circuitState = "half-open";
    health.halfOpenProbeCount = 0;
    fm.recordFailure("provider-1", "half-open failure");
    expect(health.circuitState).toBe("open");
  });

  // ── canUse ────────────────────────────────────────

  it("should return true for healthy closed circuit", () => {
    fm.registerProvider(makeProvider());
    expect(fm.canUse("provider-1")).toBe(true);
  });

  it("should return false for open circuit", () => {
    const fm2 = new ModelFailoverManager({ failureThreshold: 1, resetTimeoutMs: 60000 });
    fm2.registerProvider(makeProvider());
    fm2.recordFailure("provider-1", "e");
    expect(fm2.canUse("provider-1")).toBe(false);
    fm2.dispose();
  });

  it("should return true for half-open within probe limit", () => {
    fm.registerProvider(makeProvider());
    const health = fm.getHealth("provider-1")!;
    health.circuitState = "half-open";
    expect(fm.canUse("provider-1")).toBe(true);
  });

  it("should return false for half-open when probe limit exceeded", () => {
    const fm2 = new ModelFailoverManager({
      failureThreshold: 3,
      resetTimeoutMs: 60000,
      halfOpenProbeLimit: 1,
    });
    fm2.registerProvider(makeProvider());
    const health = fm2.getHealth("provider-1")!;
    health.circuitState = "half-open";
    expect(fm2.canUse("provider-1")).toBe(true);
    expect(fm2.canUse("provider-1")).toBe(false);
    fm2.dispose();
  });

  it("should return false for inactive provider", () => {
    fm.registerProvider(makeProvider());
    const health = fm.getHealth("provider-1")!;
    health.active = false;
    expect(fm.canUse("provider-1")).toBe(false);
  });

  it("should return false for unknown provider", () => {
    expect(fm.canUse("unknown")).toBe(false);
  });

  // ── Circuit Breaker Reset ─────────────────────────

  it("should reset a circuit manually", () => {
    fm.registerProvider(makeProvider());
    fm.recordFailure("provider-1", "e1");
    fm.recordFailure("provider-1", "e2");
    fm.recordFailure("provider-1", "e3");
    expect(fm.getHealth("provider-1")!.circuitState).toBe("open");

    fm.resetCircuit("provider-1");
    expect(fm.getHealth("provider-1")!.circuitState).toBe("closed");
    expect(fm.getHealth("provider-1")!.failureCount).toBe(0);
    expect(fm.getHealth("provider-1")!.halfOpenProbeCount).toBe(0);
  });

  it("should reset all circuits", () => {
    fm.registerProvider(makeProvider({ id: "a" }));
    fm.registerProvider(makeProvider({ id: "b" }));
    fm.recordFailure("a", "e1");
    fm.recordFailure("a", "e2");
    fm.recordFailure("a", "e3");
    fm.recordFailure("b", "e1");
    fm.recordFailure("b", "e2");
    fm.recordFailure("b", "e3");

    fm.resetAllCircuits();
    expect(fm.getHealth("a")!.circuitState).toBe("closed");
    expect(fm.getHealth("b")!.circuitState).toBe("closed");
  });

  // ── Fallback Chain ────────────────────────────────

  it("should resolve fallback chain with healthy providers", () => {
    fm.registerProvider(makeProvider({ id: "primary", fallbacks: ["fb-a", "fb-b"] }));
    fm.registerProvider(makeProvider({ id: "fb-a" }));
    fm.registerProvider(makeProvider({ id: "fb-b" }));

    const chain = fm.resolveFallbackChain("primary");
    expect(chain).toEqual(["primary", "fb-a", "fb-b"]);
  });

  it("should skip open-circuit providers in fallback chain", () => {
    fm.registerProvider(makeProvider({ id: "primary", fallbacks: ["fb-a", "fb-b"] }));
    fm.registerProvider(makeProvider({ id: "fb-a" }));
    fm.registerProvider(makeProvider({ id: "fb-b" }));

    const fbAHealth = fm.getHealth("fb-a")!;
    fbAHealth.circuitState = "open";

    const chain = fm.resolveFallbackChain("primary");
    expect(chain).toEqual(["primary", "fb-b"]);
  });

  it("should return only primary if all fallbacks are down", () => {
    fm.registerProvider(makeProvider({ id: "primary", fallbacks: ["fb-a"] }));
    fm.registerProvider(makeProvider({ id: "fb-a" }));

    const fbAHealth = fm.getHealth("fb-a")!;
    fbAHealth.circuitState = "open";

    const chain = fm.resolveFallbackChain("primary");
    expect(chain).toEqual(["primary"]);
  });

  it("should set fallback chain dynamically", () => {
    fm.registerProvider(makeProvider({ id: "primary" }));
    fm.setFallbackChain("primary", ["new-fb-1", "new-fb-2"]);
    expect(fm.getHealth("primary")!.fallbackChain).toEqual(["new-fb-1", "new-fb-2"]);
  });

  it("should execute with fallback when primary succeeds", async () => {
    fm.registerProvider(makeProvider({ id: "primary", fallbacks: ["fb-a"] }));
    fm.registerProvider(makeProvider({ id: "fb-a" }));

    const result = await fm.executeWithFallback("primary", async (pid) => {
      return `result-from-${pid}`;
    });
    expect(result).toBe("result-from-primary");
  });

  it("should fall back to next provider when primary fails", async () => {
    fm.registerProvider(makeProvider({ id: "primary", fallbacks: ["fb-a"] }));
    fm.registerProvider(makeProvider({ id: "fb-a" }));

    let callCount = 0;
    const result = await fm.executeWithFallback("primary", async (pid) => {
      callCount++;
      if (pid === "primary") throw new Error("primary down");
      return `result-from-${pid}`;
    });
    expect(result).toBe("result-from-fb-a");
    expect(callCount).toBe(2);
  });

  it("should throw when all providers in chain fail", async () => {
    fm.registerProvider(makeProvider({ id: "primary", fallbacks: ["fb-a"] }));
    fm.registerProvider(makeProvider({ id: "fb-a" }));

    await expect(
      fm.executeWithFallback("primary", async () => {
        throw new Error("all down");
      })
    ).rejects.toThrow("all down");
  });

  it("should attempt auth rotation on rate limit error", async () => {
    fm.registerProvider(makeProvider({
      id: "primary",
      apiKeys: ["key1", "key2"],
      fallbacks: [],
    }));

    let callCount = 0;
    const result = await fm.executeWithFallback("primary", async (pid, apiKey) => {
      callCount++;
      if (apiKey === "key1") throw new Error("429 rate limit exceeded");
      return `success-with-${apiKey}`;
    });
    expect(result).toBe("success-with-key2");
    expect(callCount).toBe(2);
  });

  // ── Auth Rotation ─────────────────────────────────

  it("should get current API key", () => {
    fm.registerProvider(makeProvider({ id: "p1", apiKeys: ["key-a", "key-b"] }));
    expect(fm.getCurrentApiKey("p1")).toBe("key-a");
  });

  it("should return undefined when no API keys", () => {
    fm.registerProvider(makeProvider({ id: "p1" }));
    expect(fm.getCurrentApiKey("p1")).toBeUndefined();
  });

  it("should rotate API key", () => {
    fm.registerProvider(makeProvider({ id: "p1", apiKeys: ["key-a", "key-b", "key-c"] }));
    expect(fm.getCurrentApiKey("p1")).toBe("key-a");

    const rotated = fm.rotateApiKey("p1");
    expect(rotated).toBe(true);
    expect(fm.getCurrentApiKey("p1")).toBe("key-b");

    fm.rotateApiKey("p1");
    expect(fm.getCurrentApiKey("p1")).toBe("key-c");

    fm.rotateApiKey("p1");
    expect(fm.getCurrentApiKey("p1")).toBe("key-a");
  });

  it("should not rotate when only one key", () => {
    fm.registerProvider(makeProvider({ id: "p1", apiKeys: ["key-a"] }));
    expect(fm.rotateApiKey("p1")).toBe(false);
  });

  it("should not rotate when no keys", () => {
    fm.registerProvider(makeProvider({ id: "p1" }));
    expect(fm.rotateApiKey("p1")).toBe(false);
  });

  it("should reset API key index", () => {
    fm.registerProvider(makeProvider({ id: "p1", apiKeys: ["key-a", "key-b"] }));
    fm.rotateApiKey("p1");
    expect(fm.getCurrentApiKey("p1")).toBe("key-b");

    fm.resetApiKeyIndex("p1");
    expect(fm.getCurrentApiKey("p1")).toBe("key-a");
  });

  // ── Health Scoring ─────────────────────────────────

  it("should start with health score of 100", () => {
    fm.registerProvider(makeProvider());
    expect(fm.getHealthScore("provider-1")).toBe(100);
  });

  it("should return 0 for unknown provider health score", () => {
    expect(fm.getHealthScore("unknown")).toBe(0);
  });

  it("should decrease health score with failures", () => {
    fm.registerProvider(makeProvider());
    fm.recordSuccess("provider-1", 100);
    const initial = fm.getHealthScore("provider-1");

    for (let i = 0; i < 5; i++) {
      fm.recordFailure("provider-1", `error-${i}`);
    }

    expect(fm.getHealthScore("provider-1")).toBeLessThan(initial);
  });

  it("should increase health score with successes after failures", () => {
    fm.registerProvider(makeProvider());

    for (let i = 0; i < 5; i++) {
      fm.recordFailure("provider-1", `error-${i}`);
    }
    const afterFailures = fm.getHealthScore("provider-1");

    for (let i = 0; i < 10; i++) {
      fm.recordSuccess("provider-1", 50);
    }
    const afterRecovery = fm.getHealthScore("provider-1");

    expect(afterRecovery).toBeGreaterThan(afterFailures);
  });

  it("should factor latency into health score", () => {
    fm.registerProvider(makeProvider({ id: "fast" }));
    fm.registerProvider(makeProvider({ id: "slow" }));

    for (let i = 0; i < 10; i++) {
      fm.recordSuccess("fast", 10);
      fm.recordSuccess("slow", 5000);
    }

    expect(fm.getHealthScore("fast")).toBeGreaterThan(fm.getHealthScore("slow"));
  });

  // ── Provider Priority ──────────────────────────────

  it("should sort healthy providers before unhealthy", () => {
    fm.registerProvider(makeProvider({ id: "a", order: 1 }));
    fm.registerProvider(makeProvider({ id: "b", order: 2 }));
    fm.getHealth("b")!.circuitState = "open";

    const sorted = fm.getPrioritizedProviders();
    expect(sorted[0].id).toBe("a");
    expect(sorted[1].id).toBe("b");
  });

  it("should sort by order when both healthy", () => {
    fm.registerProvider(makeProvider({ id: "b", order: 2 }));
    fm.registerProvider(makeProvider({ id: "a", order: 1 }));

    const sorted = fm.getPrioritizedProviders();
    expect(sorted[0].id).toBe("a");
    expect(sorted[1].id).toBe("b");
  });

  it("should sort by weight then latency", () => {
    fm.registerProvider(makeProvider({ id: "fast", order: 1, weight: 1 }));
    fm.registerProvider(makeProvider({ id: "slow", order: 1, weight: 5 }));
    fm.recordSuccess("fast", 50);
    fm.recordSuccess("slow", 500);

    const sorted = fm.getPrioritizedProviders();
    expect(sorted[0].id).toBe("fast");
    expect(sorted[1].id).toBe("slow");
  });

  it("should filter out disabled providers from priority list", () => {
    fm.registerProvider(makeProvider({ id: "a", enabled: false }));
    fm.registerProvider(makeProvider({ id: "b", enabled: true }));

    const sorted = fm.getPrioritizedProviders();
    expect(sorted).toHaveLength(1);
    expect(sorted[0].id).toBe("b");
  });

  it("should dynamically adjust priority based on health score", () => {
    fm.registerProvider(makeProvider({ id: "a", order: 1 }));
    fm.registerProvider(makeProvider({ id: "b", order: 2 }));

    for (let i = 0; i < 5; i++) {
      fm.recordFailure("a", "error");
    }
    for (let i = 0; i < 10; i++) {
      fm.recordSuccess("b", 50);
    }

    const sorted = fm.getPrioritizedProviders();
    expect(sorted[0].id).toBe("b");
  });

  it("should set provider order dynamically", () => {
    fm.registerProvider(makeProvider({ id: "a", order: 1 }));
    fm.registerProvider(makeProvider({ id: "b", order: 2 }));

    fm.setProviderOrder("b", 0);

    const sorted = fm.getPrioritizedProviders();
    expect(sorted[0].id).toBe("b");
  });

  // ── filterHealthy ─────────────────────────────────

  it("should filter out unhealthy providers", () => {
    fm.registerProvider(makeProvider({ id: "a" }));
    fm.registerProvider(makeProvider({ id: "b" }));
    fm.getHealth("b")!.circuitState = "open";

    const input = [
      { id: "a", enabled: true, order: 1 },
      { id: "b", enabled: true, order: 2 },
    ];
    const result = fm.filterHealthy(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("should pass through unregistered providers if enabled", () => {
    const input = [
      { id: "external", enabled: true, order: 1 },
    ];
    const result = fm.filterHealthy(input);
    expect(result).toHaveLength(1);
  });

  it("should filter out disabled providers", () => {
    const input = [
      { id: "x", enabled: false, order: 1 },
      { id: "y", enabled: true, order: 2 },
    ];
    fm.registerProvider(makeProvider({ id: "y", enabled: true }));
    const result = fm.filterHealthy(input);
    expect(result).toHaveLength(1);
  });

  // ── Retry ─────────────────────────────────────────

  it("should return exponential backoff delay", () => {
    const d0 = fm.getRetryDelay(0);
    const d1 = fm.getRetryDelay(1);
    const d2 = fm.getRetryDelay(2);

    expect(d0).toBeGreaterThanOrEqual(1000);
    expect(d1).toBeGreaterThanOrEqual(2000);
    expect(d2).toBeGreaterThanOrEqual(4000);
  });

  it("should cap retry delay at max", () => {
    const fm2 = new ModelFailoverManager({ retryMaxDelayMs: 5000 });
    const delay = fm2.getRetryDelay(10);
    expect(delay).toBeLessThanOrEqual(5000 + 5000 * 0.3);
    fm2.dispose();
  });

  // ── Summary ───────────────────────────────────────

  it("should provide accurate summary", () => {
    fm.registerProvider(makeProvider({ id: "a" }));
    fm.registerProvider(makeProvider({ id: "b" }));
    fm.recordSuccess("a", 100);
    fm.recordSuccess("a", 200);
    fm.recordFailure("b", "err");

    const summary = fm.getSummary();
    expect(summary.totalProviders).toBe(2);
    expect(summary.totalRequests).toBe(3);
    expect(summary.totalFailures).toBe(1);
    expect(summary.avgHealthScore).toBeGreaterThan(0);
    expect(summary.halfOpenCircuits).toBe(0);
    expect(summary.providers).toHaveLength(2);
    expect(summary.providers[0]).toHaveProperty("healthScore");
    expect(summary.providers[0]).toHaveProperty("dynamicPriority");
    expect(summary.providers[0]).toHaveProperty("currentKeyIndex");
    expect(summary.providers[0]).toHaveProperty("fallbackChain");
  });

  it("should get all health records", () => {
    fm.registerProvider(makeProvider({ id: "a" }));
    fm.registerProvider(makeProvider({ id: "b" }));
    expect(fm.getAllHealth()).toHaveLength(2);
  });

  it("should count half-open circuits in summary", () => {
    fm.registerProvider(makeProvider({ id: "a" }));
    fm.getHealth("a")!.circuitState = "half-open";

    const summary = fm.getSummary();
    expect(summary.halfOpenCircuits).toBe(1);
  });

  // ── Dispose ───────────────────────────────────────

  it("should dispose and clear all state", () => {
    fm.registerProvider(makeProvider());
    fm.dispose();
    expect(fm.getAllHealth()).toHaveLength(0);
    expect(fm.getSummary().totalProviders).toBe(0);
  });
});
