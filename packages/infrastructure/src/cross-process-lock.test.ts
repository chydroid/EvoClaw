/**
 * CrossProcessLock 同进程多实例的 ABA 防护：
 * A 的迟到 release 不得删除 B 后来获得的同名锁。
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CrossProcessLock } from "./filesystem-manager";

describe("CrossProcessLock", () => {
  it("stale release 不删除其他实例持有的锁", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpl-aba-"));
    try {
      const a = new CrossProcessLock(dir, "t");
      const b = new CrossProcessLock(dir, "t");
      const c = new CrossProcessLock(dir, "t");

      await a.acquire(2000);
      a.release();

      await b.acquire(2000);
      // A 的迟到 release（未持有 token）不应影响 B 的锁
      a.release();

      // C 无法获得仍被 B 持有的锁
      await expect(c.acquire(250)).rejects.toThrow(/timed out/);

      b.release();
      await c.acquire(2000);
      c.release();
      expect(fs.existsSync(path.join(dir, "t.lock"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
