/**
 * SQLite 事务包装。
 *
 * 灵感来自 openclaw-main 的 src/infra/sqlite-transaction.ts。
 *
 * EvoClaw 使用 better-sqlite3（同步 API），因此本模块完全是同步的，
 * 不接受 Promise 返回值（与 openclaw-main 的同步实现一致）。
 *
 * 提供：
 * 1. withTransaction(fn)：在事务中执行 fn，自动 commit/rollback
 * 2. withSavepoint(fn)：在 savepoint 中执行 fn
 * 3. 嵌套事务支持（外层 BEGIN，内层 SAVEPOINT）
 * 4. batchExec：批量 SQL 语句
 * 5. TransactionStats：诊断统计
 */

import type { SqliteDb } from "./sqlite-pragma";

/** 事务模式（BEGIN 的变体）。 */
export type TransactionMode = "deferred" | "immediate" | "exclusive";

/** 事务相关错误（包装底层 SQL 错误，附带阶段信息）。 */
export class TransactionError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown,
    public readonly phase:
      | "begin"
      | "commit"
      | "rollback"
      | "savepoint"
      | "release"
      | "rollback-to",
  ) {
    super(message);
    this.name = "TransactionError";
  }
}

/** 事务执行统计（用于诊断）。 */
export interface TransactionStats {
  totalTransactions: number;
  committed: number;
  rolledBack: number;
  nestedSavepoints: number;
  lastError?: { message: string; phase: string; at: Date };
}

/** 每个数据库实例对应的事务嵌套深度。 */
const transactionDepth = new WeakMap<SqliteDb, number>();

/** 每个数据库实例对应的统计快照。 */
const transactionStats = new WeakMap<SqliteDb, TransactionStats>();

/** 全局 savepoint 计数器，保证名称唯一。 */
let nextSavepointId = 0;

/** 生成下一个 savepoint 名称。 */
function nextSavepointName(prefix: string): string {
  nextSavepointId += 1;
  return `${prefix}_${nextSavepointId}`;
}

/** 读取当前嵌套深度（0 表示不在事务中）。 */
function getDepth(db: SqliteDb): number {
  return transactionDepth.get(db) ?? 0;
}

/** 设置嵌套深度（≤0 时移除条目，允许 GC 回收）。 */
function setDepth(db: SqliteDb, depth: number): void {
  if (depth <= 0) {
    transactionDepth.delete(db);
    return;
  }
  transactionDepth.set(db, depth);
}

/** 读取或初始化统计快照。 */
function getStats(db: SqliteDb): TransactionStats {
  let s = transactionStats.get(db);
  if (!s) {
    s = {
      totalTransactions: 0,
      committed: 0,
      rolledBack: 0,
      nestedSavepoints: 0,
    };
    transactionStats.set(db, s);
  }
  return s;
}

/** 记录失败到统计快照。 */
function recordFailure(
  db: SqliteDb,
  err: unknown,
  phase: "begin" | "commit" | "rollback" | "savepoint" | "release" | "rollback-to",
): void {
  const s = getStats(db);
  s.rolledBack += 1;
  s.lastError = {
    message: err instanceof Error ? err.message : String(err),
    phase,
    at: new Date(),
  };
}

/**
 * 在事务中执行函数。
 *
 * - fn 正常返回 → COMMIT，返回 fn 的结果
 * - fn 抛错 → ROLLBACK，重新抛出原错误（不包装，便于上层 catch）
 * - 嵌套调用 → 自动用 savepoint 实现（外层 BEGIN，内层 SAVEPOINT）
 * - fn 返回 Promise → 抛错（同步事务不支持 Promise）
 *
 * @param db SQLite 数据库实例
 * @param fn 要在事务中执行的函数
 * @param opts.mode 事务模式，默认 "immediate"
 */
export function withTransaction<T>(
  db: SqliteDb,
  fn: () => T,
  opts?: { mode?: TransactionMode },
): T {
  const mode: TransactionMode = opts?.mode ?? "immediate";
  const depth = getDepth(db);

  // 嵌套：用 savepoint 实现
  if (depth > 0) {
    const spName = nextSavepointName("evoclaw_sp");
    try {
      db.exec(`SAVEPOINT ${spName};`);
    } catch (err) {
      throw new TransactionError(
        `SAVEPOINT ${spName} failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
        "savepoint",
      );
    }
    setDepth(db, depth + 1);
    const s = getStats(db);
    s.nestedSavepoints += 1;
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error(
          "SQLite transactions must be synchronous; Promise returns are not supported.",
        );
      }
      try {
        db.exec(`RELEASE SAVEPOINT ${spName};`);
      } catch (err) {
        throw new TransactionError(
          `RELEASE SAVEPOINT ${spName} failed: ${err instanceof Error ? err.message : String(err)}`,
          err,
          "release",
        );
      }
      return result;
    } catch (err) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${spName};`);
      } catch (rbErr) {
        // 保留原错误，仅记录 rollback 失败
        recordFailure(
          db,
          new TransactionError(
            `ROLLBACK TO SAVEPOINT ${spName} failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`,
            rbErr,
            "rollback-to",
          ),
          "rollback-to",
        );
      } finally {
        try {
          db.exec(`RELEASE SAVEPOINT ${spName};`);
        } catch {
          // 释放失败已尽力，忽略
        }
      }
      recordFailure(db, err, "rollback-to");
      throw err;
    } finally {
      setDepth(db, depth);
    }
  }

  // 外层：BEGIN ... COMMIT/ROLLBACK
  const s = getStats(db);
  s.totalTransactions += 1;
  try {
    db.exec(`BEGIN ${mode.toUpperCase()};`);
  } catch (err) {
    throw new TransactionError(
      `BEGIN ${mode} failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
      "begin",
    );
  }
  setDepth(db, 1);

  let transactionStillActive = true;
  let result: T;
  try {
    result = fn();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new Error(
        "SQLite transactions must be synchronous; Promise returns are not supported.",
      );
    }
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
      transactionStillActive = false;
    } catch (rbErr) {
      // 保留原错误，仅记录 rollback 失败
      recordFailure(
        db,
        new TransactionError(
          `ROLLBACK failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`,
          rbErr,
          "rollback",
        ),
        "rollback",
      );
    }
    recordFailure(db, err, "rollback");
    throw err;
  } finally {
    if (!transactionStillActive) {
      setDepth(db, 0);
    }
  }

  try {
    db.exec("COMMIT;");
    transactionStillActive = false;
    s.committed += 1;
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
      transactionStillActive = false;
    } catch (rbErr) {
      recordFailure(
        db,
        new TransactionError(
          `ROLLBACK (after commit failure) failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`,
          rbErr,
          "rollback",
        ),
        "rollback",
      );
    }
    recordFailure(db, err, "commit");
    throw new TransactionError(
      `COMMIT failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
      "commit",
    );
  } finally {
    if (!transactionStillActive) {
      setDepth(db, 0);
    }
  }
}

