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

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  config(limit: number, windowMs: number): void {
    this.defaultLimit = limit;
    this.windowMs = windowMs;
  }

  async consume(key: string, points = 1): Promise<RateLimitResult> {
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

    entry.remaining -= points;

    if (entry.remaining < 0) {
      await this.eventBus.publish(
        SystemEvents.RATE_LIMIT_EXCEEDED,
        { key, remaining: entry.remaining },
        "rate-limiter"
      );
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.resetAt,
        retryAfter: entry.resetAt.getTime() - now,
      };
    }

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
}