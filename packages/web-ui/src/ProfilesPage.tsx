/**
 * ProfilesPage — 角色管理（对标 hermes web/src/pages/ProfilesPage 的「身份」子集）。
 *
 * hermes 的 Profile 系统完整（模型/MCP/技能/灵魂逐配置），但 EvoClaw 的配置是全局的，
 * 无法承载逐配置文件。因此本页只做 hermes Profile 的**身份子集**：多个命名角色 +
 * 切换激活（name/title/masterTerm/tone/introduction），后端 PersonaManager。
 */

import React, { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, GhostButton, DataTable, Modal, ConfirmModal, showToast,
} from "./shared";
import { useTranslation } from "./i18n";
import { errorMessage } from "./api-error";

interface Persona {
  id: string;
  name: string;
  title: string;
  masterTerm: string;
  tone: "warm" | "professional" | "casual" | "humorous";
  introduction: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const TONE_LABEL: Record<Persona["tone"], string> = {
  warm: "温暖", professional: "专业", casual: "随意", humorous: "幽默",
};

const s: Record<string, CSSProperties> = {
  container: { padding: 20, height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  toolbar: { display: "flex", gap: "8px", marginBottom: "16px" },
  btn: { padding: "6px 14px", borderRadius: "6px", border: "1px solid var(--border-light)", cursor: "pointer", background: "var(--bg-card)", color: "var(--text-secondary)", fontSize: "12px" },
  field: { display: "flex", flexDirection: "column", gap: "4px", marginBottom: "12px" },
  label: { fontSize: "11px", color: "var(--text-muted)", fontWeight: "bold" },
  input: { padding: "8px 10px", borderRadius: "6px", border: "1px solid var(--border-light)", background: "var(--bg-input)", color: "var(--text-primary)", fontSize: "13px" },
  textarea: { padding: "8px 10px", borderRadius: "6px", border: "1px solid var(--border-light)", background: "var(--bg-input)", color: "var(--text-primary)", fontSize: "13px", minHeight: "80px", resize: "vertical" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" },
  intro: { color: "var(--text-secondary)", fontSize: "12px", marginTop: "4px", whiteSpace: "pre-wrap" },
};

export function ProfilesPage() {
  const { t } = useTranslation();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Persona | null>(null);
  const [form, setForm] = useState<{ name: string; title: string; masterTerm: string; tone: Persona["tone"]; introduction: string }>({
    name: "", title: "", masterTerm: "主人", tone: "warm", introduction: "",
  });
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Persona | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/personas");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPersonas(Array.isArray(data.personas) ? data.personas : []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = useCallback(() => {
    setEditing(null);
    setForm({ name: "", title: "", masterTerm: "主人", tone: "warm", introduction: "" });
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((p: Persona) => {
    setEditing(p);
    setForm({ name: p.name, title: p.title, masterTerm: p.masterTerm, tone: p.tone, introduction: p.introduction });
    setModalOpen(true);
  }, []);

  const save = useCallback(async () => {
    if (!form.name.trim()) { showToast(t("profiles.name_required", "请输入角色名称"), "error"); return; }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(), title: form.title.trim(), masterTerm: form.masterTerm.trim(),
        tone: form.tone, introduction: form.introduction,
      };
      const res = editing
        ? await fetch(`/api/personas/${encodeURIComponent(editing.name)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        : await fetch("/api/personas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      showToast(editing ? t("profiles.save_ok", "已更新") : t("profiles.create_ok", "已创建"), "success");
      setModalOpen(false);
      load();
    } catch (err) {
      showToast(errorMessage(err), "error");
    } finally {
      setSaving(false);
    }
  }, [editing, form, load, t]);

  const activate = useCallback(async (p: Persona) => {
    try {
      const res = await fetch(`/api/personas/${encodeURIComponent(p.name)}/activate`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      showToast(t("profiles.activated", "已切换"), "success");
      load();
    } catch (err) {
      showToast(errorMessage(err), "error");
    }
  }, [load, t]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/personas/${encodeURIComponent(deleteTarget.name)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      showToast(t("profiles.delete_ok", "已删除"), "success");
      setDeleteTarget(null);
      load();
    } catch (err) {
      showToast(errorMessage(err), "error");
    }
  }, [deleteTarget, load, t]);

  return (
    <div style={s.container}>
      <PageHeader
        title={t("profiles.title", "角色管理")}
        subtitle={t("profiles.subtitle", "管理多个 Agent 角色身份并切换激活（对标 hermes Profile 的身份子集）")}
        actions={<PrimaryButton small onClick={openCreate}>{t("profiles.new", "新建角色")}</PrimaryButton>}
      />
      {error && <ErrorBanner message={error} />}

      <Section title={t("profiles.list_header", "角色")}>
        {loading ? (
          <Loading />
        ) : personas.length === 0 ? (
          <EmptyState title={t("profiles.empty", "暂无角色")} description={t("profiles.empty_desc", "点击「新建角色」创建第一个")} />
        ) : (
          <DataTable
            columns={[
              { key: "name", label: t("profiles.col_name", "名称"), render: (p: Persona) => (
                <div>
                  <div style={{ color: "var(--text-primary)" }}>{p.name}</div>
                  {p.title && <div style={{ color: "var(--text-muted)", fontSize: "10px" }}>{p.title}</div>}
                </div>
              ) },
              { key: "tone", label: t("profiles.col_tone", "语气"), render: (p: Persona) => TONE_LABEL[p.tone] || p.tone },
              { key: "isActive", label: t("profiles.col_state", "状态"), render: (p: Persona) => p.isActive ? <Badge variant="success">{t("profiles.active", "激活中")}</Badge> : <Badge variant="default">{t("profiles.inactive", "未激活")}</Badge> },
              { key: "action", label: t("profiles.col_action", "操作"), render: (p: Persona) => (
                <div style={{ display: "flex", gap: "6px" }}>
                  {!p.isActive && <SecondaryButton small onClick={() => activate(p)}>{t("profiles.activate", "切换")}</SecondaryButton>}
                  <GhostButton small onClick={() => openEdit(p)}>{t("profiles.edit", "编辑")}</GhostButton>
                  <GhostButton small onClick={() => setDeleteTarget(p)}>{t("profiles.delete", "删除")}</GhostButton>
                </div>
              ) },
            ]}
            data={personas}
            keyFn={(p) => p.id}
            emptyText={t("profiles.empty", "暂无角色")}
          />
        )}
      </Section>

      {modalOpen && (
        <Modal title={editing ? t("profiles.edit_title", "编辑角色") : t("profiles.create_title", "新建角色")} onClose={() => setModalOpen(false)}>
          <div style={s.field}>
            <span style={s.label}>{t("profiles.field_name", "名称")}</span>
            <input style={s.input} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="EvoClaw小助手" />
          </div>
          <div style={s.field}>
            <span style={s.label}>{t("profiles.field_title", "头衔")}</span>
            <input style={s.input} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="您的专属智能助理" />
          </div>
          <div style={s.field}>
            <span style={s.label}>{t("profiles.field_master_term", "称呼主人的词")}</span>
            <input style={s.input} value={form.masterTerm} onChange={(e) => setForm((f) => ({ ...f, masterTerm: e.target.value }))} placeholder="主人" />
          </div>
          <div style={s.field}>
            <span style={s.label}>{t("profiles.field_tone", "语气")}</span>
            <select style={s.input} value={form.tone} onChange={(e) => setForm((f) => ({ ...f, tone: e.target.value as Persona["tone"] }))}>
              {(["warm", "professional", "casual", "humorous"] as const).map((t) => <option key={t} value={t}>{TONE_LABEL[t]}</option>)}
            </select>
          </div>
          <div style={s.field}>
            <span style={s.label}>{t("profiles.field_intro", "自我介绍")}</span>
            <textarea style={s.textarea} value={form.introduction} onChange={(e) => setForm((f) => ({ ...f, introduction: e.target.value }))} placeholder="您好主人！我是…" />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}>
            <GhostButton small onClick={() => setModalOpen(false)}>{t("common.cancel", "取消")}</GhostButton>
            <PrimaryButton small onClick={save} disabled={saving}>{saving ? t("common.saving", "保存中…") : t("common.save", "保存")}</PrimaryButton>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmModal
          title={t("profiles.delete_confirm", "删除角色")}
          message={t("profiles.delete_warn", "确定删除角色") + `「${deleteTarget.name}」？` + (deleteTarget.isActive ? " " + t("profiles.delete_active_warn", "删除后将切换到其他角色。") : "")}
          confirmLabel={t("profiles.delete_confirm_btn", "删除")}
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}