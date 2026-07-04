/**
 * CanvasGraphPage — 符号记忆画布可视化页面。
 *
 * 借鉴 Infinite-Canvas 的设计：
 * - 视口变换：CSS transform translate+scale 一次性完成世界→屏幕坐标
 * - 节点渲染：DOM div 节点，SVG path 连线
 * - 交互：鼠标滚轮缩放、拖拽平移、节点点击查看详情
 * - 零依赖：纯 React + SVG，不引入 react-flow / cytoscape 等图形库
 *
 * 数据来源：GET /api/canvas-graph/snapshot
 *   { active, nodes: [{id, type, label, sourceMessageId, metadata}], edges: [{from, to, label}], sessionKey, createdAt }
 *
 * 节点类型 → 颜色/形状映射（借鉴 SymbolicMemoryCanvas 的 NODE_SHAPE）：
 *   user_request → 蓝色圆角矩形
 *   tool_call     → 绿色矩形
 *   decision      → 黄色菱形
 *   result        → 紫色圆形
 *   error         → 红色圆形
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";

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
  const [selectedNode, setSelectedNode] = useState<CanvasNode | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panState = useRef({ startX: 0, startY: 0, initialX: 0, initialY: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);

  const fetchSnapshot = useCallback(async () => {
    try {
      const res = await fetch("/api/canvas-graph/snapshot");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: CanvasSnapshot = await res.json();
      setSnapshot(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSnapshot();
    const interval = setInterval(fetchSnapshot, 3000);
    return () => clearInterval(interval);
  }, [fetchSnapshot]);

  // 鼠标滚轮缩放（以鼠标位置为中心，借鉴 Infinite-Canvas 的 handleWheel）
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const delta = -e.deltaY;
    const factor = Math.pow(1.1, delta / 100);
    const newK = Math.min(Math.max(viewport.k * factor, 0.2), 3);
    const worldX = (mouseX - viewport.x) / viewport.k;
    const worldY = (mouseY - viewport.y) / viewport.k;
    setViewport({ x: mouseX - worldX * newK, y: mouseY - worldY * newK, k: newK });
  }, [viewport]);

  // 平移
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    setIsPanning(true);
    panState.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialX: viewport.x,
      initialY: viewport.y,
    };
  }, [viewport]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    const dx = e.clientX - panState.current.startX;
    const dy = e.clientY - panState.current.startY;
    setViewport({ x: panState.current.initialX + dx, y: panState.current.initialY + dy, k: viewport.k });
  }, [isPanning, viewport.k]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  const resetViewport = useCallback(() => {
    setViewport({ x: 40, y: 40, k: 1 });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const newK = Math.min(Math.max(viewport.k * factor, 0.2), 3);
    const worldX = (cx - viewport.x) / viewport.k;
    const worldY = (cy - viewport.y) / viewport.k;
    setViewport({ x: cx - worldX * newK, y: cy - worldY * newK, k: newK });
  }, [viewport]);

  const positions = useMemo(() => {
    if (!snapshot) return new Map();
    return layoutNodes(snapshot.nodes);
  }, [snapshot]);

  if (loading) {
    return <div style={{ padding: 20, color: "#888" }}>加载画布数据...</div>;
  }

  if (error) {
    return (
      <div style={{ padding: 20 }}>
        <div style={{ color: "#ef4444", marginBottom: 12 }}>加载失败: {error}</div>
        <button onClick={fetchSnapshot} style={{ padding: "6px 12px", cursor: "pointer" }}>重试</button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", background: "#fafafa" }}>
      {/* 左侧画布区域 */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", borderRight: "1px solid #e5e7eb" }}>
        {/* 工具栏 */}
        <div style={{
          position: "absolute", top: 12, left: 12, zIndex: 10,
          background: "white", border: "1px solid #e5e7eb", borderRadius: 8,
          padding: "6px 10px", display: "flex", gap: 8, alignItems: "center",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        }}>
          <button onClick={() => zoomBy(1.2)} style={btnStyle}>+</button>
          <span style={{ minWidth: 50, textAlign: "center", fontSize: 12, color: "#666" }}>
            {Math.round(viewport.k * 100)}%
          </span>
          <button onClick={() => zoomBy(1 / 1.2)} style={btnStyle}>−</button>
          <button onClick={resetViewport} style={btnStyle}>重置</button>
          <button onClick={fetchSnapshot} style={btnStyle}>刷新</button>
          <span style={{ color: "#999", fontSize: 12, marginLeft: 8 }}>
            {snapshot?.active ? `会话: ${snapshot.sessionKey.slice(0, 20)}` : "无活动画布"}
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

        {/* 画布容器 */}
        <div
          ref={containerRef}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{
            width: "100%", height: "100%",
            cursor: isPanning ? "grabbing" : "grab",
            background: `
              radial-gradient(circle, #e5e7eb 1px, transparent 1px)
            `,
            backgroundSize: `${20 * viewport.k}px ${20 * viewport.k}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          }}
        >
          {/* 世界坐标系容器 */}
          <div style={{
            position: "absolute",
            transformOrigin: "0 0",
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
          }}>
            {/* SVG 连线层 */}
            {snapshot && snapshot.nodes.length > 0 && (
              <svg
                width={Math.max(...snapshot.nodes.map((_, i) => (i % 5) + 1)) * NODE_GAP_X + 100}
                height={Math.max(1, Math.ceil(snapshot.nodes.length / 5)) * NODE_GAP_Y + 100}
                style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
              >
                {snapshot.edges.map((edge, i) => {
                  const from = positions.get(edge.from);
                  const to = positions.get(edge.to);
                  if (!from || !to) return null;
                  const startX = from.x + NODE_WIDTH;
                  const startY = from.y + NODE_HEIGHT / 2;
                  const endX = to.x;
                  const endY = to.y + NODE_HEIGHT / 2;
                  const dx = Math.abs(endX - startX);
                  const curvature = Math.max(dx * 0.5, 50);
                  return (
                    <g key={`edge-${i}`}>
                      <path
                        d={`M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`}
                        stroke="#94a3b8"
                        strokeWidth={2}
                        fill="none"
                        markerEnd="url(#arrowhead)"
                      />
                      {edge.label && (
                        <text
                          x={(startX + endX) / 2}
                          y={(startY + endY) / 2 - 4}
                          fill="#64748b"
                          fontSize={11}
                          textAnchor="middle"
                        >
                          {edge.label}
                        </text>
                      )}
                    </g>
                  );
                })}
                <defs>
                  <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#94a3b8" />
                  </marker>
                </defs>
              </svg>
            )}

            {/* 节点层 */}
            {snapshot?.nodes.map((node) => {
              const pos = positions.get(node.id);
              if (!pos) return null;
              const style = NODE_STYLE[node.type] || NODE_STYLE.tool_call;
              const isSelected = selectedNode?.id === node.id;
              return (
                <div
                  key={node.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedNode(node);
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
                    cursor: "pointer",
                    boxShadow: isSelected ? "0 0 0 3px rgba(59,130,246,0.4)" : "0 1px 3px rgba(0,0,0,0.1)",
                    boxSizing: "border-box",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    transition: "box-shadow 150ms ease",
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
              <div>会话: {snapshot.sessionKey.slice(0, 30)}</div>
              <div>创建于: {new Date(snapshot.createdAt).toLocaleString()}</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "4px 10px",
  cursor: "pointer",
  border: "1px solid #e5e7eb",
  background: "white",
  borderRadius: 4,
  fontSize: 13,
};
