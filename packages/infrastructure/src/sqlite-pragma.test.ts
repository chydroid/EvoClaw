import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  applyPragmas,
  readPragmas,
  validatePragmas,
  getDefaultPragmas,
  DEFAULT_PRODUCTION_PRAGMAS,
  DEFAULT_DEVELOPMENT_PRAGMAS,
  type SqliteDb,
  type PragmaConfig,
} from "./sqlite-pragma";

// better-sqlite3 是项目根级依赖；infrastructure package.json 中已声明。
// 部分环境下 native binding 可能未编译，此时优雅跳过依赖它的测试。
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

// ── 不依赖 native binding 的纯函数测试 ─────────────────────────

describe("getDefaultPragmas", () => {
  it("production 环境应返回 WAL + NORMAL + 5000ms busy_timeout", () => {
    const cfg = getDefaultPragmas("production");
    expect(cfg.journalMode).toBe("WAL");
    expect(cfg.synchronous).toBe("NORMAL");
    expect(cfg.foreignKeys).toBe(true);
    expect(cfg.busyTimeout).toBe(5000);
  });

  it("development 环境应使用更小的 cache 和 busy_timeout", () => {
    const cfg = getDefaultPragmas("development");
    expect(cfg.journalMode).toBe("WAL");
    expect(cfg.busyTimeout).toBe(2000);
    expect(cfg.cacheSize).toBe(-8000);
  });

  it("test 环境应使用 MEMORY + OFF + 100ms busy_timeout", () => {
    const cfg = getDefaultPragmas("test");
    expect(cfg.journalMode).toBe("MEMORY");
    expect(cfg.synchronous).toBe("OFF");
    expect(cfg.busyTimeout).toBe(100);
  });

  it("每次返回新对象，互不影响", () => {
    const a = getDefaultPragmas("production");
    const b = getDefaultPragmas("production");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    a.busyTimeout = 9999;
    expect(b.busyTimeout).toBe(5000);
  });
});

describe("DEFAULT_PRODUCTION_PRAGMAS / DEFAULT_DEVELOPMENT_PRAGMAS", () => {
  it("production 默认值符合规范", () => {
    expect(DEFAULT_PRODUCTION_PRAGMAS.journalMode).toBe("WAL");
    expect(DEFAULT_PRODUCTION_PRAGMAS.synchronous).toBe("NORMAL");
    expect(DEFAULT_PRODUCTION_PRAGMAS.foreignKeys).toBe(true);
    expect(DEFAULT_PRODUCTION_PRAGMAS.busyTimeout).toBe(5000);
    expect(DEFAULT_PRODUCTION_PRAGMAS.cacheSize).toBe(-20000);
    expect(DEFAULT_PRODUCTION_PRAGMAS.tempStore).toBe("MEMORY");
    expect(DEFAULT_PRODUCTION_PRAGMAS.mmapSize).toBe(268_435_456);
    expect(DEFAULT_PRODUCTION_PRAGMAS.walAutocheckpoint).toBe(1000);
  });

  it("development 默认值符合规范", () => {
    expect(DEFAULT_DEVELOPMENT_PRAGMAS.journalMode).toBe("WAL");
    expect(DEFAULT_DEVELOPMENT_PRAGMAS.busyTimeout).toBe(2000);
    expect(DEFAULT_DEVELOPMENT_PRAGMAS.cacheSize).toBe(-8000);
    expect(DEFAULT_DEVELOPMENT_PRAGMAS.walAutocheckpoint).toBe(1000);
  });
});

// ── 依赖 native binding 的测试 ────────────────────────────────

