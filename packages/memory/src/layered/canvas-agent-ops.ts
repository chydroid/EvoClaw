/**
 * canvas-agent-ops — 8 种原子操作 + 纯函数 reducer。
 *
 * 借鉴 Infinite-Canvas 的 CanvasAgentOp 设计（utils/canvas-agent-ops.ts）：
 * 把所有 Agent 对画布的操作统一降维到 8 种原子 op，核心 reducer 是纯函数，
 * 易测；工具层只做参数组装，易扩展。
 *
 * 8 种原子操作：
 *   1. add_node       — 新增节点
 *   2. update_node    — 更新节点（patch 浅合并，metadata 三层合并）
 *   3. delete_node    — 删除节点（支持 id/ids/nodeType 三种筛选）
 *   4. delete_connections — 删除连线（支持 id/ids/all）
 *   5. connect_nodes  — 连接两节点（校验存在 + 去重）
 *   6. set_viewport   — 设置视口（前端用，后端画布忽略）
 *   7. select_nodes   — 选中节点（前端用，后端画布忽略）
 *   8. run_generation — 触发生成（声明性意图，reducer 内不执行）
 *
 * 与 Infinite-Canvas 的差异：
 *   - 节点类型用 SymbolicMemoryCanvas 的 5 种（user_request/tool_call/decision/result/error）
 *     而非 Infinite-Canvas 的 5 种媒体类型（image/text/config/video/audio）
 *   - 因为我们的画布是"任务状态图"而非"AI 创作画布"
 */

import type { CanvasNode, CanvasNodeType, CanvasEdge, MemoryCanvas } from "./symbolic-memory-canvas";

// ── 8 种原子操作定义（判别联合） ──

export type CanvasAgentOp =
  | { type: "add_node"; id?: string; nodeType?: CanvasNodeType; label: string; metadata?: Record<string, unknown> }
  | { type: "update_node"; id: string; label?: string; metadata?: Record<string, unknown> }
  | { type: "delete_node"; id?: string; ids?: string[]; nodeType?: CanvasNodeType }
  | { type: "delete_connections"; id?: string; ids?: string[]; all?: boolean }
  | { type: "connect_nodes"; fromNodeId: string; toNodeId: string; label?: string }
  | { type: "set_viewport"; viewport: { x: number; y: number; k: number } }
  | { type: "select_nodes"; ids: string[] }
  | { type: "run_generation"; nodeId: string; mode?: string; prompt?: string };

// ── 内部状态类型 ──

interface CanvasReducerState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeIds: string[];
  viewport: { x: number; y: number; k: number };
}

// ── 纯函数 reducer ──

/**
 * 把 ops 数组应用到画布状态，返回新状态。
 *
 * 借鉴 Infinite-Canvas 的 applyCanvasAgentOps：
 * - 所有更新用 spread/map/filter，不可变
 * - run_generation 不在 reducer 内执行（仅作为声明性意图）
 *
 * @param canvas 当前画布（提供 nodes/edges 起点）
 * @param ops   待应用的 ops 数组
 * @returns 新的画布状态（包含 selectedNodeIds 和 viewport，前端用）
 */
