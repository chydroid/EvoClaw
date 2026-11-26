import { describe, it, expect } from "vitest";
import {
  classifyLLMError,
  isContextOverflowError,
  isRateLimitError,
  isContentPolicyError,
  isSslCertError,
  isModelNotFoundError,
  isUpstreamRateLimitError,
  isOutputCapError,
  parseAvailableOutputTokens,
  estimateTokensFromText,
  estimateMessagesTokens,
  formatClassifiedErrorForUser,
  LLMErrorType,
} from "../src/error-classifier";
import {
  CONTENT_POLICY_BLOCKED_PATTERNS,
  MODEL_NOT_FOUND_PATTERNS as MODEL_NOT_FOUND_PATTERNS_TEXT,
  resolveFailoverReason,
} from "../src/failover-policy";

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

// ── ★ hermes 对齐 R10：output-cap 分类（is_output_cap_error 语义移植）──────
describe("isOutputCapError", () => {
  it("OpenAI 式 max_tokens too large（含 reduce the length 措辞）是 output-cap 而非 overflow", () => {
    // 该文本同时命中 /reduce.the.length/i——若先走 CONTEXT_OVERFLOW 会触发压缩死循环
    const msg = "Invalid request: max_tokens is too large: 1000000. This model supports at most 32768 output tokens. Please reduce the length of max_tokens.";
    expect(isOutputCapError(400, msg)).toBe(true);
  });

  it("max_tokens must be less than N 是 output-cap", () => {
    expect(isOutputCapError(400, "max_tokens must be less than 65536")).toBe(true);
  });

  it("真输入超长不是 output-cap（input overflow 信号优先）", () => {
    expect(isOutputCapError(400, "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.")).toBe(false);
  });

  it("非 400/422 状态码不判 output-cap", () => {
    expect(isOutputCapError(500, "max_tokens is too large")).toBe(false);
  });

  it("classifyLLMError 把 output-cap 归为 OUTPUT_CAP（不触发压缩）", () => {
    const r = classifyLLMError(400, "max_tokens is too large: 1000000. Maximum is 32768.");
    expect(r.type).toBe(LLMErrorType.OUTPUT_CAP);
    expect(r.shouldCompact).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.parsedOutputCap).toBe(32768);
  });
});

