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

export interface FTS5SearchResult {
  rowid: number;
  content: string;
  rank: number;
  snippet: string;
  metadata: Record<string, unknown>;
}

export interface FTS5SearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  sessionId?: string;
  type?: string;
  timeRange?: { from: Date; to: Date };
}

interface FallbackEntry {
  id: string;
  content: string;
  sessionId: string;
  type: string;
  createdAt: string;
}

export class FTS5SearchEngine {
  private db: SqliteDatabase | null = null;
  private fallback: Map<string, FallbackEntry> = new Map();
  private useFallback: boolean = false;
  private dbPath: string;

  constructor(dbPath?: string) {
    if (dbPath === undefined) {
      const dataDir = process.env.EVOCLAW_DATA_DIR || path.join(process.cwd(), "data");
      this.dbPath = path.join(dataDir, "memory", "fts5.db");
      const dir = path.dirname(this.dbPath);
      fs.mkdirSync(dir, { recursive: true });
    } else {
      this.dbPath = dbPath;
    }
    let BetterSqlite3: new (file: string, opts?: Record<string, unknown>) => SqliteDatabase;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      BetterSqlite3 = require("better-sqlite3");
    } catch (err) {
      this.db = null;
      this.useFallback = true;
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[FTS5Search] better-sqlite3 module not available, falling back to in-memory mode (${reason})\n`);
      return;
    }
    try {
      this.db = new BetterSqlite3(this.dbPath) as SqliteDatabase;
      this.useFallback = false;
      if (this.dbPath !== ":memory:") {
        process.stdout.write(`[FTS5Search] Using persistent database at ${this.dbPath}\n`);
      }
    } catch (err) {
      this.db = null;
      this.useFallback = true;
      // better-sqlite3 的 "Could not locate the bindings file" 错误包含 13 行路径列表，
      // 提取关键摘要以避免污染启动日志
      const fullReason = err instanceof Error ? err.message : String(err);
      const reason = fullReason.startsWith("Could not locate the bindings file")
        ? "native bindings not compiled for this Node.js/ABI version"
        : fullReason.split("\n")[0];
      process.stderr.write(`[FTS5Search] SQLite init failed, falling back to in-memory mode (${reason}; run "pnpm rebuild better-sqlite3" to compile native bindings)\n`);
    }
  }

  initialize(): void {
    if (this.useFallback || !this.db) return;
    this.db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id, content, session_id, type, created_at, tokenize='unicode61')"
    );
  }

  indexEntry(
    id: string,
    content: string,
    metadata: { sessionId?: string; type?: string; createdAt: Date }
  ): void {
    if (this.useFallback || !this.db) {
      this.fallback.set(id, {
        id,
        content,
        sessionId: metadata.sessionId ?? "",
        type: metadata.type ?? "",
        createdAt: metadata.createdAt.toISOString(),
      });
      return;
    }
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO memory_fts (id, content, session_id, type, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    stmt.run(id, content, metadata.sessionId ?? "", metadata.type ?? "", metadata.createdAt.toISOString());
  }

  search(options: FTS5SearchOptions): FTS5SearchResult[] {
    if (this.useFallback || !this.db) {
      return this.fallbackSearch(options);
    }
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;
    const conditions: string[] = ["memory_fts MATCH ?"];
    const params: unknown[] = [options.query];
    if (options.sessionId) {
      conditions.push("session_id = ?");
      params.push(options.sessionId);
    }
    if (options.type) {
      conditions.push("type = ?");
      params.push(options.type);
    }
    if (options.timeRange) {
      conditions.push("created_at >= ?");
      conditions.push("created_at <= ?");
      params.push(options.timeRange.from.toISOString());
      params.push(options.timeRange.to.toISOString());
    }
    const whereClause = conditions.join(" AND ");
    const sql = `SELECT rowid, id, content, session_id, type, created_at, bm25(memory_fts) as rank FROM memory_fts WHERE ${whereClause} ORDER BY rank LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      rowid: number;
      id: string;
      content: string;
      session_id: string;
      type: string;
      created_at: string;
      rank: number;
    }>;
    return rows.map((row) => ({
      rowid: row.rowid,
      content: row.content,
      rank: row.rank,
      snippet: this.generateSnippet(row.content, options.query),
      metadata: {
        id: row.id,
        sessionId: row.session_id,
        type: row.type,
        createdAt: row.created_at,
      },
    }));
  }

  deleteEntry(id: string): void {
    if (this.useFallback || !this.db) {
      this.fallback.delete(id);
      return;
    }
    const stmt = this.db.prepare("DELETE FROM memory_fts WHERE id = ?");
    stmt.run(id);
  }

  getCount(): number {
    if (this.useFallback || !this.db) {
      return this.fallback.size;
    }
    const stmt = this.db.prepare("SELECT COUNT(*) as count FROM memory_fts");
    const row = stmt.get() as { count: number };
    return row.count;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.fallback.clear();
  }

  private generateSnippet(content: string, query: string): string {
    const lowerContent = content.toLowerCase();
    const lowerQuery = query.toLowerCase().replace(/"/g, "");
    const terms = lowerQuery.split(/\s+/).filter((t) => t.length > 0);
    let firstPos = -1;
    for (const term of terms) {
      const idx = lowerContent.indexOf(term);
      if (idx !== -1 && (firstPos === -1 || idx < firstPos)) {
        firstPos = idx;
      }
    }
    if (firstPos === -1) {
      return content.slice(0, 100);
    }
    const start = Math.max(0, firstPos - 40);
    const end = Math.min(content.length, firstPos + 60);
    let snippet = content.slice(start, end);
    if (start > 0) snippet = "..." + snippet;
    if (end < content.length) snippet = snippet + "...";
    return snippet;
  }

  private fallbackSearch(options: FTS5SearchOptions): FTS5SearchResult[] {
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;
    const lowerQuery = options.query.toLowerCase();
    const terms = lowerQuery.replace(/"/g, "").split(/\s+/).filter((t) => t.length > 0);
    const results: FTS5SearchResult[] = [];
    let rowid = 0;
    for (const [, entry] of this.fallback) {
      if (options.sessionId && entry.sessionId !== options.sessionId) continue;
      if (options.type && entry.type !== options.type) continue;
      if (options.timeRange) {
        const d = new Date(entry.createdAt);
        // Invalid Date 时 getTime() 返回 NaN，所有比较都为 false，会错误地保留本应被过滤的条目。
        // 对非法日期条目跳过时间范围过滤外的处理，避免污染结果集。
        const t = d.getTime();
        if (Number.isNaN(t)) continue;
        if (t < options.timeRange.from.getTime() || t > options.timeRange.to.getTime()) continue;
      }
      const lowerContent = entry.content.toLowerCase();
      let match = false;
      for (const term of terms) {
        if (lowerContent.includes(term)) {
          match = true;
          break;
        }
      }
      if (!match) continue;
      rowid++;
      results.push({
        rowid,
        content: entry.content,
        rank: -terms.filter((t) => lowerContent.includes(t)).length,
        snippet: this.generateSnippet(entry.content, options.query),
        metadata: {
          id: entry.id,
          sessionId: entry.sessionId,
          type: entry.type,
          createdAt: entry.createdAt,
        },
      });
    }
    results.sort((a, b) => a.rank - b.rank);
    return results.slice(offset, offset + limit);
  }
}
