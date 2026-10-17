import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "./i18n";

interface TemplateInfo {
  name: string;
  template: unknown;
}

interface Section {
  id: string;
  title: string;
  type: "text" | "table" | "chart" | "list" | "metrics" | "html";
  content: string;
  tableJson: string;
  listItems: string;
  metricsJson: string;
}

const SECTION_TYPES: Section["type"][] = ["text", "table", "list", "metrics", "chart", "html"];

const s: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" },
  title: { color: "var(--section-title-color)", fontSize: "18px", fontWeight: "bold" },
  subtitle: { color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" },
  addBtn: {
    padding: "8px 16px", borderRadius: "6px", border: "none", cursor: "pointer",
    background: "var(--accent)", color: "#fff", fontSize: "12px", fontWeight: "bold",
  },
  actionBtn: {
    padding: "4px 12px", borderRadius: "4px", border: "1px solid var(--border-light)", cursor: "pointer",
    background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: "11px",
  },
  dangerBtn: {
    padding: "4px 12px", borderRadius: "4px", border: "1px solid var(--error)", cursor: "pointer",
    background: "transparent", color: "var(--error)", fontSize: "11px",
  },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", alignItems: "start" },
  card: {
    background: "var(--bg-card)", borderRadius: "8px", padding: "16px", border: "1px solid var(--border-light)", marginBottom: "12px",
  },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" },
  cardTitle: { color: "var(--text-primary)", fontSize: "14px", fontWeight: "bold" },
  field: { marginBottom: "14px" },
  label: { color: "var(--text-secondary)", fontSize: "12px", fontWeight: "bold", marginBottom: "4px", display: "block" },
  input: {
    width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border-light)",
    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: "13px", boxSizing: "border-box" as const,
  },
  textarea: {
    width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border-light)",
    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: "13px", boxSizing: "border-box" as const,
    resize: "vertical" as const, fontFamily: "inherit", minHeight: "60px",
  },
  select: {
    width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border-light)",
    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: "13px",
  },
  helpText: { color: "var(--text-muted)", fontSize: "10px", marginTop: "4px" },
  empty: { color: "var(--text-muted)", fontSize: "13px", padding: "40px", textAlign: "center" as const },
  msg: {
    padding: "8px 14px", borderRadius: "6px", marginBottom: "12px", fontSize: "12px",
  },
  resultBox: {
    background: "var(--bg-input)", borderRadius: "6px", padding: "14px", border: "1px solid var(--border-light)",
    whiteSpace: "pre-wrap" as const, fontSize: "12px", color: "var(--text-primary)", maxHeight: "50vh", overflow: "auto",
  },
  templateGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "8px" },
  templateCard: {
    padding: "12px", borderRadius: "6px", border: "1px solid var(--border-light)", cursor: "pointer",
    background: "var(--bg-hover)",
  },
  templateName: { color: "var(--text-primary)", fontSize: "13px", fontWeight: "bold" },
};

