/**
 * HealthAggregatorPage — System health aggregation dashboard.
 *
 * Displays overall health status and a grid of component health cards
 * with real-time monitoring and recheck capabilities.
 */

import React, { useState, useEffect, useCallback } from "react";
import { Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState, Section, StatusDot, PrimaryButton, showToast } from "./shared";
import { healthApi } from "./api-client";
import type { ComponentHealth } from "./api-client";
import { useTranslation } from "./i18n";

type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

const STATUS_CONFIG: Record<HealthStatus, { color: string; bg: string; icon: string; labelKey: string }> = {
  healthy:   { color: "var(--success)", bg: "var(--success-bg)", icon: "\u2705", labelKey: "health_aggregator.healthy" },
  degraded:  { color: "var(--warning)", bg: "var(--warning-bg)", icon: "\u26a0\ufe0f", labelKey: "health_aggregator.degraded" },
  unhealthy: { color: "var(--error)", bg: "var(--error-bg)", icon: "\u274c", labelKey: "health_aggregator.unhealthy" },
  unknown:   { color: "var(--text-muted)", bg: "var(--bg-hover)", icon: "\u2753", labelKey: "health_aggregator.unknown" },
};

function statusVariant(s: string): "success" | "warning" | "error" | "default" {
  if (s === "healthy") return "success";
  if (s === "degraded") return "warning";
  if (s === "unhealthy") return "error";
  return "default";
}

function formatTime(ts: string, locale: string): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const s: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)", width: "100%", boxSizing: "border-box" },
  overallCard: {
    background: "var(--bg-card)", border: "1px solid var(--border)",
    borderRadius: "12px", padding: "28px 32px", marginBottom: "24px",
    display: "flex", alignItems: "center", gap: "24px", flexWrap: "wrap",
  },
  overallIcon: { fontSize: "48px", lineHeight: 1 },
  overallInfo: { flex: 1, minWidth: 0 },
  overallStatus: { fontSize: "22px", fontWeight: 700 },
  overallTimestamp: { fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" },
  overallSummary: { fontSize: "14px", color: "var(--text-secondary)", marginTop: "6px" },
  componentGrid: {
    display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "14px",
  },
  componentCard: {
    background: "var(--bg-card)", border: "1px solid var(--border)",
    borderRadius: "10px", padding: "18px",
    display: "flex", flexDirection: "column", gap: "10px",
  },
  componentHeader: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  componentName: { display: "flex", alignItems: "center", gap: "8px", fontWeight: 600, fontSize: "14px", color: "var(--text-primary)" },
  metaRow: { display: "flex", gap: "16px", fontSize: "12px", color: "var(--text-muted)", flexWrap: "wrap" },
  metaItem: { display: "flex", alignItems: "center", gap: "4px" },
  message: {
    fontSize: "12px", color: "var(--text-secondary)", padding: "8px 12px",
    borderRadius: "6px", background: "var(--bg-hover)", lineHeight: 1.5,
  },
  legend: {
    display: "flex", gap: "16px", flexWrap: "wrap", marginBottom: "20px",
    padding: "10px 16px", background: "var(--bg-card)", borderRadius: "8px",
    border: "1px solid var(--border-light)",
  },
  legendItem: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-secondary)" },
  legendDot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  footer: { color: "var(--text-muted)", fontSize: "10px", textAlign: "center", marginTop: "16px" },
};

