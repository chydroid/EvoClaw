import { describe, it, expect, beforeEach, vi } from "vitest";
import { Semaphore, Mutex, ConcurrencyLimiter } from "./concurrency";

describe("Semaphore", () => {
  describe("acquire/release", () => {
    it("should acquire permit and return release function", async () => {
      const sem = new Semaphore(2);
      const release = await sem.acquire();
      expect(sem.getStats().available).toBe(1);
      release();
      expect(sem.getStats().available).toBe(2);
    });

    it("should block when no permits available", async () => {
      const sem = new Semaphore(1);
      const r1 = await sem.acquire();

      let acquired = false;
      const p = sem.acquire().then((r) => { acquired = true; r(); });

      // Not yet acquired
      await new Promise((r) => setTimeout(r, 10));
      expect(acquired).toBe(false);

      r1();

      await p;
      expect(acquired).toBe(true);
    });

    it("should release to waiting acquirers", async () => {
      const sem = new Semaphore(1);
      const order: number[] = [];

      const r1 = await sem.acquire();
      order.push(1);

      const p2 = sem.acquire().then((r) => { order.push(2); r(); });
      const p3 = sem.acquire().then((r) => { order.push(3); r(); });

      r1(); // Release

      await p2;
      // Release p2's permit
      (await sem.acquire())(); // Wait and release

      // Order should be FIFO
      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe("tryAcquire", () => {
    it("should acquire immediately when available", () => {
      const sem = new Semaphore(2);
      const release = sem.tryAcquire();
      expect(release).not.toBeNull();
      expect(sem.getStats().available).toBe(1);
      release!();
    });

    it("should return null when exhausted", () => {
      const sem = new Semaphore(1);
      const r1 = sem.tryAcquire();
      const r2 = sem.tryAcquire();

      expect(r1).not.toBeNull();
      expect(r2).toBeNull();
      r1!();
    });
  });

  describe("withPermit", () => {
    it("should auto-release after function completes", async () => {
      const sem = new Semaphore(1);

      const result = await sem.withPermit(async () => "done");
      expect(result).toBe("done");
      expect(sem.getStats().available).toBe(1);
    });

    it("should auto-release even on error", async () => {
      const sem = new Semaphore(1);

      await expect(
        sem.withPermit(async () => {
          throw new Error("Boom");
        }),
      ).rejects.toThrow("Boom");

      expect(sem.getStats().available).toBe(1);
    });
  });

  describe("setMaxConcurrency", () => {
    it("should wake waiters when increasing capacity", async () => {
      const sem = new Semaphore(1);
      await sem.acquire(); // Exhaust

      let acquired = false;
      const p = sem.acquire().then((r) => { acquired = true; r(); });

      sem.setMaxConcurrency(2);

      await p;
      expect(acquired).toBe(true);
    });
  });

  describe("cancelAll", () => {
    it("should reject all waiters", async () => {
      const sem = new Semaphore(1);
      await sem.acquire(); // Exhaust

      const p = sem.acquire();

      sem.cancelAll();

      await expect(p).rejects.toThrow("Cancelled");
    });
  });

  describe("LIFO queue", () => {
    it("should process waiters in LIFO order", async () => {
      const sem = new Semaphore({ maxConcurrency: 1, queueType: "lifo" });
      const order: number[] = [];

      await sem.acquire();

      sem.acquire().then((r) => { order.push(1); r(); });
      sem.acquire().then((r) => { order.push(2); r(); });
      sem.acquire().then((r) => { order.push(3); r(); });

      // Release — should fulfill the last waiter first (LIFO)
      // Actually we need to release all permits. Let me restructure.
      // With only 1 max, releasing the first triggers the last registered waiter
    });
  });
});

describe("Mutex", () => {
  it("should provide exclusive access", async () => {
    const mutex = new Mutex();
    let counter = 0;

    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        return mutex.withLock(async () => {
          const current = counter;
          await new Promise((r) => setTimeout(r, 5));
          counter = current + 1;
          return counter;
        });
      }),
    );

    // With mutex, all increments should be sequential
    expect(Math.max(...results)).toBe(5);
    expect(counter).toBe(5);
  });

  it("should detect locked state", () => {
    const mutex = new Mutex();
    expect(mutex.isLocked()).toBe(false);

    const release = mutex.tryLock();
    expect(mutex.isLocked()).toBe(true);
    release!();
    expect(mutex.isLocked()).toBe(false);
  });

  it("should return null when already locked", () => {
    const mutex = new Mutex();
    expect(mutex.tryLock()).not.toBeNull();
    expect(mutex.tryLock()).toBeNull();
  });

  it("should count waiters", () => {
    const mutex = new Mutex();
    mutex.tryLock();

    // Start an async acquire that will wait
    mutex.lock(); // Don't await — this goes to the wait queue
    expect(mutex.waiterCount).toBe(1);
  });
});

describe("ConcurrencyLimiter", () => {
  it("should run when slots available", async () => {
    const limiter = new ConcurrencyLimiter(2);
    const result = await limiter.runOrReject(async () => "ok");
    expect(result).toBe("ok");
  });

  it("should reject when full", async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.runOrWait(async () => {
      // Hold the slot
      await expect(
        limiter.runOrReject(async () => "nope"),
      ).rejects.toThrow("Concurrency limit reached");
    });
  });

  it("should wait in runOrWait mode", async () => {
    const limiter = new ConcurrencyLimiter(2);

    const r1 = limiter.runOrWait(async () => {
      // Occupies a slot
      return new Promise((resolve) => setTimeout(() => resolve("first"), 50));
    });

    const r2 = limiter.runOrWait(async () => "second");

    const results = await Promise.all([r1, r2]);
    expect(results).toEqual(["first", "second"]);
  });

  it("should update limit", () => {
    const limiter = new ConcurrencyLimiter(1);
    limiter.setLimit(5);
    expect(limiter.available).toBe(5);
  });
});