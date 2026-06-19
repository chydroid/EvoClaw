import { describe, it, expect } from "vitest";
import {
  applyJitter,
  computeBackoff,
  sleepWithAbort,
  retryAsync,
  isRetryableError,
  parseRetryAfterMs,
  type BackoffPolicy,
} from "./retry-utils";

// ═══════════════════════════════════════════════════════════
// 测试套件 1: retry-utils（双jitter重试+可中断sleep）
// 覆盖：基础功能验证、边界条件、异常输入
// ═══════════════════════════════════════════════════════════

describe("retry-utils > applyJitter", () => {
  // TC-001: symmetric 模式基础功能
  it("TC-001: symmetric jitter 产生 [delay*(1-j), delay*(1+j)] 范围内的值", () => {
    const delay = 1000;
    const jitter = 0.3;
    for (let i = 0; i < 100; i++) {
      const result = applyJitter(delay, jitter, "symmetric");
      expect(result).toBeGreaterThanOrEqual(Math.round(delay * (1 - jitter)));
      expect(result).toBeLessThanOrEqual(Math.round(delay * (1 + jitter)));
    }
  });

  // TC-002: positive 模式保证不低于下限
  it("TC-002: positive jitter 保证结果 >= delay（Retry-After 契约）", () => {
    const delay = 5000;
    const jitter = 0.3;
    for (let i = 0; i < 100; i++) {
      const result = applyJitter(delay, jitter, "positive");
      expect(result).toBeGreaterThanOrEqual(delay);
    }
  });

  // TC-003: jitter=0 时返回原值
  it("TC-003: jitter=0 时返回原始 delay", () => {
    expect(applyJitter(1000, 0, "symmetric")).toBe(1000);
    expect(applyJitter(1000, 0, "positive")).toBe(1000);
  });

  // TC-004: 边界条件 - delay=0
  it("TC-004: delay=0 时返回 0", () => {
    expect(applyJitter(0, 0.3, "symmetric")).toBe(0);
    expect(applyJitter(0, 0.3, "positive")).toBe(0);
  });
});

describe("retry-utils > computeBackoff", () => {
  // TC-005: 指数退避计算
  it("TC-005: 指数退避随 attempt 增长", () => {
    const policy: BackoffPolicy = { initialMs: 100, maxMs: 10000, factor: 2, jitter: 0 };
    expect(computeBackoff(policy, 1)).toBe(100);
    expect(computeBackoff(policy, 2)).toBe(200);
    expect(computeBackoff(policy, 3)).toBe(400);
    expect(computeBackoff(policy, 4)).toBe(800);
  });

  // TC-006: 上限约束
  it("TC-006: 退避不超过 maxMs", () => {
    const policy: BackoffPolicy = { initialMs: 100, maxMs: 500, factor: 2, jitter: 0 };
    expect(computeBackoff(policy, 10)).toBeLessThanOrEqual(500);
  });
});

