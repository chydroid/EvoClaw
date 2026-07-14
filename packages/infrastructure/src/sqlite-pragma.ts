/**
 * SQLite PRAGMA 配置管理。
 *
 * 灵感来自 openclaw-main 的 src/infra/sqlite-wal.ts 中的
 * configureSqliteConnectionPragmas 与 src/infra/sqlite-pragma.test-support.ts。
 *
 * EvoClaw 使用 better-sqlite3（而非 node:sqlite），因此本模块只声明所需的
 * SqliteDb 方法子集，调用方可以传入 better-sqlite3 实例或任何符合接口的对象。
 *
 * 推荐的生产环境 PRAGMA：
 * - journal_mode = WAL（Write-Ahead Logging，并发读写性能最佳）
 * - synchronous = NORMAL（WAL 模式下足够安全，性能远优于 FULL）
 * - foreign_keys = ON（强制外键约束）
 * - busy_timeout = 5000ms（并发时等待锁，而非立即抛 SQLITE_BUSY）
 * - cache_size = -20000（20MB 缓存，负值表示 KB）
 * - temp_store = MEMORY（临时表与中间结果存内存）
 * - mmap_size = 268435456（256MB 内存映射，加速大表扫描）
 * - wal_autocheckpoint = 1000（每 1000 页自动 checkpoint）
 */

/** journal_mode 的可选值。 */
export type JournalMode =
  | "DELETE"
  | "TRUNCATE"
  | "PERSIST"
  | "WAL"
  | "MEMORY"
  | "OFF";

/** synchronous 的可选值。 */
export type SynchronousMode = "OFF" | "NORMAL" | "FULL" | "EXTRA";

/** temp_store 的可选值。 */
export type TempStoreMode = "DEFAULT" | "FILE" | "MEMORY";

/** PRAGMA 配置项。任何字段缺省时不会发出对应 PRAGMA 语句。 */
export interface PragmaConfig {
  journalMode?: JournalMode;
  synchronous?: SynchronousMode;
  foreignKeys?: boolean;
  /** busy_timeout 毫秒数。 */
  busyTimeout?: number;
  /** cache_size：负数=KB，正数=页。 */
  cacheSize?: number;
  tempStore?: TempStoreMode;
  /** mmap_size 字节数。 */
  mmapSize?: number;
  /** wal_autocheckpoint 页数。 */
  walAutocheckpoint?: number;
  /** application_id（32-bit 应用标识）。 */
  applicationId?: number;
  /** user_version（用户自定义版本号）。 */
  userVersion?: number;
  /** secure_delete：覆盖删除（安全但慢）。 */
  secureDelete?: boolean;
}

/** 生产环境推荐的默认 PRAGMA。 */
export const DEFAULT_PRODUCTION_PRAGMAS: PragmaConfig = {
  journalMode: "WAL",
  synchronous: "NORMAL",
  foreignKeys: true,
  busyTimeout: 5000,
  cacheSize: -20000,
  tempStore: "MEMORY",
  mmapSize: 268_435_456,
  walAutocheckpoint: 1000,
};

/** 开发环境推荐的默认 PRAGMA。 */
export const DEFAULT_DEVELOPMENT_PRAGMAS: PragmaConfig = {
  journalMode: "WAL",
  synchronous: "NORMAL",
  foreignKeys: true,
  busyTimeout: 2000,
  cacheSize: -8000,
  tempStore: "MEMORY",
  walAutocheckpoint: 1000,
};

/** 实际应用到数据库的 PRAGMA 快照。 */
export interface AppliedPragmas {
  journalMode: string;
  synchronous: string;
  foreignKeys: number;
  busyTimeout: number;
  cacheSize: number;
  tempStore: string;
  mmapSize: number;
  walAutocheckpoint: number;
  applicationId?: number;
  userVersion?: number;
  secureDelete: boolean | number;
}

/**
 * SQLite 数据库接口（与 better-sqlite3 兼容）。
 * 仅声明本模块需要的方法。
 */
export interface SqliteDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close?(): unknown;
  pragma?(name: string): unknown[];
}

