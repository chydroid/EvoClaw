/**
 * Model Failover Manager — circuit breaker, health checking, and provider
 * prioritization for LLM API calls.
 *
 * Features:
 *  - Circuit breaker pattern (closed → open → half-open)
 *  - Provider health monitoring with periodic checks
 *  - Automatic failover to next healthy provider
 *  - Retry with exponential backoff + jitter
 *  - Provider priority based on cost, latency, and reliability
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
    });
  }

  unregisterProvider(providerId: string): void {
    this.providers.delete(providerId);
    this.health.delete(providerId);
    this.circuitTimers.delete(providerId);
  }

  // ── Health & Circuit Breaker ──────────────────────────────────────────

  /** Record a successful call */
  recordSuccess(providerId: string, latencyMs: number): void {
    const h = this.health.get(providerId);
    if (!h) return;

    h.failureCount = 0;
    h.totalRequests++;
    h.lastSuccess = Date.now();
    h.circuitState = "closed";

    // Exponential moving average for latency
    h.avgLatencyMs =
      h.avgLatencyMs === 0
        ? latencyMs
        : h.avgLatencyMs * 0.7 + latencyMs * 0.3;
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

    if (h.failureCount >= this.config.failureThreshold) {
      this.openCircuit(providerId);
    }
  }

  /** Check if provider can be used */
  canUse(providerId: string): boolean {
    const h = this.health.get(providerId);
    if (!h || !h.active) return false;

    if (h.circuitState === "open") {
      return false;
    }

    if (h.circuitState === "half-open") {
      return true; // Allow trial
    }

    return true;
  }

  private openCircuit(providerId: string): void {
    const h = this.health.get(providerId);
    if (!h || h.circuitState === "open") return;

    h.circuitState = "open";
    console.warn(
      `[ModelFailover] Circuit OPEN for "${providerId}" after ${h.failureCount} failures`
    );

    // Schedule half-open reset
    this.circuitTimers.set(
      providerId,
      setTimeout(() => {
        const health = this.health.get(providerId);
        if (health?.circuitState === "open") {
          health.circuitState = "half-open";
          console.log(
            `[ModelFailover] Circuit HALF-OPEN for "${providerId}"`
          );
        }
      }, this.config.resetTimeoutMs)
    );
  }

  // ── Priority & Ordering ──────────────────────────────────────────────

  /**
   * Get providers sorted by priority (healthy first, then by order).
   * Returns the list the AgentModelExecutor should use for failover.
   */
  getPrioritizedProviders(): FailoverProvider[] {
    const all = Array.from(this.providers.values()).filter(
      (p) => p.enabled
    );

    // Sort: healthy first, then by order, then by weight, then by avg latency
    return all.sort((a, b) => {
      const aHealthy = this.canUse(a.id);
      const bHealthy = this.canUse(b.id);

      if (aHealthy !== bHealthy) return aHealthy ? -1 : 1;

      const ha = this.health.get(a.id);
      const hb = this.health.get(b.id);

      // Prefer lower weight (= better)
      const aW = ha?.weight ?? a.weight ?? 0;
      const bW = hb?.weight ?? b.weight ?? 0;
      if (aW !== bW) return aW - bW;

      // Prefer lower order number
      if (a.order !== b.order) return a.order - b.order;

      // Prefer lower latency
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
    // Map to our provider IDs
    const idSet = new Set(
      Array.from(this.providers.values()).map((p) => p.id)
    );

    return providers
      .filter((p) => {
        // If not registered in failover manager, pass through
        if (!idSet.has(p.id) || !this.providers.has(p.id)) return p.enabled;
        return this.canUse(p.id);
      })
      .sort((a, b) => {
        const aH = this.health.get(a.id);
        const bH = this.health.get(b.id);

        // Healthy first
        const aOk = this.canUse(a.id);
        const bOk = this.canUse(b.id);
        if (aOk !== bOk) return aOk ? -1 : 1;

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

    this.healthCheckTimer = setInterval(async () => {
      await this.runHealthChecks();
    }, this.config.healthCheckIntervalMs);
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
            console.log(
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
      } catch {
        const h = this.health.get(id);
        if (h) h.active = false;
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
    totalRequests: number;
    totalFailures: number;
    avgOverallLatencyMs: number;
  } {
    const healths = Array.from(this.health.values());
    const active = healths.filter((h) => h.active);

    return {
      totalProviders: healths.length,
      healthyProviders: active.filter((h) => h.circuitState === "closed").length,
      openCircuits: healths.filter((h) => h.circuitState === "open").length,
      totalRequests: healths.reduce((s, h) => s + h.totalRequests, 0),
      totalFailures: healths.reduce((s, h) => s + h.totalFailures, 0),
      avgOverallLatencyMs:
        active.length > 0
          ? active.reduce((s, h) => s + h.avgLatencyMs, 0) / active.length
          : 0,
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