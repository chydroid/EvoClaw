import { describe, it, expect } from "vitest";
import { maybeIdleCompact, type SessionPersistenceDeps, type SessionHistoryEntry } from "./session-persistence";
import { IdleCompactionTracker } from "./idle-compaction";
import { CompactionManager } from "./compaction-manager";

const SESSION = "idle-s";
const SYSTEM = "SYSTEM PROMPT";

/** 构造一段足够长（> keepRecentTurns*2 = 6 条）且 token 超过 floor 的历史。 */
function longHistory(): SessionHistoryEntry[] {
  const big = "x".repeat(4000); // 每条约 1000 token
  return Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `turn ${i}: ${big}`,
  })) as SessionHistoryEntry[];
}

function makeDeps(
  tracker: IdleCompactionTracker | undefined,
  opts: { idleAfterSeconds?: number; threshold?: number; history?: SessionHistoryEntry[] } = {},
): SessionPersistenceDeps {
  const map = new Map<string, SessionHistoryEntry[]>();
  map.set(SESSION, opts.history ?? longHistory());
  return {
    sessionDataDir: "",
    sessionPersistenceEnabled: true,
    autoCompactionEnabled: true,
    compactionTokenThreshold: opts.threshold ?? 2000,
    idleCompactAfterSeconds: opts.idleAfterSeconds ?? 3600,
    idleCompactionTracker: tracker,
    conversationHistory: map,
    compactionManager: new CompactionManager(),
    lifecycleManager: null,
    sessionManager: null,
    memoryHub: null,
  };
}

describe("maybeIdleCompact — 默认关闭 / 前置条件", () => {
  it("阈值<=0（默认关闭）→ 不触发、零成本", async () => {
    const tracker = new IdleCompactionTracker();
    tracker.touch(SESSION, 1_000_000);
    const deps = makeDeps(tracker, { idleAfterSeconds: 0 });
    const out = await maybeIdleCompact(deps, SESSION, SYSTEM, 1_100_000);
    expect(out.triggered).toBe(false);
    expect(out.skipReason).toBe("disabled");
    expect(deps.conversationHistory.get(SESSION)!.length).toBe(12); // 未被压缩
  });

  it("未注入追踪器 → 不触发", async () => {
    const deps = makeDeps(undefined, { idleAfterSeconds: 3600 });
    const out = await maybeIdleCompact(deps, SESSION, SYSTEM, 1_100_000);
    expect(out.triggered).toBe(false);
    expect(out.skipReason).toBe("no-tracker");
  });

  it("首次活动前（无追踪记录）→ 不触发", async () => {
    const tracker = new IdleCompactionTracker();
    const deps = makeDeps(tracker, { idleAfterSeconds: 3600 });
    const out = await maybeIdleCompact(deps, SESSION, SYSTEM, 1_100_000);
    expect(out.triggered).toBe(false);
    expect(out.skipReason).toBe("no-prior-activity");
  });

  it("autoCompactionEnabled=false → 不触发", async () => {
    const tracker = new IdleCompactionTracker();
    tracker.touch(SESSION, 1_000_000);
    const deps = makeDeps(tracker, { idleAfterSeconds: 3600 });
    deps.autoCompactionEnabled = false;
    const out = await maybeIdleCompact(deps, SESSION, SYSTEM, 1_100_000);
    expect(out.triggered).toBe(false);
    expect(out.skipReason).toBe("disabled");
  });

  it("空闲不足 → 不触发", async () => {
    const tracker = new IdleCompactionTracker();
    tracker.touch(SESSION, 1_000_000);
    const deps = makeDeps(tracker, { idleAfterSeconds: 3600 });
    const out = await maybeIdleCompact(deps, SESSION, SYSTEM, 1_000_000 + 1800_000); // 1800s < 3600s
    expect(out.triggered).toBe(false);
    expect(out.skipReason).toBe("below-threshold");
  });

  it("token 低于 floor → 不触发（压缩已够小）", async () => {
    const tracker = new IdleCompactionTracker();
    tracker.touch(SESSION, 1_000_000);
    const deps = makeDeps(tracker, { idleAfterSeconds: 3600, threshold: 1_000_000, history: [{ role: "user", content: SYSTEM }] });
    const out = await maybeIdleCompact(deps, SESSION, SYSTEM, 1_100_000);
    expect(out.triggered).toBe(false);
    expect(out.skipReason).toBe("below-threshold");
  });
});

