import { describe, it, expect } from "vitest";
import { closeInterruptedToolSequence, type SessionPersistenceDeps, type SessionHistoryEntry } from "../src/session-persistence";

function makeDeps(history: SessionHistoryEntry[]): SessionPersistenceDeps {
  const map = new Map<string, SessionHistoryEntry[]>();
  map.set("test-session", history);
  return {
    sessionDataDir: "",
    sessionPersistenceEnabled: true,
    autoCompactionEnabled: false,
    compactionTokenThreshold: 100_000,
    conversationHistory: map,
    compactionManager: null,
    lifecycleManager: null,
    sessionManager: null,
    memoryHub: null,
  };
}

describe("fix-2: closeInterruptedToolSequence", () => {
  it("should return 0 for empty history", () => {
    const deps = makeDeps([]);
    expect(closeInterruptedToolSequence(deps, "test-session")).toBe(0);
  });

  it("should return 0 for non-existent session", () => {
    const deps = makeDeps([]);
    expect(closeInterruptedToolSequence(deps, "missing-session")).toBe(0);
  });

  it("should return 0 when last assistant has no tool_calls", () => {
    const deps = makeDeps([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    expect(closeInterruptedToolSequence(deps, "test-session")).toBe(0);
  });

  it("should return 0 when tool_calls already have responses", () => {
    const deps = makeDeps([
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "file_list", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "tc1", name: "file_list", content: "[]" },
    ]);
    expect(closeInterruptedToolSequence(deps, "test-session")).toBe(0);
  });

  it("should return 0 when last message is user (new turn started)", () => {
    const deps = makeDeps([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "file_list", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "tc1", name: "file_list", content: "[]" },
      { role: "user", content: "next question" },
    ]);
    expect(closeInterruptedToolSequence(deps, "test-session")).toBe(0);
  });

  it("should append synthetic tool message for orphan tool_call", () => {
    const deps = makeDeps([
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "file_list", arguments: "{}" } },
        ],
      },
    ]);
    const count = closeInterruptedToolSequence(deps, "test-session");
    expect(count).toBe(1);
    const history = deps.conversationHistory.get("test-session")!;
    expect(history.length).toBe(3);
    expect(history[2].role).toBe("tool");
    expect(history[2].tool_call_id).toBe("tc1");
    expect(history[2].name).toBe("file_list");
    // content should be JSON with error: "interrupted"
    const parsed = JSON.parse(history[2].content!);
    expect(parsed.error).toBe("interrupted");
    expect(parsed.reason).toContain("interrupted");
  });

  it("should append synthetic messages for multiple orphan tool_calls", () => {
    const deps = makeDeps([
      { role: "user", content: "do multiple things" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "file_list", arguments: "{}" } },
          { id: "tc2", type: "function", function: { name: "file_read", arguments: "{}" } },
          { id: "tc3", type: "function", function: { name: "shell_exec", arguments: "{}" } },
        ],
      },
    ]);
    const count = closeInterruptedToolSequence(deps, "test-session");
    expect(count).toBe(3);
    const history = deps.conversationHistory.get("test-session")!;
    expect(history.length).toBe(5); // user + assistant + 3 synthetic
    expect(history[2].tool_call_id).toBe("tc1");
    expect(history[3].tool_call_id).toBe("tc2");
    expect(history[4].tool_call_id).toBe("tc3");
  });

  it("should only append missing tool_call responses (partial response case)", () => {
    const deps = makeDeps([
      { role: "user", content: "do multiple things" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "file_list", arguments: "{}" } },
          { id: "tc2", type: "function", function: { name: "file_read", arguments: "{}" } },
        ],
      },
      // 只有 tc1 有响应，tc2 缺失
      { role: "tool", tool_call_id: "tc1", name: "file_list", content: "[]" },
    ]);
    const count = closeInterruptedToolSequence(deps, "test-session");
    expect(count).toBe(1);
    const history = deps.conversationHistory.get("test-session")!;
    expect(history.length).toBe(4);
    expect(history[3].tool_call_id).toBe("tc2");
  });

  it("should handle missing function name gracefully", () => {
    const deps = makeDeps([
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "", arguments: "{}" } },
        ],
      },
    ]);
    const count = closeInterruptedToolSequence(deps, "test-session");
    expect(count).toBe(1);
    const history = deps.conversationHistory.get("test-session")!;
    expect(history[2].name).toBe("unknown");
  });

  it("should be idempotent (calling twice should not duplicate)", () => {
    const deps = makeDeps([
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "file_list", arguments: "{}" } },
        ],
      },
    ]);
    // 第一次调用：应该追加 1 个合成消息
    expect(closeInterruptedToolSequence(deps, "test-session")).toBe(1);
    // 第二次调用：应该返回 0（已有响应）
    expect(closeInterruptedToolSequence(deps, "test-session")).toBe(0);
    const history = deps.conversationHistory.get("test-session")!;
    expect(history.length).toBe(3); // 不应该有重复
  });
});
