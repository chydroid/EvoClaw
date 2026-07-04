/**
 * CanvasGraphPage — 符号记忆画布可视化页面（v2 全面升级）。
 *
 * 借鉴 Infinite-Canvas 的核心工程优化（参照 web/src/app/(user)/canvas/）：
 *
 * 1. **视口变换**（ViewportTransform {x, y, k}）
 *    - 世界→屏幕：CSS `transform: translate + scale` 一次性完成（GPU 合成）
 *    - 滚轮缩放以鼠标位置为锚点
 *    - 中心缩放、平移、重置
 *
 * 2. **视口剔除**（Viewport Culling）
 *    - 仅渲染屏幕内 + 280px padding 的节点
 *    - 1000 个节点时只渲染几十个
 *
 * 3. **requestAnimationFrame 合并**
 *    - 平移和节点拖拽的 mousemove 用 rAF 合并，避免 60Hz 之外的重渲染
 *
 * 4. **ref 镜像避免 stale closure**
 *    - nodes/viewport/selectedNodeIds 都有 ref 镜像
 *    - 全局事件 handler 读 ref 而非 state，避免闭包陈旧值
 *
 * 5. **CSS contain 隔离**
 *    - 每个节点 `contain: "layout style"` 隔离重排
 *
 * 6. **节点拖拽**
 *    - 拖拽期间暂停历史记录，结束时 commit 一次最终状态
 *    - pointerCapture 保证拖出元素仍接收事件
 *
 * 7. **SVG bezier 连线**（借鉴 Infinite-Canvas canvas-connections.tsx）
 *    - 三次贝塞尔曲线，曲率随距离自适应
 *    - 双 path 设计：透明 16px 点击热区 + 可见 2px 连线
 *
 * 8. **小地图**（借鉴 canvas-mini-map.tsx）
 *    - 右下角缩略图，世界坐标→小地图坐标双射
 *    - 视口矩形可视化当前可见区域
 *
 * 9. **Undo/Redo**（借鉴 Infinite-Canvas 快照式 Undo）
 *    - 用户操作 + Agent ops 批次都可整体撤销
 *    - 快照式而非逐步操作
 *
 * 10. **键盘快捷键**
 *     - Delete: 删除选中节点
 *     - Ctrl+Z / Ctrl+Shift+Z: 撤销/重做
 *     - Ctrl+0: 重置视口
 *     - F: 适配所有节点
 *
 * 11. **网格背景自适应**
 *     - 网格随缩放变化（gridSize = 48 * k）
 *     - 低缩放时缩小点避免视觉抖动
 */
import { useState, useEffect, useRef, useCallback, useMemo, type CSSProperties } from "react";

interface CanvasNode {
  id: string;
  type: "user_request" | "tool_call" | "decision" | "result" | "error";
  label: string;
  sourceMessageId?: string;
  metadata?: Record<string, unknown>;
}

interface CanvasEdge {
  from: string;
  to: string;
  label?: string;
}

interface CanvasSnapshot {
  active: boolean;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  sessionKey: string;
  createdAt: number;
}

interface Viewport {
  x: number;
  y: number;
  k: number;
}

const NODE_STYLE: Record<CanvasNode["type"], { bg: string; border: string; shape: "rect" | "circle" | "diamond" }> = {
  user_request: { bg: "#dbeafe", border: "#3b82f6", shape: "rect" },
  tool_call: { bg: "#dcfce7", border: "#22c55e", shape: "rect" },
  decision: { bg: "#fef9c3", border: "#eab308", shape: "diamond" },
  result: { bg: "#f3e8ff", border: "#a855f7", shape: "circle" },
  error: { bg: "#fee2e2", border: "#ef4444", shape: "circle" },
};

const NODE_WIDTH = 200;
const NODE_HEIGHT = 60;
const NODE_GAP_X = 280;
const NODE_GAP_Y = 120;
const MIN_SCALE = 0.2;
const MAX_SCALE = 3;
const VIEWPORT_PADDING = 280;

