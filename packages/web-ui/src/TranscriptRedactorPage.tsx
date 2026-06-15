/**
 * TranscriptRedactorPage — Sensitive data auto-redaction dashboard.
 *
 * Uses real backend APIs (no mock data).
 */
import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, EmptyState,
  Section, PrimaryButton, SecondaryButton,
  StatsGrid, showToast, Toggle, DataTable,
} from "./shared";
import type { BadgeVariant } from "./shared";
import { useTranslation } from "./i18n";

const API = (window as any).__EVOCLAW_API__ || "";

type Severity = "critical" | "high" | "medium" | "low";
type TabId = "overview" | "rules" | "test" | "audit";

interface RedactionRule {
  name: string;
  severity: Severity;
  pattern: string;
  replacement: string;
  enabled: boolean;
}

interface RedactionStats {
  totalRedactions: number;
  activeRules: number;
  totalRules: number;
  redactionRate: number;
  severityBreakdown: { critical: number; high: number; medium: number; low: number };
}

interface AuditEntry {
  id: string;
  timestamp: string;
  patternName: string;
  severity: Severity;
  originalMasked: string;
  channel: string;
  session: string;
}

interface ScanMatch {
  patternName: string;
  severity: Severity;
  match: string;
  index: number;
}

const SEVERITY_VARIANT: Record<Severity, BadgeVariant> = {
  critical: "error", high: "warning", medium: "info", low: "default",
};

