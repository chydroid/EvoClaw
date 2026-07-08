/**
 * Event Ledger — OpenClaw ACP compatibility layer.
 *
 * Append-only event sourcing ledger for agent actions. Every agent action
 * (tool call, LLM invocation, session event, permission decision) is recorded
 * as an immutable event. Supports:
 *
 *   - Ordered append-only event storage
 *   - Range queries by time / agent / session / event type
 *   - Event replay for state reconstruction
 *   - Periodic compaction to prevent unbounded growth
 *   - JSONL-based file persistence
 *
 * This is the backbone of OpenClaw's "audit log" and "event history" features.
 */
import * as fs from "fs";
import * as path from "path";
import type { EventBus } from "@evoclaw/core";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface LedgerEvent {
  /** Global monotonic sequence number */
  seq: number;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Event type (e.g. "tool.call", "llm.invoke", "session.start") */
  type: string;
  /** Agent that performed the action */
  agentId?: string;
  /** Session context */
  sessionId?: string;
  /** Channel context */
  channel?: string;
  /** Event payload */
  data: Record<string, unknown>;
  /** Optional correlation ID for linking related events */
  correlationId?: string;
  /** Optional source (e.g. "web-ui", "telegram", "cron") */
  source?: string;
}

export interface LedgerQuery {
  /** Minimum sequence number */
  since?: number;
  /** Maximum sequence number */
  until?: number;
  /** Filter by event type(s) */
  types?: string[];
  /** Filter by agent */
  agentId?: string;
  /** Filter by session */
  sessionId?: string;
  /** Filter by channel */
  channel?: string;
  /** Filter by correlation ID */
  correlationId?: string;
  /** Maximum results */
  limit?: number;
  /** Return in reverse order (newest first) */
  reverse?: boolean;
}

export interface LedgerStats {
  totalEvents: number;
  lastSeq: number;
  oldestTimestamp: string;
  newestTimestamp: string;
  typeCounts: Record<string, number>;
  storageBytes: number;
}

// ──────────────────────────────────────────────────────────────
// EventLedger
// ──────────────────────────────────────────────────────────────

export class EventLedger {
  private events: LedgerEvent[] = [];
  private nextSeq = 1;
  private storePath: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private flushLock = false;

  constructor(
    private eventBus?: EventBus,
    opts?: { storePath?: string; autoSaveMs?: number },
  ) {
    this.storePath =
      opts?.storePath ||
      path.resolve(process.cwd(), "data", "event-ledger.jsonl");
    this.load();
    // 安全：scheduleSave 使用 1s 延迟 + unref()，进程退出时若窗口内还有
    // 未落盘事件会丢失。注册 beforeExit 钩子确保进程退出前 flush 所有待写事件。
    // flush() 全程同步 IO（writeFileSync/fsyncSync/renameSync），可在退出钩子中安全执行。
    process.on("beforeExit", () => this.flush());
  }

  // ── Write ──

  /**
   * Append one or more events to the ledger.
   */
  append(
    events: Array<{
      type: string;
      data: Record<string, unknown>;
      agentId?: string;
      sessionId?: string;
      channel?: string;
      correlationId?: string;
      source?: string;
    }>,
  ): LedgerEvent[] {
    const now = new Date().toISOString();
    const appended: LedgerEvent[] = [];

    for (const e of events) {
      const event: LedgerEvent = {
        seq: this.nextSeq++,
        timestamp: now,
        type: e.type,
        agentId: e.agentId,
        sessionId: e.sessionId,
        channel: e.channel,
        data: e.data,
        correlationId: e.correlationId,
        source: e.source,
      };
      this.events.push(event);
      appended.push(event);

      // Emit for real-time subscribers
      this.eventBus?.publish("event-ledger", event, "event-ledger")?.catch((err) => process.stderr.write('[EventLedger] event publish failed: ' + err + '\n'));
    }

    this.scheduleSave();
    return appended;
  }

  /**
   * Append a single event (convenience).
   */
  appendOne(
    type: string,
    data: Record<string, unknown>,
    ctx?: {
      agentId?: string;
      sessionId?: string;
      channel?: string;
      correlationId?: string;
      source?: string;
    },
  ): LedgerEvent {
    return this.append([{ type, data, ...ctx }])[0];
  }

  // ── Read ──

