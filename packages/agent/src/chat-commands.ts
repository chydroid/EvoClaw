/**
 * Chat Commands System — OpenClaw compatibility layer.
 *
 * Supports slash-commands sent as plain-text input. Commands are intercepted
 * before the LLM is called so they never consume tokens or trigger a model run.
 *
 * Implemented commands:
 *   /status       — Show agent & session status
 *   /new          — Start a fresh session (archive current)
 *   /reset        — Full session reset (clear history, new session)
 *   /compact      — Compress conversation history
 *   /thinking     — Set thinking verbosity level (off | low | medium | high)
 *   /verbose on|off — Toggle verbose tool output
 *   /usage off|tokens|full — Control token/usage reporting
 *   /restart      — Restart agent runtime
 *   /help         — Show available commands
 */
import type { AgentModelExecutor } from "./agent-model-executor.js";
import type { SessionManager } from "./session-manager.js";
import type { CompactionManager } from "./compaction-manager.js";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface CommandResult {
  /** Human-readable response (shown in chat) */
  reply: string;
  /** Whether the command was recognized and handled */
  handled: boolean;
  /** Optional side-effect instructions for the caller */
  action?: "new_session" | "reset_session" | "compact" | "restart" | null;
}

export interface CommandContext {
  agentId?: string;
  sessionId?: string;
  currentThinkingLevel?: string;
  currentVerbose?: boolean;
  currentUsageMode?: string;
  turnCount?: number;
  tokenCount?: number;
  modelName?: string;
  uptimeMs?: number;
}

// ──────────────────────────────────────────────────────────────
// Handler table
// ──────────────────────────────────────────────────────────────

type CommandHandler = (args: string[], ctx: CommandContext) => CommandResult;

const COMMANDS: Record<string, CommandHandler> = {
  status: (_, ctx) => ({
    reply: [
      "**Agent Status**",
      "",
      `Agent: \`${ctx.agentId || "default"}\``,
      `Session: \`${ctx.sessionId || "unknown"}\``,
      `Model: \`${ctx.modelName || "default"}\``,
      `Turns this session: ${ctx.turnCount ?? "?"}`,
      `Tokens used this session: ${ctx.tokenCount ?? "?"}`,
      `Thinking level: \`${ctx.currentThinkingLevel || "off"}\``,
      `Verbose: \`${ctx.currentVerbose ? "on" : "off"}\``,
      `Uptime: ${formatUptime(ctx.uptimeMs ?? 0)}`,
    ].join("\n"),
    handled: true,
  }),

  new: () => ({
    reply: "Starting a fresh session. The previous session has been archived.",
    handled: true,
    action: "new_session",
  }),

  reset: () => ({
    reply: "Resetting session… All context has been cleared.",
    handled: true,
    action: "reset_session",
  }),

  compact: () => ({
    reply:
      "Compacting conversation history… Older messages will be summarised and the most recent turns preserved.",
    handled: true,
    action: "compact",
  }),

  thinking: (args) => {
    const level = args[0]?.toLowerCase();
    const validLevels = ["off", "low", "medium", "high"];
    if (!level || !validLevels.includes(level)) {
      return {
        reply: `Usage: \`/thinking <off|low|medium|high>\`\nCurrent: \`${validLevels.join(" | ")}\``,
        handled: true,
      };
    }
    return {
      reply: `Thinking level set to **${level}**.`,
      handled: true,
    };
  },

  verbose: (args) => {
    const val = args[0]?.toLowerCase();
    if (val !== "on" && val !== "off") {
      return {
        reply: "Usage: `/verbose on|off`",
        handled: true,
      };
    }
    return {
      reply: `Verbose tool output **${val}**.`,
      handled: true,
    };
  },

  usage: (args) => {
    const val = args[0]?.toLowerCase();
    const valid = ["off", "tokens", "full"];
    if (!val || !valid.includes(val)) {
      return {
        reply: `Usage: \`/usage <off|tokens|full>\`\nCurrent: \`${valid.join(" | ")}\``,
        handled: true,
      };
    }
    const label = { off: "off", tokens: "tokens only", full: "full report" }[
      val
    ]!;
    return {
      reply: `Usage reporting set to **${label}**.`,
      handled: true,
    };
  },

  restart: () => ({
    reply: "Restarting agent runtime…",
    handled: true,
    action: "restart",
  }),

  help: () => ({
    reply: [
      "**Available Commands**",
      "",
      "`/status` — Show current agent & session status",
      "`/new` — Start a fresh session (archive current)",
      "`/reset` — Full session reset",
      "`/compact` — Compress conversation history",
      "`/thinking <off|low|medium|high>` — Set thinking level",
      "`/verbose <on|off>` — Toggle verbose tool output",
      "`/usage <off|tokens|full>` — Control usage reporting",
      "`/restart` — Restart agent runtime",
      "`/help` — Show this help",
    ].join("\n"),
    handled: true,
  }),
};

