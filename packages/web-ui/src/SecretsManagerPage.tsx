/**
 * SecretsManagerPage — Manage sensitive credentials and API keys.
 *
 * Lists, registers, rotates, revokes, and deletes secrets
 * backed by the SecretManager backend.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, GhostButton, DataTable,
  TextInput, StatsGrid, Modal, showToast,
} from "./shared";
import { secretsApi } from "./api-client";
import type { SecretEntry, SecretAuditLog } from "./api-client";

export default function SecretsManagerPage() {
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Modals
  const [showRegister, setShowRegister] = useState(false);
  const [showGenerateKey, setShowGenerateKey] = useState(false);
  const [showReveal, setShowReveal] = useState<string | null>(null);

  // Forms
  const [regName, setRegName] = useState("");
  const [regValue, setRegValue] = useState("");
  const [regTtl, setRegTtl] = useState("");
  const [genPrefix, setGenPrefix] = useState("");

  // Audit
  const [auditLogs, setAuditLogs] = useState<SecretAuditLog[]>([]);
  const [auditExpanded, setAuditExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await secretsApi.list();
      setSecrets(res.secrets);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load secrets");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const res = await secretsApi.auditLogs();
      setAuditLogs(res.logs);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRegister = async () => {
    if (!regName || !regValue) return showToast("Name and value are required", "error");
    try {
      await secretsApi.register(regName, regValue, regTtl ? Number(regTtl) : undefined);
      showToast(`Secret "${regName}" registered`, "success");
      setShowRegister(false);
      setRegName(""); setRegValue(""); setRegTtl("");
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Registration failed", "error");
    }
  };

  const handleGenerateKey = async () => {
    try {
      const res = await secretsApi.generateApiKey(genPrefix || undefined);
      showToast(`API Key generated: ${res.name}`, "success");
      setShowGenerateKey(false);
      setGenPrefix("");
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Generation failed", "error");
    }
  };

  const handleRotate = async (name: string) => {
    try {
      await secretsApi.rotate(name);
      showToast(`Secret "${name}" rotated`, "success");
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Rotation failed", "error");
    }
  };

  const handleRevoke = async (name: string) => {
    try {
      await secretsApi.revoke(name);
      showToast(`Secret "${name}" revoked`, "success");
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Revoke failed", "error");
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await secretsApi.delete(name);
      showToast(`Secret "${name}" deleted`, "success");
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Delete failed", "error");
    }
  };

  const handleReveal = async (name: string) => {
    try {
      const res = await secretsApi.get(name);
      setShowReveal(res.value);
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Failed to get secret", "error");
    }
  };

  const activeCount = secrets.filter((s) => !s.revoked).length;
  const revokedCount = secrets.filter((s) => s.revoked).length;
  const rotatedCount = secrets.filter((s) => s.rotationVersion > 0).length;

  return (
    <div style={{ padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-primary)", boxSizing: "border-box" }}>
      <PageHeader
        title="Secrets Manager"
        subtitle="Manage sensitive credentials and API keys"
        actions={
          <>
            <PrimaryButton onClick={() => setShowRegister(true)}>Register Secret</PrimaryButton>
            <SecondaryButton onClick={() => setShowGenerateKey(true)}>Generate API Key</SecondaryButton>
          </>
        }
      />

      {error && <ErrorBanner message={error} onRetry={load} />}

      <StatsGrid items={[
        { label: "Total Secrets", value: secrets.length },
        { label: "Active", value: activeCount, color: "var(--success)" },
        { label: "Revoked", value: revokedCount, color: "var(--error)" },
        { label: "Recent Rotations", value: rotatedCount, color: "var(--accent)" },
      ]} />

      <div style={{ marginTop: "20px" }} />

      {loading ? (
        <Loading text="Loading secrets..." />
      ) : secrets.length === 0 ? (
        <EmptyState title="No secrets found" description="Register your first secret or generate an API key to get started." />
      ) : (
        <Section title="Secrets">
          <Card>
            <DataTable
              columns={[
                { key: "name", label: "Name", render: (s: SecretEntry) => <code style={{ fontSize: "12px", color: "var(--accent)" }}>{s.name}</code> },
                { key: "source", label: "Source", render: (s: SecretEntry) => <Badge variant="info">{s.source}</Badge> },
                {
                  key: "status", label: "Status",
                  render: (s: SecretEntry) => (
                    s.revoked
                      ? <Badge variant="error">revoked</Badge>
                      : <Badge variant="success">active</Badge>
                  ),
                },
                { key: "rotationVersion", label: "Rotations", render: (s: SecretEntry) => <span style={{ fontSize: "13px" }}>{s.rotationVersion}</span> },
                {
                  key: "createdAt", label: "Created",
                  render: (s: SecretEntry) => (
                    <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      {new Date(s.createdAt).toLocaleDateString()}
                    </span>
                  ),
                },
                {
                  key: "actions", label: "Actions",
                  render: (s: SecretEntry) => (
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      <GhostButton small onClick={() => handleReveal(s.name)}>Reveal</GhostButton>
                      <GhostButton small onClick={() => handleRotate(s.name)}>Rotate</GhostButton>
                      {!s.revoked && (
                        <GhostButton small onClick={() => handleRevoke(s.name)} style={{ color: "var(--warning)" }}>Revoke</GhostButton>
                      )}
                      <GhostButton small onClick={() => handleDelete(s.name)} style={{ color: "var(--error)" }}>Delete</GhostButton>
                    </div>
                  ),
                },
              ]}
              data={secrets}
              keyFn={(s) => s.name}
              emptyText="No secrets registered"
            />
          </Card>
        </Section>
      )}

      {/* Audit Log Section */}
      <div style={{ marginTop: "24px" }}>
        <Section title="Audit Log">
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "8px" }}>
            <GhostButton small onClick={() => { loadAudit(); setAuditExpanded(!auditExpanded); }}>
              {auditExpanded ? "Collapse" : "Load Audit Logs"}
            </GhostButton>
          </div>
          {auditExpanded && (
            <Card>
              {auditLogs.length === 0 ? (
                <EmptyState title="No audit logs" description="Audit logs will appear here when secrets are accessed." />
              ) : (
                <DataTable
                  columns={[
                    { key: "secretName", label: "Secret" },
                    { key: "operation", label: "Operation" },
                    { key: "accessedBy", label: "Accessed By" },
                    {
                      key: "timestamp", label: "Timestamp",
                      render: (l: SecretAuditLog) => (
                        <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                          {new Date(l.timestamp).toLocaleString()}
                        </span>
                      ),
                    },
                    {
                      key: "success", label: "Result",
                      render: (l: SecretAuditLog) => (
                        l.success
                          ? <Badge variant="success">success</Badge>
                          : <Badge variant="error">failed</Badge>
                      ),
                    },
                  ]}
                  data={auditLogs}
                  keyFn={(l, i) => `${l.secretName}-${i}`}
                  emptyText="No audit logs"
                />
              )}
            </Card>
          )}
        </Section>
      </div>

      {/* Register Modal */}
      {showRegister && (
        <Modal
          title="Register Secret"
          onClose={() => setShowRegister(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setShowRegister(false)}>Cancel</SecondaryButton>
              <PrimaryButton onClick={handleRegister}>Register</PrimaryButton>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "4px" }}>Name *</label>
              <TextInput value={regName} onChange={setRegName} placeholder="e.g. DB_PASSWORD" />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "4px" }}>Value *</label>
              <TextInput value={regValue} onChange={setRegValue} placeholder="Secret value" type="password" />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "4px" }}>TTL (ms, optional)</label>
              <TextInput value={regTtl} onChange={setRegTtl} placeholder="e.g. 3600000" />
            </div>
          </div>
        </Modal>
      )}

      {/* Generate API Key Modal */}
      {showGenerateKey && (
        <Modal
          title="Generate API Key"
          onClose={() => setShowGenerateKey(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setShowGenerateKey(false)}>Cancel</SecondaryButton>
              <PrimaryButton onClick={handleGenerateKey}>Generate</PrimaryButton>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "4px" }}>Key Prefix (optional)</label>
              <TextInput value={genPrefix} onChange={setGenPrefix} placeholder="e.g. sk-" />
            </div>
          </div>
        </Modal>
      )}

      {/* Reveal Modal */}
      {showReveal !== null && (
        <Modal
          title="Secret Value"
          onClose={() => setShowReveal(null)}
          footer={<SecondaryButton onClick={() => setShowReveal(null)}>Close</SecondaryButton>}
        >
          <pre style={{
            margin: 0, padding: "12px", borderRadius: "8px",
            background: "var(--bg-input)", color: "var(--text-primary)",
            fontSize: "13px", wordBreak: "break-all", whiteSpace: "pre-wrap",
            border: "1px solid var(--border)",
          }}>
            {showReveal}
          </pre>
        </Modal>
      )}
    </div>
  );
}