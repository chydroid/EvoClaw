/**
 * canvas-agent-ops 测试 — 8 种原子操作 + 纯函数 reducer。
 *
 * 借鉴 Infinite-Canvas 的 applyCanvasAgentOps 测试思路。
 */
import { describe, it, expect } from "vitest";
import {
  applyCanvasAgentOps,
  batchAddToolNodes,
  chainConnectOps,
  summarizeCanvasAgentOps,
  type CanvasAgentOp,
} from "./canvas-agent-ops";
import type { CanvasNode, CanvasEdge } from "./symbolic-memory-canvas";

function makeCanvas(nodes: CanvasNode[], edges: CanvasEdge[] = []) {
  return { nodes, edges };
}

describe("canvas-agent-ops.applyCanvasAgentOps", () => {
  it("add_node 新增节点", () => {
    const result = applyCanvasAgentOps(makeCanvas([]), [
      { type: "add_node", label: "测试节点" },
    ]);
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].label).toBe("测试节点");
    expect(result.nodes[0].type).toBe("tool_call"); // 默认类型
  });

  it("add_node 指定 id（幂等：已存在则跳过）", () => {
    const existing: CanvasNode[] = [{ id: "n1", type: "tool_call", label: "old" }];
    const result = applyCanvasAgentOps(makeCanvas(existing), [
      { type: "add_node", id: "n1", label: "new" },
    ]);
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].label).toBe("old"); // 不覆盖
  });

  it("add_node 标签超 80 字符被截断", () => {
    const longLabel = "a".repeat(100);
    const result = applyCanvasAgentOps(makeCanvas([]), [
      { type: "add_node", label: longLabel },
    ]);
    expect(result.nodes[0].label.length).toBe(80);
    expect(result.nodes[0].label.endsWith("...")).toBe(true);
  });

  it("update_node 浅合并 label 和 metadata", () => {
    const existing: CanvasNode[] = [{
      id: "n1", type: "tool_call", label: "old",
      metadata: { toolName: "click", duration: 100 },
    }];
    const result = applyCanvasAgentOps(makeCanvas(existing), [
      { type: "update_node", id: "n1", label: "new", metadata: { duration: 200 } },
    ]);
    expect(result.nodes[0].label).toBe("new");
    expect(result.nodes[0].metadata?.toolName).toBe("click"); // 保留原 metadata
    expect(result.nodes[0].metadata?.duration).toBe(200); // 合并新 metadata
  });

  it("delete_node 按 id 删除", () => {
    const existing: CanvasNode[] = [
      { id: "n1", type: "tool_call", label: "a" },
      { id: "n2", type: "result", label: "b" },
    ];
    const result = applyCanvasAgentOps(makeCanvas(existing), [
      { type: "delete_node", id: "n1" },
    ]);
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].id).toBe("n2");
  });

  it("delete_node 按 ids 批量删除", () => {
    const existing: CanvasNode[] = [
      { id: "n1", type: "tool_call", label: "a" },
      { id: "n2", type: "result", label: "b" },
      { id: "n3", type: "error", label: "c" },
    ];
    const result = applyCanvasAgentOps(makeCanvas(existing), [
      { type: "delete_node", ids: ["n1", "n3"] },
    ]);
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].id).toBe("n2");
  });

  it("delete_node 按 nodeType 删除", () => {
    const existing: CanvasNode[] = [
      { id: "n1", type: "tool_call", label: "a" },
      { id: "n2", type: "result", label: "b" },
      { id: "n3", type: "tool_call", label: "c" },
    ];
    const result = applyCanvasAgentOps(makeCanvas(existing), [
      { type: "delete_node", nodeType: "tool_call" },
    ]);
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].type).toBe("result");
  });

  it("delete_node 同时清理相关 edges", () => {
    const existing: CanvasNode[] = [
      { id: "n1", type: "tool_call", label: "a" },
      { id: "n2", type: "tool_call", label: "b" },
    ];
    const existingEdges: CanvasEdge[] = [{ from: "n1", to: "n2" }];
    const result = applyCanvasAgentOps(makeCanvas(existing, existingEdges), [
      { type: "delete_node", id: "n1" },
    ]);
    expect(result.edges.length).toBe(0);
  });

  it("delete_connections all 清空连线", () => {
    const existing: CanvasNode[] = [
      { id: "n1", type: "tool_call", label: "a" },
      { id: "n2", type: "tool_call", label: "b" },
    ];
    const existingEdges: CanvasEdge[] = [
      { from: "n1", to: "n2" },
      { from: "n2", to: "n1" },
    ];
    const result = applyCanvasAgentOps(makeCanvas(existing, existingEdges), [
      { type: "delete_connections", all: true },
    ]);
    expect(result.edges.length).toBe(0);
  });

  it("connect_nodes 校验两端节点存在", () => {
    const existing: CanvasNode[] = [
      { id: "n1", type: "tool_call", label: "a" },
    ];
    const result = applyCanvasAgentOps(makeCanvas(existing), [
      { type: "connect_nodes", fromNodeId: "n1", toNodeId: "n999" },
    ]);
    expect(result.edges.length).toBe(0); // 不存在的节点不连线
  });

  it("connect_nodes 去重（同 from+to 不重复连线）", () => {
    const existing: CanvasNode[] = [
      { id: "n1", type: "tool_call", label: "a" },
      { id: "n2", type: "tool_call", label: "b" },
    ];
    const ops: CanvasAgentOp[] = [
      { type: "connect_nodes", fromNodeId: "n1", toNodeId: "n2" },
      { type: "connect_nodes", fromNodeId: "n1", toNodeId: "n2" },
    ];
    const result = applyCanvasAgentOps(makeCanvas(existing), ops);
    expect(result.edges.length).toBe(1);
  });

  it("set_viewport 更新视口", () => {
    const result = applyCanvasAgentOps(makeCanvas([]), [
      { type: "set_viewport", viewport: { x: 100, y: 200, k: 1.5 } },
    ]);
    expect(result.viewport).toEqual({ x: 100, y: 200, k: 1.5 });
  });

  it("select_nodes 过滤掉不存在的 id", () => {
    const existing: CanvasNode[] = [
      { id: "n1", type: "tool_call", label: "a" },
    ];
    const result = applyCanvasAgentOps(makeCanvas(existing), [
      { type: "select_nodes", ids: ["n1", "n999"] },
    ]);
    expect(result.selectedNodeIds).toEqual(["n1"]);
  });

  it("run_generation 不修改画布（仅声明性意图）", () => {
    const existing: CanvasNode[] = [
      { id: "n1", type: "result", label: "a" },
    ];
    const result = applyCanvasAgentOps(makeCanvas(existing), [
      { type: "run_generation", nodeId: "n1", mode: "image" },
    ]);
    expect(result.nodes.length).toBe(1); // 不变
  });

  it("组合操作：批量添加 + 连接 + 选中", () => {
    const ops: CanvasAgentOp[] = [
      { type: "add_node", id: "n1", label: "第一步" },
      { type: "add_node", id: "n2", label: "第二步" },
      { type: "connect_nodes", fromNodeId: "n1", toNodeId: "n2" },
      { type: "select_nodes", ids: ["n1", "n2"] },
    ];
    const result = applyCanvasAgentOps(makeCanvas([]), ops);
    expect(result.nodes.length).toBe(2);
    expect(result.edges.length).toBe(1);
    expect(result.selectedNodeIds).toEqual(["n1", "n2"]);
  });
});

