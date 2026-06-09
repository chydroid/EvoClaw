/**
 * DeadLetterQueuePage — Monitor and manage failed message deliveries.
 *
 * Shows DLQ entries with filtering, retry, and purge capabilities.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, GhostButton, DataTable,
  StatsGrid, Modal, showToast,
} from "./shared";
import { dlqApi } from "./api-client";
import type { DeadLetter } from "./api-client";
import { useTranslation } from "./i18n";

const STATUS_FILTERS = ["All", "Pending", "Dead", "Retrying"] as const;

const STATUS_LABELS: Record<string, string> = {
  All: "dlq.all",
  Pending: "dlq.pending",
  Dead: "dlq.dead",
  Retrying: "dlq.retrying",
};

export default function DeadLetterQueuePage() {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<DeadLetter[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [statusFilter, setStatusFilter] = useState<string>("All");
  const [typeFilter, setTypeFilter] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [confirmAction, setConfirmAction] = useState<{ type: "retryAll" | "purgeAll" } | null>(null);

  const load = useCallback(async () => {
    try {
      const opts: { status?: string; type?: string } = {};
      if (statusFilter !== "All") opts.status = statusFilter.toLowerCase();
      if (typeFilter) opts.type = typeFilter;
      const res = await dlqApi.list(opts);
      setMessages(res.messages);
      setTotal(res.total);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("dlq.load_fail"));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter]);

  useEffect(() => { load(); }, [load]);

  const handleRetry = async (id: string) => {
    try {
      await dlqApi.retry(id);
      showToast(t("dlq.retry_ok"), "success");
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t("dlq.retry_fail_msg"), "error");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await dlqApi.delete(id);
      showToast(t("dlq.delete_ok"), "success");
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t("dlq.delete_fail_msg"), "error");
    }
  };

  const handleRetryAll = async () => {
    try {
      const res = await dlqApi.retryAll();
      showToast(t("dlq.retry_all_ok").replace("{0}", String(res.retried)), "success");
      setConfirmAction(null);
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t("dlq.retry_all_fail"), "error");
    }
  };

  const handlePurge = async () => {
    try {
      const res = await dlqApi.purge();
      showToast(t("dlq.purge_ok").replace("{0}", String(res.deleted)), "success");
      setConfirmAction(null);
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t("dlq.purge_fail"), "error");
    }
  };

  const pendingCount = messages.filter((m) => m.status === "pending").length;
  const deadCount = messages.filter((m) => m.status === "dead").length;
  const retryingCount = messages.filter((m) => m.status === "retrying").length;

  const uniqueTypes = [...new Set(messages.map((m) => m.type))].sort();

  return (
    <div style={{ padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-primary)", boxSizing: "border-box" }}>
      <PageHeader
        title={t("dlq.title")}
        subtitle={t("dlq.subtitle")}
        actions={
          <>
            <SecondaryButton onClick={() => setConfirmAction({ type: "retryAll" })}>{t("dlq.retry_all")}</SecondaryButton>
            <PrimaryButton danger onClick={() => setConfirmAction({ type: "purgeAll" })}>{t("dlq.purge")}</PrimaryButton>
          </>
        }
      />

      {error && <ErrorBanner message={error} onRetry={load} />}

      <StatsGrid items={[
        { label: t("dlq.total_label"), value: total },
        { label: t("dlq.pending"), value: pendingCount, color: "var(--warning)" },
        { label: t("dlq.dead"), value: deadCount, color: "var(--error)" },
        { label: t("dlq.retrying"), value: retryingCount, color: "var(--accent)" },
      ]} />

      <div style={{ marginTop: "20px" }} />

      <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", gap: "4px" }}>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              style={{
                padding: "6px 14px", borderRadius: "6px", border: "1px solid var(--border)",
                background: statusFilter === f ? "var(--accent)" : "var(--bg-hover)",
                color: statusFilter === f ? "#fff" : "var(--text-secondary)",
                cursor: "pointer", fontSize: "12px", fontWeight: 500,
              }}
            >
              {STATUS_LABELS[f].includes(".") ? t(STATUS_LABELS[f]) : STATUS_LABELS[f]}
            </button>
          ))}
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          style={{
            padding: "6px 12px", borderRadius: "6px", border: "1px solid var(--border)",
            background: "var(--bg-input)", color: "var(--text-primary)", fontSize: "12px",
            cursor: "pointer",
          }}
        >
          <option value="">{t("dlq.all_types")}</option>
          {uniqueTypes.map((ut) => (
            <option key={ut} value={ut}>{ut}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <Loading text={t("app.loading")} />
      ) : messages.length === 0 ? (
        <EmptyState title={t("dlq.no_messages")} description={t("dlq.empty_desc")} />
      ) : (
        <Section title={t("dlq.message_list")}>
          <Card>
            <DataTable
              columns={[
                {
                  key: "id", label: "ID",
                  render: (m: DeadLetter) => (
                    <code
                      style={{ fontSize: "11px", color: "var(--accent)", cursor: "pointer" }}
                      onClick={() => setExpandedId(expandedId === m.id ? null : m.id)}
                    >
                      {m.id.slice(0, 12)}...
                    </code>
                  ),
                },
                { key: "type", label: t("dlq.type") },
                {
                  key: "reason", label: t("dlq.reason"),
                  render: (m: DeadLetter) => (
                    <span style={{ fontSize: "12px", color: "var(--text-muted)", maxWidth: "200px", display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.reason}
                    </span>
                  ),
                },
                {
                  key: "attempts", label: t("dlq.attempts"),
                  render: (m: DeadLetter) => (
                    <span style={{ fontSize: "13px" }}>{m.attempts} / {m.maxAttempts}</span>
                  ),
                },
                {
                  key: "status", label: t("dlq.status"),
                  render: (m: DeadLetter) => {
                    const v = m.status === "dead" ? "error" : m.status === "retrying" ? "warning" : m.status === "pending" ? "info" : "default";
                    return <Badge variant={v}>{m.status}</Badge>;
                  },
                },
                {
                  key: "enqueuedAt", label: t("dlq.enqueued_at"),
                  render: (m: DeadLetter) => (
                    <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      {new Date(m.enqueuedAt).toLocaleString()}
                    </span>
                  ),
                },
                {
                  key: "actions", label: t("dlq.actions"),
                  render: (m: DeadLetter) => (
                    <div style={{ display: "flex", gap: "4px" }}>
                      <GhostButton small onClick={() => handleRetry(m.id)}>{t("dlq.retry")}</GhostButton>
                      <GhostButton small onClick={() => handleDelete(m.id)} style={{ color: "var(--error)" }}>{t("dlq.delete")}</GhostButton>
                    </div>
                  ),
                },
              ]}
              data={messages}
              keyFn={(m) => m.id}
              emptyText={t("dlq.no_messages")}
            />

            {expandedId && (() => {
              const msg = messages.find((m) => m.id === expandedId);
              if (!msg) return null;
              return (
                <div style={{
                  marginTop: "12px", padding: "14px", borderRadius: "8px",
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                }}>
                  <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "8px" }}>
                    {t("dlq.message_content")} {msg.id}
                  </div>
                  <pre style={{
                    margin: 0, fontSize: "12px", color: "var(--text-primary)",
                    whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: "1.6",
                    maxHeight: "300px", overflow: "auto",
                  }}>
                    {JSON.stringify(msg.payload, null, 2)}
                  </pre>
                </div>
              );
            })()}
          </Card>
        </Section>
      )}

      {confirmAction && (
        <Modal
          title={confirmAction.type === "retryAll" ? t("dlq.retry_all_title") : t("dlq.purge_title")}
          onClose={() => setConfirmAction(null)}
          footer={
            <>
              <SecondaryButton onClick={() => setConfirmAction(null)}>{t("app.cancel")}</SecondaryButton>
              <PrimaryButton
                danger={confirmAction.type === "purgeAll"}
                onClick={confirmAction.type === "retryAll" ? handleRetryAll : handlePurge}
              >
                {confirmAction.type === "retryAll" ? t("dlq.retry_all") : t("dlq.purge")}
              </PrimaryButton>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "14px", lineHeight: "1.6" }}>
            {confirmAction.type === "retryAll"
              ? t("dlq.confirm_retry_msg").replace("{0}", String(total))
              : t("dlq.confirm_purge_msg").replace("{0}", String(total))}
          </p>
        </Modal>
      )}
    </div>
  );
}
