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
import { useTranslation } from "./i18n";

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

  const lines = decoded.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockLines: string[] = [];
  let inTable = false;
  let tableRows: string[][] = [];
  let tableAlign: string[] = [];
  let inList = false;
  let listType: "ul" | "ol" = "ul";
  let listItems: string[] = [];

  const closeList = () => {
    if (inList) {
      const tag = listType;
      result.push(
        `<${tag} style="margin:4px 0;padding-left:20px;">${listItems.map((li) => `<li style="margin:2px 0;">${li}</li>`).join("")}</${tag}>`
      );
      inList = false;
      listItems = [];
    }
  };

  const closeTable = () => {
    if (inTable && tableRows.length > 0) {
      const headerRow = tableRows[0];
      const bodyRows = tableRows.slice(1);
      result.push('<table style="border-collapse:collapse;margin:8px 0;width:100%;font-size:13px;">');
      result.push("<thead><tr>");
      headerRow.forEach((cell, i) => {
        const align = tableAlign[i] || "left";
        result.push(
          `<th style="border:1px solid var(--border,rgba(255,255,255,0.1));padding:6px 10px;text-align:${align};background:var(--bg-tertiary,#21262d);font-weight:600;">${cell}</th>`
        );
      });
      result.push("</tr></thead>");
      if (bodyRows.length > 0) {
        result.push("<tbody>");
        bodyRows.forEach((row) => {
          result.push("<tr>");
          row.forEach((cell, i) => {
            const align = tableAlign[i] || "left";
            result.push(
              `<td style="border:1px solid var(--border,rgba(255,255,255,0.1));padding:6px 10px;text-align:${align};">${cell}</td>`
            );
          });
          result.push("</tr>");
        });
        result.push("</tbody>");
      }
      result.push("</table>");
      inTable = false;
      tableRows = [];
      tableAlign = [];
    }
  };

  const inlineFormat = (s: string): string => {
    let result = s;
    const linkPlaceholders: string[] = [];
    
    result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, text, link) => {
      const escapedText = htmlEscape(text);
      const escapedLink = htmlEscape(link);
      const html = `<a href="${escapedLink}" target="_blank" rel="noopener" style="color:var(--accent);">${escapedText}</a>`;
      const idx = linkPlaceholders.length;
      linkPlaceholders.push(html);
      return `\x00LINK${idx}\x00`;
    });
    result = result.replace(/\[([^\]]+)\]\((\/[^\s)]+)\)/g, (match, text, link) => {
      const escapedText = htmlEscape(text);
      const escapedLink = htmlEscape(link);
      const html = `<a href="${escapedLink}" style="color:var(--accent);">${escapedText}</a>`;
      const idx = linkPlaceholders.length;
      linkPlaceholders.push(html);
      return `\x00LINK${idx}\x00`;
    });
    
    const parts = result.split(/((?<!href=")(?:https?:\/\/[^\s<>\[\]()]+|\/api\/[^\s<>\[\]()]+))/g);
    result = parts.map((part, index) => {
      if (index % 2 === 1) {
        const isExternal = part.startsWith("http://") || part.startsWith("https://");
        const extraAttrs = isExternal ? ' target="_blank" rel="noopener"' : "";
        return `<a href="${htmlEscape(part)}" style="color:var(--accent);"${extraAttrs}>${htmlEscape(part)}</a>`;
      } else {
        let text = htmlEscape(part);
        text = text.replace(/`([^`]+)`/g, (_, code) => {
          return `<code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;font-size:13px;">${code}</code>`;
        });
        text = text.replace(/\*\*(.+?)\*\*/g, (_, bold) => {
          return `<strong style="color:var(--text-primary);">${bold}</strong>`;
        });
        text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, italic) => {
          return `<em>${italic}</em>`;
        });
        return text;
      }
    }).join("");

    for (let i = linkPlaceholders.length - 1; i >= 0; i--) {
      result = result.replace(`\x00LINK${i}\x00`, linkPlaceholders[i]);
    }
    
    return result;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (line.startsWith("```")) {
      if (inCodeBlock) {
        const safeLang = (codeBlockLang || "code").replace(/["'<>]/g, "");
        result.push(
          `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang-label">${safeLang}</span></div><pre class="code-block-pre"><code>${codeBlockLines.map((l) => htmlEscape(l)).join("\n")}</code></pre></div>`
        );
        inCodeBlock = false;
        codeBlockLines = [];
        codeBlockLang = "";
      } else {
        closeList();
        closeTable();
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        codeBlockLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^[-:]+$/.test(c))) {
        tableAlign = cells.map((c) => {
          if (c.startsWith(":") && c.endsWith(":")) return "center";
          if (c.endsWith(":")) return "right";
          return "left";
        });
        continue;
      }
      inTable = true;
      closeList();
      tableRows.push(cells.map((c) => inlineFormat(c)));
      continue;
    } else if (inTable) {
      closeTable();
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      closeList();
      result.push('<hr style="border:none;border-top:1px solid var(--border,rgba(255,255,255,0.1));margin:12px 0;"/>');
      continue;
    }

    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      closeList();
      const level = headerMatch[1].length;
      const sizes: Record<number, string> = { 1: "20px", 2: "18px", 3: "16px", 4: "15px", 5: "14px", 6: "13px" };
      result.push(
        `<h${level} style="font-size:${sizes[level]};font-weight:600;margin:12px 0 6px;padding-bottom:4px;border-bottom:1px solid var(--border,rgba(255,255,255,0.08));color:var(--text-primary);">${inlineFormat(headerMatch[2])}</h${level}>`
      );
      continue;
    }

    if (trimmed.startsWith(">")) {
      closeList();
      const quoteContent = trimmed.slice(1).trim();
      result.push(
        `<blockquote style="border-left:3px solid var(--accent,#58a6ff);padding:4px 12px;margin:6px 0;background:var(--bg-tertiary,rgba(255,255,255,0.04));color:var(--text-secondary);">${inlineFormat(quoteContent)}</blockquote>`
      );
      continue;
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      closeTable();
      if (!inList || listType !== "ul") {
        closeList();
        inList = true;
        listType = "ul";
      }
      listItems.push(inlineFormat(ulMatch[1]));
      continue;
    }

    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch) {
      closeTable();
      if (!inList || listType !== "ol") {
        closeList();
        inList = true;
        listType = "ol";
      }
      listItems.push(inlineFormat(olMatch[2]));
      continue;
    }

    closeList();
    if (trimmed === "") {
      result.push('<div style="height:8px;"></div>');
    } else {
      result.push(`<p style="margin:4px 0;line-height:1.6;">${inlineFormat(trimmed)}</p>`);
    }
  }

  if (inCodeBlock) {
    const safeLang = (codeBlockLang || "code").replace(/["'<>]/g, "");
    result.push(
      `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang-label">${safeLang}</span></div><pre class="code-block-pre"><code>${codeBlockLines.map((l) => htmlEscape(l)).join("\n")}</code></pre></div>`
    );
  }
  closeList();
  closeTable();

  return result.join("");
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
    ? "var(--userBubbleBg, var(--accent, #58a6ff))"
    : "var(--botBubbleBg, var(--bg-tertiary, #21262d))",
  color: role === "user" ? "#fff" : "var(--text-primary, #c9d1d9)",
  border: role === "user" ? "none" : "1px solid var(--botBubbleBorder, var(--border, #30363d))",
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
  { name: "/help", description: "显示所有可用命令", category: "通用" },
  { name: "/new", description: "开始新会话", usage: "/new [模型]", category: "会话" },
  { name: "/reset", description: "完全重置当前会话", category: "会话" },
  { name: "/clear", description: "清空当前对话显示", category: "会话" },
  { name: "/compact", description: "压缩会话上下文", category: "会话" },
  { name: "/status", description: "查看系统状态", category: "系统" },
  { name: "/health", description: "健康检查", category: "系统" },
  { name: "/model", description: "查看或切换模型", usage: "/model [名称]", category: "模型" },
  { name: "/skills", description: "列出已安装技能", category: "技能" },
  { name: "/memory", description: "语义记忆搜索", usage: "/memory <查询>", category: "记忆" },
  { name: "/thinking", description: "设置思考级别", usage: "/thinking off|low|medium|high", category: "设置" },
  { name: "/verbose", description: "切换详细输出", usage: "/verbose on|off", category: "设置" },
  { name: "/usage", description: "控制用量报告", usage: "/usage off|tokens|full", category: "设置" },
  { name: "/cron", description: "查看定时任务", usage: "/cron list", category: "任务" },
  { name: "/plugin", description: "查看插件列表", usage: "/plugin list", category: "插件" },
  { name: "/focus", description: "聚焦上下文目标", usage: "/focus <type> <id>", category: "高级" },
  { name: "/unfocus", description: "取消上下文聚焦", category: "高级" },
  { name: "/agents", description: "列出可用上下文目标", category: "高级" },
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
  const { t } = useTranslation();
  const [messages, setMessages] = useState<WebChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [showThinking, setShowThinking] = useState<Record<string, boolean>>({});
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [currentProgress, setCurrentProgress] = useState(0);
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null);
  const [msgViewModes, setMsgViewModes] = useState<Record<string, "preview" | "raw">>({});
  const [contextUsed, setContextUsed] = useState(0);
  const [contextLimit, setContextLimit] = useState(60000);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFileInfo[]>([]);
  const [textAreaExpanded, setTextAreaExpanded] = useState(false);
  const [isTextareaHovered, setIsTextareaHovered] = useState(false);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [showQueuePanel, setShowQueuePanel] = useState(false);
  const [showCommandPanel, setShowCommandPanel] = useState(false);
  const [commandFilter, setCommandFilter] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [inputHistoryEnabled, setInputHistoryEnabled] = useState(true);
  const [inputHistoryMax, setInputHistoryMax] = useState(256);
  const [historyPositionHint, setHistoryPositionHint] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const userAbortedRef = useRef(false);
  const inputHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const savedInputRef = useRef("");
  const lastArrowKeyTimeRef = useRef(0);
  const effectiveSessionIdRef = useRef<string | null>(null);

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
    setStatusMessage(null);
  }, []);

  const pushInputHistory = useCallback((text: string) => {
    if (!inputHistoryEnabled || !text.trim()) return;
    const hist = inputHistoryRef.current;
    const idx = hist.indexOf(text);
    if (idx !== -1) hist.splice(idx, 1);
    hist.unshift(text);
    if (hist.length > inputHistoryMax) hist.length = inputHistoryMax;
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
    setMessageQueue(prev => [...prev, text]);
    setInput("");
  }, [input]);

  const handleDequeue = useCallback((index: number) => {
    setMessageQueue(prev => prev.filter((_, i) => i !== index));
  }, []);

  // ── Load messages when sessionId prop changes ──
  useEffect(() => {
    effectiveSessionIdRef.current = initialSessionId || null;
    setContextUsed(0);
    setMessageQueue([]);
    setShowQueuePanel(false);
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
          const allText = turns.map(t => t.content || "").join("");
          setContextUsed(Math.ceil(allText.length / 4));
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
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async (queuedText?: string) => {
    userAbortedRef.current = false;
    const text = (queuedText || input).trim();
    const readyFiles = queuedText ? [] : attachedFiles.filter(f => f.status === "done");
    const hasContent = text.length > 0 || readyFiles.length > 0;
    if (!hasContent || isStreaming) return;

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
          }
        }
      } catch { /* ignore */ }
      if (!sessionId) return;
    }

    const attachmentsForMsg = readyFiles.length > 0 ? readyFiles.map(f => ({...f})) : undefined;

    const userMsg: WebChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text || (readyFiles.length > 0 ? `发送了 ${readyFiles.length} 个文件` : ""),
      timestamp: new Date().toISOString(),
      attachments: attachmentsForMsg,
    };

    setMessages((prev) => [...prev, userMsg]);
    pushInputHistory(text);
    if (!queuedText) {
      setInput("");
      if (readyFiles.length > 0) {
        setAttachedFiles(prev => prev.filter(f => f.status !== "done"));
      }
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

    const statusInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/chat/status?sessionId=${sessionId}`);
        if (res.ok) {
          const status = await res.json();
          if (status && status.phase && status.phase !== "idle") {
            const phaseLabels: Record<string, string> = {
              thinking: "思考中",
              tool_calling: "执行中",
              generating: "生成中",
              done: "已完成",
              error: "出错",
              splitting: "任务拆分中",
              subtask_executing: "子任务执行中",
              resuming: "从检查点恢复",
            };
            const label = phaseLabels[status.phase] || status.phase;
            const subtaskInfo = status.subtaskIndex !== undefined && status.subtaskTotal !== undefined
              ? ` (${status.subtaskIndex + 1}/${status.subtaskTotal})`
              : "";
            setStatusMessage(`${label}${subtaskInfo}: ${status.detail}`);
            setCurrentProgress(Math.max(currentProgress, status.progress || 0));
          }
        }
      } catch { /* ignore polling errors */ }
    }, 1500);

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
            ? "🛑 已停止生成。"
            : "⏱️ 请求超时，服务器可能繁忙或模型响应缓慢。请稍后重试或检查模型配置。";
          setMessages((prev) =>
            prev.map((m) =>
              m.id === botMsgId
                ? { ...m, role: "system", content: abortMsg }
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
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === botMsgId
                          ? { ...m, role: "system", content: eventData.message || "处理出错" }
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
                    setStatusMessage(`📋 ${eventData.text || "正在处理"}`);
                  } else if (currentEvent === "progress_summary") {
                    const summaryType = eventData.type as string;
                    const summaryCount = eventData.count as number;
                    const detail = eventData.detail as string || "";
                    let label = "";
                    if (summaryType === "search_progress") {
                      label = `✅ 已完成${summaryCount}轮网络搜索`;
                    } else if (summaryType === "fetch_progress") {
                      label = `✅ 已抓取${summaryCount}个网页内容`;
                    } else if (summaryType === "search_done") {
                      label = `✅ 网络搜索全部完成，共${summaryCount}轮`;
                    } else if (summaryType === "fetch_done") {
                      label = `✅ 网页抓取全部完成，共${summaryCount}个`;
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
                        prev.map((m) =>
                          m.id === botMsgId
                            ? { ...m, content: eventData.reply }
                            : m,
                        ),
                      );
                    }

                    if (eventData.phase) {
                      const phaseLabels: Record<string, string> = {
                        thinking: "🧠 思考中",
                        tool_calling: "🔧 执行工具",
                        generating: "✍️ 生成回复",
                        done: "✅ 完成",
                        error: "❌ 出错",
                        splitting: "📋 任务拆分中",
                        subtask_executing: "⚙️ 子任务执行中",
                        resuming: "🔄 从检查点恢复",
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
            const abortMsg = wasUserAbort ? "🛑 已停止生成。" : "⏱️ 请求超时。";
            setMessages((prev) =>
              prev.map((m) =>
                m.id === botMsgId ? { ...m, role: "system", content: abortMsg } : m,
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
            prev.map((m) =>
              m.id === botMsgId
                ? {
                    ...m,
                    content: (finalData!.reply as string) || "(empty response from server)",
                    files: (finalData!.files as Array<{ path: string; size: number; downloadUrl: string }>) || [],
                  }
                : m,
            ),
          );

          if (typeof finalData.tokensUsed === "number" && (finalData.tokensUsed as number) > 0) {
            setContextUsed(finalData.tokensUsed as number);
          } else {
            const allText = messages.map(m => m.content).join("") + text + ((finalData.reply as string) || "");
            const estimated = Math.ceil(allText.length / 4);
            setContextUsed(estimated);
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
          prev.map((m) =>
            m.id === botMsgId
              ? {
                  ...m,
                  content: data.reply || "(empty response from server)",
                  files: (data.files as Array<{ path: string; size: number; downloadUrl: string }>) || [],
                }
              : m,
          ),
        );

        if (typeof data.tokensUsed === "number" && data.tokensUsed > 0) {
          setContextUsed(data.tokensUsed);
        } else {
          const allText = messages.map(m => m.content).join("") + text + (data.reply || "");
          const estimated = Math.ceil(allText.length / 4);
          setContextUsed(estimated);
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
      setProgressSteps([]);
      abortControllerRef.current = null;

      // Auto-dequeue next message if queue has items
      setMessageQueue(prev => {
        if (prev.length > 0 && sessionId) {
          const nextMsg = prev[0];
          const remaining = prev.slice(1);
          setTimeout(() => handleSend(nextMsg), 300);
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
        if (lastUserMsg && effectiveSessionIdRef.current) {
          setIsStreaming(true);
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: lastUserMsg.content, sessionId: effectiveSessionIdRef.current }),
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
    return `${year}年${month}月${day}日 ${hour}:${min}:${sec}`;
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
  const contextUsedDisplay = contextUsed >= 1000000 ? `${(contextUsed / 1000000).toFixed(1)}M` : contextUsed > 1000 ? `${(contextUsed / 1000).toFixed(1)}k` : contextUsed;
  const contextLimitDisplay = contextLimit >= 1000000 ? `${(contextLimit / 1000000).toFixed(1)}M` : contextLimit > 1000 ? `${(contextLimit / 1000).toFixed(0)}k` : contextLimit;

  return (
    <div style={chatContainerStyle}>
      {/* Chat Area */}
      <div style={chatAreaStyle}>
        <div style={messagesContainerStyle}>
          {messages.length === 0 && (
            <div style={emptyStateStyle}>
              <img src="/assets/images/evoclaw-400-100.png" alt="EvoClaw" style={{ height: "48px", marginBottom: "12px" }} />
              <div style={{ fontSize: "18px", fontWeight: 600, marginBottom: "6px" }}>已准备好对话</div>
              <div style={{ fontSize: "14px", maxWidth: "400px" }}>
                在下方输入消息与你的 AI 助手对话，或输入／查看命令。
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
                {hoveredMsgId === msg.id && msg.role === "assistant" && (
                  <>
                    <button
                      style={{
                        position: "absolute",
                        top: "3px",
                        right: "32px",
                        background: "transparent",
                        border: "1px solid var(--border, rgba(255,255,255,0.1))",
                        borderRadius: "4px",
                        padding: "2px 6px",
                        color: "var(--text-muted, #6e7681)",
                        cursor: "pointer",
                        zIndex: 10,
                        display: "flex",
                        alignItems: "center",
                        fontSize: "10px",
                        whiteSpace: "nowrap",
                        transition: "color 0.15s, background 0.15s, border-color 0.15s",
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
                        e.currentTarget.style.borderColor = "var(--accent, #58a6ff)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.color = "var(--text-muted, #6e7681)";
                        e.currentTarget.style.borderColor = "var(--border, rgba(255,255,255,0.1))";
                      }}
                    >
                      {msgViewModes[msg.id] === "raw" ? t("chat.show_preview") : t("chat.show_raw")}
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
                      title="复制为 Markdown"
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

                {/* File download links */}
                {msg.files && msg.files.length > 0 && (
                  <div style={{ marginBottom: "8px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {msg.files.map((f, i) => (
                      <a
                        key={i}
                        href={f.downloadUrl}
                        download
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
                    {msg.content !== "" ? (
                      renderMessageContent(msg)
                    ) : isStreaming ? (
                      <div style={loadingIndicatorStyle}>
                        <span>{statusMessage || loadingMessages[loadingMessageIndex]}</span>
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
              cmd.description.toLowerCase().includes(commandFilter)
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
                  命令提示
                </div>
                {categories.map(cat => (
                  <div key={cat}>
                    <div style={{ padding: "4px 12px", fontSize: "10px", fontWeight: 600, color: "var(--text-muted, #6e7681)", textTransform: "uppercase", letterSpacing: "0.3px", borderTop: cat === categories[0] ? "none" : "1px solid var(--border, #30363d)" }}>
                      {cat}
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
                            {cmd.description}
                          </span>
                          {cmd.usage && (
                            <span style={{ fontSize: "10px", color: "var(--text-muted, #6e7681)", fontFamily: "monospace", marginLeft: "8px", flexShrink: 0 }}>
                              {cmd.usage}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
                <div style={{ padding: "4px 12px 6px", fontSize: "10px", color: "var(--text-muted, #6e7681)", borderTop: "1px solid var(--border, #30363d)", display: "flex", gap: "12px" }}>
                  <span>↑↓ 导航</span>
                  <span>↵ 选择</span>
                  <span>Tab 补全</span>
                  <span>Esc 关闭</span>
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
              onBlur={() => { setTimeout(() => { setShowCommandPanel(false); }, 200); }}
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
                style={{ ...inputBtnStyle, display: "none" }}
                title="语音输入（暂未支持）"
              >
                🎤
              </button>
              <button
                style={{ ...inputBtnStyle, display: "none" }}
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
              <span style={{ color: "var(--text-muted, #6e7681)" }}>{contextUsedDisplay} / {contextLimitDisplay} tokens</span>
              {messageQueue.length > 0 && (
                <span style={{ color: "var(--accent, #58a6ff)", fontSize: "11px" }}>队列: {messageQueue.length}</span>
              )}
              <button
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: "11px", color: inputHistoryEnabled ? "var(--accent, #58a6ff)" : "var(--text-muted, #6e7681)", padding: "0 4px", transition: "color 0.15s" }}
                title={inputHistoryEnabled ? `历史输入已启用 (↑↓浏览, 最多${inputHistoryMax}条)` : "历史输入已禁用"}
                onClick={() => setInputHistoryEnabled(v => !v)}
              >
                {inputHistoryEnabled ? "⏎" : "⏎̶"}
              </button>
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
              {messageQueue.length > 0 && (
                <button
                  style={{ ...inputBtnStyle, position: "relative", color: "var(--accent, #58a6ff)" }}
                  title={`消息队列 (${messageQueue.length})`}
                  onClick={() => setShowQueuePanel(!showQueuePanel)}
                >
                  📋
                  <span style={{ position: "absolute", top: -4, right: -4, background: "var(--accent, #58a6ff)", color: "#fff", borderRadius: "50%", width: 14, height: 14, fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{messageQueue.length}</span>
                </button>
              )}
              {isStreaming ? (
                <button
                  style={{ ...sendBtnStyle, width: "36px", height: "36px", fontSize: "16px", background: "#ef4444" }}
                  onClick={handleStop}
                  title="停止执行"
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#dc2626"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "#ef4444"; }}
                >
                  ■
                </button>
              ) : (
                <>
                  <button
                    style={{ ...inputBtnStyle, width: "36px", height: "36px", fontSize: "16px", color: "var(--accent, #58a6ff)" }}
                    title="加入队列"
                    onClick={handleEnqueue}
                    disabled={!input.trim()}
                    onMouseEnter={(e) => { if (input.trim()) { e.currentTarget.style.background = "var(--bg-tertiary, #21262d)"; e.currentTarget.style.color = "var(--text-primary, #c9d1d9)"; } }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = input.trim() ? "var(--accent, #58a6ff)" : "var(--text-secondary, #8b949e)"; }}
                  >
                    ⏎+
                  </button>
                  <button
                    style={{ ...sendBtnStyle, width: "36px", height: "36px", fontSize: "16px" }}
                    onClick={() => handleSend()}
                    disabled={!input.trim() && attachedFiles.filter(f => f.status === "done").length === 0}
                    title="发送消息"
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
              <div style={{ fontSize: "11px", color: "var(--text-secondary, #8b949e)", marginBottom: "6px", fontWeight: 600 }}>消息队列 ({messageQueue.length})</div>
              {messageQueue.map((msg, idx) => (
                <div key={idx} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "4px 0", borderBottom: idx < messageQueue.length - 1 ? "1px solid var(--border, #30363d)" : "none" }}>
                  <span style={{ fontSize: "10px", color: "var(--text-muted, #6e7681)", flexShrink: 0 }}>#{idx + 1}</span>
                  <span style={{ fontSize: "12px", color: "var(--text-primary, #c9d1d9)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{msg}</span>
                  <button
                    style={{ width: 18, height: 18, borderRadius: 3, border: "none", background: "transparent", color: "var(--text-muted, #6e7681)", cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                    title="移除"
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