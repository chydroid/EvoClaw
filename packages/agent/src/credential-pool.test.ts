import { describe, it, expect, beforeEach } from "vitest";
import { CredentialPool } from "./credential-pool";

describe("CredentialPool", () => {
  let pool: CredentialPool;

  beforeEach(() => {
    pool = new CredentialPool({
      strategy: "round_robin",
      credentials: [
        { apiKey: "key-1", baseUrl: "https://api1.example.com" },
        { apiKey: "key-2", baseUrl: "https://api2.example.com" },
        { apiKey: "key-3" },
      ],
    });
  });

  it("应初始化所有凭证为 ok 状态", () => {
    const stats = pool.getStats();
    expect(stats).toHaveLength(3);
    expect(stats.every((s) => s.state === "ok")).toBe(true);
  });

  it("fill_first 策略应总是返回第一个可用凭证", () => {
    const p = new CredentialPool({
      strategy: "fill_first",
      credentials: [{ apiKey: "a" }, { apiKey: "b" }],
    });
    const c1 = p.acquire();
    const c2 = p.acquire();
    expect(c1!.apiKey).toBe("a");
    expect(c2!.apiKey).toBe("a"); // fill_first 总是返回第一个
  });

  it("round_robin 策略应轮换凭证", () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = pool.acquire();
      expect(c).not.toBeNull();
      ids.push(c!.id);
    }
    // 3 个凭证轮换 2 轮
    expect(ids[0]).toBe(ids[3]);
    expect(ids[1]).toBe(ids[4]);
    expect(ids[2]).toBe(ids[5]);
  });

  it("least_used 策略应选择使用次数最少的凭证", () => {
    const p = new CredentialPool({
      strategy: "least_used",
      credentials: [{ apiKey: "a" }, { apiKey: "b" }],
    });
    // fill_first 会总是选第一个，但 least_used 会均衡
    // 先获取一次，两个凭证都有 useCount
    const c1 = p.acquire();
    const c2 = p.acquire();
    // 第三次应该选使用次数较少的
    const c3 = p.acquire();
    expect(c3).not.toBeNull();
    // 验证 least_used 策略确实在均衡负载
    const stats = p.getStats();
    const maxUse = Math.max(...stats.map((s) => s.useCount));
    const minUse = Math.min(...stats.map((s) => s.useCount));
    expect(maxUse - minUse).toBeLessThanOrEqual(1);
  });

  it("401 错误应将凭证标记为 exhausted 并设置冷却", () => {
    const c = pool.acquire();
    pool.reportFailure(c!.id, 401);
    const stats = pool.getStats();
    const failed = stats.find((s) => s.id === c!.id);
    expect(failed!.state).toBe("exhausted");
    expect(failed!.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("冷却到期后凭证应自动恢复为 ok", () => {
    const c = pool.acquire();
    const pastTime = Date.now() - 10_000;
    pool.reportFailure(c!.id, 401);
    // 模拟时间已过冷却期
    const stats = pool.getStats();
    const entry = stats.find((s) => s.id === c!.id)!;
    // 手动检查 isUsable 逻辑通过 acquire
    const futurePool = new CredentialPool({
      strategy: "fill_first",
      credentials: [{ apiKey: "x" }],
    });
    const fc = futurePool.acquire();
    futurePool.reportFailure(fc!.id, 401);
    // 冷却未到期 → 不可用
    expect(futurePool.hasAvailable()).toBe(false);
    // 冷却到期 → 可用（通过模拟时间）
    expect(futurePool.hasAvailable(Date.now() + 10 * 60 * 1000)).toBe(true);
  });

  it("终端认证错误应永久标记为 dead", () => {
    const c = pool.acquire();
    pool.reportFailure(c!.id, 401, "token_revoked");
    const stats = pool.getStats();
    const dead = stats.find((s) => s.id === c!.id);
    expect(dead!.state).toBe("dead");
    expect(dead!.deadReason).toBe("token_revoked");
  });

  it("所有凭证不可用时应返回 null", () => {
    const p = new CredentialPool({
      strategy: "fill_first",
      credentials: [{ apiKey: "only" }],
    });
    const c = p.acquire();
    p.reportFailure(c!.id, 429);
    expect(p.acquire()).toBeNull();
  });

  it("reportSuccess 应重置错误计数并恢复状态", () => {
    const c = pool.acquire();
    pool.reportFailure(c!.id, 500); // 非 401/429，不立即 exhausted
    pool.reportSuccess(c!.id);
    const stats = pool.getStats();
    const entry = stats.find((s) => s.id === c!.id);
    expect(entry!.errorCount).toBe(0);
  });

  it("availableCount 应正确反映可用凭证数", () => {
    expect(pool.availableCount()).toBe(3);
    const c = pool.acquire();
    pool.reportFailure(c!.id, 429);
    expect(pool.availableCount()).toBe(2);
  });
});
