import { describe, it, expect } from "vitest";
import {
  classifyLLMError,
  isContextOverflowError,
  isRateLimitError,
  isContentPolicyError,
  isSslCertError,
  isModelNotFoundError,
  isUpstreamRateLimitError,
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

// ── fix-1: 新增错误类型测试 ──

describe("fix-1: SSL certificate errors", () => {
  it("should classify SSL cert error as non-retryable", () => {
    const result = classifyLLMError(undefined, "SSL certificate verify failed");
    expect(result.type).toBe(LLMErrorType.SSL_CERT);
    expect(result.retryable).toBe(false);
    expect(result.shouldSkipProvider).toBe(true);
    expect(result.shouldRotateAuth).toBe(false);
    expect(result.backoffMs).toBe(0);
  });

  it("should detect self-signed certificate", () => {
    const result = classifyLLMError(undefined, "self.signed.certificate in chain");
    expect(result.type).toBe(LLMErrorType.SSL_CERT);
  });

  it("should detect expired certificate", () => {
    const result = classifyLLMError(undefined, "CERT_HAS_EXPIRED");
    expect(result.type).toBe(LLMErrorType.SSL_CERT);
  });

  it("should detect via isSslCertError helper", () => {
    expect(isSslCertError(undefined, "ssl cert verify failed")).toBe(true);
    expect(isSslCertError(undefined, "some other error")).toBe(false);
  });
});

describe("fix-1: Content policy errors", () => {
  it("should classify content policy as non-retryable", () => {
    const result = classifyLLMError(undefined, "content policy violation");
    expect(result.type).toBe(LLMErrorType.CONTENT_POLICY);
    expect(result.retryable).toBe(false);
    expect(result.shouldSkipProvider).toBe(true);
    expect(result.shouldRotateAuth).toBe(false);
  });

  it("should detect content_filter", () => {
    const result = classifyLLMError(undefined, "content_filter triggered");
    expect(result.type).toBe(LLMErrorType.CONTENT_POLICY);
  });

  it("should detect safety flag", () => {
    const result = classifyLLMError(undefined, "flagged by safety filter");
    expect(result.type).toBe(LLMErrorType.CONTENT_POLICY);
  });

  it("should detect ResponsibleAiPolicyViolation", () => {
    const result = classifyLLMError(undefined, "ResponsibleAiPolicyViolation detected");
    expect(result.type).toBe(LLMErrorType.CONTENT_POLICY);
  });

  it("should detect via isContentPolicyError helper", () => {
    expect(isContentPolicyError(undefined, "content policy violation")).toBe(true);
    expect(isContentPolicyError(451, "")).toBe(true);
    expect(isContentPolicyError(500, "server error")).toBe(false);
  });
});

describe("fix-1: Model not found errors", () => {
  it("should classify 404 with model_not_found pattern", () => {
    const result = classifyLLMError(404, "model gpt-5 does not exist");
    expect(result.type).toBe(LLMErrorType.MODEL_NOT_FOUND);
    expect(result.retryable).toBe(false);
    expect(result.shouldSkipProvider).toBe(true);
  });

  it("should classify 404 without specific text as model_not_found", () => {
    const result = classifyLLMError(404, "model not found");
    expect(result.type).toBe(LLMErrorType.MODEL_NOT_FOUND);
  });

  it("should detect model_not_found in text without status code", () => {
    const result = classifyLLMError(undefined, "unknown model specified");
    expect(result.type).toBe(LLMErrorType.MODEL_NOT_FOUND);
  });

  it("should detect via isModelNotFoundError helper", () => {
    expect(isModelNotFoundError(404, "model not found")).toBe(true);
    expect(isModelNotFoundError(404)).toBe(true);
    expect(isModelNotFoundError(500, "server error")).toBe(false);
  });
});

describe("fix-1: Payload too large errors", () => {
  it("should classify 413 as payload_too_large (retryable, shouldCompact)", () => {
    const result = classifyLLMError(413, "request entity too large");
    expect(result.type).toBe(LLMErrorType.PAYLOAD_TOO_LARGE);
    expect(result.retryable).toBe(true);
    expect(result.shouldCompact).toBe(true);
    expect(result.shouldSkipProvider).toBe(false);
  });

  it("should detect payload too large in text", () => {
    const result = classifyLLMError(undefined, "payload too large");
    expect(result.type).toBe(LLMErrorType.PAYLOAD_TOO_LARGE);
  });
});

describe("fix-1: Provider policy blocked errors", () => {
  it("should classify OpenRouter data policy block as PROVIDER_POLICY", () => {
    const result = classifyLLMError(undefined, "no endpoints available matching your data policy");
    expect(result.type).toBe(LLMErrorType.PROVIDER_POLICY);
    expect(result.retryable).toBe(false);
    expect(result.shouldSkipProvider).toBe(true);
  });

  it("should detect guardrail block", () => {
    const result = classifyLLMError(undefined, "guardrail not allowed for this account");
    expect(result.type).toBe(LLMErrorType.PROVIDER_POLICY);
  });
});

describe("fix-1: OpenRouter upstream 429", () => {
  it("should detect upstream 429 and not rotate auth", () => {
    const result = classifyLLMError(429, "upstream provider 429 rate limited");
    expect(result.type).toBe(LLMErrorType.RATE_LIMIT);
    expect(result.retryable).toBe(true);
    expect(result.shouldRotateAuth).toBe(false); // 不轮换 key
    expect(result.shouldSkipProvider).toBe(false);
    expect(result.backoffMs).toBeGreaterThan(0);
  });

  it("should detect via isUpstreamRateLimitError helper", () => {
    expect(isUpstreamRateLimitError("upstream 429")).toBe(true);
    expect(isUpstreamRateLimitError("normal rate limit")).toBe(false);
  });

  it("normal 429 should still rotate auth", () => {
    const result = classifyLLMError(429, "rate limit exceeded");
    expect(result.type).toBe(LLMErrorType.RATE_LIMIT);
    expect(result.shouldRotateAuth).toBe(true); // 普通 429 仍轮换
  });
});

describe("fix-1: 5xx validation error detection", () => {
  it("should treat 5xx with validation error as non-retryable", () => {
    const result = classifyLLMError(500, "invalid request format");
    expect(result.type).toBe(LLMErrorType.PROVIDER_ERROR);
    expect(result.retryable).toBe(false);
    expect(result.shouldSkipProvider).toBe(true);
  });

  it("should treat 502 with bad request as non-retryable", () => {
    const result = classifyLLMError(502, "malformed request payload");
    expect(result.retryable).toBe(false);
    expect(result.shouldSkipProvider).toBe(true);
  });

  it("should treat 5xx without validation keywords as retryable", () => {
    const result = classifyLLMError(500, "internal server error");
    expect(result.retryable).toBe(true);
    expect(result.shouldSkipProvider).toBe(false);
  });
});

describe("fix-1: Server disconnect + large session heuristic", () => {
  it("should heuristically treat disconnect on large session as context overflow", () => {
    const result = classifyLLMError(undefined, "server disconnected", undefined, {
      sessionTokens: 150_000,
    });
    expect(result.type).toBe(LLMErrorType.CONTEXT_OVERFLOW);
    expect(result.shouldCompact).toBe(true);
  });

  it("should not apply heuristic for small session", () => {
    const result = classifyLLMError(undefined, "server disconnected", undefined, {
      sessionTokens: 5000,
    });
    expect(result.type).not.toBe(LLMErrorType.CONTEXT_OVERFLOW);
  });

  it("should detect peer closed connection", () => {
    const result = classifyLLMError(undefined, "peer closed connection unexpectedly", undefined, {
      sessionTokens: 120_000,
    });
    expect(result.type).toBe(LLMErrorType.CONTEXT_OVERFLOW);
  });
});