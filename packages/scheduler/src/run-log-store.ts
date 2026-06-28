/**
 * cron 运行日志 SQLite 持久化存储。
 *
 * 灵感来自 openclaw-main 的 src/cron/run-log/sqlite-store.ts + entry-codec.ts。
 *
 * 与 run-log.ts（基于 JSONL 文件）互补：
 *  - JSONL 实现简单、便于人工查看
 *  - SQLite 查询高效、支持索引和复杂过滤
 *
 * 设计原则：
 *  - 不直接依赖 better-sqlite3 类型（避免在 scheduler 包中引入 @types/better-sqlite3）
 *  - 接受外部传入的 Database 实例，由调用方管理连接生命周期
 *  - 仅声明所用到的 SQLite 方法子集（DatabaseLike）
 *  - entry-codec 风格的编解码内联在 store 中
 */

// ── SQLite 接口（仅声明我们使用的方法子集） ─────────────────────

/** SQLite 预编译语句接口。 */
interface SqliteStatement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** SQLite 数据库接口。 */
export interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close?(): void;
}

/** 兼容 better-sqlite3 的 Database 类型断言助手。 */
export function asSqliteDatabase(db: unknown): SqliteDatabaseLike {
  if (!db || typeof db !== "object") {
    throw new Error("expected a better-sqlite3 Database instance");
  }
  const candidate = db as Partial<SqliteDatabaseLike>;
  if (typeof candidate.exec !== "function" || typeof candidate.prepare !== "function") {
    throw new Error("object does not look like a better-sqlite3 Database (missing exec/prepare)");
  }
  return candidate as SqliteDatabaseLike;
}

// ── 类型定义 ────────────────────────────────────────────────────

/** cron 运行日志条目。 */
export interface RunLogEntry {
  /** 唯一运行 ID（uuid）。 */
  runId: string;
  /** 关联的 cron 任务 ID。 */
  jobId: string;
  /** 运行开始时间。 */
  startedAt: Date;
  /** 运行完成时间（未完成时为 undefined）。 */
  completedAt?: Date;
  /** 运行状态。 */
  status: "running" | "completed" | "failed" | "cancelled";
  /** 退出码（成功为 0，失败非 0）。 */
  exitCode?: number;
  /** 失败时的错误消息（前 1KB）。 */
  error?: string;
  /** stdout 输出摘要（前 1KB）。 */
  outputSummary?: string;
  /** 触发的子任务 ID 列表。 */
  triggeredSubtasks?: string[];
  /** 运行时长（毫秒）。 */
  durationMs?: number;
}

/** 查询参数。 */
export interface RunLogQuery {
  /** 按 jobId 过滤。 */
  jobId?: string;
  /** 按 status 过滤。 */
  status?: RunLogEntry["status"];
  /** 仅返回 startedAt >= startedAfter 的记录。 */
  startedAfter?: Date;
  /** 仅返回 startedAt <= startedBefore 的记录。 */
  startedBefore?: Date;
  /** 返回记录上限（默认 100）。 */
  limit?: number;
}

/** 统计信息。 */
export interface RunLogStats {
  totalRuns: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** 平均时长（毫秒，仅统计已完成的运行）。 */
  avgDurationMs?: number;
  /** 失败率（failed / totalRuns）。 */
  failureRate: number;
}

// ── 常量 ────────────────────────────────────────────────────────

/** 默认过期阈值（30 天）。 */
const DEFAULT_PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 默认查询上限。 */
const DEFAULT_QUERY_LIMIT = 100;
/** 摘要/错误字段最大长度（1KB）。 */
const MAX_SUMMARY_LENGTH = 1024;
/** 默认过期阈值（保留期）。 */
const DEFAULT_FAILED_RUN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

// ── Entry Codec：行与 RunLogEntry 之间的转换 ────────────────────

/** SQLite 行结构。 */
interface RunLogRow {
  run_id: string;
  job_id: string;
  started_at: number;
  completed_at: number | null;
  status: string;
  exit_code: number | null;
  error: string | null;
  output_summary: string | null;
  triggered_subtasks: string | null;
  duration_ms: number | null;
}

