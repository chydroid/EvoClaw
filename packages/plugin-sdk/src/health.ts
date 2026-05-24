/**
 * Health SDK — health check framework for plugins.
 */

export interface HealthStatus {
  /** Overall health */
  status: "healthy" | "degraded" | "unhealthy";
  /** Human-readable message */
  message?: string;
  /** Individual component checks */
  checks?: HealthCheck[];
  /** Timestamp */
  timestamp: Date;
}

export interface HealthCheck {
  /** Component name */
  name: string;
  /** Health status */
  status: "pass" | "warn" | "fail";
  /** Optional detail message */
  message?: string;
  /** Response time in ms */
  latencyMs?: number;
  /** Optional structured data */
  data?: Record<string, unknown>;
}

/**
 * Aggregate multiple health checks into a single status.
 */
export function aggregateHealth(checks: HealthCheck[]): HealthStatus {
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");

  return {
    status: hasFail ? "unhealthy" : hasWarn ? "degraded" : "healthy",
    checks,
    timestamp: new Date(),
    message: hasFail
      ? `${checks.filter((c) => c.status === "fail").length} checks failing`
      : hasWarn
        ? `${checks.filter((c) => c.status === "warn").length} warnings`
        : "All checks passing",
  };
}

/**
 * Create a simple pass/fail health check.
 */
export function healthCheck(
  name: string,
  fn: () => Promise<{ healthy: boolean; message?: string; data?: Record<string, unknown> }>
): () => Promise<HealthCheck> {
  return async () => {
    const start = Date.now();
    try {
      const result = await fn();
      return {
        name,
        status: result.healthy ? "pass" : "fail",
        message: result.message,
        latencyMs: Date.now() - start,
        data: result.data,
      };
    } catch (err) {
      return {
        name,
        status: "fail",
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  };
}