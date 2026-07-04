/**
 * autoFixer 测试 — 借鉴 page-agent 的 normalizeResponse。
 */
import { describe, it, expect } from "vitest";
import { normalizeResponse, formatReflection, type LLMMessage } from "./auto-fixer";

describe("autoFixer.normalizeResponse", () => {
  it("正常 tool_calls 直接返回", () => {
    const msg: LLMMessage = {
      role: "assistant",
      tool_calls: [{
        type: "function",
        function: { name: "AgentOutput", arguments: JSON.stringify({ action: { click: { index: 1 } } }) },
      }],
    };
    const result = normalizeResponse(msg);
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].name).toBe("AgentOutput");
    expect(result.toolCalls[0].arguments.action).toEqual({ click: { index: 1 } });
    expect(result.fixes.length).toBe(0);
  });

  it("修复 1：从 content 提取 JSON（无 tool_calls）", () => {
    const msg: LLMMessage = {
      role: "assistant",
      content: 'I will click the button. {"action": {"click": {"index": 3}}}',
    };
    const result = normalizeResponse(msg, "AgentOutput", ["click", "input_text"]);
    expect(result.toolCalls.length).toBe(1);
    expect(result.fixes).toContain("extract_json_from_content");
  });

  it("修复 2：把 action 名当 tool name 调用", () => {
    const msg: LLMMessage = {
      role: "assistant",
      tool_calls: [{
        type: "function",
        function: { name: "click", arguments: JSON.stringify({ index: 5 }) },
      }],
    };
    const result = normalizeResponse(msg, "AgentOutput", ["click", "input_text"]);
    expect(result.toolCalls[0].name).toBe("AgentOutput");
    expect(result.fixes.some((f) => f.startsWith("rewrap_action_as_"))).toBe(true);
  });

  it("修复 3：解开 AgentOutput 包装层", () => {
    const msg: LLMMessage = {
      role: "assistant",
      tool_calls: [{
        type: "function",
        function: {
          name: "AgentOutput",
          arguments: JSON.stringify({ AgentOutput: { action: { click: { index: 2 } } } }),
        },
      }],
    };
    const result = normalizeResponse(msg);
    expect(result.fixes).toContain("unwrap_agent_output_wrapper");
    expect((result.toolCalls[0].arguments as { action: { click: { index: number } } }).action.click.index).toBe(2);
  });

  it("修复 5：arguments 被双重 stringify", () => {
    const inner = JSON.stringify({ action: { click: { index: 4 } } });
    const msg: LLMMessage = {
      role: "assistant",
      tool_calls: [{
        type: "function",
        function: { name: "AgentOutput", arguments: JSON.stringify(inner) },
      }],
    };
    const result = normalizeResponse(msg);
    expect(result.toolCalls[0].arguments.action).toBeDefined();
  });

  it("修复 7：完全缺 action，兜底 wait", () => {
    const msg: LLMMessage = {
      role: "assistant",
      content: '{"memory": "thinking..."}',
    };
    const result = normalizeResponse(msg, "AgentOutput");
    expect(result.toolCalls.length).toBe(1);
    expect(result.fixes).toContain("fallback_to_wait_action");
  });

  it("无 tool_calls 且无 content JSON 时返回空", () => {
    const msg: LLMMessage = {
      role: "assistant",
      content: "Sorry, I can't help with that.",
    };
    const result = normalizeResponse(msg, "AgentOutput");
    expect(result.toolCalls.length).toBe(0);
  });
});

describe("autoFixer.formatReflection", () => {
  it("格式化反思字段为多行文本", () => {
    const text = formatReflection({
      evaluationPreviousGoal: "Success - clicked",
      memory: "已找到按钮",
      nextGoal: "输入用户名",
    });
    expect(text).toContain("✅");
    expect(text).toContain("💾");
    expect(text).toContain("🎯");
    expect(text).toContain("clicked");
    expect(text).toContain("输入用户名");
  });

  it("缺失字段被跳过", () => {
    const text = formatReflection({ nextGoal: "do something" });
    expect(text).not.toContain("✅");
    expect(text).toContain("🎯");
  });
});
