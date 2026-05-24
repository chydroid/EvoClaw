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

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes scaleIn {
    from { transform: scale(0.9); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
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

interface AvatarInfo {
  user: string;
  bot: string;
  userNickname: string;
  botNickname: string;
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
  "正在分析你的需求...",
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
  padding: "8px 16px",
  borderTop: "1px solid var(--border, #30363d)",
  background: "var(--bg-secondary, #161b22)",
};

const contextBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "12px",
  padding: "6px 0",
  fontSize: "12px",
  color: "var(--text-secondary, #8b949e)",
};

const contextProgressStyle: CSSProperties = {
  width: "120px",
  height: "6px",
  borderRadius: "3px",
  background: "var(--bg-tertiary, #21262d)",
  overflow: "hidden",
};

const contextProgressFillStyle: (percent: number) => CSSProperties = (percent) => ({
  height: "100%",
  borderRadius: "3px",
  background: percent > 80 ? "#f87171" : percent > 60 ? "#fbbf24" : "var(--accent, #58a6ff)",
  transition: "width 0.3s ease",
  width: `${Math.min(percent, 100)}%`,
});

const inputToolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "4px",
};

const inputBtnStyle: CSSProperties = {
  width: "32px",
  height: "32px",
  borderRadius: "8px",
  border: "none",
  background: "transparent",
  color: "var(--text-secondary, #8b949e)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "14px",
  transition: "all 0.15s",
};

