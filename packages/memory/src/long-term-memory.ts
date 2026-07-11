import { type LongTermMemory, type MemoryEntry, type MemorySearchQuery, type MemorySearchResult, DEFAULT_EMBEDDING_DIMENSION, COSINE_SIMILARITY_THRESHOLD } from "@evoclaw/core";
import { applyPragmas, DEFAULT_PRODUCTION_PRAGMAS } from "@evoclaw/infrastructure";
import { v4 as uuid } from "uuid";
import { randomUUID } from "crypto";
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
// TTL 过期扫描间隔：每 10 分钟扫描一次，清理过期记忆。
// 此前 expire() 仅在外部显式调用时执行，导致 TTL 字段被静默忽略，
// 过期记忆永远残留。
const EXPIRE_SCAN_INTERVAL_MS = 10 * 60 * 1000;

/** 解析日期，无效时回退到 epoch 0，防止 Invalid Date 导致 toISOString() 抛 RangeError */
function parseDateSafe(value: unknown): Date {
  const d = new Date(value as string);
  return Number.isFinite(d.getTime()) ? d : new Date(0);
}

export class LongTermMemoryStore implements LongTermMemory {
  private entries = new Map<string, MemoryEntry>();
  private saveTimer: NodeJS.Timeout | null = null;
  private expireTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private sqliteDb: SqliteDatabase | null = null;
  /**
   * SQLite 降级标志：saveToSqlite 失败时置为 true。
   * loadFromDisk 检测到此标志则合并 SQLite + JSON 而非二选一，
   * 防止部分条目未入库 SQLite 导致重启后永久丢失。
   */
  private sqliteDegraded = false;

  constructor() {
    this.initSqlite();
    this.loadFromDisk();
    this.startExpireTimer();
  }

  /** 启动周期性 TTL 过期扫描定时器 */
  private startExpireTimer(): void {
    // 立即执行一次过期清理（加载后即清理），然后周期性扫描
    void this.expire().catch(() => { /* best-effort */ });
    this.expireTimer = setInterval(() => {
      void this.expire().catch(() => { /* best-effort */ });
    }, EXPIRE_SCAN_INTERVAL_MS);
    // unref 防止定时器阻止进程优雅退出
    this.expireTimer.unref();
  }

  private initSqlite(): void {
    let BetterSqlite3: new (file: string, opts?: Record<string, unknown>) => SqliteDatabase;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      BetterSqlite3 = require("better-sqlite3");
    } catch (err) {
      this.sqliteDb = null;
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[LongTermMemory] better-sqlite3 module not available, SQLite backend disabled (${reason})\n`);
      return;
    }
    try {
      const dir = path.dirname(SQLITE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.sqliteDb = new BetterSqlite3(SQLITE_FILE) as SqliteDatabase;
      // 应用生产环境 PRAGMA（WAL/synchronous/busy_timeout 等），在 CREATE TABLE 之前生效。
      // 旧实现未设 PRAGMA，导致性能差且无 busy_timeout，遇锁立即失败。
      applyPragmas(this.sqliteDb, DEFAULT_PRODUCTION_PRAGMAS);
      this.sqliteDb.exec(
        "CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, type TEXT, content TEXT, importance REAL, tags TEXT, createdAt TEXT, updatedAt TEXT, ttl INTEGER, data TEXT)"
      );
      process.stdout.write(`[LongTermMemory] SQLite backend opened at ${SQLITE_FILE}\n`);
    } catch (err) {
      this.sqliteDb = null;
      // better-sqlite3 的 "Could not locate the bindings file" 错误包含 13 行路径列表，
      // 提取关键摘要以避免污染启动日志
      const fullReason = err instanceof Error ? err.message : String(err);
      const reason = fullReason.startsWith("Could not locate the bindings file")
        ? "native bindings not compiled for this Node.js/ABI version"
        : fullReason.split("\n")[0];
      process.stderr.write(`[LongTermMemory] SQLite backend init failed, falling back to JSON (${reason}; run "pnpm rebuild better-sqlite3" to compile native bindings)\n`);
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
              if (typeof item !== "object" || item === null || !item.id) continue;
              const entry: MemoryEntry = {
                ...item,
                createdAt: parseDateSafe(item.createdAt),
                accessedAt: parseDateSafe(item.accessedAt),
              };
              this.entries.set(entry.id, entry);
            } catch {
              // skip malformed rows
            }
          }
          // sqliteDegraded 为 true 时，SQLite 可能缺失部分条目（saveToSqlite 曾失败），
          // 不能直接 return：需 fall-through 到 JSON 分支合并条目（以 id 去重，JSON 优先因为可能更新）。
          if (!this.sqliteDegraded) {
            process.stdout.write(`[LongTermMemory] Loaded ${this.entries.size} entries from SQLite\n`);
            return;
          }
          process.stdout.write(`[LongTermMemory] SQLite degraded, merging with JSON (SQLite: ${this.entries.size} entries)\n`);
        }
      } catch (err) {
        process.stderr.write(`[LongTermMemory] Failed to load from SQLite: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    // Fallback to JSON file（sqliteDegraded 时为合并路径：JSON 条目以 id 覆盖 SQLite 条目）
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const raw = fs.readFileSync(MEMORY_FILE, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const item of data) {
            const entry: MemoryEntry = {
              ...item,
              createdAt: parseDateSafe(item.createdAt),
              accessedAt: parseDateSafe(item.accessedAt),
            };
            this.entries.set(entry.id, entry);
          }
          process.stdout.write(`[LongTermMemory] Loaded ${this.entries.size} entries from disk${this.sqliteDegraded ? " (merged with SQLite)" : ""}\n`);
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
    // unref 防止防抖定时器阻止进程优雅退出
    this.saveTimer.unref();
  }

