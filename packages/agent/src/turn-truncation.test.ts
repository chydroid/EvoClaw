/**
 * turn-truncation.test — 截断恢复策略测试（对标 hermes-agent agent/turn_truncation.py）
 */

import { describe, it, expect } from "vitest";
import {
  isThinkingExhausted,
  checkWindowFilled,
  checkTruncation,
  shouldContinueTruncation,
  buildContinuationNudge,
  mergeTruncatedParts,
  THINKING_EXHAUSTED_USER,
  REPETITION_DOMINATED_USER,
  CEILING_NO_TEXT,
  FIRST_TRUNCATED_FINAL,
} from "./turn-truncation";

describe("isThinkingExhausted", () => {
  it("纯 thinking 块被截断时返回 true", () => {
    expect(isThinkingExhausted("<think>reasoning here</think>")).toBe(true);
  });

  it("thinking 后无可见内容时返回 true", () => {
    expect(isThinkingExhausted("<think>reasoning here</think>")).toBe(true);
  });

  it("thinking 后有可见内容时返回 false", () => {
    expect(isThinkingExhausted("<think>reasoning</think>Here is my answer")).toBe(false);
  });

  it("无 thinking 块时返回 false", () => {
    expect(isThinkingExhausted("Here is my answer")).toBe(false);
  });

  it("空字符串返回 false", () => {
    expect(isThinkingExhausted("")).toBe(false);
  });

  it("未闭合 thinking 块返回 true", () => {
    expect(isThinkingExhausted("<think>reasoning not closed")).toBe(true);
  });
});

describe("checkWindowFilled", () => {
  it("剩余空间不足时返回元组", () => {
    expect(checkWindowFilled(99500, 100000)).not.toBeNull();
    expect(checkWindowFilled(99500, 100000)).toEqual([99500, 100000]);
  });

  it("剩余空间充足时返回 null", () => {
    expect(checkWindowFilled(50000, 100000)).toBeNull();
  });

  it("零值返回 null", () => {
    expect(checkWindowFilled(0, 100000)).toBeNull();
    expect(checkWindowFilled(50000, 0)).toBeNull();
  });

  it("NaN 返回 null", () => {
    expect(checkWindowFilled(NaN, 100000)).toBeNull();
    expect(checkWindowFilled(50000, NaN)).toBeNull();
  });
});

