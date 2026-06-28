// 工具策略审计：检测过于宽松的工具策略。
// 对齐 openclaw-main src/security/audit-tool-policy.ts 的核心检查项（sandbox 工具策略选择）。
// 输入为已抽象的策略列表，避免耦合 SandboxToolPolicy 内部结构。

export interface ToolPolicyAuditCondition {
  type: "host" | "path" | "argsPattern";
  pattern: string;
  action: "allow" | "deny";
}

export interface ToolPolicyEntry {
  agentId?: string;
  /** 工具类别：shell/file/web/browser */
  category?: string;
  /** 允许的工具名（含 "*" 通配） */
  allowed: string[];
  denied: string[];
  conditions?: ToolPolicyAuditCondition[];
}

export interface ToolPolicyAuditInput {
  policies: ToolPolicyEntry[];
}

export type ToolPolicyAuditSeverity = "info" | "warning" | "error";

export interface ToolPolicyAuditFinding {
  severity: ToolPolicyAuditSeverity;
  rule: string;
  agentId?: string;
  message: string;
  suggestion?: string;
}

const WILDCARD = "*";

// 各类别工具所需的限制条件类型
const REQUIRED_CONDITION_BY_CATEGORY: Record<string, "host" | "path" | "argsPattern"> = {
  shell: "argsPattern",
  file: "path",
  web: "host",
  browser: "host",
};

function hasConditionOfType(
  conditions: ToolPolicyAuditCondition[] | undefined,
  type: ToolPolicyAuditCondition["type"],
): boolean {
  return Boolean(conditions?.some((c) => c.type === type && c.pattern.length > 0));
}

/**
 * 审计工具策略列表，返回所有风险发现。
 * 检查项：
 * 1. wildcard allow（allowed: ["*"]）
 * 2. shell 类工具允许且无路径/参数限制
 * 3. web/browser 类工具允许但无 host 白名单
 * 4. file 类工具允许且无 path 白名单
 * 5. denied 为空且 allowed 通配
 */
export function auditToolPolicy(input: ToolPolicyAuditInput): ToolPolicyAuditFinding[] {
  const findings: ToolPolicyAuditFinding[] = [];

  for (const policy of input.policies ?? []) {
    const agentLabel = policy.agentId ?? "<default>";
    const base = policy.agentId ? { agentId: policy.agentId } : {};
    const allowed = policy.allowed ?? [];
    const denied = policy.denied ?? [];
    const conditions = policy.conditions;
    const allowWildcard = allowed.includes(WILDCARD);
    const categories = policy.category
      ? [policy.category]
      : inferCategoriesFromAllowed(allowed);

    // 1. wildcard allow
    if (allowWildcard) {
      findings.push({
        ...base,
        severity: "error",
        rule: "tool-policy-wildcard-allow",
        message: `策略允许 "*" 通配，等于放行所有工具（agent=${agentLabel}）`,
        suggestion: "改为显式工具白名单，按最小权限原则收敛",
      });
    }

    // 2-4. 类别相关限制缺失
    for (const category of categories) {
      const requiredType = REQUIRED_CONDITION_BY_CATEGORY[category];
      if (!requiredType) {
        continue;
      }
      const hasLimit = hasConditionOfType(conditions, requiredType);
      if (!hasLimit) {
        const ruleSuffix = category;
        findings.push({
          ...base,
          severity: "warning",
          rule: `tool-policy-${ruleSuffix}-no-restriction`,
          message: `允许 ${category} 类工具但缺少 ${requiredType} 限制条件（agent=${agentLabel}）`,
          suggestion: `在 conditions 中追加 { type: "${requiredType}", ... } 以收敛 ${category} 工具的可作用范围`,
        });
      }
    }

    // 5. denied 为空且 allowed 通配
    if (denied.length === 0 && allowWildcard) {
      findings.push({
        ...base,
        severity: "error",
        rule: "tool-policy-no-deny-with-wildcard",
        message: `策略 denied 为空且 allowed 通配，等于无任何否决项（agent=${agentLabel}）`,
        suggestion: "至少配置一个 denied 列表，移除通配符 allow",
      });
    }
  }

  return findings;
}

/** 根据工具名推断其所属类别（用于无 category 字段时补全检查）。 */
function inferCategoriesFromAllowed(allowed: string[]): string[] {
  const categories = new Set<string>();
  for (const name of allowed) {
    if (name === WILDCARD) continue;
    const lower = name.toLowerCase();
    if (/(shell|bash|exec|command|subprocess)/.test(lower)) {
      categories.add("shell");
    } else if (/(file|read|write|fs|path)/.test(lower)) {
      categories.add("file");
    } else if (/(web|http|fetch|request|curl)/.test(lower)) {
      categories.add("web");
    } else if (/(browser|chrome|playwright|puppeteer)/.test(lower)) {
      categories.add("browser");
    }
  }
  return Array.from(categories);
}
