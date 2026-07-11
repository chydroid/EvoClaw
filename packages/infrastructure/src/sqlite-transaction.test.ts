import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  withTransaction,
  withSavepoint,
  batchExec,
  isInTransaction,
  getTransactionStats,
  resetTransactionStats,
  TransactionError,
} from "./sqlite-transaction";
import { applyPragmas, type SqliteDb } from "./sqlite-pragma";

// better-sqlite3 native binding 探测（与 sqlite-pragma.test.ts 同模式）。
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

// ── 不依赖 native binding 的纯逻辑测试 ─────────────────────────

describe("TransactionError", () => {
  it("应保留 cause 与 phase", () => {
    const cause = new Error("boom");
    const err = new TransactionError("begin failed", cause, "begin");
    expect(err.message).toBe("begin failed");
    expect(err.cause).toBe(cause);
    expect(err.phase).toBe("begin");
    expect(err.name).toBe("TransactionError");
    expect(err).toBeInstanceOf(Error);
  });

  it("应支持所有 phase 字面量", () => {
    const phases = ["begin", "commit", "rollback", "savepoint", "release", "rollback-to"] as const;
    for (const phase of phases) {
      const err = new TransactionError(`err ${phase}`, null, phase);
      expect(err.phase).toBe(phase);
    }
  });
});

// ── 依赖 native binding 的测试 ────────────────────────────────

