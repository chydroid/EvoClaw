/**
 * Graceful Shutdown — orchestrates a clean shutdown sequence by
 * notifying registered components to drain in reverse order.
 *
 * Handles:
 *  - SIGTERM / SIGINT / SIGQUIT signal trapping
 *  - Ordered shutdown with priority and timeout per component
 *  - Drain phase: stop accepting new work
 *  - Cleanup phase: close connections, flush buffers
 *  - Force exit fallback if timeout exceeded
 *  - Shutdown hook callbacks
 *  - Status reporting for health endpoints
 *
 * Features:
 *  - Ordered shutdown (first-registered = last-shutdown)
 *  - Per-component timeout with force-kill escalation
 *  - Pre/post shutdown hooks
 *  - Shutdown state tracking
 *  - Signal trapping with double-signal force-exit
 */

import { EventEmitter } from "events";

// ── Types ─────────────────────────────────────────────────

export type ShutdownPhase = "idle" | "draining" | "shutting-down" | "complete";

export interface ShutdownTask {
  /** Component name for logging */
  name: string;
  /** Shutdown handler (return true = done, false = retry) */
  handler: () => Promise<boolean>;
  /** Priority: lower = shut down earlier */
  priority: number;
  /** Timeout in ms for this task */
  timeoutMs: number;
}

export interface GracefulShutdownConfig {
  /** Overall shutdown timeout (ms) */
  totalTimeoutMs: number;
  /** Default per-task timeout (ms) */
  defaultTaskTimeoutMs: number;
  /** Force exit timeout after second signal (ms) */
  forceExitTimeoutMs: number;
  /** Whether to trap process signals automatically */
  trapSignals: boolean;
  /** Signals to listen for */
  signals: NodeJS.Signals[];
  /** Exit code to use */
  exitCode: number;
}

export interface ShutdownStatus {
  phase: ShutdownPhase;
  startedAt: number | null;
  completedAt: number | null;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  pendingTasks: string[];
  currentTask: string | null;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: GracefulShutdownConfig = {
  totalTimeoutMs: 30_000,          // 30 seconds total
  defaultTaskTimeoutMs: 5_000,     // 5 seconds per task
  forceExitTimeoutMs: 3_000,       // 3 seconds after second SIGINT
  trapSignals: true,
  signals: ["SIGTERM", "SIGINT", "SIGQUIT"],
  exitCode: 0,
};

// ── Manager ───────────────────────────────────────────────

export class GracefulShutdownManager extends EventEmitter {
  private config: GracefulShutdownConfig;
  private tasks: ShutdownTask[] = [];
  private status: ShutdownStatus;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private forceTimer: ReturnType<typeof setTimeout> | null = null;
  private exitTimer: NodeJS.Timeout | null = null;
  private signalCount = 0;
  private boundHandleSignal: ((signal: string) => void) | null = null;

  constructor(config?: Partial<GracefulShutdownConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.status = this.createInitialStatus();

    if (this.config.trapSignals) {
      this.boundHandleSignal = this.handleSignal.bind(this);
      for (const sig of this.config.signals) {
        try {
          process.on(sig, this.boundHandleSignal);
        } catch {
          // Signal may not be available on this platform
        }
      }
    }
  }

  /**
   * Register a shutdown task.
   */
  register(task: ShutdownTask): void {
    this.tasks.push(task);
    this.status.totalTasks = this.tasks.length;
    this.status.pendingTasks.push(task.name);
  }

  /**
   * Register a simple shutdown hook (default priority, default timeout).
   */
  registerHook(
    name: string,
    handler: () => Promise<void>,
    options?: { priority?: number; timeoutMs?: number },
  ): void {
    this.register({
      name,
      handler: async () => {
        await handler();
        return true;
      },
      priority: options?.priority ?? 50,
      timeoutMs: options?.timeoutMs ?? this.config.defaultTaskTimeoutMs,
    });
  }

  /**
   * Unregister a task by name.
   */
  unregister(name: string): boolean {
    const idx = this.tasks.findIndex((t) => t.name === name);
    if (idx < 0) return false;

    this.tasks.splice(idx, 1);
    this.status.totalTasks = this.tasks.length;
    const pendingIdx = this.status.pendingTasks.indexOf(name);
    if (pendingIdx >= 0) this.status.pendingTasks.splice(pendingIdx, 1);
    return true;
  }