/** SQLite 预编译语句接口（better-sqlite3 的方法子集）。 */
export interface SqliteStatement {
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

/** 从 PRAGMA 查询返回的行中读取单值。 */
function readPragmaValue(db: SqliteDb, name: string): unknown {
  if (typeof db.pragma === "function") {
    const rows = db.pragma(name);
    if (Array.isArray(rows) && rows.length > 0) {
      const row = rows[0] as Record<string, unknown> | undefined;
      if (row) {
        const keys = Object.keys(row);
        if (keys.length > 0) return row[keys[0]];
      }
    }
    return undefined;
  }
  // better-sqlite3 prepare().get() 返回 { <name>: value } 或 undefined
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const keys = Object.keys(row);
  if (keys.length === 0) return undefined;
  return row[keys[0]];
}

/** 将 bigint/number 统一为 number。 */
function toNumber(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return Number(value) || 0;
}

/** 将值转为小写字符串（用于 journal_mode 等枚举）。 */
function toLowerString(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "").toLowerCase();
  return value.toLowerCase();
}

/** synchronous 数字码到字符串名的映射（部分 SQLite 版本返回数字）。 */
const SYNCHRONOUS_CODE_TO_NAME: Record<number, string> = {
  0: "off",
  1: "normal",
  2: "full",
  3: "extra",
};

/** temp_store 数字码到字符串名的映射（部分 SQLite 版本返回数字）。 */
const TEMP_STORE_CODE_TO_NAME: Record<number, string> = {
  0: "default",
  1: "file",
  2: "memory",
};

/**
 * 将 synchronous 的查询值统一为小写字符串名。
 * SQLite 各版本/编译选项可能返回字符串名（"normal"）或数字码（1）。
 */
function normalizeSynchronous(value: unknown): string {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isNaN(num) && num in SYNCHRONOUS_CODE_TO_NAME) {
    return SYNCHRONOUS_CODE_TO_NAME[num];
  }
  return toLowerString(value);
}

/**
 * 将 temp_store 的查询值统一为小写字符串名。
 * SQLite 各版本/编译选项可能返回字符串名（"memory"）或数字码（2）。
 */
function normalizeTempStore(value: unknown): string {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isNaN(num) && num in TEMP_STORE_CODE_TO_NAME) {
    return TEMP_STORE_CODE_TO_NAME[num];
  }
  return toLowerString(value);
}

/** 合法 journal_mode 值白名单 */
const VALID_JOURNAL_MODES = new Set(["DELETE", "TRUNCATE", "PERSIST", "WAL", "MEMORY", "OFF"]);
/** 合法 synchronous 值白名单 */
const VALID_SYNCHRONOUS = new Set(["OFF", "NORMAL", "FULL", "EXTRA"]);
/** 合法 temp_store 值白名单 */
const VALID_TEMP_STORE = new Set(["DEFAULT", "FILE", "MEMORY"]);

/**
 * 应用 PRAGMA 配置到数据库。
 *
 * 顺序：
 * 1. busy_timeout（先设置，避免后续 PRAGMA 遇锁立即失败）
 * 2. journal_mode（必须在 synchronous 之前）
 * 3. synchronous
 * 4. foreign_keys
 * 5. cache_size / temp_store / mmap_size / wal_autocheckpoint
 * 6. application_id / user_version / secure_delete
 *
 * 返回 AppliedPragmas 快照（通过重新查询得到实际生效值）。
 * 安全：字符串型 PRAGMA 值通过白名单校验，防止 SQL 注入。
 */
