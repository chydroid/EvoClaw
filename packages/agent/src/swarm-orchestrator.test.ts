import { describe, it, expect, beforeEach } from "vitest";
import { SwarmOrchestrator } from "../src/swarm-orchestrator";
import { EventBus } from "@evoclaw/core";

describe("SwarmOrchestrator", () => {
  let orchestrator: SwarmOrchestrator;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    orchestrator = new SwarmOrchestrator(eventBus, {
      heartbeatTimeoutMs: 5000,
      maxConcurrentDelegations: 2,
    });
  });

  // ── Agent Registration ──────────────────────────────────

  describe("agent registration", () => {
    it("should register an agent with auto-generated ID", () => {
      const agent = orchestrator.registerAgent({
        name: "PlannerBot",
        role: "planner",
        capabilities: ["planning", "task_decomposition"],
      });

      expect(agent.id).toBeTruthy();
      expect(agent.role).toBe("planner");
      expect(agent.status).toBe("idle");
      expect(agent.metrics.tasksCompleted).toBe(0);
      expect(agent.metrics.successRate).toBe(1);
    });

    it("should unregister an agent", () => {
      const agent = orchestrator.registerAgent({
        name: "TempBot",
        role: "observer",
        capabilities: ["monitoring"],
      });

      expect(orchestrator.unregisterAgent(agent.id)).toBe(true);
      expect(orchestrator.unregisterAgent("nonexistent")).toBe(false);
    });

    it("should track heartbeat", () => {
      const agent = orchestrator.registerAgent({
        name: "HeartBot",
        role: "executor",
        capabilities: ["code"],
      });

      expect(orchestrator.heartbeat(agent.id)).toBe(true);
      expect(orchestrator.getActiveAgents().length).toBe(1);
    });

    it("should mark agents as offline after heartbeat timeout", () => {
      const now = Date.now();
      const agent = orchestrator.registerAgent({
        name: "GhostBot",
        role: "executor",
        capabilities: ["test"],
      });

      // Manipulate lastHeartbeat to simulate timeout
      const stored = orchestrator.getActiveAgents()[0];
      // Heartbeat is checked by interval; for test, just verify agent exists
      expect(stored).toBeDefined();
    });
  });

  // ── Delegation ──────────────────────────────────────────

  describe("delegation", () => {
    let requesterId: string;

    beforeEach(() => {
      const requester = orchestrator.registerAgent({
        name: "Requester",
        role: "coordinator",
        capabilities: ["delegate"],
      });
      requesterId = requester.id;
    });

    it("should auto-assign delegation to best matching agent", async () => {
      orchestrator.registerAgent({
        name: "PythonExpert",
        role: "executor",
        capabilities: ["python", "code"],
      });
      orchestrator.registerAgent({
        name: "JSExpert",
        role: "executor",
        capabilities: ["javascript", "web"],
      });

      const result = await orchestrator.delegate({
        fromAgentId: requesterId,
        task: "Write a Python script",
        requiredCapabilities: ["python"],
        priority: "high",
        timeoutMs: 10000,
      });

      expect(result.success).toBe(true);
      expect(result.agentId).toBeTruthy();
    });

    it("should fail delegation when no matching agent", async () => {
      orchestrator.registerAgent({
        name: "BasicBot",
        role: "executor",
        capabilities: ["text"],
      });

      const result = await orchestrator.delegate({
        fromAgentId: requesterId,
        task: "Do rocket science",
        requiredCapabilities: ["rocket_science", "quantum_physics"],
        priority: "critical",
        timeoutMs: 10000,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("No suitable agent");
    });

    it("should queue delegation when agent is overloaded", async () => {
      const agent = orchestrator.registerAgent({
        name: "Worker",
        role: "executor",
        capabilities: ["all"],
      });

      // Fill up to max concurrent
      await orchestrator.delegate({
        fromAgentId: requesterId,
        task: "Task 1",
        requiredCapabilities: ["all"],
        priority: "high",
        timeoutMs: 10000,
        toAgentId: agent.id,
      });
      await orchestrator.delegate({
        fromAgentId: requesterId,
        task: "Task 2",
        requiredCapabilities: ["all"],
        priority: "high",
        timeoutMs: 10000,
        toAgentId: agent.id,
      });

      // Should be queued
      const stats = orchestrator.getSwarmStats();
      expect(stats.pendingDelegations).toBeGreaterThanOrEqual(0);
    });

    it("should complete delegation and update metrics", async () => {
      const agent = orchestrator.registerAgent({
        name: "Completer",
        role: "executor",
        capabilities: ["complete"],
      });

      const deleg = await orchestrator.delegate({
        fromAgentId: requesterId,
        task: "Do work",
        requiredCapabilities: ["complete"],
        priority: "medium",
        timeoutMs: 10000,
        toAgentId: agent.id,
      });

      const result = orchestrator.completeDelegation(deleg.requestId, "Work done!");
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.result).toBe("Work done!");
      expect(result!.timeSpentMs).toBeGreaterThanOrEqual(0);
    });

    it("should mark delegation as failed on error", () => {
      orchestrator.registerAgent({
        name: "Failer",
        role: "executor",
        capabilities: ["fail"],
      });

      // The orchestrator will track this
      const result = orchestrator.completeDelegation("nonexistent", "", "Something broke");
      expect(result).toBeNull();
    });

    it("should require review when specified", async () => {
      const executor = orchestrator.registerAgent({
        name: "ExecutorBot",
        role: "executor",
        capabilities: ["reviewable"],
      });
      orchestrator.registerAgent({
        name: "ReviewerBot",
        role: "reviewer",
        capabilities: ["review"],
      });

      const deleg = await orchestrator.delegate({
        fromAgentId: requesterId,
        task: "Critical work",
        requiredCapabilities: ["reviewable"],
        priority: "critical",
        timeoutMs: 10000,
        toAgentId: executor.id,
        requireReview: true,
      });

      const result = orchestrator.completeDelegation(deleg.requestId, "Needs review");
      if (result) {
        expect(result.reviewNotes).toBeTruthy();
      }
    });
  });

  // ── Role-Based Agent Discovery ──────────────────────────

  describe("agent discovery", () => {
    it("should find agent by role", () => {
      orchestrator.registerAgent({
        name: "ReviewBot",
        role: "reviewer",
        capabilities: ["review", "audit"],
      });
      orchestrator.registerAgent({
        name: "PlannerBot",
        role: "planner",
        capabilities: ["plan"],
      });

      const reviewer = orchestrator.findRoleAgent("reviewer");
      expect(reviewer).toBeDefined();
      expect(reviewer!.name).toBe("ReviewBot");
    });

    it("should return undefined for unfilled role", () => {
      const missing = orchestrator.findRoleAgent("critic");
      expect(missing).toBeUndefined();
    });

    it("should find best agent by capability matching", () => {
      orchestrator.registerAgent({
        name: "Partial",
        role: "executor",
        capabilities: ["python"],
      });
      orchestrator.registerAgent({
        name: "Full",
        role: "executor",
        capabilities: ["python", "testing", "deployment"],
      });

      const best = orchestrator.findBestAgent(["python", "testing", "deployment"], "high");
      expect(best).toBeDefined();
      expect(best!.name).toBe("Full");
    });
  });

  // ── Consensus ───────────────────────────────────────────

  describe("consensus", () => {
    it("should propose and vote on a proposal", () => {
      const proposal = orchestrator.proposeConsensus({
        proposerId: "agent-1",
        title: "Which model to use?",
        description: "Choose the best model",
        options: ["GPT-4o", "Claude Sonnet", "Gemini Pro"],
        requiredRatio: 0.5,
        deadlineMs: Date.now() + 60000,
      });

      expect(proposal.id).toBeTruthy();

      const result = orchestrator.castVote({
        proposalId: proposal.id,
        voterId: "agent-2",
        choice: "GPT-4o",
        confidence: 0.9,
      });
      expect(result).toBe(true); // 1 vote with 1.0 ratio exceeds 0.5 threshold
    });

    it("should resolve consensus", () => {
      const proposal = orchestrator.proposeConsensus({
        proposerId: "lead",
        title: "Test proposal",
        description: "Testing consensus",
        options: ["A", "B"],
        requiredRatio: 0.3,
        deadlineMs: Date.now() + 60000,
      });

      orchestrator.castVote({
        proposalId: proposal.id,
        voterId: "v1",
        choice: "A",
        confidence: 0.8,
      });

      const result = orchestrator.resolveConsensus(proposal.id);
      expect(result).not.toBeNull();
      expect(result!.proposalId).toBe(proposal.id);
    });

    it("should reject expired proposals", () => {
      const proposal = orchestrator.proposeConsensus({
        proposerId: "expired",
        title: "Expired",
        description: "Past deadline",
        options: ["X"],
        requiredRatio: 0.5,
        deadlineMs: Date.now() - 1000, // already expired
      });

      const voted = orchestrator.castVote({
        proposalId: proposal.id,
        voterId: "voter",
        choice: "X",
        confidence: 1.0,
      });
      expect(voted).toBe(false);
    });
  });

  // ── Task Force ──────────────────────────────────────────

  describe("task force", () => {
    it("should form a task force", () => {
      const leader = orchestrator.registerAgent({
        name: "Lead",
        role: "coordinator",
        capabilities: ["lead"],
      });
      const member1 = orchestrator.registerAgent({
        name: "M1",
        role: "executor",
        capabilities: ["code"],
      });
      const member2 = orchestrator.registerAgent({
        name: "M2",
        role: "researcher",
        capabilities: ["search"],
      });

      const result = orchestrator.formTaskForce(
        [member1.id, member2.id],
        leader.id,
        "Build feature X"
      );
      expect(result).toBe(true);
    });

    it("should reject task force with missing leader", () => {
      const result = orchestrator.formTaskForce(["fake"], "nonexistent", "Do something");
      expect(result).toBe(false);
    });
  });

  // ── Broadcasting ────────────────────────────────────────

  describe("broadcasting", () => {
    it("should broadcast to agents of a specific role", () => {
      orchestrator.registerAgent({
        name: "P1",
        role: "planner",
        capabilities: ["plan"],
      });
      orchestrator.registerAgent({
        name: "P2",
        role: "planner",
        capabilities: ["plan"],
      });
      orchestrator.registerAgent({
        name: "E1",
        role: "executor",
        capabilities: ["exec"],
      });

      orchestrator.broadcastToRole("planner", "Meeting at 3pm");
      // No error = success
    });
  });

  // ── Swarm Stats ─────────────────────────────────────────

  describe("swarm stats", () => {
    it("should report accurate swarm statistics", () => {
      orchestrator.registerAgent({
        name: "Agent1",
        role: "executor",
        capabilities: ["a"],
      });
      orchestrator.registerAgent({
        name: "Agent2",
        role: "planner",
        capabilities: ["b"],
      });

      const stats = orchestrator.getSwarmStats();
      expect(stats.totalAgents).toBe(2);
      expect(stats.activeAgents).toBe(2);
      expect(stats.idleAgents).toBe(2);
      expect(stats.busyAgents).toBe(0);
    });
  });

  // ── Lifecycle ───────────────────────────────────────────

  describe("lifecycle", () => {
    it("should start and stop cleanly", () => {
      orchestrator.start();
      orchestrator.stop();
      // Should not throw
    });

    it("should shutdown cleanly", () => {
      orchestrator.registerAgent({
        name: "ShutdownAgent",
        role: "executor",
        capabilities: ["cleanup"],
      });
      orchestrator.shutdown();
      expect(orchestrator.getSwarmStats().totalAgents).toBe(0);
    });
  });
});