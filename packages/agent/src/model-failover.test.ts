import { describe, it, expect, vi, beforeEach } from "vitest";
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

  // ── Registration ─────────────────────────────────

  it("should register a provider with healthy state", () => {
    const p = makeProvider();
    fm.registerProvider(p);
    const health = fm.getHealth("provider-1");
    expect(health).toBeDefined();
    expect(health!.circuitState).toBe("closed");
    expect(health!.failureCount).toBe(0);
    expect(health!.active).toBe(true);
  });

  it("should register disabled providers as inactive", () => {
    const p = makeProvider({ enabled: false });
    fm.registerProvider(p);
    const health = fm.getHealth("provider-1");
    expect(health!.active).toBe(false);
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
    // EMA: 200 → 200*0.7 + 100*0.3 = 170
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
  });

  it("should return true for half-open (trial)", () => {
    fm.registerProvider(makeProvider());
    const health = fm.getHealth("provider-1")!;
    health.circuitState = "half-open";
    expect(fm.canUse("provider-1")).toBe(true);
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

  // ── Prioritization ───────────────────────────────

  it("should sort healthy providers before unhealthy", () => {
    fm.registerProvider(makeProvider({ id: "a", order: 1 }));
    fm.registerProvider(makeProvider({ id: "b", order: 2 }));
    // Make b unhealthy
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
    const d0 = fm.getRetryDelay(0); // 1000 * 2^0 = 1000
    const d1 = fm.getRetryDelay(1); // 1000 * 2^1 = 2000
    const d2 = fm.getRetryDelay(2); // 1000 * 2^2 = 4000

    expect(d0).toBeGreaterThanOrEqual(1000);
    expect(d1).toBeGreaterThanOrEqual(2000);
    expect(d2).toBeGreaterThanOrEqual(4000);
  });

  it("should cap retry delay at max", () => {
    const fm2 = new ModelFailoverManager({ retryMaxDelayMs: 5000 });
    const delay = fm2.getRetryDelay(10); // would be 1024000 uncapped
    expect(delay).toBeLessThanOrEqual(5000 + 5000 * 0.3);
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
  });

  it("should get all health records", () => {
    fm.registerProvider(makeProvider({ id: "a" }));
    fm.registerProvider(makeProvider({ id: "b" }));
    expect(fm.getAllHealth()).toHaveLength(2);
  });

  // ── Dispose ───────────────────────────────────────

  it("should dispose and clear all state", () => {
    fm.registerProvider(makeProvider());
    fm.dispose();
    expect(fm.getAllHealth()).toHaveLength(0);
    expect(fm.getSummary().totalProviders).toBe(0);
  });
});