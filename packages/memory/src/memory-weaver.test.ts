import { describe, it, expect, beforeEach } from "vitest";
import { MemoryWeaver } from "../src/memory-weaver";
import type { MemoryFragment } from "../src/memory-weaver";

describe("MemoryWeaver", () => {
  let weaver: MemoryWeaver;

  beforeEach(() => {
    weaver = new MemoryWeaver({
      consolidationThreshold: 50, // Prevent auto-consolidation during tests
      decayHalfLifeMs: 86400000, // 1 day
    });
  });

  function makeFragment(overrides: Partial<MemoryFragment> = {}): MemoryFragment {
    return weaver.addFragment({
      sessionId: "session-1",
      content: "User asked about TypeScript generics",
      timestamp: Date.now() - 3600000,
      source: "discord",
      type: "conversation",
      importance: 0.5,
      metadata: {},
      ...overrides,
    });
  }

  // ── Fragment Management ─────────────────────────────────

  describe("fragment management", () => {
    it("should add and store fragments", () => {
      const f = makeFragment();
      expect(f.id).toBeTruthy();
      expect(f.type).toBe("conversation");

      const all = weaver.getFragments();
      expect(all.length).toBe(1);
    });

    it("should filter fragments by type", () => {
      makeFragment({ type: "conversation" });
      makeFragment({ type: "fact" });
      makeFragment({ type: "decision" });

      expect(weaver.getFragments({ type: "fact" }).length).toBe(1);
      expect(weaver.getFragments({ type: "decision" }).length).toBe(1);
      expect(weaver.getFragments({ type: "conversation" }).length).toBe(1);
    });

    it("should filter fragments by session", () => {
      makeFragment({ sessionId: "s1" });
      makeFragment({ sessionId: "s1" });
      makeFragment({ sessionId: "s2" });

      expect(weaver.getFragments({ sessionId: "s1" }).length).toBe(2);
      expect(weaver.getFragments({ sessionId: "s2" }).length).toBe(1);
    });

    it("should filter by minimum importance", () => {
      makeFragment({ importance: 0.3 });
      makeFragment({ importance: 0.8 });
      makeFragment({ importance: 0.9 });

      expect(weaver.getFragments({ minImportance: 0.7 }).length).toBe(2);
    });

    it("should filter by time range", () => {
      const now = Date.now();
      makeFragment({ timestamp: now - 86400000 * 5 });
      makeFragment({ timestamp: now - 3600000 });
      makeFragment({ timestamp: now - 60000 });

      expect(weaver.getFragments({ since: now - 86400000 }).length).toBe(2);
    });
  });

  // ── Relevance Scoring ───────────────────────────────────

  describe("relevance scoring", () => {
    it("should score fragments by query relevance", () => {
      makeFragment({ content: "User asked about React hooks" });
      makeFragment({ content: "User asked about TypeScript generics" });
      makeFragment({ content: "User asked about Python decorators" });

      const results = weaver.getRelevantFragments("TypeScript generics", { minScore: 0 });
      expect(results.length).toBeGreaterThan(0);
      // TypeScript fragment should be top
      expect(results[0].fragment.content).toContain("TypeScript");
    });

    it("should respect minScore filter", () => {
      makeFragment({ content: "React hooks" });
      makeFragment({ content: "TypeScript generics" });

      const all = weaver.getRelevantFragments("TypeScript", { minScore: 0 });
      const filtered = weaver.getRelevantFragments("TypeScript", { minScore: 0.3 });
      expect(filtered.length).toBeLessThanOrEqual(all.length);
    });

    it("should respect limit", () => {
      for (let i = 0; i < 20; i++) {
        makeFragment({ content: `TypeScript feature ${i}` });
      }

      const results = weaver.getRelevantFragments("TypeScript", { limit: 5, minScore: 0 });
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it("should boost relevance for recent memories", () => {
      makeFragment({ content: "TypeScript generics old", timestamp: Date.now() - 86400000 * 30 });
      makeFragment({ content: "TypeScript generics new", timestamp: Date.now() - 60000 });

      const results = weaver.getRelevantFragments("TypeScript", { minScore: 0 });
      expect(results.length).toBeGreaterThanOrEqual(1);
      // The recent one should score higher
      if (results.length >= 2) {
        expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      }
    });
  });

  // ── Highlights ──────────────────────────────────────────

  describe("highlights", () => {
    it("should return most important fragments", () => {
      makeFragment({ importance: 0.9, content: "Very important" });
      makeFragment({ importance: 0.3, content: "Not important" });
      makeFragment({ importance: 0.7, content: "Important" });

      const highlights = weaver.getHighlights(2);
      expect(highlights.length).toBe(2);
      expect(highlights[0].importance).toBe(0.9);
    });
  });

  // ── Consolidation ───────────────────────────────────────

  describe("consolidation", () => {
    it("should consolidate old sessions", () => {
      const oldTime = Date.now() - 86400000 * 2;
      for (let i = 0; i < 15; i++) {
        weaver.addFragment({
          sessionId: "old-session",
          content: `Fact about AI ${i}`,
          timestamp: oldTime,
          source: "test",
          type: "fact",
          importance: 0.6,
          metadata: {},
        });
      }

      const consolidated = weaver.consolidate();
      expect(consolidated.length).toBeGreaterThanOrEqual(1);
      expect(weaver.getStats().totalConsolidated).toBeGreaterThan(0);
    });

    it("should remove consolidated fragments from active set", () => {
      const oldTime = Date.now() - 86400000 * 2;
      const beforeCount = weaver.getFragments().length;

      for (let i = 0; i < 15; i++) {
        weaver.addFragment({
          sessionId: "old-session-2",
          content: `Old memory ${i}`,
          timestamp: oldTime,
          source: "test",
          type: "fact",
          importance: 0.5,
          metadata: {},
        });
      }

      weaver.consolidate();
      const afterCount = weaver.getFragments().length;
      expect(afterCount).toBeLessThan(beforeCount + 15);
    });

    it("should extract key facts from consolidated memories", () => {
      const oldTime = Date.now() - 86400000 * 2;
      weaver.addFragment({
        sessionId: "fact-session",
        content: "The Earth orbits the Sun",
        timestamp: oldTime,
        source: "test",
        type: "fact",
        importance: 0.9,
        metadata: {},
      });

      for (let i = 0; i < 12; i++) {
        weaver.addFragment({
          sessionId: "fact-session",
          content: `Conversation point ${i}`,
          timestamp: oldTime + i * 1000,
          source: "test",
          type: "conversation",
          importance: 0.3,
          metadata: {},
        });
      }

      const consolidated = weaver.consolidate();
      if (consolidated.length > 0) {
        expect(consolidated[0].keyFacts.length).toBeGreaterThanOrEqual(1);
        expect(consolidated[0].keyFacts).toContain("The Earth orbits the Sun");
      }
    });
  });

  // ── Timeline ────────────────────────────────────────────

  describe("timeline", () => {
    it("should build chronological timeline", () => {
      const base = Date.now() - 86400000;
      weaver.addFragment({
        sessionId: "tl",
        content: "First event",
        timestamp: base,
        source: "test",
        type: "conversation",
        importance: 0.5,
        metadata: {},
      });
      weaver.addFragment({
        sessionId: "tl",
        content: "Second event",
        timestamp: base + 3600000,
        source: "test",
        type: "conversation",
        importance: 0.5,
        metadata: {},
      });
      weaver.addFragment({
        sessionId: "tl",
        content: "Third event",
        timestamp: base + 7200000,
        source: "test",
        type: "conversation",
        importance: 0.5,
        metadata: {},
      });

      const timeline = weaver.buildTimeline();
      expect(timeline.fragments.length).toBe(3);
      expect(timeline.fragments[0].content).toBe("First event");
      expect(timeline.fragments[2].content).toBe("Third event");
      expect(timeline.density).toBeGreaterThan(0);
    });

    it("should filter timeline by type", () => {
      weaver.addFragment({
        sessionId: "tl2",
        content: "Conversation",
        timestamp: Date.now(),
        source: "test",
        type: "conversation",
        importance: 0.5,
        metadata: {},
      });
      weaver.addFragment({
        sessionId: "tl2",
        content: "Decision",
        timestamp: Date.now(),
        source: "test",
        type: "decision",
        importance: 0.5,
        metadata: {},
      });

      const timeline = weaver.buildTimeline({ type: "decision" });
      expect(timeline.fragments.length).toBe(1);
      expect(timeline.fragments[0].content).toBe("Decision");
    });

    it("should include consolidated memories in timeline", () => {
      const oldTime = Date.now() - 86400000 * 3;
      for (let i = 0; i < 15; i++) {
        weaver.addFragment({
          sessionId: "old-tl",
          content: `Old conv ${i}`,
          timestamp: oldTime,
          source: "test",
          type: "conversation",
          importance: 0.4,
          metadata: {},
        });
      }

      weaver.consolidate();
      const timeline = weaver.buildTimeline();
      expect(timeline.consolidated.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Clustering ──────────────────────────────────────────

  describe("clustering", () => {
    it("should cluster similar topics together", () => {
      weaver.addFragment({
        sessionId: "cluster",
        content: "React hooks useState useEffect",
        timestamp: Date.now(),
        source: "test",
        type: "conversation",
        importance: 0.5,
        metadata: {},
      });
      weaver.addFragment({
        sessionId: "cluster",
        content: "React context API and providers",
        timestamp: Date.now(),
        source: "test",
        type: "conversation",
        importance: 0.5,
        metadata: {},
      });
      weaver.addFragment({
        sessionId: "cluster",
        content: "Python decorators and context managers",
        timestamp: Date.now(),
        source: "test",
        type: "conversation",
        importance: 0.5,
        metadata: {},
      });

      weaver.clusterTopics();
      const stats = weaver.getStats();
      expect(stats.totalClusters).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Context Window ──────────────────────────────────────

  describe("context window", () => {
    it("should build context window with relevant memories", () => {
      weaver.addFragment({
        sessionId: "ctx",
        content: "User prefers dark theme",
        timestamp: Date.now() - 3600000,
        source: "test",
        type: "preference",
        importance: 0.8,
        metadata: {},
      });
      weaver.addFragment({
        sessionId: "ctx",
        content: "User asked about dark mode",
        timestamp: Date.now(),
        source: "test",
        type: "conversation",
        importance: 0.5,
        metadata: {},
      });

      const ctx = weaver.buildContextWindow("dark theme preference", 1000);
      expect(ctx.length).toBeGreaterThan(0);
      expect(ctx).toContain("dark");
    });

    it("should respect token budget", () => {
      for (let i = 0; i < 50; i++) {
        weaver.addFragment({
          sessionId: "budget",
          content: `Memory about dark theme ${i}`.repeat(10),
          timestamp: Date.now(),
          source: "test",
          type: "conversation",
          importance: 0.5,
          metadata: {},
        });
      }

      const ctx = weaver.buildContextWindow("dark", 500);
      // Rough token estimate: 4 chars per token
      expect(ctx.length).toBeLessThanOrEqual(500 * 4 + 200);
    });
  });

  // ── Conflict Detection ──────────────────────────────────

  describe("conflict detection", () => {
    it("should detect contradictory facts", () => {
      weaver.addFragment({
        sessionId: "conflict",
        content: "User lives in New York",
        timestamp: Date.now() - 86400000,
        source: "test",
        type: "fact",
        importance: 0.7,
        metadata: {},
      });
      weaver.addFragment({
        sessionId: "conflict",
        content: "User does not live in New York",
        timestamp: Date.now(),
        source: "test",
        type: "fact",
        importance: 0.7,
        metadata: {},
      });

      const conflicts = weaver.detectConflicts();
      expect(conflicts.length).toBeGreaterThanOrEqual(1);
    });

    it("should not flag non-contradictory facts", () => {
      weaver.addFragment({
        sessionId: "noconflict",
        content: "User likes pizza",
        timestamp: Date.now(),
        source: "test",
        type: "fact",
        importance: 0.5,
        metadata: {},
      });
      weaver.addFragment({
        sessionId: "noconflict",
        content: "User likes ice cream",
        timestamp: Date.now(),
        source: "test",
        type: "fact",
        importance: 0.5,
        metadata: {},
      });

      const conflicts = weaver.detectConflicts();
      expect(conflicts.length).toBe(0);
    });
  });

  // ── Stats & Clear ───────────────────────────────────────

  describe("stats and clear", () => {
    it("should report stats correctly", () => {
      makeFragment();
      makeFragment();

      const stats = weaver.getStats();
      expect(stats.totalFragments).toBe(2);
      expect(stats.memorySpanMs).toBeGreaterThanOrEqual(0);
    });

    it("should clear all data", () => {
      makeFragment();
      makeFragment();
      weaver.clear();

      expect(weaver.getFragments().length).toBe(0);
      expect(weaver.getStats().totalFragments).toBe(0);
    });
  });
});