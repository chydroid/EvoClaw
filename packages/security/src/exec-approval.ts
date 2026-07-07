/**
 * Exec Approval — 命令执行安全审批核心类型与决策器
 *
 * 借鉴 openclaw-main exec-approval-decision + exec-approval-policy 设计：
 *   - 决策类型：allow / deny / require_approval / audit_only
 *   - 风险等级：low / medium / high / critical
 *   - 规则匹配：regex / glob / prefix / exact 四种模式
 *   - 评估流程：归一化 → allowlist → 危险规则 → 默认 audit
 *
 * 与现有 command-guard.ts 的关系：
 *   - command-guard 提供 Hardline（无条件阻止）+ Dangerous（需批准）模式
 *   - exec-approval 提供更细粒度的规则引擎（allowlist + 自定义规则 + callerId 隔离）
 *   - 二者可叠加使用：exec-approval 的"deny"决策可作为 command-guard 之外的额外约束
 */

import { ExecAllowlist } from "./exec-allowlist.js";
import { ExecSafeBinNormalizer } from "./exec-safe-bin.js";
import { isUnsafeRegex } from "./safe-regex.js";

// ── 类型定义 ──────────────────────────────────────────────

/** 审批动作 */
export type ExecApprovalAction = "allow" | "deny" | "require_approval" | "audit_only";

/** 风险等级 */
export type ExecRiskLevel = "low" | "medium" | "high" | "critical";

/** 审批请求 */
export interface ExecApprovalRequest {
  /** 完整命令字符串 */
  command: string;
  /** 已解析参数（args[0] 为二进制名或完整路径） */
  args: string[];
  /** 工作目录 */
  cwd?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 调用者标识（agent / skill / user） */
  callerId?: string;
  /** 会话 ID */
  sessionId?: string;
}

/** 审批决策 */
export interface ExecApprovalDecision {
  action: ExecApprovalAction;
  reason: string;
  risk: ExecRiskLevel;
  /** 触发的规则 ID */
  ruleId: string;
  /** 归一化后的命令（用于日志/审计） */
  sanitizedCommand?: string;
  /** 是否需要用户确认（action === "require_approval" 时为 true） */
  needsUserConfirmation?: boolean;
}

/** 规则匹配模式 */
export type ExecRulePatternType = "glob" | "regex" | "prefix" | "exact";

/** 审批规则 */
export interface ExecApprovalRule {
  /** 规则 ID（唯一） */
  id: string;
  /** 匹配模式（glob / regex / prefix / exact） */
  pattern: string;
  /** 模式类型 */
  patternType: ExecRulePatternType;
  /** 命中后的动作 */
  action: ExecApprovalAction;
  /** 风险等级 */
  risk: ExecRiskLevel;
  /** 命中原因（人类可读） */
  reason: string;
  /** callerId 白名单；未定义则全局生效 */
  appliesTo?: string[];
}

// ── 默认危险命令规则 ──────────────────────────────────────

/**
 * 默认危险命令规则集。
 *
 * 设计原则：
 *   - critical 风险 → deny（rm -rf /、mkfs、dd 裸设备、curl|sh）
 *   - high 风险 → require_approval（shutdown/reboot）
 *   - medium 风险 → require_approval（chmod 777）
 *   - low 风险 → audit_only（history -c）
 *
 * 正则均不区分大小写（matchesRule 创建 RegExp 时附加 "i" flag）。
 */
export const DEFAULT_DANGEROUS_RULES: ExecApprovalRule[] = [
  { id: "rm-rf-root", pattern: "rm\\s+-rf\\s+/(\\s|$)", patternType: "regex", action: "deny", risk: "critical", reason: "rm -rf / 禁止" },
  { id: "rm-rf-home", pattern: "rm\\s+-rf\\s+~(/|\\s|$)", patternType: "regex", action: "deny", risk: "critical", reason: "rm -rf ~ 禁止" },
  { id: "mkfs", pattern: "^mkfs\\.", patternType: "regex", action: "deny", risk: "critical", reason: "格式化磁盘禁止" },
  { id: "dd-of-disk", pattern: "dd\\s+.*of=/dev/(sd|nvme|hd)", patternType: "regex", action: "deny", risk: "critical", reason: "dd 写裸设备禁止" },
  { id: "shutdown", pattern: "^(shutdown|reboot|halt|poweroff)", patternType: "regex", action: "require_approval", risk: "high", reason: "电源命令需审批" },
  { id: "curl-pipe-shell", pattern: "curl\\s+.*\\|\\s*(sh|bash)", patternType: "regex", action: "deny", risk: "critical", reason: "curl|sh 管道执行禁止" },
  { id: "chmod-777", pattern: "chmod\\s+777", patternType: "regex", action: "require_approval", risk: "medium", reason: "777 权限需审批" },
  { id: "history-clear", pattern: "history\\s+-c", patternType: "regex", action: "audit_only", risk: "low", reason: "清空历史记录仅审计" },
];

