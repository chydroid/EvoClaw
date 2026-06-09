import { describe, it, expect } from "vitest";
import { RAGPipeline } from "./rag-pipeline";
import { LocalEmbeddingProvider } from "../vector-memory";

describe("RAGPipeline", () => {
  const provider = new LocalEmbeddingProvider();

  it("should index a document and retrieve relevant chunks", async () => {
    const pipeline = new RAGPipeline({
      provider,
      chunkOptions: { strategy: "paragraph", minChunkSize: 1 },
      topK: 3,
      threshold: 0,
      enableReranking: false,
    });

    await pipeline.indexDocument({
      id: "doc1",
      text: "Cats are small furry animals that purr. They are popular pets around the world.\n\nDogs are loyal companions. They love to play fetch and go for walks.",
    });

    const results = await pipeline.retrieve("cats purr pets", { threshold: 0 });

    expect(results.length).toBeGreaterThan(0);
    // The cat-related chunk should rank higher
    const topResult = results[0];
    expect(topResult.text.toLowerCase()).toContain("cat");
  });

  it("should index multiple documents", async () => {
    const pipeline = new RAGPipeline({
      provider,
      chunkOptions: { strategy: "paragraph", minChunkSize: 1 },
      topK: 5,
      threshold: 0,
      enableReranking: false,
    });

    await pipeline.indexDocuments([
      {
        id: "doc1",
        text: "Python is a programming language known for its readability and simplicity.",
      },
      {
        id: "doc2",
        text: "JavaScript is widely used for web development and runs in browsers.",
      },
    ]);

    expect(pipeline.documentCount()).toBe(2);
    expect(pipeline.chunkCount()).toBeGreaterThanOrEqual(2);
  });

  it("should track document and chunk counts", async () => {
    const pipeline = new RAGPipeline({
      provider,
      chunkOptions: { strategy: "paragraph", minChunkSize: 1 },
    });

    expect(pipeline.documentCount()).toBe(0);
    expect(pipeline.chunkCount()).toBe(0);

    await pipeline.indexDocument({
      id: "doc1",
      text: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
    });

    expect(pipeline.documentCount()).toBe(1);
    expect(pipeline.chunkCount()).toBeGreaterThanOrEqual(1);
  });

  it("should remove a document from the index", async () => {
    const pipeline = new RAGPipeline({
      provider,
      chunkOptions: { strategy: "paragraph", minChunkSize: 1 },
      threshold: 0,
      enableReranking: false,
    });

    await pipeline.indexDocument({
      id: "doc1",
      text: "This is a test document with enough content to be indexed properly.",
    });

    expect(pipeline.documentCount()).toBe(1);
    const chunkCountBefore = pipeline.chunkCount();
    expect(chunkCountBefore).toBeGreaterThan(0);

    await pipeline.removeDocument("doc1");

    expect(pipeline.documentCount()).toBe(0);
    expect(pipeline.chunkCount()).toBe(0);
  });

  it("should respect topK and threshold options", async () => {
    const pipeline = new RAGPipeline({
      provider,
      chunkOptions: { strategy: "paragraph", minChunkSize: 1 },
      topK: 1,
      threshold: 0,
      enableReranking: false,
    });

    await pipeline.indexDocument({
      id: "doc1",
      text: "Alpha content about alpha things.\n\nBeta content about beta things.\n\nGamma content about gamma things.",
    });

    // topK=1 should limit results
    const results = await pipeline.retrieve("alpha", { topK: 1, threshold: 0 });
    expect(results.length).toBeLessThanOrEqual(1);

    // High threshold should filter out low-similarity results
    const strictResults = await pipeline.retrieve("alpha", { threshold: 0.99 });
    expect(strictResults.length).toBeLessThanOrEqual(results.length);
  });

  it("should work with Chinese text", async () => {
    const pipeline = new RAGPipeline({
      provider,
      chunkOptions: { strategy: "paragraph", minChunkSize: 1 },
      topK: 3,
      threshold: 0,
      enableReranking: false,
    });

    await pipeline.indexDocument({
      id: "cn-doc1",
      text: "人工智能是计算机科学的一个重要分支，致力于创建智能机器。\n\n机器学习是人工智能的子领域，通过数据训练模型来做出预测。",
    });

    const results = await pipeline.retrieve("人工智能", { threshold: 0 });
    expect(results.length).toBeGreaterThan(0);
    // The AI-related chunk should be in the results
    expect(results.some((r) => r.text.includes("人工智能"))).toBe(true);
  });
});
