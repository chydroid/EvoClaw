/**
 * Computed Status — derive task/step status from actual execution state
 * Inspired by OpenClaw 2026.5.7: "Computed status fields replace stored status"
 *
 * Instead of storing a status flag that can become stale, compute status at read time
 * from the actual state of underlying work.
 */

export interface ComputedStatusResult {
  status: "pending" | "running" | "completed" | "failed" | "interrupted" | "stale";
  reason: string;
  derivedFrom: string[];
  computedAt: number;
}

export interface StatusSource {
  id: string;
  type: "tool_result" | "plan_step" | "dag_node" | "checkpoint" | "message";
  status: string;
  timestamp: number;
  hasOutput: boolean;
  error?: string;
}

export class ComputedStatusEngine {
  private sources: Map<string, StatusSource> = new Map();

  registerSource(source: StatusSource): void {
    this.sources.set(source.id, source);
  }

  updateSource(id: string, updates: Partial<StatusSource>): void {
    const existing = this.sources.get(id);
    if (existing) {
      this.sources.set(id, { ...existing, ...updates });
    }
  }

  removeSource(id: string): void {
    this.sources.delete(id);
  }

  /**
   * Compute the overall status from all registered sources.
   * A task is "completed" only if ALL terminal steps produced output.
   * A task is "failed" if ANY required step failed.
   * A task is "stale" if results are older than staleThresholdMs.
   */
  computeStatus(options?: {
    requiredSourceIds?: string[];
    staleThresholdMs?: number;
  }): ComputedStatusResult {
    const now = Date.now();
    const staleThreshold = options?.staleThresholdMs ?? 30 * 60 * 1000; // 30 min default
    const requiredIds = options?.requiredSourceIds;
    const derivedFrom: string[] = [];

    const relevantSources = requiredIds
      ? Array.from(this.sources.values()).filter(s => requiredIds.includes(s.id))
      : Array.from(this.sources.values());

    if (relevantSources.length === 0) {
      return { status: "pending", reason: "No sources registered", derivedFrom: [], computedAt: now };
    }

    // Check for failures first
    const failedSources = relevantSources.filter(s => s.status === "failed");
    if (failedSources.length > 0) {
      derivedFrom.push(...failedSources.map(s => `${s.id}:failed`));
      return {
        status: "failed",
        reason: `${failedSources.length} source(s) failed: ${failedSources.map(s => s.error || s.id).join(", ")}`,
        derivedFrom,
        computedAt: now,
      };
    }

    // Check for running
    const runningSources = relevantSources.filter(s => s.status === "running");
    if (runningSources.length > 0) {
      derivedFrom.push(...runningSources.map(s => `${s.id}:running`));
      return {
        status: "running",
        reason: `${runningSources.length} source(s) still running`,
        derivedFrom,
        computedAt: now,
      };
    }

    // Check for interrupted (has running but no recent heartbeat)
    const interruptedSources = relevantSources.filter(s => s.status === "interrupted");
    if (interruptedSources.length > 0) {
      derivedFrom.push(...interruptedSources.map(s => `${s.id}:interrupted`));
      return {
        status: "interrupted",
        reason: `${interruptedSources.length} source(s) interrupted`,
        derivedFrom,
        computedAt: now,
      };
    }

    // Check if all completed with output
    const completedSources = relevantSources.filter(s => s.status === "completed" && s.hasOutput);
    const completedNoOutput = relevantSources.filter(s => s.status === "completed" && !s.hasOutput);

    if (completedNoOutput.length > 0) {
      derivedFrom.push(...completedNoOutput.map(s => `${s.id}:completed-no-output`));
      return {
        status: "failed",
        reason: `${completedNoOutput.length} source(s) completed without output (false success)`,
        derivedFrom,
        computedAt: now,
      };
    }

    // Check for stale results
    const staleSources = relevantSources.filter(s =>
      s.status === "completed" && (now - s.timestamp) > staleThreshold
    );
    if (staleSources.length > 0) {
      derivedFrom.push(...staleSources.map(s => `${s.id}:stale(${Math.round((now - s.timestamp) / 60000)}m)`));
      return {
        status: "stale",
        reason: `${staleSources.length} source(s) have results older than ${Math.round(staleThreshold / 60000)} minutes`,
        derivedFrom,
        computedAt: now,
      };
    }

    // All completed with output and fresh
    derivedFrom.push(...completedSources.map(s => `${s.id}:completed`));
    return {
      status: "completed",
      reason: `All ${completedSources.length} source(s) completed with output`,
      derivedFrom,
      computedAt: now,
    };
  }

  /**
   * Compute status for a specific set of sources (e.g., a DAG's nodes)
   */
  computeDagStatus(nodeIds: string[]): ComputedStatusResult {
    return this.computeStatus({ requiredSourceIds: nodeIds });
  }

  getSources(): StatusSource[] {
    return Array.from(this.sources.values());
  }

  clear(): void {
    this.sources.clear();
  }
}
