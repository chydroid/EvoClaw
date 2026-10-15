import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { ErrorRecoveryManager } from "./error-recovery-manager";

describe("ErrorRecoveryManager.executeWithRetry", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let mgr: ErrorRecoveryManager;

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    registry.registerService("eventBus", eventBus);
    mgr = new ErrorRecoveryManager(registry, eventBus);
  });

  afterEach(() => {
    // 清理事件订阅
    (eventBus as unknown as { subscriptions?: unknown }).subscriptions = undefined;
  });

  it("确定性错误（already exists）不重试：1 次即失败，消息带 [non-retryable]", async () => {
    let calls = 0;
    const maxRetriesExceeded: unknown[] = [];
    const sub = eventBus.subscribe("error.max_retries_exceeded", async (e) => {
      maxRetriesExceeded.push(e.data);
    });

    await expect(
      mgr.executeWithRetry("file_create", "/tmp/x", async () => {
        calls += 1;
        throw new Error("File already exists: /tmp/x");
      })
    ).rejects.toThrow(/failed after 1 attempt\(s\) \[non-retryable\]/);

    expect(calls).toBe(1);
    // 非重试失败不应发 max_retries_exceeded（2026-10-14 评测修复）
    await new Promise((r) => setTimeout(r, 20));
    expect(maxRetriesExceeded).toHaveLength(0);
    eventBus.unsubscribe(sub.id);
  });

  it("瞬态错误仍按配置重试，耗尽后消息反映真实尝试次数", async () => {
    let calls = 0;
    await expect(
      mgr.executeWithRetry(
        "http_call",
        "https://x",
        async () => {
          calls += 1;
          throw new Error("connect ETIMEDOUT");
        },
        { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 }
      )
    ).rejects.toThrow(/failed after 3 attempt\(s\)/);

    expect(calls).toBe(3);
  });

  it("瞬态错误重试后成功", async () => {
    let calls = 0;
    const result = await mgr.executeWithRetry(
      "http_call",
      "https://x",
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("socket hang up");
        return "ok";
      },
      { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 2 }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("目录类错误（EISDIR）也视为不可重试", async () => {
    let calls = 0;
    await expect(
      mgr.executeWithRetry("file_read", "/tmp/dir", async () => {
        calls += 1;
        throw new Error("EISDIR: illegal operation on a directory");
      })
    ).rejects.toThrow(/\[non-retryable\]/);
    expect(calls).toBe(1);
  });
});
