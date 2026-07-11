/**
 * Resource Pool — generic resource pool for managing reusable resources
 * such as database connections, HTTP clients, worker threads, etc.
 *
 * Features:
 *  - Min/max pool size with dynamic scaling
 *  - Idle timeout — scavenge stale resources
 *  - Acquire with timeout — fail fast when exhausted
 *  - Factory-based resource creation/destruction
 *  - Health check on borrow (optional validate before lending)
 *  - Pool stats (available, borrowed, pending)
 *  - Event hooks (acquire, release, create, destroy, error)
 */

import { EventEmitter } from "events";

// ── Types ─────────────────────────────────────────────────

export interface PooledResource<T> {
  /** Unique resource ID */
  id: number;
  /** The underlying resource */
  resource: T;
  /** When this resource was created (epoch ms) */
  createdAt: number;
  /** When this resource was last returned to the pool */
  lastReturnedAt: number;
  /** Number of times this resource has been borrowed */
  borrowCount: number;
}

export interface ResourcePoolConfig {
  /** Minimum idle resources to maintain */
  minSize: number;
  /** Maximum total resources (lent + idle) */
  maxSize: number;
  /** Acquire timeout in ms (0 = wait forever) */
  acquireTimeoutMs: number;
  /** Idle timeout: destroy resources idle longer than this (ms, 0 = never) */
  idleTimeoutMs: number;
  /** Interval for scavenging idle resources (ms) */
  scavengeIntervalMs: number;
  /** Max lifetime: destroy resources older than this (ms, 0 = never) */
  maxResourceLifetimeMs: number;
  /** Whether to validate resources before lending */
  validateOnBorrow: boolean;
  /** Whether to eagerly fill pool to minSize on start */
  prefill: boolean;
}

export interface PoolStats {
  /** Total resources created (ever) */
  totalCreated: number;
  /** Resources currently idle in the pool */
  idle: number;
  /** Resources currently borrowed */
  borrowed: number;
  /** Waiters in the acquire queue */
  pending: number;
  /** Resources destroyed due to errors */
  destroyedErrors: number;
  /** Resources destroyed due to idle timeout */
  destroyedIdle: number;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: ResourcePoolConfig = {
  minSize: 2,
  maxSize: 10,
  acquireTimeoutMs: 10_000,
  idleTimeoutMs: 60_000,
  scavengeIntervalMs: 30_000,
  maxResourceLifetimeMs: 0,
  validateOnBorrow: true,
  prefill: false,
};

interface AcquireRequest<T> {
  resolve: (r: PooledResource<T>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

// ── Pool ──────────────────────────────────────────────────

export class ResourcePool<T> extends EventEmitter {
  private config: ResourcePoolConfig;
  private factory: () => Promise<T>;
  private destroyer: (resource: T) => Promise<void>;
  private validator: (resource: T) => boolean | Promise<boolean>;

  private idle: PooledResource<T>[] = [];
  private borrowed = new Map<number, PooledResource<T>>();
  private waiters: AcquireRequest<T>[] = [];
  private scavengeTimer: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  private pendingCreates = 0;

  private stats: PoolStats = {
    totalCreated: 0,
    idle: 0,
    borrowed: 0,
    pending: 0,
    destroyedErrors: 0,
    destroyedIdle: 0,
  };

  private closed = false;

  constructor(
    factory: () => Promise<T>,
    destroyer: (resource: T) => Promise<void>,
    validator?: (resource: T) => boolean | Promise<boolean>,
    config?: Partial<ResourcePoolConfig>,
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.factory = factory;
    this.destroyer = destroyer;
    this.validator = validator ?? (() => true);

    this.on("error", (err) => {
      process.stderr.write(`[ResourcePool] error: ${err instanceof Error ? err.message : String(err)}\n`);
    });

    if (this.config.prefill) {
      this.prefillPool();
    }

    if (this.config.idleTimeoutMs > 0 && this.config.scavengeIntervalMs > 0) {
      this.scavengeTimer = setInterval(
        () => {
          // scavenge 是 async，丢弃的 Promise 若 reject 会变成 unhandledRejection，
          // 可能导致进程崩溃。这里捕获并记录错误。
          this.scavenge().catch((err) => {
            process.stderr.write(`[ResourcePool] scavenge failed: ${err instanceof Error ? err.message : String(err)}\n`);
          });
        },
        this.config.scavengeIntervalMs,
      );
      this.scavengeTimer.unref();
    }
  }

  /**
   * Acquire a resource from the pool. Returns a pooled resource that
   * MUST be released back via release() when done.
   */
  async acquire(): Promise<PooledResource<T>> {
    if (this.closed) {
      throw new Error("Pool is closed");
    }

    // Fast path: idle resource available
    const immediate = await this.tryGetIdle();
    if (immediate) return immediate;

    // Slow path: need to create or wait
    if (this.borrowed.size + this.pendingCreates < this.config.maxSize) {
      // Can create a new one
      this.pendingCreates++;
      try {
        const resource = await this.createResource();
        this.borrowResource(resource);
        return resource;
      } catch (err) {
        // Creation failed — add to wait queue
        return this.enqueueWaiter();
      } finally {
        this.pendingCreates--;
      }
    }

    // Pool exhausted — wait
    return this.enqueueWaiter();
  }

  /**
   * Release a resource back to the pool.
   */
  async release(resource: PooledResource<T>): Promise<void> {
    if (!this.borrowed.has(resource.id)) {
      // Already released or never borrowed
      return;
    }

    this.borrowed.delete(resource.id);
    resource.lastReturnedAt = Date.now();

    this.emit("release", resource);

    // Check if any waiter is pending
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      this.borrowResource(resource);
      waiter.resolve(resource);
      return;
    }

    // Return to idle pool
    this.idle.push(resource);
    this.updateStats();
  }

  /**
   * Get current pool statistics.
   */
  getStats(): PoolStats {
    return { ...this.stats };
  }

  /**
   * Get number of available idle resources.
   */
  get available(): number {
    return this.idle.length;
  }

  /**
   * Get number of borrowed resources.
   */
  get size(): number {
    return this.borrowed.size;
  }

  /**
   * Check if pool is closed.
   */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Close the pool and destroy all resources.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.scavengeTimer) {
      clearInterval(this.scavengeTimer);
      this.scavengeTimer = null;
    }

