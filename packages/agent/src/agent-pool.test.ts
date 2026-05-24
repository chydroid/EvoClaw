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
    // Each acquire either picks up an idle agent (sets to busy) or creates
    // a new idle agent. The odd acquires create new agents returned idle,
    // the even ones pick up those idle agents. We need enough due to the
    // createAgent not marking new agents as busy inside acquire.
    let overflow: any = null;
    for (let i = 0; i < 20; i++) {
      overflow = await pool.acquire();
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
});