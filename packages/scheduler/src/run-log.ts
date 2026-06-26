/**
 * Cron Run Log — persistent execution history for cron jobs.
 *
 * Writes every cron execution to JSONL files at
 * `<runsDir>/<jobId>.jsonl`, one JSON line per run.
 *
 * Features:
 *  - Append-only JSONL persistence per job
 *  - Query by jobId with pagination (offset/limit, time range)
 *  - Query all runs across jobs
 *  - Status filtering
 *  - Retention policies for log rotation (max entries, max age)
 *  - Log cleanup/pruning
 */

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

// ── Types ─────────────────────────────────────────────────

export interface RunLogEntry {
  /** Unique run ID */
  runId: string;
  /** Associated job ID */
  jobId: string;
  /** Job name for display */
  jobName: string;
  /** Session ID if isolated */
  sessionId?: string;
  /** When the run started (ISO string) */
  startedAt: string;
  /** When the run completed (ISO string, null if still running) */
  completedAt: string | null;
  /** Duration in ms (null if still running) */
  durationMs: number | null;
  /** Whether the run succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Output/result summary (truncated) */
  resultSummary?: string;
}

export interface RunLogQuery {
  /** Filter by job ID */
  jobId?: string;
  /** Maximum entries to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Only runs after this time (ISO string) */
  after?: string;
  /** Only runs before this time (ISO string) */
  before?: string;
  /** Only successful runs */
  success?: boolean;
}

export interface RunLogConfig {
  /** Directory where run logs are stored */
  runsDir: string;
  /** Maximum entries per job file before rotation */
  maxEntriesPerJob: number;
  /** Maximum age of entries in ms before pruning (0 = never) */
  maxAgeMs: number;
  /** Max total entries across all jobs (0 = unlimited) */
  maxTotalEntries: number;
}

export interface RunLogStats {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  byJob: Record<string, { total: number; success: number; failed: number; lastRun: string | null }>;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: RunLogConfig = {
  runsDir: path.join(process.cwd(), "data", "cron", "runs"),
  maxEntriesPerJob: 1000,
  maxAgeMs: 0,
  maxTotalEntries: 0,
};

// ── Logger ────────────────────────────────────────────────

export class CronRunLogger {
  private config: RunLogConfig;

  constructor(config?: Partial<RunLogConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureDir();
  }

  /**
   * Record a completed run.
   */
  record(entry: Omit<RunLogEntry, "runId">): RunLogEntry {
    const full: RunLogEntry = {
      ...entry,
      runId: `run_${Date.now()}_${randomUUID().slice(0, 6)}`,
    };

    if (!full.completedAt && full.durationMs === null) {
      full.completedAt = new Date().toISOString();
      full.durationMs = full.durationMs ?? 0;
    }

    const filePath = this.jobLogPath(full.jobId);
    const line = JSON.stringify(full) + "\n";

    fs.appendFileSync(filePath, line, "utf-8");

    this.enforceRetention(full.jobId);

    return full;
  }

  /**
   * Query run logs with optional filters.
   */
  query(q: RunLogQuery = {}): RunLogEntry[] {
    const all = this.readAll(q.jobId);
    let results = all;

    if (q.after) {
      results = results.filter((e) => e.startedAt >= q.after!);
    }
    if (q.before) {
      results = results.filter((e) => e.startedAt <= q.before!);
    }
    if (q.success !== undefined) {
      results = results.filter((e) => e.success === q.success);
    }

    // Sort by startedAt descending (newest first)
    results.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );

    const MAX_PAGE = 1000;
    const offset = Math.max(0, q.offset ?? 0);
    const limit = Math.min(Math.max(0, q.limit ?? results.length), MAX_PAGE);
    return results.slice(offset, offset + limit);
  }

  /**
   * Get the most recent run for a job.
   */
  getLastRun(jobId: string): RunLogEntry | null {
    const entries = this.readJobLog(jobId);
    if (entries.length === 0) return null;
    return entries[entries.length - 1];
  }

  /**
   * Get runs for a specific job.
   */
  getJobRuns(jobId: string, limit = 50): RunLogEntry[] {
    const entries = this.readJobLog(jobId);
    return entries.slice(-limit);
  }

