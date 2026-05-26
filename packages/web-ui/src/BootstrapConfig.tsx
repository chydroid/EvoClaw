import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "./i18n";

interface BootstrapFile {
  name: string;
  description: string;
  content: string;
  exists: boolean;
}

interface BootstrapData {
  files: BootstrapFile[];
  pending: boolean;
  missingFiles: string[];
  workspacePath: string;
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" },
  title: { color: "var(--section-title-color)", fontSize: "18px", fontWeight: "bold" },
  subtitle: { color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" },
  pendingBanner: {
    background: "var(--warning-bg)", border: "1px solid var(--warning)",
    padding: "12px", borderRadius: "6px", marginBottom: "16px", color: "var(--warning)",
    fontSize: "13px", fontWeight: "bold",
  },
  fileSelector: { display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" as const },
  editorSection: { background: "var(--bg-sidebar)", borderRadius: "8px", padding: "16px", border: "1px solid var(--border-light)" },
  editorHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" },
  editorTitle: { color: "var(--text-primary)", fontSize: "14px", fontWeight: "bold" },
  editorDesc: { color: "var(--text-muted)", fontSize: "11px", marginTop: "2px" },
  textarea: {
    width: "100%", minHeight: "400px", background: "var(--bg-primary)", color: "var(--text-primary)",
    border: "1px solid var(--border-light)", borderRadius: "4px", padding: "12px",
    fontSize: "13px", fontFamily: "Consolas, Monaco, monospace", resize: "vertical",
  },
  buttonRow: { display: "flex", gap: "8px", marginTop: "12px" },
  saveBtn: { background: "var(--accent)", color: "#fff", border: "none", padding: "8px 16px", borderRadius: "4px", cursor: "pointer", fontSize: "12px", fontWeight: "bold" },
  resetBtn: { background: "var(--bg-hover)", color: "var(--text-secondary)", border: "1px solid var(--border-light)", padding: "8px 16px", borderRadius: "4px", cursor: "pointer", fontSize: "12px" },
  info: { color: "var(--text-muted)", fontSize: "11px", marginTop: "8px" },
  success: { color: "var(--success)", fontSize: "12px", marginTop: "8px" },
};

const fileTabStyle = (active: boolean): React.CSSProperties => ({
  padding: "8px 16px", borderRadius: "6px", border: "1px solid var(--border-light)",
  background: active ? "var(--accent-bg)" : "var(--bg-sidebar)", color: active ? "var(--accent)" : "var(--text-secondary)",
  cursor: "pointer", fontSize: "12px", fontWeight: active ? "bold" : "normal",
  transition: "all 0.15s",
});

export function BootstrapConfig() {
  const { t, lang } = useTranslation();
  const [data, setData] = useState<BootstrapData | null>(null);
  const [selectedFile, setSelectedFile] = useState("AGENTS.md");
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const loadFiles = useCallback(async () => {
    try {
      const res = await fetch("/api/bootstrap");
      const json = await res.json();
      setData(json);
      if (json.files?.length > 0) {
        const current = json.files.find((f: BootstrapFile) => f.name === selectedFile);
        if (current) {
          setContent(current.content);
          setOriginalContent(current.content);
        }
      }
    } catch (err) {
      console.error("Failed to load bootstrap files:", err);
    } finally {
      setLoading(false);
    }
  }, [selectedFile]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const selectFile = (name: string) => {
    setSelectedFile(name);
    setMessage("");
    if (data) {
      const file = data.files.find((f) => f.name === name);
      if (file) {
        setContent(file.content);
        setOriginalContent(file.content);
      }
    }
  };

  const saveFile = async () => {
    try {
      const res = await fetch(`/api/bootstrap/${selectedFile}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const json = await res.json();
      if (json.success) {
        setOriginalContent(content);
        setMessage(t("bootstrap.saved_ok") + selectedFile);
        setTimeout(() => setMessage(""), 3000);
        loadFiles();
      } else {
        setMessage(t("bootstrap.save_fail") + (json.error || t("bootstrap.unknown_error")));
      }
    } catch (err) {
      setMessage(t("bootstrap.save_fail") + String(err));
    }
  };

  const completeBootstrap = async () => {
    try {
      const res = await fetch("/api/bootstrap/complete", { method: "POST" });
      const json = await res.json();
      setMessage(json.message || "Bootstrap ritual completed");
      loadFiles();
    } catch (err) {
      setMessage(t("bootstrap.op_fail") + String(err));
    }
  };

  const isDirty = content !== originalContent;
  const isErrorMsg = lang === "zh"
    ? message.includes("失败") || message.includes("错误")
    : /fail|error/i.test(message);

  if (loading) return <div style={styles.container}><div style={{ color: "var(--text-muted)" }}>{t("bootstrap.loading")}</div></div>;

  const currentFile = data?.files?.find((f) => f.name === selectedFile);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <div style={styles.title}>{t("bootstrap.title")}</div>
          <div style={styles.subtitle}>
            {t("bootstrap.subtitle_prefix")}{data?.workspacePath || "data/workspace"}
          </div>
        </div>
      </div>

      {data?.pending && (
        <div style={styles.pendingBanner}>
          {t("bootstrap.pending_banner")}
        </div>
      )}

      {data?.missingFiles && data.missingFiles.length > 0 && (
        <div style={{ ...styles.pendingBanner, background: "var(--error-bg)", color: "var(--error)", borderColor: "var(--error)" }}>
          {t("bootstrap.missing_files")}{data.missingFiles.join(", ")}
        </div>
      )}

      <div style={styles.fileSelector}>
        {(data?.files || []).map((f) => (
          <div
            key={f.name}
            style={fileTabStyle(f.name === selectedFile)}
            onClick={() => selectFile(f.name)}
          >
            {f.name}
            {!f.exists ? t("bootstrap.missing_suffix") : ""}
          </div>
        ))}
      </div>

      {currentFile && (
        <div style={styles.editorSection}>
          <div style={styles.editorHeader}>
            <div>
              <div style={styles.editorTitle}>{currentFile.name}</div>
              <div style={styles.editorDesc}>{currentFile.description}</div>
            </div>
            {data?.pending && currentFile.name === "BOOTSTRAP.md" && (
              <button style={{ background: "var(--warning)", color: "#000", border: "none", padding: "8px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "12px", fontWeight: "bold" }} onClick={completeBootstrap}>
                {t("bootstrap.complete_btn")}
              </button>
            )}
          </div>
          <textarea
            style={styles.textarea}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
          />
          <div style={styles.buttonRow}>
            <button style={styles.saveBtn} onClick={saveFile} disabled={!isDirty}>
              {isDirty ? t("bootstrap.save_changes") : t("bootstrap.saved")}
            </button>
            <button style={styles.resetBtn} onClick={() => setContent(originalContent)} disabled={!isDirty}>
              {t("bootstrap.undo")}
            </button>
          </div>
          {message && (
            <div style={isErrorMsg ? { ...styles.info, color: "var(--error)" } : styles.success}>
              {message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}