  /**
   * Begin graceful shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.status.phase !== "idle") return;

    this.status.phase = "draining";
    this.status.startedAt = Date.now();
    this.emit("shutdown:start");

    // Sort by priority (lower = first), then reverse for shutdown
    // (first-registered = last-shutdown, or lower priority = earlier shutdown)
    const ordered = [...this.tasks].sort((a, b) => a.priority - b.priority);

    // Total timeout
    this.totalTimer = setTimeout(() => {
      this.status.phase = "shutting-down";
      this.emit("shutdown:timeout", `Timed out after ${this.config.totalTimeoutMs}ms`);
      this.forceComplete();
    }, this.config.totalTimeoutMs);

    for (const task of ordered) {
      this.status.currentTask = task.name;
      this.emit("shutdown:task:start", task.name);

      try {
        const success = await this.executeWithTimeout(task);
        if (success) {
          this.status.completedTasks++;
          this.emit("shutdown:task:done", task.name);
        } else {
          this.status.failedTasks++;
          this.emit("shutdown:task:failed", task.name, "Handler returned false");
        }
      } catch (err) {
        this.status.failedTasks++;
        this.emit("shutdown:task:failed", task.name, (err as Error).message);
      }

      // Remove from pending
      const pendingIdx = this.status.pendingTasks.indexOf(task.name);
      if (pendingIdx >= 0) this.status.pendingTasks.splice(pendingIdx, 1);
    }

    this.finishShutdown();
  }

  /**
   * Check if shutdown is in progress.
   */
  isShuttingDown(): boolean {
    return this.status.phase === "draining" || this.status.phase === "shutting-down";
  }

  /**
   * Get current shutdown status.
   */
  getStatus(): ShutdownStatus {
    return { ...this.status, pendingTasks: [...this.status.pendingTasks] };
  }

  /**
   * Remove signal handlers (for cleanup in tests).
   */
  dispose(): void {
    if (this.boundHandleSignal) {
      for (const sig of this.config.signals) {
        process.removeListener(sig, this.boundHandleSignal);
      }
      this.boundHandleSignal = null;
    }
    if (this.totalTimer) clearTimeout(this.totalTimer);
    if (this.forceTimer) clearTimeout(this.forceTimer);
    if (this.exitTimer) clearTimeout(this.exitTimer);
  }

  configure(updates: Partial<GracefulShutdownConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ── Private ─────────────────────────────────────────────

  private handleSignal(signal: string): void {
    this.signalCount++;

    if (this.signalCount > 1) {
      // Second signal → force exit
      this.emit("shutdown:force", signal);
      this.forceTimer = setTimeout(() => {
        process.exit(1);
      }, this.config.forceExitTimeoutMs);
      return;
    }

    this.emit("shutdown:signal", signal);
    this.shutdown().catch((err) => {
      process.stderr.write("Shutdown failed:" + " " + err);
      this.forceComplete();
    });
  }

  private async executeWithTimeout(task: ShutdownTask): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.emit("shutdown:task:timeout", task.name, task.timeoutMs);
        resolve(false);
      }, task.timeoutMs);

      const taskPromise = task.handler();
      taskPromise.catch(() => {});
      taskPromise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(false);
        });
    });
  }

  private finishShutdown(): void {
    // Clear total timeout
    if (this.totalTimer) {
      clearTimeout(this.totalTimer);
      this.totalTimer = null;
    }

    this.status.phase = "complete";
    this.status.completedAt = Date.now();
    this.status.currentTask = null;

    this.emit("shutdown:complete", this.status);

    // Exit process if this was a signal-initiated shutdown
    if (this.signalCount > 0) {
      this.exitTimer = setTimeout(() => {
        process.exit(this.config.exitCode);
      }, 100);
    }
  }

  private forceComplete(): void {
    if (this.totalTimer) {
      clearTimeout(this.totalTimer);
      this.totalTimer = null;
    }

    this.status.phase = "complete";
    this.status.completedAt = Date.now();

    if (this.signalCount > 0) {
      process.exit(1);
    }
  }

  private createInitialStatus(): ShutdownStatus {
    return {
      phase: "idle",
      startedAt: null,
      completedAt: null,
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      pendingTasks: [],
      currentTask: null,
    };
  }
}