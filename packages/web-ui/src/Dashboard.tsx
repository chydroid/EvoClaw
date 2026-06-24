import React, { useState, useEffect, useCallback, useRef } from "react";
import { PageHeader, Card, Badge, StatsGrid, DataTable, Section, Loading, ErrorBanner } from "./shared";
import { useTranslation } from "./i18n";

interface SystemHealth {
  status: string;
  version: string;
  uptime: number;
  nodeVersion: string;
  platform: string;
}

interface SessionInfo {
  id: string;
  messageCount: number;
  lastActive: string;
  compactionCount: number;
  tokensUsed: number;
}

interface ProviderStatus {
  name: string;
  provider: string;
  model: string;
  status: "active" | "error" | "inactive";
  lastError?: string;
  lastErrorType?: string;
  successCount: number;
  failureCount: number;
}

interface SkillStats {
  total: number;
  installed: number;
  active: number;
  failed: number;
  categories: Record<string, number>;
}

interface BootstrapFile {
  path: string;
  exists: boolean;
  size: number;
}

interface DashboardData {
  health: SystemHealth;
  sessions: SessionInfo[];
  providers: ProviderStatus[];
  skills: SkillStats;
  bootstrapFiles: BootstrapFile[];
}

const s = {
  container: { padding: "20px", overflow: "auto", height: "100%" } as React.CSSProperties,
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "16px", marginBottom: "20px" } as React.CSSProperties,
  card: {
    background: "var(--bg-card)", border: "1px solid var(--border)",
    borderRadius: "10px", padding: "18px",
  },
  cardTitle: {
    fontSize: "13px", fontWeight: "bold", color: "var(--text-primary)",
    marginBottom: "14px", display: "flex", alignItems: "center", gap: "8px",
  } as React.CSSProperties,
  badge: (color: string): React.CSSProperties => ({
    display: "inline-block", width: "8px", height: "8px", borderRadius: "50%",
    background: color, marginRight: "6px",
  }),
  row: { display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: "13px" } as React.CSSProperties,
  label: { color: "var(--text-muted)" } as React.CSSProperties,
  value: { color: "var(--text-primary)", fontWeight: "600" } as React.CSSProperties,
  valueBadge: (color: string): React.CSSProperties => ({
    display: "inline-block", padding: "2px 8px", borderRadius: "4px",
    background: `${color}18`, color, fontSize: "12px", fontWeight: "bold",
    border: `1px solid ${color}40`,
  }),
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: "12px" },
  th: { textAlign: "left" as const, padding: "6px 8px", color: "var(--text-muted)", fontWeight: "600", borderBottom: "1px solid var(--border)" },
  td: { padding: "7px 8px", color: "var(--text-primary)", borderBottom: "1px solid var(--border)" },
  categoryBar: { display: "flex", gap: "4px", marginTop: "4px" } as React.CSSProperties,
  categorySegment: (width: string, bg: string): React.CSSProperties => ({
    height: "6px", borderRadius: "3px", background: bg, width,
  }),
  statsGrid: {
    display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px", marginBottom: "12px",
  } as React.CSSProperties,
  statBox: {
    textAlign: "center" as const, padding: "10px 6px",
    background: "var(--bg-input)", borderRadius: "8px",
  },
  statNum: { fontSize: "22px", fontWeight: "bold", lineHeight: "1.2" } as React.CSSProperties,
  statLabel: { fontSize: "10px", color: "var(--text-muted)", marginTop: "2px" } as React.CSSProperties,
  refreshBtn: {
    padding: "5px 12px", borderRadius: "6px", border: "1px solid var(--accent)",
    background: "transparent", color: "var(--accent)", cursor: "pointer",
    fontSize: "11px", marginLeft: "auto",
  } as React.CSSProperties,
  fullWidth: { gridColumn: "1 / -1" } as React.CSSProperties,
};

const CATEGORY_COLORS = [
  "#a78bfa", "#60a5fa", "#34d399", "#fbbf24", "#f472b6",
  "#fb923c", "#22d3ee", "#a3e635", "#e879f9",
];

