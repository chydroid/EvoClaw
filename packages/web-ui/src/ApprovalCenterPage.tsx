/**
 * ApprovalCenterPage — Approval Timeout Manager + Reaction Approval Handler.
 *
 * Uses real backend APIs (no mock data).
 */
import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, EmptyState,
  Section, PrimaryButton, SecondaryButton,
  StatsGrid, showToast, DataTable, Modal,
} from "./shared";
import type { BadgeVariant } from "./shared";
import { useTranslation } from "./i18n";

const API = window.__EVOCLAW_API__ || "";

type TabId = "pending" | "history" | "settings" | "reactions";

interface PendingRequest {
  id: string;
  operation: string;
  target: string;
  description?: string;
  channel?: string;
  requester: string;
  requestedAt: string;
  expiresAt: string;
  riskLevel: "critical" | "high" | "medium" | "low";
}

interface HistoryEntry {
  id: string;
  timestamp: string;
  operation: string;
  target: string;
  requester: string;
  decision: "approved" | "denied" | "expired";
  responseTime: number;
  channel: string;
}

interface ReactionEntry {
  id: string;
  timestamp: string;
  messageId: string;
  channel: string;
  request: string;
  emoji: string;
  user: string;
  decision: "approved" | "denied";
}

interface TimeoutConfig {
  timeoutSeconds: number;
  defaultAction: "deny" | "allow" | "fail-closed";
  behaviorMode: "immediate" | "debounced" | "scheduled";
  debounceWindowMs: number;
  scheduleCron: string;
  escalationEnabled: boolean;
  escalationTimeout: number;
}

const RISK_VARIANT: Record<string, BadgeVariant> = {
  critical: "error", high: "warning", medium: "default", low: "default",
};

const DECISION_VARIANT: Record<string, BadgeVariant> = {
  approved: "success", denied: "error", expired: "warning", pending: "info",
};

function formatTimeRemaining(expiresAt: string): { text: string; expired: boolean } {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return { text: "0s", expired: true };
  const s = Math.floor(ms / 1000);
  if (s < 60) return { text: `${s}s`, expired: false };
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return { text: `${m}m ${remS}s`, expired: false };
}

