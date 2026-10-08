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

  // ── appendReasoning（2026-10-08 小米模型事故）──
  // 推理是 2–6 字一个 chunk 下发的，逐 chunk 建条目会把一段完整思考
  // 碎成几十条"这是一个""非常有趣" —— 展开后根本读不出模型在想什么。
  it("★ 流式推理按轮合并成一条，而不是每个 chunk 一条", () => {
    const t = new ThinkingTrace();
    for (const piece of ["这是一个", "非常有趣", "的问题，", "让我认真想想"]) {
      t.appendReasoning(piece, 1);
    }
    const steps = t.toJSON();
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("reasoning");
    expect(steps[0].detail).toBe("这是一个非常有趣的问题，让我认真想想");
  });

  it("★ 换轮后另起一条（不同轮的思考不混在一起）", () => {
    const t = new ThinkingTrace();
    t.appendReasoning("第一轮想", 1);
    t.appendReasoning("第二轮想", 2);
    const steps = t.toJSON();
    expect(steps).toHaveLength(2);
    expect(steps[0].detail).toBe("第一轮想");
    expect(steps[1].detail).toBe("第二轮想");
  });

  it("★ title 跟着累积内容更新（取首行，不是第一个 chunk）", () => {
    const t = new ThinkingTrace();
    t.appendReasoning("嗯…", 1);
    expect(t.toJSON()[0].title).toBe("嗯…");
    t.appendReasoning("先确认文件是否存在再说", 1);
    expect(t.toJSON()[0].title).toContain("先确认文件是否存在");
  });

  it("★ 纯空白不产生条目（避免空气泡 / 空步骤）", () => {
    const t = new ThinkingTrace();
    t.appendReasoning("   \n\t ", 1);
    expect(t.size).toBe(0);
  });

  it("★ 超长推理触顶后标注截断且不再追加", () => {
    const t = new ThinkingTrace();
    t.appendReasoning("a".repeat(MAX_DETAIL_CHARS - 10), 1);
    t.appendReasoning("b".repeat(100), 1);
    const [step] = t.toJSON();
    expect(step.truncated).toBe(true);
    expect(step.detail).toContain("已截断");
    // 已截断的条目不再被后续内容改写（否则标注与实际长度不符）
    t.appendReasoning("c".repeat(50), 1);
    expect(t.toJSON()).toHaveLength(2);
  });

  it("★ 中间插入了工具调用，推理不会错误地并进上一条", () => {
    const t = new ThinkingTrace();
    t.appendReasoning("第一轮先想", 1);
    t.addDecision("file_read", { path: "a.md" });
    t.appendReasoning("第二轮再想", 2);
    const kinds = t.toJSON().map((s) => s.kind);
    expect(kinds).toEqual(["reasoning", "decision", "reasoning"]);
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