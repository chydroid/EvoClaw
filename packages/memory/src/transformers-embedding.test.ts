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

  it("isLoaded() returns false before warmUp()", () => {
    const provider = new TransformersEmbeddingProvider();
    expect(provider.isLoaded()).toBe(false);
    expect(provider.getLoadError()).toBeNull();
  });

  it("warmUp() returns false and captures the error when the model can't load (offline / missing weights)", async () => {
    if (!TransformersEmbeddingProvider.isAvailable()) return;
    // Point at a non-existent model path so warmUp() must fail. We do NOT
    // touch the real @huggingface/transformers — the test only verifies the
    // error capture contract, not the real ONNX runtime.
    const provider = new TransformersEmbeddingProvider({
      model: "this-model-definitely-does-not-exist-xyz",
    });
    const ok = await provider.warmUp();
    expect(ok).toBe(false);
    expect(provider.isLoaded()).toBe(false);
    expect(provider.getLoadError()).toBeInstanceOf(Error);
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
