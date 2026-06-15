// ── Operator Install Policy ──
// 安全策略驱动的插件/技能安装系统
// 替代传统的"代码扫描"模式，改为策略+上下文+来源+操作者决策的多元约束
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

/** 插件/技能来源类型 */
export type InstallSource = "official" | "verified" | "community" | "local" | "url" | "unknown";

/** 权限范围 */
export type PermissionScope =
  | "read_files"
  | "write_files"
  | "execute_commands"
  | "network_access"
  | "secrets_access"
  | "channel_send"
  | "user_data";

/** 风险等级 */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/** 规则类型 */
export type PolicyRuleType = "allow" | "deny" | "require_approval" | "audit_only";

/** 安装来源规则 */
export interface SourceRule {
  type: PolicyRuleType;
  source: InstallSource;
  reason: string;
}

/** 权限范围规则 */
export interface PermissionRule {
  type: PolicyRuleType;
  scope: PermissionScope;
  reason: string;
}

/** 风险等级规则 */
export interface RiskLevelRule {
  type: PolicyRuleType;
  level: RiskLevel;
  reason: string;
}

/** Skill 名称规则 */
export interface SkillNameRule {
  type: PolicyRuleType;
  pattern: string; // glob pattern
  reason: string;
}

/** 安装策略 */
export interface InstallPolicy {
  enabled: boolean;
  defaultAction: PolicyRuleType; // 默认动作(deny=最严,audit_only=宽松)
  requireOperatorApproval: boolean; // 是否需要操作者确认
  trustedSources: InstallSource[]; // 可信来源白名单
  deniedSources: InstallSource[]; // 禁止来源
  maxRiskLevel: RiskLevel; // 允许的最大风险等级
  blockedPermissions: PermissionScope[]; // 禁止授予的权限
  sourceRules: SourceRule[];
  permissionRules: PermissionRule[];
  riskRules: RiskLevelRule[];
  skillRules: SkillNameRule[];
  requireSignatureVerification: boolean; // 是否要求签名验证
  allowUnverifiedInDev: boolean; // 开发模式是否允许未签名
}

/** 安装请求上下文 */
export interface InstallRequest {
  name: string;
  version?: string;
  source: InstallSource;
  sourceUrl?: string;
  author?: string;
  description?: string;
  permissions: PermissionScope[];
  riskLevel: RiskLevel;
  signatureValid?: boolean;
  operatorId?: string; // 发起安装的操作者
  context: string; // 安装上下文 (workspace, agent, channel, etc.)
}

/** 评估结果 */
export type PolicyAction = "allow" | "deny" | "require_approval" | "audit";

/** 评估详情 */
export interface PolicyEvaluation {
  action: PolicyAction;
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  matchedRules: string[];
  warnings: string[];
  policyHash: string; // 评估时使用的策略hash，用于审计
  timestamp: number;
}

/** 审计日志条目 */
export interface InstallAuditEntry {
  id: string;
  request: InstallRequest;
  evaluation: PolicyEvaluation;
  decision: PolicyAction; // 最终决定(可能operator override)
  decidedBy: string;
  decidedAt: number;
}

/** 评估器配置 */
export interface InstallPolicyConfig {
  policy: InstallPolicy;
  policyPath?: string; // 策略文件路径
  auditPath?: string; // 审计日志路径
  operatorApprovalTimeoutMs?: number; // 操作者确认超时(默认30s)
}

/**
 * InstallPolicyManager - 操作者安装策略管理器
 * 负责评估安装请求并生成审计日志
 */
export class InstallPolicyManager {
  private policy: InstallPolicy;
  private policyPath?: string;
  private auditPath?: string;
  private approvalTimeoutMs: number;
  private auditLog: InstallAuditEntry[] = [];
  private pendingApprovals = new Map<string, {
    request: InstallRequest;
    evaluation: PolicyEvaluation;
    resolve: (decision: PolicyAction) => void;
    timer?: NodeJS.Timeout;
  }>();

