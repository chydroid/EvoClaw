import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CrossSessionRateGuard, parseResetSeconds } from "./cross-session-rate-guard";

/**
 * 回归：守卫真正接入 LLM 调用路径后，只有「配额耗尽」才允许跳过请求。
 * 瞬时 429（Retry-After 几秒）必须放行，交给重试/退避阶梯处理，
 * 否则一次瞬时限流会让该 provider 被错误跳过整个冷却窗口。
 */
describe("CrossSessionRateGuard", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-guard-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function makeGuard(): CrossSessionRateGuard {
    return new CrossSessionRateGuard({ stateDir, minResetForBreakerSeconds: 60 });
  }

  it("瞬时 429（短 Retry-After）不拦截请求", () => {
    const guard = makeGuard();
    const state = guard.recordRateLimit("prov", 429, { "retry-after": "5" });

    expect(state.isGenuine).toBe(false);
    expect(guard.shouldSkipRequest("prov")).toBe(false);

    const stats = guard.getStats();
    expect(stats.transientLimits).toBe(1);
    expect(stats.genuineRateLimits).toBe(0);
    expect(stats.skippedRequests).toBe(0);
  });

  it("配额耗尽（长 Retry-After）拦截请求并计统计", () => {
    const guard = makeGuard();
    const state = guard.recordRateLimit("prov", 429, { "retry-after": "3600" });

    expect(state.isGenuine).toBe(true);
    expect(guard.shouldSkipRequest("prov")).toBe(true);
    expect(guard.getRemainingCooldown("prov")).toBeGreaterThan(0);

    const stats = guard.getStats();
    expect(stats.checks).toBe(1);
    expect(stats.skippedRequests).toBe(1);
    expect(stats.genuineRateLimits).toBe(1);
    expect(stats.activeProviders).toBe(1);
    expect(stats.activeCooldowns[0]?.provider).toBe("prov");
    expect(stats.activeCooldowns[0]?.isGenuine).toBe(true);
  });

  it("非 429 状态码不视为配额耗尽", () => {
    const guard = makeGuard();
    const state = guard.recordRateLimit("prov", 503, { "retry-after": "3600" });
    expect(state.isGenuine).toBe(false);
    expect(guard.shouldSkipRequest("prov")).toBe(false);
  });

  it("clearRateLimit 后恢复放行", () => {
    const guard = makeGuard();
    guard.recordRateLimit("prov", 429, { "retry-after": "3600" });
    expect(guard.shouldSkipRequest("prov")).toBe(true);

    guard.clearRateLimit("prov");
    expect(guard.shouldSkipRequest("prov")).toBe(false);
  });

  it("跨实例共享状态（跨会话/跨进程）", () => {
    const first = makeGuard();
    first.recordRateLimit("prov", 429, { "retry-after": "3600" });

    const second = makeGuard();
    expect(second.shouldSkipRequest("prov")).toBe(true);
  });

  it("parseResetSeconds 优先级：1h > requests > retry-after", () => {
    expect(
      parseResetSeconds({
        "x-ratelimit-reset-requests-1h": "2h",
        "x-ratelimit-reset-requests": "5m",
        "retry-after": "30",
      }),
    ).toBe(7200);
    expect(
      parseResetSeconds({
        "x-ratelimit-reset-requests": "90s",
        "retry-after": "30",
      }),
    ).toBe(90);
    expect(parseResetSeconds({ "retry-after": "30" })).toBe(30);
  });
});
