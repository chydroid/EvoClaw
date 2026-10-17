import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "./i18n";

interface Account {
  id: string;
  provider: string;
  email: string;
  displayName: string;
  smtpHost?: string;
  smtpPort?: number;
  imapHost?: string;
  imapPort?: number;
  useTLS: boolean;
}

interface EmailItem {
  uid: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  size: number;
  flags: string[];
  hasAttachments: boolean;
  snippet: string;
}

interface ParsedEmail {
  uid: string;
  subject: string;
  from: string;
  to: string[];
  cc?: string[];
  date: string;
  body?: { text?: string; html?: string };
  attachments?: Array<{ filename: string; size: number }>;
}

const PROVIDERS = [
  { value: "gmail", label: "Gmail" },
  { value: "qq", label: "QQ 邮箱" },
  { value: "163", label: "163 邮箱" },
  { value: "outlook", label: "Outlook" },
  { value: "custom", label: "自定义" },
];

const s: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" },
  title: { color: "var(--section-title-color)", fontSize: "18px", fontWeight: "bold" },
  subtitle: { color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" },
  tabs: { display: "flex", gap: "4px", marginBottom: "16px", flexWrap: "wrap" as const },
  tab: {
    padding: "8px 16px", borderRadius: "6px 6px 0 0", border: "1px solid transparent", cursor: "pointer",
    background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: "12px", fontWeight: "bold",
  },
  tabActive: {
    padding: "8px 16px", borderRadius: "6px 6px 0 0", border: "1px solid var(--border-light)", cursor: "pointer",
    background: "var(--bg-card)", color: "var(--accent)", fontSize: "12px", fontWeight: "bold",
    borderBottom: "2px solid var(--accent)",
  },
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
    resize: "vertical" as const, fontFamily: "inherit", minHeight: "80px",
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
  row: {
    display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px",
    background: "var(--bg-hover)", borderRadius: "6px", marginBottom: "8px", cursor: "pointer",
  },
  rowHover: {
    display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px",
    background: "var(--bg-card)", borderRadius: "6px", marginBottom: "8px", cursor: "pointer",
    border: "1px solid var(--border-light)",
  },
  rowLeft: { flex: 1, minWidth: 0 },
  rowSubject: { color: "var(--text-primary)", fontSize: "13px", fontWeight: "bold", whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" },
  rowFrom: { color: "var(--text-secondary)", fontSize: "11px", marginTop: "2px" },
  rowMeta: { color: "var(--text-muted)", fontSize: "10px", marginTop: "2px" },
  rowRight: { display: "flex", alignItems: "center", gap: "8px", marginLeft: "12px" },
  badge: {
    display: "inline-block", padding: "2px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: "bold",
    background: "var(--accent-bg)", color: "var(--accent)",
  },
  detailBox: {
    background: "var(--bg-input)", borderRadius: "6px", padding: "14px", border: "1px solid var(--border-light)",
    fontSize: "13px", color: "var(--text-primary)", maxHeight: "50vh", overflow: "auto",
  },
  detailMeta: { color: "var(--text-muted)", fontSize: "11px", marginBottom: "12px", lineHeight: "1.6" },
  detailBody: { whiteSpace: "pre-wrap" as const, lineHeight: "1.6" },
  statCard: {
    background: "var(--bg-card)", borderRadius: "8px", padding: "12px 16px", border: "1px solid var(--border-light)",
  },
  statLabel: { color: "var(--text-muted)", fontSize: "11px" },
  statValue: { color: "var(--text-primary)", fontSize: "18px", fontWeight: "bold", marginTop: "2px" },
  healthDot: { display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", marginRight: "6px" },
};

export function EmailPage() {
  const { t, lang } = useTranslation();
  const [tab, setTab] = useState<"accounts" | "inbox" | "compose">("accounts");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [health, setHealth] = useState<boolean | null>(null);
  const [emails, setEmails] = useState<EmailItem[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedEmail, setSelectedEmail] = useState<ParsedEmail | null>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  // account form
  const [acctEmail, setAcctEmail] = useState("");
  const [acctPassword, setAcctPassword] = useState("");
  const [acctProvider, setAcctProvider] = useState("custom");
  const [acctDisplayName, setAcctDisplayName] = useState("");

  // compose form
  const [compAccount, setCompAccount] = useState("");
  const [compTo, setCompTo] = useState("");
  const [compCc, setCompCc] = useState("");
  const [compSubject, setCompSubject] = useState("");
  const [compBody, setCompBody] = useState("");
  const [compHtml, setCompHtml] = useState(false);

  const loadAccounts = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/email/accounts", { signal });
      if (signal?.aborted) return;
      if (res.ok) {
        const d = await res.json();
        setAccounts(Array.isArray(d.accounts) ? d.accounts : []);
      }
    } catch { /* ignore */ }
  }, []);

  const loadHealth = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/email/health", { signal });
      if (signal?.aborted) return;
      if (res.ok) {
        const d = await res.json();
        setHealth(Boolean(d.healthy));
      }
    } catch { /* ignore */ }
  }, []);

  const loadInbox = useCallback(async (accountId: string, signal?: AbortSignal) => {
    if (!accountId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ accountId, limit: "50" });
      const res = await fetch(`/api/email/inbox?${params}`, { signal });
      if (signal?.aborted) return;
      if (res.ok) {
        const d = await res.json();
        setEmails(Array.isArray(d.emails) ? d.emails : []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const loadSummary = useCallback(async (accountId: string, signal?: AbortSignal) => {
    if (!accountId) return;
    try {
      const res = await fetch(`/api/email/summary/${encodeURIComponent(accountId)}`, { signal });
      if (signal?.aborted) return;
      if (res.ok) {
        const d = await res.json();
        setSummary(d.summary || null);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadAccounts(controller.signal);
    loadHealth(controller.signal);
    const interval = setInterval(() => {
      loadAccounts(controller.signal);
      loadHealth(controller.signal);
    }, 15000);
    return () => { clearInterval(interval); controller.abort(); };
  }, [loadAccounts, loadHealth]);

  useEffect(() => {
    if (tab === "inbox" && selectedAccountId) {
      const controller = new AbortController();
      loadInbox(selectedAccountId, controller.signal);
      loadSummary(selectedAccountId, controller.signal);
      return () => controller.abort();
    }
  }, [tab, selectedAccountId, loadInbox, loadSummary]);

  const addAccount = async () => {
    if (!acctEmail.trim() || !acctPassword.trim()) {
      setMessage(t("email.acct_email_password_required"));
      setError(true);
      return;
    }
    try {
      const res = await fetch("/api/email/accounts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: acctEmail.trim(),
          password: acctPassword,
          provider: acctProvider,
          displayName: acctDisplayName.trim() || undefined,
        }),
      });
      if (res.ok) {
        setMessage(t("email.acct_added_ok"));
        setAcctEmail(""); setAcctPassword(""); setAcctDisplayName("");
        loadAccounts();
      } else {
        const d = await res.json().catch(() => ({}));
        setMessage(`${t("email.acct_add_fail")}: ${d.error || res.statusText}`);
        setError(true);
      }
    } catch {
      setMessage(t("email.network_error"));
      setError(true);
    }
  };

  const removeAccount = async (id: string) => {
    if (!confirm(t("email.confirm_remove"))) return;
    try {
      const res = await fetch(`/api/email/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok) {
        setMessage(t("email.acct_removed_ok"));
        if (selectedAccountId === id) { setSelectedAccountId(""); setEmails([]); setSummary(null); }
        loadAccounts();
      } else {
        const d = await res.json().catch(() => ({}));
        setMessage(`${t("email.acct_remove_fail")}: ${d.error || res.statusText}`);
        setError(true);
      }
    } catch {
      setMessage(t("email.network_error"));
      setError(true);
    }
  };

  const sendEmail = async () => {
    if (!compAccount || !compTo.trim() || !compSubject.trim()) {
      setMessage(t("email.send_required"));
      setError(true);
      return;
    }
    try {
      const res = await fetch("/api/email/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: compAccount,
          to: compTo.trim(),
          cc: compCc.trim() || undefined,
          subject: compSubject.trim(),
          body: compBody,
          html: compHtml || undefined,
        }),
      });
      if (res.ok) {
        const d = await res.json();
        setMessage(`${t("email.sent_ok")}${d.messageId ? ` (id: ${d.messageId})` : ""}`);
        setCompTo(""); setCompCc(""); setCompSubject(""); setCompBody("");
        setError(false);
      } else {
        const d = await res.json().catch(() => ({}));
        setMessage(`${t("email.sent_fail")}: ${d.error || res.statusText}`);
        setError(true);
      }
    } catch {
      setMessage(t("email.network_error"));
      setError(true);
    }
  };

  const viewEmail = async (accountId: string, uid: string) => {
    try {
      const res = await fetch(`/api/email/emails/${encodeURIComponent(accountId)}/${encodeURIComponent(uid)}`);
      if (res.ok) {
        const d = await res.json();
        setSelectedEmail(d.email || null);
      }
    } catch { /* ignore */ }
  };

  const fmtDate = (d?: string | Date) => {
    if (!d) return "";
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? String(d) : dt.toLocaleString();
  };

  const unreadCount = emails.filter((e) => !e.flags.includes("\\Seen")).length;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div>
          <div style={s.title}>{t("email.title")}</div>
          <div style={s.subtitle}>{t("email.subtitle")}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {health !== null && (
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
              <span style={{ ...s.healthDot, background: health ? "var(--success)" : "var(--error)" }}></span>
              {health ? t("email.healthy") : t("email.unhealthy")}
            </span>
          )}
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            {accounts.length}{t("email.account_count_suffix")}
          </span>
        </div>
      </div>

      {message && (
        <div style={{ ...s.msg, background: error ? "var(--error-bg)" : "var(--success-bg)", color: error ? "var(--error)" : "var(--success)" }}>
          {message}
        </div>
      )}

      <div style={s.tabs}>
        <button style={tab === "accounts" ? s.tabActive : s.tab} onClick={() => { setTab("accounts"); setSelectedEmail(null); }}>{t("email.tab_accounts")}</button>
        <button style={tab === "inbox" ? s.tabActive : s.tab} onClick={() => { setTab("inbox"); setSelectedEmail(null); }}>{t("email.tab_inbox")}</button>
        <button style={tab === "compose" ? s.tabActive : s.tab} onClick={() => setTab("compose")}>{t("email.tab_compose")}</button>
      </div>

      {/* ── Accounts tab ── */}
      {tab === "accounts" && (
        <div style={s.grid}>
          <div>
            <div style={s.card}>
              <div style={s.cardTitle}>{t("email.add_account")}</div>
              <div style={s.field}>
                <label style={s.label}>{t("email.email_addr")}</label>
                <input style={s.input} value={acctEmail} onChange={(e) => setAcctEmail(e.target.value)} placeholder="user@example.com" />
              </div>
              <div style={s.field}>
                <label style={s.label}>{t("email.password")}</label>
                <input style={s.input} type="password" value={acctPassword} onChange={(e) => setAcctPassword(e.target.value)} placeholder={t("email.password_ph")} />
              </div>
              <div style={s.field}>
                <label style={s.label}>{t("email.provider")}</label>
                <select style={s.select} value={acctProvider} onChange={(e) => setAcctProvider(e.target.value)}>
                  {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <div style={s.field}>
                <label style={s.label}>{t("email.display_name")}</label>
                <input style={s.input} value={acctDisplayName} onChange={(e) => setAcctDisplayName(e.target.value)} placeholder={t("email.display_name_ph")} />
              </div>
              <button style={s.addBtn} onClick={addAccount}>{t("email.add_btn")}</button>
            </div>
          </div>
          <div>
            <div style={s.card}>
              <div style={s.cardTitle}>{t("email.accounts")}</div>
              {accounts.length === 0 ? (
                <div style={s.empty}>{t("email.empty_accounts")}<br /><span style={{ fontSize: "11px" }}>{t("email.empty_hint")}</span></div>
              ) : accounts.map((a) => (
                <div key={a.id} style={s.row}>
                  <div style={s.rowLeft}>
                    <div style={s.rowSubject}>{a.displayName || a.email}</div>
                    <div style={s.rowFrom}>{a.email} ｜ {a.provider}{a.smtpHost ? ` ｜ ${a.smtpHost}:${a.smtpPort}` : ""}</div>
                  </div>
                  <div style={s.rowRight}>
                    <span style={s.badge}>{a.useTLS ? "TLS" : "plain"}</span>
                    <button style={s.dangerBtn} onClick={() => removeAccount(a.id)}>{t("email.remove")}</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Inbox tab ── */}
      {tab === "inbox" && (
        <div style={s.grid}>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: "16px" }}>
            <div style={s.card}>
              <div style={s.cardTitle}>{t("email.inbox")}</div>
              {accounts.length === 0 ? (
                <div style={s.empty}>{t("email.no_account_for_inbox")}</div>
              ) : (
                <>
                  <div style={{ ...s.field, marginBottom: "12px" }}>
                    <label style={s.label}>{t("email.account")}</label>
                    <select style={s.select} value={selectedAccountId} onChange={(e) => { setSelectedAccountId(e.target.value); setSelectedEmail(null); }}>
                      <option value="">{t("email.select_account")}</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName || a.email}</option>)}
                    </select>
                  </div>
                  {selectedAccountId && summary && (
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" as const, marginBottom: "12px" }}>
                      {Object.entries(summary).map(([k, v], i) => (
                        <div key={i} style={s.statCard}>
                          <div style={s.statLabel}>{k}</div>
                          <div style={s.statValue}>{String(v)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {selectedAccountId && !loading && emails.length === 0 ? (
                    <div style={s.empty}>{t("email.empty_inbox")}</div>
                  ) : selectedAccountId && emails.map((e) => {
                    const unread = !e.flags.includes("\\Seen");
                    return (
                      <div key={e.uid} style={unread ? s.rowHover : s.row}
                        onClick={() => viewEmail(selectedAccountId, e.uid)}>
                        <div style={s.rowLeft}>
                          <div style={s.rowSubject}>
                            {unread && <span style={{ color: "var(--accent)", marginRight: "6px" }}>&#9679;</span>}
                            {e.subject || t("email.no_subject")}
                          </div>
                          <div style={s.rowFrom}>{e.from}</div>
                          <div style={s.rowMeta}>{fmtDate(e.date)} ｜ {e.size} B{e.hasAttachments ? ` ｜ ${t("email.attachment")}` : ""}</div>
                        </div>
                        <div style={s.rowRight}>
                          {unread && <span style={s.badge}>{t("email.unread")}</span>}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>
          <div>
            <div style={s.card}>
              <div style={s.cardTitle}>{t("email.email_detail")}</div>
              {selectedEmail ? (
                <>
                  <div style={s.detailMeta}>
                    <div><strong>{t("email.from")}:</strong> {selectedEmail.from}</div>
                    <div><strong>{t("email.to")}:</strong> {(selectedEmail.to || []).join(", ")}</div>
                    {selectedEmail.cc && selectedEmail.cc.length > 0 && <div><strong>{t("email.cc")}:</strong> {selectedEmail.cc.join(", ")}</div>}
                    <div><strong>{t("email.subject")}:</strong> {selectedEmail.subject}</div>
                    <div><strong>{t("email.date")}:</strong> {fmtDate(selectedEmail.date)}</div>
                    {selectedEmail.attachments && selectedEmail.attachments.length > 0 && (
                      <div><strong>{t("email.attachments")}:</strong> {selectedEmail.attachments.map((a) => `${a.filename} (${a.size}B)`).join(", ")}</div>
                    )}
                  </div>
                  <div style={s.detailBody}>
                    {selectedEmail.body?.text || selectedEmail.body?.html || t("email.no_body")}
                  </div>
                </>
              ) : (
                <div style={s.empty}>{t("email.select_email")}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Compose tab ── */}
      {tab === "compose" && (
        <div style={s.grid}>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: "16px" }}>
            <div style={s.card}>
              <div style={s.cardTitle}>{t("email.compose")}</div>
              <div style={s.field}>
                <label style={s.label}>{t("email.account")}</label>
                <select style={s.select} value={compAccount} onChange={(e) => setCompAccount(e.target.value)}>
                  <option value="">{t("email.select_account")}</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName || a.email}</option>)}
                </select>
              </div>
              <div style={s.field}>
                <label style={s.label}>{t("email.to")}</label>
                <input style={s.input} value={compTo} onChange={(e) => setCompTo(e.target.value)} placeholder="to@example.com, ..." />
              </div>
              <div style={s.field}>
                <label style={s.label}>{t("email.cc")}</label>
                <input style={s.input} value={compCc} onChange={(e) => setCompCc(e.target.value)} placeholder="cc@example.com (可选)" />
              </div>
              <div style={s.field}>
                <label style={s.label}>{t("email.subject")}</label>
                <input style={s.input} value={compSubject} onChange={(e) => setCompSubject(e.target.value)} placeholder={t("email.subject_ph")} />
              </div>
              <div style={s.field}>
                <label style={s.label}>{t("email.body")}</label>
                <textarea style={s.textarea} value={compBody} onChange={(e) => setCompBody(e.target.value)} placeholder={t("email.body_ph")} />
              </div>
              <div style={{ ...s.field, display: "flex", alignItems: "center", gap: "8px" }}>
                <input type="checkbox" checked={compHtml} onChange={(e) => setCompHtml(e.target.checked)} id="email-html" />
                <label htmlFor="email-html" style={{ color: "var(--text-secondary)", fontSize: "12px", cursor: "pointer" }}>{t("email.html")}</label>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button style={s.addBtn} onClick={sendEmail}>{t("email.send_btn")}</button>
                <button style={s.actionBtn} onClick={() => { setCompTo(""); setCompCc(""); setCompSubject(""); setCompBody(""); }}>{t("email.clear")}</button>
              </div>
            </div>
          </div>
          <div>
            <div style={s.card}>
              <div style={s.cardTitle}>{t("email.compose_hint")}</div>
              <div style={{ color: "var(--text-muted)", fontSize: "12px", lineHeight: "1.6" }}>
                {t("email.compose_hint_text")}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}