const textAreaStyle: CSSProperties = {
  flex: 1,
  padding: "10px 14px",
  borderRadius: "12px",
  border: "1px solid var(--border, #30363d)",
  background: "var(--bg-tertiary, #21262d)",
  color: "var(--text-primary, #c9d1d9)",
  fontSize: "14px",
  resize: "none",
  minHeight: "60px",
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

export function WebChatPage({ sessionId: initialSessionId, avatars }: { sessionId?: string | null; avatars?: AvatarInfo }) {
  const [messages, setMessages] = useState<WebChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [showThinking, setShowThinking] = useState<Record<string, boolean>>({});
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);
  const [currentProgress, setCurrentProgress] = useState(0);
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null);
  const [contextUsed, setContextUsed] = useState(0);
  const [contextLimit] = useState(200000);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);

  // Permission state
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);

  // ── Load messages when sessionId prop changes ──
  useEffect(() => {
    if (!initialSessionId) {
      setMessages([]);
      return;
    }
    (async () => {
      setIsLoadingHistory(true);
      try {
        const res = await fetch(`/api/sessions/default/${initialSessionId}`);
        if (!res.ok) { setMessages([]); return; }
        const data = await res.json();
        const turns: WebChatMessage[] = (data.turns || []).map((t: Record<string, unknown>, i: number) => ({
          id: `${initialSessionId}-t${i}`,
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
  }, [initialSessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming || !initialSessionId) return;

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

    let msgIndex = 1;
    setLoadingMessageIndex(1);
    
    const progressInterval = setInterval(() => {
      setCurrentProgress((prev) => Math.min(prev + Math.random() * 10 + 3, 85));
      msgIndex = (msgIndex % (loadingMessages.length - 1)) + 1;
      setLoadingMessageIndex(msgIndex);
    }, 3000);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId: initialSessionId }),
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
      clearInterval(progressInterval);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === botMsgId
            ? { ...m, role: "system", content: "Network error — cannot reach server" }
            : m,
        ),
      );
    }

    clearInterval(progressInterval);
    setIsStreaming(false);
    setCurrentProgress(100);
  }, [input, isStreaming, initialSessionId]);

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
        if (lastUserMsg && initialSessionId) {
          setIsStreaming(true);
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: lastUserMsg.content, sessionId: initialSessionId }),
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
    if (isComposingRef.current || e.nativeEvent.isComposing) return;
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

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
  }, []);

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const sec = String(d.getSeconds()).padStart(2, "0");
    return `${year}年${month}月${day}日 ${hour}:${min}:${sec}`;
  };

  const getNickname = (role: string) => {
    if (role === "user") return avatars?.userNickname || "Me";
    if (role === "assistant") return avatars?.botNickname || "EvoClaw";
    return null;
  };

  const renderMessageContent = (msg: WebChatMessage) => {
    if (!msg.content) return null;
    const html = renderMessageHtml(msg.content);
    return <div dangerouslySetInnerHTML={{ __html: html }} />;
  };

  // Copy message as markdown
  const copyAsMarkdown = async (msg: WebChatMessage) => {
    const text = msg.content || "";
    const nick = getNickname(msg.role);
    const time = msg.timestamp ? formatTime(msg.timestamp) : "";
    const md = `**${nick}** (${time})\n\n${text}`;
    try {
      await navigator.clipboard.writeText(md);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = md;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  };

  // Export conversation as markdown
  const exportConversation = () => {
    const lines: string[] = [`# 对话导出 - ${new Date().toLocaleString("zh-CN")}\n`];
    for (const msg of messages) {
      const nick = getNickname(msg.role);
      const time = msg.timestamp ? formatTime(msg.timestamp) : "";
      const content = msg.content || "";
      lines.push(`**${nick}** (${time})`);
      lines.push("");
      lines.push(content);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `evoclaw-chat-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Attach file
  const handleFileAttach = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files) {
        setAttachedFiles(prev => [...prev, ...Array.from(files)]);
      }
    };
    input.click();
  };

  const removeAttachedFile = (index: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index));
  };

  // Context usage percentage
  const contextPercent = contextLimit > 0 ? Math.round((contextUsed / contextLimit) * 100) : 0;
  const contextUsedDisplay = contextUsed > 1000 ? `${(contextUsed / 1000).toFixed(1)}k` : contextUsed;
  const contextLimitDisplay = contextLimit > 1000 ? `${(contextLimit / 1000).toFixed(0)}k` : contextLimit;

  return (
    <div style={chatContainerStyle}>
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
              <div>
                {/* Nickname + timestamp + avatar above bubble */}
                {(() => {
                  const nick = getNickname(msg.role);
                  if (!nick || !msg.timestamp) return null;
                  const isUser = msg.role === "user";
                  const avatarSrc = isUser ? avatars?.user : avatars?.bot;
                  const avatarSize = 28;
                  return (
                    <div style={{
                      fontSize: "12px",
                      color: "var(--text-muted, #6e7681)",
                      marginBottom: "4px",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      paddingLeft: isUser ? "0" : "4px",
                      paddingRight: isUser ? "4px" : "0",
                      justifyContent: isUser ? "flex-end" : "flex-start",
                    }}>
                      {isUser ? (
                        <>
                          <span style={{ fontSize: "11px", color: "var(--text-muted, #6e7681)", fontFamily: "monospace" }}>
                            {formatTime(msg.timestamp)}
                          </span>
                          <span style={{ fontWeight: 500, color: "var(--text-secondary, #8b949e)" }}>{nick}</span>
                          {avatarSrc && (
                            <img
                              src={avatarSrc}
                              style={{ width: avatarSize, height: avatarSize, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--border, #30363d)" }}
                              alt={nick}
                            />
                          )}
                        </>
                      ) : (
                        <>
                          {avatarSrc && (
                            <img
                              src={avatarSrc}
                              style={{ width: avatarSize, height: avatarSize, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--border, #30363d)" }}
                              alt={nick}
                            />
                          )}
                          <span style={{ fontWeight: 500, color: "var(--text-secondary, #8b949e)" }}>{nick}</span>
                          <span style={{ fontSize: "11px", color: "var(--text-muted, #6e7681)", fontFamily: "monospace" }}>
                            {formatTime(msg.timestamp)}
                          </span>
                        </>
                      )}
                    </div>
                  );
                })()}
              <div
                style={{
                  ...messageBubbleStyle(msg.role),
                  border: hoveredMsgId === msg.id && msg.role === "assistant"
                    ? "1px solid var(--accent, #58a6ff)"
                    : messageBubbleStyle(msg.role).border,
                  boxShadow: hoveredMsgId === msg.id && msg.role === "assistant"
                    ? "0 0 12px rgba(88, 166, 255, 0.2)"
                    : "none",
                  transition: "border 0.15s, box-shadow 0.15s",
                  position: "relative",
                }}
                onMouseEnter={() => setHoveredMsgId(msg.id)}
                onMouseLeave={() => setHoveredMsgId(null)}
              >
                {/* Copy button - shown on hover for assistant messages */}
                {hoveredMsgId === msg.id && msg.role === "assistant" && (
                  <button
                    style={{
                      position: "absolute",
                      top: "8px",
                      right: "8px",
                      background: "transparent",
                      border: "none",
                      borderRadius: "4px",
                      padding: "4px",
                      fontSize: "14px",
                      color: "var(--text-muted, #6e7681)",
                      cursor: "pointer",
                      zIndex: 10,
                      display: "flex",
                      alignItems: "center",
                      gap: "4px",
                      transition: "all 0.15s",
                    }}
                    onClick={(e) => { e.stopPropagation(); copyAsMarkdown(msg); }}
                    onMouseEnter={(e) => { 
                      e.currentTarget.style.background = "var(--bg-tertiary, #21262d)"; 
                      e.currentTarget.style.color = "var(--text-primary, #c9d1d9)";
                      const span = e.currentTarget.querySelector('.copy-text') as HTMLElement;
                      if (span) span.style.display = "inline";
                    }}
                    onMouseLeave={(e) => { 
                      e.currentTarget.style.background = "transparent"; 
                      e.currentTarget.style.color = "var(--text-muted, #6e7681)";
                      const span = e.currentTarget.querySelector('.copy-text') as HTMLElement;
                      if (span) span.style.display = "none";
                    }}
                  >
                    📋
                    <span className="copy-text" style={{ fontSize: "11px", display: "none", fontWeight: 500 }}>复制为 Markdown</span>
                  </button>
                )}
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
              </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Context Usage Bar */}
        <div style={contextBarStyle}>
          <div style={contextProgressStyle}>
            <div style={contextProgressFillStyle(contextPercent)} />
          </div>
          <span>{contextPercent}% context used</span>
          <span style={{ color: "var(--text-muted, #6e7681)" }}>{contextUsedDisplay} / {contextLimitDisplay}</span>
        </div>

        {/* Input */}
        <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
          {/* Left toolbar */}
          <div style={inputToolbarStyle}>
            <button
              style={inputBtnStyle}
              title="附加文件"
              onClick={handleFileAttach}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-tertiary, #21262d)"; e.currentTarget.style.color = "var(--text-primary, #c9d1d9)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-secondary, #8b949e)"; }}
            >
              📎
            </button>
            <button
              style={{ ...inputBtnStyle, opacity: 0.4, cursor: "not-allowed" }}
              title="语音输入（暂未支持）"
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-tertiary, #21262d)"; e.currentTarget.style.color = "var(--text-primary, #c9d1d9)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-secondary, #8b949e)"; }}
            >
              🎤
            </button>
            <button
              style={inputBtnStyle}
              title="打开设置"
              onClick={() => {
                // Dispatch custom event to open settings modal
                window.dispatchEvent(new CustomEvent("evoclaw-open-settings"));
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-tertiary, #21262d)"; e.currentTarget.style.color = "var(--text-primary, #c9d1d9)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-secondary, #8b949e)"; }}
            >
              ⚙
            </button>
          </div>

          {/* Text input */}
          <textarea
            ref={inputRef}
            style={textAreaStyle}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
            placeholder={`给 ${getNickname("assistant")} 发消息 · Shift+Enter 换行 · Enter 发送`}
            rows={1}
            disabled={isStreaming}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />

          {/* Right toolbar */}
          <div style={{ ...inputToolbarStyle, gap: "8px" }}>
            <button
              style={inputBtnStyle}
              title="导出对话记录"
              onClick={exportConversation}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-tertiary, #21262d)"; e.currentTarget.style.color = "var(--text-primary, #c9d1d9)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-secondary, #8b949e)"; }}
            >
              📥
            </button>
            <button
              style={{ ...sendBtnStyle, width: "40px", height: "40px" }}
              onClick={handleSend}
              disabled={isStreaming}
              title="发送消息"
            >
              {isStreaming ? "⏳" : "➤"}
            </button>
          </div>
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