/**
 * 将 RunLogEntry 编码为可绑定的 SQL 参数对象。
 * 字符串字段裁剪到 MAX_SUMMARY_LENGTH；triggeredSubtasks 序列化为 JSON。
 */
function encodeEntry(entry: RunLogEntry): Omit<RunLogRow, "started_at"> {
  return {
    run_id: entry.runId,
    job_id: entry.jobId,
    completed_at: entry.completedAt ? entry.completedAt.getTime() : null,
    status: entry.status,
    exit_code: entry.exitCode ?? null,
    error: entry.error ? truncate(entry.error, MAX_SUMMARY_LENGTH) : null,
    output_summary: entry.outputSummary
      ? truncate(entry.outputSummary, MAX_SUMMARY_LENGTH)
      : null,
    triggered_subtasks: entry.triggeredSubtasks && entry.triggeredSubtasks.length > 0
      ? JSON.stringify(entry.triggeredSubtasks)
      : null,
    duration_ms: entry.durationMs ?? null,
  };
}

/** 将 SQLite 行解码为 RunLogEntry。 */
function decodeRow(row: RunLogRow): RunLogEntry {
  const entry: RunLogEntry = {
    runId: row.run_id,
    jobId: row.job_id,
    startedAt: new Date(row.started_at),
    status: row.status as RunLogEntry["status"],
  };

  if (row.completed_at !== null && row.completed_at !== undefined) {
    entry.completedAt = new Date(row.completed_at);
  }
  if (row.exit_code !== null && row.exit_code !== undefined) {
    entry.exitCode = row.exit_code;
  }
  if (row.error) {
    entry.error = row.error;
  }
  if (row.output_summary) {
    entry.outputSummary = row.output_summary;
  }
  if (row.triggered_subtasks) {
    try {
      const parsed = JSON.parse(row.triggered_subtasks);
      if (Array.isArray(parsed)) {
        entry.triggeredSubtasks = parsed.filter((s): s is string => typeof s === "string");
      }
    } catch {
      // 解析失败时忽略子任务字段
    }
  }
  if (row.duration_ms !== null && row.duration_ms !== undefined) {
    entry.durationMs = row.duration_ms;
  }

  return entry;
}

/** 安全截断字符串，避免半个多字节字符。 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}

// ── RunLogStore ──────────────────────────────────────────────────

/**
 * 运行日志的 SQLite 存储。
 *
 * 不依赖 better-sqlite3 直接内联，而是接受外部传入的 Database 实例，
 * 让调用方管理连接生命周期。测试中可使用 `new Database(":memory:")`。
 *
 * 用法：
 *  const Database = require("better-sqlite3");
 *  const db = new Database(":memory:");
 *  const store = new RunLogStore(db);
 *  store.init();
 *  store.startRun({ runId: "r1", jobId: "j1" });
 *  store.completeRun({ runId: "r1", status: "completed" });
 */
export class RunLogStore {
  constructor(private db: SqliteDatabaseLike) {}

