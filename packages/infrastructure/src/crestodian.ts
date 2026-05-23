/**
 * Crestodian — OpenClaw Daemon Guardian / Operations Manager.
 *
 * The "Crestodian" in OpenClaw is the daemon operations manager
 * responsible for:
 *
 *   - Health probes gathering (memory, CPU, process, service health)
 *   - System overview reporting
 *   - Service operations (start, stop, restart, status)
 *   - Diagnostic data collection
 *   - Rescue channel activation for emergency access
 *   - Audit trail of all operations
 *
 * This is the operations/runbook layer — it doesn't do the actual
 * work but knows how to inspect and orchestrate everything else.
 */
import * as os from "os";
import type { EventBus } from "@evoclaw/core";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface SystemHealth {
  /** Overall status: ok | degraded | down */
  status: "ok" | "degraded" | "down";
  /** Uptime in ms */
  uptimeMs: number;
  /** OS-level metrics */
  os: {
    platform: string;
    arch: string;
    hostname: string;
    cpus: number;
    loadAvg: number[];
    totalMem: number;
    freeMem: number;
    uptime: number;
  };
  /** Process metrics */
  process: {
    pid: number;
    memoryRss: number;
    memoryHeapTotal: number;
    memoryHeapUsed: number;
    memoryExternal: number;
    cpuUser: number;
    cpuSystem: number;
    version: string;
  };
  /** Per-service status */
  services: Record<string, ServiceDiagnostic>;
  /** Timestamp */
  timestamp: string;
}

export interface ServiceDiagnostic {
  name: string;
  status: "ok" | "degraded" | "error" | "unknown";
  lastChecked: string;
  details?: Record<string, unknown>;
  error?: string;
}

export interface SystemOverview {
  version: string;
  startTime: string;
  uptimeFormatted: string;
  totalServices: number;
  healthyServices: number;
  unhealthyServices: number;
  totalMemoryGb: number;
  usedMemoryMb: number;
  arch: string;
  platform: string;
  nodeVersion: string;
  pid: number;
}

export interface OperationResult {
  success: boolean;
  operation: string;
  target: string;
  timestamp: string;
  durationMs: number;
  error?: string;
  output?: Record<string, unknown>;
}

export interface CrestodianConfig {
  /** How often to auto-check services (ms). 0 = no auto-check. */
  checkIntervalMs?: number;
  /** Max history of operations to keep */
  maxOperationHistory?: number;
}

// ──────────────────────────────────────────────────────────────
// Crestodian
// ──────────────────────────────────────────────────────────────

export class Crestodian {
  private startTime: number;
  private services = new Map<string, ServiceDiagnostic>();
  private operations: OperationResult[] = [];
  private maxOps: number;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private checkCallbacks: Array<(svc: string) => ServiceDiagnostic> = [];

  constructor(
    config: CrestodianConfig = {},
    private eventBus?: EventBus,
  ) {
    this.startTime = Date.now();
    this.maxOps = config.maxOperationHistory ?? 500;

    if (config.checkIntervalMs && config.checkIntervalMs > 0) {
      this.checkTimer = setInterval(() => {
        this.runAllChecks();
      }, config.checkIntervalMs);
    }
  }

  // ── Service Registration ──

  /**
   * Register a health check callback for a service.
   * The callback should return a ServiceDiagnostic.
   */
  registerCheck(
    name: string,
    checkFn: () => ServiceDiagnostic,
  ): void {
    this.checkCallbacks.push((svc) => {
      if (svc === name) return checkFn();
      return { name: svc, status: "unknown", lastChecked: new Date().toISOString() };
    });
  }

  /**
   * Set a service's health status directly.
   */
  setServiceHealth(name: string, status: ServiceDiagnostic["status"], details?: Record<string, unknown>): void {
    this.services.set(name, {
      name,
      status,
      lastChecked: new Date().toISOString(),
      details,
    });
  }

  /**
   * Mark a service as healthy.
   */
  markHealthy(name: string): void {
    this.setServiceHealth(name, "ok");
  }

  /**
   * Mark a service as degraded.
   */
  markDegraded(name: string, reason?: string): void {
    this.setServiceHealth(name, "degraded", { reason });
  }

  /**
   * Mark a service as errored.
   */
  markError(name: string, error: Error | string): void {
    this.setServiceHealth(name, "error", {
      error: error instanceof Error ? error.message : error,
    });
  }

  // ── Health Probes ──

