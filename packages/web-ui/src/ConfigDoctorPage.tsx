/**
 * ConfigDoctorPage — Config diagnostics and repair.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, StatusDot, showToast,
} from "./shared";
import { configDoctorApi, type ConfigIssue } from "./api-client";

const s = {
  container: { padding: "20px", overflow: "auto", height: "100%" } as React.CSSProperties,
  healthBanner: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
    padding: "20px 24px",
    borderRadius: "12px",
    marginBottom: "20px",
  } as React.CSSProperties,
  healthIcon: {
    width: "48px",
    height: "48px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "28px",
    flexShrink: 0,
  } as React.CSSProperties,
  healthText: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  } as React.CSSProperties,
  healthTitle: {
    fontSize: "18px",
    fontWeight: 700,
  } as React.CSSProperties,
  healthSub: {
    fontSize: "13px",
    color: "var(--text-muted)",
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
    marginTop: "12px",
  } as React.CSSProperties,
  severityGroup: {
    marginBottom: "16px",
  } as React.CSSProperties,
  severityHeader: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px",
    fontSize: "13px",
    fontWeight: 600,
  } as React.CSSProperties,
  issueCard: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
    padding: "12px 16px",
    borderRadius: "8px",
    border: "1px solid var(--border)",
    background: "var(--bg-card)",
    marginBottom: "8px",
  } as React.CSSProperties,
  issueIcon: {
    width: "24px",
    height: "24px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "14px",
    flexShrink: 0,
    marginTop: "2px",
  } as React.CSSProperties,
  issueContent: {
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  issuePath: {
    fontFamily: "monospace",
    fontSize: "13px",
    fontWeight: 600,
    color: "var(--accent)",
    marginBottom: "4px",
  } as React.CSSProperties,
  issueMessage: {
    fontSize: "13px",
    color: "var(--text-primary)",
    marginBottom: "4px",
  } as React.CSSProperties,
  issueMeta: {
    fontSize: "11px",
    color: "var(--text-muted)",
    marginTop: "4px",
  } as React.CSSProperties,
  issueValue: {
    fontFamily: "monospace",
    fontSize: "11px",
    color: "var(--text-secondary)",
    background: "var(--bg-input)",
    padding: "2px 6px",
    borderRadius: "4px",
    display: "inline-block",
    marginTop: "2px",
  } as React.CSSProperties,
  fixButton: {
    padding: "4px 12px",
    borderRadius: "6px",
    border: "1px solid var(--accent)",
    background: "transparent",
    color: "var(--accent)",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 600,
    flexShrink: 0,
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  fixButtonDisabled: {
    padding: "4px 12px",
    borderRadius: "6px",
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "not-allowed",
    fontSize: "12px",
    fontWeight: 600,
    flexShrink: 0,
  } as React.CSSProperties,
};

function severityColor(severity: string): { bg: string; fg: string; border: string } {
  switch (severity) {
    case "error": return { bg: "var(--error-bg)", fg: "var(--error)", border: "var(--error)" };
    case "warning": return { bg: "var(--warning-bg)", fg: "var(--warning)", border: "var(--warning)" };
    case "info": return { bg: "var(--accent-bg)", fg: "var(--accent)", border: "var(--accent)" };
    default: return { bg: "var(--bg-hover)", fg: "var(--text-muted)", border: "var(--border)" };
  }
}

function severityIcon(severity: string): string {
  switch (severity) {
    case "error": return "\u2716";
    case "warning": return "\u26A0";
    case "info": return "\u2139";
    default: return "?";
  }
}

function healthConfig(healthy: boolean, issues: ConfigIssue[]) {
  const hasErrors = issues.some((i) => i.severity === "error");
  const hasWarnings = issues.some((i) => i.severity === "warning");

  if (healthy && issues.length === 0) {
    return {
      label: "Healthy",
      bg: "var(--success-bg)",
      border: "var(--success)",
      iconBg: "var(--success)",
      iconColor: "#fff",
      icon: "\u2713",
    };
  }
  if (hasErrors) {
    return {
      label: "Unhealthy",
      bg: "var(--error-bg)",
      border: "var(--error)",
      iconBg: "var(--error)",
      iconColor: "#fff",
      icon: "\u2716",
    };
  }
  if (hasWarnings) {
    return {
      label: "Degraded",
      bg: "var(--warning-bg)",
      border: "var(--warning)",
      iconBg: "var(--warning)",
      iconColor: "#fff",
      icon: "\u26A0",
    };
  }
  return {
    label: "Healthy",
    bg: "var(--success-bg)",
    border: "var(--success)",
    iconBg: "var(--success)",
    iconColor: "#fff",
    icon: "\u2713",
  };
}

export default function ConfigDoctorPage() {
  const [issues, setIssues] = useState<ConfigIssue[]>([]);
  const [healthy, setHealthy] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [fixingAll, setFixingAll] = useState(false);
  const [fixResult, setFixResult] = useState<{ fixed: number; remaining: number } | null>(null);

  const runDiagnosis = useCallback(async () => {
    setDiagnosing(true);
    setError(null);
    try {
      const result = await configDoctorApi.diagnose();
      setIssues(result.issues);
      setHealthy(result.healthy);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Diagnosis failed");
    } finally {
      setDiagnosing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    runDiagnosis();
    const interval = setInterval(runDiagnosis, 60000);
    return () => clearInterval(interval);
  }, [runDiagnosis]);

  const handleFix = useCallback(async (issue: ConfigIssue, value: unknown) => {
    setFixingId(issue.path);
    try {
      const result = await configDoctorApi.fix(issue.path, value);
      if (result.fixed) {
        showToast(`Fixed: ${issue.path}`, "success");
        await runDiagnosis();
      } else {
        showToast(`Could not fix: ${issue.path}`, "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Fix failed", "error");
    } finally {
      setFixingId(null);
    }
  }, [runDiagnosis]);

  const handleFixAll = useCallback(async () => {
    setFixingAll(true);
    setFixResult(null);
    try {
      const result = await configDoctorApi.fixAll();
      setFixResult(result);
      showToast(`Fixed ${result.fixed} issue(s), ${result.remaining} remaining`, result.remaining === 0 ? "success" : "info");
      await runDiagnosis();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Fix all failed", "error");
    } finally {
      setFixingAll(false);
    }
  }, [runDiagnosis]);

  if (loading) return <Loading text="Running diagnosis..." />;

  const hc = healthConfig(healthy, issues);
  const severityOrder: ConfigIssue["severity"][] = ["error", "warning", "info"];
  const grouped = severityOrder.reduce((acc, sev) => {
    const items = issues.filter((i) => i.severity === sev);
    if (items.length > 0) acc.push({ severity: sev, items });
    return acc;
  }, [] as Array<{ severity: ConfigIssue["severity"]; items: ConfigIssue[] }>);

  return (
    <div style={s.container}>
      <PageHeader
        title="Config Doctor"
        subtitle="Diagnose and fix configuration issues"
        actions={
          <div style={{ display: "flex", gap: "8px" }}>
            <SecondaryButton onClick={runDiagnosis} small disabled={diagnosing}>
              {diagnosing ? "Diagnosing..." : "Run Diagnosis"}
            </SecondaryButton>
          </div>
        }
      />

      {error && <ErrorBanner message={error} onRetry={runDiagnosis} />}

      {/* Health Banner */}
      <div style={{ ...s.healthBanner, background: hc.bg, border: `1px solid ${hc.border}` }}>
        <div style={{ ...s.healthIcon, background: hc.iconBg, color: hc.iconColor }}>
          {hc.icon}
        </div>
        <div style={s.healthText}>
          <div style={{ ...s.healthTitle, color: hc.border }}>
            System Status: {hc.label}
          </div>
          <div style={s.healthSub}>
            {issues.length} issue{issues.length !== 1 ? "s" : ""} found
            {" "}&bull;{" "}
            {issues.filter((i) => i.severity === "error").length} error(s),
            {" "}{issues.filter((i) => i.severity === "warning").length} warning(s),
            {" "}{issues.filter((i) => i.severity === "info").length} info(s)
          </div>
          {issues.length > 0 && (
            <div style={s.actions}>
              <PrimaryButton onClick={handleFixAll} disabled={fixingAll || fixingId !== null}>
                {fixingAll ? "Fixing All..." : "Fix All"}
              </PrimaryButton>
            </div>
          )}
          {fixResult && (
            <div style={{ marginTop: "8px", fontSize: "12px", color: "var(--success)", fontWeight: 600 }}>
              Fixed {fixResult.fixed} issue(s), {fixResult.remaining} remaining
            </div>
          )}
        </div>
      </div>

      {/* Issues */}
      {issues.length === 0 ? (
        <Card>
          <EmptyState icon="" title="No issues found" description="All configuration checks passed successfully" />
        </Card>
      ) : (
        grouped.map((group) => {
          const sc = severityColor(group.severity);
          return (
            <div key={group.severity} style={s.severityGroup}>
              <div style={s.severityHeader}>
                <Badge
                  variant={
                    group.severity === "error" ? "error" :
                    group.severity === "warning" ? "warning" : "info"
                  }
                >
                  {group.severity.toUpperCase()}
                </Badge>
                <span style={{ color: "var(--text-muted)" }}>{group.items.length} issue{group.items.length !== 1 ? "s" : ""}</span>
              </div>
              {group.items.map((issue) => (
                <div key={issue.path} style={s.issueCard}>
                  <div style={{ ...s.issueIcon, background: sc.bg, color: sc.fg }}>
                    {severityIcon(issue.severity)}
                  </div>
                  <div style={s.issueContent}>
                    <div style={s.issuePath}>{issue.path}</div>
                    <div style={s.issueMessage}>{issue.message}</div>
                    {issue.suggestion && (
                      <div style={s.issueMeta}>
                        Suggestion: {issue.suggestion}
                      </div>
                    )}
                    {issue.currentValue !== undefined && (
                      <div style={s.issueMeta}>
                        Current value: <span style={s.issueValue}>{JSON.stringify(issue.currentValue)}</span>
                      </div>
                    )}
                  </div>
                  <button
                    style={fixingId === issue.path ? s.fixButtonDisabled : s.fixButton}
                    onClick={() => handleFix(issue, issue.currentValue)}
                    disabled={fixingId === issue.path || fixingAll}
                  >
                    {fixingId === issue.path ? "Fixing..." : "Fix"}
                  </button>
                </div>
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}