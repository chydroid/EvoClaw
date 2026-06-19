import { describe, it, expect } from "vitest";
import {
  EvoError,
  ConfigError,
  AuthError,
  ProviderError,
  RateLimitError,
  ContextOverflowError,
  TaskError,
  PluginError,
  isEvoError,
  isProviderError,
  isRateLimitError,
  isContextOverflowError,
  isConfigError,
  isAuthError,
  isTaskError,
  isPluginError,
} from "./errors";

describe("Error classes", () => {
  describe("EvoError", () => {
    it("should set code and retryable", () => {
      const err = new EvoError({ message: "test", code: "TEST", retryable: true });
      expect(err.message).toBe("test");
      expect(err.code).toBe("TEST");
      expect(err.retryable).toBe(true);
      expect(err).toBeInstanceOf(Error);
    });

    it("should support context", () => {
      const err = new EvoError({ message: "test", code: "TEST", context: { foo: "bar" } });
      expect(err.context).toEqual({ foo: "bar" });
    });

    it("should support cause", () => {
      const cause = new Error("original");
      const err = new EvoError({ message: "wrapped", code: "TEST", cause });
      expect(err.cause).toBe(cause);
    });
  });

  describe("ProviderError", () => {
    it("should set statusCode and provider", () => {
      const err = new ProviderError({ message: "fail", statusCode: 500, provider: "openai" });
      expect(err.statusCode).toBe(500);
      expect(err.provider).toBe("openai");
      expect(err.code).toBe("PROVIDER_ERROR");
    });
  });

  describe("RateLimitError", () => {
    it("should be retryable with retryAfterMs", () => {
      const err = new RateLimitError({ message: "rate limited", retryAfterMs: 10000 });
      expect(err.retryAfterMs).toBe(10000);
      expect(err.retryable).toBe(true);
      expect(err.statusCode).toBe(429);
    });

    it("should default retryAfterMs to 5000", () => {
      const err = new RateLimitError({ message: "rate limited" });
      expect(err.retryAfterMs).toBe(5000);
    });
  });

  describe("ContextOverflowError", () => {
    it("should default message", () => {
      const err = new ContextOverflowError("", "anthropic");
      expect(err.message).toBe("Context window exceeded");
      expect(err.provider).toBe("anthropic");
    });
  });

  describe("ConfigError", () => {
    it("should not be retryable", () => {
      const err = new ConfigError("invalid config");
      expect(err.retryable).toBe(false);
      expect(err.code).toBe("CONFIG_ERROR");
    });
  });

  describe("TaskError", () => {
    it("should include taskId", () => {
      const err = new TaskError({ message: "failed", taskId: "t-123" });
      expect(err.taskId).toBe("t-123");
      expect(err.context?.taskId).toBe("t-123");
    });
  });

  describe("PluginError", () => {
    it("should include pluginId", () => {
      const err = new PluginError({ message: "init failed", pluginId: "my-plugin" });
      expect(err.pluginId).toBe("my-plugin");
    });
  });
});

describe("Type guards", () => {
  it("isEvoError", () => {
    expect(isEvoError(new EvoError({ message: "x", code: "X" }))).toBe(true);
    expect(isEvoError(new Error("x"))).toBe(false);
    expect(isEvoError(null)).toBe(false);
  });

  it("isProviderError", () => {
    expect(isProviderError(new ProviderError({ message: "x" }))).toBe(true);
    expect(isProviderError(new EvoError({ message: "x", code: "X" }))).toBe(false);
  });

  it("isRateLimitError", () => {
    expect(isRateLimitError(new RateLimitError({ message: "x" }))).toBe(true);
    expect(isRateLimitError(new ProviderError({ message: "x" }))).toBe(false);
  });

  it("isContextOverflowError", () => {
    expect(isContextOverflowError(new ContextOverflowError("x"))).toBe(true);
    expect(isContextOverflowError(new ProviderError({ message: "x" }))).toBe(false);
  });

  it("isConfigError", () => {
    expect(isConfigError(new ConfigError("x"))).toBe(true);
    expect(isConfigError(new Error("x"))).toBe(false);
  });

  it("isAuthError", () => {
    expect(isAuthError(new AuthError("x"))).toBe(true);
    expect(isAuthError(new Error("x"))).toBe(false);
  });

  it("isTaskError", () => {
    expect(isTaskError(new TaskError({ message: "x", taskId: "1" }))).toBe(true);
    expect(isTaskError(new Error("x"))).toBe(false);
  });

  it("isPluginError", () => {
    expect(isPluginError(new PluginError({ message: "x", pluginId: "1" }))).toBe(true);
    expect(isPluginError(new Error("x"))).toBe(false);
  });
});
