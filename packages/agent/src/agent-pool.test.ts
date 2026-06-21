import { describe, it, expect, beforeEach } from "vitest";
import { AgentPoolManager } from "./agent-pool";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import type { AgentRole } from "@evoclaw/core";

describe("AgentPoolManager", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let pool: AgentPoolManager;

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    pool = new AgentPoolManager(registry, eventBus);
  });

  it("should initialize with min agents + orchestrator + observer", async () => {
    const metrics = await pool.getMetrics();
    // minAgents=2 executors + 1 orchestrator + 1 observer = 4
    expect(metrics.totalAgents).toBe(4);
    expect(metrics.idleAgents).toBe(4);
    expect(metrics.activeAgents).toBe(0);
  });

  it("should acquire an idle agent", async () => {
    const agent = await pool.acquire();
    expect(agent).not.toBeNull();
    expect(agent!.state.status).toBe("busy");
    expect(agent!.state.activeTaskId).toBeNull();
  });

  it("should acquire agent matching specific role", async () => {
    const agent = await pool.acquire("orchestrator");
    expect(agent).not.toBeNull();
    expect(agent!.role).toBe("orchestrator");
    expect(agent!.state.status).toBe("busy");
  });

  it("should return null when pool is full and all busy", async () => {
    // The pool creates agents when full is not reached, so we need
    // to acquire many times until maxAgents (10) is hit and all are busy.
    // Use timeoutMs=0 so acquire returns null immediately when pool is full.
    let overflow: any = null;
    for (let i = 0; i < 20; i++) {
      overflow = await pool.acquire(undefined, 0);
    }
    expect(overflow).toBeNull();
  });

  it("should release an agent back to idle", async () => {
    const agent = await pool.acquire();
    await pool.release(agent!.id);

    const released = await pool.acquire();
    expect(released!.id).toBe(agent!.id);
    expect(released!.state.status).toBe("busy"); // re-acquired
  });

  it("should scale up when delta is positive", async () => {
    const before = await pool.getMetrics();
    await pool.scale(2);
    const after = await pool.getMetrics();
    expect(after.totalAgents).toBe(before.totalAgents + 2);
  });

  it("should not scale beyond max", async () => {
    await pool.scale(100); // maxAgents = 10
    const metrics = await pool.getMetrics();
    expect(metrics.totalAgents).toBeLessThanOrEqual(10);
  });

  it("should scale down idle agents", async () => {
    const before = await pool.getMetrics();
    await pool.scale(-1);
    const after = await pool.getMetrics();
    // minAgents=2 + orchestrator + observer = 4, so removing 1 should leave 3
    expect(after.totalAgents).toBe(before.totalAgents - 1);
  });

  it("should not scale below minAgents", async () => {
    const before = await pool.getMetrics();
    await pool.scale(-100);
    const after = await pool.getMetrics();
    // All executors could be removed but orchestrator + observer remain
    expect(after.totalAgents).toBeGreaterThanOrEqual(2); // orchestrator + observer
  });

  it("should only scale down idle agents", async () => {
    // Acquire all first so none are idle
    const metrics = await pool.getMetrics();
    for (let i = 0; i < metrics.totalAgents; i++) {
      await pool.acquire();
    }
    const before = await pool.getMetrics();
    expect(before.idleAgents).toBe(0);

    await pool.scale(-2);
    const after = await pool.getMetrics();
    expect(after.totalAgents).toBe(before.totalAgents); // No idle agents to remove
  });

  it("should terminate an agent", async () => {
    const agent = await pool.acquire();
    const id = agent!.id;
    await pool.terminate(id);

    const metrics = await pool.getMetrics();
    expect(metrics.totalAgents).toBe(3); // one less
  });

  it("should return health check results", async () => {
    const health = await pool.healthCheck();
    expect(health).toHaveLength(4);
    for (const h of health) {
      expect(h.healthy).toBe(true);
      expect(h.issues).toEqual([]);
    }
  });

  it("should report correct metrics after acquire/release", async () => {
    const agent = await pool.acquire();
    let metrics = await pool.getMetrics();
    expect(metrics.activeAgents).toBe(1);
    expect(metrics.idleAgents).toBe(3);
    expect(metrics.averageUtilization).toBe(1 / 4);

    await pool.release(agent!.id);
    metrics = await pool.getMetrics();
    expect(metrics.activeAgents).toBe(0);
    expect(metrics.averageUtilization).toBe(0);
  });

  it("should ignore release for non-busy agents", async () => {
    const metricsBefore = await pool.getMetrics();
    const idleAgent = Array.from((pool as any).agents.values()).find((a: any) => a.state.status === "idle");
    expect(idleAgent).toBeDefined();

    await pool.release((idleAgent as any).id);
    const metricsAfter = await pool.getMetrics();
    expect(metricsAfter.totalAgents).toBe(metricsBefore.totalAgents);
  });

  it("should skip error-state agents during acquire", async () => {
    const agent = await pool.acquire();
    await pool.reportError(agent!.id);
    await pool.reportError(agent!.id);
    await pool.reportError(agent!.id);

    const acquired = await pool.acquire();
    expect(acquired).not.toBeNull();
    expect(acquired!.id).not.toBe(agent!.id);
  });

  it("should clean up stale idle agents", async () => {
    // Scale up so we have spare executors beyond the minimum footprint.
    await pool.scale(4);
    const before = await pool.getMetrics();
    expect(before.totalAgents).toBeGreaterThan(4);

    // Manually backdate all idle heartbeats.
    const staleTime = Date.now() - 400_000;
    for (const agent of (pool as any).agents.values()) {
      if (agent.state.status === "idle") {
        agent.state.lastHeartbeat = new Date(staleTime);
      }
    }

    const removed = await pool.cleanup();
    expect(removed).toBeGreaterThan(0);

    const after = await pool.getMetrics();
    expect(after.totalAgents).toBeLessThan(before.totalAgents);
  });

  it("should keep minimum footprint during cleanup", async () => {
    const before = await pool.getMetrics();
    const staleTime = Date.now() - 400_000;
    for (const agent of (pool as any).agents.values()) {
      agent.state.lastHeartbeat = new Date(staleTime);
    }

    const removed = await pool.cleanup();
    expect(removed).toBe(0);

    const after = await pool.getMetrics();
    expect(after.totalAgents).toBe(before.totalAgents);
  });

  it("should report stale heartbeat and errors in health check", async () => {
    const agent = await pool.acquire();
    await pool.reportError(agent!.id);
    await pool.release(agent!.id);

    const staleTime = Date.now() - 400_000;
    agent!.state.lastHeartbeat = new Date(staleTime);

    const health = await pool.healthCheck();
    const agentHealth = health.find((h) => h.agentId === agent!.id);
    expect(agentHealth).toBeDefined();
    expect(agentHealth!.healthy).toBe(false);
    expect(agentHealth!.issues.some((i) => i.includes("Heartbeat stale"))).toBe(true);
    expect(agentHealth!.issues.some((i) => i.includes("recorded errors"))).toBe(true);
  });
});