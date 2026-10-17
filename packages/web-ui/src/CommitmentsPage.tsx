import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "./i18n";

interface Commitment {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "dismissed";
  sessionId?: string;
  agentId?: string;
  createdAt: number;
  updatedAt?: number;
  deadline?: number;
  tags?: string[];
}

interface Summary {
  total: number;
  pending: number;
  inProgress: number;
  overdue: number;
}

const statusBadgeStyle = (status: Commitment["status"]): React.CSSProperties => {
  const map: Record<string, { bg: string; fg: string }> = {
    pending: { bg: "var(--bg-hover)", fg: "var(--text-muted)" },
    in_progress: { bg: "var(--accent-bg)", fg: "var(--accent)" },
    completed: { bg: "var(--success-bg)", fg: "var(--success)" },
    dismissed: { bg: "var(--error-bg)", fg: "var(--error)" },
  };
  const c = map[status] || map.pending;
  return {
    display: "inline-block", padding: "2px 10px", borderRadius: "10px", fontSize: "10px", fontWeight: "bold",
    background: c.bg, color: c.fg,
  };
};

const s: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" },
  title: { color: "var(--section-title-color)", fontSize: "18px", fontWeight: "bold" },
  subtitle: { color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" },
  addBtn: {
    padding: "8px 16px", borderRadius: "6px", border: "none", cursor: "pointer",
    background: "var(--accent)", color: "#fff", fontSize: "12px", fontWeight: "bold",
  },
  summaryRow: { display: "flex", gap: "12px", flexWrap: "wrap" as const, marginBottom: "16px" },
  statCard: {
    flex: 1, minWidth: "120px", background: "var(--bg-card)", borderRadius: "8px", padding: "12px 16px",
    border: "1px solid var(--border-light)",
  },
  statLabel: { color: "var(--text-muted)", fontSize: "11px", textTransform: "uppercase" as const, letterSpacing: "0.5px" },
  statValue: { color: "var(--text-primary)", fontSize: "22px", fontWeight: "bold", marginTop: "4px" },
  card: {
    background: "var(--bg-card)", borderRadius: "8px", padding: "16px", border: "1px solid var(--border-light)", marginBottom: "12px",
  },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" },
  cardDesc: { color: "var(--text-primary)", fontSize: "13px", lineHeight: "1.5" },
  metaRow: { display: "flex", gap: "16px", marginTop: "10px", flexWrap: "wrap" as const, fontSize: "11px" },
  metaItem: { color: "var(--text-muted)" },
  metaValue: { color: "var(--text-secondary)" },
  tags: { display: "flex", gap: "4px", flexWrap: "wrap" as const, marginTop: "8px" },
  tag: {
    display: "inline-block", padding: "1px 8px", borderRadius: "4px", fontSize: "10px",
    background: "var(--bg-hover)", color: "var(--text-secondary)",
  },
  actionBtns: { display: "flex", gap: "6px", marginTop: "10px" },
  actionBtn: {
    padding: "4px 12px", borderRadius: "4px", border: "1px solid var(--border-light)", cursor: "pointer",
    background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: "11px",
  },
  dangerBtn: {
    padding: "4px 12px", borderRadius: "4px", border: "1px solid var(--error)", cursor: "pointer",
    background: "transparent", color: "var(--error)", fontSize: "11px",
  },
  modal: {
    position: "fixed" as const, top: 0, left: 0, right: 0, bottom: 0,
    background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
  },
  modalCard: {
    background: "var(--bg-card)", borderRadius: "12px", padding: "24px", border: "1px solid var(--border-light)",
    maxWidth: "520px", width: "90%", maxHeight: "80vh", overflow: "auto",
  },
  modalTitle: { color: "var(--text-primary)", fontSize: "16px", fontWeight: "bold", marginBottom: "16px" },
  field: { marginBottom: "14px" },
  label: { color: "var(--text-secondary)", fontSize: "12px", fontWeight: "bold", marginBottom: "4px", display: "block" },
  input: {
    width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border-light)",
    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: "13px", boxSizing: "border-box" as const,
  },
  empty: { color: "var(--text-muted)", fontSize: "13px", padding: "40px", textAlign: "center" as const },
  msg: {
    padding: "8px 14px", borderRadius: "6px", marginBottom: "12px", fontSize: "12px",
  },
};