describe("checkTruncation", () => {
  it("正常 length 截断返回 continue", () => {
    const result = checkTruncation({
      content: "Some partial response text",
      hasToolCalls: false,
      promptTokens: 10000,
      contextLength: 100000,
      runawayRepetition: false,
      overflowTerminal: false,
      lengthContinueRetries: 0,
      partialText: "Some partial response text",
    });
    expect(result.action).toBe("continue");
    expect(result.failed).toBe(false);
  });

  it("流式重复检测返回 abort_repetition", () => {
    const result = checkTruncation({
      content: "text",
      hasToolCalls: false,
      promptTokens: 10000,
      contextLength: 100000,
      runawayRepetition: true,
      overflowTerminal: false,
      lengthContinueRetries: 0,
      partialText: "text",
    });
    expect(result.action).toBe("abort_repetition");
    expect(result.userMessage).toContain("Repetition");
  });

  it("上下文溢出终态返回 abort_overflow", () => {
    const result = checkTruncation({
      content: "",
      hasToolCalls: false,
      promptTokens: 99000,
      contextLength: 100000,
      runawayRepetition: false,
      overflowTerminal: true,
      lengthContinueRetries: 0,
      partialText: "",
    });
    expect(result.action).toBe("abort_overflow");
    expect(result.failed).toBe(true);
    expect(result.compressionExhausted).toBe(true);
    expect(result.failureReason).toBe("context_overflow");
  });

  it("thinking 耗尽返回 abort_thinking", () => {
    const result = checkTruncation({
      content: "<think>reasoning here</think>",
      hasToolCalls: false,
      promptTokens: 10000,
      contextLength: 100000,
      runawayRepetition: false,
      overflowTerminal: false,
      lengthContinueRetries: 0,
      partialText: "<think>reasoning here</think>",
    });
    expect(result.action).toBe("abort_thinking");
    expect(result.userMessage).toContain("Thinking Budget Exhausted");
  });

  it("窗口填满返回 abort_window", () => {
    const result = checkTruncation({
      content: "Some text",
      hasToolCalls: false,
      promptTokens: 99500,
      contextLength: 100000,
      runawayRepetition: false,
      overflowTerminal: false,
      lengthContinueRetries: 0,
      partialText: "Some text",
    });
    expect(result.action).toBe("abort_window");
    expect(result.userMessage).toContain("Context window full");
  });

  it("续写上限返回 abort_ceiling", () => {
    const result = checkTruncation({
      content: "Some text",
      hasToolCalls: false,
      promptTokens: 10000,
      contextLength: 100000,
      runawayRepetition: false,
      overflowTerminal: false,
      lengthContinueRetries: 4,
      partialText: "Some text",
    });
    expect(result.action).toBe("abort_ceiling");
    expect(result.userMessage).toContain("No visible answer");
  });

  it("首次截断且无工具调用返回 abort_first", () => {
    const result = checkTruncation({
      content: "",
      hasToolCalls: false,
      promptTokens: 10000,
      contextLength: 100000,
      runawayRepetition: false,
      overflowTerminal: false,
      lengthContinueRetries: 0,
      partialText: "",
    });
    expect(result.action).toBe("abort_first");
    expect(result.failed).toBe(true);
    expect(result.failureReason).toBe("truncated");
  });

  it("首次截断但有工具调用返回 continue", () => {
    const result = checkTruncation({
      content: "",
      hasToolCalls: true,
      promptTokens: 10000,
      contextLength: 100000,
      runawayRepetition: false,
      overflowTerminal: false,
      lengthContinueRetries: 0,
      partialText: "",
    });
    expect(result.action).toBe("continue");
  });
});

describe("shouldContinueTruncation", () => {
  it("正常截断返回 true", () => {
    expect(shouldContinueTruncation({
      content: "text",
      hasToolCalls: false,
      promptTokens: 10000,
      contextLength: 100000,
      runawayRepetition: false,
      overflowTerminal: false,
      lengthContinueRetries: 0,
      partialText: "text",
    })).toBe(true);
  });

  it("thinking 耗尽返回 false", () => {
    expect(shouldContinueTruncation({
      content: "<think>reasoning</think>",
      hasToolCalls: false,
      promptTokens: 10000,
      contextLength: 100000,
      runawayRepetition: false,
      overflowTerminal: false,
      lengthContinueRetries: 0,
      partialText: "<think>reasoning</think>",
    })).toBe(false);
  });
});

describe("buildContinuationNudge", () => {
  it("返回包含截断提示的 nudge", () => {
    const nudge = buildContinuationNudge();
    expect(nudge).toContain("truncated");
    expect(nudge).toContain("Continue directly");
    expect(nudge).toContain("do not repeat");
  });
});

describe("mergeTruncatedParts", () => {
  it("合并多段文本", () => {
    const result = mergeTruncatedParts(["Hello ", "world", "!"]);
    expect(result).toBe("Hello world!");
  });

  it("去除 thinking 块", () => {
    const result = mergeTruncatedParts(["<think>reasoning</think>", "Visible text"]);
    expect(result).toBe("Visible text");
  });

  it("空数组返回空字符串", () => {
    expect(mergeTruncatedParts([])).toBe("");
  });
});

describe("文案常量", () => {
  it("THINKING_EXHAUSTED_USER 包含降低推理努力的建议", () => {
    expect(THINKING_EXHAUSTED_USER).toContain("/reasoning low");
  });

  it("REPETITION_DOMINATED_USER 包含切换模型的建议", () => {
    expect(REPETITION_DOMINATED_USER).toContain("/model");
  });

  it("CEILING_NO_TEXT 包含无可见答案说明", () => {
    expect(CEILING_NO_TEXT).toContain("No visible answer");
  });

  it("FIRST_TRUNCATED_FINAL 包含失败说明", () => {
    expect(FIRST_TRUNCATED_FINAL).toContain("First response truncated");
  });
});
