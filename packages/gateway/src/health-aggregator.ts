/**
 * Health Aggregator — aggregates health status across all channels,
 * services, and dependencies. Provides a unified view for monitoring
 * and K8s readiness/liveness probes.
 *
 * Features:
 *  - Per-channel health polling
 *  - Service dependency health
 *  - Aggregated overall status (ok/degraded/down)
 *  - Historical health events with transitions
 *  - Alerting on status degradation
 *  - Configurable health check intervals
 *  - K8s-compatible output
 */

import { EventEmitter } from "events";

// ── Types ─────────────────────────────────────────────────

export type HealthStatus = "ok" | "degraded" | "down" | "unknown";

export interface ComponentHealth {
  /** Component name */
  name: string;
  /** Component type (channel, service, dependency, database) */
  type: "channel" | "service" | "dependency" | "database" | "external";
  /** Current status */
  status: HealthStatus;
  /** When health was last checked (epoch ms) */
  lastCheckedAt: number;
  /** Response time of last check (ms, -1 if not measured) */
  responseTimeMs: number;
  /** Error message if status is down/degraded */
  error?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface AggregatedHealth {
  /** Overall system health */
  overall: HealthStatus;
  /** Per-component health */
  components: ComponentHealth[];
  /** Summary counts */
  summary: {
    total: number;
    ok: number;
    degraded: number;
    down: number;
    unknown: number;
  };
  /** When this aggregation was computed */
  computedAt: number;
  /** Uptime in seconds */
  uptimeSec: number;
  /** Whether system is ready (all critical components are ok) */
  ready: boolean;
  /** Whether system is alive (at least one component responsive) */
  alive: boolean;
}

export interface HealthTransition {
  componentName: string;
  from: HealthStatus;
  to: HealthStatus;
  timestamp: number;
  reason?: string;
}

export interface HealthAggregatorConfig {
  /** Check interval in ms */
  checkIntervalMs: number;
  /** Max transitions to keep in history */
  maxTransitions: number;
  /** Whether to auto-check on component registration */
  autoCheckOnRegister: boolean;
  /** Critical components (if any are down → overall degraded) */
  criticalComponents: string[];
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: HealthAggregatorConfig = {
  checkIntervalMs: 30_000,      // 30 seconds
  maxTransitions: 100,
  autoCheckOnRegister: false,
  criticalComponents: [],
};

// ── Aggregator ────────────────────────────────────────────

export class HealthAggregator extends EventEmitter {
  private config: HealthAggregatorConfig;
  private components = new Map<string, ComponentHealth>();
  private transitions: HealthTransition[] = [];
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private checkFns = new Map<string, () => Promise<{ ok: boolean; error?: string; responseTimeMs?: number }>>();
  private startTime: number = Date.now();

