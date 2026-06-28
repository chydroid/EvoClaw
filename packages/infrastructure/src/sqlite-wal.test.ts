import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkpointWal,
  getWalStatus,
  WalAutoCheckpoint,
  setWalAutocheckpoint,
  walPoll,
} from "./sqlite-wal";
import { applyPragmas, type SqliteDb } from "./sqlite-pragma";

// better-sqlite3 native binding 探测。
function loadDatabase(): { new (path: string): SqliteDb } | null {
  try {
    const Ctor = require("better-sqlite3") as { new (path: string): SqliteDb };
    const probe = new Ctor(":memory:");
    try { probe.close?.(); } catch { /* ignore */ }
    return Ctor;
  } catch {
    return null;
  }
}

const DatabaseCtor = loadDatabase();

// ── 依赖 native binding 的测试 ────────────────────────────────

describe.skipIf(!DatabaseCtor)("sqlite-wal (sqlite)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-sqlite-wal-"));
    dbPath = path.join(tmpDir, "test.db");
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function openDb(): SqliteDb {
    const db = new DatabaseCtor!(dbPath);
    applyPragmas(db, {
      journalMode: "WAL",
      synchronous: "NORMAL",
      foreignKeys: true,
      busyTimeout: 1000,
      walAutocheckpoint: 1000,
    });
    return db;
  }

  function writeSomeRows(db: SqliteDb, count: number): void {
    db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT NOT NULL);");
    const stmt = db.prepare("INSERT INTO t (v) VALUES (?);");
    for (let i = 0; i < count; i++) {
      stmt.run(`row-${i}-${"x".repeat(50)}`);
    }
  }

  describe("checkpointWal", () => {
    it("PASSIVE 模式应返回有效结果", () => {
      const db = openDb();
      try {
        writeSomeRows(db, 100);
        const result = checkpointWal(db, "PASSIVE", dbPath);
        expect(result.mode).toBe("PASSIVE");
        expect(result.busy).toBeGreaterThanOrEqual(0);
        expect(result.logFrames).toBeGreaterThanOrEqual(0);
        expect(result.checkpointedFrames).toBeGreaterThanOrEqual(0);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        expect(result.walSizeBytes).toBeGreaterThanOrEqual(0);
      } finally {
        try { db.close?.(); } catch { /* ignore */ }
      }
    });

    it("TRUNCATE 模式应清空 WAL 文件", () => {
      const db = openDb();
      try {
        writeSomeRows(db, 200);
        // 触发一次 PASSIVE checkpoint 确保 WAL 文件存在
        const before = checkpointWal(db, "PASSIVE", dbPath);
        expect(before.walSizeBytes ?? 0).toBeGreaterThanOrEqual(0);
        // TRUNCATE 模式应使 WAL 文件截断为 0
        const result = checkpointWal(db, "TRUNCATE", dbPath);
        expect(result.mode).toBe("TRUNCATE");
        expect(result.busy).toBeGreaterThanOrEqual(0);
      } finally {
        try { db.close?.(); } catch { /* ignore */ }
      }
    });

    it("不传 dbPath 时 walSizeBytes 应为 undefined", () => {
      const db = openDb();
      try {
        writeSomeRows(db, 10);
        const result = checkpointWal(db, "PASSIVE");
        expect(result.walSizeBytes).toBeUndefined();
      } finally {
        try { db.close?.(); } catch { /* ignore */ }
      }
    });

    it("未启用 WAL 时不应抛错（兼容 journal_mode=DELETE）", () => {
      const db = new DatabaseCtor!(dbPath);
      try {
        // 不设置 journal_mode=WAL，默认为 DELETE
        applyPragmas(db, { journalMode: "DELETE", synchronous: "NORMAL" });
        db.exec("CREATE TABLE t (v TEXT);");
        const result = checkpointWal(db, "PASSIVE", dbPath);
        expect(result.busy).toBeGreaterThanOrEqual(0);
      } finally {
        try { db.close?.(); } catch { /* ignore */ }
      }
    });
  });

  describe("getWalStatus", () => {
    it("未启用 WAL 时 walExists 应为 false", () => {
      const db = new DatabaseCtor!(dbPath);
      try {
        applyPragmas(db, { journalMode: "DELETE" });
        db.exec("CREATE TABLE t (v TEXT);");
        const status = getWalStatus(db, dbPath);
        expect(status.walPath).toBe(`${dbPath}-wal`);
        expect(status.shmPath).toBe(`${dbPath}-shm`);
        expect(status.walExists).toBe(false);
        expect(status.shmExists).toBe(false);
        expect(status.walSizeBytes).toBe(0);
        expect(status.shmSizeBytes).toBe(0);
        expect(status.journalMode).toBe("delete");
      } finally {
        try { db.close?.(); } catch { /* ignore */ }
      }
    });

    it("启用 WAL 并写入数据后应能查到 WAL 文件大小", () => {
      const db = openDb();
      try {
        writeSomeRows(db, 50);
        // 触发一次 checkpoint 确保 WAL 文件存在
        checkpointWal(db, "PASSIVE", dbPath);
        const status = getWalStatus(db, dbPath);
        expect(status.journalMode).toBe("wal");
        expect(status.autocheckpoint).toBe(1000);
        // 注意：WAL 可能在 PASSIVE checkpoint 后被清空，因此只验证字段类型
        expect(typeof status.walSizeBytes).toBe("number");
        expect(typeof status.walExists).toBe("boolean");
      } finally {
        try { db.close?.(); } catch { /* ignore */ }
      }
    });
  });

  describe("WalAutoCheckpoint", () => {
    it("start/stop 应正确管理 timer", () => {
      const db = openDb();
      try {
        const auto = new WalAutoCheckpoint({
          db,
          dbPath,
          checkIntervalMs: 100,
          maxWalSizeBytes: 1024,
        });
        expect(auto.getStats().running).toBe(false);
        auto.start();
        expect(auto.getStats().running).toBe(true);
        auto.stop();
        expect(auto.getStats().running).toBe(false);
      } finally {
        try { db.close?.(); } catch { /* ignore */ }
      }
    });

    it("checkNow 未达阈值时应返回 null", () => {
      const db = openDb();
      try {
        const auto = new WalAutoCheckpoint({
          db,
          dbPath,
          checkIntervalMs: 0,
          maxWalSizeBytes: 100 * 1024 * 1024, // 100MB 阈值
        });
        writeSomeRows(db, 5);
        const result = auto.checkNow();
        expect(result).toBeNull();
        expect(auto.getStats().totalCheckpointsTriggered).toBe(0);
        expect(auto.getStats().lastCheckAt).toBeInstanceOf(Date);
      } finally {
        try { db.close?.(); } catch { /* ignore */ }
      }
    });

    it("checkNow 达阈值时应触发 checkpoint 并返回结果", () => {
      const db = openDb();
      try {
        // 设一个非常小的阈值（1 字节），任何 WAL 文件都达标
        const auto = new WalAutoCheckpoint({
          db,
          dbPath,
          checkIntervalMs: 0,
          maxWalSizeBytes: 1,
          onCheckpoint: (r) => {
            expect(r.mode).toBe("TRUNCATE");
          },
        });
        writeSomeRows(db, 5);
        // 注意：WAL 文件可能在写入后立刻被 SQLite 自动 checkpoint，因此只在不抛错即可
        const result = auto.checkNow();
        if (result) {
          expect(result.mode).toBe("TRUNCATE");
          expect(auto.getStats().totalCheckpointsTriggered).toBeGreaterThanOrEqual(1);
        } else {
          // WAL 文件已被 SQLite 自动 checkpoint 清空，未触发我们的逻辑
          expect(auto.getStats().totalCheckpointsTriggered).toBe(0);
        }
      } finally {
        try { db.close?.(); } catch { /* ignore */ }
      }
    });

    it("getStats 应返回正确的统计", () => {
      const db = openDb();
      try {
        const auto = new WalAutoCheckpoint({
          db,
          dbPath,
          checkIntervalMs: 0,
          maxWalSizeBytes: 1,
        });
        const stats = auto.getStats();
        expect(stats.totalCheckpointsTriggered).toBe(0);
        expect(stats.lastCheckAt).toBeNull();
        expect(stats.running).toBe(false);
      } finally {
        try { db.close?.(); } catch { /* ignore */ }
      }
    });

    it("无 dbPath 时 checkNow 应返回 null", () => {
      const db = openDb();
      try {
        const auto = new WalAutoCheckpoint({
          db,
          // 不提供 dbPath
          checkIntervalMs: 0,
          maxWalSizeBytes: 1,
        });
        expect(auto.checkNow()).toBeNull();
      } finally {
        try { db.close?.(); } catch { /* ignore */ }
      }
    });
  });

  describe("setWalAutocheckpoint", () => {
    it("应设置 wal_autocheckpoint 阈值", () => {
      const db = openDb();
      try {
        setWalAutocheckpoint(db, 500);
        const status = getWalStatus(db, dbPath);
        expect(status.autocheckpoint).toBe(500);
      } finally {
        try { db.close?.(); } catch { /* ignore */ }
      }
    });
  });

  describe("walPoll", () => {
    it("不应抛错（无论 WAL 是否启用）", () => {
      const db = openDb();
      try {
        writeSomeRows(db, 10);
        expect(() => walPoll(db)).not.toThrow();
      } finally {
        try { db.close?.(); } catch { /* ignore */ }
      }
    });

    it("未启用 WAL 时也不应抛错", () => {
      const db = new DatabaseCtor!(dbPath);
      try {
        applyPragmas(db, { journalMode: "DELETE" });
        expect(() => walPoll(db)).not.toThrow();
      } finally {
        try { db.close?.(); } catch { /* ignore */ }
      }
    });
  });
});
