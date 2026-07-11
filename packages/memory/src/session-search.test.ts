import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FTS5SearchEngine } from "./fts5-search";
import {
  SessionSearch,
  type SessionInfoProvider,
  type SessionInfoLike,
  type SessionTurnLike,
  type SessionSearchResult,
} from "./session-search";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTurn(
  role: string,
  content: string,
  overrides: Partial<SessionTurnLike> = {},
): SessionTurnLike {
  return {
    role,
    content,
    timestamp: new Date().toISOString(),
    turnIndex: 0,
    ...overrides,
  };
}

function makeInfo(
  sessionId: string,
  overrides: Partial<SessionInfoLike> = {},
): SessionInfoLike {
  return {
    sessionId,
    createdAt: new Date("2025-01-01T00:00:00Z").toISOString(),
    ...overrides,
  };
}

/** 构建一个带 transcript 的 provider */
class FakeProvider implements SessionInfoProvider {
  private sessions = new Map<string, SessionInfoLike>();
  private transcripts = new Map<string, SessionTurnLike[]>();

  addSession(info: SessionInfoLike, transcript: SessionTurnLike[] = []): void {
    this.sessions.set(info.sessionId, info);
    this.transcripts.set(info.sessionId, transcript);
  }

  getSessionInfo(sessionId: string): SessionInfoLike | null {
    return this.sessions.get(sessionId) ?? null;
  }

  loadTranscript(sessionId: string): SessionTurnLike[] {
    return this.transcripts.get(sessionId) ?? [];
  }

