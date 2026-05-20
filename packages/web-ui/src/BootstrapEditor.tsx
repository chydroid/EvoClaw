import React, { useState, useEffect, useCallback } from "react";

interface BootstrapFileEntry {
  path: string;
  content: string;
  editable: boolean;
  exists: boolean;
}

const FILES = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"];

const FILE_META: Record<string, { label: string; icon: string; description: string }> = {
  "AGENTS.md": { label: "AGENTS.md", icon: "🤖", description: "Operating instructions and memory — how the agent should behave" },
  "SOUL.md": { label: "SOUL.md", icon: "💫", description: "Persona, tone, and boundaries — defines the agent's character" },
  "TOOLS.md": { label: "TOOLS.md", icon: "🔧", description: "Tool usage notes — user-maintained guidance on tools" },
  "IDENTITY.md": { label: "IDENTITY.md", icon: "🆔", description: "Identity card — agent name, vibe, and emoji" },
};

const s = {
  container: { padding: "20px", overflow: "auto", height: "100%", display: "flex", flexDirection: "column" as const } as React.CSSProperties,
  header: { display: "flex", gap: "12px", marginBottom: "16px", flexShrink: 0 } as React.CSSProperties,
  fileTab: (active: boolean): React.CSSProperties => ({
    padding: "8px 16px", borderRadius: "8px", border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: active ? "var(--accent-bg)" : "var(--bg-card)",
    color: active ? "var(--accent)" : "var(--text-primary)",
    cursor: "pointer", fontSize: "13px", fontWeight: active ? "bold" : "normal",
    display: "flex", alignItems: "center", gap: "6px",
    transition: "all 0.15s",
  }),
  editorPane: {
    flex: 1, display: "flex", flexDirection: "column" as const,
    background: "var(--bg-card)", border: "1px solid var(--border)",
    borderRadius: "10px", overflow: "hidden",
  },
  editorToolbar: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "10px 16px", borderBottom: "1px solid var(--border)",
    background: "var(--tab-bg)",
  } as React.CSSProperties,
  editorTitle: { fontSize: "14px", fontWeight: "bold", color: "var(--text-primary)" } as React.CSSProperties,
  editorDesc: { fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" } as React.CSSProperties,
  textarea: {
    flex: 1, padding: "16px", border: "none",
    background: "var(--bg-primary)", color: "var(--text-primary)",
    fontSize: "13px", fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
    lineHeight: "1.6", resize: "none" as const,
    outline: "none", tabSize: 2,
  },
  btnGroup: { display: "flex", gap: "8px" } as React.CSSProperties,
  saveBtn: {
    padding: "7px 16px", borderRadius: "6px", border: "none",
    background: "var(--accent)", color: "#fff", cursor: "pointer",
    fontSize: "13px", fontWeight: "bold",
  } as React.CSSProperties,
  resetBtn: {
    padding: "7px 16px", borderRadius: "6px", border: "1px solid var(--border)",
    background: "transparent", color: "var(--text-primary)", cursor: "pointer",
    fontSize: "13px",
  } as React.CSSProperties,
  status: { fontSize: "12px", padding: "4px 10px", borderRadius: "4px", background: "var(--bg-input)" } as React.CSSProperties,
  successBanner: {
    padding: "8px 14px", borderRadius: "6px",
    background: "#22c55e18", border: "1px solid #22c55e40",
    color: "var(--success)", fontSize: "12px", marginBottom: "8px",
  } as React.CSSProperties,
  readOnlyBadge: {
    display: "inline-block", padding: "2px 8px", borderRadius: "4px",
    background: "#f59e0b18", border: "1px solid #f59e0b40",
    color: "var(--warning)", fontSize: "10px", fontWeight: "bold",
  } as React.CSSProperties,
};

