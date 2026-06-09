import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "./i18n";

// ─── Types ────────────────────────────────────────────────────

interface ChannelInfo {
  id: string;
  name: string;
  type: string;
  unreadCount?: number;
}

interface SessionInfo {
  sessionId: string;
  agentId?: string;
  updatedAt?: number;
  messageCount?: number;
  status?: string;
  preview?: string;
  customName?: string;
}

interface TranscriptMessage {
  role: string;
  content: string;
  timestamp?: number | string;
  toolCalls?: any[];
  toolResults?: any[];
}

interface SessionDetail {
  sessionId: string;
  transcript: TranscriptMessage[];
  updatedAt?: number;
}

// ─── Styles ───────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  container: {
    display: "flex", height: "100%", overflow: "hidden",
    background: "var(--bg-secondary)",
  },
  leftPanel: {
    width: 220, minWidth: 220, borderRight: "1px solid var(--border)",
    background: "var(--bg-sidebar)", display: "flex", flexDirection: "column",
    overflow: "hidden",
  },
  panelHeader: {
    padding: "14px 16px 10px", borderBottom: "1px solid var(--border)",
    fontSize: 13, fontWeight: 700, color: "var(--text-primary)",
    textTransform: "uppercase" as const, letterSpacing: "0.5px",
  },
  panelList: {
    flex: 1, overflowY: "auto", overflowX: "hidden",
  },
  channelName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1 },
  unreadBadge: {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    minWidth: 18, height: 18, borderRadius: 9, padding: "0 5px",
    background: "var(--accent)", color: "#fff", fontSize: 10, fontWeight: 700,
  },
  middlePanel: {
    width: 280, minWidth: 280, borderRight: "1px solid var(--border)",
    background: "var(--bg-primary)", display: "flex", flexDirection: "column",
    overflow: "hidden",
  },
  sessionId: {
    color: "var(--text-primary)", fontWeight: 600, fontSize: 12,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
  },
  sessionMeta: {
    display: "flex", gap: 8, marginTop: 4, fontSize: 10, color: "var(--text-muted)",
  },
  rightPanel: {
    flex: 1, display: "flex", flexDirection: "column", overflow: "hidden",
    background: "var(--bg-primary)",
  },
  filterBar: {
    display: "flex", alignItems: "center", gap: 8, padding: "10px 16px",
    borderBottom: "1px solid var(--border)", flexWrap: "wrap" as const,
  },
  searchInput: {
    padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border)",
    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 12,
    outline: "none", width: 180,
  },
  dateInput: {
    padding: "4px 8px", borderRadius: 5, border: "1px solid var(--border)",
    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 11,
    outline: "none",
  },
  dateLabel: { fontSize: 11, color: "var(--text-muted)" },
  messageList: {
    flex: 1, overflowY: "auto", padding: "12px 16px",
  },
  messageContent: {
    fontSize: 13, color: "var(--text-primary)", lineHeight: 1.5,
    whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const,
  },
  messageTime: {
    fontSize: 10, color: "var(--text-muted)", marginTop: 4, textAlign: "right" as const,
  },
  toolBadge: {
    display: "inline-block", padding: "2px 8px", borderRadius: 4,
    background: "var(--warning-bg)", color: "var(--warning)",
    fontSize: 10, fontWeight: 700, marginBottom: 4,
  },
  emptyState: {
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    flex: 1, color: "var(--text-muted)", fontSize: 14, gap: 8,
  },
  emptyIcon: { fontSize: 36, opacity: 0.4 },
  loadingWrap: {
    display: "flex", alignItems: "center", justifyContent: "center",
    flex: 1, color: "var(--text-muted)", fontSize: 13,
  },
};

function channelItemStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "8px 16px", cursor: "pointer", fontSize: 13,
    background: active ? "var(--accent-bg)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-secondary)",
    fontWeight: active ? 600 : 400, borderLeft: active ? "3px solid var(--accent)" : "3px solid transparent",
    transition: "all 0.12s",
  };
}

function sessionItemStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex", flexDirection: "column", padding: "10px 16px",
    cursor: "pointer", fontSize: 12,
    background: active ? "var(--accent-bg)" : "transparent",
    borderLeft: active ? "3px solid var(--accent)" : "3px solid transparent",
    borderBottom: "1px solid var(--border-light, var(--border))",
    transition: "all 0.12s",
  };
}

function filterBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "4px 10px", borderRadius: 5, border: "none", cursor: "pointer",
    fontSize: 11, fontWeight: active ? 700 : 400,
    background: active ? "var(--accent)" : "var(--bg-card)",
    color: active ? "#fff" : "var(--text-secondary)",
    transition: "all 0.12s",
  };
}

function messageRowStyle(isUser: boolean): React.CSSProperties {
  return {
    display: "flex", flexDirection: "column",
    marginBottom: 10, padding: "10px 14px", borderRadius: 8,
    background: isUser ? "var(--accent-bg)" : "var(--bg-card)",
    border: isUser ? "1px solid var(--accent)" : "1px solid var(--border)",
    maxWidth: "85%",
    alignSelf: isUser ? "flex-end" : "flex-start",
  };
}

function messageRoleStyle(isUser: boolean): React.CSSProperties {
  return {
    fontSize: 11, fontWeight: 700, marginBottom: 4,
    color: isUser ? "var(--accent)" : "var(--success)",
  };
}

// ─── Helpers ──────────────────────────────────────────────────

