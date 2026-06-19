/**
 * Dead Letter Queue — persistent storage for messages that
 * fail after all retry attempts, enabling inspection, replay,
 * and forensic analysis.
 *
 * Features:
 *  - Enqueue messages that failed all retries
 *  - JSONL persistence per channel/job
 *  - Inspect/query dead letters with filters
 *  - Replay (retry sending) individual or batch messages
 *  - Purge old dead letters based on retention policy
 *  - Statistics by channel, failure reason, and time
 *  - Auto-expire entries beyond max age
 */

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

// ── Types ─────────────────────────────────────────────────

export interface DeadLetter {
  /** Unique dead letter ID */
  id: string;
  /** Channel the message was destined for */
  channel: string;
  /** Target peer/user */
  target?: string;
  /** The original message content */
  content: string;
  /** Content type */
  contentType: "text" | "html" | "markdown" | "json";
  /** Error that caused the failure */
  error: string;
  /** Number of retry attempts made */
  retryCount: number;
  /** When the original send was first attempted */
  originalSentAt: string;
  /** When the message entered the dead letter queue */
  deadLetteredAt: string;
  /** Classification of the failure */
  failureType: "timeout" | "auth" | "rate_limit" | "network" | "invalid_content" | "unknown";
  /** Optional metadata */
  metadata?: Record<string, unknown>;
  /** Whether this dead letter has been replayed */
  replayed: boolean;
  /** When it was replayed (if applicable) */
  replayedAt?: string;
}

export interface DLQQuery {
  /** Filter by channel */
  channel?: string;
  /** Filter by failure type */
  failureType?: DeadLetter["failureType"];
  /** Only unreplayed messages */
  unreplayed?: boolean;
  /** Maximum entries to return */
  limit?: number;
  /** Minimum age in queue (ms) */
  minAgeMs?: number;
}

export interface DLQStats {
  total: number;
  unreplayed: number;
  replayed: number;
  byChannel: Record<string, number>;
  byFailureType: Record<string, number>;
}

export interface DLQConfig {
  /** Directory to store dead letter files */
  storageDir: string;
  /** Maximum age of dead letters before purge (ms, 0 = never) */
  maxAgeMs: number;
  /** Maximum dead letters per channel before eviction */
  maxPerChannel: number;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: DLQConfig = {
  storageDir: path.join(process.cwd(), "data", "dlq"),
  maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  maxPerChannel: 500,
};

// ── Manager ───────────────────────────────────────────────

export class DeadLetterQueue {
  private config: DLQConfig;
  private seq = 0;

  constructor(config?: Partial<DLQConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureDir();
  }

  /**
   * Enqueue a failed message into the dead letter queue.
   */
  enqueue(entry: Omit<DeadLetter, "id" | "deadLetteredAt" | "replayed">): DeadLetter {
    const dl: DeadLetter = {
      ...entry,
      id: `dl_${Date.now()}_${(this.seq++).toString(36).padStart(4, "0")}_${randomUUID().slice(0, 6)}`,
      deadLetteredAt: new Date().toISOString(),
      replayed: false,
    };

    const filePath = this.channelFile(dl.channel);
    const line = JSON.stringify(dl) + "\n";
    fs.appendFileSync(filePath, line, "utf-8");

    return dl;
  }

  /**
   * Query dead letters with optional filters.
   */
  query(q: DLQQuery = {}): DeadLetter[] {
    let results = this.readAll(q.channel);

    if (q.failureType) {
      results = results.filter((dl) => dl.failureType === q.failureType);
    }
    if (q.unreplayed) {
      results = results.filter((dl) => !dl.replayed);
    }
    if (q.minAgeMs && q.minAgeMs > 0) {
      const cutoff = new Date(Date.now() - q.minAgeMs).toISOString();
      results = results.filter((dl) => dl.deadLetteredAt <= cutoff);
    }

    // Sort by dead letter time descending (newest first)
    results.sort(
      (a, b) => {
        const timeDiff = new Date(b.deadLetteredAt).getTime() - new Date(a.deadLetteredAt).getTime();
        if (timeDiff !== 0) return timeDiff;
        return b.id.localeCompare(a.id);
      },
    );

    const limit = q.limit ?? results.length;
    return results.slice(0, limit);
  }

  /**
   * Get a single dead letter by ID.
   */
  get(id: string): DeadLetter | null {
    const all = this.readAll();
    return all.find((dl) => dl.id === id) ?? null;
  }

