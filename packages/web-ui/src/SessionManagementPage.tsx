import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Card, PageHeader, Loading, ErrorBanner, Section,
  PrimaryButton, SecondaryButton, Toggle, StatsGrid, showToast,
} from "./shared";
import { retentionApi, chatApi, type RetentionPolicy, type RetentionStats, type ChatSession } from "./api-client";
import { useTranslation } from "./i18n";

const s = {
  container: { padding: "20px", overflow: "auto", height: "100%" } as React.CSSProperties,
  policyGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "16px",
    marginBottom: "16px",
  } as React.CSSProperties,
  inputGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  } as React.CSSProperties,
  label: {
    fontSize: "12px",
    fontWeight: 600,
    color: "var(--text-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.3px",
  } as React.CSSProperties,
  input: {
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1px solid var(--input-border)",
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    fontSize: "13px",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  } as React.CSSProperties,
  toggleRow: {
    display: "flex",
    alignItems: "center",
    marginBottom: "16px",
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  } as React.CSSProperties,
  cleanupResult: {
    marginTop: "12px",
    padding: "10px 14px",
    borderRadius: "8px",
    fontSize: "13px",
    fontWeight: 600,
    background: "var(--success-bg)",
    color: "var(--success)",
    border: "1px solid var(--success)",
  } as React.CSSProperties,
  // Session management styles
  searchRow: {
    display: "flex",
    gap: "8px",
    marginBottom: "12px",
    flexWrap: "wrap" as const,
    alignItems: "center",
  } as React.CSSProperties,
  searchInput: {
    flex: 1,
    minWidth: 200,
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1px solid var(--input-border)",
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    fontSize: "13px",
    outline: "none",
  } as React.CSSProperties,
  selectInput: {
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1px solid var(--input-border)",
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    fontSize: "13px",
    outline: "none",
  } as React.CSSProperties,
  sessionTable: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "13px",
  } as React.CSSProperties,
  th: {
    textAlign: "left" as const,
    padding: "8px 10px",
    borderBottom: "2px solid var(--border)",
    color: "var(--text-muted)",
    fontWeight: 600,
    fontSize: "11px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.3px",
    cursor: "pointer",
    userSelect: "none" as const,
  } as React.CSSProperties,
  td: {
    padding: "8px 10px",
    borderBottom: "1px solid var(--border)",
    color: "var(--text-primary)",
    maxWidth: 250,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  checkbox: {
    width: 16,
    height: 16,
    cursor: "pointer",
    accentColor: "var(--accent)",
  } as React.CSSProperties,
  dangerBtn: {
    padding: "6px 14px",
    borderRadius: "6px",
    border: "none",
    background: "var(--error, #da3633)",
    color: "#fff",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 600,
  } as React.CSSProperties,
  statusBadge: (status: string) => ({
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "11px",
    fontWeight: 600,
    background: status === "active" ? "var(--success-bg)" : "var(--bg-secondary)",
    color: status === "active" ? "var(--success)" : "var(--text-muted)",
  } as React.CSSProperties),
  emptyState: {
    padding: "40px 20px",
    textAlign: "center" as const,
    color: "var(--text-muted)",
    fontSize: "14px",
  } as React.CSSProperties,
  paginationRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: "12px",
    fontSize: "12px",
    color: "var(--text-muted)",
  } as React.CSSProperties,
  pageBtn: {
    padding: "4px 10px",
    borderRadius: "4px",
    border: "1px solid var(--border)",
    background: "var(--bg-secondary)",
    color: "var(--text-primary)",
    cursor: "pointer",
    fontSize: "12px",
  } as React.CSSProperties,
  confirmOverlay: {
    position: "fixed" as const,
    top: 0, left: 0, right: 0, bottom: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  } as React.CSSProperties,
  confirmDialog: {
    background: "var(--bg-primary)",
    borderRadius: "12px",
    padding: "24px",
    maxWidth: 420,
    width: "90%",
    boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
  } as React.CSSProperties,
};

type SortField = "name" | "updatedAt" | "turnCount" | "status";
type SortDir = "asc" | "desc";
const PAGE_SIZE = 15;

