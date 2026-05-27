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

  @keyframes uploadProgressStripe {
    0% { background-position: 0 0; }
    100% { background-position: 20px 0; }
  }

  @keyframes slideDown {
    from { opacity: 0; max-height: 0; transform: translateY(-8px); }
    to { opacity: 1; max-height: 120px; transform: translateY(0); }
  }

  @keyframes slideUp {
    from { opacity: 1; max-height: 120px; transform: translateY(0); }
    to { opacity: 0; max-height: 0; transform: translateY(-8px); }
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
  attachments?: AttachedFileInfo[];
}

interface AttachedFileInfo {
  id: string;
  name: string;
  size: number;
  type: string;
  previewUrl?: string;
  data?: string;  // base64 data URL for images, text content for text files
  status: "pending" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
  cancelToken?: { cancelled: boolean };
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
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [currentProgress, setCurrentProgress] = useState(0);
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null);
  const [contextUsed, setContextUsed] = useState(0);
  const [contextLimit, setContextLimit] = useState(60000);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFileInfo[]>([]);
  const [textAreaExpanded, setTextAreaExpanded] = useState(false);
  const [isTextareaHovered, setIsTextareaHovered] = useState(false);

  // Permission state
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);

  // ── Load messages when sessionId prop changes ──
  useEffect(() => {
    setContextUsed(0); // Reset context usage on session change
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

  const handleSend = async () => {
    const text = input.trim();
    // Allow sending with text, files, or both
    const readyFiles = attachedFiles.filter(f => f.status === "done");
    const hasContent = text.length > 0 || readyFiles.length > 0;
    if (!hasContent || isStreaming || !initialSessionId) return;

    const attachmentsForMsg = readyFiles.length > 0 ? readyFiles.map(f => ({...f})) : undefined;

    const userMsg: WebChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text || (readyFiles.length > 0 ? `发送了 ${readyFiles.length} 个文件` : ""),
      timestamp: new Date().toISOString(),
      attachments: attachmentsForMsg,
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    // Clear ready files from upload list
    if (readyFiles.length > 0) {
      setAttachedFiles(prev => prev.filter(f => f.status !== "done"));
    }
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

    // ── Poll for real task status ──
    const statusInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/chat/status?sessionId=${initialSessionId}`);
        if (res.ok) {
          const status = await res.json();
          if (status && status.phase && status.phase !== "idle") {
            const phaseLabels: Record<string, string> = {
              thinking: "思考中",
              tool_calling: "执行中",
              generating: "生成中",
              done: "已完成",
              error: "出错",
            };
            const label = phaseLabels[status.phase] || status.phase;
            setStatusMessage(`${label}: ${status.detail}`);
            setCurrentProgress(Math.max(currentProgress, status.progress || 0));
          }
        }
      } catch { /* ignore polling errors */ }
    }, 1500);

    try {
      // Build attachment payload for backend
      const attachmentPayload = readyFiles.length > 0 ? readyFiles.map(f => ({
        name: f.name,
        type: f.type,
        size: f.size,
        data: f.data || null,
      })) : undefined;

      // ── Timeout: always ensure response within 120s ──
      const FETCH_TIMEOUT = 120000; // 2 minutes
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      let res: Response;
      try {
        res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            message: text, 
            sessionId: initialSessionId,
            attachments: attachmentPayload,
          }),
          signal: controller.signal,
        });
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        if (fetchErr instanceof DOMException && fetchErr.name === "AbortError") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === botMsgId
                ? { ...m, role: "system", content: "⏱️ 请求超时（超过 2 分钟），服务器可能繁忙或模型响应缓慢。请稍后重试或检查模型配置。" }
                : m,
            ),
          );
        } else {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === botMsgId
                ? { ...m, role: "system", content: "Network error — cannot reach server" }
                : m,
            ),
          );
        }
        return;
      } finally {
        clearTimeout(timeoutId);
      }

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
            // Will re-send with approval; keep streaming true until resolved
            return;
          } else {
            // All permissions are whitelisted - auto-approve
            await autoApprovePermissions(reqs);
          }
        }
        
        setMessages((prev) =>
          prev.map((m) =>
            m.id === botMsgId
              ? { ...m, content: data.reply || "(empty response from server)" }
              : m,
          ),
        );

        // Update context usage from server response
        if (typeof data.tokensUsed === "number" && data.tokensUsed > 0) {
          setContextUsed((prev) => prev + data.tokensUsed);
        }
        if (typeof data.contextLimit === "number" && data.contextLimit > 0) {
          setContextLimit(data.contextLimit);
        }
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
      setMessages((prev) =>
        prev.map((m) =>
          m.id === botMsgId
            ? { ...m, role: "system", content: "Unexpected error — please retry" }
            : m,
        ),
      );
    } finally {
      clearInterval(progressInterval);
      clearInterval(statusInterval);
      setStatusMessage(null);
      setIsStreaming(false);
      setCurrentProgress(100);
    }

  };

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

  // ─── File upload constants ───
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  const ALLOWED_TYPES: Record<string, string[]> = {
    "image/": [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"],
    "text/": [".txt", ".csv", ".log", ".md", ".json", ".xml", ".yaml", ".yml"],
    "application/pdf": [".pdf"],
    "application/msword": [".doc"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    "application/zip": [".zip"],
    "application/x-tar": [".tar"],
    "application/gzip": [".gz"],
  };
  const ALLOWED_EXTENSIONS = Object.values(ALLOWED_TYPES).flat();
  const UPLOAD_SIM_DURATION_MS = 1500; // simulated upload duration

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getFileTypeIcon = (fileName: string, mimeType: string): React.ReactNode => {
    const ext = fileName.split(".").pop()?.toLowerCase() || "";
    const iconColor = "var(--text-muted, #6e7681)";
    // Image preview handled separately via previewUrl
    if (mimeType.startsWith("image/")) return null;
    if (ext === "pdf" || mimeType === "application/pdf") {
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
      );
    }
    if (["zip", "tar", "gz", "rar", "7z"].includes(ext)) {
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      );
    }
    if (["doc", "docx"].includes(ext)) {
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="14" y2="11"/>
        </svg>
      );
    }
    // Generic file icon
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
      </svg>
    );
  };

  // Simulate upload with progress
  const simulateUpload = (fileInfo: AttachedFileInfo): void => {
    const token = fileInfo.cancelToken;
    const startTime = Date.now();
    
    const tick = () => {
      if (token?.cancelled) {
        setAttachedFiles(prev => prev.map(f => f.id === fileInfo.id ? { ...f, status: "error" as const, error: "已取消" } : f));
        return;
      }
      const elapsed = Date.now() - startTime;
      const rawProgress = Math.min((elapsed / UPLOAD_SIM_DURATION_MS) * 100, 100);
      // Simulate occasional network jitter
      const jittered = rawProgress + (rawProgress < 90 ? Math.sin(elapsed / 200) * 5 : 0);
      const progress = Math.min(Math.max(jittered, rawProgress * 0.8), 100);

      setAttachedFiles(prev =>
        prev.map(f => f.id === fileInfo.id ? { ...f, progress: Math.round(progress) } : f)
      );

      if (progress < 100) {
        setTimeout(tick, 80 + Math.random() * 60);
      } else {
        setAttachedFiles(prev =>
          prev.map(f =>
            f.id === fileInfo.id ? { ...f, status: "done" as const, progress: 100 } : f
          )
        );
      }
    };

    setAttachedFiles(prev =>
      prev.map(f => f.id === fileInfo.id ? { ...f, status: "uploading" as const, progress: 0 } : f)
    );
    setTimeout(tick, 100);
  };

  // Attach file — validates, generates preview, starts upload
  const handleFileAttach = useCallback(() => {
    const inputEl = document.createElement("input");
    inputEl.type = "file";
    inputEl.multiple = true;
    inputEl.accept = ALLOWED_EXTENSIONS.join(",");
    inputEl.onchange = () => {
      const files = inputEl.files;
      if (!files || files.length === 0) return;

      const newFiles: AttachedFileInfo[] = [];
      const errors: string[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const ext = "." + (file.name.split(".").pop()?.toLowerCase() || "");
        
        // Duplicate check
        const isDuplicate = attachedFiles.some(f => f.name === file.name && f.size === file.size);
        if (isDuplicate) { errors.push(`"${file.name}" 已添加`); continue; }

        // Size check
        if (file.size > MAX_FILE_SIZE) {
          errors.push(`"${file.name}" 超过 10MB 限制`);
          continue;
        }

        // Type check
        const isAllowedType = Object.entries(ALLOWED_TYPES).some(([mimePrefix, exts]) => {
          if (file.type.startsWith("_")) return file.type === mimePrefix;
          if (mimePrefix.endsWith("/")) return file.type.startsWith(mimePrefix);
          return file.type === mimePrefix;
        });
        const extAllowed = ALLOWED_EXTENSIONS.includes(ext);
        if (!isAllowedType && !extAllowed) {
          errors.push(`"${file.name}" 格式不支持 (${ext})`);
          continue;
        }

        const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const cancelToken = { cancelled: false };

        const info: AttachedFileInfo = {
          id, name: file.name, size: file.size, type: file.type,
          status: "pending", progress: 0, cancelToken,
        };

        // Generate preview URL for images
        if (file.type.startsWith("image/")) {
          info.previewUrl = URL.createObjectURL(file);
        }

        newFiles.push(info);
      }

      if (errors.length > 0) {
        setMessages(prev => [...prev, {
          id: `file-err-${Date.now()}`,
          role: "system",
          content: errors.join("\n"),
          timestamp: new Date().toISOString(),
        }]);
      }

      if (newFiles.length > 0) {
        setAttachedFiles(prev => {
          const updated = [...prev, ...newFiles];
          return updated;
        });
        // Start upload simulation for each new file
        newFiles.forEach(f => simulateUpload(f));
        // Pre-read file content for sending to backend
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const info = newFiles.find(f => f.name === file.name && f.size === file.size);
          if (!info || info.cancelToken?.cancelled) continue;

          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            setAttachedFiles(prev =>
              prev.map(f => f.id === info.id ? { ...f, data: result } : f)
            );
          };
          reader.onerror = () => {
            console.warn(`[FileRead] Failed to read file: ${file.name}`);
          };

          if (file.type.startsWith("image/")) {
            reader.readAsDataURL(file);
          } else if (file.type.startsWith("text/") || file.type === "application/json") {
            reader.readAsText(file);
          }
          // Other binary files (PDF, docx, zip): data not pre-read
        }
      }
    };
    inputEl.click();
  }, [attachedFiles]);

  // Cancel upload
  const cancelUpload = useCallback((fileId: string) => {
    setAttachedFiles(prev => {
      const target = prev.find(f => f.id === fileId);
      if (target?.cancelToken) target.cancelToken.cancelled = true;
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter(f => f.id !== fileId);
    });
  }, []);

  // Remove attached file (for done/error files)
  const removeAttachedFile = useCallback((index: number) => {
    setAttachedFiles(prev => {
      const file = prev[index];
      if (file?.previewUrl) URL.revokeObjectURL(file.previewUrl);
      if (file?.cancelToken) file.cancelToken.cancelled = true;
      return prev.filter((_, i) => i !== index);
    });
  }, []);

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
                  ...(msg.role === "assistant" ? { paddingTop: "32px" } : {}),
                }}
                onMouseEnter={() => setHoveredMsgId(msg.id)}
                onMouseLeave={() => setHoveredMsgId(null)}
              >
                {/* Copy button — shown on hover for assistant messages, uses SVG icon */}
                {hoveredMsgId === msg.id && msg.role === "assistant" && (
                  <button
                    style={{
                      position: "absolute",
                      top: "5px",
                      right: "8px",
                      background: "transparent",
                      border: "none",
                      borderRadius: "4px",
                      padding: "3px",
                      color: "var(--text-muted, #6e7681)",
                      cursor: "pointer",
                      zIndex: 10,
                      display: "flex",
                      alignItems: "center",
                      transition: "color 0.15s",
                    }}
                    title="复制为 Markdown"
                    onClick={(e) => {
                      e.stopPropagation();
                      copyAsMarkdown(msg);
                      // Click feedback: brief accent flash
                      e.currentTarget.style.color = "var(--accent, #58a6ff)";
                      setTimeout(() => {
                        e.currentTarget.style.color = "var(--text-muted, #6e7681)";
                      }, 500);
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--bg-tertiary, #21262d)";
                      e.currentTarget.style.color = "var(--text-primary, #c9d1d9)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                      e.currentTarget.style.color = "var(--text-muted, #6e7681)";
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
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
                  <div>
                    {/* Attached files display in user message */}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div style={{
                        display: "flex", flexWrap: "wrap", gap: "6px",
                        marginBottom: msg.content ? "8px" : "0",
                      }}>
                        {msg.attachments.map((att) => {
                          const isImage = att.type.startsWith("image/");
                          const shortName = att.name.length > 28
                            ? att.name.slice(0, 24) + "..." + att.name.slice(-4)
                            : att.name;

                          return (
                            <div key={att.id} style={{
                              display: "flex", alignItems: "center", gap: "6px",
                              padding: "3px 8px", borderRadius: "6px",
                              background: "rgba(255,255,255,0.15)",
                              fontSize: "11px",
                              maxWidth: "220px",
                            }}>
                              {isImage && att.previewUrl ? (
                                <img src={att.previewUrl} alt="" style={{
                                  width: "24px", height: "24px", borderRadius: "3px",
                                  objectFit: "cover", flexShrink: 0,
                                }} />
                              ) : (
                                <span style={{ flexShrink: 0, opacity: 0.8 }}>
                                  {getFileTypeIcon(att.name, att.type)}
                                </span>
                              )}
                              <span style={{
                                whiteSpace: "nowrap", overflow: "hidden",
                                textOverflow: "ellipsis", opacity: 0.9,
                              }} title={att.name}>
                                {shortName}
                              </span>
                              <span style={{ opacity: 0.6, flexShrink: 0 }}>
                                {formatFileSize(att.size)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {msg.content && <span>{msg.content}</span>}
                  </div>
                ) : (
                  <div>
                    {msg.content !== "" ? (
                      renderMessageContent(msg)
                    ) : isStreaming ? (
                      <div style={loadingIndicatorStyle}>
                        <span>{statusMessage || loadingMessages[loadingMessageIndex]}</span>
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

        {/* Input */}
        <div style={{ padding: "8px 16px", borderTop: "1px solid var(--border, #30363d)", background: "var(--bg-secondary, #161b22)" }}>
          {/* Text input row */}
          <div
            style={{ position: "relative" }}
            onMouseEnter={() => setIsTextareaHovered(true)}
            onMouseLeave={() => setIsTextareaHovered(false)}
          >
            <textarea
              ref={inputRef}
              style={{
                ...textAreaStyle,
                width: "100%",
                minHeight: textAreaExpanded ? "130px" : "60px",
                maxHeight: textAreaExpanded ? "300px" : "120px",
                transition: "min-height 0.2s ease",
                paddingRight: "32px",
              }}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { isComposingRef.current = true; }}
              onCompositionEnd={() => { isComposingRef.current = false; }}
              placeholder={`给 ${getNickname("assistant")} 发消息 · Shift+Enter 换行 · Enter 发送`}
              rows={1}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {/* Expand/collapse toggle icon — visible on hover over textarea area */}
            <div
              style={{
                position: "absolute",
                top: "6px",
                right: "6px",
                opacity: isTextareaHovered ? 1 : 0,
                cursor: "pointer",
                fontSize: "12px",
                color: "var(--text-muted, #6e7681)",
                padding: "2px 4px",
                borderRadius: "4px",
                transition: "opacity 0.15s, background 0.15s",
                zIndex: 5,
              }}
              onClick={() => setTextAreaExpanded(v => !v)}
              title={textAreaExpanded ? "折叠输入框" : "展开为 5 行"}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-tertiary, #21262d)"; e.currentTarget.style.color = "var(--text-primary, #c9d1d9)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted, #6e7681)"; }}
            >
              {textAreaExpanded ? "⤒" : "⤓"}
            </div>
          </div>

          {/* File preview bar — shows attached files with upload progress */}
          {attachedFiles.length > 0 && (
            <div style={{
              display: "flex", flexWrap: "wrap", gap: "8px", padding: "6px 0 0 0",
              animation: "slideDown 0.25s ease",
            }}>
              {attachedFiles.map((file, idx) => {
                const isImage = file.type.startsWith("image/");
                const isUploading = file.status === "pending" || file.status === "uploading";
                const isError = file.status === "error";
                const displayName = file.name.length > 24 
                  ? file.name.slice(0, 20) + "..." + file.name.slice(-4) 
                  : file.name;

                return (
                  <div key={file.id} style={{
                    display: "flex", alignItems: "center", gap: "6px",
                    padding: "4px 8px", borderRadius: "8px",
                    background: "var(--bg-tertiary, #21262d)",
                    border: isError ? "1px solid var(--error, #f87171)" : "1px solid var(--border, #30363d)",
                    fontSize: "12px", color: "var(--text-primary, #c9d1d9)",
                    maxWidth: "280px", position: "relative",
                    transition: "border 0.15s",
                  }}>
                    {/* Thumbnail or file type icon */}
                    <div style={{
                      width: "32px", height: "32px", borderRadius: "4px",
                      overflow: "hidden", flexShrink: 0,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      background: "var(--bg-secondary, #161b22)",
                    }}>
                      {isImage && file.previewUrl ? (
                        <img src={file.previewUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : (
                        getFileTypeIcon(file.name, file.type)
                      )}
                    </div>

                    {/* File info + progress */}
                    <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                        <span style={{ 
                          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                          fontWeight: 500,
                        }} title={file.name}>
                          {displayName}
                        </span>
                        {isError && (
                          <span style={{ fontSize: "10px", color: "var(--error, #f87171)", flexShrink: 0 }}>
                            {file.error || "错误"}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: "10px", color: "var(--text-muted, #6e7681)" }}>
                        {formatFileSize(file.size)}
                      </div>
                      {isUploading && (
                        <div style={{
                          width: "100%", height: "3px", borderRadius: "2px",
                          background: "var(--bg-secondary, #161b22)",
                          marginTop: "3px", overflow: "hidden",
                        }}>
                          <div style={{
                            height: "100%", borderRadius: "2px",
                            width: `${file.progress}%`,
                            background: `repeating-linear-gradient(90deg, var(--accent, #58a6ff) 0, var(--accent, #58a6ff) 6px, rgba(88,166,255,0.4) 6px, rgba(88,166,255,0.4) 12px)`,
                            backgroundSize: "12px 100%",
                            animation: "uploadProgressStripe 0.5s linear infinite",
                            transition: "width 0.15s ease",
                          }} />
                        </div>
                      )}
                    </div>

                    {/* Cancel / Remove button */}
                    <button
                      style={{
                        width: "18px", height: "18px", borderRadius: "50%",
                        border: "none", background: "transparent",
                        color: "var(--text-muted, #6e7681)", cursor: "pointer",
                        fontSize: "11px", display: "flex", alignItems: "center",
                        justifyContent: "center", flexShrink: 0,
                        transition: "color 0.15s",
                      }}
                      title={isUploading ? "取消上传" : "移除"}
                      onClick={() => isUploading ? cancelUpload(file.id) : removeAttachedFile(idx)}
                      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--error, #f87171)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted, #6e7681)"; }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Toolbar row below textarea — left: tools, center: context bar, right: send */}
          <div style={{ display: "flex", alignItems: "center", marginTop: "6px" }}>
            {/* Left tools */}
            <div style={{ display: "flex", alignItems: "center", gap: "2px", flexShrink: 0 }}>
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
              >
                🎤
              </button>
              <button
                style={inputBtnStyle}
                title="打开设置"
                onClick={() => { window.dispatchEvent(new CustomEvent("evoclaw-open-settings")); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-tertiary, #21262d)"; e.currentTarget.style.color = "var(--text-primary, #c9d1d9)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-secondary, #8b949e)"; }}
              >
                ⚙
              </button>
            </div>

            {/* Centered context usage bar */}
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", fontSize: "12px", color: "var(--text-secondary, #8b949e)" }}>
              <div style={contextProgressStyle}>
                <div style={contextProgressFillStyle(contextPercent)} />
              </div>
              <span>{contextPercent}%</span>
              <span style={{ color: "var(--text-muted, #6e7681)" }}>{contextUsedDisplay} / {contextLimitDisplay}</span>
            </div>

            {/* Right tools */}
            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
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
                style={{ ...sendBtnStyle, width: "36px", height: "36px", fontSize: "16px" }}
                onClick={handleSend}
                disabled={isStreaming}
                title="发送消息"
              >
                {isStreaming ? "⏳" : "➤"}
              </button>
            </div>
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