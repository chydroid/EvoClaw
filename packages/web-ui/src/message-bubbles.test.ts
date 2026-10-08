/**
 * 回归测试：多气泡切分（用户最在意的问题）。
 *
 * 用户原话（2026-10-08）：「在任务执行过程中，EvoClaw 回复的输出框多次变化，
 * 下一个变化总是会冲掉上一个页面的内容。这是最要命的。」
 */
import { describe, it, expect } from "vitest";
import { applyRoundContent, shouldStartNewBubble, type Bubble } from "./message-bubbles";

const B = "bot-123";

describe("shouldStartNewBubble", () => {
  it("首轮（1）与无轮次不新建气泡", () => {
    expect(shouldStartNewBubble(1)).toBe(false);
    expect(shouldStartNewBubble(null)).toBe(false);
    expect(shouldStartNewBubble(undefined)).toBe(false);
  });

  it("第2轮起新建", () => {
    expect(shouldStartNewBubble(2)).toBe(true);
    expect(shouldStartNewBubble(5)).toBe(true);
  });
});

describe("applyRoundContent —— 下一条不冲掉上一条", () => {
  it("首轮写入当前气泡", () => {
    const prev: Bubble[] = [{ id: B, role: "assistant", content: "" }];
    const r = applyRoundContent(prev, { botMsgId: B, activeBubbleId: B, roundIndex: 1, reply: "第一轮" });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].content).toBe("第一轮");
    expect(r.activeBubbleId).toBe(B);
  });

  it("第2轮新建气泡，**第1轮内容原样保留**", () => {
    const prev: Bubble[] = [{ id: B, role: "assistant", content: "第一轮" }];
    const r = applyRoundContent(prev, { botMsgId: B, activeBubbleId: B, roundIndex: 2, reply: "第二轮" });
    expect(r.messages).toHaveLength(2);
    // ★ 核心断言：第一轮内容没被冲掉
    expect(r.messages[0].content).toBe("第一轮");
    expect(r.messages[1].content).toBe("第二轮");
    expect(r.activeBubbleId).toBe(`${B}-r2`);
  });

  it("★ 不给旧气泡改名（自检发现的 bug）", () => {
    // 旧实现把上一轮改名成 -r(N-1)，但首轮 id 是裸 botMsgId，命名不一致；
    // 且改名会打断 showThinking 等按 id 索引的展开状态。
    const prev: Bubble[] = [
      { id: B, role: "assistant", content: "第一轮" },
      { id: `${B}-r2`, role: "assistant", content: "第二轮" },
    ];
    const r = applyRoundContent(prev, { botMsgId: B, activeBubbleId: `${B}-r2`, roundIndex: 3, reply: "第三轮" });
    // 所有旧 id 保持不变
    expect(r.messages.map((m) => m.id)).toEqual([B, `${B}-r2`, `${B}-r3`]);
    expect(r.messages[0].content).toBe("第一轮");
    expect(r.messages[1].content).toBe("第二轮");
  });

  it("同轮重复事件幂等：只更新内容，不重复建气泡", () => {
    let cur: Bubble[] = [{ id: B, role: "assistant", content: "第一轮" }];
    let active = B;
    // 第2轮：连续多个 token 事件都带 roundIndex=2
    for (const partial of ["第", "第二", "第二轮完整"]) {
      const r = applyRoundContent(cur, { botMsgId: B, activeBubbleId: active, roundIndex: 2, reply: partial });
      cur = r.messages;
      active = r.activeBubbleId;
    }
    expect(cur).toHaveLength(2);
    expect(cur[1].content).toBe("第二轮完整");
  });

  it("第3轮：三轮内容各自独立都在", () => {
    let cur: Bubble[] = [{ id: B, role: "assistant", content: "" }];
    let active = B;
    for (const [i, txt] of ["第一轮", "第二轮", "第三轮"].entries()) {
      const r = applyRoundContent(cur, { botMsgId: B, activeBubbleId: active, roundIndex: i + 1, reply: txt });
      cur = r.messages;
      active = r.activeBubbleId;
    }
    expect(cur).toHaveLength(3);
    expect(cur.map((m) => m.content)).toEqual(["第一轮", "第二轮", "第三轮"]);
  });

  it("无 roundIndex（老后端）时退化为更新当前气泡，不新建", () => {
    const prev: Bubble[] = [{ id: B, role: "assistant", content: "旧" }];
    const r = applyRoundContent(prev, { botMsgId: B, activeBubbleId: B, roundIndex: null, reply: "新" });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].content).toBe("新");
  });

  it("首轮为空时，第2轮仍能正常新建", () => {
    const prev: Bubble[] = [{ id: B, role: "assistant", content: "" }];
    const r = applyRoundContent(prev, { botMsgId: B, activeBubbleId: B, roundIndex: 2, reply: "直接第二轮" });
    expect(r.messages).toHaveLength(2);
    expect(r.messages[1].content).toBe("直接第二轮");
  });

  it("保留扩展字段（思考轨迹等）不被丢失", () => {
    type M = Bubble & { thinkingTrace?: string[] };
    const prev: M[] = [{ id: B, role: "assistant", content: "第一轮", thinkingTrace: ["a"] }];
    const r = applyRoundContent(prev, { botMsgId: B, activeBubbleId: B, roundIndex: 2, reply: "第二轮" });
    expect((r.messages[0] as M).thinkingTrace).toEqual(["a"]);
  });
});
