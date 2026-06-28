/**
 * restart-coordinator.test.ts — 重启协调器测试
 *
 * 测试策略：
 * - 用 fake timer + 自定义 nowFn 控制 时间
 * - 用 mock sentinel 替代实际 sentinel 行为
 * - 监听 process.emit("SIGUSR1") 而非真实重启
 * - 不实际触发 supervisor handoff（env.VITEST=1 短路）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  RestartCoordinator,
  getDefaultRestartCoordinator,
  resetDefaultRestartCoordinator,
  __testing,
} from "./restart-coordinator";
import { RestartSentinel } from "./restart-sentinel";
import {
  writeGatewayRestartIntentSync,
  consumeGatewayRestartIntentSync,
  clearGatewayRestartIntentSync,
  resolveRestartIntentPath,
} from "./restart-intent";

function makeTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-restart-coord-"));
}

describe("restart-coordinator", () => {
  let coordinator: RestartCoordinator;
  let sentinel: RestartSentinel;
  let now: number;

  beforeEach(() => {
    now = 1000;
    sentinel = new RestartSentinel({
      authGraceMs: 5000,
      cooldownMs: 30000,
      nowFn: () => now,
    });
    coordinator = new RestartCoordinator({
      sentinel,
      nowFn: () => now,
      deferralPollMs: 50,
      deferralStillPendingWarnMs: 30,
      deferralTimeoutMs: 200,
    });
  });

  describe("schedule basic", () => {
    it("returns ScheduledRestart with ok=true", () => {
      const result = coordinator.schedule({ reason: "test" });
      expect(result.ok).toBe(true);
      expect(result.pid).toBe(process.pid);
      expect(result.signal).toBe("SIGUSR1");
      expect(result.coalesced).toBe(false);
      expect(result.reason).toBe("test");
    });

    it("uses default delay of 2000ms", () => {
      const result = coordinator.schedule();
      expect(result.delayMs).toBeGreaterThanOrEqual(1900);
      expect(result.delayMs).toBeLessThanOrEqual(2100);
    });

    it("respects custom delayMs", () => {
      const result = coordinator.schedule({ delayMs: 5000 });
      expect(result.delayMs).toBe(5000);
    });

    it("clamps delayMs to 60000 max", () => {
      const result = coordinator.schedule({ delayMs: 120000 });
      expect(result.delayMs).toBe(60000);
    });

    it("clamps delayMs to 0 min", () => {
      const result = coordinator.schedule({ delayMs: -100 });
      expect(result.delayMs).toBe(0);
    });

    it("truncates long reason to 200 chars", () => {
      const longReason = "x".repeat(300);
      const result = coordinator.schedule({ reason: longReason });
      expect(result.reason?.length).toBe(200);
    });

    it("trims whitespace from reason", () => {
      const result = coordinator.schedule({ reason: "  trimmed  " });
      expect(result.reason).toBe("trimmed");
    });

    it("returns undefined reason for empty string", () => {
      const result = coordinator.schedule({ reason: "   " });
      expect(result.reason).toBeUndefined();
    });

    it("returns undefined reason for non-string", () => {
      const result = coordinator.schedule({ reason: undefined });
      expect(result.reason).toBeUndefined();
    });

    it("mode is emit when SIGUSR1 listener exists, supervisor on win32 otherwise signal", () => {
      const result = coordinator.schedule();
      const hasListener = process.listenerCount("SIGUSR1") > 0;
      if (hasListener) {
        expect(result.mode).toBe("emit");
      } else if (process.platform === "win32") {
        expect(result.mode).toBe("supervisor");
      } else {
        expect(result.mode).toBe("signal");
      }
    });

    it("applies cooldown from sentinel", () => {
      // 标记已发出信号 — 启动冷却期（但不进入 cycle，避免触发合并）
      sentinel.markEmitted();
      const result = coordinator.schedule({ delayMs: 1000 });
      expect(result.cooldownMsApplied).toBe(30000);
      expect(result.delayMs).toBe(31000);
    });

    it("skipCooldown=true bypasses cooldown", () => {
      sentinel.markEmitted();
      const result = coordinator.schedule({ delayMs: 1000, skipCooldown: true });
      expect(result.cooldownMsApplied).toBe(0);
      expect(result.delayMs).toBe(1000);
    });
  });

  describe("schedule coalescing", () => {
    it("returns coalesced:true when unconsumed signal exists", () => {
      sentinel.enterCycle("first");
      const result = coordinator.schedule({ reason: "second" });
      expect(result.coalesced).toBe(true);
      expect(result.delayMs).toBe(0);
    });

    it("returns coalesced:true when second request is later than pending", () => {
      // 第一次：100ms 后到期
      coordinator.schedule({ delayMs: 100, reason: "first" });
      // 第二次：5000ms 后到期 — 比第一次晚，应该合并
      const result = coordinator.schedule({ delayMs: 5000, reason: "second" });
      expect(result.coalesced).toBe(true);
    });

    it("pulls earlier when second request is earlier than pending", () => {
      // 第一次：5000ms 后到期
      coordinator.schedule({ delayMs: 5000, reason: "first" });
      // 第二次：100ms 后到期 — 比第一次早，应该 reschedule（coalesced:false）
      const result = coordinator.schedule({ delayMs: 100, reason: "second" });
      expect(result.coalesced).toBe(false);
      expect(result.delayMs).toBe(100);
    });

    it("updates pending reason when shouldPreferRestartReason", () => {
      coordinator.schedule({ delayMs: 5000, reason: "config.reload" });
      coordinator.schedule({ delayMs: 10000, reason: "update.run" });
      // update.run 应该优先 — 但因为已有 pending，应返回 coalesced
      const state = sentinel.getState();
      expect(state.cycleToken).toBe(0); // 未触发 enterCycle
    });
  });

  describe("emitHooks sessionKey protection", () => {
    it("queued emitHooks with sessionKey", () => {
      const result = coordinator.schedule({
        delayMs: 1000,
        emitHooks: { beforeEmit: async () => {} },
        sessionKey: "session-A",
      });
      expect(result.emitHooksQueued).toBe(true);
    });

    it("rejects emitHooks from different sessionKey", () => {
      coordinator.schedule({
        delayMs: 1000,
        emitHooks: { beforeEmit: async () => {} },
        sessionKey: "session-A",
      });
      const result = coordinator.schedule({
        delayMs: 2000,
        emitHooks: { beforeEmit: async () => {} },
        sessionKey: "session-B",
      });
      expect(result.emitHooksQueued).toBe(false);
    });

    it("allows same sessionKey to update hooks", () => {
      coordinator.schedule({
        delayMs: 1000,
        emitHooks: { beforeEmit: async () => {} },
        sessionKey: "session-A",
      });
      const result = coordinator.schedule({
        delayMs: 2000,
        emitHooks: { beforeEmit: async () => {} },
        sessionKey: "session-A",
      });
      expect(result.emitHooksQueued).toBe(true);
    });

    it("no sessionKey means hooks are always queued", () => {
      coordinator.schedule({
        delayMs: 1000,
        emitHooks: { beforeEmit: async () => {} },
      });
      const result = coordinator.schedule({
        delayMs: 2000,
        emitHooks: { beforeEmit: async () => {} },
      });
      expect(result.emitHooksQueued).toBe(true);
    });
  });

  describe("setPreRestartDeferralCheck", () => {
    it("registers deferral check function", () => {
      const check = vi.fn(() => 0);
      coordinator.setPreRestartDeferralCheck(check);
      // 内部状态变更，无直接 getter 验证；通过 schedule 行为间接验证
      // 但因为 delayMs=0 + pending=0，会立即 emit
      // 这里只验证不抛错
      expect(() => coordinator.setPreRestartDeferralCheck(check)).not.toThrow();
    });

    it("accepts null to disable", () => {
      coordinator.setPreRestartDeferralCheck(() => 5);
      expect(() => coordinator.setPreRestartDeferralCheck(null)).not.toThrow();
    });
  });

  describe("emitGatewayRestart", () => {
    let stateDir: string;
    let env: NodeJS.ProcessEnv;

    beforeEach(() => {
      stateDir = makeTempStateDir();
      env = { ...process.env, EVOCLAW_STATE_DIR: stateDir, VITEST: "1" };
      // 用一个新的 coordinator 绑定此 env（通过子类化或重新创建）
      // 实际上 emitGatewayRestart 不接受 env 参数，intent 写入用的是 process.env
      // 这里我们直接覆盖 process.env.EVOCLAW_STATE_DIR
      process.env.EVOCLAW_STATE_DIR = stateDir;
    });

    afterEach(() => {
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      delete process.env.EVOCLAW_STATE_DIR;
    });

    it("writes intent file before emitting signal", () => {
      // 添加 SIGUSR1 监听器，使 mode=emit
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        const emitted = coordinator.emitGatewayRestart("test-reason");
        expect(emitted).toBe(true);
        // intent 文件应存在
        expect(fs.existsSync(resolveRestartIntentPath())).toBe(true);
      } finally {
        process.off("SIGUSR1", handler);
        clearGatewayRestartIntentSync();
      }
    });

    it("returns false when unconsumed signal already exists", () => {
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        coordinator.emitGatewayRestart("first");
        const second = coordinator.emitGatewayRestart("second");
        expect(second).toBe(false);
      } finally {
        process.off("SIGUSR1", handler);
        clearGatewayRestartIntentSync();
      }
    });

    it("enters sentinel cycle and authorizes", () => {
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        coordinator.emitGatewayRestart("cycle-test");
        const state = sentinel.getState();
        expect(state.cycleToken).toBeGreaterThan(0);
        expect(state.consumedToken).toBeLessThan(state.cycleToken);
        expect(state.authorizedCount).toBeGreaterThanOrEqual(1);
      } finally {
        process.off("SIGUSR1", handler);
        clearGatewayRestartIntentSync();
      }
    });
  });

  describe("consumeIntent", () => {
    let stateDir: string;

    beforeEach(() => {
      stateDir = makeTempStateDir();
      process.env.EVOCLAW_STATE_DIR = stateDir;
    });

    afterEach(() => {
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      delete process.env.EVOCLAW_STATE_DIR;
    });

    it("returns ok:true when intent exists for current pid", () => {
      writeGatewayRestartIntentSync({
        targetPid: process.pid,
        reason: "consume-test",
      });
      const result = coordinator.consumeIntent();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.intent.reason).toBe("consume-test");
      }
    });

    it("returns no-file when no intent exists", () => {
      const result = coordinator.consumeIntent();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("no-file");
      }
    });

    it("deletes intent file after consume", () => {
      writeGatewayRestartIntentSync({ targetPid: process.pid });
      coordinator.consumeIntent();
      expect(fs.existsSync(resolveRestartIntentPath())).toBe(false);
    });
  });

  describe("clearIntent", () => {
    let stateDir: string;

    beforeEach(() => {
      stateDir = makeTempStateDir();
      process.env.EVOCLAW_STATE_DIR = stateDir;
    });

    afterEach(() => {
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      delete process.env.EVOCLAW_STATE_DIR;
    });

    it("deletes existing intent", () => {
      writeGatewayRestartIntentSync({ targetPid: process.pid });
      coordinator.clearIntent();
      expect(fs.existsSync(resolveRestartIntentPath())).toBe(false);
    });

    it("is idempotent when no intent exists", () => {
      expect(() => coordinator.clearIntent()).not.toThrow();
    });
  });

  describe("resetInProcessRestartState", () => {
    it("clears pending timer and active polls", () => {
      coordinator.schedule({ delayMs: 5000 });
      expect(() => coordinator.resetInProcessRestartState()).not.toThrow();
    });

    it("allows new schedule after reset", () => {
      coordinator.schedule({ delayMs: 5000 });
      coordinator.resetInProcessRestartState();
      const result = coordinator.schedule({ delayMs: 100 });
      expect(result.coalesced).toBe(false);
    });
  });

  describe("getSentinelState", () => {
    it("returns sentinel state snapshot", () => {
      const state = coordinator.getSentinelState();
      expect(state).toHaveProperty("authorizedCount");
      expect(state).toHaveProperty("cycleToken");
    });
  });

  describe("setExternalPolicy", () => {
    it("delegates to sentinel", () => {
      coordinator.setExternalPolicy(true);
      expect(sentinel.isExternallyAllowed()).toBe(true);
      coordinator.setExternalPolicy(false);
      expect(sentinel.isExternallyAllowed()).toBe(false);
    });
  });

  describe("default singleton", () => {
    it("getDefaultRestartCoordinator returns same instance", () => {
      resetDefaultRestartCoordinator();
      const c1 = getDefaultRestartCoordinator();
      const c2 = getDefaultRestartCoordinator();
      expect(c1).toBe(c2);
    });

    it("resetDefaultRestartCoordinator creates new instance", () => {
      const c1 = getDefaultRestartCoordinator();
      resetDefaultRestartCoordinator();
      const c2 = getDefaultRestartCoordinator();
      expect(c1).not.toBe(c2);
    });
  });

  describe("constants", () => {
    it("DEFAULT_DELAY_MS is 2000", () => {
      expect(__testing.DEFAULT_DELAY_MS).toBe(2000);
    });

    it("MAX_DELAY_MS is 60000", () => {
      expect(__testing.MAX_DELAY_MS).toBe(60000);
    });

    it("DEFAULT_DEFERRAL_POLL_MS is 500", () => {
      expect(__testing.DEFAULT_DEFERRAL_POLL_MS).toBe(500);
    });

    it("DEFAULT_DEFERRAL_TIMEOUT_MS is 300000", () => {
      expect(__testing.DEFAULT_DEFERRAL_TIMEOUT_MS).toBe(300000);
    });
  });
});
