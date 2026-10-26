/**
 * turn-preflight-gate.test — 预检压力门控测试（对标 hermes-agent agent/turn_preflight_gate.py）
 */

import { describe, it, expect } from "vitest";
import {
  runPreflightGate,
  hasSignificantProgress,
  createPreflightGateDeps,
  type RunPreflightGateOptions,
  type RunPreflightGateDeps,
} from "./turn-preflight-gate";

function makeOptions(overrides?: Partial<RunPreflightGateOptions>): RunPreflightGateOptions {
  return {
    requestPressureTokens: 50000,
    messages: [{ role: "user", content: "hello" }],
    systemMessage: "system",
    userMessage: "hello",
    activeSystemPrompt: "system",
    conversationHistory: [],
    apiCallCount: 0,
    compressionAttempts: 0,
    maxCompressionAttempts: 3,
    effectiveTaskId: "test-task",
    failed: false,
    compressionTimeoutExhausted: false,
    preflightCompressionBlocked: false,
    providerOverflowRecoveryPending: false,
    lastPreflightPressure: null,
    ...overrides,
  };
}

describe("runPreflightGate", () => {
  it("Ollama runtime context 不足时 break", () => {
    const opts = makeOptions();
    const deps = createPreflightGateDeps({
      ollamaContextLimitError: () => "Ollama context too small",
      emitDiagnosticStatus: () => {},
      appendMessage: () => {},
      refundApiCall: () => {},
      refundIterationBudget: () => {},
    });
    const verdict = runPreflightGate(opts, deps);
    expect(verdict.action).toBe("break");
    expect(verdict.failed).toBe(true);
    expect(verdict.turnExitReason).toBe("ollama_runtime_context_too_small");
    expect(verdict.finalResponse).toContain("Ollama");
  });

  it("Ollama runtime context 正常时 fallthrough", () => {
    const opts = makeOptions();
    const deps = createPreflightGateDeps({
      ollamaContextLimitError: () => null,
      shouldCompress: () => false,
    });
    const verdict = runPreflightGate(opts, deps);
    expect(verdict.action).toBe("fallthrough");
  });

  it("provider 溢出恢复待处理时执行压缩", () => {
    const opts = makeOptions({
      providerOverflowRecoveryPending: true,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    });
    const deps = createPreflightGateDeps({
      ollamaContextLimitError: () => null,
      shouldCompress: () => true,
      compressContext: () => ({ messages: ["new"], changed: true, timedOut: false }),
      refundApiCall: () => {},
      resetRetryState: () => {},
    });
    const verdict = runPreflightGate(opts, deps);
    expect(verdict.action).toBe("continue");
  });

  it("延迟压缩时 fallthrough", () => {
    const opts = makeOptions();
    const deps = createPreflightGateDeps({
      ollamaContextLimitError: () => null,
      deferPreflight: () => true,
      shouldCompress: () => true,
    });
    const verdict = runPreflightGate(opts, deps);
    expect(verdict.action).toBe("fallthrough");
  });

  it("isRequestPressureAnchored 时不延迟", () => {
    const opts = makeOptions({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    });
    const deps = createPreflightGateDeps({
      ollamaContextLimitError: () => null,
      isRequestPressureAnchored: true,
      shouldCompress: () => true,
      compressContext: () => ({ messages: ["new"], changed: true, timedOut: false }),
      refundApiCall: () => {},
      resetRetryState: () => {},
    });
    const verdict = runPreflightGate(opts, deps);
    expect(verdict.action).toBe("continue");
  });
});

describe("hasSignificantProgress", () => {
  it("减少超过 10% 时返回 true", () => {
    expect(hasSignificantProgress(100000, 80000)).toBe(true);
    expect(hasSignificantProgress(100000, 89000)).toBe(true);
  });

  it("减少不足 10% 时返回 false", () => {
    expect(hasSignificantProgress(100000, 95000)).toBe(false);
    expect(hasSignificantProgress(100000, 99000)).toBe(false);
  });

  it("prevTokens 为 0 时返回 true", () => {
    expect(hasSignificantProgress(0, 50000)).toBe(true);
  });

  it("currentTokens 为 0 时返回 true", () => {
    expect(hasSignificantProgress(100000, 0)).toBe(true);
  });

  it("相等时返回 false", () => {
    expect(hasSignificantProgress(100000, 100000)).toBe(false);
  });
});

describe("createPreflightGateDeps", () => {
  it("创建默认依赖", () => {
    const deps = createPreflightGateDeps();
    expect(deps).toBeDefined();
    expect(typeof deps.compressContext).toBe("function");
    expect(typeof deps.refundApiCall).toBe("function");
    expect(typeof deps.shouldCompress).toBe("function");
  });

  it("支持覆盖默认依赖", () => {
    const customFn = () => {};
    const deps = createPreflightGateDeps({ refundApiCall: customFn });
    expect(deps.refundApiCall).toBe(customFn);
  });
});
