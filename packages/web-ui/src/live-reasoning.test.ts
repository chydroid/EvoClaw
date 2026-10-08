/**
 * 实时推理（live reasoning）单测
 *
 * 对应真实事故（2026-10-08，小米 mimo 模型）：
 * 用户展开执行过程看到的只有铺天盖地的「正在生成回复...」，
 * 却看不到大模型的思考与分析过程。
 */
import { describe, it, expect } from "vitest";
import {
  mergeLiveReasoning,
  isNoiseProgressStep,
  pickThinkingSummary,
  tailText,
  type LiveThinkingStep,
} from "./live-reasoning";

describe("mergeLiveReasoning — 流式推理合并进轨迹", () => {
  it("★ 末条是本轮 reasoning → 就地替换，不新增条目", () => {
    let trace: LiveThinkingStep[] = [{ kind: "reasoning", title: "这是一个", detail: "这是一个", round: 1 }];
    trace = mergeLiveReasoning(trace, "这是一个非常有趣的问题", 1);
    expect(trace).toHaveLength(1);
    expect(trace[0].detail).toBe("这是一个非常有趣的问题");
  });

  it("★ 没有 reasoning 条目 → 追加一条", () => {
    const trace = mergeLiveReasoning(
      [{ kind: "decision", title: "决定调用 file_read" }],
      "我得先看看文件",
      1,
    );
    expect(trace).toHaveLength(2);
    expect(trace[1].kind).toBe("reasoning");
    expect(trace[1].detail).toBe("我得先看看文件");
  });

  it("★ 轮次不同 → 不合并（新一轮的思考另起一条）", () => {
    const base: LiveThinkingStep[] = [{ kind: "reasoning", title: "第一轮", detail: "第一轮想", round: 1 }];
    const trace = mergeLiveReasoning(base, "第二轮想", 2);
    expect(trace).toHaveLength(2);
    expect(trace[1].detail).toBe("第二轮想");
  });

  it("★ 已截断的条目不再被改写（否则标注与实际长度不符）", () => {
    const base: LiveThinkingStep[] = [
      { kind: "reasoning", title: "x", detail: "已截断内容", round: 1, truncated: true },
    ];
    const trace = mergeLiveReasoning(base, "新来的推理", 1);
    expect(trace).toHaveLength(2);
    expect(trace[0].detail).toBe("已截断内容");
  });

  it("★ 空文本 / 空轨迹都不炸", () => {
    expect(mergeLiveReasoning(undefined, "", 1)).toEqual([]);
    expect(mergeLiveReasoning(undefined, "只有文本", 1)[0].detail).toBe("只有文本");
  });

  it("★ title 取累积文本首行（不是第一个 chunk 那几个字）", () => {
    const trace = mergeLiveReasoning(undefined, "嗯\n先确认文件是否存在", 1);
    expect(trace[0].title).toBe("嗯");
  });
});

describe("isNoiseProgressStep — 刷屏噪声过滤", () => {
  it("★ token 事件一律视为噪声", () => {
    expect(isNoiseProgressStep({ type: "token", phase: "generating", detail: "正在生成回复..." })).toBe(true);
  });

  it("★ status + generating 视为噪声（每 50ms 一条，detail 恒为占位文案）", () => {
    expect(isNoiseProgressStep({ type: "status", phase: "generating", detail: "正在生成回复..." })).toBe(true);
  });

  it("★ 真正有信息的事件保留", () => {
    expect(isNoiseProgressStep({ type: "tool_call", phase: "tool_calling", detail: "🔧 file_read" })).toBe(false);
    expect(isNoiseProgressStep({ type: "tool_result", phase: "tool_calling", detail: "file_read 执行完成" })).toBe(false);
    expect(isNoiseProgressStep({ type: "llm_call", phase: "thinking", detail: "正在调用 小米 MiMo" })).toBe(false);
    expect(isNoiseProgressStep({ type: "reasoning", phase: "thinking", detail: "模型思考中…" })).toBe(false);
  });

  it("★ 保底：detail 就是占位文案的一律过滤（换个 type 也逃不掉）", () => {
    expect(isNoiseProgressStep({ type: "whatever", detail: "正在生成回复..." })).toBe(true);
  });
});

describe("pickThinkingSummary — 折叠摘要优先取推理原文", () => {
  it("★ 推理不在首位时也要取到它（旧实现只取 steps[0]，结果摘要是动作描述）", () => {
    const steps: LiveThinkingStep[] = [
      { kind: "system", title: "自动续跑 #1" },
      { kind: "decision", title: "决定调用 shell_exec" },
      { kind: "reasoning", title: "让我换个思路", detail: "我先确认目录结构再决定怎么改" },
    ];
    expect(pickThinkingSummary(steps, 30)).toContain("我先确认目录结构");
  });

  it("★ 没有推理时退回首条标题", () => {
    const steps: LiveThinkingStep[] = [{ kind: "decision", title: "决定调用 file_read" }];
    expect(pickThinkingSummary(steps)).toBe("决定调用 file_read");
  });

  it("★ 空轨迹返回空串", () => {
    expect(pickThinkingSummary(undefined)).toBe("");
    expect(pickThinkingSummary([])).toBe("");
  });
});

describe("tailText — 实时预览只取尾部", () => {
  it("★ 短文本原样返回", () => {
    expect(tailText("abc", 10)).toBe("abc");
  });
  it("★ 长文本只留尾部并加省略号", () => {
    const r = tailText("0123456789", 4);
    expect(r).toBe("…6789");
    expect(r.length).toBeLessThanOrEqual(5);
  });
});
