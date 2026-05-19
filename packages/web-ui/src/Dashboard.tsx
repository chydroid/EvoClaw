import React, { useState, useEffect, useCallback } from "react";

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
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [healthRes, sessionsRes, providersRes, skillsRes, bsRes] = await Promise.allSettled([
        fetch("/api/health"),
        fetch("/api/system/sessions").catch(() => null),
        fetch("/api/system/providers").catch(() => null),
        fetch("/api/skills"),
        fetch("/api/system/bootstrap-files").catch(() => null),
      ]);

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
          installed: (skills || []).filter((s: any) => s.lifecycle?.status === "installed").length,
          active: (skills || []).filter((s: any) => s.lifecycle?.status === "active").length,
          failed: (skills || []).filter((s: any) => s.lifecycle?.status === "failed").length,
          categories,
        },
        bootstrapFiles: bootstrapFiles || [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard data");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading && !data) {
    return (
      <div style={s.container}>
        <div style={{ textAlign: "center", padding: "60px", color: "var(--text-muted)" }}>
          Loading dashboard...
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={s.container}>
        <div style={{ textAlign: "center", padding: "60px", color: "#ef4444" }}>
          {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const healthColor = data.health.status === "ok" ? "#22c55e" : data.health.status === "degraded" ? "#f59e0b" : "#ef4444";

  function formatUptime(seconds: number): string {
    if (!seconds || seconds < 0) return "-";
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
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
        <h2 style={{ fontSize: "18px", color: "var(--text-primary)", margin: 0 }}>System Dashboard</h2>
        <button style={s.refreshBtn} onClick={fetchData}>Refresh</button>
      </div>

      <div style={s.grid}>
        {/* System Health Card */}
        <div style={s.card}>
          <div style={s.cardTitle}>
            <span style={s.badge(healthColor)}></span>
            System Health
          </div>
          <div style={s.row}>
            <span style={s.label}>Status</span>
            <span style={s.valueBadge(healthColor)}>{data.health.status.toUpperCase()}</span>
          </div>
          <div style={s.row}>
            <span style={s.label}>Version</span>
            <span style={s.value}>{data.health.version}</span>
          </div>
          <div style={s.row}>
            <span style={s.label}>Uptime</span>
            <span style={s.value}>{formatUptime(data.health.uptime)}</span>
          </div>
          <div style={s.row}>
            <span style={s.label}>Platform</span>
            <span style={s.value}>{data.health.platform}</span>
          </div>
          <div style={s.row}>
            <span style={s.label}>Node.js</span>
            <span style={s.value}>{data.health.nodeVersion}</span>
          </div>
        </div>

        {/* Sessions Card */}
        <div style={s.card}>
          <div style={s.cardTitle}>📋 Sessions</div>
          <div style={s.statsGrid}>
            <div style={s.statBox}>
              <div style={{ ...s.statNum, color: "#a78bfa" }}>{data.sessions.length}</div>
              <div style={s.statLabel}>Active</div>
            </div>
            <div style={s.statBox}>
              <div style={{ ...s.statNum, color: "#60a5fa" }}>{totalTokens(data.sessions)}</div>
              <div style={s.statLabel}>Tokens</div>
            </div>
            <div style={s.statBox}>
              <div style={{ ...s.statNum, color: "#fbbf24" }}>{compactCount(data.sessions)}</div>
              <div style={s.statLabel}>Compactions</div>
            </div>
            <div style={s.statBox}>
              <div style={{ ...s.statNum, color: "#34d399" }}>{data.sessions.reduce((sum, s) => sum + (s.messageCount || 0), 0)}</div>
              <div style={s.statLabel}>Messages</div>
            </div>
          </div>
          {data.sessions.length > 0 ? (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Session</th>
                  <th style={s.th}>Msgs</th>
                  <th style={s.th}>Tokens</th>
                  <th style={s.th}>Compact</th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.slice(0, 4).map((ses) => (
                  <tr key={ses.id}>
                    <td style={{ ...s.td, fontSize: "11px", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ses.id}</td>
                    <td style={s.td}>{ses.messageCount}</td>
                    <td style={s.td}>{ses.tokensUsed}</td>
                    <td style={s.td}>{ses.compactionCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "10px 0" }}>
              No active sessions
            </div>
          )}
        </div>

        {/* Provider Status Card */}
        <div style={s.card}>
          <div style={s.cardTitle}>🔄 LLM Providers</div>
          {data.providers.length > 0 ? (
            data.providers.map((p, i) => (
              <div key={i} style={{ marginBottom: "10px" }}>
                <div style={s.row}>
                  <span style={s.label}>
                    <span style={s.badge(p.status === "active" ? "#22c55e" : p.status === "error" ? "#ef4444" : "#6b7280")}></span>
                    {p.name}
                  </span>
                  <span style={{ ...s.value, fontSize: "11px" }}>{p.provider} / {p.model}</span>
                </div>
                <div style={{ display: "flex", gap: "12px", marginTop: "3px", fontSize: "11px" }}>
                  <span style={{ color: "#22c55e" }}>✓ {p.successCount}</span>
                  <span style={{ color: p.failureCount > 0 ? "#ef4444" : "var(--text-muted)" }}>✗ {p.failureCount}</span>
                </div>
                {p.lastError && (
                  <div style={{ fontSize: "10px", color: "#ef4444", marginTop: "3px", wordBreak: "break-all" }}>
                    {p.lastErrorType ? `[${p.lastErrorType}] ` : ""}{p.lastError.slice(0, 80)}
                  </div>
                )}
              </div>
            ))
          ) : (
            <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>No provider data available</div>
          )}
        </div>

        {/* Skills Card */}
        <div style={s.card}>
          <div style={s.cardTitle}>🧩 Skills Overview</div>
          <div style={s.statsGrid}>
            <div style={s.statBox}>
              <div style={{ ...s.statNum, color: "#a78bfa" }}>{data.skills.total}</div>
              <div style={s.statLabel}>Total</div>
            </div>
            <div style={s.statBox}>
              <div style={{ ...s.statNum, color: "#22c55e" }}>{data.skills.active}</div>
              <div style={s.statLabel}>Active</div>
            </div>
            <div style={s.statBox}>
              <div style={{ ...s.statNum, color: "#60a5fa" }}>{data.skills.installed}</div>
              <div style={s.statLabel}>Installed</div>
            </div>
            <div style={s.statBox}>
              <div style={{ ...s.statNum, color: data.skills.failed > 0 ? "#ef4444" : "var(--text-muted)" }}>{data.skills.failed}</div>
              <div style={s.statLabel}>Failed</div>
            </div>
          </div>
          {Object.keys(data.skills.categories).length > 0 ? (
            <div>
              {Object.entries(data.skills.categories).slice(0, 5).map(([cat, count], i) => {
                const pct = Math.round((count / data.skills.total) * 100);
                return (
                  <div key={cat} style={{ marginBottom: "6px" }}>
                    <div style={s.row}>
                      <span style={{ ...s.label, fontSize: "12px" }}>{cat}</span>
                      <span style={{ fontSize: "12px", color: "var(--text-primary)" }}>{count} ({pct}%)</span>
                    </div>
                    <div style={s.categoryBar}>
                      <div style={s.categorySegment(`${pct}%`, CATEGORY_COLORS[i % CATEGORY_COLORS.length])}></div>
                      <div style={{ flex: 1, height: "6px", borderRadius: "3px", background: "var(--bg-input)" }}></div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "10px 0" }}>
              No skills installed
            </div>
          )}
        </div>

        {/* Bootstrap Files Card */}
        <div style={{ ...s.card, ...s.fullWidth }}>
          <div style={s.cardTitle}>📄 Bootstrap Files</div>
          {data.bootstrapFiles.length > 0 ? (
            <table style={{ ...s.table, width: "100%" }}>
              <thead>
                <tr>
                  <th style={s.th}>File</th>
                  <th style={s.th}>Status</th>
                  <th style={s.th}>Size</th>
                </tr>
              </thead>
              <tbody>
                {data.bootstrapFiles.map((f) => (
                  <tr key={f.path}>
                    <td style={{ ...s.td, fontFamily: "monospace", fontSize: "12px" }}>{f.path}</td>
                    <td style={s.td}>
                      <span style={s.valueBadge(f.exists ? "#22c55e" : "#6b7280")}>
                        {f.exists ? "Loaded" : "Missing"}
                      </span>
                    </td>
                    <td style={s.td}>{f.exists ? `${(f.size / 1024).toFixed(1)} KB` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>
              No bootstrap files detected
            </div>
          )}
        </div>
      </div>
    </div>
  );
}