export function CommitmentsPage() {
  const { t, lang } = useTranslation();
  const [items, setItems] = useState<Commitment[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [desc, setDesc] = useState("");
  const [deadline, setDeadline] = useState("");
  const [tags, setTags] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [listRes, sumRes] = await Promise.all([
        fetch("/api/commitments", { signal }),
        fetch("/api/commitments/summary", { signal }),
      ]);
      if (signal?.aborted) return;
      if (listRes.ok) {
        const d = await listRes.json();
        setItems(Array.isArray(d.commitments) ? d.commitments : []);
      }
      if (sumRes.ok) {
        const d = await sumRes.json();
        setSummary(d as Summary);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    const interval = setInterval(() => load(controller.signal), 15000);
    return () => { clearInterval(interval); controller.abort(); };
  }, [load]);

  const create = async () => {
    if (!desc.trim()) { setMessage(t("commitments.desc_required")); setError(true); return; }
    try {
      const body: Record<string, unknown> = { description: desc.trim() };
      if (deadline.trim()) {
        const n = Number(deadline.trim());
        body.deadline = Number.isFinite(n) ? n : Date.parse(deadline.trim());
      }
      if (tags.trim()) body.tags = tags.split(",").map((x) => x.trim()).filter(Boolean);
      const res = await fetch("/api/commitments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setMessage(t("commitments.created_ok"));
        setDesc(""); setDeadline(""); setTags("");
        setShowModal(false);
        load();
      } else {
        const d = await res.json().catch(() => ({}));
        setMessage(`${t("commitments.create_fail")}: ${d.error || res.statusText}`);
        setError(true);
      }
    } catch {
      setMessage(t("commitments.network_error"));
      setError(true);
    }
  };

  const dismiss = async (id: string) => {
    if (!confirm(t("commitments.confirm_dismiss"))) return;
    try {
      const res = await fetch(`/api/commitments/${id}/dismiss`, { method: "POST" });
      if (res.ok) {
        setMessage(t("commitments.dismissed_ok"));
        load();
      } else {
        const d = await res.json().catch(() => ({}));
        setMessage(`${t("commitments.dismiss_fail")}: ${d.error || res.statusText}`);
        setError(true);
      }
    } catch {
      setMessage(t("commitments.network_error"));
      setError(true);
    }
  };

  const fmtDeadline = (ts?: number) => {
    if (!ts) return t("commitments.no_deadline");
    const d = new Date(ts);
    const now = new Date();
    const diff = (d.getTime() - now.getTime()) / 86400000;
    const rel = diff < 0 ? t("commitments.overdue_ago") : diff < 1 ? t("commitments.today") : t("commitments.in_days").replace("{0}", String(Math.ceil(diff)));
    return `${d.toLocaleDateString()} (${rel})`;
  };

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div>
          <div style={s.title}>{t("commitments.title")}</div>
          <div style={s.subtitle}>{t("commitments.subtitle")}</div>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button style={s.actionBtn} onClick={() => load()}>{t("commitments.refresh")}</button>
          <button style={s.addBtn} onClick={() => setShowModal(true)}>＋ {t("commitments.new")}</button>
        </div>
      </div>

      {message && (
        <div style={{ ...s.msg, background: error ? "var(--error-bg)" : "var(--success-bg)", color: error ? "var(--error)" : "var(--success)" }}>
          {message}
        </div>
      )}

      {summary && (
        <div style={s.summaryRow}>
          <div style={s.statCard}>
            <div style={s.statLabel}>{t("commitments.total")}</div>
            <div style={s.statValue}>{summary.total}</div>
          </div>
          <div style={s.statCard}>
            <div style={s.statLabel}>{t("commitments.pending")}</div>
            <div style={s.statValue}>{summary.pending}</div>
          </div>
          <div style={s.statCard}>
            <div style={s.statLabel}>{t("commitments.in_progress")}</div>
            <div style={s.statValue}>{summary.inProgress}</div>
          </div>
          <div style={s.statCard}>
            <div style={s.statLabel}>{t("commitments.overdue_count")}</div>
            <div style={{ ...s.statValue, color: summary.overdue > 0 ? "var(--error)" : "var(--text-primary)" }}>{summary.overdue}</div>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div style={s.empty}>{t("commitments.empty")}<br /><span style={{ fontSize: "11px" }}>{t("commitments.empty_hint")}</span></div>
      ) : (
        items.map((c) => (
          <div key={c.id} style={s.card}>
            <div style={s.cardHeader}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" as const }}>
                  <span style={statusBadgeStyle(c.status)}>{t(`commitments.status_${c.status}`)}</span>
                  {c.deadline && c.deadline < Date.now() && c.status !== "completed" && c.status !== "dismissed" && (
                    <span style={{ color: "var(--error)", fontSize: "10px", fontWeight: "bold" }}>{t("commitments.overdue")}</span>
                  )}
                </div>
                <div style={s.cardDesc}>{c.description}</div>
              </div>
            </div>
            <div style={s.metaRow}>
              <span style={s.metaItem}>{t("commitments.id")}: <span style={s.metaValue}>{c.id}</span></span>
              <span style={s.metaItem}>{t("commitments.deadline")}: <span style={s.metaValue}>{fmtDeadline(c.deadline)}</span></span>
              <span style={s.metaItem}>{t("commitments.created_at")}: <span style={s.metaValue}>{new Date(c.createdAt).toLocaleString()}</span></span>
              {c.tags && c.tags.length > 0 && (
                <span style={{ ...s.metaItem, display: "flex", gap: "4px" }}>
                  {t("commitments.tags")}: {c.tags.map((tg, i) => <span key={i} style={s.tag}>{tg}</span>)}
                </span>
              )}
            </div>
            {c.status !== "completed" && c.status !== "dismissed" && (
              <div style={s.actionBtns}>
                <button style={s.dangerBtn} onClick={() => dismiss(c.id)}>{t("commitments.dismiss")}</button>
              </div>
            )}
          </div>
        ))
      )}

      {showModal && (
        <div style={s.modal} onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}>
          <div style={s.modalCard}>
            <div style={s.modalTitle}>{t("commitments.modal_title")}</div>
            <div style={s.field}>
              <label style={s.label}>{t("commitments.description")}</label>
              <input style={s.input} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t("commitments.description_ph")} autoFocus />
            </div>
            <div style={s.field}>
              <label style={s.label}>{t("commitments.deadline")}</label>
              <input style={s.input} value={deadline} onChange={(e) => setDeadline(e.target.value)} placeholder={t("commitments.deadline_ph")} />
              <div style={{ color: "var(--text-muted)", fontSize: "10px", marginTop: "4px" }}>{t("commitments.deadline_help")}</div>
            </div>
            <div style={s.field}>
              <label style={s.label}>{t("commitments.tags")}</label>
              <input style={s.input} value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t("commitments.tags_ph")} />
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
              <button style={s.addBtn} onClick={create}>{t("commitments.create_btn")}</button>
              <button style={s.actionBtn} onClick={() => setShowModal(false)}>{t("commitments.cancel")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}