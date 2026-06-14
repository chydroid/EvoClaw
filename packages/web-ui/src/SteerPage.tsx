/**
 * SteerPage — Comprehensive steer command dashboard.
 *
 * Features: Session selector, instruction form, priority selector,
 * result display, instruction history, quick templates, category reference.
 */
import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, EmptyState,
  PrimaryButton, SecondaryButton, GhostButton, showToast, Section,
} from "./shared";
import type { BadgeVariant } from "./shared";
import { useTranslation } from "./i18n";

const API = (window as any).__EVOCLAW_API__ || "";

// ── Types ──

interface Session {
  id: string;
  agentId: string;
  createdAt: string;
  messageCount: number;
  lastActivity: string;
}

interface SteerResult {
  accepted: boolean;
  message?: string;
  pendingCount?: number;
}

interface HistoryEntry {
  id: number;
  timestamp: string;
  sessionId: string;
  instruction: string;
  priority: string;
  result: SteerResult;
}

interface QuickTemplate {
  key: string;
  category: string;
  instruction: string;
  icon: string;
}

// ── Constants ──

const PRIORITY_CONFIG: Record<string, { variant: BadgeVariant; color: string; icon: string }> = {
  low: { variant: "default", color: "var(--text-muted)", icon: "▽" },
  normal: { variant: "info", color: "var(--accent)", icon: "●" },
  high: { variant: "warning", color: "var(--warning)", icon: "▲" },
  critical: { variant: "error", color: "var(--error)", icon: "⚡" },
};

const QUICK_TEMPLATES: QuickTemplate[] = [
  { key: "quality", category: "constraint", instruction: "Focus on code quality — ensure clean, maintainable, well-tested code", icon: "🎯" },
  { key: "analysis", category: "redirect", instruction: "Switch to analysis mode — provide detailed analysis rather than implementation", icon: "🔄" },
  { key: "security", category: "emphasis", instruction: "Prioritize security — review for vulnerabilities, injection risks, and data exposure", icon: "🔒" },
  { key: "cancel", category: "cancel", instruction: "Cancel current operation — stop what you are doing and wait for new instructions", icon: "⛔" },
  { key: "context", category: "info", instruction: "Additional context: ", icon: "ℹ️" },
];

const CATEGORIES = [
  { key: "redirect", icon: "🔄" },
  { key: "constraint", icon: "⚠️" },
  { key: "emphasis", icon: "🔵" },
  { key: "cancel", icon: "⛔" },
  { key: "info", icon: "ℹ️" },
] as const;

let historyIdCounter = 0;

// Map API session to local Session type
function mapSession(raw: any): Session {
  return {
    id: raw.sessionId || raw.id || "",
    agentId: raw.agentId || "",
    createdAt: raw.createdAt || "",
    messageCount: raw.turnCount || raw.messageCount || 0,
    lastActivity: raw.updatedAt || raw.lastActivity || "",
  };
}

// ── Styles ──

