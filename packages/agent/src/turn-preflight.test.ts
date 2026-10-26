/**
 * turn-preflight.test — 预检压缩门控测试（对标 hermes-agent agent/turn_preflight.py）
 */

import { describe, it, expect } from "vitest";
import {
  runPreflightCompression,
  compressAfterToolResults,
  COMPRESSION_TIMEOUT_FINAL_RESPONSE,
  HANDOFF_SKIP_FINAL_RESPONSE,
  type RunPreflightCompressionOptions,
  type RunPreflightCompressionDeps,
} from "./turn-preflight";

function makeOptions(overrides?: Partial<RunPreflightCompressionOptions>): RunPreflightCompressionOptions {
  return {
    compressionEnabled: true,
    messagesCount: 10,
    compressionAttempts: 0,
    maxCompressionAttempts: 3,
    requestPressureTokens: 50000,
    compressorThresholdTokens: 40000,
    compressorContextLength: 100000,
    hasRefreshToken: false,
    reviewForkFirstRequestPending: false,
    preflightCompressionBlocked: false,
    deferPreflight: () => false,
    compressionCooldown: false,
    shouldCompress: () => true,
    providerOverflowPreflight: false,
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<RunPreflightCompressionDeps>): RunPreflightCompressionDeps {
  return {
    compressContext: () => ({ messages: [], changed: false, timedOut: false }),
    refundApiCall: () => {},
    onCompressionAttempt: () => {},
    resetRetryState: () => {},
    shouldSkipModelCallForHandoff: () => false,
    ...overrides,
  };
}

describe("runPreflightCompression", () => {
  it("压缩成功时返回 continue", () => {
    const opts = makeOptions();
    const deps = makeDeps({
      compressContext: () => ({ messages: ["new"], changed: true, timedOut: false }),
    });
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.action).toBe("continue");
    expect(verdict.compressionAttempts).toBe(1);
  });

  it("压缩超时时返回 break", () => {
    const opts = makeOptions();
    const deps = makeDeps({
      compressContext: () => ({ messages: [], changed: false, timedOut: true }),
    });
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.action).toBe("break");
    expect(verdict.failed).toBe(true);
    expect(verdict.compressionTimeoutExhausted).toBe(true);
    expect(verdict.turnExitReason).toBe("context_compression_timeout");
    expect(verdict.finalResponse).toContain("timed out");
  });

  it("压缩未改变 messages 时退款并 fallthrough", () => {
    const opts = makeOptions();
    const deps = makeDeps({
      compressContext: () => ({ messages: [], changed: false, timedOut: false }),
    });
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.action).toBe("fallthrough");
    expect(verdict.compressionAttempts).toBe(0); // 退款
  });

  it("压缩跳过时退款并保留 progress blocker", () => {
    const opts = makeOptions({ compressionCooldown: true });
    const deps = makeDeps();
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.action).toBe("fallthrough");
    expect(verdict.compressionAttempts).toBe(0);
  });

  it("延迟压缩时 fallthrough", () => {
    const opts = makeOptions({
      deferPreflight: () => true,
      providerOverflowPreflight: false,
    });
    const deps = makeDeps();
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.action).toBe("fallthrough");
    expect(verdict.compressionAttempts).toBe(0);
  });

  it("无压缩资格时 fallthrough", () => {
    const opts = makeOptions({ compressionEnabled: false });
    const deps = makeDeps();
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.action).toBe("fallthrough");
  });

  it("单消息时跳过压缩", () => {
    const opts = makeOptions({ messagesCount: 1 });
    const deps = makeDeps();
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.action).toBe("fallthrough");
  });

  it("达到压缩上限时 fallthrough", () => {
    const opts = makeOptions({ compressionAttempts: 3 });
    const deps = makeDeps();
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.action).toBe("fallthrough");
  });

  it("review fork 首个请求待处理时跳过压缩", () => {
    const opts = makeOptions({ reviewForkFirstRequestPending: true });
    const deps = makeDeps();
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.action).toBe("fallthrough");
  });

  it("reference-only handoff 时 break", () => {
    const opts = makeOptions();
    const deps = makeDeps({
      compressContext: () => ({ messages: ["handoff"], changed: true, timedOut: false }),
      shouldSkipModelCallForHandoff: () => true,
    });
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.action).toBe("break");
    expect(verdict.turnExitReason).toBe("compaction_handoff_not_actionable");
    expect(verdict.finalResponse).toContain("reference handoff");
  });

  it("provider 溢出 + 压缩冷却时 fail closed", () => {
    const opts = makeOptions({
      providerOverflowPreflight: true,
      compressionCooldown: true,
    });
    const deps = makeDeps();
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.action).toBe("return");
    expect(verdict.result?.error).toBe("compression_deferred");
  });

  it("provider 溢出 + 压缩耗尽时 fail closed", () => {
    const opts = makeOptions({
      providerOverflowPreflight: true,
      compressionAttempts: 3,
      maxCompressionAttempts: 3,
    });
    const deps = makeDeps();
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.action).toBe("return");
    expect(verdict.result?.error).toBe("compression_exhausted");
  });

  it("provider 溢出 + 其他门控阻塞时 fail closed", () => {
    const opts = makeOptions({
      providerOverflowPreflight: true,
      messagesCount: 1,
    });
    const deps = makeDeps();
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.action).toBe("return");
    expect(verdict.result?.error).toBe("compression_exhausted");
  });

  it("preFlightCompressionBlocked 时跳过压缩", () => {
    const opts = makeOptions({ preflightCompressionBlocked: true });
    const deps = makeDeps();
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.action).toBe("fallthrough");
  });

  it("lastPreflightPressure 仅在压缩 pass 重新武装", () => {
    const opts = makeOptions();
    const deps = makeDeps({
      compressContext: () => ({ messages: ["new"], changed: true, timedOut: false }),
    });
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.lastPreflightPressure).toBe(50000);
  });

  it("压缩未改变时 lastPreflightPressure 重置为 null", () => {
    const opts = makeOptions();
    const deps = makeDeps({
      compressContext: () => ({ messages: [], changed: false, timedOut: false }),
    });
    const verdict = runPreflightCompression(opts, deps);
    expect(verdict.lastPreflightPressure).toBeNull();
  });
});

