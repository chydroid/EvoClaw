import { describe, it, expect, beforeEach } from "vitest";
import {
  CompactionManager,
  type CompressionEffectSummary,
} from "./compaction-manager";

describe("CompactionManager.summarizeManualCompression", () => {
  let mgr: CompactionManager;

  beforeEach(() => {
    mgr = new CompactionManager({ dataDir: "./data/compactions-test-feedback" });
  });

  const makeSummary = (
    before: unknown[],
    after: unknown[],
    beforeTokens: number,
    afterTokens: number,
  ): CompressionEffectSummary =>
    mgr.summarizeManualCompression(before, after, beforeTokens, afterTokens);

  it("noop=true when after.length === before.length", () => {
    const before = [1, 2, 3];
    const after = [1, 2, 3];
    const s = makeSummary(before, after, 100, 100);
    expect(s.noop).toBe(true);
    expect(s.headline).toBe("No changes from compression: 3 messages");
    expect(s.tokenLine).toBe("Approx request size: ~100 → ~100 tokens");
    expect(s.note).toBeUndefined();
  });

  it("noop=false and headline shows compressed count when messages reduced", () => {
    const before = [1, 2, 3, 4, 5];
    const after = [1, 2];
    const s = makeSummary(before, after, 500, 200);
    expect(s.noop).toBe(false);
    expect(s.headline).toBe("Compressed: 5 → 2 messages");
    expect(s.tokenLine).toBe("Approx request size: ~500 → ~200 tokens");
    // tokens 减少，不触发 note
    expect(s.note).toBeUndefined();
  });

  it("adds note when messages reduced but tokens increased", () => {
    const before = [1, 2, 3, 4];
    const after = [1, 2];
    const s = makeSummary(before, after, 100, 150);
    expect(s.noop).toBe(false);
    expect(s.headline).toBe("Compressed: 4 → 2 messages");
    expect(s.tokenLine).toBe("Approx request size: ~100 → ~150 tokens");
    expect(s.note).toBeDefined();
    expect(s.note).toContain("denser summaries");
  });

  it("does not add note when messages equal (noop)", () => {
    const before = [1, 2];
    const after = [1, 2];
    // 即使 tokens 增加，因 noop 也不附加 note
    const s = makeSummary(before, after, 100, 200);
    expect(s.noop).toBe(true);
    expect(s.note).toBeUndefined();
  });

  it("does not add note when messages reduced and tokens reduced", () => {
    const before = [1, 2, 3];
    const after = [1];
    const s = makeSummary(before, after, 300, 100);
    expect(s.noop).toBe(false);
    expect(s.note).toBeUndefined();
  });

  it("handles empty arrays", () => {
    const s = makeSummary([], [], 0, 0);
    expect(s.noop).toBe(true);
    expect(s.headline).toBe("No changes from compression: 0 messages");
    expect(s.tokenLine).toBe("Approx request size: ~0 → ~0 tokens");
    expect(s.note).toBeUndefined();
  });

  it("handles messages increase (after > before) without note", () => {
    const before = [1];
    const after = [1, 2, 3];
    const s = makeSummary(before, after, 50, 150);
    expect(s.noop).toBe(false);
    expect(s.headline).toBe("Compressed: 1 → 3 messages");
    expect(s.note).toBeUndefined();
  });

  it("returns CompressionEffectSummary shape with all required fields", () => {
    const s = makeSummary([1, 2], [1], 100, 80);
    expect(s).toHaveProperty("noop");
    expect(s).toHaveProperty("headline");
    expect(s).toHaveProperty("tokenLine");
    // note 为 optional
    expect(typeof s.noop).toBe("boolean");
    expect(typeof s.headline).toBe("string");
    expect(typeof s.tokenLine).toBe("string");
  });

  it("does not mutate input arrays", () => {
    const before = [1, 2, 3];
    const after = [1];
    const beforeCopy = [...before];
    const afterCopy = [...after];
    makeSummary(before, after, 100, 80);
    expect(before).toEqual(beforeCopy);
    expect(after).toEqual(afterCopy);
  });

  it("tokenLine reflects passed token numbers exactly", () => {
    const s = makeSummary([1, 2, 3], [1], 1234, 567);
    expect(s.tokenLine).toBe("Approx request size: ~1234 → ~567 tokens");
  });
});
