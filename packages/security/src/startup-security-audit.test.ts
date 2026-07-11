/**
 * startup-security-audit.test.ts — 启动安全审计测试
 * 同时覆盖 advisory-catalog 的公告检测。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import {
  runStartupSecurityAudit,
  resetAuditSentinel,
} from "./startup-security-audit";
import { ADVISORIES, detectCompromised } from "./advisory-catalog";

// ═══════════════════════════════════════════════════════════
// 测试套件：advisory-catalog（安全公告目录）
// ═══════════════════════════════════════════════════════════

describe("advisory-catalog", () => {
  describe("ADVISORIES", () => {
    it("包含至少 1 条公告", () => {
      expect(ADVISORIES.length).toBeGreaterThanOrEqual(1);
    });

    it("每条公告有完整的字段结构", () => {
      for (const adv of ADVISORIES) {
        expect(adv.id).toBeTruthy();
        expect(adv.package).toBeTruthy();
        expect(adv.affectedVersions).toBeTruthy();
        expect(adv.description).toBeTruthy();
        expect(adv.severity).toBeTruthy();
        expect(adv.recommendation).toBeTruthy();
      }
    });
  });

  describe("detectCompromised", () => {
    it("当前项目无受影响包时返回空数组", () => {
      const result = detectCompromised();
      // EvoClaw 项目不依赖 event-stream 或 colors
      const evoclawAdvisories = result.filter(
        (a) => a.package === "event-stream" || a.package === "colors",
      );
      expect(evoclawAdvisories.length).toBe(0);
    });

    it("检测到受影响包时返回对应公告", () => {
      const mockPkg = JSON.stringify({
        dependencies: { "event-stream": "3.3.5" },
      });
      const readSpy = vi.spyOn(fs, "readFileSync");
      readSpy.mockImplementation((p) => {
        if (typeof p === "string" && p.endsWith("package.json")) {
          return mockPkg;
        }
        return Buffer.alloc(0);
      });

      const result = detectCompromised();
      const found = result.find((a) => a.package === "event-stream");
      expect(found).toBeDefined();
      expect(found!.id).toBe("EVOCLAW-ADV-001");
      expect(found!.severity).toBe("critical");

      readSpy.mockRestore();
    });

    it("版本不在受影响范围时不报告", () => {
      const mockPkg = JSON.stringify({
        dependencies: { "event-stream": "3.3.6" },
      });
      const readSpy = vi.spyOn(fs, "readFileSync");
      readSpy.mockImplementation((p) => {
        if (typeof p === "string" && p.endsWith("package.json")) {
          return mockPkg;
        }
        return Buffer.alloc(0);
      });

      const result = detectCompromised();
      expect(result.find((a) => a.package === "event-stream")).toBeUndefined();

      readSpy.mockRestore();
    });

    it("检测版本范围（>=X <Y）", () => {
      const mockPkg = JSON.stringify({
        dependencies: { "colors": "1.4.46" },
      });
      const readSpy = vi.spyOn(fs, "readFileSync");
      readSpy.mockImplementation((p) => {
        if (typeof p === "string" && p.endsWith("package.json")) {
          return mockPkg;
        }
        return Buffer.alloc(0);
      });

      const result = detectCompromised();
      const found = result.find((a) => a.package === "colors");
      expect(found).toBeDefined();
      expect(found!.severity).toBe("high");

      readSpy.mockRestore();
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 测试套件：startup-security-audit（启动安全审计）
// ═══════════════════════════════════════════════════════════

describe("startup-security-audit", () => {
  const originalGetuidDesc = Object.getOwnPropertyDescriptor(process, "getuid");
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalEvoClawHost = process.env.EvoClaw_HOST;

  beforeEach(() => {
    resetAuditSentinel();
  });

  afterEach(() => {
    // 恢复 process.getuid
    if (originalGetuidDesc) {
      Object.defineProperty(process, "getuid", originalGetuidDesc);
    }
    // 恢复 JWT_SECRET
    if (originalJwtSecret !== undefined) {
      process.env.JWT_SECRET = originalJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
    // 恢复 EvoClaw_HOST
    if (originalEvoClawHost !== undefined) {
      process.env.EvoClaw_HOST = originalEvoClawHost;
    } else {
      delete process.env.EvoClaw_HOST;
    }
    vi.restoreAllMocks();
  });

  describe("root 用户检测", () => {
    it("uid=0 时发出警告", () => {
      Object.defineProperty(process, "getuid", {
        value: () => 0,
        configurable: true,
        writable: true,
      });
      const warnings = runStartupSecurityAudit({});
      const hit = warnings.find((w) => w.rule === "startup-root-user");
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe("warning");
      expect(hit!.message).toContain("root");
    });

    it("uid!=0 时不发出 root 警告", () => {
      Object.defineProperty(process, "getuid", {
        value: () => 1000,
        configurable: true,
        writable: true,
      });
      const warnings = runStartupSecurityAudit({});
      expect(warnings.some((w) => w.rule === "startup-root-user")).toBe(false);
    });
  });

  describe("gateway 公网绑定 + JWT_SECRET", () => {
    it("0.0.0.0 且无 JWT_SECRET 时报 error", () => {
      delete process.env.JWT_SECRET;
      const warnings = runStartupSecurityAudit({ gatewayHost: "0.0.0.0" });
      const hit = warnings.find((w) => w.rule === "startup-gateway-public-no-secret");
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe("error");
    });

    it("0.0.0.0 且 JWT_SECRET 为默认值时报 error", () => {
      const warnings = runStartupSecurityAudit({
        gatewayHost: "0.0.0.0",
        jwtSecret: "default",
      });
      const hit = warnings.find((w) => w.rule === "startup-gateway-public-no-secret");
      expect(hit).toBeDefined();
    });

    it("0.0.0.0 且 JWT_SECRET 为空字符串时报 error", () => {
      const warnings = runStartupSecurityAudit({
        gatewayHost: "0.0.0.0",
        jwtSecret: "",
      });
      expect(warnings.some((w) => w.rule === "startup-gateway-public-no-secret")).toBe(true);
    });

    it("0.0.0.0 且 JWT_SECRET 为强值时不报警", () => {
      const warnings = runStartupSecurityAudit({
        gatewayHost: "0.0.0.0",
        jwtSecret: "a-very-strong-and-random-secret-key-12345",
      });
      expect(warnings.some((w) => w.rule === "startup-gateway-public-no-secret")).toBe(false);
    });

    it("127.0.0.1 时不报公网绑定警告", () => {
      delete process.env.JWT_SECRET;
      const warnings = runStartupSecurityAudit({ gatewayHost: "127.0.0.1" });
      expect(warnings.some((w) => w.rule === "startup-gateway-public-no-secret")).toBe(false);
    });
  });

  describe("Docker 环境检测", () => {
    it("/.dockerenv 存在时发出 Docker 警告", () => {
      const existsSpy = vi.spyOn(fs, "existsSync");
      existsSpy.mockImplementation((p) => {
        if (typeof p === "string" && p === "/.dockerenv") return true;
        return false;
      });
      const warnings = runStartupSecurityAudit({});
      const hit = warnings.find((w) => w.rule === "startup-docker-env");
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe("warning");
      expect(hit!.message).toContain("Docker");
    });

    it("/.dockerenv 不存在时不报 Docker 警告", () => {
      const existsSpy = vi.spyOn(fs, "existsSync");
      existsSpy.mockImplementation(() => false);
      const warnings = runStartupSecurityAudit({});
      expect(warnings.some((w) => w.rule === "startup-docker-env")).toBe(false);
    });
  });

  describe("_AUDIT_RAN sentinel", () => {
    it("第二次调用返回空数组", () => {
      const first = runStartupSecurityAudit({});
      const second = runStartupSecurityAudit({});
      expect(Array.isArray(first)).toBe(true);
      expect(second).toEqual([]);
    });

    it("resetAuditSentinel 后可重新运行", () => {
      runStartupSecurityAudit({});
      resetAuditSentinel();
      const result = runStartupSecurityAudit({});
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("无选项时正常执行", () => {
    it("不传参数返回数组", () => {
      const warnings = runStartupSecurityAudit();
      expect(Array.isArray(warnings)).toBe(true);
    });
  });
});
