import { describe, it, expect } from "vitest";
import { auditTrustModel } from "./audit-trust-model";
import type { TrustModelSkill, TrustModelAgent } from "./audit-trust-model";

// ═══════════════════════════════════════════════════════════
// 测试套件：audit-trust-model（信任模型审计）
// 对齐 openclaw-main src/security/audit-plugins-trust.ts + audit-trust-model.test
// ═══════════════════════════════════════════════════════════

function skill(over: Partial<TrustModelSkill>): TrustModelSkill {
  return {
    id: "s1",
    name: "skill-1",
    author: "tester",
    source: "bundled",
    permissions: {},
    ...over,
  };
}

describe("audit-trust-model > untrusted skill 危险能力", () => {
  it("untrusted skill 允许 subprocess 报 error", () => {
    const findings = auditTrustModel({
      skills: [
        skill({
          id: "u1",
          name: "bad",
          source: "url",
          trustLevel: "untrusted",
          permissions: { allowSubprocess: true },
        }),
      ],
    });
    const hit = findings.find((f) => f.rule === "trust-untrusted-subprocess");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
    expect(hit!.entityId).toBe("u1");
    expect(hit!.entityType).toBe("skill");
  });

  it("untrusted skill 允许 network 报 error", () => {
    const findings = auditTrustModel({
      skills: [
        skill({ source: "url", trustLevel: "untrusted", permissions: { allowNetwork: true } }),
      ],
    });
    expect(findings.some((f) => f.rule === "trust-untrusted-network")).toBe(true);
  });

  it("untrusted skill 允许 filesystem 报 error", () => {
    const findings = auditTrustModel({
      skills: [
        skill({ source: "url", trustLevel: "untrusted", permissions: { allowFileSystem: true } }),
      ],
    });
    expect(findings.some((f) => f.rule === "trust-untrusted-filesystem")).toBe(true);
  });
});

describe("audit-trust-model > community skill 限制缺失", () => {
  it("community skill 允许 network 且无 allowedHosts 报 warning", () => {
    const findings = auditTrustModel({
      skills: [
        skill({
          source: "marketplace",
          trustLevel: "community",
          permissions: { allowNetwork: true },
        }),
      ],
    });
    const hit = findings.find((f) => f.rule === "trust-community-network-no-hosts");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
  });

  it("community skill 允许 network 且配置 allowedHosts 不报警", () => {
    const findings = auditTrustModel({
      skills: [
        skill({
          source: "marketplace",
          trustLevel: "community",
          permissions: { allowNetwork: true, allowedHosts: ["api.example.com"] },
        }),
      ],
    });
    expect(findings.some((f) => f.rule === "trust-community-network-no-hosts")).toBe(false);
  });

  it("community skill 允许 filesystem 且无 allowedPaths 报 warning", () => {
    const findings = auditTrustModel({
      skills: [
        skill({
          source: "workspace",
          trustLevel: "community",
          permissions: { allowFileSystem: true },
        }),
      ],
    });
    expect(findings.some((f) => f.rule === "trust-workspace-fs-no-paths")).toBe(true);
  });
});

describe("audit-trust-model > marketplace 未签名", () => {
  it("marketplace skill 未验证签名报 warning", () => {
    const findings = auditTrustModel({
      skills: [skill({ id: "m1", source: "marketplace", permissions: {} })],
    });
    const hit = findings.find((f) => f.rule === "trust-marketplace-unsigned");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
  });

  it("marketplace skill 已验证签名不报警", () => {
    const findings = auditTrustModel({
      skills: [
        skill({
          id: "m1",
          source: "marketplace",
          permissions: {},
          ...({ signatureVerified: true } as Partial<TrustModelSkill>),
        }),
      ],
    });
    expect(findings.some((f) => f.rule === "trust-marketplace-unsigned")).toBe(false);
  });
});

describe("audit-trust-model > 信任跨越", () => {
  it("低信任 agent 无 toolPolicyRef 且存在 trusted skill 时报 warning", () => {
    const findings = auditTrustModel({
      skills: [skill({ id: "t1", source: "bundled", permissions: {} })], // bundled => trusted
      agents: [
        { id: "a1", name: "low-agent", trustLevel: "community" },
      ] as TrustModelAgent[],
    });
    const hit = findings.find((f) => f.rule === "trust-cross-boundary");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
    expect(hit!.entityType).toBe("agent");
  });

  it("低信任 agent 配置 toolPolicyRef 时不报跨越", () => {
    const findings = auditTrustModel({
      skills: [skill({ source: "bundled", permissions: {} })],
      agents: [
        { id: "a1", name: "low-agent", trustLevel: "community", toolPolicyRef: "strict-1" },
      ] as TrustModelAgent[],
    });
    expect(findings.some((f) => f.rule === "trust-cross-boundary")).toBe(false);
  });

  it("不存在 trusted skill 时不报跨越", () => {
    const findings = auditTrustModel({
      skills: [skill({ source: "url", trustLevel: "untrusted", permissions: {} })],
      agents: [{ id: "a1", name: "low-agent", trustLevel: "community" }] as TrustModelAgent[],
    });
    expect(findings.some((f) => f.rule === "trust-cross-boundary")).toBe(false);
  });
});

describe("audit-trust-model > 边界情况", () => {
  it("空 skills 返回空发现", () => {
    expect(auditTrustModel({ skills: [] })).toHaveLength(0);
  });

  it("bundled skill 无任何危险权限不报警", () => {
    const findings = auditTrustModel({
      skills: [skill({ source: "bundled", permissions: {} })],
    });
    expect(findings).toHaveLength(0);
  });
});
