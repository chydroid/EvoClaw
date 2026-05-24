import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ResourcePool } from "./resource-pool";

describe("ResourcePool", () => {
  let pool: ResourcePool<{ id: string }>;
  let created: number;
  let destroyed: number;

  beforeEach(() => {
    created = 0;
    destroyed = 0;

    pool = new ResourcePool<{ id: string }>(
      async () => {
        created++;
        return { id: `res-${created}` };
      },
      async () => {
        destroyed++;
      },
      () => true,
      { minSize: 0, maxSize: 5, acquireTimeoutMs: 1000, idleTimeoutMs: 0, prefill: false },
    );
  });

  afterEach(async () => {
    await pool.close();
  });

  describe("acquire/release", () => {
    it("should create and acquire a resource", async () => {
      const r = await pool.acquire();
      expect(r.resource.id).toBe("res-1");
      expect(r.borrowCount).toBe(1);
      expect(pool.size).toBe(1);
      expect(created).toBe(1);
    });

    it("should release and reuse a resource", async () => {
      const r1 = await pool.acquire();
      await pool.release(r1);

      const r2 = await pool.acquire();
      // Should reuse the same resource
      expect(r2.id).toBe(r1.id);
      expect(r2.borrowCount).toBe(2);
      expect(created).toBe(1); // Only created once
    });

    it("should create multiple resources up to maxSize", async () => {
      const resources = [];
      for (let i = 0; i < 5; i++) {
        resources.push(await pool.acquire());
      }

      expect(pool.size).toBe(5);
      expect(created).toBe(5);
      expect(pool.available).toBe(0);

      // Release all
      for (const r of resources) {
        await pool.release(r);
      }
      expect(pool.available).toBe(5);
    });

    it("should fail acquire when pool is exhausted", async () => {
      const smallPool = new ResourcePool<{ id: string }>(
        async () => ({ id: "x" }),
        async () => {},
        () => true,
        { minSize: 0, maxSize: 1, acquireTimeoutMs: 100, idleTimeoutMs: 0 },
      );

      const r1 = await smallPool.acquire();
      // Second acquire should timeout
      await expect(smallPool.acquire()).rejects.toThrow("Acquire timeout");
      await smallPool.close();
    });
  });

  describe("validator", () => {
    it("should validate before lending", async () => {
      let validateCalled = false;

      const vpool = new ResourcePool<{ id: string }>(
        async () => ({ id: "v" }),
        async () => {},
        () => {
          validateCalled = true;
          return true;
        },
        { minSize: 0, maxSize: 5, validateOnBorrow: true, idleTimeoutMs: 0 },
      );

      const r = await vpool.acquire();
      await vpool.release(r);
      const r2 = await vpool.acquire();

      expect(validateCalled).toBe(true);
      await vpool.close();
    });

    it("should destroy invalid resources", async () => {
      let created = 0;

      const vpool = new ResourcePool<number>(
        async () => ++created,
        async () => {},
        (v) => v > 1, // First resource (v=1) is invalid
        { minSize: 0, maxSize: 5, validateOnBorrow: true, idleTimeoutMs: 0 },
      );

      const r1 = await vpool.acquire(); // Gets #1
      await vpool.release(r1);

      const r2 = await vpool.acquire(); // #1 invalid → destroy → create #2
      expect(r2.resource).toBe(2);

      await vpool.close();
    });
  });

  describe("events", () => {
    it("should emit acquire event", async () => {
      const handler = vi.fn();
      pool.on("acquire", handler);

      const r = await pool.acquire();
      expect(handler).toHaveBeenCalledTimes(1);
      await pool.release(r);
    });

    it("should emit release event", async () => {
      const handler = vi.fn();
      pool.on("release", handler);

      const r = await pool.acquire();
      await pool.release(r);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("close", () => {
    it("should close pool and reject waiters", async () => {
      // Exhaust the pool entirely
      const held: Array<Awaited<ReturnType<typeof pool.acquire>>> = [];
      for (let i = 0; i < 5; i++) {
        held.push(await pool.acquire());
      }

      // Start an acquire that will wait (pool full)
      const acquirePromise = pool.acquire();

      // Small delay to ensure acquirePromise is in wait queue
      await new Promise((r) => setTimeout(r, 10));

      await pool.close();

      await expect(acquirePromise).rejects.toThrow("Pool closed");
      expect(pool.isClosed()).toBe(true);
    });
  });

  describe("stats", () => {
    it("should track stats", async () => {
      const r = await pool.acquire();
      const stats = pool.getStats();

      expect(stats.borrowed).toBe(1);
      expect(stats.idle).toBe(0);
      expect(stats.totalCreated).toBe(1);

      await pool.release(r);

      const stats2 = pool.getStats();
      expect(stats2.borrowed).toBe(0);
      expect(stats2.idle).toBe(1);
    });
  });

  describe("configure", () => {
    it("should update config", () => {
      pool.configure({ maxSize: 20 });
    });
  });
});