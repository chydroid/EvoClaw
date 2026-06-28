import { describe, it, expect, beforeEach } from "vitest";
import {
  scanDangerousConfigFlags,
  getDangerousFlag,
  registerDangerousFlag,
  clearCustomDangerousFlags,
  DANGEROUS_CONFIG_FLAGS,
} from "./dangerous-config-flags";

// ═══════════════════════════════════════════════════════════
// 测试套件：dangerous-config-flags（危险配置标记）
// ═══════════════════════════════════════════════════════════

describe("dangerous-config-flags > security.allowEval", () => {
  it("allowEval=true 视为危险", () => {
    const findings = scanDangerousConfigFlags({
      security: { allowEval: true },
    });
    const hit = findings.find((f) => f.key === "security.allowEval");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
    expect(hit!.actualValue).toBe(true);
  });

  it("allowEval=false 视为安全", () => {
    const findings = scanDangerousConfigFlags({
      security: { allowEval: false },
    });
    expect(findings.find((f) => f.key === "security.allowEval")).toBeUndefined();
  });
});

describe("dangerous-config-flags > security.disableSandbox", () => {
  it("disableSandbox=true 视为危险", () => {
    const findings = scanDangerousConfigFlags({
      security: { disableSandbox: true },
    });
    const hit = findings.find((f) => f.key === "security.disableSandbox");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });
});

describe("dangerous-config-flags > security.allowRoot", () => {
  it("allowRoot=true 视为 critical", () => {
    const findings = scanDangerousConfigFlags({
      security: { allowRoot: true },
    });
    const hit = findings.find((f) => f.key === "security.allowRoot");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("critical");
  });
});

describe("dangerous-config-flags > security.dangerouslyDisableAuth", () => {
  it("production 环境下禁用认证视为 critical", () => {
    const findings = scanDangerousConfigFlags(
      { security: { dangerouslyDisableAuth: true } },
      { environment: "production" },
    );
    const hit = findings.find((f) => f.key === "security.dangerouslyDisableAuth");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("critical");
  });

  it("development 环境下不检测（appliesTo 限定）", () => {
    const findings = scanDangerousConfigFlags(
      { security: { dangerouslyDisableAuth: true } },
      { environment: "development" },
    );
    expect(findings.find((f) => f.key === "security.dangerouslyDisableAuth")).toBeUndefined();
  });
});

describe("dangerous-config-flags > gateway.cors.origin", () => {
  it('origin="*" 视为不安全', () => {
    const findings = scanDangerousConfigFlags({
      gateway: { cors: { origin: "*" } },
    });
    const hit = findings.find((f) => f.key === "gateway.cors.origin");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
  });

  it('origin="https://example.com" 视为安全', () => {
    const findings = scanDangerousConfigFlags({
      gateway: { cors: { origin: "https://example.com" } },
    });
    expect(findings.find((f) => f.key === "gateway.cors.origin")).toBeUndefined();
  });
});

describe("dangerous-config-flags > gateway.tls.enabled", () => {
  it("production 环境下 TLS=false 视为 error", () => {
    const findings = scanDangerousConfigFlags(
      { gateway: { tls: { enabled: false } } },
      { environment: "production" },
    );
    const hit = findings.find((f) => f.key === "gateway.tls.enabled");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });

  it("development 环境下 TLS 状态不检测", () => {
    const findings = scanDangerousConfigFlags(
      { gateway: { tls: { enabled: false } } },
      { environment: "development" },
    );
    expect(findings.find((f) => f.key === "gateway.tls.enabled")).toBeUndefined();
  });
});

describe("dangerous-config-flags > gateway.host", () => {
  it('host="0.0.0.0" 视为 warning', () => {
    const findings = scanDangerousConfigFlags({
      gateway: { host: "0.0.0.0" },
    });
    const hit = findings.find((f) => f.key === "gateway.host");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
  });

  it('host="127.0.0.1" 视为安全', () => {
    const findings = scanDangerousConfigFlags({
      gateway: { host: "127.0.0.1" },
    });
    expect(findings.find((f) => f.key === "gateway.host")).toBeUndefined();
  });
});

