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

const STATUS_FILTERS = ["All", "Pending", "Dead", "Retrying"] as const;

export default function DeadLetterQueuePage() {
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
      setError(err instanceof Error ? err.message : "Failed to load dead letter queue");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter]);

  useEffect(() => { load(); }, [load]);

  const handleRetry = async (id: string) => {
    try {
      await dlqApi.retry(id);
      showToast("Message retry scheduled", "success");
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Retry failed", "error");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await dlqApi.delete(id);
      showToast("Message deleted", "success");
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Delete failed", "error");
    }
  };

  const handleRetryAll = async () => {
    try {
      const res = await dlqApi.retryAll();
      showToast(`${res.retried} messages queued for retry`, "success");
      setConfirmAction(null);
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Retry all failed", "error");
    }
  };

  const handlePurge = async () => {
    try {
      const res = await dlqApi.purge();
      showToast(`${res.deleted} messages purged`, "success");
      setConfirmAction(null);
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Purge failed", "error");
    }
  };

  const pendingCount = messages.filter((m) => m.status === "pending").length;
  const deadCount = messages.filter((m) => m.status === "dead").length;
  const retryingCount = messages.filter((m) => m.status === "retrying").length;

  const uniqueTypes = [...new Set(messages.map((m) => m.type))].sort();

  return (
    <div style={{ padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-primary)", boxSizing: "border-box" }}>
      <PageHeader
        title="Dead Letter Queue"
        subtitle="Monitor and manage failed message deliveries"
        actions={
          <>
            <SecondaryButton onClick={() => setConfirmAction({ type: "retryAll" })}>Retry All</SecondaryButton>
            <PrimaryButton danger onClick={() => setConfirmAction({ type: "purgeAll" })}>Purge All</PrimaryButton>
          </>
        }
      />

      {error && <ErrorBanner message={error} onRetry={load} />}

      <StatsGrid items={[
        { label: "Total", value: total },
        { label: "Pending", value: pendingCount, color: "var(--warning)" },
        { label: "Dead", value: deadCount, color: "var(--error)" },
        { label: "Retried", value: retryingCount, color: "var(--accent)" },
      ]} />

      <div style={{ marginTop: "20px" }} />

      {/* Filters */}
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
              {f}
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
          <option value="">All Types</option>
          {uniqueTypes.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <Loading text="Loading dead letter queue..." />
      ) : messages.length === 0 ? (
        <EmptyState title="No dead letters" description="The dead letter queue is empty." />
      ) : (
        <Section title="Messages">
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
                { key: "type", label: "Type" },
                {
                  key: "reason", label: "Reason",
                  render: (m: DeadLetter) => (
                    <span style={{ fontSize: "12px", color: "var(--text-muted)", maxWidth: "200px", display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.reason}
                    </span>
                  ),
                },
                {
                  key: "attempts", label: "Attempts",
                  render: (m: DeadLetter) => (
                    <span style={{ fontSize: "13px" }}>{m.attempts} / {m.maxAttempts}</span>
                  ),
                },
                {
                  key: "status", label: "Status",
                  render: (m: DeadLetter) => {
                    const v = m.status === "dead" ? "error" : m.status === "retrying" ? "warning" : m.status === "pending" ? "info" : "default";
                    return <Badge variant={v}>{m.status}</Badge>;
                  },
                },
                {
                  key: "enqueuedAt", label: "Enqueued",
                  render: (m: DeadLetter) => (
                    <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      {new Date(m.enqueuedAt).toLocaleString()}
                    </span>
                  ),
                },
                {
                  key: "actions", label: "Actions",
                  render: (m: DeadLetter) => (
                    <div style={{ display: "flex", gap: "4px" }}>
                      <GhostButton small onClick={() => handleRetry(m.id)}>Retry</GhostButton>
                      <GhostButton small onClick={() => handleDelete(m.id)} style={{ color: "var(--error)" }}>Delete</GhostButton>
                    </div>
                  ),
                },
              ]}
              data={messages}
              keyFn={(m) => m.id}
              emptyText="No messages in queue"
            />

            {/* Expanded row */}
            {expandedId && (() => {
              const msg = messages.find((m) => m.id === expandedId);
              if (!msg) return null;
              return (
                <div style={{
                  marginTop: "12px", padding: "14px", borderRadius: "8px",
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                }}>
                  <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "8px" }}>
                    Payload for {msg.id}
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

      {/* Confirm Modal */}
      {confirmAction && (
        <Modal
          title={confirmAction.type === "retryAll" ? "Retry All Messages" : "Purge All Messages"}
          onClose={() => setConfirmAction(null)}
          footer={
            <>
              <SecondaryButton onClick={() => setConfirmAction(null)}>Cancel</SecondaryButton>
              <PrimaryButton
                danger={confirmAction.type === "purgeAll"}
                onClick={confirmAction.type === "retryAll" ? handleRetryAll : handlePurge}
              >
                {confirmAction.type === "retryAll" ? "Retry All" : "Purge All"}
              </PrimaryButton>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "14px", lineHeight: "1.6" }}>
            {confirmAction.type === "retryAll"
              ? `Are you sure you want to retry all ${total} messages in the queue?`
              : `Are you sure you want to permanently delete all ${total} messages? This action cannot be undone.`}
          </p>
        </Modal>
      )}
    </div>
  );
}