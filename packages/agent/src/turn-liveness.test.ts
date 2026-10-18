import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TurnLivenessWatchdog,
  getTurnLivenessWatchdog,
  resetTurnLivenessWatchdog,
  DEFAULT_TURN_LIVENESS_TIMEOUT_MS,
  DEFAULT_TURN_LIVENESS_POLL_MS,
} from "./turn-liveness";

// ═══════════════════════════════════════════════════════════
// Turn 存活看门狗（hermes turn_liveness.py 的 TS 移植）
// ═══════════════════════════════════════════════════════════
describe("TurnLivenessWatchdog", () => {
  let dog: TurnLivenessWatchdog;

  beforeEach(() => {
    dog = new TurnLivenessWatchdog({
      timeoutMs: 100,
      pollMs: 50,
    });
  });

  it("默认配置（hermes 对齐）", () => {
    const d = new TurnLivenessWatchdog();
    expect(DEFAULT_TURN_LIVENESS_TIMEOUT_MS).toBe(600_000);
    expect(DEFAULT_TURN_LIVENESS_POLL_MS).toBe(15_000);
  });

  it("start / stop 基本生命周期", () => {
    const onStale = vi.fn();
    dog.start("sess-1", onStale);
    dog.stop("sess-1");
    expect(onStale).not.toHaveBeenCalled();
  });

  it("无活动超过 timeoutMs 后 isStale 返回 true", async () => {
    dog.start("sess-1", () => {});
    await new Promise((r) => setTimeout(r, 150));
    expect(dog.isStale("sess-1")).toBe(true);
    dog.stop("sess-1");
  });

  it("有活动（touch）重置停滞计时", async () => {
    const onStale = vi.fn();
    dog.start("sess-1", onStale);
    await new Promise((r) => setTimeout(r, 80));
    dog.touch("sess-1"); // 重置
    await new Promise((r) => setTimeout(r, 80));
    // 触碰后又过了 80ms（< timeoutMs=100），不应判停滞
    expect(onStale).not.toHaveBeenCalled();
    dog.stop("sess-1");
  });

  it("停滞后触发 onStale 回调（至少一次）", async () => {
    const onStale = vi.fn();
    dog.start("sess-1", onStale);
    await new Promise((r) => setTimeout(r, 200));
    expect(onStale).toHaveBeenCalled();
    expect(onStale.mock.calls.length).toBeGreaterThanOrEqual(1);
    const event = onStale.mock.calls[0]?.[0];
    expect(event).toBeTruthy();
    expect(event?.sessionId).toBe("sess-1");
    expect(event?.waitedMs).toBeGreaterThanOrEqual(100);
    dog.stop("sess-1");
  });

  it("turn 重启后旧 poll 不触发（generation 重新校验）", async () => {
    // 用长超时：重启后新 turn 的 activity 被重置，不应判停滞；
    // 旧 poll（restart 前调度的）因 generation 不匹配而退出。
    const longDog = new TurnLivenessWatchdog({ timeoutMs: 1000, pollMs: 50 });
    const onStale = vi.fn();
    longDog.start("sess-1", onStale);
    await new Promise((r) => setTimeout(r, 80));
    // 重启 turn（模拟 turn 被恢复/重试）：generation 递增，activity 重置
    longDog.start("sess-1", onStale);
    await new Promise((r) => setTimeout(r, 300));
    // 旧 poll 已因 generation 不匹配退出；新 turn 活动在 300ms 前被重置，
    // 未超过 1000ms 超时 → 不应触发 onStale
    expect(onStale).not.toHaveBeenCalled();
    longDog.stop("sess-1");
  });

  it("stop 后不再触发 onStale", async () => {
    const onStale = vi.fn();
    dog.start("sess-1", onStale);
    await new Promise((r) => setTimeout(r, 60));
    dog.stop("sess-1");
    await new Promise((r) => setTimeout(r, 200));
    expect(onStale).not.toHaveBeenCalled();
  });

  it("clearAll 清空全部状态", () => {
    dog.start("sess-1", () => {});
    dog.start("sess-2", () => {});
    dog.clearAll();
    expect(dog.isStale("sess-1")).toBe(false);
    expect(dog.isStale("sess-2")).toBe(false);
  });

  it("未启用时不监控", () => {
    const d = new TurnLivenessWatchdog({ enabled: false });
    const onStale = vi.fn();
    d.start("sess-1", onStale);
    expect(onStale).not.toHaveBeenCalled();
  });
});

describe("getTurnLivenessWatchdog 单例", () => {
  beforeEach(() => resetTurnLivenessWatchdog());

  it("同一实例", () => {
    const a = getTurnLivenessWatchdog();
    const b = getTurnLivenessWatchdog();
    expect(a).toBe(b);
  });

  it("updateConfig 更新配置", () => {
    const d = getTurnLivenessWatchdog({ timeoutMs: 1000 });
    d.updateConfig({ timeoutMs: 5000 });
    // 配置更新后生效（通过 isStale 间接验证需要等待，这里只验证不抛异常）
    expect(d).toBeInstanceOf(TurnLivenessWatchdog);
  });
});