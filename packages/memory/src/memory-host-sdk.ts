/**
 * Memory Host SDK — OpenClaw compatibility layer.
 *
 * Advanced memory hosting capabilities on top of the existing memory system:
 *   - Memory embeddings via local providers (TF-IDF by default, no external API)
 *   - Memory search with configurable relevance threshold
 *   - Session-linked memory scope (global vs session-local)
 *   - Memory expiry (TTL-based auto-cleanup)
 *   - Memory hooks/plugins for custom processing
 *
 * This extends the basic MemoryHub with semantic capabilities from
 * SemanticMemoryStore while adding the hosting-layer features OpenClaw
 * provides.
 */
import { EventBus, SystemEvents } from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface MemoryHostEntry {
  id: string;
  content: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  source: string;
  scope: "global" | "session";
  sessionId?: string;
  agentId?: string;
  tags: string[];
  priority: number; // 0-10, higher = more important
}

export interface MemoryHostQuery {
  text?: string;
  tags?: string[];
  scope?: "global" | "session" | "all";
  sessionId?: string;
  agentId?: string;
  source?: string;
  minPriority?: number;
  limit?: number;
  includeExpired?: boolean;
}

export interface MemoryHostConfig {
  /** Max entries before eviction starts */
  maxEntries?: number;
  /** Default entry TTL in ms (0 = no expiry) */
  defaultTtlMs?: number;
  /** Persistence file path (JSON) */
  storePath?: string;
  /** Auto-save interval in ms (0 = save immediately) */
  autoSaveMs?: number;
}

