import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { HealthAggregator, createHealthCheck } from "./health-aggregator";

describe("HealthAggregator", () => {
  let ha: HealthAggregator;

  beforeEach(() => {
    ha = new HealthAggregator();
  });

  afterEach(() => {
    ha.stopPolling();
  });

  describe("registerComponent", () => {
    it("should register a component", () => {
      ha.registerComponent("discord", "channel", async () => ({ ok: true }));
      const comp = ha.getComponent("discord");
      expect(comp).not.toBeNull();
      expect(comp!.name).toBe("discord");
      expect(comp!.type).toBe("channel");
      expect(comp!.status).toBe("unknown");
    });

    it("should unregister a component", () => {
      ha.registerComponent("telegram", "channel", async () => ({ ok: true }));
      expect(ha.unregisterComponent("telegram")).toBe(true);
      expect(ha.getComponent("telegram")).toBeNull();
    });
  });

  describe("checkComponent", () => {
    it("should mark component as ok on success", async () => {
      ha.registerComponent("webchat", "channel", async () => ({ ok: true }));

      const comp = await ha.checkComponent("webchat");
      expect(comp!.status).toBe("ok");
      expect(comp!.lastCheckedAt).toBeGreaterThan(0);
    });

    it("should mark component as down on failure", async () => {
      ha.registerComponent("webchat", "channel", async () => ({
        ok: false,
        error: "Connection refused",
      }));

      const comp = await ha.checkComponent("webchat");
      expect(comp!.status).toBe("down");
      expect(comp!.error).toBe("Connection refused");
    });

    it("should catch exceptions in check function", async () => {
      ha.registerComponent("broken", "service", async () => {
        throw new Error("Boom");
      });

      const comp = await ha.checkComponent("broken");
      expect(comp!.status).toBe("down");
      expect(comp!.error).toContain("Boom");
    });

    it("should return null for unknown component", async () => {
      const result = await ha.checkComponent("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("checkAll", () => {
    it("should check all components", async () => {
      ha.registerComponent("webchat", "channel", async () => ({ ok: true }));
      ha.registerComponent("discord", "channel", async () => ({ ok: true }));
      ha.registerComponent("db", "database", async () => ({ ok: false, error: "timeout" }));

      const result = await ha.checkAll();
      expect(result.components).toHaveLength(3);
      expect(result.summary.ok).toBe(2);
      expect(result.summary.down).toBe(1);
    });
  });

  describe("aggregate", () => {
    it("should report healthy when all ok", async () => {
      ha.registerComponent("s1", "service", async () => ({ ok: true }));
      ha.registerComponent("s2", "service", async () => ({ ok: true }));

      await ha.checkAll();
      const result = ha.aggregate();

      expect(result.overall).toBe("ok");
      expect(result.ready).toBe(true);
      expect(result.alive).toBe(true);
    });

    it("should report degraded when non-critical component is down", async () => {
      ha.registerComponent("crit", "service", async () => ({ ok: true }));
      ha.registerComponent("noncrit", "service", async () => ({ ok: false }));

      await ha.checkAll();
      const result = ha.aggregate();

      expect(result.overall).toBe("degraded");
      expect(result.ready).toBe(false);
      expect(result.alive).toBe(true);
    });

    it("should report down when critical component is down", async () => {
      const haCrit = new HealthAggregator({
        criticalComponents: ["db"],
      });

      haCrit.registerComponent("db", "database", async () => ({ ok: false, error: "down" }));
      haCrit.registerComponent("web", "service", async () => ({ ok: true }));

      await haCrit.checkAll();
      const result = haCrit.aggregate();

      expect(result.overall).toBe("down");
    });

    it("should report unknown when nothing checked", () => {
      ha.registerComponent("s1", "service", async () => ({ ok: true }));
      // Don't check — status stays "unknown"

      const result = ha.aggregate();
      expect(result.overall).toBe("unknown");
    });
  });

  describe("updateComponentHealth", () => {
    it("should manually update health", () => {
      ha.registerComponent("webchat", "channel", async () => ({ ok: true }));
      ha.updateComponentHealth("webchat", "degraded", { error: "Slow response" });

      expect(ha.getComponent("webchat")!.status).toBe("degraded");
      expect(ha.getComponent("webchat")!.error).toBe("Slow response");
    });

    it("should emit statusChange on transition", () => {
      const handler = vi.fn();
      ha.on("statusChange", handler);

      ha.registerComponent("webchat", "channel", async () => ({ ok: true }));

      // Set initial state to "ok" — this triggers "unknown" → "ok" transition
      ha.updateComponentHealth("webchat", "ok");

      // Now set to "degraded" — this triggers "ok" → "degraded" transition
      ha.updateComponentHealth("webchat", "degraded");

      // 2 transitions: unknown→ok and ok→degraded
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("getByType", () => {
    it("should filter by type", async () => {
      ha.registerComponent("discord", "channel", async () => ({ ok: true }));
      ha.registerComponent("telegram", "channel", async () => ({ ok: true }));
      ha.registerComponent("db", "database", async () => ({ ok: true }));

      await ha.checkAll();

      expect(ha.getByType("channel")).toHaveLength(2);
      expect(ha.getByType("database")).toHaveLength(1);
    });
  });

  describe("K8s summary", () => {
    it("should produce K8s-compatible summary", async () => {
      ha.registerComponent("discord", "channel", async () => ({ ok: true }));
      await ha.checkAll();

      const k8s = ha.getK8sSummary();
      expect(k8s.status).toBeDefined();
      expect(k8s.uptime).toBeGreaterThan(0);
      expect(k8s.checks).toHaveLength(1);
      expect(k8s.checks[0].name).toBe("discord");
      expect(k8s.checks[0].status).toBe("ok");
    });
  });

  describe("transitions", () => {
    it("should record status transitions", async () => {
      ha.registerComponent("webchat", "channel", async () => ({ ok: true }));
      await ha.checkComponent("webchat");

      // Manually trigger a different status
      ha.updateComponentHealth("webchat", "degraded", { error: "Slow" });

      const transitions = ha.getTransitions();
      // 2 transitions: unknown→ok (from checkComponent) and ok→degraded (from manual update)
      expect(transitions.length).toBe(2);
      expect(transitions[1].from).toBe("ok");
      expect(transitions[1].to).toBe("degraded");
    });

    it("should clear transitions", () => {
      ha.registerComponent("s1", "service", async () => ({ ok: true }));
      ha.updateComponentHealth("s1", "ok");
      ha.updateComponentHealth("s1", "degraded");

      ha.clearTransitions();
      expect(ha.getTransitions()).toHaveLength(0);
    });
  });

  describe("polling", () => {
    it("should start and stop polling", () => {
      expect(ha.isPolling()).toBe(false);
      ha.startPolling();
      expect(ha.isPolling()).toBe(true);
      ha.stopPolling();
      expect(ha.isPolling()).toBe(false);
    });

    it("should not start duplicate polling", () => {
      ha.startPolling();
      ha.startPolling();
      ha.stopPolling();
      expect(ha.isPolling()).toBe(false);
    });
  });

  describe("createHealthCheck", () => {
    it("should create health check from boolean promise", async () => {
      const check = createHealthCheck(async () => true);
      const result = await check();
      expect(result.ok).toBe(true);
    });

    it("should handle errors in health check", async () => {
      const check = createHealthCheck(async () => {
        throw new Error("Boom");
      });
      const result = await check();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Boom");
    });
  });

  describe("configure", () => {
    it("should update config", () => {
      ha.configure({ checkIntervalMs: 60_000 });
      ha.startPolling();
      ha.stopPolling();
    });
  });
});