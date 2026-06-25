import type { TaskStatus } from "./types";

export class TaskStatusTracker {
  private statuses = new Map<string, TaskStatus>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  set(sessionId: string, phase: TaskStatus["phase"], detail: string, progress: number, subtaskIndex?: number, subtaskTotal?: number, subtaskLabel?: string): void {
    this.statuses.set(sessionId, { phase, detail, progress, updatedAt: Date.now(), subtaskIndex, subtaskTotal, subtaskLabel });
    // Auto-cleanup stale entries every 5 minutes
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, val] of this.statuses) {
          if (now - val.updatedAt > 300_000) this.statuses.delete(key);
        }
        if (this.statuses.size === 0 && this.cleanupTimer) {
          clearInterval(this.cleanupTimer);
          this.cleanupTimer = null;
        }
      }, 60_000);
      // 允许进程在定时器运行时退出
      this.cleanupTimer.unref();
    }
  }

  get(sessionId: string): TaskStatus | null {
    return this.statuses.get(sessionId) || null;
  }

  delete(sessionId: string): void {
    this.statuses.delete(sessionId);
  }

  /** Get all active statuses (for monitoring) */
  getAll(): Array<{ sessionId: string; status: TaskStatus }> {
    return Array.from(this.statuses.entries()).map(([sessionId, status]) => ({ sessionId, status }));
  }
}

export const taskStatusTracker = new TaskStatusTracker();
