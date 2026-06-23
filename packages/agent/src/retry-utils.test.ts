import { describe, it, expect, beforeEach } from "vitest";
import {
  jitteredBackoff,
  _resetJitterCounterForTests,
  applyJitter,
  computeBackoff,
  sleepWithAbort,
  retryAsync,
  isRetryableError,
  parseRetryAfterMs,
  type BackoffPolicy,
} from "./retry-utils";

// ═══════════════════════════════════════════════════════════
// 测试套件：retry-utils（重试工具）
// ═══════════════════════════════════════════════════════════

describe("retry-utils > jitteredBackoff", () => {
  beforeEach(() => {
    _resetJitterCounterForTests();
  });

  it("第一次重试基础延迟约等于 baseDelay", () => {
    const delay = jitteredBackoff(1, 5000, 120000, 0);
    expect(delay).toBe(5000);
  });

  it("延迟随重试次数指数增长", () => {
    const d1 = jitteredBackoff(1, 5000, 120000, 0);
    const d2 = jitteredBackoff(2, 5000, 120000, 0);
    const d3 = jitteredBackoff(3, 5000, 120000, 0);
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
  });

  it("延迟不超过 maxDelayMs", () => {
    const delay = jitteredBackoff(20, 5000, 30000, 0.5);
    expect(delay).toBeLessThanOrEqual(30000 + 30000 * 0.5 + 1);
  });

  it("jitter 使并发调用产生不同延迟（去相关）", () => {
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) {
      delays.add(jitteredBackoff(3, 5000, 120000, 0.5));
    }
    // 20 次调用应产生至少 15 个不同的值（允许少量碰撞）
    expect(delays.size).toBeGreaterThanOrEqual(15);
  });

  it("exponent >= 63 时返回 maxDelayMs", () => {
    const delay = jitteredBackoff(65, 5000, 30000, 0.5);
    expect(delay).toBeGreaterThanOrEqual(30000);
  });

  it("baseDelayMs <= 0 时返回 maxDelayMs", () => {
    const delay = jitteredBackoff(3, 0, 30000, 0.5);
    expect(delay).toBeGreaterThanOrEqual(30000);
  });

  it("jitterRatio=0 时延迟等于基础值", () => {
    const delay = jitteredBackoff(3, 5000, 120000, 0);
    expect(delay).toBe(20000); // 5000 * 2^2 = 20000
  });
});

describe("retry-utils > applyJitter", () => {
  it("jitter=0 时返回原值", () => {
    expect(applyJitter(1000, 0)).toBe(1000);
  });

  it("symmetric 模式延迟在 [delay*(1-j), delay*(1+j)] 范围内", () => {
    for (let i = 0; i < 100; i++) {
      const result = applyJitter(1000, 0.3, "symmetric");
      expect(result).toBeGreaterThanOrEqual(700);
      expect(result).toBeLessThanOrEqual(1300);
    }
  });

  it("positive 模式延迟 >= delay", () => {
    for (let i = 0; i < 100; i++) {
      const result = applyJitter(1000, 0.3, "positive");
      expect(result).toBeGreaterThanOrEqual(1000);
      expect(result).toBeLessThanOrEqual(1300);
    }
  });
});

describe("retry-utils > computeBackoff", () => {
  it("计算有界指数退避", () => {
    const policy: BackoffPolicy = {
      initialMs: 300,
      maxMs: 30000,
      factor: 2,
      jitter: 0,
    };
    expect(computeBackoff(policy, 1)).toBe(300);
    expect(computeBackoff(policy, 2)).toBe(600);
    expect(computeBackoff(policy, 3)).toBe(1200);
  });

  it("延迟不超过 maxMs", () => {
    const policy: BackoffPolicy = {
      initialMs: 300,
      maxMs: 1000,
      factor: 2,
      jitter: 0,
    };
    expect(computeBackoff(policy, 10)).toBe(1000);
  });
});

