import { describe, it, expect } from "vitest";
import { ConcurrentToolExecutor, type ToolCall } from "./concurrent-tool-executor";

/**
 * 回归：maxConcurrency=1 且工具"实际耗时 > toolTimeoutMs"时，
 * 超时后信号量槽位必须保持占用至后台任务真正结束才释放，
 * 否则下一个工具会在后台任务仍在跑时拿到槽位并发执行，
 * 导致实际在飞数突破上限（历史 bug：超时后 finally 提前 release）。
 */
describe("ConcurrentToolExecutor — 超时后槽位保持占用（回归）", () => {
  function makeTools(ids: string[]): ToolCall[] {
    return ids.map((id) => ({ id, name: `tool-${id}`, args: {} }));
  }

  it("超时后两个慢工具不会实际并发执行（maxConcurrency=1）", async () => {
    const exec = new ConcurrentToolExecutor({
      maxConcurrency: 1,
      toolTimeoutMs: 60,
      heartbeatTimeoutMs: 10000,
      pollIntervalMs: 100,
      enableSafetyClassification: false,
    });

    // 追踪 executor 内"实际同时在跑"的工具数（不受信号量语义影响）
    let inFlight = 0;
    let maxInFlight = 0;
    const executor = async (tool: ToolCall) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 120)); // 真实耗时 > 60ms 超时
        return `done-${tool.id}`;
      } finally {
        inFlight--;
      }
    };

    const t0 = Date.now();
    const results = await exec.execute(makeTools(["t1", "t2"]), executor);
    const elapsed = Date.now() - t0;

    // 两个工具都在 60ms 时"超时返回"，但后台还在跑到 120ms
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("timeout");
    expect(results[1].success).toBe(false);

    // 核心断言：修复前 t1 超时后槽位被提前释放，t2 立即与 t1 后台并发跑，
    // maxInFlight=2；修复后 t2 必须等 t1 后台真正结束（~120ms）才能开始，
    // 全程 maxInFlight=1。
    expect(maxInFlight).toBe(1);

    // 序列化佐证：t2 的后台实际执行起点不早于 t1 结束，
    // 总耗时至少接近 120ms（而非两个都卡在 60ms 超时点就返回后立刻结束）。
    expect(elapsed).toBeGreaterThanOrEqual(120);
  });

  it("正常完成（未超时）的工具正确释放槽位，不泄漏", async () => {
    const exec = new ConcurrentToolExecutor({
      maxConcurrency: 2,
      toolTimeoutMs: 5000,
      heartbeatTimeoutMs: 10000,
      pollIntervalMs: 100,
      enableSafetyClassification: false,
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const executor = async (tool: ToolCall) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 20));
        return `done-${tool.id}`;
      } finally {
        inFlight--;
      }
    };

    const results = await exec.execute(makeTools(["a", "b", "c"]), executor);
    expect(results.map((r) => r.success)).toEqual([true, true, true]);
    // maxConcurrency=2：三个 20ms 任务两批跑，峰值重叠数 = 2
    expect(maxInFlight).toBe(2);
    // 全部结束后无活跃执行、槽位不泄漏
    expect(exec.getActiveCount()).toBe(0);
  });
});
