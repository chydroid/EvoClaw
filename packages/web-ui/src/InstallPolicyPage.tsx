/**
 * InstallPolicyPage — Operator Install Policy management.
 *
 * Uses real backend APIs (no mock data). Falls back to EmptyState when no data.
 */
import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, EmptyState,
  Section, PrimaryButton, SecondaryButton, GhostButton,
  StatsGrid, Modal, showToast, Toggle, DataTable,
} from "./shared";
import type { BadgeVariant } from "./shared";
import { useTranslation } from "./i18n";

const API = window.__EVOCLAW_API__ || "";

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
  critical: "error", high: "error", medium: "warning", low: "default",
};

const DECISION_VARIANT: Record<Decision, BadgeVariant> = {
  allow: "success", deny: "error", require_approval: "warning",
};

const RULE_VARIANT: Record<RuleType, BadgeVariant> = {
  allow: "success", deny: "error", require_approval: "warning", audit_only: "info",
};

const SOURCE_TYPE_VARIANT: Record<SourceType, BadgeVariant> = {
  official: "success", verified: "info", community: "default",
  local: "default", url: "warning", unknown: "error",
};

// ── Component ──

export default function InstallPolicyPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>("overview");
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [sourceRules, setSourceRules] = useState<SourceRule[]>([]);
  const [permissionRules, setPermissionRules] = useState<PermissionRule[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [stats, setStats] = useState<PolicyStats>({
    totalRules: 0, trustedSources: 0, deniedSources: 0, pendingApprovals: 0,
  });

  const [showAddSource, setShowAddSource] = useState(false);
  const [newSourceType, setNewSourceType] = useState<SourceType>("community");
  const [newPattern, setNewPattern] = useState("");
  const [newRuleType, setNewRuleType] = useState<RuleType>("require_approval");
  const [newReason, setNewReason] = useState("");

  const [testSkill, setTestSkill] = useState("");
  const [testSource, setTestSource] = useState("");
  const [testResult, setTestResult] = useState<EvalResult | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<SourceRule | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, auditRes] = await Promise.all([
        fetch(`${API}/api/install-policy/rules`).then(r => r.json()).catch((err) => { console.error("[API] request failed:", err); return null; }),
        fetch(`${API}/api/install-policy/audit?limit=50`).then(r => r.json()).catch((err) => { console.error("[API] request failed:", err); return null; }),
      ]);

      const allRules: any[] = (rulesRes?.rules || rulesRes || []) as any[];
      const sources: SourceRule[] = allRules.filter((r) => r?.sourceType);
      const permissions: PermissionRule[] = allRules.filter((r) => r?.scope).map((r) => ({
        ...r,
        enabled: r.enabled !== false,
      }));
      setSourceRules(sources);
      setPermissionRules(permissions);

      const audit: AuditEntry[] = (auditRes?.entries || auditRes?.audit || auditRes || []) as any[];
      setAuditEntries(audit);

      // Compute stats from real data
      setStats({
        totalRules: allRules.length,
        trustedSources: sources.filter(r => r.ruleType === "allow").length,
        deniedSources: sources.filter(r => r.ruleType === "deny").length,
        pendingApprovals: audit.filter(a => a.decision === "require_approval").length,
      });
    } catch {
      // Network error — keep empty state
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadData]);

  const handleAddSourceRule = async () => {
    if (!newPattern.trim()) {
      showToast(t("installPolicy.confirmRemove"), "error");
      return;
    }
    const rule = {
      id: `src-${Date.now()}`,
      type: "source" as const,
      sourceType: newSourceType,
      pattern: newPattern.trim(),
      ruleType: newRuleType,
      reason: newReason.trim() || "",
    };
    try {
      const res = await fetch(`${API}/api/install-policy/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rule),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.warn("[InstallPolicy] Failed to add rule:", err);
      showToast(t("installPolicy.addFail", "添加规则失败"), "error");
      return;
    }
    setSourceRules(prev => [...prev, rule]);
    setShowAddSource(false);
    setNewPattern("");
    setNewReason("");
    setNewSourceType("community");
    setNewRuleType("require_approval");
    showToast(t("installPolicy.addSuccess"), "success");
    loadData();
  };

  const handleDeleteSourceRule = async (rule: SourceRule) => {
    try {
      const res = await fetch(`${API}/api/install-policy/rules/${rule.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.warn("[InstallPolicy] Failed to delete rule:", err);
      showToast(t("installPolicy.removeFail", "删除规则失败"), "error");
      setDeleteTarget(null);
      return;
    }
    setSourceRules(prev => prev.filter(r => r.id !== rule.id));
    setDeleteTarget(null);
    showToast(t("installPolicy.removeSuccess"), "success");
  };

  const handleTogglePermission = async (rule: PermissionRule) => {
    const updated = { ...rule, enabled: !rule.enabled };
    try {
      const res = await fetch(`${API}/api/install-policy/rules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...updated, type: "permission" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.warn("[InstallPolicy] Failed to toggle permission:", err);
      showToast(t("installPolicy.toggleFail", "切换权限失败"), "error");
      return;
    }
    setPermissionRules(prev => prev.map(r => r.id === rule.id ? updated : r));
    showToast(t("installPolicy.toggleSuccess"), "success");
  };

  const handleTestPolicy = async () => {
    if (!testSkill.trim() || !testSource.trim()) {
      showToast(t("installPolicy.test.skillName") + " / " + t("installPolicy.test.skillSource"), "error");
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
      setTestResult(data.result || data);
    } catch {
      setTestResult(null);
    }
    setTestLoading(false);
  };

  if (loading) return <Loading />;

  const tabs: { id: TabId; key: string }[] = [
    { id: "overview", key: "installPolicy.tabs.overview" },
    { id: "sources", key: "installPolicy.tabs.sources" },
    { id: "permissions", key: "installPolicy.tabs.permissions" },
    { id: "audit", key: "installPolicy.tabs.audit" },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <PageHeader
        title={t("installPolicy.title")}
        subtitle={t("installPolicy.subtitle")}
        actions={
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Toggle checked={autoRefresh} onChange={setAutoRefresh} label={t("installPolicy.autoRefresh")} />
            <SecondaryButton onClick={loadData} small>↻</SecondaryButton>
          </div>
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
            { label: t("installPolicy.stats.totalRules"), value: stats.totalRules, color: "var(--accent)" },
            { label: t("installPolicy.stats.trustedSources"), value: stats.trustedSources, color: "var(--success)" },
            { label: t("installPolicy.stats.deniedSources"), value: stats.deniedSources, color: "var(--error)" },
            { label: t("installPolicy.stats.pendingApprovals"), value: stats.pendingApprovals, color: "var(--warning)" },
          ]} />

          <Section title={t("installPolicy.recentEvaluations", "Recent Evaluations")} style={{ marginTop: 24 }}>
            {auditEntries.length === 0 ? (
              <EmptyState title={t("installPolicy.empty.audit")} />
            ) : (
              auditEntries.slice(0, 5).map(entry => (
                <Card key={entry.id} style={{ marginBottom: 10, borderLeft: `3px solid ${entry.decision === "allow" ? "var(--success)" : entry.decision === "deny" ? "var(--error)" : "var(--warning)"}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{entry.skillOrPlugin}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                        {entry.source} · {entry.timestamp ? new Date(entry.timestamp).toLocaleString() : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <Badge variant={RISK_VARIANT[entry.riskLevel] || "default"}>{entry.riskLevel}</Badge>
                      <Badge variant={DECISION_VARIANT[entry.decision] || "default"}>{entry.decision}</Badge>
                    </div>
                  </div>
                </Card>
              ))
            )}
          </Section>

          <Section title={t("installPolicy.test.title")} style={{ marginTop: 20 }}>
            <Card>
              <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>{t("installPolicy.test.skillName")}</label>
                  <input value={testSkill} onChange={e => setTestSkill(e.target.value)}
                    placeholder="e.g. web-scraper"
                    style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>{t("installPolicy.test.skillSource")}</label>
                  <input value={testSource} onChange={e => setTestSource(e.target.value)}
                    placeholder="e.g. community/web-scraper"
                    style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <PrimaryButton onClick={handleTestPolicy} disabled={testLoading || !testSkill.trim() || !testSource.trim()}>
                  {testLoading ? "..." : t("installPolicy.test.button")}
                </PrimaryButton>
                <SecondaryButton onClick={() => { setTestSkill(""); setTestSource(""); setTestResult(null); }}>×</SecondaryButton>
              </div>
            </Card>

            {testResult && (
              <Card style={{ marginTop: 12, borderLeft: `3px solid ${testResult.allowed ? "var(--success)" : testResult.decision === "require_approval" ? "var(--warning)" : "var(--error)"}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>
                    {testResult.allowed ? "✅ " : testResult.decision === "require_approval" ? "⚠️ " : "❌ "}
                    {t("installPolicy.test.result")}
                  </div>
                  <Badge variant={DECISION_VARIANT[testResult.decision] || "default"}>{testResult.decision}</Badge>
                </div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>
                  {testResult.reason}
                </div>
                {testResult.matchedRules && testResult.matchedRules.length > 0 && (
                  <div style={{ fontSize: 12 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                      {testResult.matchedRules.map((rId: string) => (
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
              {t("installPolicy.tabs.sources")} ({sourceRules.length})
            </div>
            <PrimaryButton small onClick={() => setShowAddSource(true)}>
              + {t("installPolicy.addRule")}
            </PrimaryButton>
          </div>

          <Card>
            {sourceRules.length === 0 ? (
              <EmptyState title={t("installPolicy.empty.sources")} />
            ) : (
              <DataTable<SourceRule>
                columns={[
                  { key: "sourceType", label: t("installPolicy.col.type"), width: "130px", render: r => (
                    <Badge variant={SOURCE_TYPE_VARIANT[r.sourceType] || "default"}>{r.sourceType}</Badge>
                  )},
                  { key: "pattern", label: t("installPolicy.col.pattern"), render: r => (
                    <code style={{ fontSize: 12, color: "var(--accent)" }}>{r.pattern}</code>
                  )},
                  { key: "ruleType", label: t("installPolicy.col.ruleType"), width: "140px", render: r => (
                    <Badge variant={RULE_VARIANT[r.ruleType] || "default"}>{r.ruleType}</Badge>
                  )},
                  { key: "reason", label: t("installPolicy.col.reason"), render: r => (
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.reason}</span>
                  )},
                  { key: "actions", label: "", width: "60px", render: r => (
                    <GhostButton small onClick={() => setDeleteTarget(r)} style={{ color: "var(--error)" }}>×</GhostButton>
                  )},
                ]}
                data={sourceRules}
                keyFn={r => r.id}
              />
            )}
          </Card>
        </div>
      )}

      {/* ── Permissions Tab ── */}
      {tab === "permissions" && (
        <div>
          <div style={{ marginBottom: 16, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
            {t("installPolicy.tabs.permissions")} ({permissionRules.length})
          </div>

          <Card>
            {permissionRules.length === 0 ? (
              <EmptyState title={t("installPolicy.empty.permissions")} />
            ) : (
              <DataTable<PermissionRule>
                columns={[
                  { key: "scope", label: t("installPolicy.col.scope"), width: "180px", render: r => (
                    <code style={{ fontSize: 12, color: "var(--accent)" }}>{r.scope}</code>
                  )},
                  { key: "ruleType", label: t("installPolicy.col.ruleType"), width: "140px", render: r => (
                    <Badge variant={RULE_VARIANT[r.ruleType] || "default"}>{r.ruleType}</Badge>
                  )},
                  { key: "reason", label: t("installPolicy.col.reason"), render: r => (
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.reason}</span>
                  )},
                  { key: "enabled", label: t("installPolicy.col.enabled"), width: "80px", render: r => (
                    <Toggle checked={r.enabled} onChange={() => handleTogglePermission(r)} />
                  )},
                ]}
                data={permissionRules}
                keyFn={r => r.id}
              />
            )}
          </Card>
        </div>
      )}

      {/* ── Audit Tab ── */}
      {tab === "audit" && (
        <div>
          {auditEntries.length === 0 ? (
            <EmptyState title={t("installPolicy.empty.audit")} />
          ) : (
            <Card>
              <DataTable<AuditEntry>
                columns={[
                  { key: "timestamp", label: t("installPolicy.col.timestamp"), width: "170px", render: e => (
                    <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      {e.timestamp ? new Date(e.timestamp).toLocaleString() : ""}
                    </span>
                  )},
                  { key: "skillOrPlugin", label: t("installPolicy.col.skill"), width: "160px", render: e => (
                    <span style={{ fontWeight: 500 }}>{e.skillOrPlugin}</span>
                  )},
                  { key: "source", label: t("installPolicy.col.source"), render: e => (
                    <code style={{ fontSize: 11, color: "var(--accent)" }}>{e.source}</code>
                  )},
                  { key: "riskLevel", label: t("installPolicy.col.risk"), width: "110px", render: e => (
                    <Badge variant={RISK_VARIANT[e.riskLevel] || "default"}>{e.riskLevel}</Badge>
                  )},
                  { key: "decision", label: t("installPolicy.col.decision"), width: "140px", render: e => (
                    <Badge variant={DECISION_VARIANT[e.decision] || "default"}>{e.decision}</Badge>
                  )},
                  { key: "evaluator", label: t("installPolicy.col.evaluator"), width: "180px", render: e => (
                    <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{e.evaluator}</code>
                  )},
                ]}
                data={auditEntries}
                keyFn={e => e.id}
              />
            </Card>
          )}
        </div>
      )}

      {/* ── Add Source Rule Modal ── */}
      {showAddSource && (
        <Modal
          title={t("installPolicy.addRule")}
          onClose={() => setShowAddSource(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setShowAddSource(false)}>{t("installPolicy.cancel")}</SecondaryButton>
              <PrimaryButton onClick={handleAddSourceRule}>+</PrimaryButton>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>{t("installPolicy.col.type")}</label>
              <select value={newSourceType} onChange={e => setNewSourceType(e.target.value as SourceType)}
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none" }}>
                {(["official", "verified", "community", "local", "url", "unknown"] as SourceType[]).map(st => (
                  <option key={st} value={st}>{st}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>{t("installPolicy.col.pattern")}</label>
              <input value={newPattern} onChange={e => setNewPattern(e.target.value)}
                placeholder="e.g. community/* or my-org/*"
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>{t("installPolicy.col.ruleType")}</label>
              <select value={newRuleType} onChange={e => setNewRuleType(e.target.value as RuleType)}
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none" }}>
                {(["allow", "deny", "require_approval", "audit_only"] as RuleType[]).map(rt => (
                  <option key={rt} value={rt}>{rt}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>{t("installPolicy.col.reason")}</label>
              <input value={newReason} onChange={e => setNewReason(e.target.value)}
                placeholder="..."
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
            </div>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <Modal
          title={t("installPolicy.removeRule")}
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <SecondaryButton onClick={() => setDeleteTarget(null)}>{t("installPolicy.cancel")}</SecondaryButton>
              <PrimaryButton onClick={() => handleDeleteSourceRule(deleteTarget)}>✓</PrimaryButton>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 14, lineHeight: 1.6 }}>
            {t("installPolicy.confirmRemove")}
          </p>
        </Modal>
      )}
    </div>
  );
}
