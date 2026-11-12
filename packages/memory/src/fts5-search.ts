import * as fs from "fs";
import * as path from "path";
import { applyPragmas, DEFAULT_PRODUCTION_PRAGMAS, withTransaction } from "@evoclaw/infrastructure";

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

/** fallback Map 最大条目数，防止无界内存增长。 */
const FALLBACK_MAX_ENTRIES = 10000;

// ── FTS5 查询构造（hermes alignment round4）──────────────────
//
// 旧实现把整条查询包成一个短语：`"machine learning"`。自然语言检索
// （"quick dog"、"项目进度 季度目标"）因此几乎总是零结果；CJK 更严重——
// unicode61 把连续中文切成整段 token，短语/前缀都命中不了。
// 对齐 hermes `hermes_state_search.py:_quote_fts_tokens`：每个 token 单独
// 引号化（中和 FTS5 语法字符）+ 裸词前缀通配；含 CJK 且 MATCH 无结果时
// 退化为 LIKE 子串匹配。

interface QueryToken {
  text: string;
  /** 用户显式用引号括起的短语（保持精确短语，不加前缀通配） */
  quoted: boolean;
}

/** 保留显式 AND/OR/NOT 操作符，其余 token 全部字面化（NEAR 需函数语法，不保留） */
const FTS_OPERATORS = new Set(["AND", "OR", "NOT"]);

function tokenizeQuery(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const text = (m[1] ?? m[2] ?? "").trim();
    if (text) tokens.push({ text, quoted: m[1] !== undefined });
  }
  return tokens;
}

/** 纯标点 token 不含可检索内容，丢弃以免生成无效 FTS5 语法（如 `")"*`） */
function isLiteralTerm(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** 是否含 CJK 字符（中文/日文假名/韩文） */
export function hasCjkText(text: string): boolean {
  return /[㐀-鿿぀-ヿ가-힯]/.test(text);
}

/** 构造安全的 FTS5 MATCH 表达式；空查询返回 ""（调用方按无结果处理） */
export function buildFtsMatchQuery(query: string): string {
  const parts: Array<{ kind: "term" | "op"; value: string }> = [];
  for (const { text, quoted } of tokenizeQuery(query)) {
    // 只有未加引号的裸操作符才当操作符；其余全部字面化
    if (!quoted && FTS_OPERATORS.has(text.toUpperCase())) {
      parts.push({ kind: "op", value: text.toUpperCase() });
      continue;
    }
    if (!isLiteralTerm(text)) continue;
    const escaped = text.replace(/"/g, '""');
    parts.push({ kind: "term", value: quoted ? `"${escaped}"` : `"${escaped}"*` });
  }
  // 只保留位于两个 term 之间的操作符；首尾/连续操作符会让 MATCH 抛语法错误
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].kind === "op") {
      if (parts[i - 1]?.kind === "term" && parts[i + 1]?.kind === "term") {
        out.push(parts[i].value);
      }
    } else {
      out.push(parts[i].value);
    }
  }
  return out.join(" ");
}

/** LIKE 回退用的模式串：转义 LIKE 自身的 %/_，每个 term 一个 %term% */
function buildLikePatterns(query: string): string[] {
  return tokenizeQuery(query)
    .filter((t) => isLiteralTerm(t.text) && !(t.quoted === false && FTS_OPERATORS.has(t.text.toUpperCase())))
    .map((t) => `%${t.text.replace(/[\\%_]/g, "\\$&")}%`);
}

