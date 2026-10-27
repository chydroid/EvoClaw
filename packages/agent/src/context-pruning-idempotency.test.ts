/**
 * P0-5 Fix E：ContextPruning hard-clear 幂等性。
 *
 * 根因：hard-clear 按位置滑动（idx < cutoffIndex），每轮新消息使 cutoffIndex
 * 前移一条 → 每轮多清一条 tool 结果 → history 内容逐轮变化 → 永久缓存 miss。
 *
 * 修复：llm-caller 在 prune 后把剪枝结果写回 conversationHistory。
 * 已剪枝内容（占位串）二次 prune → 再清产生相同占位串 → 字节稳定（幂等）。
 *
 * 本测试验证：对同一（已剪枝）输入二次 prune，输出与一次 prune 字节一致。
 */
import { describe, it, expect } from "vitest";
import { ContextPruningManager } from "./context-pruning";

/** 构造 N 条 tool 结果 + 交错 user/assistant 的历史（超 hard-clear 阈值） */
function makeHistory(toolCount: number): Array<{ role: string; content: string }> {
  const msgs: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < toolCount; i++) {
    msgs.push({ role: "user", content: `q${i}` });
    msgs.push({ role: "tool", content: `tool-result-${i}-${"x".repeat(5000)}` });
    msgs.push({ role: "assistant", content: `a${i}` });
  }
  return msgs;
}

describe("P0-5 Fix E — ContextPruning hard-clear 幂等性", () => {
  it("hard-clear 二次 prune 输出字节一致（幂等）", () => {
    const mgr = new ContextPruningManager({
      softTrimThreshold: 4000,
      hardClearTurnThreshold: 2, // >4 条消息触发 hard-clear
      enableSoftTrim: true,
      enableHardClear: true,
    });
    const history = makeHistory(10); // 30 条消息，远超阈值

    const first = mgr.prune(history);
    // 写回后的历史（模拟 llm-caller 的 conversationHistory.set 写回）
    const writtenBack = first.prunedMessages;

    const second = mgr.prune(writtenBack);
    // 幂等：二次 prune 输出与一次 prune 的写回内容字节一致
    expect(second.prunedMessages).toEqual(writtenBack);
  });

  it("hard-clear 二次 prune 不再新增 hardCleared（占位串不被重复计数）", () => {
    const mgr = new ContextPruningManager({
      softTrimThreshold: 4000,
      hardClearTurnThreshold: 2,
      enableSoftTrim: true,
      enableHardClear: true,
    });
    const history = makeHistory(10);

    const first = mgr.prune(history);
    expect(first.stats.hardCleared).toBeGreaterThan(0);

    const second = mgr.prune(first.prunedMessages);
    // 已剪枝的占位串长度 < softTrimThreshold，hard-clear 再清同一批
    // → hardCleared 计数应等于一次 prune 中已被清的 tool 消息数（不新增）
    // 占位串本身也会被 hard-clear "再清"（同位置），但内容不变 → 幂等。
    // 关键断言：输出字节一致（上面的测试已覆盖），此处验证 stats 不膨胀。
    expect(second.stats.hardCleared).toBeLessThanOrEqual(first.stats.hardCleared);
  });

  it("soft-trim 幂等（trimmed 串含 marker ≤ 阈值 → 二次 trim 不再触发）", () => {
    const mgr = new ContextPruningManager({
      softTrimThreshold: 4000,
      hardClearTurnThreshold: 100, // 禁用 hard-clear 干扰
      enableSoftTrim: true,
      enableHardClear: false,
    });
    const history = [
      { role: "user", content: "q" },
      { role: "tool", content: "y".repeat(5000) },
      { role: "assistant", content: "a" },
    ];

    const first = mgr.prune(history);
    expect(first.stats.softTrimmed).toBe(1);

    // trimmed 串 = head(2800) + marker(~40) + tail(1150) ≈ 3990 < 4000
    // → 二次 trim 不再触发（softTrimmed=0），输出字节一致。
    const second = mgr.prune(first.prunedMessages);
    expect(second.stats.softTrimmed).toBe(0);
    expect(second.prunedMessages).toEqual(first.prunedMessages);
  });
});
