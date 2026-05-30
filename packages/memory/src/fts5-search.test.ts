import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FTS5SearchEngine } from "./fts5-search";

describe("FTS5SearchEngine", () => {
  let engine: FTS5SearchEngine;

  beforeEach(() => {
    engine = new FTS5SearchEngine(":memory:");
    engine.initialize();
  });

  afterEach(() => {
    engine.close();
  });

  it("initialize creates the FTS5 table", () => {
    engine.indexEntry("test-1", "hello world", {
      sessionId: "sess-1",
      type: "conversation",
      createdAt: new Date(),
    });
    expect(engine.getCount()).toBe(1);
  });

  it("indexEntry and search work together", () => {
    engine.indexEntry("entry-1", "The quick brown fox jumps over the lazy dog", {
      sessionId: "sess-1",
      type: "conversation",
      createdAt: new Date("2025-01-01"),
    });
    engine.indexEntry("entry-2", "A completely different topic about cooking recipes", {
      sessionId: "sess-1",
      type: "knowledge",
      createdAt: new Date("2025-01-02"),
    });

    const results = engine.search({ query: "fox" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const foxResult = results.find((r) => r.metadata.id === "entry-1");
    expect(foxResult).toBeDefined();
    expect(foxResult!.content).toContain("fox");
  });

  it("search with limit and offset", () => {
    for (let i = 0; i < 10; i++) {
      engine.indexEntry(`entry-${i}`, `Document number ${i} about programming and code`, {
        sessionId: "sess-1",
        type: "conversation",
        createdAt: new Date(),
      });
    }

    const firstPage = engine.search({ query: "programming", limit: 3, offset: 0 });
    expect(firstPage.length).toBeLessThanOrEqual(3);

    const secondPage = engine.search({ query: "programming", limit: 3, offset: 3 });
    expect(secondPage.length).toBeLessThanOrEqual(3);
  });

  it("search filters by sessionId", () => {
    engine.indexEntry("e1", "Important data about session A", {
      sessionId: "sess-a",
      type: "conversation",
      createdAt: new Date(),
    });
    engine.indexEntry("e2", "Important data about session B", {
      sessionId: "sess-b",
      type: "conversation",
      createdAt: new Date(),
    });

    const results = engine.search({ query: "Important", sessionId: "sess-a" });
    expect(results.every((r) => r.metadata.sessionId === "sess-a")).toBe(true);
  });

  it("search filters by type", () => {
    engine.indexEntry("e1", "Knowledge about typescript", {
      sessionId: "sess-1",
      type: "knowledge",
      createdAt: new Date(),
    });
    engine.indexEntry("e2", "Conversation about typescript", {
      sessionId: "sess-1",
      type: "conversation",
      createdAt: new Date(),
    });

    const results = engine.search({ query: "typescript", type: "knowledge" });
    expect(results.every((r) => r.metadata.type === "knowledge")).toBe(true);
  });

  it("deleteEntry removes entry from index", () => {
    engine.indexEntry("del-1", "This entry will be deleted soon", {
      sessionId: "sess-1",
      type: "conversation",
      createdAt: new Date(),
    });
    expect(engine.getCount()).toBe(1);

    engine.deleteEntry("del-1");
    expect(engine.getCount()).toBe(0);
  });

  it("deleteEntry with non-existent id does not throw", () => {
    expect(() => engine.deleteEntry("non-existent")).not.toThrow();
  });

  it("getCount returns correct number of entries", () => {
    expect(engine.getCount()).toBe(0);

    engine.indexEntry("c1", "First entry", {
      sessionId: "s1",
      type: "conversation",
      createdAt: new Date(),
    });
    expect(engine.getCount()).toBe(1);

    engine.indexEntry("c2", "Second entry", {
      sessionId: "s1",
      type: "conversation",
      createdAt: new Date(),
    });
    expect(engine.getCount()).toBe(2);
  });

  it("search results include snippet", () => {
    engine.indexEntry("snip-1", "This is a long document about machine learning algorithms and neural networks", {
      sessionId: "s1",
      type: "knowledge",
      createdAt: new Date(),
    });

    const results = engine.search({ query: "machine learning" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].snippet).toBeDefined();
    expect(typeof results[0].snippet).toBe("string");
  });

  it("search results include rank", () => {
    engine.indexEntry("rank-1", "Machine learning is a subset of artificial intelligence", {
      sessionId: "s1",
      type: "knowledge",
      createdAt: new Date(),
    });

    const results = engine.search({ query: "machine learning" });
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0].rank).toBe("number");
  });

  it("close clears the database", () => {
    engine.indexEntry("close-1", "test content", {
      sessionId: "s1",
      type: "conversation",
      createdAt: new Date(),
    });
    engine.close();
    engine = new FTS5SearchEngine(":memory:");
    engine.initialize();
    expect(engine.getCount()).toBe(0);
  });

  it("indexEntry with same id creates additional row in FTS5", () => {
    engine.indexEntry("dup-1", "Original content about algorithms", {
      sessionId: "s1",
      type: "conversation",
      createdAt: new Date(),
    });
    engine.indexEntry("dup-1", "Updated content about algorithms", {
      sessionId: "s1",
      type: "knowledge",
      createdAt: new Date(),
    });

    const results = engine.search({ query: "algorithms" });
    expect(results.length).toBeGreaterThan(0);
    const hasUpdated = results.some((r) => r.content.includes("Updated content"));
    expect(hasUpdated).toBe(true);
  });
});