interface FtsRow {
  rowid: number;
  id: string;
  content: string;
  session_id: string;
  type: string;
  created_at: string;
  rank: number;
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
      // 应用生产环境 PRAGMA（WAL/synchronous/busy_timeout 等），在 CREATE TABLE 之前生效
      applyPragmas(this.db, DEFAULT_PRODUCTION_PRAGMAS);
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
      this.pruneFallback();
      return;
    }
    // FTS5 表无 PRIMARY KEY/UNIQUE 约束，INSERT OR REPLACE 无法实现幂等更新，
    // 每次 REPLACE 都会插入新行导致索引重复膨胀。先 DELETE 再 INSERT 保证幂等。
    // 用 withTransaction 包裹 DELETE+INSERT：进程在 DELETE 后 INSERT 前崩溃会回滚，
    // 避免条目永久丢失（与 indexBatch 保持一致）。
    withTransaction(this.db, () => {
      const deleteStmt = this.db!.prepare("DELETE FROM memory_fts WHERE id = ?");
      deleteStmt.run(id);
      const stmt = this.db!.prepare(
        "INSERT INTO memory_fts (id, content, session_id, type, created_at) VALUES (?, ?, ?, ?, ?)"
      );
      stmt.run(id, content, metadata.sessionId ?? "", metadata.type ?? "", metadata.createdAt.toISOString());
    });
  }

  /**
   * 批量索引 —— 在单个事务中写入多条记录，降低 FTS5 写锁竞争。
   *
   * 对标 Hermes v0.18.0 的 "FTS5 索引合并降低写入锁竞争"：
   * - 旧方式：每条 indexEntry 一次 INSERT，每触发一次 FTS5 写锁
   * - 新方式：所有条目在 BEGIN/COMMIT 事务内批量写入，只触发一次写锁
   *
   * 对于批量导入（如会话历史索引、RAG 文档分块索引），
   * 批量事务可以将写入性能提升 5-10 倍。
   */
  indexBatch(
    entries: Array<{
      id: string;
      content: string;
      metadata: { sessionId?: string; type?: string; createdAt: Date };
    }>,
  ): void {
    if (entries.length === 0) return;
    if (this.useFallback || !this.db) {
      for (const entry of entries) {
        this.fallback.set(entry.id, {
          id: entry.id,
          content: entry.content,
          sessionId: entry.metadata.sessionId ?? "",
          type: entry.metadata.type ?? "",
          createdAt: entry.metadata.createdAt.toISOString(),
        });
      }
      this.pruneFallback();
      return;
    }
    // 在单个事务中批量写入 —— FTS5 写锁只在 BEGIN 时获取一次
    // 复用 withTransaction：自动处理嵌套事务（savepoint）和 ROLLBACK，比手动 BEGIN/COMMIT 更稳健
    withTransaction(this.db, () => {
      const deleteStmt = this.db!.prepare("DELETE FROM memory_fts WHERE id = ?");
      const stmt = this.db!.prepare(
        "INSERT INTO memory_fts (id, content, session_id, type, created_at) VALUES (?, ?, ?, ?, ?)"
      );
      for (const entry of entries) {
        // FTS5 表无 UNIQUE 约束，INSERT OR REPLACE 无法幂等：先 DELETE 再 INSERT 防止索引重复膨胀
        deleteStmt.run(entry.id);
        stmt.run(
          entry.id,
          entry.content,
          entry.metadata.sessionId ?? "",
          entry.metadata.type ?? "",
          entry.metadata.createdAt.toISOString(),
        );
      }
    });
  }

  /** 构造 session/type/timeRange 过滤条件（MATCH / LIKE 两条路径共用） */
  private filterClauses(options: FTS5SearchOptions): { sql: string[]; params: unknown[] } {
    const sql: string[] = [];
    const params: unknown[] = [];
    if (options.sessionId) {
      sql.push("session_id = ?");
      params.push(options.sessionId);
    }
    if (options.type) {
      sql.push("type = ?");
      params.push(options.type);
    }
    if (options.timeRange) {
      sql.push("created_at >= ?", "created_at <= ?");
      params.push(options.timeRange.from.toISOString(), options.timeRange.to.toISOString());
    }
    return { sql, params };
  }

  search(options: FTS5SearchOptions): FTS5SearchResult[] {
    if (this.useFallback || !this.db) {
      return this.fallbackSearch(options);
    }
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;
    const filters = this.filterClauses(options);
    const matchQuery = buildFtsMatchQuery(options.query);
    if (!matchQuery) return [];

    let rows: FtsRow[] = [];
    try {
      // 主路径：逐 token 引号化 + 前缀，支持多词自然语言查询与非精确短语
      rows = this.db.prepare(
        `SELECT rowid, id, content, session_id, type, created_at, bm25(memory_fts) as rank ` +
        `FROM memory_fts WHERE memory_fts MATCH ? AND ${["1=1", ...filters.sql].join(" AND ")} ` +
        `ORDER BY rank LIMIT ? OFFSET ?`,
      ).all(matchQuery, ...filters.params, limit, offset) as FtsRow[];

      // CJK 回退：unicode61 把连续中文切成一个整段 token，MATCH 常静默零结果。
      // 用 LIKE 子串匹配（带同样的过滤/分页），不引入新依赖、无需数据迁移。
      if (rows.length === 0 && hasCjkText(options.query)) {
        const patterns = buildLikePatterns(options.query);
        if (patterns.length > 0) {
          const likeClauses = patterns.map(() => "content LIKE ? ESCAPE '\\'");
          const likeParams: unknown[] = patterns;
          rows = this.db.prepare(
            `SELECT rowid, id, content, session_id, type, created_at, 0.0 as rank ` +
            `FROM memory_fts WHERE ${likeClauses.join(" AND ")} AND ${["1=1", ...filters.sql].join(" AND ")} ` +
            `ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          ).all(...likeParams, ...filters.params, limit, offset) as FtsRow[];
        }
      }
    } catch (err) {
      // FTS5 查询失败时重新抛出，让调用方决定降级策略。
      // 旧实现回退到 this.fallback Map，但正常模式下 fallback 为空，返回空数组会掩盖真实错误。
      process.stderr.write('[FTS5Search] query failed: ' + err + '\n');
      throw err;
    }

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

  /**
   * 限制 fallback Map 大小，超限时淘汰 createdAt 最旧的条目，防止无界内存增长。
   * ISO 8601 字符串按字典序排序即为时间顺序，无需解析为 Date。
   */
  private pruneFallback(maxEntries: number = FALLBACK_MAX_ENTRIES): void {
    if (this.fallback.size <= maxEntries) return;
    const sorted = Array.from(this.fallback.entries())
      .sort((a, b) => (a[1].createdAt < b[1].createdAt ? -1 : a[1].createdAt > b[1].createdAt ? 1 : 0));
    const toRemove = sorted.length - maxEntries;
    for (let i = 0; i < toRemove; i++) {
      this.fallback.delete(sorted[i][0]);
    }
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
    if (terms.length === 0) return []; // 空查询不返回全部条目（与 MATCH 路径对齐）
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
      // 与 SQLite 路径对齐：逐 token 与语义（每个 term 都要命中），
      // 避免 MATCH 与 fallback Map 两条后端行为分叉。
      const matchedTerms = terms.filter((t) => lowerContent.includes(t)).length;
      if (matchedTerms !== terms.length) continue;
      rowid++;
      results.push({
        rowid,
        content: entry.content,
        rank: -matchedTerms,
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