  private saveToDisk(): void {
    if (!this.dirty) return;
    // 安全：仅在成功写入后才清除 dirty 标志。
    // 旧实现在 try 之前就 dirty=false，写入失败时数据永久丢失且不重试。
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
      // 原子写入：temp + fsync + rename，防止崩溃时产生截断的记忆文件
      const tmpPath = `${MEMORY_FILE}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      const fd = fs.openSync(tmpPath, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf-8");
        fs.fsyncSync(fd);
      } catch (werr) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw werr;
      }
      fs.closeSync(fd);
      try {
        if (fs.existsSync(MEMORY_FILE)) {
          const st = fs.statSync(MEMORY_FILE);
          fs.chmodSync(tmpPath, st.mode);
        }
      } catch { /* ignore */ }
      try {
        fs.renameSync(tmpPath, MEMORY_FILE);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EXDEV" || code === "EBUSY") {
          // 跨设备回退：目标侧 temp + rename
          const content = fs.readFileSync(tmpPath, "utf-8");
          const dstTmp = `${MEMORY_FILE}.${process.pid}.${randomUUID().slice(0, 8)}.dst.tmp`;
          const fd2 = fs.openSync(dstTmp, "w");
          try {
            fs.writeFileSync(fd2, content, "utf-8");
            fs.fsyncSync(fd2);
          } catch (w2err) {
            try { fs.closeSync(fd2); } catch { /* ignore */ }
            try { fs.unlinkSync(dstTmp); } catch { /* ignore */ }
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            throw w2err;
          }
          fs.closeSync(fd2);
          // 安全：EXDEV 回退的 rename 失败必须抛出，否则数据丢失且 dirty 已清
          try {
            fs.renameSync(dstTmp, MEMORY_FILE);
          } catch (renameErr) {
            try { fs.unlinkSync(dstTmp); } catch { /* ignore */ }
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            throw renameErr;
          }
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        } else {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          throw err;
        }
      }
      // 仅在成功写入后才清除 dirty
      this.dirty = false;
    } catch (err) {
      // 写入失败：保持 dirty=true，下次 scheduleSave 会重试
      process.stderr.write(`[LongTermMemory] Failed to save (will retry): ${err instanceof Error ? err.message : String(err)}\n`);
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
      // 成功写入：重置降级标志（SQLite 恢复可用）
      this.sqliteDegraded = false;
    } catch (err) {
      // 失败时设置降级标志：loadFromDisk 检测到此标志会合并 SQLite + JSON，
      // 避免未入库条目在重启后永久丢失。
      this.sqliteDegraded = true;
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
        const escaped = query.query.replace(/[%_\\]/g, "\\$&");
        const stmt = this.sqliteDb.prepare(
          "SELECT id FROM memories WHERE content LIKE ? ESCAPE '\\'"
        );
        const rows = stmt.all(`%${escaped}%`) as Array<{ id: string }>;
        const sqliteMatchIds = new Set(rows.map((r) => r.id));

        // SQLite 可能缺失部分条目（saveToSqlite 曾失败导致未入库），
        // 仅靠 sqliteMatchIds 会遗漏这些条目的 content 匹配。
        // 遍历内存 entries，content 匹配查询的条目也加入 sqliteMatchIds。
        const lowerQuery = query.query.toLowerCase();
        for (const entry of this.entries.values()) {
          if (entry.content.toLowerCase().includes(lowerQuery)) {
            sqliteMatchIds.add(entry.id);
          }
        }

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
        // 清空可能的部分结果：SQLite 分支在 for 循环执行到一半时抛错，
        // 已添加到 results 的条目会保留，随后内存分支会再次处理相同 entries 并追加，
        // 导致重复结果。清空后由内存分支重新填充。
        results.length = 0;
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
            createdAt: parseDateSafe(item.createdAt),
            accessedAt: parseDateSafe(item.accessedAt),
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

  /**
   * 释放资源：落盘 dirty 数据，清理 saveTimer/expireTimer，关闭 SQLite 连接。
   * 长期运行服务在销毁实例时应调用，否则 SQLite 文件句柄与 WAL 锁会泄漏。
   */
  async close(): Promise<void> {
    if (this.dirty) {
      this.saveToDisk();
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.expireTimer) {
      clearInterval(this.expireTimer);
      this.expireTimer = null;
    }
    // saveToDisk 失败时 dirty 仍为 true：若继续关闭 SQLite，dirty 数据将永久丢失。
    // 输出 stderr 警告使丢失不再静默（对齐"审计日志必须防止溢出和静默丢失"）。
    if (this.dirty) {
      process.stderr.write('[LongTermMemory] close() called with dirty=true: saveToDisk failed, unsaved data will be lost\n');
    }
    if (this.sqliteDb) {
      try {
        this.sqliteDb.close();
      } catch {
        // best effort
      }
      this.sqliteDb = null;
    }
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
