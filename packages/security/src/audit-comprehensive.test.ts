// 综合审计集成测试：验证 AuditCenter.runComprehensiveAudit 合并 5 个模块发现并按 severity 排序。
import { describe, it, expect, beforeEach } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { AuditCenter } from "./audit-center";
import type { ComprehensiveAuditInput } from "./audit-center";

// ═══════════════════════════════════════════════════════════
// 测试套件：AuditCenter.runComprehensiveAudit（综合审计集成）
// ═══════════════════════════════════════════════════════════

describe("AuditCenter.runComprehensiveAudit > 集成", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let center: AuditCenter;

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    center = new AuditCenter(registry, eventBus);
  });

  it("空 input 返回空 findings 与零计数 summary", () => {
    const result = center.runComprehensiveAudit({});
    expect(result.findings).toHaveLength(0);
    expect(result.summary.total).toBe(0);
    expect(result.summary.bySeverity.error).toBe(0);
    expect(result.summary.bySeverity.warning).toBe(0);
    expect(result.summary.bySeverity.info).toBe(0);
    for (const mod of ["config", "channel", "tool-policy", "trust-model", "gateway"] as const) {
      expect(result.summary.byModule[mod]).toBe(0);
    }
  });

  it("合并多模块发现并按 severity 降序排序（error > warning > info）", () => {
    const input: ComprehensiveAuditInput = {
      config: { config: { allowEval: true, debug: "no" } },
      channels: {
        channels: [
          { id: "w1", type: "wechat", enabled: true, config: { debug: true } },
        ],
      },
      gateway: {
        gateway: {
          host: "127.0.0.1",
          port: 27788,
          cors: { origin: "*", credentials: false },
          auth: { enabled: true },
          tls: { enabled: true },
          rateLimit: { enabled: true },
        },
      },
    };
    const result = center.runComprehensiveAudit(input);

    // 至少应包含 config error、channel info、gateway warning
    expect(result.summary.bySeverity.error).toBeGreaterThan(0);
    expect(result.summary.bySeverity.warning).toBeGreaterThan(0);
    expect(result.summary.bySeverity.info).toBeGreaterThan(0);

    // 验证 severity 降序：第一条不低于下一条
    for (let i = 1; i < result.findings.length; i++) {
      const prev = result.findings[i - 1];
      const curr = result.findings[i];
      const rank = { error: 3, warning: 2, info: 1 };
      expect(rank[prev.severity]).toBeGreaterThanOrEqual(rank[curr.severity]);
    }
  });

  it("module 字段正确映射到来源模块", () => {
    const input: ComprehensiveAuditInput = {
      toolPolicies: {
        policies: [{ allowed: ["*"], denied: [] }],
      },
      trustModel: {
        skills: [
          {
            id: "u1",
            name: "bad",
            author: "x",
            source: "url",
            trustLevel: "untrusted",
            permissions: { allowSubprocess: true },
          },
        ],
      },
    };
    const result = center.runComprehensiveAudit(input);
    expect(result.findings.some((f) => f.module === "tool-policy")).toBe(true);
    expect(result.findings.some((f) => f.module === "trust-model")).toBe(true);
    expect(result.summary.byModule["tool-policy"]).toBeGreaterThan(0);
    expect(result.summary.byModule["trust-model"]).toBeGreaterThan(0);
  });

  it("仅提供部分模块时跳过未提供的模块", () => {
    // 用 JSON.parse 构造，使 __proto__ 成为自有可枚举属性
    const protoConfig = JSON.parse('{"__proto__":1}') as Record<string, unknown>;
    const result = center.runComprehensiveAudit({
      config: { config: protoConfig },
    });
    expect(result.summary.byModule.config).toBeGreaterThan(0);
    expect(result.summary.byModule.channel).toBe(0);
    expect(result.summary.byModule.gateway).toBe(0);
  });

  it("携带模块特有字段（path/channelId/entityId 等）", () => {
    const result = center.runComprehensiveAudit({
      config: { config: { host: "0.0.0.0" } },
      channels: {
        channels: [
          { id: "c1", type: "wechat", enabled: false, config: { token: "plain" } },
        ],
      },
    });
    const cfgFinding = result.findings.find((f) => f.module === "config");
    expect(cfgFinding?.path).toBeDefined();
    const chFinding = result.findings.find((f) => f.module === "channel");
    expect(chFinding?.channelId).toBe("c1");
    expect(chFinding?.channelType).toBe("wechat");
  });
});
