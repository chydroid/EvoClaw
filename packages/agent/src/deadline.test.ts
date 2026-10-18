import { describe, it, expect, vi } from "vitest";
import {
  clampTimeout,
  DeadlineExceeded,
  withDeadline,
  boundedAsync,
  ToolSuspectTracker,
  getToolSuspectTracker,
  type SuspectableBackend,
} from "./deadline";

// ═══════════════════════════════════════════════════════════
// 统一有界执行层（hermes deadline.py 的 TS 移植）
// ═══════════════════════════════════════════════════════════
describe("clampTimeout", () => {
  it("null / undefined / 非正数 / NaN → null（无界）", () => {
    expect(clampTimeout(null)).toBeNull();
    expect(clampTimeout(undefined)).toBeNull();
    expect(clampTimeout(0)).toBeNull();
    expect(clampTimeout(-1)).toBeNull();
    expect(clampTimeout(NaN)).toBeNull();
    expect(clampTimeout("abc" as unknown as number)).toBeNull();
  });

  it("正常值原样返回", () => {
    expect(clampTimeout(1000)).toBe(1000);
    expect(clampTimeout(5.5)).toBe(5.5);
  });

  it("超过安全上限的值被夹到 MAX_SAFE_TIMEOUT_MS", () => {
    expect(clampTimeout(10 ** 12)).toBe(31_536_000_000);
    expect(clampTimeout(Infinity)).toBe(31_536_000_000);
  });
});

describe("DeadlineExceeded", () => {
  it("是 Error 子类，携带 label 与 timeoutMs", () => {
    const err = new DeadlineExceeded("tool:shell_exec", 30_000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DeadlineExceeded");
    expect(err.label).toBe("tool:shell_exec");
    expect(err.timeoutMs).toBe(30_000);
    expect(err.message).toContain("deadline exceeded after 30000ms");
  });
});

describe("withDeadline", () => {
  it("正常完成（未超时）→ 返回结果", async () => {
    const result = await withDeadline(
      async () => "done",
      1000,
      { label: "fast-op" },
    );
    expect(result).toBe("done");
  });

  it("超时 → 抛 DeadlineExceeded", async () => {
    const promise = withDeadline(
      async () => new Promise<string>(() => {}), // 永不 resolve
      50,
      { label: "stuck-op" },
    );
    await expect(promise).rejects.toThrow(DeadlineExceeded);
    await expect(promise).rejects.toThrow("deadline exceeded after 50ms: stuck-op");
  });

  it("操作异常原样传播（不是超时）", async () => {
    await expect(
      withDeadline(async () => {
        throw new Error("boom");
      }, 1000),
    ).rejects.toThrow("boom");
  });

  it("null 超时 = 无界，不抛 DeadlineExceeded", async () => {
    const result = await withDeadline(async () => "ok", null);
    expect(result).toBe("ok");
  });

  it("超时后执行 onAbandon（仅一次）", async () => {
    const onAbandon = vi.fn(async () => {});
    await expect(
      withDeadline(async () => new Promise(() => {}), 50, { onAbandon }),
    ).rejects.toThrow(DeadlineExceeded);
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it("超时后 markSuspect 被调用", async () => {
    const backend: SuspectableBackend = {
      markSuspect: vi.fn(),
      ensureHealthy: () => true,
    };
    await expect(
      withDeadline(async () => new Promise(() => {}), 50, { backend, label: "b" }),
    ).rejects.toThrow(DeadlineExceeded);
    expect(backend.markSuspect).toHaveBeenCalledTimes(1);
    const reason = (backend.markSuspect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(reason).toContain("b");
    expect(reason).toContain("50ms");
  });

  it("后端不实现 markSuspect 时不抛异常", async () => {
    const backend = { ensureHealthy: () => true } as unknown as SuspectableBackend;
    await expect(
      withDeadline(async () => new Promise(() => {}), 50, { backend }),
    ).rejects.toThrow(DeadlineExceeded);
  });

  it("onAbandon 失败不影响主流程", async () => {
    const onAbandon = vi.fn(async () => {
      throw new Error("abandon cleanup failed");
    });
    await expect(
      withDeadline(async () => new Promise(() => {}), 50, { onAbandon }),
    ).rejects.toThrow(DeadlineExceeded);
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });
});

describe("boundedAsync", () => {
  it("是 withDeadline 的薄包装", async () => {
    const result = await boundedAsync(async () => "ok", 1000);
    expect(result).toBe("ok");
  });

  it("超时抛 DeadlineExceeded", async () => {
    await expect(
      boundedAsync(async () => new Promise(() => {}), 50, { label: "bounded" }),
    ).rejects.toThrow(DeadlineExceeded);
  });
});

describe("ToolSuspectTracker（hermes SuspectableBackend 的 TS 移植）", () => {
  it("markToolSuspect / isSuspect / clearToolSuspect", () => {
    const t = new ToolSuspectTracker();
    expect(t.isSuspect("shell_exec")).toBe(false);
    t.markToolSuspect("shell_exec", "timed out after 30s");
    expect(t.isSuspect("shell_exec")).toBe(true);
    expect(t.isSuspect("file_read")).toBe(false);
    t.clearToolSuspect("shell_exec");
    expect(t.isSuspect("shell_exec")).toBe(false);
  });

  it("ensureHealthy 在有 suspect 记录时返回 false", () => {
    const t = new ToolSuspectTracker();
    expect(t.ensureHealthy()).toBe(true);
    t.markToolSuspect("shell_exec", "timed out");
    expect(t.ensureHealthy()).toBe(false);
    t.clearAll();
    expect(t.ensureHealthy()).toBe(true);
  });

  it("TTL 过期后自动恢复", async () => {
    const t = new ToolSuspectTracker(50); // 50ms TTL
    t.markToolSuspect("shell_exec", "timed out");
    expect(t.isSuspect("shell_exec")).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(t.isSuspect("shell_exec")).toBe(false);
  });

  it("markSuspect 实现 SuspectableBackend 协议", () => {
    const t = new ToolSuspectTracker();
    // markSuspect 用 reason 作 key（与 markToolSuspect 不同，后者用工具名）
    t.markSuspect("some-backend: timed out after 30s");
    expect(t.ensureHealthy()).toBe(false);
  });

  it("getToolSuspectTracker 返回进程级单例", () => {
    const a = getToolSuspectTracker();
    const b = getToolSuspectTracker();
    expect(a).toBe(b);
  });
});