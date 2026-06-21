import { describe, it, expect, beforeEach } from "vitest";
import { RateLimitTracker } from "./rate-limit-tracker";

describe("RateLimitTracker", () => {
  let tracker: RateLimitTracker;

  beforeEach(() => {
    tracker = new RateLimitTracker();
  });

  it("应解析 x-ratelimit-* header", () => {
    const now = 1000000;
    tracker.update("openai", {
      "x-ratelimit-limit-requests-min": "60",
      "x-ratelimit-remaining-requests-min": "30",
      "x-ratelimit-reset-requests-min": "30",
      "x-ratelimit-limit-requests-hour": "3600",
      "x-ratelimit-remaining-requests-hour": "1800",
      "x-ratelimit-reset-requests-hour": "1800",
      "x-ratelimit-limit-tokens-min": "90000",
      "x-ratelimit-remaining-tokens-min": "45000",
      "x-ratelimit-reset-tokens-min": "30",
      "x-ratelimit-limit-tokens-hour": "5400000",
      "x-ratelimit-remaining-tokens-hour": "2700000",
      "x-ratelimit-reset-tokens-hour": "1800",
    }, now);

    const state = tracker.get("openai");
    expect(state).not.toBeNull();
    expect(state!.requestsMin.limit).toBe(60);
    expect(state!.requestsMin.remaining).toBe(30);
    expect(state!.requestsMin.resetSeconds).toBe(30);
    expect(state!.requestsHour.limit).toBe(3600);
    expect(state!.tokensMin.limit).toBe(90000);
    expect(state!.tokensHour.limit).toBe(5400000);
  });

  it("应支持简写形式（不带 -min/-hour 后缀）", () => {
    tracker.update("simple", {
      "x-ratelimit-limit": "100",
      "x-ratelimit-remaining": "50",
      "x-ratelimit-reset": "60",
    });

    const state = tracker.get("simple");
    expect(state!.requestsMin.limit).toBe(100);
    expect(state!.requestsMin.remaining).toBe(50);
  });

  it("header 大小写不敏感", () => {
    tracker.update("test", {
      "X-RateLimit-Limit-Requests-Min": "60",
      "X-RateLimit-Remaining-Requests-Min": "0",
      "X-RateLimit-Reset-Requests-Min": "30",
    });

    const state = tracker.get("test");
    expect(state!.requestsMin.limit).toBe(60);
    expect(state!.requestsMin.remaining).toBe(0);
  });

  it("isNearLimit 在 remaining <= 0 时返回 true", () => {
    tracker.update("openai", {
      "x-ratelimit-limit-requests-min": "60",
      "x-ratelimit-remaining-requests-min": "0",
      "x-ratelimit-reset-requests-min": "30",
    });

    expect(tracker.isNearLimit("openai")).toBe(true);
  });

  it("isNearLimit 在 remaining/limit < 0.1 时返回 true", () => {
    tracker.update("openai", {
      "x-ratelimit-limit-requests-min": "100",
      "x-ratelimit-remaining-requests-min": "5",
      "x-ratelimit-reset-requests-min": "30",
    });

    expect(tracker.isNearLimit("openai")).toBe(true);
  });

  it("isNearLimit 在剩余充足时返回 false", () => {
    tracker.update("openai", {
      "x-ratelimit-limit-requests-min": "100",
      "x-ratelimit-remaining-requests-min": "80",
      "x-ratelimit-reset-requests-min": "30",
    });

    expect(tracker.isNearLimit("openai")).toBe(false);
  });

  it("isNearLimit 在无数据时返回 false", () => {
    expect(tracker.isNearLimit("unknown")).toBe(false);
  });

  it("waitForResetMs 应计算正确的等待时间", () => {
    const now = 1000000;
    tracker.update("openai", {
      "x-ratelimit-limit-requests-min": "60",
      "x-ratelimit-remaining-requests-min": "0",
      "x-ratelimit-reset-requests-min": "30",
    }, now);

    // 30 秒重置，已过 10 秒 → 还需等 20 秒
    const wait = tracker.waitForResetMs("openai", now + 10_000);
    expect(wait).toBe(20_000);
  });

  it("waitForResetMs 在无数据时返回 Infinity", () => {
    expect(tracker.waitForResetMs("unknown")).toBe(Infinity);
  });

  it("waitForResetMs 在 remaining > 0 时返回 0", () => {
    tracker.update("openai", {
      "x-ratelimit-limit-requests-min": "60",
      "x-ratelimit-remaining-requests-min": "30",
      "x-ratelimit-reset-requests-min": "30",
    });

    expect(tracker.waitForResetMs("openai")).toBe(0);
  });

  it("clear 应移除指定 provider 的状态", () => {
    tracker.update("openai", { "x-ratelimit-limit": "100" });
    tracker.clear("openai");
    expect(tracker.get("openai")).toBeNull();
  });

  it("clearAll 应移除所有状态", () => {
    tracker.update("openai", { "x-ratelimit-limit": "100" });
    tracker.update("anthropic", { "x-ratelimit-limit": "50" });
    tracker.clearAll();
    expect(tracker.get("openai")).toBeNull();
    expect(tracker.get("anthropic")).toBeNull();
  });
});