describe.skipIf(!DatabaseCtor)("applyPragmas / readPragmas / validatePragmas (sqlite)", () => {
  let db: SqliteDb;

  beforeEach(() => {
    db = new DatabaseCtor!(":memory:");
  });

  afterEach(() => {
    try { db.close?.(); } catch { /* ignore */ }
  });

  it("applyPragmas 应设置 journal_mode = WAL（:memory: 实际为 memory，但不会抛错）", () => {
    applyPragmas(db, { journalMode: "WAL" });
    const read = readPragmas(db);
    // 内存数据库可能强制 journal_mode=memory，因此只验证不抛错
    expect(["wal", "memory"]).toContain(read.journalMode);
  });

  it("applyPragmas 应启用 foreign_keys", () => {
    applyPragmas(db, { foreignKeys: true });
    const read = readPragmas(db);
    expect(read.foreignKeys).toBe(1);
  });

  it("applyPragmas 应设置 busy_timeout", () => {
    applyPragmas(db, { busyTimeout: 3000 });
    const read = readPragmas(db);
    expect(read.busyTimeout).toBe(3000);
  });

  it("applyPragmas 应设置 cache_size 为负值（KB）", () => {
    applyPragmas(db, { cacheSize: -15000 });
    const read = readPragmas(db);
    expect(read.cacheSize).toBe(-15000);
  });

  it("applyPragmas 应设置 synchronous = NORMAL", () => {
    applyPragmas(db, { synchronous: "NORMAL" });
    const read = readPragmas(db);
    expect(read.synchronous).toBe("normal");
  });

  it("applyPragmas 应设置 synchronous = OFF", () => {
    applyPragmas(db, { synchronous: "OFF" });
    const read = readPragmas(db);
    expect(read.synchronous).toBe("off");
  });

  it("applyPragmas 应设置 temp_store = MEMORY", () => {
    applyPragmas(db, { tempStore: "MEMORY" });
    const read = readPragmas(db);
    expect(read.tempStore).toBe("memory");
  });

  it("applyPragmas 应设置 mmap_size", () => {
    applyPragmas(db, { mmapSize: 268_435_456 });
    const read = readPragmas(db);
    expect(read.mmapSize).toBe(268_435_456);
  });

  it("applyPragmas 应设置 wal_autocheckpoint", () => {
    applyPragmas(db, { walAutocheckpoint: 500 });
    const read = readPragmas(db);
    expect(read.walAutocheckpoint).toBe(500);
  });

  it("applyPragmas 应设置 application_id 与 user_version", () => {
    applyPragmas(db, { applicationId: 0x45564f43, userVersion: 42 });
    const read = readPragmas(db);
    expect(read.applicationId).toBe(0x45564f43);
    expect(read.userVersion).toBe(42);
  });

  it("applyPragmas 应设置 secure_delete = ON", () => {
    applyPragmas(db, { secureDelete: true });
    const read = readPragmas(db);
    const sd =
      typeof read.secureDelete === "boolean" ? read.secureDelete : read.secureDelete === 1;
    expect(sd).toBe(true);
  });

  it("readPragmas 在未应用任何 PRAGMA 时应返回默认值（不抛错）", () => {
    const read = readPragmas(db);
    expect(typeof read.journalMode).toBe("string");
    expect(typeof read.busyTimeout).toBe("number");
    expect(typeof read.cacheSize).toBe("number");
  });

  it("validatePragmas 应返回所有匹配项（foreign_keys ON）", () => {
    applyPragmas(db, { foreignKeys: true });
    const diffs = validatePragmas(db, { foreignKeys: true });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].ok).toBe(true);
  });

  it("validatePragmas 应检测到不匹配（busy_timeout 期望与实际不同）", () => {
    applyPragmas(db, { busyTimeout: 3000 });
    const diffs = validatePragmas(db, { busyTimeout: 9999 });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].ok).toBe(false);
    expect(diffs[0].expected).toBe(9999);
    expect(diffs[0].actual).toBe(3000);
  });

  it("validatePragmas 应能批量验证完整 PRAGMA 配置", () => {
    const cfg: PragmaConfig = {
      foreignKeys: true,
      busyTimeout: 5000,
      cacheSize: -20000,
      tempStore: "MEMORY",
      mmapSize: 268_435_456,
      walAutocheckpoint: 1000,
    };
    applyPragmas(db, cfg);
    const diffs = validatePragmas(db, cfg);
    // 内存数据库可能不接受所有 PRAGMA；只要所有项都 ok=true 即可
    for (const d of diffs) {
      expect(d.ok, `PRAGMA ${d.pragma} expected ${d.expected} got ${d.actual}`).toBe(true);
    }
  });
});
