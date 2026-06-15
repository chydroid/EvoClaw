/**
 * TranscriptRedactorPage — Sensitive data auto-redaction dashboard.
 *
 * Shows: Redaction stats, rule catalog, content scanner, audit log.
 */
import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, EmptyState,
  Section, PrimaryButton, SecondaryButton, GhostButton,
  StatsGrid, Modal, showToast, Toggle, DataTable, TextInput,
} from "./shared";
import type { BadgeVariant } from "./shared";
import { useTranslation } from "./i18n";

const API = (window as any).__EVOCLAW_API__ || "";

// ── Types ──

type Severity = "critical" | "high" | "medium" | "low";
type TabId = "overview" | "rules" | "test" | "audit";

interface RedactionRule {
  id: string;
  name: string;
  severity: Severity;
  pattern: string;
  replacement: string;
  enabled: boolean;
}

interface RedactionStats {
  total: number;
  bySeverity: Record<Severity, number>;
  activeRules: number;
  redactionRate: number;
}

interface ScanMatch {
  ruleId: string;
  ruleName: string;
  severity: Severity;
  original: string;
  replacement: string;
  start: number;
  end: number;
}

interface ScanResult {
  redacted: string;
  matches: ScanMatch[];
}

interface AuditEntry {
  timestamp: string;
  patternName: string;
  severity: Severity;
  original: string;
  channel: string;
  session: string;
}

// ── Constants ──

const SEVERITY_VARIANT: Record<Severity, BadgeVariant> = {
  critical: "error",
  high: "warning",
  medium: "info",
  low: "default",
};

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ── Built-in rules (12 patterns) ──

