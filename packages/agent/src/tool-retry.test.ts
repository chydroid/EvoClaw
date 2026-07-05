import { describe, it, expect, vi } from "vitest";
import {
  withRetry,
  createRetryExecutor,
  defaultIsRetryable,
  computeBackoff,
} from "./tool-retry";

// ═══════════════════════════════════════════════════════════
// 测试套件：tool-retry（工具重试与指数退避）
// ═══════════════════════════════════════════════════════════

describe("defaultIsRetryable", () => {
  it("网络层 TypeError(fetch) 可重试", () => {
    const err = new TypeError("fetch failed");
    expect(defaultIsRetryable(err)).toBe(true);
  });

  it("ECONNRESET 可重试", () => {
    const err = new Error("reset") as NodeJS.ErrnoException;
    err.code = "ECONNRESET";
    expect(defaultIsRetryable(err)).toBe(true);
  });

  it("ETIMEDOUT 可重试", () => {
    const err = new Error("timeout") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    expect(defaultIsRetryable(err)).toBe(true);
  });

  it("HTTP 429 错误消息可重试", () => {
    const err = new Error("HTTP 429 Too Many Requests");
    expect(defaultIsRetryable(err)).toBe(true);
  });

  it("HTTP 503 错误消息可重试", () => {
    const err = new Error("HTTP 503 Service Unavailable");
    expect(defaultIsRetryable(err)).toBe(true);
  });

  it("rate limit 关键词可重试", () => {
    expect(defaultIsRetryable(new Error("rate limit exceeded"))).toBe(true);
    expect(defaultIsRetryable(new Error("too many requests"))).toBe(true);
    expect(defaultIsRetryable(new Error("quota exceeded"))).toBe(true);
  });

  it("HTTP 4xx（非 429）不可重试", () => {
    const err = new Error("HTTP 404 Not Found");
    expect(defaultIsRetryable(err)).toBe(false);
  });

  it("普通 Error 不可重试", () => {
    expect(defaultIsRetryable(new Error("something went wrong"))).toBe(false);
  });

  it("字符串错误可重试", () => {
    expect(defaultIsRetryable("rate limit hit")).toBe(true);
    expect(defaultIsRetryable("ECONNRESET")).toBe(true);
    expect(defaultIsRetryable("HTTP 500 error")).toBe(true);
  });

  it("字符串错误不可重试", () => {
    expect(defaultIsRetryable("invalid argument")).toBe(false);
  });
});

describe("computeBackoff", () => {
  const opts = {
    maxRetries: 3,
    initialBackoffMs: 100,
    backoffMultiplier: 2,
    maxBackoffMs: 10_000,
    jitterRatio: 0,
  };

  it("指数增长", () => {
    expect(computeBackoff(0, opts)).toBe(100);
    expect(computeBackoff(1, opts)).toBe(200);
    expect(computeBackoff(2, opts)).toBe(400);
    expect(computeBackoff(3, opts)).toBe(800);
  });

  it("不超过 maxBackoffMs", () => {
    expect(computeBackoff(20, opts)).toBeLessThanOrEqual(10_000);
  });

  it("抖动在 ±jitterRatio 范围内", () => {
    const jitterOpts = { ...opts, jitterRatio: 0.5 };
    for (let i = 0; i < 20; i++) {
      const base = Math.min(100 * Math.pow(2, i), 10_000);
      const delay = computeBackoff(i, jitterOpts);
      expect(delay).toBeGreaterThanOrEqual(Math.max(0, base * 0.5));
      expect(delay).toBeLessThanOrEqual(base * 1.5);
    }
  });
});

describe("withRetry", () => {
  it("首次成功不重试", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, initialBackoffMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("重试到成功", async () => {
    let count = 0;
    const fn = vi.fn().mockImplementation(async () => {
      count++;
      if (count < 3) {
        const err = new Error("HTTP 503") as NodeJS.ErrnoException;
        err.code = "ECONNRESET";
        throw err;
      }
      return "ok";
    });
    const result = await withRetry(fn, {
      maxRetries: 3,
      initialBackoffMs: 1,
      backoffMultiplier: 1,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("不可重试错误立即抛出", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("HTTP 404 Not Found"));
    await expect(
      withRetry(fn, { maxRetries: 3, initialBackoffMs: 1 })
    ).rejects.toThrow("HTTP 404 Not Found");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("重试耗尽后抛出最后一次错误", async () => {
    const err = new Error("HTTP 503") as NodeJS.ErrnoException;
    err.code = "ECONNRESET";
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, { maxRetries: 2, initialBackoffMs: 1, backoffMultiplier: 1 })
    ).rejects.toThrow("HTTP 503");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("onRetry 回调被调用", async () => {
    const onRetry = vi.fn();
    let count = 0;
    const fn = vi.fn().mockImplementation(async () => {
      count++;
      if (count < 3) {
        const err = new Error("HTTP 503") as NodeJS.ErrnoException;
        err.code = "ECONNRESET";
        throw err;
      }
      return "ok";
    });
    await withRetry(fn, {
      maxRetries: 3,
      initialBackoffMs: 1,
      backoffMultiplier: 1,
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toHaveProperty("attempt", 1);
    expect(onRetry.mock.calls[1][0]).toHaveProperty("attempt", 2);
  });

  it("自定义 isRetryable 决定是否重试", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("custom"));
    await expect(
      withRetry(fn, {
        maxRetries: 3,
        initialBackoffMs: 1,
        isRetryable: () => false,
      })
    ).rejects.toThrow("custom");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("createRetryExecutor", () => {
  it("使用默认配置", async () => {
    const exec = createRetryExecutor({
      maxRetries: 2,
      initialBackoffMs: 1,
      backoffMultiplier: 1,
    });
    let count = 0;
    const result = await exec(async () => {
      count++;
      if (count < 2) {
        const err = new Error("HTTP 503") as NodeJS.ErrnoException;
        err.code = "ECONNRESET";
        throw err;
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(count).toBe(2);
  });

  it("override 配置覆盖默认", async () => {
    const exec = createRetryExecutor({
      maxRetries: 0,
      initialBackoffMs: 1,
    });
    let count = 0;
    const result = await exec(
      async () => {
        count++;
        if (count < 3) {
          const err = new Error("HTTP 503") as NodeJS.ErrnoException;
          err.code = "ECONNRESET";
          throw err;
        }
        return "ok";
      },
      { maxRetries: 3, initialBackoffMs: 1, backoffMultiplier: 1 }
    );
    expect(result).toBe("ok");
    expect(count).toBe(3);
  });
});
