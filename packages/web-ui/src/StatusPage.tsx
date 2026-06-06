import React, { useState, useEffect, useCallback } from "react";

interface SystemStatus {
  online: boolean;
  uptime: number;
  uptimeFormatted: string;
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
  };
  platform: string;
  nodeVersion: string;
  agentStatuses: Array<{
    sessionId: string;
    state: string;
    currentAction: string;
    toolCalls: Array<{ name: string; status: string }>;
    lastActivity: string;
    tokensUsed: number;
    duration: number;
    runId: number;
    progress?: { current: number; total: number; label: string };
  }>;
  timestamp: string;
}

interface ServiceInfo {
  name: string;
  version: string;
  status: string;
  startedAt?: string;
  error?: string;
}

const statusIndicatorStyle = (state: string): React.CSSProperties => ({
  width: "10px", height: "10px", borderRadius: "50%", flexShrink: 0,
  background: state === "idle" ? "var(--text-muted)" :
    state === "thinking" || state === "executing" ? "var(--accent)" :
    state === "responding" ? "var(--success)" :
    state === "error" ? "var(--error)" : "var(--warning)",
  animation: state === "thinking" || state === "executing" ? "pulse 1.5s ease-in-out infinite" : "none",
});

const progressFillStyle = (pct: number): React.CSSProperties => ({
  height: "100%", width: `${pct}%`, borderRadius: "2px", background: "var(--accent)", transition: "width 0.3s",
});

const memoryFillStyle = (used: number, total: number): React.CSSProperties => ({
  height: "100%", width: `${Math.min(100, (used / total) * 100)}%`, borderRadius: "4px",
  background: used / total > 0.8 ? "var(--error)" : used / total > 0.6 ? "var(--warning)" : "var(--success)",
  transition: "width 0.5s",
});

const statusBadgeStyle2 = (status: string): React.CSSProperties => ({
  display: "inline-block", padding: "2px 8px", borderRadius: "10px", fontSize: "10px", fontWeight: "bold",
  background: status === "running" ? "var(--success-bg)" : status === "stopped" ? "var(--error-bg)" : "var(--warning-bg)",
  color: status === "running" ? "var(--success)" : status === "stopped" ? "var(--error)" : "var(--warning)",
});

