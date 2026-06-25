/**
 * EventsPage — ACP Event Ledger viewer.
 *
 * Displays the append-only event log from EventLedger,
 * with filtering by event type, session, and agent.
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "./i18n";

interface LedgerEvent {
  id: string;
  seq: number;
  type: string;
  agentId?: string;
  sessionId?: string;
  timestamp: number;
  data: Record<string, unknown>;
}

const EVENT_TYPES = [
  "tool_call", "tool_result", "permission_request", "permission_grant",
  "permission_deny", "model_invoke", "model_response", "system",
  "error", "commitment", "session",
];

const typeBadgeStyle = (type: string): React.CSSProperties => ({
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "4px",
  fontSize: "10px",
  fontWeight: "bold",
  textTransform: "uppercase" as const,
  background:
    type.startsWith("tool") ? "var(--info-bg, rgba(88,166,255,0.15))" :
    type.startsWith("permission") ? "var(--warning-bg)" :
    type.startsWith("model") ? "var(--success-bg)" :
    type === "error" ? "var(--error-bg)" :
    type === "system" ? "var(--info-bg, rgba(88,166,255,0.15))" :
    "var(--bg-hover)",
  color:
    type.startsWith("tool") ? "var(--info, #58a6ff)" :
    type.startsWith("permission") ? "var(--warning)" :
    type.startsWith("model") ? "var(--success)" :
    type === "error" ? "var(--error)" :
    type === "system" ? "var(--text-secondary)" :
    "var(--text-muted)",
});

const s: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)", width: "100%", boxSizing: "border-box" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "8px" },
  title: { color: "var(--text-primary)", fontSize: "18px", fontWeight: "bold" },
  subtitle: { color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" },
  controls: { display: "flex", gap: "8px", flexWrap: "wrap" },
  select: {
    padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--border)",
    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: "12px",
  },
  refreshBtn: {
    padding: "6px 14px", borderRadius: "6px", border: "1px solid var(--accent)",
    background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: "12px",
  },
  statsBar: {
    display: "flex", gap: "16px", marginBottom: "12px", padding: "10px 14px",
    background: "var(--bg-card)", borderRadius: "8px", border: "1px solid var(--border-light)",
    flexWrap: "wrap",
  },
  statItem: { fontSize: "12px", color: "var(--text-secondary)" },
  statValue: { fontWeight: "bold", color: "var(--text-primary)" },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: "12px" },
  th: { textAlign: "left" as const, padding: "8px 10px", color: "var(--text-muted)", fontSize: "11px", fontWeight: "bold", borderBottom: "1px solid var(--border-light)" },
  td: { padding: "7px 10px", color: "var(--text-secondary)", borderBottom: "1px solid var(--border-light)", verticalAlign: "top" as const },
  empty: { padding: "40px", textAlign: "center", color: "var(--text-muted)" },
};

export function EventsPage() {
  const { t, lang } = useTranslation();
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [snapshot, setSnapshot] = useState<Record<string, unknown>>({});
  const [filterType, setFilterType] = useState("");
  const [loading, setLoading] = useState(true);

  const loadEvents = useCallback(async (signal?: AbortSignal) => {
    try {
      const [evtRes, snapRes] = await Promise.all([
        fetch(`/api/events?limit=100${filterType ? `&type=${filterType}` : ""}`, { signal }),
        fetch("/api/events/snapshot", { signal }),
      ]);
      if (signal?.aborted) return;
      if (evtRes.ok) {
        const data = await evtRes.json();
        setEvents(data.events || []);
      }
      if (snapRes.ok) {
        setSnapshot(await snapRes.json());
      }
    } catch {
      // silent
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [filterType]);

  useEffect(() => {
    const controller = new AbortController();
    loadEvents(controller.signal);
    const interval = setInterval(() => loadEvents(controller.signal), 10000);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [loadEvents]);

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const typeCounts: Record<string, number> = {};
  for (const e of events) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  }

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div>
          <div style={s.title}>{t("events.title")}</div>
          <div style={s.subtitle}>
            {t("events.sequence_info").replace("{0}", String((snapshot as any).firstSeq || 0)).replace("{1}", String((snapshot as any).lastSeq || 0)).replace("{2}", String((snapshot as any).entries || events.length))}
          </div>
        </div>
        <div style={s.controls}>
          <select style={s.select} value={filterType} onChange={(e) => setFilterType(e.target.value)}>
            <option value="">{t("events.all_types")}</option>
            {EVENT_TYPES.map((et) => (
              <option key={et} value={et}>{et}</option>
            ))}
          </select>
          <button style={s.refreshBtn} onClick={() => loadEvents()}>{t("events.refresh_btn")}</button>
        </div>
      </div>

      <div style={s.statsBar}>
        {Object.entries(typeCounts).map(([type, count]) => (
          <div key={type} style={s.statItem}>
            <span style={typeBadgeStyle(type)}>{type}</span>
            {" "}<span style={s.statValue}>{count}</span>
          </div>
        ))}
        {Object.keys(typeCounts).length === 0 && (
          <div style={s.statItem}>{t("events.no_events")}</div>
        )}
      </div>

      {events.length === 0 ? (
        <div style={s.empty}>
          {loading ? t("events.loading") : t("events.no_events_desc")}
        </div>
      ) : (
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>{t("events.col_number")}</th>
              <th style={s.th}>{t("events.table_type")}</th>
              <th style={s.th}>{t("events.table_time")}</th>
              <th style={s.th}>{t("events.col_session")}</th>
              <th style={s.th}>{t("events.col_agent")}</th>
              <th style={s.th}>{t("events.col_details")}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((evt) => (
              <tr key={evt.id}>
                <td style={s.td}>{evt.seq}</td>
                <td style={s.td}><span style={typeBadgeStyle(evt.type)}>{evt.type}</span></td>
                <td style={s.td}>{formatTime(evt.timestamp)}</td>
                <td style={s.td}>{evt.sessionId?.slice(-8) || "-"}</td>
                <td style={s.td}>{evt.agentId || "-"}</td>
                <td style={s.td}>
                  <code style={{ fontSize: "11px", wordBreak: "break-all" }}>
                    {JSON.stringify(evt.data).slice(0, 120)}{JSON.stringify(evt.data).length > 120 ? "..." : ""}
                  </code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}