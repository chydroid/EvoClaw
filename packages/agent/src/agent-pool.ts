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
  };

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.initializePool();
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
      if (agent.state.status === "idle") {
        if (!role || agent.role === role) {
          agent.state.status = "busy";
          agent.state.lastHeartbeat = new Date();
          return agent;
        }
      }
    }

    if (agents.length < this.poolConfig.maxAgents) {
      return this.createAgent(role || "executor");
    }

    return null;
  }

  async release(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.state.status = "idle";
      agent.state.activeTaskId = null;
      agent.state.lastHeartbeat = new Date();
    }
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
    return Array.from(this.agents.values()).map((agent) => ({
      agentId: agent.id,
      healthy: agent.state.status !== "error" && agent.state.status !== "terminated",
      issues: agent.state.status === "error" ? ["Agent in error state"] : [],
    }));
  }
}