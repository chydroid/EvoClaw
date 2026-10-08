import { describe, it, expect } from "vitest";
import { ThinkingTrace, MAX_TITLE_CHARS, MAX_DETAIL_CHARS } from "./thinking-trace";
import { StreamingTagScrubber } from "./llm-caller";

/**
 * 回归：思考过程必须被完整保留。
 *
 * 真实事故（2026-10-08，用户原话）：
 *   「任务完成后，整个思考的解决问题的过程，一点都看不到。」
 *
 * 根因之一：StreamingTagScrubber 把 `<think>/<reasoning>` 区间内容
 * **直接丢弃**，既不进正文也不留存 —— 模型的推理文本从未被捕获过。
 */
describe("StreamingTagScrubber — 推理内容不再被丢弃", () => {
  it("★ <think> 内的推理文本必须被捕获，而不是丢掉", () => {
    const s = new StreamingTagScrubber();
    const visible = s.feed("<think>我要先看看文件列表</think>好的，我来处理");
    expect(visible).toBe("好的，我来处理");
    expect(s.takeReasoning()).toContain("我要先看看文件列表");
  });

  it("★ 推理文本跨多个 delta 分片也能完整拼接", () => {
    const s = new StreamingTagScrubber();
    s.feed("<think>第一段");
    s.feed("，第二段");
    s.feed("，第三段</think>正文");
    expect(s.takeReasoning()).toBe("第一段，第二段，第三段");
  });

  it("★ <reasoning> 标签同样被捕获", () => {
    const s = new StreamingTagScrubber();
    s.feed("<reasoning>分析中</reasoning>结论");
    expect(s.takeReasoning()).toContain("分析中");
  });

  it("★ 跨 delta 的闭合标签被正确识别（不被误当作推理内容）", () => {
    const s = new StreamingTagScrubber();
    s.feed("<think>abc");
    s.feed("</think>可见文本");
    expect(s.takeReasoning()).toBe("abc");
  });

  it("★ 无推理标签时 takeReasoning 返回空串（不污染轨迹）", () => {
    const s = new StreamingTagScrubber();
    s.feed("普通回复");
    expect(s.takeReasoning()).toBe("");
  });

  it("★ takeReasoning 取走后清空累积器（不会重复计入）", () => {
    const s = new StreamingTagScrubber();
    s.feed("<think>x</think>y");
    expect(s.takeReasoning()).toBe("x");
    expect(s.takeReasoning()).toBe("");
  });

  it("★ 未闭合的推理块在 flush 时也能取到（不丢）", () => {
    const s = new StreamingTagScrubber();
    s.feed("<think>未闭合的推理");
    const flushed = s.flush();
    expect(typeof flushed).toBe("string");
    // 至少不能把推理内容混进可见输出
    expect(flushed).not.toContain("未闭合的推理");
  });
});

describe("ThinkingTrace — 轨迹采集与序列化", () => {
  it("★ 空轨迹的 summary 为空、isEmpty 为 true", () => {
    const t = new ThinkingTrace();
    expect(t.isEmpty).toBe(true);
    expect(t.summary()).toBe("");
    expect(t.toJSON()).toEqual([]);
  });

  it("★ 记录推理：标题取首行、detail 存全文", () => {
    const t = new ThinkingTrace();
    t.addReasoning("第一步：检查文件\n第二步：读取内容", 1);
    const [step] = t.toJSON();
    expect(step.kind).toBe("reasoning");
    expect(step.detail).toContain("第二步");
    expect(step.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
  });

  it("★ 记录工具决策与结果，顺序保持", () => {
    const t = new ThinkingTrace();
    t.addDecision("file_read", { path: "a.md" });
    t.addToolResult("file_read", "# 内容", { ok: true });
    t.addToolResult("shell_exec", { success: false, error: "boom" });
    const steps = t.toJSON();
    expect(steps.map((s) => s.kind)).toEqual(["decision", "tool_result", "error"]);
    expect(steps[1].ok).toBe(true);
    expect(steps[2].ok).toBe(false);
    expect(steps[2].title).toContain("失败");
  });

  it("★ ok 未显式给出时，从返回值里的 success:false 推断为失败", () => {
    const t = new ThinkingTrace();
    t.addToolResult("x", JSON.stringify({ success: false, error: "e" }));
    expect(t.toJSON()[0].kind).toBe("error");
  });

  it("★ 超长 detail 被截断并显式标注（不静默丢内容）", () => {
    const t = new ThinkingTrace();
    t.addReasoning("x".repeat(MAX_DETAIL_CHARS + 500));
    const [step] = t.toJSON();
    expect(step.truncated).toBe(true);
    expect(step.detail).toContain("已截断");
  });

  it("★ 超长 title 被截断", () => {
    const t = new ThinkingTrace();
    t.addSystem("y".repeat(MAX_TITLE_CHARS + 100));
    expect(t.toJSON()[0].title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
  });

  it("★ summary 优先用 reasoning 正文（只有推理的 detail 才有信息量）", () => {
    const t = new ThinkingTrace();
    t.addDecision("file_read", { path: "x" });
    t.addReasoning("先看看文件到底有多少内容再决定怎么读");
    expect(t.summary(30)).toBe("先看看文件到底有多少内容再决定怎么读");
  });

  it("★ 没有 reasoning 时 summary 用标题，而不是 JSON 参数", () => {
    const t = new ThinkingTrace();
    t.addDecision("file_read", { path: "x" });
    // 曾经把 {"path":"x"} 当摘要，折叠态完全看不出在干什么
    expect(t.summary(30)).toContain("file_read");
    expect(t.summary(30)).not.toContain("path");
  });

  it("★ summary 长度受 maxChars 约束", () => {
    const t = new ThinkingTrace();
    t.addReasoning("z".repeat(200));
    expect(t.summary(30).length).toBeLessThanOrEqual(31);
  });

  it("★ 循环引用不会导致序列化崩溃", () => {
    const t = new ThinkingTrace();
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    t.addDecision("t", a);
    expect(() => t.toJSON()).not.toThrow();
  });

  it("★ offsetMs 单调不减（前端可据此做时间线）", () => {
    const t = new ThinkingTrace();
    t.addSystem("一");
    t.addSystem("二");
    t.addSystem("三");
    const steps = t.toJSON();
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].offsetMs!).toBeGreaterThanOrEqual(steps[i - 1].offsetMs!);
    }
  });
});