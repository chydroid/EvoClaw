/**
 * MessageTemplatesPage — Manage reusable message templates.
 *
 * Create, edit, delete, and test-render message templates with
 * variable substitution support.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState, Section,
  PrimaryButton, SecondaryButton, GhostButton, TextInput, Modal, showToast,
} from "./shared";
import { templatesApi } from "./api-client";
import type { MessageTemplate } from "./api-client";

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)", width: "100%", boxSizing: "border-box" },
  templateCard: {
    background: "var(--bg-card)", border: "1px solid var(--border)",
    borderRadius: "10px", padding: "18px", marginBottom: "12px",
    cursor: "pointer", transition: "border-color 0.15s",
  },
  templateHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "8px" },
  templateName: { fontWeight: 600, fontSize: "15px", color: "var(--text-primary)" },
  templateDesc: { fontSize: "13px", color: "var(--text-muted)", marginTop: "4px" },
  templateMeta: { display: "flex", gap: "12px", alignItems: "center", marginTop: "8px", flexWrap: "wrap" },
  metaValue: { fontSize: "12px", color: "var(--text-secondary)" },
  metaLabel: { fontSize: "11px", color: "var(--text-muted)" },
  expandedSection: {
    marginTop: "14px", padding: "14px 16px", background: "var(--bg-hover)",
    borderRadius: "8px", border: "1px solid var(--border-light)",
  },
  contentPreview: {
    fontFamily: "monospace", fontSize: "12px", whiteSpace: "pre-wrap",
    wordBreak: "break-word", color: "var(--text-secondary)",
    lineHeight: 1.6, maxHeight: "200px", overflow: "auto",
    background: "var(--bg-input)", padding: "10px", borderRadius: "6px",
    marginBottom: "12px",
  },
  variablesList: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" },
  variableChip: {
    display: "inline-block", padding: "3px 10px", borderRadius: "12px",
    fontSize: "12px", fontWeight: 500, background: "var(--accent-bg)",
    color: "var(--accent)", fontFamily: "monospace",
  },
  actions: { display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" },
  testSection: {
    marginTop: "14px", padding: "14px 16px", background: "var(--bg-card)",
    borderRadius: "8px", border: "1px solid var(--accent)" + "40",
  },
  testTitle: { fontSize: "13px", fontWeight: 600, color: "var(--accent)", marginBottom: "10px" },
  testVarRow: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" },
  testVarLabel: { fontSize: "12px", color: "var(--text-secondary)", minWidth: "100px", fontFamily: "monospace" },
  testVarInput: { flex: 1 },
  testResult: {
    marginTop: "12px", padding: "12px", borderRadius: "8px",
    background: "var(--bg-hover)", border: "1px solid var(--border-light)",
    fontSize: "13px", whiteSpace: "pre-wrap", wordBreak: "break-word",
    color: "var(--text-primary)", lineHeight: 1.6,
  },
  formGroup: { marginBottom: "14px" },
  formLabel: { fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: "6px" },
  formTextarea: {
    width: "100%", padding: "10px 12px", borderRadius: "8px",
    border: "1px solid var(--input-border)", background: "var(--bg-input)",
    color: "var(--text-primary)", fontSize: "13px", fontFamily: "monospace",
    resize: "vertical", minHeight: "120px", boxSizing: "border-box", outline: "none",
  },
  formSelect: {
    width: "100%", padding: "8px 12px", borderRadius: "8px",
    border: "1px solid var(--input-border)", background: "var(--bg-input)",
    color: "var(--text-primary)", fontSize: "13px", outline: "none",
    boxSizing: "border-box",
  },
  footer: { color: "var(--text-muted)", fontSize: "10px", textAlign: "center", marginTop: "16px" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractVariables(template: string): string[] {
  const re = /\{\{(\w+)\}\}/g;
  const vars = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    vars.add(m[1]);
  }
  return Array.from(vars);
}

function formatDate(ts: string): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MessageTemplatesPage() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  // Create / Edit modal
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formCategory, setFormCategory] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formVariables, setFormVariables] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Expand
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Test render
  const [testTemplateId, setTestTemplateId] = useState<string | null>(null);
  const [testVars, setTestVars] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<string | null>(null);

  // ─── Data loading ─────────────────────────────────────────────────────────

  const loadTemplates = useCallback(async () => {
    try {
      const data = await templatesApi.list();
      setTemplates(data.templates || []);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTemplates();
    const interval = setInterval(loadTemplates, 15000);
    return () => clearInterval(interval);
  }, [loadTemplates]);

  // ─── Form helpers ──────────────────────────────────────────────────────────

  const resetForm = useCallback(() => {
    setFormName("");
    setFormDesc("");
    setFormCategory("");
    setFormContent("");
    setFormVariables([]);
    setEditingId(null);
  }, []);

  const openCreate = useCallback(() => {
    resetForm();
    setShowModal(true);
  }, [resetForm]);

  const openEdit = useCallback((tpl: MessageTemplate) => {
    setEditingId(tpl.id);
    setFormName(tpl.name);
    setFormDesc(tpl.description || "");
    setFormCategory(tpl.category || "");
    setFormContent(tpl.template);
    setFormVariables(tpl.variables || []);
    setShowModal(true);
  }, []);

  const handleContentChange = useCallback((val: string) => {
    setFormContent(val);
    setFormVariables(extractVariables(val));
  }, []);

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!formName.trim() || !formContent.trim()) {
      showToast("Name and template content are required", "error");
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await templatesApi.update(editingId, {
          name: formName.trim(),
          description: formDesc.trim(),
          category: formCategory.trim(),
          template: formContent,
          variables: formVariables,
        });
        showToast("Template updated", "success");
      } else {
        await templatesApi.create({
          name: formName.trim(),
          description: formDesc.trim(),
          category: formCategory.trim(),
          template: formContent,
          variables: formVariables,
        });
        showToast("Template created", "success");
      }
      setShowModal(false);
      resetForm();
      await loadTemplates();
    } catch {
      showToast("Failed to save template", "error");
    } finally {
      setSaving(false);
    }
  }, [formName, formDesc, formCategory, formContent, formVariables, editingId, resetForm, loadTemplates]);

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm("Are you sure you want to delete this template?")) return;
    try {
      await templatesApi.delete(id);
      showToast("Template deleted", "success");
      setExpandedId(null);
      setTestTemplateId(null);
      await loadTemplates();
    } catch {
      showToast("Failed to delete template", "error");
    }
  }, [loadTemplates]);

  // ─── Test render ──────────────────────────────────────────────────────────

  const startTest = useCallback((tpl: MessageTemplate) => {
    setTestTemplateId(tpl.id);
    const vars: Record<string, string> = {};
    for (const v of tpl.variables || []) {
      vars[v] = "";
    }
    setTestVars(vars);
    setTestResult(null);
  }, []);

  const handleRender = useCallback(async (id: string) => {
    try {
      const data = await templatesApi.render(id, testVars);
      setTestResult(data.rendered);
    } catch {
      showToast("Render failed", "error");
    }
  }, [testVars]);

  // ─── Toggle expand ────────────────────────────────────────────────────────

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
    setTestTemplateId(null);
    setTestResult(null);
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) return <div style={s.container}><Loading text="Loading templates..." /></div>;
  if (error && templates.length === 0) return <div style={s.container}><ErrorBanner message={error} onRetry={loadTemplates} /></div>;

  return (
    <div style={s.container}>
      <PageHeader
        title="Message Templates"
        subtitle="Create and manage reusable message templates"
        actions={
          <PrimaryButton onClick={openCreate}>+ Create Template</PrimaryButton>
        }
      />

      {templates.length === 0 ? (
        <Card>
          <EmptyState title="No templates" description="Create your first message template to get started." />
        </Card>
      ) : (
        templates.map((tpl) => {
          const isExpanded = expandedId === tpl.id;
          const isTesting = testTemplateId === tpl.id;
          const varCount = (tpl.variables || []).length;

          return (
            <div key={tpl.id} style={s.templateCard} onClick={() => !isExpanded && toggleExpand(tpl.id)}>
              <div style={s.templateHeader}>
                <div>
                  <div style={s.templateName}>{tpl.name}</div>
                  <div style={s.templateDesc}>{tpl.description || "No description"}</div>
                </div>
                <Badge variant="info">{tpl.category || "Uncategorized"}</Badge>
              </div>
              <div style={s.templateMeta}>
                <span style={s.metaValue}>
                  <span style={s.metaLabel}>Variables: </span>{varCount}
                </span>
                <span style={s.metaValue}>
                  <span style={s.metaLabel}>Created: </span>{formatDate(tpl.createdAt)}
                </span>
              </div>

              {/* Expanded view */}
              {isExpanded && (
                <div style={s.expandedSection} onClick={(e) => e.stopPropagation()}>
                  <Section title="Template Content">
                    <div style={s.contentPreview}>{tpl.template}</div>
                  </Section>

                  {varCount > 0 && (
                    <Section title="Variables">
                      <div style={s.variablesList}>
                        {(tpl.variables || []).map((v) => (
                          <span key={v} style={s.variableChip}>{`{{${v}}}`}</span>
                        ))}
                      </div>
                    </Section>
                  )}

                  <div style={s.actions}>
                    <SecondaryButton small onClick={() => openEdit(tpl)}>Edit</SecondaryButton>
                    <SecondaryButton small onClick={() => startTest(tpl)}>Test Render</SecondaryButton>
                    <GhostButton small onClick={() => handleDelete(tpl.id)} style={{ color: "var(--error)" }}>Delete</GhostButton>
                  </div>

                  {/* Test Render Section */}
                  {isTesting && (
                    <div style={s.testSection}>
                      <div style={s.testTitle}>Test Render</div>
                      {(tpl.variables || []).map((v) => (
                        <div key={v} style={s.testVarRow}>
                          <span style={s.testVarLabel}>{`{{${v}}}`}</span>
                          <div style={s.testVarInput}>
                            <TextInput
                              value={testVars[v] || ""}
                              onChange={(val) => setTestVars((prev) => ({ ...prev, [v]: val }))}
                              placeholder={`Value for ${v}...`}
                            />
                          </div>
                        </div>
                      ))}
                      <div style={{ marginTop: "10px" }}>
                        <PrimaryButton small onClick={() => handleRender(tpl.id)}>Render</PrimaryButton>
                      </div>
                      {testResult !== null && (
                        <div style={s.testResult}>{testResult || "(empty result)"}</div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}

      {/* Create / Edit Modal */}
      {showModal && (
        <Modal
          title={editingId ? "Edit Template" : "Create Template"}
          onClose={() => setShowModal(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setShowModal(false)}>Cancel</SecondaryButton>
              <PrimaryButton onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : editingId ? "Update" : "Create"}
              </PrimaryButton>
            </>
          }
        >
          <div style={s.formGroup}>
            <label style={s.formLabel}>Name</label>
            <TextInput value={formName} onChange={setFormName} placeholder="Template name..." />
          </div>
          <div style={s.formGroup}>
            <label style={s.formLabel}>Description</label>
            <TextInput value={formDesc} onChange={setFormDesc} placeholder="Brief description..." />
          </div>
          <div style={s.formGroup}>
            <label style={s.formLabel}>Category</label>
            <TextInput value={formCategory} onChange={setFormCategory} placeholder="e.g. greeting, notification..." />
          </div>
          <div style={s.formGroup}>
            <label style={s.formLabel}>Template Content</label>
            <textarea
              style={s.formTextarea}
              value={formContent}
              onChange={(e) => handleContentChange(e.target.value)}
              placeholder="Enter template with {{variables}}..."
            />
          </div>
          <div style={s.formGroup}>
            <label style={s.formLabel}>Detected Variables</label>
            {formVariables.length > 0 ? (
              <div style={s.variablesList}>
                {formVariables.map((v) => (
                  <span key={v} style={s.variableChip}>{`{{${v}}}`}</span>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>No variables detected. Use {"{{variableName}}"} in your template.</div>
            )}
          </div>
        </Modal>
      )}

      <div style={s.footer}>
        Auto-refreshing every 15 seconds &middot; {templates.length} templates
      </div>
    </div>
  );
}