  /**
   * Gather full system health report.
   */
  getHealth(): SystemHealth {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const uptimeMs = Date.now() - this.startTime;

    return {
      status: this.computeOverallStatus(),
      uptimeMs,
      os: {
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        cpus: os.cpus().length,
        loadAvg: os.loadavg(),
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        uptime: os.uptime(),
      },
      process: {
        pid: process.pid,
        memoryRss: memUsage.rss,
        memoryHeapTotal: memUsage.heapTotal,
        memoryHeapUsed: memUsage.heapUsed,
        memoryExternal: memUsage.external,
        cpuUser: cpuUsage.user,
        cpuSystem: cpuUsage.system,
        version: process.version,
      },
      services: Object.fromEntries(this.services),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Liveness check (simple boolean).
   */
  isAlive(): boolean {
    return true; // If this code runs, we're alive
  }

  /**
   * Readiness check (all services ok or degraded, none errored).
   */
  isReady(): boolean {
    for (const svc of this.services.values()) {
      if (svc.status === "error") return false;
    }
    return true;
  }

  // ── Overview ──

  /**
   * Generate a human-readable system overview.
   */
  getOverview(): SystemOverview {
    const healthy = [...this.services.values()].filter(
      (s) => s.status === "ok",
    ).length;
    const unhealthy = [...this.services.values()].filter(
      (s) => s.status !== "ok",
    ).length;

    return {
      version: process.version,
      startTime: new Date(this.startTime).toISOString(),
      uptimeFormatted: formatUptime(Date.now() - this.startTime),
      totalServices: this.services.size,
      healthyServices: healthy,
      unhealthyServices: unhealthy,
      totalMemoryGb: Number((os.totalmem() / 1_073_741_824).toFixed(1)),
      usedMemoryMb: Math.round(process.memoryUsage().rss / 1_048_576),
      arch: os.arch(),
      platform: os.platform(),
      nodeVersion: process.version,
      pid: process.pid,
    };
  }

  /**
   * Render overview as markdown string.
   */
  renderOverview(): string {
    const ov = this.getOverview();
    return [
      "**System Overview**",
      "",
      `Uptime: ${ov.uptimeFormatted}`,
      `Platform: ${ov.platform} (${ov.arch})`,
      `Node: ${ov.nodeVersion} | PID: ${ov.pid}`,
      `Services: ${ov.healthyServices}/${ov.totalServices} healthy`,
      `Memory: ${ov.usedMemoryMb}MB / ${ov.totalMemoryGb}GB`,
      `Started: ${new Date(ov.startTime).toLocaleString()}`,
    ].join("\n");
  }

  // ── Operations ──

  /**
   * Execute an operation and record the result.
   */
  async execute(
    operation: string,
    target: string,
    fn: () => Promise<unknown>,
  ): Promise<OperationResult> {
    const start = Date.now();
    try {
      const output = await fn();
      const result: OperationResult = {
        success: true,
        operation,
        target,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - start,
        output:
          typeof output === "object" && output !== null
            ? (output as Record<string, unknown>)
            : { value: output },
      };
      this.recordOperation(result);
      return result;
    } catch (err) {
      const result: OperationResult = {
        success: false,
        operation,
        target,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
      this.recordOperation(result);
      return result;
    }
  }

  /**
   * Get recent operations history.
   */
  getOperationHistory(limit?: number): OperationResult[] {
    const ops = [...this.operations].reverse();
    return limit ? ops.slice(0, limit) : ops;
  }

  // ── Diagnostics ──

  /**
   * Collect full diagnostic data for troubleshooting.
   */
  collectDiagnostics(): Record<string, unknown> {
    const health = this.getHealth();
    return {
      status: health.status,
      collectedAt: Date.now(),
      os: health.os,
      process: health.process,
      health,
      overview: this.getOverview(),
      recentOperations: this.getOperationHistory(20),
      config: {
        NODE_ENV: process.env.NODE_ENV,
      },
      env: process.env,
    };
  }

  // ── Cleanup ──

  /**
   * Stop auto-check timer.
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  // ── Internals ──

  private computeOverallStatus(): SystemHealth["status"] {
    if (this.services.size === 0) return "ok";
    const hasError = [...this.services.values()].some(
      (s) => s.status === "error",
    );
    if (hasError) return "degraded";
    return "ok";
  }

  private runAllChecks(): void {
    const allNames = new Set([
      ...this.services.keys(),
      ...this.checkCallbacks.map((_fn, i) => `check-${i}`),
    ]);

    for (const name of allNames) {
      for (const cb of this.checkCallbacks) {
        try {
          const diag = cb(name);
          this.services.set(name, diag);
        } catch {
          this.services.set(name, {
            name,
            status: "error",
            lastChecked: new Date().toISOString(),
            error: "Check threw exception",
          });
        }
      }
    }
  }

  private recordOperation(result: OperationResult): void {
    this.operations.push(result);
    if (this.operations.length > this.maxOps) {
      this.operations = this.operations.slice(-this.maxOps);
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function formatUptime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return `${hr}h ${remMin}m`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return `${day}d ${remHr}h`;
}