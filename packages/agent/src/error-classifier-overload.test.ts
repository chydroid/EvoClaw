import { describe, it, expect } from "vitest";
import {
  classifyLLMError,
  LLMErrorType,
} from "./error-classifier";

/**
 * 5xx 过载细分回归测试（2026-10-18，对齐 hermes 瞬时过载自动恢复阶梯）：
 * 503 → overloaded（阶梯原地重试）、504/529 → timeout/overloaded，
 * 其余 5xx 仍为瞬时 provider_error；5xx 中的请求验证错误仍 non-transient。
 */
describe("classifyLLMError > 5xx 过载细分", () => {
  it("503 归类为瞬时 overloaded（供恢复阶梯原地重试）", () => {
    const r = classifyLLMError(503, "Service Unavailable");
    expect(r.type).toBe(LLMErrorType.PROVIDER_ERROR);
    expect(r.retryable).toBe(true);
    expect(r.isTransient).toBe(true);
    expect(r.shouldSkipProvider).toBe(false);
    expect(r.reason).toBe("overloaded");
  });

  it("504 归类为瞬时 timeout", () => {
    const r = classifyLLMError(504, "Gateway Timeout");
    expect(r.type).toBe(LLMErrorType.TIMEOUT);
    expect(r.retryable).toBe(true);
    expect(r.isTransient).toBe(true);
    expect(r.reason).toBe("timeout");
  });

  it("529（Anthropic 过载码）归类为瞬时 overloaded", () => {
    const r = classifyLLMError(529, "Anthropic is at capacity");
    expect(r.type).toBe(LLMErrorType.TIMEOUT);
    expect(r.retryable).toBe(true);
    expect(r.isTransient).toBe(true);
    expect(r.reason).toBe("overloaded");
  });

  it("普通 500 仍为瞬时 provider_error", () => {
    const r = classifyLLMError(500, "Internal Server Error");
    expect(r.type).toBe(LLMErrorType.PROVIDER_ERROR);
    expect(r.retryable).toBe(true);
    expect(r.isTransient).toBe(true);
    expect(r.reason).toBe("server_error");
  });

  it("5xx 请求验证错误仍 non-transient 且跳过 provider（不误入阶梯）", () => {
    const r = classifyLLMError(500, "invalid request body: malformed json");
    expect(r.retryable).toBe(false);
    expect(r.isTransient).toBe(false);
    expect(r.shouldSkipProvider).toBe(true);
    expect(r.reason).toBe("format_error");
  });
});
