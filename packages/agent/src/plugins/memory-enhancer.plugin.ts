import type { Plugin, PluginHookRegistration, BeforePromptBuildHook, SessionEndHook, AfterToolCallHook, BeforeCompactionHook, AfterCompactionHook, BeforeAgentStartHook } from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";

const MANIFEST = {
  name: "Memory Enhancer",
  version: "2.0.0",
  description: "ECC-inspired memory persistence: auto-save insights on session end, restore context on session start, preserve state across compactions, and extract reusable patterns from tool results.",
  description_zh: "ECC记忆增强：会话结束时自动保存洞察，启动时恢复上下文，压缩时保留状态，并从工具结果中提取可复用模式",
  author: "evoclaw",
};

interface SessionMemory {
  sessionId: string;
  startTime: string;
  insights: string[];
  toolResults: Map<string, { tool: string; summary: string; timestamp: string }>;
  userPreferences: string[];
  decisions: string[];
  errors: string[];
}

const MEMORY_DIR = "data/memory-sessions";
const MAX_INSIGHT_LENGTH = 500;
const MAX_SESSIONS_TO_RESTORE = 3;
const MAX_TOOL_RESULT_SUMMARY = 300;

/** Per-session memory state, keyed by sessionId.
 *  此前为单一模块变量 currentSession，并发会话会互相覆盖，导致跨会话数据泄漏。
 *  改为 Map 后每个会话拥有独立的内存状态。 */
const sessions = new Map<string, SessionMemory>();
const MAX_SESSIONS = 100;
let memoryDir: string = MEMORY_DIR;
let persistCount = 0;
let restoreCount = 0;

function ensureMemoryDir(): void {
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
  }
}

function getMemoryFilePath(sessionId: string): string {
  return path.join(memoryDir, `${sessionId}.json`);
}

function extractInsight(text: string): string {
  const patterns = [
    /(?:我喜欢|我偏好|我更倾向|我习惯用|我通常用|我偏好|我倾向|我prefer|I prefer|I like|I always use)\s*(.{5,80})/i,
    /(?:注意|重要|关键|务必|一定要|必须|critical|important|note that|make sure|must)\s*[:：]?\s*(.{5,80})/i,
    /(?:workaround|解决方案|解决办法|修复方法|fix|resolved by)\s*[:：]?\s*(.{5,80})/i,
    /(?:决定|decided|resolved|agreed)\s+(?:to|that|on|使用|采用)\s*(.{5,80})/i,
    /(?:错误|error|bug|issue|problem|失败)\s*[:：]?\s*(.{5,80})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim().slice(0, MAX_INSIGHT_LENGTH);
    }
  }
  return "";
}

function summarizeToolResult(toolName: string, result: unknown): string {
  if (!result) return "";
  const str = typeof result === "string" ? result : JSON.stringify(result);
  if (str.length <= MAX_TOOL_RESULT_SUMMARY) return str;

  if (toolName === "web_search" || toolName === "web_fetch") {
    const urlMatch = str.match(/https?:\/\/[^\s"')\]]+/g);
    const urls = urlMatch ? urlMatch.slice(0, 3).join(", ") : "";
    return `Search results: ${str.slice(0, 200)}...${urls ? ` URLs: ${urls}` : ""}`;
  }

  if (toolName === "file_create" || toolName === "file_modify") {
    const pathMatch = str.match(/(?:path|file)[:：]\s*"?([^"\n]+)/i);
    return pathMatch ? `File operation: ${pathMatch[1]}` : str.slice(0, MAX_TOOL_RESULT_SUMMARY);
  }

  return str.slice(0, MAX_TOOL_RESULT_SUMMARY);
}

function persistSession(session: SessionMemory): void {
  if (!session || session.insights.length === 0 && session.toolResults.size === 0) return;

  ensureMemoryDir();
  const data = {
    sessionId: session.sessionId,
    startTime: session.startTime,
    endTime: new Date().toISOString(),
    insights: session.insights,
    toolResults: Object.fromEntries(session.toolResults),
    userPreferences: session.userPreferences,
    decisions: session.decisions,
    errors: session.errors,
  };

  const filePath = getMemoryFilePath(session.sessionId);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    persistCount++;
    console.log(`[Memory Enhancer] Persisted session ${session.sessionId} (${session.insights.length} insights, ${session.toolResults.size} tool results)`);
  } catch (err: any) {
    console.warn(`[Memory Enhancer] Failed to persist session: ${err.message?.slice(0, 100)}`);
  }
}

