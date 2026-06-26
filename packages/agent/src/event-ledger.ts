/**
 * Event Ledger — OpenClaw ACP compatibility layer.
 *
 * Append-only event sourcing for all agent actions. Every tool call,
 * permission request, model invocation, and system event is recorded
 * as an immutable ledger entry. Supports:
 *
 *   - Sequential event IDs with causal ordering
 *   - Event types: tool_call, tool_result, permission, model_invoke,
 *     model_response, system, error, commitment, session
 *   - Per-session and per-agent scoping
 *   - JSONL-based persistence
 *   - Query by time range, type, agent, session
 *   - Snapshots for fast replay
 */
import * as fs from "fs";
import * as path from "path";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export type LedgerEventType =
  | "tool_call"
  | "tool_result"
  | "permission_request"
  | "permission_grant"
  | "permission_deny"
  | "model_invoke"
  | "model_response"
  | "system"
  | "error"
  | "commitment"
  | "session_start"
  | "session_end"
  | "subagent_spawn"
  | "subagent_result";

export interface LedgerEntry {
  /** Monotonically increasing event ID */
  seq: number;
  /** Event type */
  type: LedgerEventType;
  /** ISO timestamp */
  timestamp: string;
  /** Agent ID */
  agentId?: string;
  /** Session ID */
  sessionId?: string;
  /** Event payload (free-form) */
  data: Record<string, unknown>;
  /** Causality: ID of the event that caused this one */
  causedBy?: number;
  /** Duration in ms (for paired events like tool_call→tool_result) */
  duration?: number;
}

export interface LedgerQuery {
  types?: LedgerEventType[];
  agentId?: string;
  sessionId?: string;
  since?: number; // seq number
  from?: string; // ISO timestamp
  to?: string; // ISO timestamp
  limit?: number;
  offset?: number;
}

export interface EventLedgerConfig {
  storeDir?: string;
  maxEntriesPerFile?: number;
  autoFlushMs?: number;
  /** Maximum entries to keep in memory at load time; older entries are skipped. */
  maxLoadedEntries?: number;
}

// ──────────────────────────────────────────────────────────────
// EventLedger
// ──────────────────────────────────────────────────────────────

