import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FTS5SearchEngine, buildFtsMatchQuery, hasCjkText } from "./fts5-search";

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

  // ── hermes alignment round4：多词 / CJK / 注入安全 ──────────
  it("多词自然语言查询按「与」语义命中（旧实现整句短语会零结果）", () => {
    engine.indexEntry("multi-1", "The quick brown fox jumps over the lazy dog", {
      sessionId: "s1", type: "conversation", createdAt: new Date("2025-01-01"),
    });
    engine.indexEntry("multi-2", "A quick brown bear sleeps", {
      sessionId: "s1", type: "conversation", createdAt: new Date("2025-01-02"),
    });
    const results = engine.search({ query: "quick dog" });
    expect(results.map((r) => r.metadata.id)).toContain("multi-1");
    expect(results.map((r) => r.metadata.id)).not.toContain("multi-2");
  });

  it("部分单词前缀可命中（quick* / brow*）", () => {
    engine.indexEntry("prefix-1", "The quick brown fox", {
      sessionId: "s1", type: "conversation", createdAt: new Date(),
    });
    expect(engine.search({ query: "quic" }).length).toBeGreaterThan(0);
    expect(engine.search({ query: "brow" }).length).toBeGreaterThan(0);
  });

  it("显式短语仍按精确短语处理，且 FTS5 特殊字符不注入语法", () => {
    engine.indexEntry("phrase-1", "machine learning algorithms", {
      sessionId: "s1", type: "knowledge", createdAt: new Date(),
    });
    expect(engine.search({ query: '"machine learning"' }).length).toBeGreaterThan(0);
    // 特殊字符被字面化，不抛语法错误也不误命中
    expect(() => engine.search({ query: "rm -rf / OR ) * \"" })).not.toThrow();
    expect(buildFtsMatchQuery('a "b c" OR d')).toBe('"a"* "b c" OR "d"*');
  });

  it("★ CJK 查询走 LIKE 回退，不再静默零结果", () => {
    engine.indexEntry("cjk-1", "项目进度报告已经完成，季度目标达成", {
      sessionId: "s1", type: "knowledge", createdAt: new Date("2025-01-01"),
    });
    engine.indexEntry("cjk-2", "完全无关的烹饪食谱记录", {
      sessionId: "s1", type: "knowledge", createdAt: new Date("2025-01-02"),
    });
    expect(hasCjkText("项目进度")).toBe(true);
    for (const q of ["项目进度", "项目", "季度目标"]) {
      const results = engine.search({ query: q });
      expect(results.map((r) => r.metadata.id), `CJK 查询 ${q} 应命中`).toContain("cjk-1");
    }
    // 中间片段：整段 token 的前缀匹配不到，必须真正走 LIKE 回退
    // （unicode61 把「项目进度报告已经完成」切成一个 token）
    for (const q of ["进度", "报告", "完成"]) {
      const results = engine.search({ query: q });
      expect(results.map((r) => r.metadata.id), `CJK 片段 ${q} 应经 LIKE 回退命中`).toContain("cjk-1");
    }
    expect(engine.search({ query: "项目进度" }).map((r) => r.metadata.id)).not.toContain("cjk-2");
  });

  it("CJK LIKE 回退仍遵守 sessionId / type / 分页过滤", () => {
    engine.indexEntry("cjk-f1", "项目进度报告一", { sessionId: "s1", type: "knowledge", createdAt: new Date() });
    engine.indexEntry("cjk-f2", "项目进度报告二", { sessionId: "s2", type: "conversation", createdAt: new Date() });
    const filtered = engine.search({ query: "项目进度", sessionId: "s1", type: "knowledge", limit: 1 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].metadata.id).toBe("cjk-f1");
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

  it("fallback 多词查询同样按「与」语义（与 SQLite 路径不分叉）", () => {
    const engine = createFallbackEngine();
    engine.indexEntry("fb-m1", "The quick brown fox and the lazy dog", {
      sessionId: "s1", type: "conversation", createdAt: new Date(),
    });
    engine.indexEntry("fb-m2", "A quick brown bear", {
      sessionId: "s1", type: "conversation", createdAt: new Date(),
    });
    const results = engine.search({ query: "quick dog" });
    expect(results.map((r) => r.metadata.id)).toEqual(["fb-m1"]);
    engine.close();
  });
});
