/**
 * InstallPolicyPage — Operator Install Policy management dashboard.
 *
 * Manages trusted/denied source rules, permission scope rules, and audit log
 * for the EvoClaw Operator Install Policy system.
 */
import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, EmptyState,
  Section, PrimaryButton, SecondaryButton, GhostButton,
  StatsGrid, Modal, showToast, Toggle, DataTable,
} from "./shared";
import type { BadgeVariant } from "./shared";
import { useTranslation } from "./i18n";

const API = (window as any).__EVOCLAW_API__ || "";

// ── Types ──

type SourceType = "official" | "verified" | "community" | "local" | "url" | "unknown";
type RuleType = "allow" | "deny" | "require_approval" | "audit_only";
type PermissionScope = "read_files" | "write_files" | "execute_commands" | "network_access" | "secrets_access" | "channel_send" | "user_data";
type RiskLevel = "critical" | "high" | "medium" | "low";
type Decision = "allow" | "deny" | "require_approval";
type TabId = "overview" | "sources" | "permissions" | "audit";

interface SourceRule {
  id: string;
  sourceType: SourceType;
  pattern: string;
  ruleType: RuleType;
  reason: string;
}

interface PermissionRule {
  id: string;
  scope: PermissionScope;
  ruleType: RuleType;
  reason: string;
  enabled: boolean;
}

interface AuditEntry {
  id: string;
  timestamp: string;
  skillOrPlugin: string;
  source: string;
  riskLevel: RiskLevel;
  decision: Decision;
  evaluator: string;
}

interface PolicyStats {
  totalRules: number;
  trustedSources: number;
  deniedSources: number;
  pendingApprovals: number;
}

interface EvalResult {
  allowed: boolean;
  decision: Decision;
  matchedRules: string[];
  reason: string;
}

// ── Variant Maps ──

const RISK_VARIANT: Record<RiskLevel, BadgeVariant> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "default",
};

const DECISION_VARIANT: Record<Decision, BadgeVariant> = {
  allow: "success",
  deny: "error",
  require_approval: "warning",
};

const RULE_VARIANT: Record<RuleType, BadgeVariant> = {
  allow: "success",
  deny: "error",
  require_approval: "warning",
  audit_only: "info",
};

const SOURCE_TYPE_VARIANT: Record<SourceType, BadgeVariant> = {
  official: "success",
  verified: "info",
  community: "default",
  local: "default",
  url: "warning",
  unknown: "error",
};

const SCOPE_LABELS: Record<PermissionScope, string> = {
  read_files: "Read Files",
  write_files: "Write Files",
  execute_commands: "Execute Commands",
  network_access: "Network Access",
  secrets_access: "Secrets Access",
  channel_send: "Channel Send",
  user_data: "User Data",
};

const RULE_LABELS: Record<RuleType, string> = {
  allow: "Allow",
  deny: "Deny",
  require_approval: "Require Approval",
  audit_only: "Audit Only",
};

// ── Mock Data ──

const MOCK_SOURCE_RULES: SourceRule[] = [
  { id: "src-001", sourceType: "official", pattern: "evoclaw/*", ruleType: "allow", reason: "Official EvoClaw operators are always trusted" },
  { id: "src-002", sourceType: "verified", pattern: "verified-partners/*", ruleType: "allow", reason: "Verified partner operators passed security review" },
  { id: "src-003", sourceType: "community", pattern: "community/*", ruleType: "require_approval", reason: "Community operators need manual approval" },
  { id: "src-004", sourceType: "url", pattern: "http://*", ruleType: "deny", reason: "Plain HTTP sources are insecure" },
  { id: "src-005", sourceType: "unknown", pattern: "unregistered/*", ruleType: "deny", reason: "Unregistered sources are blocked by default" },
  { id: "src-006", sourceType: "local", pattern: "local/*", ruleType: "audit_only", reason: "Local operators are audited but allowed" },
  { id: "src-007", sourceType: "community", pattern: "community/experimental/*", ruleType: "deny", reason: "Experimental community operators are too risky" },
];