describe("dangerous-config-flags > logging.redactSecrets", () => {
  it("禁用日志脱敏视为 error", () => {
    const findings = scanDangerousConfigFlags({
      logging: { redactSecrets: false },
    });
    const hit = findings.find((f) => f.key === "logging.redactSecrets");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });
});

describe("dangerous-config-flags > debug.enabled", () => {
  it("production 环境下启用调试视为 warning", () => {
    const findings = scanDangerousConfigFlags(
      { debug: { enabled: true } },
      { environment: "production" },
    );
    const hit = findings.find((f) => f.key === "debug.enabled");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
  });
});

describe("dangerous-config-flags > 集成测试", () => {
  it("多危险配置同时存在时全部检测到", () => {
    const findings = scanDangerousConfigFlags({
      security: { allowEval: true, disableSandbox: true, allowRoot: true },
      gateway: { host: "0.0.0.0", cors: { origin: "*" } },
      logging: { redactSecrets: false },
    });
    expect(findings.length).toBeGreaterThanOrEqual(6);
    const keys = findings.map((f) => f.key);
    expect(keys).toContain("security.allowEval");
    expect(keys).toContain("security.disableSandbox");
    expect(keys).toContain("security.allowRoot");
    expect(keys).toContain("gateway.host");
    expect(keys).toContain("gateway.cors.origin");
    expect(keys).toContain("logging.redactSecrets");
  });

  it("全部安全配置不产生 findings", () => {
    const findings = scanDangerousConfigFlags({
      security: { allowEval: false, disableSandbox: false, allowRoot: false },
      gateway: { host: "127.0.0.1", cors: { origin: "https://example.com" } },
      logging: { redactSecrets: true },
    });
    expect(findings).toHaveLength(0);
  });

  it("未配置的键不产生 findings", () => {
    const findings = scanDangerousConfigFlags({});
    expect(findings).toHaveLength(0);
  });
});

describe("dangerous-config-flags > getDangerousFlag", () => {
  it("能查询已存在的标记", () => {
    const flag = getDangerousFlag("security.allowEval");
    expect(flag).not.toBeNull();
    expect(flag!.severity).toBe("error");
  });

  it("查询不存在的标记返回 null", () => {
    expect(getDangerousFlag("nonexistent.key")).toBeNull();
  });
});

describe("dangerous-config-flags > registerDangerousFlag", () => {
  beforeEach(() => {
    clearCustomDangerousFlags();
  });

  it("注册自定义标记后能扫描到", () => {
    registerDangerousFlag({
      key: "custom.dangerousFlag",
      description: "自定义危险标记",
      severity: "warning",
      safeValues: [false],
    });
    const findings = scanDangerousConfigFlags({
      custom: { dangerousFlag: true },
    });
    const hit = findings.find((f) => f.key === "custom.dangerousFlag");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
  });

  it("注册同 key 自定义标记会覆盖旧值", () => {
    registerDangerousFlag({
      key: "custom.dup",
      description: "v1",
      severity: "info",
      safeValues: [false],
    });
    registerDangerousFlag({
      key: "custom.dup",
      description: "v2",
      severity: "error",
      safeValues: [false],
    });
    const flag = getDangerousFlag("custom.dup");
    expect(flag!.description).toBe("v2");
    expect(flag!.severity).toBe("error");
  });
});

describe("dangerous-config-flags > DANGEROUS_CONFIG_FLAGS", () => {
  it("默认标记列表非空", () => {
    expect(DANGEROUS_CONFIG_FLAGS.length).toBeGreaterThan(0);
  });

  it("所有标记都有 key/description/severity", () => {
    for (const flag of DANGEROUS_CONFIG_FLAGS) {
      expect(typeof flag.key).toBe("string");
      expect(flag.key.length).toBeGreaterThan(0);
      expect(typeof flag.description).toBe("string");
      expect(["info", "warning", "error", "critical"]).toContain(flag.severity);
    }
  });
});
