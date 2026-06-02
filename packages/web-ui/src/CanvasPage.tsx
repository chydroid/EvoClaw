import React, { useState, useEffect, useCallback, useRef } from "react";
import { showToast, ConfirmModal, Spinner } from "./shared";

interface CanvasFile {
  filename: string;
  content: string;
  updatedAt: number;
}

interface CanvasProject {
  id: string;
  name: string;
  files: CanvasFile[];
  createdAt: number;
  updatedAt: number;
}

interface A2UIElement {
  id: string;
  type: string;
  props: Record<string, any>;
}

const st = {
  container: {
    display: "flex",
    height: "100%",
    background: "var(--bg-primary)",
    color: "var(--text-primary)",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  } as React.CSSProperties,
  leftPanel: {
    width: 200,
    minWidth: 200,
    borderRight: "1px solid var(--border)",
    background: "var(--bg-sidebar)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  } as React.CSSProperties,
  panelHeader: {
    padding: "12px 14px",
    borderBottom: "1px solid var(--border)",
    fontSize: 13,
    fontWeight: 700,
    color: "var(--text-primary)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  } as React.CSSProperties,
  projectList: {
    flex: 1,
    overflowY: "auto",
    padding: "6px 8px",
  } as React.CSSProperties,
  projectItem: (active: boolean): React.CSSProperties => ({
    padding: "8px 10px",
    borderRadius: 6,
    cursor: "pointer",
    marginBottom: 2,
    background: active ? "var(--accent-bg)" : "transparent",
    border: active ? "1px solid var(--accent)" : "1px solid transparent",
    transition: "all 0.12s",
    display: "flex",
    alignItems: "center",
    gap: 8,
  }),
  projectName: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 12,
    color: "var(--text-secondary)",
  } as React.CSSProperties,
  projectNameActive: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 12,
    color: "var(--accent)",
    fontWeight: 600,
  } as React.CSSProperties,
  projectTime: {
    fontSize: 9,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  deleteBtn: {
    width: 18,
    height: 18,
    borderRadius: 4,
    border: "none",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 11,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    opacity: 0,
    transition: "opacity 0.15s",
  } as React.CSSProperties,
  addBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    padding: "8px 12px",
    margin: "8px",
    borderRadius: 6,
    border: "1px dashed var(--border)",
    background: "transparent",
    color: "var(--accent)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
    transition: "background 0.15s",
  } as React.CSSProperties,
  centerPanel: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  } as React.CSSProperties,
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 12px",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-card)",
  } as React.CSSProperties,
  toolBtn: (active: boolean): React.CSSProperties => ({
    padding: "4px 10px",
    borderRadius: 5,
    border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
    background: active ? "var(--accent-bg)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-secondary)",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    transition: "all 0.12s",
  }),
  previewArea: {
    flex: 1,
    position: "relative",
    background: "var(--bg-secondary)",
    overflow: "hidden",
  } as React.CSSProperties,
  iframe: {
    width: "100%",
    height: "100%",
    border: "none",
    background: "#fff",
  } as React.CSSProperties,
  a2uiContainer: {
    width: "100%",
    height: "100%",
    overflow: "auto",
    padding: 16,
    background: "var(--bg-secondary)",
  } as React.CSSProperties,
  a2uiTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: "var(--text-primary)",
    marginBottom: 16,
  } as React.CSSProperties,
  a2uiCard: {
    background: "var(--bg-card)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: 14,
    marginBottom: 10,
  } as React.CSSProperties,
  a2uiCardTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text-primary)",
    marginBottom: 6,
  } as React.CSSProperties,
  a2uiCardContent: {
    fontSize: 13,
    color: "var(--text-secondary)",
    lineHeight: 1.5,
  } as React.CSSProperties,
  a2uiText: (tag: string): React.CSSProperties => ({
    fontSize: tag === "h1" ? 22 : tag === "p" ? 14 : 13,
    fontWeight: tag === "h1" ? 700 : 400,
    color: tag === "h1" ? "var(--text-primary)" : "var(--text-secondary)",
    marginBottom: 8,
    lineHeight: 1.5,
  }),
  a2uiButton: {
    padding: "6px 16px",
    borderRadius: 6,
    border: "1px solid var(--accent)",
    background: "var(--accent-bg)",
    color: "var(--accent)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
    marginRight: 8,
    marginBottom: 8,
  } as React.CSSProperties,
  a2uiInput: {
    padding: "6px 12px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    fontSize: 12,
    marginRight: 8,
    marginBottom: 8,
    outline: "none",
  } as React.CSSProperties,
  a2uiList: {
    paddingLeft: 20,
    color: "var(--text-secondary)",
    fontSize: 13,
    lineHeight: 1.8,
  } as React.CSSProperties,
  a2uiEmpty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "var(--text-muted)",
    fontSize: 13,
    gap: 8,
  } as React.CSSProperties,
  statusBar: {
    padding: "4px 12px",
    borderTop: "1px solid var(--border)",
    background: "var(--bg-card)",
    fontSize: 11,
    color: "var(--text-muted)",
    display: "flex",
    alignItems: "center",
    gap: 12,
  } as React.CSSProperties,
  rightPanel: (collapsed: boolean): React.CSSProperties => ({
    width: collapsed ? 0 : 400,
    minWidth: collapsed ? 0 : 400,
    borderLeft: "1px solid var(--border)",
    background: "var(--bg-sidebar)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    transition: "width 0.2s, min-width 0.2s",
  }),
  fileTabs: {
    display: "flex",
    borderBottom: "1px solid var(--border)",
    overflowX: "auto",
    background: "var(--bg-card)",
  } as React.CSSProperties,
  fileTab: (active: boolean): React.CSSProperties => ({
    padding: "6px 14px",
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    color: active ? "var(--accent)" : "var(--text-muted)",
    background: active ? "var(--accent-bg)" : "transparent",
    border: "none",
    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
    cursor: "pointer",
    whiteSpace: "nowrap",
    transition: "all 0.12s",
  }),
  editorArea: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  } as React.CSSProperties,
  textarea: {
    flex: 1,
    padding: 12,
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    border: "none",
    outline: "none",
    resize: "none",
    fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
    fontSize: 12,
    lineHeight: 1.6,
    tabSize: 2,
  } as React.CSSProperties,
  editorFooter: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 12px",
    borderTop: "1px solid var(--border)",
    background: "var(--bg-card)",
  } as React.CSSProperties,
  btnPrimary: {
    padding: "5px 14px",
    borderRadius: 6,
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
  } as React.CSSProperties,
  btnSecondary: {
    padding: "5px 14px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg-hover)",
    color: "var(--text-primary)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
  } as React.CSSProperties,
  btnSmall: {
    padding: "3px 8px",
    borderRadius: 4,
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text-secondary)",
    cursor: "pointer",
    fontSize: 11,
  } as React.CSSProperties,
  loadingOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.3)",
    zIndex: 10,
  } as React.CSSProperties,
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "var(--text-muted)",
    fontSize: 13,
    gap: 8,
  } as React.CSSProperties,
  newProjectInput: {
    padding: "6px 10px",
    borderRadius: 5,
    border: "1px solid var(--accent)",
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    fontSize: 12,
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
    margin: "6px 8px",
  } as React.CSSProperties,
  evalModal: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10000,
    backdropFilter: "blur(4px)",
  } as React.CSSProperties,
  evalCard: {
    background: "var(--bg-card)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: 20,
    width: 480,
    maxWidth: "90vw",
  } as React.CSSProperties,
  evalTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text-primary)",
    marginBottom: 12,
  } as React.CSSProperties,
  evalTextarea: {
    width: "100%",
    height: 120,
    padding: 10,
    borderRadius: 6,
    border: "1px solid var(--input-border)",
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
    fontSize: 12,
    outline: "none",
    resize: "vertical",
    boxSizing: "border-box",
  } as React.CSSProperties,
  evalResult: {
    marginTop: 10,
    padding: 10,
    borderRadius: 6,
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-light)",
    fontSize: 12,
    fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
    color: "var(--text-secondary)",
    maxHeight: 150,
    overflow: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  } as React.CSSProperties,
  chartBar: {
    display: "flex",
    alignItems: "flex-end",
    gap: 6,
    height: 100,
    padding: "8px 0",
  } as React.CSSProperties,
  chartBarCol: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    flex: 1,
  } as React.CSSProperties,
  chartBarFill: (h: number): React.CSSProperties => ({
    width: "100%",
    maxWidth: 40,
    height: h,
    background: "var(--accent)",
    borderRadius: "3px 3px 0 0",
    transition: "height 0.3s",
  }),
  chartBarLabel: {
    fontSize: 10,
    color: "var(--text-muted)",
  } as React.CSSProperties,
  chartLineSvg: {
    width: "100%",
    height: 100,
  } as React.CSSProperties,
  chartPieSvg: {
    width: 120,
    height: 120,
  } as React.CSSProperties,
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}小时前`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD}天前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function renderA2UIChart(type: string, data: Record<string, any>): React.ReactNode {
  if (type === "bar" && data.labels && data.values) {
    const max = Math.max(...data.values, 1);
    return (
      <div style={st.chartBar}>
        {(data.values as number[]).map((v, i) => (
          <div key={i} style={st.chartBarCol}>
            <div style={st.chartBarFill((v / max) * 80)} />
            <span style={st.chartBarLabel}>{data.labels[i] || ""}</span>
          </div>
        ))}
      </div>
    );
  }
  if (type === "line" && data.labels && data.values) {
    const values = data.values as number[];
    const max = Math.max(...values, 1);
    const w = 280;
    const h = 100;
    const points = values.map((v, i) => {
      const x = (i / Math.max(values.length - 1, 1)) * w;
      const y = h - (v / max) * (h - 10) - 5;
      return `${x},${y}`;
    }).join(" ");
    return (
      <svg style={st.chartLineSvg} viewBox={`0 0 ${w} ${h}`}>
        <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={points} />
        {values.map((v, i) => {
          const x = (i / Math.max(values.length - 1, 1)) * w;
          const y = h - (v / max) * (h - 10) - 5;
          return <circle key={i} cx={x} cy={y} r="3" fill="var(--accent)" />;
        })}
      </svg>
    );
  }
  if (type === "pie" && data.labels && data.values) {
    const values = data.values as number[];
    const total = values.reduce((a, b) => a + b, 0);
    if (total === 0) return null;
    const colors = ["var(--accent)", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899"];
    let cumulative = 0;
    const slices = values.map((v, i) => {
      const startAngle = (cumulative / total) * 2 * Math.PI;
      cumulative += v;
      const endAngle = (cumulative / total) * 2 * Math.PI;
      const r = 50;
      const cx = 60;
      const cy = 60;
      const x1 = cx + r * Math.sin(startAngle);
      const y1 = cy - r * Math.cos(startAngle);
      const x2 = cx + r * Math.sin(endAngle);
      const y2 = cy - r * Math.cos(endAngle);
      const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
      const d = `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} Z`;
      cumulative;
      return (
        <path key={i} d={d} fill={colors[i % colors.length]} opacity={0.85} />
      );
    });
    return (
      <svg style={st.chartPieSvg} viewBox="0 0 120 120">
        {slices}
      </svg>
    );
  }
  return <div style={{ color: "var(--text-muted)", fontSize: 12 }}>不支持的图表类型</div>;
}

export function CanvasPage() {
  const [projects, setProjects] = useState<CanvasProject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [a2uiMode, setA2uiMode] = useState(false);
  const [a2uiElements, setA2uiElements] = useState<A2UIElement[]>([]);
  const [a2uiTitle, setA2uiTitle] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [activeFile, setActiveFile] = useState("index.html");
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [evalModalOpen, setEvalModalOpen] = useState(false);
  const [evalScript, setEvalScript] = useState("");
  const [evalResult, setEvalResult] = useState<string | null>(null);
  const [evalLoading, setEvalLoading] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sseRef = useRef<EventSource | null>(null);
  const projectRef = useRef<CanvasProject | null>(null);

  const selectedProject = projects.find((p) => p.id === selectedId) || null;
  projectRef.current = selectedProject;

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/canvas/projects");
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || []);
      }
    } catch {
      showToast("加载项目列表失败", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    if (!selectedProject) {
      setEditorContent("");
      setActiveFile("index.html");
      return;
    }
    const file = selectedProject.files.find((f) => f.filename === activeFile);
    if (file) {
      setEditorContent(file.content);
    } else if (activeFile === "index.html") {
      setEditorContent("");
    } else {
      const firstFile = selectedProject.files[0];
      if (firstFile) {
        setActiveFile(firstFile.filename);
        setEditorContent(firstFile.content);
      }
    }
  }, [selectedId, activeFile]);

  useEffect(() => {
    if (selectedProject) {
      const file = selectedProject.files.find((f) => f.filename === activeFile);
      if (file && file.content !== editorContent) {
        setEditorContent(file.content);
      }
    }
  }, [selectedProject]);

  const loadFileContent = useCallback(async (projectId: string, filename: string) => {
    try {
      const res = await fetch(`/api/canvas/projects/${projectId}/files/${encodeURIComponent(filename)}`);
      if (res.ok) {
        const text = await res.text();
        setEditorContent(text);
      }
    } catch {
      showToast("加载文件失败", "error");
    }
  }, []);

  useEffect(() => {
    if (a2uiMode) {
      const es = new EventSource("/api/canvas/events");
      es.onmessage = (e) => {
        try {
          const cmd = JSON.parse(e.data);
          handleA2UICommand(cmd);
        } catch {}
      };
      es.onerror = () => {
        setStatusMsg("SSE 连接断开，尝试重连...");
      };
      sseRef.current = es;
      setStatusMsg("A2UI 模式已激活，SSE 已连接");
      return () => {
        es.close();
        sseRef.current = null;
      };
    } else {
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      setStatusMsg("");
    }
  }, [a2uiMode]);

  function handleA2UICommand(cmd: Record<string, any>) {
    switch (cmd.cmd) {
      case "setTitle":
        setA2uiTitle(cmd.value || "");
        break;
      case "addText":
        setA2uiElements((prev) => [
          ...prev,
          { id: `text-${Date.now()}`, type: "text", props: { value: cmd.value || "", tag: cmd.tag || "p" } },
        ]);
        break;
      case "addButton":
        setA2uiElements((prev) => [
          ...prev,
          { id: cmd.id || `btn-${Date.now()}`, type: "button", props: { label: cmd.label || "按钮" } },
        ]);
        break;
      case "addInput":
        setA2uiElements((prev) => [
          ...prev,
          { id: cmd.id || `inp-${Date.now()}`, type: "input", props: { placeholder: cmd.placeholder || "" } },
        ]);
        break;
      case "addCard":
        setA2uiElements((prev) => [
          ...prev,
          { id: `card-${Date.now()}`, type: "card", props: { title: cmd.title || "", content: cmd.content || "" } },
        ]);
        break;
      case "addList":
        setA2uiElements((prev) => [
          ...prev,
          { id: `list-${Date.now()}`, type: "list", props: { items: cmd.items || [] } },
        ]);
        break;
      case "addChart":
        setA2uiElements((prev) => [
          ...prev,
          { id: `chart-${Date.now()}`, type: "chart", props: { chartType: cmd.type || "bar", data: cmd.data || {} } },
        ]);
        break;
      case "clear":
        setA2uiElements([]);
        setA2uiTitle("");
        break;
      case "update":
        setA2uiElements((prev) =>
          prev.map((el) => (el.id === cmd.id ? { ...el, props: { ...el.props, value: cmd.value } } : el))
        );
        break;
      case "remove":
        setA2uiElements((prev) => prev.filter((el) => el.id !== cmd.id));
        break;
    }
    setStatusMsg(`A2UI: ${cmd.cmd}`);
  }

  async function createProject() {
    if (!newProjectName.trim()) return;
    try {
      const res = await fetch("/api/canvas/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newProjectName.trim() }),
      });
      if (res.ok) {
        const proj = await res.json();
        await fetchProjects();
        setSelectedId(proj.id || proj.project?.id);
        setShowNewProject(false);
        setNewProjectName("");
        showToast("项目已创建", "success");
      } else {
        showToast("创建项目失败", "error");
      }
    } catch {
      showToast("创建项目失败", "error");
    }
  }

  async function deleteProject(id: string) {
    try {
      const res = await fetch(`/api/canvas/projects/${id}`, { method: "DELETE" });
      if (res.ok) {
        if (selectedId === id) {
          setSelectedId(null);
        }
        await fetchProjects();
        showToast("项目已删除", "success");
      } else {
        showToast("删除项目失败", "error");
      }
    } catch {
      showToast("删除项目失败", "error");
    }
    setDeleteConfirm(null);
  }

  async function saveFile() {
    if (!selectedId || !activeFile) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/canvas/projects/${selectedId}/files/${encodeURIComponent(activeFile)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editorContent }),
      });
      if (res.ok) {
        showToast("文件已保存", "success");
        await fetchProjects();
        setStatusMsg(`已保存 ${activeFile}`);
      } else {
        showToast("保存失败", "error");
      }
    } catch {
      showToast("保存失败", "error");
    } finally {
      setSaving(false);
    }
  }

  function refreshIframe() {
    if (iframeRef.current) {
      const src = iframeRef.current.src;
      iframeRef.current.src = "";
      setTimeout(() => {
        if (iframeRef.current) iframeRef.current.src = src;
      }, 50);
    }
    setStatusMsg("预览已刷新");
  }

  async function evalJS() {
    if (!selectedId || !evalScript.trim()) return;
    setEvalLoading(true);
    setEvalResult(null);
    try {
      const res = await fetch(`/api/canvas/projects/${selectedId}/eval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: evalScript }),
      });
      if (res.ok) {
        const data = await res.json();
        setEvalResult(typeof data.result === "string" ? data.result : JSON.stringify(data.result, null, 2));
        showToast("执行完成", "success");
      } else {
        const text = await res.text();
        setEvalResult(`Error: ${text}`);
        showToast("执行失败", "error");
      }
    } catch (e: any) {
      setEvalResult(`Error: ${e.message}`);
      showToast("执行失败", "error");
    } finally {
      setEvalLoading(false);
    }
  }

  function handleA2UIAction(action: string, elementId: string, value?: string) {
    if ((window as any).openclawSendUserAction) {
      (window as any).openclawSendUserAction({ action, elementId, value });
    }
    setStatusMsg(`用户操作: ${action} on ${elementId}`);
  }

  function renderA2UI() {
    if (a2uiElements.length === 0 && !a2uiTitle) {
      return (
        <div style={st.a2uiEmpty}>
          <span style={{ fontSize: 28, opacity: 0.3 }}>◉</span>
          <span>等待 A2UI 推送...</span>
        </div>
      );
    }
    return (
      <div style={st.a2uiContainer}>
        {a2uiTitle && <div style={st.a2uiTitle}>{a2uiTitle}</div>}
        {a2uiElements.map((el) => {
          switch (el.type) {
            case "text":
              return (
                <div key={el.id} style={st.a2uiText(el.props.tag || "p")}>
                  {el.props.value}
                </div>
              );
            case "button":
              return (
                <button
                  key={el.id}
                  style={st.a2uiButton}
                  onClick={() => handleA2UIAction("click", el.id)}
                >
                  {el.props.label}
                </button>
              );
            case "input":
              return (
                <input
                  key={el.id}
                  style={st.a2uiInput}
                  placeholder={el.props.placeholder}
                  defaultValue={el.props.value || ""}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleA2UIAction("submit", el.id, (e.target as HTMLInputElement).value);
                    }
                  }}
                />
              );
            case "card":
              return (
                <div key={el.id} style={st.a2uiCard}>
                  <div style={st.a2uiCardTitle}>{el.props.title}</div>
                  <div style={st.a2uiCardContent}>{el.props.content}</div>
                </div>
              );
            case "list":
              return (
                <ul key={el.id} style={st.a2uiList}>
                  {(el.props.items as string[]).map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              );
            case "chart":
              return (
                <div key={el.id} style={st.a2uiCard}>
                  {renderA2UIChart(el.props.chartType, el.props.data)}
                </div>
              );
            default:
              return null;
          }
        })}
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", background: "var(--bg-primary)" }}>
        <Spinner size={32} />
      </div>
    );
  }

  const iframeSrc = selectedId ? `/api/canvas/projects/${selectedId}/files/index.html` : "";

  return (
    <div style={st.container}>
      {deleteConfirm && (
        <ConfirmModal
          title="删除项目"
          message={`确定要删除此项目吗？此操作不可撤销。`}
          confirmLabel="删除"
          danger
          onConfirm={() => deleteProject(deleteConfirm)}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {evalModalOpen && (
        <div style={st.evalModal} onClick={() => setEvalModalOpen(false)}>
          <div style={st.evalCard} onClick={(e) => e.stopPropagation()}>
            <div style={st.evalTitle}>执行 JavaScript</div>
            <textarea
              style={st.evalTextarea}
              value={evalScript}
              onChange={(e) => setEvalScript(e.target.value)}
              placeholder="输入要执行的 JavaScript 代码..."
              autoFocus
            />
            <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
              <button style={st.btnSecondary} onClick={() => setEvalModalOpen(false)}>取消</button>
              <button style={st.btnPrimary} onClick={evalJS} disabled={evalLoading}>
                {evalLoading ? "执行中..." : "执行"}
              </button>
            </div>
            {evalResult !== null && (
              <div style={st.evalResult}>{evalResult}</div>
            )}
          </div>
        </div>
      )}

      {!fullscreen && (
        <div style={st.leftPanel}>
          <div style={st.panelHeader}>
            <span>项目</span>
          </div>
          <div style={st.projectList}>
            {projects.map((p) => (
              <div
                key={p.id}
                style={st.projectItem(selectedId === p.id)}
                onClick={() => {
                  setSelectedId(p.id);
                  setActiveFile("index.html");
                  setA2uiElements([]);
                  setA2uiTitle("");
                }}
                onMouseEnter={(e) => {
                  const btn = e.currentTarget.querySelector(".del-btn") as HTMLElement;
                  if (btn) btn.style.opacity = "1";
                }}
                onMouseLeave={(e) => {
                  const btn = e.currentTarget.querySelector(".del-btn") as HTMLElement;
                  if (btn) btn.style.opacity = "0";
                }}
              >
                <span style={selectedId === p.id ? st.projectNameActive : st.projectName}>{p.name}</span>
                <span style={st.projectTime}>{formatTime(p.updatedAt)}</span>
                <button
                  className="del-btn"
                  style={st.deleteBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteConfirm(p.id);
                  }}
                  title="删除项目"
                >
                  ✕
                </button>
              </div>
            ))}
            {projects.length === 0 && (
              <div style={{ color: "var(--text-muted)", fontSize: 12, padding: "16px 10px", textAlign: "center" }}>
                暂无项目
              </div>
            )}
          </div>
          {showNewProject ? (
            <div style={{ padding: "0 8px 8px" }}>
              <input
                style={st.newProjectInput}
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createProject();
                  if (e.key === "Escape") { setShowNewProject(false); setNewProjectName(""); }
                }}
                placeholder="项目名称"
                autoFocus
              />
              <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                <button style={st.btnPrimary} onClick={createProject}>创建</button>
                <button style={st.btnSecondary} onClick={() => { setShowNewProject(false); setNewProjectName(""); }}>取消</button>
              </div>
            </div>
          ) : (
            <button style={st.addBtn} onClick={() => setShowNewProject(true)}>
              + 新建项目
            </button>
          )}
        </div>
      )}

      <div style={st.centerPanel}>
        <div style={st.toolbar}>
          <button style={st.toolBtn(false)} onClick={refreshIframe} title="刷新预览">⟳ 刷新</button>
          <button
            style={st.toolBtn(fullscreen)}
            onClick={() => setFullscreen(!fullscreen)}
            title={fullscreen ? "退出全屏" : "全屏"}
          >
            {fullscreen ? "⤓ 退出全屏" : "⤢ 全屏"}
          </button>
          <button
            style={st.toolBtn(a2uiMode)}
            onClick={() => {
              setA2uiMode(!a2uiMode);
              if (!a2uiMode) {
                setA2uiElements([]);
                setA2uiTitle("");
              }
            }}
            title="A2UI 模式"
          >
            ◉ A2UI
          </button>
          <div style={{ flex: 1 }} />
          {!rightCollapsed && (
            <button style={st.btnSmall} onClick={() => setRightCollapsed(true)}>▸ 收起编辑器</button>
          )}
          {rightCollapsed && (
            <button style={st.btnSmall} onClick={() => setRightCollapsed(false)}>◂ 展开编辑器</button>
          )}
        </div>

        <div style={st.previewArea}>
          {saving && (
            <div style={st.loadingOverlay}>
              <Spinner size={24} />
            </div>
          )}
          {!selectedId ? (
            <div style={st.emptyState}>
              <span style={{ fontSize: 36, opacity: 0.2 }}>⊞</span>
              <span>选择或创建一个项目开始</span>
            </div>
          ) : a2uiMode ? (
            renderA2UI()
          ) : (
            <iframe
              ref={iframeRef}
              style={st.iframe}
              sandbox="allow-scripts allow-same-origin"
              src={iframeSrc}
              title="Canvas 预览"
            />
          )}
        </div>

        <div style={st.statusBar}>
          {statusMsg && <span>{statusMsg}</span>}
          {selectedProject && <span>项目: {selectedProject.name}</span>}
          {a2uiMode && <span style={{ color: "var(--accent)" }}>A2UI 已连接</span>}
        </div>
      </div>

      {!fullscreen && (
        <div style={st.rightPanel(rightCollapsed)}>
          <div style={st.panelHeader}>
            <span>代码编辑</span>
          </div>
          {selectedProject ? (
            <>
              <div style={st.fileTabs}>
                {selectedProject.files.map((f) => (
                  <button
                    key={f.filename}
                    style={st.fileTab(activeFile === f.filename)}
                    onClick={() => {
                      setActiveFile(f.filename);
                      loadFileContent(selectedProject.id, f.filename);
                    }}
                  >
                    {f.filename}
                  </button>
                ))}
              </div>
              <div style={st.editorArea}>
                <textarea
                  style={st.textarea}
                  value={editorContent}
                  onChange={(e) => setEditorContent(e.target.value)}
                  spellCheck={false}
                />
                <div style={st.editorFooter}>
                  <button style={st.btnPrimary} onClick={saveFile} disabled={saving}>
                    {saving ? "保存中..." : "保存"}
                  </button>
                  <button style={st.btnSecondary} onClick={() => setEvalModalOpen(true)}>
                    执行JS
                  </button>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{activeFile}</span>
                </div>
              </div>
            </>
          ) : (
            <div style={st.emptyState}>
              <span style={{ fontSize: 24, opacity: 0.2 }}>📄</span>
              <span>选择项目查看代码</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