  constructor(config: InstallPolicyConfig) {
    this.policy = config.policy;
    this.policyPath = config.policyPath;
    this.auditPath = config.auditPath;
    this.approvalTimeoutMs = config.operatorApprovalTimeoutMs ?? 30000;
    this.loadAuditLog();
  }

  /** 评估安装请求 */
  async evaluate(request: InstallRequest): Promise<PolicyEvaluation> {
    const matchedRules: string[] = [];
    const warnings: string[] = [];
    const reasons: string[] = [];
    let needsApproval = this.policy.requireOperatorApproval;

    if (!this.policy.enabled) {
      return this.buildEvaluation("allow", "策略系统未启用", [], warnings);
    }

    // 1. 检查trusted sources
    if (this.policy.trustedSources.includes(request.source)) {
      matchedRules.push(`trusted-source:${request.source}`);
    }

    // 2. 检查denied sources (最高优先级)
    for (const rule of this.policy.deniedSources) {
      if (rule === request.source) {
        return this.buildEvaluation("deny", `来源 ${request.source} 被策略禁止`, matchedRules, warnings);
      }
    }
    for (const rule of this.policy.sourceRules) {
      if (rule.source === request.source) {
        matchedRules.push(`source-rule:${rule.type}:${rule.source}`);
        if (rule.type === "deny") {
          return this.buildEvaluation("deny", rule.reason, matchedRules, warnings);
        }
      }
    }

    // 3. 检查风险等级
    const riskOrder: RiskLevel[] = ["low", "medium", "high", "critical"];
    if (riskOrder.indexOf(request.riskLevel) > riskOrder.indexOf(this.policy.maxRiskLevel)) {
      warnings.push(`风险等级 ${request.riskLevel} 超过允许的最大值 ${this.policy.maxRiskLevel}`);
    }
    for (const rule of this.policy.riskRules) {
      if (rule.level === request.riskLevel) {
        matchedRules.push(`risk-rule:${rule.type}:${rule.level}`);
        if (rule.type === "deny") {
          return this.buildEvaluation("deny", rule.reason, matchedRules, warnings);
        }
      }
    }

    // 4. 检查权限范围
    for (const perm of request.permissions) {
      if (this.policy.blockedPermissions.includes(perm)) {
        return this.buildEvaluation("deny", `权限 ${perm} 被策略禁止`, matchedRules, warnings);
      }
    }
    for (const rule of this.policy.permissionRules) {
      if (request.permissions.includes(rule.scope)) {
        matchedRules.push(`permission-rule:${rule.type}:${rule.scope}`);
        if (rule.type === "deny") {
          return this.buildEvaluation("deny", rule.reason, matchedRules, warnings);
        }
        if (rule.type === "require_approval") {
          needsApproval = true;
        }
      }
    }

    // 5. 检查skill名称规则
    for (const rule of this.policy.skillRules) {
      if (this.matchPattern(request.name, rule.pattern)) {
        matchedRules.push(`skill-rule:${rule.type}:${rule.pattern}`);
        if (rule.type === "deny") {
          return this.buildEvaluation("deny", rule.reason, matchedRules, warnings);
        }
      }
    }

    // 6. 检查签名验证
    if (this.policy.requireSignatureVerification && !request.signatureValid) {
      if (!this.policy.allowUnverifiedInDev) {
        return this.buildEvaluation("deny", "策略要求签名验证但插件未签名", matchedRules, warnings);
      }
      warnings.push("插件未签名（开发模式例外）");
    }

    // 7. 检查是否需要operator approval
    needsApproval = needsApproval ||
                    request.riskLevel === "high" ||
                    request.riskLevel === "critical" ||
                    request.permissions.length > 2;

    if (needsApproval) {
      const reason = `需要操作者确认 (风险=${request.riskLevel}, 权限数=${request.permissions.length})`;
      return this.buildEvaluation("require_approval", reason, matchedRules, warnings);
    }

    // 8. 检查默认动作
    if (this.policy.defaultAction === "deny") {
      return this.buildEvaluation("deny", "默认动作deny且无明确allow规则匹配", matchedRules, warnings);
    }
    if (this.policy.defaultAction === "require_approval") {
      return this.buildEvaluation("require_approval", "默认动作require_approval", matchedRules, warnings);
    }
    if (this.policy.defaultAction === "audit_only") {
      return this.buildEvaluation("audit", "默认动作audit_only", matchedRules, warnings);
    }

    return this.buildEvaluation("allow", "通过所有策略检查", matchedRules, warnings);
  }