function formatTime(ts: number | string | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function isChannelSession(sessionId: string, channelType?: string): boolean {
  if (channelType) {
    const prefix = channelType === "feishu" ? "feishu-" : "weixin-";
    return sessionId.startsWith(prefix);
  }
  return sessionId.startsWith("feishu-") || sessionId.startsWith("weixin-");
}

function getSessionChannelType(sessionId: string): string {
  if (sessionId.startsWith("feishu-")) return "feishu";
  if (sessionId.startsWith("weixin-")) return "weixin";
  return "";
}

function getDisplaySessionId(sessionId: string): string {
  const match = sessionId.match(/^(feishu|weixin)-(.+)$/);
  return match ? match[2] : sessionId;
}

// ─── Component ────────────────────────────────────────────────

export default function ChannelMessagesPage() {
  const { t } = useTranslation();

  // State
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);

  // Filters
  const [searchKeyword, setSearchKeyword] = useState("");
  const [messageFilter, setMessageFilter] = useState<"all" | "user" | "assistant" | "tool">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Fetch channels
  const fetchChannels = useCallback(async () => {
    setLoadingChannels(true);
    try {
      const res = await fetch("/api/channels/active");
      if (res.ok) {
        const data = await res.json();
        const list: ChannelInfo[] = Array.isArray(data)
          ? data.map((c: any) => ({
              id: c.id || c.channelId || c.name,
              name: c.name || c.id || c.channelId || "Unknown",
              type: c.type || "feishu",
              unreadCount: c.unreadCount || 0,
            }))
          : [];
        setChannels(list);
        if (list.length > 0 && !selectedChannelId) {
          setSelectedChannelId(list[0].id);
        }
      }
    } catch { /* ignore */ }
    setLoadingChannels(false);
  }, []);

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const res = await fetch("/api/sessions");
      if (res.ok) {
        const data = await res.json();
        const raw: any[] = Array.isArray(data) ? data : data?.sessions || [];
        const channelType = channels.find(c => c.id === selectedChannelId)?.type;
        const filtered = raw
          .filter((sess: any) => isChannelSession(sess.sessionId || "", channelType))
          .map((sess: any) => ({
            sessionId: sess.sessionId || "",
            agentId: sess.agentId,
            updatedAt: sess.updatedAt,
            messageCount: sess.turnCount || sess.messageCount || 0,
            status: sess.status,
            preview: sess.preview || "",
            customName: sess.customName || "",
          }));
        filtered.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
        setSessions(filtered);
      }
    } catch { /* ignore */ }
    setLoadingSessions(false);
  }, [channels, selectedChannelId]);

  // Fetch session detail (messages)
  const fetchSessionDetail = useCallback(async (sessionId: string) => {
    setLoadingMessages(true);
    try {
      const res = await fetch(`/api/sessions/default/${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        const transcript: TranscriptMessage[] = Array.isArray(data?.transcript)
          ? data.transcript.map((m: any) => ({
              role: m.role || "unknown",
              content: typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""),
              timestamp: m.timestamp || m.createdAt,
              toolCalls: m.toolCalls || m.tool_calls,
              toolResults: m.toolResults || m.tool_results,
            }))
          : [];
        setSessionDetail({ sessionId, transcript, updatedAt: data?.updatedAt });
      }
    } catch { /* ignore */ }
    setLoadingMessages(false);
  }, []);

  // Effects
  useEffect(() => { fetchChannels(); }, [fetchChannels]);

  useEffect(() => {
    if (selectedChannelId) {
      fetchSessions();
      setSelectedSessionId(null);
      setSessionDetail(null);
    }
  }, [selectedChannelId, fetchSessions]);

  useEffect(() => {
    if (selectedSessionId) {
      fetchSessionDetail(selectedSessionId);
    } else {
      setSessionDetail(null);
    }
  }, [selectedSessionId, fetchSessionDetail]);

  // Filtered messages
  const filteredMessages = sessionDetail?.transcript.filter((msg) => {
    // Message type filter
    if (messageFilter !== "all") {
      if (messageFilter === "user" && msg.role !== "user") return false;
      if (messageFilter === "assistant" && msg.role !== "assistant") return false;
      if (messageFilter === "tool" && msg.role !== "tool" && !msg.toolCalls && !msg.toolResults) return false;
    }
    // Keyword filter
    if (searchKeyword.trim()) {
      const q = searchKeyword.toLowerCase();
      if (!msg.content.toLowerCase().includes(q)) return false;
    }
    // Date range filter
    if (dateFrom || dateTo) {
      const msgTime = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;
      if (dateFrom && msgTime < new Date(dateFrom).getTime()) return false;
      if (dateTo && msgTime > new Date(dateTo + "T23:59:59").getTime()) return false;
    }
    return true;
  }) || [];

  const selectedChannel = channels.find(c => c.id === selectedChannelId);

  // ─── Render ───────────────────────────────────────────────

  return (
    <div style={s.container}>
      {/* Left Panel — Channel List */}
      <div style={s.leftPanel}>
        <div style={s.panelHeader}>{t("channel_messages.select_channel", "Select Channel")}</div>
        <div style={s.panelList}>
          {loadingChannels ? (
            <div style={s.loadingWrap}>{t("channel_messages.loading", "Loading...")}</div>
          ) : channels.length === 0 ? (
            <div style={s.emptyState}>
              <span style={s.emptyIcon}>📡</span>
              <span>{t("channel_messages.no_channels", "No active channels")}</span>
            </div>
          ) : (
            channels.map(ch => (
              <div
                key={ch.id}
                style={channelItemStyle(selectedChannelId === ch.id)}
                onClick={() => setSelectedChannelId(ch.id)}
              >
                <span style={s.channelName}>
                  {ch.type === "feishu" ? "🪶 " : ch.type === "weixin" || ch.type === "wechat" ? "💬 " : "📡 "}
                  {ch.name}
                </span>
                {ch.unreadCount != null && ch.unreadCount > 0 && (
                  <span style={s.unreadBadge}>{ch.unreadCount}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Middle Panel — Session List */}
      <div style={s.middlePanel}>
        <div style={s.panelHeader}>
          {selectedChannel ? selectedChannel.name : t("channel_messages.select_session", "Select Session")}
        </div>
        <div style={s.panelList}>
          {!selectedChannelId ? (
            <div style={s.emptyState}>
              <span style={s.emptyIcon}>👈</span>
              <span>{t("channel_messages.select_channel", "Select Channel")}</span>
            </div>
          ) : loadingSessions ? (
            <div style={s.loadingWrap}>{t("channel_messages.loading", "Loading...")}</div>
          ) : sessions.length === 0 ? (
            <div style={s.emptyState}>
              <span style={s.emptyIcon}>📭</span>
              <span>{t("channel_messages.no_sessions", "No sessions")}</span>
            </div>
          ) : (
            sessions.map(sess => (
              <div
                key={sess.sessionId}
                style={sessionItemStyle(selectedSessionId === sess.sessionId)}
                onClick={() => setSelectedSessionId(sess.sessionId)}
              >
                <span style={s.sessionId}>
                  {getSessionChannelType(sess.sessionId) === "feishu" ? "🪶 " : "💬 "}
                  {getDisplaySessionId(sess.sessionId)}
                </span>
                <div style={s.sessionMeta}>
                  {sess.messageCount != null && sess.messageCount > 0 && (
                    <span>{sess.messageCount} {t("sessions.messages", "messages")}</span>
                  )}
                  {sess.updatedAt && (
                    <span>{formatTime(sess.updatedAt)}</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right Panel — Messages */}
      <div style={s.rightPanel}>
        {/* Filter Bar */}
        {selectedSessionId && (
          <div style={s.filterBar}>
            <input
              style={s.searchInput}
              value={searchKeyword}
              onChange={e => setSearchKeyword(e.target.value)}
              placeholder={t("channel_messages.search", "Search messages")}
            />
            {(["all", "user", "assistant", "tool"] as const).map(f => (
              <button
                key={f}
                style={filterBtnStyle(messageFilter === f)}
                onClick={() => setMessageFilter(f)}
              >
                {t(`channel_messages.filter_${f}`, f)}
              </button>
            ))}
            <span style={s.dateLabel}>{t("channel_messages.from", "From")}</span>
            <input
              type="date"
              style={s.dateInput}
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
            />
            <span style={s.dateLabel}>{t("channel_messages.to", "To")}</span>
            <input
              type="date"
              style={s.dateInput}
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
            />
          </div>
        )}

        {/* Message List */}
        {!selectedSessionId ? (
          <div style={s.emptyState}>
            <span style={s.emptyIcon}>💬</span>
            <span>{t("channel_messages.select_session", "Select Session")}</span>
          </div>
        ) : loadingMessages ? (
          <div style={s.loadingWrap}>{t("channel_messages.loading", "Loading...")}</div>
        ) : filteredMessages.length === 0 ? (
          <div style={s.emptyState}>
            <span style={s.emptyIcon}>📭</span>
            <span>{t("channel_messages.no_messages", "No messages")}</span>
          </div>
        ) : (
          <div style={s.messageList}>
            {filteredMessages.map((msg, idx) => {
              const isUser = msg.role === "user";
              const isTool = msg.role === "tool" || !!msg.toolCalls || !!msg.toolResults;
              return (
                <div key={idx} style={messageRowStyle(isUser)}>
                  {isTool && (
                    <span style={s.toolBadge}>{t("channel_messages.filter_tool", "Tool")}</span>
                  )}
                  <span style={messageRoleStyle(isUser)}>
                    {isUser
                      ? t("channel_messages.filter_user", "User")
                      : isTool
                        ? t("channel_messages.filter_tool", "Tool")
                        : t("channel_messages.filter_assistant", "Assistant")}
                  </span>
                  <div style={s.messageContent}>{msg.content}</div>
                  {msg.timestamp && (
                    <div style={s.messageTime}>{formatTime(msg.timestamp)}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