const styles = {
  container: {
    padding: 24,
    maxWidth: 1200,
    margin: "0 auto",
  } as React.CSSProperties,
  twoCol: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 20,
  } as React.CSSProperties,
  formGroup: {
    marginBottom: 16,
  } as React.CSSProperties,
  label: {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.3px",
    marginBottom: 6,
  } as React.CSSProperties,
  select: {
    width: "100%",
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid var(--input-border)",
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box" as const,
  } as React.CSSProperties,
  textarea: {
    width: "100%",
    minHeight: 100,
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--input-border)",
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    fontSize: 13,
    fontFamily: "inherit",
    resize: "vertical" as const,
    outline: "none",
    boxSizing: "border-box" as const,
  } as React.CSSProperties,
  priorityRow: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap" as const,
  } as React.CSSProperties,
  priorityBtn: (active: boolean, color: string): React.CSSProperties => ({
    padding: "6px 14px",
    borderRadius: 6,
    border: active ? `2px solid ${color}` : "1px solid var(--border)",
    background: active ? `${color}20` : "transparent",
    color: active ? color : "var(--text-secondary)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    transition: "all 0.15s",
  }),
  resultBox: (success: boolean): React.CSSProperties => ({
    marginTop: 16,
    padding: "14px 18px",
    borderRadius: 8,
    background: success ? "var(--success-bg)" : "var(--error-bg)",
    border: `1px solid ${success ? "var(--success)" : "var(--error)"}40`,
    color: success ? "var(--success)" : "var(--error)",
  }),
  resultTitle: {
    fontWeight: 600,
    fontSize: 14,
  } as React.CSSProperties,
  resultMessage: {
    fontSize: 13,
    marginTop: 4,
    opacity: 0.9,
  } as React.CSSProperties,
  resultPending: {
    fontSize: 12,
    marginTop: 4,
    opacity: 0.7,
  } as React.CSSProperties,
  historyEntry: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 0",
    borderBottom: "1px solid var(--border-light)",
  } as React.CSSProperties,
  historyMeta: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap" as const,
    marginBottom: 4,
  } as React.CSSProperties,
  historyTime: {
    fontSize: 11,
    color: "var(--text-muted)",
  } as React.CSSProperties,
  historyInstruction: {
    fontSize: 13,
    color: "var(--text-primary)",
    lineHeight: 1.4,
    wordBreak: "break-word" as const,
  } as React.CSSProperties,
  templateGrid: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  } as React.CSSProperties,
  templateBtn: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg-hover)",
    cursor: "pointer",
    textAlign: "left" as const,
    transition: "border-color 0.15s, background 0.15s",
  } as React.CSSProperties,
  templateIcon: {
    fontSize: 18,
    flexShrink: 0,
  } as React.CSSProperties,
  templateContent: {
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  templateLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    marginBottom: 2,
  } as React.CSSProperties,
  templateInstruction: {
    fontSize: 11,
    color: "var(--text-muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  catCard: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 0",
  } as React.CSSProperties,
  catIcon: {
    fontSize: 18,
    flexShrink: 0,
  } as React.CSSProperties,
  catName: {
    fontWeight: 600,
    fontSize: 13,
    color: "var(--text-primary)",
    minWidth: 60,
  } as React.CSSProperties,
  catDesc: {
    fontSize: 12,
    color: "var(--text-muted)",
  } as React.CSSProperties,
  sessionInfoGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
  } as React.CSSProperties,
  sessionInfoItem: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 2,
  } as React.CSSProperties,
  sessionInfoLabel: {
    fontSize: 10,
    textTransform: "uppercase" as const,
    letterSpacing: "0.3px",
    color: "var(--text-muted)",
    fontWeight: 600,
  } as React.CSSProperties,
  sessionInfoValue: {
    fontSize: 13,
    color: "var(--text-primary)",
    fontFamily: "monospace",
    wordBreak: "break-all" as const,
  } as React.CSSProperties,
  historyHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  } as React.CSSProperties,
  historyHeaderTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text-primary)",
    margin: 0,
  } as React.CSSProperties,
  formActions: {
    display: "flex",
    gap: 8,
    marginTop: 4,
  } as React.CSSProperties,
};

// ── Component ──