const MOCK_PERMISSION_RULES: PermissionRule[] = [
  { id: "perm-001", scope: "read_files", ruleType: "allow", reason: "Reading files is safe for most operators", enabled: true },
  { id: "perm-002", scope: "write_files", ruleType: "require_approval", reason: "Writing files needs explicit approval", enabled: true },
  { id: "perm-003", scope: "execute_commands", ruleType: "require_approval", reason: "Command execution is high-risk", enabled: true },
  { id: "perm-004", scope: "network_access", ruleType: "audit_only", reason: "Network access is logged for review", enabled: true },
  { id: "perm-005", scope: "secrets_access", ruleType: "deny", reason: "Direct secrets access is prohibited", enabled: true },
  { id: "perm-006", scope: "channel_send", ruleType: "allow", reason: "Channel messaging is allowed", enabled: true },
  { id: "perm-007", scope: "user_data", ruleType: "deny", reason: "User data access requires special exemption", enabled: true },
];

const MOCK_AUDIT_ENTRIES: AuditEntry[] = [
  { id: "aud-001", timestamp: "2026-06-15T10:23:45Z", skillOrPlugin: "web-scraper", source: "community/web-scraper", riskLevel: "medium", decision: "require_approval", evaluator: "SourceRule(src-003)" },
  { id: "aud-002", timestamp: "2026-06-15T10:20:12Z", skillOrPlugin: "file-reader", source: "evoclaw/file-reader", riskLevel: "low", decision: "allow", evaluator: "SourceRule(src-001)" },
  { id: "aud-003", timestamp: "2026-06-15T10:18:33Z", skillOrPlugin: "shell-exec", source: "community/shell-exec", riskLevel: "critical", decision: "deny", evaluator: "SourceRule(src-007)" },
  { id: "aud-004", timestamp: "2026-06-15T10:15:07Z", skillOrPlugin: "db-connector", source: "verified-partners/db-connector", riskLevel: "low", decision: "allow", evaluator: "SourceRule(src-002)" },
  { id: "aud-005", timestamp: "2026-06-15T10:12:50Z", skillOrPlugin: "http-fetch", source: "http://evil.com/plugin", riskLevel: "critical", decision: "deny", evaluator: "SourceRule(src-004)" },
  { id: "aud-006", timestamp: "2026-06-15T10:10:22Z", skillOrPlugin: "local-dev-tool", source: "local/dev-tool", riskLevel: "low", decision: "allow", evaluator: "SourceRule(src-006)" },
  { id: "aud-007", timestamp: "2026-06-15T10:08:15Z", skillOrPlugin: "secret-vault", source: "evoclaw/secret-vault", riskLevel: "medium", decision: "require_approval", evaluator: "PermissionRule(perm-005)" },
  { id: "aud-008", timestamp: "2026-06-15T10:05:40Z", skillOrPlugin: "data-exporter", source: "unregistered/data-exporter", riskLevel: "high", decision: "deny", evaluator: "SourceRule(src-005)" },
];

// ── Component ──

