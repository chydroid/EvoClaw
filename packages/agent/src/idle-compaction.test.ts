import { describe, it, expect } from "vitest";
import {
  shouldIdleCompact,
  idleFloorTokens,
  IdleCompactionTracker,
  IDLE_SUMMARY_TARGET_RATIO,
  type IdleCompactInput,
} from "./idle-compaction";

// ═══════════════════════════════════════════════════════════
// 空闲触发压缩（hermes `_should_idle_compact` / `_idle_compaction` 的 TS 移植）
// ═══════════════════════════════════════════════════════════

function baseInput(overrides: Partial<IdleCompactInput> = {}): IdleCompactInput {
  return {
    enabled: true,
    idleAfterSeconds: 60,
    idleGapSeconds: 3600,
    tokens: 120_000,
    floorTokens: 20_000,
    cooldownActive: false,
    lastCompactionTokens: 0,
    ...overrides,
  };
}

describe("shouldIdleCompact — 关闭 / 阈值 / 空闲 / 冷却 前置门", () => {
  it("enabled=false → 否", () => {
    expect(shouldIdleCompact(baseInput({ enabled: false }))).toBe(false);
  });

  it("idleAfterSeconds<=0 → 否（opt-in 默认关闭）", () => {
    expect(shouldIdleCompact(baseInput({ idleAfterSeconds: 0 }))).toBe(false);
    expect(shouldIdleCompact(baseInput({ idleAfterSeconds: -5 }))).toBe(false);
  });

  it("空闲未达阈值 → 否", () => {
    expect(shouldIdleCompact(baseInput({ idleGapSeconds: 30 }))).toBe(false);
    expect(shouldIdleCompact(baseInput({ idleGapSeconds: 59 }))).toBe(false);
  });

  it("空闲恰好等于阈值 → 是（>= 语义）", () => {
    expect(shouldIdleCompact(baseInput({ idleGapSeconds: 60 }))).toBe(true);
  });

  it("冷却期内 → 否（即便空闲够、token 够）", () => {
    expect(shouldIdleCompact(baseInput({ cooldownActive: true }))).toBe(false);
  });
});

describe("shouldIdleCompact — token floor 判定", () => {
  it("tokens <= floor → 否（不压缩已低于目标体积的会话）", () => {
    expect(shouldIdleCompact(baseInput({ tokens: 20_000, floorTokens: 20_000 }))).toBe(false);
    expect(shouldIdleCompact(baseInput({ tokens: 15_000, floorTokens: 20_000 }))).toBe(false);
  });

  it("tokens > floor → 是", () => {
    expect(shouldIdleCompact(baseInput({ tokens: 20_001, floorTokens: 20_000 }))).toBe(true);
  });
});

describe("shouldIdleCompact — lastCompactionTokens 抬高 floor（#97239 防反复压缩）", () => {
  it("上次压缩产出 100k + floor 20k → 有效 floor 120k，tokens=120k 不触发", () => {
    const input = baseInput({ tokens: 120_000, floorTokens: 20_000, lastCompactionTokens: 100_000 });
    expect(shouldIdleCompact(input)).toBe(false);
  });

  it("必须新增「一个 floor 的量」才再次触发：tokens>120k 才触发", () => {
    expect(shouldIdleCompact(baseInput({ tokens: 120_001, floorTokens: 20_000, lastCompactionTokens: 100_000 }))).toBe(true);
  });

  it("last+floor 高于理论 floor 时取 last+floor：last=5k, floor=20k → 有效 floor=25k", () => {
    // max(20000, 5000+20000=25000) → 25000
    expect(shouldIdleCompact(baseInput({ tokens: 24_999, floorTokens: 20_000, lastCompactionTokens: 5_000 }))).toBe(false);
    expect(shouldIdleCompact(baseInput({ tokens: 25_001, floorTokens: 20_000, lastCompactionTokens: 5_000 }))).toBe(true);
  });

  it("lastCompactionTokens=0 时保持原始语义（floor 就是理论值）", () => {
    expect(shouldIdleCompact(baseInput({ tokens: 20_001, floorTokens: 20_000, lastCompactionTokens: 0 }))).toBe(true);
  });

  it("负数 / 非法的 lastCompactionTokens 不抬高 floor", () => {
    expect(shouldIdleCompact(baseInput({ tokens: 20_001, floorTokens: 20_000, lastCompactionTokens: -1 }))).toBe(true);
    expect(shouldIdleCompact(baseInput({ tokens: 20_001, floorTokens: 20_000, lastCompactionTokens: 0.5 }))).toBe(true);
  });
});

