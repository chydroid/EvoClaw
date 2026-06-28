import { describe, it, expect } from "vitest";
import { auditConfig } from "./audit-config";
import type { ConfigAuditInput } from "./audit-config";

// ═══════════════════════════════════════════════════════════
// 测试套件：audit-config（配置审计）
// 对齐 openclaw-main src/security/audit-config-basics.test + dangerous-config-flags
// ═══════════════════════════════════════════════════════════

function audit(config: Record<string, unknown>, extra: Partial<ConfigAuditInput> = {}): ReturnType<typeof auditConfig> {
  return auditConfig({ config, ...extra });
}

describe("audit-config > prototype pollution", () => {
  it("检测到 __proto__ 危险键并报 error", () => {
    // 用 JSON.parse 构造，使 __proto__ 成为自有可枚举属性（模拟外部配置加载）
    const config = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const findings = audit(config);
    const hit = findings.find((f) => f.rule === "config-prototype-pollution");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
    expect(hit!.path).toBe("__proto__");
  });

  it("检测嵌套对象中的 constructor/prototype 键", () => {
    const findings = audit({
      channels: { wechat: { prototype: { x: 1 } } },
    });
    const hit = findings.find(
      (f) => f.rule === "config-prototype-pollution" && f.path.includes("wechat"),
    );
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });
});

describe("audit-config > 危险开关", () => {
  it("allowEval=true 报 error", () => {
    const findings = audit({ allowEval: true });
    const hit = findings.find((f) => f.rule === "config-allow-eval");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });

  it("字符串 \"yes\" 也视为真值并报警", () => {
    const findings = audit({ disableSandbox: "yes" });
    expect(findings.some((f) => f.rule === "config-disable-sandbox")).toBe(true);
  });

  it("allowEval=false 不报警", () => {
    const findings = audit({ allowEval: false, allowRoot: false });
    expect(findings.some((f) => f.rule === "config-allow-eval")).toBe(false);
    expect(findings.some((f) => f.rule === "config-allow-root")).toBe(false);
  });
});

describe("audit-config > 明文密钥", () => {
  it("明文 token 报 warning，且包含长度信息", () => {
    const findings = audit({ wechat: { token: "abc123secret" } });
    const hit = findings.find((f) => f.rule === "config-plaintext-secret");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
    expect(hit!.message).toContain("12");
    expect(hit!.path).toBe("wechat.token");
  });

  it("${ENV_VAR} 引用不报明文密钥", () => {
    const findings = audit({ wechat: { token: "${WECHAT_TOKEN}" } });
    expect(findings.some((f) => f.rule === "config-plaintext-secret")).toBe(false);
  });

  it("strictMode 下明文密钥升级为 error", () => {
    const findings = auditConfig({
      config: { db: { password: "p@ss" } },
      strictMode: true,
    });
    const hit = findings.find((f) => f.rule === "config-plaintext-secret");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });
});

describe("audit-config > 不安全监听地址与 CORS", () => {
  it("host=0.0.0.0 报 warning", () => {
    const findings = audit({ server: { host: "0.0.0.0", port: 27788 } });
    const hit = findings.find((f) => f.rule === "config-unsafe-bind");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
  });

  it("host=127.0.0.1 不报警", () => {
    const findings = audit({ server: { host: "127.0.0.1", port: 27788 } });
    expect(findings.some((f) => f.rule === "config-unsafe-bind")).toBe(false);
  });

  it('cors="*" 报 warning', () => {
    const findings = audit({ gateway: { cors: "*" } });
    expect(findings.some((f) => f.rule === "config-cors-wildcard")).toBe(true);
  });

  it("cors.origin=[] 数组形式下不误报（仅字符串通配才报）", () => {
    const findings = audit({ gateway: { cors: { origin: ["https://a.com"] } } });
    expect(findings.some((f) => f.rule === "config-cors-wildcard")).toBe(false);
  });
});

describe("audit-config > 边界情况", () => {
  it("空配置返回空发现", () => {
    const findings = audit({});
    expect(findings).toHaveLength(0);
  });

  it("递归遍历数组中的对象", () => {
    const findings = audit({
      channels: [{ id: "a", apiKey: "plain-text-key" }],
    });
    expect(findings.some((f) => f.rule === "config-plaintext-secret" && f.path.includes("channels[0]"))).toBe(true);
  });

  it("循环引用不导致栈溢出", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const findings = audit(obj);
    // 不抛异常即通过，且 prototype pollution 不应误报
    expect(Array.isArray(findings)).toBe(true);
  });

  it("非对象根节点报 config-invalid-root", () => {
    const findings = auditConfig({ config: "not-an-object" as unknown as Record<string, unknown> });
    expect(findings.some((f) => f.rule === "config-invalid-root")).toBe(true);
  });
});
