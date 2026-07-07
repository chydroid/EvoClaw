import { describe, it, expect } from "vitest";
import {
  classifyLLMError,
  isContextOverflowError,
  isRateLimitError,
  estimateTokensFromText,
  estimateMessagesTokens,
  LLMErrorType,
} from "../src/error-classifier";

describe("classifyLLMError", () => {
  describe("HTTP status code classification", () => {
    it("should classify 429 as rate limit", () => {
      const result = classifyLLMError(429);
      expect(result.type).toBe(LLMErrorType.RATE_LIMIT);
      expect(result.retryable).toBe(true);
      expect(result.shouldRotateAuth).toBe(true);
    });

    it("should classify 401 as auth error", () => {
      const result = classifyLLMError(401);
      expect(result.type).toBe(LLMErrorType.AUTH);
      expect(result.retryable).toBe(false);
    });

    it("should classify 403 as auth error", () => {
      const result = classifyLLMError(403);
      expect(result.type).toBe(LLMErrorType.AUTH);
    });

    it("should classify 402 as billing error", () => {
      const result = classifyLLMError(402);
      expect(result.type).toBe(LLMErrorType.BILLING);
      expect(result.retryable).toBe(false);
    });
  });

  describe("Context overflow detection", () => {
    it("should detect context length exceeded message", () => {
      const result = classifyLLMError(undefined, "context length exceeded for model gpt-4");
      expect(result.type).toBe(LLMErrorType.CONTEXT_OVERFLOW);
      expect(result.shouldCompact).toBe(true);
    });

    it("should detect input too long message", () => {
      const result = classifyLLMError(undefined, "input is too long, reduce the length");
      expect(result.type).toBe(LLMErrorType.CONTEXT_OVERFLOW);
      expect(result.shouldCompact).toBe(true);
    });

    it("should detect token limit message", () => {
      const result = classifyLLMError(undefined, "input exceeds the maximum number of tokens");
      expect(result.type).toBe(LLMErrorType.CONTEXT_OVERFLOW);
    });

    it("should detect context window error", () => {
      const result = classifyLLMError(undefined, "maximum context length exceeded");
      expect(result.type).toBe(LLMErrorType.CONTEXT_OVERFLOW);
    });

    it("should detect request too large", () => {
      const result = classifyLLMError(undefined, "request_too_large - input token count exceeds limit");
      expect(result.type).toBe(LLMErrorType.CONTEXT_OVERFLOW);
    });
  });

  describe("Rate limit detection", () => {
    it("should detect rate limit in error text", () => {
      const result = classifyLLMError(undefined, "rate limit exceeded, try again in 10s");
      expect(result.type).toBe(LLMErrorType.RATE_LIMIT);
      expect(result.backoffMs).toBeGreaterThan(0);
    });

    it("should detect throttling message", () => {
      const result = classifyLLMError(undefined, "requests too frequent, throttled");
      expect(result.type).toBe(LLMErrorType.RATE_LIMIT);
    });

    it("should detect quota exceeded", () => {
      const result = classifyLLMError(undefined, "quota exceeded for api key");
      expect(result.type).toBe(LLMErrorType.RATE_LIMIT);
    });

    it("should parse retry-after header", () => {
      const result = classifyLLMError(undefined, "retry after 30 seconds");
      expect(result.type).toBe(LLMErrorType.RATE_LIMIT);
      // Retry-After 契约场景下 backoff 不再被 30s 上限截断，
      // 上限提升至 5 分钟以尊重 provider 的 Retry-After 要求。
      // positive jitter 模式会在 base 上增加最多 30%，因此
      // 30s * 1.0 ~ 30s * 1.3 = 30000 ~ 39000
      expect(result.backoffMs).toBeGreaterThanOrEqual(29000);
      expect(result.backoffMs).toBeLessThanOrEqual(40000);
      expect(result.hasRetryAfterContract).toBe(true);
    });
  });

  describe("Auth error detection", () => {
    it("should detect invalid api key", () => {
      const result = classifyLLMError(undefined, "invalid api key provided");
      expect(result.type).toBe(LLMErrorType.AUTH);
    });

    it("should detect unauthorized", () => {
      const result = classifyLLMError(undefined, "unauthorized access denied");
      expect(result.type).toBe(LLMErrorType.AUTH);
    });

    it("should detect authentication failed", () => {
      const result = classifyLLMError(undefined, "authentication failed for this provider");
      expect(result.type).toBe(LLMErrorType.AUTH);
    });
  });

  describe("Billing error detection", () => {
    it("should detect insufficient quota", () => {
      const result = classifyLLMError(undefined, "insufficient_quota for this model");
      expect(result.type).toBe(LLMErrorType.BILLING);
    });

    it("should detect account balance issue", () => {
      const result = classifyLLMError(undefined, "account balance is insufficient");
      expect(result.type).toBe(LLMErrorType.BILLING);
    });

    it("should detect subscription issue", () => {
      const result = classifyLLMError(undefined, "subscription has expired");
      expect(result.type).toBe(LLMErrorType.BILLING);
    });
  });

  describe("Timeout detection", () => {
    it("should detect timeout error", () => {
      const result = classifyLLMError(undefined, "request timed out after 30s");
      expect(result.type).toBe(LLMErrorType.TIMEOUT);
    });

    it("should detect ECONNRESET", () => {
      const result = classifyLLMError(undefined, "ECONNRESET error");
      expect(result.type).toBe(LLMErrorType.TIMEOUT);
    });
  });

  describe("Unknown error", () => {
    it("should classify unrecognizable errors as unknown", () => {
      // 5xx 现在归类为 PROVIDER_ERROR（可重试），不再落入 UNKNOWN
      // 使用无 status code 的不可识别错误测试 UNKNOWN 分支
      const result = classifyLLMError(undefined, "something went wrong");
      expect(result.type).toBe(LLMErrorType.UNKNOWN);
      expect(result.retryable).toBe(false);
    });

    it("should classify 5xx errors as provider_error (retryable)", () => {
      const result = classifyLLMError(500, "internal server error");
      expect(result.type).toBe(LLMErrorType.PROVIDER_ERROR);
      expect(result.retryable).toBe(true);
    });

    it("should classify empty error as unknown", () => {
      const result = classifyLLMError(undefined, "");
      expect(result.type).toBe(LLMErrorType.UNKNOWN);
    });
  });
});

