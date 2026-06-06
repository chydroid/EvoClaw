/**
 * OpsPage — Crestodian Operations Manager UI.
 *
 * Displays system health, diagnostics, and service overview
 * from the Crestodian daemon guardian.
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "./i18n";

interface SystemHealth {
  status: "ok" | "degraded" | "down";
  uptimeMs: number;
  os: { hostname: string; platform: string; arch: string; cpus: number; totalMem: number; freeMem: number; loadAvg: number[] };
  process: { pid: number; memoryRss: number; memoryHeapUsed: number; cpuUser: number; cpuSystem: number };
  services: Record<string, unknown>;
}

interface Diagnostics {
  status: string;
  collectedAt: number;
  os: Record<string, unknown>;
  process: Record<string, unknown>;
  config?: Record<string, unknown>;
}

const s: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)", width: "100%", boxSizing: "border-box" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "8px" },
  title: { color: "var(--text-primary)", fontSize: "18px", fontWeight: "bold" },
  subtitle: { color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" },
  refreshBtn: {
    padding: "6px 14px", borderRadius: "6px", border: "1px solid var(--accent)",
    background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: "12px",
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "14px", marginBottom: "20px" },
  card: { background: "var(--bg-card)", borderRadius: "8px", padding: "14px", border: "1px solid var(--border-light)" },
  cardTitle: { color: "var(--text-muted)", fontSize: "11px", textTransform: "uppercase" as const, fontWeight: "bold", marginBottom: "6px", letterSpacing: "0.5px" },
  cardValue: { color: "var(--text-primary)", fontSize: "22px", fontWeight: "bold" },
  cardSub: { color: "var(--text-muted)", fontSize: "11px", marginTop: "2px" },
  panel: {
    background: "var(--bg-card)", borderRadius: "8px", border: "1px solid var(--border-light)",
    marginBottom: "16px", overflow: "hidden",
  },
  panelHeader: {
    padding: "12px 16px", borderBottom: "1px solid var(--border-light)",
    display: "flex", justifyContent: "space-between", alignItems: "center",
  },
  panelTitle: { color: "var(--text-primary)", fontSize: "14px", fontWeight: "bold" },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: "12px" },
  th: { textAlign: "left" as const, padding: "7px 12px", color: "var(--text-muted)", fontSize: "11px", fontWeight: "bold", borderBottom: "1px solid var(--border-light)" },
  td: { padding: "7px 12px", color: "var(--text-secondary)", borderBottom: "1px solid var(--border-light)" },
  empty: { padding: "24px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" },
};

function statusDotStyle(st: string): React.CSSProperties {
  return {
    display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", marginRight: "6px",
    background: st === "ok" ? "var(--success)" : st === "degraded" ? "var(--warning)" : "var(--error)",
  };
}

export function OpsPage() {
  const { t } = useTranslation();
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const [healthRes, diagRes] = await Promise.all([
        fetch("/api/crestodian/health"),
        fetch("/api/crestodian/diagnostics"),
      ]);
      if (healthRes.ok) setHealth(await healthRes.json());
      if (diagRes.ok) setDiagnostics(await diagRes.json());
    } catch (err) {
      console.error("[OpsPage] Load data failed:", err);
    } finally {
      setLoading(false);
      if (isManual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, [loadData]);

  const fmtMs = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  };

  const fmtMB = (bytes: number) => {
    if (!bytes || bytes === 0) return "-";
    return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  };

  const getCpuPercent = (user: number, system: number) => {
    const total = user + system;
    if (!total) return "-";
    return `${((total / 10000) / (health?.uptimeMs || 1)).toFixed(1)}%`;
  };

  const servicesArray = health?.services
    ? Object.entries(health.services).map(([name, info]: [string, any]) => ({
        name,
        status: info?.status === "running" ? "ok" as const : "error" as const,
        latencyMs: info?.latencyMs || 0,
      }))
    : [];

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div>
          <div style={s.title}>{t("ops.crestodian_title", "运维管理 (Crestodian)")}</div>
          <div style={s.subtitle}>{t("ops.crestodian_subtitle", "守护进程运维管理器 — 系统健康、诊断与操作审计")}</div>
        </div>
        <button style={{ ...s.refreshBtn, opacity: refreshing ? 0.6 : 1 }} onClick={() => loadData(true)} disabled={refreshing}>{t("ops.refresh", "刷新")}</button>
      </div>

      {/* Health Cards */}
      <div style={s.grid}>
        <div style={s.card}>
          <div style={s.cardTitle}>{t("ops.system_status", "系统状态")}</div>
          <div style={{ ...s.cardValue, color: health?.status === "ok" ? "var(--success)" : "var(--error)" }}>
            {health?.status === "ok" ? t("ops.normal", "正常") : health?.status || t("ops.unknown", "未知")}
          </div>
          <div style={s.cardSub}>{t("ops.uptime", "运行时间")}: {health ? fmtMs(health.uptimeMs) : "-"}</div>
        </div>
        <div style={s.card}>
          <div style={s.cardTitle}>CPU</div>
          <div style={s.cardValue}>{health?.os?.cpus || "-"} {t("ops.cores", "核")}</div>
          <div style={s.cardSub}>{t("ops.process", "进程")}: {health?.process ? getCpuPercent(health.process.cpuUser, health.process.cpuSystem) : "-"}%</div>
        </div>
        <div style={s.card}>
          <div style={s.cardTitle}>{t("ops.memory", "内存")}</div>
          <div style={s.cardValue}>{fmtMB(health?.process?.memoryRss || 0)}</div>
          <div style={s.cardSub}>
            {t("ops.heap", "堆")}: {fmtMB(health?.process?.memoryHeapUsed || 0)} ·
            {t("ops.system", "系统")}: {fmtMB(health?.os?.freeMem || 0)} / {fmtMB(health?.os?.totalMem || 0)}
          </div>
        </div>
        <div style={s.card}>
          <div style={s.cardTitle}>{t("ops.process_title", "进程")}</div>
          <div style={s.cardValue}>{health?.process?.pid || "-"}</div>
          <div style={s.cardSub}>
            {t("ops.platform", "平台")}: {health?.os?.platform || "-"} · {health?.os?.hostname || "-"}
          </div>
        </div>
      </div>

      {/* Service Health Table */}
      <div style={s.panel}>
        <div style={s.panelHeader}>
          <span style={s.panelTitle}>{t("ops.service_health_status", "服务健康状态")}</span>
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            {t("ops.service_count", "{0} 个服务").replace("{0}", String(servicesArray.length))}
          </span>
        </div>
        {servicesArray.length === 0 ? (
          <div style={s.empty}>{loading ? t("app.loading", "加载中...") : t("ops.no_service_data", "无服务数据")}</div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>{t("ops.service_name", "服务名称")}</th>
                <th style={s.th}>{t("ops.service_status", "状态")}</th>
                <th style={s.th}>{t("ops.latency", "延迟")}</th>
                <th style={s.th}>{t("ops.errors", "错误")}</th>
              </tr>
            </thead>
            <tbody>
              {servicesArray.map((svc) => (
                <tr key={svc.name}>
                  <td style={s.td}>{svc.name}</td>
                  <td style={s.td}>
                    <span style={statusDotStyle(svc.status)} />
                    {svc.status === "ok" ? t("ops.normal", "正常") : svc.status === "error" ? t("ops.abnormal", "异常") : t("ops.unknown", "未知")}
                  </td>
                  <td style={s.td}>{svc.latencyMs}ms</td>
                  <td style={s.td}>-</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Diagnostics Summary */}
      <div style={s.panel}>
        <div style={s.panelHeader}>
          <span style={s.panelTitle}>{t("ops.diagnostics_info", "诊断信息")}</span>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            {diagnostics?.collectedAt ? new Date(diagnostics.collectedAt).toLocaleTimeString() : "-"}
          </span>
        </div>
        <div style={{ padding: "14px 16px" }}>
          {diagnostics ? (
            <pre style={{
              margin: 0, fontSize: "11px", color: "var(--text-secondary)", lineHeight: "1.6",
              whiteSpace: "pre-wrap", wordBreak: "break-all",
              maxHeight: "300px", overflow: "auto",
            }}>
              {JSON.stringify({ os: diagnostics.os, process: diagnostics.process }, null, 2)}
            </pre>
          ) : (
            <div style={s.empty}>{t("ops.no_diag_data", "暂无诊断数据")}</div>
          )}
        </div>
      </div>
    </div>
  );
}