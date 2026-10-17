import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { MessageQueue } from "./message-queue";

/**
 * MessageQueue 退避重试的并发安全性回归测试（MQ-1）。
 *
 * 历史 bug：handler 失败后进入指数退避，退避计时器的回调里直接重入
 * processTopic。若此刻原处理循环仍持锁（handler await 未完成），同一
 * topic 会出现第二个 processTopic 实例，同一消息被两个循环先后 shift
 * 出去投递 —— 重复消费。修复后：持锁期间计时器到点只置 backoffFired
 * 标记，由持锁循环在下一轮迭代直接放行消费；锁已释放时计时器才重入。
 */
describe("MessageQueue backoff retry (MQ-1)", () => {
  let queue: MessageQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new MessageQueue(new ServiceRegistry(), new EventBus());
  });

  afterEach(() => {
    queue.dispose();
    vi.useRealTimers();
  });

  it("holds lock through the await gap: no duplicate delivery across re-entry", async () => {
    const delivered: unknown[] = [];
    let calls = 0;
    let resolveOk: (() => void) | undefined;
    const okGate = new Promise<void>((r) => (resolveOk = r));

    const handler = vi.fn(async (msg: { payload: unknown }) => {
      calls++;
      if (calls === 1) throw new Error("boom");
      await okGate; // 让 handler 在退避窗口内保持 await，模拟循环持锁跨越计时器到期
      delivered.push(msg.payload);
    });

    queue.subscribe("t", handler);
    await queue.publish("t", "m1");
    // m1 首次投递失败 → 2s 退避；到点后锁已释放 → 重入 processTopic 再投递，
    // handler 在 okGate 上挂住 → 循环重新持锁（原 bug 场景：新 publish 会与
    // 残留循环并发）
    await vi.advanceTimersByTimeAsync(3000);
    await queue.publish("t", "m2");
    await vi.advanceTimersByTimeAsync(2000);
    // m1 的第二次投递已发起（被 gate 挂住）：calls=2
    expect(calls).toBe(2);
    expect(delivered).toEqual([]);
    resolveOk!();
    // 微任务冲刷：gate 解除后 m1 投递成功 → m2 顺序投递
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    // 每条消息恰投一次：m1 成功重试 + m2；无重复消费
    expect(delivered).toEqual(["m1", "m2"]);
    expect(calls).toBe(3);
  });

  it("backoffed messages redeliver once when the flag is consumed by the holding loop", async () => {
    let failing = true;
    const delivered: unknown[] = [];
    const handler = vi.fn(async (msg: { payload: unknown }) => {
      if (failing) throw new Error("fail");
      delivered.push(msg.payload);
    });

    queue.subscribe("t", handler);
    const p1 = queue.publish("t", "a");
    failing = false;
    const p2 = queue.publish("t", "b");
    await p1;
    await p2;
    // a 失败 1 次后 2s 退避；b 直接成功
    await vi.advanceTimersByTimeAsync(10000);
    expect(delivered).toEqual(["b", "a"]);
    // a 失败 1 + 成功 1；b 成功 1 → 共 3 次 handler 调用，无重复
    expect(handler.mock.calls.length).toBe(3);
  });
});
