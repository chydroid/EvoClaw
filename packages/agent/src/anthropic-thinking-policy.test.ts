/**
 * anthropic-thinking-policy 单测（对齐 Hermes anthropic_thinking_policy.py）。
 *
 * 覆盖：
 * - claude 家族版本解析（语义 minor / 快照日期 / 版本尾置）
 * - modelPreservesPriorThinking（4.5+/4.6+/5.5+ 保留；3.x 剥离；非 claude false；未知默认 true）
 * - anthropicThinkingRoute（native/minimax/kimi/deepseek/third_party）
 * - shouldReplayPriorThinking 决策矩阵
 */
import { describe, it, expect } from "vitest";
import {
  claudeFamilyVersion,
  modelPreservesPriorThinking,
  anthropicThinkingRoute,
  routeReplaysPriorThinking,
  shouldReplayPriorThinking,
} from "./anthropic-thinking-policy";

describe("anthropic-thinking-policy > claudeFamilyVersion", () => {
  it("标准语义 minor id", () => {
    expect(claudeFamilyVersion("claude-opus-4-5")).toEqual({ family: "opus", version: [4, 5] });
    expect(claudeFamilyVersion("claude-sonnet-4-6")).toEqual({ family: "sonnet", version: [4, 6] });
    expect(claudeFamilyVersion("claude-haiku-5-5")).toEqual({ family: "haiku", version: [5, 5] });
  });
  it("快照日期后缀不污染 minor（claude-opus-4-20250514 记为 4.0）", () => {
    expect(claudeFamilyVersion("claude-opus-4-20250514")).toEqual({ family: "opus", version: [4, 0] });
  });
  it("点号/下划线分隔；version-last 形态（claude-3-5-haiku）不可解析", () => {
    expect(claudeFamilyVersion("claude.opus.4.6")).toEqual({ family: "opus", version: [4, 6] });
    expect(claudeFamilyVersion("claude-3-5-haiku")).toBeNull();
    expect(claudeFamilyVersion("claude_3_5_haiku")).toBeNull();
  });
  it("非 claude / 不可解析 → null", () => {
    expect(claudeFamilyVersion("gpt-4o")).toBeNull();
    expect(claudeFamilyVersion(undefined)).toBeNull();
    expect(claudeFamilyVersion(42)).toBeNull();
  });
});

describe("anthropic-thinking-policy > modelPreservesPriorThinking", () => {
  it("保留边界：opus 4.5+ / sonnet 4.6+ / haiku 5.5+", () => {
    expect(modelPreservesPriorThinking("claude-opus-4-5")).toBe(true);
    expect(modelPreservesPriorThinking("claude-opus-4-6")).toBe(true);
    expect(modelPreservesPriorThinking("claude-sonnet-4-6")).toBe(true);
    expect(modelPreservesPriorThinking("claude-haiku-5-5")).toBe(true);
    expect(modelPreservesPriorThinking("claude-haiku-5-6")).toBe(true);
  });
  it("边界以下剥离：opus 4.4 / sonnet 4.1 / haiku 5.4", () => {
    expect(modelPreservesPriorThinking("claude-opus-4-4")).toBe(false);
    expect(modelPreservesPriorThinking("claude-sonnet-4-1")).toBe(false);
    expect(modelPreservesPriorThinking("claude-haiku-5-4")).toBe(false);
  });
  it("Claude 3.x 一律剥离（含 version-last 形态）", () => {
    expect(modelPreservesPriorThinking("claude-3")).toBe(false);
    expect(modelPreservesPriorThinking("claude-3-5-haiku")).toBe(false);
    expect(modelPreservesPriorThinking("claude-3.5-sonnet")).toBe(false);
  });
  it("非 claude 一律 false；未知 claude 家族默认保留", () => {
    expect(modelPreservesPriorThinking("gpt-4o")).toBe(false);
    expect(modelPreservesPriorThinking("deepseek-reasoner")).toBe(false);
    expect(modelPreservesPriorThinking(null)).toBe(false);
    expect(modelPreservesPriorThinking("claude-fable-5-1")).toBe(true);
    expect(modelPreservesPriorThinking("claude-opus-4-20250514")).toBe(false);
  });
});

describe("anthropic-thinking-policy > anthropicThinkingRoute", () => {
  it("native：Anthropic 官方 / Bedrock / Nous Portal", () => {
    expect(anthropicThinkingRoute("https://api.anthropic.com/v1/messages", "claude-opus-4-5")).toBe("native");
    expect(anthropicThinkingRoute("https://bedrock-runtime.amazonaws.com/v1/messages", "claude-sonnet-4-6")).toBe("native");
    expect(anthropicThinkingRoute("https://us.anthropic.bedrock.smith", "m")).toBe("native");
    expect(anthropicThinkingRoute("https://inference-api.nousresearch.com/v1/messages", "m")).toBe("native");
    expect(anthropicThinkingRoute("https://c.us.anthropic.ai/v1/messages", "claude-opus-4-5")).toBe("native");
  });
  it("minimax / kimi / deepseek 专属契约", () => {
    expect(anthropicThinkingRoute("https://api.minimaxi.com/anthropic/v1/messages", "m")).toBe("minimax");
    expect(anthropicThinkingRoute("https://api.moonshot.cn/v1/messages", "m")).toBe("kimi");
    expect(anthropicThinkingRoute("https://relay.example.com/v1/messages", "deepseek-reasoner")).toBe("deepseek");
  });
  it("未知中继（含 OpenAI 兼容网关）→ third_party", () => {
    expect(anthropicThinkingRoute("https://relay.example.com/v1/messages", "claude-opus-4-5")).toBe("third_party");
    expect(anthropicThinkingRoute("not-a-url", "m")).toBe("third_party");
  });
});

describe("anthropic-thinking-policy > 重放决策矩阵", () => {
  it("minimax 无论模型一律重放；native 按模型能力", () => {
    expect(routeReplaysPriorThinking("minimax", "anything")).toBe(true);
    expect(routeReplaysPriorThinking("native", "claude-opus-4-5")).toBe(true);
    expect(routeReplaysPriorThinking("native", "claude-opus-4-4")).toBe(false);
    expect(routeReplaysPriorThinking("third_party", "claude-opus-4-5")).toBe(false);
    expect(routeReplaysPriorThinking("kimi", "claude-opus-4-5")).toBe(false);
    expect(routeReplaysPriorThinking("deepseek", "claude-opus-4-5")).toBe(false);
  });
  it("一站式：production gateway + claude → false（剥离保签名安全）", () => {
    expect(shouldReplayPriorThinking("https://gateway.example.com/anthropic", "claude-opus-4-5")).toBe(false);
    expect(shouldReplayPriorThinking("https://api.anthropic.com", "claude-opus-4-5")).toBe(true);
    expect(shouldReplayPriorThinking("https://api.anthropic.com", "claude-3-5-haiku")).toBe(false);
  });
});
