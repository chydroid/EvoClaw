import { describe, it, expect } from "vitest";
import { VectorMemoryStore, EmbeddingSimulator, LocalEmbeddingProvider } from "./vector-memory";

describe("VectorMemoryStore", () => {
  it("should add and search vectors", async () => {
    const store = new VectorMemoryStore(null as never, null as never);

    await store.addVector("v1", [1, 0, 0], { label: "cat" });
    await store.addVector("v2", [0, 1, 0], { label: "dog" });
    await store.addVector("v3", [0, 0, 1], { label: "bird" });

    const results = await store.search([1, 0, 0], { threshold: 0 });
    expect(results[0].id).toBe("v1");
  });

  it("should return results sorted by similarity", async () => {
    const store = new VectorMemoryStore(null as never, null as never);

    await store.addVector("target", [1, 0, 0]);
    await store.addVector("far", [-1, 0, 0]);
    await store.addVector("mid", [0.5, 0.5, 0]);

    const results = await store.search([1, 0, 0], { threshold: -0.01, limit: 3 });

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].id).toBe("target");
    expect(results[0].score).toBeGreaterThan(results[results.length - 1].score);
  });

  it("should respect similarity threshold", async () => {
    const store = new VectorMemoryStore(null as never, null as never);

    await store.addVector("v1", [1, 0, 0]);
    await store.addVector("v2", [-1, 0, 0]);

    const results = await store.search([1, 0, 0], { threshold: 0.9 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("v1");
  });

  it("should support batch add", async () => {
    const store = new VectorMemoryStore(null as never, null as never);

    await store.batchAdd([
      { id: "a", vector: [1, 0] },
      { id: "b", vector: [0, 1] },
      { id: "c", vector: [1, 1] },
    ]);

    expect(store.size()).toBe(3);
  });

  it("should delete vectors", async () => {
    const store = new VectorMemoryStore(null as never, null as never);

    await store.addVector("x", [1, 0]);
    expect(store.size()).toBe(1);

    store.delete("x");
    expect(store.size()).toBe(0);
  });
});

describe("EmbeddingSimulator", () => {
  it("should generate vectors of correct dimension", async () => {
    const sim = new EmbeddingSimulator(256);
    const v = await sim.generate("hello world");
    expect(v).toHaveLength(256);
    expect(sim.dimension()).toBe(256);
  });

  it("should produce similar vectors for similar text", async () => {
    const sim = new EmbeddingSimulator(256);

    const v1 = await sim.generate("hello world");
    const v2 = await sim.generate("hello world");
    const v3 = await sim.generate("completely different text");

    const similarity12 = cosineSimilarity(v1, v2);
    const similarity13 = cosineSimilarity(v1, v3);

    expect(similarity12).toBeCloseTo(1.0, 10);
    expect(similarity13).toBeLessThan(1.0);
  });

  it("should generate normalized vectors", async () => {
    const sim = new EmbeddingSimulator(128);
    const v = await sim.generate("test");

    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("should batch generate", async () => {
    const sim = new EmbeddingSimulator(64);
    const vectors = await sim.batchGenerate(["a", "b", "c"]);
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toHaveLength(64);
  });
});

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

describe("LocalEmbeddingProvider", () => {
  it("should generate vectors for Chinese text", async () => {
    const provider = new LocalEmbeddingProvider();
    const vector = await provider.embed("人工智能是未来的发展方向");
    expect(vector).toHaveLength(256);

    const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("should produce similar vectors for similar Chinese text", async () => {
    const provider = new LocalEmbeddingProvider();

    const v1 = await provider.embed("人工智能技术");
    const v2 = await provider.embed("人工智能技术");
    const v3 = await provider.embed("今天天气很好");

    const similarity12 = cosineSimilarity(v1, v2);
    const similarity13 = cosineSimilarity(v1, v3);

    expect(similarity12).toBeCloseTo(1.0, 5);
    expect(similarity13).toBeLessThan(1.0);
  });

  it("should handle mixed English-Chinese text", async () => {
    const provider = new LocalEmbeddingProvider();

    const v1 = await provider.embed("Python编程语言很受欢迎");
    const v2 = await provider.embed("Python编程语言很受欢迎");
    const v3 = await provider.embed("Java是一种面向对象的语言");

    const similarity12 = cosineSimilarity(v1, v2);
    const similarity13 = cosineSimilarity(v1, v3);

    expect(similarity12).toBeCloseTo(1.0, 5);
    expect(similarity13).toBeLessThan(1.0);
  });
});