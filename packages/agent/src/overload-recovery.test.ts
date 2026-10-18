import { describe, it, expect } from "vitest";
import {
  isOverloadLadderEligible,
  computeOverloadWait,
  OVERLOAD_RECOVERY_MAX,
  type LadderErrorInfo,
} from "./overload-recovery";

function info(overrides: Partial<LadderErrorInfo>): LadderErrorInfo {
  return {
    type: "rate_limit",
    retryable: true,
    backoffMs: 5000,
    ...overrides,
  };
}

describe("isOverloadLadderEligible", () => {
  it("瞬时限流（retryable + rate_limit）→ 有资格", () => {
    expect(isOverloadLadderEligible(info({ type: "rate_limit" }), 0)).toBe(true);
  });

  it("5xx 瞬时服务端错误（provider_error + isTransient）→ 有资格", () => {
    expect(isOverloadLadderEligible(info({ type: "provider_error", isTransient: true }), 0)).toBe(true);
  });

  it("超时（timeout）→ 有资格", () => {
    expect(isOverloadLadderEligible(info({ type: "timeout" }), 0)).toBe(true);
  });

  it("非白名单类型（auth/content_policy/ssl_cert）→ 无资格", () => {
    expect(isOverloadLadderEligible(info({ type: "auth", retryable: false, isTransient: false }), 0)).toBe(false);
    expect(isOverloadLadderEligible(info({ type: "content_policy", retryable: false, isTransient: false }), 0)).toBe(false);
  });

  it("显式 non-transient（5xx 请求验证错误）→ 无资格", () => {
    expect(isOverloadLadderEligible(info({ type: "provider_error", retryable: false, isTransient: false }), 0)).toBe(false);
  });

  it("retryable=false 一律无资格", () => {
    expect(isOverloadLadderEligible(info({ type: "rate_limit", retryable: false }), 0)).toBe(false);
  });

  it("超过最大周期数 → 无资格", () => {
    expect(isOverloadLadderEligible(info({ type: "rate_limit" }), OVERLOAD_RECOVERY_MAX)).toBe(false);
  });

  it("isTransient 缺省（未判定）不阻断（由 retryable + 白名单兜底）", () => {
    expect(isOverloadLadderEligible(info({ type: "network" }), 0)).toBe(true);
  });
});

describe("computeOverloadWait", () => {
  it("无契约时：jittered backoff 落在 [15s, 90s] 内（15s 基数 ×2 + 0.5 jitter）", () => {
    const waits = Array.from({ length: 50 }, (_, i) => computeOverloadWait(i + 1, info({ type: "rate_limit" })));
    for (const w of waits) {
      expect(w).toBeGreaterThanOrEqual(15_000);
      // 基数 min(15s*2^(n-1), 60s) + jitter ≤ 0.5*基数
      expect(w).toBeLessThanOrEqual(90_000 + 1);
    }
    // 随周期单调不下降（指数退避，jitter 不破坏下限）
    for (let i = 1; i < waits.length; i++) {
      expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1] * 0.5);
    }
  });

  it("有 Retry-After 契约时：尊重契约值（不超过 120s 上限）", () => {
    const w = computeOverloadWait(1, info({ type: "rate_limit", hasRetryAfterContract: true, backoffMs: 30_000 }));
    expect(w).toBe(30_000);
  });

  it("契约值超上限时封顶 120s", () => {
    const w = computeOverloadWait(1, info({ type: "rate_limit", hasRetryAfterContract: true, backoffMs: 300_000 }));
    expect(w).toBe(120_000);
  });

  it("契约值为 0/负 → 不等待（0s）", () => {
    expect(computeOverloadWait(1, info({ type: "rate_limit", hasRetryAfterContract: true, backoffMs: 0 }))).toBe(0);
  });
});
