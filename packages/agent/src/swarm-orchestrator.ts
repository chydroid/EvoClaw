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

// ── Handoff 类型（借鉴 OpenAI Agents SDK 的 handoff 语义） ──

/**
 * Handoff 请求 — 对话控制权转移。
 *
 * 与 delegate 的关键区别：
 * - delegate（agents-as-tools）：调用方保留控制权，被委托方执行后返回结果
 * - handoff：调用方将对话控制权完全转移给目标 agent，自身退出对话
 *
 * 典型场景：客服转接、专家会诊、任务升级
 */
export interface HandoffRequest {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  /** 转接原因 */
  reason: string;
  /** 转接时携带的上下文摘要 */
  contextSummary?: string;
  /** 对话历史（可选，用于目标 agent 续接） */
  conversationHistory?: Array<{ role: string; content: string }>;
  /** 转接时间戳 */
  createdAt: number;
}

/**
 * Handoff 结果
 */
export interface HandoffResult {
  requestId: string;
  success: boolean;
  /** 接管 agent 的 ID */
  receivingAgentId: string;
  /** 转出 agent 的 ID（转出后变为 idle） */
  transferringAgentId: string;
  error?: string;
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
  /** 活跃的 handoff 请求 */
  private activeHandoffs = new Map<string, HandoffRequest>();
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
        this.trimMaps();
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
    // unref 让定时器不阻止进程退出
    timeoutTimer.unref?.();
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
    this.trimMaps();

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

  // ── Handoff（控制权转移，借鉴 OpenAI Agents SDK） ──────

  /**
   * 将对话控制权从一个 agent 转移到另一个 agent。
   *
   * 与 delegate 的关键区别：
   * - delegate（agents-as-tools）：调用方保留控制权，被委托方执行后返回结果
   * - handoff：调用方将对话控制权完全转移给目标 agent，自身退出对话
   *
   * 典型场景：客服转接、专家会诊、任务升级（tier-1 → tier-2 support）
   *
   * 流程：
   * 1. 验证双方 agent 存在且非 offline
   * 2. 转出 agent 标记为 idle（退出当前对话）
   * 3. 转入 agent 接管对话（标记为 busy，记录 contextSummary 与 conversationHistory）
   * 4. 发布 swarm:handoff 事件，供上层（如 SessionManager）切换对话主体
   * 5. 调用方可通过 completeHandoff() 显式结束 handoff 生命周期
   */
  handoff(request: Omit<HandoffRequest, "id" | "createdAt">): HandoffResult {
    const fromAgent = this.agents.get(request.fromAgentId);
    const toAgent = this.agents.get(request.toAgentId);

    if (!fromAgent) {
      return {
        requestId: "",
        success: false,
        receivingAgentId: request.toAgentId,
        transferringAgentId: request.fromAgentId,
        error: `Transferring agent not found: ${request.fromAgentId}`,
      };
    }
    if (!toAgent) {
      return {
        requestId: "",
        success: false,
        receivingAgentId: request.toAgentId,
        transferringAgentId: request.fromAgentId,
        error: `Receiving agent not found: ${request.toAgentId}`,
      };
    }
    if (toAgent.status === "offline") {
      return {
        requestId: "",
        success: false,
        receivingAgentId: request.toAgentId,
        transferringAgentId: request.fromAgentId,
        error: `Receiving agent is offline: ${request.toAgentId}`,
      };
    }
    // 不允许 handoff 给自己（无意义的循环）
    if (request.fromAgentId === request.toAgentId) {
      return {
        requestId: "",
        success: false,
        receivingAgentId: request.toAgentId,
        transferringAgentId: request.fromAgentId,
        error: "Cannot hand off to the same agent",
      };
    }

    const fullRequest: HandoffRequest = {
      ...request,
      id: `handoff_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
    };

    // 转出 agent：标记为 idle（退出当前对话）
    fromAgent.status = "idle";
    fromAgent.currentTask = undefined;

    // 转入 agent：接管对话，标记为 busy
    toAgent.status = "busy";
    toAgent.currentTask = `handoff-receiving: ${request.reason}`;
    // 携带的上下文摘要与会话历史存入 metadata，供接收方读取
    toAgent.metadata = {
      ...(toAgent.metadata ?? {}),
      handoffContext: {
        fromAgentId: request.fromAgentId,
        fromAgentName: fromAgent.name,
        reason: request.reason,
        contextSummary: request.contextSummary,
        conversationHistory: request.conversationHistory,
        receivedAt: fullRequest.createdAt,
      },
    };

    this.activeHandoffs.set(fullRequest.id, fullRequest);
    this.trimMaps();

    this.eventBus.publish(
      "swarm:handoff",
      {
        handoffId: fullRequest.id,
        fromAgentId: request.fromAgentId,
        toAgentId: request.toAgentId,
        reason: request.reason,
        contextSummary: request.contextSummary,
      },
      "swarm-orchestrator",
    );

    return {
      requestId: fullRequest.id,
      success: true,
      receivingAgentId: request.toAgentId,
      transferringAgentId: request.fromAgentId,
    };
  }

  /**
   * 完成 handoff：转入 agent 完成接管工作后调用，清理 activeHandoffs 记录，
   * 将接收 agent 恢复为 idle，并发布 swarm:handoff-completed 事件。
   */
  completeHandoff(handoffId: string): boolean {
    const request = this.activeHandoffs.get(handoffId);
    if (!request) return false;

    const receivingAgent = this.agents.get(request.toAgentId);
    if (receivingAgent) {
      receivingAgent.status = "idle";
      receivingAgent.currentTask = undefined;
      // 清理 handoff 上下文 metadata
      if (receivingAgent.metadata?.handoffContext) {
        const { handoffContext, ...rest } = receivingAgent.metadata;
        receivingAgent.metadata = Object.keys(rest).length > 0 ? rest : undefined;
      }
      // 接收 agent 完成一次任务，更新指标
      receivingAgent.metrics.tasksCompleted++;
      receivingAgent.metrics.reliabilityScore = this.calculateReliability(receivingAgent);
    }

    this.activeHandoffs.delete(handoffId);

    this.eventBus.publish(
      "swarm:handoff-completed",
      {
        handoffId,
        fromAgentId: request.fromAgentId,
        toAgentId: request.toAgentId,
      },
      "swarm-orchestrator",
    );

    return true;
  }

  /** 获取当前活跃的 handoff 请求 */
  getActiveHandoffs(): HandoffRequest[] {
    return Array.from(this.activeHandoffs.values());
  }

  // ── Consensus ───────────────────────────────────────────

  /** Propose a decision to the swarm for consensus */
  proposeConsensus(proposal: Omit<ConsensusProposal, "id">): ConsensusProposal {
    const full: ConsensusProposal = {
      ...proposal,
      id: `proposal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    };

    this.proposals.set(full.id, full);
    this.trimMaps();
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
    const votesCast = filtered.length;
    // Count votes per option to find the most popular
    const optionCounts = new Map<string, number>();
    for (const v of filtered) {
      optionCounts.set(v.choice, (optionCounts.get(v.choice) || 0) + 1);
    }
    const maxCount = votesCast > 0 ? Math.max(...optionCounts.values()) : 0;
    const agreementRatio = maxCount / Math.max(votesCast, 1);

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
    const votesCast = allVotes.length;

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

    // agreementRatio = most popular option votes / total votes cast
    const maxVoteCount = votesCast > 0 ? Math.max(...Array.from(counts.values()).map((c) => c.votes)) : 0;
    const agreementRatio = maxVoteCount / Math.max(votesCast, 1);

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
    // 避免定时器阻止进程退出
    this.heartbeatTimer.unref?.();
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
    this.trimMaps();
    this.agents.clear();
    this.pendingDelegations.clear();
    this.activeDelegations.clear();
    this.delegationResults.clear();
    this.proposals.clear();
    this.votes.clear();
  }