describe("isContextOverflowError", () => {
  it("should return true for context overflow message", () => {
    expect(isContextOverflowError(undefined, "context length exceeded")).toBe(true);
  });

  it("should return false for non-overflow message", () => {
    expect(isContextOverflowError(undefined, "some other error")).toBe(false);
  });

  it("should return false for empty message", () => {
    expect(isContextOverflowError(undefined, "")).toBe(false);
  });
});

describe("isRateLimitError", () => {
  it("should return true for 429 status", () => {
    expect(isRateLimitError(429)).toBe(true);
  });

  it("should return true for rate limit message", () => {
    expect(isRateLimitError(undefined, "rate limit exceeded")).toBe(true);
  });

  it("should return false for other error", () => {
    expect(isRateLimitError(500, "server error")).toBe(false);
  });
});

describe("estimateTokensFromText", () => {
  it("should estimate tokens based on character count", () => {
    expect(estimateTokensFromText("hello")).toBe(2);
    expect(estimateTokensFromText("")).toBe(0);
  });

  it("should round up", () => {
    const longText = "x".repeat(100);
    expect(estimateTokensFromText(longText)).toBe(25);
  });
});

describe("estimateMessagesTokens", () => {
  it("should sum tokens across messages", () => {
    const messages = [
      { role: "system", content: "Hello world" },
      { role: "user", content: "How are you?" },
    ];
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(0);
  });

  it("should handle null content", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: null },
    ];
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(0);
  });

  it("should return 0 for empty messages", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});