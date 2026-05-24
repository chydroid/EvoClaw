/**
 * SessionRetentionPage — Session retention policy management.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Card, PageHeader, Loading, ErrorBanner, Section,
  PrimaryButton, SecondaryButton, Toggle, StatsGrid, showToast,
} from "./shared";
import { retentionApi, type RetentionPolicy, type RetentionStats } from "./api-client";

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<number | null>(null);

  // Policy state
  const [maxAgeDays, setMaxAgeDays] = useState(30);
  const [maxInactiveDays, setMaxInactiveDays] = useState(7);
  const [maxSessions, setMaxSessions] = useState(100);
  const [maxMessagesPerSession, setMaxMessagesPerSession] = useState(1000);
  const [enabled, setEnabled] = useState(true);

  // Stats state
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
      setError(err instanceof Error ? err.message : "Failed to load retention data");
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
      showToast("Retention policy saved", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save policy", "error");
    } finally {
      setSaving(false);
    }
  }, [maxAgeDays, maxInactiveDays, maxSessions, maxMessagesPerSession, enabled]);

  const handleRunCleanup = useCallback(async () => {
    setCleaning(true);
    setCleanResult(null);
    try {
      const result = await retentionApi.runNow();
      setCleanResult(result.cleaned);
      showToast(`Cleaned up ${result.cleaned} sessions`, "success");
      await fetchData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Cleanup failed", "error");
    } finally {
      setCleaning(false);
    }
  }, [fetchData]);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return "Never";
    return new Date(dateStr).toLocaleString("zh-CN");
  };

  if (loading) return <Loading text="Loading retention policy..." />;

  return (
    <div style={s.container}>
      <PageHeader
        title="Session Retention"
        subtitle="Manage session lifecycle and cleanup policies"
        actions={<SecondaryButton onClick={fetchData} small>Refresh</SecondaryButton>}
      />

      {error && <ErrorBanner message={error} onRetry={fetchData} />}

      {/* Stats */}
      <StatsGrid
        items={[
          { label: "Total Sessions", value: stats.totalSessions, color: "var(--accent)" },
          { label: "Expired", value: stats.expiredSessions, color: "var(--warning)" },
          { label: "Cleaned Up", value: stats.cleanedUp, color: "var(--success)" },
          { label: "Last Run", value: stats.lastRun ? new Date(stats.lastRun).toLocaleDateString("zh-CN") : "Never", sub: stats.lastRun ? new Date(stats.lastRun).toLocaleTimeString("zh-CN") : undefined },
        ]}
      />

      {/* Policy Configuration */}
      <Section title="Policy Configuration" style={{ marginTop: "20px" }}>
        <Card>
          <div style={s.toggleRow}>
            <Toggle checked={enabled} onChange={setEnabled} label={enabled ? "Enabled" : "Disabled"} />
          </div>
          <div style={s.policyGrid}>
            <div style={s.inputGroup}>
              <span style={s.label}>Max Age (Days)</span>
              <input
                type="number"
                style={s.input}
                value={maxAgeDays}
                onChange={(e) => setMaxAgeDays(Number(e.target.value))}
                min={1}
              />
            </div>
            <div style={s.inputGroup}>
              <span style={s.label}>Max Inactive (Days)</span>
              <input
                type="number"
                style={s.input}
                value={maxInactiveDays}
                onChange={(e) => setMaxInactiveDays(Number(e.target.value))}
                min={1}
              />
            </div>
            <div style={s.inputGroup}>
              <span style={s.label}>Max Sessions</span>
              <input
                type="number"
                style={s.input}
                value={maxSessions}
                onChange={(e) => setMaxSessions(Number(e.target.value))}
                min={1}
              />
            </div>
            <div style={s.inputGroup}>
              <span style={s.label}>Max Messages / Session</span>
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
              {saving ? "Saving..." : "Save Policy"}
            </PrimaryButton>
          </div>
        </Card>
      </Section>

      {/* Cleanup */}
      <Section title="Manual Cleanup" style={{ marginTop: "24px" }}>
        <Card>
          <div style={{ marginBottom: "12px", fontSize: "13px", color: "var(--text-secondary)" }}>
            Sessions that exceed retention thresholds will be removed. Last run: {formatDate(stats.lastRun)}
          </div>
          <PrimaryButton onClick={handleRunCleanup} disabled={cleaning} danger>
            {cleaning ? "Cleaning..." : "Run Cleanup Now"}
          </PrimaryButton>
          {cleanResult !== null && (
            <div style={s.cleanupResult}>
              Cleaned up {cleanResult} session{cleanResult !== 1 ? "s" : ""}
            </div>
          )}
        </Card>
      </Section>
    </div>
  );
}