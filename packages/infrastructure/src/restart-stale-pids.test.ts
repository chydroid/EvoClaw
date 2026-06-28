/**
 * restart-stale-pids.test.ts — 陈旧 gateway PID 检测与清理测试
 *
 * 注意：lsof / netstat / taskkill 等外部命令依赖真实系统，
 * 因此大部分 spawn-based 测试用 mock 或 skip 处理。
 */

import { describe, it, expect } from "vitest";
import {
  isGatewayArgv,
  getSelfAndAncestorPidsSync,
  terminateStaleProcessesSync,
  cleanStaleGatewayProcessesSync,
  waitForPortFreeSync,
  findGatewayPidsOnPortSync,
  parseLsofEntries,
  __testing,
} from "./restart-stale-pids";

describe("restart-stale-pids", () => {
  describe("isGatewayArgv", () => {
    it("returns true for argv containing evoclaw", () => {
      expect(isGatewayArgv(["node", "evoclaw.js", "--port", "27788"])).toBe(true);
    });

    it("returns true for argv containing gateway", () => {
      expect(isGatewayArgv(["node", "gateway-server.js"])).toBe(true);
    });

    it("returns true for argv containing both", () => {
      expect(isGatewayArgv(["evoclaw", "gateway", "--start"])).toBe(true);
    });

    it("returns false for unrelated argv", () => {
      expect(isGatewayArgv(["node", "other-app.js"])).toBe(false);
    });

    it("returns false for empty argv", () => {
      expect(isGatewayArgv([])).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(isGatewayArgv(["EVOCLOW", "GATEWAY"])).toBe(true);
      expect(isGatewayArgv(["Evoclaw", "Gateway"])).toBe(true);
    });

    it("matches evoclaw substring", () => {
      expect(isGatewayArgv(["/usr/local/bin/evoclaw", "start"])).toBe(true);
    });

    it("matches gateway substring", () => {
      expect(isGatewayArgv(["/opt/evoclaw/bin/evoclaw-gateway"])).toBe(true);
    });
  });

  describe("getSelfAndAncestorPidsSync", () => {
    it("always includes current process pid", () => {
      const pids = getSelfAndAncestorPidsSync();
      expect(pids.has(process.pid)).toBe(true);
    });

    it("includes immediate parent pid when valid", () => {
      if (process.ppid > 0) {
        const pids = getSelfAndAncestorPidsSync();
        expect(pids.has(process.ppid)).toBe(true);
      }
    });

    it("returns at least 1 pid", () => {
      const pids = getSelfAndAncestorPidsSync();
      expect(pids.size).toBeGreaterThanOrEqual(1);
    });

    it("does not throw on any platform", () => {
      expect(() => getSelfAndAncestorPidsSync()).not.toThrow();
    });

    it("accepts custom spawnTimeoutMs", () => {
      expect(() => getSelfAndAncestorPidsSync(500)).not.toThrow();
    });
  });

  describe("__testing.parsePsCommandLine", () => {
    it("parses simple whitespace-separated args", () => {
      const args = __testing.parsePsCommandLine("node evoclaw.js --port 27788");
      expect(args).toEqual(["node", "evoclaw.js", "--port", "27788"]);
    });

    it("parses double-quoted args", () => {
      const args = __testing.parsePsCommandLine('node "my app.js" --arg');
      expect(args).toEqual(["node", "my app.js", "--arg"]);
    });

    it("parses single-quoted args", () => {
      const args = __testing.parsePsCommandLine("node 'my app.js' --arg");
      expect(args).toEqual(["node", "my app.js", "--arg"]);
    });

    it("parses mixed quoting", () => {
      const args = __testing.parsePsCommandLine('node "a b" \'c d\' e');
      expect(args).toEqual(["node", "a b", "c d", "e"]);
    });

    it("ignores empty tokens", () => {
      const args = __testing.parsePsCommandLine("  node   evoclaw  ");
      expect(args).toEqual(["node", "evoclaw"]);
    });

    it("returns empty for empty input", () => {
      expect(__testing.parsePsCommandLine("")).toEqual([]);
    });
  });

  describe("parseLsofEntries (pure parser)", () => {
    it("parses p/c paired entries", () => {
      const stdout = "p12345\ncnode\np67890\ncpython";
      const entries = parseLsofEntries(stdout);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ pid: 12345, cmd: "node" });
      expect(entries[1]).toEqual({ pid: 67890, cmd: "python" });
    });

    it("parses entry without cmd (p line only)", () => {
      const stdout = "p12345";
      const entries = parseLsofEntries(stdout);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ pid: 12345 });
    });

    it("parses cmd containing evoclaw", () => {
      const stdout = "p12345\ncevoclaw-gateway";
      const entries = parseLsofEntries(stdout);
      expect(entries[0]).toEqual({ pid: 12345, cmd: "evoclaw-gateway" });
    });

    it("returns empty for empty stdout", () => {
      expect(parseLsofEntries("")).toEqual([]);
    });

    it("returns empty for whitespace-only stdout", () => {
      expect(parseLsofEntries("  \n  ")).toEqual([]);
    });

    it("ignores non-p non-c lines", () => {
      const stdout = "header\np12345\ngarbage\ncnode\nfooter";
      const entries = parseLsofEntries(stdout);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ pid: 12345, cmd: "node" });
    });

    it("skips invalid pid (non-numeric)", () => {
      const stdout = "pabc\ncnode";
      const entries = parseLsofEntries(stdout);
      expect(entries).toHaveLength(0);
    });

    it("skips invalid pid (zero)", () => {
      const stdout = "p0\ncnode";
      const entries = parseLsofEntries(stdout);
      expect(entries).toHaveLength(0);
    });

    it("skips invalid pid (negative)", () => {
      const stdout = "p-1\ncnode";
      const entries = parseLsofEntries(stdout);
      expect(entries).toHaveLength(0);
    });

    it("handles multiple p lines without c lines", () => {
      const stdout = "p1\np2\np3";
      const entries = parseLsofEntries(stdout);
      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual({ pid: 1 });
      expect(entries[1]).toEqual({ pid: 2 });
      expect(entries[2]).toEqual({ pid: 3 });
    });
  });

  describe("__testing.filterGatewayPidsFromLsof", () => {
    it("includes pid when cmd contains evoclaw", () => {
      const pids = __testing.filterGatewayPidsFromLsof(
        [{ pid: 99999, cmd: "evoclaw-gateway" }],
        100,
      );
      expect(pids).toContain(99999);
    });

    it("includes pid when cmd contains gateway", () => {
      const pids = __testing.filterGatewayPidsFromLsof(
        [{ pid: 99999, cmd: "my-gateway" }],
        100,
      );
      expect(pids).toContain(99999);
    });

    it("excludes self pid", () => {
      const pids = __testing.filterGatewayPidsFromLsof(
        [{ pid: process.pid, cmd: "evoclaw" }],
        100,
      );
      expect(pids).not.toContain(process.pid);
    });

    it("excludes ancestor ppid", () => {
      if (process.ppid > 0) {
        const pids = __testing.filterGatewayPidsFromLsof(
          [{ pid: process.ppid, cmd: "evoclaw" }],
          100,
        );
        expect(pids).not.toContain(process.ppid);
      }
    });

    it("returns empty for non-gateway cmd (without ps fallback success)", () => {
      // pid 99999 不存在 → verifyGatewayPidByArgvSync 返回 false
      const pids = __testing.filterGatewayPidsFromLsof(
        [{ pid: 99999, cmd: "other-app" }],
        100,
      );
      expect(pids).toEqual([]);
    });

    it("deduplicates pids", () => {
      const pids = __testing.filterGatewayPidsFromLsof(
        [
          { pid: 99999, cmd: "evoclaw" },
          { pid: 99999, cmd: "evoclaw" },
        ],
        100,
      );
      expect(pids.filter((p) => p === 99999).length).toBe(1);
    });

    it("returns empty for empty input", () => {
      expect(__testing.filterGatewayPidsFromLsof([], 100)).toEqual([]);
    });
  });

  describe("__testing.sleepSync", () => {
    it("sleeps for short duration without throwing", () => {
      const start = Date.now();
      __testing.sleepSync(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(500);
    });

    it("returns immediately for 0 ms", () => {
      const start = Date.now();
      __testing.sleepSync(0);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
    });

    it("returns immediately for negative ms", () => {
      const start = Date.now();
      __testing.sleepSync(-100);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe("constants", () => {
    it("SPAWN_TIMEOUT_MS is 2000", () => {
      expect(__testing.SPAWN_TIMEOUT_MS).toBe(2000);
    });

    it("POLL_SPAWN_TIMEOUT_MS is 400", () => {
      expect(__testing.POLL_SPAWN_TIMEOUT_MS).toBe(400);
    });

    it("STALE_SIGTERM_WAIT_MS is 600", () => {
      expect(__testing.STALE_SIGTERM_WAIT_MS).toBe(600);
    });

    it("STALE_SIGKILL_WAIT_MS is 400", () => {
      expect(__testing.STALE_SIGKILL_WAIT_MS).toBe(400);
    });

    it("PORT_FREE_POLL_INTERVAL_MS is 50", () => {
      expect(__testing.PORT_FREE_POLL_INTERVAL_MS).toBe(50);
    });

    it("PORT_FREE_TIMEOUT_MS is 2000", () => {
      expect(__testing.PORT_FREE_TIMEOUT_MS).toBe(2000);
    });

    it("MAX_ANCESTOR_WALK_DEPTH is 32", () => {
      expect(__testing.MAX_ANCESTOR_WALK_DEPTH).toBe(32);
    });
  });

  describe("terminateStaleProcessesSync", () => {
    it("returns empty result for empty input", () => {
      const result = terminateStaleProcessesSync([]);
      expect(result.killed).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("returns empty result for null input", () => {
      const result = terminateStaleProcessesSync(null as unknown as number[]);
      expect(result.killed).toEqual([]);
      expect(result.errors).toEqual([]);
    });
  });

  describe("cleanStaleGatewayProcessesSync", () => {
    it("returns empty for invalid port (0)", () => {
      const killed = cleanStaleGatewayProcessesSync(0);
      expect(killed).toEqual([]);
    });

    it("returns empty for invalid port (negative)", () => {
      const killed = cleanStaleGatewayProcessesSync(-1);
      expect(killed).toEqual([]);
    });

    it("returns empty for NaN port", () => {
      const killed = cleanStaleGatewayProcessesSync(NaN);
      expect(killed).toEqual([]);
    });
  });

  describe("waitForPortFreeSync", () => {
    it("does not throw on unused port", () => {
      // 用一个不太可能被占用的端口
      expect(() => waitForPortFreeSync(59999)).not.toThrow();
    });
  });

  describe("findGatewayPidsOnPortSync", () => {
    it("returns array (possibly empty) for valid port", () => {
      const pids = findGatewayPidsOnPortSync(59999);
      expect(Array.isArray(pids)).toBe(true);
    });
  });
});