export class EventLedger {
  private entries: LedgerEntry[] = [];
  private nextSeq = 1;
  private storeDir: string;
  private maxEntriesPerFile: number;
  private maxLoadedEntries: number;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: EventLedgerConfig = {}) {
    this.storeDir =
      config.storeDir ||
      path.resolve(process.cwd(), "data", "ledger");
    this.maxEntriesPerFile = config.maxEntriesPerFile ?? 10_000;
    this.maxLoadedEntries = config.maxLoadedEntries ?? 50_000;
    this.load();
  }

  // ── Append ──

  /**
   * Record an event in the ledger. Returns the sequence number.
   */
  append(
    type: LedgerEventType,
    data: Record<string, unknown>,
    opts?: {
      agentId?: string;
      sessionId?: string;
      causedBy?: number;
      duration?: number;
    },
  ): number {
    const seq = this.nextSeq++;
    const entry: LedgerEntry = {
      seq,
      type,
      timestamp: new Date().toISOString(),
      agentId: opts?.agentId,
      sessionId: opts?.sessionId,
      data,
      causedBy: opts?.causedBy,
      duration: opts?.duration,
    };
    this.entries.push(entry);
    this.dirty = true;
    this.scheduleFlush();
    return seq;
  }

  /**
   * Convenience: record a tool call + its result as paired events.
   */
  recordToolExecution(
    toolName: string,
    params: Record<string, unknown>,
    result: unknown,
    duration: number,
    opts?: { agentId?: string; sessionId?: string },
  ): { callSeq: number; resultSeq: number } {
    const callSeq = this.append("tool_call", { tool: toolName, params }, opts);
    const resultSeq = this.append(
      "tool_result",
      { tool: toolName, result: typeof result === "string" ? result : JSON.stringify(result) },
      { ...opts, causedBy: callSeq, duration },
    );
    return { callSeq, resultSeq };
  }

  // ── Query ──

  /**
   * Query ledger entries with optional filters.
   */
  query(q: LedgerQuery = {}): LedgerEntry[] {
    let results = [...this.entries];

    if (q.types && q.types.length > 0) {
      results = results.filter((e) => q.types!.includes(e.type));
    }
    if (q.agentId) {
      results = results.filter((e) => e.agentId === q.agentId);
    }
    if (q.sessionId) {
      results = results.filter((e) => e.sessionId === q.sessionId);
    }
    if (q.since !== undefined) {
      results = results.filter((e) => e.seq >= q.since!);
    }
    if (q.from) {
      results = results.filter((e) => e.timestamp >= q.from!);
    }
    if (q.to) {
      results = results.filter((e) => e.timestamp <= q.to!);
    }

    // Most recent first
    results.sort((a, b) => b.seq - a.seq);

    if (q.offset) {
      results = results.slice(q.offset);
    }
    if (q.limit) {
      results = results.slice(0, q.limit);
    }

    return results;
  }

  /**
   * Get a single event by sequence number.
   */
  get(seq: number): LedgerEntry | undefined {
    return this.entries.find((e) => e.seq === seq);
  }

  /**
   * Get the causal chain for an event (all ancestor events).
   */
  getCausalChain(seq: number): LedgerEntry[] {
    const chain: LedgerEntry[] = [];
    let current = this.get(seq);
    while (current) {
      chain.unshift(current);
      if (current.causedBy) {
        current = this.get(current.causedBy);
      } else {
        break;
      }
    }
    return chain;
  }

  // ── Snapshots ──

  /**
   * Create a snapshot of the current ledger state for fast replay.
   * Returns the snapshot as a JSON-serializable object.
   */
  snapshot(): { nextSeq: number; entryCount: number; types: Record<string, number> } {
    const types: Record<string, number> = {};
    for (const e of this.entries) {
      types[e.type] = (types[e.type] || 0) + 1;
    }
    return {
      nextSeq: this.nextSeq,
      entryCount: this.entries.length,
      types,
    };
  }

  // ── Stats ──

  getStats(): {
    total: number;
    byType: Record<string, number>;
    byAgent: Record<string, number>;
    oldestTimestamp: string | null;
    newestTimestamp: string | null;
  } {
    const byType: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    let oldestTimestamp: string | null = null;
    let newestTimestamp: string | null = null;

    for (const e of this.entries) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      const aid = e.agentId || "unknown";
      byAgent[aid] = (byAgent[aid] || 0) + 1;
      if (oldestTimestamp === null || e.timestamp < oldestTimestamp) {
        oldestTimestamp = e.timestamp;
      }
      if (newestTimestamp === null || e.timestamp > newestTimestamp) {
        newestTimestamp = e.timestamp;
      }
    }

    return {
      total: this.entries.length,
      byType,
      byAgent,
      oldestTimestamp,
      newestTimestamp,
    };
  }

  /**
   * Total number of entries in memory.
   */
  get count(): number {
    return this.entries.length;
  }

  // ── Persistence ──

  private load(): void {
    try {
      if (!fs.existsSync(this.storeDir)) {
        fs.mkdirSync(this.storeDir, { recursive: true });
        return;
      }
      // Sort newest-first so recent events are loaded first; stop once the
      // in-memory limit is reached to avoid OOM/stack abort on huge history.
      const files = fs
        .readdirSync(this.storeDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();

      let loadedCount = 0;
      for (const file of files) {
        if (loadedCount >= this.maxLoadedEntries) break;
        const content = fs.readFileSync(path.join(this.storeDir, file), "utf-8");
        // Files are append-only and chronologically sorted; read newest lines last.
        const lines = content.split("\n").filter((l) => l.trim());
        const remaining = this.maxLoadedEntries - loadedCount;
        const slice = remaining < lines.length ? lines.slice(-remaining) : lines;
        for (const line of slice) {
          try {
            const entry = JSON.parse(line) as LedgerEntry;
            this.entries.push(entry);
            if (entry.seq >= this.nextSeq) {
              this.nextSeq = entry.seq + 1;
            }
            loadedCount++;
          } catch {
            // Skip corrupted lines
          }
        }
      }
    } catch {
      // Silent — start fresh
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 500);
    this.flushTimer.unref?.();
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    try {
      if (!fs.existsSync(this.storeDir)) {
        fs.mkdirSync(this.storeDir, { recursive: true });
      }

      // Write entries to the latest file
      const files = fs
        .readdirSync(this.storeDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();
      let targetFile: string;

      if (files.length > 0) {
        const lastFile = files[files.length - 1];
        const lastPath = path.join(this.storeDir, lastFile);
        const lastContent = fs.readFileSync(lastPath, "utf-8");
        const lineCount = lastContent.split("\n").filter((l) => l.trim()).length;
        if (lineCount >= this.maxEntriesPerFile) {
          targetFile = path.join(this.storeDir, `ledger-${Date.now()}.jsonl`);
        } else {
          targetFile = lastPath;
        }
      } else {
        targetFile = path.join(this.storeDir, `ledger-${Date.now()}.jsonl`);
      }

      // Collect unsaved entries (those with seq > last persisted)
      const existing = fs.existsSync(targetFile)
        ? fs.readFileSync(targetFile, "utf-8").split("\n").filter((l) => l.trim())
        : [];
      const existingSeqs = new Set(
        existing.map((l) => {
          try { return JSON.parse(l).seq; } catch { return -1; }
        }),
      );

      const newLines = this.entries
        .filter((e) => !existingSeqs.has(e.seq))
        .map((e) => JSON.stringify(e));

      if (newLines.length > 0) {
        fs.appendFileSync(targetFile, newLines.join("\n") + "\n", "utf-8");
      }

      this.dirty = false;
    } catch {
      // Best-effort
    }
  }

  /**
   * Compact ledger by removing entries older than a cutoff.
   */
  compact(retainDays: number): number {
    const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.timestamp >= cutoff);
    return before - this.entries.length;
  }
}