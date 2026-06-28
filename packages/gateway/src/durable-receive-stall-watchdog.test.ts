/**
 * Durable receive journal + stall watchdog 单元测试。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InMemoryDurableReceiveJournal,
  createInMemoryDurableReceiveJournal,
  createArmableStallWatchdog,
} from "./index.js";

describe("InMemoryDurableReceiveJournal", () => {
  it("新事件应返回 accepted", async () => {
    const journal = new InMemoryDurableReceiveJournal<string>();
    const result = await journal.accept("evt-1", "payload-1");
    expect(result.kind).toBe("accepted");
    expect(result.duplicate).toBe(false);
    if (result.kind === "accepted") {
      expect(result.record.payload).toBe("payload-1");
      expect(result.record.attempts).toBe(0);
    }
  });

  it("重复事件应返回 pending（在未完成前）", async () => {
    const journal = new InMemoryDurableReceiveJournal<string>();
    await journal.accept("evt-1", "payload-1");
    const result = await journal.accept("evt-1", "payload-2");
    expect(result.kind).toBe("pending");
    expect(result.duplicate).toBe(true);
  });

  it("完成后重复事件应返回 completed", async () => {
    const journal = new InMemoryDurableReceiveJournal<string>();
    await journal.accept("evt-1", "payload-1");
    await journal.complete("evt-1");
    const result = await journal.accept("evt-1", "payload-2");
    expect(result.kind).toBe("completed");
    expect(result.duplicate).toBe(true);
  });

  it("release 应增加 attempts 并记录 lastError", async () => {
    const journal = new InMemoryDurableReceiveJournal<string>();
    await journal.accept("evt-1", "payload-1");
    const released = await journal.release("evt-1", { lastError: "timeout" });
    expect(released).toBe(true);
    const pending = await journal.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].attempts).toBe(1);
    expect(pending[0].lastError).toBe("timeout");
  });

  it("release 不存在的 id 应返回 false", async () => {
    const journal = new InMemoryDurableReceiveJournal<string>();
    const released = await journal.release("nonexistent");
    expect(released).toBe(false);
  });

  it("pending 应按 receivedAt 升序排序", async () => {
    let now = 1000;
    const journal = new InMemoryDurableReceiveJournal<string>({ now: () => now });
    await journal.accept("c", "c", { receivedAt: 3000 });
    await journal.accept("a", "a", { receivedAt: 1000 });
    await journal.accept("b", "b", { receivedAt: 2000 });
    const pending = await journal.pending();
    expect(pending.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("空 id 应抛出异常", async () => {
    const journal = new InMemoryDurableReceiveJournal<string>();
    await expect(journal.accept("   ", "payload")).rejects.toThrow("cannot be empty");
  });

  it("deletePending 应删除 pending 记录", async () => {
    const journal = new InMemoryDurableReceiveJournal<string>();
    await journal.accept("evt-1", "payload-1");
    const deleted = await journal.deletePending("evt-1");
    expect(deleted).toBe(true);
    expect(await journal.pending()).toHaveLength(0);
  });

  it("completedTtlMs 到期应自动清理墓碑", async () => {
    let now = 1000;
    const journal = new InMemoryDurableReceiveJournal<string>({
      completedTtlMs: 5000,
      now: () => now,
    });
    await journal.accept("evt-1", "payload-1");
    await journal.complete("evt-1");
    expect(journal.getCompletedCount()).toBe(1);
    now += 6000; // 超过 TTL
    await journal.accept("evt-1", "payload-2"); // 触发 pruneExpired
    expect(journal.getCompletedCount()).toBe(0);
  });

  it("pendingTtlMs 到期后重复 accept 应视为新事件", async () => {
    let now = 1000;
    const journal = new InMemoryDurableReceiveJournal<string>({
      pendingTtlMs: 5000,
      now: () => now,
    });
    await journal.accept("evt-1", "payload-1");
    now += 6000; // 超过 TTL
    const result = await journal.accept("evt-1", "payload-2");
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.record.payload).toBe("payload-2");
    }
  });

  it("工厂函数应创建可用实例", () => {
    const journal = createInMemoryDurableReceiveJournal<string>();
    expect(journal).toBeInstanceOf(InMemoryDurableReceiveJournal);
  });
});

describe("createArmableStallWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("arm 前不触发 onTimeout", () => {
    const onTimeout = vi.fn();
    const wd = createArmableStallWatchdog({
      label: "test",
      timeoutMs: 10_000,
      onTimeout,
    });
    vi.advanceTimersByTime(20_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(wd.isArmed()).toBe(false);
    wd.stop();
  });

  it("arm 后无 touch 超时应触发 onTimeout", () => {
    const onTimeout = vi.fn();
    const wd = createArmableStallWatchdog({
      label: "test",
      timeoutMs: 10_000,
      checkIntervalMs: 1_000,
      onTimeout,
    });
    wd.arm();
    vi.advanceTimersByTime(11_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith({
      idleMs: expect.any(Number),
      timeoutMs: 10_000,
    });
    expect(wd.isArmed()).toBe(false); // disarm 后置
    wd.stop();
  });

  it("touch 应刷新 lastActivityAt 防止超时", () => {
    const onTimeout = vi.fn();
    const wd = createArmableStallWatchdog({
      label: "test",
      timeoutMs: 10_000,
      checkIntervalMs: 1_000,
      onTimeout,
    });
    wd.arm();
    // 每 5 秒 touch 一次，共 30 秒
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(5_000);
      wd.touch();
    }
    expect(onTimeout).not.toHaveBeenCalled();
    wd.stop();
  });

  it("disarm 后不再监控", () => {
    const onTimeout = vi.fn();
    const wd = createArmableStallWatchdog({
      label: "test",
      timeoutMs: 10_000,
      checkIntervalMs: 1_000,
      onTimeout,
    });
    wd.arm();
    wd.disarm();
    vi.advanceTimersByTime(20_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(wd.isArmed()).toBe(false);
    wd.stop();
  });

  it("stop 后实例不可再用", () => {
    const onTimeout = vi.fn();
    const wd = createArmableStallWatchdog({
      label: "test",
      timeoutMs: 10_000,
      checkIntervalMs: 1_000,
      onTimeout,
    });
    wd.stop();
    wd.arm(); // 应被忽略
    vi.advanceTimersByTime(20_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(wd.isArmed()).toBe(false);
  });

  it("超时后应只触发一次 onTimeout（自动 disarm）", () => {
    const onTimeout = vi.fn();
    const wd = createArmableStallWatchdog({
      label: "test",
      timeoutMs: 10_000,
      checkIntervalMs: 1_000,
      onTimeout,
    });
    wd.arm();
    vi.advanceTimersByTime(50_000); // 远超 timeout
    expect(onTimeout).toHaveBeenCalledTimes(1);
    wd.stop();
  });

  it("AbortSignal 已 aborted 应直接进入 stopped 状态", () => {
    const onTimeout = vi.fn();
    const ac = new AbortController();
    ac.abort();
    const wd = createArmableStallWatchdog({
      label: "test",
      timeoutMs: 10_000,
      checkIntervalMs: 1_000,
      abortSignal: ac.signal,
      onTimeout,
    });
    wd.arm();
    vi.advanceTimersByTime(20_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(wd.isArmed()).toBe(false);
  });

  it("AbortSignal 运行中 abort 应触发 stop", () => {
    const onTimeout = vi.fn();
    const ac = new AbortController();
    const wd = createArmableStallWatchdog({
      label: "test",
      timeoutMs: 10_000,
      checkIntervalMs: 1_000,
      abortSignal: ac.signal,
      onTimeout,
    });
    wd.arm();
    vi.advanceTimersByTime(5_000);
    ac.abort(); // 触发 stop
    vi.advanceTimersByTime(20_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(wd.isArmed()).toBe(false);
  });

  it("无效 timeoutMs 应回退到默认值（不抛错）", () => {
    const onTimeout = vi.fn();
    const wd = createArmableStallWatchdog({
      label: "test",
      timeoutMs: -1, // 无效值
      checkIntervalMs: 1_000,
      onTimeout,
    });
    wd.arm();
    // 不会立即崩溃，且默认 timeoutMs=1，arm 后下次 check 即触发
    vi.advanceTimersByTime(2_000);
    expect(onTimeout).toHaveBeenCalled();
    wd.stop();
  });
});