  /**
   * Get statistics for all jobs.
   */
  getStats(): RunLogStats {
    const all = this.readAll();

    const stats: RunLogStats = {
      totalRuns: all.length,
      successfulRuns: all.filter((e) => e.success).length,
      failedRuns: all.filter((e) => !e.success).length,
      byJob: {},
    };

    for (const entry of all) {
      if (!stats.byJob[entry.jobId]) {
        stats.byJob[entry.jobId] = { total: 0, success: 0, failed: 0, lastRun: null };
      }
      const js = stats.byJob[entry.jobId];
      js.total++;
      if (entry.success) {
        js.success++;
      } else {
        js.failed++;
      }
      if (!js.lastRun || entry.startedAt > js.lastRun) {
        js.lastRun = entry.startedAt;
      }
    }

    return stats;
  }

  /**
   * Prune old entries based on config.
   * Returns count of entries removed.
   */
  prune(): number {
    let pruned = 0;

    // Prune by max age
    if (this.config.maxAgeMs > 0) {
      const cutoff = new Date(Date.now() - this.config.maxAgeMs).toISOString();

      for (const jobId of this.listJobIds()) {
        const entries = this.readJobLog(jobId);
        const kept = entries.filter((e) => e.startedAt >= cutoff);
        if (kept.length < entries.length) {
          const prunedFromJob = entries.length - kept.length;
          this.writeJobLog(jobId, kept);
          pruned += prunedFromJob;
        }
      }
    }

    // Prune by max per job
    if (this.config.maxEntriesPerJob > 0) {
      for (const jobId of this.listJobIds()) {
        const entries = this.readJobLog(jobId);
        if (entries.length > this.config.maxEntriesPerJob) {
          const kept = entries.slice(-this.config.maxEntriesPerJob);
          const prunedFromJob = entries.length - kept.length;
          this.writeJobLog(jobId, kept);
          pruned += prunedFromJob;
        }
      }
    }

    // Prune by max total
    if (this.config.maxTotalEntries > 0) {
      const all = this.readAll();
      if (all.length > this.config.maxTotalEntries) {
        // Sort and keep only newest
        all.sort(
          (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
        );
        const toKeep = all.slice(-this.config.maxTotalEntries);
        pruned += all.length - toKeep.length;

        // Group by job and rewrite
        const byJob = new Map<string, RunLogEntry[]>();
        for (const e of toKeep) {
          if (!byJob.has(e.jobId)) byJob.set(e.jobId, []);
          byJob.get(e.jobId)!.push(e);
        }

        // Clear all files, rewrite kept
        for (const jobId of this.listJobIds()) {
          const p = this.jobLogPath(jobId);
          try { fs.unlinkSync(p); } catch { /* ignore */ }
        }
        for (const [jobId, entries] of byJob) {
          this.writeJobLog(jobId, entries);
        }
      }
    }

    return pruned;
  }

  /**
   * Delete all logs for a specific job.
   */
  deleteJob(jobId: string): boolean {
    const p = this.jobLogPath(jobId);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      return true;
    }
    return false;
  }

  /**
   * Count total runs across all jobs.
   */
  get totalRuns(): number {
    return this.readAll().length;
  }

  configure(updates: Partial<RunLogConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ── Private ─────────────────────────────────────────────

  private ensureDir(): void {
    if (!fs.existsSync(this.config.runsDir)) {
      fs.mkdirSync(this.config.runsDir, { recursive: true });
    }
  }

  private jobLogPath(jobId: string): string {
    const safe = jobId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.config.runsDir, `${safe}.jsonl`);
  }

  private readJobLog(jobId: string): RunLogEntry[] {
    const p = this.jobLogPath(jobId);
    if (!fs.existsSync(p)) return [];

    try {
      const content = fs.readFileSync(p, "utf-8");
      const entries: RunLogEntry[] = [];
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as RunLogEntry);
        } catch {
          // Skip corrupted line instead of losing all entries
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  private writeJobLog(jobId: string, entries: RunLogEntry[]): void {
    const p = this.jobLogPath(jobId);
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(p, content, "utf-8");
  }

  private readAll(jobId?: string): RunLogEntry[] {
    if (jobId) return this.readJobLog(jobId);

    const all: RunLogEntry[] = [];
    for (const id of this.listJobIds()) {
      all.push(...this.readJobLog(id));
    }
    return all;
  }

  private listJobIds(): string[] {
    try {
      return fs
        .readdirSync(this.config.runsDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(".jsonl", ""));
    } catch {
      return [];
    }
  }

  private enforceRetention(jobId: string): void {
    if (this.config.maxEntriesPerJob > 0) {
      const entries = this.readJobLog(jobId);
      if (entries.length > this.config.maxEntriesPerJob) {
        const kept = entries.slice(-this.config.maxEntriesPerJob);
        this.writeJobLog(jobId, kept);
      }
    }
  }
}