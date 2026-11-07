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

  describe("模型级冷却（对齐 Hermes credential_pool_model_cooldowns.py）", () => {
    /** 池策略：round_robin，key-1/key-2/key-3；每个 it 独立重建（rrIndex 从 0 起） */

    it("某模型 429 只冷却该模型：兄弟模型仍可复用被冷却凭证", () => {
      const p = new CredentialPool({
        strategy: "fill_first",
        credentials: [{ apiKey: "a" }, { apiKey: "b" }],
      });
      const a = p.acquire("claude-opus-4")!; // fill_first → 第一条（apiKey a）
      p.reportModelRateLimit(a.id, "claude-opus-4");
      // 同模型复用：被冷却的 a 不入选 → 返回 b
      const opusNext = p.acquire("claude-opus-4")!;
      expect(opusNext.apiKey).toBe("b");
      // 兄弟模型（sonnet）不受影响：仍可复用 a（fill_first 首选即是 a）
      const sonnet = p.acquire("claude-sonnet-4")!;
      expect(sonnet.apiKey).toBe("a");
    });

    it("未指定模型时保守：任一活跃模型级冷却即跳过该凭证", () => {
      const first = pool.acquire("claude-opus-4")!; // rr0 → key-1
      pool.reportModelRateLimit(first.id, "claude-opus-4");
      // 调用者无模型上下文 → 保守：key-1 上任何活跃模型冷却均阻断复用
      const second = pool.acquire()!;
      expect(second.apiKey).not.toBe("key-1");
    });

    it("模型级冷却到期后凭证恢复可用", () => {
      const c = pool.acquire("claude-opus-4")!; // key-1
      const futureExpiry = Date.now() + 60 * 1000;
      pool.reportModelRateLimit(c.id, "claude-opus-4", futureExpiry);
      // 冷却写入固定到期时间（可被检测/到期恢复逻辑使用）
      const stats = pool.getStats();
      const until = stats.find((s) => s.id === c.id)!.modelCooldowns?.["claude-opus-4"];
      expect(until).toBe(futureExpiry);
      // 该凭证在冷却期内对 opus-4 模拟不可用 → 直接断言到期后 modelCooldownUntil 归零
      expect(pool.modelCooldownUntil(stats.find((s) => s.id === c.id)!, "claude-opus-4", futureExpiry + 1)).toBe(0);
    });

    it("模型级冷却到期后 provider 等待已清零", () => {
      const c = pool.acquire("claude-opus-4")!;
      pool.reportModelRateLimit(c.id, "claude-opus-4", Date.now() - 5_000); // 已过期
      // 冷却已过期 → 对 opus-4 的下次选择可用（round_robin 下一次恰好可能选到该凭证）
      // 验证方式：modelCooldownUntil 现在到期
      const stats = pool.getStats();
      const entry = stats.find((s) => s.id === c.id)!;
      expect(pool.modelCooldownUntil(entry, "claude-opus-4")).toBe(0);
      // acquire 可再拿到该凭证（若 rr 轮转回它）
      const next = pool.acquire("claude-opus-4")!;
      expect(next).not.toBeNull();
    });

    it("按 key 报告模型级冷却（provider 视角 Key-first）", () => {
      pool.reportModelRateLimitForKey("key-1", "claude-sonnet-4");
      const stats = pool.getStats();
      // key-1 记录 sonnet-4 冷却
      expect(stats[0].modelCooldowns?.["claude-sonnet-4"]).toBeGreaterThan(Date.now());
      // 下次选 sonnet-4 → 不被 key-1 选中
      const next = pool.acquire("claude-sonnet-4")!;
      expect(next.apiKey).not.toBe("key-1");
    });

    it("同 key 孪生条目共享模型级冷却（传播不漏）", () => {
      const twinPool = new CredentialPool({
        strategy: "fill_first",
        credentials: [
          { apiKey: "shared" },
          { apiKey: "shared" },
        ],
      });
      const t = twinPool.acquire()!; // 孪生之一条
      twinPool.reportModelRateLimit(t.id, "claude-opus-4");
      // 两个孪生条目都记录了该模型冷却（共享 token 同限流）
      const stats = twinPool.getStats();
      const cooled = stats.filter((s) => s.modelCooldowns?.["claude-opus-4"] != null);
      expect(cooled).toHaveLength(2);
      // 冷却期内任何模型都无法复用这对孪生
      expect(twinPool.acquire("claude-opus-4")).toBeNull();
    });

    it("凭证级冷却与模型级冷却独立（604 正交性）", () => {
      const c = pool.acquire("claude-opus-4")!; // key-1
      pool.reportFailure(c.id, 401); // 凭证级冷却 5min
      const stats = pool.getStats();
      // 凭证级冷却导致 key-1 exhausted → 对任何模型均不可用（先于模型过滤）
      expect(pool.acquire("claude-sonnet-4")).not.toBeNull(); // sonnet 用其他 key
      // 冷却到期恢复后，模型过滤始终参与—— modelCooldownUntil = 0（无模型冷却）
      const s = stats.find((x) => x.id === c.id)!;
      expect(s.modelCooldowns).toEqual({});
    });
  });
});
