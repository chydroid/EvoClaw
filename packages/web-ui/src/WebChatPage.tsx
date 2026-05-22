/**
 * WebChatPage — OpenClaw-style WebChat interface.
 *
 * A standalone, full-featured chat interface with:
 * - Real-time streaming display
 * - Code block highlighting
 * - Message actions (copy, retry)
 * - Session switching
 * - Thinking/reasoning display
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import type { CSSProperties } from "react";
import { htmlEscape } from "./highlight";

// Add CSS animations
const styleSheet = document.createElement("style");
styleSheet.textContent = `
  @keyframes dotPulse {
    0%, 80%, 100% {
      transform: scale(0.6);
      opacity: 0.5;
    }
    40% {
      transform: scale(1);
      opacity: 1;
    }
  }
  
  @keyframes blink {
    0%, 50% { opacity: 1; }
    51%, 100% { opacity: 0; }
  }
`;
document.head.appendChild(styleSheet);

// Simple markdown-to-HTML renderer
function renderMessageHtml(text: string): string {
  // Decode HTML entities first (e.g. &ensp; &#0183; &amp;) before htmlEscape re-encodes them
  const decoded = text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&ensp;/g, " ")
    .replace(/&emsp;/g, "  ")
    .replace(/&nbsp;/g, " ")
    .replace(/&thinsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"');
  const escaped = htmlEscape(decoded);
  return escaped
    // Code blocks: ```lang\n...\n```
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_: string, lang: string, code: string) => {
      return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang-label">${lang || "code"}</span></div><pre class="code-block-pre"><code>${code.trim()}</code></pre></div>`;
    })
    // Inline code: `text`
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;font-size:13px;">$1</code>')
    // Bold: **text**
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--text-primary);">$1</strong>')
    // Links: [text](url) — must come after code to avoid matching inside code blocks
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);">$1</a>')
    // Plain URLs that aren't already in links
    .replace(/(?<!href=")(https?:\/\/[^\s<>\[\]()]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:var(--accent);">$1</a>')
    // Line breaks
    .replace(/\n/g, '<br/>');
}

interface WebChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: string;
  thinking?: string;
  toolCalls?: Array<{ name: string; args: string; result?: string; status: "running" | "done" | "error" }>;
  actions?: Array<{ label: string; type: string }>;
  permissionRequests?: Array<{ id: string; operation: string; description: string; target: string }>;
}

interface PermissionRequest {
  id: string;
  operation: string;
  description: string;
  target: string;
  messageId: string;
}

interface WebChatSession {
  id: string;
  label: string;
  lastActivity: string;
  messageCount: number;
  status: "active" | "idle";
}

// ─── Styles (extracted as functions to avoid Record typing issues) ──────────

const chatContainerStyle: CSSProperties = {
  display: "flex",
  height: "100%",
  background: "var(--bg-primary, #0d1117)",
  borderRadius: "8px",
  border: "1px solid var(--border, #30363d)",
  overflow: "hidden",
};

const sessionSidebarStyle: CSSProperties = {
  width: "240px",
  borderRight: "1px solid var(--border, #30363d)",
  background: "var(--bg-secondary, #161b22)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const sessionListStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "8px",
};

const sessionItemStyle = (active: boolean): CSSProperties => ({
  padding: "10px 12px",
  borderRadius: "6px",
  cursor: "pointer",
  marginBottom: "4px",
  background: active ? "var(--accent-bg, rgba(88,166,255,0.12))" : "transparent",
  border: active ? "1px solid var(--accent, #58a6ff)" : "1px solid transparent",
  color: "var(--text-primary, #c9d1d9)",
  fontSize: "13px",
  transition: "all 0.15s",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
});

const deleteBtnStyle: CSSProperties = {
  width: "24px",
  height: "24px",
  borderRadius: "4px",
  border: "none",
  background: "transparent",
  color: "var(--text-secondary, #8b949e)",
  cursor: "pointer",
  fontSize: "14px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  opacity: 0,
  transition: "opacity 0.15s",
};

const newSessionBtnStyle: CSSProperties = {
  margin: "8px",
  padding: "8px 12px",
  borderRadius: "6px",
  border: "1px solid var(--border, #30363d)",
  background: "var(--bg-tertiary, #21262d)",
  color: "var(--text-primary, #c9d1d9)",
  cursor: "pointer",
  fontSize: "13px",
  width: "calc(100% - 16px)",
};

const chatAreaStyle: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const messagesContainerStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "16px 20px",
};

const messageRowStyle = (role: string): CSSProperties => ({
  display: "flex",
  marginBottom: "16px",
  justifyContent: role === "user" ? "flex-end" : "flex-start",
});

const messageBubbleStyle = (role: string): CSSProperties => ({
  maxWidth: "75%",
  padding: "10px 16px",
  borderRadius: role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
  background: role === "user"
    ? "var(--accent, #58a6ff)"
    : "var(--bg-tertiary, #21262d)",
  color: role === "user" ? "#fff" : "var(--text-primary, #c9d1d9)",
  fontSize: "14px",
  lineHeight: "1.5",
  wordBreak: "break-word",
  position: "relative",
});

const thinkingBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  padding: "4px 10px",
  borderRadius: "12px",
  background: "var(--bg-secondary, #161b22)",
  border: "1px solid var(--border, #30363d)",
  fontSize: "12px",
  color: "var(--text-secondary, #8b949e)",
  marginBottom: "8px",
  cursor: "pointer",
};

const loadingIndicatorStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "8px",
  padding: "12px 16px",
  borderRadius: "18px 18px 18px 4px",
  background: "var(--bg-tertiary, #21262d)",
  color: "var(--text-secondary, #8b949e)",
  fontSize: "14px",
};

const dotsStyle: CSSProperties = {
  display: "flex",
  gap: "3px",
};

const dotStyle: CSSProperties = {
  width: "6px",
  height: "6px",
  borderRadius: "50%",
  background: "var(--accent, #58a6ff)",
  animation: "dotPulse 1.4s infinite ease-in-out",
};

const loadingMessages = [
  "正在分析您的需求...",
  "正在检索相关信息...",
  "正在处理中，请稍候...",
  "正在生成回复...",
  "马上就好，请耐心等待...",
];

const toolCallStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: "6px",
  background: "var(--bg-secondary, #161b22)",
  border: "1px solid var(--border, #30363d)",
  marginTop: "8px",
  fontSize: "12px",
  fontFamily: "monospace",
};

const inputContainerStyle: CSSProperties = {
  padding: "12px 16px",
  borderTop: "1px solid var(--border, #30363d)",
  display: "flex",
  gap: "8px",
  alignItems: "flex-end",
};

const textAreaStyle: CSSProperties = {
  flex: 1,
  padding: "10px 14px",
  borderRadius: "20px",
  border: "1px solid var(--border, #30363d)",
  background: "var(--bg-tertiary, #21262d)",
  color: "var(--text-primary, #c9d1d9)",
  fontSize: "14px",
  resize: "none",
  minHeight: "40px",
  maxHeight: "120px",
  fontFamily: "inherit",
  outline: "none",
};

const sendBtnStyle: CSSProperties = {
  width: "40px",
  height: "40px",
  borderRadius: "50%",
  border: "none",
  background: "var(--accent, #58a6ff)",
  color: "#fff",
  cursor: "pointer",
  fontSize: "18px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const emptyStateStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "var(--text-secondary, #8b949e)",
  textAlign: "center",
};

const actionBtnStyle: CSSProperties = {
  padding: "2px 8px",
  borderRadius: "4px",
  border: "1px solid var(--border, #30363d)",
  background: "rgba(255,255,255,0.05)",
  color: "var(--text-secondary, #8b949e)",
  cursor: "pointer",
  fontSize: "11px",
  marginLeft: "6px",
};

// Permission Whitelist - stored in localStorage
const getWhitelist = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem("evoclaw_permission_whitelist") || "[]");
  } catch {
    return [];
  }
};

const addToWhitelist = (operation: string): void => {
  const list = getWhitelist();
  if (!list.includes(operation)) {
    list.push(operation);
    localStorage.setItem("evoclaw_permission_whitelist", JSON.stringify(list));
  }
};

const isWhitelisted = (operation: string): boolean => {
  return getWhitelist().includes(operation);
};

const permissionModalStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: "rgba(0,0,0,0.7)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const permissionCardStyle: CSSProperties = {
  background: "var(--bg-secondary, #161b22)",
  border: "1px solid var(--border, #30363d)",
  borderRadius: "12px",
  padding: "24px",
  width: "480px",
  maxWidth: "90%",
  boxShadow: "0 20px 40px rgba(0,0,0,0.4)",
};

const permissionTitleStyle: CSSProperties = {
  fontSize: "18px",
  fontWeight: 600,
  color: "var(--text-primary, #c9d1d9)",
  marginBottom: "8px",
};

const permissionDescStyle: CSSProperties = {
  fontSize: "14px",
  color: "var(--text-secondary, #8b949e)",
  marginBottom: "20px",
};

const permissionItemStyle: CSSProperties = {
  background: "var(--bg-tertiary, #21262d)",
  borderRadius: "8px",
  padding: "12px 14px",
  marginBottom: "10px",
};

const permissionOpStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "4px",
  background: "var(--accent-bg, rgba(88,166,255,0.15))",
  color: "var(--accent, #58a6ff)",
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  marginRight: "8px",
};

const permissionTargetStyle: CSSProperties = {
  fontSize: "13px",
  color: "var(--text-primary, #c9d1d9)",
  fontFamily: "monospace",
  marginTop: "4px",
};

const permissionActionsStyle: CSSProperties = {
  display: "flex",
  gap: "10px",
  marginTop: "20px",
  justifyContent: "flex-end",
};

const permissionBtnStyle = (primary: boolean, destructive?: boolean): CSSProperties => ({
  padding: "10px 20px",
  borderRadius: "8px",
  border: primary ? "none" : "1px solid var(--border, #30363d)",
  background: primary
    ? (destructive ? "var(--error, #f87171)" : "var(--accent, #58a6ff)")
    : "var(--bg-tertiary, #21262d)",
  color: primary ? "#fff" : "var(--text-primary, #c9d1d9)",
  cursor: "pointer",
  fontSize: "14px",
  fontWeight: 500,
  transition: "all 0.15s",
});

export function WebChatPage() {
  const [sessions, setSessions] = useState<WebChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WebChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [showThinking, setShowThinking] = useState<Record<string, boolean>>({});
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null);
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);
  const [currentProgress, setCurrentProgress] = useState(0);
  
  // Permission state
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ── Load session list from backend on mount ──
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok) return;
        const data = await res.json();
        const backendSessions: WebChatSession[] = (data.sessions || []).map((s: Record<string, unknown>) => {
          const sessionId = (s.sessionId as string) || "";
          const preview = (s.preview as string) || "";
          const label = preview || `Session ${sessionId.slice(-8) || "..."}`;
          return {
            id: sessionId,
            label,
            lastActivity: (s.updatedAt as string) || (s.createdAt as string) || new Date().toISOString(),
            messageCount: (s.turnCount as number) || 0,
            status: (s.status === "active" ? "active" : "idle") as "active" | "idle",
          };
        });

        if (backendSessions.length > 0) {
          // Sort by lastActivity descending
          backendSessions.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
          setSessions(backendSessions);
          // Auto-load the most recent session
          const mostRecent = backendSessions[0];
          setActiveSessionId(mostRecent.id);
        } else {
          // No existing sessions — create a fresh one via API
          await createBackendSession();
        }
      } catch {
        // Silent fallback — proceed with empty state
      }
    })();
  }, []);

  // ── Load messages when switching sessions ──
  useEffect(() => {
    if (!activeSessionId) return;
    (async () => {
      setIsLoadingHistory(true);
      try {
        const res = await fetch(`/api/sessions/default/${activeSessionId}`);
        if (!res.ok) {
          setMessages([]);
          return;
        }
        const data = await res.json();
        const turns: WebChatMessage[] = (data.turns || []).map((t: Record<string, unknown>, i: number) => ({
          id: `${activeSessionId}-t${i}`,
          role: (t.role as "user" | "assistant" | "system" | "tool") || "assistant",
          content: (t.content as string) || "",
          timestamp: (t.timestamp as string) || new Date().toISOString(),
        }));

        if (turns.length > 0) {
          setMessages(turns);
        } else {
          // Empty session — show welcome
          setMessages([{
            id: `welcome-${Date.now()}`,
            role: "assistant",
            content: "你好！我是 EvoClaw 小助手。有什么我可以帮助你的吗？",
            timestamp: new Date().toISOString(),
          }]);
        }
      } catch {
        setMessages([{
          id: `welcome-${Date.now()}`,
          role: "assistant",
          content: "你好！我是 EvoClaw 小助手。有什么我可以帮助你的吗？",
          timestamp: new Date().toISOString(),
        }]);
      } finally {
        setIsLoadingHistory(false);
      }
    })();
  }, [activeSessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Create a new session on the backend ──
  const createBackendSession = async () => {
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "default" }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const newSess = data.session as Record<string, unknown>;
      const sessEntry: WebChatSession = {
        id: (newSess.sessionId as string) || "",
        label: `Session ${(newSess.sessionId as string)?.slice(-8) || "new"}`,
        lastActivity: (newSess.createdAt as string) || new Date().toISOString(),
        messageCount: 0,
        status: "active",
      };
      setSessions((prev) => [sessEntry, ...prev]);
      setActiveSessionId(sessEntry.id);
      setMessages([{
        id: `welcome-${Date.now()}`,
        role: "assistant",
        content: "你好！我是 EvoClaw 小助手。有什么我可以帮助你的吗？",
        timestamp: new Date().toISOString(),
      }]);
    } catch {
      // Fallback
    }
  };

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming || !activeSessionId) return;

    const userMsg: WebChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsStreaming(true);
    setLoadingMessageIndex(0);
    setCurrentProgress(0);

    const botMsgId = `bot-${Date.now()}`;
    const botMsg: WebChatMessage = {
      id: botMsgId,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, botMsg]);

    // Start loading animation loop
    const loadingInterval = setInterval(() => {
      setLoadingMessageIndex((prev) => (prev + 1) % loadingMessages.length);
      setCurrentProgress((prev) => Math.min(prev + Math.random() * 15 + 5, 90));
    }, 1500);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId: activeSessionId }),
      });

      if (res.ok) {
        const data = await res.json();
        
        // Check for permission requests
        if (data.permissionRequests && data.permissionRequests.length > 0) {
          const reqs: PermissionRequest[] = data.permissionRequests.map((p: Record<string, unknown>) => ({
            id: (p.id as string) || "",
            operation: (p.operation as string) || "",
            description: (p.description as string) || "",
            target: (p.target as string) || "",
            messageId: botMsgId,
          }));
          
          // Filter out whitelisted operations
          const nonWhitelisted = reqs.filter((r) => !isWhitelisted(r.operation));
          
          if (nonWhitelisted.length > 0) {
            setPendingPermissions(nonWhitelisted);
            setShowPermissionModal(true);
            // Don't set streaming to false yet - waiting for permission
            return;
          } else {
            // All permissions are whitelisted - auto-approve
            await autoApprovePermissions(reqs);
          }
        }
        
        setMessages((prev) =>
          prev.map((m) =>
            m.id === botMsgId
              ? { ...m, content: data.reply || "No response" }
              : m,
          ),
        );
        // Update session metadata (turn count, last activity) in sidebar
        setSessions((prev) =>
          prev.map((s) =>
            s.id === activeSessionId
              ? { ...s, messageCount: s.messageCount + 2, lastActivity: new Date().toISOString() }
              : s,
          ),
        );
      } else {
        const errText = await res.text().catch(() => "");
        setMessages((prev) =>
          prev.map((m) =>
            m.id === botMsgId
              ? { ...m, role: "system", content: `Server error: ${errText.slice(0, 200)}` }
              : m,
          ),
        );
      }
    } catch {
      clearInterval(loadingInterval);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === botMsgId
            ? { ...m, role: "system", content: "Network error — cannot reach server" }
            : m,
        ),
      );
    }

    clearInterval(loadingInterval);
    setIsStreaming(false);
    setCurrentProgress(100);
  }, [input, isStreaming, activeSessionId]);

  // ── Permission handling ──
  const autoApprovePermissions = async (reqs: PermissionRequest[]) => {
    try {
      await Promise.all(
        reqs.map((r) =>
          fetch("/api/permission/approve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestId: r.id, whitelist: isWhitelisted(r.operation) }),
          }),
        ),
      );
    } catch {
      // Silent
    }
  };

  const handlePermissionAction = async (action: "approve" | "approveAndWhitelist" | "deny") => {
    // Immediately close modal for better UX
    setShowPermissionModal(false);
    setPendingPermissions([]);
    
    try {
      if (action === "approve" || action === "approveAndWhitelist") {
        // Approve all pending permissions
        for (const perm of pendingPermissions) {
          await fetch("/api/permission/approve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestId: perm.id, whitelist: action === "approveAndWhitelist" }),
          });
          // Add to whitelist if requested
          if (action === "approveAndWhitelist") {
            addToWhitelist(perm.operation);
          }
        }
        // Retry the original message after approval
        const lastUserMsg = messages.find((m) => m.role === "user");
        if (lastUserMsg && activeSessionId) {
          setIsStreaming(true);
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: lastUserMsg.content, sessionId: activeSessionId }),
          });
          if (res.ok) {
            const data = await res.json();
            setMessages((prev) =>
              prev.map((m) =>
                m.id === pendingPermissions[0]?.messageId
                  ? { ...m, content: data.reply || "No response" }
                  : m,
              ),
            );
          }
        }
      } else {
        // Deny all pending permissions
        for (const perm of pendingPermissions) {
          await fetch("/api/permission/deny", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestId: perm.id }),
          });
        }
        // Update message to show denial
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingPermissions[0]?.messageId
              ? { ...m, role: "system", content: "权限请求已被拒绝" }
              : m,
          ),
        );
      }
    } catch {
      // Silent
    }
    
    setIsStreaming(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleThinking = (id: string) => {
    setShowThinking((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const copyMessage = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const newSession = () => {
    createBackendSession();
  };

  const deleteSession = async (sessionId: string) => {
    if (confirm("确定要删除这个会话吗？此操作无法撤销。")) {
      try {
        const res = await fetch(`/api/sessions/default/${sessionId}`, {
          method: "DELETE",
        });
        if (res.ok) {
          setSessions((prev) => prev.filter((s) => s.id !== sessionId));
          if (activeSessionId === sessionId) {
            const remaining = sessions.filter((s) => s.id !== sessionId);
            if (remaining.length > 0) {
              setActiveSessionId(remaining[0].id);
            } else {
              setActiveSessionId(null);
              setMessages([]);
              await createBackendSession();
            }
          }
        }
      } catch {
        alert("删除会话失败");
      }
    }
  };

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
  }, []);

  const formatTime = (ts: string) => {
    return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  };

  const renderMessageContent = (msg: WebChatMessage) => {
    if (!msg.content) return null;
    const html = renderMessageHtml(msg.content);
    return <div dangerouslySetInnerHTML={{ __html: html }} />;
  };

  return (
    <div style={chatContainerStyle}>
      {/* Session Sidebar */}
      <div style={sessionSidebarStyle}>
        <button style={newSessionBtnStyle} onClick={newSession}>
          + New Session
        </button>
        <div style={sessionListStyle}>
          {sessions.map((s) => (
            <div
              key={s.id}
              style={sessionItemStyle(s.id === activeSessionId)}
              onClick={() => setActiveSessionId(s.id)}
              onMouseEnter={() => setHoveredSessionId(s.id)}
              onMouseLeave={() => setHoveredSessionId(null)}
            >
              <div>
                <div style={{ fontWeight: 600, marginBottom: "2px" }}>{s.label}</div>
                <div style={{ fontSize: "11px", color: "var(--text-secondary)", display: "flex", justifyContent: "space-between" }}>
                  <span>{s.messageCount} msgs</span>
                  <span>{new Date(s.lastActivity).toLocaleDateString()}</span>
                </div>
              </div>
              <button
                style={{
                  ...deleteBtnStyle,
                  opacity: hoveredSessionId === s.id ? 1 : 0,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSession(s.id);
                }}
                title="删除会话"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Chat Area */}
      <div style={chatAreaStyle}>
        <div style={messagesContainerStyle}>
          {messages.length === 0 && (
            <div style={emptyStateStyle}>
              <div style={{ fontSize: "48px", marginBottom: "12px" }}>🦞</div>
              <div style={{ fontSize: "18px", fontWeight: 600, marginBottom: "6px" }}>开始对话</div>
              <div style={{ fontSize: "14px", maxWidth: "400px" }}>
                EvoClaw WebChat - 在下方输入消息开始与你的 AI 助手对话
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} style={messageRowStyle(msg.role)}>
              <div style={messageBubbleStyle(msg.role)}>
                {/* Thinking badge */}
                {msg.thinking && (
                  <div style={thinkingBadgeStyle} onClick={() => toggleThinking(msg.id)}>
                    <span>{showThinking[msg.id] ? "💭" : "🧠"}</span>
                    <span>思考中...</span>
                    <span style={{ fontSize: "10px", transform: showThinking[msg.id] ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
                  </div>
                )}
                {showThinking[msg.id] && msg.thinking && (
                  <div style={{ ...toolCallStyle, fontStyle: "italic", color: "var(--text-secondary)", marginBottom: "8px" }}>
                    {msg.thinking}
                  </div>
                )}

                {/* Permission requests badge */}
                {msg.permissionRequests && msg.permissionRequests.length > 0 && (
                  <div style={{ ...thinkingBadgeStyle, background: "rgba(248,113,113,0.15)", borderColor: "var(--error, #f87171)", marginBottom: "8px" }}>
                    <span>🔐</span>
                    <span>{msg.permissionRequests.length} 项权限请求</span>
                  </div>
                )}

                {/* Tool calls */}
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div style={{ marginBottom: "8px" }}>
                    {msg.toolCalls.map((tc, i) => (
                      <div key={i} style={{ ...toolCallStyle, display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                        <span>{tc.status === "running" ? "⏳" : tc.status === "error" ? "❌" : "✅"}</span>
                        <span style={{ fontWeight: 600 }}>{tc.name}</span>
                        <span style={{ color: "var(--text-secondary)", fontSize: "11px" }}>{tc.args}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Content */}
                {msg.role === "user" ? (
                  <span>{msg.content}</span>
                ) : (
                  <div>
                    {msg.content !== "" ? (
                      renderMessageContent(msg)
                    ) : isStreaming ? (
                      <div style={loadingIndicatorStyle}>
                        <span>{loadingMessages[loadingMessageIndex]}</span>
                        <div style={dotsStyle}>
                          <span style={{ ...dotStyle, animationDelay: "0s" }} />
                          <span style={{ ...dotStyle, animationDelay: "0.2s" }} />
                          <span style={{ ...dotStyle, animationDelay: "0.4s" }} />
                        </div>
                        {currentProgress > 0 && (
                          <div style={{ 
                            width: "60px", 
                            height: "4px", 
                            background: "var(--bg-secondary)", 
                            borderRadius: "2px",
                            overflow: "hidden"
                          }}>
                            <div style={{ 
                              width: `${currentProgress}%`, 
                              height: "100%", 
                              background: "var(--accent)",
                              borderRadius: "2px",
                              transition: "width 0.5s ease"
                            }} />
                          </div>
                        )}
                      </div>
                    ) : (
                      <span />
                    )}
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "4px" }}>
                  <span style={{ fontSize: "10px", opacity: 0.6 }}>{formatTime(msg.timestamp)}</span>
                  <div style={{ opacity: 0, transition: "opacity 0.2s" }} className="msg-actions">
                    <button style={actionBtnStyle} onClick={() => copyMessage(msg.content)}>Copy</button>
                  </div>
                </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div style={inputContainerStyle}>
          <textarea
            ref={inputRef}
            style={textAreaStyle}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"
            rows={1}
            disabled={isStreaming}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <button style={sendBtnStyle} onClick={handleSend} disabled={isStreaming}>
            {isStreaming ? "⏳" : "➤"}
          </button>
        </div>
      </div>

      {/* Permission Modal */}
      {showPermissionModal && (
        <div style={permissionModalStyle} onClick={() => {}}>
          <div style={permissionCardStyle} onClick={(e) => e.stopPropagation()}>
            <div style={permissionTitleStyle}>🔐 权限请求</div>
            <div style={permissionDescStyle}>
              系统需要您的授权才能执行以下操作：
            </div>
            
            {pendingPermissions.map((perm) => (
              <div key={perm.id} style={permissionItemStyle}>
                <div>
                  <span style={permissionOpStyle}>{perm.operation}</span>
                  <span style={{ color: "var(--text-secondary, #8b949e)", fontSize: "13px" }}>
                    {perm.description}
                  </span>
                </div>
                {perm.target && (
                  <div style={permissionTargetStyle}>
                    目标: {perm.target}
                  </div>
                )}
              </div>
            ))}
            
            <div style={permissionActionsStyle}>
              <button
                style={permissionBtnStyle(false)}
                onClick={() => handlePermissionAction("approve")}
              >
                本次确认
              </button>
              <button
                style={permissionBtnStyle(true)}
                onClick={() => handlePermissionAction("approveAndWhitelist")}
              >
                加入白名单
              </button>
              <button
                style={permissionBtnStyle(true, true)}
                onClick={() => handlePermissionAction("deny")}
              >
                拒绝
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}