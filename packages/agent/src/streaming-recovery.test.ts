import { describe, it, expect } from "vitest";
import { StreamingRecoveryManager, getStreamingRecoveryManager } from "./streaming-recovery";

// ═══════════════════════════════════════════════════════════
// 截断工具调用 max_tokens 提升（hermes turn_truncation
// `boosted_output_cap` 语义）：工具调用被 length 截断后，同一 prompt
// 大概率再次被截断——按重试次数指数放大 max_tokens（2→4→8，上限 8×，
// 受 maxTruncatedToolCallRetries=3 限制）。
// ═══════════════════════════════════════════════════════════
describe("StreamingRecoveryManager > getMaxTokensBoost（boosted_output_cap）", () => {
  it("无截断时返回 1（不影响正常调用）", () => {
    const m = new StreamingRecoveryManager();
    expect(m.getMaxTokensBoost()).toBe(1);
  });

  it("截断工具调用重试次数 → 指数放大，上限 8×（受 maxTruncatedToolCallRetries=3 限制）", () => {
    const m = new StreamingRecoveryManager();
    // 每次 interruptedInToolCall 且无 think 后内容 → 走 strategy 2 并递增计数
    const ctx = () => ({
      partialText: "",
      interruptedInThinking: false,
      interruptedInToolCall: true,
      truncatedByLength: false,
      toolCallsThisTurn: ["shell_exec"],
      hasPriorTurnContent: false,
      retryCount: 0,
    });
    m.recover(ctx()); // count=1 → 2×
    expect(m.getMaxTokensBoost()).toBe(2);
    m.recover(ctx()); // count=2 → 4×
    expect(m.getMaxTokensBoost()).toBe(4);
    m.recover(ctx()); // count=3 → 8×
    expect(m.getMaxTokensBoost()).toBe(8);
    m.recover(ctx()); // count 已达上限 3，不再递增
    expect(m.getMaxTokensBoost()).toBe(8);
    m.recover(ctx());
    expect(m.getMaxTokensBoost()).toBe(8);
  });

  it("resetTurn 后计数清零，boost 回到 1", () => {
    const m = new StreamingRecoveryManager();
    const ctx = () => ({
      partialText: "",
      interruptedInThinking: false,
      interruptedInToolCall: true,
      truncatedByLength: false,
      toolCallsThisTurn: ["shell_exec"],
      hasPriorTurnContent: false,
      retryCount: 0,
    });
    m.recover(ctx());
    m.recover(ctx());
    expect(m.getMaxTokensBoost()).toBe(4);
    m.resetTurn();
    expect(m.getMaxTokensBoost()).toBe(1);
  });

  it("单例 getStreamingRecoveryManager 可用", () => {
    const a = getStreamingRecoveryManager();
    const b = getStreamingRecoveryManager();
    expect(a).toBe(b);
    expect(typeof a.getMaxTokensBoost).toBe("function");
  });
});