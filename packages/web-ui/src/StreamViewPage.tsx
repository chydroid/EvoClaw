/**
 * StreamViewPage — Real-time agent event stream viewer.
 *
 * Displays the agent lifecycle event stream in real time:
 * - Lifecycle events (start/end/error)
 * - Tool calls (start/update/end/error)
 * - Thinking/reasoning
 * - Response streaming
 * - Compaction events
 * - Heartbeats
 * - Permissions
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "./i18n";

const API = (window as any).__EVOCLAW_API__ || "";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StreamEvent {
  id: string;
  type: "lifecycle" | "tool" | "assistant" | "thinking" | "error" | "compaction" | "permission" | "heartbeat" | "system";
  timestamp: string;
  sessionId?: string;
  runId?: string;
  phase?: string;
  data: Record<string, unknown>;
}

interface StreamFilter {
  types: Set<string>;
  sessionId?: string;
  searchText: string;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const containerStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-primary, #0d1117)",
  borderRadius: "8px",
  border: "1px solid var(--border, #30363d)",
};

const headerStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border, #30363d)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  background: "var(--bg-secondary, #161b22)",
};

const titleStyle: CSSProperties = {
  fontSize: "15px",
  fontWeight: 700,
  color: "var(--text-primary, #c9d1d9)",
};

const filterBarStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  alignItems: "center",
};

const filterChipStyle = (active: boolean, color: string): CSSProperties => ({
  padding: "3px 10px",
  borderRadius: "12px",
  border: active ? `1px solid ${color}` : "1px solid var(--border, #30363d)",
  background: active ? `${color}20` : "transparent",
  color: active ? color : "var(--text-secondary, #8b949e)",
  cursor: "pointer",
  fontSize: "11px",
  fontWeight: active ? 600 : 400,
  transition: "all 0.15s",
});

const eventListStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "8px",
};

const eventItemStyle: CSSProperties = {
  display: "flex",
  gap: "10px",
  padding: "8px 12px",
  borderRadius: "6px",
  borderBottom: "1px solid var(--border, #30363d)",
  fontFamily: "'Cascadia Code', 'Fira Code', monospace",
  fontSize: "12px",
};

const eventTimeStyle: CSSProperties = {
  color: "var(--text-secondary, #8b949e)",
  fontSize: "11px",
  whiteSpace: "nowrap",
  minWidth: "70px",
};

const eventTypeBadgeStyle = (type: string): CSSProperties => {
  const colors: Record<string, string> = {
    lifecycle: "#58a6ff",
    tool: "#3fb950",
    assistant: "#d2a8ff",
    thinking: "#f0883e",
    error: "#f85149",
    compaction: "#a371f7",
    permission: "#d29922",
    heartbeat: "#8b949e",
    system: "#8b949e",
  };
  return {
    padding: "1px 6px",
    borderRadius: "3px",
    background: `${colors[type] ?? "#8b949e"}20`,
    color: colors[type] ?? "#8b949e",
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    whiteSpace: "nowrap",
    minWidth: "70px",
    textAlign: "center",
  };
};

const eventDataStyle: CSSProperties = {
  color: "var(--text-primary, #c9d1d9)",
  flex: 1,
  wordBreak: "break-all",
  lineHeight: "1.5",
};

const autoScrollBtnStyle = (active: boolean): CSSProperties => ({
  padding: "4px 10px",
  borderRadius: "4px",
  border: "1px solid var(--border, #30363d)",
  background: active ? "var(--accent-bg, rgba(88,166,255,0.12))" : "transparent",
  color: active ? "var(--accent, #58a6ff)" : "var(--text-secondary, #8b949e)",
  cursor: "pointer",
  fontSize: "11px",
});

const statsBarStyle: CSSProperties = {
  display: "flex",
  gap: "16px",
  fontSize: "12px",
  color: "var(--text-secondary, #8b949e)",
};

const statStyle = (color: string): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: "4px",
  color,
});

// ─── Event Type Colors ────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  lifecycle: "#58a6ff",
  tool: "#3fb950",
  assistant: "#d2a8ff",
  thinking: "#f0883e",
  error: "#f85149",
  compaction: "#a371f7",
  permission: "#d29922",
  heartbeat: "#8b949e",
  system: "#8b949e",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapApiEvent(e: Record<string, unknown>, index: number): StreamEvent {
  return {
    id: (e.id as string) || `evt-${index}`,
    type: (e.type as StreamEvent["type"]) || "system",
    timestamp: (e.timestamp as string) || new Date().toISOString(),
    sessionId: e.sessionId as string | undefined,
    runId: (e.runId as string) || (e.agentId as string),
    data: (e.data as Record<string, unknown>) || {},
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function StreamViewPage() {
  const { t, lang } = useTranslation();
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [filter, setFilter] = useState<StreamFilter>({
    types: new Set(["lifecycle", "tool", "assistant", "thinking", "error", "compaction", "permission", "heartbeat"]),
    searchText: "",
  });
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const lastTimestampRef = useRef<number>(0);

  // Fetch events from backend API
  const fetchInitialEvents = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/events?limit=100`);
      const data = await res.json();
      if (data.events && data.events.length > 0) {
        const mapped = data.events.map(mapApiEvent);
        setEvents(mapped);
        const lastTs = mapped[mapped.length - 1].timestamp;
        lastTimestampRef.current = new Date(lastTs).getTime();
      }
    } catch {
      // ignore — will retry on next poll
    } finally {
      setLoading(false);
    }
  }, []);

  const pollNewEvents = useCallback(async () => {
    try {
      const fromTime = lastTimestampRef.current || Date.now() - 60000;
      const res = await fetch(`${API}/api/events?fromTime=${fromTime}&limit=50`);
      const data = await res.json();
      if (data.events && data.events.length > 0) {
        setEvents(prev => {
          const incoming = data.events.map((e: Record<string, unknown>, i: number) =>
            mapApiEvent(e, prev.length + i)
          );
          const next = [...prev, ...incoming];
          // Update lastTimestampRef from the newest event
          const lastTs = incoming[incoming.length - 1].timestamp;
          lastTimestampRef.current = new Date(lastTs).getTime();
          return next.length > 500 ? next.slice(-500) : next;
        });
      }
    } catch {
      // ignore — will retry on next poll
    }
  }, []);

  // Initial load + polling
  useEffect(() => {
    if (paused) return;

    fetchInitialEvents();

    const interval = setInterval(pollNewEvents, 3000);
    return () => clearInterval(interval);
  }, [paused, fetchInitialEvents, pollNewEvents]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  const toggleFilter = (type: string) => {
    setFilter((prev) => {
      const next = new Set(prev.types);
      if (next.has(type)) {
        if (next.size > 1) next.delete(type);
      } else {
        next.add(type);
      }
      return { ...prev, types: next };
    });
  };

  const clearEvents = () => {
    setEvents([]);
    lastTimestampRef.current = 0;
  };

  const filteredEvents = events.filter((e) => {
    if (!filter.types.has(e.type)) return false;
    if (filter.searchText) {
      const searchable = JSON.stringify(e.data) + " " + e.type + " " + (e.sessionId ?? "") + " " + (e.runId ?? "");
      return searchable.toLowerCase().includes(filter.searchText.toLowerCase());
    }
    return true;
  });

  // Stats
  const typeCounts: Record<string, number> = {};
  for (const e of events) {
    typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
  }

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <div style={titleStyle}>{t("stream.title")}</div>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div style={statsBarStyle}>
            {Object.entries(typeCounts).map(([type, count]) => (
              <span key={type} style={statStyle(TYPE_COLORS[type] ?? "#8b949e")}>
                <span style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: TYPE_COLORS[type] ?? "#8b949e",
                  display: "inline-block",
                }} />
                {type}: {count}
              </span>
            ))}
          </div>
          <button style={autoScrollBtnStyle(autoScroll)} onClick={() => setAutoScroll(!autoScroll)}>
            {autoScroll ? t("stream.auto") : t("stream.manual")}
          </button>
          <button style={autoScrollBtnStyle(false)} onClick={() => setPaused(!paused)}>
            {paused ? t("stream.play") : t("stream.pause")}
          </button>
          <button style={autoScrollBtnStyle(false)} onClick={clearEvents}>
            {t("stream.clear")}
          </button>
        </div>
      </div>

      {/* Filter Chips */}
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-secondary, #161b22)" }}>
        <div style={filterBarStyle}>
          {Object.keys(TYPE_COLORS).map((type) => (
            <div
              key={type}
              style={filterChipStyle(filter.types.has(type), TYPE_COLORS[type])}
              onClick={() => toggleFilter(type)}
            >
              {type}
            </div>
          ))}
          <input
            style={{
              marginLeft: "auto",
              padding: "4px 10px",
              borderRadius: "4px",
              border: "1px solid var(--border, #30363d)",
              background: "var(--bg-tertiary, #21262d)",
              color: "var(--text-primary, #c9d1d9)",
              fontSize: "11px",
              width: "160px",
              outline: "none",
            }}
            placeholder={t("stream.filter_placeholder")}
            value={filter.searchText}
            onChange={(e) => setFilter((f) => ({ ...f, searchText: e.target.value }))}
          />
        </div>
      </div>

      {/* Event List */}
      <div ref={listRef} style={eventListStyle}>
        {loading && events.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px", color: "var(--text-secondary, #8b949e)", fontSize: "14px" }}>
            {t("stream.loading", "Loading events...")}
          </div>
        )}

        {!loading && events.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px", color: "var(--text-secondary, #8b949e)", fontSize: "14px" }}>
            {paused ? t("stream.paused_hint") : t("stream.no_events")}
          </div>
        )}

        {filteredEvents.length === 0 && events.length > 0 && (
          <div style={{ textAlign: "center", padding: "40px", color: "var(--text-secondary, #8b949e)", fontSize: "14px" }}>
            {t("stream.no_events")}
          </div>
        )}

        {filteredEvents.map((event) => (
          <div key={event.id} style={eventItemStyle}>
            <span style={eventTimeStyle}>
              {new Date(event.timestamp).toLocaleTimeString(locale, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                fractionalSecondDigits: 3,
              })}
            </span>
            <span style={eventTypeBadgeStyle(event.type)}>{event.type}</span>
            {event.sessionId && (
              <span style={{ color: "var(--text-secondary, #8b949e)", fontSize: "10px" }}>
                {event.sessionId}
              </span>
            )}
            <span style={eventDataStyle}>
              {Object.entries(event.data)
                .filter(([, v]) => v !== undefined && v !== null)
                .map(([k, v]) => (
                  <span key={k} style={{ marginRight: "8px" }}>
                    <span style={{ color: "var(--text-secondary, #8b949e)" }}>{k}</span>=
                    <span style={{ color: "var(--accent, #58a6ff)" }}>
                      {typeof v === "object" ? JSON.stringify(v) : String(v)}
                    </span>
                  </span>
                ))}
            </span>
          </div>
        ))}
      </div>

      {/* Bottom Bar */}
      <div style={{
        padding: "6px 16px",
        borderTop: "1px solid var(--border, #30363d)",
        background: "var(--bg-secondary, #161b22)",
        display: "flex",
        justifyContent: "space-between",
        fontSize: "11px",
        color: "var(--text-secondary, #8b949e)",
      }}>
        <span>{t("stream.total_events").replace("{0}", String(events.length)).replace("{1}", String(filteredEvents.length))}</span>
        <span>{paused ? t("stream.paused") : t("stream.live")}</span>
      </div>
    </div>
  );
}