  constructor(config?: Partial<HealthAggregatorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a component with a health check function.
   */
  registerComponent(
    name: string,
    type: ComponentHealth["type"],
    checkFn: () => Promise<{ ok: boolean; error?: string; responseTimeMs?: number }>,
    metadata?: Record<string, unknown>,
  ): void {
    this.checkFns.set(name, checkFn);
    this.components.set(name, {
      name,
      type,
      status: "unknown",
      lastCheckedAt: 0,
      responseTimeMs: -1,
      metadata,
    });

    if (this.config.autoCheckOnRegister) {
      this.checkComponent(name);
    }
  }

  /**
   * Unregister a component.
   */
  unregisterComponent(name: string): boolean {
    this.checkFns.delete(name);
    return this.components.delete(name);
  }

  /**
   * Update component health directly (for callback-based health).
   */
  updateComponentHealth(
    name: string,
    status: HealthStatus,
    options?: { error?: string; responseTimeMs?: number; metadata?: Record<string, unknown> },
  ): void {
    const component = this.components.get(name);
    if (!component) return;

    const previousStatus = component.status;

    component.status = status;
    component.lastCheckedAt = Date.now();
    if (options?.responseTimeMs !== undefined) component.responseTimeMs = options.responseTimeMs;
    if (options?.error !== undefined) component.error = options.error;
    if (options?.metadata) component.metadata = { ...component.metadata, ...options.metadata };

    // Record transition
    if (previousStatus !== status) {
      this.recordTransition(name, previousStatus, status, options?.error);
      this.emit("statusChange", name, previousStatus, status);
    }
  }

  /**
   * Check health of all components.
   */
  async checkAll(): Promise<AggregatedHealth> {
    const checks = [...this.checkFns.keys()].map((name) =>
      this.checkComponent(name).catch(() => {
        this.updateComponentHealth(name, "down", { error: "Health check threw exception" });
      }),
    );

    await Promise.all(checks);
    return this.aggregate();
  }

  /**
   * Check health of a single component.
   */
  async checkComponent(name: string): Promise<ComponentHealth | null> {
    const checkFn = this.checkFns.get(name);
    const component = this.components.get(name);

    if (!checkFn || !component) return null;

    const startTime = Date.now();

    try {
      const result = await checkFn();
      const responseTime = result.responseTimeMs ?? (Date.now() - startTime);
      const status: HealthStatus = result.ok ? "ok" : "down";

      this.updateComponentHealth(name, status, {
        error: result.error,
        responseTimeMs: responseTime,
      });
    } catch (err) {
      this.updateComponentHealth(name, "down", {
        error: err instanceof Error ? err.message : "Unknown error",
        responseTimeMs: Date.now() - startTime,
      });
    }

    return this.components.get(name)!;
  }

  /**
   * Get the current aggregated health.
   */
  aggregate(): AggregatedHealth {
    const components = [...this.components.values()];
    const summary = {
      total: components.length,
      ok: components.filter((c) => c.status === "ok").length,
      degraded: components.filter((c) => c.status === "degraded").length,
      down: components.filter((c) => c.status === "down").length,
      unknown: components.filter((c) => c.status === "unknown").length,
    };

    // Determine overall status
    let overall: HealthStatus = "ok";

    // Check critical components
    const criticalDown = components.some(
      (c) =>
        this.config.criticalComponents.includes(c.name) && c.status === "down",
    );
    const criticalDegraded = components.some(
      (c) =>
        this.config.criticalComponents.includes(c.name) &&
        c.status === "degraded",
    );

    if (criticalDown) {
      overall = "down";
    } else if (criticalDegraded || summary.down > 0) {
      overall = "degraded";
    } else if (summary.degraded > 0) {
      overall = "degraded";
    } else if (summary.unknown === summary.total) {
      overall = "unknown";
    }

    const ready = summary.down === 0 && summary.unknown === 0;
    const alive = summary.ok > 0 || summary.degraded > 0;

    return {
      overall,
      components: components.map((c) => ({ ...c })),
      summary,
      computedAt: Date.now(),
      uptimeSec: Math.max(1, Math.round((Date.now() - this.startTime) / 1000)),
      ready,
      alive,
    };
  }

  /**
   * Get health for a specific component.
   */
  getComponent(name: string): ComponentHealth | null {
    return this.components.get(name) ?? null;
  }

  /**
   * Get all component health entries.
   */
  getAllComponents(): ComponentHealth[] {
    return [...this.components.values()];
  }

  /**
   * Get health by component type.
   */
  getByType(type: ComponentHealth["type"]): ComponentHealth[] {
    return [...this.components.values()].filter((c) => c.type === type);
  }

  /**
   * Get K8s-compatible health summary.
   */
  getK8sSummary(): {
    status: string;
    ready: boolean;
    alive: boolean;
    uptime: number;
    checks: Array<{ name: string; status: string; error?: string }>;
  } {
    const agg = this.aggregate();
    return {
      status: agg.overall,
      ready: agg.ready,
      alive: agg.alive,
      uptime: agg.uptimeSec,
      checks: agg.components.map((c) => ({
        name: c.name,
        status: c.status,
        error: c.error,
      })),
    };
  }

  // ── Transition History ──────────────────────────────────

  /**
   * Get recent health transitions.
   */
  getTransitions(limit?: number): HealthTransition[] {
    if (limit) return this.transitions.slice(-limit);
    return [...this.transitions];
  }

  /**
   * Clear transition history.
   */
  clearTransitions(): void {
    this.transitions = [];
  }

  // ── Polling ─────────────────────────────────────────────

  /**
   * Start periodic health checks.
   */
  startPolling(): void {
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => this.checkAll(), this.config.checkIntervalMs);
  }

  /**
   * Stop periodic health checks.
   */
  stopPolling(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Whether polling is active.
   */
  isPolling(): boolean {
    return this.checkTimer !== null;
  }

  configure(updates: Partial<HealthAggregatorConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ── Private ─────────────────────────────────────────────

  private recordTransition(
    componentName: string,
    from: HealthStatus,
    to: HealthStatus,
    reason?: string,
  ): void {
    this.transitions.push({
      componentName,
      from,
      to,
      timestamp: Date.now(),
      reason,
    });

    if (this.transitions.length > this.config.maxTransitions) {
      this.transitions = this.transitions.slice(-this.config.maxTransitions);
    }
  }
}

// ── Utility ───────────────────────────────────────────────

/**
 * Create a standard health check function from a boolean promise.
 */
export function createHealthCheck(
  fn: () => Promise<boolean>,
  name?: string,
): () => Promise<{ ok: boolean; error?: string; responseTimeMs?: number }> {
  return async () => {
    const startTime = Date.now();
    try {
      const ok = await fn();
      return { ok, error: ok ? undefined : `${name ?? "check"} failed`, responseTimeMs: Date.now() - startTime };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Check threw exception" };
    }
  };
}