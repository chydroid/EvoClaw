import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  RetryPolicy,
  isRetryableError,
  RetryPresets,
} from "./retry-policy";
import type { RetryCallbacks } from "./retry-policy";

describe("RetryPolicy", () => {
  describe("isRetryableError", () => {
    it("should classify ECONNRESET as retryable", () => {
      const err = new Error("read ECONNRESET");
      expect(isRetryableError(err)).toBe(true);
    });

    it("should classify ECONNREFUSED as retryable", () => {
      const err = new Error("connect ECONNREFUSED");
      expect(isRetryableError(err)).toBe(true);
    });

    it("should classify ETIMEDOUT as retryable", () => {
      const err = new Error("connect ETIMEDOUT");
      expect(isRetryableError(err)).toBe(true);
    });

    it("should classify rate limit errors as retryable", () => {
      const err = new Error("rate limit exceeded");
      expect(isRetryableError(err)).toBe(true);
    });

    it("should classify too many requests as retryable", () => {
      const err = new Error("too many requests");
      expect(isRetryableError(err)).toBe(true);
    });

    it("should classify service unavailable as retryable", () => {
      const err = new Error("service unavailable");
      expect(isRetryableError(err)).toBe(true);
    });

    it("should classify gateway timeout as retryable", () => {
      const err = new Error("gateway timeout");
      expect(isRetryableError(err)).toBe(true);
    });

    it("should classify bad gateway as retryable", () => {
      const err = new Error("bad gateway");
      expect(isRetryableError(err)).toBe(true);
    });

    it("should classify HTTP 429 as retryable", () => {
      const err = new Error("HTTP status 429 Too Many Requests");
      expect(isRetryableError(err)).toBe(true);
    });

    it("should classify HTTP 502 as retryable", () => {
      const err = new Error("HTTP status 502 Bad Gateway");
      expect(isRetryableError(err)).toBe(true);
    });

    it("should classify HTTP 503 as retryable", () => {
      const err = new Error("HTTP status 503 Service Unavailable");
      expect(isRetryableError(err)).toBe(true);
    });

    it("should classify HTTP 504 as retryable", () => {
      const err = new Error("HTTP status 504 Gateway Timeout");
      expect(isRetryableError(err)).toBe(true);
    });

    it("should classify TimeoutError as retryable", () => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      expect(isRetryableError(err)).toBe(true);
    });

    it("should NOT classify generic error as retryable", () => {
      const err = new Error("something went wrong");
      expect(isRetryableError(err)).toBe(false);
    });

    it("should NOT classify 400 as retryable", () => {
      const err = new Error("HTTP status 400 Bad Request");
      expect(isRetryableError(err)).toBe(false);
    });

    it("should NOT classify 404 as retryable", () => {
      const err = new Error("HTTP status 404 Not Found");
      expect(isRetryableError(err)).toBe(false);
    });
  });

  describe("execute", () => {
    it("should return success on first attempt", async () => {
      const policy = new RetryPolicy({ maxRetries: 3 });
      const fn = vi.fn().mockResolvedValue("ok");

      const result = await policy.execute(fn);
      expect(result.success).toBe(true);
      expect(result.result).toBe("ok");
      expect(result.attempts).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should retry on failure and succeed", async () => {
      const policy = new RetryPolicy({
        maxRetries: 3,
        baseDelayMs: 10,
        jitter: "none",  // Deterministic for testing
        retryOnAllErrors: true,
      });

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockRejectedValueOnce(new Error("ETIMEDOUT"))
        .mockResolvedValue("ok");

      const result = await policy.execute(fn);
      expect(result.success).toBe(true);
      expect(result.result).toBe("ok");
      expect(result.attempts).toBe(3);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should give up after max retries", async () => {
      const policy = new RetryPolicy({
        maxRetries: 2,
        baseDelayMs: 10,
        jitter: "none",
        retryOnAllErrors: true,
      });

      const fn = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

      const result = await policy.execute(fn);
      expect(result.success).toBe(false);
      expect(result.error!.message).toBe("ECONNRESET");
      expect(result.attempts).toBe(3); // Initial + 2 retries
    });

    it("should not retry non-retryable errors", async () => {
      const policy = new RetryPolicy({
        maxRetries: 3,
        retryOnAllErrors: false,
      });

      const fn = vi.fn().mockRejectedValue(new Error("Invalid input"));

      const result = await policy.execute(fn);
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should use custom error classifier", async () => {
      const policy = new RetryPolicy({
        maxRetries: 3,
        retryOnAllErrors: false,
        baseDelayMs: 10,
        jitter: "none",
        isRetryable: (err) => err.message.includes("custom retry"),
      });

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("custom retry error"))
        .mockResolvedValue("ok");

      const result = await policy.execute(fn);
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
    });

    it("should fire callbacks", async () => {
      const policy = new RetryPolicy({
        maxRetries: 2,
        baseDelayMs: 10,
        jitter: "none",
        retryOnAllErrors: true,
      });

      const callbacks: RetryCallbacks<string> = {
        onAttempt: vi.fn(),
        onRetry: vi.fn(),
        onSuccess: vi.fn(),
        onGiveUp: vi.fn(),
      };

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValue("ok");

      await policy.execute(fn, callbacks);

      expect(callbacks.onAttempt).toHaveBeenCalledTimes(2);
      expect(callbacks.onRetry).toHaveBeenCalledTimes(1);
      expect(callbacks.onSuccess).toHaveBeenCalledTimes(1);
    });

    it("should fire onGiveUp callback", async () => {
      const policy = new RetryPolicy({
        maxRetries: 1,
        baseDelayMs: 10,
        jitter: "none",
        retryOnAllErrors: true,
      });

      const onGiveUp = vi.fn();
      const fn = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

      await policy.execute(fn, { onGiveUp });
      expect(onGiveUp).toHaveBeenCalledTimes(1);
    });

    it("should include total time in result", async () => {
      const policy = new RetryPolicy({
        maxRetries: 2,
        baseDelayMs: 10,
        jitter: "none",
        retryOnAllErrors: true,
      });

      const fn = vi.fn().mockResolvedValue("fast");
      const result = await policy.execute(fn);
      expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should timeout slow operations", async () => {
      const policy = new RetryPolicy({
        maxRetries: 1,
        retryOnAllErrors: true,
        attemptTimeoutMs: 50,
        baseDelayMs: 10,
        jitter: "none",
      });

      const fn = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
      );

      const result = await policy.execute(fn);
      expect(result.success).toBe(false);
    });
  });

  describe("getDelayForAttempt", () => {
    it("should compute delay for first retry", () => {
      const policy = new RetryPolicy({
        baseDelayMs: 1000,
        backoffMultiplier: 2,
        jitter: "none",
      });
      const delay = policy.getDelayForAttempt(1);
      expect(delay).toBe(2000); // 1000 * 2^1
    });

    it("should compute delay for third retry", () => {
      const policy = new RetryPolicy({
        baseDelayMs: 1000,
        backoffMultiplier: 2,
        jitter: "none",
      });
      const delay = policy.getDelayForAttempt(3);
      expect(delay).toBe(8000); // 1000 * 2^3
    });

    it("should not exceed max delay", () => {
      const policy = new RetryPolicy({
        baseDelayMs: 1000,
        backoffMultiplier: 2,
        maxDelayMs: 5000,
        jitter: "none",
      });
      const delay = policy.getDelayForAttempt(5);
      expect(delay).toBeLessThanOrEqual(5000);
    });
  });

  describe("Presets", () => {
    it("should provide fast preset", () => {
      const config = RetryPresets.fast();
      expect(config.maxRetries).toBe(2);
      expect(config.jitter).toBe("full");
      expect(config.retryOnAllErrors).toBe(true);
    });

    it("should provide standard preset", () => {
      const config = RetryPresets.standard();
      expect(config.maxRetries).toBe(3);
      expect(config.jitter).toBe("decorrelated");
    });

    it("should provide persistent preset", () => {
      const config = RetryPresets.persistent();
      expect(config.maxRetries).toBe(5);
      expect(config.baseDelayMs).toBe(2000);
    });

    it("should provide aggressive preset", () => {
      const config = RetryPresets.aggressive();
      expect(config.maxRetries).toBe(10);
      expect(config.backoffMultiplier).toBe(1.5);
    });
  });

  describe("configure", () => {
    it("should update configuration", () => {
      const policy = new RetryPolicy({ maxRetries: 3 });
      policy.configure({ maxRetries: 5 });
      expect(policy.getDelayForAttempt(1)).toBeDefined();
    });
  });
});