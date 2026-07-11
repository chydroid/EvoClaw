import { v4 as uuid } from "uuid";

export interface InstallRule {
  id: string;
  pattern: string;
  action: "allow" | "block" | "review";
  reason: string;
  scope: "name" | "author" | "source" | "capability";
  priority: number;
}

export interface InstallPolicy {
  id: string;
  name: string;
  description: string;
  rules: InstallRule[];
  defaultAction: "allow" | "block" | "review";
  createdAt: number;
  updatedAt: number;
}

export interface InstallContext {
  skillName: string;
  author?: string;
  source: "clawhub" | "npm" | "archive" | "source" | "cli";
  capabilities?: string[];
  hasFileAccess: boolean;
  hasNetworkAccess: boolean;
  hasShellAccess: boolean;
  metadata?: Record<string, unknown>;
}

export interface InstallDecision {
  action: "allow" | "block" | "review";
  reason: string;
  matchedRule?: InstallRule;
  policyId: string;
  context: InstallContext;
}

function matchGlob(pattern: string, value: string): boolean {
  // Convert glob pattern to regex
  // Supports: * (any chars), ? (single char), [abc] (char class)
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex special chars (except * and ?)
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const regex = new RegExp(`^${regexStr}$`, "i");
  return regex.test(value);
}

const TRUSTED_AUTHORS = ["evoclaw-official", "evoclaw-bot"];

function createDefaultPolicy(): InstallPolicy {
  const now = Date.now();
  return {
    id: uuid(),
    name: "Default Install Policy",
    description: "Built-in default policy with sensible security rules",
    rules: [
      {
        id: uuid(),
        pattern: "*",
        action: "block",
        reason: "Skills with shell access from untrusted sources pose a security risk",
        scope: "capability",
        // 优先级低于 clawhub/trusted authors，使可信来源/作者的 allow 规则
        // 先于通用 capability "*" 阻断规则生效，避免可信技能被阻断而死代码。
        // 原值为 100，高于 clawhub(70)/trusted authors(60)，导致任何带能力的
        // 可信技能都会在此被阻断，clawhub 与 trusted authors 规则永不触发。
        priority: 50,
      },
      {
        id: uuid(),
        pattern: "*",
        action: "block",
        reason: "Skills with network access from CLI source are not allowed",
        scope: "capability",
        priority: 40,
      },
      {
        id: uuid(),
        pattern: "*",
        action: "review",
        reason: "Skills with file access from archive source require manual review",
        scope: "capability",
        priority: 30,
      },
      {
        id: uuid(),
        pattern: "clawhub",
        action: "allow",
        reason: "Skills from ClawHub are vetted and trusted",
        scope: "source",
        priority: 70,
      },
      {
        id: uuid(),
        pattern: TRUSTED_AUTHORS.join("|"),
        action: "allow",
        reason: "Skills from trusted authors are allowed",
        scope: "author",
        priority: 60,
      },
    ],
    defaultAction: "review",
    createdAt: now,
    updatedAt: now,
  };
}

export class InstallPolicyManager {
  private policies = new Map<string, InstallPolicy>();
  private auditLog: InstallDecision[] = [];
  private static readonly AUDIT_LOG_MAX = 10000;
  private stats = {
    totalEvaluations: 0,
    allowed: 0,
    blocked: 0,
    pendingReview: 0,
  };

  constructor() {
    // Initialize with built-in default policy
    const defaultPolicy = createDefaultPolicy();
    this.policies.set(defaultPolicy.id, defaultPolicy);
  }

  createPolicy(
    name: string,
    description: string,
    rules: Omit<InstallRule, "id">[],
    defaultAction: "allow" | "block" | "review" = "review"
  ): InstallPolicy {
    const now = Date.now();
    const policy: InstallPolicy = {
      id: uuid(),
      name,
      description,
      rules: rules.map((r) => ({ ...r, id: uuid() })),
      defaultAction,
      createdAt: now,
      updatedAt: now,
    };
    this.policies.set(policy.id, policy);
    return policy;
  }

  updatePolicy(
    policyId: string,
    updates: Partial<Pick<InstallPolicy, "name" | "description" | "rules" | "defaultAction">>
  ): InstallPolicy | null {
    const policy = this.policies.get(policyId);
    if (!policy) return null;

    if (updates.name !== undefined) policy.name = updates.name;
    if (updates.description !== undefined) policy.description = updates.description;
    if (updates.rules !== undefined) {
      policy.rules = updates.rules.map((r) => {
        if ("id" in r && typeof r.id === "string") return r as InstallRule;
        const { pattern, action, reason, scope, priority } = r;
        return { id: uuid(), pattern, action, reason, scope, priority };
      });
    }
    if (updates.defaultAction !== undefined) policy.defaultAction = updates.defaultAction;

    policy.updatedAt = Date.now();
    return policy;
  }

