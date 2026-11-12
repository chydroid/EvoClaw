import { describe, it, expect, afterEach, vi } from "vitest";
import { ApprovalDenialBreaker, resolveDenialBreakerConfig } from "./approval-denial-breaker";

/**
 * P3 — 审批连续拒绝熔断（对标 hermes approval.py）。
 * 阈值默认 3，0 关闭；批准清零；超时不算拒绝；会话隔离；LRU + 空闲 TTL。
 */
describe("ApprovalDenialBreaker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("前 2 次拒绝不熔断，第 3 次熔断", () => {
    const b = new ApprovalDenialBreaker({ threshold: 3 });
    expect(b.recordDenial("s1", "r1").consecutive).toBe(1);
    expect(b.isTripped("s1")).toBe(false);
    expect(b.recordDenial("s1", "r2").consecutive).toBe(2);
    expect(b.isTripped("s1")).toBe(false);
    const st = b.recordDenial("s1", "r3");
    expect(st.consecutive).toBe(3);
    expect(st.trippedAt).toBeGreaterThan(0);
    expect(b.isTripped("s1")).toBe(true);
  });

  it("批准清零（reset）", () => {
    const b = new ApprovalDenialBreaker({ threshold: 2 });
    b.recordDenial("s1", "r1");
    b.recordDenial("s1", "r2");
    expect(b.isTripped("s1")).toBe(true);
    b.recordApproval("s1");
    expect(b.isTripped("s1")).toBe(false);
    expect(b.getState("s1")).toBeUndefined();
    // 重新计数从 1 开始
    expect(b.recordDenial("s1", "r3").consecutive).toBe(1);
  });

  it("阈值 <= 0 关闭：不计数、不熔断", () => {
    const b = new ApprovalDenialBreaker({ threshold: 0 });
    for (let i = 0; i < 10; i++) {
      expect(b.recordDenial(`s${i}`, `r${i}`).consecutive).toBe(0);
      expect(b.isTripped(`s${i}`)).toBe(false);
    }
    expect(b.snapshot()).toHaveLength(0);
  });

  it("会话隔离", () => {
    const b = new ApprovalDenialBreaker({ threshold: 2 });
    b.recordDenial("s1", "r1");
    b.recordDenial("s1", "r2");
    expect(b.isTripped("s1")).toBe(true);
    expect(b.isTripped("s2")).toBe(false);
    expect(b.getState("s2")).toBeUndefined();
  });

  it("同一 requestId 重复投递只计一次（决策回调 + 事件）", () => {
    const b = new ApprovalDenialBreaker({ threshold: 3 });
    b.recordDenial("s1", "same-id");
    b.recordDenial("s1", "same-id");
    expect(b.getState("s1")?.consecutive).toBe(1);
  });

  it("空闲 TTL：超过 idleTtlMs 后状态自动清除", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T00:00:00Z"));
    const b = new ApprovalDenialBreaker({ threshold: 2, idleTtlMs: 60_000 });
    b.recordDenial("s1", "r1");
    b.recordDenial("s1", "r2");
    expect(b.isTripped("s1")).toBe(true);
    vi.setSystemTime(new Date("2026-11-13T00:02:00Z"));
    expect(b.isTripped("s1")).toBe(false);
    expect(b.getState("s1")).toBeUndefined();
  });

  it("LRU：超过 maxSessions 时淘汰最久未使用的会话", () => {
    const b = new ApprovalDenialBreaker({ threshold: 5, maxSessions: 2 });
    b.recordDenial("s1", "r1");
    b.recordDenial("s2", "r2");
    // 访问 s1 提升为最近使用
    b.getState("s1");
    b.recordDenial("s3", "r3");
    expect(b.getState("s1")).toBeDefined();
    expect(b.getState("s2")).toBeUndefined();
    expect(b.getState("s3")).toBeDefined();
  });

  it("snapshot 按最近拒绝时间倒序", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T00:00:00Z"));
    const b = new ApprovalDenialBreaker({ threshold: 5 });
    b.recordDenial("old", "r1");
    vi.setSystemTime(new Date("2026-11-13T00:00:10Z"));
    b.recordDenial("new", "r2");
    expect(b.snapshot().map((s) => s.sessionId)).toEqual(["new", "old"]);
  });

  it("reset 支持单会话与全部", () => {
    const b = new ApprovalDenialBreaker({ threshold: 2 });
    b.recordDenial("s1", "r1");
    b.recordDenial("s2", "r2");
    expect(b.reset("s1")).toBe(1);
    expect(b.getState("s1")).toBeUndefined();
    expect(b.getState("s2")).toBeDefined();
    expect(b.reset()).toBe(1);
    expect(b.snapshot()).toHaveLength(0);
  });

  it("resolveDenialBreakerConfig 读取环境变量并做非法值回落", () => {
    expect(resolveDenialBreakerConfig({} as NodeJS.ProcessEnv).threshold).toBe(3);
    expect(resolveDenialBreakerConfig({ EVOCLAW_APPROVAL_DENIAL_THRESHOLD: "5" } as NodeJS.ProcessEnv).threshold).toBe(5);
    expect(resolveDenialBreakerConfig({ EVOCLAW_APPROVAL_DENIAL_THRESHOLD: "0" } as NodeJS.ProcessEnv).threshold).toBe(0);
    expect(resolveDenialBreakerConfig({ EVOCLAW_APPROVAL_DENIAL_THRESHOLD: "abc" } as NodeJS.ProcessEnv).threshold).toBe(3);
  });
});
