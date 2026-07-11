/**
 * WebhooksPage — Manage Incoming Webhook endpoints.
 *
 * Lists registered webhook endpoints, supports register / edit / delete / test
 * operations, and shows recent event logs and statistics.
 */

import React, { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, GhostButton, DataTable,
  TextInput, Toggle, StatsGrid, Modal, ConfirmModal, showToast,
} from "./shared";
import { webhooksApi } from "./api-client";
import type { WebhookEndpoint, WebhookEventLog, WebhookTestResult } from "./api-client";
import { useTranslation } from "./i18n";

// ─── Form state ────────────────────────────────────────────────

interface EndpointForm {
  id: string;
  path: string;
  method: "POST" | "GET";
  action: string;
  authToken: string;
  description: string;
  enabled: boolean;
}

const EMPTY_FORM: EndpointForm = {
  id: "",
  path: "",
  method: "POST",
  action: "",
  authToken: "",
  description: "",
  enabled: true,
};

// ─── Styles ────────────────────────────────────────────────────

const fieldLabelStyle: CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--text-secondary)",
  marginBottom: "4px",
};

const fieldGroupStyle: CSSProperties = {
  marginBottom: "14px",
};

const selectStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: "8px",
  border: "1px solid var(--input-border)",
  background: "var(--bg-input)",
  color: "var(--text-primary)",
  fontSize: "13px",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
  cursor: "pointer",
};

const methodBadgeStyle = (method: string): CSSProperties => ({
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "4px",
  fontSize: "11px",
  fontWeight: 700,
  fontFamily: "monospace",
  background: method === "POST" ? "var(--accent-bg)" : "var(--success-bg)",
  color: method === "POST" ? "var(--accent)" : "var(--success)",
});

const preStyle: CSSProperties = {
  margin: 0,
  padding: "12px",
  borderRadius: "8px",
  background: "var(--bg-hover)",
  border: "1px solid var(--border)",
  fontSize: "12px",
  color: "var(--text-primary)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  lineHeight: "1.6",
  maxHeight: "320px",
  overflow: "auto",
};

// ─── Component ─────────────────────────────────────────────────

