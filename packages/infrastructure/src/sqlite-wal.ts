/**
 * SQLite WAL checkpoint 管理。
 *
 * 灵感来自 openclaw-main 的 src/infra/sqlite-wal.ts。
 *
 * EvoClaw 简化了 openclaw-main 的网络存储检测逻辑（openclaw-main 检测 NFS/SMB
 * 后强制回退到 DELETE 模式，EvoClaw 由调用方决定是否使用 WAL，本模块只关注
 * checkpoint 与 WAL 文件大小监控）。
 *
 * 提供：
 * 1. checkpointWal：手动 checkpoint（PASSIVE / FULL / RESTART / TRUNCATE）
 * 2. getWalStatus：查询 WAL 文件大小与状态
 * 3. WalAutoCheckpoint：自动 checkpoint 调度器（基于大小阈值）
 * 4. setWalAutocheckpoint：配置 SQLite 内置自动 checkpoint 阈值
 * 5. walPoll：强制 WAL 切换
 */

import type { SqliteDb } from "./sqlite-pragma";
import * as fs from "fs";
import * as path from "path";

/** wal_checkpoint 模式。 */
export type CheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";

/** checkpoint 执行结果。 */
export interface WalCheckpointResult {
  mode: CheckpointMode;
  /** 0=成功，1=busy（其他连接正在写入）。 */
  busy: number;
  /** checkpoint 前的 WAL 帧数。 */
  logFrames: number;
  /** checkpoint 的帧数。 */
  checkpointedFrames: number;
  /** checkpoint 前的 WAL 文件大小（字节，若 dbPath 已提供）。 */
  walSizeBytes?: number;
  /** checkpoint 耗时（毫秒）。 */
  durationMs: number;
}

/** WAL 文件状态。 */
export interface WalStatus {
  /** dbPath + "-wal" 的路径。 */
  walPath: string;
  /** WAL 文件是否存在。 */
  walExists: boolean;
  /** WAL 文件大小（字节）。 */
  walSizeBytes: number;
  /** dbPath + "-shm" 的路径。 */
  shmPath: string;
  /** SHM 文件是否存在。 */
  shmExists: boolean;
  /** SHM 文件大小（字节）。 */
  shmSizeBytes: number;
  /** 当前 journal_mode（应为 "wal"）。 */
  journalMode: string;
  /** wal_autocheckpoint 页数阈值。 */
  autocheckpoint: number;
}

/** 从 PRAGMA wal_checkpoint 返回的行中提取 busy/log/checkpointed。 */
function parseWalCheckpointRow(
  row: unknown,
): { busy: number; log: number; checkpointed: number } {
  if (!row || typeof row !== "object") {
    return { busy: 0, log: 0, checkpointed: 0 };
  }
  const record = row as Record<string, unknown>;
  const busyRaw = record.busy ?? record[Object.keys(record)[0]];
  const logRaw = record.log ?? record[Object.keys(record)[1]];
  const checkpointedRaw =
    record.checkpointed ?? record[Object.keys(record)[2]];
  const toNum = (v: unknown): number =>
    typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v) || 0;
  return {
    busy: toNum(busyRaw),
    log: toNum(logRaw),
    checkpointed: toNum(checkpointedRaw),
  };
}

/** 安全读取文件大小（不存在或不可访问时返回 0）。 */
function safeFileSize(filePath: string): number {
  try {
    const st = fs.statSync(filePath);
    return st.size;
  } catch {
    return 0;
  }
}

/**
 * 执行 WAL checkpoint。
 *
 * @param db SQLite 数据库实例
 * @param mode checkpoint 模式，默认 PASSIVE
 * @param dbPath 数据库路径（用于查询 WAL 文件大小，若不提供则跳过大小查询）
 */
export function checkpointWal(
  db: SqliteDb,
  mode: CheckpointMode = "PASSIVE",
  dbPath?: string,
): WalCheckpointResult {
  const start = Date.now();
  // 在 checkpoint 前查询 WAL 文件大小（checkpoint 后会被清空/截断）
  let walSizeBytes: number | undefined;
  if (dbPath) {
    walSizeBytes = safeFileSize(`${dbPath}-wal`);
  }

  let busy = 0;
  let logFrames = 0;
  let checkpointedFrames = 0;
  try {
    const row = db.prepare(`PRAGMA wal_checkpoint(${mode});`).get();
    const parsed = parseWalCheckpointRow(row);
    busy = parsed.busy;
    logFrames = parsed.log;
    checkpointedFrames = parsed.checkpointed;
  } catch (err) {
    // WAL 可能未启用（journal_mode != WAL），此时帧数全为 0
    if (
      err instanceof Error &&
      /wal|journal/i.test(err.message)
    ) {
      // 静默忽略：调用方应通过 getWalStatus 判断 WAL 是否启用
    } else {
      throw err;
    }
  }

  return {
    mode,
    busy,
    logFrames,
    checkpointedFrames,
    walSizeBytes,
    durationMs: Date.now() - start,
  };
}

/**
 * 查询 WAL 状态。
 */