export default function BootstrapEditor() {
  const [files, setFiles] = useState<Record<string, BootstrapFileEntry>>({});
  const [activeFile, setActiveFile] = useState<string>(FILES[0]);
  const [editContent, setEditContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    const result: Record<string, BootstrapFileEntry> = {};
    for (const file of FILES) {
      try {
        const res = await fetch(`/api/system/bootstrap-file/${file}`);
        if (res.ok) {
          const data = await res.json() as { path: string; content: string; editable: boolean };
          result[file] = { ...data, exists: true };
        } else {
          result[file] = { path: file, content: "", editable: false, exists: false };
        }
      } catch {
        result[file] = { path: file, content: "", editable: false, exists: false };
      }
    }
    setFiles(result);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    if (files[activeFile]) {
      setEditContent(files[activeFile].content);
      setDirty(false);
      setSaveStatus(null);
    }
  }, [activeFile, files]);

  async function handleSave() {
    const file = files[activeFile];
    if (!file || !file.editable) return;

    setSaving(true);
    setSaveStatus(null);
    try {
      const res = await fetch(`/api/system/bootstrap-file/${activeFile}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      if (res.ok) {
        files[activeFile] = { ...file, content: editContent };
        setFiles({ ...files, [activeFile]: { ...file, content: editContent } });
        setDirty(false);
        setSaveStatus("Saved successfully! Agent will pick up changes on next system prompt build.");
      } else {
        const err = await res.text();
        setSaveStatus(`Save failed: ${err.slice(0, 100)}`);
      }
    } catch (err) {
      setSaveStatus(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
    setSaving(false);

    if (saveStatus) {
      setTimeout(() => setSaveStatus(null), 5000);
    }
  }

  function handleReset() {
    setEditContent(files[activeFile]?.content || "");
    setDirty(false);
  }

  const currentFile = files[activeFile];
  const meta = FILE_META[activeFile] || { label: activeFile, icon: "📄", description: "" };

  if (loading) {
    return (
      <div style={s.container}>
        <div style={{ textAlign: "center", padding: "60px", color: "var(--text-muted)" }}>
          Loading bootstrap files...
        </div>
      </div>
    );
  }

  return (
    <div style={s.container}>
      <div style={s.header}>
        {FILES.map((f) => (
          <button
            key={f}
            style={s.fileTab(activeFile === f)}
            onClick={() => setActiveFile(f)}
          >
            <span>{FILE_META[f]?.icon || "📄"}</span>
            <span>{FILE_META[f]?.label || f}</span>
          </button>
        ))}
      </div>

      <div style={s.editorPane}>
        <div style={s.editorToolbar}>
          <div>
            <div style={s.editorTitle}>
              {meta.icon} {meta.label}
              {currentFile && !currentFile.editable && currentFile.exists && (
                <span style={{ ...s.readOnlyBadge, marginLeft: "8px" }}>Read-only</span>
              )}
              {currentFile && !currentFile.exists && (
                <span style={{ ...s.readOnlyBadge, marginLeft: "8px" }}>Not found</span>
              )}
            </div>
            <div style={s.editorDesc}>{meta.description}</div>
          </div>
          <div style={s.btnGroup}>
            <button style={s.resetBtn} onClick={handleReset} disabled={!dirty}>
              Reset
            </button>
            <button
              style={s.saveBtn}
              onClick={handleSave}
              disabled={!dirty || !currentFile?.editable || saving}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>

        {saveStatus && (
          <div style={{ padding: "0 16px", marginTop: "8px" }}>
            <div style={{
              ...s.successBanner,
              ...(saveStatus.startsWith("Error") || saveStatus.startsWith("Save failed")
                ? { background: "#ef444418", border: "1px solid #ef444440", color: "var(--error)" }
                : {}),
            }}>
              {saveStatus}
            </div>
          </div>
        )}

        <textarea
          style={s.textarea}
          value={editContent}
          onChange={(e) => { setEditContent(e.target.value); setDirty(true); }}
          placeholder={currentFile?.editable === false
            ? "This file does not exist or is not editable"
            : "# Enter your content here..."}
          readOnly={currentFile?.editable === false}
        />

        <div style={{ padding: "6px 16px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--text-muted)" }}>
          <span>{editContent.split("\n").length} lines · {editContent.length} chars</span>
          <span>{dirty ? "Unsaved changes" : "No changes"}</span>
        </div>
      </div>
    </div>
  );
}