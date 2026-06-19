import { type LongTermMemory, type MemoryEntry, type MemorySearchQuery, type MemorySearchResult, DEFAULT_EMBEDDING_DIMENSION, COSINE_SIMILARITY_THRESHOLD } from "@evoclaw/core";
import { v4 as uuid } from "uuid";
import * as fs from "fs";
import * as path from "path";

interface SqliteStatement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const DATA_DIR = process.env.EVOCLAW_DATA_DIR || path.join(process.cwd(), "data");
const MEMORY_FILE = path.join(DATA_DIR, "memory", "long-term.json");
const SQLITE_FILE = path.join(DATA_DIR, "memory", "long-term.db");
const SAVE_DEBOUNCE_MS = 2000;

export class LongTermMemoryStore implements LongTermMemory {
  private entries = new Map<string, MemoryEntry>();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private sqliteDb: SqliteDatabase | null = null;

  constructor() {
    this.initSqlite();
    this.loadFromDisk();
  }

  private initSqlite(): void {
    try {
      const BetterSqlite3 = require("better-sqlite3");
      const dir = path.dirname(SQLITE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.sqliteDb = new BetterSqlite3(SQLITE_FILE) as SqliteDatabase;
      this.sqliteDb.exec(
        "CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, type TEXT, content TEXT, importance REAL, tags TEXT, createdAt TEXT, updatedAt TEXT, ttl INTEGER, data TEXT)"
      );
      process.stdout.write(`[LongTermMemory] SQLite backend opened at ${SQLITE_FILE}\n`);
    } catch {
      this.sqliteDb = null;
      process.stderr.write(`[LongTermMemory] better-sqlite3 not available, SQLite backend disabled\n`);
    }
  }

  /** Load persisted memory from disk */
  private loadFromDisk(): void {
    // Try SQLite first
    if (this.sqliteDb) {
      try {
        const stmt = this.sqliteDb.prepare("SELECT data FROM memories");
        const rows = stmt.all() as Array<{ data: string }>;
        if (rows.length > 0 && this.entries.size === 0) {
          for (const row of rows) {
            try {
              const item = JSON.parse(row.data);
              const entry: MemoryEntry = {
                ...item,
                createdAt: new Date(item.createdAt),
                accessedAt: new Date(item.accessedAt),
              };
              this.entries.set(entry.id, entry);
            } catch {
              // skip malformed rows
            }
          }
          process.stdout.write(`[LongTermMemory] Loaded ${this.entries.size} entries from SQLite\n`);
          return;
        }
      } catch (err) {
        process.stderr.write(`[LongTermMemory] Failed to load from SQLite: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    // Fallback to JSON file
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const raw = fs.readFileSync(MEMORY_FILE, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const item of data) {
            const entry: MemoryEntry = {
              ...item,
              createdAt: new Date(item.createdAt),
              accessedAt: new Date(item.accessedAt),
            };
            this.entries.set(entry.id, entry);
          }
          process.stdout.write(`[LongTermMemory] Loaded ${this.entries.size} entries from disk\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[LongTermMemory] Failed to load from disk: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  /** Save to disk with debounce */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveToDisk(), SAVE_DEBOUNCE_MS);
  }

  private saveToDisk(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const dir = path.dirname(MEMORY_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.entries.values()).map((e) => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
        accessedAt: e.accessedAt.toISOString(),
      }));
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      process.stderr.write(`[LongTermMemory] Failed to save: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  private saveToSqlite(entry: MemoryEntry): void {
    if (!this.sqliteDb) return;
    try {
      const stmt = this.sqliteDb.prepare(
        "INSERT OR REPLACE INTO memories (id, type, content, importance, tags, createdAt, updatedAt, ttl, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const data = JSON.stringify({
        ...entry,
        createdAt: entry.createdAt.toISOString(),
        accessedAt: entry.accessedAt.toISOString(),
      });
      stmt.run(
        entry.id,
        entry.type,
        entry.content,
        entry.metadata.importance,
        JSON.stringify(entry.metadata.tags),
        entry.createdAt.toISOString(),
        entry.accessedAt.toISOString(),
        entry.ttl,
        data
      );
    } catch (err) {
      process.stderr.write(`[LongTermMemory] Failed to save to SQLite: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  async store(entry: MemoryEntry): Promise<MemoryEntry> {
    const fullEntry: MemoryEntry = {
      ...entry,
      id: entry.id || uuid(),
      createdAt: entry.createdAt || new Date(),
      accessedAt: entry.accessedAt || new Date(),
    };
    this.entries.set(fullEntry.id, fullEntry);
    this.saveToSqlite(fullEntry);
    this.scheduleSave();
    return fullEntry;
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    const results: MemorySearchResult[] = [];

    // Use SQLite for content matching when available
    if (this.sqliteDb && query.query) {
      try {
        const stmt = this.sqliteDb.prepare(
          "SELECT id FROM memories WHERE content LIKE ?"
        );
        const rows = stmt.all(`%${query.query}%`) as Array<{ id: string }>;
        const sqliteMatchIds = new Set(rows.map((r) => r.id));

        for (const entry of this.entries.values()) {
          let score = 0;
          const matchedFields: string[] = [];

          if (query.type && entry.type !== query.type) continue;

          if (query.tags?.length) {
            const tagMatch = query.tags.some((t) => entry.metadata.tags.includes(t));
            if (!tagMatch) continue;
            matchedFields.push("tags");
            score += 0.3;
          }

          if (query.minImportance && entry.metadata.importance < query.minImportance) continue;

          if (sqliteMatchIds.has(entry.id)) {
            score += 0.5;
            matchedFields.push("content");
          }

          if (query.embedding && entry.embedding) {
            const similarity = this.cosineSimilarity(query.embedding, entry.embedding);
            if (similarity >= (query.threshold || COSINE_SIMILARITY_THRESHOLD)) {
              score += similarity * 0.5;
              matchedFields.push("embedding");
            } else if (!matchedFields.length) {
              continue;
            }
          }

          if (score > 0) {
            results.push({ entry, score, matchedFields });
          }
        }

        results.sort((a, b) => b.score - a.score);
        return query.limit ? results.slice(0, query.limit) : results;
      } catch (err) {
        process.stderr.write(`[LongTermMemory] SQLite search failed, falling back to in-memory: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    // In-memory fallback
    for (const entry of this.entries.values()) {
      let score = 0;
      const matchedFields: string[] = [];

      if (query.type && entry.type !== query.type) continue;

      if (query.tags?.length) {
        const tagMatch = query.tags.some((t) => entry.metadata.tags.includes(t));
        if (!tagMatch) continue;
        matchedFields.push("tags");
        score += 0.3;
      }

      if (query.minImportance && entry.metadata.importance < query.minImportance) continue;

      if (query.query && entry.content.toLowerCase().includes(query.query.toLowerCase())) {
        score += 0.5;
        matchedFields.push("content");
      }

      if (query.embedding && entry.embedding) {
        const similarity = this.cosineSimilarity(query.embedding, entry.embedding);
        if (similarity >= (query.threshold || COSINE_SIMILARITY_THRESHOLD)) {
          score += similarity * 0.5;
          matchedFields.push("embedding");
        } else if (!matchedFields.length) {
          continue;
        }
      }

      if (score > 0) {
        results.push({ entry, score, matchedFields });
      }
    }

    results.sort((a, b) => b.score - a.score);

    return query.limit ? results.slice(0, query.limit) : results;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    let entry = this.entries.get(id) ?? null;
    if (!entry && this.sqliteDb) {
      // Check SQLite if not found in memory Map
      try {
        const stmt = this.sqliteDb.prepare("SELECT data FROM memories WHERE id = ?");
        const row = stmt.get(id) as { data: string } | undefined;
        if (row) {
          const item = JSON.parse(row.data);
          const sqliteEntry: MemoryEntry = {
            ...item,
            createdAt: new Date(item.createdAt),
            accessedAt: new Date(item.accessedAt),
          };
          this.entries.set(sqliteEntry.id, sqliteEntry);
          entry = sqliteEntry;
        }
      } catch (err) {
        process.stderr.write(`[LongTermMemory] Failed to retrieve from SQLite: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    if (entry) {
      entry.accessedAt = new Date();
      this.scheduleSave();
    }
    return entry;
  }

  async update(id: string, updates: Partial<MemoryEntry>): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      const updated = { ...entry, ...updates, accessedAt: new Date() };
      this.entries.set(id, updated);
      this.saveToSqlite(updated);
      this.scheduleSave();
    }
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
    if (this.sqliteDb) {
      try {
        const stmt = this.sqliteDb.prepare("DELETE FROM memories WHERE id = ?");
        stmt.run(id);
      } catch (err) {
        process.stderr.write(`[LongTermMemory] Failed to delete from SQLite: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    this.scheduleSave();
  }

  async expire(): Promise<number> {
    let expired = 0;
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.ttl > 0 && entry.createdAt.getTime() + entry.ttl < now) {
        this.entries.delete(id);
        if (this.sqliteDb) {
          try {
            const stmt = this.sqliteDb.prepare("DELETE FROM memories WHERE id = ?");
            stmt.run(id);
          } catch {
            // best effort
          }
        }
        expired++;
      }
    }
    if (expired > 0) this.scheduleSave();
    return expired;
  }

  /** Get all entries (for backup/export) */
  async getAll(): Promise<MemoryEntry[]> {
    return Array.from(this.entries.values());
  }

  /** Force immediate save */
  async flush(): Promise<void> {
    this.saveToDisk();
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;
    return dotProduct / denominator;
  }
}
