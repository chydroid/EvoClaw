import React, { useState } from "react";

const TOOL_ITEMS = [
  { id: "select", label: "选择", icon: "⬚" },
  { id: "text", label: "文本", icon: "T" },
  { id: "rect", label: "矩形", icon: "▭" },
  { id: "circle", label: "圆形", icon: "○" },
  { id: "line", label: "线条", icon: "╱" },
] as const;

type ToolId = typeof TOOL_ITEMS[number]["id"];

const s = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)", display: "flex", flexDirection: "column" } as React.CSSProperties,
  header: { marginBottom: "16px" } as React.CSSProperties,
  title: { color: "var(--text-primary)", fontSize: "18px", fontWeight: "bold" } as React.CSSProperties,
  subtitle: { color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" } as React.CSSProperties,
  toolbar: {
    display: "flex", alignItems: "center", gap: "4px",
    padding: "8px 12px", marginBottom: "12px",
    background: "var(--bg-card)", borderRadius: "8px",
    border: "1px solid var(--border-light)",
  } as React.CSSProperties,
  toolBtn: (active: boolean): React.CSSProperties => ({
    padding: "6px 12px", borderRadius: "6px",
    border: active ? "1px solid var(--accent)" : "1px solid transparent",
    background: active ? "var(--accent-bg)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-secondary)",
    cursor: "pointer", fontSize: "13px", fontWeight: active ? 600 : 400,
    display: "flex", alignItems: "center", gap: "6px",
    transition: "all 0.12s",
  }),
  separator: { width: "1px", height: "20px", background: "var(--border-light)", margin: "0 6px" } as React.CSSProperties,
  canvasArea: {
    flex: 1, minHeight: "400px",
    background: "var(--bg-card)", borderRadius: "8px",
    border: "1px solid var(--border-light)",
    position: "relative" as const, overflow: "hidden",
  } as React.CSSProperties,
  gridPattern: {
    position: "absolute" as const, inset: 0,
    backgroundImage: "radial-gradient(circle, var(--border-light) 1px, transparent 1px)",
    backgroundSize: "24px 24px",
    opacity: 0.5,
  } as React.CSSProperties,
  placeholder: {
    position: "absolute" as const, inset: 0,
    display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center",
    gap: "8px", pointerEvents: "none" as const,
  } as React.CSSProperties,
  placeholderIcon: { fontSize: "40px", opacity: 0.3, color: "var(--text-muted)" } as React.CSSProperties,
  placeholderText: { fontSize: "14px", color: "var(--text-muted)", opacity: 0.6 } as React.CSSProperties,
};

export function CanvasPage() {
  const [activeTool, setActiveTool] = useState<ToolId>("select");

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div style={s.title}>画布工作区</div>
        <div style={s.subtitle}>拖拽元素到画布或使用工具栏创建内容</div>
      </div>

      <div style={s.toolbar}>
        {TOOL_ITEMS.map((tool, i) => (
          <React.Fragment key={tool.id}>
            {i > 0 && <div style={s.separator} />}
            <button
              style={s.toolBtn(activeTool === tool.id)}
              onClick={() => setActiveTool(tool.id)}
            >
              <span style={{ fontSize: "14px" }}>{tool.icon}</span>
              <span>{tool.label}</span>
            </button>
          </React.Fragment>
        ))}
      </div>

      <div style={s.canvasArea}>
        <div style={s.gridPattern} />
        <div style={s.placeholder}>
          <div style={s.placeholderIcon}>⊞</div>
          <div style={s.placeholderText}>选择工具开始创建内容</div>
        </div>
      </div>
    </div>
  );
}
