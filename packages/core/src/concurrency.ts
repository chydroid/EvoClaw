/**
 * Concurrency Primitives — lightweight synchronization utilities
 * for coordinating async operations.
 *
 * Features:
 *  - Semaphore: limit concurrent access to N resources
 *  - Mutex: exclusive lock (binary semaphore)
 *  - ConcurrencyLimiter: dynamic concurrency adjustment
 *  - tryAcquire() — non-blocking attempt
 *  - withResource() — RAII-style auto-release
 */

// ── Types ─────────────────────────────────────────────────

export interface SemaphoreConfig {
  /** Maximum concurrent permits */
  maxConcurrency: number;
  /** Queue type: "fifo" (default) or "lifo" */
  queueType: "fifo" | "lifo";
  /** Whether to emit events on acquire/release */
  debug: boolean;
}

export interface SemaphoreStats {
  available: number;
  waiting: number;
  maxConcurrency: number;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: SemaphoreConfig = {
  maxConcurrency: 1,
  queueType: "fifo",
  debug: false,
};

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
}

// ── Semaphore ─────────────────────────────────────────────

export class Semaphore {
  private config: SemaphoreConfig;
  private available: number;
  private waiters: Waiter[] = [];

  constructor(maxConcurrency: number);
  constructor(config: Partial<SemaphoreConfig>);
  constructor(arg: number | Partial<SemaphoreConfig>) {
    if (typeof arg === "number") {
      this.config = { ...DEFAULT_CONFIG, maxConcurrency: arg };
    } else {
      this.config = { ...DEFAULT_CONFIG, ...arg };
    }
    this.available = this.config.maxConcurrency;
  }

  /**
   * Acquire a permit. Resolves when a permit becomes available.
   * Use with try/finally or withPermit() to ensure release.
   */
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }

    // Queue for a permit
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        // When resolve is called (by release passing a permit to us),
        // the permit has already been handed off — available was 0 and the
        // next release() call will give it to the next waiter. Do not
        // decrement available here; doing so would drive the counter negative
        // because the slow-path acquire does not pre-decrement like the fast
        // path does.
        resolve: () => {
          resolve(() => this.release());
        },
        reject,
      };

      if (this.config.queueType === "lifo") {
        this.waiters.unshift(waiter);
      } else {
        this.waiters.push(waiter);
      }
    });
  }

  /**
   * Non-blocking attempt to acquire. Returns release function or null.
   */
  tryAcquire(): (() => void) | null {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    return null;
  }

  /**
   * Release a permit back to the pool.
   */
  release(): void {
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve();
    } else {
      this.available = Math.min(this.available + 1, this.config.maxConcurrency);
    }
  }

  /**
   * Execute a function under semaphore protection.
   * Auto-releases the permit when done (success or error).
   */
  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Adjust max concurrency dynamically.
   */
  setMaxConcurrency(max: number): void {
    const diff = max - this.config.maxConcurrency;
    this.config.maxConcurrency = max;
    this.available = Math.max(0, this.available + diff);

    // Wake up waiters if we increased capacity
    while (this.available > 0 && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve();
    }
  }

  /**
   * Get current semaphore stats.
   */
  getStats(): SemaphoreStats {
    return {
      available: this.available,
      waiting: this.waiters.length,
      maxConcurrency: this.config.maxConcurrency,
    };
  }

  /**
   * Discard all pending waiters.
   */
  cancelAll(reason = "Cancelled"): void {
    const waiters = [...this.waiters];
    this.waiters = [];
    for (const w of waiters) {
      w.reject(new Error(reason));
    }
  }
}

// ── Mutex ─────────────────────────────────────────────────

/**
 * Mutex — a binary semaphore (maxConcurrency = 1).
 * Convenience wrapper around Semaphore for exclusive locks.
 */
export class Mutex {
  private sem: Semaphore;

  constructor() {
    this.sem = new Semaphore(1);
  }

  /**
   * Acquire the lock. Returns a release function.
   */
  async lock(): Promise<() => void> {
    return this.sem.acquire();
  }

  /**
   * Non-blocking lock attempt. Returns release function or null.
   */
  tryLock(): (() => void) | null {
    return this.sem.tryAcquire();
  }

  /**
   * Execute a function under mutex protection.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.sem.withPermit(fn);
  }

  /**
   * Whether the mutex is currently locked.
   */
  isLocked(): boolean {
    return this.sem.getStats().available === 0;
  }

  /**
   * Get number of waiters.
   */
  get waiterCount(): number {
    return this.sem.getStats().waiting;
  }
}

// ── ConcurrencyLimiter ────────────────────────────────────

/**
 * ConcurrencyLimiter — limits concurrent execution of a function
 * without queueing. Excess calls are either rejected or wait for
 * a slot with optional timeout.
 */
export class ConcurrencyLimiter {
  private sem: Semaphore;

  constructor(maxConcurrent: number) {
    this.sem = new Semaphore(maxConcurrent);
  }

  /**
   * Run a function if concurrency allows, fails if all slots are taken.
   */
  async runOrReject<T>(fn: () => Promise<T>): Promise<T> {
    const release = this.sem.tryAcquire();
    if (!release) {
      throw new Error("Concurrency limit reached — no available slots");
    }

    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Run a function, waiting for an available slot.
   */
  async runOrWait<T>(fn: () => Promise<T>): Promise<T> {
    return this.sem.withPermit(fn);
  }

  /**
   * Current number of available slots.
   */
  get available(): number {
    return this.sem.getStats().available;
  }

  /**
   * Current number of waiters.
   */
  get waiting(): number {
    return this.sem.getStats().waiting;
  }

  /**
   * Set a new limit.
   */
  setLimit(max: number): void {
    this.sem.setMaxConcurrency(max);
  }
}