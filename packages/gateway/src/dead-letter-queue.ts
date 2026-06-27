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
  /** markReplayed 进行中的 ID 集合，防止并发 read-modify-write 竞态 */
  private markReplayedLocks = new Set<string>();

  constructor(config?: Partial<DLQConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureDir();
  }

  /**
   * Enqueue a failed message into the dead letter queue.
   * 每条消息独立文件 + 原子写入，防止崩溃时 appendFileSync 写入损坏行。
   */
  enqueue(entry: Omit<DeadLetter, "id" | "deadLetteredAt" | "replayed">): DeadLetter {
    const dl: DeadLetter = {
      ...entry,
      id: `dl_${Date.now()}_${(this.seq++).toString(36).padStart(4, "0")}_${randomUUID().slice(0, 6)}`,
      deadLetteredAt: new Date().toISOString(),
      replayed: false,
    };

    // 每条消息独立文件，原子写入，防止崩溃时 JSONL 损坏
    const msgFile = path.join(this.config.storageDir, `${dl.id}.json`);
    const tmpPath = `${msgFile}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(dl), "utf-8");
      fs.fsyncSync(fd);
    } catch (werr) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw werr;
    }
    fs.closeSync(fd);
    try { fs.renameSync(tmpPath, msgFile); } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }

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
   * 原子更新单条消息文件，避免读-改-写竞态。
   * 使用 in-flight 锁防止并发调用丢失 retryCount 累加。
   */
  markReplayed(id: string, success: boolean): boolean {
    // 如果已有 in-flight 操作，拒绝并发调用以避免丢失 retryCount 累加
    if (this.markReplayedLocks.has(id)) {
      return false;
    }
    this.markReplayedLocks.add(id);
    try {
      return this.doMarkReplayedSync(id, success);
    } finally {
      this.markReplayedLocks.delete(id);
    }
  }

  private doMarkReplayedSync(id: string, success: boolean): boolean {
    const dl = this.get(id);
    if (!dl) return false;

    if (success) {
      dl.replayed = true;
      dl.replayedAt = new Date().toISOString();
    } else {
      // Increment retry count and update error timestamp
      dl.retryCount++;
      dl.deadLetteredAt = new Date().toISOString();
    }

    // 原子写入更新后的消息
    const msgFile = this.messageFile(id);
    const tmpPath = `${msgFile}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      const fd = fs.openSync(tmpPath, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(dl), "utf-8");
        fs.fsyncSync(fd);
      } catch (werr) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw werr;
      }
      fs.closeSync(fd);
      fs.renameSync(tmpPath, msgFile);
    } catch (err) {
      process.stderr.write(`[DeadLetterQueue] Failed to mark ${id} as replayed:` + " " + err);
      return false;
    }
    return true;
  }

  /**
   * Delete a specific dead letter.
   */
  delete(id: string): boolean {
    const msgFile = this.messageFile(id);
    try {
      if (fs.existsSync(msgFile)) {
        fs.unlinkSync(msgFile);
        return true;
      }
    } catch (err) {
      process.stderr.write(`[DeadLetterQueue] Failed to delete ${id}:` + " " + err);
    }
    // 旧版 JSONL 兼容：通过 readAll + writeAll 删除
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
    const entries = this.readAll(channel);
    // 删除新版每条消息文件
    for (const dl of entries) {
      try { fs.unlinkSync(this.messageFile(dl.id)); } catch { /* ignore */ }
    }
    // 删除旧版 JSONL 文件
    const p = this.channelFile(channel);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
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

  /** 单条消息文件路径（每条消息独立文件，原子写入） */
  private messageFile(id: string): string {
    return path.join(this.config.storageDir, `${id}.json`);
  }

  /** 旧版 JSONL 文件路径（向后兼容读取） */
  private channelFile(channel: string): string {
    const safe = channel.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.config.storageDir, `${safe}.jsonl`);
  }

  private readAll(channel?: string): DeadLetter[] {
    const entries: DeadLetter[] = [];

    // 读取新版格式：每条消息独立 .json 文件
    try {
      const files = fs
        .readdirSync(this.config.storageDir)
        .filter((f) => f.startsWith("dl_") && f.endsWith(".json"));
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(this.config.storageDir, f), "utf-8");
          const dl = JSON.parse(content) as DeadLetter;
          if (!channel || dl.channel === channel) {
            entries.push(dl);
          }
        } catch (err) {
          // 跳过损坏的单条消息文件
          process.stderr.write('[DeadLetterQueue] skipped corrupt entry: ' + err + '\n');
        }
      }
    } catch (err) {
      // 目录不存在或读取失败
      process.stderr.write('[DeadLetterQueue] skipped corrupt entry: ' + err + '\n');
    }

    // 向后兼容：读取旧版 JSONL 文件
    if (channel) {
      const p = this.channelFile(channel);
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, "utf-8");
          for (const line of content.split("\n")) {
            if (!line.trim()) continue;
            try {
              entries.push(JSON.parse(line) as DeadLetter);
            } catch (err) {
              // 跳过损坏行
              process.stderr.write('[DeadLetterQueue] skipped corrupt entry: ' + err + '\n');
            }
          }
        } catch (err) {
          // 读取失败
          process.stderr.write('[DeadLetterQueue] skipped corrupt entry: ' + err + '\n');
        }
      }
    } else {
      // 读取所有旧版 JSONL 文件
      for (const ch of this.listChannelsLegacy()) {
        entries.push(...this.readAll(ch));
      }
    }

    return entries;
  }

  private writeAll(channel: string, entries: DeadLetter[]): void {
    // 新版格式：每条消息独立文件，writeAll 仅用于 purge 后清理
    // 删除该 channel 下所有旧文件，然后保留 entries 中的文件
    const existing = this.readAll(channel);
    const keepIds = new Set(entries.map((e) => e.id));
    for (const dl of existing) {
      if (!keepIds.has(dl.id)) {
        try { fs.unlinkSync(this.messageFile(dl.id)); } catch { /* ignore */ }
      }
    }
    // 旧版 JSONL 文件也清理
    const p = this.channelFile(channel);
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }

  /** 旧版 JSONL 文件列表（向后兼容） */
  private listChannelsLegacy(): string[] {
    try {
      return fs
        .readdirSync(this.config.storageDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(".jsonl", ""));
    } catch {
      return [];
    }
  }

  listChannels(): string[] {
    const channels = new Set<string>();
    // 从新版 .json 文件中提取 channel
    try {
      const files = fs
        .readdirSync(this.config.storageDir)
        .filter((f) => f.startsWith("dl_") && f.endsWith(".json"));
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(this.config.storageDir, f), "utf-8");
          const dl = JSON.parse(content) as DeadLetter;
          channels.add(dl.channel);
        } catch (err) {
          // 跳过损坏文件
          process.stderr.write('[DeadLetterQueue] skipped corrupt entry: ' + err + '\n');
        }
      }
    } catch (err) {
      // 目录不存在
      process.stderr.write('[DeadLetterQueue] skipped corrupt entry: ' + err + '\n');
    }
    // 合并旧版 JSONL channel
    for (const ch of this.listChannelsLegacy()) {
      channels.add(ch);
    }
    return Array.from(channels);
  }
}