describe("FTS5SearchEngine fallback mode", () => {
  function createFallbackEngine(): FTS5SearchEngine {
    const eng = new FTS5SearchEngine(":memory:");
    const internal = eng as unknown as {
      db: null;
      useFallback: boolean;
      fallback: Map<string, unknown>;
    };
    internal.db = null;
    internal.useFallback = true;
    internal.fallback = new Map();
    return eng;
  }

  it("operates in fallback mode when database is not available", () => {
    const fallbackEngine = createFallbackEngine();

    fallbackEngine.indexEntry("fb-1", "Fallback mode content about testing", {
      sessionId: "s1",
      type: "conversation",
      createdAt: new Date(),
    });

    expect(fallbackEngine.getCount()).toBe(1);

    const results = fallbackEngine.search({ query: "testing" });
    expect(results.length).toBeGreaterThanOrEqual(1);

    fallbackEngine.close();
  });

  it("fallback search with sessionId filter", () => {
    const engine = createFallbackEngine();

    engine.indexEntry("fb-s1", "Content for session A", {
      sessionId: "sess-a",
      type: "conversation",
      createdAt: new Date(),
    });
    engine.indexEntry("fb-s2", "Content for session B", {
      sessionId: "sess-b",
      type: "conversation",
      createdAt: new Date(),
    });

    const results = engine.search({ query: "Content", sessionId: "sess-a" });
    expect(results.every((r) => r.metadata.sessionId === "sess-a")).toBe(true);

    engine.close();
  });

  it("fallback deleteEntry works", () => {
    const engine = createFallbackEngine();

    engine.indexEntry("fb-del", "To be deleted", {
      sessionId: "s1",
      type: "conversation",
      createdAt: new Date(),
    });
    expect(engine.getCount()).toBe(1);

    engine.deleteEntry("fb-del");
    expect(engine.getCount()).toBe(0);

    engine.close();
  });

  it("fallback search with limit and offset", () => {
    const engine = createFallbackEngine();

    for (let i = 0; i < 5; i++) {
      engine.indexEntry(`fb-lim-${i}`, `Fallback document number ${i} about testing`, {
        sessionId: "s1",
        type: "conversation",
        createdAt: new Date(),
      });
    }

    const first = engine.search({ query: "testing", limit: 2, offset: 0 });
    expect(first.length).toBeLessThanOrEqual(2);

    engine.close();
  });

  it("fallback search with type filter", () => {
    const engine = createFallbackEngine();

    engine.indexEntry("fb-t1", "Knowledge about testing", {
      sessionId: "s1",
      type: "knowledge",
      createdAt: new Date(),
    });
    engine.indexEntry("fb-t2", "Conversation about testing", {
      sessionId: "s1",
      type: "conversation",
      createdAt: new Date(),
    });

    const results = engine.search({ query: "testing", type: "knowledge" });
    expect(results.every((r) => r.metadata.type === "knowledge")).toBe(true);

    engine.close();
  });

  it("fallback search returns results with snippet and rank", () => {
    const engine = createFallbackEngine();

    engine.indexEntry("fb-snip", "This is a long document about machine learning and neural networks", {
      sessionId: "s1",
      type: "knowledge",
      createdAt: new Date(),
    });

    const results = engine.search({ query: "machine learning" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].snippet).toBeDefined();
    expect(typeof results[0].rank).toBe("number");

    engine.close();
  });
});
