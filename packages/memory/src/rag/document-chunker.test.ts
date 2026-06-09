import { describe, it, expect } from "vitest";
import { chunkDocument } from "./document-chunker";

describe("chunkDocument", () => {
  it("should handle empty text", () => {
    const chunks = chunkDocument("");
    expect(chunks).toHaveLength(0);
  });

  it("should handle short text as single chunk", () => {
    const chunks = chunkDocument("short text", { strategy: "fixed", maxChunkSize: 512 });
    expect(chunks).toHaveLength(1);
  });

  it("should split text into fixed-size chunks", () => {
    const chunks = chunkDocument("a".repeat(100), { strategy: "fixed", maxChunkSize: 40, overlap: 10, minChunkSize: 1 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("should split on double newlines", () => {
    const chunks = chunkDocument("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.", { strategy: "paragraph", minChunkSize: 1 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it("should split on sentence boundaries", () => {
    const chunks = chunkDocument("First sentence. Second sentence! Third sentence?", { strategy: "sentence", minChunkSize: 1 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("should split on Chinese sentence boundaries", () => {
    const chunks = chunkDocument("这是第一句话。这是第二句话！这是第三句话？", { strategy: "sentence", minChunkSize: 1 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("should track correct offsets", () => {
    const text = "Hello world. This is a test.";
    const chunks = chunkDocument(text, { strategy: "fixed", maxChunkSize: 15, overlap: 3, minChunkSize: 1 });
    for (const chunk of chunks) {
      expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
    }
  });

  it("should merge small chunks", () => {
    const text = "A very long paragraph that is definitely longer than the minimum chunk size.\n\nTiny.";
    const chunks = chunkDocument(text, { strategy: "paragraph", minChunkSize: 50 });
    let foundStandaloneTiny = false;
    for (const c of chunks) {
      if (c.text.trim() === "Tiny.") foundStandaloneTiny = true;
    }
    expect(foundStandaloneTiny).toBe(false);
  });

  it("should handle Chinese text with paragraph strategy", () => {
    const chunks = chunkDocument("这是第一段内容，包含了足够多的文字。\n\n这是第二段内容，同样包含了足够多的文字。", { strategy: "paragraph", minChunkSize: 10 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});
