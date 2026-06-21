/**
 * RateLimitTracker — 解析和追踪 LLM provider 的 x-ratelimit-* 响应头
 *
 * 借鉴 hermes-agent 的 rate_limit_tracker.py 设计：
 * - 解析 12 个 x-ratelimit-* header
 * - 维护 requests_min / requests_hour / tokens_min / tokens_hour 四维计数
 * - 提供 waitForReset() 辅助调用方决定退避策略
 */

export interface RateLimitBucket {
  limit: number | null;
  remaining: number | null;
  resetSeconds: number | null;
  capturedAt: number;
}

export interface RateLimitState {
  requestsMin: RateLimitBucket;
  requestsHour: RateLimitBucket;
  tokensMin: RateLimitBucket;
  tokensHour: RateLimitBucket;
}

function emptyBucket(): RateLimitBucket {
  return { limit: null, remaining: null, resetSeconds: null, capturedAt: 0 };
}

function emptyState(): RateLimitState {
  return {
    requestsMin: emptyBucket(),
    requestsHour: emptyBucket(),
    tokensMin: emptyBucket(),
    tokensHour: emptyBucket(),
  };
}

function parseHeader(headers: Record<string, string>, name: string): number | null {
  const lower = name.toLowerCase();
  // 先精确匹配，再小写匹配，最后遍历查找（大小写不敏感）
  const raw = headers[name] ?? headers[lower] ?? findHeaderCI(headers, lower);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 大小写不敏感查找 header 值 */
function findHeaderCI(headers: Record<string, string>, lowerName: string): string | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) return headers[key];
  }
  return undefined;
}

function parseBucket(
  headers: Record<string, string>,
  prefix: string,
  capturedAt: number
): RateLimitBucket {
  return {
    limit: parseHeader(headers, `x-ratelimit-limit-${prefix}`),
    remaining: parseHeader(headers, `x-ratelimit-remaining-${prefix}`),
    resetSeconds: parseHeader(headers, `x-ratelimit-reset-${prefix}`),
    capturedAt,
  };
}

export class RateLimitTracker {
  private states = new Map<string, RateLimitState>();

  /**
   * 从响应头更新 provider 的速率限制状态。
   * @param provider provider 名称
   * @param headers HTTP 响应头（小写或原始大小写均可）
   * @param now 当前时间戳（默认 Date.now()）
   */
  update(provider: string, headers: Record<string, string>, now = Date.now()): void {
    let state = this.states.get(provider);
    if (!state) {
      state = emptyState();
      this.states.set(provider, state);
    }

    state.requestsMin = parseBucket(headers, "requests-min", now);
    state.requestsHour = parseBucket(headers, "requests-hour", now);
    state.tokensMin = parseBucket(headers, "tokens-min", now);
    state.tokensHour = parseBucket(headers, "tokens-hour", now);

    // 也支持不带 -min/-hour 后缀的简写形式
    const simpleLimit = parseHeader(headers, "x-ratelimit-limit");
    const simpleRemaining = parseHeader(headers, "x-ratelimit-remaining");
    const simpleReset = parseHeader(headers, "x-ratelimit-reset");
    if (simpleLimit != null && state.requestsMin.limit == null) {
      state.requestsMin = { limit: simpleLimit, remaining: simpleRemaining, resetSeconds: simpleReset, capturedAt: now };
    }
  }

  /** 获取 provider 的当前速率限制状态 */
  get(provider: string): RateLimitState | null {
    return this.states.get(provider) ?? null;
  }

  /**
   * 判断 provider 是否接近速率限制。
   * 当任一维度 remaining <= 0 或 remaining / limit < 0.1 时返回 true。
   */
  isNearLimit(provider: string): boolean {
    const state = this.states.get(provider);
    if (!state) return false;
    return [state.requestsMin, state.requestsHour, state.tokensMin, state.tokensHour].some(
      (b) => b.remaining != null && b.limit != null && (b.remaining <= 0 || b.remaining / b.limit < 0.1)
    );
  }

  /**
   * 计算需要等待多少毫秒才能恢复。
   * 返回 0 表示无需等待，返回 Infinity 表示无数据无法判断。
   */
  waitForResetMs(provider: string, now = Date.now()): number {
    const state = this.states.get(provider);
    if (!state) return Infinity;

    const buckets = [state.requestsMin, state.requestsHour, state.tokensMin, state.tokensHour];
    let maxWait = 0;
    for (const b of buckets) {
      if (b.remaining != null && b.remaining <= 0 && b.resetSeconds != null) {
        const resetMs = b.capturedAt + b.resetSeconds * 1000 - now;
        if (resetMs > maxWait) maxWait = resetMs;
      }
    }
    return Math.max(0, maxWait);
  }

  /** 清除 provider 的状态 */
  clear(provider: string): void {
    this.states.delete(provider);
  }

  /** 清除所有状态 */
  clearAll(): void {
    this.states.clear();
  }
}
