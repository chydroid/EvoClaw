import { describe, it, expect } from "vitest";
import {
  compactConversationHistory,
  needsCompaction,
  getUsageAnchorRegistry,
  type SessionPersistenceDeps,
  type SessionHistoryEntry,
} from "../src/session-persistence";
import { captureUsageAnchor } from "../src/usage-anchor";

function makeDeps(
  history: SessionHistoryEntry[],
  extra?: Partial<SessionPersistenceDeps>,
): SessionPersistenceDeps & { historyMap: Map<string, SessionHistoryEntry[]> } {
  const historyMap = new Map<string, SessionHistoryEntry[]>();
  historyMap.set("test-session", history);
  return {
    historyMap,
    sessionDataDir: "",
    sessionPersistenceEnabled: true,
    autoCompactionEnabled: false,
    compactionTokenThreshold: 100_000,
    conversationHistory: historyMap,
    compactionManager: null,
    lifecycleManager: null,
    sessionManager: null,
    memoryHub: null,
    ...extra,
  };
}

describe("R11 GAP-23: todo 压缩后重注入（formatForInjection 死码接线）", () => {
  it("provider 返回快照 → 压缩后历史末尾追加 synthetic user 行", async () => {
    const history: SessionHistoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: "user", content: `turn ${i} question` });
      history.push({ role: "assistant", content: `turn ${i} answer` });
    }
    const snapshot = "[Your active task list was preserved across context compression]\n- [>] 1. 写测试 (in_progress)";
    const deps = makeDeps(history, { todoSnapshotProvider: () => snapshot });
    await compactConversationHistory(deps, "test-session");
    const after = deps.historyMap.get("test-session")!;
    const last = after[after.length - 1];
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("preserved across context compression");
    expect(String(last.content)).toContain("写测试");
  });

  it("provider 返回 null（无活跃项）→ 不注入", async () => {
    const history: SessionHistoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: "user", content: `turn ${i}` });
      history.push({ role: "assistant", content: `answer ${i}` });
    }
    const deps = makeDeps(history, { todoSnapshotProvider: () => null });
    await compactConversationHistory(deps, "test-session");
    const after = deps.historyMap.get("test-session")!;
    expect(after.some((m) => String(m.content ?? "").includes("preserved across context compression"))).toBe(false);
  });

  it("provider 抛错 → 不阻断压缩（快照尽力而为）", async () => {
    const history: SessionHistoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: "user", content: `turn ${i}` });
      history.push({ role: "assistant", content: `answer ${i}` });
    }
    const deps = makeDeps(history, {
      todoSnapshotProvider: () => {
        throw new Error("store gone");
      },
    });
    await expect(compactConversationHistory(deps, "test-session")).resolves.toBeUndefined();
    const after = deps.historyMap.get("test-session")!;
    // 压缩照常发生（older 段被替换为摘要）
    expect(after.length).toBeLessThan(history.length);
  });

  it("未注册 provider（undefined）→ 行为零成本，不注入", async () => {
    const history: SessionHistoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: "user", content: `turn ${i}` });
      history.push({ role: "assistant", content: `answer ${i}` });
    }
    const deps = makeDeps(history);
    await compactConversationHistory(deps, "test-session");
    const after = deps.historyMap.get("test-session")!;
    expect(after.some((m) => String(m.content ?? "").includes("preserved across context compression"))).toBe(false);
  });
});

describe("R11 GAP-1: usage anchor 接入压缩门（provider 真值优先，fail-closed）", () => {
  const bigHistory = (): SessionHistoryEntry[] => [
    { role: "user", content: "a".repeat(4000) },   // ~1000 est tokens
    { role: "assistant", content: "b".repeat(4000) }, // ~1000 est tokens
  ];

  it("锚有效：真实 prompt_tokens 决定判定（CJK 低估场景不再触发过晚）", () => {
    // chars×0.25 估 2000 tokens；真实 prompt_tokens = 9000（CJK 2×低估的反向：
    // 真实远大于估算）。阈值 5000：旧路径判 false（不压缩），锚路径判 true。
    const deps = makeDeps(bigHistory(), { autoCompactionEnabled: true, compactionTokenThreshold: 5000 });
    const anchor = captureUsageAnchor(9000, 500, deps.historyMap.get("test-session")!);
    getUsageAnchorRegistry().set("test-session", anchor!);
    try {
      expect(needsCompaction(deps, "test-session", "system prompt", 100_000)).toBe(true);
    } finally {
      getUsageAnchorRegistry().clear("test-session");
    }
  });

  it("锚有效但低于阈值 → 不压缩（真实值小于阈值，避免过早压缩）", () => {
    const deps = makeDeps(bigHistory(), { autoCompactionEnabled: true, compactionTokenThreshold: 5000 });
    const anchor = captureUsageAnchor(1200, 100, deps.historyMap.get("test-session")!);
    getUsageAnchorRegistry().set("test-session", anchor!);
    try {
      expect(needsCompaction(deps, "test-session", "system prompt", 100_000)).toBe(false);
    } finally {
      getUsageAnchorRegistry().clear("test-session");
    }
  });

  it("锚失配（前缀被改写）→ fail-closed 回退旧估算路径", () => {
    const deps = makeDeps(bigHistory(), { autoCompactionEnabled: true, compactionTokenThreshold: 5000 });
    const anchor = captureUsageAnchor(9000, 500, deps.historyMap.get("test-session")!);
    getUsageAnchorRegistry().set("test-session", anchor!);
    // 模拟剪枝改写第一条内容
    deps.historyMap.set("test-session", [
      { role: "user", content: "[pruned]" },
      { role: "assistant", content: "b".repeat(4000) },
    ]);
    try {
      // 回退路径：chars×0.25 = 2000 < 5000 → false（锚的 9000 不再参与判定）
      expect(needsCompaction(deps, "test-session", "system prompt", 100_000)).toBe(false);
    } finally {
      getUsageAnchorRegistry().clear("test-session");
    }
  });

  it("无锚 → 旧估算路径（向后兼容）", () => {
    const deps = makeDeps(bigHistory(), { autoCompactionEnabled: true, compactionTokenThreshold: 1500 });
    expect(needsCompaction(deps, "test-session", "system prompt", 100_000)).toBe(true);
  });

  it("压缩后锚被清空（前缀改写，指纹必然失配）", async () => {
    const history: SessionHistoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: "user", content: `turn ${i}` });
      history.push({ role: "assistant", content: `answer ${i}` });
    }
    const deps = makeDeps(history);
    const anchor = captureUsageAnchor(42_000, 500, history);
    getUsageAnchorRegistry().set("test-session", anchor!);
    await compactConversationHistory(deps, "test-session");
    expect(getUsageAnchorRegistry().get("test-session")).toBeUndefined();
  });
});
