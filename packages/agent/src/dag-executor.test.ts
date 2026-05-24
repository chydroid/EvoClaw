import { describe, it, expect, vi, beforeEach } from "vitest";
import { DAGExecutor } from "./dag-executor";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import type { Task, DAGNode } from "@evoclaw/core";

function makeNode(id: string, deps: string[] = [], action?: string): DAGNode {
  return { id, dependencies: deps, action: action ?? `action-${id}`, params: {} };
}

function makeTask(nodes: DAGNode[]): Task {
  return {
    id: "task-1",
    dag: nodes,
    context: { sessionId: "s1" },
    priority: "normal",
    createdAt: new Date(),
    status: "pending",
    type: "dag",
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
      { id: "a", dependencies: [], action: "run", skill: "failing-skill", params: {} },
    ];
    const task = makeTask(nodes);

    await expect(executor.executeDAG(task)).rejects.toThrow("Skill failed");
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
      { id: "a", dependencies: [], action: "run", skill: "my-skill", params: { key: "val" } },
    ];
    const task = makeTask(nodes);
    const result = await executor.executeDAG(task);

    expect(skillExecuted).toHaveBeenCalledWith("my-skill", { key: "val" });
    expect(result.steps[0].status).toBe("completed");
  });
});