function loadRecentSessions(count: number): Array<{ sessionId: string; insights: string[]; userPreferences: string[]; decisions: string[]; errors: string[] }> {
  ensureMemoryDir();
  const files = fs.readdirSync(memoryDir)
    .filter(f => f.endsWith(".json"))
    .map(f => ({ file: f, mtime: fs.statSync(path.join(memoryDir, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, count);

  const sessions: Array<{ sessionId: string; insights: string[]; userPreferences: string[]; decisions: string[]; errors: string[] }> = [];
  for (const { file } of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(memoryDir, file), "utf-8"));
      // 跳过缺少 sessionId 的损坏会话文件，避免后续 buildRestoredContext 中 slice(undefined) 崩溃
      if (typeof data.sessionId !== "string" || data.sessionId.length === 0) {
        console.warn(`[Memory Enhancer] Skipping session file "${file}": missing or invalid sessionId`);
        continue;
      }
      sessions.push({
        sessionId: data.sessionId,
        insights: data.insights || [],
        userPreferences: data.userPreferences || [],
        decisions: data.decisions || [],
        errors: data.errors || [],
      });
    } catch (err) { console.warn(`[Memory Enhancer] Failed to load session file "${file}":`, err); }
  }
  return sessions;
}

function buildRestoredContext(sessions: Array<{ sessionId: string; insights: string[]; userPreferences: string[]; decisions: string[]; errors: string[] }>): string {
  if (sessions.length === 0) return "";

  const parts: string[] = ["### Previous Session Context (auto-restored)"];

  for (const s of sessions) {
    const items: string[] = [];
    if (s.userPreferences.length > 0) items.push(`Preferences: ${s.userPreferences.join("; ")}`);
    if (s.decisions.length > 0) items.push(`Decisions: ${s.decisions.join("; ")}`);
    if (s.insights.length > 0) items.push(`Key insights: ${s.insights.slice(0, 5).join("; ")}`);
    if (s.errors.length > 0) items.push(`Known issues: ${s.errors.slice(0, 3).join("; ")}`);
    if (items.length > 0) {
      parts.push(`Session ${s.sessionId.slice(0, 8)}: ${items.join(" | ")}`);
    }
  }

  parts.push("Use this context when relevant. Do not repeat past mistakes.");
  return parts.join("\n");
}

function cleanupOldSessions(maxSessions: number = 50): void {
  ensureMemoryDir();
  const files = fs.readdirSync(memoryDir)
    .filter(f => f.endsWith(".json"))
    .map(f => ({ file: f, mtime: fs.statSync(path.join(memoryDir, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  if (files.length > maxSessions) {
    for (let i = maxSessions; i < files.length; i++) {
      try { fs.unlinkSync(path.join(memoryDir, files[i].file)); } catch {}
    }
    console.log(`[Memory Enhancer] Cleaned up ${files.length - maxSessions} old session files`);
  }
}

export function createMemoryEnhancerPlugin(): Plugin {
  const hooks: PluginHookRegistration[] = [
    {
      hookType: "before_agent_start",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as BeforeAgentStartHook;
        const sessionId = h.context?.sessionId || `session-${Date.now()}`;
        if (!sessions.has(sessionId)) {
          // 安全：限制并发会话数，防止无界增长
          if (sessions.size >= MAX_SESSIONS) {
            const oldestKey = sessions.keys().next().value;
            if (oldestKey) sessions.delete(oldestKey);
          }
          sessions.set(sessionId, {
            sessionId,
            startTime: new Date().toISOString(),
            insights: [],
            toolResults: new Map(),
            userPreferences: [],
            decisions: [],
            errors: [],
          });
        }
        return {};
      },
    },
    {
      hookType: "before_prompt_build",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as BeforePromptBuildHook;
        const recentSessions = loadRecentSessions(MAX_SESSIONS_TO_RESTORE);
        const restoredContext = buildRestoredContext(recentSessions);

        if (restoredContext) {
          restoreCount++;
          h.systemPrompt += `\n\n${restoredContext}`;
        }

        h.systemPrompt += "\n\n[Memory Enhancer v2] Long-term memory active. Past session context auto-restored above. Learn from previous decisions and avoid repeating past errors.";

        return { appendSystemContext: "" };
      },
    },
    {
      hookType: "session_end",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as SessionEndHook;
        const reason = h.reason || "completed";

        const sessionId = h.context?.sessionId;
        if (sessionId) {
          const session = sessions.get(sessionId);
          if (session) {
            persistSession(session);
            sessions.delete(sessionId);
          }
        }

        cleanupOldSessions();
        console.log(`[Memory Enhancer] Session ended: ${h.context?.sessionId}, reason: ${reason}, total persists: ${persistCount}`);
        return {};
      },
    },
    {
      hookType: "after_tool_call",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as AfterToolCallHook;
        const significantTools = ["file_create", "file_modify", "file_delete", "web_search", "web_fetch", "skill_execute", "markitdown_convert"];

        if (significantTools.includes(h.toolName) && !h.errored) {
          const sessionId = h.context?.sessionId;
          const session = sessionId ? sessions.get(sessionId) : undefined;
          if (!session) return {};

          const summary = summarizeToolResult(h.toolName, h.result);
          if (summary) {
            session.toolResults.set(`${h.toolName}-${Date.now()}`, {
              tool: h.toolName,
              summary,
              timestamp: new Date().toISOString(),
            });
          }

          if (h.toolName === "web_search" || h.toolName === "web_fetch") {
            const resultStr = typeof h.result === "string" ? h.result : JSON.stringify(h.result || {});
            const insight = extractInsight(resultStr);
            if (insight) session.insights.push(insight);
          }
        }

        if (h.errored && h.toolName) {
          const sessionId = h.context?.sessionId;
          const session = sessionId ? sessions.get(sessionId) : undefined;
          if (session) {
            session.errors.push(`${h.toolName}: ${String(h.error || "unknown error").slice(0, 200)}`);
          }
        }

        return {};
      },
    },
    {
      hookType: "before_compaction",
      priority: "first",
      handler: async (hook) => {
        const h = hook as BeforeCompactionHook;
        const sessionId = h.context?.sessionId;
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (session && session.insights.length > 0) {
          persistSession(session);
          console.log(`[Memory Enhancer] Pre-compaction save: ${session.insights.length} insights preserved`);
        }
        return {};
      },
    },
    {
      hookType: "after_compaction",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as AfterCompactionHook;
        console.log(`[Memory Enhancer] Compaction completed: ${h.turnCount} turns compacted, successor: ${h.successorSessionId?.slice(0, 8)}`);
        return {};
      },
    },
  ];

  return {
    manifest: MANIFEST,
    hooks,
    async init(context) {
      if (context) {
        memoryDir = path.join(context.dataDir || "data", "memory-sessions");
      }
      ensureMemoryDir();
      console.log(`[Memory Enhancer v2] Initialized, memory dir: ${memoryDir}`);
    },
    async shutdown() {
      for (const session of sessions.values()) {
        persistSession(session);
      }
      sessions.clear();
      console.log(`[Memory Enhancer v2] Shutting down — ${persistCount} sessions persisted, ${restoreCount} restores`);
    },
    async healthCheck() {
      ensureMemoryDir();
      const files = fs.readdirSync(memoryDir).filter(f => f.endsWith(".json"));
      return {
        healthy: true,
        message: `Active (v2.0.0, ${files.length} session files, ${persistCount} persists, ${restoreCount} restores)`,
      };
    },
  };
}

export function setCurrentSession(sessionId: string): void {
  // 并发安全：不再使用模块级 currentSession，改为按 sessionId 写入 sessions Map
  if (!sessions.has(sessionId)) {
    if (sessions.size >= MAX_SESSIONS) {
      const oldestKey = sessions.keys().next().value;
      if (oldestKey) sessions.delete(oldestKey);
    }
    sessions.set(sessionId, {
      sessionId,
      startTime: new Date().toISOString(),
      insights: [],
      toolResults: new Map(),
      userPreferences: [],
      decisions: [],
      errors: [],
    });
  }
}

export function addUserInsight(text: string): void {
  // 并发安全：无法确定 sessionId 时直接返回，避免污染其他会话
  return;
}