describe("retry-utils > sleepWithAbort", () => {
  // TC-007: 正常 sleep 完成
  it("TC-007: 正常 sleep 后 resolve", async () => {
    const start = Date.now();
    await sleepWithAbort(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  // TC-008: AbortSignal 中断
  it("TC-008: AbortSignal 触发后立即 reject", async () => {
    const controller = new AbortController();
    const promise = sleepWithAbort(5000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toThrow("aborted");
  });

  // TC-009: 已 abort 的信号立即 reject
  it("TC-009: 已 abort 的信号立即 reject", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepWithAbort(1000, controller.signal)).rejects.toThrow("aborted");
  });

  // TC-010: delay=0 立即 resolve
  it("TC-010: delay=0 立即 resolve", async () => {
    await expect(sleepWithAbort(0)).resolves.toBeUndefined();
  });
});

describe("retry-utils > retryAsync", () => {
  // TC-011: 首次成功不重试
  it("TC-011: 首次成功时不重试", async () => {
    let calls = 0;
    const result = await retryAsync(async () => {
      calls++;
      return "ok";
    }, 3);
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  // TC-012: 重试后成功
  it("TC-012: 失败后重试成功", async () => {
    let calls = 0;
    const result = await retryAsync(async () => {
      calls++;
      if (calls < 3) throw new Error("fail");
      return "ok";
    }, 5);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  // TC-013: 重试次数耗尽抛出最后一个错误
  it("TC-013: 重试耗尽后抛出错误", async () => {
    let calls = 0;
    await expect(
      retryAsync(async () => {
        calls++;
        throw new Error(`fail-${calls}`);
      }, 3),
    ).rejects.toThrow("fail-3");
    expect(calls).toBe(3);
  });

  // TC-014: shouldRetry 控制是否重试
  it("TC-014: shouldRetry 返回 false 时不重试", async () => {
    let calls = 0;
    await expect(
      retryAsync(
        async () => {
          calls++;
          throw new Error("permanent");
        },
        {
          attempts: 5,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow("permanent");
    expect(calls).toBe(1);
  });

  // TC-015: onRetry 回调被调用
  it("TC-015: onRetry 回调在重试时被调用", async () => {
    const retryInfos: number[] = [];
    let calls = 0;
    await retryAsync(
      async () => {
        calls++;
        if (calls < 3) throw new Error("fail");
        return "ok";
      },
      {
        attempts: 5,
        minDelayMs: 1,
        onRetry: (info) => retryInfos.push(info.attempt),
      },
    );
    expect(retryInfos).toEqual([1, 2]);
  });

  // TC-016: AbortSignal 中断重试
  it("TC-016: AbortSignal 中断重试循环", async () => {
    const controller = new AbortController();
    let calls = 0;
    setTimeout(() => controller.abort(), 10);
    await expect(
      retryAsync(
        async () => {
          calls++;
          throw new Error("fail");
        },
        {
          attempts: 10,
          minDelayMs: 100,
          abortSignal: controller.signal,
        },
      ),
    ).rejects.toThrow("aborted");
  });

  // TC-017: Retry-After 契约 - positive jitter
  it("TC-017: Retry-After 使用 positive jitter 保证不低于下限", async () => {
    let calls = 0;
    const delays: number[] = [];
    await retryAsync(
      async () => {
        calls++;
        if (calls < 2) {
          throw new Error("retry after 100");
        }
        return "ok";
      },
      {
        attempts: 3,
        minDelayMs: 10,
        maxDelayMs: 5000,
        jitter: 0.3,
        retryAfterMs: (err) => {
          const m = err instanceof Error ? err.message.match(/retry after (\d+)/) : null;
          return m ? parseInt(m[1], 10) : undefined;
        },
        onRetry: (info) => delays.push(info.delayMs),
      },
    );
    // Retry-After=100ms，positive jitter 保证 >= 100
    expect(delays.length).toBeGreaterThan(0);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
  });
});

describe("retry-utils > isRetryableError", () => {
  // TC-018: 网络错误可重试
  it("TC-018: ECONNRESET 错误可重试", () => {
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true);
  });

  // TC-019: 超时错误可重试
  it("TC-019: timeout 错误可重试", () => {
    expect(isRetryableError(new Error("request timeout"))).toBe(true);
  });

  // TC-020: abort 错误不可重试
  it("TC-020: aborted 错误不可重试", () => {
    expect(isRetryableError(new Error("aborted"))).toBe(false);
  });

  // TC-021: 普通错误不可重试
  it("TC-021: 普通错误不可重试", () => {
    expect(isRetryableError(new Error("something went wrong"))).toBe(false);
  });
});

describe("retry-utils > parseRetryAfterMs", () => {
  // TC-022: 解析 retry-after 秒数
  it("TC-022: 解析 'retry after 30' 为 30000ms", () => {
    expect(parseRetryAfterMs(new Error("retry after 30"))).toBe(30000);
  });

  // TC-023: 无匹配返回 undefined
  it("TC-023: 无 retry-after 信息返回 undefined", () => {
    expect(parseRetryAfterMs(new Error("some error"))).toBeUndefined();
  });
});