describe("maybeIdleCompact — 触发并压缩", () => {
  it("空闲足够 + token 超 floor → 压缩历史并记录产出", async () => {
    const tracker = new IdleCompactionTracker();
    tracker.touch(SESSION, 1_000_000);
    const deps = makeDeps(tracker, { idleAfterSeconds: 3600, threshold: 2000 });
    const before = deps.conversationHistory.get(SESSION)!.length;

    const out = await maybeIdleCompact(deps, SESSION, SYSTEM, 1_000_000 + 3600_000);
    expect(out.triggered).toBe(true);
    expect(out.idleGapSeconds).toBe(3600);
    expect(out.tokensBefore).toBeGreaterThan(0);
    const after = deps.conversationHistory.get(SESSION)!.length;
    expect(after).toBeLessThan(before); // 历史确实被压缩
    // 追踪器记录实际产出，抬高下次 floor
    expect(tracker.getLastCompactionTokens(SESSION)).toBeGreaterThan(0);
    expect(tracker.getLastCompactionTokens(SESSION)).toBe(out.tokensAfter);
  });

  it("压缩后刷新活动时间（gap 归零），下一轮空闲需重新累计", async () => {
    const tracker = new IdleCompactionTracker();
    tracker.touch(SESSION, 1_000_000);
    const deps = makeDeps(tracker, { idleAfterSeconds: 3600, threshold: 2000 });
    const now = 1_000_000 + 3600_000;
    await maybeIdleCompact(deps, SESSION, SYSTEM, now);
    expect(tracker.getIdleGapSeconds(SESSION, now)).toBe(0);
  });

  it("#97239 防反复压缩：压缩到 floor 之上后，同样空闲不再触发（需新增内容）", async () => {
    const tracker = new IdleCompactionTracker();
    tracker.touch(SESSION, 1_000_000);
    const deps = makeDeps(tracker, { idleAfterSeconds: 3600, threshold: 2000 });

    const first = await maybeIdleCompact(deps, SESSION, SYSTEM, 1_000_000 + 3600_000);
    expect(first.triggered).toBe(true);

    // 立刻再来一次同等空闲（模拟再次恢复）：lastCompactionTokens 已抬高 floor，不应再压
    const produced = tracker.getLastCompactionTokens(SESSION);
    const second = await maybeIdleCompact(deps, SESSION, SYSTEM, 1_000_000 + 7200_000);
    expect(second.triggered).toBe(false);
    // 产出 token 会被作为下次 floor 的基线
    expect(produced).toBeGreaterThan(0);
  });

  it("反抖动：连续无效压缩后（压缩效果 <10%）再次空闲压缩被冷却拒绝", async () => {
    const tracker = new IdleCompactionTracker();
    tracker.touch(SESSION, 1_000_000);
    const deps = makeDeps(tracker, { idleAfterSeconds: 3600, threshold: 2000 });
    // 伪造两次无效压缩计数，使 shouldSkipCompaction() 返回 true
    deps.compactionManager!.recordCompressionEffect(1000, 1000); // 0% 节省
    deps.compactionManager!.recordCompressionEffect(1000, 1000);
    expect(deps.compactionManager!.shouldSkipCompaction()).toBe(true);
    const out = await maybeIdleCompact(deps, SESSION, SYSTEM, 1_000_000 + 3600_000);
    expect(out.triggered).toBe(false);
    expect(out.skipReason).toBe("cooldown");
  });
});