export function applyPragmas(db: SqliteDb, config: PragmaConfig): AppliedPragmas {
  if (config.busyTimeout !== undefined) {
    const ms = Math.max(0, Math.floor(config.busyTimeout));
    db.exec(`PRAGMA busy_timeout = ${ms};`);
  }
  if (config.journalMode) {
    const mode = String(config.journalMode).toUpperCase();
    if (!VALID_JOURNAL_MODES.has(mode)) {
      throw new Error(`Invalid journal_mode: ${config.journalMode}`);
    }
    db.exec(`PRAGMA journal_mode = ${mode};`);
  }
  if (config.synchronous) {
    const mode = String(config.synchronous).toUpperCase();
    if (!VALID_SYNCHRONOUS.has(mode)) {
      throw new Error(`Invalid synchronous: ${config.synchronous}`);
    }
    db.exec(`PRAGMA synchronous = ${mode};`);
  }
  if (config.foreignKeys !== undefined) {
    db.exec(`PRAGMA foreign_keys = ${config.foreignKeys ? "ON" : "OFF"};`);
  }
  if (config.cacheSize !== undefined) {
    db.exec(`PRAGMA cache_size = ${Math.floor(config.cacheSize)};`);
  }
  if (config.tempStore) {
    const mode = String(config.tempStore).toUpperCase();
    if (!VALID_TEMP_STORE.has(mode)) {
      throw new Error(`Invalid temp_store: ${config.tempStore}`);
    }
    db.exec(`PRAGMA temp_store = ${mode};`);
  }
  if (config.mmapSize !== undefined) {
    const v = Math.max(0, Math.floor(config.mmapSize));
    db.exec(`PRAGMA mmap_size = ${v};`);
  }
  if (config.walAutocheckpoint !== undefined) {
    const pages = Math.max(0, Math.floor(config.walAutocheckpoint));
    db.exec(`PRAGMA wal_autocheckpoint = ${pages};`);
  }
  if (config.applicationId !== undefined) {
    db.exec(`PRAGMA application_id = ${Math.floor(config.applicationId)};`);
  }
  if (config.userVersion !== undefined) {
    db.exec(`PRAGMA user_version = ${Math.floor(config.userVersion)};`);
  }
  if (config.secureDelete !== undefined) {
    db.exec(`PRAGMA secure_delete = ${config.secureDelete ? "ON" : "OFF"};`);
  }
  return readPragmas(db);
}

/**
 * 读取当前 PRAGMA 状态。返回实际生效值（来自数据库自身）。
 */
export function readPragmas(db: SqliteDb): AppliedPragmas {
  const journalMode = toLowerString(readPragmaValue(db, "journal_mode"));
  const synchronous = normalizeSynchronous(readPragmaValue(db, "synchronous"));
  const foreignKeys = toNumber(readPragmaValue(db, "foreign_keys"));
  const busyTimeout = toNumber(readPragmaValue(db, "busy_timeout"));
  const cacheSize = toNumber(readPragmaValue(db, "cache_size"));
  const tempStore = normalizeTempStore(readPragmaValue(db, "temp_store"));
  const mmapSize = toNumber(readPragmaValue(db, "mmap_size"));
  const walAutocheckpoint = toNumber(readPragmaValue(db, "wal_autocheckpoint"));
  const secureDeleteRaw = readPragmaValue(db, "secure_delete");
  const secureDelete =
    typeof secureDeleteRaw === "string"
      ? toLowerString(secureDeleteRaw) === "on"
      : toNumber(secureDeleteRaw);

  const result: AppliedPragmas = {
    journalMode,
    synchronous,
    foreignKeys,
    busyTimeout,
    cacheSize,
    tempStore,
    mmapSize,
    walAutocheckpoint,
    secureDelete,
  };

  // application_id / user_version 可选：仅在调用方明确查询时返回
  const applicationIdRaw = readPragmaValue(db, "application_id");
  if (applicationIdRaw !== undefined) {
    result.applicationId = toNumber(applicationIdRaw);
  }
  const userVersionRaw = readPragmaValue(db, "user_version");
  if (userVersionRaw !== undefined) {
    result.userVersion = toNumber(userVersionRaw);
  }
  return result;
}

/**
 * 验证 PRAGMA 是否生效。返回差异列表（空数组表示全部通过）。
 *
 * 注意：SQLite 的 PRAGMA 值可能在某些环境下被忽略（如内存数据库强制 WAL 失败），
 * 因此本函数仅作诊断使用，不抛异常。
 */
