import { describe, it, expect, beforeEach } from "vitest";
import { EventBus } from "@evoclaw/core";
import { QueueManager } from "./queue-manager";

/**
 * 回归：队列满且全部为 done/failed（无 pending）时，新入队不得使
 * queue.length 突破 maxQueueSize（历史 bug：无 pending 可丢时直接 push，
 * 数组无限增长）。
 */
describe("QueueManager — maxQueueSize 上限守护（回归）", () => {
  let eventBus: EventBus;
  let qm: QueueManager;
  const SESSION = "sess-cap-test";

  beforeEach(() => {
    eventBus = new EventBus();
    // 小容量 + 关闭持久化副作用（用真实目录不影响）
    qm = new QueueManager(eventBus, { maxQueueSize: 3 });
  });

  function fillQueueWith(status: "done" | "failed" | "processing", n: number) {
    const queue = (qm as unknown as { getOrCreateQueue(s: string): Array<{ status: string; createdAt: string; id: string }> }).getOrCreateQueue(SESSION);
    for (let i = 0; i < n; i++) {
      queue.push({
        id: `seed-${status}-${i}`,
        sessionId: SESSION,
        mode: "steer",
        message: "seed",
        priority: 5,
        createdAt: new Date().toISOString(),
        context: undefined,
        retryCount: 0,
        maxRetries: 0,
        status,
        lane: "main",
        generation: 0,
        queuedAheadAtEnqueue: 0,
        activeAheadAtEnqueue: 0,
      });
    }
  }

  it("满队列全为 done/failed：丢弃最旧的非活跃项以腾位，长度不超过上限", () => {
    fillQueueWith("done", 3); // 3 个 done，= maxQueueSize
    const item = qm.enqueue(SESSION, "new message");
    // 入队成功（没有抛错），且队列仍在上限内
    const queue = (qm as unknown as { getOrCreateQueue(s: string): unknown[] }).getOrCreateQueue(SESSION);
    expect(queue.length).toBeLessThanOrEqual(3);
    expect(item).toBeDefined();
  });

  it("满队列全为 processing：拒绝入队（而非突破上限）", () => {
    fillQueueWith("processing", 3);
    expect(() => qm.enqueue(SESSION, "new message")).toThrow(/at capacity|processing/i);
    // 队列长度未变
    const queue = (qm as unknown as { getOrCreateQueue(s: string): unknown[] }).getOrCreateQueue(SESSION);
    expect(queue.length).toBe(3);
  });
});
