/**
 * 会话重载 × 读去重代际（v33 续跑实证，2026-11-26）。
 *
 * 事故：每轮 chat() 从 transcript 重载活动历史时只保留 user/assistant，
 * **tool 结果被丢弃**（resume 还会裁到最近 3 轮）。但 ReadTracker 的 dedup 是
 * per-session 的，它以为「文件未变、内容仍在上下文里」→ 回 stub / 硬 BLOCK。
 * 模型拿不到内容却被告知「内容仍是最新的」，只能改用 `cat` 绕过，白白多一轮。
 *
 * 修法：重载即前进 read generation（对齐 hermes 在压缩边界 reset_file_dedup），
 * dedup 只在同一回合内生效。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { AgentModelExecutor } from "./agent-model-executor";
import { ReadTracker } from "./read-tracker";

function fakeSessionManager(turns: Array<{ role: "user" | "assistant" | "tool"; content: string | null }>) {
  return {
    loadSessionMeta: () => ({ id: "s1" }),
    createSession: () => ({ id: "s1" }),
    loadTranscript: () => turns.map((t, i) => ({ turnIndex: i, ...t, timestamp: "2026-11-26T00:00:00Z" })),
  };
}

describe("reloadSessionHistory — 重载即前进读代际", () => {
  let executor: AgentModelExecutor;

  beforeEach(() => {
    ReadTracker.resetInstance();
    executor = new AgentModelExecutor(new ServiceRegistry(), new EventBus());
  });

  it("★ 上一回合读过 → 重载后首次读回全文（不再是 stub）", async () => {
    const rt = ReadTracker.getInstance();
    const path = "/w/a.txt";
    const version = "m1:hash1";
    // 上一回合：真读并记账 → 同一回合内再读会被 stub
    rt.noteReadServed("s1", path, version, 1, undefined, 10, 10, false);
    expect(rt.checkBeforeRead("s1", path, version, 1, undefined).action).toBe("stub");

    // 新回合：chat() 入口重载 transcript（tool 结果被丢弃）
    executor.setSessionManager(fakeSessionManager([
      { role: "user", content: "继续" },
      { role: "assistant", content: "好的" },
    ]) as never);
    await (executor as unknown as {
      reloadSessionHistory: (a: string, s: string, r: boolean) => Promise<void>;
    }).reloadSessionHistory("default", "s1", false);

    // 重载后：内容已不在上下文 → 必须允许真读
    expect(rt.checkBeforeRead("s1", path, version, 1, undefined).action).toBe("allow");
  });

  it("重载后活动历史只保留 user/assistant（tool 结果不进上下文）", async () => {
    executor.setSessionManager(fakeSessionManager([
      { role: "user", content: "读文件" },
      { role: "assistant", content: null },
      { role: "tool", content: '{"content":"SECRET"}' },
      { role: "assistant", content: "读到了" },
    ]) as never);
    await (executor as unknown as {
      reloadSessionHistory: (a: string, s: string, r: boolean) => Promise<void>;
    }).reloadSessionHistory("default", "s1", false);
    const history = (executor as unknown as {
      conversationHistory: Map<string, Array<{ role: string; content: string | null }>>;
    }).conversationHistory.get("s1")!;
    expect(history.map((h) => h.role)).toEqual(["user", "assistant", "assistant"]);
    expect(JSON.stringify(history)).not.toContain("SECRET");
  });

  it("transcript 为空 → 不前进代际（空会话不得白送一次全文读）", async () => {
    const rt = ReadTracker.getInstance();
    const path = "/w/b.txt";
    rt.noteReadServed("s1", path, "m2:h2", 1, undefined, 5, 5, false);
    executor.setSessionManager(fakeSessionManager([]) as never);
    const spy = vi.spyOn(rt, "advanceGeneration");
    await (executor as unknown as {
      reloadSessionHistory: (a: string, s: string, r: boolean) => Promise<void>;
    }).reloadSessionHistory("default", "s1", false);
    expect(spy).not.toHaveBeenCalled();
  });
});
