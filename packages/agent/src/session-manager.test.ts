import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionManager } from "./session-manager";
import type { SessionConfig, SessionInfo, SessionTurn } from "./session-manager";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function createTestConfig(): SessionConfig {
  const tmpDir = path.join(os.tmpdir(), `evoclaw-session-test-${Date.now()}`);
  return {
    sessionsDir: tmpDir,
    maxTurnsBeforeCompaction: 100,
    writeLockTimeoutMs: 5000,
    truncateAfterCompaction: true,
    maxActiveTranscriptBytes: 10 * 1024 * 1024,
  };
}

describe("SessionManager", () => {
  let sm: SessionManager;
  let config: SessionConfig;

  beforeEach(() => {
    config = createTestConfig();
    sm = new SessionManager(config);
  });

  afterEach(() => {
    // Cleanup test directories
    try {
      if (fs.existsSync(config.sessionsDir)) {
        fs.rmSync(config.sessionsDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  describe("Session Lifecycle", () => {
    it("should create a session", () => {
      const session = sm.createSession("agent-1");
      expect(session.agentId).toBe("agent-1");
      expect(session.status).toBe("active");
      expect(session.turnCount).toBe(0);
      expect(session.compactionCount).toBe(0);
      expect(session.sessionId).toMatch(/^sess_/);
    });

    it("should create session with custom ID", () => {
      const session = sm.createSession("agent-1", { sessionId: "my-custom-id" });
      expect(session.sessionId).toBe("my-custom-id");
    });

    it("should create session with predecessor", () => {
      const session = sm.createSession("agent-1", { predecessorSessionId: "old-session" });
      expect(session.predecessorSessionId).toBe("old-session");
    });

    it("should get or create session", () => {
      const s1 = sm.getOrCreateSession("agent-1", "fixed-id");
      expect(s1.sessionId).toBe("fixed-id");

      const s2 = sm.getOrCreateSession("agent-1", "fixed-id");
      expect(s2.sessionId).toBe("fixed-id");
      expect(s2).toEqual(s1);
    });

    it("should load session metadata", () => {
      const created = sm.createSession("agent-1");
      const loaded = sm.loadSessionMeta("agent-1", created.sessionId);
      expect(loaded).toBeDefined();
      expect(loaded!.agentId).toBe("agent-1");
    });

    it("should return null for unknown session", () => {
      const loaded = sm.loadSessionMeta("agent-1", "nonexistent");
      expect(loaded).toBeNull();
    });

    it("should archive a session", () => {
      const session = sm.createSession("agent-1");
      sm.archiveSession("agent-1", session.sessionId, "Testing archive");

      const reloaded = sm.loadSessionMeta("agent-1", session.sessionId);
      expect(reloaded!.status).toBe("archived");
    });

    it("should delete a session", () => {
      const session = sm.createSession("agent-1");
      expect(fs.existsSync(path.join(config.sessionsDir, "agent-1", session.sessionId))).toBe(true);

      const result = sm.deleteSession("agent-1", session.sessionId);
      expect(result).toBe(true);
      expect(fs.existsSync(path.join(config.sessionsDir, "agent-1", session.sessionId))).toBe(false);
    });

    it("should return false when deleting non-existent session", () => {
      const result = sm.deleteSession("agent-1", "nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("Transcript I/O", () => {
    it("should append and load turns", () => {
      const session = sm.createSession("agent-1");

      const turn: SessionTurn = {
        turnIndex: 0,
        role: "user",
        content: "Hello",
        timestamp: new Date().toISOString(),
      };

      sm.appendTurn("agent-1", session.sessionId, turn);

      const turns = sm.loadTranscript("agent-1", session.sessionId);
      expect(turns).toHaveLength(1);
      expect(turns[0].content).toBe("Hello");
      expect(turns[0].role).toBe("user");
    });

    it("should handle tool calls in turns", () => {
      const session = sm.createSession("agent-1");

      const turn: SessionTurn = {
        turnIndex: 0,
        role: "assistant",
        content: null,
        timestamp: new Date().toISOString(),
        toolCalls: [{
          id: "call-1",
          name: "web_search",
          arguments: { query: "test" },
        }],
      };

      sm.appendTurn("agent-1", session.sessionId, turn);

      const turns = sm.loadTranscript("agent-1", session.sessionId);
      expect(turns).toHaveLength(1);
      expect(turns[0].toolCalls).toBeDefined();
      expect(turns[0].toolCalls![0].name).toBe("web_search");
    });

    it("should update turn count on append", () => {
      const session = sm.createSession("agent-1");

      sm.appendTurn("agent-1", session.sessionId, {
        turnIndex: 0, role: "user", content: "A", timestamp: new Date().toISOString(),
      });
      sm.appendTurn("agent-1", session.sessionId, {
        turnIndex: 1, role: "assistant", content: "B", timestamp: new Date().toISOString(),
      });

      const reloaded = sm.loadSessionMeta("agent-1", session.sessionId);
      expect(reloaded!.turnCount).toBe(2);
    });

    it("should load full session with turns", () => {
      const session = sm.createSession("agent-1");

      sm.appendTurn("agent-1", session.sessionId, {
        turnIndex: 0, role: "user", content: "Q", timestamp: new Date().toISOString(),
      });

      const loaded = sm.loadSession("agent-1", session.sessionId);
      expect(loaded).toBeDefined();
      expect(loaded!.session.sessionId).toBe(session.sessionId);
      expect(loaded!.turns).toHaveLength(1);
    });

    it("should rewrite transcript", () => {
      const session = sm.createSession("agent-1");

      sm.appendTurn("agent-1", session.sessionId, {
        turnIndex: 0, role: "user", content: "Old", timestamp: new Date().toISOString(),
      });

      const newTurns: SessionTurn[] = [
        { turnIndex: 0, role: "system", content: "Summary", timestamp: new Date().toISOString() },
        { turnIndex: 1, role: "user", content: "New", timestamp: new Date().toISOString() },
      ];

      sm.rewriteTranscript("agent-1", session.sessionId, newTurns);

      const turns = sm.loadTranscript("agent-1", session.sessionId);
      expect(turns).toHaveLength(2);
      expect(turns[0].content).toBe("Summary");
    });
  });

  describe("Write Locks", () => {
    it("should acquire and release a lock", () => {
      const session = sm.createSession("agent-1");

      const lock = sm.acquireLock("agent-1", session.sessionId);
      expect(lock).toBeDefined();
      expect(lock!.sessionId).toBe(session.sessionId);
      expect(sm.isLocked(session.sessionId)).toBe(true);

      sm.releaseLock(lock!);
      expect(sm.isLocked(session.sessionId)).toBe(false);
    });

    it("should support reentrant locks", () => {
      const session = sm.createSession("agent-1");

      const lock1 = sm.acquireLock("agent-1", session.sessionId, { allowReentrant: true });
      expect(lock1).toBeDefined();

      const lock2 = sm.acquireLock("agent-1", session.sessionId, { allowReentrant: true });
      expect(lock2).toBeDefined();
      expect(lock2!.reentrant).toBe(true);

      sm.releaseLock(lock2!);
      sm.releaseLock(lock1!);
      expect(sm.isLocked(session.sessionId)).toBe(false);
    });

    it("should block non-reentrant reacquisition", () => {
      const session = sm.createSession("agent-1");

      const lock1 = sm.acquireLock("agent-1", session.sessionId);
      expect(lock1).toBeDefined();

      const lock2 = sm.acquireLock("agent-1", session.sessionId);
      expect(lock2).toBeNull(); // Not reentrant by default

      sm.releaseLock(lock1!);
    });

    it("should get lock holder PID", () => {
      const session = sm.createSession("agent-1");
      const lock = sm.acquireLock("agent-1", session.sessionId);

      const holder = sm.getLockHolder(session.sessionId);
      expect(holder).toBe(process.pid);

      sm.releaseLock(lock!);
    });
  });

  describe("Compaction Helpers", () => {
    it("should check byte guard", () => {
      const session = sm.createSession("agent-1");
      expect(sm.checkByteGuard("agent-1", session.sessionId)).toBe(false); // empty transcript
    });

    it("should mark session as compacted", () => {
      const parent = sm.createSession("agent-1", { sessionId: "parent" });
      const child = sm.createSession("agent-1", { sessionId: "child" });

      sm.markCompacted("agent-1", "parent", "child", "Compaction summary");

      const parentReloaded = sm.loadSessionMeta("agent-1", "parent");
      expect(parentReloaded!.status).toBe("compacted");
      expect(parentReloaded!.successorSessionId).toBe("child");

      const childReloaded = sm.loadSessionMeta("agent-1", "child");
      expect(childReloaded!.predecessorSessionId).toBe("parent");
    });
  });

  describe("List / Query", () => {
    it("should list sessions for an agent", () => {
      sm.createSession("agent-1", { sessionId: "sess-a" });
      sm.createSession("agent-1", { sessionId: "sess-b" });
      sm.createSession("agent-2", { sessionId: "sess-c" });

      const sessions = sm.listSessions("agent-1");
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.sessionId).sort()).toEqual(["sess-a", "sess-b"]);
    });

    it("should list all agents", () => {
      sm.createSession("agent-1", { sessionId: "a" });
      sm.createSession("agent-2", { sessionId: "b" });

      const agents = sm.listAgents();
      expect(agents).toContain("agent-1");
      expect(agents).toContain("agent-2");
    });

    it("should return empty list for unknown agent", () => {
      const sessions = sm.listSessions("nonexistent");
      expect(sessions).toHaveLength(0);
    });
  });
});