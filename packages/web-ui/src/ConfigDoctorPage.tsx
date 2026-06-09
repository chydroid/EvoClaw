/**
 * ConfigDoctorPage — Config diagnostics and repair.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, StatusDot, showToast,
} from "./shared";
import { configDoctorApi, type ConfigIssue } from "./api-client";
import { useTranslation } from "./i18n";

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
      labelKey: "config_doctor.healthy",
      bg: "var(--success-bg)",
      border: "var(--success)",
      iconBg: "var(--success)",
      iconColor: "#fff",
      icon: "\u2713",
    };
  }
  if (hasErrors) {
    return {
      labelKey: "config_doctor.error",
      bg: "var(--error-bg)",
      border: "var(--error)",
      iconBg: "var(--error)",
      iconColor: "#fff",
      icon: "\u2716",
    };
  }
  if (hasWarnings) {
    return {
      labelKey: "config_doctor.warning",
      bg: "var(--warning-bg)",
      border: "var(--warning)",
      iconBg: "var(--warning)",
      iconColor: "#fff",
      icon: "\u26A0",
    };
  }
  return {
    labelKey: "config_doctor.healthy",
    bg: "var(--success-bg)",
    border: "var(--success)",
    iconBg: "var(--success)",
    iconColor: "#fff",
    icon: "\u2713",
  };
}

export default function ConfigDoctorPage() {
  const { t } = useTranslation();
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
      setError(err instanceof Error ? err.message : t("config_doctor.diag_fail"));
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
        showToast(t("config_doctor.fixed_path", "已修复: {0}").replace("{0}", issue.path), "success");
        await runDiagnosis();
      } else {
        showToast(t("config_doctor.cannot_fix", "无法修复: {0}").replace("{0}", issue.path), "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("config_doctor.fix_failed"), "error");
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
      showToast(t("config_doctor.fixed_summary", "已修复 {0} 个问题, {1} 个待处理").replace("{0}", String(result.fixed)).replace("{1}", String(result.remaining)), result.remaining === 0 ? "success" : "info");
      await runDiagnosis();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("config_doctor.fix_all_fail"), "error");
    } finally {
      setFixingAll(false);
    }
  }, [runDiagnosis]);

  if (loading) return <Loading text={t("config_doctor.running")} />;

  const hc = healthConfig(healthy, issues);
  const severityOrder: ConfigIssue["severity"][] = ["error", "warning", "info"];
  const grouped = severityOrder.reduce((acc, sev) => {
    const items = issues.filter((i) => i.severity === sev);
    if (items.length > 0) acc.push({ severity: sev, items });
    return acc;
  }, [] as Array<{ severity: ConfigIssue["severity"]; items: ConfigIssue[] }>);

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warning").length;
  const infoCount = issues.filter((i) => i.severity === "info").length;

  return (
    <div style={s.container}>
      <PageHeader
        title={t("config_doctor.title")}
        subtitle={t("config_doctor.subtitle")}
        actions={
          <div style={{ display: "flex", gap: "8px" }}>
            <SecondaryButton onClick={runDiagnosis} small disabled={diagnosing}>
              {diagnosing ? t("config_doctor.running") : t("config_doctor.run_diagnosis")}
            </SecondaryButton>
          </div>
        }
      />

      {error && <ErrorBanner message={error} onRetry={runDiagnosis} />}

      <div style={{ ...s.healthBanner, background: hc.bg, border: `1px solid ${hc.border}` }}>
        <div style={{ ...s.healthIcon, background: hc.iconBg, color: hc.iconColor }}>
          {hc.icon}
        </div>
        <div style={s.healthText}>
          <div style={{ ...s.healthTitle, color: hc.border }}>
            {t("config_doctor.system_status_label", "系统状态: {0}").replace("{0}", t(hc.labelKey))}
          </div>
          <div style={s.healthSub}>
            {t("config_doctor.issues_found_count", "发现 {0} 个问题").replace("{0}", String(issues.length))}
            {" "}&bull;{" "}
            {t("config_doctor.issue_summary", "{0} 个错误, {1} 个警告, {2} 个提示").replace("{0}", String(errorCount)).replace("{1}", String(warnCount)).replace("{2}", String(infoCount))}
          </div>
          {issues.length > 0 && (
            <div style={s.actions}>
              <PrimaryButton onClick={handleFixAll} disabled={fixingAll || fixingId !== null}>
                {fixingAll ? t("config_doctor.fixing_all") : t("config_doctor.fix_all")}
              </PrimaryButton>
            </div>
          )}
          {fixResult && (
            <div style={{ marginTop: "8px", fontSize: "12px", color: "var(--success)", fontWeight: 600 }}>
              {t("config_doctor.fixed_summary", "已修复 {0} 个问题, {1} 个待处理").replace("{0}", String(fixResult.fixed)).replace("{1}", String(fixResult.remaining))}
            </div>
          )}
        </div>
      </div>

      {issues.length === 0 ? (
        <Card>
          <EmptyState icon="" title={t("config_doctor.no_issues")} description={t("config_doctor.all_passed")} />
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
                <span style={{ color: "var(--text-muted)" }}>{t("config_doctor.issue_count", "{0} 个问题").replace("{0}", String(group.items.length))}</span>
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
                        {t("config_doctor.suggestion")}: {issue.suggestion}
                      </div>
                    )}
                    {issue.currentValue !== undefined && (
                      <div style={s.issueMeta}>
                        {t("config_doctor.current_value")}: <span style={s.issueValue}>{JSON.stringify(issue.currentValue)}</span>
                      </div>
                    )}
                  </div>
                  <button
                    style={fixingId === issue.path ? s.fixButtonDisabled : s.fixButton}
                    onClick={() => handleFix(issue, issue.currentValue)}
                    disabled={fixingId === issue.path || fixingAll}
                  >
                    {fixingId === issue.path ? t("config_doctor.fixing") : t("config_doctor.fix")}
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