describe("parseAvailableOutputTokens", () => {
  it("解析 'Maximum is N'", () => {
    expect(parseAvailableOutputTokens("max_tokens is too large: 1000000. Maximum is 32768")).toBe(32768);
  });

  it("解析 'must be less than N'", () => {
    expect(parseAvailableOutputTokens("max_tokens must be less than 65536")).toBe(65536);
  });

  it("解析 'up to N'", () => {
    expect(parseAvailableOutputTokens("max_tokens can be up to 8192")).toBe(8192);
  });

  it("无数字返回 null", () => {
    expect(parseAvailableOutputTokens("something failed")).toBeNull();
  });

  it("滤掉过小数字（HTTP 状态码类）", () => {
    expect(parseAvailableOutputTokens("error 400 near max_tokens")).toBeNull();
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

  it("★ 403 + 「our safety system」必须判 content_policy，不得落到 AUTH", () => {
    // v34 实证（server log）：provider 返回
    //   HTTP 403 {"message":"...rejected as a result of our safety system..."}
    // 旧模式只认 `safety filter`，于是走到 403→AUTH：provider 被 skip 300s、
    // 同一提示词换 provider 再发一次，必然再被拒。hermes 在状态码分类**之前**
    // 判安全拒绝（safety refusal beats status code）。
    const r = classifyLLMError(403, '{"error":{"message":"Your request was rejected as a result of our safety system."}}');
    expect(r.type).toBe(LLMErrorType.CONTENT_POLICY);
    expect(r.retryable).toBe(false);
  });

  it("★ hermes 精选措辞表逐条生效", () => {
    const phrases = [
      "flagged for possible cybersecurity risk",
      "trusted access for cyber",
      "violates our usage policies",
      "your request was flagged by",
      "prompt was flagged by our safety",
      "responses cannot be generated due to safety",
      "data_inspection_failed",
      "new_sensitive",
      "content exists risk",
      "data may contain inappropriate content",
    ];
    for (const p of phrases) {
      expect(isContentPolicyError(400, p), p).toBe(true);
    }
  });

  it("★ 泛化词 'policy' 不得把计费/鉴权误判为内容策略", () => {
    expect(isContentPolicyError(402, "billing policy requires payment")).toBe(false);
    expect(isContentPolicyError(401, "invalid api key")).toBe(false);
  });

  it("★ 451 必须判 content_policy（不得落到 unknown/transient 反复重试）", () => {
    // isContentPolicyError 早已特判 451，主分类器此前没有对应分支 → 451 被
    // 当成 unknown 反复重试 + 换 provider 重发。同一类漂移。
    const r = classifyLLMError(451, "Unavailable For Legal Reasons");
    expect(r.type).toBe(LLMErrorType.CONTENT_POLICY);
    expect(r.shouldSkipProvider).toBe(true);
    expect(r.retryable).toBe(false);
    expect(r.reason).toBe("content_policy_blocked");
    // 两条分类路径对 451 必须一致
    expect(resolveFailoverReason(451, "Unavailable For Legal Reasons")).toBe("content_policy_blocked");
  });

  it("★ 两条分类路径（resolveFailoverReason / classifyLLMError）必须同源", () => {
    // v34 治本回归：content-policy 措辞此前在 failover-policy.ts（子串）与
    // error-classifier.ts（正则）各存一份，已经漂移。现在唯一真相在
    // failover-policy.ts:CONTENT_POLICY_BLOCKED_PATTERNS，两处必须同判。
    for (const p of CONTENT_POLICY_BLOCKED_PATTERNS) {
      const text = `Request refused: ${p}.`;
      // 路径 1：resolveFailoverReason 的 reason 分类
      expect(resolveFailoverReason(400, text), p).toBe("content_policy_blocked");
      // 路径 2：classifyLLMError 的 LLMErrorType 分类
      expect(classifyLLMError(400, text).type, p).toBe(LLMErrorType.CONTENT_POLICY);
    }
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

  it("404 措辞不匹配任何模式时仍归 model_not_found（不得落成可重试 provider_error）", () => {
    // ★ v34 实证：OpenRouter 下线 slug 的 404 措辞未命中旧模式表 → 旧实现返回
    //   { type: PROVIDER_ERROR, retryable: true, reason: "model_not_found" }
    //   ——对象自相矛盾，且与 resolveFailoverReason(404) 相反，导致过载阶梯
    //   重试一个已下线的模型 27 次。
    const result = classifyLLMError(404, "some gateway said no");
    expect(result.type).toBe(LLMErrorType.MODEL_NOT_FOUND);
    expect(result.retryable).toBe(false);
    expect(result.isTransient).toBe(false);
    expect(result.shouldSkipProvider).toBe(true);
    expect(result.reason).toBe("model_not_found");
  });

  it("404 两条路径（reason 与 classifier）对下线措辞同判", () => {
    // 实测原文（DOTS3/OpenRouter 网关）
    const text =
      "OpenRouterFree: dots-studio/dots-3-note-preview:free is no longer available on OpenRouter: " +
      "no provider serves this model anymore. See available models at https://openrouter.ai/models";
    expect(resolveFailoverReason(404, text)).toBe("model_not_found");
    const result = classifyLLMError(404, text);
    expect(result.type).toBe(LLMErrorType.MODEL_NOT_FOUND);
    expect(result.reason).toBe("model_not_found");
    expect(result.retryable).toBe(false);
    expect(result.shouldSkipProvider).toBe(true);
  });

  it("MODEL_NOT_FOUND 措辞表逐条：两条路径同判", () => {
    for (const phrase of MODEL_NOT_FOUND_PATTERNS_TEXT) {
      const text = `HTTP 404: ${phrase}`;
      expect(resolveFailoverReason(404, text), phrase).toBe("model_not_found");
      const r = classifyLLMError(404, text);
      expect(r.type, phrase).toBe(LLMErrorType.MODEL_NOT_FOUND);
      expect(r.retryable, phrase).toBe(false);
    }
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

describe("★ 2026-10-30: ABORT classification (deliberate cancellation)", () => {
  it("should classify 'Request aborted' as ABORT, not TIMEOUT", () => {
    // 此前 /abort/i 在 TIMEOUT_PATTERNS 中吞掉 "Request aborted"，
    // 导致 abort 走 overload ladder（6s/14s/27s）+ 熔断器（30s）≈ 50-77s 浪费/次。
    const result = classifyLLMError(undefined, "Request aborted");
    expect(result.type).toBe(LLMErrorType.ABORT);
    expect(result.retryable).toBe(false);
    expect(result.backoffMs).toBe(0);
    expect(result.shouldSkipProvider).toBe(false);
    expect(result.isTransient).toBe(false);
  });

  it("should classify AbortError DOMException as ABORT", () => {
    const result = classifyLLMError(undefined, "AbortError: This operation was aborted");
    expect(result.type).toBe(LLMErrorType.ABORT);
    expect(result.retryable).toBe(false);
  });

  it("should classify 'aborted' reason string as ABORT", () => {
    // controller.abort(new Error("aborted")) → fetch rejects with reason "aborted"
    const result = classifyLLMError(undefined, "aborted");
    expect(result.type).toBe(LLMErrorType.ABORT);
  });

  it("should not classify provider 502 as ABORT", () => {
    // 502 是 provider 错误，不是 abort——确保 ABORT_PATTERNS 不误伤
    const result = classifyLLMError(502, "bad gateway");
    expect(result.type).not.toBe(LLMErrorType.ABORT);
  });

  it("should not classify 'timeout' as ABORT", () => {
    // 真实超时仍归 TIMEOUT——确保 ABORT 检查不抢占超时分类
    const result = classifyLLMError(undefined, "request timed out after 60000ms");
    expect(result.type).toBe(LLMErrorType.TIMEOUT);
  });
});
// ═══════════════════════════════════════════════════════════
// ★ v34 治本：两条失败分类路径的**同判门禁**
//
// 同一个错误文本会经过两条独立实现：
//   - classifyLLMError()   → 决定 type / retryable / shouldSkipProvider（行为）
//   - resolveFailoverReason() → 决定 reason（记账/熔断/文案）
// 二者若对同一输入给出不同 reason，就会出现「记账说不可重试、行为却在重试」
// 这类自相矛盾（v34 实测两例：404 下线 slug、无状态码 model does not exist）。
// 这个门禁把所有已知形态钉死在表里——新增分支必须同时更新两条路径。
// ═══════════════════════════════════════════════════════════
describe("★ 跨模块同判门禁：classifyLLMError.reason === resolveFailoverReason", () => {
  const CASES: Array<[number | undefined, string, string]> = [
    // [status, errorText, 期望 reason]
    [400, "thinking block signature cannot be modified", "thinking_signature"],
    [400, "text is not set", "multimodal_tool_content_unsupported"],
    [400, "invalid request body: malformed json", "unclassified"],
    [401, "invalid api key", "auth"],
    [402, "insufficient quota", "billing"],
    [403, "forbidden", "auth"],
    [403, "DOTS3: rejected as a result of our safety system", "content_policy_blocked"],
    [404, "model not found", "model_not_found"],
    [404, "no provider serves this model anymore", "model_not_found"],
    [404, "totally unrecognized 404 body", "model_not_found"],
    [408, "timeout", "timeout"],
    [413, "payload too large", "payload_too_large"],
    [422, "unprocessable entity", "format"],
    [429, "rate limit exceeded", "rate_limit"],
    [451, "unavailable for legal reasons", "content_policy_blocked"],
    [500, "Internal Server Error", "server_error"],
    [502, "Bad Gateway", "server_error"],
    [503, "Service Unavailable", "overloaded"],
    [504, "Gateway Timeout", "timeout"],
    [529, "at capacity", "overloaded"],
    [undefined, "context length exceeded", "context_overflow"],
    [undefined, "invalid api key", "auth"],
    [undefined, "your request was rejected as a result of our safety system", "content_policy_blocked"],
    [undefined, "model does not exist", "model_not_found"],
    [undefined, "unknown model specified", "model_not_found"],
    [undefined, "connection reset by peer", "network"],
    [undefined, "overloaded", "overloaded"],
  ];

  for (const [status, text, expected] of CASES) {
    it(`${status ?? "无状态码"} ${text.slice(0, 46)} → ${expected}`, () => {
      const c = classifyLLMError(status, text);
      const r = resolveFailoverReason(status, text);
      expect(c.reason).toBe(r);
      expect(c.reason).toBe(expected);
      // 不可重试的 reason 不得同时标 retryable（反之亦然）
      const nonRetryable = ["model_not_found", "auth", "billing", "content_policy_blocked", "provider_policy_blocked"];
      if (nonRetryable.includes(expected)) expect(c.retryable, `${text} 不可重试`).toBe(false);
    });
  }
});

// ═══════════════════════════════════════════════════════════
// v34 T4：「已自动切换到下一个 provider」必须在真的还有下一个时才说
// 事故：magpie 401 后文案宣称已切换，实际循环直接 break、下一个 provider
// 从未被调用——用户被误导为「已换人重试」。
// ═══════════════════════════════════════════════════════════
describe("formatClassifiedErrorForUser — 切换措辞属实性", () => {
  const auth = classifyLLMError(401, "invalid api key");

  it("还有下一个 provider → 说已切换", () => {
    const msg = formatClassifiedErrorForUser(auth, "magpie", true);
    expect(msg.userMessage).toContain("已自动切换");
  });

  it("没有下一个 provider → 不得说已切换", () => {
    const msg = formatClassifiedErrorForUser(auth, "magpie", false);
    expect(msg.userMessage).not.toContain("已自动切换");
    expect(msg.userMessage).toContain("没有其他可用");
  });

  it("billing / model_not_found 同口径", () => {
    const billing = classifyLLMError(402, "insufficient balance");
    expect(formatClassifiedErrorForUser(billing, "x", false).userMessage).not.toContain("已自动切换");
    const mnf = classifyLLMError(404, "model does not exist");
    expect(formatClassifiedErrorForUser(mnf, "x", false).userMessage).not.toContain("已自动");
    expect(formatClassifiedErrorForUser(mnf, "x", true).userMessage).toContain("已自动");
  });
});