export function applyCanvasAgentOps(
  canvas: Pick<MemoryCanvas, "nodes" | "edges">,
  ops: CanvasAgentOp[]
): CanvasReducerState & { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  let nodes = [...canvas.nodes];
  let edges = [...canvas.edges];
  let selectedNodeIds: string[] = [];
  let viewport = { x: 0, y: 0, k: 1 };

  // 用于生成本地节点 ID 的计数器（取现有最大编号 +1）
  let maxNodeNum = 0;
  for (const n of nodes) {
    const m = n.id.match(/^n(\d+)$/);
    if (m) maxNodeNum = Math.max(maxNodeNum, parseInt(m[1], 10));
  }

  for (const op of ops) {
    switch (op.type) {
      case "add_node": {
        maxNodeNum++;
        const id = op.id || `n${maxNodeNum}`;
        // 跳过已存在的 id（幂等）
        if (nodes.some((n) => n.id === id)) break;
        const nodeType: CanvasNodeType = op.nodeType || "tool_call";
        const truncatedLabel = op.label.length > 80 ? op.label.slice(0, 77) + "..." : op.label;
        nodes.push({
          id,
          type: nodeType,
          label: truncatedLabel,
          metadata: op.metadata,
        });
        break;
      }
      case "update_node": {
        nodes = nodes.map((n) => {
          if (n.id !== op.id) return n;
          const mergedMetadata = op.metadata
            ? { ...(n.metadata || {}), ...op.metadata }
            : n.metadata;
          return {
            ...n,
            label: op.label !== undefined ? op.label : n.label,
            metadata: mergedMetadata,
          };
        });
        break;
      }
      case "delete_node": {
        const idsToDelete = new Set<string>();
        if (op.id) idsToDelete.add(op.id);
        if (op.ids) for (const i of op.ids) idsToDelete.add(i);
        if (op.nodeType) {
          for (const n of nodes) {
            if (n.type === op.nodeType) idsToDelete.add(n.id);
          }
        }
        nodes = nodes.filter((n) => !idsToDelete.has(n.id));
        // 同时清理相关 edges
        edges = edges.filter(
          (e) => !idsToDelete.has(e.from) && !idsToDelete.has(e.to)
        );
        // 清理已删除的 selectedNodeIds
        selectedNodeIds = selectedNodeIds.filter((id) => !idsToDelete.has(id));
        break;
      }
      case "delete_connections": {
        if (op.all) {
          edges = [];
        } else {
          const idsToDelete = new Set<string>();
          if (op.id) idsToDelete.add(op.id);
          if (op.ids) for (const i of op.ids) idsToDelete.add(i);
          // 注意：edges 没有 id 字段，这里 ids 实际是 from-to 对的字符串
          // 简化处理：用 `${from}->${to}` 作为连线标识
          if (op.id && op.id.includes("->")) {
            edges = edges.filter((e) => `${e.from}->${e.to}` !== op.id);
          }
          if (op.ids) {
            const idSet = new Set(op.ids);
            edges = edges.filter((e) => !idSet.has(`${e.from}->${e.to}`));
          }
        }
        break;
      }
      case "connect_nodes": {
        // 校验两端节点存在
        const fromExists = nodes.some((n) => n.id === op.fromNodeId);
        const toExists = nodes.some((n) => n.id === op.toNodeId);
        if (!fromExists || !toExists) break;
        // 去重（from+to 唯一）
        const dupKey = `${op.fromNodeId}->${op.toNodeId}`;
        const exists = edges.some((e) => `${e.from}->${e.to}` === dupKey);
        if (exists) break;
        edges.push({
          from: op.fromNodeId,
          to: op.toNodeId,
          label: op.label,
        });
        break;
      }
      case "set_viewport": {
        viewport = { ...op.viewport };
        break;
      }
      case "select_nodes": {
        // 过滤掉不存在的 id
        const nodeIds = new Set(nodes.map((n) => n.id));
        selectedNodeIds = op.ids.filter((id) => nodeIds.has(id));
        break;
      }
      case "run_generation": {
        // 声明性意图，reducer 内不执行实际生成
        // 调用方需在 reducer 之外处理（借鉴 Infinite-Canvas 的 microtask 模式）
        break;
      }
    }
  }

  return { nodes, edges, selectedNodeIds, viewport };
}

// ── 工具函数：把高层操作转换为 ops 数组 ──

/**
 * 把多个工具调用节点批量添加为 ops（用于一次 Agent turn 的多工具调用）。
 *
 * 借鉴 Infinite-Canvas 的 generationFlowOps：一条用户请求展开为多个原子操作。
 */
export function batchAddToolNodes(
  toolCalls: Array<{
    toolName: string;
    label?: string;
    metadata?: Record<string, unknown>;
  }>
): CanvasAgentOp[] {
  return toolCalls.map((tc) => ({
    type: "add_node" as const,
    nodeType: "tool_call" as CanvasNodeType,
    label: tc.label || tc.toolName,
    metadata: { toolName: tc.toolName, ...tc.metadata },
  }));
}

/**
 * 把工具调用结果链式连接：每个新节点连到上一个节点。
 */
export function chainConnectOps(nodeIds: string[], edgeLabel?: string): CanvasAgentOp[] {
  const ops: CanvasAgentOp[] = [];
  for (let i = 1; i < nodeIds.length; i++) {
    ops.push({
      type: "connect_nodes",
      fromNodeId: nodeIds[i - 1],
      toNodeId: nodeIds[i],
      label: edgeLabel,
    });
  }
  return ops;
}

/**
 * 把 ops 数组计数摘要为人类可读字符串。
 * 借鉴 Infinite-Canvas 的 summarizeCanvasAgentOps。
 */
export function summarizeCanvasAgentOps(ops: CanvasAgentOp[]): string {
  const counts = new Map<string, number>();
  for (const op of ops) {
    counts.set(op.type, (counts.get(op.type) || 0) + 1);
  }
  const parts: string[] = [];
  const labelMap: Record<string, string> = {
    add_node: "新增节点",
    update_node: "更新节点",
    delete_node: "删除节点",
    delete_connections: "删除连线",
    connect_nodes: "连接节点",
    set_viewport: "设置视口",
    select_nodes: "选中节点",
    run_generation: "触发生成",
  };
  for (const [type, count] of counts) {
    parts.push(`${labelMap[type] || type} ${count}`);
  }
  return parts.join(", ");
}