export default function TranscriptRedactorPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>("overview");
  const [loading, setLoading] = useState(true);
  const [rules, setRules] = useState<RedactionRule[]>([]);
  const [stats, setStats] = useState<RedactionStats>({
    totalRedactions: 0, activeRules: 0, totalRules: 0, redactionRate: 0,
    severityBreakdown: { critical: 0, high: 0, medium: 0, low: 0 },
  });
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<{ redacted: string; matches: ScanMatch[] } | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, statsRes, auditRes] = await Promise.all([
        fetch(`${API}/api/transcript-redactor/rules`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/transcript-redactor/stats`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/transcript-redactor/audit?limit=50`).then(r => r.json()).catch(() => null),
      ]);

      const list: RedactionRule[] = (rulesRes?.rules || rulesRes || []) as any[];
      setRules(list);

      if (statsRes) {
        setStats({
          totalRedactions: Number(statsRes.totalRedactions) || 0,
          activeRules: list.filter(r => r.enabled).length,
          totalRules: list.length,
          redactionRate: Number(statsRes.redactionRate) || 0,
          severityBreakdown: statsRes.severityBreakdown || { critical: 0, high: 0, medium: 0, low: 0 },
        });
      } else {
        setStats({
          totalRedactions: 0,
          activeRules: list.filter(r => r.enabled).length,
          totalRules: list.length,
          redactionRate: 0,
          severityBreakdown: { critical: 0, high: 0, medium: 0, low: 0 },
        });
      }

      const auditList: AuditEntry[] = (auditRes?.entries || auditRes?.audit || auditRes || []) as any[];
      setAudit(auditList);
    } catch {
      // Keep empty state
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleToggleRule = async (ruleName: string, enabled: boolean) => {
    try {
      await fetch(`${API}/api/transcript-redactor/rules/${encodeURIComponent(ruleName)}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    } catch { /* ignore */ }
    setRules(prev => prev.map(r => r.name === ruleName ? { ...r, enabled } : r));
    showToast(t("redactor.toggleSuccess"), "success");
  };

  const handleScan = async () => {
    if (!testInput.trim()) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await fetch(`${API}/api/transcript-redactor/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: testInput }),
      });
      const data = await res.json();
      setTestResult({
        redacted: data.redacted ?? data.redactedText ?? testInput,
        matches: data.matches ?? data.detections ?? [],
      });
    } catch {
      setTestResult({ redacted: testInput, matches: [] });
    }
    setTestLoading(false);
  };

  if (loading) return <Loading />;

  const tabs: { id: TabId; key: string }[] = [
    { id: "overview", key: "redactor.tabs.overview" },
    { id: "rules", key: "redactor.tabs.rules" },
    { id: "test", key: "redactor.tabs.test" },
    { id: "audit", key: "redactor.tabs.audit" },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <PageHeader
        title={t("redactor.title")}
        subtitle={t("redactor.subtitle")}
        actions={
          <SecondaryButton small onClick={loadData}>↻</SecondaryButton>
        }
      />

      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
        {tabs.map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            style={{
              padding: "8px 16px", border: "none", borderRadius: 6, cursor: "pointer",
              background: tab === tb.id ? "var(--accent)" : "transparent",
              color: tab === tb.id ? "#fff" : "var(--text-muted)", fontWeight: 600, fontSize: 13,
            }}>
            {t(tb.key)}
          </button>
        ))}
      </div>

      {/* ── Overview Tab ── */}
      {tab === "overview" && (
        <div>
          <StatsGrid items={[
            { label: t("redactor.stats.totalRedactions"), value: stats.totalRedactions, color: "var(--accent)" },
            { label: t("redactor.stats.activeRules"), value: `${stats.activeRules}/${stats.totalRules}`, color: "var(--success)" },
            { label: t("redactor.stats.redactionRate"), value: stats.redactionRate.toFixed(1) + "%", color: "var(--warning)" },
            { label: t("redactor.stats.severityDist"), value: stats.severityBreakdown.critical, color: "var(--error)" },
          ]} />

          {stats.totalRedactions > 0 && (
            <Section title={t("redactor.stats.severityDist")} style={{ marginTop: 24 }}>
              <Card>
                {(["critical", "high", "medium", "low"] as Severity[]).map(sev => {
                  const count = stats.severityBreakdown[sev] ?? 0;
                  const total = Object.values(stats.severityBreakdown).reduce((a, b) => a + b, 0);
                  const pct = total > 0 ? (count / total) * 100 : 0;
                  return (
                    <div key={sev} style={{ marginBottom: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <Badge variant={SEVERITY_VARIANT[sev]}>{t(`redactor.severity.${sev}`)}</Badge>
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{count} ({pct.toFixed(1)}%)</span>
                      </div>
                      <div style={{ height: 6, background: "var(--bg-hover)", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: "var(--accent)", borderRadius: 3 }} />
                      </div>
                    </div>
                  );
                })}
              </Card>
            </Section>
          )}
        </div>
      )}

      {/* ── Rules Tab ── */}
      {tab === "rules" && (
        <Card>
          {rules.length === 0 ? (
            <EmptyState title={t("redactor.empty.rules")} />
          ) : (
            <DataTable<RedactionRule>
              columns={[
                { key: "name", label: t("redactor.col.name"), render: r => (
                  <code style={{ fontSize: 12, color: "var(--accent)" }}>{r.name}</code>
                )},
                { key: "severity", label: t("redactor.col.severity"), width: "100px", render: r => (
                  <Badge variant={SEVERITY_VARIANT[r.severity] || "default"}>{r.severity}</Badge>
                )},
                { key: "pattern", label: t("redactor.col.pattern"), render: r => (
                  <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.pattern.length > 60 ? r.pattern.slice(0, 60) + "..." : r.pattern}</code>
                )},
                { key: "replacement", label: t("redactor.col.replacement"), render: r => (
                  <code style={{ fontSize: 11, color: "var(--warning)" }}>{r.replacement}</code>
                )},
                { key: "enabled", label: t("redactor.col.enabled"), width: "80px", render: r => (
                  <Toggle checked={r.enabled} onChange={(v) => handleToggleRule(r.name, v)} />
                )},
              ]}
              data={rules}
              keyFn={r => r.name}
            />
          )}
        </Card>
      )}

      {/* ── Test Tab ── */}
      {tab === "test" && (
        <div>
          <Section title={t("redactor.test.inputLabel")}>
            <Card>
              <textarea
                value={testInput}
                onChange={e => setTestInput(e.target.value)}
                placeholder={t("redactor.test.placeholder")}
                rows={8}
                style={{
                  width: "100%", padding: "12px", borderRadius: 6,
                  background: "var(--bg-input)", border: "1px solid var(--border)",
                  color: "var(--text-primary)", fontSize: 13, fontFamily: "monospace",
                  resize: "vertical", outline: "none", boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <PrimaryButton onClick={handleScan} disabled={testLoading || !testInput.trim()}>
                  {testLoading ? "..." : t("redactor.test.button")}
                </PrimaryButton>
                <SecondaryButton onClick={() => { setTestInput(""); setTestResult(null); }}>×</SecondaryButton>
              </div>
            </Card>
          </Section>

          {testResult && (
            <>
              <Section title={t("redactor.test.redacted")} style={{ marginTop: 20 }}>
                <Card>
                  <pre style={{
                    margin: 0, padding: 12, background: "var(--bg-input)",
                    border: "1px solid var(--border)", borderRadius: 6,
                    fontSize: 12, color: "var(--text-primary)", whiteSpace: "pre-wrap", wordBreak: "break-all",
                  }}>{testResult.redacted}</pre>
                </Card>
              </Section>

              <Section title={t("redactor.test.detected")} style={{ marginTop: 20 }}>
                {testResult.matches.length === 0 ? (
                  <EmptyState title={t("redactor.test.noMatch")} />
                ) : (
                  <Card>
                    {testResult.matches.map((m, i) => (
                      <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid var(--border-light)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <Badge variant={SEVERITY_VARIANT[m.severity] || "default"}>{m.severity}</Badge>
                          <code style={{ fontSize: 12, color: "var(--accent)" }}>{m.patternName}</code>
                          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>@{m.index}</span>
                        </div>
                        <code style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4, display: "block" }}>
                          {m.match}
                        </code>
                      </div>
                    ))}
                  </Card>
                )}
              </Section>
            </>
          )}
        </div>
      )}

      {/* ── Audit Tab ── */}
      {tab === "audit" && (
        <Card>
          {audit.length === 0 ? (
            <EmptyState title={t("redactor.empty.audit")} />
          ) : (
            <DataTable<AuditEntry>
              columns={[
                { key: "timestamp", label: t("redactor.col.timestamp"), width: "170px", render: a => (
                  <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {a.timestamp ? new Date(a.timestamp).toLocaleString() : ""}
                  </span>
                )},
                { key: "patternName", label: t("redactor.col.name"), render: a => (
                  <code style={{ fontSize: 12, color: "var(--accent)" }}>{a.patternName}</code>
                )},
                { key: "severity", label: t("redactor.col.severity"), width: "90px", render: a => (
                  <Badge variant={SEVERITY_VARIANT[a.severity] || "default"}>{a.severity}</Badge>
                )},
                { key: "originalMasked", label: t("redactor.col.originalMasked"), render: a => (
                  <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{a.originalMasked}</code>
                )},
                { key: "channel", label: t("redactor.col.channel"), render: a => (
                  <Badge variant="default">{a.channel}</Badge>
                )},
                { key: "session", label: t("redactor.col.session"), render: a => (
                  <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{a.session}</code>
                )},
              ]}
              data={audit}
              keyFn={a => a.id}
            />
          )}
        </Card>
      )}
    </div>
  );
}