export default function SessionManagementPage() {
  const { t, lang } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<number | null>(null);

  // Retention policy state
  const [maxAgeDays, setMaxAgeDays] = useState(30);
  const [maxInactiveDays, setMaxInactiveDays] = useState(7);
  const [maxSessions, setMaxSessions] = useState(100);
  const [maxMessagesPerSession, setMaxMessagesPerSession] = useState(1000);
  const [enabled, setEnabled] = useState(true);

  const [stats, setStats] = useState<RetentionStats>({
    totalSessions: 0,
    expiredSessions: 0,
    cleanedUp: 0,
    lastRun: "",
  });

  // Session management state
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>("updatedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [confirmAction, setConfirmAction] = useState<"clearAll" | "deleteSelected" | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [policyRes, statsRes, sessionsRes] = await Promise.all([
        retentionApi.getPolicy(),
        retentionApi.getStats(),
        chatApi.listSessions(),
      ]);

      const policy = policyRes.policy;
      setMaxAgeDays(policy.maxAgeDays);
      setMaxInactiveDays(policy.maxInactiveDays);
      setMaxSessions(policy.maxSessions);
      setMaxMessagesPerSession(policy.maxMessagesPerSession);
      setEnabled(policy.enabled);
      setStats(statsRes);
      setSessions(sessionsRes.sessions || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("session_mgmt.load_fail"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Filtered, sorted, paginated sessions
  const filteredSessions = useMemo(() => {
    let result = sessions;

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(s =>
        (s.label || s.preview || s.sessionId).toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q)
      );
    }

    // Status filter
    if (statusFilter !== "all") {
      result = result.filter(s => {
        const isActive = s.status === "active" || (!s.status && s.turnCount && s.turnCount > 0);
        return statusFilter === "active" ? isActive : !isActive;
      });
    }

    // Sort
    result = [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "name":
          cmp = (a.label || a.preview || a.sessionId).localeCompare(b.label || b.preview || b.sessionId);
          break;
        case "updatedAt":
          cmp = new Date(a.updatedAt || 0).getTime() - new Date(b.updatedAt || 0).getTime();
          break;
        case "turnCount":
          cmp = (a.turnCount || 0) - (b.turnCount || 0);
          break;
        case "status":
          cmp = (a.status || "").localeCompare(b.status || "");
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return result;
  }, [sessions, searchQuery, statusFilter, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filteredSessions.length / PAGE_SIZE));
  const pagedSessions = filteredSessions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [searchQuery, statusFilter, sortField, sortDir]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === pagedSessions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pagedSessions.map(s => s.sessionId)));
    }
  };

  const handleDeleteSelected = async () => {
    setDeleting(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map(id => {
          const sess = sessions.find(s => s.sessionId === id);
          const agentId = sess?.agentId || "default";
          return fetch(`/api/sessions/${encodeURIComponent(agentId)}/${id}`, { method: "DELETE" });
        })
      );
      showToast(t("session_mgmt.deleted_count").replace("{0}", String(selectedIds.size)), "success");
      setSelectedIds(new Set());
      setConfirmAction(null);
      await fetchData();
    } catch (err) {
      showToast(t("session_mgmt.delete_fail"), "error");
    } finally {
      setDeleting(false);
    }
  };

  const handleClearAll = async () => {
    setDeleting(true);
    try {
      await Promise.all(
        sessions.map(s =>
          fetch(`/api/sessions/${encodeURIComponent(s.agentId || "default")}/${s.sessionId}`, { method: "DELETE" })
        )
      );
      showToast(t("session_mgmt.all_cleared"), "success");
      setConfirmAction(null);
      await fetchData();
    } catch (err) {
      showToast(t("session_mgmt.delete_fail"), "error");
    } finally {
      setDeleting(false);
    }
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await retentionApi.updatePolicy({
        maxAgeDays,
        maxInactiveDays,
        maxSessions,
        maxMessagesPerSession,
        enabled,
      });
      showToast(t("retention.saved_ok"), "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("retention.save_fail"), "error");
    } finally {
      setSaving(false);
    }
  }, [maxAgeDays, maxInactiveDays, maxSessions, maxMessagesPerSession, enabled, t]);

  const handleRunCleanup = useCallback(async () => {
    setCleaning(true);
    setCleanResult(null);
    try {
      const result = await retentionApi.runNow();
      setCleanResult(result.cleaned);
      showToast(t("retention.cleaned_count").replace("{0}", String(result.cleaned)), "success");
      await fetchData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("retention.clean_fail"), "error");
    } finally {
      setCleaning(false);
    }
  }, [fetchData, t]);

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return "-";
    return new Date(dateStr).toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
  };

  const formatRelative = (dateStr?: string) => {
    if (!dateStr) return "-";
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t("sessions.just_now");
    if (mins < 60) return t("sessions.minutes_ago").replace("{0}", String(mins));
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t("sessions.hours_ago").replace("{0}", String(hours));
    const days = Math.floor(hours / 24);
    return t("sessions.days_ago").replace("{0}", String(days));
  };

  if (loading) return <Loading text={t("app.loading")} />;

  return (
    <div style={s.container}>
      <PageHeader
        title={t("session_mgmt.title")}
        subtitle={t("session_mgmt.subtitle")}
        actions={<SecondaryButton onClick={fetchData} small>{t("retention.refresh_btn")}</SecondaryButton>}
      />

      {error && <ErrorBanner message={error} onRetry={fetchData} />}

      <StatsGrid
        items={[
          { label: t("session_mgmt.total_sessions"), value: sessions.length, color: "var(--accent)" },
          { label: t("session_mgmt.active_sessions"), value: sessions.filter(s => s.status === "active" || (!s.status && (s.turnCount || 0) > 0)).length, color: "var(--success)" },
          { label: t("retention.expired"), value: stats.expiredSessions, color: "var(--warning)" },
          { label: t("retention.last_run"), value: stats.lastRun ? new Date(stats.lastRun).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US") : t("retention.never"), sub: stats.lastRun ? new Date(stats.lastRun).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US") : undefined },
        ]}
      />

      {/* ── Session Browser ── */}
      <Section title={t("session_mgmt.browser_title")} style={{ marginTop: "20px" }}>
        <Card>
          {/* Search & filter row */}
          <div style={s.searchRow}>
            <input
              style={s.searchInput}
              type="search"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t("session_mgmt.search_placeholder")}
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore
              data-form-type="other"
            />
            <select
              style={s.selectInput}
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
            >
              <option value="all">{t("session_mgmt.all_statuses")}</option>
              <option value="active">{t("session_mgmt.active_only")}</option>
              <option value="inactive">{t("session_mgmt.inactive_only")}</option>
            </select>
            {selectedIds.size > 0 && (
              <button
                style={s.dangerBtn}
                onClick={() => setConfirmAction("deleteSelected")}
              >
                {t("session_mgmt.delete_selected").replace("{0}", String(selectedIds.size))}
              </button>
            )}
            {sessions.length > 0 && (
              <button
                style={{ ...s.dangerBtn, opacity: 0.8 }}
                onClick={() => setConfirmAction("clearAll")}
              >
                {t("session_mgmt.clear_all")}
              </button>
            )}
          </div>

          {/* Session table */}
          {filteredSessions.length === 0 ? (
            <div style={s.emptyState}>
              {searchQuery || statusFilter !== "all"
                ? t("session_mgmt.no_match")
                : t("sessions.empty")}
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.sessionTable}>
                <thead>
                  <tr>
                    <th style={{ ...s.th, width: 36 }}>
                      <input
                        type="checkbox"
                        style={s.checkbox}
                        checked={pagedSessions.length > 0 && pagedSessions.every(s => selectedIds.has(s.sessionId))}
                        onChange={toggleSelectAll}
                      />
                    </th>
                    <th style={s.th} onClick={() => handleSort("name")}>
                      {t("session_mgmt.col_name")} {sortField === "name" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                    </th>
                    <th style={s.th} onClick={() => handleSort("status")}>
                      {t("session_mgmt.col_status")} {sortField === "status" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                    </th>
                    <th style={s.th} onClick={() => handleSort("turnCount")}>
                      {t("session_mgmt.col_turns")} {sortField === "turnCount" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                    </th>
                    <th style={s.th} onClick={() => handleSort("updatedAt")}>
                      {t("session_mgmt.col_last_active")} {sortField === "updatedAt" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                    </th>
                    <th style={{ ...s.th, width: 60 }}>{t("session_mgmt.col_actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedSessions.map(sess => (
                    <tr key={sess.sessionId}>
                      <td style={s.td}>
                        <input
                          type="checkbox"
                          style={s.checkbox}
                          checked={selectedIds.has(sess.sessionId)}
                          onChange={() => toggleSelect(sess.sessionId)}
                        />
                      </td>
                      <td style={s.td} title={sess.label || sess.preview || sess.sessionId}>
                        {sess.label || sess.preview || sess.sessionId.slice(0, 12) + "..."}
                      </td>
                      <td style={s.td}>
                        <span style={s.statusBadge(sess.status === "active" ? "active" : "inactive")}>
                          {sess.status === "active" ? t("session_mgmt.active") : t("session_mgmt.inactive")}
                        </span>
                      </td>
                      <td style={s.td}>{sess.turnCount ?? 0}</td>
                      <td style={s.td} title={formatDate(sess.updatedAt)}>
                        {formatRelative(sess.updatedAt)}
                      </td>
                      <td style={s.td}>
                        <button
                          style={{ ...s.dangerBtn, padding: "3px 8px", fontSize: "11px" }}
                          onClick={async () => {
                            try {
                              await fetch(`/api/sessions/${encodeURIComponent(sess.agentId || "default")}/${sess.sessionId}`, { method: "DELETE" });
                              showToast(t("session_mgmt.deleted_one"), "success");
                              await fetchData();
                            } catch { showToast(t("session_mgmt.delete_fail"), "error"); }
                          }}
                        >
                          {t("session_mgmt.delete_btn")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {filteredSessions.length > PAGE_SIZE && (
            <div style={s.paginationRow}>
              <span>
                {(() => {
                  const start = (page - 1) * PAGE_SIZE + 1;
                  const end = Math.min(page * PAGE_SIZE, filteredSessions.length);
                  const total = filteredSessions.length;
                  return t("session_mgmt.showing").replace("{0}", String(start)).replace("{1}", String(end)).replace("{2}", String(total));
                })()}
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                <button style={s.pageBtn} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  ←
                </button>
                <span style={{ padding: "4px 8px" }}>{page} / {totalPages}</span>
                <button style={s.pageBtn} disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                  →
                </button>
              </div>
            </div>
          )}
        </Card>
      </Section>

      {/* ── Retention Policy ── */}
      <Section title={t("retention.policy_config")} style={{ marginTop: "24px" }}>
        <Card>
          <div style={s.toggleRow}>
            <Toggle checked={enabled} onChange={setEnabled} label={enabled ? t("retention.enabled") : t("feature_flags.disabled")} />
          </div>
          <div style={s.policyGrid}>
            <div style={s.inputGroup}>
              <span style={s.label}>{t("retention.max_age")}</span>
              <input
                type="number"
                style={s.input}
                value={maxAgeDays}
                onChange={(e) => setMaxAgeDays(Number(e.target.value))}
                min={1}
              />
            </div>
            <div style={s.inputGroup}>
              <span style={s.label}>{t("retention.max_inactive")}</span>
              <input
                type="number"
                style={s.input}
                value={maxInactiveDays}
                onChange={(e) => setMaxInactiveDays(Number(e.target.value))}
                min={1}
              />
            </div>
            <div style={s.inputGroup}>
              <span style={s.label}>{t("retention.max_sessions")}</span>
              <input
                type="number"
                style={s.input}
                value={maxSessions}
                onChange={(e) => setMaxSessions(Number(e.target.value))}
                min={1}
              />
            </div>
            <div style={s.inputGroup}>
              <span style={s.label}>{t("retention.max_messages")}</span>
              <input
                type="number"
                style={s.input}
                value={maxMessagesPerSession}
                onChange={(e) => setMaxMessagesPerSession(Number(e.target.value))}
                min={1}
              />
            </div>
          </div>
          <div style={s.actions}>
            <PrimaryButton onClick={handleSave} disabled={saving}>
              {saving ? t("retention.saving") : t("retention.save")}
            </PrimaryButton>
          </div>
        </Card>
      </Section>

      {/* ── Manual Cleanup ── */}
      <Section title={t("retention.manual_cleanup")} style={{ marginTop: "24px" }}>
        <Card>
          <div style={{ marginBottom: "12px", fontSize: "13px", color: "var(--text-secondary)" }}>
            {t("retention.cleanup_desc")} {formatDate(stats.lastRun || undefined)}
          </div>
          <PrimaryButton onClick={handleRunCleanup} disabled={cleaning} danger>
            {cleaning ? t("retention.cleaning") : t("retention.run_now")}
          </PrimaryButton>
          {cleanResult !== null && (
            <div style={s.cleanupResult}>
              {t("retention.cleaned_result").replace("{0}", String(cleanResult))}
            </div>
          )}
        </Card>
      </Section>

      {/* ── Confirm Dialog ── */}
      {confirmAction && (
        <div style={s.confirmOverlay} onClick={() => !deleting && setConfirmAction(null)}>
          <div style={s.confirmDialog} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 12px 0", fontSize: 16 }}>
              {confirmAction === "clearAll"
                ? t("session_mgmt.confirm_clear_all")
                : t("session_mgmt.confirm_delete_selected").replace("{0}", String(selectedIds.size))}
            </h3>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 20px 0" }}>
              {t("session_mgmt.confirm_desc")}
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <SecondaryButton onClick={() => setConfirmAction(null)} disabled={deleting}>
                {t("sessions.no")}
              </SecondaryButton>
              <PrimaryButton
                danger
                onClick={confirmAction === "clearAll" ? handleClearAll : handleDeleteSelected}
                disabled={deleting}
              >
                {deleting ? t("session_mgmt.deleting") : t("sessions.yes")}
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
