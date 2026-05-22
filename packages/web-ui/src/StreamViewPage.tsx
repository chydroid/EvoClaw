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

import React, { useState, useEffect, useRef } from "react";
import type { CSSProperties } from "react";

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

// ─── Component ────────────────────────────────────────────────────────────────

export function StreamViewPage() {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [filter, setFilter] = useState<StreamFilter>({
    types: new Set(["lifecycle", "tool", "assistant", "thinking", "error", "compaction", "permission", "heartbeat"]),
    searchText: "",
  });
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const eventCounter = useRef(0);

  // Simulate real-time event stream
  useEffect(() => {
    if (paused) return;

    const eventTypes = ["lifecycle", "tool", "assistant", "thinking", "error", "compaction", "permission", "heartbeat", "system"];
    const sessions = ["sess_main", "sess_dev"];
    const runIds = ["run_001", "run_002"];

    const generateEvent = (): StreamEvent => {
      const type = eventTypes[Math.floor(Math.random() * 7)]; // bias towards frequent types
      eventCounter.current++;

      const dataMap: Record<string, Record<string, unknown>> = {
        lifecycle: {
          phase: ["start", "end", "error"][Math.floor(Math.random() * 3)],
          sessionId: sessions[Math.floor(Math.random() * sessions.length)],
          runId: runIds[Math.floor(Math.random() * runIds.length)],
        },
        tool: {
          name: ["read_file", "write_file", "web_search", "bash_exec", "skill_execute", "send_message"][Math.floor(Math.random() * 6)],
          status: ["start", "progress", "done", "error"][Math.floor(Math.random() * 4)],
          duration: Math.floor(Math.random() * 5000),
        },
        assistant: {
          delta: "这是流式回复的内容片段...".slice(0, Math.floor(Math.random() * 20) + 5),
          tokensSoFar: Math.floor(Math.random() * 2000),
        },
        thinking: {
          reasoning: ["分析用户意图...", "规划工具调用...", "评估结果...", "生成最终回复..."][Math.floor(Math.random() * 4)],
          confidence: Math.round(Math.random() * 100) / 100,
        },
        error: {
          code: ["RATE_LIMIT", "CONTEXT_OVERFLOW", "TOOL_ERROR", "TIMEOUT"][Math.floor(Math.random() * 4)],
          message: "An error occurred during execution",
          sessionId: sessions[Math.floor(Math.random() * sessions.length)],
        },
        compaction: {
          reason: ["auto", "manual", "overflow"][Math.floor(Math.random() * 3)],
          turnsCompacted: Math.floor(Math.random() * 50) + 10,
          summaryLength: Math.floor(Math.random() * 500) + 100,
        },
        permission: {
          operation: "exec_command",
          target: "rm -rf /tmp/cache",
          status: ["requested", "approved", "denied"][Math.floor(Math.random() * 3)],
        },
        heartbeat: {
          activeSessions: Math.floor(Math.random() * 5) + 1,
          uptime: Math.floor(Math.random() * 86400),
        },
      };

      return {
        id: `evt-${eventCounter.current}`,
        type: type as StreamEvent["type"],
        timestamp: new Date().toISOString(),
        sessionId: sessions[Math.floor(Math.random() * sessions.length)],
        runId: runIds[Math.floor(Math.random() * runIds.length)],
        data: dataMap[type] ?? {},
      };
    };

    // Initial events
    const initialEvents: StreamEvent[] = [];
    for (let i = 0; i < 20; i++) {
      initialEvents.push(generateEvent());
    }
    setEvents(initialEvents);

    // Periodic new events
    const interval = setInterval(() => {
      setEvents((prev) => {
        const newEvent = generateEvent();
        const MAX_EVENTS = 500;
        const next = [...prev, newEvent];
        return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
      });
    }, 1500 + Math.random() * 2000);

    return () => clearInterval(interval);
  }, [paused]);

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
    eventCounter.current = 0;
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
        <div style={titleStyle}>Stream Monitor</div>
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
            {autoScroll ? "Auto↓" : "Manual"}
          </button>
          <button style={autoScrollBtnStyle(false)} onClick={() => setPaused(!paused)}>
            {paused ? "▶ Play" : "⏸ Pause"}
          </button>
          <button style={autoScrollBtnStyle(false)} onClick={clearEvents}>
            Clear
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
            placeholder="Filter..."
            value={filter.searchText}
            onChange={(e) => setFilter((f) => ({ ...f, searchText: e.target.value }))}
          />
        </div>
      </div>

      {/* Event List */}
      <div ref={listRef} style={eventListStyle}>
        {filteredEvents.map((event) => (
          <div key={event.id} style={eventItemStyle}>
            <span style={eventTimeStyle}>
              {new Date(event.timestamp).toLocaleTimeString("zh-CN", {
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

        {filteredEvents.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px", color: "var(--text-secondary, #8b949e)", fontSize: "14px" }}>
            {paused ? "Stream paused — click Play to resume" : "No events matching current filters"}
          </div>
        )}
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
        <span>Total: {filteredEvents.length} events (showing {filteredEvents.length} filtered)</span>
        <span>{paused ? "PAUSED" : "LIVE"}</span>
      </div>
    </div>
  );
}