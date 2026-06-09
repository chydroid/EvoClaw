import React, { useState, useEffect, useCallback } from "react";
import {
  Card, PageHeader, Loading, ErrorBanner, Section,
  PrimaryButton, SecondaryButton, Toggle, StatsGrid, showToast,
} from "./shared";
import { retentionApi, type RetentionPolicy, type RetentionStats } from "./api-client";
import { useTranslation } from "./i18n";

const s = {
  container: { padding: "20px", overflow: "auto", height: "100%" } as React.CSSProperties,
  policyGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "16px",
    marginBottom: "16px",
  } as React.CSSProperties,
  inputGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  } as React.CSSProperties,
  label: {
    fontSize: "12px",
    fontWeight: 600,
    color: "var(--text-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.3px",
  } as React.CSSProperties,
  input: {
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1px solid var(--input-border)",
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    fontSize: "13px",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  } as React.CSSProperties,
  toggleRow: {
    display: "flex",
    alignItems: "center",
    marginBottom: "16px",
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  } as React.CSSProperties,
  cleanupResult: {
    marginTop: "12px",
    padding: "10px 14px",
    borderRadius: "8px",
    fontSize: "13px",
    fontWeight: 600,
    background: "var(--success-bg)",
    color: "var(--success)",
    border: "1px solid var(--success)",
  } as React.CSSProperties,
};

export default function SessionRetentionPage() {
  const { t, lang } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<number | null>(null);

  const [maxAgeDays, setMaxAgeDays] = useState(30);
  const [maxInactiveDays, setMaxInactiveDays] = useState(7);
  const [maxSessions, setMaxSessions] = useState(100);
  const [maxMessagesPerSession, setMaxMessagesPerSession] = useState(1000);
  const [enabled, setEnabled] = useState(true);

  const [stats, setStats] = useState<RetentionStats>({
    totalSessions: 0,
    expiredSessions: 0,
    cleanedUp: 0,
    lastRun: "",
  });

  const fetchData = useCallback(async () => {
    try {
      const [policyRes, statsRes] = await Promise.all([
        retentionApi.getPolicy(),
        retentionApi.getStats(),
      ]);

      const policy = policyRes.policy;
      setMaxAgeDays(policy.maxAgeDays);
      setMaxInactiveDays(policy.maxInactiveDays);
      setMaxSessions(policy.maxSessions);
      setMaxMessagesPerSession(policy.maxMessagesPerSession);
      setEnabled(policy.enabled);
      setStats(statsRes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("retention.load_fail"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await retentionApi.updatePolicy({
        maxAgeDays,
        maxInactiveDays,
        maxSessions,
        maxMessagesPerSession,
        enabled,
      });
      showToast(t("retention.saved_ok"), "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("retention.save_fail"), "error");
    } finally {
      setSaving(false);
    }
  }, [maxAgeDays, maxInactiveDays, maxSessions, maxMessagesPerSession, enabled, t]);

  const handleRunCleanup = useCallback(async () => {
    setCleaning(true);
    setCleanResult(null);
    try {
      const result = await retentionApi.runNow();
      setCleanResult(result.cleaned);
      showToast(t("retention.cleaned_count", String(result.cleaned)), "success");
      await fetchData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("retention.clean_fail"), "error");
    } finally {
      setCleaning(false);
    }
  }, [fetchData, t]);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return t("retention.never");
    return new Date(dateStr).toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
  };

  if (loading) return <Loading text={t("app.loading")} />;

  return (
    <div style={s.container}>
      <PageHeader
        title={t("retention.title")}
        subtitle={t("retention.subtitle")}
        actions={<SecondaryButton onClick={fetchData} small>{t("retention.refresh_btn")}</SecondaryButton>}
      />

      {error && <ErrorBanner message={error} onRetry={fetchData} />}

      <StatsGrid
        items={[
          { label: t("retention.total_sessions"), value: stats.totalSessions, color: "var(--accent)" },
          { label: t("retention.expired"), value: stats.expiredSessions, color: "var(--warning)" },
          { label: t("retention.cleaned"), value: stats.cleanedUp, color: "var(--success)" },
          { label: t("retention.last_run"), value: stats.lastRun ? new Date(stats.lastRun).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US") : t("retention.never"), sub: stats.lastRun ? new Date(stats.lastRun).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US") : undefined },
        ]}
      />

      <Section title={t("retention.policy_config")} style={{ marginTop: "20px" }}>
        <Card>
          <div style={s.toggleRow}>
            <Toggle checked={enabled} onChange={setEnabled} label={enabled ? t("retention.enabled") : t("feature_flags.disabled")} />
          </div>
          <div style={s.policyGrid}>
            <div style={s.inputGroup}>
              <span style={s.label}>{t("retention.max_age")}</span>
              <input
                type="number"
                style={s.input}
                value={maxAgeDays}
                onChange={(e) => setMaxAgeDays(Number(e.target.value))}
                min={1}
              />
            </div>
            <div style={s.inputGroup}>
              <span style={s.label}>{t("retention.max_inactive")}</span>
              <input
                type="number"
                style={s.input}
                value={maxInactiveDays}
                onChange={(e) => setMaxInactiveDays(Number(e.target.value))}
                min={1}
              />
            </div>
            <div style={s.inputGroup}>
              <span style={s.label}>{t("retention.max_sessions")}</span>
              <input
                type="number"
                style={s.input}
                value={maxSessions}
                onChange={(e) => setMaxSessions(Number(e.target.value))}
                min={1}
              />
            </div>
            <div style={s.inputGroup}>
              <span style={s.label}>{t("retention.max_messages")}</span>
              <input
                type="number"
                style={s.input}
                value={maxMessagesPerSession}
                onChange={(e) => setMaxMessagesPerSession(Number(e.target.value))}
                min={1}
              />
            </div>
          </div>
          <div style={s.actions}>
            <PrimaryButton onClick={handleSave} disabled={saving}>
              {saving ? t("retention.saving") : t("retention.save")}
            </PrimaryButton>
          </div>
        </Card>
      </Section>

      <Section title={t("retention.manual_cleanup")} style={{ marginTop: "24px" }}>
        <Card>
          <div style={{ marginBottom: "12px", fontSize: "13px", color: "var(--text-secondary)" }}>
            {t("retention.cleanup_desc")} {formatDate(stats.lastRun)}
          </div>
          <PrimaryButton onClick={handleRunCleanup} disabled={cleaning} danger>
            {cleaning ? t("retention.cleaning") : t("retention.run_now")}
          </PrimaryButton>
          {cleanResult !== null && (
            <div style={s.cleanupResult}>
              {t("retention.cleaned_result", String(cleanResult))}
            </div>
          )}
        </Card>
      </Section>
    </div>
  );
}
