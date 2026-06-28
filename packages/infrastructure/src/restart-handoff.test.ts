/**
 * restart-handoff.test.ts — Supervisor 交接测试
 *
 * 真实 spawn 命令在 CI 中不可控，因此主要测试：
 * - 测试模式短路
 * - 内部辅助函数
 * - 不支持的平台回退
 */

import { describe, it, expect } from "vitest";
import {
  triggerGatewayRestart,
  __testing,
} from "./restart-handoff";

describe("restart-handoff", () => {
  describe("triggerGatewayRestart (test mode)", () => {
    it("returns ok in test mode", () => {
      const result = triggerGatewayRestart({
        env: { VITEST: "1", ...process.env },
        skipStaleCleanup: true,
      });
      expect(result.ok).toBe(true);
      expect(result.method).toBe("test-mode");
      expect(result.tried).toEqual([]);
    });

    it("returns ok when NODE_ENV=test", () => {
      const result = triggerGatewayRestart({
        env: { NODE_ENV: "test", ...process.env },
        skipStaleCleanup: true,
      });
      expect(result.ok).toBe(true);
      expect(result.method).toBe("test-mode");
    });

    it("returns ok when process.env.VITEST is set", () => {
      const original = process.env.VITEST;
      process.env.VITEST = "1";
      try {
        const result = triggerGatewayRestart({
          skipStaleCleanup: true,
        });
        expect(result.ok).toBe(true);
        expect(result.method).toBe("test-mode");
      } finally {
        if (original === undefined) {
          delete process.env.VITEST;
        } else {
          process.env.VITEST = original;
        }
      }
    });
  });

  describe("__testing.normalizeSystemdUnit", () => {
    it("returns default unit when raw is empty", () => {
      expect(__testing.normalizeSystemdUnit(undefined, undefined)).toBe("evoclaw-gateway.service");
    });

    it("returns default unit when raw is whitespace", () => {
      expect(__testing.normalizeSystemdUnit("   ", undefined)).toBe("evoclaw-gateway.service");
    });

    it("uses profile in default unit", () => {
      expect(__testing.normalizeSystemdUnit(undefined, "prod")).toBe("evoclaw-gateway-prod.service");
    });

    it("trims whitespace from profile", () => {
      expect(__testing.normalizeSystemdUnit(undefined, "  prod  ")).toBe("evoclaw-gateway-prod.service");
    });

    it("appends .service suffix if missing", () => {
      expect(__testing.normalizeSystemdUnit("custom-unit", undefined)).toBe("custom-unit.service");
    });

    it("preserves .service suffix if present", () => {
      expect(__testing.normalizeSystemdUnit("custom.service", undefined)).toBe("custom.service");
    });

    it("trims raw input", () => {
      expect(__testing.normalizeSystemdUnit("  custom-unit  ", undefined)).toBe("custom-unit.service");
    });

    it("ignores profile when raw is provided", () => {
      expect(__testing.normalizeSystemdUnit("custom", "prod")).toBe("custom.service");
    });
  });

  describe("__testing.resolveLaunchdLabel", () => {
    it("returns default label when profile is undefined", () => {
      expect(__testing.resolveLaunchdLabel(undefined)).toBe("ai.evoclaw.gateway");
    });

    it("returns default label when profile is empty", () => {
      expect(__testing.resolveLaunchdLabel("")).toBe("ai.evoclaw.gateway");
    });

    it("returns default label when profile is whitespace", () => {
      expect(__testing.resolveLaunchdLabel("   ")).toBe("ai.evoclaw.gateway");
    });

    it("appends profile to label", () => {
      expect(__testing.resolveLaunchdLabel("prod")).toBe("ai.evoclaw.gateway.prod");
    });

    it("trims profile", () => {
      expect(__testing.resolveLaunchdLabel("  prod  ")).toBe("ai.evoclaw.gateway.prod");
    });
  });

  describe("__testing.resolveSchtasksName", () => {
    it("returns default name when env not set", () => {
      expect(__testing.resolveSchtasksName({})).toBe("EvoclawGateway");
    });

    it("uses EVOCLAW_SCHTASKS_NAME when set", () => {
      expect(__testing.resolveSchtasksName({ EVOCLAW_SCHTASKS_NAME: "CustomTask" })).toBe("CustomTask");
    });

    it("trims EVOCLAW_SCHTASKS_NAME", () => {
      expect(__testing.resolveSchtasksName({ EVOCLAW_SCHTASKS_NAME: "  CustomTask  " })).toBe("CustomTask");
    });

    it("returns default when EVOCLAW_SCHTASKS_NAME is empty", () => {
      expect(__testing.resolveSchtasksName({ EVOCLAW_SCHTASKS_NAME: "" })).toBe("EvoclawGateway");
    });

    it("returns default when EVOCLAW_SCHTASKS_NAME is whitespace", () => {
      expect(__testing.resolveSchtasksName({ EVOCLAW_SCHTASKS_NAME: "   " })).toBe("EvoclawGateway");
    });
  });

  describe("__testing.formatSpawnDetail", () => {
    it("formats error message when error is Error", () => {
      const result = __testing.formatSpawnDetail({ error: new Error("boom") });
      expect(result).toBe("boom");
    });

    it("formats error message when error is string", () => {
      const result = __testing.formatSpawnDetail({ error: "string error" });
      expect(result).toBe("string error");
    });

    it("formats stderr when no error", () => {
      const result = __testing.formatSpawnDetail({ stderr: "stderr output", stdout: "" });
      expect(result).toBe("stderr output");
    });

    it("formats stdout when no error and no stderr", () => {
      const result = __testing.formatSpawnDetail({ stderr: "", stdout: "stdout output" });
      expect(result).toBe("stdout output");
    });

    it("formats exit status when no error/stderr/stdout", () => {
      const result = __testing.formatSpawnDetail({ status: 42 });
      expect(result).toBe("exit 42");
    });

    it("returns unknown error when nothing available", () => {
      const result = __testing.formatSpawnDetail({});
      expect(result).toBe("unknown error");
    });

    it("collapses whitespace in stderr", () => {
      const result = __testing.formatSpawnDetail({ stderr: "  line1\n  line2  " });
      expect(result).toBe("line1 line2");
    });

    it("handles non-Error non-string error", () => {
      const result = __testing.formatSpawnDetail({ error: { code: 42 } });
      // Should produce some string output
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("handles circular reference in error object", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const result = __testing.formatSpawnDetail({ error: circular });
      expect(result).toBe("unknown error");
    });
  });

  describe("constants", () => {
    it("SPAWN_TIMEOUT_MS is 2000", () => {
      expect(__testing.SPAWN_TIMEOUT_MS).toBe(2000);
    });

    it("LAUNCHCTL_ALREADY_LOADED_EXIT_CODE is 37", () => {
      expect(__testing.LAUNCHCTL_ALREADY_LOADED_EXIT_CODE).toBe(37);
    });

    it("DEFAULT_SYSTEMD_UNIT is evoclaw-gateway.service", () => {
      expect(__testing.DEFAULT_SYSTEMD_UNIT).toBe("evoclaw-gateway.service");
    });

    it("DEFAULT_LAUNCHD_LABEL is ai.evoclaw.gateway", () => {
      expect(__testing.DEFAULT_LAUNCHD_LABEL).toBe("ai.evoclaw.gateway");
    });

    it("DEFAULT_SCHTASKS_NAME is EvoclawGateway", () => {
      expect(__testing.DEFAULT_SCHTASKS_NAME).toBe("EvoclawGateway");
    });
  });
});
