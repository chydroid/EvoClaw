/**
 * Model Failover Manager — circuit breaker, health checking, provider
 * prioritization, fallback chains, auth rotation, and health scoring
 * for LLM API calls.
 *
 * Features:
 *  - Circuit breaker pattern (closed → open → half-open) with configurable
 *    half-open probe allowance
 *  - Fallback chain: primary + ordered fallback providers
 *  - Auth rotation: rotate API keys per provider on rate-limit
 *  - Health scoring: per-provider score based on success rate, latency, error rate
 *  - Provider priority: dynamic priority adjustment based on health score
 *  - Provider health monitoring with periodic checks
 *  - Automatic failover to next healthy provider
 *  - Retry with exponential backoff + jitter
 *
 * Integrates with the existing AgentModelExecutor's tryCallLLM loop,
 * adding pre-flight provider filtering and post-call health updates.
 */

export interface FailoverConfig {
  /** Max consecutive failures before circuit opens */
  failureThreshold?: number;
  /** Circuit breaker reset timeout in ms (default: 30000) */
  resetTimeoutMs?: number;
  /** Health check interval in ms (default: 60000) */
  healthCheckIntervalMs?: number;
  /** Max retries per provider (default: 2) */
  maxRetries?: number;
  /** Base retry delay in ms (default: 1000) */
  retryBaseDelayMs?: number;
  /** Max retry delay in ms (default: 30000) */
  retryMaxDelayMs?: number;
  /** Jitter factor (0-1, default: 0.3) */
  jitterFactor?: number;
  /** Number of probe requests allowed through in half-open state (default: 1) */
  halfOpenProbeLimit?: number;
  /** Weight for success rate in health score calculation (default: 0.5) */
  healthScoreSuccessWeight?: number;
  /** Weight for latency in health score calculation (default: 0.3) */
  healthScoreLatencyWeight?: number;
  /** Weight for error rate in health score calculation (default: 0.2) */
  healthScoreErrorWeight?: number;
}

export interface ProviderHealth {
  providerId: string;
  /** Current circuit breaker state */
  circuitState: "closed" | "open" | "half-open";
  /** Consecutive failure count */
  failureCount: number;
  /** Total requests served */
  totalRequests: number;
  /** Total failures */
  totalFailures: number;
  /** Last failure timestamp */
  lastFailure?: number;
  /** Last success timestamp */
  lastSuccess?: number;
  /** Average latency in ms */
  avgLatencyMs: number;
  /** Last known error message */
  lastError?: string;
  /** Whether the provider is currently active */
  active: boolean;
  /** Custom weight for priority sorting */
  weight?: number;
  /** Computed health score (0-100, higher is better) */
  healthScore: number;
  /** Number of probe requests currently in flight during half-open */
  halfOpenProbeCount: number;
  /** Current API key index for auth rotation */
  currentKeyIndex: number;
  /** Fallback chain: ordered list of provider IDs to try on failure */
  fallbackChain: string[];
  /** Dynamic priority (lower = higher priority, adjusted by health score) */
  dynamicPriority: number;
  /** EMA of success rate for responsive health scoring */
  successRateEma: number;
}

export interface FailoverProvider {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  /** Check if provider is reachable */
  healthCheck: () => Promise<boolean>;
  /** Optional weight override for priority */
  weight?: number;
  /** API keys for auth rotation */
  apiKeys?: string[];
  /** Ordered fallback provider IDs */
  fallbacks?: string[];
}

