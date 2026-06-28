import { describe, it, expect, beforeEach } from "vitest";
import { CacheTracer } from "./cache-trace";
import type { CacheProvider } from "./prompt-cache-stability";

describe("CacheTracer", () => {
  let tracer: CacheTracer;

  beforeEach(() => {
    tracer = new CacheTracer();
  });

  const makeEntry = (
    overrides: Partial<{
      provider: CacheProvider;
      model: string;
      sessionId: string;
      cacheHitTokens: number;
      cacheMissTokens: number;
      cacheBrokenAt: number;
      cacheBrokenReason: string;
      durationMs: number;
    }> = {},
  ) => ({
    provider: "openai" as CacheProvider,
    model: "gpt-4o",
    sessionId: "session-1",
    cacheHitTokens: 1000,
    cacheMissTokens: 200,
    cacheBrokenAt: 5,
    cacheBrokenReason: "messages[5] changed",
    durationMs: 200,
    ...overrides,
  });

  describe("record", () => {
    it("record 填充 id/timestamp/costSaved/latencySaved", () => {
      const entry = tracer.record(makeEntry());
      expect(entry.id).toBeDefined();
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.timestamp).toBeInstanceOf(Date);
      expect(entry.estimatedInputCostSaved).toBeGreaterThan(0);
      expect(entry.estimatedLatencySavedMs).toBeGreaterThan(0);
    });

    it("record 后可查询到该条目", () => {
      tracer.record(makeEntry());
      expect(tracer.size()).toBe(1);
      const all = tracer.query({});
      expect(all).toHaveLength(1);
    });

    it("record 0 cacheHitTokens 时 costSaved 为 0", () => {
      const entry = tracer.record(
        makeEntry({ cacheHitTokens: 0, cacheMissTokens: 100 }),
      );
      expect(entry.estimatedInputCostSaved).toBe(0);
    });

    it("record 超过 maxSize 时 FIFO 淘汰", () => {
      const small = new CacheTracer({ maxSize: 3 });
      for (let i = 0; i < 5; i++) {
        small.record(makeEntry({ sessionId: `s-${i}` }));
      }
      expect(small.size()).toBe(3);
      const all = small.query({});
      expect(all[0].sessionId).toBe("s-2");
      expect(all[2].sessionId).toBe("s-4");
    });
  });

  describe("query", () => {
    beforeEach(() => {
      tracer.record(makeEntry({ sessionId: "a", provider: "openai" }));
      tracer.record(makeEntry({ sessionId: "b", provider: "anthropic" }));
      tracer.record(
        makeEntry({ sessionId: "a", provider: "openai", cacheMissTokens: 500 }),
      );
    });

    it("query by sessionId 过滤", () => {
      const result = tracer.query({ sessionId: "a" });
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.sessionId === "a")).toBe(true);
    });

    it("query by provider 过滤", () => {
      const result = tracer.query({ provider: "anthropic" });
      expect(result).toHaveLength(1);
      expect(result[0].provider).toBe("anthropic");
    });

    it("query by minCacheMissTokens 过滤", () => {
      const result = tracer.query({ minCacheMissTokens: 400 });
      expect(result).toHaveLength(1);
      expect(result[0].cacheMissTokens).toBe(500);
    });

    it("query 按 timestamp 升序", () => {
      const result = tracer.query({});
      expect(result.length).toBe(3);
      expect(result[0].timestamp.getTime()).toBeLessThanOrEqual(
        result[1].timestamp.getTime(),
      );
      expect(result[1].timestamp.getTime()).toBeLessThanOrEqual(
        result[2].timestamp.getTime(),
      );
    });

    it("query 支持 limit", () => {
      const result = tracer.query({ limit: 2 });
      expect(result).toHaveLength(2);
    });

    it("query 支持 after/before 时间范围", () => {
      const future = new Date(Date.now() + 60_000);
      const past = new Date(Date.now() - 60_000);
      expect(tracer.query({ before: past })).toHaveLength(0);
      expect(tracer.query({ after: past })).toHaveLength(3);
      expect(tracer.query({ before: future, after: past })).toHaveLength(3);
    });
  });

  describe("stats", () => {
    it("stats totalRequests 正确", () => {
      tracer.record(makeEntry({ sessionId: "a" }));
      tracer.record(makeEntry({ sessionId: "b" }));
      const stats = tracer.stats();
      expect(stats.totalRequests).toBe(2);
    });

    it("stats byProvider 按 provider 聚合", () => {
      tracer.record(makeEntry({ provider: "openai", cacheHitTokens: 1000 }));
      tracer.record(makeEntry({ provider: "anthropic", cacheHitTokens: 500 }));
      tracer.record(makeEntry({ provider: "openai", cacheHitTokens: 500 }));
      const stats = tracer.stats();
      expect(stats.byProvider.openai.requests).toBe(2);
      expect(stats.byProvider.openai.hitTokens).toBe(1500);
      expect(stats.byProvider.anthropic.requests).toBe(1);
      expect(stats.byProvider.anthropic.hitTokens).toBe(500);
    });

    it("stats bySession 按 session 聚合", () => {
      tracer.record(makeEntry({ sessionId: "s1", cacheHitTokens: 100 }));
      tracer.record(makeEntry({ sessionId: "s2", cacheHitTokens: 200 }));
      tracer.record(makeEntry({ sessionId: "s1", cacheHitTokens: 300 }));
      const stats = tracer.stats();
      expect(stats.bySession.s1.requests).toBe(2);
      expect(stats.bySession.s1.hitTokens).toBe(400);
      expect(stats.bySession.s2.requests).toBe(1);
      expect(stats.bySession.s2.hitTokens).toBe(200);
    });

    it("stats overallHitRate 计算", () => {
      tracer.record(makeEntry({ cacheHitTokens: 800, cacheMissTokens: 200 }));
      const stats = tracer.stats();
      expect(stats.overallHitRate).toBeCloseTo(0.8, 2);
    });

    it("stats totalEstimatedCostSaved 累计", () => {
      tracer.record(makeEntry({ cacheHitTokens: 1_000_000 }));
      const stats = tracer.stats();
      // gpt-4o: input=2.5, cacheRead=1.25 → 1M token 节省 $1.25
      expect(stats.totalEstimatedCostSaved).toBeCloseTo(1.25, 2);
    });

    it("stats worstBrokenReasons 按次数倒序", () => {
      tracer.record(makeEntry({ cacheBrokenReason: "reason-a" }));
      tracer.record(makeEntry({ cacheBrokenReason: "reason-b" }));
      tracer.record(makeEntry({ cacheBrokenReason: "reason-a" }));
      tracer.record(makeEntry({ cacheBrokenReason: "reason-a" }));
      const stats = tracer.stats();
      expect(stats.worstBrokenReasons[0].reason).toBe("reason-a");
      expect(stats.worstBrokenReasons[0].count).toBe(3);
      expect(stats.worstBrokenReasons[1].reason).toBe("reason-b");
      expect(stats.worstBrokenReasons[1].count).toBe(1);
    });

    it("stats 空 trace 返回零值", () => {
      const stats = tracer.stats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.totalCacheHitTokens).toBe(0);
      expect(stats.totalCacheMissTokens).toBe(0);
      expect(stats.overallHitRate).toBe(0);
      expect(stats.totalEstimatedCostSaved).toBe(0);
    });
  });

  describe("estimateCostSaved", () => {
    it("精确匹配 model 名称", () => {
      const cost = tracer.estimateCostSaved({
        provider: "openai",
        model: "gpt-4o",
        cacheHitTokens: 1_000_000,
      });
      // gpt-4o: input=2.5, cacheRead=1.25 → 1M token 节省 $1.25
      expect(cost).toBeCloseTo(1.25, 4);
    });

    it("模糊匹配 model 名称", () => {
      const cost = tracer.estimateCostSaved({
        provider: "openai",
        model: "gpt-4o-2024-08-06",
        cacheHitTokens: 1_000_000,
      });
      expect(cost).toBeCloseTo(1.25, 4);
    });

    it("未匹配 model 时使用 provider 默认值", () => {
      const cost = tracer.estimateCostSaved({
        provider: "anthropic",
        model: "unknown-model",
        cacheHitTokens: 1_000_000,
      });
      // anthropic 默认: input=2.5, cacheRead=0.3 → 1M token 节省 $2.20
      expect(cost).toBeCloseTo(2.2, 4);
    });

    it("cacheHitTokens=0 时返回 0", () => {
      const cost = tracer.estimateCostSaved({
        provider: "openai",
        model: "gpt-4o",
        cacheHitTokens: 0,
      });
      expect(cost).toBe(0);
    });
  });

  describe("prune", () => {
    it("prune 清理过期 trace", () => {
      const shortLived = new CacheTracer({ maxAgeMs: 10 });
      shortLived.record(makeEntry());
      // 等待过期
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const removed = shortLived.prune();
          expect(removed).toBe(1);
          expect(shortLived.size()).toBe(0);
          resolve();
        }, 20);
      });
    });

    it("prune 未过期的条目保留", () => {
      tracer.record(makeEntry());
      const removed = tracer.prune();
      expect(removed).toBe(0);
      expect(tracer.size()).toBe(1);
    });
  });

  describe("clear", () => {
    it("clear 清空所有 trace", () => {
      tracer.record(makeEntry());
      tracer.record(makeEntry());
      expect(tracer.size()).toBe(2);
      tracer.clear();
      expect(tracer.size()).toBe(0);
    });
  });

  describe("setCostTable", () => {
    it("setCostTable 合并覆盖现有成本表", () => {
      // 覆盖 gpt-4o 价格
      tracer.setCostTable({
        "gpt-4o": { input: 5.0, cacheRead: 1.0, cacheWrite: 6.0 },
      });
      const cost = tracer.estimateCostSaved({
        provider: "openai",
        model: "gpt-4o",
        cacheHitTokens: 1_000_000,
      });
      // 新价格: (5.0 - 1.0) * 1M / 1M = 4.0
      expect(cost).toBeCloseTo(4.0, 4);
    });

    it("setCostTable 添加新 model 不影响现有", () => {
      tracer.setCostTable({
        "custom-model": { input: 10, cacheRead: 1, cacheWrite: 12 },
      });
      const costCustom = tracer.estimateCostSaved({
        provider: "unknown",
        model: "custom-model",
        cacheHitTokens: 1_000_000,
      });
      expect(costCustom).toBeCloseTo(9.0, 4); // (10-1)*1M/1M

      // 现有 gpt-4o 不受影响
      const costGpt = tracer.estimateCostSaved({
        provider: "openai",
        model: "gpt-4o",
        cacheHitTokens: 1_000_000,
      });
      expect(costGpt).toBeCloseTo(1.25, 4);
    });
  });

  describe("estimateLatencySaved", () => {
    it("latency 与 cacheHitTokens 成正比（每 1k token 50ms）", () => {
      tracer.record(makeEntry({ cacheHitTokens: 1000 }));
      const all = tracer.query({});
      expect(all[0].estimatedLatencySavedMs).toBe(50);
    });

    it("cacheHitTokens=0 时 latencySaved=0", () => {
      tracer.record(makeEntry({ cacheHitTokens: 0 }));
      const all = tracer.query({});
      expect(all[0].estimatedLatencySavedMs).toBe(0);
    });
  });
});