describe("compressAfterToolResults", () => {
  it("等待真实 usage 时不压缩", () => {
    const verdict = compressAfterToolResults(
      {
        compressionEnabled: true,
        compressionAttempts: 0,
        maxCompressionAttempts: 3,
        realTokens: 50000,
        compressorThresholdTokens: 40000,
        awaitingRealUsageAfterCompression: true,
        shouldCompress: () => true,
      },
      {
        compressContext: () => ({ messages: [], changed: false }),
        refundApiCall: () => {},
        resetRetryState: () => {},
        shouldSkipModelCallForHandoff: () => false,
        warnContextOverflowBlocked: () => {},
        pruneToolResults: () => ({ messages: [], count: 0 }),
        onPrune: () => {},
      },
    );
    expect(verdict.endTurn).toBe(false);
  });

  it("超过阈值时压缩", () => {
    const verdict = compressAfterToolResults(
      {
        compressionEnabled: true,
        compressionAttempts: 0,
        maxCompressionAttempts: 3,
        realTokens: 50000,
        compressorThresholdTokens: 40000,
        awaitingRealUsageAfterCompression: false,
        shouldCompress: () => true,
      },
      {
        compressContext: () => ({ messages: ["new"], changed: true }),
        refundApiCall: () => {},
        resetRetryState: () => {},
        shouldSkipModelCallForHandoff: () => false,
        warnContextOverflowBlocked: () => {},
        pruneToolResults: () => ({ messages: [], count: 0 }),
        onPrune: () => {},
      },
    );
    expect(verdict.compressionAttempts).toBe(1);
    expect(verdict.endTurn).toBe(false);
  });

  it("压缩被阻塞时发警告", () => {
    let warned = false;
    const verdict = compressAfterToolResults(
      {
        compressionEnabled: true,
        compressionAttempts: 0,
        maxCompressionAttempts: 3,
        realTokens: 50000,
        compressorThresholdTokens: 40000,
        awaitingRealUsageAfterCompression: false,
        shouldCompress: () => false,
      },
      {
        compressContext: () => ({ messages: [], changed: false }),
        refundApiCall: () => {},
        resetRetryState: () => {},
        shouldSkipModelCallForHandoff: () => false,
        warnContextOverflowBlocked: () => { warned = true; },
        pruneToolResults: () => ({ messages: [], count: 0 }),
        onPrune: () => {},
      },
    );
    expect(warned).toBe(true);
    expect(verdict.endTurn).toBe(false);
  });

  it("reference-only handoff 时 endTurn", () => {
    const verdict = compressAfterToolResults(
      {
        compressionEnabled: true,
        compressionAttempts: 0,
        maxCompressionAttempts: 3,
        realTokens: 50000,
        compressorThresholdTokens: 40000,
        awaitingRealUsageAfterCompression: false,
        shouldCompress: () => true,
      },
      {
        compressContext: () => ({ messages: ["handoff"], changed: true }),
        refundApiCall: () => {},
        resetRetryState: () => {},
        shouldSkipModelCallForHandoff: () => true,
        warnContextOverflowBlocked: () => {},
        pruneToolResults: () => ({ messages: [], count: 0 }),
        onPrune: () => {},
      },
    );
    expect(verdict.endTurn).toBe(true);
    expect(verdict.turnExitReason).toBe("compaction_handoff_not_actionable");
  });
});

describe("文案常量", () => {
  it("COMPRESSION_TIMEOUT_FINAL_RESPONSE 包含超时说明", () => {
    expect(COMPRESSION_TIMEOUT_FINAL_RESPONSE).toContain("timed out");
    expect(COMPRESSION_TIMEOUT_FINAL_RESPONSE).toContain("/new");
  });

  it("HANDOFF_SKIP_FINAL_RESPONSE 包含 handoff 说明", () => {
    expect(HANDOFF_SKIP_FINAL_RESPONSE).toContain("reference handoff");
  });
});
