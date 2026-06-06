import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "./i18n";

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

const STATUS_LABEL_KEYS: Record<string, string> = {
  idle: "status.state_idle", thinking: "status.state_thinking", executing: "status.state_executing",
  responding: "status.state_responding", error: "status.state_error", waiting_permission: "status.state_waiting_permission",
};

export function StatusPage() {
  const { t } = useTranslation();
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
      setError(t("status.connection_error"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  if (loading) return <div style={s.container}><div style={{ color: "var(--text-muted)" }}>{t("app.loading")}</div></div>;
  if (error && !status) return <div style={s.container}><div style={{ color: "var(--error)" }}>{error}</div></div>;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div style={s.title}>{t("status.title")}</div>
        <div style={s.subtitle}>
          {t("dashboard.uptime")}: {status?.uptimeFormatted || t("status.unknown")} · {status?.platform || "?"} · Node {status?.nodeVersion || "?"}
        </div>
      </div>

      {/* Stats Grid */}
      <div style={s.grid}>
        <div style={s.card}>
          <div style={s.cardTitle}>{t("status.run_status")}</div>
          <div style={{ ...s.cardValue, color: status?.online ? "var(--success)" : "var(--error)" }}>
            {status?.online ? t("app.online") : t("app.offline")}
          </div>
          <div style={s.cardSub}>{t("dashboard.uptime")}: {status?.uptimeFormatted || "N/A"}</div>
        </div>
        <div style={s.card}>
          <div style={s.cardTitle}>{t("status.memory_usage")}</div>
          <div style={s.cardValue}>{status?.memory?.heapUsed || 0} MB</div>
          <div style={s.cardSub}>RSS: {status?.memory?.rss || 0} MB</div>
          <div style={s.memoryBar}>
            <div style={memoryFillStyle(status?.memory?.heapUsed || 0, status?.memory?.heapTotal || 1)} />
          </div>
        </div>
        <div style={s.card}>
          <div style={s.cardTitle}>{t("dashboard.active_sessions")}</div>
          <div style={s.cardValue}>{status?.agentStatuses?.length || 0}</div>
          <div style={s.cardSub}>
            {status?.agentStatuses?.filter(a => a.state === "thinking" || a.state === "executing").length || 0} {t("status.active_suffix")}
          </div>
        </div>
        <div style={s.card}>
          <div style={s.cardTitle}>{t("status.service_count")}</div>
          <div style={s.cardValue}>{services.length}</div>
          <div style={s.cardSub}>
            {services.filter(s => s.status === "running").length} {t("status.running_suffix")}
          </div>
        </div>
      </div>

      {/* Agent Statuses */}
      <div style={s.section}>
        <div style={s.sectionTitle}>{t("status.agent_status")}</div>
        {(status?.agentStatuses || []).length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "16px" }}>{t("status.no_active_agents")}</div>
        ) : (
          (status?.agentStatuses || []).map((agent, i) => (
            <div key={i} style={s.statusRow}>
              <div style={statusIndicatorStyle(agent.state)} />
              <div style={s.statusText}>
                <div style={s.statusSession}>{agent.sessionId}</div>
                <div style={s.statusAction}>{agent.currentAction || t("status.no_action")}</div>
                {agent.toolCalls.length > 0 && (
                  <div style={s.statusMeta}>
                    {t("status.tools")}: {agent.toolCalls.map(tc => `${tc.name}(${tc.status})`).join(", ")}
                  </div>
                )}
                <div style={s.statusMeta}>
                  {t("dashboard.providers_status")}: {t(STATUS_LABEL_KEYS[agent.state] || "", agent.state)} ·
                  {t("status.token")}: {agent.tokensUsed} ·
                  {t("status.duration")}: {(agent.duration / 1000).toFixed(1)}s ·
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
        <div style={s.sectionTitle}>{t("status.service_list")}</div>
        {services.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "16px" }}>{t("status.no_services")}</div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>{t("ops.service_name")}</th>
                <th style={s.th}>{t("status.version")}</th>
                <th style={s.th}>{t("dashboard.providers_status")}</th>
                <th style={s.th}>{t("plugins.error")}</th>
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
        {t("status.auto_refreshing")} · {t("status.last_update")}: {status?.timestamp ? new Date(status.timestamp).toLocaleTimeString() : "N/A"}
      </div>
    </div>
  );
}