export function getWalStatus(db: SqliteDb, dbPath: string): WalStatus {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const walExists = fs.existsSync(walPath);
  const shmExists = fs.existsSync(shmPath);

  // journal_mode
  let journalMode = "delete";
  try {
    const row = db.prepare("PRAGMA journal_mode;").get() as
      | Record<string, unknown>
      | undefined;
    if (row) {
      const keys = Object.keys(row);
      if (keys.length > 0) {
        const v = row[keys[0]];
        journalMode = typeof v === "string" ? v.toLowerCase() : String(v ?? "").toLowerCase();
      }
    }
  } catch {
    // ignore
  }

  // wal_autocheckpoint
  let autocheckpoint = 1000;
  try {
    const row = db.prepare("PRAGMA wal_autocheckpoint;").get() as
      | Record<string, unknown>
      | undefined;
    if (row) {
      const keys = Object.keys(row);
      if (keys.length > 0) {
        const v = row[keys[0]];
        autocheckpoint =
          typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v) || 1000;
      }
    }
  } catch {
    // ignore
  }

  return {
    walPath,
    walExists,
    walSizeBytes: walExists ? safeFileSize(walPath) : 0,
    shmPath,
    shmExists,
    shmSizeBytes: shmExists ? safeFileSize(shmPath) : 0,
    journalMode,
    autocheckpoint,
  };
}

/**
 * WAL 自动 checkpoint 调度器。
 *
 * 定期检查 WAL 文件大小，超过阈值时触发 checkpoint（默认 TRUNCATE 模式）。
 * 不依赖 SQLite 内置的 wal_autocheckpoint（那个基于页数，本调度器基于字节数）。
 */
export class WalAutoCheckpoint {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly checkIntervalMs: number;
  private readonly maxWalSizeBytes: number;
  private readonly db: SqliteDb;
  private readonly dbPath?: string;
  private readonly onCheckpoint?: (result: WalCheckpointResult) => void;
  private readonly onError?: (err: Error) => void;
  private lastCheckAt: Date | null = null;
  private totalCheckpointsTriggered = 0;

  constructor(opts: {
    db: SqliteDb;
    dbPath?: string;
    /** 检查间隔（毫秒），默认 60_000。 */
    checkIntervalMs?: number;
    /** 触发 checkpoint 的 WAL 大小阈值（字节），默认 10MB。 */
    maxWalSizeBytes?: number;
    onCheckpoint?: (result: WalCheckpointResult) => void;
    onError?: (err: Error) => void;
  }) {
    this.db = opts.db;
    this.dbPath = opts.dbPath;
    this.checkIntervalMs = Math.max(0, Math.floor(opts.checkIntervalMs ?? 60_000));
    this.maxWalSizeBytes = Math.max(0, Math.floor(opts.maxWalSizeBytes ?? 10 * 1024 * 1024));
    this.onCheckpoint = opts.onCheckpoint;
    this.onError = opts.onError;
  }

  /** 启动 interval。若已启动则先停止旧的。 */
  start(): void {
    this.stop();
    if (this.checkIntervalMs <= 0) return;
    this.timer = setInterval(() => {
      try {
        this.checkNow();
      } catch (err) {
        if (this.onError) {
          this.onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }, this.checkIntervalMs);
    // unref 避免阻止 Node 退出
    const handle = this.timer as ReturnType<typeof setInterval> & {
      unref?: () => void;
    };
    handle.unref?.();
  }

  /** 停止 interval。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 手动触发一次检查。
   *
   * @returns 若触发了 checkpoint 则返回结果，否则返回 null
   */
  checkNow(): WalCheckpointResult | null {
    this.lastCheckAt = new Date();
    if (!this.dbPath) return null;

    let walSize = 0;
    try {
      walSize = safeFileSize(`${this.dbPath}-wal`);
    } catch {
      // ignore
    }
    if (walSize < this.maxWalSizeBytes) return null;

    const result = checkpointWal(this.db, "TRUNCATE", this.dbPath);
    this.totalCheckpointsTriggered += 1;
    if (this.onCheckpoint) this.onCheckpoint(result);
    return result;
  }

  /** 返回调度器统计。 */
  getStats(): {
    totalCheckpointsTriggered: number;
    lastCheckAt: Date | null;
    running: boolean;
  } {
    return {
      totalCheckpointsTriggered: this.totalCheckpointsTriggered,
      lastCheckAt: this.lastCheckAt,
      running: this.timer !== null,
    };
  }
}

/**
 * 配置 WAL 自动 checkpoint 阈值（页数）。
 *
 * 这是 SQLite 内置的 wal_autocheckpoint PRAGMA，与 WalAutoCheckpoint 调度器
 * （基于字节数）互补。
 */
export function setWalAutocheckpoint(db: SqliteDb, pages: number): void {
  const p = Math.max(0, Math.floor(pages));
  db.exec(`PRAGMA wal_autocheckpoint = ${p};`);
}

/**
 * 强制 WAL 切换（启动新 WAL 文件）。
 *
 * 通过 PRAGMA wal_checkpoint(TRUNCATE) 实现：truncate 模式会等待所有读者完成、
 * 将 WAL 截断为 0 字节，下一次写入将启动新 WAL 文件。
 *
 * 若数据库不在 WAL 模式，本调用是 no-op。
 */
export function walPoll(db: SqliteDb): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // WAL 未启用或不可访问时静默忽略
  }
}