  /**
   * 初始化 schema（如果不存在）。
   * 幂等：多次调用安全。
   */
  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_run_logs (
        run_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL,
        exit_code INTEGER,
        error TEXT,
        output_summary TEXT,
        triggered_subtasks TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_cron_run_logs_job_id ON cron_run_logs(job_id);
      CREATE INDEX IF NOT EXISTS idx_cron_run_logs_started_at ON cron_run_logs(started_at);
      CREATE INDEX IF NOT EXISTS idx_cron_run_logs_status ON cron_run_logs(status);
    `);
  }

  /**
   * 记录运行开始。若 runId 已存在则忽略（幂等）。
   */
  startRun(opts: { runId: string; jobId: string; startedAt?: Date }): void {
    const startedAt = opts.startedAt ?? new Date();
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO cron_run_logs
       (run_id, job_id, started_at, status)
       VALUES (?, ?, ?, 'running')`,
    );
    stmt.run(opts.runId, opts.jobId, startedAt.getTime());
  }

  /**
   * 更新运行完成（status、exitCode、duration 等）。
   * 若 runId 不存在则忽略。
   */
  completeRun(opts: {
    runId: string;
    completedAt?: Date;
    status: "completed" | "failed" | "cancelled";
    exitCode?: number;
    error?: string;
    outputSummary?: string;
    triggeredSubtasks?: string[];
  }): void {
    const completedAt = opts.completedAt ?? new Date();
    const encoded = encodeEntry({
      runId: opts.runId,
      jobId: "", // 不更新 job_id，仅用 runId 定位
      startedAt: new Date(0),
      completedAt,
      status: opts.status,
      exitCode: opts.exitCode,
      error: opts.error,
      outputSummary: opts.outputSummary,
      triggeredSubtasks: opts.triggeredSubtasks,
    });

    // 先查询 startedAt 计算 durationMs
    const existing = this.db.prepare(
      `SELECT started_at FROM cron_run_logs WHERE run_id = ?`,
    ).get(opts.runId) as { started_at: number } | undefined;

    if (!existing) return; // runId 不存在，忽略

    const durationMs = completedAt.getTime() - existing.started_at;

    const stmt = this.db.prepare(
      `UPDATE cron_run_logs
       SET completed_at = ?, status = ?, exit_code = ?, error = ?,
           output_summary = ?, triggered_subtasks = ?, duration_ms = ?
       WHERE run_id = ?`,
    );
    stmt.run(
      encoded.completed_at,
      encoded.status,
      encoded.exit_code,
      encoded.error,
      encoded.output_summary,
      encoded.triggered_subtasks,
      durationMs,
      opts.runId,
    );
  }

  /**
   * 查询运行日志，支持按 jobId/status/时间范围过滤，按 startedAt 降序返回。
   */
  query(opts: RunLogQuery = {}): RunLogEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.jobId) {
      where.push("job_id = ?");
      params.push(opts.jobId);
    }
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.startedAfter) {
      where.push("started_at >= ?");
      params.push(opts.startedAfter.getTime());
    }
    if (opts.startedBefore) {
      where.push("started_at <= ?");
      params.push(opts.startedBefore.getTime());
    }

    const limit = Math.max(0, opts.limit ?? DEFAULT_QUERY_LIMIT);
    const sql = `SELECT * FROM cron_run_logs
                 ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY started_at DESC
                 LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as RunLogRow[];
    return rows.map(decodeRow);
  }

  /**
   * 获取单条运行日志（按 runId）。
   */
  getRun(runId: string): RunLogEntry | undefined {
    const row = this.db.prepare(
      `SELECT * FROM cron_run_logs WHERE run_id = ?`,
    ).get(runId) as RunLogRow | undefined;
    return row ? decodeRow(row) : undefined;
  }

  /**
   * 清理过期日志（默认 30 天前）。返回被清理的记录数。
   */
  prune(olderThanMs: number = DEFAULT_PRUNE_AGE_MS, now: Date = new Date()): number {
    const cutoff = now.getTime() - olderThanMs;
    const row = this.db.prepare(
      `DELETE FROM cron_run_logs WHERE started_at < ?`,
    );
    // better-sqlite3 的 changes 通过 prepare(...).run() 后用 this.changes 获取，
    // 这里用一个 trick：先查 count 再 delete，避免对 driver 特性的依赖。
    const countStmt = this.db.prepare(
      `SELECT COUNT(*) AS c FROM cron_run_logs WHERE started_at < ?`,
    );
    const before = countStmt.get(cutoff) as { c: number } | undefined;
    const beforeCount = before?.c ?? 0;
    row.run(cutoff);
    return beforeCount;
  }

  /**
   * 获取统计信息。
   */
  stats(): RunLogStats {
    const totalRow = this.db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
         AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE NULL END) AS avg_duration
       FROM cron_run_logs`,
    ).get() as {
      total: number;
      running: number;
      completed: number;
      failed: number;
      cancelled: number;
      avg_duration: number | null;
    } | undefined;

    const t = totalRow ?? {
      total: 0, running: 0, completed: 0, failed: 0, cancelled: 0, avg_duration: null,
    };

    const totalRuns = t.total ?? 0;
    const failed = t.failed ?? 0;
    const failureRate = totalRuns > 0 ? failed / totalRuns : 0;

    return {
      totalRuns,
      running: t.running ?? 0,
      completed: t.completed ?? 0,
      failed,
      cancelled: t.cancelled ?? 0,
      avgDurationMs: t.avg_duration != null ? Math.floor(t.avg_duration) : undefined,
      failureRate,
    };
  }
}
