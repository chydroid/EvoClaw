/**
 * SqliteCheckpointer — SQLite-backed Checkpointer for StateGraph.
 *
 * 弥补 EvoClaw 与主流 AI Agent 项目的差距：
 * - LangGraph SqliteSaver / AsyncSqliteSaver
 * - OpenAI Agents SDK session persistence
 * - AutoGen save_state / load_state
 *
 * 设计原则：
 * 1. 不直接 import better-sqlite3（避免在 agent 包引入原生依赖）
 *    —— 接受外部传入的 SqliteDatabaseLike 实例，由调用方管理连接生命周期
 * 2. 状态与 writes 序列化为 JSON 存储（SQLite 无原生对象类型）
 * 3. 按 (thread_id, checkpoint_id) 主键去重，支持幂等 put
 * 4. list 按 timestamp 倒序返回
 * 5. 同步 DB 操作包裹在 Promise 中以符合 Checkpointer 接口
 *
 * 用法：
 * ```ts
 * const Database = require("better-sqlite3");
 * const db = new Database("checkpoints.sqlite");
 * const saver = new SqliteCheckpointer<MyState>(db);
 * saver.init();
 *
 * const graph = new StateGraph<MyState>().setCheckpointer(saver).compile();
 * await graph.invoke(initialState, { threadId: "t1" });
 * const snap = await saver.get("t1"); // 恢复最新快照
 * ```
 */

import { withTransaction } from "@evoclaw/infrastructure";
import type { Checkpointer, Checkpoint, CheckpointMetadata } from "./state-graph";

// ── SQLite 接口（仅声明使用的方法子集，与 scheduler/run-log-store 保持一致） ──

interface SqliteStatement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

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

// ── Row schema ──────────────────────────────────────────────────

interface CheckpointRow {
  checkpoint_id: string;
  thread_id: string;
  state: string; // JSON
  node_id: string;
  step: number;
  timestamp: number;
  writes: string; // JSON array of { nodeId, writes }
}

// ── SqliteCheckpointer ──────────────────────────────────────────

/**
 * SQLite-backed Checkpointer 实现。
 *
 * 与 MemoryCheckpointer 相比：
 *  - 持久化到磁盘，进程重启后状态可恢复
 *  - 支持大规模历史记录查询（通过 SQL 索引）
 *  - 适合生产环境的长时间运行图
 *
 * 仍保持与 MemoryCheckpointer 相同的接口，便于无缝替换。
 */
export class SqliteCheckpointer<TState> implements Checkpointer<TState> {
  constructor(private db: SqliteDatabaseLike) {}

  /** 初始化 schema（如果不存在）。幂等。必须在首次使用前调用。 */
  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_checkpoints (
        checkpoint_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        state TEXT NOT NULL,
        node_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        writes TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (thread_id, checkpoint_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_thread_ts
        ON agent_checkpoints(thread_id, timestamp DESC);
    `);
  }

  async put(
    threadId: string,
    checkpointId: string,
    state: TState,
    metadata: CheckpointMetadata,
  ): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO agent_checkpoints
       (checkpoint_id, thread_id, state, node_id, step, timestamp, writes)
       VALUES (?, ?, ?, ?, ?, ?, '[]')`,
    );
    stmt.run(
      checkpointId,
      threadId,
      JSON.stringify(state),
      metadata.nodeId,
      metadata.step,
      metadata.timestamp,
    );
  }

  async get(threadId: string): Promise<Checkpoint<TState> | undefined> {
    const stmt = this.db.prepare(
      `SELECT * FROM agent_checkpoints
       WHERE thread_id = ?
       ORDER BY timestamp DESC
       LIMIT 1`,
    );
    const row = stmt.get(threadId) as CheckpointRow | undefined;
    if (!row) return undefined;
    return this.rowToCheckpoint(row);
  }

  async list(threadId: string): Promise<Checkpoint<TState>[]> {
    const stmt = this.db.prepare(
      `SELECT * FROM agent_checkpoints
       WHERE thread_id = ?
       ORDER BY timestamp DESC`,
    );
    const rows = stmt.all(threadId) as CheckpointRow[];
    return rows.map((r) => this.rowToCheckpoint(r));
  }

  async putWrites(
    threadId: string,
    checkpointId: string,
    nodeId: string,
    writes: Partial<TState>,
  ): Promise<void> {
    // 用 withTransaction 包裹 read-modify-write，避免竞态条件：
    // 旧实现先 SELECT 再 UPDATE，两个操作之间可能被其他写入插入/覆盖。
    withTransaction(this.db, () => {
      // 读取当前 writes 数组
      const selectStmt = this.db.prepare(
        `SELECT writes FROM agent_checkpoints
         WHERE thread_id = ? AND checkpoint_id = ?`,
      );
      const row = selectStmt.get(threadId, checkpointId) as { writes: string } | undefined;
      if (!row) return; // checkpoint 不存在，忽略

      let writesArr: Array<{ nodeId: string; writes: Partial<TState> }> = [];
      try {
        writesArr = JSON.parse(row.writes) as Array<{ nodeId: string; writes: Partial<TState> }>;
        if (!Array.isArray(writesArr)) writesArr = [];
      } catch {
        writesArr = [];
      }

      writesArr.push({ nodeId, writes });

      const updateStmt = this.db.prepare(
        `UPDATE agent_checkpoints
         SET writes = ?
         WHERE thread_id = ? AND checkpoint_id = ?`,
      );
      updateStmt.run(JSON.stringify(writesArr), threadId, checkpointId);
    });
  }

  /** 删除指定 thread 的所有 checkpoint */
  async clear(threadId: string): Promise<void> {
    const stmt = this.db.prepare(
      `DELETE FROM agent_checkpoints WHERE thread_id = ?`,
    );
    stmt.run(threadId);
  }

  /** 删除所有 thread 的 checkpoint（谨慎使用） */
  async clearAll(): Promise<void> {
    this.db.exec(`DELETE FROM agent_checkpoints`);
  }

  // ── Internal ────────────────────────────────────────────

  private rowToCheckpoint(row: CheckpointRow): Checkpoint<TState> {
    let state: TState;
    try {
      state = JSON.parse(row.state) as TState;
    } catch {
      // 损坏的 state JSON 退化为空对象，避免整个 list 调用失败
      state = {} as TState;
    }

    let writes: Array<{ nodeId: string; writes: Partial<TState> }> = [];
    try {
      const parsed = JSON.parse(row.writes);
      if (Array.isArray(parsed)) writes = parsed;
    } catch {
      writes = [];
    }

    return {
      id: row.checkpoint_id,
      threadId: row.thread_id,
      state,
      metadata: {
        nodeId: row.node_id,
        step: row.step,
        timestamp: row.timestamp,
      },
      writes,
    };
  }
}
