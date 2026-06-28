import { describe, it, expect } from "vitest";
import { auditGatewayExposure } from "./audit-gateway-exposure";
import type { GatewayExposureAuditInput } from "./audit-gateway-exposure";

// ═══════════════════════════════════════════════════════════
// 测试套件：audit-gateway-exposure（网关暴露审计）
// 对齐 openclaw-main src/security/audit-gateway-config.ts + audit-gateway-exposure.test
// ═══════════════════════════════════════════════════════════

function gw(over: Partial<GatewayExposureAuditInput["gateway"]>): GatewayExposureAuditInput {
  return {
    gateway: {
      host: "127.0.0.1",
      port: 27788,
      cors: { origin: [], credentials: false },
      auth: { enabled: true },
      tls: { enabled: true },
      rateLimit: { enabled: true },
      ...over,
    },
  };
}

describe("audit-gateway-exposure > 公网绑定", () => {
  it('host="0.0.0.0" 报 warning', () => {
    const findings = auditGatewayExposure(gw({ host: "0.0.0.0", port: 27788 }));
    const hit = findings.find((f) => f.rule === "gateway-public-bind");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
    expect(hit!.message).toContain("27788");
  });

  it('host="127.0.0.1" 不报公网绑定', () => {
    const findings = auditGatewayExposure(gw({ host: "127.0.0.1" }));
    expect(findings.some((f) => f.rule === "gateway-public-bind")).toBe(false);
  });
});

describe("audit-gateway-exposure > 鉴权", () => {
  it("auth.enabled=false 报 error", () => {
    const findings = auditGatewayExposure(gw({ auth: { enabled: false } }));
    const hit = findings.find((f) => f.rule === "gateway-auth-disabled");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });

  it("未提供 auth 默认 enabled=true 不报鉴权关闭", () => {
    const findings = auditGatewayExposure(gw({ auth: undefined }));
    expect(findings.some((f) => f.rule === "gateway-auth-disabled")).toBe(false);
  });
});

describe("audit-gateway-exposure > CORS", () => {
  it('origin="*" + credentials=true 报 error', () => {
    const findings = auditGatewayExposure(
      gw({ cors: { origin: "*", credentials: true } }),
    );
    const hit = findings.find((f) => f.rule === "gateway-cors-credentials-wildcard");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });

  it('origin="*" + credentials=false 报 warning（仅通配）', () => {
    const findings = auditGatewayExposure(
      gw({ cors: { origin: "*", credentials: false } }),
    );
    expect(findings.some((f) => f.rule === "gateway-cors-credentials-wildcard")).toBe(false);
    expect(findings.some((f) => f.rule === "gateway-cors-wildcard")).toBe(true);
  });

  it("origin 数组含通配且 credentials=true 报 error", () => {
    const findings = auditGatewayExposure(
      gw({ cors: { origin: ["https://a.com", "*"], credentials: true } }),
    );
    expect(findings.some((f) => f.rule === "gateway-cors-credentials-wildcard")).toBe(true);
  });
});

describe("audit-gateway-exposure > TLS / rate limit", () => {
  it("tls.enabled=false 报 warning", () => {
    const findings = auditGatewayExposure(gw({ tls: { enabled: false } }));
    expect(findings.some((f) => f.rule === "gateway-tls-disabled")).toBe(true);
  });

  it("rateLimit.enabled=false 报 info", () => {
    const findings = auditGatewayExposure(gw({ rateLimit: { enabled: false } }));
    const hit = findings.find((f) => f.rule === "gateway-rate-limit-disabled");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("info");
  });
});

describe("audit-gateway-exposure > webhook 与 publicUrl", () => {
  it("渠道 webhookUrl 为 HTTP 报 warning", () => {
    const findings = auditGatewayExposure(
      gw({
        host: "127.0.0.1",
        channels: [{ type: "wechat", webhookUrl: "http://example.com/hook" }],
      }),
    );
    const hit = findings.find((f) => f.rule === "gateway-channel-insecure-webhook");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("wechat");
  });

  it("publicUrl 为 HTTP 报 warning", () => {
    const findings = auditGatewayExposure(gw({ publicUrl: "http://gw.example.com" }));
    expect(findings.some((f) => f.rule === "gateway-public-url-insecure")).toBe(true);
  });

  it("HTTPS publicUrl 不报警", () => {
    const findings = auditGatewayExposure(gw({ publicUrl: "https://gw.example.com" }));
    expect(findings.some((f) => f.rule === "gateway-public-url-insecure")).toBe(false);
  });
});

describe("audit-gateway-exposure > 渠道公网暴露但鉴权关闭", () => {
  it("publicExposed=true 且 auth disabled 报 error", () => {
    const findings = auditGatewayExposure(
      gw({
        auth: { enabled: false },
        channels: [{ type: "wechat", publicExposed: true }],
      }),
    );
    const hit = findings.find((f) => f.rule === "gateway-channel-public-no-auth");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });

  it("publicExposed=true 且 auth enabled 不报该规则", () => {
    const findings = auditGatewayExposure(
      gw({
        auth: { enabled: true },
        channels: [{ type: "wechat", publicExposed: true }],
      }),
    );
    expect(findings.some((f) => f.rule === "gateway-channel-public-no-auth")).toBe(false);
  });
});

describe("audit-gateway-exposure > 边界情况", () => {
  it("安全配置（默认）只报少量或零发现", () => {
    const findings = auditGatewayExposure(
      gw({
        host: "127.0.0.1",
        cors: { origin: ["https://a.com"], credentials: false },
        auth: { enabled: true },
        tls: { enabled: true },
        rateLimit: { enabled: true },
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it("完全无 auth/tls/rateLimit 字段时按默认值检测", () => {
    const findings = auditGatewayExposure({
      gateway: {
        host: "127.0.0.1",
        port: 27788,
        cors: { origin: [], credentials: false },
      },
    });
    // tls 默认 enabled=false => 应报 tls-disabled
    expect(findings.some((f) => f.rule === "gateway-tls-disabled")).toBe(true);
    // rateLimit 默认 enabled=false => 应报 rate-limit-disabled
    expect(findings.some((f) => f.rule === "gateway-rate-limit-disabled")).toBe(true);
  });
});