  /** 等待操作者确认 */
  async waitForOperatorApproval(
    request: InstallRequest,
    evaluation: PolicyEvaluation,
  ): Promise<PolicyAction> {
    const id = `${request.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<PolicyAction>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(id);
        // fail-closed: 超时默认拒绝
        resolve("deny");
      }, this.approvalTimeoutMs);
      this.pendingApprovals.set(id, { request, evaluation, resolve, timer });
    });
  }

  /** 操作者做出决定 */
  submitOperatorDecision(approvalId: string, decision: PolicyAction, operatorId: string): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingApprovals.delete(approvalId);
    // 记录审计
    this.audit({
      request: pending.request,
      evaluation: pending.evaluation,
      decision,
      decidedBy: operatorId,
      decidedAt: Date.now(),
    });
    pending.resolve(decision);
    return true;
  }

  /** 完整流程: 评估 + (可选)等待approval + 审计 */
  async processInstall(request: InstallRequest): Promise<{
    action: PolicyAction;
    evaluation: PolicyEvaluation;
    auditId?: string;
  }> {
    const evaluation = await this.evaluate(request);
    if (evaluation.action === "require_approval") {
      const decision = await this.waitForOperatorApproval(request, evaluation);
      const finalEvaluation = { ...evaluation, action: decision, requiresApproval: false };
      const auditEntry = this.audit({
        request,
        evaluation: finalEvaluation,
        decision,
        decidedBy: request.operatorId ?? "system",
        decidedAt: Date.now(),
      });
      return { action: decision, evaluation: finalEvaluation, auditId: auditEntry.id };
    }
    // 直接审计
    const auditEntry = this.audit({
      request,
      evaluation,
      decision: evaluation.action,
      decidedBy: "auto",
      decidedAt: Date.now(),
    });
    return { action: evaluation.action, evaluation, auditId: auditEntry.id };
  }

  /** 记录审计 */
  private audit(entry: Omit<InstallAuditEntry, "id">): InstallAuditEntry {
    const id = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const full: InstallAuditEntry = { id, ...entry };
    this.auditLog.push(full);
    // 限制内存中日志数量
    if (this.auditLog.length > 10000) {
      this.auditLog.shift();
    }
    this.persistAudit();
    return full;
  }

  /** 查询审计日志 */
  queryAudit(filter?: {
    name?: string;
    operatorId?: string;
    action?: PolicyAction;
    sinceMs?: number;
    limit?: number;
  }): InstallAuditEntry[] {
    let result = this.auditLog;
    if (filter?.name) {
      result = result.filter((e) => e.request.name.includes(filter.name!));
    }
    if (filter?.operatorId) {
      result = result.filter((e) => e.decidedBy !== "auto" && e.decidedBy === filter.operatorId);
    }
    if (filter?.action) {
      result = result.filter((e) => e.decision === filter.action);
    }
    if (filter?.sinceMs) {
      const cutoff = Date.now() - filter.sinceMs;
      result = result.filter((e) => e.decidedAt >= cutoff);
    }
    if (filter?.limit) {
      result = result.slice(-filter.limit);
    }
    return result;
  }

  /** 获取审计日志 (alias for queryAudit without filter) */
  getAuditLog(limit = 100): InstallAuditEntry[] {
    return this.auditLog.slice(-limit);
  }

  /** 持久化审计日志 */
  private persistAudit(): void {
    if (!this.auditPath) return;
    try {
      const dir = path.dirname(this.auditPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 只保留最近1000条
      const toWrite = this.auditLog.slice(-1000);
      fs.writeFileSync(this.auditPath, JSON.stringify(toWrite, null, 2), "utf-8");
    } catch (err) {
      // 静默失败,不阻塞主流程
    }
  }

  /** 加载审计日志 */
  private loadAuditLog(): void {
    if (!this.auditPath || !fs.existsSync(this.auditPath)) return;
    try {
      const data = fs.readFileSync(this.auditPath, "utf-8");
      this.auditLog = JSON.parse(data);
    } catch {
      this.auditLog = [];
    }
  }

  /** 推断安装来源 */
  static inferSource(sourceUrl?: string, author?: string): InstallSource {
    if (!sourceUrl) return "local";
    if (sourceUrl.includes("clawhub.com")) return "official";
    if (sourceUrl.includes("github.com/openclaw")) return "community";
    if (author && /^(openclaw|hermes|evoclaw|official)$/i.test(author)) return "verified";
    if (sourceUrl.startsWith("https://") || sourceUrl.startsWith("http://")) {
      return sourceUrl.includes("npm") || sourceUrl.includes("registry") ? "verified" : "community";
    }
    return "url";
  }

  /** 推断风险等级 */
  static inferRiskLevel(permissions: PermissionScope[]): RiskLevel {
    if (permissions.includes("secrets_access") && permissions.includes("execute_commands")) {
      return "critical";
    }
    if (permissions.includes("execute_commands") || permissions.includes("secrets_access")) {
      return "high";
    }
    if (permissions.includes("network_access") || permissions.includes("write_files")) {
      return "medium";
    }
    return "low";
  }

  /** 计算策略hash */
  getPolicyHash(): string {
    return createHash("sha256").update(JSON.stringify(this.policy)).digest("hex").slice(0, 16);
  }

  /** 获取当前策略 */
  getPolicy(): InstallPolicy {
    return this.policy;
  }

  /** 更新策略 */
  updatePolicy(policy: InstallPolicy): void {
    this.policy = policy;
  }

  /** 获取待处理approval列表 */
  getPendingApprovals(): Array<{
    id: string;
    request: InstallRequest;
    evaluation: PolicyEvaluation;
  }> {
    return Array.from(this.pendingApprovals.entries()).map(([id, p]) => ({
      id,
      request: p.request,
      evaluation: p.evaluation,
    }));
  }

  private buildEvaluation(
    action: PolicyAction,
    reason: string,
    matchedRules: string[],
    warnings: string[],
  ): PolicyEvaluation {
    return {
      action,
      allowed: action === "allow" || action === "audit",
      requiresApproval: action === "require_approval",
      reason,
      matchedRules,
      warnings,
      policyHash: this.getPolicyHash(),
      timestamp: Date.now(),
    };
  }

  private matchPattern(text: string, pattern: string): boolean {
    // 简单glob: * 匹配任意字符
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$", "i");
    return regex.test(text);
  }
}

/** 默认安装策略 */
export const DEFAULT_INSTALL_POLICY: InstallPolicy = {
  enabled: true,
  defaultAction: "audit_only",
  requireOperatorApproval: false,
  trustedSources: ["official", "verified", "local"],
  deniedSources: [],
  maxRiskLevel: "high",
  blockedPermissions: [],
  sourceRules: [
    { type: "deny", source: "unknown", reason: "未知来源禁止安装" },
  ],
  permissionRules: [
    {
      type: "require_approval",
      scope: "secrets_access",
      reason: "访问密钥需要操作者确认",
    },
    {
      type: "require_approval",
      scope: "execute_commands",
      reason: "执行命令需要操作者确认",
    },
  ],
  riskRules: [
    { type: "deny", level: "critical", reason: "禁止安装critical风险等级插件" },
  ],
  skillRules: [],
  requireSignatureVerification: false,
  allowUnverifiedInDev: true,
};
