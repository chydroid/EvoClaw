/**
 * R11 P0 死码接线测试（台账第 5 项）
 *  - ModelFailoverManager 记账镜像：executor recordProviderSuccess/Failure 转发
 *  - getLiveProviderHealthSnapshot / resetLiveProviderCircuit：活熔断状态面
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ModelFailoverManager } from "./model-failover";
import { ProviderHealthTracker, getLiveProviderHealthSnapshot, resetLiveProviderCircuit } from "./llm-caller";

describe("R11 P0: ModelFailoverManager 记账镜像契约", () => {
  let fm: ModelFailoverManager;

  beforeEach(() => {
    fm = new ModelFailoverManager({ failureThreshold: 3, resetTimeoutMs: 60_000 });
  });

  afterEach(() => {
    fm.dispose();
  });

  it("recordSuccess/recordFailure 驱动健康分与请求统计（status 路由数据源）", () => {
    fm.registerProvider({ id: "p1", name: "P1", enabled: true, order: 1, healthCheck: async () => true });
    fm.recordSuccess("p1", 120);
    fm.recordSuccess("p1", 80);
    fm.recordFailure("p1", "HTTP 500: internal");

    const h = fm.getHealth("p1")!;
    expect(h.totalRequests).toBe(3);
    expect(h.totalFailures).toBe(1);
    expect(h.lastError).toContain("HTTP 500");
    expect(h.avgLatencyMs).toBeGreaterThan(0);
    expect(h.circuitState).toBe("closed"); // 1 次失败未达阈值
  });

  it("连续失败达阈值 → 熔断 open（镜像态与活门控分离，均可见）", () => {
    fm.registerProvider({ id: "p2", name: "P2", enabled: true, order: 1, healthCheck: async () => true });
    for (let i = 0; i < 3; i++) fm.recordFailure("p2", "timeout");
    expect(fm.getHealth("p2")!.circuitState).toBe("open");
    // 活门控不受 manager 镜像影响（两个独立状态域）
    expect(getLiveProviderHealthSnapshot("p2")?.tripped ?? false).toBe(false);
  });

  it("resetCircuit 恢复 closed（reset 路由的 manager 侧语义）", () => {
    fm.registerProvider({ id: "p3", name: "P3", enabled: true, order: 1, healthCheck: async () => true });
    for (let i = 0; i < 5; i++) fm.recordFailure("p3", "boom");
    expect(fm.getHealth("p3")!.circuitState).toBe("open");
    fm.resetCircuit("p3");
    expect(fm.getHealth("p3")!.circuitState).toBe("closed");
    expect(fm.getHealth("p3")!.failureCount).toBe(0);
  });

  it("getSummary 汇总面可供 /api/system/failover/status 直接消费", () => {
    fm.registerProvider({ id: "p4", name: "P4", enabled: true, order: 1, healthCheck: async () => true });
    fm.recordSuccess("p4", 50);
    const summary = fm.getSummary();
    expect(summary.totalProviders).toBe(1);
    expect(summary.healthyProviders).toBe(1);
    expect(summary.totalRequests).toBe(1);
    expect(summary.providers[0]!.id).toBe("p4");
  });
});

describe("R11 P0: 活熔断状态面（getLiveProviderHealthSnapshot / resetLiveProviderCircuit）", () => {
  const tracker = new ProviderHealthTracker(2, 30_000);
  // 直接操作同一实例无法生效（llm-caller 用模块级单例）——这里验证公开函数的
  // 行为契约：未知 provider → null / 0；reset 全量返回清除数 ≥ 0。

  it("未知 provider → snapshot null（不建空档）", () => {
    expect(getLiveProviderHealthSnapshot(`nonexistent-${Date.now()}`)).toBeNull();
  });

  it("reset 单个未知 provider → 0", () => {
    expect(resetLiveProviderCircuit(`nonexistent-${Date.now()}`)).toBe(0);
  });

  it("reset 全量 → 返回非负清除数", () => {
    const n = resetLiveProviderCircuit();
    expect(n).toBeGreaterThanOrEqual(0);
  });
});

describe("R11 P0: ProviderHealthTracker IfKnown 方法（状态面内部契约）", () => {
  it("getSnapshotIfKnown 未知 → null，已知 → 快照", () => {
    const t = new ProviderHealthTracker();
    expect(t.getSnapshotIfKnown("x")).toBeNull();
    t.recordSuccess("x", 10);
    const snap = t.getSnapshotIfKnown("x")!;
    expect(snap.tripped).toBe(false);
    expect(snap.totalSuccesses).toBe(1);
  });

  it("resetIfKnown 只清已存在的记录", () => {
    const t = new ProviderHealthTracker();
    expect(t.resetIfKnown("y")).toBe(false);
    t.recordFailure("y");
    t.recordFailure("y");
    expect(t.resetIfKnown("y")).toBe(true);
    expect(t.getSnapshotIfKnown("y")).toBeNull();
  });

  it("resetAllKnown 返回清除数", () => {
    const t = new ProviderHealthTracker();
    t.recordSuccess("a", 1);
    t.recordSuccess("b", 1);
    expect(t.resetAllKnown()).toBe(2);
    expect(t.resetAllKnown()).toBe(0);
  });
});
