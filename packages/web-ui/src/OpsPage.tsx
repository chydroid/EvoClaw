/**
 * OpsPage — Crestodian Operations Manager UI.
 *
 * Displays system health, diagnostics, and service overview
 * from the Crestodian daemon guardian.
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "./i18n";
import { systemApi, type AuditAlert, type FailoverStatus } from "./api-client";

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
  const [auditAlerts, setAuditAlerts] = useState<AuditAlert[]>([]);
  const [auditStats, setAuditStats] = useState<Record<string, unknown>>({});
  const [failover, setFailover] = useState<FailoverStatus | null>(null);
  const [resettingProvider, setResettingProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async (isManual = false, signal?: AbortSignal) => {
    if (isManual) setRefreshing(true);
    try {
      const [healthRes, diagRes] = await Promise.all([
        fetch("/api/crestodian/health", { signal }),
        fetch("/api/crestodian/diagnostics", { signal }),
      ]);
      if (signal?.aborted) return;
      if (healthRes.ok) setHealth(await healthRes.json());
      if (diagRes.ok) setDiagnostics(await diagRes.json());
      // Audit & failover — best-effort, don't block main load
      const [auditRes, failoverRes] = await Promise.all([
        systemApi.audit(),
        systemApi.failoverStatus(),
      ]);
      if (signal?.aborted) return;
      setAuditAlerts(auditRes.alerts || []);
      setAuditStats(auditRes.stats || {});
      setFailover(failoverRes);
    } catch (err) {
      if (signal?.aborted) return;
      console.error("[OpsPage] Load data failed:", err);
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        if (isManual) setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadData(false, controller.signal);
    const interval = setInterval(() => loadData(false, controller.signal), 10000);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
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

  const handleResetFailover = useCallback(async (providerId?: string) => {
    const key = providerId || "__all__";
    setResettingProvider(key);
    try {
      await systemApi.resetFailover(providerId);
      await loadData(true);
    } catch (err) {
      console.error("[OpsPage] Reset failover failed:", err);
    } finally {
      setResettingProvider(null);
    }
  }, [loadData]);

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

      {/* Failover Status */}
      <div style={s.panel}>
        <div style={s.panelHeader}>
          <span style={s.panelTitle}>{t("ops.failover_status", "故障转移状态")}</span>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            {failover && (
              <span style={{
                padding: "2px 8px", borderRadius: "10px", fontSize: "11px", fontWeight: "bold",
                background: failover.status === "active" ? "var(--success-bg)" : "var(--error-bg)",
                color: failover.status === "active" ? "var(--success)" : "var(--error)",
              }}>
                {failover.status === "active" ? t("ops.active", "活跃") : t("ops.unavailable", "不可用")}
              </span>
            )}
            <button
              onClick={() => handleResetFailover()}
              disabled={resettingProvider === "__all__" || !failover || failover.status !== "active"}
              style={{
                ...s.refreshBtn, opacity: (resettingProvider === "__all__" || !failover || failover.status !== "active") ? 0.5 : 1,
                cursor: (resettingProvider === "__all__" || !failover || failover.status !== "active") ? "not-allowed" : "pointer",
              }}
            >
              {resettingProvider === "__all__" ? t("ops.resetting", "重置中...") : t("ops.reset_all_circuits", "重置全部熔断器")}
            </button>
          </div>
        </div>
        {failover && failover.status === "active" && failover.providers && failover.providers.length > 0 ? (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>{t("ops.provider", "Provider")}</th>
                <th style={s.th}>{t("ops.circuit_state", "熔断状态")}</th>
                <th style={s.th}>{t("ops.success_rate", "成功率")}</th>
                <th style={s.th}>{t("ops.priority", "优先级")}</th>
                <th style={s.th}>{t("ops.errors", "操作")}</th>
              </tr>
            </thead>
            <tbody>
              {failover.providers.map((p, i) => {
                const pid = p.id || p.name || `provider-${i}`;
                const circuitState = String(p.circuitState || "closed");
                const isResetting = resettingProvider === pid;
                return (
                  <tr key={pid}>
                    <td style={s.td}>{p.name || p.id || "-"}</td>
                    <td style={s.td}>
                      <span style={{
                        padding: "2px 8px", borderRadius: "10px", fontSize: "11px", fontWeight: "bold",
                        background: circuitState === "closed" ? "var(--success-bg)" : circuitState === "open" ? "var(--error-bg)" : "var(--warning-bg)",
                        color: circuitState === "closed" ? "var(--success)" : circuitState === "open" ? "var(--error)" : "var(--warning)",
                      }}>
                        {t(`ops.circuit.${circuitState}`, circuitState)}
                      </span>
                    </td>
                    <td style={s.td}>
                      {typeof p.successRateEma === "number" ? `${Math.round(p.successRateEma * 100)}%` : "-"}
                    </td>
                    <td style={s.td}>{p.dynamicPriority ?? "-"}</td>
                    <td style={s.td}>
                      <button
                        onClick={() => handleResetFailover(p.id)}
                        disabled={isResetting}
                        style={{
                          padding: "3px 10px", borderRadius: "6px",
                          border: "1px solid var(--border)", background: "var(--bg-hover)",
                          color: "var(--text-secondary)", cursor: isResetting ? "not-allowed" : "pointer",
                          fontSize: "11px", opacity: isResetting ? 0.5 : 1,
                        }}
                      >
                        {isResetting ? t("ops.resetting", "重置中...") : t("ops.reset_circuit", "重置")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div style={s.empty}>
            {failover?.status === "unavailable" ? t("ops.failover_unavailable", "故障转移管理器未注册") : t("ops.no_failover_data", "无故障转移数据")}
          </div>
        )}
      </div>

      {/* Audit Logs */}
      <div style={s.panel}>
        <div style={s.panelHeader}>
          <span style={s.panelTitle}>{t("ops.audit_logs", "系统审计日志")}</span>
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            {t("ops.alert_count", "{0} 条告警").replace("{0}", String(auditAlerts.length))}
          </span>
        </div>
        {auditAlerts.length === 0 ? (
          <div style={s.empty}>
            {Object.keys(auditStats).length > 0 ? t("ops.no_alerts", "无未确认告警") : t("ops.no_audit_data", "无审计数据")}
          </div>
        ) : (
          <div style={{ maxHeight: "320px", overflow: "auto" }}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>{t("ops.severity", "级别")}</th>
                  <th style={s.th}>{t("ops.message", "消息")}</th>
                  <th style={s.th}>{t("ops.timestamp", "时间")}</th>
                </tr>
              </thead>
              <tbody>
                {auditAlerts.slice(0, 50).map((alert, i) => {
                  const severity = String(alert.severity || "info");
                  return (
                    <tr key={alert.id || i}>
                      <td style={s.td}>
                        <span style={{
                          padding: "2px 8px", borderRadius: "10px", fontSize: "11px", fontWeight: "bold",
                          background: severity === "critical" || severity === "high" ? "var(--error-bg)" : severity === "medium" ? "var(--warning-bg)" : "var(--accent-bg)",
                          color: severity === "critical" || severity === "high" ? "var(--error)" : severity === "medium" ? "var(--warning)" : "var(--accent)",
                        }}>
                          {severity}
                        </span>
                      </td>
                      <td style={s.td}>{alert.message || JSON.stringify(alert)}</td>
                      <td style={s.td}>
                        {alert.timestamp ? new Date(alert.timestamp).toLocaleString() : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {Object.keys(auditStats).length > 0 && (
          <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border-light)" }}>
            <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "6px" }}>
              {t("ops.audit_stats", "审计统计")}
            </div>
            <pre style={{
              margin: 0, fontSize: "11px", color: "var(--text-secondary)", lineHeight: "1.6",
              whiteSpace: "pre-wrap", wordBreak: "break-all",
              maxHeight: "150px", overflow: "auto",
            }}>
              {JSON.stringify(auditStats, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}