const DEFAULT_RULES: RedactionRule[] = [
  { id: "openai-api-key", name: "OpenAI API Key", severity: "critical", pattern: "sk-[A-Za-z0-9]{20,}", replacement: "[REDACTED_OPENAI_KEY]", enabled: true },
  { id: "anthropic-api-key", name: "Anthropic API Key", severity: "critical", pattern: "sk-ant-[A-Za-z0-9]{20,}", replacement: "[REDACTED_ANTHROPIC_KEY]", enabled: true },
  { id: "jwt-token", name: "JWT Token", severity: "high", pattern: "eyJ[A-Za-z0-9-_]+\\.eyJ[A-Za-z0-9-_]+\\.[A-Za-z0-9-_]+", replacement: "[REDACTED_JWT]", enabled: true },
  { id: "aws-access-key", name: "AWS Access Key", severity: "critical", pattern: "AKIA[0-9A-Z]{16}", replacement: "[REDACTED_AWS_KEY]", enabled: true },
  { id: "github-token", name: "GitHub Token", severity: "critical", pattern: "gh[ps]_[A-Za-z0-9]{36}", replacement: "[REDACTED_GITHUB_TOKEN]", enabled: true },
  { id: "private-key", name: "Private Key", severity: "critical", pattern: "-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----", replacement: "[REDACTED_PRIVATE_KEY]", enabled: true },
  { id: "email", name: "Email Address", severity: "medium", pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", replacement: "[REDACTED_EMAIL]", enabled: true },
  { id: "phone-cn", name: "Phone (CN)", severity: "medium", pattern: "1[3-9]\\d{9}", replacement: "[REDACTED_PHONE]", enabled: true },
  { id: "ipv4", name: "IPv4 Address", severity: "low", pattern: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b", replacement: "[REDACTED_IP]", enabled: true },
  { id: "credit-card", name: "Credit Card", severity: "critical", pattern: "\\b(?:\\d[ -]*?){13,19}\\b", replacement: "[REDACTED_CC]", enabled: true },
  { id: "env-secret", name: "ENV Secret", severity: "high", pattern: "(?:PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL)\\s*=\\s*['\"]?[^\\s'\"\\n]{8,}", replacement: "[REDACTED_ENV_SECRET]", enabled: true },
  { id: "credential-harvesting", name: "Credential Harvesting", severity: "high", pattern: "(?:password|passwd|pwd|secret|token|api[_-]?key)\\s*[:=]\\s*\\S+", replacement: "[REDACTED_CREDENTIAL]", enabled: true },
];

// ── Mock audit data ──

const MOCK_AUDIT: AuditEntry[] = [
  { timestamp: "2026-06-15T10:23:41Z", patternName: "openai-api-key", severity: "critical", original: "sk-abc...xyz", channel: "wechat", session: "sess_001" },
  { timestamp: "2026-06-15T10:21:15Z", patternName: "email", severity: "medium", original: "j***@corp.com", channel: "slack", session: "sess_002" },
  { timestamp: "2026-06-15T10:18:03Z", patternName: "aws-access-key", severity: "critical", original: "AKIA...XXXX", channel: "api", session: "sess_003" },
  { timestamp: "2026-06-15T10:15:50Z", patternName: "phone-cn", severity: "medium", original: "138****1234", channel: "wechat", session: "sess_004" },
  { timestamp: "2026-06-15T10:12:22Z", patternName: "jwt-token", severity: "high", original: "eyJ...xxx", channel: "api", session: "sess_005" },
  { timestamp: "2026-06-15T10:09:11Z", patternName: "github-token", severity: "critical", original: "ghp_...abc", channel: "slack", session: "sess_006" },
  { timestamp: "2026-06-15T10:05:44Z", patternName: "ipv4", severity: "low", original: "192.168.x.x", channel: "api", session: "sess_007" },
  { timestamp: "2026-06-15T10:02:30Z", patternName: "credit-card", severity: "critical", original: "4111 **** **** 1111", channel: "wechat", session: "sess_008" },
  { timestamp: "2026-06-15T09:58:12Z", patternName: "env-secret", severity: "high", original: "PASSWORD=***", channel: "api", session: "sess_009" },
  { timestamp: "2026-06-15T09:55:01Z", patternName: "credential-harvesting", severity: "high", original: "token: ***", channel: "slack", session: "sess_010" },
];

// ── Mock stats ──

const MOCK_STATS: RedactionStats = {
  total: 1847,
  bySeverity: { critical: 612, high: 423, medium: 538, low: 274 },
  activeRules: 12,
  redactionRate: 94.2,
};

// ── Local scan simulation ──

function simulateScan(text: string, rules: RedactionRule[]): ScanResult {
  const matches: ScanMatch[] = [];
  let redacted = text;

  const enabledRules = rules.filter(r => r.enabled);
  for (const rule of enabledRules) {
    try {
      const regex = new RegExp(rule.pattern, "gi");
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          original: maskOriginal(match[0]),
          replacement: rule.replacement,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    } catch { /* invalid regex — skip */ }
  }

  // Sort by start position descending to replace from end
  matches.sort((a, b) => b.start - a.start);
  for (const m of matches) {
    redacted = redacted.slice(0, m.start) + m.replacement + redacted.slice(m.end);
  }

  return { redacted, matches: matches.sort((a, b) => a.start - b.start) };
}

function maskOriginal(original: string): string {
  if (original.length <= 6) return "***";
  return original.slice(0, 3) + "***" + original.slice(-3);
}

// ── Component ──

export default function TranscriptRedactorPage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<RedactionStats | null>(null);
  const [rules, setRules] = useState<RedactionRule[]>(DEFAULT_RULES);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabId>("overview");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [scanInput, setScanInput] = useState("");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);

  // ── Data loading ──

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, rulesRes, auditRes] = await Promise.all([
        fetch(`${API}/api/transcript-redactor/stats`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/transcript-redactor/rules`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/transcript-redactor/audit`).then(r => r.json()).catch(() => null),
      ]);
      if (statsRes?.stats) setStats(statsRes.stats);
      else setStats(MOCK_STATS);
      if (rulesRes?.rules) setRules(rulesRes.rules);
      if (auditRes?.entries) setAuditEntries(auditRes.entries);
      else setAuditEntries(MOCK_AUDIT);
    } catch {
      setStats(MOCK_STATS);
      setAuditEntries(MOCK_AUDIT);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(loadData, 10000);
    return () => clearInterval(id);
  }, [autoRefresh, loadData]);

  // ── Handlers ──

  const handleToggleRule = async (ruleId: string, enabled: boolean) => {
    const updated = rules.map(r => r.id === ruleId ? { ...r, enabled } : r);
    setRules(updated);
    try {
      await fetch(`${API}/api/transcript-redactor/rules/${ruleId}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      showToast(`${ruleId} ${enabled ? "enabled" : "disabled"}`, "success");
    } catch {
      showToast("Toggle failed — change is local only", "error");
    }
  };

  const handleScan = async () => {
    if (!scanInput.trim()) return;
    setScanLoading(true);
    setScanResult(null);
    try {
      const res = await fetch(`${API}/api/transcript-redactor/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: scanInput }),
      });
      const data = await res.json();
      if (data.result) {
        setScanResult(data.result);
      } else {
        setScanResult(simulateScan(scanInput, rules));
      }
    } catch {
      setScanResult(simulateScan(scanInput, rules));
    }
    setScanLoading(false);
  };

  const handleEnableAll = () => {
    setRules(rules.map(r => ({ ...r, enabled: true })));
    showToast("All rules enabled", "success");
  };

  const handleDisableAll = () => {
    setRules(rules.map(r => ({ ...r, enabled: false })));
    showToast("All rules disabled", "info");
  };

  // ── Render ──

  if (loading) return <Loading />;

  const enabledCount = rules.filter(r => r.enabled).length;
  const tabs: { id: TabId; label: string }[] = [
    { id: "overview", label: t("redactor.overview", "Overview") },
    { id: "rules", label: t("redactor.rules", `Rules (${enabledCount}/${rules.length})`) },
    { id: "test", label: t("redactor.test", "Test") },
    { id: "audit", label: t("redactor.audit", `Audit (${auditEntries.length})`) },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <PageHeader
        title={t("redactor.title", "\u{1F9EA} Transcript Redactor")}
        subtitle={t("redactor.subtitle", "Automatic sensitive data detection and redaction for all transcripts")}
        actions={
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Toggle checked={autoRefresh} onChange={setAutoRefresh} label={t("redactor.auto_refresh", "Auto-refresh")} />
          </div>
        }
      />

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
        {tabs.map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            style={{
              padding: "8px 16px", border: "none", borderRadius: 6, cursor: "pointer",
              background: tab === tb.id ? "var(--accent)" : "transparent",
              color: tab === tb.id ? "#fff" : "var(--text-muted)", fontWeight: 600, fontSize: 13,
            }}>
            {tb.label}
          </button>
        ))}
      </div>

      {/* ── Overview Tab ── */}
      {tab === "overview" && stats && (
        <div>
          <StatsGrid items={[
            { label: t("redactor.total_redactions", "Total Redactions"), value: stats.total.toLocaleString(), color: "var(--accent)" },
            { label: t("redactor.active_rules", "Active Rules"), value: `${enabledCount}/${rules.length}`, color: "var(--success)" },
            { label: t("redactor.redaction_rate", "Redaction Rate"), value: `${stats.redactionRate}%`, color: stats.redactionRate >= 90 ? "var(--success)" : "var(--warning)" },
          ]} />

          {/* Severity distribution */}
          <Card style={{ marginTop: 16 }}>
            <h3 style={{ margin: "0 0 16px 0", fontSize: 14, fontWeight: 600 }}>
              {t("redactor.severity_distribution", "Severity Distribution")}
            </h3>
            <div style={{ display: "flex", gap: 12 }}>
              {(["critical", "high", "medium", "low"] as Severity[]).map(sev => {
                const count = stats.bySeverity[sev];
                const pct = stats.total > 0 ? ((count / stats.total) * 100).toFixed(1) : "0";
                return (
                  <div key={sev} style={{
                    flex: 1, background: "var(--bg-input)", borderRadius: 8, padding: "14px 16px",
                    textAlign: "center", borderLeft: `3px solid ${severityColor(sev)}`,
                  }}>
                    <div style={{ fontSize: 24, fontWeight: 700, color: severityColor(sev) }}>{count}</div>
                    <div style={{ marginTop: 4 }}>
                      <Badge variant={SEVERITY_VARIANT[sev]}>{sev.toUpperCase()}</Badge>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{pct}%</div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Quick actions */}
          <Card style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              {t("redactor.quick_actions_hint", "Quickly manage all redaction rules or test content")}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <SecondaryButton onClick={handleEnableAll}>
                {t("redactor.enable_all", "Enable All")}
              </SecondaryButton>
              <SecondaryButton onClick={handleDisableAll}>
                {t("redactor.disable_all", "Disable All")}
              </SecondaryButton>
              <PrimaryButton onClick={() => setTab("test")}>
                {t("redactor.test_content", "Test Content")}
              </PrimaryButton>
            </div>
          </Card>
        </div>
      )}

      {/* ── Rules Tab ── */}
      {tab === "rules" && (
        <div>
          <Card style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                {t("redactor.built_in_rules", "Built-in Redaction Rules")}
              </h3>
              <div style={{ display: "flex", gap: 8 }}>
                <SecondaryButton onClick={handleEnableAll}>Enable All</SecondaryButton>
                <SecondaryButton onClick={handleDisableAll}>Disable All</SecondaryButton>
              </div>
            </div>
            <DataTable<RedactionRule>
              columns={[
                {
                  key: "name",
                  label: t("redactor.col_name", "Name"),
                  render: (r) => (
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--accent)" }}>{r.id}</span>
                  ),
                  width: "18%",
                },
                {
                  key: "severity",
                  label: t("redactor.col_severity", "Severity"),
                  render: (r) => (
                    <Badge variant={SEVERITY_VARIANT[r.severity]}>{r.severity.toUpperCase()}</Badge>
                  ),
                  width: "12%",
                },
                {
                  key: "pattern",
                  label: t("redactor.col_pattern", "Pattern"),
                  render: (r) => (
                    <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)" }}>
                      {maskPattern(r.pattern)}
                    </span>
                  ),
                  width: "30%",
                },
                {
                  key: "replacement",
                  label: t("redactor.col_replacement", "Replacement"),
                  render: (r) => (
                    <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--warning)" }}>{r.replacement}</span>
                  ),
                  width: "22%",
                },
                {
                  key: "enabled",
                  label: t("redactor.col_enabled", "Enabled"),
                  render: (r) => (
                    <Toggle checked={r.enabled} onChange={v => handleToggleRule(r.id, v)} />
                  ),
                  width: "18%",
                },
              ]}
              data={rules}
              keyFn={(r) => r.id}
              emptyText="No rules configured"
            />
          </Card>
        </div>
      )}

      {/* ── Test Tab ── */}
      {tab === "test" && (
        <div>
          <Card style={{ marginBottom: 16 }}>
            <h3 style={{ margin: "0 0 8px 0", fontSize: 14, fontWeight: 600 }}>
              {t("redactor.content_scanner", "Content Scanner")}
            </h3>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px 0" }}>
              {t("redactor.scan_hint", "Paste sample text below to see what would be redacted by the active rules.")}
            </p>
            <textarea
              value={scanInput}
              onChange={e => setScanInput(e.target.value)}
              placeholder={"Try: My API key is sk-abc123def456ghi789jkl012mno345 and my email is user@example.com"}
              style={{
                width: "100%", minHeight: 100, padding: 12, borderRadius: 8,
                background: "var(--bg-input)", border: "1px solid var(--border)",
                color: "var(--text-primary)", fontFamily: "monospace", fontSize: 13,
                resize: "vertical", boxSizing: "border-box",
              }}
            />
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <PrimaryButton onClick={handleScan} disabled={scanLoading || !scanInput.trim()}>
                {scanLoading ? t("redactor.scanning", "Scanning...") : t("redactor.scan", "Scan")}
              </PrimaryButton>
              <SecondaryButton onClick={() => { setScanInput(""); setScanResult(null); }}>
                {t("redactor.clear", "Clear")}
              </SecondaryButton>
            </div>
          </Card>

          {/* Scan result — redacted output */}
          {scanResult && (
            <>
              <Card style={{ marginBottom: 16, borderLeft: `3px solid ${scanResult.matches.length > 0 ? "var(--warning)" : "var(--success)"}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {scanResult.matches.length > 0
                      ? t("redactor.redacted_output", "\u26A0\uFE0F Redacted Output")
                      : t("redactor.clean_output", "\u2705 No Sensitive Data Detected")}
                  </div>
                  <Badge variant={scanResult.matches.length > 0 ? "warning" : "success"}>
                    {scanResult.matches.length} {scanResult.matches.length === 1 ? "match" : "matches"}
                  </Badge>
                </div>
                <pre style={{
                  background: "var(--bg-input)", padding: 12, borderRadius: 6,
                  whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 13,
                  fontFamily: "monospace", margin: 0, color: "var(--text-primary)",
                }}>
                  {highlightRedacted(scanResult.redacted, scanResult.matches.map(m => m.replacement))}
                </pre>
              </Card>

              {/* Detected patterns list */}
              {scanResult.matches.length > 0 && (
                <Card>
                  <h4 style={{ margin: "0 0 12px 0", fontSize: 13, fontWeight: 600 }}>
                    {t("redactor.detected_patterns", "Detected Patterns")}
                  </h4>
                  <DataTable<ScanMatch>
                    columns={[
                      {
                        key: "ruleName",
                        label: "Rule",
                        render: (m) => (
                          <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--accent)" }}>{m.ruleId}</span>
                        ),
                        width: "20%",
                      },
                      {
                        key: "severity",
                        label: "Severity",
                        render: (m) => <Badge variant={SEVERITY_VARIANT[m.severity]}>{m.severity.toUpperCase()}</Badge>,
                        width: "12%",
                      },
                      {
                        key: "original",
                        label: "Original",
                        render: (m) => (
                          <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--error)" }}>{m.original}</span>
                        ),
                        width: "25%",
                      },
                      {
                        key: "replacement",
                        label: "Replacement",
                        render: (m) => (
                          <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--success)" }}>{m.replacement}</span>
                        ),
                        width: "43%",
                      },
                    ]}
                    data={scanResult.matches}
                    keyFn={(_, i) => `match-${i}`}
                    emptyText="No matches"
                  />
                </Card>
              )}
            </>
          )}

          {/* Quick test examples */}
          <Card style={{ marginTop: 16 }}>
            <h4 style={{ margin: "0 0 10px 0", fontSize: 13, fontWeight: 600 }}>
              {t("redactor.quick_examples", "Quick Test Examples")}
            </h4>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {[
                { label: "OpenAI Key", text: "My key is sk-abc123def456ghi789jkl012mno345pqr678" },
                { label: "AWS Key", text: "Access key: AKIAIOSFODNN7EXAMPLE" },
                { label: "Email", text: "Contact me at admin@evoclaw.dev for details" },
                { label: "Phone CN", text: "My number is 13912345678" },
                { label: "JWT", text: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456" },
                { label: "ENV Secret", text: "DATABASE_PASSWORD=super_secret_2024" },
                { label: "IPv4", text: "Server is at 192.168.1.100 on port 8080" },
                { label: "Credit Card", text: "Card number: 4111 1111 1111 1111" },
              ].map(ex => (
                <button key={ex.label} onClick={() => { setScanInput(ex.text); setScanResult(null); }}
                  style={{
                    padding: "4px 10px", border: "1px solid var(--border)", borderRadius: 4,
                    background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 11,
                  }}>
                  {ex.label}
                </button>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── Audit Tab ── */}
      {tab === "audit" && (
        <div>
          {auditEntries.length === 0 ? (
            <EmptyState
              title={t("redactor.no_audit", "No Audit Entries")}
              description={t("redactor.no_audit_desc", "Redaction events will appear here as transcripts are processed.")}
            />
          ) : (
            <Card>
              <DataTable<AuditEntry>
                columns={[
                  {
                    key: "timestamp",
                    label: t("redactor.col_timestamp", "Timestamp"),
                    render: (e) => (
                      <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                        {new Date(e.timestamp).toLocaleString()}
                      </span>
                    ),
                    width: "18%",
                  },
                  {
                    key: "patternName",
                    label: t("redactor.col_pattern_name", "Pattern"),
                    render: (e) => (
                      <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--accent)" }}>{e.patternName}</span>
                    ),
                    width: "18%",
                  },
                  {
                    key: "severity",
                    label: t("redactor.col_severity", "Severity"),
                    render: (e) => <Badge variant={SEVERITY_VARIANT[e.severity]}>{e.severity.toUpperCase()}</Badge>,
                    width: "10%",
                  },
                  {
                    key: "original",
                    label: t("redactor.col_original", "Original"),
                    render: (e) => (
                      <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--error)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }}>
                        {e.original}
                      </span>
                    ),
                    width: "22%",
                  },
                  {
                    key: "channel",
                    label: t("redactor.col_channel", "Channel"),
                    render: (e) => (
                      <Badge variant="info">{e.channel}</Badge>
                    ),
                    width: "12%",
                  },
                  {
                    key: "session",
                    label: t("redactor.col_session", "Session"),
                    render: (e) => (
                      <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)" }}>{e.session}</span>
                    ),
                    width: "20%",
                  },
                ]}
                data={auditEntries}
                keyFn={(e, i) => `audit-${i}`}
                emptyText="No audit entries"
              />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ── Helpers ──

function severityColor(sev: Severity): string {
  switch (sev) {
    case "critical": return "var(--error)";
    case "high": return "var(--warning)";
    case "medium": return "var(--accent)";
    case "low": return "var(--text-muted)";
  }
}

function maskPattern(pattern: string): string {
  if (pattern.length <= 20) return pattern;
  return pattern.slice(0, 15) + "..." + pattern.slice(-5);
}

function highlightRedacted(text: string, replacements: string[]): React.ReactNode {
  if (replacements.length === 0) return text;

  let result: React.ReactNode[] = [];
  let remaining = text;
  let keyIdx = 0;

  for (const rep of replacements) {
    const idx = remaining.indexOf(rep);
    if (idx === -1) continue;
    if (idx > 0) result.push(remaining.slice(0, idx));
    result.push(
      <span key={keyIdx++} style={{
        background: "var(--error-bg)", color: "var(--error)",
        padding: "1px 4px", borderRadius: 3, fontWeight: 600,
      }}>
        {rep}
      </span>
    );
    remaining = remaining.slice(idx + rep.length);
  }
  if (remaining) result.push(remaining);

  return <>{result}</>;
}