/**
 * 在 savepoint 中执行函数（与 withTransaction 嵌套时行为相同）。
 *
 * 与 withTransaction 的区别：本函数总是用 SAVEPOINT，即使外层不在事务中。
 * 若调用时未在外层事务中，则先 BEGIN 一个外层事务再 SAVEPOINT。
 *
 * @param db SQLite 数据库实例
 * @param fn 要在 savepoint 中执行的函数
 * @param name savepoint 名称（可选，默认自动生成）
 */
export function withSavepoint<T>(
  db: SqliteDb,
  fn: () => T,
  name?: string,
): T {
  const depth = getDepth(db);
  const spName = name ?? nextSavepointName("evoclaw_sp");
  // 校验 savepoint 名称，防止 SQL 注入（名称直接拼入 SAVEPOINT 语句）
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(spName)) {
    throw new Error(`Invalid savepoint name: ${spName}`);
  }

  // 若不在事务中，先开一个外层事务
  if (depth === 0) {
    return withTransaction(db, () => {
      // 进入 withTransaction 后 depth = 1，再嵌套 savepoint
      return withSavepointInner(db, fn, spName);
    });
  }
  return withSavepointInner(db, fn, spName);
}

/** 内部 savepoint 实现（假设已在外层事务中）。 */
function withSavepointInner<T>(
  db: SqliteDb,
  fn: () => T,
  spName: string,
): T {
  const depth = getDepth(db);
  try {
    db.exec(`SAVEPOINT ${spName};`);
  } catch (err) {
    throw new TransactionError(
      `SAVEPOINT ${spName} failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
      "savepoint",
    );
  }
  setDepth(db, depth + 1);
  const s = getStats(db);
  s.nestedSavepoints += 1;
  try {
    const result = fn();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new Error(
        "SQLite savepoints must be synchronous; Promise returns are not supported.",
      );
    }
    try {
      db.exec(`RELEASE SAVEPOINT ${spName};`);
    } catch (err) {
      throw new TransactionError(
        `RELEASE SAVEPOINT ${spName} failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
        "release",
      );
    }
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${spName};`);
    } catch (rbErr) {
      recordFailure(
        db,
        new TransactionError(
          `ROLLBACK TO SAVEPOINT ${spName} failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`,
          rbErr,
          "rollback-to",
        ),
        "rollback-to",
      );
    } finally {
      try {
        db.exec(`RELEASE SAVEPOINT ${spName};`);
      } catch {
        // 释放失败已尽力，忽略
      }
    }
    recordFailure(db, err, "rollback-to");
    throw err;
  } finally {
    setDepth(db, depth);
  }
}

/**
 * 检测数据库是否在事务中（基于模块内 WeakMap 跟踪）。
 *
 * 注意：此函数仅检测由 withTransaction/withSavepoint 启动的事务，
 * 不能感知外部代码直接执行 BEGIN 启动的事务。
 */
export function isInTransaction(db: SqliteDb): boolean {
  return getDepth(db) > 0;
}

/**
 * 批量执行 SQL 语句（在单个事务中）。
 *
 * - 空数组：直接返回，不开事务
 * - 任一语句失败：整个事务回滚
 */
export function batchExec(db: SqliteDb, statements: string[]): void {
  if (statements.length === 0) return;
  withTransaction(db, () => {
    for (const sql of statements) {
      db.exec(sql);
    }
  });
}

/**
 * 返回该 db 的事务统计快照（深拷贝，调用方修改不会影响内部状态）。
 */
export function getTransactionStats(db: SqliteDb): TransactionStats {
  const s = getStats(db);
  return {
    totalTransactions: s.totalTransactions,
    committed: s.committed,
    rolledBack: s.rolledBack,
    nestedSavepoints: s.nestedSavepoints,
    lastError: s.lastError
      ? {
          message: s.lastError.message,
          phase: s.lastError.phase,
          at: new Date(s.lastError.at),
        }
      : undefined,
  };
}

/**
 * 重置该 db 的事务统计。
 */
export function resetTransactionStats(db: SqliteDb): void {
  transactionStats.set(db, {
    totalTransactions: 0,
    committed: 0,
    rolledBack: 0,
    nestedSavepoints: 0,
  });
}