// ──────────────────────────────────────────────────────────────
// TF-IDF Vectorizer (same as SemanticMemoryStore)
// ──────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "shall", "this", "that",
  "these", "those", "it", "its", "i", "me", "my", "we", "our", "you",
  "your", "he", "she", "they", "them", "not", "no", "if", "so", "as",
  "than", "too", "very", "just", "about", "up", "out", "when", "what",
  "which", "who", "whom", "how", "all", "each", "every", "both", "few",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function buildTfIdfVector(
  text: string,
  globalIdf: Map<string, number>,
  totalDocs: number,
): number[] {
  const tokens = tokenize(text);
  const tf: Map<string, number> = new Map();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }

  const vector: number[] = [];
  for (const [term, freq] of tf) {
    const idf = globalIdf.get(term) || Math.log(totalDocs + 1);
    vector.push(freq * idf);
  }

  // Normalize
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= magnitude;
    }
  }

  return vector;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const minLen = Math.max(a.length, b.length);
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < minLen; i++) {
    const va = a[i] || 0;
    const vb = b[i] || 0;
    dotProduct += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ──────────────────────────────────────────────────────────────
// MemoryHost
// ──────────────────────────────────────────────────────────────

export class MemoryHost {
  private entries = new Map<string, MemoryHostEntry>();
  private maxEntries: number;
  private defaultTtlMs: number;
  private storePath: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    config: MemoryHostConfig = {},
    private eventBus?: EventBus,
  ) {
    this.maxEntries = config.maxEntries ?? 10_000;
    this.defaultTtlMs = config.defaultTtlMs ?? 0;
    this.storePath =
      config.storePath ||
      path.resolve(process.cwd(), "data", "memory-host.json");
    this.load();
  }

  // ── CRUD ──

  add(entry: Omit<MemoryHostEntry, "id" | "createdAt" | "updatedAt">): MemoryHostEntry {
    const now = Date.now();
    const id = `mem_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const full: MemoryHostEntry = {
      ...entry,
      id,
      createdAt: now,
      updatedAt: now,
      priority: entry.priority ?? 5,
      tags: entry.tags ?? [],
    };

    // Evict oldest if at capacity
    if (this.entries.size >= this.maxEntries) {
      let oldest: string | undefined;
      let oldestTime = Infinity;
      for (const [k, v] of this.entries) {
        if (v.createdAt < oldestTime) {
          oldestTime = v.createdAt;
          oldest = k;
        }
      }
      if (oldest) this.entries.delete(oldest);
    }

    this.entries.set(id, full);
    this.scheduleSave();
    return full;
  }

  get(id: string): MemoryHostEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.entries.delete(id);
      return undefined;
    }
    return entry;
  }

  update(id: string, patch: Partial<Omit<MemoryHostEntry, "id" | "createdAt">>): MemoryHostEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    Object.assign(entry, patch, { updatedAt: Date.now() });
    this.scheduleSave();
    return entry;
  }

  delete(id: string): boolean {
    const existed = this.entries.delete(id);
    if (existed) this.scheduleSave();
    return existed;
  }

  // ── Query ──

  search(query: MemoryHostQuery): MemoryHostEntry[] {
    let results = [...this.entries.values()];

    // Filter expired
    if (!query.includeExpired) {
      const now = Date.now();
      results = results.filter((e) => !e.expiresAt || e.expiresAt > now);
    }

    // Scope filter
    if (query.scope && query.scope !== "all") {
      results = results.filter((e) => e.scope === query.scope);
    }

    // Session filter
    if (query.sessionId) {
      results = results.filter((e) => e.sessionId === query.sessionId);
    }

    // Agent filter
    if (query.agentId) {
      results = results.filter((e) => e.agentId === query.agentId);
    }

    // Source filter
    if (query.source) {
      results = results.filter((e) => e.source === query.source);
    }

    // Priority filter
    if (query.minPriority !== undefined) {
      results = results.filter((e) => e.priority >= query.minPriority!);
    }

    // Tag filter
    if (query.tags && query.tags.length > 0) {
      results = results.filter((e) =>
        e.tags.some((t) => query.tags!.includes(t)),
      );
    }

    // Semantic search
    if (query.text) {
      // Build IDF
      const totalDocs = results.length;
      const df = new Map<string, number>();
      for (const entry of results) {
        const tokens = tokenize(entry.content);
        const seen = new Set<string>();
        for (const t of tokens) {
          if (!seen.has(t)) {
            seen.add(t);
            df.set(t, (df.get(t) || 0) + 1);
          }
        }
      }

      const globalIdf = new Map<string, number>();
      for (const [term, count] of df) {
        globalIdf.set(term, Math.log(totalDocs / (count + 1)));
      }

      const queryVec = buildTfIdfVector(query.text, globalIdf, totalDocs);
      const scored = results.map((entry) => ({
        entry,
        score: cosineSimilarity(
          queryVec,
          buildTfIdfVector(entry.content, globalIdf, totalDocs),
        ),
      }));

      scored.sort((a, b) => b.score - a.score);
      results = scored
        .filter((s) => s.score > 0.01)
        .map((s) => s.entry);
    }

    // Sort by priority desc, then recency
    results.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.updatedAt - a.updatedAt;
    });

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  // ── Cleanup ──

  /** Remove all expired entries. */
  purgeExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        this.entries.delete(id);
        count++;
      }
    }
    if (count > 0) this.scheduleSave();
    return count;
  }

  /** Remove all entries for a given session. */
  clearSession(sessionId: string): number {
    let count = 0;
    for (const [id, entry] of this.entries) {
      if (entry.sessionId === sessionId) {
        this.entries.delete(id);
        count++;
      }
    }
    if (count > 0) this.scheduleSave();
    return count;
  }

  // ── Stats ──

  getStats(): { total: number; global: number; session: number; expired: number } {
    const now = Date.now();
    let global = 0;
    let session = 0;
    let expired = 0;
    for (const entry of this.entries.values()) {
      if (entry.expiresAt && entry.expiresAt <= now) expired++;
      if (entry.scope === "global") global++;
      if (entry.scope === "session") session++;
    }
    return {
      total: this.entries.size,
      global,
      session,
      expired,
    };
  }

  /** Total active entries (excluding expired). */
  get count(): number {
    const now = Date.now();
    let c = 0;
    for (const entry of this.entries.values()) {
      if (!entry.expiresAt || entry.expiresAt > now) c++;
    }
    return c;
  }

  // ── Persistence ──

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (entry.id) {
              entry.createdAt = Number(entry.createdAt);
              entry.updatedAt = Number(entry.updatedAt);
              if (entry.expiresAt) entry.expiresAt = Number(entry.expiresAt);
              this.entries.set(entry.id, entry);
            }
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
    this.saveTimer = setTimeout(() => this.flush(), 500);
    this.saveTimer.unref();
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const arr = [...this.entries.values()];
      const tmp = `${this.storePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), "utf-8");
      // fsync the temp file so the data is durable before the atomic rename
      const fd = fs.openSync(tmp, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.storePath);
      this.dirty = false;
    } catch (err) {
      console.error(`[MemoryHost] Failed to flush store to ${this.storePath}: ${err instanceof Error ? err.message : String(err)}`);
      // Keep dirty = true and reschedule so we retry on the next tick
      this.scheduleSave();
    }
  }

  private isExpired(entry: MemoryHostEntry): boolean {
    return !!(
      entry.expiresAt &&
      entry.expiresAt <= Date.now()
    );
  }
}