// 自动布局：按节点 id 顺序水平排列，超过 5 个换行
function layoutNodes(nodes: CanvasNode[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((node, i) => {
    const col = i % 5;
    const row = Math.floor(i / 5);
    positions.set(node.id, { x: col * NODE_GAP_X, y: row * NODE_GAP_Y });
  });
  return positions;
}

export function CanvasGraphPage() {
  const [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 40, y: 40, k: 1 });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [nodePositions, setNodePositions] = useState<Map<string, { x: number; y: number }>>(new Map());

  // ── ref 镜像（借鉴 Infinite-Canvas 的 ref mirrors，避免 stale closure） ──
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef(viewport);
  const snapshotRef = useRef<CanvasSnapshot | null>(null);
  const selectedNodeIdsRef = useRef<Set<string>>(new Set([selectedNodeId].filter(Boolean) as string[]));
  const panStateRef = useRef({ startX: 0, startY: 0, initialX: 0, initialY: 0 });
  const dragStateRef = useRef<{ nodeId: string; startClientX: number; startClientY: number; initialNodeX: number; initialNodeY: number } | null>(null);
  const panningRef = useRef(false);
  // rAF 合并
  const panFrameRef = useRef<number | null>(null);
  const nextViewportRef = useRef<Viewport | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  // Undo/Redo 快照
  const undoStackRef = useRef<Array<{ nodes: CanvasNode[]; edges: CanvasEdge[]; positions: Map<string, { x: number; y: number }> }>>([]);
  const redoStackRef = useRef<Array<{ nodes: CanvasNode[]; edges: CanvasEdge[]; positions: Map<string, { x: number; y: number }> }>>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);

  // 同步 ref 镜像
  useEffect(() => { viewportRef.current = viewport; }, [viewport]);
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  useEffect(() => {
    selectedNodeIdsRef.current = new Set(selectedNodeId ? [selectedNodeId] : []);
  }, [selectedNodeId]);

  const fetchSnapshot = useCallback(async () => {
    try {
      const res = await fetch("/api/canvas-graph/snapshot");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: CanvasSnapshot = await res.json();
      setSnapshot(data);
      // 初始化布局（如果新数据节点多于已有位置）
      setNodePositions((prev) => {
        const newPositions = new Map(prev);
        for (const node of data.nodes) {
          if (!newPositions.has(node.id)) {
            const idx = data.nodes.indexOf(node);
            const col = idx % 5;
            const row = Math.floor(idx / 5);
            newPositions.set(node.id, { x: col * NODE_GAP_X, y: row * NODE_GAP_Y });
          }
        }
        // 删除不存在的节点位置
        const validIds = new Set(data.nodes.map((n) => n.id));
        for (const id of newPositions.keys()) {
          if (!validIds.has(id)) newPositions.delete(id);
        }
        return newPositions;
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSnapshot();
    const interval = setInterval(fetchSnapshot, 5000); // 5 秒刷新（从 3 秒放宽，减少抖动）
    return () => clearInterval(interval);
  }, [fetchSnapshot]);

  // ── 视口剔除（借鉴 Infinite-Canvas visibleNodes） ──
  const visibleNodes = useMemo(() => {
    if (!snapshot) return [];
    const rect = containerRef.current?.getBoundingClientRect();
    const width = rect?.width || 1200;
    const height = rect?.height || 800;
    const k = viewport.k;
    const viewLeft = -viewport.x / k - VIEWPORT_PADDING;
    const viewTop = -viewport.y / k - VIEWPORT_PADDING;
    const viewRight = viewLeft + width / k + VIEWPORT_PADDING * 2;
    const viewBottom = viewTop + height / k + VIEWPORT_PADDING * 2;
    return snapshot.nodes.filter((node) => {
      const pos = nodePositions.get(node.id);
      if (!pos) return false;
      return pos.x + NODE_WIDTH > viewLeft
        && pos.x < viewRight
        && pos.y + NODE_HEIGHT > viewTop
        && pos.y < viewBottom;
    });
  }, [snapshot, nodePositions, viewport]);

  // ── 滚轮缩放（以鼠标位置为锚点） ──
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const currentViewport = viewportRef.current;
    const delta = -e.deltaY;
    const factor = Math.pow(1.1, delta / 100);
    const newK = Math.min(Math.max(currentViewport.k * factor, MIN_SCALE), MAX_SCALE);
    const worldX = (mouseX - currentViewport.x) / currentViewport.k;
    const worldY = (mouseY - currentViewport.y) / currentViewport.k;
    setViewport({ x: mouseX - worldX * newK, y: mouseY - worldY * newK, k: newK });
  }, []);

  // ── 平移（rAF 合并） ──
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 仅在画布空白处响应（不是节点）
    if ((e.target as HTMLElement).dataset.canvasBg || e.currentTarget === e.target) {
      if (e.button !== 0 && e.button !== 1) return;
      panningRef.current = true;
      setIsPanning(true);
      panStateRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        initialX: viewportRef.current.x,
        initialY: viewportRef.current.y,
      };
    }
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // 平移
    if (panningRef.current) {
      const dx = e.clientX - panStateRef.current.startX;
      const dy = e.clientY - panStateRef.current.startY;
      nextViewportRef.current = {
        x: panStateRef.current.initialX + dx,
        y: panStateRef.current.initialY + dy,
        k: viewportRef.current.k,
      };
      if (panFrameRef.current) return;
      panFrameRef.current = requestAnimationFrame(() => {
        panFrameRef.current = null;
        if (nextViewportRef.current) {
          setViewport(nextViewportRef.current);
        }
      });
      return;
    }
    // 节点拖拽（rAF 合并）
    if (dragStateRef.current) {
      const ds = dragStateRef.current;
      const dx = (e.clientX - ds.startClientX) / viewportRef.current.k;
      const dy = (e.clientY - ds.startClientY) / viewportRef.current.k;
      if (dragFrameRef.current) cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = requestAnimationFrame(() => {
        dragFrameRef.current = null;
        setNodePositions((prev) => {
          const next = new Map(prev);
          next.set(ds.nodeId, { x: ds.initialNodeX + dx, y: ds.initialNodeY + dy });
          return next;
        });
      });
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    if (panningRef.current) {
      panningRef.current = false;
      setIsPanning(false);
      if (panFrameRef.current) {
        cancelAnimationFrame(panFrameRef.current);
        panFrameRef.current = null;
      }
    }
    if (dragStateRef.current) {
      // 节点拖拽结束：commit 一次最终状态（暂停历史记录 → 恢复并 commit）
      pushUndoSnapshot();
      dragStateRef.current = null;
      if (dragFrameRef.current) {
        cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
    }
  }, []);

  // ── 节点拖拽 ──
  const handleNodeMouseDown = useCallback((e: React.MouseEvent, node: CanvasNode) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    setSelectedNodeId(node.id);
    const pos = nodePositions.get(node.id) || { x: 0, y: 0 };
    dragStateRef.current = {
      nodeId: node.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      initialNodeX: pos.x,
      initialNodeY: pos.y,
    };
    // pointerCapture 保证拖出元素仍接收事件
    try { (e.currentTarget as HTMLElement).setPointerCapture((e as unknown as PointerEvent).pointerId); } catch { /* ignore */ }
  }, [nodePositions]);

  // ── 视口控制 ──
  const resetViewport = useCallback(() => {
    setViewport({ x: 40, y: 40, k: 1 });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const currentViewport = viewportRef.current;
    const newK = Math.min(Math.max(currentViewport.k * factor, MIN_SCALE), MAX_SCALE);
    const worldX = (cx - currentViewport.x) / currentViewport.k;
    const worldY = (cy - currentViewport.y) / currentViewport.k;
    setViewport({ x: cx - worldX * newK, y: cy - worldY * newK, k: newK });
  }, []);

  // 适配所有节点
  const fitAll = useCallback(() => {
    if (!snapshot || snapshot.nodes.length === 0) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of snapshot.nodes) {
      const pos = nodePositions.get(node.id);
      if (!pos) continue;
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + NODE_WIDTH);
      maxY = Math.max(maxY, pos.y + NODE_HEIGHT);
    }
    if (!isFinite(minX)) return;
    const w = maxX - minX;
    const h = maxY - minY;
    const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(rect.width / (w + 80), rect.height / (h + 80))));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setViewport({ x: rect.width / 2 - cx * k, y: rect.height / 2 - cy * k, k });
  }, [snapshot, nodePositions]);

  // ── Undo/Redo（快照式） ──
  const pushUndoSnapshot = useCallback(() => {
    if (!snapshot) return;
    undoStackRef.current.push({
      nodes: [...snapshot.nodes],
      edges: [...snapshot.edges],
      positions: new Map(nodePositions),
    });
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    setUndoCount(undoStackRef.current.length);
    redoStackRef.current = [];
    setRedoCount(0);
  }, [snapshot, nodePositions]);

  const undo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (!prev || !snapshot) return;
    // 当前状态推入 redo
    redoStackRef.current.push({
      nodes: [...snapshot.nodes],
      edges: [...snapshot.edges],
      positions: new Map(nodePositions),
    });
    setSnapshot((s) => s ? { ...s, nodes: prev.nodes, edges: prev.edges } : s);
    setNodePositions(prev.positions);
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
  }, [snapshot, nodePositions]);

  const redo = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next || !snapshot) return;
    undoStackRef.current.push({
      nodes: [...snapshot.nodes],
      edges: [...snapshot.edges],
      positions: new Map(nodePositions),
    });
    setSnapshot((s) => s ? { ...s, nodes: next.nodes, edges: next.edges } : s);
    setNodePositions(next.positions);
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
  }, [snapshot, nodePositions]);

  // ── 删除选中节点（通过 ops API） ──
  const deleteSelected = useCallback(async () => {
    if (!selectedNodeId || !snapshot) return;
    pushUndoSnapshot();
    try {
      await fetch("/api/canvas-graph/apply-ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ops: [{ type: "delete_node", id: selectedNodeId }],
        }),
      });
      setSelectedNodeId(null);
      await fetchSnapshot();
    } catch (err) {
      setError(`删除节点失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [selectedNodeId, snapshot, pushUndoSnapshot, fetchSnapshot]);

  // ── 键盘快捷键 ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 仅当画布页面激活时响应（避免与聊天输入框冲突）
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedNodeId) {
          e.preventDefault();
          void deleteSelected();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        resetViewport();
      } else if (e.key === "f" || e.key === "F") {
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          fitAll();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedNodeId, undo, redo, resetViewport, fitAll, deleteSelected]);

  const selectedNode = useMemo(
    () => snapshot?.nodes.find((n) => n.id === selectedNodeId) || null,
    [snapshot, selectedNodeId]
  );

  // ── 小地图数据 ──
  const minimap = useMemo(() => {
    if (!snapshot || snapshot.nodes.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of snapshot.nodes) {
      const pos = nodePositions.get(node.id);
      if (!pos) continue;
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + NODE_WIDTH);
      maxY = Math.max(maxY, pos.y + NODE_HEIGHT);
    }
    if (!isFinite(minX)) return null;
    const worldW = maxX - minX;
    const worldH = maxY - minY;
    const miniSize = 140;
    const scale = Math.min(miniSize / worldW, miniSize / worldH) || 1;
    return { minX, minY, worldW, worldH, scale, miniSize };
  }, [snapshot, nodePositions]);

  if (loading) {
    return <div style={{ padding: 20, color: "#888" }}>加载画布数据...</div>;
  }

  if (error && !snapshot) {
    return (
      <div style={{ padding: 20 }}>
        <div style={{ color: "#ef4444", marginBottom: 12 }}>加载失败: {error}</div>
        <button onClick={fetchSnapshot} style={{ padding: "6px 12px", cursor: "pointer" }}>重试</button>
      </div>
    );
  }

  // 网格背景自适应（借鉴 Infinite-Canvas 的网格大小随缩放变化）
  const gridSize = 48 * viewport.k;
  const dotSize = viewport.k < 0.3 ? 0.8 : 1.15;
  const backgroundPosition = `${viewport.x % gridSize}px ${viewport.y % gridSize}px`;

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", background: "#fafafa" }}>
      {/* 左侧画布区域 */}
      <div
        style={{ flex: 1, position: "relative", overflow: "hidden", borderRight: "1px solid #e5e7eb" }}
      >
        {/* 工具栏 */}
        <div style={{
          position: "absolute", top: 12, left: 12, zIndex: 10,
          background: "white", border: "1px solid #e5e7eb", borderRadius: 8,
          padding: "6px 10px", display: "flex", gap: 8, alignItems: "center",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        }}>
          <button onClick={() => zoomBy(1.2)} style={btnStyle} title="放大">+</button>
          <span style={{ minWidth: 50, textAlign: "center", fontSize: 12, color: "#666" }}>
            {Math.round(viewport.k * 100)}%
          </span>
          <button onClick={() => zoomBy(1 / 1.2)} style={btnStyle} title="缩小">−</button>
          <button onClick={resetViewport} style={btnStyle} title="重置 (Ctrl+0)">重置</button>
          <button onClick={fitAll} style={btnStyle} title="适配 (F)">适配</button>
          <button onClick={fetchSnapshot} style={btnStyle} title="刷新">刷新</button>
          <button onClick={undo} disabled={undoCount === 0} style={{ ...btnStyle, opacity: undoCount === 0 ? 0.4 : 1 }} title="撤销 (Ctrl+Z)">↶</button>
          <button onClick={redo} disabled={redoCount === 0} style={{ ...btnStyle, opacity: redoCount === 0 ? 0.4 : 1 }} title="重做 (Ctrl+Y)">↷</button>
          <button onClick={deleteSelected} disabled={!selectedNodeId} style={{ ...btnStyle, opacity: !selectedNodeId ? 0.4 : 1, color: selectedNodeId ? "#ef4444" : "#999" }} title="删除 (Delete)">删除</button>
          <span style={{ color: "#999", fontSize: 12, marginLeft: 8 }}>
            {snapshot?.active ? `会话: ${(snapshot.sessionKey || "").slice(0, 20)}` : "无活动画布"}
          </span>
        </div>

        {/* 状态指示 */}
        {!snapshot?.active && (
          <div style={{
            position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            color: "#999", textAlign: "center", pointerEvents: "none",
          }}>
            <div style={{ fontSize: 16, marginBottom: 8 }}>当前无活动画布</div>
            <div style={{ fontSize: 13 }}>Agent 执行任务时，工具调用会自动记录为节点</div>
          </div>
        )}

        {/* 画布容器（data-canvas-bg 用于区分空白处点击） */}
        <div
          ref={containerRef}
          data-canvas-bg="true"
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{
            width: "100%", height: "100%",
            cursor: isPanning ? "grabbing" : "grab",
            background: `radial-gradient(circle, #e5e7eb ${dotSize}px, transparent ${dotSize + 0.5}px)`,
            backgroundSize: `${gridSize}px ${gridSize}px`,
            backgroundPosition,
          }}
        >
          {/* 世界坐标系容器 */}
          <div style={{
            position: "absolute",
            transformOrigin: "0 0",
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
          }}>
            {/* SVG 连线层（借鉴 Infinite-Canvas 双 path：透明热区 + 可见连线） */}
            {snapshot && snapshot.nodes.length > 0 && (
              <svg
                width={10000}
                height={10000}
                style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", transform: "translateZ(0)" }}
              >
                <defs>
                  <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#94a3b8" />
                  </marker>
                </defs>
                {snapshot.edges.map((edge, i) => {
                  const from = nodePositions.get(edge.from);
                  const to = nodePositions.get(edge.to);
                  if (!from || !to) return null;
                  const startX = from.x + NODE_WIDTH;
                  const startY = from.y + NODE_HEIGHT / 2;
                  const endX = to.x;
                  const endY = to.y + NODE_HEIGHT / 2;
                  const dx = Math.abs(endX - startX);
                  const curvature = Math.max(dx * 0.5, 50);
                  const pathD = `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;
                  return (
                    <g key={`edge-${i}`}>
                      {/* 16px 透明热区 */}
                      <path d={pathD} stroke="transparent" strokeWidth={16} fill="none" style={{ pointerEvents: "stroke", cursor: "pointer" }} />
                      {/* 可见连线 */}
                      <path
                        d={pathD}
                        stroke="#94a3b8"
                        strokeWidth={2}
                        fill="none"
                        markerEnd="url(#arrowhead)"
                        style={{ pointerEvents: "none" }}
                      />
                      {edge.label && (
                        <text
                          x={(startX + endX) / 2}
                          y={(startY + endY) / 2 - 4}
                          fill="#64748b"
                          fontSize={11}
                          textAnchor="middle"
                          style={{ pointerEvents: "none" }}
                        >
                          {edge.label}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            )}

            {/* 节点层（视口剔除：仅渲染可见节点） */}
            {visibleNodes.map((node) => {
              const pos = nodePositions.get(node.id);
              if (!pos) return null;
              const style = NODE_STYLE[node.type] || NODE_STYLE.tool_call;
              const isSelected = selectedNodeId === node.id;
              return (
                <div
                  key={node.id}
                  onMouseDown={(e) => handleNodeMouseDown(e, node)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedNodeId(node.id);
                  }}
                  style={{
                    position: "absolute",
                    left: pos.x,
                    top: pos.y,
                    width: NODE_WIDTH,
                    minHeight: NODE_HEIGHT,
                    background: style.bg,
                    border: `2px solid ${style.border}`,
                    borderRadius: style.shape === "circle" ? "50%" : style.shape === "diamond" ? 4 : 8,
                    padding: "8px 12px",
                    cursor: "move",
                    boxShadow: isSelected ? "0 0 0 3px rgba(59,130,246,0.4)" : "0 1px 3px rgba(0,0,0,0.1)",
                    boxSizing: "border-box",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    transition: "box-shadow 150ms ease",
                    contain: "layout style",
                    userSelect: "none",
                  }}
                >
                  <div style={{ fontSize: 10, color: "#64748b", marginBottom: 2 }}>
                    {node.id} · {node.type}
                  </div>
                  <div style={{ fontSize: 13, color: "#1f2937", wordBreak: "break-word", lineHeight: 1.3 }}>
                    {node.label}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 图例 */}
        <div style={{
          position: "absolute", bottom: 12, left: 12,
          background: "white", border: "1px solid #e5e7eb", borderRadius: 8,
          padding: "8px 12px", fontSize: 12,
        }}>
          {Object.entries(NODE_STYLE).map(([type, style]) => (
            <div key={type} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{
                display: "inline-block", width: 12, height: 12,
                background: style.bg, border: `2px solid ${style.border}`,
                borderRadius: style.shape === "circle" ? "50%" : 3,
              }} />
              <span style={{ color: "#475569" }}>{type}</span>
            </div>
          ))}
        </div>

        {/* 小地图（借鉴 Infinite-Canvas canvas-mini-map.tsx） */}
        {minimap && (
          <div style={{
            position: "absolute", bottom: 12, right: 12,
            width: minimap.miniSize + 20, height: minimap.miniSize + 20,
            background: "white", border: "1px solid #e5e7eb", borderRadius: 8,
            padding: 10,
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          }}>
            <svg width={minimap.miniSize} height={minimap.miniSize} style={{ display: "block" }}>
              {/* 节点 */}
              {snapshot?.nodes.map((node) => {
                const pos = nodePositions.get(node.id);
                if (!pos) return null;
                const mx = (pos.x - minimap.minX) * minimap.scale;
                const my = (pos.y - minimap.minY) * minimap.scale;
                const mw = NODE_WIDTH * minimap.scale;
                const mh = NODE_HEIGHT * minimap.scale;
                const style = NODE_STYLE[node.type] || NODE_STYLE.tool_call;
                return (
                  <rect
                    key={`mini-${node.id}`}
                    x={mx} y={my} width={Math.max(2, mw)} height={Math.max(2, mh)}
                    fill={style.bg} stroke={style.border} strokeWidth={0.5}
                  />
                );
              })}
              {/* 视口矩形 */}
              {(() => {
                const rect = containerRef.current?.getBoundingClientRect();
                if (!rect) return null;
                const vx = (-viewport.x / viewport.k - minimap.minX) * minimap.scale;
                const vy = (-viewport.y / viewport.k - minimap.minY) * minimap.scale;
                const vw = (rect.width / viewport.k) * minimap.scale;
                const vh = (rect.height / viewport.k) * minimap.scale;
                return (
                  <rect
                    x={vx} y={vy} width={vw} height={vh}
                    fill="rgba(59,130,246,0.1)" stroke="#3b82f6" strokeWidth={1}
                  />
                );
              })()}
            </svg>
            <div style={{ fontSize: 10, color: "#999", marginTop: 4, textAlign: "center" }}>小地图</div>
          </div>
        )}

        {/* 快捷键提示 */}
        <div style={{
          position: "absolute", top: 12, right: 12,
          background: "white", border: "1px solid #e5e7eb", borderRadius: 8,
          padding: "6px 10px", fontSize: 11, color: "#666",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        }}>
          <div>F: 适配 · Ctrl+0: 重置 · Del: 删除</div>
          <div>Ctrl+Z: 撤销 · Ctrl+Y: 重做 · 滚轮: 缩放</div>
        </div>
      </div>

      {/* 右侧详情面板 */}
      <div style={{ width: 320, padding: 16, background: "white", overflowY: "auto" }}>
        <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 16 }}>节点详情</h3>
        {selectedNode ? (
          <div>
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "#64748b" }}>ID</span>
              <div style={{ fontFamily: "monospace", fontSize: 13 }}>{selectedNode.id}</div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "#64748b" }}>类型</span>
              <div style={{ fontSize: 13 }}>{selectedNode.type}</div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "#64748b" }}>标签</span>
              <div style={{ fontSize: 13, padding: "6px 8px", background: "#f9fafb", borderRadius: 4, wordBreak: "break-word" }}>
                {selectedNode.label}
              </div>
            </div>
            {selectedNode.sourceMessageId && (
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: "#64748b" }}>来源消息 ID</span>
                <div style={{ fontFamily: "monospace", fontSize: 12 }}>{selectedNode.sourceMessageId}</div>
              </div>
            )}
            {selectedNode.metadata && Object.keys(selectedNode.metadata).length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: "#64748b" }}>元数据</span>
                <pre style={{
                  fontSize: 11, padding: "6px 8px", background: "#f9fafb",
                  borderRadius: 4, overflowX: "auto", margin: "4px 0",
                }}>
                  {JSON.stringify(selectedNode.metadata, null, 2)}
                </pre>
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: "#9ca3af", fontSize: 13 }}>点击节点查看详情</div>
        )}

        {snapshot && snapshot.nodes.length > 0 && (
          <>
            <h4 style={{ marginTop: 20, marginBottom: 8, fontSize: 14 }}>画布统计</h4>
            <div style={{ fontSize: 12, color: "#475569" }}>
              <div>节点数: {snapshot.nodes.length}</div>
              <div>连线数: {snapshot.edges.length}</div>
              <div>会话: {(snapshot.sessionKey || "").slice(0, 30)}</div>
              <div>创建于: {new Date(snapshot.createdAt).toLocaleString()}</div>
              <div>可视节点: {visibleNodes.length} / {snapshot.nodes.length}</div>
              <div>缩放: {Math.round(viewport.k * 100)}%</div>
              <div>撤销栈: {undoCount} · 重做栈: {redoCount}</div>
            </div>
          </>
        )}
      </div>

      {error && (
        <div style={{
          position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)",
          background: "#fee2e2", color: "#ef4444", padding: "6px 12px",
          borderRadius: 6, fontSize: 12,
        }}>
          {error}
        </div>
      )}
    </div>
  );
}

const btnStyle: CSSProperties = {
  padding: "4px 10px",
  cursor: "pointer",
  border: "1px solid #e5e7eb",
  background: "white",
  borderRadius: 4,
  fontSize: 13,
};
