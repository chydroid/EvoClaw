/**
 * ApprovalCenterPage — Approval Timeout Manager + Reaction Approval Handler.
 *
 * Tabs: Pending, History, Settings, Reactions.
 * Pending shows card-based countdown requests; History uses DataTable;
 * Settings configures timeout & behavior; Reactions shows emoji-based approvals.
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

type TabId = "pending" | "history" | "settings" | "reactions";

type RiskLevel = "low" | "medium" | "high" | "critical";
type Decision = "approved" | "denied" | "expired" | "pending";
type BehaviorMode = "immediate" | "debounced" | "scheduled";
type TimeoutAction = "fail-closed" | "deny";
type ReactionChannel = "telegram" | "discord" | "slack" | "feishu" | "whatsapp";

interface PendingRequest {
  id: string;
  operation: string;
  description: string;
  target: string;
  requestedAt: number;
  expiresAt: number;
  riskLevel: RiskLevel;
  requester: string;
  channel?: string;
}

interface HistoryEntry {
  id: string;
  timestamp: string;
  operation: string;
  target: string;
  requester: string;
  decision: Decision;
  responseTimeMs: number;
  channel: string;
}

interface ReactionEntry {
  messageId: string;
  channel: ReactionChannel;
  request: string;
  emoji: string;
  user: string;
  decision: Decision;
  timestamp: string;
}

interface ApprovalSettings {
  timeoutMs: number;
  onTimeoutAction: TimeoutAction;
  behaviorMode: BehaviorMode;
  escalationEnabled: boolean;
  escalationTimeoutMs: number;
  debounceWindowMs: number;
  scheduleCron: string;
}

// ── Variant maps ──

const RISK_VARIANT: Record<RiskLevel, BadgeVariant> = {
  low: "default",
  medium: "default",
  high: "warning",
  critical: "error",
};

const DECISION_VARIANT: Record<Decision, BadgeVariant> = {
  approved: "success",
  denied: "error",
  expired: "warning",
  pending: "info",
};

const CHANNEL_LABELS: Record<ReactionChannel, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  feishu: "Feishu",
  whatsapp: "WhatsApp",
};

const CHANNEL_ICONS: Record<ReactionChannel, string> = {
  telegram: "\u{1F4E8}",
  discord: "\u{1F3AE}",
  slack: "\u{1F4AC}",
  feishu: "\u{1F680}",
  whatsapp: "\u{1F4F1}",
};

const APPROVE_EMOJIS = ["\u{1F44D}", "\u2705"]; // 👍 ✅
const DENY_EMOJIS = ["\u{1F44E}", "\u274C"];    // 👎 ❌

// ── Mock data ──

const now = Date.now();

const MOCK_PENDING: PendingRequest[] = [
  {
    id: "apr-001",
    operation: "file_write",
    description: "Write production config file /etc/evoclaw/prod.yaml",
    target: "/etc/evoclaw/prod.yaml",
    requestedAt: now - 120_000,
    expiresAt: now + 180_000,
    riskLevel: "high",
    requester: "agent-planner-01",
    channel: "telegram",
  },
  {
    id: "apr-002",
    operation: "shell_exec",
    description: "Execute database migration script on prod cluster",
    target: "db-prod-01:5432",
    requestedAt: now - 200_000,
    expiresAt: now + 100_000,
    riskLevel: "critical",
    requester: "agent-executor-03",
    channel: "discord",
  },
  {
    id: "apr-003",
    operation: "api_call",
    description: "Delete stale user sessions older than 90 days",
    target: "POST /api/admin/sessions/purge",
    requestedAt: now - 30_000,
    expiresAt: now + 270_000,
    riskLevel: "medium",
    requester: "agent-maintenance-02",
    channel: "slack",
  },
  {
    id: "apr-004",
    operation: "config_change",
    description: "Update LLM model from gpt-4o to claude-3.5-sonnet",
    target: "llm.default_model",
    requestedAt: now - 250_000,
    expiresAt: now + 50_000,
    riskLevel: "high",
    requester: "agent-evolver-01",
    channel: "feishu",
  },
  {
    id: "apr-005",
    operation: "send_message",
    description: "Send notification to #ops channel about deployment",
    target: "#ops (Discord)",
    requestedAt: now - 10_000,
    expiresAt: now + 290_000,
    riskLevel: "low",
    requester: "agent-notifier-01",
  },
];

const MOCK_HISTORY: HistoryEntry[] = [
  { id: "apr-h01", timestamp: new Date(now - 600_000).toISOString(), operation: "file_write", target: "/var/log/evoclaw/debug.log", requester: "agent-logger-01", decision: "approved", responseTimeMs: 3200, channel: "telegram" },
  { id: "apr-h02", timestamp: new Date(now - 1_200_000).toISOString(), operation: "shell_exec", target: "db-staging:5432", requester: "agent-executor-03", decision: "denied", responseTimeMs: 8500, channel: "discord" },
  { id: "apr-h03", timestamp: new Date(now - 1_800_000).toISOString(), operation: "api_call", target: "DELETE /api/users/batch", requester: "agent-cleaner-02", decision: "expired", responseTimeMs: 300_000, channel: "slack" },
  { id: "apr-h04", timestamp: new Date(now - 2_400_000).toISOString(), operation: "config_change", target: "security.max_retries", requester: "agent-tuner-01", decision: "approved", responseTimeMs: 1200, channel: "feishu" },
  { id: "apr-h05", timestamp: new Date(now - 3_000_000).toISOString(), operation: "file_write", target: "/etc/evoclaw/routes.json", requester: "agent-router-01", decision: "approved", responseTimeMs: 5400, channel: "telegram" },
  { id: "apr-h06", timestamp: new Date(now - 3_600_000).toISOString(), operation: "shell_exec", target: "kubectl rollout restart", requester: "agent-deployer-01", decision: "denied", responseTimeMs: 15000, channel: "discord" },
  { id: "apr-h07", timestamp: new Date(now - 4_200_000).toISOString(), operation: "send_message", target: "#alerts (Slack)", requester: "agent-notifier-01", decision: "approved", responseTimeMs: 800, channel: "slack" },
  { id: "apr-h08", timestamp: new Date(now - 4_800_000).toISOString(), operation: "api_call", target: "POST /api/evolution/apply", requester: "agent-evolver-01", decision: "expired", responseTimeMs: 300_000, channel: "feishu" },
];

const MOCK_REACTIONS: ReactionEntry[] = [
  { messageId: "msg-001", channel: "telegram", request: "Deploy v2.3.1 to production", emoji: "\u{1F44D}", user: "admin_alice", decision: "approved", timestamp: new Date(now - 300_000).toISOString() },
  { messageId: "msg-002", channel: "discord", request: "Delete 500 stale sessions", emoji: "\u274C", user: "ops_bob", decision: "denied", timestamp: new Date(now - 600_000).toISOString() },
  { messageId: "msg-003", channel: "slack", request: "Rotate API keys for staging", emoji: "\u2705", user: "dev_charlie", decision: "approved", timestamp: new Date(now - 900_000).toISOString() },
  { messageId: "msg-004", channel: "feishu", request: "Update guardrail severity to high", emoji: "\u{1F44E}", user: "sec_diana", decision: "denied", timestamp: new Date(now - 1_200_000).toISOString() },
  { messageId: "msg-005", channel: "whatsapp", request: "Send incident report to CTO", emoji: "\u{1F44D}", user: "ops_eve", decision: "approved", timestamp: new Date(now - 1_500_000).toISOString() },
  { messageId: "msg-006", channel: "telegram", request: "Reset feature flags cache", emoji: "\u2705", user: "dev_frank", decision: "approved", timestamp: new Date(now - 1_800_000).toISOString() },
];

// ── Helpers ──

function formatCountdown(ms: number): string {
  if (ms <= 0) return "00:00";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatResponseTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ── Component ──

export default function ApprovalCenterPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>("pending");
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [reactions, setReactions] = useState<ReactionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [nowTs, setNowTs] = useState(Date.now());
  const [confirmModal, setConfirmModal] = useState<{ id: string; action: "approve" | "deny" } | null>(null);
  const [historyFilter, setHistoryFilter] = useState<Decision | "all">("all");

  // Settings state
  const [settings, setSettings] = useState<ApprovalSettings>({
    timeoutMs: 300_000,
    onTimeoutAction: "fail-closed",
    behaviorMode: "immediate",
    escalationEnabled: false,
    escalationTimeoutMs: 600_000,
    debounceWindowMs: 5000,
    scheduleCron: "0 */5 * * *",
  });

  // ── Data loading ──

  const loadData = useCallback(async () => {
    try {
      const [pendRes, histRes, reactRes, settRes] = await Promise.allSettled([
        fetch(`${API}/api/approval/pending`),
        fetch(`${API}/api/approval/history?limit=100`),
        fetch(`${API}/api/approval/reactions?limit=100`),
        fetch(`${API}/api/approval/settings`),
      ]);

      if (pendRes.status === "fulfilled" && pendRes.value.ok) {
        const d = await pendRes.value.json();
        if (d.requests?.length) setPending(d.requests);
      }
      if (histRes.status === "fulfilled" && histRes.value.ok) {
        const d = await histRes.value.json();
        if (d.history?.length) setHistory(d.history);
      }
      if (reactRes.status === "fulfilled" && reactRes.value.ok) {
        const d = await reactRes.value.json();
        if (d.reactions?.length) setReactions(d.reactions);
      }
      if (settRes.status === "fulfilled" && settRes.value.ok) {
        const d = await settRes.value.json();
        if (d.settings) setSettings(d.settings);
      }
    } catch {
      // silent — mock data will be used
    }
    setLoading(false);
  }, []);

  // Initial load + fallback to mock
  useEffect(() => {
    loadData().then(() => {
      setPending(prev => prev.length === 0 ? MOCK_PENDING : prev);
      setHistory(prev => prev.length === 0 ? MOCK_HISTORY : prev);
      setReactions(prev => prev.length === 0 ? MOCK_REACTIONS : prev);
    });
  }, [loadData]);

  // Auto-refresh every 10s for pending tab (time-sensitive)
  useEffect(() => {
    if (tab !== "pending") return;
    const interval = setInterval(loadData, 10_000);
    return () => clearInterval(interval);
  }, [tab, loadData]);

  // Countdown timer — tick every second
  useEffect(() => {
    const interval = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // ── Actions ──

  const handleApprove = async (id: string) => {
    try {
      await fetch(`${API}/api/approval/${id}/approve`, { method: "POST" });
      showToast(t("approval.approved", "Request approved"), "success");
      setPending(prev => prev.filter(r => r.id !== id));
    } catch {
      showToast(t("approval.approve_failed", "Failed to approve"), "error");
    }
    setConfirmModal(null);
  };

  const handleDeny = async (id: string) => {
    try {
      await fetch(`${API}/api/approval/${id}/deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: t("approval.denied_from_webui", "Denied from Web UI") }),
      });
      showToast(t("approval.denied", "Request denied"), "info");
      setPending(prev => prev.filter(r => r.id !== id));
    } catch {
      showToast(t("approval.deny_failed", "Failed to deny"), "error");
    }
    setConfirmModal(null);
  };

  const handleSaveSettings = async () => {
    try {
      await fetch(`${API}/api/approval/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      showToast(t("approval.settings_saved", "Settings saved"), "success");
    } catch {
      showToast(t("approval.settings_save_failed", "Failed to save settings"), "error");
    }
  };

  // ── Computed ──

  const filteredHistory = historyFilter === "all"
    ? history
    : history.filter(h => h.decision === historyFilter);

  const totalRequests = history.length + pending.length;
  const approvedCount = history.filter(h => h.decision === "approved").length;
  const approvalRate = totalRequests > 0 ? Math.round((approvedCount / totalRequests) * 100) : 0;
  const avgResponseTime = history.length > 0
    ? Math.round(history.reduce((sum, h) => sum + h.responseTimeMs, 0) / history.length)
    : 0;
  const timeoutRate = history.length > 0
    ? Math.round((history.filter(h => h.decision === "expired").length / history.length) * 100)
    : 0;

  // ── Tab definitions ──

  const tabs: { id: TabId; label: string; badge?: number }[] = [
    { id: "pending", label: t("approval.pending", "Pending"), badge: pending.length },
    { id: "history", label: t("approval.history", "History") },
    { id: "settings", label: t("approval.settings", "Settings") },
    { id: "reactions", label: t("approval.reactions", "Reactions") },
  ];

  if (loading) return <Loading />;

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <PageHeader
        title={t("approval.title", "\u{1F6E1}\uFE0F Approval Center")}
        subtitle={t("approval.subtitle", "Approval Timeout Manager & Reaction Approval Handler")}
        actions={
          <SecondaryButton onClick={loadData}>
            {t("approval.refresh", "Refresh")}
          </SecondaryButton>
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
              display: "flex", alignItems: "center", gap: 6,
            }}>
            {tb.label}
            {tb.badge !== undefined && tb.badge > 0 && (
              <span style={{
                background: tab === tb.id ? "rgba(255,255,255,0.25)" : "var(--accent-bg)",
                color: tab === tb.id ? "#fff" : "var(--accent)",
                padding: "1px 7px", borderRadius: 10, fontSize: 11, fontWeight: 700,
              }}>
                {tb.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Pending Tab ── */}
      {tab === "pending" && (
        <div>
          {pending.length === 0 ? (
            <EmptyState
              icon="\u2705"
              title={t("approval.no_pending", "No Pending Requests")}
              description={t("approval.no_pending_desc", "All approval requests have been resolved.")}
            />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))", gap: 16 }}>
              {pending.map(req => {
                const remaining = req.expiresAt - nowTs;
                const isUrgent = remaining < 60_000;
                const isExpired = remaining <= 0;
                return (
                  <Card key={req.id} style={{
                    borderLeft: `3px solid ${
                      req.riskLevel === "critical" ? "var(--error)" :
                      req.riskLevel === "high" ? "var(--warning)" :
                      "var(--border)"
                    }`,
                  }}>
                    {/* Header row */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <code style={{ fontSize: 11, color: "var(--accent)" }}>{req.id}</code>
                          <Badge variant={RISK_VARIANT[req.riskLevel]}>{req.riskLevel}</Badge>
                        </div>
                        <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>{req.operation}</div>
                      </div>
                      <div style={{
                        textAlign: "right",
                        color: isExpired ? "var(--error)" : isUrgent ? "var(--error)" : "var(--text-secondary)",
                        fontWeight: 700,
                        fontSize: 18,
                        fontFamily: "monospace",
                        animation: isUrgent && !isExpired ? "EvoClaw-pulse 1s ease-in-out infinite" : undefined,
                      }}>
                        {isExpired ? t("approval.expired", "EXPIRED") : formatCountdown(remaining)}
                      </div>
                    </div>

                    {/* Description */}
                    <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>
                      {req.description}
                    </div>

                    {/* Details grid */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px", fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                      <div><strong>Target:</strong> <code style={{ fontSize: 11 }}>{req.target.length > 35 ? req.target.slice(0, 35) + "\u2026" : req.target}</code></div>
                      <div><strong>Requester:</strong> {req.requester}</div>
                      <div><strong>Requested:</strong> {new Date(req.requestedAt).toLocaleTimeString()}</div>
                      <div><strong>Channel:</strong> {req.channel || "Web UI"}</div>
                    </div>

                    {/* Action buttons */}
                    {!isExpired && (
                      <div style={{ display: "flex", gap: 8 }}>
                        <PrimaryButton small onClick={() => setConfirmModal({ id: req.id, action: "approve" })}
                          style={{ background: "var(--success)", flex: 1 }}>
                          {t("approval.approve", "Approve")}
                        </PrimaryButton>
                        <PrimaryButton small danger onClick={() => setConfirmModal({ id: req.id, action: "deny" })}
                          style={{ flex: 1 }}>
                          {t("approval.deny", "Deny")}
                        </PrimaryButton>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── History Tab ── */}
      {tab === "history" && (
        <div>
          {/* Filter bar */}
          <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
            {(["all", "approved", "denied", "expired"] as const).map(f => (
              <button key={f} onClick={() => setHistoryFilter(f)}
                style={{
                  padding: "5px 12px", border: "1px solid " + (historyFilter === f ? "var(--accent)" : "var(--border)"),
                  borderRadius: 6, cursor: "pointer",
                  background: historyFilter === f ? "var(--accent-bg)" : "transparent",
                  color: historyFilter === f ? "var(--accent)" : "var(--text-muted)",
                  fontWeight: 600, fontSize: 12,
                }}>
                {f === "all" ? t("approval.all", "All") : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          <Card>
            <DataTable
              columns={[
                { key: "timestamp", label: t("approval.timestamp", "Timestamp"), width: "160px", render: (h: HistoryEntry) => formatTimestamp(h.timestamp) },
                { key: "operation", label: t("approval.operation", "Operation"), render: (h: HistoryEntry) => <code style={{ fontSize: 11 }}>{h.operation}</code> },
                { key: "target", label: t("approval.target", "Target"), render: (h: HistoryEntry) => (
                  <span style={{ fontSize: 12 }}>{h.target.length > 30 ? h.target.slice(0, 30) + "\u2026" : h.target}</span>
                )},
                { key: "requester", label: t("approval.requester", "Requester") },
                { key: "decision", label: t("approval.decision", "Decision"), render: (h: HistoryEntry) => (
                  <Badge variant={DECISION_VARIANT[h.decision]}>{h.decision}</Badge>
                )},
                { key: "responseTime", label: t("approval.response_time", "Response Time"), render: (h: HistoryEntry) => formatResponseTime(h.responseTimeMs) },
                { key: "channel", label: t("approval.channel", "Channel"), render: (h: HistoryEntry) => (
                  <span style={{ fontSize: 12, textTransform: "capitalize" }}>{h.channel}</span>
                )},
              ]}
              data={filteredHistory}
              keyFn={(h: HistoryEntry) => h.id}
              emptyText={t("approval.no_history", "No approval history")}
            />
          </Card>
        </div>
      )}

      {/* ── Settings Tab ── */}
      {tab === "settings" && (
        <div>
          {/* Stats overview */}
          <Section title={t("approval.current_stats", "Current Statistics")}>
            <StatsGrid items={[
              { label: t("approval.total_requests", "Total Requests"), value: totalRequests },
              { label: t("approval.approval_rate", "Approval Rate"), value: `${approvalRate}%`, color: approvalRate >= 80 ? "var(--success)" : "var(--warning)" },
              { label: t("approval.avg_response_time", "Avg Response Time"), value: formatResponseTime(avgResponseTime) },
              { label: t("approval.timeout_rate", "Timeout Rate"), value: `${timeoutRate}%`, color: timeoutRate > 20 ? "var(--error)" : "var(--success)" },
            ]} />
          </Section>

          {/* Timeout configuration */}
          <Card title={t("approval.timeout_config", "Timeout Configuration")} style={{ marginBottom: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4, fontWeight: 600 }}>
                  {t("approval.default_timeout", "Default Timeout (seconds)")}
                </label>
                <input type="number" value={Math.round(settings.timeoutMs / 1000)}
                  onChange={e => setSettings(s => ({ ...s, timeoutMs: (parseInt(e.target.value) || 300) * 1000 }))}
                  style={{
                    padding: "8px 12px", borderRadius: 8, border: "1px solid var(--input-border)",
                    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 13,
                    width: "100%", boxSizing: "border-box", outline: "none",
                  }} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4, fontWeight: 600 }}>
                  {t("approval.on_timeout", "Action on Timeout")}
                </label>
                <select value={settings.onTimeoutAction}
                  onChange={e => setSettings(s => ({ ...s, onTimeoutAction: e.target.value as TimeoutAction }))}
                  style={{
                    padding: "8px 12px", borderRadius: 8, border: "1px solid var(--input-border)",
                    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 13,
                    width: "100%", boxSizing: "border-box", outline: "none",
                  }}>
                  <option value="fail-closed">{t("approval.fail_closed", "Fail-Closed (deny & log)")}</option>
                  <option value="deny">{t("approval.deny_silent", "Deny (silent)")}</option>
                </select>
              </div>
            </div>
          </Card>

          {/* Behavior mode */}
          <Card title={t("approval.behavior_mode", "Behavior Mode")} style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              {(["immediate", "debounced", "scheduled"] as BehaviorMode[]).map(mode => (
                <button key={mode} onClick={() => setSettings(s => ({ ...s, behaviorMode: mode }))}
                  style={{
                    padding: "8px 16px", border: "1px solid " + (settings.behaviorMode === mode ? "var(--accent)" : "var(--border)"),
                    borderRadius: 6, cursor: "pointer",
                    background: settings.behaviorMode === mode ? "var(--accent-bg)" : "transparent",
                    color: settings.behaviorMode === mode ? "var(--accent)" : "var(--text-muted)",
                    fontWeight: 600, fontSize: 12,
                  }}>
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {settings.behaviorMode === "immediate" && t("approval.mode_immediate_desc", "Approvals are processed immediately upon receipt.")}
              {settings.behaviorMode === "debounced" && t("approval.mode_debounced_desc", "Approvals are batched within a debounce window to reduce noise.")}
              {settings.behaviorMode === "scheduled" && t("approval.mode_scheduled_desc", "Approvals are processed on a fixed schedule (cron).")}
            </div>
            {settings.behaviorMode === "debounced" && (
              <div style={{ marginTop: 12 }}>
                <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4, fontWeight: 600 }}>
                  {t("approval.debounce_window", "Debounce Window (seconds)")}
                </label>
                <input type="number" value={Math.round(settings.debounceWindowMs / 1000)}
                  onChange={e => setSettings(s => ({ ...s, debounceWindowMs: (parseInt(e.target.value) || 5) * 1000 }))}
                  style={{
                    padding: "8px 12px", borderRadius: 8, border: "1px solid var(--input-border)",
                    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 13,
                    width: 200, outline: "none",
                  }} />
              </div>
            )}
            {settings.behaviorMode === "scheduled" && (
              <div style={{ marginTop: 12 }}>
                <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4, fontWeight: 600 }}>
                  {t("approval.schedule_cron", "Schedule (cron)")}
                </label>
                <input type="text" value={settings.scheduleCron}
                  onChange={e => setSettings(s => ({ ...s, scheduleCron: e.target.value }))}
                  placeholder="0 */5 * * *"
                  style={{
                    padding: "8px 12px", borderRadius: 8, border: "1px solid var(--input-border)",
                    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 13,
                    fontFamily: "monospace", width: 200, outline: "none",
                  }} />
              </div>
            )}
          </Card>

          {/* Escalation */}
          <Card title={t("approval.escalation", "Escalation Settings")} style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{t("approval.escalation_enabled", "Enable Escalation")}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {t("approval.escalation_desc", "Escalate unhandled requests to higher-level approvers after timeout.")}
                </div>
              </div>
              <Toggle checked={settings.escalationEnabled}
                onChange={v => setSettings(s => ({ ...s, escalationEnabled: v }))} />
            </div>
            {settings.escalationEnabled && (
              <div>
                <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4, fontWeight: 600 }}>
                  {t("approval.escalation_timeout", "Escalation Timeout (seconds)")}
                </label>
                <input type="number" value={Math.round(settings.escalationTimeoutMs / 1000)}
                  onChange={e => setSettings(s => ({ ...s, escalationTimeoutMs: (parseInt(e.target.value) || 600) * 1000 }))}
                  style={{
                    padding: "8px 12px", borderRadius: 8, border: "1px solid var(--input-border)",
                    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 13,
                    width: 200, outline: "none",
                  }} />
              </div>
            )}
          </Card>

          <div style={{ display: "flex", gap: 8 }}>
            <PrimaryButton onClick={handleSaveSettings}>
              {t("approval.save_settings", "Save Settings")}
            </PrimaryButton>
            <SecondaryButton onClick={loadData}>
              {t("approval.reset", "Reset")}
            </SecondaryButton>
          </div>
        </div>
      )}

      {/* ── Reactions Tab ── */}
      {tab === "reactions" && (
        <div>
          {/* Supported channels & emoji mappings */}
          <Card title={t("approval.supported_channels", "Supported Channels & Emoji Mappings")} style={{ marginBottom: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
              {(Object.keys(CHANNEL_LABELS) as ReactionChannel[]).map(ch => (
                <div key={ch} style={{
                  padding: "12px 14px", borderRadius: 8,
                  background: "var(--bg-secondary)", border: "1px solid var(--border-light)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 18 }}>{CHANNEL_ICONS[ch]}</span>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{CHANNEL_LABELS[ch]}</span>
                  </div>
                  <div style={{ display: "flex", gap: 12, fontSize: 12 }}>
                    <span>
                      {APPROVE_EMOJIS.map(e => <span key={e} style={{ marginRight: 2 }}>{e}</span>)} = <span style={{ color: "var(--success)", fontWeight: 600 }}>Approve</span>
                    </span>
                    <span>
                      {DENY_EMOJIS.map(e => <span key={e} style={{ marginRight: 2 }}>{e}</span>)} = <span style={{ color: "var(--error)", fontWeight: 600 }}>Deny</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Reactions table */}
          <Card title={t("approval.reaction_log", "Reaction Approval Log")}>
            <DataTable
              columns={[
                { key: "messageId", label: t("approval.message_id", "Message ID"), width: "100px", render: (r: ReactionEntry) => (
                  <code style={{ fontSize: 11 }}>{r.messageId}</code>
                )},
                { key: "channel", label: t("approval.channel", "Channel"), width: "100px", render: (r: ReactionEntry) => (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                    {CHANNEL_ICONS[r.channel]} {CHANNEL_LABELS[r.channel]}
                  </span>
                )},
                { key: "request", label: t("approval.request", "Request"), render: (r: ReactionEntry) => (
                  <span style={{ fontSize: 12 }}>{r.request.length > 40 ? r.request.slice(0, 40) + "\u2026" : r.request}</span>
                )},
                { key: "emoji", label: t("approval.emoji", "Emoji"), width: "60px", render: (r: ReactionEntry) => (
                  <span style={{ fontSize: 16 }}>{r.emoji}</span>
                )},
                { key: "user", label: t("approval.user", "User"), render: (r: ReactionEntry) => (
                  <code style={{ fontSize: 11 }}>{r.user}</code>
                )},
                { key: "decision", label: t("approval.decision", "Decision"), width: "100px", render: (r: ReactionEntry) => (
                  <Badge variant={DECISION_VARIANT[r.decision]}>{r.decision}</Badge>
                )},
                { key: "timestamp", label: t("approval.timestamp", "Timestamp"), width: "140px", render: (r: ReactionEntry) => formatTimestamp(r.timestamp) },
              ]}
              data={reactions}
              keyFn={(r: ReactionEntry, i: number) => `${r.messageId}-${i}`}
              emptyText={t("approval.no_reactions", "No reaction approvals recorded")}
            />
          </Card>
        </div>
      )}

      {/* ── Confirm Modal ── */}
      {confirmModal && (
        <Modal
          title={confirmModal.action === "approve"
            ? t("approval.confirm_approve", "Confirm Approval")
            : t("approval.confirm_deny", "Confirm Denial")}
          onClose={() => setConfirmModal(null)}
          footer={
            <>
              <SecondaryButton onClick={() => setConfirmModal(null)}>
                {t("approval.cancel", "Cancel")}
              </SecondaryButton>
              <PrimaryButton
                danger={confirmModal.action === "deny"}
                onClick={() => confirmModal.action === "approve"
                  ? handleApprove(confirmModal.id)
                  : handleDeny(confirmModal.id)}
              >
                {confirmModal.action === "approve"
                  ? t("approval.approve", "Approve")
                  : t("approval.deny", "Deny")}
              </PrimaryButton>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 14, lineHeight: 1.6 }}>
            {confirmModal.action === "approve"
              ? t("approval.confirm_approve_msg", "Are you sure you want to approve this request? The operation will be executed immediately.")
              : t("approval.confirm_deny_msg", "Are you sure you want to deny this request? The operation will be blocked.")}
          </p>
          <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: "var(--bg-secondary)", fontSize: 12 }}>
            <strong>Request ID:</strong> <code>{confirmModal.id}</code>
          </div>
        </Modal>
      )}
    </div>
  );
}