export function validatePragmas(
  db: SqliteDb,
  expected: PragmaConfig,
): Array<{ pragma: string; expected: unknown; actual: unknown; ok: boolean }> {
  const actual = readPragmas(db);
  const diffs: Array<{
    pragma: string;
    expected: unknown;
    actual: unknown;
    ok: boolean;
  }> = [];

  if (expected.journalMode !== undefined) {
    const exp = expected.journalMode.toLowerCase();
    const act = actual.journalMode.toLowerCase();
    diffs.push({ pragma: "journal_mode", expected: exp, actual: act, ok: exp === act });
  }
  if (expected.synchronous !== undefined) {
    const exp = expected.synchronous.toLowerCase();
    const act = actual.synchronous.toLowerCase();
    diffs.push({ pragma: "synchronous", expected: exp, actual: act, ok: exp === act });
  }
  if (expected.foreignKeys !== undefined) {
    const exp = expected.foreignKeys ? 1 : 0;
    diffs.push({
      pragma: "foreign_keys",
      expected: exp,
      actual: actual.foreignKeys,
      ok: exp === actual.foreignKeys,
    });
  }
  if (expected.busyTimeout !== undefined) {
    diffs.push({
      pragma: "busy_timeout",
      expected: expected.busyTimeout,
      actual: actual.busyTimeout,
      ok: expected.busyTimeout === actual.busyTimeout,
    });
  }
  if (expected.cacheSize !== undefined) {
    diffs.push({
      pragma: "cache_size",
      expected: expected.cacheSize,
      actual: actual.cacheSize,
      ok: expected.cacheSize === actual.cacheSize,
    });
  }
  if (expected.tempStore !== undefined) {
    const exp = expected.tempStore.toLowerCase();
    const act = actual.tempStore.toLowerCase();
    diffs.push({ pragma: "temp_store", expected: exp, actual: act, ok: exp === act });
  }
  if (expected.mmapSize !== undefined) {
    diffs.push({
      pragma: "mmap_size",
      expected: expected.mmapSize,
      actual: actual.mmapSize,
      ok: expected.mmapSize === actual.mmapSize,
    });
  }
  if (expected.walAutocheckpoint !== undefined) {
    diffs.push({
      pragma: "wal_autocheckpoint",
      expected: expected.walAutocheckpoint,
      actual: actual.walAutocheckpoint,
      ok: expected.walAutocheckpoint === actual.walAutocheckpoint,
    });
  }
  if (expected.applicationId !== undefined) {
    diffs.push({
      pragma: "application_id",
      expected: expected.applicationId,
      actual: actual.applicationId ?? 0,
      ok: expected.applicationId === (actual.applicationId ?? 0),
    });
  }
  if (expected.userVersion !== undefined) {
    diffs.push({
      pragma: "user_version",
      expected: expected.userVersion,
      actual: actual.userVersion ?? 0,
      ok: expected.userVersion === (actual.userVersion ?? 0),
    });
  }
  if (expected.secureDelete !== undefined) {
    const exp = expected.secureDelete ? 1 : 0;
    const actNum =
      typeof actual.secureDelete === "boolean"
        ? actual.secureDelete
          ? 1
          : 0
        : actual.secureDelete;
    diffs.push({
      pragma: "secure_delete",
      expected: exp,
      actual: actNum,
      ok: exp === actNum,
    });
  }
  return diffs;
}

/**
 * 选择环境默认 PRAGMA。
 *
 * - production：使用 DEFAULT_PRODUCTION_PRAGMAS
 * - development：使用 DEFAULT_DEVELOPMENT_PRAGMAS
 * - test：使用内存模式 + 同步关闭，适合 vitest 内存数据库
 */
export function getDefaultPragmas(
  environment: "production" | "development" | "test",
): PragmaConfig {
  switch (environment) {
    case "production":
      return { ...DEFAULT_PRODUCTION_PRAGMAS };
    case "development":
      return { ...DEFAULT_DEVELOPMENT_PRAGMAS };
    case "test":
      return {
        ...DEFAULT_DEVELOPMENT_PRAGMAS,
        synchronous: "OFF",
        journalMode: "MEMORY",
        busyTimeout: 100,
      };
  }
}
