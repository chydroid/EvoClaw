/**
 * Multi-Agent Swarm Orchestrator — agent-to-agent communication,
 * delegation, role-based assignment, and consensus-driven execution.
 *
 * Enables:
 *  - Agent discovery and registration in a swarm
 *  - Role-based agent specialization (planner / executor / reviewer / critic)
 *  - Task delegation with capability matching
 *  - Swarm consensus for critical decisions
 *  - Agent-to-agent messaging with routing
 *  - Load balancing across agent pool with health awareness
 *  - Hierarchical swarm topology (leader / worker patterns)
 */

import type { EventBus } from "@evoclaw/core";

// ── Types ─────────────────────────────────────────────────

export type AgentRole =
  | "planner"       // Breaks tasks into subtasks
  | "executor"      // Executes individual tasks
  | "reviewer"      // Reviews outputs for quality
  | "critic"        // Critiques and suggests improvements
  | "researcher"    // Gathers information
  | "coordinator"   // Coordinates other agents
  | "specialist"    // Domain-specific expert
  | "observer";     // Monitors and reports

export interface SwarmAgent {
  id: string;
  name: string;
  role: AgentRole;
  capabilities: string[];
  /** Current status */
  status: "idle" | "busy" | "offline" | "error";
  /** Current task if busy */
  currentTask?: string;
  /** Performance metrics */
  metrics: {
    tasksCompleted: number;
    successRate: number;
    avgResponseTime: number;
    reliabilityScore: number; // 0-1
  };
  /** When last heartbeat was received */
  lastHeartbeat: number;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

export interface DelegationRequest {
  id: string;
  fromAgentId: string;
  toAgentId?: string; // undefined = auto-assign
  task: string;
  context?: string;
  /** Required capabilities */
  requiredCapabilities: string[];
  /** Priority */
  priority: "critical" | "high" | "medium" | "low";
  /** Timeout in ms */
  timeoutMs: number;
  /** Whether to wait for review */
  requireReview?: boolean;
}

export interface DelegationResult {
  requestId: string;
  success: boolean;
  agentId: string;
  result?: string;
  error?: string;
  reviewNotes?: string;
  reviewerId?: string;
  timeSpentMs: number;
}

export interface ConsensusProposal {
  id: string;
  proposerId: string;
  title: string;
  description: string;
  options: string[];
  /** Required agreement ratio (0-1) */
  requiredRatio: number;
  /** Timeout for responses */
  deadlineMs: number;
}

export interface ConsensusVote {
  proposalId: string;
  voterId: string;
  choice: string;
  confidence: number; // 0-1
  reasoning?: string;
}

export interface ConsensusResult {
  proposalId: string;
  resolved: boolean;
  winner?: string;
  votes: ConsensusVote[];
  agreementRatio: number;
  tieBreaker?: string;
}

export interface SwarmConfig {
  /** Max agents in the swarm */
  maxAgents?: number;
  /** Heartbeat timeout (ms) before marking agent offline */
  heartbeatTimeoutMs?: number;
  /** Default delegation timeout */
  defaultTimeoutMs?: number;
  /** Max concurrent delegations per agent */
  maxConcurrentDelegations?: number;
  /** Auto-heal: reassign tasks from offline agents */
  autoReassign?: boolean;
}

// ── Swarm Orchestrator ────────────────────────────────────

export class SwarmOrchestrator {
  private agents = new Map<string, SwarmAgent>();
  private pendingDelegations = new Map<string, DelegationRequest>();
  private activeDelegations = new Map<string, DelegationRequest>();
  private delegationResults = new Map<string, DelegationResult>();
  private delegationStartTimes = new Map<string, number>();
  private delegationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private proposals = new Map<string, ConsensusProposal>();
  private votes = new Map<string, ConsensusVote[]>();
  private config: Required<SwarmConfig>;
  private eventBus: EventBus;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(eventBus: EventBus, config: SwarmConfig = {}) {
    this.eventBus = eventBus;
    this.config = {
      maxAgents: config.maxAgents ?? 50,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs ?? 30000,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 120000,
      maxConcurrentDelegations: config.maxConcurrentDelegations ?? 5,
      autoReassign: config.autoReassign ?? true,
    };
  }

  // ── Agent Lifecycle ─────────────────────────────────────

