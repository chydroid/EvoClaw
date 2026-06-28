import { describe, it, expect, beforeEach } from "vitest";
import {
  PromptCacheStabilityManager,
  estimateTokens,
  type PromptCacheKey,
} from "./prompt-cache-stability";

describe("PromptCacheStabilityManager", () => {
  let mgr: PromptCacheStabilityManager;

  beforeEach(() => {
    mgr = new PromptCacheStabilityManager();
  });

  const makeKey = (
    overrides: Partial<PromptCacheKey> = {},
  ): PromptCacheKey => ({
    provider: "openai",
    systemPrompt: "You are a helpful assistant.",
    tools: [{ name: "tool1" }],
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ],
    model: "gpt-4o",
    ...overrides,
  });

  it("首次评估 isStable=false（无历史）", () => {
    const result = mgr.evaluate(makeKey());
    expect(result.isStable).toBe(false);
    expect(result.brokenAt).toBe(0);
    expect(result.brokenReason).toContain("首次");
    expect(result.estimatedCacheMissTokens).toBeGreaterThan(0);
    expect(result.estimatedCacheHitTokens).toBe(0);
    expect(result.currentCacheKeyHash).toBeDefined();
  });

  it("相同 key 第二次评估 isStable=true", () => {
    const key = makeKey();
    mgr.evaluate(key);
    const result = mgr.evaluate(key);
    expect(result.isStable).toBe(true);
    expect(result.stablePrefixLength).toBe(2);
    expect(result.estimatedCacheHitTokens).toBeGreaterThan(0);
    expect(result.estimatedCacheMissTokens).toBe(0);
    expect(result.previousCacheKeyHash).toBe(result.currentCacheKeyHash);
  });

  it("systemPrompt 变化时 brokenAt=0", () => {
    mgr.evaluate(makeKey({ systemPrompt: "old prompt" }));
    const result = mgr.evaluate(makeKey({ systemPrompt: "new prompt" }));
    expect(result.isStable).toBe(false);
    expect(result.brokenAt).toBe(0);
    expect(result.brokenReason).toContain("systemPrompt");
  });

  it("tools 变化时 brokenAt=0", () => {
    mgr.evaluate(makeKey({ tools: [{ name: "a" }] }));
    const result = mgr.evaluate(makeKey({ tools: [{ name: "b" }] }));
    expect(result.isStable).toBe(false);
    expect(result.brokenAt).toBe(0);
    expect(result.brokenReason).toContain("tools");
  });

  it("tools 顺序不同但内容相同不破坏 cache（应用 stableStringify）", () => {
    const tools1 = [
      { name: "a", params: { x: 1 } },
      { name: "b", params: { y: 2 } },
    ];
    const tools2 = [
      { name: "b", params: { y: 2 } },
      { name: "a", params: { x: 1 } },
    ];
    mgr.evaluate(makeKey({ tools: tools1 }));
    const result = mgr.evaluate(makeKey({ tools: tools2 }));
    expect(result.isStable).toBe(true);
  });

  it("messages 第 N 条变化时 brokenAt=N", () => {
    mgr.evaluate(
      makeKey({
        messages: [
          { role: "user", content: "msg1" },
          { role: "assistant", content: "msg2" },
          { role: "user", content: "msg3" },
        ],
      }),
    );
    const result = mgr.evaluate(
      makeKey({
        messages: [
          { role: "user", content: "msg1" },
          { role: "assistant", content: "msg2" },
          { role: "user", content: "CHANGED" },
        ],
      }),
    );
    expect(result.isStable).toBe(false);
    expect(result.brokenAt).toBe(2);
    expect(result.brokenReason).toContain("第 2 条");
  });

  it("messages 仅追加（前缀一致）→ stablePrefixLength 等于上次长度", () => {
    mgr.evaluate(
      makeKey({
        messages: [
          { role: "user", content: "msg1" },
          { role: "assistant", content: "msg2" },
        ],
      }),
    );
    const result = mgr.evaluate(
      makeKey({
        messages: [
          { role: "user", content: "msg1" },
          { role: "assistant", content: "msg2" },
          { role: "user", content: "msg3" },
        ],
      }),
    );
    expect(result.stablePrefixLength).toBe(2);
    expect(result.estimatedCacheHitTokens).toBeGreaterThan(0);
    expect(result.estimatedCacheMissTokens).toBeGreaterThan(0);
  });

  it("stablePrefixLength 受 maxCacheMessages 限制", () => {
    mgr.evaluate(
      makeKey({
        maxCacheMessages: 2,
        messages: [
          { role: "user", content: "msg1" },
          { role: "assistant", content: "msg2" },
        ],
      }),
    );
    const result = mgr.evaluate(
      makeKey({
        maxCacheMessages: 2,
        messages: [
          { role: "user", content: "msg1" },
          { role: "assistant", content: "msg2" },
          { role: "user", content: "msg3" },
          { role: "assistant", content: "msg4" },
        ],
      }),
    );
    expect(result.stablePrefixLength).toBeLessThanOrEqual(2);
  });

  it("provider 变化导致整体失效", () => {
    mgr.evaluate(makeKey({ provider: "openai" }));
    const result = mgr.evaluate(makeKey({ provider: "anthropic" }));
    expect(result.isStable).toBe(false);
    expect(result.brokenAt).toBe(0);
    expect(result.brokenReason).toContain("provider");
  });

  it("model 变化导致整体失效", () => {
    mgr.evaluate(makeKey({ model: "gpt-4o" }));
    const result = mgr.evaluate(makeKey({ model: "gpt-4o-mini" }));
    expect(result.isStable).toBe(false);
    expect(result.brokenAt).toBe(0);
    expect(result.brokenReason).toContain("model");
  });

  it("token 估算与内容长度成正比", () => {
    const small = makeKey({ messages: [{ role: "user", content: "x" }] });
    const big = makeKey({
      messages: [{ role: "user", content: "x".repeat(1000) }],
    });
    const r1 = mgr.evaluate(small);
    mgr.reset();
    const r2 = mgr.evaluate(big);
    expect(r2.estimatedCacheMissTokens!).toBeGreaterThan(
      r1.estimatedCacheMissTokens!,
    );
  });

  it("reset 后下次评估视为首次", () => {
    mgr.evaluate(makeKey());
    mgr.reset();
    const result = mgr.evaluate(makeKey());
    expect(result.isStable).toBe(false);
    expect(result.brokenReason).toContain("首次");
    expect(result.previousCacheKeyHash).toBeUndefined();
  });

  it("getHistory 返回历史记录", () => {
    mgr.evaluate(makeKey());
    mgr.evaluate(makeKey());
    mgr.evaluate(makeKey());
    const history = mgr.getHistory();
    expect(history).toHaveLength(3);
    // 第一次 unstable，后续两次 stable
    expect(history[0].isStable).toBe(false);
    expect(history[1].isStable).toBe(true);
    expect(history[2].isStable).toBe(true);
  });

  it("getHistory 支持限制返回数量", () => {
    for (let i = 0; i < 5; i++) {
      mgr.evaluate(makeKey());
    }
    const history = mgr.getHistory(2);
    expect(history).toHaveLength(2);
  });

  it("getHitRate 计算 cache 命中率", () => {
    // 第一次 miss
    mgr.evaluate(makeKey());
    // 后续两次 hit
    mgr.evaluate(makeKey());
    mgr.evaluate(makeKey());
    const rate = mgr.getHitRate();
    expect(rate).toBeCloseTo(2 / 3, 2);
  });

  it("getHitRate 在空历史时返回 0", () => {
    expect(mgr.getHitRate()).toBe(0);
  });

  it("history maxSize 限制（不会无限增长）", () => {
    const small = new PromptCacheStabilityManager({ maxHistorySize: 3 });
    for (let i = 0; i < 10; i++) {
      small.evaluate(makeKey());
    }
    const history = small.getHistory();
    expect(history.length).toBeLessThanOrEqual(3);
  });

  it("detectAntiPatterns 识别 messages 中间位置频繁变化", () => {
    // 在 idx=1 处反复破坏 cache
    for (let i = 0; i < 4; i++) {
      mgr.evaluate(
        makeKey({
          messages: [
            { role: "user", content: "stable" },
            { role: "assistant", content: `change-${i}` },
          ],
        }),
      );
    }
    const patterns = mgr.detectAntiPatterns();
    expect(patterns.length).toBeGreaterThan(0);
    const msgPattern = patterns.find((p) =>
      p.pattern.includes("中间内容"),
    );
    expect(msgPattern).toBeDefined();
    expect(msgPattern!.severity).toBe("error"); // count >= 3
  });

  it("detectAntiPatterns 识别易变字段（含 timestamp 关键字）", () => {
    mgr.evaluate(
      makeKey({
        messages: [
          { role: "user", content: "msg1" },
          { role: "assistant", content: "Timestamp: now" },
        ],
      }),
    );
    mgr.evaluate(
      makeKey({
        messages: [
          { role: "user", content: "msg1" },
          { role: "assistant", content: "Timestamp: changed" },
        ],
      }),
    );
    mgr.evaluate(
      makeKey({
        messages: [
          { role: "user", content: "msg1" },
          { role: "assistant", content: "Timestamp: again" },
        ],
      }),
    );
    const patterns = mgr.detectAntiPatterns();
    // 至少有一个反模式（中间位置变化）+ 可能识别 volatile 模式
    expect(patterns.length).toBeGreaterThan(0);
  });

  it("detectAntiPatterns 在历史不足时返回空", () => {
    expect(mgr.detectAntiPatterns()).toEqual([]);
  });

  it("detectAntiPatterns 识别频繁切换 model", () => {
    // 切换 model 3+ 次以触发反模式
    mgr.evaluate(makeKey({ model: "gpt-4o" }));
    mgr.evaluate(makeKey({ model: "gpt-4o-mini" }));
    mgr.evaluate(makeKey({ model: "gpt-4o" }));
    mgr.evaluate(makeKey({ model: "gpt-4o-mini" }));
    const patterns = mgr.detectAntiPatterns();
    const modelPattern = patterns.find((p) =>
      p.pattern.includes("切换 model"),
    );
    expect(modelPattern).toBeDefined();
  });

  it("diffs 在差异时返回具体差异列表", () => {
    mgr.evaluate(makeKey({ systemPrompt: "old" }));
    const result = mgr.evaluate(makeKey({ systemPrompt: "new" }));
    expect(result.diffs).toBeDefined();
    expect(result.diffs!.length).toBeGreaterThan(0);
  });
});

describe("estimateTokens", () => {
  it("字符串按 4 chars/token 估算", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("ab")).toBe(1); // ceil
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("undefined/null 返回 0", () => {
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens(null)).toBe(0);
  });

  it("对象序列化后估算", () => {
    const tokens = estimateTokens({ a: "1234", b: "5678" });
    expect(tokens).toBeGreaterThan(0);
  });
});