// ── 简化版 glob 匹配（仅支持 * 和 ?，不引入新依赖） ────────

/**
 * 简化版 glob → RegExp 转换。
 *
 * 支持的通配符：
 *   - `*` 匹配任意数量字符（含空）
 *   - `?` 匹配单个字符
 *
 * 其他正则元字符会被转义，确保字面匹配。
 */
export function minimatchLike(input: string, pattern: string): boolean {
  if (!pattern) return false;
  let regex = "^";
  for (const ch of pattern) {
    switch (ch) {
      case "*":
        regex += ".*";
        break;
      case "?":
        regex += ".";
        break;
      default:
        // 转义正则特殊字符
        regex += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  regex += "$";
  return new RegExp(regex, "i").test(input);
}

// ── 审批策略 ─────────────────────────────────────────────

/**
 * 执行审批策略：组合归一化器 + 白名单 + 危险规则，产出 ExecApprovalDecision。
 *
 * 评估顺序：
 *   1. 归一化命令（去 shell 元字符混淆、应用别名）
 *   2. 检查 allowlist（命中即 allow，risk=low）
 *   3. 检查危险规则（首条命中即返回，action 由规则决定）
 *   4. 默认策略：audit_only（risk=low）
 */
export class ExecApprovalPolicy {
  private rules: ExecApprovalRule[];
  private readonly allowlist: ExecAllowlist;
  private readonly safeBinNormalizer: ExecSafeBinNormalizer;

  constructor(opts?: { rules?: ExecApprovalRule[]; allowlist?: ExecAllowlist }) {
    this.rules = opts?.rules ? [...opts.rules] : [...DEFAULT_DANGEROUS_RULES];
    this.allowlist = opts?.allowlist ?? new ExecAllowlist();
    this.safeBinNormalizer = new ExecSafeBinNormalizer();
  }

  /**
   * 评估命令审批请求。
   */
  evaluate(req: ExecApprovalRequest): ExecApprovalDecision {
    // 1. 归一化命令（去 shell 元字符混淆、应用别名）
    const normalized = this.safeBinNormalizer.normalize(req.command);

    // 2. 检查 allowlist（命中直接 allow，risk=low）
    if (this.allowlist.matches(normalized, req.args)) {
      return {
        action: "allow",
        reason: "allowlist match",
        risk: "low",
        ruleId: "allowlist",
        sanitizedCommand: normalized,
      };
    }

    // 3. 检查危险规则（首条命中即返回）
    for (const rule of this.rules) {
      // appliesTo 过滤：若规则限定 callerId 且当前请求不在白名单则跳过
      if (rule.appliesTo && (!req.callerId || !rule.appliesTo.includes(req.callerId))) {
        continue;
      }
      if (this.matchesRule(normalized, rule)) {
        return {
          action: rule.action,
          reason: rule.reason,
          risk: rule.risk,
          ruleId: rule.id,
          sanitizedCommand: normalized,
          needsUserConfirmation: rule.action === "require_approval",
        };
      }
    }

    // 4. 默认策略：audit_only
    return {
      action: "audit_only",
      reason: "no rule matched, default audit",
      risk: "low",
      ruleId: "default",
      sanitizedCommand: normalized,
    };
  }

  /** 单条规则匹配（按 patternType 分发） */
  private matchesRule(command: string, rule: ExecApprovalRule): boolean {
    if (!command) return false;
    switch (rule.patternType) {
      case "regex": {
        if (isUnsafeRegex(rule.pattern)) {
          process.stderr.write(`[Security] Skipping unsafe regex pattern in exec approval: ${rule.pattern}\n`);
          return false;
        }
        try {
          return new RegExp(rule.pattern, "i").test(command);
        } catch {
          return false;
        }
      }
      case "glob":
        return minimatchLike(command, rule.pattern);
      case "prefix":
        return command.toLowerCase().startsWith(rule.pattern.toLowerCase());
      case "exact":
        return command.toLowerCase() === rule.pattern.toLowerCase();
      default:
        return false;
    }
  }

  /** 新增规则（同 ID 会被替换） */
  addRule(rule: ExecApprovalRule): void {
    const idx = this.rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) {
      this.rules[idx] = rule;
    } else {
      this.rules.push(rule);
    }
  }

  /** 移除规则；返回是否实际移除 */
  removeRule(ruleId: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== ruleId);
    return this.rules.length < before;
  }

  /** 列出所有规则（返回副本） */
  listRules(): ExecApprovalRule[] {
    return [...this.rules];
  }

  /** 获取 allowlist 引用（供调用方添加/移除白名单条目） */
  getAllowlist(): ExecAllowlist {
    return this.allowlist;
  }

  /** 获取归一化器引用（供调用方检测隐藏字符等） */
  getNormalizer(): ExecSafeBinNormalizer {
    return this.safeBinNormalizer;
  }
}