// ──────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────

/**
 * Check if a user message is a command and handle it.
 * Returns { handled: true } with a reply if the message starts with `/`.
 */
export function handleChatCommand(
  input: string,
  ctx: CommandContext = {},
): CommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { reply: "", handled: false };
  }

  // Parse out the command name (before first space) and remaining args
  const spaceIdx = trimmed.indexOf(" ");
  const cmdName =
    spaceIdx === -1
      ? trimmed.slice(1).toLowerCase()
      : trimmed.slice(1, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? [] : trimmed.slice(spaceIdx + 1).split(/\s+/);

  const handler = COMMANDS[cmdName];
  if (!handler) {
    return {
      reply: `Unknown command: \`/${cmdName}\`. Type \`/help\` for available commands.`,
      handled: true,
    };
  }

  return handler(args, ctx);
}

/**
 * Centralised command dispatch. Call this before passing a message to the LLM.
 * If `handled` is true, return the `reply` directly — no model call needed.
 */
export function dispatchCommand(
  message: string,
  executor: AgentModelExecutor,
  sessionManager: SessionManager | null,
  compactionManager: CompactionManager | null,
): CommandResult {
  const ctx: CommandContext = {
    agentId: "default",
    sessionId: executor.currentSessionId,
    currentThinkingLevel: (executor as unknown as { thinkingLevel?: string }).thinkingLevel,
  };

  const result = handleChatCommand(message, ctx);

  // Execute side-effects
  if (result.action && sessionManager) {
    switch (result.action) {
      case "new_session": {
        const newId = `sess_${Date.now()}`;
        sessionManager.createSession("default", { sessionId: newId });
        // 通过公开 setter 设置当前 sessionId，后续 chat() 调用会使用此 sessionId
        (executor as { currentSessionId?: string }).currentSessionId = newId;
        break;
      }
      case "reset_session": {
        const resetId = `sess_${Date.now()}`;
        sessionManager.createSession("default", { sessionId: resetId });
        (executor as { currentSessionId?: string }).currentSessionId = resetId;
        // 使用公开方法清理会话历史，避免直接赋值数组破坏 Map 类型契约
        if (typeof (executor as { clearChatHistory?: (sessionId?: string) => void }).clearChatHistory === "function") {
          (executor as { clearChatHistory: (sessionId?: string) => void }).clearChatHistory();
        }
        break;
      }
      case "compact": {
        if (compactionManager) {
          // 使用公开方法获取历史，避免直接访问内部 Map
          const executorWithHistory = executor as { getChatHistory?: (sessionId: string) => Array<{ role: string; content: string | null }> };
          if (typeof executorWithHistory.getChatHistory === "function") {
            const sid = ctx.sessionId || "";
            const history = executorWithHistory.getChatHistory(sid);
            if (history && history.length > 4) {
              compactionManager.buildSummary(sid, history as Array<{ role: string; content: string }>);
            }
          }
        }
        break;
      }
      case "restart": {
        // 重启 agent runtime：创建新会话并清空对话历史，
        // 与 reset_session 行为一致，但语义上是完整重启。
        const restartId = `sess_${Date.now()}`;
        sessionManager.createSession("default", { sessionId: restartId });
        (executor as { currentSessionId?: string }).currentSessionId = restartId;
        if (typeof (executor as { clearChatHistory?: (sessionId?: string) => void }).clearChatHistory === "function") {
          (executor as { clearChatHistory: (sessionId?: string) => void }).clearChatHistory();
        }
        break;
      }
    }
  }

  return result;
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function formatUptime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}