  /** Register a new agent in the swarm */
  registerAgent(agent: Omit<SwarmAgent, "id" | "status" | "lastHeartbeat" | "metrics">): SwarmAgent {
    if (this.agents.size >= this.config.maxAgents) {
      throw new Error("Max agents reached");
    }

    const fullAgent: SwarmAgent = {
      ...agent,
      id: `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: "idle",
      lastHeartbeat: Date.now(),
      metrics: {
        tasksCompleted: 0,
        successRate: 1,
        avgResponseTime: 0,
        reliabilityScore: 1,
      },
    };

    this.agents.set(fullAgent.id, fullAgent);
    this.eventBus.publish("swarm:agent-registered", { agent: fullAgent }, "swarm-orchestrator");
    return fullAgent;
  }

  /** Remove an agent from the swarm */
  unregisterAgent(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    // Reassign any active delegations from this agent
    if (this.config.autoReassign) {
      for (const [, delegation] of this.activeDelegations) {
        if (delegation.toAgentId === agentId) {
          this.reassignDelegation(delegation);
        }
      }
    }

    this.agents.delete(agentId);
    this.eventBus.publish("swarm:agent-unregistered", { agentId }, "swarm-orchestrator");
    return true;
  }

  /** Agent sends heartbeat to stay active */
  heartbeat(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    agent.lastHeartbeat = Date.now();
    if (agent.status === "offline") {
      agent.status = "idle";
    }
    return true;
  }

  // ── Delegation ──────────────────────────────────────────

  /**
   * Delegate a task to the best-matching agent.
   * If no agent is specified, auto-assigns based on capabilities.
   */
  async delegate(request: Omit<DelegationRequest, "id">): Promise<DelegationResult> {
    const delegation: DelegationRequest = {
      ...request,
      id: `deleg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    };

    // Auto-assign: find best agent for the capabilities
    if (!delegation.toAgentId) {
      const best = this.findBestAgent(delegation.requiredCapabilities, delegation.priority);
      if (!best) {
        const result: DelegationResult = {
          requestId: delegation.id,
          success: false,
          agentId: "",
          error: "No suitable agent available",
          timeSpentMs: 0,
        };
        this.delegationResults.set(delegation.id, result);
        return result;
      }
      delegation.toAgentId = best.id;
    }

    const agent = this.agents.get(delegation.toAgentId);
    if (!agent) {
      return { requestId: delegation.id, success: false, agentId: delegation.toAgentId, error: "Agent not found", timeSpentMs: 0 };
    }

    // Check agent is available
    if (agent.status === "offline") {
      return { requestId: delegation.id, success: false, agentId: agent.id, error: "Agent offline", timeSpentMs: 0 };
    }

    // Check concurrent delegation limit
    const activeCount = this.countActiveDelegations(agent.id);
    if (activeCount >= this.config.maxConcurrentDelegations) {
      this.pendingDelegations.set(delegation.id, delegation);
      return { requestId: delegation.id, success: false, agentId: agent.id, error: "Agent overloaded — queued", timeSpentMs: 0 };
    }

    // Execute delegation
    const startTime = Date.now();
    agent.status = "busy";
    agent.currentTask = delegation.task;
    this.activeDelegations.set(delegation.id, delegation);
    this.delegationStartTimes.set(delegation.id, startTime);

    // Set timeout for delegation
    const timeoutMs = request.timeoutMs || 120000; // default 2 minutes
    const timeoutTimer = setTimeout(() => {
      this.failDelegation(delegation.id, new Error(`Delegation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.delegationTimers.set(delegation.id, timeoutTimer);

    this.eventBus.publish("swarm:delegation-started", { delegation }, "swarm-orchestrator");

    // In production, the agent would execute asynchronously;
    // the orchestrator tracks the result via completeDelegation()

    return {
      requestId: delegation.id,
      success: true,
      agentId: agent.id,
      timeSpentMs: 0,
    };
  }

  /** Complete a delegation with the result */
  completeDelegation(requestId: string, result: string, error?: string): DelegationResult | null {
    const delegation = this.activeDelegations.get(requestId);
    if (!delegation) return null;

    // Clear timeout timer
    const timer = this.delegationTimers.get(requestId);
    if (timer) { clearTimeout(timer); this.delegationTimers.delete(requestId); }

    const agent = this.agents.get(delegation.toAgentId!);
    const endTime = Date.now();
    const startTime = this.delegationStartTimes.get(requestId) ?? endTime;
    const timeSpent = endTime - startTime;
    this.delegationStartTimes.delete(requestId);

    const delResult: DelegationResult = {
      requestId,
      success: !error,
      agentId: delegation.toAgentId!,
      result: error ? undefined : result,
      error,
      timeSpentMs: timeSpent,
    };

    // Review if required
    if (delegation.requireReview && !error) {
      const reviewer = this.findRoleAgent("reviewer");
      if (reviewer) {
        const reviewNotes = `Reviewed by ${reviewer.name}: ${result.slice(0, 100)}...`;
        delResult.reviewNotes = reviewNotes;
        delResult.reviewerId = reviewer.id;
      }
    }

    // Update agent metrics
    if (agent) {
      agent.status = "idle";
      agent.currentTask = undefined;
      agent.metrics.tasksCompleted++;
      const newSuccessCount = agent.metrics.successRate * (agent.metrics.tasksCompleted - 1) + (delResult.success ? 1 : 0);
      agent.metrics.successRate = newSuccessCount / agent.metrics.tasksCompleted;
      agent.metrics.avgResponseTime =
        (agent.metrics.avgResponseTime * (agent.metrics.tasksCompleted - 1) + timeSpent) /
        agent.metrics.tasksCompleted;
      agent.metrics.reliabilityScore = this.calculateReliability(agent);
    }

    this.activeDelegations.delete(requestId);
    this.delegationResults.set(requestId, delResult);

    this.eventBus.publish("swarm:delegation-completed", { result: delResult }, "swarm-orchestrator");

    // Process queued delegations for this agent
    this.processPending(agent?.id);

    return delResult;
  }

  /** Handle a delegation failure or timeout */
  private failDelegation(delegationId: string, error: Error): void {
    const delegation = this.activeDelegations.get(delegationId);
    if (!delegation) return;

    // Clear timeout timer
    const timer = this.delegationTimers.get(delegationId);
    if (timer) { clearTimeout(timer); this.delegationTimers.delete(delegationId); }

    // Mark agent as idle again
    const agent = this.agents.get(delegation.toAgentId!);
    if (agent) agent.status = "idle";

    // Remove from active delegations
    this.activeDelegations.delete(delegationId);
    this.delegationStartTimes.delete(delegationId);

    // Emit failure event
    this.eventBus.publish("swarm:delegation_failed", { delegationId, error: error.message }, "swarm-orchestrator");

    // Process pending delegations
    this.processPending(agent?.id);
  }

  // ── Consensus ───────────────────────────────────────────

  /** Propose a decision to the swarm for consensus */
  proposeConsensus(proposal: Omit<ConsensusProposal, "id">): ConsensusProposal {
    const full: ConsensusProposal = {
      ...proposal,
      id: `proposal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    };

    this.proposals.set(full.id, full);
    this.votes.set(full.id, []);

    this.eventBus.publish("swarm:consensus-proposed", { proposal: full }, "swarm-orchestrator");
    return full;
  }

  /** Cast a vote on a proposal */
  castVote(vote: ConsensusVote): boolean {
    const proposal = this.proposals.get(vote.proposalId);
    if (!proposal) return false;
    if (Date.now() > proposal.deadlineMs) return false;

    const existing = this.votes.get(vote.proposalId) ?? [];
    // Remove previous vote from this voter
    const filtered = existing.filter((v) => v.voterId !== vote.voterId);
    filtered.push(vote);
    this.votes.set(vote.proposalId, filtered);

    this.eventBus.publish("swarm:vote-cast", { vote }, "swarm-orchestrator");

    // Check if consensus is reached
    const onlineAgents = this.getActiveAgents().length;
    // Count votes per option to find the most popular
    const optionCounts = new Map<string, number>();
    for (const v of filtered) {
      optionCounts.set(v.choice, (optionCounts.get(v.choice) || 0) + 1);
    }
    const maxCount = filtered.length > 0 ? Math.max(...optionCounts.values()) : 0;
    const agreementRatio = maxCount / Math.max(onlineAgents, 1);

    if (agreementRatio >= proposal.requiredRatio) {
      return true;
    }

    return false;
  }

  /** Resolve a proposal and return the consensus result */
  resolveConsensus(proposalId: string): ConsensusResult | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return null;

    const allVotes = this.votes.get(proposalId) ?? [];
    const onlineAgents = this.getActiveAgents().length;

    // Count votes per option
    const counts = new Map<string, { votes: number; totalConfidence: number }>();
    for (const option of proposal.options) {
      counts.set(option, { votes: 0, totalConfidence: 0 });
    }
    for (const vote of allVotes) {
      const c = counts.get(vote.choice);
      if (c) {
        c.votes++;
        c.totalConfidence += vote.confidence;
      }
    }

    // agreementRatio = most popular option votes / total online agents
    const maxVoteCount = allVotes.length > 0 ? Math.max(...Array.from(counts.values()).map((c) => c.votes)) : 0;
    const agreementRatio = maxVoteCount / Math.max(onlineAgents, 1);

    // Find winner
    let winner: string | undefined;
    let maxScore = 0;
    let tie = false;
    for (const [option, data] of counts) {
      const score = data.votes + data.totalConfidence * 0.5;
      if (score > maxScore) {
        maxScore = score;
        winner = option;
        tie = false;
      } else if (Math.abs(score - maxScore) < 0.001) {
        tie = true;
      }
    }

    const result: ConsensusResult = {
      proposalId,
      resolved: agreementRatio >= proposal.requiredRatio && !tie,
      winner: tie ? undefined : winner,
      votes: allVotes,
      agreementRatio,
      tieBreaker: tie ? "Proposer decides" : undefined,
    };

    this.eventBus.publish("swarm:consensus-resolved", { result }, "swarm-orchestrator");
    return result;
  }

  // ── Agent Discovery ─────────────────────────────────────

  /** Find the best agent for a given set of capabilities */
  findBestAgent(requiredCapabilities: string[], priority: DelegationRequest["priority"]): SwarmAgent | null {
    const active = this.getActiveAgents();
    const idle = active.filter((a) => a.status === "idle");
    if (idle.length === 0 && active.length === 0) return null;

    const pool = idle.length > 0 ? idle : active;

    // Score each agent
    const scored = pool
      .filter((a) => this.matchesCapabilities(a, requiredCapabilities))
      .map((a) => {
        const capScore = this.countCapabilityMatches(a, requiredCapabilities) / Math.max(requiredCapabilities.length, 1);
        const reliability = a.metrics.reliabilityScore;
        const successRate = a.metrics.successRate;
        return {
          agent: a,
          score: capScore * 0.5 + reliability * 0.3 + successRate * 0.2,
        };
      });

    if (scored.length === 0) {
      // Fallback: find any agent with partial match (at least 1 match)
      const partial = pool
        .map((a) => ({
          agent: a,
          score: this.countCapabilityMatches(a, requiredCapabilities) / Math.max(requiredCapabilities.length, 1),
        }))
        .filter((p) => p.score > 0)
        .sort((a, b) => b.score - a.score);

      return partial[0]?.agent ?? null;
    }

    scored.sort((a, b) => b.score - a.score);
    return scored[0].agent;
  }

  /** Find an agent by role */
  findRoleAgent(role: AgentRole): SwarmAgent | undefined {
    return this.getActiveAgents()
      .filter((a) => a.role === role && a.status === "idle")
      .sort((a, b) => b.metrics.reliabilityScore - a.metrics.reliabilityScore)[0];
  }

  /** Get all active (non-offline) agents */
  getActiveAgents(): SwarmAgent[] {
    const now = Date.now();
    return Array.from(this.agents.values()).filter((a) => {
      const alive = now - a.lastHeartbeat < this.config.heartbeatTimeoutMs;
      if (!alive && a.status !== "offline") {
        a.status = "offline";
      }
      return alive;
    });
  }

  // ── Group Operations ────────────────────────────────────

  /** Broadcast a message to all agents of a specific role */
  broadcastToRole(role: AgentRole, message: string): void {
    const targets = this.getActiveAgents().filter((a) => a.role === role);
    this.eventBus.publish("swarm:broadcast", { role, message, receiverCount: targets.length }, "swarm-orchestrator");
  }

  /** Form a temporary sub-swarm for a complex task */
  formTaskForce(agentIds: string[], leaderId: string, task: string): boolean {
    const leader = this.agents.get(leaderId);
    if (!leader) return false;

    const members = agentIds.filter((id) => this.agents.has(id));
    if (members.length === 0) return false;

    this.eventBus.publish("swarm:taskforce-formed", {
      leader: leader.id,
      members,
      task,
    }, "swarm-orchestrator");

    return true;
  }

  // ── Metrics ─────────────────────────────────────────────

  getSwarmStats(): {
    totalAgents: number;
    activeAgents: number;
    idleAgents: number;
    busyAgents: number;
    offlineAgents: number;
    pendingDelegations: number;
    activeDelegations: number;
    completedDelegations: number;
    avgSuccessRate: number;
    avgResponseTime: number;
  } {
    const all = Array.from(this.agents.values());
    const active = all.filter((a) => a.status !== "offline");

    return {
      totalAgents: all.length,
      activeAgents: active.length,
      idleAgents: active.filter((a) => a.status === "idle").length,
      busyAgents: active.filter((a) => a.status === "busy").length,
      offlineAgents: all.filter((a) => a.status === "offline").length,
      pendingDelegations: this.pendingDelegations.size,
      activeDelegations: this.activeDelegations.size,
      completedDelegations: this.delegationResults.size,
      avgSuccessRate: active.length > 0
        ? active.reduce((s, a) => s + a.metrics.successRate, 0) / active.length
        : 0,
      avgResponseTime: active.length > 0
        ? active.reduce((s, a) => s + a.metrics.avgResponseTime, 0) / active.length
        : 0,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────

  start(): void {
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 5000);
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  shutdown(): void {
    this.stop();
    // Clear all delegation timers
    for (const [, timer] of this.delegationTimers) {
      clearTimeout(timer);
    }
    this.delegationTimers.clear();
    this.agents.clear();
    this.pendingDelegations.clear();
    this.activeDelegations.clear();
    this.delegationResults.clear();
    this.proposals.clear();
    this.votes.clear();
  }

  // ── Internal ────────────────────────────────────────────

  private matchesCapabilities(agent: SwarmAgent, required: string[]): boolean {
    return required.every((cap) =>
      agent.capabilities.some((ac) =>
        ac.toLowerCase().includes(cap.toLowerCase()) || cap.toLowerCase().includes(ac.toLowerCase())
      )
    );
  }

  private countCapabilityMatches(agent: SwarmAgent, required: string[]): number {
    return required.filter((cap) =>
      agent.capabilities.some((ac) =>
        ac.toLowerCase().includes(cap.toLowerCase()) || cap.toLowerCase().includes(ac.toLowerCase())
      )
    ).length;
  }

  private countActiveDelegations(agentId: string): number {
    let count = 0;
    for (const [, d] of this.activeDelegations) {
      if (d.toAgentId === agentId) count++;
    }
    return count;
  }

  private calculateReliability(agent: SwarmAgent): number {
    // Reliability = weighted score from success rate, response consistency, and uptime
    const successScore = agent.metrics.successRate;
    const consistencyScore = agent.metrics.tasksCompleted > 0 ? 1 - (agent.metrics.avgResponseTime / 120000) : 0.5;
    const uptimeScore = agent.status !== "offline" ? 1 : 0;

    return Math.max(0, Math.min(1, successScore * 0.5 + consistencyScore * 0.3 + uptimeScore * 0.2));
  }

  private reassignDelegation(delegation: DelegationRequest): void {
    const best = this.findBestAgent(delegation.requiredCapabilities, delegation.priority);
    if (best) {
      delegation.toAgentId = best.id;
      best.status = "busy";
      best.currentTask = delegation.task;
      this.delegationStartTimes.set(delegation.id, Date.now());
      this.eventBus.publish("swarm:delegation-reassigned", { delegation, newAgent: best.id }, "swarm-orchestrator");
    }
  }

  private processPending(agentId?: string): void {
    if (!agentId) return;

    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== "idle") return;

    for (const [, delegation] of this.pendingDelegations) {
      if (delegation.toAgentId === agentId) {
        this.pendingDelegations.delete(delegation.id);
        agent.status = "busy";
        agent.currentTask = delegation.task;
        this.activeDelegations.set(delegation.id, delegation);
        break;
      }
    }
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    const timeout = this.config.heartbeatTimeoutMs;

    for (const [, agent] of this.agents) {
      if (agent.status !== "offline" && now - agent.lastHeartbeat > timeout) {
        agent.status = "offline";

        // Reassign active tasks
        if (this.config.autoReassign) {
          for (const [, delegation] of this.activeDelegations) {
            if (delegation.toAgentId === agent.id) {
              const best = this.findBestAgent(delegation.requiredCapabilities, delegation.priority);
              if (best) {
                delegation.toAgentId = best.id;
                best.status = "busy";
                this.eventBus.publish("swarm:delegation-reassigned",
                  { delegation, oldAgent: agent.id, newAgent: best.id },
                  "swarm-orchestrator");
              }
            }
          }
        }

        this.eventBus.publish("swarm:agent-offline", { agentId: agent.id }, "swarm-orchestrator");
      }
    }

    // Check for timed-out delegations
    for (const [delegationId, delegation] of this.activeDelegations) {
      const startTime = this.delegationStartTimes.get(delegationId);
      if (startTime) {
        const timeoutMs = delegation.timeoutMs || this.config.defaultTimeoutMs;
        if (now - startTime > timeoutMs) {
          this.failDelegation(delegationId, new Error(`Delegation timed out after ${timeoutMs}ms`));
        }
      }
    }
  }

  /** Get swarm status summary */
  getStatus(): { agentCount: number; activeDelegations: number; agents: Array<{ id: string; name: string; role: string; status: string }> } {
    const agents = Array.from(this.agents.values()).map(a => ({
      id: a.id, name: a.name, role: a.role, status: a.status,
    }));
    return {
      agentCount: this.agents.size,
      activeDelegations: this.activeDelegations.size,
      agents,
    };
  }
}