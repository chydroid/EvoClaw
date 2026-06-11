import { describe, it, expect, vi, beforeEach } from "vitest";
import { DAGExecutor } from "./dag-executor";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import type { Task, DAGNode } from "@evoclaw/core";
import type { ExecutionPlan } from "./planning-engine";

function makeNode(id: string, deps: string[] = [], action?: string): DAGNode {
  return { id, dependencies: deps, action: action ?? `action-${id}`, params: {}, timeout: 60000 };
}

function makeTask(nodes: DAGNode[]): Task {
  return {
    id: "task-1",
    dag: nodes,
    context: { sessionId: "s1", userId: "", workspace: "", variables: {}, tags: [], traceId: "" },
    priority: "normal",
    createdAt: new Date(),
    status: "pending",
    type: "automation",
    input: {},
    output: null,
    executionPlan: [],
    updatedAt: new Date(),
    completedAt: null,
    retryCount: 0,
    maxRetries: 0,
  };
}

describe("DAGExecutor", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let executor: DAGExecutor;

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    executor = new DAGExecutor(registry, eventBus);
  });

  it("should execute a single-node DAG", async () => {
    const task = makeTask([makeNode("a")]);
    const result = await executor.executeDAG(task);
    expect(result.output.dagCompleted).toBe(true);
    expect(result.output.nodeCount).toBe(1);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].nodeId).toBe("a");
    expect(result.steps[0].status).toBe("completed");
  });

  it("should execute nodes in dependency order", async () => {
    // a → b → c
    const nodes: DAGNode[] = [
      makeNode("a"),
      makeNode("b", ["a"]),
      makeNode("c", ["b"]),
    ];
    const task = makeTask(nodes);
    const result = await executor.executeDAG(task);

    expect(result.steps).toHaveLength(3);
    const ids = result.steps.map((s) => s.nodeId);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("should handle diamond-shaped DAG", async () => {
    // a → b → d
    // a → c → d
    const nodes: DAGNode[] = [
      makeNode("a"),
      makeNode("b", ["a"]),
      makeNode("c", ["a"]),
      makeNode("d", ["b", "c"]),
    ];
    const task = makeTask(nodes);
    const result = await executor.executeDAG(task);

    const completed = result.steps.filter((s) => s.status === "completed");
    expect(completed).toHaveLength(4);
    // d must be last
    const lastNode = result.steps[result.steps.length - 1];
    expect(lastNode.nodeId).toBe("d");
  });

  it("should propagate errors from failed nodes", async () => {
    // Register a skill that throws to simulate node failure
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockRejectedValue(new Error("Skill failed")),
    });

    const nodes: DAGNode[] = [
      { id: "a", dependencies: [], action: "run", skill: "failing-skill", params: {}, timeout: 60000 },
    ];
    const task = makeTask(nodes);

    const result = await executor.executeDAG(task);
    // With retry=0 and no throw, the node should be marked as failed
    expect(result.steps[0].status).toBe("failed");
    expect(result.steps[0].error).toBe("Skill failed");
  });

  it("should throw on circular dependency", async () => {
    // a → b → a (cycle)
    const nodes: DAGNode[] = [
      makeNode("a", ["b"]),
      makeNode("b", ["a"]),
    ];
    const task = makeTask(nodes);

    await expect(executor.executeDAG(task)).rejects.toThrow("DAG contains a cycle");
  });

  it("should handle self-referencing node", async () => {
    const nodes: DAGNode[] = [
      makeNode("a", ["a"]), // self-reference is a cycle
    ];
    const task = makeTask(nodes);
    await expect(executor.executeDAG(task)).rejects.toThrow("DAG contains a cycle");
  });

  it("should execute independent nodes in topological order", async () => {
    const nodes: DAGNode[] = [
      makeNode("a"),
      makeNode("b"),
      makeNode("c"),
    ];
    const task = makeTask(nodes);
    const result = await executor.executeDAG(task);
    expect(result.steps).toHaveLength(3);
    const ids = result.steps.map((s) => s.nodeId);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
  });

  it("should execute skill nodes via skillManager", async () => {
    const skillExecuted = vi.fn().mockResolvedValue({ output: "skill-result" });
    registry.registerService("skillManager", {
      executeSkill: skillExecuted,
    });

    const nodes: DAGNode[] = [
      { id: "a", dependencies: [], action: "run", skill: "my-skill", params: { key: "val" }, timeout: 60000 },
    ];
    const task = makeTask(nodes);
    const result = await executor.executeDAG(task);

    expect(skillExecuted).toHaveBeenCalledWith("my-skill", { key: "val" });
    expect(result.steps[0].status).toBe("completed");
  });

  // ── Parallel execution ──

  it("should execute independent nodes concurrently (parallel execution)", async () => {
    const startTimes: Record<string, number> = {};

    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockImplementation(async (name: string) => {
        startTimes[name] = Date.now();
        // Simulate work taking 100ms
        await new Promise((r) => setTimeout(r, 100));
        return { done: true };
      }),
    });

    const nodes: DAGNode[] = [
      { id: "a", dependencies: [], action: "run", skill: "skill-a", params: {}, timeout: 60000 },
      { id: "b", dependencies: [], action: "run", skill: "skill-b", params: {}, timeout: 60000 },
    ];
    const task = makeTask(nodes);
    const result = await executor.executeDAG(task);

    expect(result.steps).toHaveLength(2);
    expect(result.steps.every((s) => s.status === "completed")).toBe(true);

    // Both nodes should have started within 50ms of each other (parallel)
    const diff = Math.abs(startTimes["skill-a"] - startTimes["skill-b"]);
    expect(diff).toBeLessThan(50);
  });

  // ── Conditional branching ──

  it("should skip a node when condition evaluates to false", async () => {
    const nodes: DAGNode[] = [
      makeNode("a"),
      { id: "b", dependencies: ["a"], action: "action-b", params: {}, timeout: 60000, condition: "false" },
      makeNode("c", ["a"]),
    ];
    const task = makeTask(nodes);
    const result = await executor.executeDAG(task);

    const nodeB = result.steps.find((s) => s.nodeId === "b");
    expect(nodeB?.status).toBe("skipped");

    const nodeA = result.steps.find((s) => s.nodeId === "a");
    const nodeC = result.steps.find((s) => s.nodeId === "c");
    expect(nodeA?.status).toBe("completed");
    expect(nodeC?.status).toBe("completed");
  });

  it("should execute a node when condition evaluates to true", async () => {
    const nodes: DAGNode[] = [
      { id: "a", dependencies: [], action: "action-a", params: {}, timeout: 60000, condition: "true" },
    ];
    const task = makeTask(nodes);
    const result = await executor.executeDAG(task);

    expect(result.steps[0].status).toBe("completed");
  });

  it("should evaluate condition using context variables", async () => {
    const task: Task = {
      id: "task-1",
      dag: [
        { id: "a", dependencies: [], action: "action-a", params: {}, timeout: 60000, condition: "sessionId === 's1'" },
        { id: "b", dependencies: [], action: "action-b", params: {}, timeout: 60000, condition: "sessionId === 'wrong'" },
      ],
      context: { sessionId: "s1", userId: "", workspace: "", variables: {}, tags: [], traceId: "" },
      priority: "normal",
      createdAt: new Date(),
      status: "pending",
      type: "automation",
      input: {},
      output: null,
      executionPlan: [],
      updatedAt: new Date(),
      completedAt: null,
      retryCount: 0,
      maxRetries: 0,
    };

    const result = await executor.executeDAG(task);
    const nodeA = result.steps.find((s) => s.nodeId === "a");
    const nodeB = result.steps.find((s) => s.nodeId === "b");
    expect(nodeA?.status).toBe("completed");
    expect(nodeB?.status).toBe("skipped");
  });

  // ── Node retry ──

  it("should retry a failing node up to retryCount times", async () => {
    let callCount = 0;
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error("Transient failure");
        }
        return { success: true };
      }),
    });

    const nodes: DAGNode[] = [
      { id: "a", dependencies: [], action: "run", skill: "retry-skill", params: {}, timeout: 60000, retryCount: 3, retryDelay: 10 },
    ];
    const task = makeTask(nodes);
    const result = await executor.executeDAG(task);

    const nodeA = result.steps.find((s) => s.nodeId === "a");
    expect(nodeA?.status).toBe("completed");
    expect(nodeA?.attempt).toBe(3);
  });

  it("should mark node as failed after exhausting retries", async () => {
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockRejectedValue(new Error("Permanent failure")),
    });

    const nodes: DAGNode[] = [
      { id: "a", dependencies: [], action: "run", skill: "fail-skill", params: {}, timeout: 60000, retryCount: 2, retryDelay: 10 },
    ];
    const task = makeTask(nodes);
    const result = await executor.executeDAG(task);

    const nodeA = result.steps.find((s) => s.nodeId === "a");
    expect(nodeA?.status).toBe("failed");
    expect(nodeA?.attempt).toBe(3); // 1 initial + 2 retries
    expect(nodeA?.error).toBe("Permanent failure");
  });

  // ── Node timeout ──

  it("should fail a node that exceeds its timeout", async () => {
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 5000)); // takes 5s
        return { done: true };
      }),
    });

    const nodes: DAGNode[] = [
      { id: "a", dependencies: [], action: "run", skill: "slow-skill", params: {}, timeout: 60000, timeoutMs: 50 },
    ];
    const task = makeTask(nodes);
    const result = await executor.executeDAG(task);

    const nodeA = result.steps.find((s) => s.nodeId === "a");
    expect(nodeA?.status).toBe("failed");
    expect(nodeA?.error).toContain("timed out");
  });

  it("should complete a node that finishes within its timeout", async () => {
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10)); // fast
        return { done: true };
      }),
    });

    const nodes: DAGNode[] = [
      { id: "a", dependencies: [], action: "run", skill: "fast-skill", params: {}, timeout: 60000, timeoutMs: 5000 },
    ];
    const task = makeTask(nodes);
    const result = await executor.executeDAG(task);

    const nodeA = result.steps.find((s) => s.nodeId === "a");
    expect(nodeA?.status).toBe("completed");
  });

  // ── fromExecutionPlan ──

  it("should convert an ExecutionPlan to a Task via fromExecutionPlan", () => {
    const plan: ExecutionPlan = {
      id: "plan-1",
      goal: "Test goal",
      steps: [
        { id: "step-1", description: "First step", toolHint: "search", dependsOn: [], status: "pending" },
        { id: "step-2", description: "Second step", toolHint: "analyze", dependsOn: ["step-1"], status: "pending" },
      ],
      createdAt: Date.now(),
      status: "draft",
      replanCount: 0,
    };

    const task = executor.fromExecutionPlan(plan);

    expect(task.id).toBe("plan-1");
    expect(task.type).toBe("automation");
    expect(task.dag).toHaveLength(2);
    expect(task.dag[0].id).toBe("step-1");
    expect(task.dag[0].action).toBe("First step");
    expect(task.dag[0].skill).toBe("search");
    expect(task.dag[0].dependencies).toEqual([]);
    expect(task.dag[1].id).toBe("step-2");
    expect(task.dag[1].dependencies).toEqual(["step-1"]);
  });

  it("should execute a DAG produced from fromExecutionPlan", async () => {
    const plan: ExecutionPlan = {
      id: "plan-2",
      goal: "Execute plan",
      steps: [
        { id: "s1", description: "Step 1", status: "pending" },
        { id: "s2", description: "Step 2", dependsOn: ["s1"], status: "pending" },
      ],
      createdAt: Date.now(),
      status: "draft",
      replanCount: 0,
    };

    const task = executor.fromExecutionPlan(plan);
    const result = await executor.executeDAG(task);

    expect(result.output.dagCompleted).toBe(true);
    expect(result.steps).toHaveLength(2);
    const ids = result.steps.map((s) => s.nodeId);
    expect(ids).toEqual(["s1", "s2"]);
  });

  // ── Dependency on skipped node ──

  it("should mark dependent node as waiting_dependency when dependency is skipped", async () => {
    const nodes: DAGNode[] = [
      { id: "a", dependencies: [], action: "action-a", params: {}, timeout: 60000, condition: "false" },
      { id: "b", dependencies: ["a"], action: "action-b", params: {}, timeout: 60000 },
    ];
    const task = makeTask(nodes);
    const result = await executor.executeDAG(task);

    const nodeA = result.steps.find((s) => s.nodeId === "a");
    const nodeB = result.steps.find((s) => s.nodeId === "b");
    expect(nodeA?.status).toBe("skipped");
    expect(nodeB?.status).toBe("waiting_dependency");
  });
});
