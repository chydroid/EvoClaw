/**
 * 回归测试：历史消息加载必须保留思考轨迹。
 *
 * 用户反馈（2026-10-08）：「任务完成后我在结果里找不到完成任务的过程。」
 * 根因不在后端 —— 后端接口已返回 thinkingTrace / thinkingSummary，
 * 但前端加载历史时只取 role/content/timestamp，把这两个字段静默丢弃。
 */
import { describe, it, expect } from "vitest";
import { mapSessionTurnsToMessages, type ThinkingStep } from "./thinking-trace-mapping";

const trace: ThinkingStep[] = [
  { kind: "reasoning", title: "先看 data/workspace 有哪些文件", detail: "用户要统计 .md 数量……", at: 1 },
  { kind: "decision", title: "决定调用 shell_exec", detail: '{"command":"ls"}', at: 2 },
  { kind: "tool_result", title: "shell_exec 返回", detail: "a.md\nb.md", at: 3 },
];

describe("mapSessionTurnsToMessages —— 思考轨迹保留", () => {
  it("保留 thinkingTrace —— 这正是之前被静默丢弃的字段", () => {
    const [msg] = mapSessionTurnsToMessages(
      [{ role: "assistant", content: "共 2 个", timestamp: "2026-10-08T00:00:00Z", thinkingTrace: trace }],
      "web-ui"
    );
    expect(msg.thinkingTrace).toBeDefined();
    expect(msg.thinkingTrace).toHaveLength(3);
    expect(msg.thinkingTrace![0].kind).toBe("reasoning");
    expect(msg.thinkingTrace![1].detail).toBe('{"command":"ls"}');
    expect(msg.thinkingTrace![2].detail).toBe("a.md\nb.md");
  });

  it("保留 thinkingSummary（折叠态那一行摘要）", () => {
    const [msg] = mapSessionTurnsToMessages(
      [{ role: "assistant", content: "done", thinkingTrace: trace, thinkingSummary: "决定调用 shell_exec" }],
      "web-ui"
    );
    expect(msg.thinkingSummary).toBe("决定调用 shell_exec");
  });

  it("用户消息（无轨迹）不产生空字段", () => {
    const [msg] = mapSessionTurnsToMessages([{ role: "user", content: "统计 .md 数量" }], "web-ui");
    expect(msg.thinkingTrace).toBeUndefined();
    expect(msg.thinkingSummary).toBeUndefined();
  });

  it("空轨迹数组视为无轨迹，不渲染空面板", () => {
    const [msg] = mapSessionTurnsToMessages(
      [{ role: "assistant", content: "done", thinkingTrace: [], thinkingSummary: "" }],
      "web-ui"
    );
    expect(msg.thinkingTrace).toBeUndefined();
    expect(msg.thinkingSummary).toBeUndefined();
  });

  it("保留基础字段并生成稳定 id", () => {
    const msgs = mapSessionTurnsToMessages(
      [
        { role: "user", content: "hi", timestamp: "2026-10-08T00:00:00Z" },
        { role: "assistant", content: "yo", thinkingTrace: trace },
      ],
      "sess_abc"
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).toBe("sess_abc-t0");
    expect(msgs[1].id).toBe("sess_abc-t1");
    expect(msgs[0].content).toBe("hi");
    expect(msgs[1].thinkingTrace).toHaveLength(3);
  });

  it("缺少 role/content/timestamp 时有安全兜底", () => {
    const [msg] = mapSessionTurnsToMessages([{}], "s");
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("");
    expect(typeof msg.timestamp).toBe("string");
  });

  it("多轮消息各自保留自己的轨迹，不串轮", () => {
    const msgs = mapSessionTurnsToMessages(
      [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1", thinkingTrace: trace.slice(0, 1), thinkingSummary: "s1" },
        { role: "user", content: "q2" },
        {
          role: "assistant",
          content: "a2",
          thinkingTrace: [trace[0], trace[1], trace[2], { kind: "error", title: "失败" }],
          thinkingSummary: "s2",
        },
      ],
      "s"
    );
    expect(msgs[1].thinkingTrace).toHaveLength(1);
    expect(msgs[1].thinkingSummary).toBe("s1");
    expect(msgs[3].thinkingTrace).toHaveLength(4);
    expect(msgs[3].thinkingSummary).toBe("s2");
    expect(msgs[2].thinkingTrace).toBeUndefined();
  });
});
