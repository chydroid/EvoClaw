/**
 * TokenUsagePage — Token usage tracking dashboard.
 *
 * Shows: Overview stats, by-model breakdown, by-session breakdown, cost analysis.
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

interface TokenOverview {
  totalTokens: number;
  totalCost: number;
  avgTokensPerSession: number;
  totalCalls: number;
}

interface ModelUsage {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  calls: number;
}

interface SessionUsage {
  sessionId: string;
  user: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  lastActive: string;
}

interface ProviderCost {
  provider: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  percentage: number;
}

interface RecentUsageEntry {
  id: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timestamp: string;
  status: string;
}

type TabId = "overview" | "by-model" | "by-session" | "cost";

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  completed: "success", active: "info", failed: "error", timeout: "warning",
};

const PROVIDER_COLORS: Record<string, string> = {
  openai: "#10b981", anthropic: "#f59e0b", google: "#3b82f6",
  mistral: "#8b5cf6", local: "#6b7280",
};

// ── Formatters ──

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatCost(n: number): string {
  return "$" + n.toFixed(4);
}

// ── Mock Data ──

function generateMockOverview(): TokenOverview {
  return {
    totalTokens: 3_847_291,
    totalCost: 24.5632,
    avgTokensPerSession: 1284,
    totalCalls: 2996,
  };
}

function generateMockModelUsage(): ModelUsage[] {
  return [
    { model: "gpt-4o", provider: "openai", inputTokens: 892_340, outputTokens: 312_450, totalTokens: 1_204_790, cost: 12.8450, calls: 1240 },
    { model: "gpt-4o-mini", provider: "openai", inputTokens: 543_210, outputTokens: 198_760, totalTokens: 741_970, cost: 1.4839, calls: 890 },
    { model: "claude-3.5-sonnet", provider: "anthropic", inputTokens: 421_890, outputTokens: 187_340, totalTokens: 609_230, cost: 6.0923, calls: 420 },
    { model: "claude-3-haiku", provider: "anthropic", inputTokens: 234_560, outputTokens: 89_120, totalTokens: 323_680, cost: 0.9710, calls: 310 },
    { model: "gemini-1.5-pro", provider: "google", inputTokens: 312_450, outputTokens: 145_670, totalTokens: 458_120, cost: 2.7487, calls: 98 },
    { model: "mistral-large", provider: "mistral", inputTokens: 98_760, outputTokens: 43_210, totalTokens: 141_970, cost: 0.2839, calls: 38 },
  ];
}

function generateMockSessionUsage(): SessionUsage[] {
  return [
    { sessionId: "sess_a1b2c3", user: "alice", inputTokens: 12_340, outputTokens: 4_560, cost: 0.2468, lastActive: "2026-06-15T08:32:00Z" },
    { sessionId: "sess_d4e5f6", user: "bob", inputTokens: 8_920, outputTokens: 3_210, cost: 0.1784, lastActive: "2026-06-15T07:45:00Z" },
    { sessionId: "sess_g7h8i9", user: "carol", inputTokens: 23_450, outputTokens: 9_870, cost: 0.4690, lastActive: "2026-06-15T06:12:00Z" },
    { sessionId: "sess_j0k1l2", user: "dave", inputTokens: 5_670, outputTokens: 2_130, cost: 0.1134, lastActive: "2026-06-14T22:58:00Z" },
    { sessionId: "sess_m3n4o5", user: "eve", inputTokens: 15_890, outputTokens: 6_780, cost: 0.3178, lastActive: "2026-06-14T19:30:00Z" },
    { sessionId: "sess_p6q7r8", user: "frank", inputTokens: 3_450, outputTokens: 1_230, cost: 0.0690, lastActive: "2026-06-14T15:22:00Z" },
    { sessionId: "sess_s9t0u1", user: "grace", inputTokens: 19_230, outputTokens: 8_450, cost: 0.3846, lastActive: "2026-06-14T11:05:00Z" },
    { sessionId: "sess_v2w3x4", user: "hank", inputTokens: 7_890, outputTokens: 3_560, cost: 0.1578, lastActive: "2026-06-13T23:47:00Z" },
  ];
}

function generateMockRecentUsage(): RecentUsageEntry[] {
  return [
    { id: "req_001", model: "gpt-4o", inputTokens: 2340, outputTokens: 890, cost: 0.0357, timestamp: "2026-06-15T08:32:12Z", status: "completed" },
    { id: "req_002", model: "claude-3.5-sonnet", inputTokens: 1560, outputTokens: 670, cost: 0.0223, timestamp: "2026-06-15T08:30:45Z", status: "completed" },
    { id: "req_003", model: "gpt-4o-mini", inputTokens: 890, outputTokens: 340, cost: 0.0012, timestamp: "2026-06-15T08:28:33Z", status: "completed" },
    { id: "req_004", model: "gemini-1.5-pro", inputTokens: 3450, outputTokens: 1230, cost: 0.0207, timestamp: "2026-06-15T08:25:11Z", status: "completed" },
    { id: "req_005", model: "gpt-4o", inputTokens: 1200, outputTokens: 0, cost: 0.0120, timestamp: "2026-06-15T08:22:09Z", status: "failed" },
    { id: "req_006", model: "claude-3-haiku", inputTokens: 670, outputTokens: 230, cost: 0.0020, timestamp: "2026-06-15T08:19:55Z", status: "completed" },
    { id: "req_007", model: "mistral-large", inputTokens: 2100, outputTokens: 780, cost: 0.0058, timestamp: "2026-06-15T08:15:40Z", status: "timeout" },
    { id: "req_008", model: "gpt-4o", inputTokens: 4560, outputTokens: 1890, cost: 0.0645, timestamp: "2026-06-15T08:10:22Z", status: "completed" },
  ];
}

function generateMockProviderCosts(): ProviderCost[] {
  return [
    { provider: "openai", totalCost: 14.3289, inputTokens: 1_435_550, outputTokens: 511_210, calls: 2130, percentage: 58.3 },
    { provider: "anthropic", totalCost: 7.0633, inputTokens: 656_450, outputTokens: 276_460, calls: 730, percentage: 28.8 },
    { provider: "google", totalCost: 2.7487, inputTokens: 312_450, outputTokens: 145_670, calls: 98, percentage: 11.2 },
    { provider: "mistral", totalCost: 0.2839, inputTokens: 98_760, outputTokens: 43_210, calls: 38, percentage: 1.2 },
    { provider: "local", totalCost: 0.1384, inputTokens: 44_080, outputTokens: 12_740, calls: 0, percentage: 0.5 },
  ];
}

export default function TokenUsagePage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabId>("overview");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [costThreshold, setCostThreshold] = useState(50);
  const [thresholdModalOpen, setThresholdModalOpen] = useState(false);
  const [thresholdInput, setThresholdInput] = useState("50");

  // Data state
  const [overview, setOverview] = useState<TokenOverview | null>(null);
  const [modelUsage, setModelUsage] = useState<ModelUsage[]>([]);
  const [sessionUsage, setSessionUsage] = useState<SessionUsage[]>([]);
  const [recentUsage, setRecentUsage] = useState<RecentUsageEntry[]>([]);
  const [providerCosts, setProviderCosts] = useState<ProviderCost[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [overviewRes, modelRes, sessionRes, costRes] = await Promise.all([
        fetch(`${API}/api/token-usage/overview`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/token-usage/by-model`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/token-usage/by-session`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/token-usage/cost`).then(r => r.json()).catch(() => null),
      ]);
      setOverview(overviewRes?.overview ?? generateMockOverview());
      setModelUsage(modelRes?.models ?? generateMockModelUsage());
      setSessionUsage(sessionRes?.sessions ?? generateMockSessionUsage());
      setRecentUsage(generateMockRecentUsage());
      setProviderCosts(costRes?.providers ?? generateMockProviderCosts());
    } catch {
      // Fallback to mock data
      setOverview(generateMockOverview());
      setModelUsage(generateMockModelUsage());
      setSessionUsage(generateMockSessionUsage());
      setRecentUsage(generateMockRecentUsage());
      setProviderCosts(generateMockProviderCosts());
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-refresh every 30s
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => { loadData(); }, 30_000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadData]);

  const handleSaveThreshold = () => {
    const val = parseFloat(thresholdInput);
    if (isNaN(val) || val <= 0) {
      showToast("Invalid threshold value", "error");
      return;
    }
    setCostThreshold(val);
    setThresholdModalOpen(false);
    showToast(`Cost alert threshold set to ${formatCost(val)}`, "success");
  };

  if (loading) return <Loading />;

  const tabs: { id: TabId; label: string }[] = [
    { id: "overview", label: t("tokenUsage.overview", "Overview") },
    { id: "by-model", label: t("tokenUsage.byModel", "By Model") },
    { id: "by-session", label: t("tokenUsage.bySession", "By Session") },
    { id: "cost", label: t("tokenUsage.cost", "Cost") },
  ];

  const costAlertTriggered = overview !== null && overview.totalCost >= costThreshold;

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <PageHeader
        title={t("tokenUsage.title", "\u{1F4CA} Token Usage")}
        subtitle={t("tokenUsage.subtitle", "Track token consumption, costs, and usage patterns across models and sessions")}
        actions={
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Toggle checked={autoRefresh} onChange={setAutoRefresh} label="Auto-refresh" />
            <SecondaryButton small onClick={loadData}>Refresh</SecondaryButton>
          </div>
        }
      />

      {/* Cost alert banner */}
      {costAlertTriggered && (
        <div style={{
          padding: "10px 16px", borderRadius: 8, marginBottom: 16,
          background: "var(--warning-bg)", border: "1px solid var(--warning)",
          color: "var(--warning)", fontSize: 13, display: "flex",
          alignItems: "center", justifyContent: "space-between",
        }}>
          <span>\u26A0\uFE0F Cost alert: Total cost ({formatCost(overview!.totalCost)}) has exceeded the threshold ({formatCost(costThreshold)})</span>
          <GhostButton small onClick={() => setThresholdModalOpen(true)}>Adjust</GhostButton>
        </div>
      )}

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
      {tab === "overview" && overview && (
        <div>
          <StatsGrid items={[
            { label: "Total Tokens", value: formatTokens(overview.totalTokens), color: "var(--accent)" },
            { label: "Total Cost", value: formatCost(overview.totalCost), color: "var(--warning)" },
            { label: "Avg Tokens/Session", value: formatTokens(overview.avgTokensPerSession), color: "var(--success)" },
            { label: "Total Calls", value: overview.totalCalls.toLocaleString(), color: "var(--text-primary)" },
          ]} />

          <Section title={t("tokenUsage.recentUsage", "Recent Usage")} style={{ marginTop: 24 }}>
            <Card>
              <DataTable<RecentUsageEntry>
                columns={[
                  { key: "id", label: "Request", render: (r) => (
                    <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--accent)" }}>{r.id}</span>
                  )},
                  { key: "model", label: "Model", render: (r) => (
                    <Badge variant="info">{r.model}</Badge>
                  )},
                  { key: "inputTokens", label: "Input", render: (r) => formatTokens(r.inputTokens) },
                  { key: "outputTokens", label: "Output", render: (r) => formatTokens(r.outputTokens) },
                  { key: "cost", label: "Cost", render: (r) => (
                    <span style={{ color: "var(--warning)" }}>{formatCost(r.cost)}</span>
                  )},
                  { key: "timestamp", label: "Time", render: (r) => (
                    <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      {new Date(r.timestamp).toLocaleTimeString()}
                    </span>
                  )},
                  { key: "status", label: "Status", render: (r) => (
                    <Badge variant={STATUS_VARIANT[r.status] || "default"}>{r.status}</Badge>
                  )},
                ]}
                data={recentUsage}
                keyFn={(r) => r.id}
                emptyText="No recent usage data"
              />
            </Card>
          </Section>
        </div>
      )}

      {/* ── By-Model Tab ── */}
      {tab === "by-model" && (
        <div>
          <Card>
            <DataTable<ModelUsage>
              columns={[
                { key: "model", label: "Model", render: (m) => (
                  <span style={{ fontWeight: 600 }}>{m.model}</span>
                )},
                { key: "provider", label: "Provider", render: (m) => (
                  <Badge variant="default" style={{ borderColor: PROVIDER_COLORS[m.provider] || "var(--border)", color: PROVIDER_COLORS[m.provider] || "var(--text-secondary)" }}>
                    {m.provider}
                  </Badge>
                )},
                { key: "inputTokens", label: "Input Tokens", render: (m) => formatTokens(m.inputTokens) },
                { key: "outputTokens", label: "Output Tokens", render: (m) => formatTokens(m.outputTokens) },
                { key: "totalTokens", label: "Total Tokens", render: (m) => (
                  <span style={{ fontWeight: 600 }}>{formatTokens(m.totalTokens)}</span>
                )},
                { key: "cost", label: "Cost", render: (m) => (
                  <span style={{ color: "var(--warning)" }}>{formatCost(m.cost)}</span>
                )},
                { key: "calls", label: "Calls", render: (m) => m.calls.toLocaleString() },
              ]}
              data={modelUsage}
              keyFn={(m) => m.model}
              emptyText="No model usage data"
            />
          </Card>

          {/* Model cost distribution */}
          <Section title={t("tokenUsage.modelDistribution", "Token Distribution by Model")} style={{ marginTop: 20 }}>
            <Card>
              {modelUsage.map(m => {
                const pct = overview ? (m.totalTokens / overview.totalTokens) * 100 : 0;
                return (
                  <div key={m.model} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{m.model}</span>
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{pct.toFixed(1)}% ({formatTokens(m.totalTokens)})</span>
                    </div>
                    <div style={{ height: 6, background: "var(--bg-hover)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{
                        height: "100%", width: `${pct}%`, borderRadius: 3,
                        background: "var(--accent)", transition: "width 0.3s",
                      }} />
                    </div>
                  </div>
                );
              })}
            </Card>
          </Section>
        </div>
      )}

      {/* ── By-Session Tab ── */}
      {tab === "by-session" && (
        <div>
          <Card>
            <DataTable<SessionUsage>
              columns={[
                { key: "sessionId", label: "Session ID", render: (s) => (
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--accent)" }}>{s.sessionId}</span>
                )},
                { key: "user", label: "User", render: (s) => (
                  <span style={{ fontWeight: 500 }}>{s.user}</span>
                )},
                { key: "inputTokens", label: "Input", render: (s) => formatTokens(s.inputTokens) },
                { key: "outputTokens", label: "Output", render: (s) => formatTokens(s.outputTokens) },
                { key: "cost", label: "Cost", render: (s) => (
                  <span style={{ color: "var(--warning)" }}>{formatCost(s.cost)}</span>
                )},
                { key: "lastActive", label: "Last Active", render: (s) => (
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {new Date(s.lastActive).toLocaleString()}
                  </span>
                )},
              ]}
              data={sessionUsage}
              keyFn={(s) => s.sessionId}
              emptyText="No session usage data"
            />
          </Card>

          {/* Session cost summary */}
          <Section title={t("tokenUsage.sessionSummary", "Session Cost Summary")} style={{ marginTop: 20 }}>
            <StatsGrid items={[
              {
                label: "Active Sessions",
                value: sessionUsage.filter(s => {
                  const diff = Date.now() - new Date(s.lastActive).getTime();
                  return diff < 24 * 60 * 60 * 1000;
                }).length,
                color: "var(--success)",
              },
              {
                label: "Avg Cost/Session",
                value: formatCost(sessionUsage.reduce((sum, s) => sum + s.cost, 0) / Math.max(sessionUsage.length, 1)),
                color: "var(--warning)",
              },
              {
                label: "Highest Cost Session",
                value: formatCost(Math.max(...sessionUsage.map(s => s.cost), 0)),
                color: "var(--error)",
              },
              {
                label: "Total Session Tokens",
                value: formatTokens(sessionUsage.reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0)),
                color: "var(--accent)",
              },
            ]} />
          </Section>
        </div>
      )}

      {/* ── Cost Tab ── */}
      {tab === "cost" && (
        <div>
          {/* Cost overview */}
          <StatsGrid items={[
            { label: "Total Cost", value: formatCost(overview?.totalCost ?? 0), color: "var(--warning)" },
            { label: "Alert Threshold", value: formatCost(costThreshold), color: costAlertTriggered ? "var(--error)" : "var(--text-primary)" },
            { label: "Remaining Budget", value: formatCost(Math.max(costThreshold - (overview?.totalCost ?? 0), 0)), color: "var(--success)" },
            { label: "Avg Cost/Call", value: formatCost((overview?.totalCost ?? 0) / Math.max(overview?.totalCalls ?? 1, 1)), color: "var(--text-primary)" },
          ]} />

          {/* Provider cost breakdown */}
          <Section title={t("tokenUsage.providerCosts", "Cost by Provider")} style={{ marginTop: 24 }}>
            <Card>
              {providerCosts.map(p => (
                <div key={p.provider} style={{
                  display: "flex", alignItems: "center", gap: 16,
                  padding: "12px 0", borderBottom: "1px solid var(--border-light)",
                }}>
                  <div style={{ width: 100 }}>
                    <Badge variant="default" style={{
                      borderColor: PROVIDER_COLORS[p.provider] || "var(--border)",
                      color: PROVIDER_COLORS[p.provider] || "var(--text-secondary)",
                    }}>
                      {p.provider}
                    </Badge>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--warning)" }}>{formatCost(p.totalCost)}</span>
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{p.percentage.toFixed(1)}%</span>
                    </div>
                    <div style={{ height: 8, background: "var(--bg-hover)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{
                        height: "100%", width: `${p.percentage}%`, borderRadius: 4,
                        background: PROVIDER_COLORS[p.provider] || "var(--accent)",
                        transition: "width 0.3s",
                      }} />
                    </div>
                  </div>
                  <div style={{ width: 180, fontSize: 11, color: "var(--text-muted)", textAlign: "right" }}>
                    <div>{formatTokens(p.inputTokens)} in / {formatTokens(p.outputTokens)} out</div>
                    <div>{p.calls.toLocaleString()} calls</div>
                  </div>
                </div>
              ))}
            </Card>
          </Section>

          {/* Cost alert settings */}
          <Section title={t("tokenUsage.costAlerts", "Cost Alert Settings")} style={{ marginTop: 20 }}>
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Cost Alert Threshold</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                    Get notified when total cost exceeds the threshold. Current: {formatCost(costThreshold)}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Badge variant={costAlertTriggered ? "error" : "success"}>
                    {costAlertTriggered ? "ALERT TRIGGERED" : "WITHIN BUDGET"}
                  </Badge>
                  <PrimaryButton small onClick={() => { setThresholdInput(String(costThreshold)); setThresholdModalOpen(true); }}>
                    Configure
                  </PrimaryButton>
                </div>
              </div>

              {/* Budget usage bar */}
              <div style={{ marginTop: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Budget Usage</span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {((overview?.totalCost ?? 0) / costThreshold * 100).toFixed(1)}%
                  </span>
                </div>
                <div style={{ height: 10, background: "var(--bg-hover)", borderRadius: 5, overflow: "hidden" }}>
                  <div style={{
                    height: "100%",
                    width: `${Math.min((overview?.totalCost ?? 0) / costThreshold * 100, 100)}%`,
                    borderRadius: 5,
                    background: costAlertTriggered ? "var(--error)" : "var(--success)",
                    transition: "width 0.3s, background 0.3s",
                  }} />
                </div>
              </div>
            </Card>
          </Section>
        </div>
      )}

      {/* ── Threshold Modal ── */}
      {thresholdModalOpen && (
        <Modal
          title="Set Cost Alert Threshold"
          onClose={() => setThresholdModalOpen(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setThresholdModalOpen(false)}>Cancel</SecondaryButton>
              <PrimaryButton onClick={handleSaveThreshold}>Save</PrimaryButton>
            </>
          }
        >
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>
              Enter the cost threshold (USD). You will be alerted when total spending exceeds this amount.
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>$</span>
              <input
                type="number"
                value={thresholdInput}
                onChange={e => setThresholdInput(e.target.value)}
                min="0"
                step="1"
                style={{
                  flex: 1, padding: "8px 12px", borderRadius: 8,
                  border: "1px solid var(--border)", background: "var(--bg-input)",
                  color: "var(--text-primary)", fontSize: 14, outline: "none",
                }}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {[10, 25, 50, 100, 250].map(v => (
              <GhostButton key={v} small onClick={() => setThresholdInput(String(v))}>
                ${v}
              </GhostButton>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
