import { describe, it, expect } from "vitest";
import { TransformersEmbeddingProvider } from "./transformers-embedding";

describe("TransformersEmbeddingProvider", () => {
  it("should construct without errors", () => {
    const provider = new TransformersEmbeddingProvider();
    expect(provider).toBeDefined();
    expect(provider.dimensions).toBe(384);
  });

  it("should have correct default dimensions (384)", () => {
    const provider = new TransformersEmbeddingProvider();
    expect(provider.dimensions).toBe(384);
  });

  it("should have isAvailable() return a boolean", () => {
    const result = TransformersEmbeddingProvider.isAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("should allow custom model and dimensions via options", () => {
    const provider = new TransformersEmbeddingProvider({
      model: "custom-model",
      dimensions: 768,
    });
    expect(provider.dimensions).toBe(768);
  });

  // This test requires network access to download the model from huggingface.co
  // Skip if the package is not installed OR if we're in a network-restricted environment
  it.runIf(
    TransformersEmbeddingProvider.isAvailable() &&
      process.env["EVOCLAW_TEST_TRANSFORMERS"] === "1"
  )(
    "should generate embeddings of correct dimension",
    async () => {
      const provider = new TransformersEmbeddingProvider({ dimensions: 384 });
      const vector = await provider.embed("hello world");

      expect(Array.isArray(vector)).toBe(true);
      expect(vector.length).toBe(384);

      // Vector should be L2-normalized
      const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
      expect(norm).toBeCloseTo(1.0, 3);
    },
    60000 // 60s timeout for model download on first run
  );
});
