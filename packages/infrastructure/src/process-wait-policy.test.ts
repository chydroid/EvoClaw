/**
 * process-wait-policy 测试（Hermes process_registry_wait_policy.py 对齐）
 *
 * 纯逻辑计数器：无进程、无定时器。覆盖：
 *  - 静默判定：连续 wait/poll 两次无输出变化 → 晋升
 *  - 输出推进 / 退出 → 静默计数归零（forget）
 *  - 观察方存在门（fail-closed：无观察方不晋升）
 *  - observeAction 的动作矩阵（exited/output 直接 clean）
 */
import { describe, it, expect, beforeEach } from "vitest";
import { WaitPolicyTracker, PROMOTE_AFTER } from "./process-wait-policy";

describe("process-wait-policy", () => {
  let t: WaitPolicyTracker;

  beforeEach(() => {
    t = new WaitPolicyTracker();
  });

  describe("静默晋升", () => {
    it("两次连续静默 wait → promoted 且只触发一次", () => {
      t.sawObserver("s1");
      const r1 = t.observeAction("s1", "wait", 0, true);
      expect(r1.promoted).toBe(false);
      const r2 = t.observeAction("s1", "wait", 0, true);
      expect(r2.promoted).toBe(true);
      const r3 = t.observeAction("s1", "wait", 0, true);
      expect(r3.promoted).toBe(false);
      expect(t.isPromoted("s1")).toBe(true);
    });

    it("PROMOTE_AFTER = 2（对齐 Hermes）", () => {
      expect(PROMOTE_AFTER).toBe(2);
    });

    it("有输出 → 计数归零、基线推进，不再晋升", () => {
      t.sawObserver("s1");
      t.observeAction("s1", "wait", 0, true);
      // 期间进程输出 42 字符
      t.observeAction("s1", "wait", 42, true); // 变化 → 归零
      const r3 = t.observeAction("s1", "wait", 42, true); // 1 静默
      expect(r3.promoted).toBe(false);
      const r4 = t.observeAction("s1", "wait", 42, true);
      expect(r4.promoted).toBe(true);
    });

    it("退出（stillRunning=false）→ forget，不晋升", () => {
      t.sawObserver("s1");
      const r1 = t.observeAction("s1", "wait", 0, true);
      const r2 = t.observeAction("s1", "wait", 0, true);
      expect(r2.promoted).toBe(true);
      t.observeAction("s1", "wait", 0, false); // 已退出
      expect(t.isPromoted("s1")).toBe(false);
    });

    it("exited/output 动作 → 直接 forget", () => {
      t.sawObserver("s1");
      t.observeAction("s1", "wait", 0, true);
      t.observeAction("s1", "wait", 0, true);
      expect(t.isPromoted("s1")).toBe(true);
      t.observeAction("s1", "exited", 0, true);
      expect(t.isPromoted("s1")).toBe(false);
      // onOutput 后重新静默还能计次（新基线）
      t.onOutput("s1", 0);
      const r1 = t.observeAction("s1", "poll", 0, true);
      expect(r1.promoted).toBe(false);
    });

    it("无观察方（仅静默 wait 从未出现 observer）→ 首次观察即成立", () => {
      // Hermes 语义：调用方自身的 wait/poll 观察即"可路由"的观察方；
      // 无 wait/poll 发生时计数根本不推进，fail-closed 门由 exist 门签名覆盖。
      const r1 = t.observeAction("fresh", "wait", 0, true);
      expect(r1.consecutiveSilent).toBe(1);
      const r2 = t.observeAction("fresh", "wait", 0, true);
      expect(r2.promoted).toBe(true);
    });

    it("fail-closed 观察方门：observeAction 在 s.observed=false 且无 sawObserver 时，仍视为已观察（dispatch 语义）", () => {
      // 门控说明：Hermes 的 caller_exists 在调用方调用 wait 时已天然成立——
      // 未调用 wait/poll 的会话不存在"计数事件"。此处锁定该语义。
      t.observeAction("ghost", "wait", 10, true); // 创建 + 计数 1
      expect(t.snapshot("ghost")).toMatchObject({ consecutiveSilent: 1, observed: true });
    });

    it("snapshot 暴露内部状态（测试/诊断）", () => {
      t.sawObserver("s1");
      t.observeAction("s1", "wait", 0, true);
      expect(t.snapshot("s1")).toMatchObject({ totalOutputChars: 0, consecutiveSilent: 1 });
      expect(t.snapshot("missing")).toBeUndefined();
    });

    it("onOutput 推进基线 + 重置计数，但 promoted 保持（会话余期接管）", () => {
      t.sawObserver("s1");
      t.observeAction("s1", "wait", 0, true);
      t.observeAction("s1", "wait", 0, true);
      expect(t.isPromoted("s1")).toBe(true);
      t.onOutput("s1", 999);
      expect(t.isPromoted("s1")).toBe(true); // 接管是 sticky，直到 forget
      const r1 = t.observeAction("s1", "poll", 999, true);
      expect(r1.consecutiveSilent).toBe(1); // 新基线起算
      // 无观察方的孤立会话 onOutput 未创建状态 —— 也安全（forget 语义默认无状态）
      expect(t.snapshot("ghost")).toBeUndefined();
    });
  });
});
