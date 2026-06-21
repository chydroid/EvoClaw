import {
  ServiceRegistry,
  EventBus,
  type RateLimiter,
  type RateLimitResult,
  type RateLimitStatus,
} from "@evoclaw/core";
import { SystemEvents } from "@evoclaw/core";

interface RateLimitEntry {
  total: number;
  remaining: number;
  resetAt: Date;
}

export class RateLimiterService implements RateLimiter {
  private entries = new Map<string, RateLimitEntry>();
  private defaultLimit = 100;
  private windowMs = 60000;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.startCleanupTimer();
  }

  config(limit: number, windowMs: number): void {
    this.defaultLimit = limit;
    this.windowMs = windowMs;
  }

  async consume(key: string, points = 1): Promise<RateLimitResult> {
    // BUG 12.1 fix: 防止负数 points 绕过速率限制。
    // 原代码 entry.remaining - points < 0 对负数 points 永远为 false，
    // 且 entry.remaining -= points 会增加配额。
    if (!Number.isFinite(points) || points < 0) {
      throw new Error(`Invalid points value: ${points}. Must be a non-negative finite number.`);
    }
    // points=0 是合法的"查询"操作，但仍走正常流程
    const safePoints = points === 0 ? 0 : Math.floor(points);
    const now = Date.now();
    let entry = this.entries.get(key);

    if (!entry || now > entry.resetAt.getTime()) {
      entry = {
        total: this.defaultLimit,
        remaining: this.defaultLimit,
        resetAt: new Date(now + this.windowMs),
      };
      this.entries.set(key, entry);
    }

    if (entry.remaining - safePoints < 0) {
      await this.eventBus.publish(
        SystemEvents.RATE_LIMIT_EXCEEDED,
        { key, remaining: entry.remaining },
        "rate-limiter"
      );
      return {
        allowed: false,
        remaining: Math.max(0, entry.remaining),
        resetAt: entry.resetAt,
        retryAfter: entry.resetAt.getTime() - now,
      };
    }

    entry.remaining -= safePoints;

    return {
      allowed: true,
      remaining: entry.remaining,
      resetAt: entry.resetAt,
      retryAfter: 0,
    };
  }

  async get(key: string): Promise<RateLimitStatus> {
    const entry = this.entries.get(key);
    if (!entry) {
      return {
        total: this.defaultLimit,
        remaining: this.defaultLimit,
        resetAt: new Date(Date.now() + this.windowMs),
      };
    }
    return {
      total: entry.total,
      remaining: Math.max(0, entry.remaining),
      resetAt: entry.resetAt,
    };
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /** Stop the cleanup timer. Call this when the service is being shut down. */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Periodically evict expired entries to prevent unbounded memory growth */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.entries) {
        if (now > entry.resetAt.getTime()) {
          this.entries.delete(key);
        }
      }
    }, 60_000);
    // BUG 12.2 fix: unref 防止定时器阻止进程优雅退出
    this.cleanupTimer.unref();
  }
}