  /**
   * Mark a dead letter as replayed.
   */
  markReplayed(id: string, success: boolean): boolean {
    const dl = this.get(id);
    if (!dl) return false;

    const entries = this.readAll(dl.channel);
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;

    if (success) {
      entries[idx].replayed = true;
      entries[idx].replayedAt = new Date().toISOString();
    } else {
      // Increment retry count and update error timestamp
      entries[idx].retryCount++;
      entries[idx].deadLetteredAt = new Date().toISOString();
    }

    this.writeAll(dl.channel, entries);
    return true;
  }

  /**
   * Delete a specific dead letter.
   */
  delete(id: string): boolean {
    const dl = this.get(id);
    if (!dl) return false;

    const entries = this.readAll(dl.channel);
    const filtered = entries.filter((e) => e.id !== id);
    this.writeAll(dl.channel, filtered);
    return true;
  }

  /**
   * Get all unreplayed dead letters for a channel (for batch replay).
   */
  getUnreplayed(channel?: string): DeadLetter[] {
    return this.query({ channel, unreplayed: true });
  }

  /**
   * Get statistics about the dead letter queue.
   */
  getStats(): DLQStats {
    const all = this.readAll();

    const stats: DLQStats = {
      total: all.length,
      unreplayed: 0,
      replayed: 0,
      byChannel: {},
      byFailureType: {},
    };

    for (const dl of all) {
      if (dl.replayed) {
        stats.replayed++;
      } else {
        stats.unreplayed++;
      }

      stats.byChannel[dl.channel] = (stats.byChannel[dl.channel] ?? 0) + 1;
      stats.byFailureType[dl.failureType] = (stats.byFailureType[dl.failureType] ?? 0) + 1;
    }

    return stats;
  }

  /**
   * Check if a channel has dead letters.
   */
  hasDeadLetters(channel: string): boolean {
    return this.readAll(channel).length > 0;
  }

  /**
   * Purge old or excess dead letters.
   * Returns the count of purged entries.
   */
  purge(): number {
    let purged = 0;

    // Purge by max age
    if (this.config.maxAgeMs > 0) {
      const cutoff = new Date(Date.now() - this.config.maxAgeMs).toISOString();

      for (const channel of this.listChannels()) {
        const entries = this.readAll(channel);
        const kept = entries.filter((dl) => dl.deadLetteredAt >= cutoff);
        const removed = entries.length - kept.length;
        purged += removed;
        this.writeAll(channel, kept);
      }
    }

    // Purge by max per channel
    if (this.config.maxPerChannel > 0) {
      for (const channel of this.listChannels()) {
        const entries = this.readAll(channel);
        if (entries.length > this.config.maxPerChannel) {
          entries.sort(
            (a, b) =>
              new Date(a.deadLetteredAt).getTime() -
              new Date(b.deadLetteredAt).getTime(),
          );
          const removed = entries.length - this.config.maxPerChannel;
          purged += removed;
          this.writeAll(channel, entries.slice(-this.config.maxPerChannel));
        }
      }
    }

    return purged;
  }

  /**
   * Purge all dead letters for a specific channel.
   */
  purgeChannel(channel: string): number {
    const p = this.channelFile(channel);
    if (!fs.existsSync(p)) return 0;

    const entries = this.readAll(channel);
    fs.unlinkSync(p);
    return entries.length;
  }

  /**
   * Count total dead letters.
   */
  get count(): number {
    return this.readAll().length;
  }

  configure(updates: Partial<DLQConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ── Private ─────────────────────────────────────────────

  private ensureDir(): void {
    if (!fs.existsSync(this.config.storageDir)) {
      fs.mkdirSync(this.config.storageDir, { recursive: true });
    }
  }

  private channelFile(channel: string): string {
    const safe = channel.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.config.storageDir, `${safe}.jsonl`);
  }

  private readAll(channel?: string): DeadLetter[] {
    if (channel) {
      const p = this.channelFile(channel);
      if (!fs.existsSync(p)) return [];
      try {
        const content = fs.readFileSync(p, "utf-8");
        const entries: DeadLetter[] = [];
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            entries.push(JSON.parse(line) as DeadLetter);
          } catch {
            // Skip corrupted line instead of losing all entries
          }
        }
        return entries;
      } catch (err) {
        process.stderr.write(`[DeadLetterQueue] Failed to read channel file for "${channel}":` + " " + err);
        return [];
      }
    }

    const all: DeadLetter[] = [];
    for (const ch of this.listChannels()) {
      all.push(...this.readAll(ch));
    }
    return all;
  }

  private writeAll(channel: string, entries: DeadLetter[]): void {
    const p = this.channelFile(channel);
    if (entries.length === 0) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
      return;
    }
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(p, content, "utf-8");
  }

  listChannels(): string[] {
    try {
      return fs
        .readdirSync(this.config.storageDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(".jsonl", ""));
    } catch {
      return [];
    }
  }
}