export default function ApprovalCenterPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>("pending");
  const [loading, setLoading] = useState(true);

  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [reactions, setReactions] = useState<ReactionEntry[]>([]);
  const [config, setConfig] = useState<TimeoutConfig>({
    timeoutSeconds: 300, defaultAction: "deny", behaviorMode: "immediate",
    debounceWindowMs: 5000, scheduleCron: "",
    escalationEnabled: false, escalationTimeout: 60,
  });
  const [confirmAction, setConfirmAction] = useState<{ type: "approve" | "deny"; req: PendingRequest } | null>(null);
  const [filter, setFilter] = useState<"all" | "approved" | "denied" | "expired">("all");
  const [_, setTick] = useState(0);

  // Countdown tick (1s)
  useEffect(() => {
    if (tab !== "pending") return;
    const interval = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(interval);
  }, [tab]);

  const loadData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [pendingRes, configRes, reactionRes, historyRes] = await Promise.all([
        fetch(`${API}/api/approvals/pending`, { signal }).then(r => r.json()).catch((err) => { console.error("[API] request failed:", err); return null; }),
        fetch(`${API}/api/approval-timeout/config`, { signal }).then(r => r.json()).catch((err) => { console.error("[API] request failed:", err); return null; }),
        fetch(`${API}/api/reaction-approvals`, { signal }).then(r => r.json()).catch((err) => { console.error("[API] request failed:", err); return null; }),
        fetch(`${API}/api/approvals/history`, { signal }).then(r => r.json()).catch((err) => { console.error("[API] request failed:", err); return null; }),
      ]);

      const pendList: PendingRequest[] = (pendingRes?.pending || pendingRes?.requests || pendingRes || []) as any[];
      setPending(pendList);

      if (configRes) {
        setConfig({
          timeoutSeconds: Number(configRes.timeoutSeconds ?? configRes.timeout ?? 300),
          defaultAction: configRes.defaultAction ?? "deny",
          behaviorMode: configRes.behaviorMode ?? "immediate",
          debounceWindowMs: Number(configRes.debounceWindowMs ?? 5000),
          scheduleCron: configRes.scheduleCron ?? "",
          escalationEnabled: !!configRes.escalationEnabled,
          escalationTimeout: Number(configRes.escalationTimeout ?? 60),
        });
      }

      // History from dedicated /api/approvals/history endpoint
      const hist: HistoryEntry[] = (historyRes?.history || []) as any[];
      setHistory(hist);

      // Reactions endpoint returns {history, pending, stats}
      const reactList: ReactionEntry[] = (reactionRes?.history || reactionRes?.entries || reactionRes || []) as any[];
      setReactions(reactList);
    } catch {
      // Keep empty state
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    loadData(controller.signal);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [loadData]);

  // Auto-refresh pending
  useEffect(() => {
    if (tab !== "pending") return;
    const interval = setInterval(() => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      loadData(controller.signal).finally(() => clearTimeout(timeout));
    }, 10000);
    return () => clearInterval(interval);
  }, [tab, loadData]);

  const handleApprove = async (req: PendingRequest) => {
    try {
      const res = await fetch(`${API}/api/approvals/${req.id}/approve`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast(t("approval.approveSuccess"), "success");
      setPending(prev => prev.filter(p => p.id !== req.id));
    } catch (e: any) {
      showToast(e.message || t("approval.approve"), "error");
    }
    setConfirmAction(null);
  };

  const handleDeny = async (req: PendingRequest) => {
    try {
      const res = await fetch(`${API}/api/approvals/${req.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: t("approval.deny") }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast(t("approval.denySuccess"), "success");
      setPending(prev => prev.filter(p => p.id !== req.id));
    } catch (e: any) {
      showToast(e.message || t("approval.deny"), "error");
    }
    setConfirmAction(null);
  };

  const handleSaveConfig = async () => {
    try {
      const res = await fetch(`${API}/api/approval-timeout/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast(t("approval.settings.saved"), "success");
    } catch (e: any) {
      showToast(e.message || t("approval.settings.save"), "error");
    }
  };

  if (loading) return <Loading />;

  const tabs: { id: TabId; key: string }[] = [
    { id: "pending", key: "approval.tabs.pending" },
    { id: "history", key: "approval.tabs.history" },
    { id: "settings", key: "approval.tabs.settings" },
    { id: "reactions", key: "approval.tabs.reactions" },
  ];

  const filteredHistory = filter === "all" ? history : history.filter(h => h.decision === filter);

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <PageHeader
        title={t("approval.title")}
        subtitle={t("approval.subtitle")}
        actions={<SecondaryButton small onClick={loadData}>↻</SecondaryButton>}
      />

      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
        {tabs.map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            style={{
              padding: "8px 16px", border: "none", borderRadius: 6, cursor: "pointer",
              background: tab === tb.id ? "var(--accent)" : "transparent",
              color: tab === tb.id ? "#fff" : "var(--text-muted)", fontWeight: 600, fontSize: 13,
            }}>
            {t(tb.key)} {tb.id === "pending" && pending.length > 0 && `(${pending.length})`}
          </button>
        ))}
      </div>

      {/* ── Pending Tab ── */}
      {tab === "pending" && (
        <div>
          {pending.length === 0 ? (
            <EmptyState title={t("approval.empty.pending")} />
          ) : (
            pending.map(req => {
              const remaining = formatTimeRemaining(req.expiresAt);
              return (
                <Card key={req.id} style={{
                  marginBottom: 12, borderLeft: `3px solid ${remaining.expired ? "var(--error)" : "var(--warning)"}`,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <code style={{ fontSize: 11, color: "var(--accent)" }}>{req.id}</code>
                        <Badge variant={RISK_VARIANT[req.riskLevel] || "default"}>{req.riskLevel}</Badge>
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{req.operation}</div>
                      {req.description && (
                        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>{req.description}</div>
                      )}
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {req.target && <span>{req.target} · </span>}
                        {req.channel && <span>{req.channel} · </span>}
                        {req.requester && <span>{req.requester} · </span>}
                        {req.requestedAt && <span>{new Date(req.requestedAt).toLocaleString()}</span>}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                      <div style={{
                        fontSize: 13, fontWeight: 600,
                        color: remaining.expired ? "var(--error)" : "var(--warning)",
                      }}>
                        ⏱ {remaining.expired ? t("approval.expired") : remaining.text}
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => setConfirmAction({ type: "approve", req })}
                          disabled={remaining.expired}
                          style={{
                            padding: "6px 12px", borderRadius: 4, border: "none", cursor: "pointer",
                            background: "var(--success)", color: "#fff", fontSize: 12, fontWeight: 600,
                            opacity: remaining.expired ? 0.5 : 1,
                          }}>
                          ✓ {t("approval.approve")}
                        </button>
                        <button onClick={() => setConfirmAction({ type: "deny", req })}
                          disabled={remaining.expired}
                          style={{
                            padding: "6px 12px", borderRadius: 4, border: "none", cursor: "pointer",
                            background: "var(--error)", color: "#fff", fontSize: 12, fontWeight: 600,
                            opacity: remaining.expired ? 0.5 : 1,
                          }}>
                          ✕ {t("approval.deny")}
                        </button>
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })
          )}
        </div>
      )}

      {/* ── History Tab ── */}
      {tab === "history" && (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            {(["all", "approved", "denied", "expired"] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                style={{
                  padding: "6px 12px", borderRadius: 4, cursor: "pointer", fontSize: 12,
                  background: filter === f ? "var(--accent)" : "var(--bg-card)",
                  color: filter === f ? "#fff" : "var(--text-secondary)",
                  border: "1px solid var(--border)",
                }}>
                {t(`approval.history.filter.${f}`)}
              </button>
            ))}
          </div>
          <Card>
            {filteredHistory.length === 0 ? (
              <EmptyState title={t("approval.empty.history")} />
            ) : (
              <DataTable<HistoryEntry>
                columns={[
                  { key: "timestamp", label: t("approval.col.timestamp"), width: "170px", render: h => (
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {h.timestamp ? new Date(h.timestamp).toLocaleString() : ""}
                    </span>
                  )},
                  { key: "operation", label: t("approval.col.operation"), render: h => (
                    <span style={{ fontWeight: 500 }}>{h.operation}</span>
                  )},
                  { key: "target", label: t("approval.col.target"), render: h => (
                    <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{h.target}</code>
                  )},
                  { key: "requester", label: t("approval.col.requester"), render: h => h.requester },
                  { key: "decision", label: t("approval.col.decision"), width: "100px", render: h => (
                    <Badge variant={DECISION_VARIANT[h.decision] || "default"}>{h.decision}</Badge>
                  )},
                  { key: "responseTime", label: t("approval.col.responseTime"), render: h => `${h.responseTime}s` },
                  { key: "channel", label: t("approval.col.channel"), render: h => (
                    <Badge variant="default">{h.channel}</Badge>
                  )},
                ]}
                data={filteredHistory}
                keyFn={h => h.id}
              />
            )}
          </Card>
        </div>
      )}

      {/* ── Settings Tab ── */}
      {tab === "settings" && (
        <div>
          <StatsGrid items={[
            { label: t("approval.settings.statsTotal"), value: history.length, color: "var(--accent)" },
            {
              label: t("approval.settings.statsApprovalRate"),
              value: history.length > 0
                ? `${((history.filter(h => h.decision === "approved").length / history.length) * 100).toFixed(0)}%`
                : "—",
              color: "var(--success)",
            },
            {
              label: t("approval.settings.statsAvgResponse"),
              value: history.length > 0
                ? `${(history.reduce((s, h) => s + h.responseTime, 0) / history.length).toFixed(1)}s`
                : "—",
              color: "var(--warning)",
            },
            {
              label: t("approval.settings.statsTimeoutRate"),
              value: history.length > 0
                ? `${((history.filter(h => h.decision === "expired").length / history.length) * 100).toFixed(0)}%`
                : "—",
              color: "var(--error)",
            },
          ]} />

          <Section title={t("approval.settings.title")} style={{ marginTop: 24 }}>
            <Card>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div>
                  <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                    {t("approval.settings.timeout")}
                  </label>
                  <input type="number" value={config.timeoutSeconds}
                    onChange={e => setConfig(c => ({ ...c, timeoutSeconds: Number(e.target.value) }))}
                    style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none" }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                    {t("approval.settings.defaultAction")}
                  </label>
                  <select value={config.defaultAction} onChange={e => setConfig(c => ({ ...c, defaultAction: e.target.value as any }))}
                    style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none" }}>
                    <option value="deny">{t("approval.settings.action.deny")}</option>
                    <option value="allow">{t("approval.settings.action.allow")}</option>
                    <option value="fail-closed">{t("approval.settings.action.failClosed")}</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                    {t("approval.settings.behaviorMode")}
                  </label>
                  <select value={config.behaviorMode} onChange={e => setConfig(c => ({ ...c, behaviorMode: e.target.value as any }))}
                    style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none" }}>
                    <option value="immediate">{t("approval.settings.behavior.immediate")}</option>
                    <option value="debounced">{t("approval.settings.behavior.debounced")}</option>
                    <option value="scheduled">{t("approval.settings.behavior.scheduled")}</option>
                  </select>
                </div>
                {config.behaviorMode === "debounced" && (
                  <div>
                    <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                      {t("approval.settings.debounceWindow")}
                    </label>
                    <input type="number" value={config.debounceWindowMs}
                      onChange={e => setConfig(c => ({ ...c, debounceWindowMs: Number(e.target.value) }))}
                      style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none" }} />
                  </div>
                )}
                {config.behaviorMode === "scheduled" && (
                  <div>
                    <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                      {t("approval.settings.scheduleCron")}
                    </label>
                    <input type="text" value={config.scheduleCron} placeholder="*/5 * * * *"
                      onChange={e => setConfig(c => ({ ...c, scheduleCron: e.target.value }))}
                      style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, fontFamily: "monospace", outline: "none" }} />
                  </div>
                )}
                <div>
                  <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                    {t("approval.settings.escalationTimeout")}
                  </label>
                  <input type="number" value={config.escalationTimeout} disabled={!config.escalationEnabled}
                    onChange={e => setConfig(c => ({ ...c, escalationTimeout: Number(e.target.value) }))}
                    style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none", opacity: config.escalationEnabled ? 1 : 0.5 }} />
                </div>
              </div>
              <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={config.escalationEnabled}
                  onChange={e => setConfig(c => ({ ...c, escalationEnabled: e.target.checked }))} />
                <label style={{ fontSize: 13, color: "var(--text-primary)" }}>
                  {t("approval.settings.escalationEnabled")}
                </label>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <PrimaryButton onClick={handleSaveConfig}>✓ {t("approval.settings.save")}</PrimaryButton>
                <SecondaryButton onClick={() => setConfig({
                  timeoutSeconds: 300, defaultAction: "deny", behaviorMode: "immediate",
                  debounceWindowMs: 5000, scheduleCron: "",
                  escalationEnabled: false, escalationTimeout: 60,
                })}>↺</SecondaryButton>
              </div>
            </Card>
          </Section>
        </div>
      )}

      {/* ── Reactions Tab ── */}
      {tab === "reactions" && (
        <div>
          <Section title={t("approval.reactions.title")}>
            <Card>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
                {[
                  { ch: "telegram", approve: "👍", deny: "👎" },
                  { ch: "discord", approve: "✅", deny: "❌" },
                  { ch: "slack", approve: ":white_check_mark:", deny: ":x:" },
                  { ch: "feishu", approve: "OK", deny: "Not OK" },
                  { ch: "whatsapp", approve: "✅", deny: "❌" },
                  { ch: "imessage", approve: "👍", deny: "👎" },
                  { ch: "signal", approve: "👍", deny: "👎" },
                ].map(c => (
                  <div key={c.ch} style={{ padding: 12, background: "var(--bg-input)", borderRadius: 6, border: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{c.ch}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      ✓ {c.approve} · ✕ {c.deny}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </Section>

          <Section title={t("approval.reactions.title")} style={{ marginTop: 20 }}>
            <Card>
              {reactions.length === 0 ? (
                <EmptyState title={t("approval.empty.reactions")} />
              ) : (
                <DataTable<ReactionEntry>
                  columns={[
                    { key: "timestamp", label: t("approval.col.timestamp"), width: "170px", render: r => (
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {r.timestamp ? new Date(r.timestamp).toLocaleString() : ""}
                      </span>
                    )},
                    { key: "messageId", label: t("approval.col.messageId"), render: r => (
                      <code style={{ fontSize: 11, color: "var(--accent)" }}>{r.messageId}</code>
                    )},
                    { key: "channel", label: t("approval.col.channel"), render: r => (
                      <Badge variant="default">{r.channel}</Badge>
                    )},
                    { key: "request", label: t("approval.col.operation"), render: r => r.request },
                    { key: "emoji", label: t("approval.col.emoji"), width: "60px", render: r => (
                      <span style={{ fontSize: 18 }}>{r.emoji}</span>
                    )},
                    { key: "user", label: t("approval.col.user"), render: r => r.user },
                    { key: "decision", label: t("approval.col.decision"), width: "100px", render: r => (
                      <Badge variant={DECISION_VARIANT[r.decision] || "default"}>{r.decision}</Badge>
                    )},
                  ]}
                  data={reactions}
                  keyFn={r => r.id}
                />
              )}
            </Card>
          </Section>
        </div>
      )}

      {/* ── Confirm Modal ── */}
      {confirmAction && (
        <Modal
          title={confirmAction.type === "approve" ? t("approval.confirmApprove") : t("approval.confirmDeny")}
          onClose={() => setConfirmAction(null)}
          footer={
            <>
              <SecondaryButton onClick={() => setConfirmAction(null)}>{t("approval.cancel")}</SecondaryButton>
              <PrimaryButton onClick={() => confirmAction.type === "approve" ? handleApprove(confirmAction.req) : handleDeny(confirmAction.req)}>
                ✓
              </PrimaryButton>
            </>
          }
        >
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            <div style={{ marginBottom: 8 }}><strong>{t("approval.col.operation")}:</strong> {confirmAction.req.operation}</div>
            <div style={{ marginBottom: 8 }}><strong>{t("approval.col.target")}:</strong> {confirmAction.req.target}</div>
            <div><strong>{t("approval.col.requester")}:</strong> {confirmAction.req.requester}</div>
          </div>
        </Modal>
      )}
    </div>
  );
}
