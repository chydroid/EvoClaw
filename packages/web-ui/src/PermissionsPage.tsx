/**
 * PermissionsPage — ACP Permission Relay viewer.
 *
 * Shows pending permission requests and history from PermissionRelay.
 * Allows approving/denying pending requests from the UI.
 */

import React, { useState, useEffect, useCallback } from "react";

interface PermissionRequest {
  id: string;
  agentId: string;
  sessionId: string;
  toolName: string;
  params: Record<string, unknown>;
  category: string;
  createdAt: number;
  status: "pending" | "approved" | "denied" | "timed_out";
  decidedAt?: number;
  decidedBy?: string;
  reason?: string;
}

const statusBadgeStyle = (st: string): React.CSSProperties => ({
  display: "inline-block", padding: "2px 8px", borderRadius: "10px", fontSize: "10px", fontWeight: "bold",
  background:
    st === "approved" ? "var(--success-bg)" :
    st === "denied" ? "var(--error-bg)" :
    st === "timed_out" ? "var(--warning-bg)" :
    "var(--info-bg, rgba(88,166,255,0.15))",
  color:
    st === "approved" ? "var(--success)" :
    st === "denied" ? "var(--error)" :
    st === "timed_out" ? "var(--warning)" :
    "var(--info, #58a6ff)",
});

const s: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)", width: "100%", boxSizing: "border-box" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "8px" },
  title: { color: "var(--text-primary)", fontSize: "18px", fontWeight: "bold" },
  subtitle: { color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" },
  refreshBtn: {
    padding: "6px 14px", borderRadius: "6px", border: "1px solid var(--accent)",
    background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: "12px",
  },
  panel: {
    background: "var(--bg-card)", borderRadius: "8px", border: "1px solid var(--border-light)",
    marginBottom: "16px", overflow: "hidden",
  },
  panelHeader: {
    padding: "12px 16px", borderBottom: "1px solid var(--border-light)",
    display: "flex", justifyContent: "space-between", alignItems: "center",
  },
  panelTitle: { color: "var(--text-primary)", fontSize: "14px", fontWeight: "bold" },
  panelCount: {
    padding: "2px 10px", borderRadius: "10px", fontSize: "11px", fontWeight: "bold",
    background: "var(--accent-bg)", color: "var(--accent)",
  },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: "12px" },
  th: { textAlign: "left" as const, padding: "8px 12px", color: "var(--text-muted)", fontSize: "11px", fontWeight: "bold", borderBottom: "1px solid var(--border-light)" },
  td: { padding: "8px 12px", color: "var(--text-secondary)", borderBottom: "1px solid var(--border-light)", verticalAlign: "middle" as const },
  actionBtn: {
    padding: "4px 12px", borderRadius: "4px", border: "none", cursor: "pointer",
    fontSize: "11px", fontWeight: "bold", marginRight: "6px",
  },
  empty: { padding: "24px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" },
};

export function PermissionsPage() {
  const [pending, setPending] = useState<PermissionRequest[]>([]);
  const [history, setHistory] = useState<PermissionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const [pendRes, histRes] = await Promise.all([
        fetch("/api/permission-relay/pending"),
        fetch("/api/permission-relay/history?limit=50"),
      ]);
      if (pendRes.ok) {
        const d = await pendRes.json();
        setPending(d.requests || []);
      }
      if (histRes.ok) {
        const d = await histRes.json();
        setHistory(d.history || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
      if (isManual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  const approve = async (id: string) => {
    try {
      const res = await fetch(`/api/permission-relay/${id}/approve`, { method: "POST" });
      if (res.ok) await loadData();
    } catch {}
  };

  const deny = async (id: string) => {
    try {
      const res = await fetch(`/api/permission-relay/${id}/deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Denied from Web UI" }),
      });
      if (res.ok) await loadData();
    } catch {}
  };

  const formatTime = (ts?: number) => {
    if (!ts) return "-";
    return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div>
          <div style={s.title}>权限中继 (Permission Relay)</div>
          <div style={s.subtitle}>集中式权限控制 — 所有工具调用权限请求经此流转</div>
        </div>
        <button style={{ ...s.refreshBtn, opacity: refreshing ? 0.6 : 1 }} onClick={() => loadData(true)} disabled={refreshing}>刷新</button>
      </div>

      {/* Pending Requests */}
      <div style={s.panel}>
        <div style={s.panelHeader}>
          <span style={s.panelTitle}>待处理请求</span>
          <span style={s.panelCount}>{pending.length}</span>
        </div>
        {pending.length === 0 ? (
          <div style={s.empty}>{loading ? "加载中..." : "无待处理权限请求"}</div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>工具</th>
                <th style={s.th}>Agent</th>
                <th style={s.th}>会话</th>
                <th style={s.th}>分类</th>
                <th style={s.th}>时间</th>
                <th style={s.th}>参数</th>
                <th style={s.th}>操作</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((req) => (
                <tr key={req.id}>
                  <td style={s.td}><code style={{ fontSize: "11px" }}>{req.toolName}</code></td>
                  <td style={s.td}>{req.agentId}</td>
                  <td style={s.td}>{req.sessionId?.slice(-8) || "-"}</td>
                  <td style={s.td}>{req.category}</td>
                  <td style={s.td}>{formatTime(req.createdAt)}</td>
                  <td style={s.td}>
                    <code style={{ fontSize: "10px", maxWidth: "150px", display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {JSON.stringify(req.params)}
                    </code>
                  </td>
                  <td style={s.td}>
                    <button style={{ ...s.actionBtn, background: "var(--success)", color: "#fff" }} onClick={() => approve(req.id)}>批准</button>
                    <button style={{ ...s.actionBtn, background: "var(--error)", color: "#fff" }} onClick={() => deny(req.id)}>拒绝</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* History */}
      <div style={s.panel}>
        <div style={s.panelHeader}>
          <span style={s.panelTitle}>历史记录</span>
          <span style={s.panelCount}>{history.length}</span>
        </div>
        {history.length === 0 ? (
          <div style={s.empty}>暂无历史记录</div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>工具</th>
                <th style={s.th}>状态</th>
                <th style={s.th}>决策者</th>
                <th style={s.th}>原因</th>
                <th style={s.th}>Agent</th>
                <th style={s.th}>时间</th>
              </tr>
            </thead>
            <tbody>
              {history.map((req) => (
                <tr key={req.id}>
                  <td style={s.td}><code style={{ fontSize: "11px" }}>{req.toolName}</code></td>
                  <td style={s.td}><span style={statusBadgeStyle(req.status)}>{req.status}</span></td>
                  <td style={s.td}>{req.decidedBy || "-"}</td>
                  <td style={s.td}>{req.reason || "-"}</td>
                  <td style={s.td}>{req.agentId}</td>
                  <td style={s.td}>{formatTime(req.decidedAt || req.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}