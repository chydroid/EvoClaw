import { describe, it, expect } from "vitest";
import { SimpleReranker } from "./reranker";

describe("SimpleReranker", () => {
  const reranker = new SimpleReranker();

  it("should rerank results and preserve originalScore", () => {
    const results = [
      { text: "The cat sat on the mat", score: 0.9, metadata: { id: 1 } },
      { text: "Dogs are loyal animals", score: 0.7, metadata: { id: 2 } },
    ];

    const reranked = reranker.rerank("cat on mat", results);

    expect(reranked).toHaveLength(2);
    for (const r of reranked) {
      expect(r).toHaveProperty("originalScore");
      expect(r).toHaveProperty("score");
      expect(r).toHaveProperty("text");
      expect(r).toHaveProperty("metadata");
    }
    // originalScore should match the input score
    expect(reranked.find((r) => r.text.includes("cat"))!.originalScore).toBe(0.9);
    expect(reranked.find((r) => r.text.includes("Dogs"))!.originalScore).toBe(0.7);
  });

  it("should boost results with keyword overlap", () => {
    const results = [
      { text: "The cat sat on the mat", score: 0.5, metadata: {} },
      { text: "Dogs are loyal animals", score: 0.5, metadata: {} },
    ];

    const reranked = reranker.rerank("cat mat", results);

    // The "cat" result should be boosted because of keyword overlap
    const catResult = reranked.find((r) => r.text.includes("cat"))!;
    const dogResult = reranked.find((r) => r.text.includes("Dogs"))!;

    expect(catResult.score).toBeGreaterThan(dogResult.score);
    // Both should have originalScore of 0.5
    expect(catResult.originalScore).toBe(0.5);
    expect(dogResult.originalScore).toBe(0.5);
  });

  it("should handle empty results", () => {
    const reranked = reranker.rerank("query", []);
    expect(reranked).toHaveLength(0);
  });

  it("should handle Chinese text keyword overlap", () => {
    const results = [
      { text: "人工智能是未来的发展方向", score: 0.5, metadata: {} },
      { text: "今天天气很好适合出门", score: 0.5, metadata: {} },
    ];

    const reranked = reranker.rerank("人工智能", results);

    const aiResult = reranked.find((r) => r.text.includes("人工智能"))!;
    const weatherResult = reranked.find((r) => r.text.includes("天气"))!;

    expect(aiResult.score).toBeGreaterThan(weatherResult.score);
  });

  it("should sort by final score descending", () => {
    const results = [
      { text: "alpha beta gamma", score: 0.3, metadata: {} },
      { text: "alpha delta epsilon", score: 0.9, metadata: {} },
      { text: "zeta eta theta", score: 0.6, metadata: {} },
    ];

    const reranked = reranker.rerank("alpha", results);

    // Should be sorted by final score descending
    for (let i = 1; i < reranked.length; i++) {
      expect(reranked[i - 1].score).toBeGreaterThanOrEqual(reranked[i].score);
    }
  });
});