  /**
   * Query events with optional filters.
   */
  query(q: LedgerQuery = {}): LedgerEvent[] {
    let results = [...this.events];

    if (q.since !== undefined) {
      results = results.filter((e) => e.seq >= q.since!);
    }
    if (q.until !== undefined) {
      results = results.filter((e) => e.seq <= q.until!);
    }
    if (q.types && q.types.length > 0) {
      results = results.filter((e) => q.types!.includes(e.type));
    }
    if (q.agentId) {
      results = results.filter((e) => e.agentId === q.agentId);
    }
    if (q.sessionId) {
      results = results.filter((e) => e.sessionId === q.sessionId);
    }
    if (q.channel) {
      results = results.filter((e) => e.channel === q.channel);
    }
    if (q.correlationId) {
      results = results.filter(
        (e) => e.correlationId === q.correlationId,
      );
    }

    if (q.reverse) {
      results.reverse();
    }

    if (q.limit) {
      results = results.slice(0, q.limit);
    }

    return results;
  }

  /**
   * Get events for a specific session, ordered by sequence.
   */
  getSessionEvents(sessionId: string): LedgerEvent[] {
    return this.query({ sessionId });
  }

  /**
   * Get the most recent event of each type (for status dashboards).
   */
  getLatestByType(): Map<string, LedgerEvent> {
    const latest = new Map<string, LedgerEvent>();
    for (const e of this.events) {
      const existing = latest.get(e.type);
      if (!existing || e.seq > existing.seq) {
        latest.set(e.type, e);
      }
    }
    return latest;
  }

  /**
   * Replay all events in order (for state reconstruction).
   */
  replay(
    handler: (event: LedgerEvent) => void | Promise<void>,
    filter?: LedgerQuery,
  ): void {
    const events = filter ? this.query(filter) : this.events;
    for (const event of events) {
      handler(event);
    }
  }

  // ── Stats ──

  getStats(): LedgerStats {
    const typeCounts: Record<string, number> = {};
    for (const e of this.events) {
      typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    }

    const oldest = this.events[0];
    const newest = this.events[this.events.length - 1];

    return {
      totalEvents: this.events.length,
      lastSeq: this.nextSeq - 1,
      oldestTimestamp: oldest?.timestamp || "",
      newestTimestamp: newest?.timestamp || "",
      typeCounts,
      storageBytes: JSON.stringify(this.events).length,
    };
  }

  /** Total event count. */
  get count(): number {
    return this.events.length;
  }

  // ── Maintenance ──

  /**
   * Compact events older than the given age (keep last N per session).
   * Older events are summarized into single "compact" records.
   */
  compact(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;

    // Keep events within the window
    const kept: LedgerEvent[] = [];
    for (const e of this.events) {
      const eventTime = new Date(e.timestamp).getTime();
      if (eventTime >= cutoff) {
        kept.push(e);
      } else {
        removed++;
      }
    }

    if (removed > 0) {
      // Insert a compaction marker
      kept.unshift({
        seq: this.nextSeq++,
        timestamp: new Date().toISOString(),
        type: "ledger.compacted",
        data: {
          compactedEvents: removed,
          cutoff: new Date(cutoff).toISOString(),
        },
      });
      this.events = kept;
      this.scheduleSave();
    }

    return removed;
  }

  // ── Persistence ──

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as LedgerEvent;
            if (parsed.seq !== undefined) {
              this.events.push(parsed);
              if (parsed.seq >= this.nextSeq) {
                this.nextSeq = parsed.seq + 1;
              }
            }
          } catch {
            // Skip corrupt lines
          }
        }
      }
    } catch {
      // Start fresh
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 1000);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || this.flushLock) return;
    this.flushLock = true;
    const tmp = `${this.storePath}.tmp.${process.pid}`;
    let fd: number | null = null;
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const jsonl = this.events
        .map((e) => JSON.stringify(e))
        .join("\n");
      fs.writeFileSync(tmp, jsonl + "\n", "utf-8");
      fd = fs.openSync(tmp, "r");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, this.storePath);
      this.dirty = false;
    } catch (err) {
      process.stderr.write(`[EventLedger] Failed to flush: ${err instanceof Error ? err.message : String(err)}` + "\n");
      // 限制重试频率避免无限快速重试
      this.saveTimer = setTimeout(() => this.flush(), 5000);
      this.saveTimer.unref?.();
    } finally {
      // 确保 fd 被关闭（fsyncSync 抛出时 fd 泄漏）
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* already closed or error */ }
      }
      // 清理残留的 tmp 文件
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
      this.flushLock = false;
    }
  }
}