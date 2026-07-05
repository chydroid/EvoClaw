import { describe, it, expect } from "vitest";
import { handleChatCommand, dispatchCommand } from "./chat-commands";
import type { CommandContext } from "./chat-commands";

// Minimal mock of AgentModelExecutor — 对齐真实 AgentModelExecutor 公开接口：
// - currentSessionId: string | undefined（public 字段）
// - thinkingLevel: "off" | "low" | "medium" | "high"
// - getChatHistory(sessionId): Array<{ role, content }>
// - clearChatHistory(sessionId?): void
// 不再使用 conversationHistory/verbose/usageMode 等不存在或不匹配的字段。
function createMockExecutor(overrides: Record<string, unknown> = {}) {
  const historyMap = new Map<string, Array<{ role: string; content: string | null }>>();
  const executor = {
    currentSessionId: "test-session-1" as string | undefined,
    thinkingLevel: "off" as "off" | "low" | "medium" | "high",
    getChatHistory: (sessionId: string) => historyMap.get(sessionId) || [],
    clearChatHistory: (sessionId?: string) => {
      if (sessionId) historyMap.delete(sessionId);
      else historyMap.clear();
    },
    // 测试辅助：直接注入历史以模拟已有对话
    _setHistory: (sessionId: string, history: Array<{ role: string; content: string }>) => {
      historyMap.set(sessionId, history);
    },
    ...overrides,
  } as any;
  // 支持 overrides 中直接传入 conversationHistory 数组（向后兼容旧测试）
  if (Array.isArray((overrides as any).conversationHistory)) {
    executor._setHistory("test-session-1", (overrides as any).conversationHistory);
  }
  return executor;
}

// Minimal mock of SessionManager
function createMockSessionManager() {
  const sessions = new Map<string, any>();
  return {
    createSession: (agentId: string, opts: { sessionId?: string }) => {
      const session = {
        sessionId: opts.sessionId || `sess_${Date.now()}`,
        agentId,
        status: "active",
        turnCount: 0,
        tokenEstimate: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        compactionCount: 0,
      };
      sessions.set(session.sessionId, session);
      return session;
    },
    getSession: (id: string) => sessions.get(id),
    _sessions: sessions,
  } as any;
}

// Minimal mock of CompactionManager
function createMockCompactionManager() {
  const summaries = new Map<string, string>();
  return {
    buildSummary: (sessionId: string, history: Array<{ role: string; content: string }>) => {
      const summary = `Compacted ${history.length} messages`;
      summaries.set(sessionId, summary);
      return summary;
    },
    _summaries: summaries,
  } as any;
}

