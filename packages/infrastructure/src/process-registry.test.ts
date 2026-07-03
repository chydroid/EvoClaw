import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  ProcessRegistry,
  processRegistry,
  formatUptimeShort,
} from "./process-registry";

describe("process-registry", () => {
  describe("formatUptimeShort", () => {
    it("formats sub-minute seconds with an 's' suffix", () => {
      expect(formatUptimeShort(0)).toBe("0s");
      expect(formatUptimeShort(30)).toBe("30s");
      expect(formatUptimeShort(59)).toBe("59s");
    });

    it("regression: formats 65 seconds as '1m 5s' (param is seconds, not ms)", () => {
      // The function takes SECONDS — 65 → "1m 5s" (contains "1m").
      const out = formatUptimeShort(65);
      expect(out).toContain("1m");
      expect(out).toBe("1m 5s");
    });

    it("formats hours and minutes", () => {
      expect(formatUptimeShort(3700)).toBe("1h 1m");
      expect(formatUptimeShort(7200)).toBe("2h");
    });

    it("clamps negative input to 0s", () => {
      expect(formatUptimeShort(-5)).toBe("0s");
    });
  });

  describe("singleton", () => {
    it("processRegistry is a ProcessRegistry instance", () => {
      expect(processRegistry).toBeInstanceOf(ProcessRegistry);
    });
  });

  describe("register / poll / readLog / appendOutput", () => {
    let reg: ProcessRegistry;

    beforeEach(() => {
      reg = new ProcessRegistry();
    });

    it("registers a session and exposes it via poll", () => {
      const session = reg.register({ command: "echo hi", sessionKey: "s1" });
      expect(session.id).toMatch(/^proc_/);
      expect(session.command).toBe("echo hi");
      expect(session.exited).toBe(false);
      expect(session.finishedAt).toBeNull();

      const polled = reg.poll(session.id);
      expect(polled).not.toBeNull();
      expect(polled!.id).toBe(session.id);
    });

    it("appendOutput accumulates into the rolling buffer and readLog returns it", () => {
      const session = reg.register({ command: "echo hi" });
      reg.appendOutput(session.id, "first line\n");
      reg.appendOutput(session.id, "second line\n");
      expect(reg.readLog(session.id)).toContain("first line");
      expect(reg.readLog(session.id)).toContain("second line");
    });

    it("appendOutput is a no-op for an unknown session", () => {
      expect(() => reg.appendOutput("nope", "data")).not.toThrow();
    });

    it("strips bash shell-noise lines from the output buffer", () => {
      const session = reg.register({ command: "bash -c echo" });
      reg.appendOutput(
        session.id,
        "bash: cannot set terminal process group: Not a tty\nreal output\n",
      );
      const log = reg.readLog(session.id);
      expect(log).not.toContain("cannot set terminal process group");
      expect(log).toContain("real output");
    });
  });

  describe("markCompleted", () => {
    let reg: ProcessRegistry;

    beforeEach(() => {
      reg = new ProcessRegistry();
    });

    it("moves the session from running to finished and sets finishedAt", () => {
      const session = reg.register({ command: "echo hi" });
      reg.markCompleted(session.id, 0, "exited", "");
      expect(reg.listRunning().find((s) => s.id === session.id)).toBeUndefined();
      const finished = reg.listFinished().find((s) => s.id === session.id);
      expect(finished).toBeDefined();
      expect(finished!.exited).toBe(true);
      expect(finished!.exitCode).toBe(0);
      expect(finished!.finishedAt).not.toBeNull();
    });

    it("queues a completion notification when notifyOnComplete is true", () => {
      const session = reg.register({ command: "echo hi", notifyOnComplete: true });
      reg.markCompleted(session.id, 0);
      const events = reg.drainNotifications();
      expect(events.some((e) => e.sessionId === session.id && e.type === "completion")).toBe(true);
    });
  });

  describe("kill — ESRCH handling (regression)", () => {
    let reg: ProcessRegistry;

    beforeEach(() => {
      reg = new ProcessRegistry();
    });

    it("regression: an ESRCH from kill() still marks the session finished and returns true", () => {
      // The bug: when the process had already exited, ChildProcess.kill()
      // throws ESRCH. The fix catches ESRCH/ENOENT, marks the session
      // completed (already_exited), and returns true — instead of leaving the
      // session stranded in the running map.
      const esrchErr = Object.assign(new Error("ESRCH"), { code: "ESRCH" as const });
      const mockProc = {
        kill: vi.fn(() => {
          throw esrchErr;
        }),
      } as unknown as ChildProcess;

      const session = reg.register({ command: "sleep 10", process: mockProc });
      const result = reg.kill(session.id);

      expect(result).toBe(true);
      expect(mockProc.kill).toHaveBeenCalledTimes(1);
      // Session must NOT remain in running.
      expect(reg.listRunning().find((s) => s.id === session.id)).toBeUndefined();
      // Session must be in finished with reason already_exited.
      const finished = reg.listFinished().find((s) => s.id === session.id);
      expect(finished).toBeDefined();
      expect(finished!.completionReason).toBe("already_exited");
      expect(finished!.terminationSource).toBe("process.kill");
    });

    it("a normal kill marks the session finished with reason 'killed'", () => {
      const mockProc = {
        kill: vi.fn(() => true),
      } as unknown as ChildProcess;
      const session = reg.register({ command: "sleep 10", process: mockProc });
      const result = reg.kill(session.id);
      expect(result).toBe(true);
      const finished = reg.listFinished().find((s) => s.id === session.id);
      expect(finished).toBeDefined();
      expect(finished!.completionReason).toBe("killed");
    });

    it("returns false when the session has no process handle", () => {
      const session = reg.register({ command: "sleep 10", process: null });
      expect(reg.kill(session.id)).toBe(false);
    });

    it("returns false for a non-ESRCH kill error", () => {
      const otherErr = Object.assign(new Error("EPERM"), { code: "EPERM" as const });
      const mockProc = {
        kill: vi.fn(() => {
          throw otherErr;
        }),
      } as unknown as ChildProcess;
      const session = reg.register({ command: "sleep 10", process: mockProc });
      expect(reg.kill(session.id)).toBe(false);
      // Session stays in running.
      expect(reg.listRunning().find((s) => s.id === session.id)).toBeDefined();
    });
  });

  describe("pruneExpired — uses finishedAt (regression)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("regression: a long-running task that JUST finished is NOT pruned", () => {
      // The bug: pruneExpired used startedAt, so a long task that just
      // finished was immediately pruned (startedAt old > TTL). The fix uses
      // finishedAt as the TTL anchor.
      const reg = new ProcessRegistry();
      const session = reg.register({ command: "long-running" }); // startedAt = T0

      // Advance well past the finished-session TTL (1800s) so startedAt is old.
      vi.advanceTimersByTime(2_000_000);

      // NOW the task finishes — finishedAt is recent.
      reg.markCompleted(session.id, 0);

      // pruneExpired must NOT remove it (finishedAt age < TTL).
      expect(reg.pruneExpired()).toBe(0);
      expect(reg.listFinished().find((s) => s.id === session.id)).toBeDefined();

      // Advance past the TTL measured from finishedAt.
      vi.advanceTimersByTime(1_800_000 + 1);
      expect(reg.pruneExpired()).toBe(1);
      expect(reg.listFinished().find((s) => s.id === session.id)).toBeUndefined();
    });

    it("prunes nothing when there are no finished sessions", () => {
      const reg = new ProcessRegistry();
      expect(reg.pruneExpired()).toBe(0);
    });
  });

  describe("killAll", () => {
    it("kills all running sessions for a sessionKey and returns the count", () => {
      const reg = new ProcessRegistry();
      const mk = (): ChildProcess => ({ kill: vi.fn(() => true) } as unknown as ChildProcess);
      const a = reg.register({ command: "a", sessionKey: "S1", process: mk() });
      const b = reg.register({ command: "b", sessionKey: "S2", process: mk() });
      const c = reg.register({ command: "c", sessionKey: "S1", process: mk() });

      const killed = reg.killAll("S1");
      expect(killed).toBe(2);
      expect(reg.listRunning().find((s) => s.id === a.id)).toBeUndefined();
      expect(reg.listRunning().find((s) => s.id === c.id)).toBeUndefined();
      expect(reg.listRunning().find((s) => s.id === b.id)).toBeDefined();
    });
  });
});
