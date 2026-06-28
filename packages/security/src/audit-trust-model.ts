// 信任模型审计：检测信任边界跨越、混信问题。
// 对齐 openclaw-main src/security/audit-plugins-trust.ts + audit-trust-model.test 的核心检查项。
// 输入为已抽象的 skill/agent 列表，避免耦合 plugin-registry / sandbox-tool-policy 内部类型。

export type TrustLevel = "trusted" | "verified" | "community" | "untrusted";

export interface TrustModelSkillPermissions {
  allowNetwork?: boolean;
  allowFileSystem?: boolean;
  allowSubprocess?: boolean;
  allowedHosts?: string[];
  allowedPaths?: string[];
}

export interface TrustModelSkill {
  id: string;
  name: string;
  author: string;
  source: "bundled" | "managed" | "marketplace" | "workspace" | "url";
  trustLevel?: TrustLevel;
  permissions: TrustModelSkillPermissions;
}

export interface TrustModelAgent {
  id: string;
  name: string;
  trustLevel: TrustLevel;
  /** 引用的工具策略 ID（缺失表示无策略约束） */
  toolPolicyRef?: string;
}

export interface TrustModelAuditInput {
  skills: TrustModelSkill[];
  agents?: TrustModelAgent[];
}

export type TrustModelAuditSeverity = "info" | "warning" | "error";

export interface TrustModelAuditFinding {
  severity: TrustModelAuditSeverity;
  rule: string;
  entityId: string;
  entityType: "skill" | "agent";
  message: string;
  suggestion?: string;
}

// 信任等级数值化（数字越小越不可信）
const TRUST_RANK: Record<TrustLevel, number> = {
  untrusted: 0,
  community: 1,
  verified: 2,
  trusted: 3,
};

function defaultTrustLevel(source: TrustModelSkill["source"]): TrustLevel {
  switch (source) {
    case "bundled":
      return "trusted";
    case "managed":
      return "verified";
    case "workspace":
      return "community";
    case "marketplace":
      return "community";
    case "url":
      return "untrusted";
    default:
      return "untrusted";
  }
}

function hasNonEmptyList(list: string[] | undefined): boolean {
  return Array.isArray(list) && list.length > 0;
}

/**
 * 审计信任模型，返回所有风险发现。
 * 检查项：
 * 1. untrusted skill 允许 subprocess
 * 2. community skill 允许 network 且无 host 白名单
 * 3. workspace skill 允许 file system 且无 path 限制
 * 4. trust level 跨越（低信任 agent 缺少 toolPolicyRef 时可触达高信任 skill）
 * 5. marketplace skill 未验证签名（仅警告）
 */
export function auditTrustModel(input: TrustModelAuditInput): TrustModelAuditFinding[] {
  const findings: TrustModelAuditFinding[] = [];

  for (const skill of input.skills ?? []) {
    const trustLevel = skill.trustLevel ?? defaultTrustLevel(skill.source);
    const perms = skill.permissions ?? {};
    const base = { entityId: skill.id, entityType: "skill" as const };

    // 1. untrusted skill 允许 subprocess
    if (trustLevel === "untrusted" && perms.allowSubprocess === true) {
      findings.push({
        ...base,
        severity: "error",
        rule: "trust-untrusted-subprocess",
        message: `不可信 skill "${skill.name}" 允许执行子进程，存在 RCE 风险`,
        suggestion: "禁止 untrusted skill 的 allowSubprocess，或先提升其信任等级并完成审查",
      });
    }

    // 2. community skill 允许 network 且无 host 白名单
    if (
      trustLevel === "community" &&
      perms.allowNetwork === true &&
      !hasNonEmptyList(perms.allowedHosts)
    ) {
      findings.push({
        ...base,
        severity: "warning",
        rule: "trust-community-network-no-hosts",
        message: `社区 skill "${skill.name}" 允许联网但未配置 allowedHosts 白名单`,
        suggestion: "显式列出 allowedHosts，限制可访问的主机",
      });
    }

    // 3. workspace skill 允许 file system 且无 path 限制
    if (
      trustLevel === "community" &&
      perms.allowFileSystem === true &&
      !hasNonEmptyList(perms.allowedPaths)
    ) {
      findings.push({
        ...base,
        severity: "warning",
        rule: "trust-workspace-fs-no-paths",
        message: `工作区 skill "${skill.name}" 允许文件系统访问但未配置 allowedPaths`,
        suggestion: "显式列出 allowedPaths，限制可读写的目录",
      });
    }

    // 4. untrusted skill 允许 network 或 fs（更宽泛的不可信能力检测）
    if (trustLevel === "untrusted") {
      if (perms.allowNetwork === true) {
        findings.push({
          ...base,
          severity: "error",
          rule: "trust-untrusted-network",
          message: `不可信 skill "${skill.name}" 允许联网`,
          suggestion: "禁止 untrusted skill 的 allowNetwork",
        });
      }
      if (perms.allowFileSystem === true) {
        findings.push({
          ...base,
          severity: "error",
          rule: "trust-untrusted-filesystem",
          message: `不可信 skill "${skill.name}" 允许文件系统访问`,
          suggestion: "禁止 untrusted skill 的 allowFileSystem",
        });
      }
    }

    // 5. marketplace skill 未验证签名
    if (skill.source === "marketplace") {
      const signatureVerified =
        (skill as TrustModelSkill & { signatureVerified?: boolean }).signatureVerified === true;
      if (!signatureVerified) {
        findings.push({
          ...base,
          severity: "warning",
          rule: "trust-marketplace-unsigned",
          message: `marketplace skill "${skill.name}" 未验证签名，来源完整性未知`,
          suggestion: "在分发前校验包签名/integrity，确认作者身份",
        });
      }
    }
  }

  // 4. trust level 跨越：低信任 agent 缺少 toolPolicyRef 时可触达高信任 skill
  const agents = input.agents ?? [];
  const hasHighTrustSkill = (input.skills ?? []).some(
    (s) => (s.trustLevel ?? defaultTrustLevel(s.source)) === "trusted",
  );
  if (hasHighTrustSkill && agents.length > 0) {
    for (const agent of agents) {
      const agentRank = TRUST_RANK[agent.trustLevel] ?? 0;
      if (agentRank < TRUST_RANK.verified && !agent.toolPolicyRef) {
        findings.push({
          entityId: agent.id,
          entityType: "agent",
          severity: "warning",
          rule: "trust-cross-boundary",
          message: `低信任 agent "${agent.name}"（${agent.trustLevel}）未引用任何工具策略，可能触达 trusted skill`,
          suggestion: "为低信任 agent 绑定受限的 toolPolicyRef，避免越权调用",
        });
      }
    }
  }

  return findings;
}