describe("ChatCommands", () => {
  describe("handleChatCommand", () => {
    it("should return handled=false for non-commands", () => {
      const result = handleChatCommand("Hello, how are you?");
      expect(result.handled).toBe(false);
    });

    it("should return handled=true for slash commands", () => {
      const result = handleChatCommand("/help");
      expect(result.handled).toBe(true);
      expect(result.reply).toContain("Available Commands");
    });

    it("/status should return agent info", () => {
      const ctx: CommandContext = {
        agentId: "agent-1",
        sessionId: "sess-1",
        modelName: "gpt-4o",
        turnCount: 5,
        tokenCount: 1200,
        currentThinkingLevel: "medium",
        currentVerbose: true,
        uptimeMs: 60000,
      };

      const result = handleChatCommand("/status", ctx);
      expect(result.reply).toContain("agent-1");
      expect(result.reply).toContain("sess-1");
      expect(result.reply).toContain("gpt-4o");
      expect(result.reply).toContain("5");
      expect(result.reply).toContain("1200");
      expect(result.reply).toContain("medium");
      expect(result.reply).toContain("on");
    });

    it("/new should return new_session action", () => {
      const result = handleChatCommand("/new");
      expect(result.handled).toBe(true);
      expect(result.action).toBe("new_session");
      expect(result.reply).toContain("fresh session");
    });

    it("/reset should return reset_session action", () => {
      const result = handleChatCommand("/reset");
      expect(result.handled).toBe(true);
      expect(result.action).toBe("reset_session");
      expect(result.reply).toContain("Resetting");
    });

    it("/compact should return compact action", () => {
      const result = handleChatCommand("/compact");
      expect(result.handled).toBe(true);
      expect(result.action).toBe("compact");
      expect(result.reply).toContain("Compacting");
    });

    it("/thinking should accept valid levels", () => {
      const result = handleChatCommand("/thinking medium");
      expect(result.handled).toBe(true);
      expect(result.reply).toContain("medium");
    });

    it("/thinking should reject invalid levels", () => {
      const result = handleChatCommand("/thinking extreme");
      expect(result.handled).toBe(true);
      expect(result.reply).toContain("Usage");
    });

    it("/thinking with no args should show usage", () => {
      const result = handleChatCommand("/thinking");
      expect(result.handled).toBe(true);
      expect(result.reply).toContain("Usage");
    });

    it("/verbose on should work", () => {
      const result = handleChatCommand("/verbose on");
      expect(result.handled).toBe(true);
      expect(result.reply).toContain("on");
    });

    it("/verbose off should work", () => {
      const result = handleChatCommand("/verbose off");
      expect(result.handled).toBe(true);
      expect(result.reply).toContain("off");
    });

    it("/verbose with invalid arg should show usage", () => {
      const result = handleChatCommand("/verbose maybe");
      expect(result.handled).toBe(true);
      expect(result.reply).toContain("Usage");
    });

    it("/usage should accept valid modes", () => {
      const result = handleChatCommand("/usage tokens");
      expect(result.handled).toBe(true);
      expect(result.reply).toContain("tokens only");
    });

    it("/usage with invalid mode should show usage", () => {
      const result = handleChatCommand("/usage bananas");
      expect(result.handled).toBe(true);
      expect(result.reply).toContain("Usage");
    });

    it("/restart should return restart action", () => {
      const result = handleChatCommand("/restart");
      expect(result.handled).toBe(true);
      expect(result.action).toBe("restart");
    });

    it("should handle unknown commands gracefully", () => {
      const result = handleChatCommand("/foobar");
      expect(result.handled).toBe(true);
      expect(result.reply).toContain("Unknown command");
      expect(result.reply).toContain("/foobar");
    });
  });

  describe("dispatchCommand", () => {
    it("should execute new_session side-effect", () => {
      const executor = createMockExecutor();
      const sessionManager = createMockSessionManager();

      const result = dispatchCommand("/new", executor, sessionManager, null);
      expect(result.handled).toBe(true);
      expect(executor.currentSessionId).toBeDefined();
      expect(executor.currentSessionId).not.toBe("test-session-1");
    });

    it("should execute reset_session side-effect", () => {
      const executor = createMockExecutor();
      const sessionManager = createMockSessionManager();

      const result = dispatchCommand("/reset", executor, sessionManager, null);
      expect(result.handled).toBe(true);
      expect(executor.currentSessionId).toBeDefined();
      expect(executor.currentSessionId).not.toBe("test-session-1");
      // 验证 clearChatHistory 被调用（历史被清空）
      expect(executor.getChatHistory("test-session-1")).toEqual([]);
    });

    it("should execute compact side-effect", () => {
      const executor = createMockExecutor({
        conversationHistory: [
          { role: "user", content: "Q1" },
          { role: "assistant", content: "A1" },
          { role: "user", content: "Q2" },
          { role: "assistant", content: "A2" },
          { role: "user", content: "Q3" },
        ],
      });
      const sessionManager = createMockSessionManager();
      const compactionManager = createMockCompactionManager();

      const result = dispatchCommand("/compact", executor, sessionManager, compactionManager);
      expect(result.handled).toBe(true);

      // Verify compaction happened
      expect(compactionManager._summaries.size).toBeGreaterThan(0);
      const summary = compactionManager._summaries.get("test-session-1");
      expect(summary).toContain("Compacted 5 messages");
    });

    it("should handle non-command messages gracefully", () => {
      const executor = createMockExecutor();
      const sessionManager = createMockSessionManager();

      const result = dispatchCommand("Hello", executor, sessionManager, null);
      expect(result.handled).toBe(false);
    });

    it("should handle compact with too few messages", () => {
      const executor = createMockExecutor({
        conversationHistory: [
          { role: "user", content: "Q1" },
        ],
      });
      const sessionManager = createMockSessionManager();
      const compactionManager = createMockCompactionManager();

      const result = dispatchCommand("/compact", executor, sessionManager, compactionManager);
      expect(result.handled).toBe(true);
      // Should not compact because history <= 4
      expect(compactionManager._summaries.size).toBe(0);
    });
  });
});