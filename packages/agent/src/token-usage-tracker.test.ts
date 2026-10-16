import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TokenUsageTracker } from "./token-usage-tracker";

describe("TokenUsageTracker — 缓存命中/写入字段（P0 埋点回归）", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-tutest-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("record 携带 cacheHitTokens/cacheWriteTokens 时 getSummary 全维度聚合", () => {
    const t = new TokenUsageTracker({ storeDir: path.join(tmpDir, "a") });
    t.record({ sessionId: "s1", provider: "openai", model: "gpt-4", inputTokens: 1000, outputTokens: 200, cacheHitTokens: 800, cacheWriteTokens: 100 });
    t.record({ sessionId: "s1", provider: "openai", model: "gpt-4", inputTokens: 1000, outputTokens: 200, cacheHitTokens: 500 });
    const s = t.getSummary();
    expect(s.totalCacheHitTokens).toBe(1300);
    expect(s.totalCacheWriteTokens).toBe(100);
    const m = s.byModel["openai/gpt-4"];
    expect(m.calls).toBe(2);
    expect(m.cacheHitTokens).toBe(1300);
    expect(m.cacheWriteTokens).toBe(100);
    const sess = t.getSessionCost("s1");
    expect(sess.cacheHitTokens).toBe(1300);
    expect(sess.cacheWriteTokens).toBe(100);
  });

  it("旧记录（无缓存字段）加载后聚合为 0，不崩 NaN", () => {
    const dir = path.join(tmpDir, "old");
    fs.mkdirSync(dir, { recursive: true });
    // 模拟旧版 records.json：只有基础字段，无 cacheHitTokens
    fs.writeFileSync(
      path.join(dir, "records.json"),
      JSON.stringify({
        counter: 1,
        savedAt: new Date().toISOString(),
        records: [{
          id: "usage-1-0", sessionId: "s-old", provider: "openai", model: "gpt-4",
          inputTokens: 500, outputTokens: 100, inputCost: 0, outputCost: 0,
          totalCost: 0, calledAt: Date.now(),
        }],
      }),
    );
    const t = new TokenUsageTracker({ storeDir: dir });
    const s = t.getSummary();
    expect(s.totalCacheHitTokens).toBe(0);
    expect(s.totalCacheWriteTokens).toBe(0);
    expect(Number.isFinite(s.totalInputTokens)).toBe(true);
  });

  it("负数/NaN 缓存字段被钳制（不污染统计）", () => {
    const t = new TokenUsageTracker({ storeDir: path.join(tmpDir, "b") });
    t.record({ sessionId: "s", provider: "openai", model: "m", inputTokens: 100, outputTokens: 10, cacheHitTokens: -5, cacheWriteTokens: -1 });
    const s = t.getSummary();
    expect(s.totalCacheHitTokens).toBe(0);
    expect(s.totalCacheWriteTokens).toBe(0);
  });
});
