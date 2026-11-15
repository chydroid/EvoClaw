import { describe, it, expect } from "vitest";
import { IterationContextPolicy, type PolicyMessage } from "./iteration-context-policy";

/**
 * 回归：策略在 LLM 请求副本上执行，不能破坏两件事：
 *   1. system 消息（系统提示/技能段/动态尾）是缓存前缀的根基，不能被 cap；
 *   2. 截断按消息独立丢弃后，assistant.tool_calls 与 tool 响应必须成对，
 *      否则 provider 直接 400。
 */
describe("IterationContextPolicy", () => {
  it("system 消息不参与 cap，普通消息被截断", () => {
    const policy = new IterationContextPolicy({ capStartIteration: 1, capMaxMessageLength: 20 });
    const longSystem = "s".repeat(200);
    const longUser = "u".repeat(200);

    const result = policy.applyPolicy(
      [
        { role: "system", content: longSystem },
        { role: "user", content: longUser },
      ],
      1,
    );

    expect(result.messages[0]?.content).toBe(longSystem);
    expect(result.messages[1]?.content.length).toBeLessThan(longUser.length);
    expect(result.capped).toBe(true);
    expect(policy.getStats().messagesCapped).toBe(1);
  });

  it("第 2 轮起剥离技能上下文", () => {
    const policy = new IterationContextPolicy({ capStartIteration: 99 });
    const result = policy.applyPolicy(
      [
        { role: "system", content: "skills" , isSkillContext: true },
        { role: "user", content: "hi" },
      ],
      2,
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.skillsStripped).toBe(true);
    expect(policy.getStats().skillsStrippedRuns).toBe(1);
  });

  it("截断后修复 tool 配对，并保留 system 消息", () => {
    const policy = new IterationContextPolicy({
      capStartIteration: 99,
      truncateStartIteration: 1,
      truncateKeepRecent: 2,
      truncateTargetTokenBudget: 20,
    });

    const messages: PolicyMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "do it" },
      { role: "assistant", content: "call-a1", toolCalls: [{ id: "a1" }] },
      { role: "tool", content: "result-a1", toolCallId: "a1" },
      { role: "assistant", content: "call-a2", toolCalls: [{ id: "a2" }] },
      { role: "tool", content: "result-a2", toolCallId: "a2" },
      { role: "assistant", content: "done" },
    ];

    const result = policy.applyPolicy(messages, 1);
    expect(result.truncated).toBe(true);

    const roles = result.messages.map((m) => m.role);
    expect(roles[0]).toBe("system");
    expect(result.messages[0]?.content).toBe("sys");

    // 不变量：每个保留的 tool 消息都有对应被保留的 assistant tool_call
    const keptAssistantCallIds = new Set(
      result.messages.flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.id)),
    );
    for (const msg of result.messages) {
      if (msg.role === "tool") {
        expect(msg.toolCallId && keptAssistantCallIds.has(msg.toolCallId)).toBe(true);
      }
    }
    expect(policy.getStats().truncatedRuns).toBe(1);
  });
});