describe.skipIf(!DatabaseCtor)("withTransaction / withSavepoint (sqlite)", () => {
  let db: SqliteDb;

  beforeEach(() => {
    db = new DatabaseCtor!(":memory:");
    applyPragmas(db, { journalMode: "MEMORY", synchronous: "OFF", foreignKeys: true });
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL);");
    resetTransactionStats(db);
  });

  afterEach(() => {
    try { db.close?.(); } catch { /* ignore */ }
  });

  describe("withTransaction", () => {
    it("成功时应 commit 并返回值", () => {
      const result = withTransaction(db, () => {
        db.prepare("INSERT INTO t (v) VALUES (?);").run("hello");
        return "ok";
      });
      expect(result).toBe("ok");
      const rows = db.prepare("SELECT COUNT(*) AS c FROM t;").get() as { c: number };
      expect(rows.c).toBe(1);
    });

    it("fn 抛错时应 rollback 并重新抛出原错误", () => {
      expect(() =>
        withTransaction(db, () => {
          db.prepare("INSERT INTO t (v) VALUES (?);").run("x");
          throw new Error("boom");
        }),
      ).toThrow("boom");
      const rows = db.prepare("SELECT COUNT(*) AS c FROM t;").get() as { c: number };
      expect(rows.c).toBe(0);
    });

    it("BEGIN 失败时应抛 TransactionError(phase=begin)", () => {
      // 通过 mock db 模拟 BEGIN 失败
      let firstCall = true;
      const mockDb: SqliteDb = {
        exec: (sql: string) => {
          if (firstCall && sql.startsWith("BEGIN")) {
            firstCall = false;
            throw new Error("cannot begin");
          }
        },
        prepare: () => ({
          get: () => undefined,
          run: () => undefined,
          all: () => [],
        }),
      };
      expect(() => withTransaction(mockDb, () => "x")).toThrow("cannot begin");
      try {
        withTransaction(mockDb, () => "x");
      } catch (err) {
        expect(err).toBeInstanceOf(TransactionError);
        expect((err as TransactionError).phase).toBe("begin");
      }
    });

    it("嵌套调用：内层失败 rollback 不影响外层", () => {
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (v) VALUES (?);").run("outer");
        expect(() =>
          withTransaction(db, () => {
            db.prepare("INSERT INTO t (v) VALUES (?);").run("inner");
            throw new Error("inner fail");
          }),
        ).toThrow("inner fail");
      });
      const rows = db.prepare("SELECT v FROM t ORDER BY id;").all() as { v: string }[];
      expect(rows).toEqual([{ v: "outer" }]);
    });

    it("嵌套调用：内层成功则与外层一起 commit", () => {
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (v) VALUES (?);").run("outer");
        withTransaction(db, () => {
          db.prepare("INSERT INTO t (v) VALUES (?);").run("inner");
        });
      });
      const rows = db.prepare("SELECT v FROM t ORDER BY id;").all() as { v: string }[];
      expect(rows).toEqual([{ v: "outer" }, { v: "inner" }]);
    });

    it("fn 返回 Promise 时应抛错并 rollback", () => {
      expect(() =>
        withTransaction(db, async () => {
          db.prepare("INSERT INTO t (v) VALUES (?);").run("async");
          return "ignored";
        }),
      ).toThrow("must be synchronous");
      const rows = db.prepare("SELECT COUNT(*) AS c FROM t;").get() as { c: number };
      expect(rows.c).toBe(0);
    });

    it("支持 deferred / immediate / exclusive 模式", () => {
      for (const mode of ["deferred", "immediate", "exclusive"] as const) {
        withTransaction(
          db,
          () => {
            db.prepare("INSERT INTO t (v) VALUES (?);").run(mode);
          },
          { mode },
        );
      }
      const rows = db.prepare("SELECT v FROM t ORDER BY id;").all() as { v: string }[];
      expect(rows).toEqual([{ v: "deferred" }, { v: "immediate" }, { v: "exclusive" }]);
    });
  });

  describe("withSavepoint", () => {
    it("成功时应 release 并保留写入", () => {
      withSavepoint(db, () => {
        db.prepare("INSERT INTO t (v) VALUES (?);").run("sp");
      });
      const rows = db.prepare("SELECT COUNT(*) AS c FROM t;").get() as { c: number };
      expect(rows.c).toBe(1);
    });

    it("fn 抛错时应 rollback to savepoint 并重新抛出", () => {
      expect(() =>
        withSavepoint(db, () => {
          db.prepare("INSERT INTO t (v) VALUES (?);").run("sp");
          throw new Error("sp fail");
        }),
      ).toThrow("sp fail");
      const rows = db.prepare("SELECT COUNT(*) AS c FROM t;").get() as { c: number };
      expect(rows.c).toBe(0);
    });

    it("无外层事务时自动开外层事务", () => {
      withSavepoint(db, () => {
        db.prepare("INSERT INTO t (v) VALUES (?);").run("sp1");
      });
      const rows = db.prepare("SELECT v FROM t;").all() as { v: string }[];
      expect(rows).toEqual([{ v: "sp1" }]);
    });

    it("支持自定义 savepoint 名称", () => {
      withSavepoint(db, () => {
        db.prepare("INSERT INTO t (v) VALUES (?);").run("named");
      }, "custom_sp_name");
      const rows = db.prepare("SELECT v FROM t;").all() as { v: string }[];
      expect(rows).toHaveLength(1);
    });

    it("在 withTransaction 内嵌套时正常工作", () => {
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (v) VALUES (?);").run("outer");
        withSavepoint(db, () => {
          db.prepare("INSERT INTO t (v) VALUES (?);").run("sp");
        });
      });
      const rows = db.prepare("SELECT v FROM t ORDER BY id;").all() as { v: string }[];
      expect(rows).toEqual([{ v: "outer" }, { v: "sp" }]);
    });
  });

  describe("isInTransaction", () => {
    it("未在事务中应返回 false", () => {
      expect(isInTransaction(db)).toBe(false);
    });

    it("在事务中应返回 true", () => {
      withTransaction(db, () => {
        expect(isInTransaction(db)).toBe(true);
      });
      expect(isInTransaction(db)).toBe(false);
    });

    it("嵌套时也返回 true", () => {
      withTransaction(db, () => {
        expect(isInTransaction(db)).toBe(true);
        withTransaction(db, () => {
          expect(isInTransaction(db)).toBe(true);
        });
      });
    });
  });

  describe("batchExec", () => {
    it("应在单个事务中按序执行所有语句", () => {
      batchExec(db, [
        "INSERT INTO t (v) VALUES ('a');",
        "INSERT INTO t (v) VALUES ('b');",
        "INSERT INTO t (v) VALUES ('c');",
      ]);
      const rows = db.prepare("SELECT v FROM t ORDER BY id;").all() as { v: string }[];
      expect(rows).toEqual([{ v: "a" }, { v: "b" }, { v: "c" }]);
    });

    it("空数组时应 no-op 且不开事务", () => {
      batchExec(db, []);
      const rows = db.prepare("SELECT COUNT(*) AS c FROM t;").get() as { c: number };
      expect(rows.c).toBe(0);
    });

    it("任一语句失败时应 rollback 整批", () => {
      expect(() =>
        batchExec(db, [
          "INSERT INTO t (v) VALUES ('ok1');",
          "INSERT INTO t (v) VALUES ('ok2');",
          "INVALID SQL SYNTAX HERE;",
        ]),
      ).toThrow();
      const rows = db.prepare("SELECT COUNT(*) AS c FROM t;").get() as { c: number };
      expect(rows.c).toBe(0);
    });
  });

  describe("TransactionStats", () => {
    it("committed 应统计成功事务数", () => {
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (v) VALUES (?);").run("a");
      });
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (v) VALUES (?);").run("b");
      });
      const stats = getTransactionStats(db);
      expect(stats.totalTransactions).toBe(2);
      expect(stats.committed).toBe(2);
      expect(stats.rolledBack).toBe(0);
    });

    it("rolledBack 应统计失败事务数", () => {
      try {
        withTransaction(db, () => {
          throw new Error("fail");
        });
      } catch {
        /* swallow */
      }
      const stats = getTransactionStats(db);
      expect(stats.totalTransactions).toBe(1);
      expect(stats.rolledBack).toBe(1);
      expect(stats.committed).toBe(0);
      expect(stats.lastError).toBeDefined();
      // 顶层事务失败使用完整 ROLLBACK，phase 为 "rollback"；
      // 仅 savepoint 回滚才使用 "rollback-to"。
      expect(stats.lastError!.phase).toBe("rollback");
      expect(stats.lastError!.message).toBe("fail");
    });

    it("nestedSavepoints 应统计嵌套 savepoint 数", () => {
      withTransaction(db, () => {
        withTransaction(db, () => {
          /* nested */
        });
      });
      const stats = getTransactionStats(db);
      expect(stats.totalTransactions).toBe(1);
      expect(stats.nestedSavepoints).toBe(1);
    });

    it("resetTransactionStats 应重置所有计数", () => {
      withTransaction(db, () => "x");
      resetTransactionStats(db);
      const stats = getTransactionStats(db);
      expect(stats.totalTransactions).toBe(0);
      expect(stats.committed).toBe(0);
      expect(stats.rolledBack).toBe(0);
      expect(stats.nestedSavepoints).toBe(0);
      expect(stats.lastError).toBeUndefined();
    });

    it("getTransactionStats 返回的对象是深拷贝", () => {
      withTransaction(db, () => "x");
      const s1 = getTransactionStats(db);
      s1.committed = 9999;
      const s2 = getTransactionStats(db);
      expect(s2.committed).toBe(1);
    });
  });

  describe("错误传播", () => {
    it("嵌套外层失败时内层 savepoint 也应回滚", () => {
      expect(() =>
        withTransaction(db, () => {
          db.prepare("INSERT INTO t (v) VALUES (?);").run("outer");
          withTransaction(db, () => {
            db.prepare("INSERT INTO t (v) VALUES (?);").run("inner");
          });
          throw new Error("outer fail");
        }),
      ).toThrow("outer fail");
      const rows = db.prepare("SELECT COUNT(*) AS c FROM t;").get() as { c: number };
      expect(rows.c).toBe(0);
    });
  });
});