describe("retry-utils > sleepWithAbort", () => {
  it("正常 sleep 后 resolve", async () => {
    const start = Date.now();
    await sleepWithAbort(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("AbortSignal 触发时立即 reject", async () => {
    const controller = new AbortController();
    const promise = sleepWithAbort(5000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toThrow("aborted");
  });

  it("已 aborted 的信号立即 reject", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepWithAbort(5000, controller.signal)).rejects.toThrow("aborted");
  });

  it("delay=0 立即 resolve", async () => {
    await expect(sleepWithAbort(0)).resolves.toBeUndefined();
  });
});

describe("retry-utils > retryAsync", () => {
  it("成功时返回结果", async () => {
    const result = await retryAsync(() => Promise.resolve(42), 3);
    expect(result).toBe(42);
  });

  it("重试后成功", async () => {
    let attempts = 0;
    const result = await retryAsync(
      () => {
        attempts++;
        if (attempts < 3) throw new Error("fail");
        return Promise.resolve("success");
      },
      { attempts: 5, minDelayMs: 1, maxDelayMs: 10 },
    );
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("重试次数耗尽后抛出最后错误", async () => {
    let attempts = 0;
    await expect(
      retryAsync(
        () => {
          attempts++;
          throw new Error(`fail ${attempts}`);
        },
        { attempts: 3, minDelayMs: 1, maxDelayMs: 5 },
      ),
    ).rejects.toThrow("fail 3");
    expect(attempts).toBe(3);
  });

  it("shouldRetry=false 时不重试", async () => {
    let attempts = 0;
    await expect(
      retryAsync(
        () => {
          attempts++;
          throw new Error("permanent");
        },
        {
          attempts: 5,
          minDelayMs: 1,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow("permanent");
    expect(attempts).toBe(1);
  });

  it("AbortSignal 触发时停止重试", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const promise = retryAsync(
      () => {
        attempts++;
        throw new Error("fail");
      },
      {
        attempts: 10,
        minDelayMs: 100,
        maxDelayMs: 1000,
        abortSignal: controller.signal,
      },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow();
    expect(attempts).toBeLessThan(10);
  });

  it("onRetry 回调被调用", async () => {
    let retryCount = 0;
    await expect(
      retryAsync(
        () => {
          throw new Error("fail");
        },
        {
          attempts: 3,
          minDelayMs: 1,
          onRetry: () => retryCount++,
        },
      ),
    ).rejects.toThrow();
    expect(retryCount).toBe(2); // 3 次尝试，2 次重试
  });
});

describe("retry-utils > isRetryableError", () => {
  it("网络错误可重试", () => {
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
  });

  it("超时错误可重试", () => {
    expect(isRetryableError(new Error("timeout"))).toBe(true);
    expect(isRetryableError(new Error("timed out"))).toBe(true);
  });

  it("5xx 服务器错误可重试", () => {
    expect(isRetryableError(new Error("500 Internal Server Error"))).toBe(true);
    expect(isRetryableError(new Error("502 Bad Gateway"))).toBe(true);
    expect(isRetryableError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isRetryableError(new Error("504 Gateway Timeout"))).toBe(true);
  });

  it("aborted 错误不可重试", () => {
    expect(isRetryableError(new Error("aborted"))).toBe(false);
  });

  it("普通错误不可重试", () => {
    expect(isRetryableError(new Error("invalid input"))).toBe(false);
    expect(isRetryableError(new Error("not found"))).toBe(false);
  });
});

describe("retry-utils > parseRetryAfterMs", () => {
  it("解析 'retry after N' 格式", () => {
    expect(parseRetryAfterMs(new Error("retry after 30 seconds"))).toBe(30000);
    expect(parseRetryAfterMs(new Error("retry-after: 60"))).toBe(60000);
  });

  it("无 Retry-After 返回 undefined", () => {
    expect(parseRetryAfterMs(new Error("rate limit exceeded"))).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });
});