describe("idleFloorTokens", () => {
  it("默认 ratio=0.20", () => {
    expect(IDLE_SUMMARY_TARGET_RATIO).toBe(0.2);
    expect(idleFloorTokens(100_000)).toBe(20_000);
  });

  it("非法的阈值 / 比例回落安全值", () => {
    expect(idleFloorTokens(0)).toBe(0);
    expect(idleFloorTokens(-1)).toBe(0);
    expect(idleFloorTokens(NaN)).toBe(0);
    expect(idleFloorTokens(100_000, 0)).toBe(20_000); // 非法 ratio → 默认
    expect(idleFloorTokens(100_000, -1)).toBe(20_000);
  });
});

describe("IdleCompactionTracker", () => {
  it("从未记录 → idleGapSeconds 为 null（首轮不触发）", () => {
    const t = new IdleCompactionTracker();
    expect(t.getIdleGapSeconds("s1")).toBeNull();
    expect(t.getLastCompactionTokens("s1")).toBe(0);
  });

  it("touch 后读取空闲秒数", () => {
    const t = new IdleCompactionTracker();
    t.touch("s1", 1_000_000);
    expect(t.getIdleGapSeconds("s1", 1_060_000)).toBe(60);
    expect(t.getIdleGapSeconds("s1", 1_000_000)).toBe(0);
  });

  it("时钟回拨（now < lastActivityAt）夹到 0，不返回负数", () => {
    const t = new IdleCompactionTracker();
    t.touch("s1", 2_000_000);
    expect(t.getIdleGapSeconds("s1", 1_900_000)).toBe(0);
  });

  it("recordCompaction 记录产出并刷新活动时间", () => {
    const t = new IdleCompactionTracker();
    t.touch("s1", 1_000_000);
    t.recordCompaction("s1", 80_000, 1_050_000);
    expect(t.getLastCompactionTokens("s1")).toBe(80_000);
    expect(t.getIdleGapSeconds("s1", 1_050_000)).toBe(0);
  });

  it("非法 producedTokens（负/NaN）归 0", () => {
    const t = new IdleCompactionTracker();
    t.recordCompaction("s1", -5);
    expect(t.getLastCompactionTokens("s1")).toBe(0);
    t.recordCompaction("s1", NaN);
    expect(t.getLastCompactionTokens("s1")).toBe(0);
  });

  it("recordCompaction 保留 lastCompactionTokens 于 touch 之间（touch 不清零）", () => {
    const t = new IdleCompactionTracker();
    t.recordCompaction("s1", 80_000, 1_000_000);
    t.touch("s1", 1_100_000);
    expect(t.getLastCompactionTokens("s1")).toBe(80_000);
    expect(t.getIdleGapSeconds("s1", 1_100_000)).toBe(0);
  });

  it("reset 清除逐会话状态", () => {
    const t = new IdleCompactionTracker();
    t.recordCompaction("s1", 50_000);
    t.reset("s1");
    expect(t.getLastCompactionTokens("s1")).toBe(0);
    expect(t.getIdleGapSeconds("s1")).toBeNull();
  });

  it("LRU 上限：超过 maxSessions 淘汰最旧会话", () => {
    const t = new IdleCompactionTracker(3);
    t.touch("s1"); t.touch("s2"); t.touch("s3");
    t.touch("s4"); // 淘汰 s1
    expect(t.size()).toBe(3);
    expect(t.getIdleGapSeconds("s1")).toBeNull();
    expect(t.getIdleGapSeconds("s4")).not.toBeNull();
    // 访问提升：touch s2 后 s2 变最新，再触 s5 淘汰 s3
    t.touch("s2");
    t.touch("s5");
    expect(t.getIdleGapSeconds("s3")).toBeNull();
    expect(t.getIdleGapSeconds("s2")).not.toBeNull();
  });

  it("空 sessionId 被忽略", () => {
    const t = new IdleCompactionTracker();
    t.touch("");
    expect(t.size()).toBe(0);
  });
});