export function WebhooksPage() {
  const { t } = useTranslation();
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [eventLogs, setEventLogs] = useState<WebhookEventLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Form modal state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EndpointForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<WebhookEndpoint | null>(null);

  // Test result modal
  const [testResult, setTestResult] = useState<WebhookTestResult | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  // Event log detail
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [epRes, logRes] = await Promise.all([
        webhooksApi.list(),
        webhooksApi.eventLogs(),
      ]);
      setEndpoints(epRes.endpoints || []);
      setEventLogs(logRes.logs || []);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("webhooks.load_fail"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  // ─── Form handlers ───────────────────────────────────────────

  const openCreateForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(true);
  };

  const openEditForm = (ep: WebhookEndpoint) => {
    setForm({
      id: ep.id,
      path: ep.path,
      method: ep.method,
      action: ep.action,
      authToken: ep.authToken || "",
      description: ep.description || "",
      enabled: ep.enabled,
    });
    setEditingId(ep.id);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const handleSave = async () => {
    if (!form.id.trim() || !form.path.trim() || !form.action.trim()) {
      showToast(t("webhooks.id_placeholder"), "error");
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await webhooksApi.update(editingId, {
          path: form.path.trim(),
          method: form.method,
          action: form.action.trim(),
          authToken: form.authToken.trim() || undefined,
          description: form.description.trim() || undefined,
          enabled: form.enabled,
        });
        showToast(t("webhooks.update_ok").replace("{0}", form.id), "success");
      } else {
        await webhooksApi.create({
          id: form.id.trim(),
          path: form.path.trim(),
          method: form.method,
          action: form.action.trim(),
          authToken: form.authToken.trim() || undefined,
          description: form.description.trim() || undefined,
          enabled: form.enabled,
        });
        showToast(t("webhooks.create_ok").replace("{0}", form.id), "success");
      }
      closeForm();
      load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : (editingId ? t("webhooks.update_fail") : t("webhooks.create_fail"));
      showToast(msg, "error");
    } finally {
      setSaving(false);
    }
  };

  // ─── Delete handler ─────────────────────────────────────────

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await webhooksApi.delete(deleteTarget.id);
      showToast(t("webhooks.delete_ok"), "success");
      setDeleteTarget(null);
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t("webhooks.delete_fail"), "error");
      setDeleteTarget(null);
    }
  };

  // ─── Test handler ───────────────────────────────────────────

  const handleTest = async (ep: WebhookEndpoint) => {
    setTestingId(ep.id);
    try {
      const result = await webhooksApi.test(ep.id);
      setTestResult(result);
      if (result.success) {
        showToast(t("webhooks.test_ok").replace("{0}", String(result.statusCode)), "success");
      } else {
        showToast(t("webhooks.test_fail").replace("{0}", String(result.statusCode)), "error");
      }
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t("webhooks.test_error"), "error");
    } finally {
      setTestingId(null);
    }
  };

  // ─── Copy URL ───────────────────────────────────────────────

  const handleCopyUrl = (ep: WebhookEndpoint) => {
    const url = `${window.location.origin}/hooks${ep.path}`;
    navigator.clipboard.writeText(url).then(
      () => showToast(t("webhooks.url_copied"), "success"),
      () => showToast(t("webhooks.copy_url"), "error"),
    );
  };

  // ─── Stats ──────────────────────────────────────────────────

  const activeCount = endpoints.filter((e) => e.enabled).length;
  const totalTriggers = endpoints.reduce((sum, e) => sum + (e.triggerCount || 0), 0);

  const isEdit = editingId !== null;

  return (
    <div style={{ padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-primary)", boxSizing: "border-box" }}>
      <PageHeader
        title={t("webhooks.title")}
        subtitle={t("webhooks.subtitle")}
        actions={
          <PrimaryButton onClick={openCreateForm}>{t("webhooks.register")}</PrimaryButton>
        }
      />

      {error && <ErrorBanner message={error} onRetry={load} />}

      <StatsGrid items={[
        { label: t("webhooks.total_endpoints"), value: endpoints.length },
        { label: t("webhooks.active_endpoints"), value: activeCount, color: "var(--success)" },
        { label: t("webhooks.total_triggers"), value: totalTriggers, color: "var(--accent)" },
      ]} />

      <div style={{ marginTop: "20px" }} />

      {loading ? (
        <Loading text={t("app.loading")} />
      ) : endpoints.length === 0 ? (
        <EmptyState title={t("webhooks.no_endpoints")} description={t("webhooks.empty_desc")} />
      ) : (
        <Section title={t("webhooks.endpoint_list")}>
          <Card>
            <DataTable
              columns={[
                {
                  key: "id", label: t("webhooks.endpoint_id"),
                  render: (e: WebhookEndpoint) => (
                    <code style={{ fontSize: "12px", color: "var(--accent)" }}>{e.id}</code>
                  ),
                },
                {
                  key: "path", label: t("webhooks.path"),
                  render: (e: WebhookEndpoint) => (
                    <code style={{ fontSize: "12px", color: "var(--text-primary)" }}>/hooks{e.path}</code>
                  ),
                },
                {
                  key: "method", label: t("webhooks.method"),
                  render: (e: WebhookEndpoint) => <span style={methodBadgeStyle(e.method)}>{e.method}</span>,
                },
                {
                  key: "action", label: t("webhooks.action"),
                  render: (e: WebhookEndpoint) => (
                    <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{e.action}</span>
                  ),
                },
                {
                  key: "status", label: t("webhooks.status"),
                  render: (e: WebhookEndpoint) => (
                    e.enabled
                      ? <Badge variant="success">{t("webhooks.status_enabled")}</Badge>
                      : <Badge variant="default">{t("webhooks.status_disabled")}</Badge>
                  ),
                },
                {
                  key: "triggerCount", label: t("webhooks.trigger_count"),
                  render: (e: WebhookEndpoint) => <span style={{ fontSize: "13px" }}>{e.triggerCount || 0}</span>,
                },
                {
                  key: "lastTriggeredAt", label: t("webhooks.last_triggered"),
                  render: (e: WebhookEndpoint) => (
                    <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      {e.lastTriggeredAt ? new Date(e.lastTriggeredAt).toLocaleString() : t("webhooks.never_triggered")}
                    </span>
                  ),
                },
                {
                  key: "actions", label: t("webhooks.actions"),
                  render: (e: WebhookEndpoint) => (
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      <GhostButton small onClick={() => { if (testingId !== e.id) handleTest(e); }} style={testingId === e.id ? { opacity: 0.5, cursor: "not-allowed" } : undefined}>
                        {testingId === e.id ? "..." : t("webhooks.test")}
                      </GhostButton>
                      <GhostButton small onClick={() => openEditForm(e)}>{t("webhooks.edit_btn")}</GhostButton>
                      <GhostButton small onClick={() => handleCopyUrl(e)}>{t("webhooks.copy_url")}</GhostButton>
                      <GhostButton small onClick={() => setDeleteTarget(e)} style={{ color: "var(--error)" }}>{t("webhooks.delete")}</GhostButton>
                    </div>
                  ),
                },
              ]}
              data={endpoints}
              keyFn={(e) => e.id}
              emptyText={t("webhooks.no_endpoints")}
            />
          </Card>
        </Section>
      )}

      {/* ─── Event Logs ─── */}
      {!loading && eventLogs.length > 0 && (
        <Section title={t("webhooks.event_logs")}>
          <Card>
            <DataTable
              columns={[
                {
                  key: "timestamp", label: t("webhooks.log_time"),
                  render: (l: WebhookEventLog) => (
                    <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      {new Date(l.timestamp).toLocaleString()}
                    </span>
                  ),
                },
                {
                  key: "endpointPath", label: t("webhooks.log_path"),
                  render: (l: WebhookEventLog) => (
                    <code
                      style={{ fontSize: "11px", color: "var(--accent)", cursor: "pointer" }}
                      onClick={() => setExpandedLogId(expandedLogId === l.id ? null : l.id)}
                    >
                      {l.endpointPath}
                    </code>
                  ),
                },
                {
                  key: "action", label: t("webhooks.log_action"),
                  render: (l: WebhookEventLog) => (
                    <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{l.action}</span>
                  ),
                },
                {
                  key: "statusCode", label: t("webhooks.log_status"),
                  render: (l: WebhookEventLog) => {
                    const v = l.statusCode >= 200 && l.statusCode < 300 ? "success" : "error";
                    return <Badge variant={v}>{l.statusCode}</Badge>;
                  },
                },
                {
                  key: "method", label: t("webhooks.method"),
                  render: (l: WebhookEventLog) => <span style={methodBadgeStyle(l.method)}>{l.method}</span>,
                },
              ]}
              data={eventLogs.slice(0, 50)}
              keyFn={(l) => l.id}
              emptyText={t("webhooks.no_logs")}
            />

            {expandedLogId && (() => {
              const log = eventLogs.find((l) => l.id === expandedLogId);
              if (!log) return null;
              return (
                <div style={{ marginTop: "12px", padding: "14px", borderRadius: "8px", background: "var(--bg-hover)", border: "1px solid var(--border)" }}>
                  <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "8px" }}>
                    {t("webhooks.log_details")}
                  </div>
                  {log.error && (
                    <div style={{ marginBottom: "8px", padding: "6px 10px", borderRadius: "4px", background: "var(--error-bg)", color: "var(--error)", fontSize: "12px" }}>
                      {log.error}
                    </div>
                  )}
                  <pre style={preStyle}>
                    {JSON.stringify({ headers: log.headers, body: log.body }, null, 2)}
                  </pre>
                </div>
              );
            })()}
          </Card>
        </Section>
      )}

      {/* ─── Create / Edit Form Modal ─── */}
      {showForm && (
        <Modal
          title={isEdit ? t("webhooks.edit") : t("webhooks.register")}
          onClose={closeForm}
          width={560}
          footer={
            <>
              <SecondaryButton onClick={closeForm} disabled={saving}>{t("app.cancel")}</SecondaryButton>
              <PrimaryButton onClick={handleSave} disabled={saving}>
                {saving ? "..." : isEdit ? t("webhooks.edit_btn") : t("webhooks.register")}
              </PrimaryButton>
            </>
          }
        >
          {/* ID — only editable on create */}
          <div style={fieldGroupStyle}>
            <label style={fieldLabelStyle}>{t("webhooks.endpoint_id")}</label>
            <TextInput
              value={form.id}
              onChange={(v) => setForm({ ...form, id: v })}
              placeholder={t("webhooks.id_placeholder")}
            />
          </div>

          <div style={fieldGroupStyle}>
            <label style={fieldLabelStyle}>{t("webhooks.path")}</label>
            <TextInput
              value={form.path}
              onChange={(v) => setForm({ ...form, path: v })}
              placeholder={t("webhooks.path_placeholder")}
            />
          </div>

          <div style={{ ...fieldGroupStyle, display: "flex", gap: "12px" }}>
            <div style={{ flex: 1 }}>
              <label style={fieldLabelStyle}>{t("webhooks.method")}</label>
              <select
                style={selectStyle}
                value={form.method}
                onChange={(e) => setForm({ ...form, method: e.target.value as "POST" | "GET" })}
              >
                <option value="POST">{t("webhooks.method_post")}</option>
                <option value="GET">{t("webhooks.method_get")}</option>
              </select>
            </div>
            <div style={{ flex: 2 }}>
              <label style={fieldLabelStyle}>{t("webhooks.action")}</label>
              <TextInput
                value={form.action}
                onChange={(v) => setForm({ ...form, action: v })}
                placeholder={t("webhooks.action_placeholder")}
              />
            </div>
          </div>

          <div style={fieldGroupStyle}>
            <label style={fieldLabelStyle}>{t("webhooks.auth_token")}</label>
            <TextInput
              value={form.authToken}
              onChange={(v) => setForm({ ...form, authToken: v })}
              placeholder={t("webhooks.token_placeholder")}
            />
          </div>

          <div style={fieldGroupStyle}>
            <label style={fieldLabelStyle}>{t("webhooks.description")}</label>
            <TextInput
              value={form.description}
              onChange={(v) => setForm({ ...form, description: v })}
              placeholder={t("webhooks.desc_placeholder")}
            />
          </div>

          <div style={{ ...fieldGroupStyle, marginBottom: 0 }}>
            <Toggle
              checked={form.enabled}
              onChange={(v) => setForm({ ...form, enabled: v })}
              label={t("webhooks.enabled")}
            />
          </div>
        </Modal>
      )}

      {/* ─── Delete Confirmation ─── */}
      {deleteTarget && (
        <ConfirmModal
          title={t("webhooks.delete")}
          message={t("webhooks.delete_confirm").replace("{0}", deleteTarget.id)}
          danger
          confirmLabel={t("webhooks.delete")}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* ─── Test Result Modal ─── */}
      {testResult && (
        <Modal
          title={t("webhooks.test_result")}
          onClose={() => setTestResult(null)}
          width={600}
          footer={
            <PrimaryButton onClick={() => setTestResult(null)}>{t("app.cancel")}</PrimaryButton>
          }
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
            <Badge variant={testResult.success ? "success" : "error"}>
              HTTP {testResult.statusCode}
            </Badge>
            <span style={{ fontSize: "13px", color: testResult.success ? "var(--success)" : "var(--error)" }}>
              {testResult.success ? t("webhooks.test_ok").replace("{0}", String(testResult.statusCode)) : t("webhooks.test_fail").replace("{0}", String(testResult.statusCode))}
            </span>
          </div>
          <pre style={preStyle}>
            {JSON.stringify(testResult.response ?? testResult.eventLog ?? {}, null, 2)}
          </pre>
        </Modal>
      )}
    </div>
  );
}
