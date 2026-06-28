import { describe, it, expect } from "vitest";
import { auditToolPolicy } from "./audit-tool-policy";
import type { ToolPolicyEntry } from "./audit-tool-policy";

// ═══════════════════════════════════════════════════════════
// 测试套件：audit-tool-policy（工具策略审计）
// 对齐 openclaw-main src/security/audit-tool-policy.ts（sandbox 工具策略选择）
// ═══════════════════════════════════════════════════════════

function policy(over: Partial<ToolPolicyEntry>): ToolPolicyEntry {
  return { allowed: [], denied: [], ...over };
}

function audit(policies: ToolPolicyEntry[]): ReturnType<typeof auditToolPolicy> {
  return auditToolPolicy({ policies });
}

describe("audit-tool-policy > wildcard allow", () => {
  it('allowed=["*"] 报 error', () => {
    const findings = audit([policy({ allowed: ["*"], denied: ["rm"] })]);
    const hit = findings.find((f) => f.rule === "tool-policy-wildcard-allow");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });

  it("无 agentId 时 base 不含 agentId 字段", () => {
    const findings = audit([policy({ allowed: ["*"], denied: ["x"] })]);
    const hit = findings.find((f) => f.rule === "tool-policy-wildcard-allow");
    expect(hit).toBeDefined();
    expect(hit!.agentId).toBeUndefined();
  });

  it("带 agentId 时 finding 带 agentId", () => {
    const findings = audit([policy({ agentId: "agent-1", allowed: ["*"], denied: ["x"] })]);
    const hit = findings.find((f) => f.rule === "tool-policy-wildcard-allow");
    expect(hit).toBeDefined();
    expect(hit!.agentId).toBe("agent-1");
  });
});

describe("audit-tool-policy > 类别限制缺失", () => {
  it("显式 category=shell 且无 argsPattern 限制报 warning", () => {
    const findings = audit([
      policy({ category: "shell", allowed: ["bash"], denied: [] }),
    ]);
    const hit = findings.find((f) => f.rule === "tool-policy-shell-no-restriction");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
  });

  it("category=web 且无 host 限制报 warning", () => {
    const findings = audit([
      policy({ category: "web", allowed: ["fetch"], denied: [] }),
    ]);
    expect(findings.some((f) => f.rule === "tool-policy-web-no-restriction")).toBe(true);
  });

  it("category=file 且无 path 限制报 warning", () => {
    const findings = audit([
      policy({ category: "file", allowed: ["readFile"], denied: [] }),
    ]);
    expect(findings.some((f) => f.rule === "tool-policy-file-no-restriction")).toBe(true);
  });

  it("提供对应限制条件后不报警", () => {
    const findings = audit([
      policy({
        category: "web",
        allowed: ["fetch"],
        denied: [],
        conditions: [{ type: "host", pattern: "*.example.com", action: "allow" }],
      }),
    ]);
    expect(findings.some((f) => f.rule === "tool-policy-web-no-restriction")).toBe(false);
  });
});

describe("audit-tool-policy > denied 空且通配", () => {
  it('denied=[] 且 allowed=["*"] 同时报两条 error', () => {
    const findings = audit([policy({ allowed: ["*"], denied: [] })]);
    expect(findings.some((f) => f.rule === "tool-policy-wildcard-allow")).toBe(true);
    expect(findings.some((f) => f.rule === "tool-policy-no-deny-with-wildcard")).toBe(true);
  });

  it("denied 非空时仅报 wildcard-allow", () => {
    const findings = audit([policy({ allowed: ["*"], denied: ["rm"] })]);
    expect(findings.some((f) => f.rule === "tool-policy-wildcard-allow")).toBe(true);
    expect(findings.some((f) => f.rule === "tool-policy-no-deny-with-wildcard")).toBe(false);
  });
});

describe("audit-tool-policy > 推断类别", () => {
  it("无 category 但 allowed 含 shell 类工具名时推断并报限制缺失", () => {
    const findings = audit([policy({ allowed: ["bash", "exec"], denied: [] })]);
    expect(findings.some((f) => f.rule === "tool-policy-shell-no-restriction")).toBe(true);
  });

  it("无 category 且 allowed 全为未知工具名时不报限制缺失", () => {
    const findings = audit([policy({ allowed: ["customTool"], denied: [] })]);
    expect(findings.some((f) => f.rule.endsWith("-no-restriction"))).toBe(false);
  });
});

describe("audit-tool-policy > 边界情况", () => {
  it("空策略列表返回空发现", () => {
    expect(audit([])).toHaveLength(0);
  });

  it("空 allowed 且空 denied 不报警", () => {
    const findings = audit([policy({ allowed: [], denied: [] })]);
    expect(findings).toHaveLength(0);
  });
});
