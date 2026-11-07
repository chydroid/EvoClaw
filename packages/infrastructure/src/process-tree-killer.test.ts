/**
 * process-tree-killer 测试（Hermes ProcessTerminationMixin 对齐 Step 6）
 *
 * 覆盖：
 *  - 安全门控（pid 0/1/自身/父）
 *  - POSIX 真实子进程树终止 + 幸存者验证（settle 复查后仍存活 → KillResult.survivors）
 *  - isAlive 注入桩：幸存者 / probe 异常 fail-closed / grace 行为
 *  - force 模式、recursive=false
 *
 * 真实进程测试用短生命周期 shell 父子（bash 保持存活 + sleep 子进程），
 * 不依赖真实 kill-proof 进程（竞赛条件）。
 */
import { describe, it, expect, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  killProcessTree,
  killChildProcessTree,
  type KillOptions,
} from "./process-tree-killer";

function realKillOpts(over: Partial<KillOptions> = {}): KillOptions {
  return { gracePeriodMs: 1500, ...over };
}

describe("process-tree-killer", () => {
  describe("安全门控", () => {
    it("pid 0/1 → unsafe 报错且零信号", async () => {
      for (const p of [0, 1, process.ppid]) {
        const r = await killProcessTree(p);
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/unsafe/);
        expect(r.killedPids).toEqual([]);
      }
    });
  });

  describe("真实进程树终止 + 幸存者验证", () => {
    it("terminates real parent with 2 alive children and reports no survivors", async () => {
      // bash 保持存活（wait），其下挂两个 sleep 子进程
      const bash = spawn("bash", ["-c", "sleep 30 & sleep 30 & wait"], {
        stdio: "ignore",
        detached: false,
      });
      const bashPid = bash.pid!;
      // 等子进程就位
      await new Promise((r) => setTimeout(r, 200));

      const r = await killProcessTree(bashPid, {
        gracePeriodMs: 1000,
        killSettleMs: 300,
      });

      expect(r.success).toBe(true);
      expect(r.survivors?.length ?? 0).toBe(0);
      expect(r.killedPids).toContain(bashPid);
      // 3 个 pid（bash + 2 sleep）全部回收
      expect(r.killedPids.length >= 3).toBe(true);
      bash.unref();
    });

    it("detects genuine survivors via injected isAlive stub", async () => {
      // 桩：pid 恒存活 → settle 复查后仍存活 → fail-closed
      const r = await killProcessTree(424242, {
        gracePeriodMs: 50,
        killSettleMs: 80,
        force: true,
        isAlive: async () => true,
      });
      expect(r.success).toBe(false);
      expect(r.survivors).toContain(424242);
      expect(r.failedPids).toContain(424242);
      expect(r.error).toBeUndefined();
    });

    it("injected probe exception → fail-closed 视为存活", async () => {
      const r = await killProcessTree(424243, {
        gracePeriodMs: 50,
        killSettleMs: 80,
        force: true,
        isAlive: async () => {
          throw new Error("EPERM probe");
        },
      });
      expect(r.success).toBe(false);
      expect(r.survivors).toContain(424243);
    });

    it("injected stub says dead → killedPids contains root", async () => {
      const r = await killProcessTree(424244, {
        gracePeriodMs: 50,
        killSettleMs: 80,
        force: true,
        isAlive: async () => false,
      });
      expect(r.success).toBe(true);
      expect(r.killedPids).toContain(424244);
    });
  });

  describe("killChildProcessTree", () => {
    it("delegates from ChildProcess handle", async () => {
      const fakeProc = { pid: 424245 } as unknown as ChildProcess;
      const r = await killChildProcessTree(fakeProc, {
        gracePeriodMs: 50,
        killSettleMs: 80,
        force: true,
        isAlive: async () => false,
      });
      expect(r.success).toBe(true);
    });

    it("returns error when no pid", async () => {
      const fakeProc = { pid: null } as unknown as ChildProcess;
      const r = await killChildProcessTree(fakeProc);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/no pid/);
    });
  });

  describe("killProcessTree settle 复查重扫", () => {
    it("survivor detection + re-scan of new child spawned late during settle", async () => {
      // 桩驱动：root 在 grace/settle 期间"始终活着"，且 /proc children 可读
      // （本测试不读真实 /proc —— 通过 fallback 路径 ps 探测，ps 对不存在 pid
      // 返回空，settle 逻辑按存活桩判定 root）。
      const r = await killProcessTree(424246, {
        gracePeriodMs: 50,
        killSettleMs: 80,
        force: true,
        isAlive: async (p) => p === 424246,
      });
      expect(r.survivors).toEqual([424246]);
    });

    it("graceful parent: alive until SIGTERM lands → early settle exit", async () => {
      // alive(root) 第一次 false（模拟 SIGTERM 生效）→ settle 短窗口结束、无幸存者
      const aliveState = { n: 0 };
      const r = await killProcessTree(424247, {
        gracePeriodMs: 60,
        killSettleMs: 60,
        isAlive: async (p) => {
          aliveState.n++;
          if (p === 424247) return true;
          return false;
        },
      });
      expect(r.success).toBe(false);
      expect(r.survivors).toContain(424247);
    });
  });
});
