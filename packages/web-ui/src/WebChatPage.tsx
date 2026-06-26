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
import { renderMarkdown } from "./markdown-renderer";
import { useTranslation } from "./i18n";
import { useVoice, isSpeechRecognitionSupported, type VoiceState } from "./useVoice";
import { voiceApi, type VoiceApiResponse } from "./api-client";
import { showToast } from "./shared";

const estimateTokens = (text: string): number => {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
  const otherChars = text.length - cjkChars;
  return Math.ceil(cjkChars * 1.5 + otherChars / 4);
};

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

function renderMessageHtml(text: string): string {
  return renderMarkdown(text);
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
  files?: Array<{ path: string; size: number; downloadUrl: string }>;
  intermediateOutput?: string;
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
  position: "relative",
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

// Estimate the display width budget for assistant messages. Short replies
// look better in a narrower bubble, but tables and other wide content need
// a larger minimum width to render fully without squashing.
const assistantMinWidth = (content: unknown): string => {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text?: unknown }).text || "") : "")).join("")
      : "";
  // Strip markdown noise so the length reflects actual rendered text.
  const stripped = text
    .replace(/```[\s\S]*?```/g, "") // fenced code blocks
    .replace(/`[^`]*`/g, "")        // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links
    .replace(/[#>*_~|-]+/g, " ")   // md punctuation
    .replace(/\|/g, "")             // table separators
    .replace(/\s+/g, "");
  return stripped.length > 300 ? "580px" : "460px";
};

const messageBubbleStyle = (role: string, content?: unknown): CSSProperties => ({
  maxWidth: role === "assistant" ? "min(85%, 1100px)" : "75%",
  minWidth: role === "assistant"
    ? assistantMinWidth(content)
    : role === "user" ? "60px" : "0",
  padding: "10px 16px",
  borderRadius: role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
  background: role === "user"
    ? "var(--user-bubble-bg, var(--accent, #58a6ff))"
    : "var(--bot-bubble-bg, var(--bg-tertiary, #21262d))",
  color: role === "user" ? "#fff" : "var(--text-primary, #c9d1d9)",
  border: role === "user" ? "none" : "1px solid var(--bot-bubble-border, var(--border, #30363d))",
  fontSize: "14px",
  lineHeight: "1.6",
  wordBreak: "break-word",
  position: "relative",
  boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
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
  "chat.loading.analyzing",
  "chat.loading.searching",
  "chat.loading.processing",
  "chat.loading.generating",
  "chat.loading.almost_done",
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
  minHeight: "48px",
  maxHeight: "120px",
  fontFamily: "inherit",
  outline: "none",
  transition: "border-color 0.2s, box-shadow 0.2s",
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
  padding: "40px 20px",
  gap: "16px",
};

interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  category: string;
}

interface ProgressStep {
  type: "status" | "tool_call" | "tool_result" | "llm_call" | "final" | "error" | "understanding" | "progress_summary";
  detail: string;
  progress?: number;
  toolName?: string;
  toolResult?: string;
  toolError?: boolean;
  round?: number;
  timestamp: number;
  summaryType?: string;
  summaryCount?: number;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "chat.cmd.help_desc", category: "chat.cat.general" },
  { name: "/new", description: "chat.cmd.new_desc", usage: "chat.cmd.new_usage", category: "chat.cat.session" },
  { name: "/reset", description: "chat.cmd.reset_desc", category: "chat.cat.session" },
  { name: "/clear", description: "chat.cmd.clear_desc", category: "chat.cat.session" },
  { name: "/compact", description: "chat.cmd.compact_desc", category: "chat.cat.session" },
  { name: "/status", description: "chat.cmd.status_desc", category: "chat.cat.system" },
  { name: "/health", description: "chat.cmd.health_desc", category: "chat.cat.system" },
  { name: "/model", description: "chat.cmd.model_desc", usage: "chat.cmd.model_usage", category: "chat.cat.model" },
  { name: "/skills", description: "chat.cmd.skills_desc", category: "chat.cat.skills" },
  { name: "/memory", description: "chat.cmd.memory_desc", usage: "chat.cmd.memory_usage", category: "chat.cat.memory" },
  { name: "/thinking", description: "chat.cmd.thinking_desc", usage: "/thinking off|low|medium|high", category: "chat.cat.settings" },
  { name: "/verbose", description: "chat.cmd.verbose_desc", usage: "/verbose on|off", category: "chat.cat.settings" },
  { name: "/usage", description: "chat.cmd.usage_desc", usage: "/usage off|tokens|full", category: "chat.cat.settings" },
  { name: "/cron", description: "chat.cmd.cron_desc", usage: "/cron list", category: "chat.cat.tasks" },
  { name: "/plugin", description: "chat.cmd.plugin_desc", usage: "/plugin list", category: "chat.cat.plugins" },
  { name: "/focus", description: "chat.cmd.focus_desc", usage: "/focus <type> <id>", category: "chat.cat.advanced" },
  { name: "/unfocus", description: "chat.cmd.unfocus_desc", category: "chat.cat.advanced" },
  { name: "/agents", description: "chat.cmd.agents_desc", category: "chat.cat.advanced" },
];

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
    try {
      localStorage.setItem("evoclaw_permission_whitelist", JSON.stringify(list));
    } catch {
      // 私密浏览模式或配额超限时忽略
    }
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

/**
 * 压缩图片：将大图片缩放到指定尺寸并转为 JPEG base64。
 * 减少 base64 内联上传时的 JSON 负载（典型压缩比 5-10x）。
 */
async function compressImage(file: File, maxDim: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round(height * (maxDim / width));
            width = maxDim;
          } else {
            width = Math.round(width * (maxDim / height));
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("Canvas context unavailable")); return; }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("Image load failed"));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

export function WebChatPage({ sessionId: initialSessionId, avatars, onSessionCreated }: { sessionId?: string | null; avatars?: AvatarInfo; onSessionCreated?: (sessionId: string) => void }) {
  const { t, lang } = useTranslation();
  const [messages, setMessages] = useState<WebChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const isStreamingRef = useRef(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [showThinking, setShowThinking] = useState<Record<string, boolean>>({});
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [currentProgress, setCurrentProgress] = useState(0);
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null);
  const [msgViewModes, setMsgViewModes] = useState<Record<string, "preview" | "raw">>({});
  const [contextUsed, setContextUsed] = useState(0);
  const [contextLimit, setContextLimit] = useState(128000);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFileInfo[]>([]);
  const [textAreaExpandLevel, setTextAreaExpandLevel] = useState(0); // 0=2行, 1=5行, 2=10行
  const [isTextareaHovered, setIsTextareaHovered] = useState(false);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [showQueuePanel, setShowQueuePanel] = useState(false);
  const [showCommandPanel, setShowCommandPanel] = useState(false);
  const [commandFilter, setCommandFilter] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [inputHistoryEnabled, setInputHistoryEnabled] = useState(true);
  const [inputHistoryMax, setInputHistoryMax] = useState(256);
  const [historyPositionHint, setHistoryPositionHint] = useState<string | null>(null);

  // Voice input state
  const [voiceEnabledBackend, setVoiceEnabledBackend] = useState(false);
  const [voiceConfig, setVoiceConfig] = useState<VoiceApiResponse["config"] | null>(null);
  const [voiceInterim, setVoiceInterim] = useState("");
  const [voiceToast, setVoiceToast] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const statusAbortControllerRef = useRef<AbortController | null>(null);
  const voiceAbortControllerRef = useRef<AbortController | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const intervalsRef = useRef<ReturnType<typeof setInterval>[]>([]);
  const dequeueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { return () => { if (dequeueTimerRef.current) clearTimeout(dequeueTimerRef.current); }; }, []);
  const userAbortedRef = useRef(false);
  const inputHistoryRef = useRef<string[]>([]);
  // Load persisted input history from localStorage
  if (inputHistoryRef.current.length === 0) {
    try {
      const saved = localStorage.getItem("evoclaw_input_history");
      if (saved) inputHistoryRef.current = JSON.parse(saved);
    } catch { /* ignore */ }
  }
  const historyIndexRef = useRef(-1);
  const savedInputRef = useRef("");
  const lastArrowKeyTimeRef = useRef(0);
  const effectiveSessionIdRef = useRef<string | null>(null);
  const hasLocalMessagesRef = useRef(false);
  const sessionMessagesCache = useRef<Map<string, WebChatMessage[]>>(new Map());
  const currentMessagesRef = useRef<WebChatMessage[]>([]);
  const attachedFilesRef = useRef<AttachedFileInfo[]>([]);

  // Permission state
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);

  const handleStop = useCallback(() => {
    userAbortedRef.current = true;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
    isStreamingRef.current = false;
    setStatusMessage(null);
  }, []);

  const pushInputHistory = useCallback((text: string) => {
    if (!inputHistoryEnabled || !text.trim()) return;
    const hist = inputHistoryRef.current;
    const idx = hist.indexOf(text);
    if (idx !== -1) hist.splice(idx, 1);
    hist.unshift(text);
    if (hist.length > inputHistoryMax) hist.length = inputHistoryMax;
    try { localStorage.setItem("evoclaw_input_history", JSON.stringify(hist)); } catch { /* quota exceeded */ }
  }, [inputHistoryEnabled, inputHistoryMax]);

  const showHistoryHint = useCallback((index: number) => {
    const hist = inputHistoryRef.current;
    if (hist.length === 0) return;
    const pos = index === -1 ? hist.length + 1 : index + 1;
    setHistoryPositionHint(`${pos}/${hist.length}`);
    setTimeout(() => setHistoryPositionHint(null), 1500);
  }, []);

  const handleEnqueue = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    if (messageQueue.length >= 10) {
      setStatusMessage(t("chat.queue_full"));
      setTimeout(() => setStatusMessage(null), 2000);
      return;
    }
    setMessageQueue(prev => [...prev, text]);
    setInput("");
    // Also sync to backend QueueManager
    const sid = effectiveSessionIdRef.current;
    if (sid) {
      fetch("/api/queue/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, message: text, mode: "followup" }),
      }).catch(() => {});
    }
  }, [input, messageQueue.length]);

  const handleDequeue = useCallback((index: number) => {
    setMessageQueue(prev => {
      const item = prev[index];
      const newQueue = prev.filter((_, i) => i !== index);
      // Also sync to backend
      const sid = effectiveSessionIdRef.current;
      if (sid && item) {
        fetch(`/api/queue/${encodeURIComponent(item)}`, { method: "DELETE" }).catch(() => {});
      }
      return newQueue;
    });
  }, []);

  // ── Load messages when sessionId prop changes ──
  useEffect(() => {
    const prevSessionId = effectiveSessionIdRef.current;
    effectiveSessionIdRef.current = initialSessionId || null;

    // Save current messages to cache for the previous session
    if (prevSessionId && currentMessagesRef.current.length > 0) {
      sessionMessagesCache.current.set(prevSessionId, [...currentMessagesRef.current]);
    }

    setContextUsed(0);
    setMessageQueue([]);
    setShowQueuePanel(false);

    if (!initialSessionId) {
      setMessages([]);
      hasLocalMessagesRef.current = false;
      return;
    }

    // Check cache first
    const cached = sessionMessagesCache.current.get(initialSessionId);
    if (cached && cached.length > 0) {
      setMessages(cached);
      hasLocalMessagesRef.current = true;
      const allText = cached.map(t => t.content || "").join("");
      setContextUsed(estimateTokens(allText));
      return;
    }

    // No cache — load from server
    hasLocalMessagesRef.current = false;
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
          sessionMessagesCache.current.set(initialSessionId, turns);
          hasLocalMessagesRef.current = true;
          const allText = turns.map(t => t.content || "").join("");
          setContextUsed(estimateTokens(allText));
        } else {
          setMessages([]);
        }
      } catch {
        setMessages([]);
      } finally {
        setIsLoadingHistory(false);
      }
    })();
  }, [initialSessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages]);

  useEffect(() => {
    currentMessagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    attachedFilesRef.current = attachedFiles;
  }, [attachedFiles]);

  useEffect(() => {
    const sid = effectiveSessionIdRef.current;
    if (sid && messages.length > 0) {
      sessionMessagesCache.current.set(sid, [...messages]);
    }
  }, [messages]);

  // Voice setup
  const onVoiceResult = useCallback((text: string, isFinal: boolean) => {
    if (!isFinal) {
      setVoiceInterim(text);
      return;
    }
    setVoiceInterim("");
    setInput((prev) => {
      const combined = (prev.trim() + " " + text).trim();
      return combined;
    });
    if (voiceConfig?.autoSubmit && text.trim()) {
      setTimeout(() => handleSendRef.current(text.trim()), 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceConfig?.autoSubmit]);

  const onVoiceError = useCallback((error: string) => {
    setVoiceToast(`${t("chat.voice_not_supported")}: ${error}`);
    setTimeout(() => setVoiceToast(null), 4000);
  }, [t]);

  const onVoiceStateChange = useCallback((state: VoiceState) => {
    if (state === "listening") {
      setVoiceToast(t("chat.voice_listening"));
    } else if (state === "error") {
      setVoiceToast(t("chat.voice_not_supported"));
      setTimeout(() => setVoiceToast(null), 4000);
    } else {
      setVoiceToast(null);
    }
  }, [t]);

  const voice = useVoice({
    language: voiceConfig?.language || "zh-CN",
    continuous: voiceConfig?.continuous ?? true,
    interimResults: voiceConfig?.interimResults ?? true,
    autoSubmit: false,
    onResult: onVoiceResult,
    onError: onVoiceError,
    onStateChange: onVoiceStateChange,
  });

  const refreshVoiceConfig = useCallback(() => {
    voiceAbortControllerRef.current?.abort();
    voiceAbortControllerRef.current = new AbortController();
    voiceApi.get(voiceAbortControllerRef.current.signal).then((data) => {
      setVoiceConfig(data.config);
      setVoiceEnabledBackend(data.config.enabled && data.status.available);
    }).catch(() => {
      setVoiceEnabledBackend(false);
    });
  }, []);

  useEffect(() => {
    refreshVoiceConfig();
    const interval = setInterval(refreshVoiceConfig, 60000);
    const onVisible = () => { if (!document.hidden) refreshVoiceConfig(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      voiceAbortControllerRef.current?.abort();
      voiceAbortControllerRef.current = null;
    };
  }, [refreshVoiceConfig]);

  // Cleanup: revoke blob URLs and clear intervals/timers on unmount
  useEffect(() => {
    return () => {
      // 使用 ref 获取最新的 attachedFiles，避免空依赖闭包捕获初始值导致 blob URL 泄漏
      attachedFilesRef.current.forEach(f => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      });
      intervalsRef.current.forEach(id => clearInterval(id));
      intervalsRef.current = [];
      timersRef.current.forEach(id => clearTimeout(id));
      timersRef.current = [];
      statusAbortControllerRef.current?.abort();
      statusAbortControllerRef.current = null;
      voiceAbortControllerRef.current?.abort();
      voiceAbortControllerRef.current = null;
      voice.stopListening();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSendRef = useRef<(queuedText?: string) => void>(() => {});
  useEffect(() => {
    handleSendRef.current = handleSend;
  });
  const handleSend = async (queuedText?: string) => {
    voice.stopListening();
    userAbortedRef.current = false;
    const text = (queuedText || input).trim();
    const readyFiles = queuedText ? [] : attachedFiles.filter(f => f.status === "done");
    const hasContent = text.length > 0 || readyFiles.length > 0;
    if (!hasContent || isStreamingRef.current) return;

    let sessionId = effectiveSessionIdRef.current;
    if (!sessionId) {
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: "default" }),
        });
        if (res.ok) {
          const data = await res.json();
          sessionId = data.session?.sessionId || data.sessionId;
          if (sessionId) {
            effectiveSessionIdRef.current = sessionId;
            onSessionCreated?.(sessionId);
          }
        }
        if (!sessionId) {
          showToast(t("chat.session_create_failed", "创建会话失败，请重试"), "error");
          return;
        }
      } catch (err) {
        console.warn("[Chat] Session creation failed:", err);
        showToast(t("chat.session_create_failed", "创建会话失败，请重试"), "error");
        return;
      }
    }

    const attachmentsForMsg = readyFiles.length > 0 ? readyFiles.map(f => ({...f})) : undefined;

    const userMsg: WebChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text || (readyFiles.length > 0 ? t("chat.files_sent").replace("{0}", String(readyFiles.length)) : ""),
      timestamp: new Date().toISOString(),
      attachments: attachmentsForMsg,
    };

    setMessages((prev) => [...prev, userMsg]);
    hasLocalMessagesRef.current = true;
    pushInputHistory(text);
    if (!queuedText) {
      setInput("");
      if (readyFiles.length > 0) {
        setAttachedFiles(prev => {
        const done = prev.filter(f => f.status === "done");
        done.forEach(f => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
        return prev.filter(f => f.status !== "done");
      });
      }
    }
    setIsStreaming(true);
    isStreamingRef.current = true;
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
    intervalsRef.current.push(progressInterval);

    const statusInterval = setInterval(async () => {
      try {
        statusAbortControllerRef.current?.abort();
        statusAbortControllerRef.current = new AbortController();
        const res = await fetch(`/api/chat/status?sessionId=${sessionId}`, { signal: statusAbortControllerRef.current.signal });
        if (res.ok) {
          const status = await res.json();
          if (status && status.phase && status.phase !== "idle") {
            const phaseLabels: Record<string, string> = {
              thinking: t("chat.phase.thinking"),
              tool_calling: t("chat.phase.tool_calling"),
              generating: t("chat.phase.generating"),
              done: t("chat.phase.done"),
              error: t("chat.phase.error"),
              splitting: t("chat.phase.splitting"),
              subtask_executing: t("chat.phase.subtask_executing"),
              resuming: t("chat.phase.resuming"),
              working: t("chat.phase.working"),
            };
            const label = phaseLabels[status.phase] || status.phase;
            const subtaskInfo = status.subtaskIndex !== undefined && status.subtaskTotal !== undefined
              ? ` (${status.subtaskIndex + 1}/${status.subtaskTotal})`
              : "";
            setStatusMessage(`${label}${subtaskInfo}: ${status.detail}`);
            setCurrentProgress(prev => Math.max(prev, status.progress || 0));
          }
        }
      } catch { /* ignore polling errors */ }
    }, 3000);
    intervalsRef.current.push(statusInterval);

    try {
      const attachmentPayload = readyFiles.length > 0 ? readyFiles.map(f => ({
        name: f.name,
        type: f.type,
        size: f.size,
        data: f.data || null,
      })) : undefined;

      const FETCH_TIMEOUT = 1_200_000;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      setProgressSteps([]);

      let res: Response;
      try {
        res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            message: text, 
            sessionId: sessionId,
            attachments: attachmentPayload,
            stream: true,
          }),
          signal: controller.signal,
        });
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        abortControllerRef.current = null;
        if (fetchErr instanceof DOMException && fetchErr.name === "AbortError") {
          const wasUserAbort = userAbortedRef.current;
          userAbortedRef.current = false;
          const abortMsg = wasUserAbort
            ? t("chat.stopped")
            : t("chat.timeout");
          setMessages((prev) =>
            prev.map((m) =>
              m.id === botMsgId
                ? { ...m, content: m.content ? m.content + "\n\n---\n⚠️ " + abortMsg : "⚠️ " + abortMsg }
                : m,
            ),
          );
        } else {
          const netErrMsg = t("chat.network_error", "Network error — cannot reach server");
          setMessages((prev) =>
            prev.map((m) =>
              m.id === botMsgId
                ? { ...m, content: m.content ? m.content + "\n\n---\n⚠️ " + netErrMsg : "⚠️ " + netErrMsg }
                : m,
            ),
          );
        }
        return;
      } finally {
        clearTimeout(timeoutId);
      }

      const contentType = res.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalData: Record<string, unknown> | null = null;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            let currentEvent = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) {
                currentEvent = line.slice(7).trim();
              } else if (line.startsWith("data: ") && currentEvent) {
                try {
                  const eventData = JSON.parse(line.slice(6));

                  if (currentEvent === "done") {
                    finalData = eventData;
                  } else if (currentEvent === "error") {
                    const errMsg = eventData.message || t("chat.process_error");
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === botMsgId
                          ? { ...m, content: m.content ? m.content + "\n\n---\n⚠️ " + errMsg : "⚠️ " + errMsg }
                          : m,
                      ),
                    );
                  } else if (currentEvent === "understanding") {
                    const step: ProgressStep = {
                      type: "understanding",
                      detail: eventData.text || "",
                      timestamp: Date.now(),
                    };
                    setProgressSteps((prev) => [...prev, step]);
                    setStatusMessage(`📋 ${eventData.text || t("chat.processing")}`);
                  } else if (currentEvent === "working") {
                    setStatusMessage(`${t("chat.phase.working_emoji")} ${eventData.detail || t("chat.working")}`);
                  } else if (currentEvent === "progress_summary") {
                    const summaryType = eventData.type as string;
                    const summaryCount = eventData.count as number;
                    const detail = eventData.detail as string || "";
                    let label = "";
                    if (summaryType === "search_progress") {
                      label = t("chat.search_progress").replace("{0}", String(summaryCount));
                    } else if (summaryType === "fetch_progress") {
                      label = t("chat.fetch_progress").replace("{0}", String(summaryCount));
                    } else if (summaryType === "search_done") {
                      label = t("chat.search_done").replace("{0}", String(summaryCount));
                    } else if (summaryType === "fetch_done") {
                      label = t("chat.fetch_done").replace("{0}", String(summaryCount));
                    }
                    const step: ProgressStep = {
                      type: "progress_summary",
                      detail: label,
                      timestamp: Date.now(),
                      summaryType,
                      summaryCount,
                    };
                    setProgressSteps((prev) => {
                      const filtered = prev.filter(s =>
                        !(s.type === "progress_summary" && s.summaryType === summaryType && s.summaryCount === summaryCount)
                      );
                      return [...filtered, step];
                    });
                    if (label) setStatusMessage(label);
                  } else {
                    const step: ProgressStep = {
                      type: eventData.type || currentEvent,
                      detail: eventData.detail || "",
                      progress: eventData.progress,
                      toolName: eventData.toolName,
                      toolResult: eventData.toolResult,
                      toolError: eventData.toolError,
                      round: eventData.round,
                      timestamp: Date.now(),
                    };
                    const isSearchOrFetchResult = step.type === "tool_result" && (step.toolName === "web_search" || step.toolName === "fetch_node_page");
                    if (!isSearchOrFetchResult) {
                      setProgressSteps((prev) => {
                        const lastStep = prev[prev.length - 1];
                        if (lastStep && lastStep.type === step.type && lastStep.toolName === step.toolName && lastStep.detail === step.detail) {
                          return prev;
                        }
                        return [...prev, step];
                      });
                    }

                    if (eventData.phase === "generating" && eventData.reply) {
                      setMessages((prev) =>
                        prev.map((m) => {
                          if (m.id !== botMsgId) return m;
                          const newReply = eventData.reply as string;
                          const currentContent = m.content || "";
                          // If new reply is shorter than current content, this is a new LLM round
                          // Move current content to intermediate output, start fresh with new round
                          if (newReply.length < currentContent.length * 0.5 && currentContent.length > 50) {
                            const prevIntermediate = m.intermediateOutput || "";
                            return {
                              ...m,
                              intermediateOutput: prevIntermediate ? prevIntermediate + "\n\n---\n" + currentContent : currentContent,
                              content: newReply,
                            };
                          }
                          return { ...m, content: newReply };
                        }),
                      );
                    }

                    if (eventData.phase) {
                      const phaseLabels: Record<string, string> = {
                        thinking: t("chat.phase.thinking_emoji"),
                        tool_calling: t("chat.phase.tool_calling_emoji"),
                        generating: t("chat.phase.generating_emoji"),
                        done: t("chat.phase.done_emoji"),
                        error: t("chat.phase.error_emoji"),
                        splitting: t("chat.phase.splitting_emoji"),
                        subtask_executing: t("chat.phase.subtask_executing_emoji"),
                        resuming: t("chat.phase.resuming_emoji"),
                        working: t("chat.phase.working_emoji"),
                      };
                      const label = phaseLabels[eventData.phase] || eventData.phase;
                      const subtaskInfo = eventData.subtaskIndex !== undefined && eventData.subtaskTotal !== undefined
                        ? ` (${eventData.subtaskIndex + 1}/${eventData.subtaskTotal})`
                        : "";
                      setStatusMessage(`${label}${subtaskInfo}: ${eventData.detail}`);
                    }
                    if (typeof eventData.progress === "number") {
                      setCurrentProgress(eventData.progress);
                    }
                  }
                } catch { /* ignore parse errors */ }
                currentEvent = "";
              } else if (line.trim() === "") {
                currentEvent = "";
              }
            }
          }
        } catch (readErr) {
          if (readErr instanceof DOMException && readErr.name === "AbortError") {
            const wasUserAbort = userAbortedRef.current;
            userAbortedRef.current = false;
            const abortMsg = wasUserAbort ? t("chat.stopped") : t("chat.timeout_short");
            setMessages((prev) =>
              prev.map((m) =>
                m.id === botMsgId
                  ? { ...m, content: m.content ? m.content + "\n\n---\n⚠️ " + abortMsg : "⚠️ " + abortMsg }
                  : m,
              ),
            );
            return;
          }
        }

        if (finalData) {
          if (finalData.permissionRequests && (finalData.permissionRequests as Array<unknown>).length > 0) {
            const reqs: PermissionRequest[] = (finalData.permissionRequests as Array<Record<string, unknown>>).map((p) => ({
              id: (p.id as string) || "",
              operation: (p.operation as string) || "",
              description: (p.description as string) || "",
              target: (p.target as string) || "",
              messageId: botMsgId,
            }));
            const nonWhitelisted = reqs.filter((r) => !isWhitelisted(r.operation));
            if (nonWhitelisted.length > 0) {
              setPendingPermissions(nonWhitelisted);
              setShowPermissionModal(true);
              return;
            } else {
              await autoApprovePermissions(reqs);
            }
          }

          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== botMsgId) return m;
              const finalReply = (finalData!.reply as string) || "";
              const finalContent = finalReply || m.content || t("chat.empty_response", "(empty response from server)");
              return {
                ...m,
                content: finalContent,
                intermediateOutput: m.intermediateOutput, // keep intermediate output visible
                files: (finalData!.files as Array<{ path: string; size: number; downloadUrl: string }>) || [],
              };
            }),
          );

          // Use contextTokens (prompt_tokens from last LLM call) for context usage display,
          // NOT tokensUsed (cumulative total_tokens which includes all rounds)
          if (typeof finalData.contextTokens === "number" && (finalData.contextTokens as number) > 0) {
            setContextUsed(finalData.contextTokens as number);
          } else if (typeof finalData.tokensUsed === "number" && (finalData.tokensUsed as number) > 0) {
            setContextUsed(finalData.tokensUsed as number);
          } else {
            const allText = (currentMessagesRef.current || messages).map(m => m.content).join("") + text + ((finalData.reply as string) || "");
            setContextUsed(estimateTokens(allText));
          }
          if (typeof finalData.contextLimit === "number") {
            setContextLimit(finalData.contextLimit as number);
          }
        }
      } else if (res.ok) {
        const data = await res.json();
        
        if (data.permissionRequests && data.permissionRequests.length > 0) {
          const reqs: PermissionRequest[] = data.permissionRequests.map((p: Record<string, unknown>) => ({
            id: (p.id as string) || "",
            operation: (p.operation as string) || "",
            description: (p.description as string) || "",
            target: (p.target as string) || "",
            messageId: botMsgId,
          }));
          const nonWhitelisted = reqs.filter((r) => !isWhitelisted(r.operation));
          if (nonWhitelisted.length > 0) {
            setPendingPermissions(nonWhitelisted);
            setShowPermissionModal(true);
            return;
          } else {
            await autoApprovePermissions(reqs);
          }
        }
        
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== botMsgId) return m;
            const nonStreamReply = data.reply || "";
            const nonStreamContent = nonStreamReply || m.content || t("chat.empty_response", "(empty response from server)");
            return {
              ...m,
              content: nonStreamContent,
              files: (data.files as Array<{ path: string; size: number; downloadUrl: string }>) || [],
            };
          }),
        );

        if (typeof data.tokensUsed === "number" && data.tokensUsed > 0) {
          setContextUsed(data.tokensUsed);
        } else {
          const allText = (currentMessagesRef.current || messages).map(m => m.content).join("") + text + (data.reply || "");
          setContextUsed(estimateTokens(allText));
        }
        if (typeof data.contextLimit === "number" && data.contextLimit > 0) {
          setContextLimit(data.contextLimit);
        }
      } else {
        const errText = await res.text().catch(() => "");
        const srvErrMsg = `Server error: ${errText.slice(0, 200)}`;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === botMsgId
              ? { ...m, content: m.content ? m.content + "\n\n---\n⚠️ " + srvErrMsg : "⚠️ " + srvErrMsg }
              : m,
          ),
        );
      }
    } catch {
      const unexpErrMsg = t("chat.unexpected_error", "Unexpected error — please retry");
      setMessages((prev) =>
        prev.map((m) =>
          m.id === botMsgId
            ? { ...m, content: m.content ? m.content + "\n\n---\n⚠️ " + unexpErrMsg : "⚠️ " + unexpErrMsg }
            : m,
        ),
      );
    } finally {
      clearInterval(progressInterval);
      clearInterval(statusInterval);
      intervalsRef.current = intervalsRef.current.filter(id => id !== progressInterval && id !== statusInterval);
      statusAbortControllerRef.current?.abort();
      statusAbortControllerRef.current = null;
      setStatusMessage(null);
      setIsStreaming(false);
    isStreamingRef.current = false;
      setCurrentProgress(100);
      setProgressSteps([]);
      abortControllerRef.current = null;

      // Auto-dequeue next message if queue has items
      setMessageQueue(prev => {
        if (prev.length > 0 && sessionId) {
          const nextMsg = prev[0];
          const remaining = prev.slice(1);
          dequeueTimerRef.current = setTimeout(() => handleSend(nextMsg), 300);
          return remaining;
        }
        return prev;
      });
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
    } catch (err) {
      console.warn("[Chat] Auto-approve permissions failed:", err);
    }
  };

  const handlePermissionAction = async (action: "approve" | "approveAndWhitelist" | "deny") => {
    // Capture pending permissions and target message id before clearing modal state
    const reqs = pendingPermissions;
    const targetMessageId = reqs[0]?.messageId;

    // Immediately close modal for better UX
    setShowPermissionModal(false);
    setPendingPermissions([]);

    try {
      if (action === "approve" || action === "approveAndWhitelist") {
        // Approve all pending permissions
        for (const perm of reqs) {
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
        // Retry the most recent user message after approval — 复用已有流式逻辑，由 handleSend 自行管理 isStreaming 状态
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
        if (lastUserMsg && effectiveSessionIdRef.current) {
          handleSendRef.current(lastUserMsg.content);
          return;
        }
      } else {
        // Deny all pending permissions
        for (const perm of reqs) {
          await fetch("/api/permission/deny", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestId: perm.id }),
          });
        }
        // Update message to show denial
        setMessages((prev) =>
          prev.map((m) =>
            m.id === targetMessageId
              ? { ...m, content: m.content ? m.content + "\n\n---\n⚠️ " + t("chat.permission_denied") : "⚠️ " + t("chat.permission_denied") }
              : m,
          ),
        );
      }
    } catch (err) {
      console.warn("[Chat] Permission action failed:", err);
    }
    
    setIsStreaming(false);
    isStreamingRef.current = false;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isComposingRef.current || e.nativeEvent.isComposing) return;

    if (showCommandPanel) {
      const filtered = SLASH_COMMANDS.filter(cmd =>
        cmd.name.toLowerCase().includes("/" + commandFilter) ||
        cmd.description.toLowerCase().includes(commandFilter)
      );
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedCommandIndex(prev => Math.min(prev + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedCommandIndex(prev => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (filtered.length > 0) {
          const cmd = filtered[selectedCommandIndex];
          setInput(cmd.name + " ");
          setShowCommandPanel(false);
          setCommandFilter("");
          inputRef.current?.focus();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowCommandPanel(false);
        setCommandFilter("");
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (filtered.length > 0) {
          const cmd = filtered[selectedCommandIndex];
          setInput(cmd.name + " ");
          setShowCommandPanel(false);
          setCommandFilter("");
        }
        return;
      }
    }

    // ── Input history navigation with Up/Down arrows ──
    if (inputHistoryEnabled && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const textarea = inputRef.current;
      const hist = inputHistoryRef.current;

      if (textarea && hist.length > 0 && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const now = Date.now();
        if (now - lastArrowKeyTimeRef.current < 60) {
          e.preventDefault();
          return;
        }
        lastArrowKeyTimeRef.current = now;

        if (e.key === "ArrowUp") {
          const cursorAtStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0;
          if (cursorAtStart || historyIndexRef.current >= 0) {
            e.preventDefault();
            if (historyIndexRef.current === -1) {
              savedInputRef.current = input;
              historyIndexRef.current = 0;
            } else {
              historyIndexRef.current = (historyIndexRef.current + 1) % hist.length;
            }
            setInput(hist[historyIndexRef.current]);
            showHistoryHint(historyIndexRef.current);
            return;
          }
        }

        if (e.key === "ArrowDown") {
          if (historyIndexRef.current >= 0) {
            e.preventDefault();
            const cursorAtEnd = textarea.selectionStart === input.length && textarea.selectionEnd === input.length;
            if (cursorAtEnd || historyIndexRef.current >= 0) {
              if (historyIndexRef.current === 0) {
                setInput(savedInputRef.current);
                historyIndexRef.current = -1;
                showHistoryHint(-1);
              } else {
                historyIndexRef.current = (historyIndexRef.current - 1 + hist.length) % hist.length;
                setInput(hist[historyIndexRef.current]);
                showHistoryHint(historyIndexRef.current);
              }
            }
            return;
          }
        }
      }
    }

    // Reset history navigation on any other key
    if (historyIndexRef.current !== -1 && e.key !== "ArrowUp" && e.key !== "ArrowDown") {
      historyIndexRef.current = -1;
      savedInputRef.current = "";
    }

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
    const val = e.target.value;
    setInput(val);
    if (val.startsWith("/")) {
      setCommandFilter(val.slice(1).toLowerCase());
      setShowCommandPanel(true);
      setSelectedCommandIndex(0);
    } else {
      setShowCommandPanel(false);
      setCommandFilter("");
    }
  }, []);

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const sec = String(d.getSeconds()).padStart(2, "0");
    return t("chat.date_format")
      .replace("{0}", String(year))
      .replace("{1}", month)
      .replace("{2}", day)
      .replace("{3}", hour)
      .replace("{4}", min)
      .replace("{5}", sec);
  };

  const getNickname = (role: string) => {
    if (role === "user") return avatars?.userNickname || "Me";
    if (role === "assistant") return avatars?.botNickname || "EvoClaw";
    return null;
  };

  const renderMessageContent = (msg: WebChatMessage) => {
    if (!msg.content) return null;
    const viewMode = msgViewModes[msg.id] || "preview";
    if (viewMode === "raw") {
      return <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, fontFamily: "monospace", fontSize: "13px", lineHeight: "1.6" }}>{msg.content}</pre>;
    }
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
    const lines: string[] = [`# ${t("chat.export_title")} - ${new Date().toLocaleString(lang === "en" ? "en-US" : "zh-CN")}\n`];
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
    setTimeout(() => URL.revokeObjectURL(url), 5000);
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
        setAttachedFiles(prev => prev.map(f => f.id === fileInfo.id ? { ...f, status: "error" as const, error: t("chat.upload_cancelled") } : f));
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
        const tid = setTimeout(tick, 80 + Math.random() * 60);
        timersRef.current.push(tid);
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
        if (isDuplicate) { errors.push(t("chat.file_already_added").replace("{0}", file.name)); continue; }

        // Size check
        if (file.size > MAX_FILE_SIZE) {
          errors.push(t("chat.file_too_large").replace("{0}", file.name));
          continue;
        }

        // Type check
        const isAllowedType = Object.entries(ALLOWED_TYPES).some(([mimePrefix, exts]) => {
          if (mimePrefix.endsWith("/")) return file.type.startsWith(mimePrefix);
          return file.type === mimePrefix;
        });
        const extAllowed = ALLOWED_EXTENSIONS.includes(ext);
        if (!isAllowedType && !extAllowed) {
          errors.push(t("chat.file_type_unsupported").replace("{0}", file.name).replace("{1}", ext));
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
            // 大图片先压缩再 base64，减少 JSON 负载
            if (file.size > 500 * 1024) {
              compressImage(file, 1920, 0.85).then(compressed => {
                setAttachedFiles(prev =>
                  prev.map(f => f.id === info.id ? { ...f, data: compressed, size: Math.floor(compressed.length * 0.75) } : f)
                );
              }).catch(() => {
                // 压缩失败时回退到原始 base64
                reader.readAsDataURL(file);
              });
            } else {
              reader.readAsDataURL(file);
            }
          } else if (file.type.startsWith("text/") || file.type === "application/json") {
            reader.readAsText(file);
          } else {
            // 二进制文件（PDF, docx, zip 等）也以 base64 读取，确保内容发送到服务端
            reader.readAsDataURL(file);
          }
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
  const contextUsedDisplay = contextUsed >= 1000000 ? `${(contextUsed / 1000000).toFixed(1)}M` : contextUsed > 1000 ? `${(contextUsed / 1000).toFixed(1)}k` : contextUsed;
  const contextLimitDisplay = contextLimit >= 1000000 ? `${(contextLimit / 1000000).toFixed(1)}M` : contextLimit > 1000 ? `${(contextLimit / 1000).toFixed(0)}k` : contextLimit;

  return (
    <div style={chatContainerStyle}>
      {voiceToast && (
        <div style={{
          position: "absolute" as const,
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 100,
          background: "var(--bg-sidebar, #161b22)",
          border: "1px solid var(--border, #30363d)",
          borderRadius: "20px",
          padding: "8px 16px",
          fontSize: "13px",
          color: voice.isListening ? "#ef4444" : "var(--text-primary, #c9d1d9)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}>
          {voice.isListening ? "🎙" : "🎤"} {voiceToast}
        </div>
      )}
      {/* Chat Area */}
      <div style={chatAreaStyle}>
        <div style={messagesContainerStyle}>
          {messages.length === 0 && (
            <div style={emptyStateStyle}>
              <img src="/assets/images/evoclaw-400-100.png" alt="EvoClaw" style={{ height: "48px", marginBottom: "12px" }} />
              <div style={{ fontSize: "18px", fontWeight: 600, marginBottom: "6px" }}>{t("chat.ready_to_chat")}</div>
              <div style={{ fontSize: "14px", maxWidth: "400px" }}>
                {t("chat.empty_state_desc")}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} style={messageRowStyle(msg.role)}>
              <div style={{ display: "inline-flex", flexDirection: "column", maxWidth: "75%", alignItems: msg.role === "user" ? "flex-end" : "flex-start" }}>
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
                  ...messageBubbleStyle(msg.role, msg.content),
                  border: hoveredMsgId === msg.id && msg.role === "assistant"
                    ? "1px solid var(--accent, #58a6ff)"
                    : messageBubbleStyle(msg.role, msg.content).border,
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
                {hoveredMsgId === msg.id && msg.role === "assistant" && (
                  <>
                    <button
                      style={{
                        position: "absolute",
                        top: "5px",
                        right: "32px",
                        background: "transparent",
                        border: "none",
                        borderRadius: "4px",
                        padding: "3px",
                        color: "var(--text-muted, #6e7681)",
                        cursor: "pointer",
                        zIndex: 10,
                        display: "flex",
                        alignItems: "center",
                        transition: "color 0.15s, background 0.15s",
                      }}
                      title={msgViewModes[msg.id] === "raw" ? t("chat.show_preview") : t("chat.show_raw")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMsgViewModes((prev) => ({
                          ...prev,
                          [msg.id]: prev[msg.id] === "raw" ? "preview" : "raw",
                        }));
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
                      {msgViewModes[msg.id] === "raw" ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="14" y1="4" x2="10" y2="20"/></svg>
                      )}
                    </button>
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
                      title={t("chat.copy_as_markdown")}
                      onClick={(e) => {
                        e.stopPropagation();
                        copyAsMarkdown(msg);
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
                  </>
                )}
                {/* Thinking badge */}
                {msg.thinking && (
                  <div style={thinkingBadgeStyle} onClick={() => toggleThinking(msg.id)}>
                    <span>{showThinking[msg.id] ? "💭" : "🧠"}</span>
                    <span>{t("chat.thinking")}</span>
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
                    <span>{t("chat.permission_requests_count").replace("{0}", String(msg.permissionRequests.length))}</span>
                  </div>
                )}

                {/* File download links */}
                {msg.files && msg.files.length > 0 && (
                  <div style={{ marginBottom: "8px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {msg.files.map((f, i) => (
                      <a
                        key={i}
                        href={f.downloadUrl}
                        download
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: "inline-flex", alignItems: "center", gap: "6px",
                          padding: "6px 12px", borderRadius: "8px",
                          background: "var(--bg-card, rgba(124,58,237,0.1))",
                          border: "1px solid var(--border, rgba(124,58,237,0.3))",
                          color: "var(--accent, #7c3aed)", textDecoration: "none",
                          fontSize: "13px", fontWeight: 500,
                          transition: "background 0.2s, transform 0.1s",
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover, rgba(124,58,237,0.2))"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-card, rgba(124,58,237,0.1))"; }}
                      >
                        <span>📄</span>
                        <span>{f.path.split("/").pop() || f.path}</span>
                        <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                          ({f.size > 1024 ? `${(f.size / 1024).toFixed(1)}KB` : `${f.size}B`})
                        </span>
                      </a>
                    ))}
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
                    {msg.intermediateOutput && (
                      <details style={{ marginBottom: "8px" }}>
                        <summary style={{ fontSize: "11px", color: "var(--text-muted)", cursor: "pointer", userSelect: "none" }}>
                          {t("chat.intermediate_output", "中间过程")}
                        </summary>
                        <div style={{ fontSize: "12px", color: "var(--text-muted)", opacity: 0.8, maxHeight: "200px", overflowY: "auto", marginTop: "4px" }}>
                          <div dangerouslySetInnerHTML={{ __html: renderMessageHtml(msg.intermediateOutput) }} />
                        </div>
                      </details>
                    )}
                    {msg.content !== "" ? (
                      renderMessageContent(msg)
                    ) : isStreaming ? (
                      <div style={loadingIndicatorStyle}>
                        <span>{statusMessage || t(loadingMessages[loadingMessageIndex])}</span>
                        {progressSteps.length > 0 && (
                          <div style={{ marginTop: "8px", width: "100%", maxHeight: "240px", overflowY: "auto" }}>
                            {progressSteps.slice(-12).map((step, i) => {
                              const totalSteps = Math.min(progressSteps.length, 12);
                              const baseOpacity = 0.4 + (i / totalSteps) * 0.6;
                              if (step.type === "understanding") {
                                return (
                                  <div key={i} style={{
                                    fontSize: "12px", padding: "4px 0",
                                    color: "var(--accent)", opacity: baseOpacity,
                                    borderBottom: "1px solid var(--border, #30363d)",
                                    marginBottom: "4px",
                                  }}>
                                    📋 {step.detail}
                                  </div>
                                );
                              }
                              if (step.type === "progress_summary") {
                                return (
                                  <div key={i} style={{
                                    fontSize: "12px", padding: "3px 0",
                                    color: "var(--text-primary)", opacity: baseOpacity,
                                    fontWeight: 500,
                                  }}>
                                    {step.detail}
                                  </div>
                                );
                              }
                              let icon = "📡";
                              if (step.type === "tool_call") icon = step.toolName === "web_search" ? "🔍" : step.toolName === "fetch_node_page" ? "📄" : "🔧";
                              else if (step.type === "tool_result") icon = step.toolError ? "❌" : "✅";
                              else if (step.type === "llm_call") icon = "🧠";
                              return (
                                <div key={i} style={{
                                  fontSize: "12px",
                                  color: "var(--text-secondary)",
                                  padding: "2px 0",
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "6px",
                                  opacity: baseOpacity,
                                }}>
                                  {icon}
                                  <span>{step.detail}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
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
          {/* Command panel */}
          {showCommandPanel && (() => {
            const filtered = SLASH_COMMANDS.filter(cmd =>
              cmd.name.toLowerCase().includes("/" + commandFilter) ||
              t(cmd.description).toLowerCase().includes(commandFilter)
            );
            if (filtered.length === 0) return null;
            const categories = [...new Set(filtered.map(c => c.category))];
            return (
              <div style={{
                marginBottom: "8px",
                borderRadius: "10px",
                border: "1px solid var(--border, #30363d)",
                background: "var(--bg-primary, #0d1117)",
                maxHeight: "280px",
                overflowY: "auto",
                animation: "slideDown 0.15s ease-out",
              }}>
                <div style={{ padding: "8px 12px 4px", fontSize: "11px", fontWeight: 600, color: "var(--text-muted, #6e7681)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  {t("chat.command_hints")}
                </div>
                {categories.map(cat => (
                  <div key={cat}>
                    <div style={{ padding: "4px 12px", fontSize: "10px", fontWeight: 600, color: "var(--text-muted, #6e7681)", textTransform: "uppercase", letterSpacing: "0.3px", borderTop: cat === categories[0] ? "none" : "1px solid var(--border, #30363d)" }}>
                      {t(cat)}
                    </div>
                    {filtered.filter(c => c.category === cat).map((cmd) => {
                      const globalIdx = filtered.indexOf(cmd);
                      const isSelected = globalIdx === selectedCommandIndex;
                      return (
                        <div
                          key={cmd.name}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            padding: "6px 12px",
                            cursor: "pointer",
                            background: isSelected ? "var(--accent-bg, rgba(88,166,255,0.12))" : "transparent",
                            borderLeft: isSelected ? "2px solid var(--accent, #58a6ff)" : "2px solid transparent",
                            transition: "background 0.1s, border-color 0.1s",
                          }}
                          onClick={() => {
                            setInput(cmd.name + " ");
                            setShowCommandPanel(false);
                            setCommandFilter("");
                            inputRef.current?.focus();
                          }}
                          onMouseEnter={() => setSelectedCommandIndex(globalIdx)}
                        >
                          <span style={{ fontFamily: "monospace", fontSize: "13px", fontWeight: 600, color: isSelected ? "var(--accent, #58a6ff)" : "var(--text-primary, #c9d1d9)", minWidth: "90px", flexShrink: 0 }}>
                            {cmd.name}
                          </span>
                          <span style={{ fontSize: "12px", color: "var(--text-secondary, #8b949e)", flex: 1 }}>
                            {t(cmd.description)}
                          </span>
                          {cmd.usage && (
                            <span style={{ fontSize: "10px", color: "var(--text-muted, #6e7681)", fontFamily: "monospace", marginLeft: "8px", flexShrink: 0 }}>
                              {t(cmd.usage)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
                <div style={{ padding: "4px 12px 6px", fontSize: "10px", color: "var(--text-muted, #6e7681)", borderTop: "1px solid var(--border, #30363d)", display: "flex", gap: "12px" }}>
                  <span>{t("chat.nav_hint")}</span>
                  <span>{t("chat.select_hint")}</span>
                  <span>{t("chat.tab_hint")}</span>
                  <span>{t("chat.esc_hint")}</span>
                </div>
              </div>
            );
          })()}
          {/* Text input row */}
          <div
            style={{ position: "relative" }}
            onMouseEnter={() => setIsTextareaHovered(true)}
            onMouseLeave={() => setIsTextareaHovered(false)}
          >
            <textarea
              ref={inputRef}
              id="evoclaw-chat-input"
              name="chat_message"
              className="EvoClaw-chat-textarea"
              style={{
                ...textAreaStyle,
                width: "100%",
                minHeight: textAreaExpandLevel === 0 ? "60px" : textAreaExpandLevel === 1 ? "130px" : "260px",
                maxHeight: textAreaExpandLevel === 0 ? "120px" : textAreaExpandLevel === 1 ? "300px" : "500px",
                transition: "min-height 0.2s ease",
                paddingRight: "32px",
              }}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { isComposingRef.current = true; }}
              onCompositionEnd={() => { isComposingRef.current = false; }}
              onBlur={() => { setTimeout(() => { setShowCommandPanel(false); }, 200); }}
              placeholder={t("chat.input_placeholder").replace("{0}", getNickname("assistant") || "EvoClaw")}
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
              onClick={() => setTextAreaExpandLevel(v => (v + 1) % 3)}
              title={textAreaExpandLevel === 0 ? t("chat.expand_input") : textAreaExpandLevel === 1 ? t("chat.expand_input_10") : t("chat.collapse_input")}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-tertiary, #21262d)"; e.currentTarget.style.color = "var(--text-primary, #c9d1d9)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted, #6e7681)"; }}
            >
              {textAreaExpandLevel === 2 ? "⤒" : "⤓"}
            </div>
            {/* History position hint */}
            {historyPositionHint && (
              <div style={{
                position: "absolute",
                top: "6px",
                right: "28px",
                fontSize: "10px",
                color: "var(--accent, #58a6ff)",
                background: "var(--bg-primary, #0d1117)",
                border: "1px solid var(--border, #30363d)",
                borderRadius: "4px",
                padding: "1px 6px",
                opacity: 0.9,
                zIndex: 5,
                pointerEvents: "none",
                fontFamily: "monospace",
                animation: "fadeIn 0.15s ease-out",
              }}>
                {historyPositionHint}
              </div>
            )}
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
                            {file.error || t("chat.error")}
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
                      title={isUploading ? t("chat.cancel_upload") : t("chat.remove")}
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
                title={t("chat.attach_file")}
                onClick={handleFileAttach}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-tertiary, #21262d)"; e.currentTarget.style.color = "var(--text-primary, #c9d1d9)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-secondary, #8b949e)"; }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              </button>
              {voiceEnabledBackend && (
                <button
                  style={{
                    ...inputBtnStyle,
                    color: voice.isListening ? "#ef4444" : "var(--text-secondary, #8b949e)",
                    animation: voice.isListening ? "pulse 1s infinite" : undefined,
                  }}
                  title={voice.isListening ? t("chat.voice_listening") : t("chat.voice_input")}
                  onClick={() => {
                    if (!isSpeechRecognitionSupported()) {
                      setVoiceToast(t("chat.voice_not_supported"));
                      setTimeout(() => setVoiceToast(null), 4000);
                      return;
                    }
                    voice.toggleListening();
                  }}
                  onMouseEnter={(e) => { if (!voice.isListening) { e.currentTarget.style.background = "var(--bg-tertiary, #21262d)"; e.currentTarget.style.color = "var(--text-primary, #c9d1d9)"; } }}
                  onMouseLeave={(e) => { if (!voice.isListening) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-secondary, #8b949e)"; } }}
                >
                  {voice.isListening ? "🎙" : "🎤"}
                </button>
              )}
              {voiceInterim && (
                <span style={{ fontSize: "11px", color: "var(--accent, #58a6ff)", marginLeft: "4px" }}>
                  {voiceInterim}
                </span>
              )}
              <button
                style={{ ...inputBtnStyle, display: "none" }}
                title={t("chat.open_settings")}
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
              <span style={{ color: "var(--text-muted, #6e7681)" }}>{contextUsedDisplay} / {contextLimitDisplay} {t("sessions.tokens")}</span>
              {messageQueue.length > 0 && (
                <span style={{ color: "var(--accent, #58a6ff)", fontSize: "11px" }}>{t("chat.queue_label").replace("{0}", String(messageQueue.length))}</span>
              )}
              <button
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: "11px", color: inputHistoryEnabled ? "var(--accent, #58a6ff)" : "var(--text-muted, #6e7681)", padding: "0 4px", transition: "color 0.15s" }}
                title={inputHistoryEnabled ? t("chat.history_enabled").replace("{0}", String(inputHistoryMax)) : t("chat.history_disabled")}
                onClick={() => setInputHistoryEnabled(v => !v)}
              >
                {inputHistoryEnabled ? "⏎" : "⏎̶"}
              </button>
            </div>

            {/* Right tools */}
            <div style={{ display: "flex", alignItems: "center", gap: "16px", flexShrink: 0 }}>
              <button
                style={inputBtnStyle}
                title={t("chat.export_conversation")}
                onClick={exportConversation}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-tertiary, #21262d)"; e.currentTarget.style.color = "var(--text-primary, #c9d1d9)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-secondary, #8b949e)"; }}
              >
                📥
              </button>
              {/* Queue button: visible when streaming (send→stop), add to queue */}
              {isStreaming && (
                <button
                  style={{ ...inputBtnStyle, position: "relative", color: "var(--accent, #58a6ff)" }}
                  title={messageQueue.length >= 10 ? t("chat.queue_full_title") : t("chat.add_to_queue") + (messageQueue.length > 0 ? ` (${messageQueue.length})` : "")}
                  onClick={handleEnqueue}
                  disabled={!input.trim() || messageQueue.length >= 10}
                  onMouseEnter={(e) => { if (input.trim()) { e.currentTarget.style.background = "var(--bg-tertiary, #21262d)"; e.currentTarget.style.color = "var(--text-primary, #c9d1d9)"; } }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = input.trim() && messageQueue.length < 10 ? "var(--accent, #58a6ff)" : "var(--text-secondary, #8b949e)"; }}
                >
                  📋
                  {messageQueue.length > 0 && (
                    <span style={{ position: "absolute", top: -4, right: -4, background: "var(--accent, #58a6ff)", color: "#fff", borderRadius: "50%", width: 14, height: 14, fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{messageQueue.length}</span>
                  )}
                </button>
              )}
              {isStreaming ? (
                <button
                  style={{ ...sendBtnStyle, width: "36px", height: "36px", fontSize: "16px", background: "#ef4444" }}
                  onClick={handleStop}
                  title={t("chat.stop_execution")}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#dc2626"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "#ef4444"; }}
                >
                  ■
                </button>
              ) : (
                <>
                  <button
                    style={{ ...sendBtnStyle, width: "36px", height: "36px", fontSize: "16px" }}
                    onClick={() => handleSend()}
                    disabled={!input.trim() && attachedFiles.filter(f => f.status === "done").length === 0}
                    title={t("chat.send_message")}
                  >
                    ➤
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Queue panel */}
          {showQueuePanel && messageQueue.length > 0 && (
            <div style={{ marginTop: "6px", padding: "8px 10px", borderRadius: "8px", background: "var(--bg-tertiary, #21262d)", border: "1px solid var(--border, #30363d)", maxHeight: "120px", overflowY: "auto" }}>
              <div style={{ fontSize: "11px", color: "var(--text-secondary, #8b949e)", marginBottom: "6px", fontWeight: 600 }}>{t("chat.message_queue_count").replace("{0}", String(messageQueue.length))}</div>
              {messageQueue.map((msg, idx) => (
                <div key={idx} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "4px 0", borderBottom: idx < messageQueue.length - 1 ? "1px solid var(--border, #30363d)" : "none" }}>
                  <span style={{ fontSize: "10px", color: "var(--text-muted, #6e7681)", flexShrink: 0 }}>#{idx + 1}</span>
                  <span style={{ fontSize: "12px", color: "var(--text-primary, #c9d1d9)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{msg}</span>
                  <button
                    style={{ width: 18, height: 18, borderRadius: 3, border: "none", background: "transparent", color: "var(--text-muted, #6e7681)", cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                    title={t("chat.remove")}
                    onClick={() => handleDequeue(idx)}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--error, #f87171)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted, #6e7681)"; }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Permission Modal */}
      {showPermissionModal && (
        <div style={permissionModalStyle} onClick={() => {}}>
          <div style={permissionCardStyle} onClick={(e) => e.stopPropagation()}>
            <div style={permissionTitleStyle}>{t("chat.permission_title")}</div>
            <div style={permissionDescStyle}>
              {t("chat.permission_desc")}
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
                    {t("chat.permission_target").replace("{0}", perm.target)}
                  </div>
                )}
              </div>
            ))}
            
            <div style={permissionActionsStyle}>
              <button
                style={permissionBtnStyle(false)}
                onClick={() => handlePermissionAction("approve")}
              >
                {t("chat.approve_once")}
              </button>
              <button
                style={permissionBtnStyle(true)}
                onClick={() => handlePermissionAction("approveAndWhitelist")}
              >
                {t("chat.add_to_whitelist")}
              </button>
              <button
                style={permissionBtnStyle(true, true)}
                onClick={() => handlePermissionAction("deny")}
              >
                {t("chat.deny")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}