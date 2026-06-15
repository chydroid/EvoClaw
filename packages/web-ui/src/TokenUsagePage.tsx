/**
 * TokenUsagePage — Token usage tracking dashboard.
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

export default function TokenUsagePage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabId>("overview");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [costThreshold, setCostThreshold] = useState(50);
  const [thresholdModalOpen, setThresholdModalOpen] = useState(false);
  const [thresholdInput, setThresholdInput] = useState("50");

  // Data state — all initialized to empty/zero
  const [overview, setOverview] = useState<TokenOverview>({
    totalTokens: 0, totalCost: 0, avgTokensPerSession: 0, totalCalls: 0,
  });
  const [modelUsage, setModelUsage] = useState<ModelUsage[]>([]);
  const [sessionUsage, setSessionUsage] = useState<SessionUsage[]>([]);
  const [providerCosts, setProviderCosts] = useState<ProviderCost[]>([]);
  const [recentUsage, setRecentUsage] = useState<{ id: string; model: string; tokens: number; cost: number; timestamp: string }[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [overviewRes, modelRes, sessionRes, costRes] = await Promise.all([
        fetch(`${API}/api/token-usage/overview`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/token-usage/by-model`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/token-usage/by-session`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/token-usage/cost`).then(r => r.json()).catch(() => null),
      ]);
      if (overviewRes && typeof overviewRes === "object") {
        setOverview({
          totalTokens: Number(overviewRes.totalTokens) || 0,
          totalCost: Number(overviewRes.totalCost) || 0,
          avgTokensPerSession: Number(overviewRes.avgTokensPerSession) || 0,
          totalCalls: Number(overviewRes.totalCalls) || 0,
        });
        if (Array.isArray(overviewRes.recentUsage)) setRecentUsage(overviewRes.recentUsage);
      }
      if (modelRes && Array.isArray(modelRes.models)) setModelUsage(modelRes.models);
      else if (Array.isArray(modelRes)) setModelUsage(modelRes);
      if (sessionRes && Array.isArray(sessionRes.sessions)) setSessionUsage(sessionRes.sessions);
      else if (Array.isArray(sessionRes)) setSessionUsage(sessionRes);
      if (costRes && Array.isArray(costRes.providers)) setProviderCosts(costRes.providers);
      else if (Array.isArray(costRes)) setProviderCosts(costRes);
    } catch {
      // Network error — keep empty state
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => { loadData(); }, 30_000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadData]);

  const handleSaveThreshold = () => {
    const val = parseFloat(thresholdInput);
    if (isNaN(val) || val <= 0) {
      showToast(t("tokenUsage.cost.invalid"), "error");
      return;
    }
    setCostThreshold(val);
    setThresholdModalOpen(false);
    showToast(t("tokenUsage.cost.saved") + ": $" + val.toFixed(2), "success");
  };

  if (loading) return <Loading />;

  const tabs: { id: TabId; key: string }[] = [
    { id: "overview", key: "tokenUsage.tabs.overview" },
    { id: "by-model", key: "tokenUsage.tabs.byModel" },
    { id: "by-session", key: "tokenUsage.tabs.bySession" },
    { id: "cost", key: "tokenUsage.tabs.cost" },
  ];

  const costAlertTriggered = overview.totalCost >= costThreshold;

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <PageHeader
        title={t("tokenUsage.title")}
        subtitle={t("tokenUsage.subtitle")}
        actions={
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Toggle checked={autoRefresh} onChange={setAutoRefresh} label={t("tokenUsage.actions.autoRefresh")} />
            <SecondaryButton small onClick={loadData}>{t("tokenUsage.actions.refresh")}</SecondaryButton>
          </div>
        }
      />

      {costAlertTriggered && (
        <div style={{
          padding: "10px 16px", borderRadius: 8, marginBottom: 16,
          background: "var(--warning-bg)", border: "1px solid var(--warning)",
          color: "var(--warning)", fontSize: 13, display: "flex",
          alignItems: "center", justifyContent: "space-between",
        }}>
          <span>⚠️ {t("tokenUsage.cost.alert").replace("{0}", formatCost(overview.totalCost)).replace("{1}", formatCost(costThreshold))}</span>
          <GhostButton small onClick={() => setThresholdModalOpen(true)}>{t("tokenUsage.cost.threshold")}</GhostButton>
        </div>
      )}

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
            { label: t("tokenUsage.stats.totalTokens"), value: formatTokens(overview.totalTokens), color: "var(--accent)" },
            { label: t("tokenUsage.stats.totalCost"), value: formatCost(overview.totalCost), color: "var(--warning)" },
            { label: t("tokenUsage.stats.avgPerSession"), value: formatTokens(overview.avgTokensPerSession), color: "var(--success)" },
            { label: t("tokenUsage.stats.totalCalls"), value: overview.totalCalls.toLocaleString(), color: "var(--text-primary)" },
          ]} />

          <Section title={t("tokenUsage.recentUsage")} style={{ marginTop: 24 }}>
            <Card>
              {recentUsage.length === 0 ? (
                <EmptyState title={t("tokenUsage.empty.overview")} />
              ) : (
                <DataTable
                  columns={[
                    { key: "id", label: t("tokenUsage.col.request"), render: (r: any) => (
                      <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--accent)" }}>{r.id}</span>
                    )},
                    { key: "model", label: t("tokenUsage.col.model"), render: (r: any) => (
                      <Badge variant="info">{r.model}</Badge>
                    )},
                    { key: "tokens", label: t("tokenUsage.col.total"), render: (r: any) => formatTokens(r.tokens ?? ((r.inputTokens || 0) + (r.outputTokens || 0))) },
                    { key: "cost", label: t("tokenUsage.col.cost"), render: (r: any) => (
                      <span style={{ color: "var(--warning)" }}>{formatCost(r.cost)}</span>
                    )},
                    { key: "timestamp", label: t("tokenUsage.col.timestamp"), render: (r: any) => (
                      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                        {r.timestamp ? new Date(r.timestamp).toLocaleString() : "—"}
                      </span>
                    )},
                  ]}
                  data={recentUsage}
                  keyFn={(r: any) => r.id}
                />
              )}
            </Card>
          </Section>
        </div>
      )}

      {/* ── By-Model Tab ── */}
      {tab === "by-model" && (
        <div>
          <Card>
            {modelUsage.length === 0 ? (
              <EmptyState title={t("tokenUsage.empty.byModel")} />
            ) : (
              <DataTable<ModelUsage>
                columns={[
                  { key: "model", label: t("tokenUsage.col.model"), render: (m) => (
                    <span style={{ fontWeight: 600 }}>{m.model}</span>
                  )},
                  { key: "provider", label: t("tokenUsage.col.provider"), render: (m) => (
                    <Badge variant="default" style={{ borderColor: PROVIDER_COLORS[m.provider] || "var(--border)", color: PROVIDER_COLORS[m.provider] || "var(--text-secondary)" }}>
                      {m.provider}
                    </Badge>
                  )},
                  { key: "inputTokens", label: t("tokenUsage.col.input"), render: (m) => formatTokens(m.inputTokens) },
                  { key: "outputTokens", label: t("tokenUsage.col.output"), render: (m) => formatTokens(m.outputTokens) },
                  { key: "totalTokens", label: t("tokenUsage.col.total"), render: (m) => (
                    <span style={{ fontWeight: 600 }}>{formatTokens(m.totalTokens)}</span>
                  )},
                  { key: "cost", label: t("tokenUsage.col.cost"), render: (m) => (
                    <span style={{ color: "var(--warning)" }}>{formatCost(m.cost)}</span>
                  )},
                  { key: "calls", label: t("tokenUsage.col.calls"), render: (m) => m.calls.toLocaleString() },
                ]}
                data={modelUsage}
                keyFn={(m) => m.model}
              />
            )}
          </Card>

          {modelUsage.length > 0 && (
            <Section title={t("tokenUsage.providerBreakdown")} style={{ marginTop: 20 }}>
              <Card>
                {modelUsage.map(m => {
                  const pct = overview.totalTokens > 0 ? (m.totalTokens / overview.totalTokens) * 100 : 0;
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
          )}
        </div>
      )}

      {/* ── By-Session Tab ── */}
      {tab === "by-session" && (
        <div>
          <Card>
            {sessionUsage.length === 0 ? (
              <EmptyState title={t("tokenUsage.empty.bySession")} />
            ) : (
              <DataTable<SessionUsage>
                columns={[
                  { key: "sessionId", label: t("tokenUsage.col.session"), render: (s) => (
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--accent)" }}>{s.sessionId}</span>
                  )},
                  { key: "user", label: t("tokenUsage.col.user"), render: (s) => (
                    <span style={{ fontWeight: 500 }}>{s.user}</span>
                  )},
                  { key: "inputTokens", label: t("tokenUsage.col.input"), render: (s) => formatTokens(s.inputTokens) },
                  { key: "outputTokens", label: t("tokenUsage.col.output"), render: (s) => formatTokens(s.outputTokens) },
                  { key: "cost", label: t("tokenUsage.col.cost"), render: (s) => (
                    <span style={{ color: "var(--warning)" }}>{formatCost(s.cost)}</span>
                  )},
                  { key: "lastActive", label: t("tokenUsage.col.lastActive"), render: (s) => (
                    <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      {new Date(s.lastActive).toLocaleString()}
                    </span>
                  )},
                ]}
                data={sessionUsage}
                keyFn={(s) => s.sessionId}
              />
            )}
          </Card>

          {sessionUsage.length > 0 && (
            <Section title={t("tokenUsage.sessionSummary")} style={{ marginTop: 20 }}>
              <StatsGrid items={[
                {
                  label: t("tokenUsage.stats.totalCalls"),
                  value: sessionUsage.filter(s => {
                    const diff = Date.now() - new Date(s.lastActive).getTime();
                    return diff < 24 * 60 * 60 * 1000;
                  }).length,
                  color: "var(--success)",
                },
                {
                  label: t("tokenUsage.col.cost"),
                  value: formatCost(sessionUsage.reduce((sum, s) => sum + s.cost, 0) / Math.max(sessionUsage.length, 1)),
                  color: "var(--warning)",
                },
                {
                  label: t("tokenUsage.col.total"),
                  value: formatCost(Math.max(...sessionUsage.map(s => s.cost), 0)),
                  color: "var(--error)",
                },
                {
                  label: t("tokenUsage.col.session"),
                  value: formatTokens(sessionUsage.reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0)),
                  color: "var(--accent)",
                },
              ]} />
            </Section>
          )}
        </div>
      )}

      {/* ── Cost Tab ── */}
      {tab === "cost" && (
        <div>
          <StatsGrid items={[
            { label: t("tokenUsage.stats.totalCost"), value: formatCost(overview.totalCost), color: "var(--warning)" },
            { label: t("tokenUsage.cost.threshold"), value: formatCost(costThreshold), color: costAlertTriggered ? "var(--error)" : "var(--text-primary)" },
            { label: t("tokenUsage.cost.withinBudget"), value: formatCost(Math.max(costThreshold - overview.totalCost, 0)), color: "var(--success)" },
            { label: t("tokenUsage.stats.totalCalls"), value: formatCost(overview.totalCost / Math.max(overview.totalCalls, 1)), color: "var(--text-primary)" },
          ]} />

          <Section title={t("tokenUsage.cost.byProvider")} style={{ marginTop: 24 }}>
            <Card>
              {providerCosts.length === 0 ? (
                <EmptyState title={t("tokenUsage.empty.cost")} />
              ) : (
                providerCosts.map(p => (
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
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{(p.percentage ?? 0).toFixed(1)}%</span>
                      </div>
                      <div style={{ height: 8, background: "var(--bg-hover)", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{
                          height: "100%", width: `${p.percentage ?? 0}%`, borderRadius: 4,
                          background: PROVIDER_COLORS[p.provider] || "var(--accent)",
                          transition: "width 0.3s",
                        }} />
                      </div>
                    </div>
                    <div style={{ width: 180, fontSize: 11, color: "var(--text-muted)", textAlign: "right" }}>
                      <div>{formatTokens(p.inputTokens)} / {formatTokens(p.outputTokens)}</div>
                      <div>{p.calls.toLocaleString()} calls</div>
                    </div>
                  </div>
                ))
              )}
            </Card>
          </Section>

          <Section title={t("tokenUsage.cost.threshold")} style={{ marginTop: 20 }}>
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t("tokenUsage.cost.threshold")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                    {t("tokenUsage.cost.withinBudget")}: {formatCost(costThreshold)}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Badge variant={costAlertTriggered ? "error" : "success"}>
                    {costAlertTriggered ? t("tokenUsage.cost.alert").split("：")[0] : t("tokenUsage.cost.withinBudget")}
                  </Badge>
                  <PrimaryButton small onClick={() => { setThresholdInput(String(costThreshold)); setThresholdModalOpen(true); }}>
                    {t("tokenUsage.cost.threshold")}
                  </PrimaryButton>
                </div>
              </div>

              <div style={{ marginTop: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Budget Usage</span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {(overview.totalCost / Math.max(costThreshold, 1) * 100).toFixed(1)}%
                  </span>
                </div>
                <div style={{ height: 10, background: "var(--bg-hover)", borderRadius: 5, overflow: "hidden" }}>
                  <div style={{
                    height: "100%",
                    width: `${Math.min(overview.totalCost / Math.max(costThreshold, 1) * 100, 100)}%`,
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

      {thresholdModalOpen && (
        <Modal
          title={t("tokenUsage.cost.threshold")}
          onClose={() => setThresholdModalOpen(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setThresholdModalOpen(false)}>{t("common.cancel")}</SecondaryButton>
              <PrimaryButton onClick={handleSaveThreshold}>{t("common.save")}</PrimaryButton>
            </>
          }
        >
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>
              {t("tokenUsage.cost.threshold")}
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
          <div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>Quick Select</div>
            <div style={{ display: "flex", gap: 8 }}>
              {[10, 25, 50, 100, 250].map(v => (
                <GhostButton key={v} small onClick={() => setThresholdInput(String(v))}>
                  ${v}
                </GhostButton>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
