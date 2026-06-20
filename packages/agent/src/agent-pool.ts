import {
  ServiceRegistry,
  EventBus,
  type Agent,
  type AgentPool,
  type AgentRole,
  type PoolMetrics,
  type HealthStatus,
} from "@evoclaw/core";
import { v4 as uuid } from "uuid";

export class AgentPoolManager implements AgentPool {
  private agents = new Map<string, Agent>();
  private poolConfig = {
    minAgents: 2,
    maxAgents: 10,
    scaleThreshold: 0.7,
    heartbeatTimeoutMs: 300_000, // 5 minutes
    maxErrorCount: 3,
  };

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.initializePool();
  }

  /**
   * Report that an agent encountered an error during execution.
   * Increments the error counter and moves the agent to the error state
   * when the threshold is crossed.
   */
  async reportError(agentId: string, errorMessage?: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.state.errorCount += 1;
    agent.state.lastHeartbeat = new Date();

    if (agent.state.errorCount >= this.poolConfig.maxErrorCount) {
      agent.state.status = "error";
      process.stderr.write(
        `[AgentPool] Agent "${agentId}" moved to error state after ${agent.state.errorCount} errors${errorMessage ? `: ${errorMessage}` : ""}`
      );
      await this.eventBus.publish("agent.error", agent, "agent-pool");
    }
  }

  private initializePool(): void {
    for (let i = 0; i < this.poolConfig.minAgents; i++) {
      this.createAgent("executor");
    }
    this.createAgent("orchestrator");
    this.createAgent("observer");
  }

  private createAgent(role: AgentRole): Agent {
    const agent: Agent = {
      id: uuid(),
      name: `${role}-${uuid().slice(0, 8)}`,
      role,
      model: "default",
      state: {
        activeTaskId: null,
        status: "idle",
        memoryContext: {},
        lastHeartbeat: new Date(),
        errorCount: 0,
      },
      capabilities: [],
      config: {
        maxConcurrency: 1,
        maxRetries: 3,
        defaultTimeout: 300000,
        allowCodeExecution: true,
        allowedSkills: [],
        temperature: 0.7,
        maxTokens: 4096,
      },
      metrics: {
        tasksCompleted: 0,
        tasksFailed: 0,
        averageResponseTime: 0,
        tokenUsage: 0,
        costEstimate: 0,
      },
    };

    this.agents.set(agent.id, agent);
    return agent;
  }

  async acquire(role?: AgentRole): Promise<Agent | null> {
    const agents = Array.from(this.agents.values());

    for (const agent of agents) {
      // Skip agents that are no longer usable: error, terminated, or awaiting_input.
      if (agent.state.status === "error" || agent.state.status === "terminated" || agent.state.status === "awaiting_input") {
        continue;
      }
      if (agent.state.status === "idle") {
        if (!role || agent.role === role) {
          agent.state.status = "busy";
          agent.state.lastHeartbeat = new Date();
          return agent;
        }
      }
    }

    if (agents.length < this.poolConfig.maxAgents) {
      // When creating a new agent, mark it as busy before returning so callers
      // can rely on the "busy" invariant for all acquired agents.
      const newAgent = this.createAgent(role || "executor");
      newAgent.state.status = "busy";
      newAgent.state.lastHeartbeat = new Date();
      return newAgent;
    }

    return null;
  }

  async release(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    if (agent.state.status !== "busy") {
      process.stderr.write(
        `[AgentPool] Ignoring release for agent "${agentId}" which is not busy (status=${agent.state.status})`
      );
      return;
    }

    agent.state.status = "idle";
    agent.state.activeTaskId = null;
    agent.state.lastHeartbeat = new Date();
  }

  async scale(delta: number): Promise<void> {
    if (delta > 0) {
      for (let i = 0; i < delta && this.agents.size < this.poolConfig.maxAgents; i++) {
        this.createAgent("executor");
      }
    } else {
      const toRemove = Math.min(Math.abs(delta), this.agents.size - this.poolConfig.minAgents);
      const idleAgents = Array.from(this.agents.values()).filter((a) => a.state.status === "idle");
      for (let i = 0; i < Math.min(toRemove, idleAgents.length); i++) {
        this.agents.delete(idleAgents[i].id);
      }
    }
  }

  async terminate(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.state.status = "terminated";
      this.agents.delete(agentId);
      await this.eventBus.publish("agent.terminated", agent, "agent-pool");
    }
  }

  /**
   * Clean up stale or unhealthy agents.
   * - Removes idle agents whose heartbeat expired (unless it would drop below minAgents).
   * - Removes agents in error/terminated state.
   * Returns the number of agents removed.
   */
  async cleanup(now = Date.now()): Promise<number> {
    let removed = 0;
    const agents = Array.from(this.agents.values());

    for (const agent of agents) {
      const isUnusable = agent.state.status === "error" || agent.state.status === "terminated";
      const isStaleIdle =
        agent.state.status === "idle" &&
        now - agent.state.lastHeartbeat.getTime() > this.poolConfig.heartbeatTimeoutMs;

      if (isUnusable || isStaleIdle) {
        if (this.agents.size <= this.poolConfig.minAgents + 2) {
          // Keep orchestrator + observer + min executors; just mark unusable agents.
          if (isUnusable) continue;
          // For stale idle agents within the minimum footprint, refresh heartbeat.
          agent.state.lastHeartbeat = new Date(now);
          continue;
        }
        this.agents.delete(agent.id);
        removed++;
      }
    }

    return removed;
  }

  async getMetrics(): Promise<PoolMetrics> {
    const agents = Array.from(this.agents.values());
    const active = agents.filter((a) => a.state.status === "busy").length;
    const idle = agents.length - active;

    return {
      totalAgents: agents.length,
      activeAgents: active,
      idleAgents: idle,
      queuedTasks: 0,
      averageUtilization: agents.length > 0 ? active / agents.length : 0,
    };
  }

  async healthCheck(): Promise<HealthStatus[]> {
    const now = Date.now();
    return Array.from(this.agents.values()).map((agent) => {
      const issues: string[] = [];
      if (agent.state.status === "error") issues.push("Agent in error state");
      if (agent.state.status === "terminated") issues.push("Agent terminated");
      if (agent.state.errorCount > 0) issues.push(`Agent has ${agent.state.errorCount} recorded errors`);
      const staleMs = now - agent.state.lastHeartbeat.getTime();
      if (staleMs > this.poolConfig.heartbeatTimeoutMs) {
        issues.push(`Heartbeat stale (${Math.round(staleMs / 1000)}s)`);
      }
      return {
        agentId: agent.id,
        healthy: issues.length === 0,
        issues,
      };
    });
  }
}