export default function InstallPolicyPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>("overview");
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [sourceRules, setSourceRules] = useState<SourceRule[]>([]);
  const [permissionRules, setPermissionRules] = useState<PermissionRule[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [stats, setStats] = useState<PolicyStats | null>(null);

  // Modal state for adding source rule
  const [showAddSource, setShowAddSource] = useState(false);
  const [newSourceType, setNewSourceType] = useState<SourceType>("community");
  const [newPattern, setNewPattern] = useState("");
  const [newRuleType, setNewRuleType] = useState<RuleType>("require_approval");
  const [newReason, setNewReason] = useState("");

  // Test policy state
  const [testSkill, setTestSkill] = useState("");
  const [testSource, setTestSource] = useState("");
  const [testResult, setTestResult] = useState<EvalResult | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<SourceRule | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [statsRes, sourcesRes, permsRes, auditRes] = await Promise.all([
        fetch(`${API}/api/install-policy/stats`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/install-policy/sources`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/install-policy/permissions`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/install-policy/audit?limit=50`).then(r => r.json()).catch(() => null),
      ]);

      if (statsRes?.stats) {
        setStats(statsRes.stats);
      } else {
        // Fallback to computed mock stats
        const trusted = MOCK_SOURCE_RULES.filter(r => r.ruleType === "allow").length;
        const denied = MOCK_SOURCE_RULES.filter(r => r.ruleType === "deny").length;
        const pending = MOCK_AUDIT_ENTRIES.filter(a => a.decision === "require_approval").length;
        setStats({ totalRules: MOCK_SOURCE_RULES.length + MOCK_PERMISSION_RULES.length, trustedSources: trusted, deniedSources: denied, pendingApprovals: pending });
      }

      setSourceRules(sourcesRes?.rules || MOCK_SOURCE_RULES);
      setPermissionRules(permsRes?.rules || MOCK_PERMISSION_RULES);
      setAuditEntries(auditRes?.entries || MOCK_AUDIT_ENTRIES);
    } catch {
      // Use mock data on error
      const trusted = MOCK_SOURCE_RULES.filter(r => r.ruleType === "allow").length;
      const denied = MOCK_SOURCE_RULES.filter(r => r.ruleType === "deny").length;
      const pending = MOCK_AUDIT_ENTRIES.filter(a => a.decision === "require_approval").length;
      setStats({ totalRules: MOCK_SOURCE_RULES.length + MOCK_PERMISSION_RULES.length, trustedSources: trusted, deniedSources: denied, pendingApprovals: pending });
      setSourceRules(MOCK_SOURCE_RULES);
      setPermissionRules(MOCK_PERMISSION_RULES);
      setAuditEntries(MOCK_AUDIT_ENTRIES);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadData]);

  const handleAddSourceRule = async () => {
    if (!newPattern.trim()) {
      showToast("Pattern is required", "error");
      return;
    }
    const rule: SourceRule = {
      id: `src-${Date.now()}`,
      sourceType: newSourceType,
      pattern: newPattern.trim(),
      ruleType: newRuleType,
      reason: newReason.trim() || "Added by admin",
    };
    try {
      await fetch(`${API}/api/install-policy/sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rule),
      });
    } catch { /* fallback to local */ }
    setSourceRules(prev => [...prev, rule]);
    setShowAddSource(false);
    setNewPattern("");
    setNewReason("");
    setNewSourceType("community");
    setNewRuleType("require_approval");
    showToast("Source rule added", "success");
    loadData();
  };

  const handleDeleteSourceRule = async (rule: SourceRule) => {
    try {
      await fetch(`${API}/api/install-policy/sources/${rule.id}`, { method: "DELETE" });
    } catch { /* fallback to local */ }
    setSourceRules(prev => prev.filter(r => r.id !== rule.id));
    setDeleteTarget(null);
    showToast("Source rule removed", "success");
  };

  const handleTogglePermission = async (rule: PermissionRule) => {
    const updated = { ...rule, enabled: !rule.enabled };
    try {
      await fetch(`${API}/api/install-policy/permissions/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: updated.enabled }),
      });
    } catch { /* fallback to local */ }
    setPermissionRules(prev => prev.map(r => r.id === rule.id ? updated : r));
    showToast(`${SCOPE_LABELS[rule.scope]} ${updated.enabled ? "enabled" : "disabled"}`, "success");
  };

  const handleTestPolicy = async () => {
    if (!testSkill.trim() || !testSource.trim()) {
      showToast("Skill name and source are required", "error");
      return;
    }
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await fetch(`${API}/api/install-policy/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillName: testSkill.trim(), source: testSource.trim() }),
      });
      const data = await res.json();
      setTestResult(data.result);
    } catch {
      // Simulate evaluation locally
      const matched = sourceRules.filter(r => {
        const prefix = r.pattern.replace("/*", "");
        return testSource.trim().startsWith(prefix);
      });
      const bestMatch = matched[0];
      const decision: Decision = bestMatch ? (bestMatch.ruleType as Decision) : "deny";
      setTestResult({
        allowed: decision === "allow",
        decision,
        matchedRules: matched.map(r => r.id),
        reason: bestMatch ? bestMatch.reason : "No matching rule found — default deny",
      });
    }
    setTestLoading(false);
  };

  if (loading) return <Loading />;

  const tabs: { id: TabId; label: string }[] = [
    { id: "overview", label: t("installPolicy.overview", "Overview") },
    { id: "sources", label: t("installPolicy.sources", `Sources (${sourceRules.length})`) },
    { id: "permissions", label: t("installPolicy.permissions", `Permissions (${permissionRules.length})`) },
    { id: "audit", label: t("installPolicy.audit", `Audit (${auditEntries.length})`) },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <PageHeader
        title={t("installPolicy.title", "\u{1F6E1}\uFE0F Install Policy")}
        subtitle={t("installPolicy.subtitle", "Operator install policy — source trust, permission scopes, and audit trail")}
        actions={
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Toggle checked={autoRefresh} onChange={setAutoRefresh} label={t("installPolicy.autoRefresh", "Auto-refresh")} />
            <SecondaryButton onClick={loadData} small>{t("installPolicy.refresh", "Refresh")}</SecondaryButton>
          </div>
        }
      />

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid #2d3748", paddingBottom: 8 }}>
        {tabs.map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            style={{
              padding: "8px 16px", border: "none", borderRadius: 6, cursor: "pointer",
              background: tab === tb.id ? "#007bff" : "transparent",
              color: tab === tb.id ? "#fff" : "#888", fontWeight: 600, fontSize: 13,
            }}>
            {tb.label}
          </button>
        ))}
      </div>

      {/* ── Overview Tab ── */}
      {tab === "overview" && stats && (
        <div>
          <Section title={t("installPolicy.policyStats", "Policy Statistics")}>
            <StatsGrid items={[
              { label: "Total Rules", value: stats.totalRules, color: "var(--accent)" },
              { label: "Trusted Sources", value: stats.trustedSources, color: "var(--success)" },
              { label: "Denied Sources", value: stats.deniedSources, color: "var(--error)" },
              { label: "Pending Approvals", value: stats.pendingApprovals, color: "var(--warning)" },
            ]} />
          </Section>

          <Section title={t("installPolicy.recentEvaluations", "Recent Policy Evaluations")}>
            {auditEntries.slice(0, 5).map(entry => (
              <Card key={entry.id} style={{ marginBottom: 10, borderLeft: `3px solid ${entry.decision === "allow" ? "var(--success)" : entry.decision === "deny" ? "var(--error)" : "var(--warning)"}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{entry.skillOrPlugin}</div>
                    <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
                      {entry.source} &middot; {new Date(entry.timestamp).toLocaleString()}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <Badge variant={RISK_VARIANT[entry.riskLevel]}>{entry.riskLevel}</Badge>
                    <Badge variant={DECISION_VARIANT[entry.decision]}>{entry.decision.replace("_", " ")}</Badge>
                  </div>
                </div>
              </Card>
            ))}
          </Section>

          {/* Test Policy Section */}
          <Section title={t("installPolicy.testPolicy", "Test Policy")}>
            <Card>
              <p style={{ fontSize: 12, color: "#888", margin: "0 0 12px 0" }}>
                {t("installPolicy.testHint", "Evaluate a skill/plugin against the current install policy rules.")}
              </p>
              <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Skill / Plugin Name</label>
                  <input value={testSkill} onChange={e => setTestSkill(e.target.value)}
                    placeholder="e.g. web-scraper"
                    style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "#0d1117", border: "1px solid #2d3748", color: "#e2e8f0", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Source</label>
                  <input value={testSource} onChange={e => setTestSource(e.target.value)}
                    placeholder="e.g. community/web-scraper"
                    style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "#0d1117", border: "1px solid #2d3748", color: "#e2e8f0", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <PrimaryButton onClick={handleTestPolicy} disabled={testLoading || !testSkill.trim() || !testSource.trim()}>
                  {testLoading ? "Evaluating..." : "Evaluate"}
                </PrimaryButton>
                <SecondaryButton onClick={() => { setTestSkill(""); setTestSource(""); setTestResult(null); }}>Clear</SecondaryButton>
              </div>
            </Card>

            {testResult && (
              <Card style={{ marginTop: 12, borderLeft: `3px solid ${testResult.allowed ? "var(--success)" : testResult.decision === "require_approval" ? "var(--warning)" : "var(--error)"}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>
                    {testResult.allowed ? "\u2705 Allowed" : testResult.decision === "require_approval" ? "\u26A0\uFE0F Requires Approval" : "\u274C Denied"}
                  </div>
                  <Badge variant={DECISION_VARIANT[testResult.decision]}>{testResult.decision.replace("_", " ")}</Badge>
                </div>
                <div style={{ fontSize: 13, color: "#e2e8f0", marginBottom: 8 }}>
                  <strong>Reason:</strong> {testResult.reason}
                </div>
                {testResult.matchedRules.length > 0 && (
                  <div style={{ fontSize: 12 }}>
                    <strong>Matched Rules:</strong>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                      {testResult.matchedRules.map(rId => (
                        <Badge key={rId} variant="info">{rId}</Badge>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            )}
          </Section>
        </div>
      )}

      {/* ── Sources Tab ── */}
      {tab === "sources" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
              {t("installPolicy.sourceRules", "Source Rules")}
            </div>
            <PrimaryButton small onClick={() => setShowAddSource(true)}>
              {t("installPolicy.addRule", "+ Add Rule")}
            </PrimaryButton>
          </div>

          <Card>
            <DataTable<SourceRule>
              columns={[
                { key: "sourceType", label: "Source Type", width: "130px", render: r => (
                  <Badge variant={SOURCE_TYPE_VARIANT[r.sourceType]}>{r.sourceType}</Badge>
                )},
                { key: "pattern", label: "Pattern", render: r => (
                  <code style={{ fontSize: 12, color: "#93c5fd" }}>{r.pattern}</code>
                )},
                { key: "ruleType", label: "Rule Type", width: "140px", render: r => (
                  <Badge variant={RULE_VARIANT[r.ruleType]}>{RULE_LABELS[r.ruleType]}</Badge>
                )},
                { key: "reason", label: "Reason", render: r => (
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.reason}</span>
                )},
                { key: "actions", label: "", width: "60px", render: r => (
                  <GhostButton small onClick={() => setDeleteTarget(r)} style={{ color: "var(--error)" }}>Remove</GhostButton>
                )},
              ]}
              data={sourceRules}
              keyFn={r => r.id}
              emptyText="No source rules configured"
            />
          </Card>
        </div>
      )}

      {/* ── Permissions Tab ── */}
      {tab === "permissions" && (
        <div>
          <div style={{ marginBottom: 16, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
            {t("installPolicy.permissionRules", "Permission Scope Rules")}
          </div>

          <Card>
            <DataTable<PermissionRule>
              columns={[
                { key: "scope", label: "Scope", width: "180px", render: r => (
                  <code style={{ fontSize: 12, color: "#93c5fd" }}>{SCOPE_LABELS[r.scope]}</code>
                )},
                { key: "ruleType", label: "Rule Type", width: "140px", render: r => (
                  <Badge variant={RULE_VARIANT[r.ruleType]}>{RULE_LABELS[r.ruleType]}</Badge>
                )},
                { key: "reason", label: "Reason", render: r => (
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.reason}</span>
                )},
                { key: "enabled", label: "Enabled", width: "80px", render: r => (
                  <Toggle checked={r.enabled} onChange={() => handleTogglePermission(r)} />
                )},
              ]}
              data={permissionRules}
              keyFn={r => r.id}
              emptyText="No permission rules configured"
            />
          </Card>
        </div>
      )}

      {/* ── Audit Tab ── */}
      {tab === "audit" && (
        <div>
          {auditEntries.length === 0 ? (
            <EmptyState
              title={t("installPolicy.noAudit", "No Audit Entries")}
              description={t("installPolicy.noAuditDesc", "Policy evaluation audit entries will appear here when skills or plugins are evaluated.")}
            />
          ) : (
            <Card>
              <DataTable<AuditEntry>
                columns={[
                  { key: "timestamp", label: "Timestamp", width: "170px", render: e => (
                    <span style={{ fontSize: 12, color: "#888", whiteSpace: "nowrap" }}>
                      {new Date(e.timestamp).toLocaleString()}
                    </span>
                  )},
                  { key: "skillOrPlugin", label: "Skill / Plugin", width: "160px", render: e => (
                    <span style={{ fontWeight: 500 }}>{e.skillOrPlugin}</span>
                  )},
                  { key: "source", label: "Source", render: e => (
                    <code style={{ fontSize: 11, color: "#93c5fd" }}>{e.source}</code>
                  )},
                  { key: "riskLevel", label: "Risk Level", width: "110px", render: e => (
                    <Badge variant={RISK_VARIANT[e.riskLevel]}>{e.riskLevel}</Badge>
                  )},
                  { key: "decision", label: "Decision", width: "140px", render: e => (
                    <Badge variant={DECISION_VARIANT[e.decision]}>{e.decision.replace("_", " ")}</Badge>
                  )},
                  { key: "evaluator", label: "Evaluator", width: "180px", render: e => (
                    <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{e.evaluator}</code>
                  )},
                ]}
                data={auditEntries}
                keyFn={e => e.id}
                emptyText="No audit entries"
              />
            </Card>
          )}
        </div>
      )}

      {/* ── Add Source Rule Modal ── */}
      {showAddSource && (
        <Modal
          title={t("installPolicy.addSourceRule", "Add Source Rule")}
          onClose={() => setShowAddSource(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setShowAddSource(false)}>Cancel</SecondaryButton>
              <PrimaryButton onClick={handleAddSourceRule}>Add Rule</PrimaryButton>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={{ fontSize: 12, color: "#888", display: "block", marginBottom: 4 }}>Source Type</label>
              <select value={newSourceType} onChange={e => setNewSourceType(e.target.value as SourceType)}
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "#0d1117", border: "1px solid #2d3748", color: "#e2e8f0", fontSize: 13, outline: "none" }}>
                {(["official", "verified", "community", "local", "url", "unknown"] as SourceType[]).map(st => (
                  <option key={st} value={st}>{st}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#888", display: "block", marginBottom: 4 }}>Pattern</label>
              <input value={newPattern} onChange={e => setNewPattern(e.target.value)}
                placeholder="e.g. community/* or my-org/*"
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "#0d1117", border: "1px solid #2d3748", color: "#e2e8f0", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#888", display: "block", marginBottom: 4 }}>Rule Type</label>
              <select value={newRuleType} onChange={e => setNewRuleType(e.target.value as RuleType)}
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "#0d1117", border: "1px solid #2d3748", color: "#e2e8f0", fontSize: 13, outline: "none" }}>
                {(["allow", "deny", "require_approval", "audit_only"] as RuleType[]).map(rt => (
                  <option key={rt} value={rt}>{RULE_LABELS[rt]}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#888", display: "block", marginBottom: 4 }}>Reason</label>
              <input value={newReason} onChange={e => setNewReason(e.target.value)}
                placeholder="Why this rule exists"
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "#0d1117", border: "1px solid #2d3748", color: "#e2e8f0", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
            </div>
          </div>
        </Modal>
      )}

      {/* ── Delete Confirmation Modal ── */}
      {deleteTarget && (
        <Modal
          title={t("installPolicy.removeRule", "Remove Source Rule")}
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <SecondaryButton onClick={() => setDeleteTarget(null)}>Cancel</SecondaryButton>
              <PrimaryButton danger onClick={() => handleDeleteSourceRule(deleteTarget)}>Remove</PrimaryButton>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 14, lineHeight: 1.6 }}>
            {t("installPolicy.removeConfirm", `Are you sure you want to remove the rule for "${deleteTarget.pattern}"? This may affect policy evaluation for matching sources.`)}
          </p>
        </Modal>
      )}
    </div>
  );
}