  listSessions(): SessionInfoLike[] {
    return Array.from(this.sessions.values());
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("SessionSearch", () => {
  let fts: FTS5SearchEngine;

  beforeEach(() => {
    fts = new FTS5SearchEngine(":memory:");
    fts.initialize();
  });

  afterEach(() => {
    fts.close();
  });

  // ── Static config ──────────────────────────────────────────────────

  describe("static source lists", () => {
    it("exposes _DEMOTED_SESSION_SOURCES", () => {
      expect(SessionSearch._DEMOTED_SESSION_SOURCES).toContain("cron");
      expect(SessionSearch._DEMOTED_SESSION_SOURCES).toContain("scheduler");
    });

    it("exposes _HIDDEN_SESSION_SOURCES", () => {
      expect(SessionSearch._HIDDEN_SESSION_SOURCES).toContain("subagent");
      expect(SessionSearch._HIDDEN_SESSION_SOURCES).toContain("tool");
    });

    it("_DEMOTED and _HIDDEN are disjoint", () => {
      for (const s of SessionSearch._DEMOTED_SESSION_SOURCES) {
        expect(SessionSearch._HIDDEN_SESSION_SOURCES).not.toContain(s);
      }
    });
  });

  // ── discover ───────────────────────────────────────────────────────

  describe("discover", () => {
    it("returns FTS5 matches as SessionSearchResult", async () => {
      fts.indexEntry("msg-1", "The quick brown fox jumps", {
        sessionId: "sess-1",
        type: "conversation",
        createdAt: new Date("2025-01-01"),
      });

      const search = new SessionSearch(fts);
      const results = await search.discover("fox");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].sessionId).toBe("sess-1");
      expect(results[0].snippet).toContain("fox");
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].timestamp).toBeTruthy();
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 10; i++) {
        fts.indexEntry(`msg-${i}`, `Document about programming number ${i}`, {
          sessionId: `sess-${i}`,
          type: "conversation",
          createdAt: new Date(`2025-01-${i + 1}`),
        });
      }

      const search = new SessionSearch(fts);
      const results = await search.discover("programming", 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("merges lineage: child session results resolve to parent", async () => {
      // parent session
      fts.indexEntry("msg-parent", "Parent session about typescript", {
        sessionId: "sess-parent",
        type: "conversation",
        createdAt: new Date("2025-01-01"),
      });
      // child session (has parentSessionId via provider)
      fts.indexEntry("msg-child", "Child session also about typescript", {
        sessionId: "sess-child",
        type: "conversation",
        createdAt: new Date("2025-01-02"),
      });

      const provider = new FakeProvider();
      provider.addSession(
        makeInfo("sess-parent"),
        [makeTurn("user", "Parent session about typescript")],
      );
      provider.addSession(
        makeInfo("sess-child", { parentSessionId: "sess-parent" }),
        [makeTurn("user", "Child session also about typescript")],
      );

      const search = new SessionSearch(fts, provider);
      const results = await search.discover("typescript");

      // 两条 FTS5 命中应合并到同一个 parent session
      const parentResults = results.filter((r) => r.sessionId === "sess-parent");
      expect(parentResults.length).toBe(1);
    });

    it("filters out hidden session sources", async () => {
      fts.indexEntry("msg-visible", "Visible session about python", {
        sessionId: "sess-visible",
        type: "conversation",
        createdAt: new Date("2025-01-01"),
      });
      fts.indexEntry("msg-hidden", "Hidden subagent session about python", {
        sessionId: "sess-hidden",
        type: "conversation",
        createdAt: new Date("2025-01-02"),
      });

      const provider = new FakeProvider();
      provider.addSession(makeInfo("sess-visible", { source: "user" }));
      provider.addSession(makeInfo("sess-hidden", { source: "subagent" }));

      const search = new SessionSearch(fts, provider);
      const results = await search.discover("python");

      expect(results.every((r) => r.sessionId !== "sess-hidden")).toBe(true);
      expect(results.some((r) => r.sessionId === "sess-visible")).toBe(true);
    });

    it("demotes cron/scheduler sources to end of results", async () => {
      fts.indexEntry("msg-cron", "Scheduled task about deployment", {
        sessionId: "sess-cron",
        type: "conversation",
        createdAt: new Date("2025-01-02"),
      });
      fts.indexEntry("msg-user", "User question about deployment", {
        sessionId: "sess-user",
        type: "conversation",
        createdAt: new Date("2025-01-01"),
      });

      const provider = new FakeProvider();
      provider.addSession(makeInfo("sess-cron", { source: "cron" }));
      provider.addSession(makeInfo("sess-user", { source: "user" }));

      const search = new SessionSearch(fts, provider);
      const results = await search.discover("deployment");

      // cron 应在最后
      const cronIdx = results.findIndex((r) => r.sessionId === "sess-cron");
      const userIdx = results.findIndex((r) => r.sessionId === "sess-user");
      expect(cronIdx).toBeGreaterThan(userIdx);
    });

    it("attaches messageWindow and bookends when provider available", async () => {
      const transcript: SessionTurnLike[] = [
        { role: "user", content: "First message", timestamp: "t0", turnIndex: 0 },
        { role: "assistant", content: "Second message", timestamp: "t1", turnIndex: 1 },
        { role: "user", content: "Third message with keyword", timestamp: "t2", turnIndex: 2, metadata: { id: "msg-3" } },
        { role: "assistant", content: "Fourth message", timestamp: "t3", turnIndex: 3 },
        { role: "user", content: "Fifth message", timestamp: "t4", turnIndex: 4 },
        { role: "assistant", content: "Sixth message", timestamp: "t5", turnIndex: 5 },
        { role: "user", content: "Seventh message", timestamp: "t6", turnIndex: 6 },
        { role: "assistant", content: "Eighth message", timestamp: "t7", turnIndex: 7 },
      ];

      fts.indexEntry("msg-3", "Third message with keyword", {
        sessionId: "sess-1",
        type: "conversation",
        createdAt: new Date("2025-01-01"),
      });

      const provider = new FakeProvider();
      provider.addSession(makeInfo("sess-1"), transcript);

      const search = new SessionSearch(fts, provider);
      const results = await search.discover("keyword");

      expect(results).toHaveLength(1);
      const r = results[0];
      expect(r.messageWindow).toBeDefined();
      // 锚点在第 2 条（index=2），±5 应覆盖全部 8 条
      expect(r.messageWindow!.length).toBe(8);
      expect(r.bookendStart).toBeDefined();
      expect(r.bookendStart!.length).toBeGreaterThan(0);
      expect(r.bookendEnd).toBeDefined();
      expect(r.bookendEnd!.length).toBeGreaterThan(0);
    });

    it("works without provider (degraded mode)", async () => {
      fts.indexEntry("msg-1", "Hello world from session", {
        sessionId: "sess-1",
        type: "conversation",
        createdAt: new Date("2025-01-01"),
      });

      const search = new SessionSearch(fts, null);
      const results = await search.discover("hello");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].sessionId).toBe("sess-1");
      // 无 provider 时无 messageWindow
      expect(results[0].messageWindow).toBeUndefined();
    });

    it("returns empty array for no matches", async () => {
      fts.indexEntry("msg-1", "Hello world", {
        sessionId: "sess-1",
        type: "conversation",
        createdAt: new Date(),
      });

      const search = new SessionSearch(fts);
      const results = await search.discover("nonexistentterm12345");
      expect(results).toHaveLength(0);
    });

    it("attaches parentSessionId from provider info", async () => {
      fts.indexEntry("msg-1", "Session content", {
        sessionId: "sess-child",
        type: "conversation",
        createdAt: new Date("2025-01-01"),
      });

      const provider = new FakeProvider();
      provider.addSession(
        makeInfo("sess-child", { parentSessionId: "sess-root" }),
      );
      provider.addSession(makeInfo("sess-root"));

      const search = new SessionSearch(fts, provider);
      const results = await search.discover("content");

      // sess-child 解析到 sess-root
      expect(results[0].sessionId).toBe("sess-root");
    });
  });

  // ── scroll ─────────────────────────────────────────────────────────

  describe("scroll", () => {
    it("returns message window around specified messageId", async () => {
      const transcript: SessionTurnLike[] = [];
      for (let i = 0; i < 10; i++) {
        transcript.push({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}`,
          timestamp: `t${i}`,
          turnIndex: i,
          metadata: { id: `msg-${i}` },
        });
      }

      const provider = new FakeProvider();
      provider.addSession(makeInfo("sess-1"), transcript);

      const search = new SessionSearch(fts, provider);
      const result = await search.scroll("sess-1", "msg-5", 2);

      expect(result.sessionId).toBe("sess-1");
      expect(result.messageWindow).toBeDefined();
      // ±2 = 5 条
      expect(result.messageWindow!.length).toBe(5);
      // 中间应是锚点
      expect(result.messageWindow![2].messageId).toBe("msg-5");
    });

    it("clamps window at start of transcript", async () => {
      const transcript: SessionTurnLike[] = [];
      for (let i = 0; i < 5; i++) {
        transcript.push({
          role: "user",
          content: `Message ${i}`,
          timestamp: `t${i}`,
          turnIndex: i,
          metadata: { id: `msg-${i}` },
        });
      }

      const provider = new FakeProvider();
      provider.addSession(makeInfo("sess-1"), transcript);

      const search = new SessionSearch(fts, provider);
      const result = await search.scroll("sess-1", "msg-0", 3);

      // 锚点在 index 0，±3 但开头不能小于 0
      expect(result.messageWindow!.length).toBe(4); // 0,1,2,3
    });

    it("clamps window at end of transcript", async () => {
      const transcript: SessionTurnLike[] = [];
      for (let i = 0; i < 5; i++) {
        transcript.push({
          role: "user",
          content: `Message ${i}`,
          timestamp: `t${i}`,
          turnIndex: i,
          metadata: { id: `msg-${i}` },
        });
      }

      const provider = new FakeProvider();
      provider.addSession(makeInfo("sess-1"), transcript);

      const search = new SessionSearch(fts, provider);
      const result = await search.scroll("sess-1", "msg-4", 3);

      // 锚点在 index 4，±3 但结尾不能超过 5
      expect(result.messageWindow!.length).toBe(4); // 1,2,3,4
    });

    it("falls back to turnIndex when messageId is numeric", async () => {
      const transcript: SessionTurnLike[] = [];
      for (let i = 0; i < 5; i++) {
        transcript.push({
          role: "user",
          content: `Message ${i}`,
          timestamp: `t${i}`,
          turnIndex: i,
        });
      }

      const provider = new FakeProvider();
      provider.addSession(makeInfo("sess-1"), transcript);

      const search = new SessionSearch(fts, provider);
      const result = await search.scroll("sess-1", "2", 1);

      expect(result.messageWindow!.length).toBe(3);
      expect(result.messageWindow![1].content).toBe("Message 2");
    });

    it("returns empty window when transcript is empty", async () => {
      const provider = new FakeProvider();
      provider.addSession(makeInfo("sess-1"), []);

      const search = new SessionSearch(fts, provider);
      const result = await search.scroll("sess-1", "any-msg", 2);

      expect(result.sessionId).toBe("sess-1");
      expect(result.messageWindow).toEqual([]);
    });

    it("returns empty window when provider is null", async () => {
      const search = new SessionSearch(fts, null);
      const result = await search.scroll("sess-1", "msg-1", 2);

      expect(result.sessionId).toBe("sess-1");
      expect(result.messageWindow).toEqual([]);
    });

    it("attaches source from session info", async () => {
      const provider = new FakeProvider();
      provider.addSession(
        makeInfo("sess-1", { source: "user" }),
        [makeTurn("user", "Hello", { metadata: { id: "m1" } })],
      );

      const search = new SessionSearch(fts, provider);
      const result = await search.scroll("sess-1", "m1", 1);

      expect(result.source).toBe("user");
    });
  });

  // ── browse ─────────────────────────────────────────────────────────

  describe("browse", () => {
    it("lists sessions by time descending", async () => {
      const provider = new FakeProvider();
      provider.addSession(makeInfo("old", { createdAt: "2025-01-01T00:00:00Z" }));
      provider.addSession(makeInfo("new", { createdAt: "2025-06-01T00:00:00Z" }));
      provider.addSession(makeInfo("mid", { createdAt: "2025-03-01T00:00:00Z" }));

      const search = new SessionSearch(fts, provider);
      const results = await search.browse();

      expect(results[0].sessionId).toBe("new");
      expect(results[1].sessionId).toBe("mid");
      expect(results[2].sessionId).toBe("old");
    });

    it("respects limit", async () => {
      const provider = new FakeProvider();
      for (let i = 0; i < 30; i++) {
        provider.addSession(
          makeInfo(`sess-${i}`, { createdAt: new Date(2025, 0, i + 1).toISOString() }),
        );
      }

      const search = new SessionSearch(fts, provider);
      const results = await search.browse(5);
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it("filters hidden sources", async () => {
      const provider = new FakeProvider();
      provider.addSession(makeInfo("visible", { source: "user" }));
      provider.addSession(makeInfo("hidden1", { source: "subagent" }));
      provider.addSession(makeInfo("hidden2", { source: "tool" }));

      const search = new SessionSearch(fts, provider);
      const results = await search.browse();

      expect(results.every((r) => r.sessionId !== "hidden1")).toBe(true);
      expect(results.every((r) => r.sessionId !== "hidden2")).toBe(true);
      expect(results.some((r) => r.sessionId === "visible")).toBe(true);
    });

    it("demotes cron/scheduler to end", async () => {
      const provider = new FakeProvider();
      provider.addSession(makeInfo("cron", { source: "cron", createdAt: "2025-06-01T00:00:00Z" }));
      provider.addSession(makeInfo("user", { source: "user", createdAt: "2025-01-01T00:00:00Z" }));

      const search = new SessionSearch(fts, provider);
      const results = await search.browse();

      const cronIdx = results.findIndex((r) => r.sessionId === "cron");
      const userIdx = results.findIndex((r) => r.sessionId === "user");
      expect(cronIdx).toBeGreaterThan(userIdx);
    });

    it("returns empty array when provider has no listSessions", async () => {
      const search = new SessionSearch(fts, null);
      const results = await search.browse();
      expect(results).toHaveLength(0);
    });

    it("includes sessions without source", async () => {
      const provider = new FakeProvider();
      provider.addSession(makeInfo("no-source"));

      const search = new SessionSearch(fts, provider);
      const results = await search.browse();

      expect(results.some((r) => r.sessionId === "no-source")).toBe(true);
    });
  });

  // ── _resolveToParent ──────────────────────────────────────────────

  describe("_resolveToParent", () => {
    it("returns same sessionId when no parent", () => {
      const provider = new FakeProvider();
      provider.addSession(makeInfo("sess-1"));

      const search = new SessionSearch(fts, provider);
      expect(search._resolveToParent("sess-1")).toBe("sess-1");
    });

    it("walks parentSessionId chain to root", () => {
      const provider = new FakeProvider();
      provider.addSession(makeInfo("root"));
      provider.addSession(makeInfo("child", { parentSessionId: "root" }));
      provider.addSession(makeInfo("grandchild", { parentSessionId: "child" }));

      const search = new SessionSearch(fts, provider);
      expect(search._resolveToParent("grandchild")).toBe("root");
    });

    it("supports predecessorSessionId as alias", () => {
      const provider = new FakeProvider();
      provider.addSession(makeInfo("root"));
      provider.addSession(makeInfo("child", { predecessorSessionId: "root" }));

      const search = new SessionSearch(fts, provider);
      expect(search._resolveToParent("child")).toBe("root");
    });

    it("returns original sessionId when provider is null", () => {
      const search = new SessionSearch(fts, null);
      expect(search._resolveToParent("sess-1")).toBe("sess-1");
    });

    it("handles circular references without infinite loop", () => {
      const provider = new FakeProvider();
      provider.addSession(makeInfo("a", { parentSessionId: "b" }));
      provider.addSession(makeInfo("b", { parentSessionId: "a" }));

      const search = new SessionSearch(fts, provider);
      // 不应无限循环
      const result = search._resolveToParent("a");
      expect(typeof result).toBe("string");
    });

    it("stops when session not found in provider", () => {
      const provider = new FakeProvider();
      provider.addSession(makeInfo("child", { parentSessionId: "missing" }));

      const search = new SessionSearch(fts, provider);
      // missing 不在 provider 中，应停止并返回 "missing"
      expect(search._resolveToParent("child")).toBe("missing");
    });
  });

  // ── SessionSearchResult shape ─────────────────────────────────────

  describe("SessionSearchResult shape", () => {
    it("discover returns results with all required fields", async () => {
      fts.indexEntry("msg-1", "Test content here", {
        sessionId: "sess-1",
        type: "conversation",
        createdAt: new Date("2025-01-01"),
      });

      const search = new SessionSearch(fts);
      const results = await search.discover("test");

      expect(results.length).toBeGreaterThanOrEqual(1);
      const r: SessionSearchResult = results[0];
      expect(r).toHaveProperty("sessionId");
      expect(r).toHaveProperty("score");
      expect(r).toHaveProperty("snippet");
      expect(r).toHaveProperty("timestamp");
      expect(typeof r.sessionId).toBe("string");
      expect(typeof r.score).toBe("number");
      expect(typeof r.snippet).toBe("string");
      expect(typeof r.timestamp).toBe("string");
    });
  });
});