describe("canvas-agent-ops.batchAddToolNodes", () => {
  it("批量添加多个工具调用节点", () => {
    const ops = batchAddToolNodes([
      { toolName: "click", label: "点击登录" },
      { toolName: "input_text", label: "输入用户名" },
    ]);
    expect(ops.length).toBe(2);
    expect(ops.every((op) => op.type === "add_node")).toBe(true);
  });

  it("缺 label 时用 toolName 作为 label", () => {
    const ops = batchAddToolNodes([{ toolName: "scroll" }]);
    expect((ops[0] as { label: string }).label).toBe("scroll");
  });
});

describe("canvas-agent-ops.chainConnectOps", () => {
  it("链式连接：n1→n2→n3", () => {
    const ops = chainConnectOps(["n1", "n2", "n3"]);
    expect(ops.length).toBe(2);
    expect(ops[0].type).toBe("connect_nodes");
  });
});

describe("canvas-agent-ops.summarizeCanvasAgentOps", () => {
  it("摘要各种操作计数", () => {
    const ops: CanvasAgentOp[] = [
      { type: "add_node", label: "a" },
      { type: "add_node", label: "b" },
      { type: "connect_nodes", fromNodeId: "n1", toNodeId: "n2" },
    ];
    const summary = summarizeCanvasAgentOps(ops);
    expect(summary).toContain("新增节点 2");
    expect(summary).toContain("连接节点 1");
  });
});
