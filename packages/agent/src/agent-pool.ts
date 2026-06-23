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
    autoScale: true,
  };
  // 等待队列：当池满时，请求排队等待
  private waitQueue: Array<{
    role?: AgentRole;
    resolve: (agent: Agent | null) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];

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

  async acquire(role?: AgentRole, timeoutMs = 30_000): Promise<Agent | null> {
    const agent = this.tryAcquire(role);
    if (agent) return agent;

    // timeoutMs=0 表示不排队，立即返回 null
    if (timeoutMs <= 0) return null;

    // 池满时排队等待
    return new Promise<Agent | null>((resolve) => {
      const timer = setTimeout(() => {
        // 超时：从队列移除并返回 null
        const idx = this.waitQueue.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waitQueue.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      this.waitQueue.push({ role, resolve, timer });

      // 尝试自动扩容
      if (this.poolConfig.autoScale) {
        this.tryAutoScale();
      }
    });
  }

  /**
   * 尝试立即获取一个空闲 agent。内部方法，不排队。
   */
  private tryAcquire(role?: AgentRole): Agent | null {
    const agents = Array.from(this.agents.values());

    for (const agent of agents) {
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
      const newAgent = this.createAgent(role || "executor");
      newAgent.state.status = "busy";
      newAgent.state.lastHeartbeat = new Date();
      return newAgent;
    }

    return null;
  }

  /**
   * 基于利用率自动扩容。当利用率超过 scaleThreshold 且未达 maxAgents 时扩容。
   */
  private tryAutoScale(): void {
    const agents = Array.from(this.agents.values());
    const active = agents.filter((a) => a.state.status === "busy").length;
    const utilization = agents.length > 0 ? active / agents.length : 0;

    if (utilization >= this.poolConfig.scaleThreshold && agents.length < this.poolConfig.maxAgents) {
      this.createAgent("executor");
      process.stderr.write(
        `[AgentPool] Auto-scaled: ${agents.length} → ${agents.length + 1} agents (utilization=${(utilization * 100).toFixed(0)}%)`
      );
    }
  }

  /**
   * 唤醒等待队列中的下一个请求。
   */
  private drainWaitQueue(): void {
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue[0];
      const agent = this.tryAcquire(waiter.role);
      if (agent) {
        this.waitQueue.shift();
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(agent);
      } else {
        break; // 无可用 agent，停止尝试
      }
    }
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

    // 唤醒等待队列中的下一个请求
    this.drainWaitQueue();
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
    const idle = agents.filter((a) => a.state.status === "idle").length;

    return {
      totalAgents: agents.length,
      activeAgents: active,
      idleAgents: idle,
      queuedTasks: this.waitQueue.length,
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