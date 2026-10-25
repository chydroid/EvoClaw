/**
 * EnvPage — 运行时环境变量管理（对标 hermes web/src/pages/EnvPage 的 env var 子集）。
 *
 * hermes EnvPage（1109 行）含 env var 的 CRUD + reveal + channel-managed flags；
 * EvoClaw 的 SecretsManager 管的是**凭证**（加密 API key），与 env var 是两个概念，
 * 且 env var 原本只能在启动前改 .env。因此本页只做 env var 的**运行时可管理子集**：
 * 列出经 API 管理的变量、新增/删除，写入后即时同步到 process.env。
 */

import React, { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, GhostButton, DataTable, Modal, ConfirmModal, showToast,
  TextInput,
} from "./shared";
import { useTranslation } from "./i18n";
import { errorMessage } from "./api-error";

interface EnvEntry {
  key: string;
  value: string;
  source: "envfile" | "api" | "system";
  readonly: boolean;
  updatedAt: string;
}

const s: Record<string, CSSProperties> = {
  container: { padding: 20, height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  toolbar: { display: "flex", gap: "8px", marginBottom: "16px" },
  btn: { padding: "6px 14px", borderRadius: "6px", border: "1px solid var(--border-light)", cursor: "pointer", background: "var(--bg-card)", color: "var(--text-secondary)", fontSize: "12px" },
  field: { display: "flex", flexDirection: "column", gap: "4px", marginBottom: "12px" },
  label: { fontSize: "11px", color: "var(--text-muted)", fontWeight: "bold" },
  input: { padding: "8px 10px", borderRadius: "6px", border: "1px solid var(--border-light)", background: "var(--bg-input)", color: "var(--text-primary)", fontSize: "13px" },
  valueMono: { fontFamily: "Consolas, Monaco, monospace", fontSize: "12px", wordBreak: "break-all" },
  hint: { color: "var(--text-muted)", fontSize: "11px", marginTop: "8px" },
};

const SOURCE_LABEL: Record<EnvEntry["source"], string> = {
  envfile: "来自 .env",
  api: "经 API 设置",
  system: "系统内置",
};

export function EnvPage() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<EnvEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/env");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEntries(Array.isArray(data.env) ? data.env : []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleReveal = useCallback((key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    const k = newKey.trim();
    if (!k) { showToast(t("env.name_required", "请输入变量名"), "error"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/env", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: k, value: newValue }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      showToast(t("env.save_ok", "已设置"), "success");
      setModalOpen(false);
      setNewKey("");
      setNewValue("");
      load();
    } catch (err) {
      showToast(errorMessage(err), "error");
    } finally {
      setSaving(false);
    }
  }, [newKey, newValue, load, t]);

  const confirmDelete = useCallback(async (key: string) => {
    try {
      const res = await fetch(`/api/env/${encodeURIComponent(key)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      showToast(t("env.delete_ok", "已删除"), "success");
      setDeleteTarget(null);
      load();
    } catch (err) {
      showToast(errorMessage(err), "error");
    }
  }, [load, t]);

  return (
    <div style={s.container}>
      <PageHeader
        title={t("env.title", "环境变量")}
        subtitle={t("env.subtitle", "运行时管理 env var（写入后即时生效；对标 hermes EnvPage 的 env var 子集）")}
        actions={<PrimaryButton small onClick={() => setModalOpen(true)}>{t("env.new", "新增变量")}</PrimaryButton>}
      />
      {error && <ErrorBanner message={error} />}

      <Section title={t("env.list_header", "已管理的变量")}>
        {loading ? (
          <Loading />
        ) : entries.length === 0 ? (
          <EmptyState title={t("env.empty", "暂无经 API 管理的变量")} description={t("env.empty_desc", "点击「新增变量」添加第一个")} />
        ) : (
          <DataTable
            columns={[
              { key: "key", label: t("env.col_key", "变量名"), render: (e: EnvEntry) => <span style={s.valueMono}>{e.key}</span> },
              { key: "value", label: t("env.col_value", "值"), render: (e: EnvEntry) => (
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ ...s.valueMono, color: revealed.has(e.key) ? "var(--text-primary)" : "var(--text-muted)" }}>
                    {revealed.has(e.key) ? e.value : "••••••••"}
                  </span>
                  <GhostButton small onClick={() => toggleReveal(e.key)}>{revealed.has(e.key) ? t("env.hide", "隐藏") : t("env.reveal", "显示")}</GhostButton>
                </div>
              ) },
              { key: "source", label: t("env.col_source", "来源"), render: (e: EnvEntry) => <Badge variant="default">{SOURCE_LABEL[e.source] || e.source}</Badge> },
              { key: "action", label: t("env.col_action", "操作"), render: (e: EnvEntry) => (
                e.readonly ? <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>{t("env.readonly", "只读")}</span>
                  : <GhostButton small onClick={() => setDeleteTarget(e.key)}>{t("env.delete", "删除")}</GhostButton>
              ) },
            ]}
            data={entries}
            keyFn={(e) => e.key}
            emptyText={t("env.empty", "暂无经 API 管理的变量")}
          />
        )}
      </Section>

      <div style={s.hint}>{t("env.hint", "系统内置变量（EvoClaw_*、WEB_UI_TOKEN 等）与受保护变量为只读，不允许经 API 改写。")}</div>

      {modalOpen && (
        <Modal title={t("env.new", "新增变量")} onClose={() => setModalOpen(false)}>
          <div style={s.field}>
            <span style={s.label}>{t("env.field_key", "变量名")}</span>
            <TextInput value={newKey} onChange={setNewKey} placeholder="MY_API_KEY" />
          </div>
          <div style={s.field}>
            <span style={s.label}>{t("env.field_value", "值")}</span>
            <TextInput value={newValue} onChange={setNewValue} placeholder="value" />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}>
            <GhostButton small onClick={() => setModalOpen(false)}>{t("common.cancel", "取消")}</GhostButton>
            <PrimaryButton small onClick={save} disabled={saving}>{saving ? t("common.saving", "保存中…") : t("common.save", "保存")}</PrimaryButton>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmModal
          title={t("env.delete_confirm", "删除变量")}
          message={`${t("env.delete_warn", "确定删除环境变量")}${deleteTarget}？`}
          confirmLabel={t("env.delete_confirm_btn", "删除")}
          danger
          onConfirm={() => confirmDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}