    // Reject all waiters
    for (const waiter of this.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error("Pool closed"));
    }
    this.waiters = [];

    // Destroy all idle
    for (const r of this.idle) {
      await this.safeDestroy(r);
    }
    this.idle = [];

    // Destroy all borrowed (best effort)
    for (const r of this.borrowed.values()) {
      await this.safeDestroy(r);
    }
    this.borrowed.clear();

    this.updateStats();
    this.emit("close");
  }

  configure(updates: Partial<ResourcePoolConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ── Private ─────────────────────────────────────────────

  private async tryGetIdle(): Promise<PooledResource<T> | null> {
    while (this.idle.length > 0) {
      const resource = this.idle.shift()!;

      // Check max lifetime
      if (
        this.config.maxResourceLifetimeMs > 0 &&
        Date.now() - resource.createdAt > this.config.maxResourceLifetimeMs
      ) {
        await this.safeDestroy(resource);
        this.stats.destroyedIdle++;
        continue;
      }

      // Validate on borrow
      if (this.config.validateOnBorrow) {
        try {
          const valid = await this.validator(resource.resource);
          if (!valid) {
            await this.safeDestroy(resource);
            this.stats.destroyedErrors++;
            continue;
          }
        } catch {
          await this.safeDestroy(resource);
          this.stats.destroyedErrors++;
          continue;
        }
      }

      this.borrowResource(resource);
      return resource;
    }

    return null;
  }

  private borrowResource(resource: PooledResource<T>): void {
    resource.borrowCount++;
    this.borrowed.set(resource.id, resource);
    this.updateStats();
    this.emit("acquire", resource);
  }

  private async createResource(): Promise<PooledResource<T>> {
    const item = await this.factory();
    this.stats.totalCreated++;

    const pooled: PooledResource<T> = {
      id: this.nextId++,
      resource: item,
      createdAt: Date.now(),
      lastReturnedAt: Date.now(),
      borrowCount: 0,
    };

    this.emit("create", pooled);
    return pooled;
  }

  private enqueueWaiter(): Promise<PooledResource<T>> {
    return new Promise<PooledResource<T>>((resolve, reject) => {
      const timer =
        this.config.acquireTimeoutMs > 0
          ? setTimeout(() => {
              const idx = this.waiters.findIndex((w) => w.reject === reject);
              if (idx >= 0) {
                this.waiters.splice(idx, 1);
                this.updateStats();
              }
              reject(new Error(`Acquire timeout after ${this.config.acquireTimeoutMs}ms`));
            }, this.config.acquireTimeoutMs)
          : null;

      this.waiters.push({ resolve, reject, timer });
      this.updateStats();
    });
  }

  private async scavenge(): Promise<void> {
    const now = Date.now();
    const toRemove: PooledResource<T>[] = [];

    for (const r of this.idle) {
      if (now - r.lastReturnedAt > this.config.idleTimeoutMs) {
        toRemove.push(r);
      }
    }

    if (toRemove.length > 0 && this.idle.length - toRemove.length < this.config.minSize) {
      // Keep min idle resources
      const maxRemove = this.idle.length - this.config.minSize;
      if (maxRemove <= 0) return;
      toRemove.splice(maxRemove);
    }

    for (const r of toRemove) {
      const idx = this.idle.indexOf(r);
      if (idx >= 0) this.idle.splice(idx, 1);
      await this.safeDestroy(r);
      this.stats.destroyedIdle++;
    }

    this.updateStats();
  }

  private async prefillPool(): Promise<void> {
    for (let i = 0; i < this.config.minSize; i++) {
      try {
        const r = await this.createResource();
        this.idle.push(r);
      } catch {
        // Prefill failure is non-fatal
      }
    }
    this.updateStats();
  }

  private async safeDestroy(resource: PooledResource<T>): Promise<void> {
    try {
      await this.destroyer(resource.resource);
    } catch (err) {
      this.emit("error", err, resource);
    }
  }

  private updateStats(): void {
    this.stats.idle = this.idle.length;
    this.stats.borrowed = this.borrowed.size;
    this.stats.pending = this.waiters.length;
  }
}