export class ModelFailoverManager {
  private config: Required<FailoverConfig>;
  private providers = new Map<string, FailoverProvider>();
  private health = new Map<string, ProviderHealth>();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private circuitTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: FailoverConfig = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      resetTimeoutMs: config.resetTimeoutMs ?? 30000,
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 60000,
      maxRetries: config.maxRetries ?? 2,
      retryBaseDelayMs: config.retryBaseDelayMs ?? 1000,
      retryMaxDelayMs: config.retryMaxDelayMs ?? 30000,
      jitterFactor: config.jitterFactor ?? 0.3,
      halfOpenProbeLimit: config.halfOpenProbeLimit ?? 1,
      healthScoreSuccessWeight: config.healthScoreSuccessWeight ?? 0.5,
      healthScoreLatencyWeight: config.healthScoreLatencyWeight ?? 0.3,
      healthScoreErrorWeight: config.healthScoreErrorWeight ?? 0.2,
    };
  }

  // ── Provider Management ──────────────────────────────────────────────

  registerProvider(provider: FailoverProvider): void {
    this.providers.set(provider.id, provider);
    this.health.set(provider.id, {
      providerId: provider.id,
      circuitState: "closed",
      failureCount: 0,
      totalRequests: 0,
      totalFailures: 0,
      avgLatencyMs: 0,
      active: provider.enabled,
      weight: provider.weight,
      healthScore: 100,
      halfOpenProbeCount: 0,
      currentKeyIndex: 0,
      fallbackChain: provider.fallbacks ?? [],
      dynamicPriority: provider.order,
      successRateEma: 1.0,
    });
  }

  unregisterProvider(providerId: string): void {
    this.providers.delete(providerId);
    this.health.delete(providerId);
    const timer = this.circuitTimers.get(providerId);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    this.circuitTimers.delete(providerId);
  }

  // ── Fallback Chain ──────────────────────────────────────────────────

  /**
   * Resolve the full fallback chain for a provider.
   * Returns [primary, ...fallbacks] in order, skipping open-circuit providers.
   */
  resolveFallbackChain(providerId: string): string[] {
    const h = this.health.get(providerId);
    if (!h) return [providerId];

    const chain: string[] = [];
    if (this.canUse(providerId)) {
      chain.push(providerId);
    }

    for (const fallbackId of h.fallbackChain) {
      if (this.canUse(fallbackId)) {
        chain.push(fallbackId);
      }
    }

    return chain.length > 0 ? chain : [providerId];
  }

  /**
   * Set the fallback chain for a provider.
   */
  setFallbackChain(providerId: string, fallbackIds: string[]): void {
    const h = this.health.get(providerId);
    if (!h) return;
    h.fallbackChain = fallbackIds;
  }

  /**
   * Execute a function with automatic fallback chain traversal.
   * Tries each provider in the chain until one succeeds or all fail.
   */
  async executeWithFallback<T>(
    providerId: string,
    fn: (currentProviderId: string, apiKey?: string) => Promise<T>
  ): Promise<T> {
    const chain = this.resolveFallbackChain(providerId);

    let lastError: Error | undefined;
    for (const currentId of chain) {
      const startMs = Date.now();
      try {
        // half-open 探测限制：在发起真实请求前消费一个 probe 槽位，
        // 防止多个并发请求同时使用 half-open provider（原 consumeProbe 从未被调用，
        // 导致 halfOpenProbeCount 永远为 0，canUse 对 half-open 永远返回 true）。
        if (!this.consumeProbe(currentId)) {
          lastError = new Error(`Provider "${currentId}" half-open probe limit reached`);
          continue;
        }
        const apiKey = this.getCurrentApiKey(currentId);
        const result = await fn(currentId, apiKey);
        this.recordSuccess(currentId, Date.now() - startMs);
        return result;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.recordFailure(currentId, errMsg);
        lastError = err instanceof Error ? err : new Error(errMsg);

        if (this.isRateLimitError(errMsg)) {
          const rotated = this.rotateApiKey(currentId);
          if (rotated) {
            // 重试使用新的 startMs，避免记录 inflated latency 污染熔断器统计
            const retryStartMs = Date.now();
            try {
              const apiKey = this.getCurrentApiKey(currentId);
              const result = await fn(currentId, apiKey);
              this.recordSuccess(currentId, Date.now() - retryStartMs);
              return result;
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              this.recordFailure(currentId, retryMsg);
              lastError = retryErr instanceof Error ? retryErr : new Error(retryMsg);
            }
          }
        }
      }
    }

    throw lastError ?? new Error(`All providers in fallback chain failed for "${providerId}"`);
  }

  // ── Auth Rotation ───────────────────────────────────────────────────

  /**
   * Get the current API key for a provider.
   */
  getCurrentApiKey(providerId: string): string | undefined {
    const provider = this.providers.get(providerId);
    const h = this.health.get(providerId);
    if (!provider?.apiKeys?.length || !h) return undefined;
    return provider.apiKeys[h.currentKeyIndex];
  }

  /**
   * Rotate to the next API key for a provider.
   * Returns true if rotation was possible, false if only one key or no keys.
   */
  rotateApiKey(providerId: string): boolean {
    const provider = this.providers.get(providerId);
    const h = this.health.get(providerId);
    if (!provider?.apiKeys || provider.apiKeys.length <= 1 || !h) return false;

    h.currentKeyIndex = (h.currentKeyIndex + 1) % provider.apiKeys.length;
    process.stdout.write(
      `[ModelFailover] Rotated API key for "${providerId}" to index ${h.currentKeyIndex}`
    );
    return true;
  }

  /**
   * Reset the API key index for a provider back to 0.
   */
  resetApiKeyIndex(providerId: string): void {
    const h = this.health.get(providerId);
    if (h) h.currentKeyIndex = 0;
  }

  private isRateLimitError(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      lower.includes("rate") ||
      lower.includes("429") ||
      lower.includes("too many requests") ||
      lower.includes("quota") ||
      lower.includes("throttl")
    );
  }

  // ── Health & Circuit Breaker ──────────────────────────────────────────

  /** Record a successful call */
  recordSuccess(providerId: string, latencyMs: number): void {
    const h = this.health.get(providerId);
    if (!h) return;

    h.failureCount = 0;
    h.totalRequests++;
    h.lastSuccess = Date.now();
    h.successRateEma = h.successRateEma * 0.7 + 1.0 * 0.3;

    if (h.circuitState === "half-open") {
      h.halfOpenProbeCount = 0;
    }
    h.circuitState = "closed";

    h.avgLatencyMs =
      h.avgLatencyMs === 0
        ? latencyMs
        : h.avgLatencyMs * 0.7 + latencyMs * 0.3;

    this.recalculateHealthScore(providerId);
  }

  /** Record a failed call */
  recordFailure(providerId: string, error: string): void {
    const h = this.health.get(providerId);
    if (!h) return;

    h.failureCount++;
    h.totalFailures++;
    h.totalRequests++;
    h.lastFailure = Date.now();
    h.lastError = error;
    h.successRateEma = h.successRateEma * 0.7 + 0.0 * 0.3;

    if (h.circuitState === "half-open") {
      h.halfOpenProbeCount = 0;
      this.openCircuit(providerId);
    } else if (h.failureCount >= this.config.failureThreshold) {
      this.openCircuit(providerId);
    }

    this.recalculateHealthScore(providerId);
  }

  /** Check if provider can be used (pure query, no side effects) */
  canUse(providerId: string): boolean {
    const h = this.health.get(providerId);
    if (!h || !h.active) return false;

    if (h.circuitState === "open") {
      return false;
    }

    if (h.circuitState === "half-open") {
      // BUG 5.1 fix: canUse() 是查询方法，不应有副作用。
      // 原代码在此处 h.halfOpenProbeCount++ 会导致多次调用耗尽 probe 限额。
      // 副作用移到 consumeProbe() 方法，调用方在发起请求前调用。
      return h.halfOpenProbeCount < this.config.halfOpenProbeLimit;
    }

    return true;
  }

  /**
   * 消费一个 half-open probe 槽位。在发起真实请求前调用。
   * 仅在 half-open 状态下递增计数器，其他状态无操作。
   * @returns true 表示可以发起请求，false 表示 probe 限额已耗尽
   */
  consumeProbe(providerId: string): boolean {
    const h = this.health.get(providerId);
    if (!h || h.circuitState !== "half-open") {
      return true; // 非 half-open 状态不限制
    }
    if (h.halfOpenProbeCount >= this.config.halfOpenProbeLimit) {
      return false;
    }
    h.halfOpenProbeCount++;
    return true;
  }

  private openCircuit(providerId: string): void {
    const h = this.health.get(providerId);
    if (!h || h.circuitState === "open") return;

    h.circuitState = "open";
    h.halfOpenProbeCount = 0;
    process.stderr.write(
      `[ModelFailover] Circuit OPEN for "${providerId}" after ${h.failureCount} failures`
    );

    this.circuitTimers.set(
      providerId,
      setTimeout(() => {
        const health = this.health.get(providerId);
        if (health?.circuitState === "open") {
          health.circuitState = "half-open";
          health.halfOpenProbeCount = 0;
          process.stdout.write(
            `[ModelFailover] Circuit HALF-OPEN for "${providerId}"`
          );
        }
      }, this.config.resetTimeoutMs)
    );
  }

  /** Manually reset a circuit breaker to closed state */
  resetCircuit(providerId: string): void {
    const h = this.health.get(providerId);
    if (!h) return;

    const timer = this.circuitTimers.get(providerId);
    if (timer) {
      clearTimeout(timer);
      this.circuitTimers.delete(providerId);
    }

    h.circuitState = "closed";
    h.failureCount = 0;
    h.halfOpenProbeCount = 0;
    process.stdout.write(
      `[ModelFailover] Circuit RESET to CLOSED for "${providerId}"`
    );

    this.recalculateHealthScore(providerId);
  }

  /** Reset all circuit breakers */
  resetAllCircuits(): void {
    for (const providerId of this.health.keys()) {
      this.resetCircuit(providerId);
    }
  }

  // ── Health Scoring ──────────────────────────────────────────────────

  /**
   * Calculate health score for a provider based on:
   *  - Success rate (weight: healthScoreSuccessWeight)
   *  - Latency (weight: healthScoreLatencyWeight) — lower is better
   *  - Error rate (weight: healthScoreErrorWeight) — lower is better
   *
   * Score range: 0-100, higher is better.
   */
  recalculateHealthScore(providerId: string): void {
    const h = this.health.get(providerId);
    if (!h) return;

    if (h.totalRequests === 0) {
      h.healthScore = 100;
      this.updateDynamicPriority(providerId);
      return;
    }

    const successScore = h.successRateEma * 100;
    const errorRate = h.totalRequests > 0 ? h.totalFailures / h.totalRequests : 0;
    const errorScore = (1 - errorRate) * 100;

    const latencyScore = h.avgLatencyMs > 0
      ? Math.max(0, 100 - (h.avgLatencyMs / 50))
      : 100;

    const rawScore =
      successScore * this.config.healthScoreSuccessWeight +
      latencyScore * this.config.healthScoreLatencyWeight +
      errorScore * this.config.healthScoreErrorWeight;

    h.healthScore = Math.round(Math.max(0, Math.min(100, rawScore)));

    this.updateDynamicPriority(providerId);
  }

  /**
   * Get the health score for a provider.
   */
  getHealthScore(providerId: string): number {
    return this.health.get(providerId)?.healthScore ?? 0;
  }

  // ── Provider Priority ──────────────────────────────────────────────

  /**
   * Update the dynamic priority for a provider based on health score.
   * Lower dynamicPriority = higher actual priority.
   * Formula: base order * 100 + (100 - healthScore)
   */
  private updateDynamicPriority(providerId: string): void {
    const h = this.health.get(providerId);
    const p = this.providers.get(providerId);
    if (!h || !p) return;

    const baseOrder = p.order * 100;
    const healthPenalty = 100 - h.healthScore;
    const circuitPenalty = h.circuitState === "open" ? 10000 : h.circuitState === "half-open" ? 5000 : 0;

    h.dynamicPriority = baseOrder + healthPenalty + circuitPenalty;
  }

  /**
   * Manually set the priority order for a provider.
   */
  setProviderOrder(providerId: string, order: number): void {
    const p = this.providers.get(providerId);
    if (!p) return;
    p.order = order;
    this.updateDynamicPriority(providerId);
  }

  /**
   * Get providers sorted by priority (healthy first, then by dynamic priority).
   * Returns the list the AgentModelExecutor should use for failover.
   */
  getPrioritizedProviders(): FailoverProvider[] {
    const all = Array.from(this.providers.values()).filter(
      (p) => p.enabled
    );

    return all.sort((a, b) => {
      const aHealthy = this.canUse(a.id);
      const bHealthy = this.canUse(b.id);

      if (aHealthy !== bHealthy) return aHealthy ? -1 : 1;

      const ha = this.health.get(a.id);
      const hb = this.health.get(b.id);

      const aP = ha?.dynamicPriority ?? a.order * 100;
      const bP = hb?.dynamicPriority ?? b.order * 100;
      if (aP !== bP) return aP - bP;

      const aW = ha?.weight ?? a.weight ?? 0;
      const bW = hb?.weight ?? b.weight ?? 0;
      if (aW !== bW) return aW - bW;

      return (ha?.avgLatencyMs ?? 0) - (hb?.avgLatencyMs ?? 0);
    });
  }

  /**
   * Filter a provider list, returning only healthy ones in priority order.
   * This is the main entry point for ModelExecutor integration.
   */
  filterHealthy<T extends { id: string; enabled: boolean; order: number }>(
    providers: T[]
  ): T[] {
    const idSet = new Set(
      Array.from(this.providers.values()).map((p) => p.id)
    );

    return providers
      .filter((p) => {
        if (!idSet.has(p.id) || !this.providers.has(p.id)) return p.enabled;
        return this.canUse(p.id);
      })
      .sort((a, b) => {
        const aOk = this.canUse(a.id);
        const bOk = this.canUse(b.id);
        if (aOk !== bOk) return aOk ? -1 : 1;

        const aH = this.health.get(a.id);
        const bH = this.health.get(b.id);
        const aP = aH?.dynamicPriority ?? a.order * 100;
        const bP = bH?.dynamicPriority ?? b.order * 100;
        if (aP !== bP) return aP - bP;

        return a.order - b.order;
      });
  }

  // ── Retry Logic ──────────────────────────────────────────────────────

  /**
   * Calculate retry delay with exponential backoff + jitter.
   */
  getRetryDelay(attempt: number): number {
    const baseDelay = this.config.retryBaseDelayMs * Math.pow(2, attempt);
    const capped = Math.min(baseDelay, this.config.retryMaxDelayMs);
    const jitter = capped * this.config.jitterFactor * Math.random();
    return Math.floor(capped + jitter);
  }

  // ── Health Checks ────────────────────────────────────────────────────

  /** Start periodic health checks */
  startHealthChecks(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(() => {
      void this.runHealthChecks().catch((err) => {
        process.stderr.write("[ModelFailover] Health check failed:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
      });
    }, this.config.healthCheckIntervalMs);
    this.healthCheckTimer.unref?.();
  }

  /** Stop periodic health checks */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private async runHealthChecks(): Promise<void> {
    for (const [id, provider] of this.providers) {
      if (!provider.enabled) continue;

      try {
        const isHealthy = await provider.healthCheck();
        const h = this.health.get(id);
        if (!h) continue;

        if (isHealthy) {
          if (h.circuitState === "half-open") {
            h.circuitState = "closed";
            h.failureCount = 0;
            h.halfOpenProbeCount = 0;
            process.stdout.write(
              `[ModelFailover] Provider "${id}" recovered — circuit CLOSED`
            );
          }
          h.active = true;
        } else {
          h.active = false;
          if (h.circuitState === "closed") {
            h.failureCount++;
            if (h.failureCount >= this.config.failureThreshold) {
              this.openCircuit(id);
            }
          }
        }

        this.recalculateHealthScore(id);
      } catch {
        const h = this.health.get(id);
        if (h) {
          h.active = false;
          this.recalculateHealthScore(id);
        }
      }
    }
  }

  // ── Status ───────────────────────────────────────────────────────────

  getAllHealth(): ProviderHealth[] {
    return Array.from(this.health.values());
  }

  getHealth(providerId: string): ProviderHealth | undefined {
    return this.health.get(providerId);
  }

  /** Get a summary for monitoring */
  getSummary(): {
    totalProviders: number;
    healthyProviders: number;
    openCircuits: number;
    halfOpenCircuits: number;
    totalRequests: number;
    totalFailures: number;
    avgOverallLatencyMs: number;
    avgHealthScore: number;
    providers: Array<{
      id: string;
      circuitState: string;
      healthScore: number;
      dynamicPriority: number;
      currentKeyIndex: number;
      fallbackChain: string[];
    }>;
  } {
    const healths = Array.from(this.health.values());
    const active = healths.filter((h) => h.active);

    return {
      totalProviders: healths.length,
      healthyProviders: active.filter((h) => h.circuitState === "closed").length,
      openCircuits: healths.filter((h) => h.circuitState === "open").length,
      halfOpenCircuits: healths.filter((h) => h.circuitState === "half-open").length,
      totalRequests: healths.reduce((s, h) => s + h.totalRequests, 0),
      totalFailures: healths.reduce((s, h) => s + h.totalFailures, 0),
      avgOverallLatencyMs:
        active.length > 0
          ? active.reduce((s, h) => s + h.avgLatencyMs, 0) / active.length
          : 0,
      avgHealthScore:
        healths.length > 0
          ? healths.reduce((s, h) => s + h.healthScore, 0) / healths.length
          : 0,
      providers: healths.map((h) => ({
        id: h.providerId,
        circuitState: h.circuitState,
        healthScore: h.healthScore,
        dynamicPriority: h.dynamicPriority,
        currentKeyIndex: h.currentKeyIndex,
        fallbackChain: h.fallbackChain,
      })),
    };
  }

  dispose(): void {
    this.stopHealthChecks();
    for (const timer of this.circuitTimers.values()) {
      clearTimeout(timer);
    }
    this.circuitTimers.clear();
    this.providers.clear();
    this.health.clear();
  }
}