export default function SteerPage() {
  const { t, lang } = useTranslation();

  // Form state
  const [sessionId, setSessionId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [priority, setPriority] = useState("normal");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SteerResult | null>(null);

  // Sessions state
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [manualSessionId, setManualSessionId] = useState(false);

  // History state
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const res = await fetch(`${API}/api/sessions`);
      if (!res.ok) { setSessions([]); setSessionsLoading(false); return; }
      const data = await res.json();
      const raw = Array.isArray(data) ? data : data?.sessions || [];
      setSessions(raw.map(mapSession));
    } catch {
      setSessions([]);
    }
    setSessionsLoading(false);
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  // Find selected session
  const selectedSession = sessions.find(s => s.id === sessionId) || null;

  // Handle steer submit
  const handleSteer = async () => {
    if (!sessionId) {
      showToast(t("steer.no_session_selected"), "error");
      return;
    }
    if (!instruction.trim()) {
      showToast(t("steer.instruction_required"), "error");
      return;
    }

    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch(`${API}/api/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, instruction: instruction.trim(), priority }),
      });
      const data: SteerResult = await res.json();
      setResult(data);

      // Add to history
      const entry: HistoryEntry = {
        id: ++historyIdCounter,
        timestamp: new Date().toISOString(),
        sessionId,
        instruction: instruction.trim(),
        priority,
        result: data,
      };
      setHistory(prev => [entry, ...prev].slice(0, 10));

      if (data.accepted) {
        showToast(t("steer.inject_success"), "success");
        setInstruction("");
      } else {
        showToast(t("steer.inject_fail"), "error");
      }
    } catch (err) {
      const failResult: SteerResult = {
        accepted: false,
        message: err instanceof Error ? err.message : String(err),
      };
      setResult(failResult);

      const entry: HistoryEntry = {
        id: ++historyIdCounter,
        timestamp: new Date().toISOString(),
        sessionId,
        instruction: instruction.trim(),
        priority,
        result: failResult,
      };
      setHistory(prev => [entry, ...prev].slice(0, 10));
      showToast(t("steer.inject_fail"), "error");
    }
    setSubmitting(false);
  };

  // Apply template
  const applyTemplate = (template: QuickTemplate) => {
    setInstruction(template.instruction);
  };

  // Format time
  const formatTime = (iso: string) => {
    return new Date(iso).toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      month: "short",
      day: "numeric",
    });
  };

  const formatRelative = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return lang === "zh" ? "刚刚" : "just now";
    if (mins < 60) return lang === "zh" ? `${mins} 分钟前` : `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return lang === "zh" ? `${hours} 小时前` : `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return lang === "zh" ? `${days} 天前` : `${days}d ago`;
  };

  // Short session ID display
  const shortId = (id: string) => (id && id.length > 12) ? id.slice(0, 8) + "..." : (id || "");

  if (sessionsLoading) return <Loading text={t("steer.session_loading")} />;

  return (
    <div style={styles.container}>
      <PageHeader
        title={t("steer.title")}
        subtitle={t("steer.subtitle")}
        actions={
          <SecondaryButton onClick={fetchSessions} small>
            🔄 {t("steer.refresh_sessions")}
          </SecondaryButton>
        }
      />

      <div style={styles.twoCol}>
        {/* ── Left Column: Steer Form ── */}
        <div>
          <Card>
            {/* Session Selector */}
            <div style={styles.formGroup}>
              <label style={styles.label}>{t("steer.session_label")}</label>
              {sessions.length > 0 ? (
                <select
                  value={manualSessionId ? "__manual__" : sessionId}
                  onChange={e => {
                    if (e.target.value === "__manual__") {
                      setManualSessionId(true);
                      setSessionId("");
                    } else {
                      setManualSessionId(false);
                      setSessionId(e.target.value);
                    }
                  }}
                  style={styles.select}
                >
                  <option value="">{t("steer.session_placeholder")}</option>
                  {sessions.map(s => (
                    <option key={s.id} value={s.id}>
                      {shortId(s.id)} — {s.agentId || "agent"} ({s.messageCount} msgs, {formatRelative(s.lastActivity)})
                    </option>
                  ))}
                  <option value="__manual__">{t("steer.session_manual")}</option>
                </select>
              ) : (
                <div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
                    {t("steer.session_empty")}
                  </div>
                  <input
                    value={sessionId}
                    onChange={e => setSessionId(e.target.value)}
                    placeholder={t("steer.session_manual_placeholder")}
                    style={{
                      ...styles.select,
                      fontFamily: "monospace",
                    }}
                  />
                </div>
              )}
              {manualSessionId && (
                <input
                  value={sessionId}
                  onChange={e => setSessionId(e.target.value)}
                  placeholder={t("steer.session_manual_placeholder")}
                  style={{
                    ...styles.select,
                    fontFamily: "monospace",
                    marginTop: 8,
                  }}
                />
              )}
            </div>

            {/* Current Session Info */}
            {selectedSession && (
              <div style={{ ...styles.formGroup, padding: "10px 14px", background: "var(--bg-secondary)", borderRadius: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.3px", marginBottom: 8 }}>
                  {t("steer.session_info_title")}
                </div>
                <div style={styles.sessionInfoGrid}>
                  <div style={styles.sessionInfoItem}>
                    <span style={styles.sessionInfoLabel}>{t("steer.session_id")}</span>
                    <span style={styles.sessionInfoValue}>{shortId(selectedSession.id)}</span>
                  </div>
                  <div style={styles.sessionInfoItem}>
                    <span style={styles.sessionInfoLabel}>{t("steer.session_agent")}</span>
                    <span style={styles.sessionInfoValue}>{selectedSession.agentId || "-"}</span>
                  </div>
                  <div style={styles.sessionInfoItem}>
                    <span style={styles.sessionInfoLabel}>{t("steer.session_messages")}</span>
                    <span style={styles.sessionInfoValue}>{selectedSession.messageCount}</span>
                  </div>
                  <div style={styles.sessionInfoItem}>
                    <span style={styles.sessionInfoLabel}>{t("steer.session_last_activity")}</span>
                    <span style={styles.sessionInfoValue}>{formatRelative(selectedSession.lastActivity)}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Instruction Textarea */}
            <div style={styles.formGroup}>
              <label style={styles.label}>{t("steer.instruction_label")}</label>
              <textarea
                value={instruction}
                onChange={e => setInstruction(e.target.value)}
                placeholder={t("steer.instruction_placeholder")}
                rows={4}
                style={styles.textarea}
              />
            </div>

            {/* Priority Selector */}
            <div style={styles.formGroup}>
              <label style={styles.label}>{t("steer.priority_label")}</label>
              <div style={styles.priorityRow}>
                {(["low", "normal", "high", "critical"] as const).map(p => {
                  const cfg = PRIORITY_CONFIG[p];
                  const active = priority === p;
                  return (
                    <button
                      key={p}
                      onClick={() => setPriority(p)}
                      style={styles.priorityBtn(active, cfg.color)}
                    >
                      {cfg.icon} {t(`steer.priority_${p}`)}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Submit */}
            <div style={styles.formActions}>
              <PrimaryButton
                onClick={handleSteer}
                disabled={submitting || !sessionId || !instruction.trim()}
              >
                {submitting ? t("steer.submitting") : t("steer.submit")}
              </PrimaryButton>
              <SecondaryButton
                onClick={() => { setInstruction(""); setResult(null); }}
                disabled={submitting}
              >
                {t("steer.history_clear")}
              </SecondaryButton>
            </div>
          </Card>

          {/* Result Display */}
          {result && (
            <div style={styles.resultBox(result.accepted)}>
              <div style={styles.resultTitle}>
                {result.accepted ? t("steer.result_success") : t("steer.result_fail")}
              </div>
              {result.message && (
                <div style={styles.resultMessage}>{result.message}</div>
              )}
              {result.pendingCount !== undefined && (
                <div style={styles.resultPending}>
                  {t("steer.pending_count").replace("{0}", String(result.pendingCount))}
                </div>
              )}
            </div>
          )}

          {/* Quick Templates */}
          <Section title={t("steer.templates_title")} style={{ marginTop: 20 }}>
            <Card>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                {t("steer.templates_desc")}
              </div>
              <div style={styles.templateGrid}>
                {QUICK_TEMPLATES.map(template => (
                  <button
                    key={template.key}
                    onClick={() => applyTemplate(template)}
                    style={styles.templateBtn}
                    onMouseEnter={e => {
                      e.currentTarget.style.borderColor = "var(--accent)";
                      e.currentTarget.style.background = "var(--accent-bg)";
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.borderColor = "var(--border)";
                      e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                  >
                    <span style={styles.templateIcon}>{template.icon}</span>
                    <div style={styles.templateContent}>
                      <div style={styles.templateLabel}>{t(`steer.template.${template.key}`)}</div>
                      <div style={styles.templateInstruction}>{template.instruction}</div>
                    </div>
                    <Badge variant={template.category === "cancel" ? "error" : template.category === "constraint" ? "warning" : template.category === "emphasis" ? "info" : "default"}>
                      {t(`steer.cat_${template.category}`)}
                    </Badge>
                  </button>
                ))}
              </div>
            </Card>
          </Section>
        </div>

        {/* ── Right Column: History + Categories ── */}
        <div>
          {/* Instruction History */}
          <Section title={t("steer.history_title")}>
            <Card>
              {history.length === 0 ? (
                <EmptyState
                  title={t("steer.history_empty")}
                />
              ) : (
                <>
                  <div style={styles.historyHeader}>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {history.length}/10
                    </span>
                    <GhostButton onClick={() => setHistory([])} small>
                      {t("steer.history_clear")}
                    </GhostButton>
                  </div>
                  {history.map(entry => {
                    const pCfg = PRIORITY_CONFIG[entry.priority] || PRIORITY_CONFIG.normal;
                    return (
                      <div key={entry.id} style={styles.historyEntry}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={styles.historyMeta}>
                            <span style={styles.historyTime}>{formatTime(entry.timestamp)}</span>
                            <Badge variant={pCfg.variant}>
                              {pCfg.icon} {t(`steer.priority_${entry.priority}`)}
                            </Badge>
                            <Badge variant={entry.result.accepted ? "success" : "error"}>
                              {entry.result.accepted ? "✓" : "✗"}
                            </Badge>
                            <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace" }}>
                              {shortId(entry.sessionId)}
                            </span>
                          </div>
                          <div style={styles.historyInstruction}>{entry.instruction}</div>
                          {entry.result.message && (
                            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                              {entry.result.message}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </Card>
          </Section>

          {/* Category Reference */}
          <Section title={t("steer.categories_title")} style={{ marginTop: 20 }}>
            <Card>
              {CATEGORIES.map(cat => (
                <div key={cat.key} style={styles.catCard}>
                  <span style={styles.catIcon}>{cat.icon}</span>
                  <span style={styles.catName}>{t(`steer.cat_${cat.key}`)}</span>
                  <span style={styles.catDesc}>— {t(`steer.cat_${cat.key}_desc`)}</span>
                </div>
              ))}
            </Card>
          </Section>
        </div>
      </div>
    </div>
  );
}
