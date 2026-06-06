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
import { useTranslation } from "./i18n";

export default function SecretsManagerPage() {
  const { t } = useTranslation();
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showRegister, setShowRegister] = useState(false);
  const [showGenerateKey, setShowGenerateKey] = useState(false);
  const [showReveal, setShowReveal] = useState<string | null>(null);

  const [regName, setRegName] = useState("");
  const [regValue, setRegValue] = useState("");
  const [regTtl, setRegTtl] = useState("");
  const [genPrefix, setGenPrefix] = useState("");

  const [auditLogs, setAuditLogs] = useState<SecretAuditLog[]>([]);
  const [auditExpanded, setAuditExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await secretsApi.list();
      setSecrets(res.secrets);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("secrets.load_fail", "加载密钥失败"));
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
    if (!regName || !regValue) return showToast(t("secrets.name_value_required", "名称和值为必填项"), "error");
    try {
      await secretsApi.register(regName, regValue, regTtl ? Number(regTtl) : undefined);
      showToast(t("secrets.registered_ok", "密钥 \"{0}\" 已注册").replace("{0}", regName), "success");
      setShowRegister(false);
      setRegName(""); setRegValue(""); setRegTtl("");
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t("secrets.register_fail", "注册失败"), "error");
    }
  };

  const handleGenerateKey = async () => {
    try {
      const res = await secretsApi.generateApiKey(genPrefix || undefined);
      showToast(t("secrets.generated_ok", "API Key 已生成: {0}").replace("{0}", res.name), "success");
      setShowGenerateKey(false);
      setGenPrefix("");
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t("secrets.generate_fail", "生成失败"), "error");
    }
  };

  const handleRotate = async (name: string) => {
    try {
      await secretsApi.rotate(name);
      showToast(t("secrets.rotated_ok", "密钥 \"{0}\" 已轮换").replace("{0}", name), "success");
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t("secrets.rotate_fail", "轮换失败"), "error");
    }
  };

  const handleRevoke = async (name: string) => {
    try {
      await secretsApi.revoke(name);
      showToast(t("secrets.revoked_ok", "密钥 \"{0}\" 已撤销").replace("{0}", name), "success");
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t("secrets.revoke_fail", "撤销失败"), "error");
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await secretsApi.delete(name);
      showToast(t("secrets.deleted_ok", "密钥 \"{0}\" 已删除").replace("{0}", name), "success");
      load();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t("secrets.delete_fail", "删除失败"), "error");
    }
  };

  const handleReveal = async (name: string) => {
    try {
      const res = await secretsApi.get(name);
      setShowReveal(res.value);
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t("secrets.get_fail", "获取密钥失败"), "error");
    }
  };

  const activeCount = secrets.filter((s) => !s.revoked).length;
  const revokedCount = secrets.filter((s) => s.revoked).length;
  const rotatedCount = secrets.filter((s) => s.rotationVersion > 0).length;

  return (
    <div style={{ padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-primary)", boxSizing: "border-box" }}>
      <PageHeader
        title={t("secrets.title")}
        subtitle={t("secrets.subtitle")}
        actions={
          <>
            <PrimaryButton onClick={() => setShowRegister(true)}>{t("secrets.register")}</PrimaryButton>
            <SecondaryButton onClick={() => setShowGenerateKey(true)}>{t("secrets.generate_apikey")}</SecondaryButton>
          </>
        }
      />

      {error && <ErrorBanner message={error} onRetry={load} />}

      <StatsGrid items={[
        { label: t("secrets.total_count", "密钥总数"), value: secrets.length },
        { label: t("secrets.active"), value: activeCount, color: "var(--success)" },
        { label: t("secrets.revoked"), value: revokedCount, color: "var(--error)" },
        { label: t("secrets.recent_rotations", "最近轮换"), value: rotatedCount, color: "var(--accent)" },
      ]} />

      <div style={{ marginTop: "20px" }} />

      {loading ? (
        <Loading text={t("app.loading")} />
      ) : secrets.length === 0 ? (
        <EmptyState title={t("secrets.no_secrets")} description={t("secrets.empty_hint", "注册第一个密钥或生成 API Key 以开始使用")} />
      ) : (
        <Section title={t("secrets.list_title", "密钥列表")}>
          <Card>
            <DataTable
              columns={[
                { key: "name", label: t("secrets.name"), render: (s: SecretEntry) => <code style={{ fontSize: "12px", color: "var(--accent)" }}>{s.name}</code> },
                { key: "source", label: t("secrets.source"), render: (s: SecretEntry) => <Badge variant="info">{s.source}</Badge> },
                {
                  key: "status", label: t("secrets.status"),
                  render: (s: SecretEntry) => (
                    s.revoked
                      ? <Badge variant="error">{t("secrets.revoked")}</Badge>
                      : <Badge variant="success">{t("secrets.active")}</Badge>
                  ),
                },
                { key: "rotationVersion", label: t("secrets.rotation_count", "轮换次数"), render: (s: SecretEntry) => <span style={{ fontSize: "13px" }}>{s.rotationVersion}</span> },
                {
                  key: "createdAt", label: t("secrets.created"),
                  render: (s: SecretEntry) => (
                    <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      {new Date(s.createdAt).toLocaleDateString()}
                    </span>
                  ),
                },
                {
                  key: "actions", label: t("secrets.operation"),
                  render: (s: SecretEntry) => (
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      <GhostButton small onClick={() => handleReveal(s.name)}>{t("secrets.view", "查看")}</GhostButton>
                      <GhostButton small onClick={() => handleRotate(s.name)}>{t("secrets.rotate")}</GhostButton>
                      {!s.revoked && (
                        <GhostButton small onClick={() => handleRevoke(s.name)} style={{ color: "var(--warning)" }}>{t("secrets.revoke")}</GhostButton>
                      )}
                      <GhostButton small onClick={() => handleDelete(s.name)} style={{ color: "var(--error)" }}>{t("secrets.delete")}</GhostButton>
                    </div>
                  ),
                },
              ]}
              data={secrets}
              keyFn={(s) => s.name}
              emptyText={t("secrets.no_secrets")}
            />
          </Card>
        </Section>
      )}

      <div style={{ marginTop: "24px" }}>
        <Section title={t("secrets.audit_log")}>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "8px" }}>
            <GhostButton small onClick={() => { loadAudit(); setAuditExpanded(!auditExpanded); }}>
              {auditExpanded ? t("secrets.collapse", "收起") : t("secrets.load_audit", "加载审计日志")}
            </GhostButton>
          </div>
          {auditExpanded && (
            <Card>
              {auditLogs.length === 0 ? (
                <EmptyState title={t("secrets.no_audit")} description={t("secrets.audit_hint", "密钥被访问时审计日志将在此显示")} />
              ) : (
                <DataTable
                  columns={[
                    { key: "secretName", label: t("secrets.secret", "密钥") },
                    { key: "operation", label: t("secrets.operation") },
                    { key: "accessedBy", label: t("secrets.accessed_by") },
                    {
                      key: "timestamp", label: t("secrets.timestamp"),
                      render: (l: SecretAuditLog) => (
                        <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                          {new Date(l.timestamp).toLocaleString()}
                        </span>
                      ),
                    },
                    {
                      key: "success", label: t("secrets.result", "结果"),
                      render: (l: SecretAuditLog) => (
                        l.success
                          ? <Badge variant="success">{t("secrets.success")}</Badge>
                          : <Badge variant="error">{t("secrets.failed")}</Badge>
                      ),
                    },
                  ]}
                  data={auditLogs}
                  keyFn={(l, i) => `${l.secretName}-${i}`}
                  emptyText={t("secrets.no_audit")}
                />
              )}
            </Card>
          )}
        </Section>
      </div>

      {showRegister && (
        <Modal
          title={t("secrets.register_new")}
          onClose={() => setShowRegister(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setShowRegister(false)}>{t("app.cancel")}</SecondaryButton>
              <PrimaryButton onClick={handleRegister}>{t("secrets.register")}</PrimaryButton>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "4px" }}>{t("secrets.secret_name")} *</label>
              <TextInput value={regName} onChange={setRegName} placeholder="e.g. DB_PASSWORD" />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "4px" }}>{t("secrets.secret_value")} *</label>
              <TextInput value={regValue} onChange={setRegValue} placeholder="Secret value" type="password" />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "4px" }}>{t("secrets.ttl")}</label>
              <TextInput value={regTtl} onChange={setRegTtl} placeholder="e.g. 3600000" />
            </div>
          </div>
        </Modal>
      )}

      {showGenerateKey && (
        <Modal
          title={t("secrets.generate_apikey")}
          onClose={() => setShowGenerateKey(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setShowGenerateKey(false)}>{t("app.cancel")}</SecondaryButton>
              <PrimaryButton onClick={handleGenerateKey}>{t("secrets.generate", "生成")}</PrimaryButton>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "4px" }}>{t("secrets.key_prefix", "密钥前缀（可选）")}</label>
              <TextInput value={genPrefix} onChange={setGenPrefix} placeholder="e.g. sk-" />
            </div>
          </div>
        </Modal>
      )}

      {showReveal !== null && (
        <Modal
          title={t("secrets.secret_value")}
          onClose={() => setShowReveal(null)}
          footer={<SecondaryButton onClick={() => setShowReveal(null)}>{t("secrets.close", "关闭")}</SecondaryButton>}
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