export default function HealthAggregatorPage() {
  const { t, lang } = useTranslation();
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const [overall, setOverall] = useState<string>("loading");
  const [components, setComponents] = useState<ComponentHealth[]>([]);
  const [timestamp, setTimestamp] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  const loadHealth = useCallback(async () => {
    try {
      const data = await healthApi.full();
      setOverall(data.overall);
      setComponents(data.components || []);
      setTimestamp(data.timestamp);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("health_aggregator.load_fail"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadHealth();
    const interval = setInterval(loadHealth, 10000);
    return () => clearInterval(interval);
  }, [loadHealth]);

  const handleRecheck = useCallback(async (name: string) => {
    try {
      const updated = await healthApi.check(name);
      setComponents((prev) => prev.map((c) => (c.name === updated.name ? updated : c)));
      showToast(t("health_aggregator.recheck_done").replace("{0}", name), "success");
    } catch {
      showToast(t("health_aggregator.recheck_fail").replace("{0}", name), "error");
    }
  }, [t]);

  const healthyCount = components.filter((c) => c.status === "healthy").length;
  const degradedCount = components.filter((c) => c.status === "degraded").length;
  const unhealthyCount = components.filter((c) => c.status === "unhealthy").length;

  const overallCfg = STATUS_CONFIG[overall as HealthStatus] || STATUS_CONFIG.unknown;

  if (loading) return <div style={s.container}><Loading text={t("app.loading")} /></div>;
  if (error && components.length === 0) return <div style={s.container}><ErrorBanner message={error} onRetry={loadHealth} /></div>;

  return (
    <div style={s.container}>
      <PageHeader title={t("health_aggregator.title")} subtitle={t("health_aggregator.subtitle")} />

      <div style={s.legend}>
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
          <div key={key} style={s.legendItem}>
            <span style={{ ...s.legendDot, background: cfg.color }} />
            {t(cfg.labelKey)}
          </div>
        ))}
      </div>

      <div style={{ ...s.overallCard, borderColor: overallCfg.color + "60" }}>
        <div style={s.overallIcon}>{overallCfg.icon}</div>
        <div style={s.overallInfo}>
          <div style={{ ...s.overallStatus, color: overallCfg.color }}>{t(overallCfg.labelKey)}</div>
          <div style={s.overallTimestamp}>{t("health_aggregator.last_update_label")} {formatTime(timestamp, locale)}</div>
          <div style={s.overallSummary}>
            {t("health_aggregator.summary").replace("{0}", String(healthyCount)).replace("{1}", String(degradedCount)).replace("{2}", String(unhealthyCount))} &mdash; {t("health_aggregator.total_components").replace("{0}", String(components.length))}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", minWidth: "200px" }}>
          {[
            { label: t("health_aggregator.healthy"), value: healthyCount, color: "var(--success)" },
            { label: t("health_aggregator.degraded"), value: degradedCount, color: "var(--warning)" },
            { label: t("health_aggregator.unhealthy"), value: unhealthyCount, color: "var(--error)" },
            { label: t("health_aggregator.total_label"), value: components.length },
          ].map((item, i) => (
            <div key={i} style={{
              background: "var(--bg-input)", border: "1px solid var(--border-light)",
              borderRadius: "8px", padding: "10px 14px", textAlign: "center",
            }}>
              <div style={{ fontSize: "10px", color: "var(--text-muted)", fontWeight: 600, marginBottom: "2px" }}>{item.label}</div>
              <div style={{ fontSize: "22px", fontWeight: 700, color: item.color || "var(--text-primary)" }}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      <Section title={t("health_aggregator.components_header").replace("{0}", String(components.length))}>
        {components.length === 0 ? (
          <EmptyState title={t("health_aggregator.no_components")} description={t("health_aggregator.no_components_desc")} />
        ) : (
          <div style={s.componentGrid}>
            {components.map((comp) => (
              <div key={comp.name} style={s.componentCard}>
                <div style={s.componentHeader}>
                  <div style={s.componentName}>
                    <StatusDot status={comp.status} size={10} />
                    {comp.name}
                  </div>
                  <Badge variant={statusVariant(comp.status)}>{comp.status}</Badge>
                </div>
                <div style={s.metaRow}>
                  <span style={s.metaItem}>
                    <span style={{ color: "var(--text-muted)" }}>{t("health_aggregator.latency")}:</span> {comp.latencyMs}ms
                  </span>
                  <span style={s.metaItem}>
                    <span style={{ color: "var(--text-muted)" }}>{t("health_aggregator.last_check")}:</span> {formatTime(comp.lastCheck, locale)}
                  </span>
                </div>
                {comp.message && <div style={s.message}>{comp.message}</div>}
                <PrimaryButton small onClick={() => handleRecheck(comp.name)}>
                  {t("health_aggregator.check")}
                </PrimaryButton>
              </div>
            ))}
          </div>
        )}
      </Section>

      <div style={s.footer}>
        {t("health_aggregator.auto_refresh")} &middot; {t("health_aggregator.last_update_label")} {formatTime(timestamp, locale)}
      </div>
    </div>
  );
}