  /** 修剪历史 Maps，防止无限增长 */
  private trimMaps(): void {
    const MAX = 500;
    if (this.delegationResults.size > MAX) {
      const keys = Array.from(this.delegationResults.keys()).slice(0, this.delegationResults.size - MAX);
      for (const k of keys) this.delegationResults.delete(k);
    }
    if (this.proposals.size > MAX) {
      const keys = Array.from(this.proposals.keys()).slice(0, this.proposals.size - MAX);
      for (const k of keys) { this.proposals.delete(k); this.votes.delete(k); }
    }
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

      // 清理旧定时器，避免泄漏（旧定时器仍指向 failDelegation 会在到期后误触发）
      const oldTimer = this.delegationTimers.get(delegation.id);
      if (oldTimer) {
        clearTimeout(oldTimer);
        this.delegationTimers.delete(delegation.id);
      }

      // 设置新的超时定时器（参照 delegate / processPending 的模式）
      // 注意：不重置 delegationStartTimes，保留原始起始时间，让总超时预算不变；
      // 新定时器按剩余时间触发，与 checkHeartbeats 的总预算校验保持一致
      const startTime = this.delegationStartTimes.get(delegation.id) ?? Date.now();
      const timeoutMs = delegation.timeoutMs || this.config.defaultTimeoutMs;
      const remaining = Math.max(0, timeoutMs - (Date.now() - startTime));
      const timeoutTimer = setTimeout(() => {
        this.failDelegation(delegation.id, new Error(`Delegation timed out after ${timeoutMs}ms`));
      }, remaining);
      // 避免定时器阻止进程退出
      timeoutTimer.unref?.();
      this.delegationTimers.set(delegation.id, timeoutTimer);

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
        // 设置超时定时器与起始时间，避免委托永久挂起（与 delegate 方法一致）
        this.delegationStartTimes.set(delegation.id, Date.now());
        const timeoutMs = delegation.timeoutMs || this.config.defaultTimeoutMs;
        const timeoutTimer = setTimeout(() => {
          this.failDelegation(delegation.id, new Error(`Delegation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        // unref 让定时器不阻止进程退出
        timeoutTimer.unref?.();
        this.delegationTimers.set(delegation.id, timeoutTimer);
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

        // Reassign active tasks（委托 reassignDelegation 处理：清理旧定时器、
        // 设置新定时器、更新 best.currentTask，避免内联重分配遗漏）
        if (this.config.autoReassign) {
          for (const [, delegation] of this.activeDelegations) {
            if (delegation.toAgentId === agent.id) {
              this.reassignDelegation(delegation);
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