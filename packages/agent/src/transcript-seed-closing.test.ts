import { describe, it, expect } from "vitest";
import { closeInterruptedToolSequence, type SessionPersistenceDeps, type SessionHistoryEntry } from "./session-persistence";

/** 复刻 sessionLoadFn（agent-model-executor.ts:2374-2384）的 seed 形状：
 *  只保留 user/assistant，assistant 保留 tool_calls（tool 消息被滤掉）。 */
function seedFromTranscript(turns: Array<{ role: string; content: string | null; tool_calls?: unknown }>): SessionHistoryEntry[] {
  return turns
    .filter((t) => t.role === "user" || t.role === "assistant")
    .map((t) => {
      const entry: Record<string, unknown> = { role: t.role, content: t.content };
      if (t.role === "assistant" && t.tool_calls) entry.tool_calls = t.tool_calls;
      return entry as SessionHistoryEntry;
    });
}

describe("GAP-10 复核：transcript 直载 seed → turn 起点清理覆盖", () => {
  it("seed 出的 dangling tool_calls 被 closeInterruptedToolSequence 闭合（同一张 Map）", () => {
    // transcript 末尾：assistant 带 tool_calls 但 tool response 被 seed 滤掉
    const seeded = seedFromTranscript([
      { role: "user", content: "list files" },
      { role: "assistant", content: null, tool_calls: [{ id: "tc1", type: "function", function: { name: "file_list", arguments: "{}" } }] },
    ]);
    const map = new Map<string, SessionHistoryEntry[]>();
    map.set("s1", seeded);
    const deps = { conversationHistory: map } as unknown as SessionPersistenceDeps;
    // llm-caller turn 起点（:4785）对同一 Map 执行
    const closed = closeInterruptedToolSequence(deps, "s1");
    expect(closed).toBe(1);
    const after = map.get("s1")!;
    const toolMsg = after.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("tc1");
  });

  it("seed 末尾是 user（新回合）→ 不误修（与 in-memory 路径同语义）", () => {
    const seeded = seedFromTranscript([
      { role: "assistant", content: null, tool_calls: [{ id: "tc1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "user", content: "next" },
    ]);
    const map = new Map<string, SessionHistoryEntry[]>();
    map.set("s2", seeded);
    const deps = { conversationHistory: map } as unknown as SessionPersistenceDeps;
    expect(closeInterruptedToolSequence(deps, "s2")).toBe(0);
  });
});