const s: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  header: { marginBottom: "20px" },
  title: { color: "var(--section-title-color)", fontSize: "18px", fontWeight: "bold" },
  subtitle: { color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px", marginBottom: "24px" },
  card: { background: "var(--bg-card)", borderRadius: "8px", padding: "16px", border: "1px solid var(--border-light)" },
  cardTitle: { color: "var(--text-muted)", fontSize: "11px", textTransform: "uppercase" as const, fontWeight: "bold", marginBottom: "8px", letterSpacing: "0.5px" },
  cardValue: { color: "var(--text-primary)", fontSize: "24px", fontWeight: "bold" },
  cardSub: { color: "var(--text-muted)", fontSize: "11px", marginTop: "4px" },
  section: { marginBottom: "24px" },
  sectionTitle: { color: "var(--text-primary)", fontSize: "14px", fontWeight: "bold", marginBottom: "12px" },
  statusRow: {
    background: "var(--bg-card)", borderRadius: "8px", padding: "14px", border: "1px solid var(--border-light)",
    marginBottom: "8px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px",
  },
  statusText: { flex: 1, minWidth: 0 },
  statusSession: { color: "var(--text-primary)", fontSize: "13px", fontWeight: "bold" },
  statusAction: { color: "var(--text-secondary)", fontSize: "12px", whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" },
  statusMeta: { color: "var(--text-muted)", fontSize: "10px", marginTop: "2px" },
  progressBar: {
    height: "4px", borderRadius: "2px", background: "var(--bg-hover)", marginTop: "6px", overflow: "hidden",
  },
  memoryBar: {
    height: "8px", borderRadius: "4px", background: "var(--bg-hover)", marginTop: "8px", overflow: "hidden",
  },
  table: { width: "100%", borderCollapse: "collapse" as const },
  th: { textAlign: "left" as const, padding: "8px 12px", color: "var(--text-muted)", fontSize: "11px", fontWeight: "bold", borderBottom: "1px solid var(--border-light)" },
  td: { padding: "8px 12px", color: "var(--text-secondary)", fontSize: "12px", borderBottom: "1px solid var(--border-light)" },
  error: { color: "var(--error)", fontSize: "11px", marginTop: "4px" },
};

const STATUS_LABELS: Record<string, string> = {
  idle: "空闲", thinking: "思考中", executing: "执行工具",
  responding: "回复中", error: "出错", waiting_permission: "等待授权",
};

export function StatusPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadData = useCallback(async () => {
    try {
      const [statusRes, svcRes] = await Promise.all([
        fetch("/api/status"),
        fetch("/api/system/services"),
      ]);
      if (statusRes.ok) setStatus(await statusRes.json());
      if (svcRes.ok) setServices(await svcRes.json());
      setError("");
    } catch (err) {
      setError("无法连接到服务器");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  if (loading) return <div style={s.container}><div style={{ color: "var(--text-muted)" }}>加载中...</div></div>;
  if (error && !status) return <div style={s.container}><div style={{ color: "var(--error)" }}>{error}</div></div>;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div style={s.title}>系统状态</div>
        <div style={s.subtitle}>
          运行时间: {status?.uptimeFormatted || "未知"} · {status?.platform || "?"} · Node {status?.nodeVersion || "?"}
        </div>
      </div>

      {/* Stats Grid */}
      <div style={s.grid}>
        <div style={s.card}>
          <div style={s.cardTitle}>运行状态</div>
          <div style={{ ...s.cardValue, color: status?.online ? "var(--success)" : "var(--error)" }}>
            {status?.online ? "在线" : "离线"}
          </div>
          <div style={s.cardSub}>运行时间: {status?.uptimeFormatted || "N/A"}</div>
        </div>
        <div style={s.card}>
          <div style={s.cardTitle}>内存使用</div>
          <div style={s.cardValue}>{status?.memory?.heapUsed || 0} MB</div>
          <div style={s.cardSub}>RSS: {status?.memory?.rss || 0} MB</div>
          <div style={s.memoryBar}>
            <div style={memoryFillStyle(status?.memory?.heapUsed || 0, status?.memory?.heapTotal || 1)} />
          </div>
        </div>
        <div style={s.card}>
          <div style={s.cardTitle}>活跃会话</div>
          <div style={s.cardValue}>{status?.agentStatuses?.length || 0}</div>
          <div style={s.cardSub}>
            {status?.agentStatuses?.filter(a => a.state === "thinking" || a.state === "executing").length || 0} 个活跃中
          </div>
        </div>
        <div style={s.card}>
          <div style={s.cardTitle}>服务数量</div>
          <div style={s.cardValue}>{services.length}</div>
          <div style={s.cardSub}>
            {services.filter(s => s.status === "running").length} 个运行中
          </div>
        </div>
      </div>

      {/* Agent Statuses */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Agent 状态</div>
        {(status?.agentStatuses || []).length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "16px" }}>当前无活跃 Agent 会话</div>
        ) : (
          (status?.agentStatuses || []).map((agent, i) => (
            <div key={i} style={s.statusRow}>
              <div style={statusIndicatorStyle(agent.state)} />
              <div style={s.statusText}>
                <div style={s.statusSession}>{agent.sessionId}</div>
                <div style={s.statusAction}>{agent.currentAction || "无操作"}</div>
                {agent.toolCalls.length > 0 && (
                  <div style={s.statusMeta}>
                    工具: {agent.toolCalls.map(t => `${t.name}(${t.status})`).join(", ")}
                  </div>
                )}
                <div style={s.statusMeta}>
                  状态: {STATUS_LABELS[agent.state] || agent.state} · 
                  Token: {agent.tokensUsed} · 
                  耗时: {(agent.duration / 1000).toFixed(1)}s · 
                  Run #{agent.runId}
                </div>
                {agent.progress && (
                  <div style={s.progressBar}>
                    <div style={progressFillStyle((agent.progress.current / agent.progress.total) * 100)} />
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Services Table */}
      <div style={s.section}>
        <div style={s.sectionTitle}>服务列表</div>
        {services.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "16px" }}>无服务数据</div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>服务名称</th>
                <th style={s.th}>版本</th>
                <th style={s.th}>状态</th>
                <th style={s.th}>错误</th>
              </tr>
            </thead>
            <tbody>
              {services.map((svc) => (
                <tr key={svc.name}>
                  <td style={s.td}>{svc.name}</td>
                  <td style={s.td}>{svc.version}</td>
                  <td style={s.td}>
                    <span style={statusBadgeStyle2(svc.status)}>{svc.status}</span>
                  </td>
                  <td style={s.td}>
                    {svc.error ? <span style={s.error}>{svc.error}</span> : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Refresh hint */}
      <div style={{ color: "var(--text-muted)", fontSize: "10px", textAlign: "center" as const, marginTop: "8px" }}>
        自动刷新中 (每 5 秒) · 最后更新: {status?.timestamp ? new Date(status.timestamp).toLocaleTimeString() : "N/A"}
      </div>
    </div>
  );
}