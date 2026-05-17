import { describe, it, expect } from "vitest";
import { KnowledgeGraphStore } from "./knowledge-graph";

describe("KnowledgeGraphStore", () => {
  it("should add and retrieve nodes", async () => {
    const kg = new KnowledgeGraphStore();

    await kg.addNode({ id: "n1", type: "person", properties: { name: "Alice" }, labels: ["user"] });
    await kg.addNode({ id: "n2", type: "person", properties: { name: "Bob" }, labels: ["user"] });
    await kg.addNode({ id: "n3", type: "project", properties: { name: "EcoClaw" }, labels: ["repo"] });

    const node = await kg.getNode("n1");
    expect(node).toBeDefined();
    expect(node!.properties).toEqual({ name: "Alice" });
  });

  it("should add edges between nodes", async () => {
    const kg = new KnowledgeGraphStore();

    await kg.addNode({ id: "n1", type: "person", properties: {}, labels: ["user"] });
    await kg.addNode({ id: "n2", type: "person", properties: {}, labels: ["user"] });

    await kg.addEdge({ from: "n1", to: "n2", type: "follows", properties: {} });

    const edges = await kg.findEdges("n1");
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("follows");
  });

  it("should filter by edge type", async () => {
    const kg = new KnowledgeGraphStore();

    await kg.addNode({ id: "n1", type: "person", properties: {}, labels: ["user"] });
    await kg.addNode({ id: "n2", type: "person", properties: {}, labels: ["user"] });
    await kg.addNode({ id: "n3", type: "project", properties: {}, labels: ["repo"] });

    await kg.addEdge({ from: "n1", to: "n2", type: "follows", properties: {} });
    await kg.addEdge({ from: "n1", to: "n3", type: "contributes", properties: {} });

    const follows = await kg.findEdges("n1", "follows");
    expect(follows).toHaveLength(1);

    const all = await kg.findEdges("n1");
    expect(all).toHaveLength(2);
  });

  it("should query nodes by type", async () => {
    const kg = new KnowledgeGraphStore();

    await kg.addNode({ id: "n1", type: "person", properties: {}, labels: ["user"] });
    await kg.addNode({ id: "n2", type: "person", properties: {}, labels: ["user"] });
    await kg.addNode({ id: "n3", type: "project", properties: {}, labels: ["repo"] });

    const result = await kg.query({
      pattern: "person",
      params: { type: "person" },
    });

    expect(result.nodes).toHaveLength(2);
  });

  it("should query nodes by label", async () => {
    const kg = new KnowledgeGraphStore();

    await kg.addNode({ id: "n1", type: "doc", properties: {}, labels: ["important", "active"] });
    await kg.addNode({ id: "n2", type: "doc", properties: {}, labels: ["archived"] });

    const result = await kg.query({
      pattern: "label",
      params: { label: "important" },
    });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe("n1");
  });

  it("should delete nodes and their edges", async () => {
    const kg = new KnowledgeGraphStore();

    await kg.addNode({ id: "n1", type: "person", properties: {}, labels: ["user"] });
    await kg.addNode({ id: "n2", type: "person", properties: {}, labels: ["user"] });

    await kg.addEdge({ from: "n1", to: "n2", type: "knows", properties: {} });
    await kg.addEdge({ from: "n2", to: "n1", type: "knows", properties: {} });

    await kg.deleteNode("n1");
    expect(await kg.getNode("n1")).toBeUndefined();

    const edges = await kg.findEdges("n2");
    expect(edges).toHaveLength(0);
  });

  it("should find nodes by label", async () => {
    const kg = new KnowledgeGraphStore();

    await kg.addNode({ id: "n1", type: "skill", properties: {}, labels: ["weather", "active"] });
    await kg.addNode({ id: "n2", type: "skill", properties: {}, labels: ["calculator", "active"] });
    await kg.addNode({ id: "n3", type: "skill", properties: {}, labels: ["weather", "disabled"] });

    const activeSkills = await kg.findNodes("active");
    expect(activeSkills).toHaveLength(2);

    const weatherSkills = await kg.findNodes("weather");
    expect(weatherSkills).toHaveLength(2);
  });
});