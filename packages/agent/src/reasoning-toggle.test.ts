/**
 * 推理开关：让不同大模型都能吐出思考原文。
 *
 * 背景（2026-10-08，用户诉求「要适应不同的大模型都能够显示出来」）：
 * 实测抓原始 SSE 流发现 mimo-v2.6-flash 默认只给 7 字推理，
 * 加 enable_thinking 给 50 字、加 reasoning_effort 给 68 字；
 * agnes-3.0-flash 则一个字段都不给。系统此前从不传任何推理开关，
 * 等于把模型已有的能力丢掉 —— 这才是轨迹里几乎没有 reasoning 的真正原因。
 */
import { describe, it, expect } from "vitest";
import { applyReasoningToggle, pickReasoningToggle } from "./reasoning-toggle";

describe("pickReasoningToggle —— 按 provider 选对开关", () => {
  it("MiMo / Qwen 系用 enable_thinking（实测最有效）", () => {
    expect(pickReasoningToggle({ id: "xiaomi-mimo", model: "mimo-v2.6-flash" })).toEqual({
      kind: "enable_thinking",
      value: true,
    });
    expect(pickReasoningToggle({ id: "qwen", model: "qwen3-max" }).kind).toBe("enable_thinking");
    expect(pickReasoningToggle({ name: "GLM-5.1", model: "glm-5.1" }).kind).toBe("enable_thinking");
  });

  it("OpenAI / Anthropic 系用 reasoning_effort", () => {
    expect(pickReasoningToggle({ id: "openai", model: "gpt-5" })).toEqual({
      kind: "reasoning_effort",
      value: "high",
    });
    expect(pickReasoningToggle({ name: "Claude Sonnet", model: "claude-4" }).kind).toBe("reasoning_effort");
  });

  it("DeepSeek 不重复加开关（调用方已单独发 reasoning_type）", () => {
    expect(pickReasoningToggle({ id: "deepseek", model: "deepseek-v4.1-flash" }).kind).toBe("none");
    expect(pickReasoningToggle({ name: "DeepSeek Chat" }).kind).toBe("none");
  });

  it("不认识 / 不支持推理的 provider 返回 none，不乱加参数", () => {
    expect(pickReasoningToggle({ id: "custom-1791190214796-1", model: "agnes-3.0-flash" }).kind).toBe("none");
    expect(pickReasoningToggle({}).kind).toBe("none");
    expect(pickReasoningToggle({ name: "", model: "" }).kind).toBe("none");
  });

  it("大小写与分隔符不影响识别", () => {
    expect(pickReasoningToggle({ model: "MIMO-V2.6-Flash" }).kind).toBe("enable_thinking");
    expect(pickReasoningToggle({ model: "qwen 3 max" }).kind).toBe("enable_thinking");
  });
});

describe("applyReasoningToggle —— 写进请求体", () => {
  it("支持推理的 provider 会被加上开关", () => {
    const b = applyReasoningToggle({}, { id: "xiaomi-mimo", model: "mimo-v2.6-flash" });
    expect(b.enable_thinking).toBe(true);
  });

  it("不支持的 provider 请求体保持原样（不引入未知字段）", () => {
    const b = applyReasoningToggle({ model: "x", stream: true }, { model: "agnes-3.0-flash" });
    expect(b).toEqual({ model: "x", stream: true });
    expect("enable_thinking" in b).toBe(false);
    expect("reasoning_effort" in b).toBe(false);
  });

  it("不覆盖调用方已显式设置的值", () => {
    const b = applyReasoningToggle({ enable_thinking: false }, { model: "mimo-v2.6-flash" });
    expect(b.enable_thinking).toBe(false);
  });

  it("保留原有字段，不破坏 tools / stream 等", () => {
    const b = applyReasoningToggle(
      { model: "mimo-v2.6-flash", stream: true, tools: [{ name: "shell_exec" }] },
      { model: "mimo-v2.6-flash" }
    );
    expect(b.model).toBe("mimo-v2.6-flash");
    expect(b.stream).toBe(true);
    expect(Array.isArray(b.tools)).toBe(true);
    expect(b.enable_thinking).toBe(true);
  });
});