  deletePolicy(policyId: string): boolean {
    return this.policies.delete(policyId);
  }

  getPolicy(policyId: string): InstallPolicy | undefined {
    return this.policies.get(policyId);
  }

  listPolicies(): InstallPolicy[] {
    return Array.from(this.policies.values());
  }

  evaluate(context: InstallContext): InstallDecision {
    this.stats.totalEvaluations++;

    // Collect all rules from all policies, sorted by priority (descending)
    const allRules: Array<{ rule: InstallRule; policyId: string }> = [];
    for (const policy of this.policies.values()) {
      for (const rule of policy.rules) {
        allRules.push({ rule, policyId: policy.id });
      }
    }
    allRules.sort((a, b) => b.rule.priority - a.rule.priority);

    // Evaluate rules in priority order
    for (const { rule, policyId } of allRules) {
      if (this.ruleMatches(rule, context)) {
        const decision: InstallDecision = {
          action: rule.action,
          reason: rule.reason,
          matchedRule: rule,
          policyId,
          context,
        };
        this.recordDecision(decision);
        return decision;
      }
    }

    // No rule matched — use the first policy's default action
    const firstPolicy = this.policies.values().next().value;
    const defaultAction = firstPolicy?.defaultAction ?? "review";

    const decision: InstallDecision = {
      action: defaultAction,
      reason: "No matching rule found; using default action",
      policyId: firstPolicy?.id ?? "none",
      context,
    };
    this.recordDecision(decision);
    return decision;
  }

  checkInstall(
    skillName: string,
    source: InstallContext["source"],
    metadata?: Record<string, unknown>
  ): InstallDecision {
    const context: InstallContext = {
      skillName,
      source,
      hasFileAccess: (metadata?.hasFileAccess as boolean) ?? false,
      hasNetworkAccess: (metadata?.hasNetworkAccess as boolean) ?? false,
      hasShellAccess: (metadata?.hasShellAccess as boolean) ?? false,
      author: metadata?.author as string | undefined,
      capabilities: metadata?.capabilities as string[] | undefined,
      metadata,
    };
    return this.evaluate(context);
  }

  getAuditLog(): InstallDecision[] {
    return [...this.auditLog];
  }

  getStats(): { totalEvaluations: number; allowed: number; blocked: number; pendingReview: number } {
    return { ...this.stats };
  }

  private ruleMatches(rule: InstallRule, context: InstallContext): boolean {
    switch (rule.scope) {
      case "name":
        return matchGlob(rule.pattern, context.skillName);

      case "author":
        if (!context.author) return false;
        // Support pipe-separated authors in pattern
        const authors = rule.pattern.split("|");
        return authors.some((a) => matchGlob(a.trim(), context.author!));

      case "source":
        return matchGlob(rule.pattern, context.source);

      case "capability": {
        // Capability rules match based on access flags and capabilities list
        const pattern = rule.pattern.toLowerCase();

        if (pattern === "*" || pattern === "any") {
          // Universal capability rules — check if the relevant access flag is set
          if (context.hasShellAccess) return true;
          if (context.hasNetworkAccess) return true;
          if (context.hasFileAccess) return true;
          return false;
        }

        // Check named capabilities
        if (context.capabilities?.some((cap) => matchGlob(pattern, cap))) {
          return true;
        }

        // Map common capability names to access flags
        if (
          (pattern === "shell" || pattern.includes("shell")) &&
          context.hasShellAccess
        ) {
          return true;
        }
        if (
          (pattern === "network" || pattern.includes("network")) &&
          context.hasNetworkAccess
        ) {
          return true;
        }
        if (
          (pattern === "file" || pattern.includes("file")) &&
          context.hasFileAccess
        ) {
          return true;
        }

        return false;
      }

      default:
        return false;
    }
  }

  private recordDecision(decision: InstallDecision): void {
    this.auditLog.push(decision);
    // FIFO 淘汰：超过上限时丢弃最旧条目，防止无界增长
    if (this.auditLog.length > InstallPolicyManager.AUDIT_LOG_MAX) {
      this.auditLog.splice(0, this.auditLog.length - InstallPolicyManager.AUDIT_LOG_MAX);
    }

    switch (decision.action) {
      case "allow":
        this.stats.allowed++;
        break;
      case "block":
        this.stats.blocked++;
        break;
      case "review":
        this.stats.pendingReview++;
        break;
    }
  }
}
