import { describe, it, expect } from "vitest";
import { auditChannels } from "./audit-channel";
import type { ChannelAuditInput, ChannelAuditChannel } from "./audit-channel";

// ═══════════════════════════════════════════════════════════
// 测试套件：audit-channel（渠道审计）
// 对齐 openclaw-main src/security/audit-channel.ts（DM policy/token/webhook）
// ═══════════════════════════════════════════════════════════

function ch(over: Partial<ChannelAuditChannel> & { id: string; type: string }): ChannelAuditChannel {
  return { enabled: true, config: {}, ...over };
}

function audit(channels: ChannelAuditChannel[]): ReturnType<typeof auditChannels> {
  return auditChannels({ channels });
}

describe("audit-channel > 明文凭证", () => {
  it("明文 token 报 error 并标注长度", () => {
    const findings = audit([ch({ id: "w1", type: "wechat", config: { token: "plain-token-12345" } })]);
    const hit = findings.find((f) => f.rule === "channel-plaintext-credential");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
    expect(hit!.channelId).toBe("w1");
    expect(hit!.channelType).toBe("wechat");
    expect(hit!.message).toContain("token");
  });

  it("${ENV_VAR} 引用的 token 不报明文", () => {
    const findings = audit([ch({ id: "w1", type: "wechat", config: { token: "${WECHAT_TOKEN}" } })]);
    expect(findings.some((f) => f.rule === "channel-plaintext-credential")).toBe(false);
  });

  it("appSecret/botToken 等多种凭证键均识别", () => {
    const findings = audit([
      ch({ id: "f1", type: "feishu", config: { appSecret: "abc123" } }),
      ch({ id: "t1", type: "telegram", config: { botToken: "555:ABC" } }),
    ]);
    expect(findings.filter((f) => f.rule === "channel-plaintext-credential")).toHaveLength(2);
  });

  it("空字符串凭证不报明文", () => {
    const findings = audit([ch({ id: "w1", type: "wechat", config: { token: "" } })]);
    expect(findings.some((f) => f.rule === "channel-plaintext-credential")).toBe(false);
  });
});

describe("audit-channel > 不安全 webhook", () => {
  it("HTTP webhookUrl 报 warning", () => {
    const findings = audit([
      ch({ id: "w1", type: "wechat", config: { webhookUrl: "http://example.com/hook" } }),
    ]);
    const hit = findings.find((f) => f.rule === "channel-insecure-webhook");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
  });

  it("HTTPS webhookUrl 不报警", () => {
    const findings = audit([
      ch({ id: "w1", type: "wechat", config: { webhookUrl: "https://example.com/hook" } }),
    ]);
    expect(findings.some((f) => f.rule === "channel-insecure-webhook")).toBe(false);
  });
});

describe("audit-channel > 缺失必需配置", () => {
  it("wechat 已启用但缺 token 报 error", () => {
    const findings = audit([ch({ id: "w1", type: "wechat", enabled: true, config: {} })]);
    const hit = findings.find((f) => f.rule === "channel-missing-required-config");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
    expect(hit!.message).toContain("token");
  });

  it("未启用渠道不报缺失必需配置", () => {
    const findings = audit([ch({ id: "w1", type: "wechat", enabled: false, config: {} })]);
    expect(findings.some((f) => f.rule === "channel-missing-required-config")).toBe(false);
  });
});

describe("audit-channel > 开放访问与调试模式", () => {
  it("allowAllUsers=true 且无白名单报 warning", () => {
    const findings = audit([
      ch({ id: "w1", type: "wechat", config: { allowAllUsers: true } }),
    ]);
    const hit = findings.find((f) => f.rule === "channel-open-access");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
  });

  it("allowAllUsers=true 但 allowFrom 含白名单不报开放访问", () => {
    const findings = audit([
      ch({
        id: "w1",
        type: "wechat",
        config: { allowAllUsers: true, allowFrom: ["user-1", "user-2"] },
      }),
    ]);
    expect(findings.some((f) => f.rule === "channel-open-access")).toBe(false);
  });

  it("allowFrom 含通配 * 视为无白名单（仍报开放访问）", () => {
    const findings = audit([
      ch({
        id: "w1",
        type: "wechat",
        config: { allowAllUsers: true, allowFrom: ["*"] },
      }),
    ]);
    expect(findings.some((f) => f.rule === "channel-open-access")).toBe(true);
  });

  it("debug=true 报 info", () => {
    const findings = audit([
      ch({ id: "w1", type: "wechat", config: { debug: true } }),
    ]);
    const hit = findings.find((f) => f.rule === "channel-debug-enabled");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("info");
  });

  it("dmPolicy=open 视为开放访问", () => {
    const findings = audit([
      ch({ id: "w1", type: "wechat", config: { dmPolicy: "open" } }),
    ]);
    expect(findings.some((f) => f.rule === "channel-open-access")).toBe(true);
  });
});

describe("audit-channel > 边界情况", () => {
  it("空渠道列表返回空发现", () => {
    expect(audit([])).toHaveLength(0);
  });

  it("未知渠道类型不报缺失必需配置（不命中 REQUIRED_KEYS_BY_TYPE）", () => {
    const findings = audit([ch({ id: "x1", type: "unknown", enabled: true, config: {} })]);
    expect(findings.some((f) => f.rule === "channel-missing-required-config")).toBe(false);
  });
});
