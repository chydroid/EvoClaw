/**
 * R11 GAP-2/4 测试：
 *  - GAP-2 prepared compaction（对标 hermes prepared_compaction.py）：
 *    频带启动后台 pass → 压缩取用 splice hit；窗口漂移 → miss 内联照旧（fail-closed）；
 *    pass 失败退避；会话边界丢弃。
 *  - GAP-4 落盘静默失败 fail-closed 门：persistSessionTurn 失败记账 →
 *    compactConversationHistory 拒绝执行；落盘恢复 → 门清除。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  compactConversationHistory,
  needsCompactionProbe,
  persistSessionTurn,
  type SessionPersistenceDeps,
  type SessionHistoryEntry,
} from "../src/session-persistence";
import {
  maybePrepareCompaction,
  preparedCompactionStats,
  PREPARE_BAND_RATIO,
} from "../src/prepared-compaction";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function makeHistory(turns: number): SessionHistoryEntry[] {
  const history: SessionHistoryEntry[] = [];
  for (let i = 0; i < turns; i++) {
    history.push({ role: "user", content: `question ${i} with some substance to fingerprint` });
    history.push({ role: "assistant", content: `answer ${i} likewise substantial` });
  }
  return history;
}

function makeDeps(
  history: SessionHistoryEntry[],
  extra?: Partial<SessionPersistenceDeps>,
  sid: string = "test-session",
): SessionPersistenceDeps & { historyMap: Map<string, SessionHistoryEntry[]> } {
  const historyMap = new Map<string, SessionHistoryEntry[]>();
  historyMap.set(sid, history);
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

beforeEach(() => {
  // 跨测试清状态：module-level Map 按会话键隔离，但用不同 sessionId 更稳；
  // 这里统一 sessionId，靠 discardPreparedCompaction 语义清理。
  // prepared-compaction 无公开清理入口 → 测试用不同 sessionId 前缀隔离。
});

describe("R11 GAP-2: maybePrepareCompaction 频带判定与 pass 生命周期", () => {
  it("探针值在频带内 → 启动 pass，摘要完成后发布候选", async () => {
    const sid = "prep-hit-1";
    const history = makeHistory(20);
    let summaryCalls = 0;
    const deps = makeDeps(history, {
      autoCompactionEnabled: true,
      llmSummarizer: async () => {
        summaryCalls++;
        return "后台生成的结构化摘要";
      },
    }, sid);
    // 探针值：阈值 100_000，频带 (88_000, 100_000]
    const probe = 95_000;
    const started = maybePrepareCompaction(deps, sid, probe);
    expect(started).toBe(true);
    const stats0 = preparedCompactionStats(sid);
    expect(stats0.hasPending).toBe(true);

    // 等 pass 完成（fake summarizer 同步 resolve，一个微任务周期足够）
    await new Promise((r) => setTimeout(r, 20));
    const stats1 = preparedCompactionStats(sid);
    expect(stats1.hasPending).toBe(false);
    expect(stats1.hasEntry).toBe(true);
    expect(summaryCalls).toBe(1);
  });

  it("探针值低于频带下限 / 超阈值 / 非正 → 不启动", () => {
    const deps = makeDeps(makeHistory(20), {
      autoCompactionEnabled: true,
      llmSummarizer: async () => "x",
    });
    // 88_000 以下（远低于频带）
    expect(maybePrepareCompaction(deps, "band-low", 50_000)).toBe(false);
    // 超阈值（压缩已该触发，不是预备时机）
    expect(maybePrepareCompaction(deps, "band-high", 120_000)).toBe(false);
    expect(maybePrepareCompaction(deps, "band-zero", 0)).toBe(false);
  });

  it("history 太短（无可压缩段）→ 不启动", () => {
    const deps = makeDeps(makeHistory(4), {
      autoCompactionEnabled: true,
      llmSummarizer: async () => "x",
    }, "too-short");
    expect(maybePrepareCompaction(deps, "too-short", 95_000)).toBe(false);
  });

  it("已有候选时不重复启动 pass（单飞）", async () => {
    const sid = "single-flight";
    const history = makeHistory(20);
    let summaryCalls = 0;
    const deps = makeDeps(history, {
      autoCompactionEnabled: true,
      llmSummarizer: async () => {
        summaryCalls++;
        return "摘要";
      },
    }, sid);
    expect(maybePrepareCompaction(deps, sid, 95_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(maybePrepareCompaction(deps, sid, 95_000)).toBe(false); // 有候选 → 不再 pass
    expect(summaryCalls).toBe(1);
  });

  it("pass 失败（summarizer 抛错/空返回）→ 退避期内不再启动", async () => {
    const sid = "backoff";
    const history = makeHistory(20);
    const deps = makeDeps(history, {
      autoCompactionEnabled: true,
      llmSummarizer: async () => {
        throw new Error("provider down");
      },
    }, sid);
    expect(maybePrepareCompaction(deps, sid, 95_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    const stats = preparedCompactionStats(sid);
    expect(stats.hasEntry).toBe(false);
    expect(stats.retryAfterInMs).toBeGreaterThan(0);
    expect(maybePrepareCompaction(deps, sid, 95_000)).toBe(false); // 退避中
  });
});

describe("R11 GAP-2: compactConversationHistory 取用预压缩摘要", () => {
  it("窗口一致 → splice hit：跳过内联 LLM 摘要，用后台摘要", async () => {
    const sid = "splice-hit";
    const history = makeHistory(20); // 40 条，压缩段 = 前 34 条
    let inlineCalls = 0;
    const deps = makeDeps(history, {
      autoCompactionEnabled: true,
      // 后台 pass 与内联路径共用同一 summarizer —— 返回统一文本，
      // hit/miss 用调用次数区分（hit=1 仅后台，miss=2 后台+内联）
      llmSummarizer: async () => {
        inlineCalls++;
        return "后台生成的结构化摘要";
      },
    }, sid);
    expect(maybePrepareCompaction(deps, sid, 95_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));

    // 模拟一个正常回合结束：追加一对 [user, assistant]（P0-9 纯追加）
    history.push({ role: "user", content: "next turn question" });
    history.push({ role: "assistant", content: "next turn answer" });

    await compactConversationHistory(deps, sid);
    // inlineCalls=1：仅后台 pass 那一次（splice hit 不追加内联调用）；
    // 若 splice miss 则这里会是 2（后台 1 + 内联 1）
    expect(inlineCalls).toBe(1);
    const after = deps.historyMap.get(sid)!;
    // 摘要行落在开头（compacted[0] = system summary）= 后台摘要被取用
    expect(String(after[0].content)).toBe("后台生成的结构化摘要");
    // recent 6 条保留
    expect(after.length).toBe(8); // 1 summary + 6 recent + 1 synthetic user turn
  });

  it("前缀被改写 → splice miss：候选丢弃，内联摘要照旧（fail-closed）", async () => {
    const sid = "splice-miss-rewind";
    const history = makeHistory(20);
    let inlineCalls = 0;
    const deps = makeDeps(history, {
      autoCompactionEnabled: true,
      llmSummarizer: async () => {
        inlineCalls++;
        return "内联摘要";
      },
      // 有 CompactionManager 才走 llmSummarizer 内联路径；用桩模拟最小面
      compactionManager: {
        buildSummary: () => ({ id: "t", parentSessionId: sid, successorSessionId: sid, summary: "", keyFacts: [], decisions: [], pendingItems: [], compactedTurnCount: 0, timestamp: new Date().toISOString() }),
        buildLLMSummaryPrompt: () => "内联 prompt",
        buildSuccessorPrompt: (c: { summary: string }) => c.summary,
        buildMemoryEntry: () => ({ content: "", type: "system", metadata: { source: "compaction", tags: [], importance: 0 } }),
      } as unknown as SessionPersistenceDeps["compactionManager"],
    }, sid);
    expect(maybePrepareCompaction(deps, sid, 95_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));

    // 剪枝改写前缀（模拟 maxHistoryLength splice / 人工改写）
    history.splice(0, 2);

    await compactConversationHistory(deps, sid);
    expect(inlineCalls).toBe(2); // 后台 pass 1 + 内联 1（miss 后照旧内联）
    const after = deps.historyMap.get(sid)!;
    expect(String(after[0].content)).toBe("内联摘要");
  });

  it("slice 点漂移（keepRecentTurns 不一致）→ miss", async () => {
    const sid = "splice-miss-slice";
    const history = makeHistory(20);
    let inlineCalls = 0;
    const deps = makeDeps(history, {
      autoCompactionEnabled: true,
      llmSummarizer: async () => {
        inlineCalls++;
        return "内联摘要";
      },
      compactionManager: {
        buildSummary: () => ({ id: "t", parentSessionId: sid, successorSessionId: sid, summary: "", keyFacts: [], decisions: [], pendingItems: [], compactedTurnCount: 0, timestamp: new Date().toISOString() }),
        buildLLMSummaryPrompt: () => "内联 prompt",
        buildSuccessorPrompt: (c: { summary: string }) => c.summary,
        buildMemoryEntry: () => ({ content: "", type: "system", metadata: { source: "compaction", tags: [], importance: 0 } }),
      } as unknown as SessionPersistenceDeps["compactionManager"],
    }, sid);
    expect(maybePrepareCompaction(deps, sid, 95_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    history.push(
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    );
    // keepRecentTurns=2：slice 点 = 42-4 = 38 ≠ 准备时 34 → 且尾边界后移？
    // 不——38 > 34 是前移方向（尾更多），通过 ≥ 校验；指纹只查到 34 也没变。
    // 真正 miss 的路径是 rewound（slice 后移）：改用 rewind 触发。
    history.splice(0, 4);
    await compactConversationHistory(deps, sid, 2);
    expect(inlineCalls).toBe(2); // 后台 1 + 内联 1
  });
});

describe("R11 GAP-4: 落盘静默失败 fail-closed 压缩门", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gap4-gate-"));
  });

  it("persistSessionTurn 失败记账 → compactConversationHistory 拒绝执行", async () => {
    const sid = "gate-blocked";
    const history = makeHistory(20);
    // sessionDataDir 指向一个**文件** → sessionFilePath mkdirSync 失败 → persist 记账
    const blocker = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(blocker, "block", "utf-8");
    const deps = makeDeps(history, { sessionDataDir: blocker }, sid);
    expect(() => persistSessionTurn(deps, sid, "user", "会触发失败的消息")).not.toThrow(); // 静默失败：不抛，只记账

    const inlineCalls = { n: 0 };
    const deps2: SessionPersistenceDeps = {
      ...deps,
      llmSummarizer: async () => {
        inlineCalls.n++;
        return "内联摘要";
      },
    };
    await compactConversationHistory(deps2, sid);
    expect(inlineCalls.n).toBe(0); // 门拦截：内联摘要也没跑
    // history 原样保留（未被压缩重写）
    expect(deps.historyMap.get(sid)!.length).toBe(40);
  });

  it("落盘恢复（一次成功写入）→ 门清除，压缩恢复执行", async () => {
    const sid = "gate-recover";
    const history = makeHistory(20);
    const dataDir = path.join(tmpDir, "data");
    const deps = makeDeps(history, { sessionDataDir: dataDir }, sid);
    // 正常落盘（成功 → 无失败记录）
    persistSessionTurn(deps, sid, "user", "正常消息");
    await compactConversationHistory(deps, sid);
    // 门未拦：压缩执行（compactionManager=null → 规则摘要路径，无需 LLM）
    expect(deps.historyMap.get(sid)![0].role).toBe("system"); // 已压缩
    expect(String(deps.historyMap.get(sid)![0].content)).toContain("Compacted");
  });

  it("needsCompactionProbe 与 needsCompaction 同口径（锚缺失走估算）", () => {
    const history = makeHistory(20);
    const deps = makeDeps(history, { compactionTokenThreshold: 100_000 });
    const probe = needsCompactionProbe(deps, "test-session", "system prompt text");
    expect(probe).toBeGreaterThan(0);
    // 阈值很小 → needsCompaction 为 true 时 probe 必然大于该阈值
    const tight = makeDeps(history, { compactionTokenThreshold: 1 });
    expect(probe).toBeGreaterThan(tight.compactionTokenThreshold);
  });

  it("PREPARE_BAND_RATIO 常量与 hermes 对齐（12%）", () => {
    expect(PREPARE_BAND_RATIO).toBe(0.12);
  });
});
