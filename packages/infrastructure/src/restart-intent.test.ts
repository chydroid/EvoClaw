/**
 * restart-intent.test.ts — 持久化 intent 文件测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  writeGatewayRestartIntentSync,
  consumeGatewayRestartIntentSync,
  readGatewayRestartIntentPayloadSync,
  clearGatewayRestartIntentSync,
  resolveRestartIntentPath,
  resolveDefaultStateDir,
  getIntentTtlMs,
  getIntentMaxBytes,
  __testing,
} from "./restart-intent";

function makeTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-restart-intent-"));
}

describe("restart-intent", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  const originalPid = process.pid;

  beforeEach(() => {
    stateDir = makeTempStateDir();
    env = { ...process.env, EVOCLAW_STATE_DIR: stateDir };
  });

  afterEach(() => {
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("resolveDefaultStateDir", () => {
    it("uses EVOCLAW_STATE_DIR when set", () => {
      const dir = resolveDefaultStateDir({ EVOCLAW_STATE_DIR: "/custom/path" });
      expect(dir).toBe("/custom/path");
    });

    it("trims whitespace from EVOCLAW_STATE_DIR", () => {
      const dir = resolveDefaultStateDir({ EVOCLAW_STATE_DIR: "  /trim/me  " });
      expect(dir).toBe("/trim/me");
    });

    it("falls back to cwd/data when env not set", () => {
      const dir = resolveDefaultStateDir({});
      expect(dir).toBe(path.join(process.cwd(), "data"));
    });

    it("falls back to cwd/data when env is empty string", () => {
      const dir = resolveDefaultStateDir({ EVOCLAW_STATE_DIR: "" });
      expect(dir).toBe(path.join(process.cwd(), "data"));
    });
  });

  describe("resolveRestartIntentPath", () => {
    it("joins state dir with intent filename", () => {
      const p = resolveRestartIntentPath({ EVOCLAW_STATE_DIR: "/state" });
      expect(p).toBe(path.join("/state", "gateway-restart-intent.json"));
    });
  });

  describe("writeGatewayRestartIntentSync", () => {
    it("writes valid intent file with required fields", () => {
      const ok = writeGatewayRestartIntentSync({
        env,
        targetPid: originalPid,
        reason: "config.reload",
      });
      expect(ok).toBe(true);
      const intentPath = resolveRestartIntentPath(env);
      expect(fs.existsSync(intentPath)).toBe(true);
      const raw = fs.readFileSync(intentPath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.kind).toBe("gateway-restart");
      expect(parsed.pid).toBe(originalPid);
      expect(parsed.reason).toBe("config.reload");
      expect(typeof parsed.createdAt).toBe("number");
    });

    it("writes intent with force flag", () => {
      const ok = writeGatewayRestartIntentSync({
        env,
        targetPid: originalPid,
        intent: { force: true, reason: "manual.force" },
      });
      expect(ok).toBe(true);
      const raw = fs.readFileSync(resolveRestartIntentPath(env), "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.force).toBe(true);
      expect(parsed.reason).toBe("manual.force");
    });

    it("writes intent with waitMs", () => {
      const ok = writeGatewayRestartIntentSync({
        env,
        targetPid: originalPid,
        intent: { waitMs: 5000 },
      });
      expect(ok).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(resolveRestartIntentPath(env), "utf8"));
      expect(parsed.waitMs).toBe(5000);
    });

    it("rejects invalid pid (0)", () => {
      const ok = writeGatewayRestartIntentSync({ env, targetPid: 0 });
      expect(ok).toBe(false);
      expect(fs.existsSync(resolveRestartIntentPath(env))).toBe(false);
    });

    it("rejects invalid pid (negative)", () => {
      const ok = writeGatewayRestartIntentSync({ env, targetPid: -1 });
      expect(ok).toBe(false);
    });

    it("rejects invalid pid (fractional)", () => {
      const ok = writeGatewayRestartIntentSync({ env, targetPid: 1.5 });
      expect(ok).toBe(false);
    });

    it("rejects invalid pid (undefined)", () => {
      const ok = writeGatewayRestartIntentSync({ env });
      expect(ok).toBe(false);
    });

    it("truncates long reason to 200 chars", () => {
      const longReason = "x".repeat(300);
      const ok = writeGatewayRestartIntentSync({
        env,
        targetPid: originalPid,
        reason: longReason,
      });
      expect(ok).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(resolveRestartIntentPath(env), "utf8"));
      expect(parsed.reason.length).toBe(200);
    });

    it("trims whitespace from reason", () => {
      const ok = writeGatewayRestartIntentSync({
        env,
        targetPid: originalPid,
        reason: "  trimmed  ",
      });
      expect(ok).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(resolveRestartIntentPath(env), "utf8"));
      expect(parsed.reason).toBe("trimmed");
    });

    it("rejects invalid waitMs (negative)", () => {
      const ok = writeGatewayRestartIntentSync({
        env,
        targetPid: originalPid,
        intent: { waitMs: -1 },
      });
      expect(ok).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(resolveRestartIntentPath(env), "utf8"));
      expect(parsed.waitMs).toBeUndefined();
    });

    it("creates state dir if not exists", () => {
      const nested = path.join(stateDir, "nested", "deeper");
      const env2 = { ...env, EVOCLAW_STATE_DIR: nested };
      const ok = writeGatewayRestartIntentSync({
        env: env2,
        targetPid: originalPid,
      });
      expect(ok).toBe(true);
      expect(fs.existsSync(resolveRestartIntentPath(env2))).toBe(true);
    });
  });

  describe("readGatewayRestartIntentPayloadSync", () => {
    it("returns ok:true for valid intent matching current pid", () => {
      writeGatewayRestartIntentSync({ env, targetPid: originalPid, reason: "test" });
      const result = readGatewayRestartIntentPayloadSync(env);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.intent.reason).toBe("test");
      }
    });

    it("returns no-file when no intent exists", () => {
      const result = readGatewayRestartIntentPayloadSync(env);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("no-file");
      }
    });

    it("returns pid-mismatch when pid does not match", () => {
      writeGatewayRestartIntentSync({ env, targetPid: originalPid });
      // Write intent with different pid manually
      const intentPath = resolveRestartIntentPath(env);
      const payload = {
        kind: "gateway-restart",
        pid: 999999,
        createdAt: Date.now(),
      };
      fs.writeFileSync(intentPath, `${JSON.stringify(payload)}\n`);
      const result = readGatewayRestartIntentPayloadSync(env);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("pid-mismatch");
      }
    });

    it("returns expired when intent is too old", () => {
      const intentPath = resolveRestartIntentPath(env);
      const payload = {
        kind: "gateway-restart",
        pid: originalPid,
        createdAt: Date.now() - getIntentTtlMs() - 1000,
      };
      fs.writeFileSync(intentPath, `${JSON.stringify(payload)}\n`);
      const result = readGatewayRestartIntentPayloadSync(env);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("expired");
      }
    });

    it("returns invalid-json for malformed content", () => {
      const intentPath = resolveRestartIntentPath(env);
      fs.writeFileSync(intentPath, "not valid json {{{");
      const result = readGatewayRestartIntentPayloadSync(env);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid-json");
      }
    });

    it("returns oversize when file exceeds max bytes", () => {
      const intentPath = resolveRestartIntentPath(env);
      const huge = "x".repeat(getIntentMaxBytes() + 100);
      fs.writeFileSync(intentPath, huge);
      const result = readGatewayRestartIntentPayloadSync(env);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("oversize");
      }
    });

    it("returns schema-mismatch when kind is wrong", () => {
      const intentPath = resolveRestartIntentPath(env);
      const payload = {
        kind: "not-gateway-restart",
        pid: originalPid,
        createdAt: Date.now(),
      };
      fs.writeFileSync(intentPath, JSON.stringify(payload));
      const result = readGatewayRestartIntentPayloadSync(env);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("schema-mismatch");
      }
    });

    it("accepts intent without optional fields", () => {
      const intentPath = resolveRestartIntentPath(env);
      const payload = {
        kind: "gateway-restart",
        pid: originalPid,
        createdAt: Date.now(),
      };
      fs.writeFileSync(intentPath, JSON.stringify(payload));
      const result = readGatewayRestartIntentPayloadSync(env);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.intent.reason).toBeUndefined();
        expect(result.intent.force).toBeUndefined();
        expect(result.intent.waitMs).toBeUndefined();
      }
    });
  });

  describe("consumeGatewayRestartIntentSync", () => {
    it("reads and deletes intent file", () => {
      writeGatewayRestartIntentSync({ env, targetPid: originalPid, reason: "consume" });
      const result = consumeGatewayRestartIntentSync(env);
      expect(result.ok).toBe(true);
      // 文件应已被删除
      expect(fs.existsSync(resolveRestartIntentPath(env))).toBe(false);
    });

    it("returns no-file and does not throw when no intent exists", () => {
      const result = consumeGatewayRestartIntentSync(env);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("no-file");
      }
    });

    it("deletes file even when content is invalid", () => {
      const intentPath = resolveRestartIntentPath(env);
      fs.writeFileSync(intentPath, "garbage");
      const result = consumeGatewayRestartIntentSync(env);
      expect(result.ok).toBe(false);
      expect(fs.existsSync(intentPath)).toBe(false);
    });
  });

  describe("clearGatewayRestartIntentSync", () => {
    it("deletes existing intent file", () => {
      writeGatewayRestartIntentSync({ env, targetPid: originalPid });
      clearGatewayRestartIntentSync(env);
      expect(fs.existsSync(resolveRestartIntentPath(env))).toBe(false);
    });

    it("is idempotent when no file exists", () => {
      expect(() => clearGatewayRestartIntentSync(env)).not.toThrow();
    });
  });

  describe("__testing.normalizePid", () => {
    it("returns pid for positive integer", () => {
      expect(__testing.normalizePid(42)).toBe(42);
    });

    it("returns null for 0", () => {
      expect(__testing.normalizePid(0)).toBeNull();
    });

    it("returns null for negative", () => {
      expect(__testing.normalizePid(-1)).toBeNull();
    });

    it("returns null for fractional", () => {
      expect(__testing.normalizePid(1.5)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(__testing.normalizePid(undefined)).toBeNull();
    });
  });

  describe("__testing.parseGatewayRestartIntent", () => {
    it("parses valid JSON", () => {
      const payload = {
        kind: "gateway-restart",
        pid: 12345,
        createdAt: Date.now(),
        reason: "test",
      };
      const result = __testing.parseGatewayRestartIntent(JSON.stringify(payload));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.pid).toBe(12345);
        expect(result.payload.reason).toBe("test");
      }
    });

    it("returns invalid-json for invalid JSON", () => {
      const result = __testing.parseGatewayRestartIntent("garbage");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid-json");
      }
    });

    it("returns schema-mismatch for wrong kind", () => {
      const payload = { kind: "other", pid: 1, createdAt: Date.now() };
      const result = __testing.parseGatewayRestartIntent(JSON.stringify(payload));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("schema-mismatch");
      }
    });

    it("returns schema-mismatch for missing pid", () => {
      const payload = { kind: "gateway-restart", createdAt: Date.now() };
      const result = __testing.parseGatewayRestartIntent(JSON.stringify(payload));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("schema-mismatch");
      }
    });

    it("returns schema-mismatch for missing createdAt", () => {
      const payload = { kind: "gateway-restart", pid: 1 };
      const result = __testing.parseGatewayRestartIntent(JSON.stringify(payload));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("schema-mismatch");
      }
    });
  });
});