export default function Dashboard() {
  const { t } = useTranslation();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [healthRes, sessionsRes, providersRes, skillsRes, bsRes] = await Promise.allSettled([
        fetch("/api/health", { signal }),
        fetch("/api/system/sessions", { signal }).catch(() => null),
        fetch("/api/system/providers", { signal }).catch(() => null),
        fetch("/api/skills", { signal }),
        fetch("/api/system/bootstrap-files", { signal }).catch(() => null),
      ]);
      if (signal?.aborted) return;

      const health = healthRes.status === "fulfilled" && healthRes.value.ok
        ? await healthRes.value.json() as SystemHealth : null;

      const sessions = sessionsRes.status === "fulfilled" && (sessionsRes.value as Response | null)?.ok
        ? await (sessionsRes.value as Response).json() as SessionInfo[] : [];

      const providers = providersRes.status === "fulfilled" && (providersRes.value as Response | null)?.ok
        ? await (providersRes.value as Response).json() as ProviderStatus[] : [];

      const skills = skillsRes.status === "fulfilled" && skillsRes.value.ok
        ? await skillsRes.value.json() as any[] : [];

      const bootstrapFiles = bsRes.status === "fulfilled" && (bsRes.value as Response | null)?.ok
        ? await (bsRes.value as Response).json() as BootstrapFile[] : [];

      const categories: Record<string, number> = {};
      for (const sk of (skills || [])) {
        const cat = sk.category || "uncategorized";
        categories[cat] = (categories[cat] || 0) + 1;
      }

      setData({
        health: health || { status: "unknown", version: "-", uptime: 0, nodeVersion: "-", platform: "-" },
        sessions: sessions || [],
        providers: providers || [],
        skills: {
          total: (skills || []).length,
          installed: (skills || []).filter((s: any) => s.lifecycle?.status === "draft" || s.lifecycle?.status === "active").length,
          active: (skills || []).filter((s: any) => s.lifecycle?.status === "active").length,
          failed: (skills || []).filter((s: any) => s.lifecycle?.status === "failed").length,
          categories,
        },
        bootstrapFiles: bootstrapFiles || [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("dashboard.load_error"));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    fetchData(controller.signal);
    const interval = setInterval(() => fetchData(controller.signal), 30000);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [fetchData]);

  if (loading && !data) {
    return <div style={s.container}><Loading text={t("dashboard.loading")} /></div>;
  }

  if (error && !data) {
    return <div style={s.container}><ErrorBanner message={error} onRetry={() => fetchData()} /></div>;
  }

  if (!data) return null;

  const healthColor = data.health.status === "ok" ? "#22c55e" : data.health.status === "degraded" ? "#f59e0b" : "#ef4444";

  function formatUptime(seconds: number): string {
    if (!seconds || seconds < 0) return "-";
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}${t("dashboard.uptime_d")} ${h}${t("dashboard.uptime_h")}`;
    if (h > 0) return `${h}${t("dashboard.uptime_h")} ${m}${t("dashboard.uptime_m")}`;
    return `${m}${t("dashboard.uptime_m")}`;
  }

  function compactCount(sessions: SessionInfo[]): number {
    return sessions.reduce((sum, s) => sum + (s.compactionCount || 0), 0);
  }

  function totalTokens(sessions: SessionInfo[]): number {
    return sessions.reduce((sum, s) => sum + (s.tokensUsed || 0), 0);
  }

  return (
    <div style={s.container}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <PageHeader title={t("dashboard.title")} />
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{t("dashboard.auto_refresh")}</span>
          <button style={s.refreshBtn} onClick={() => fetchData()}>{t("dashboard.refresh")}</button>
        </div>
      </div>

      <StatsGrid items={[
        { label: t("dashboard.sessions_count"), value: data.sessions.length, color: "#a78bfa" },
        { label: t("dashboard.total_tokens"), value: totalTokens(data.sessions), color: "#60a5fa" },
        { label: t("dashboard.sessions_compactions"), value: compactCount(data.sessions), color: "#fbbf24" },
        { label: t("dashboard.total_messages"), value: data.sessions.reduce((sum, s) => sum + (s.messageCount || 0), 0), color: "#34d399" },
      ]} />

      <div style={s.grid}>
        {/* System Health */}
        <Card title={<><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: healthColor, marginRight: 8 }} />{t("dashboard.health_header")}</>}>
          <div style={s.row}><span style={s.label}>{t("dashboard.providers_status")}</span><Badge variant={data.health.status === "ok" ? "success" : data.health.status === "degraded" ? "warning" : "error"}>{data.health.status === "ok" ? t("dashboard.service_healthy") : data.health.status === "degraded" ? t("dashboard.service_degraded") : data.health.status === "unhealthy" ? t("dashboard.service_unhealthy") : t("dashboard.service_unknown")}</Badge></div>
          <div style={s.row}><span style={s.label}>{t("dashboard.version")}</span><span style={s.value}>{data.health.version}</span></div>
          <div style={s.row}><span style={s.label}>{t("dashboard.uptime")}</span><span style={s.value}>{formatUptime(data.health.uptime)}</span></div>
          <div style={s.row}><span style={s.label}>{t("dashboard.platform")}</span><span style={s.value}>{data.health.platform}</span></div>
          <div style={s.row}><span style={s.label}>Node.js</span><span style={s.value}>{data.health.nodeVersion}</span></div>
        </Card>

        {/* Provider Status */}
        <Card title={t("dashboard.providers_header")}>
          {data.providers.length > 0 ? (
            data.providers.map((p, i) => (
              <div key={i} style={{ marginBottom: "10px" }}>
                <div style={s.row}>
                  <span style={s.label}>
                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: p.status === "active" ? "#22c55e" : p.status === "error" ? "#ef4444" : "#6b7280", marginRight: 6 }} />
                    {p.name}
                  </span>
                  <span style={{ ...s.value, fontSize: "11px" }}>{p.provider} / {p.model}</span>
                </div>
                <div style={{ display: "flex", gap: "12px", marginTop: "3px", fontSize: "11px" }}>
                  <span style={{ color: "#22c55e" }}>{t("dashboard.providers_success")} {p.successCount}</span>
                  <span style={{ color: p.failureCount > 0 ? "#ef4444" : "var(--text-muted)" }}>{t("dashboard.providers_failure")} {p.failureCount}</span>
                </div>
                {p.lastError && (
                  <div style={{ fontSize: "10px", color: "#ef4444", marginTop: "3px", wordBreak: "break-all" }}>
                    {p.lastErrorType ? `[${p.lastErrorType}] ` : ""}{p.lastError.slice(0, 80)}
                  </div>
                )}
              </div>
            ))
          ) : (
            <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>{t("dashboard.no_providers")}</div>
          )}
        </Card>

        {/* Skills Overview */}
        <Card title={t("dashboard.skills_header")}>
          <StatsGrid items={[
            { label: t("dashboard.skills_total"), value: data.skills.total, color: "#a78bfa" },
            { label: t("dashboard.skills_active"), value: data.skills.active, color: "#22c55e" },
            { label: t("dashboard.skills_installed"), value: data.skills.installed, color: "#60a5fa" },
            { label: t("dashboard.skills_failed"), value: data.skills.failed, color: data.skills.failed > 0 ? "#ef4444" : "var(--text-muted)" },
          ]} />
          {Object.keys(data.skills.categories).length > 0 ? (
            <div style={{ marginTop: 12 }}>
              {Object.entries(data.skills.categories).slice(0, 5).map(([cat, count], i) => {
                const pct = Math.round((count / data.skills.total) * 100);
                return (
                  <div key={cat} style={{ marginBottom: "6px" }}>
                    <div style={s.row}>
                      <span style={{ ...s.label, fontSize: "12px" }}>{cat}</span>
                      <span style={{ fontSize: "12px", color: "var(--text-primary)" }}>{count} ({pct}%)</span>
                    </div>
                    <div style={s.categoryBar}>
                      <div style={s.categorySegment(`${pct}%`, CATEGORY_COLORS[i % CATEGORY_COLORS.length])} />
                      <div style={{ flex: 1, height: "6px", borderRadius: "3px", background: "var(--bg-input)" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "10px 0" }}>{t("dashboard.no_skills_installed")}</div>
          )}
        </Card>

        {/* Sessions */}
        <Card title={t("dashboard.sessions_header_count").replace("{0}", String(data.sessions.length))}>
          {data.sessions.length > 0 ? (
            <DataTable
              columns={[
                { key: "id", label: t("dashboard.session_id"), render: (s: SessionInfo) => <span style={{ fontSize: "11px", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{s.id}</span> },
                { key: "messageCount", label: t("dashboard.sessions_messages") },
                { key: "tokensUsed", label: t("dashboard.token") },
                { key: "compactionCount", label: t("dashboard.compaction") },
              ]}
              data={data.sessions.slice(0, 4)}
              keyFn={(s) => s.id}
              emptyText={t("dashboard.no_active_sessions")}
            />
          ) : (
            <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "10px 0" }}>{t("dashboard.no_active_sessions")}</div>
          )}
        </Card>

        {/* Bootstrap Files */}
        <Card title={t("dashboard.bootstrap_header")} style={{ gridColumn: "1 / -1" }}>
          {data.bootstrapFiles.length > 0 ? (
            <DataTable
              columns={[
                { key: "path", label: t("dashboard.file"), render: (f: BootstrapFile) => <span style={{ fontFamily: "monospace", fontSize: "12px" }}>{f.path}</span> },
                { key: "exists", label: t("dashboard.providers_status"), render: (f: BootstrapFile) => <Badge variant={f.exists ? "success" : "default"}>{f.exists ? t("dashboard.yes") : t("dashboard.no")}</Badge> },
                { key: "size", label: t("dashboard.size"), render: (f: BootstrapFile) => f.exists ? `${(f.size / 1024).toFixed(1)} KB` : "-" },
              ]}
              data={data.bootstrapFiles}
              keyFn={(f) => f.path}
              emptyText={t("dashboard.no_bootstrap_files")}
            />
          ) : (
            <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>{t("dashboard.no_bootstrap_files")}</div>
          )}
        </Card>
      </div>
    </div>
  );
}