export function ReportingPage() {
  const { t, lang } = useTranslation();
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [footer, setFooter] = useState("");
  const [sections, setSections] = useState<Section[]>([]);
  const [result, setResult] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [generating, setGenerating] = useState(false);

  const loadTemplates = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/reporting/templates", { signal });
      if (signal?.aborted) return;
      if (res.ok) {
        const d = await res.json();
        setTemplates(Array.isArray(d.templates) ? d.templates : []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadTemplates(controller.signal);
    return () => controller.abort();
  }, [loadTemplates]);

  const addSection = () => {
    setSections((prev) => [...prev, { id: `sec-${Date.now()}-${prev.length}`, title: "", type: "text", content: "", tableJson: "", listItems: "", metricsJson: "" }]);
  };

  const updateSection = (id: string, patch: Partial<Section>) => {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const removeSection = (id: string) => {
    setSections((prev) => prev.filter((s) => s.id !== id));
  };

  const buildReportData = (): Record<string, unknown> => {
    const secs = sections.map((s) => {
      const sec: Record<string, unknown> = { id: s.id, title: s.title || t("reporting.untitled"), type: s.type };
      if (s.type === "text" || s.type === "html") sec.content = s.content;
      if (s.type === "table") {
        try { sec.tableData = JSON.parse(s.tableJson || '{"headers":[],"rows":[]}'); } catch { sec.tableData = { headers: [], rows: [] }; }
      }
      if (s.type === "list") {
        sec.listItems = s.listItems.split("\n").map((x) => x.trim()).filter(Boolean);
      }
      if (s.type === "metrics") {
        try { sec.metrics = JSON.parse(s.metricsJson || '[]'); } catch { sec.metrics = []; }
      }
      return sec;
    });
    const data: Record<string, unknown> = { title: title || t("reporting.untitled"), generatedAt: new Date().toISOString(), sections: secs };
    if (summary.trim()) data.summary = { totalItems: secs.length, highlights: [summary.trim()] };
    if (footer.trim()) data.footer = footer.trim();
    return data;
  };

  const generate = async () => {
    if (sections.length === 0) {
      setMessage(t("reporting.no_sections_msg"));
      setError(true);
      return;
    }
    setGenerating(true);
    setMessage("");
    setResult("");
    try {
      const res = await fetch("/api/reporting/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: buildReportData() }),
      });
      if (res.ok) {
        const d = await res.json();
        setResult(String(d.report || ""));
        setMessage(t("reporting.generated_ok"));
        setError(false);
      } else {
        const d = await res.json().catch(() => ({}));
        setMessage(`${t("reporting.generated_fail")}: ${d.error || res.statusText}`);
        setError(true);
      }
    } catch {
      setMessage(t("reporting.network_error"));
      setError(true);
    }
    setGenerating(false);
  };

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div>
          <div style={s.title}>{t("reporting.title")}</div>
          <div style={s.subtitle}>{t("reporting.subtitle")}</div>
        </div>
        <button style={s.addBtn} onClick={generate} disabled={generating}>
          {generating ? t("reporting.generating") : t("reporting.generate")}
        </button>
      </div>

      {message && (
        <div style={{ ...s.msg, background: error ? "var(--error-bg)" : "var(--success-bg)", color: error ? "var(--error)" : "var(--success)" }}>
          {message}
        </div>
      )}

      <div style={s.grid}>
        {/* Left: form */}
        <div>
          <div style={s.card}>
            <div style={s.cardTitle}>{t("reporting.templates")}</div>
            {templates.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>{t("reporting.empty_templates")}</div>
            ) : (
              <div style={s.templateGrid}>
                {templates.map((tpl, i) => (
                  <div key={i} style={s.templateCard} title={t("reporting.use_template")}>
                    <div style={s.templateName}>{tpl.name}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={s.card}>
            <div style={s.cardTitle}>{t("reporting.basic")}</div>
            <div style={s.field}>
              <label style={s.label}>{t("reporting.report_title")}</label>
              <input style={s.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("reporting.report_title_ph")} />
            </div>
            <div style={s.field}>
              <label style={s.label}>{t("reporting.summary")}</label>
              <input style={s.input} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={t("reporting.summary_ph")} />
            </div>
            <div style={s.field}>
              <label style={s.label}>{t("reporting.footer")}</label>
              <input style={s.input} value={footer} onChange={(e) => setFooter(e.target.value)} placeholder={t("reporting.footer_ph")} />
            </div>
          </div>

          <div style={s.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <div style={s.cardTitle}>{t("reporting.sections")}</div>
              <button style={s.actionBtn} onClick={addSection}>＋ {t("reporting.add_section")}</button>
            </div>
            {sections.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>{t("reporting.empty_sections")}</div>
            ) : sections.map((sec) => (
              <div key={sec.id} style={{ ...s.card, padding: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                  <select style={{ ...s.select, width: "auto", minWidth: "100px" }} value={sec.type}
                    onChange={(e) => updateSection(sec.id, { type: e.target.value as Section["type"] })}>
                    {SECTION_TYPES.map((tp) => <option key={tp} value={tp}>{t(`reporting.type_${tp}`)}</option>)}
                  </select>
                  <button style={s.dangerBtn} onClick={() => removeSection(sec.id)}>{t("reporting.remove")}</button>
                </div>
                <div style={s.field}>
                  <label style={s.label}>{t("reporting.section_title")}</label>
                  <input style={s.input} value={sec.title} onChange={(e) => updateSection(sec.id, { title: e.target.value })} placeholder={t("reporting.section_title_ph")} />
                </div>
                {(sec.type === "text" || sec.type === "html") && (
                  <div style={s.field}>
                    <label style={s.label}>{t("reporting.section_content")}</label>
                    <textarea style={s.textarea} value={sec.content} onChange={(e) => updateSection(sec.id, { content: e.target.value })} placeholder={t("reporting.section_content_ph")} />
                  </div>
                )}
                {sec.type === "table" && (
                  <div style={s.field}>
                    <label style={s.label}>{t("reporting.table_json")}</label>
                    <textarea style={{ ...s.textarea, minHeight: "80px", fontFamily: "monospace", fontSize: "11px" }} value={sec.tableJson} onChange={(e) => updateSection(sec.id, { tableJson: e.target.value })} placeholder={'{"headers":["列1","列2"],"rows":[["a","b"]]}'} />
                    <div style={s.helpText}>{t("reporting.table_help")}</div>
                  </div>
                )}
                {sec.type === "list" && (
                  <div style={s.field}>
                    <label style={s.label}>{t("reporting.list_items")}</label>
                    <textarea style={s.textarea} value={sec.listItems} onChange={(e) => updateSection(sec.id, { listItems: e.target.value })} placeholder={t("reporting.list_items_ph")} />
                  </div>
                )}
                {sec.type === "metrics" && (
                  <div style={s.field}>
                    <label style={s.label}>{t("reporting.metrics_json")}</label>
                    <textarea style={{ ...s.textarea, minHeight: "80px", fontFamily: "monospace", fontSize: "11px" }} value={sec.metricsJson} onChange={(e) => updateSection(sec.id, { metricsJson: e.target.value })} placeholder={'[{"label":"指标","value":"100"}]'} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Right: result */}
        <div style={s.card}>
          <div style={s.cardTitle}>{t("reporting.result")}</div>
          {result ? (
            <div style={s.resultBox}>{result}</div>
          ) : (
            <div style={s.empty}>{t("reporting.result_hint")}</div>
          )}
        </div>
      </div>
    </div>
  );
}