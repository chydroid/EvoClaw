/**
 * Tool Policy Manager — OpenClaw-style per-agent tool access control.
 *
 * Controls which tools each agent can use, with support for:
 * - Allowlist/denylist modes per agent
 * - Per-category tool restrictions (shell, file, web, browser)
 * - Runtime policy evaluation
 * - Policy inheritance from defaults
 *
 * Integrates with AgentRouter for agent-specific policies.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Agent-level tool policy (mirrors @evoclaw/agent ToolPolicy to avoid circular dep) */
export interface AgentToolPolicy {
  mode: "allowlist" | "denylist";
  tools: string[];
  allowShell?: boolean;
  allowFileOps?: boolean;
  allowWeb?: boolean;
  allowBrowser?: boolean;
  maxFileSize?: number;
}

export interface ToolPolicyRule {
  /** Tool name or category wildcard (e.g., "shell_*") */
  tool: string;
  /** Allow or deny */
  action: "allow" | "deny";
  /** Optional condition for the rule */
  condition?: ToolPolicyCondition;
}

export interface ToolPolicyCondition {
  /** Maximum file size in bytes */
  maxFileSize?: number;
  /** Allowed domains (for web tools) */
  allowedDomains?: string[];
  /** Required approval (for shell exec) */
  requireApproval?: boolean;
  /** Time-based restriction (cron expression) */
  timeRestriction?: string;
}

export interface ToolPolicyConfig {
  /** Policy name */
  name: string;
  /** Rules ordered by priority (first match wins) */
  rules: ToolPolicyRule[];
  /** Default action when no rules match */
  defaultAction: "allow" | "deny";
}

export interface ToolAccessRequest {
  toolName: string;
  agentId: string;
  agentPolicy?: AgentToolPolicy;
  parameters?: Record<string, unknown>;
  sessionId?: string;
}

export interface ToolAccessDecision {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
  requestId?: string;
}

// ─── Pre-defined category rules ───────────────────────────────────────────────

const SHELL_TOOLS = ["shell_exec", "exec", "bash", "process", "run"];
const FILE_TOOLS = ["file_read", "file_write", "file_create", "file_modify", "file_delete", "file_list", "file_search"];
const WEB_TOOLS = ["web_search", "web_fetch", "fetch_node_page", "http_request", "browser_fetch_json"];
const BROWSER_TOOLS = ["browser_navigate", "browser_get_text", "browser_click", "browser_screenshot", "browser_fill", "browser_launch", "browser_tabs", "browser_get_html", "browser_evaluate"];
const SYSTEM_TOOLS = ["shell_exec", "process", "cron", "scheduler", "gateway"];

function getToolCategory(toolName: string): string | null {
  if (SHELL_TOOLS.includes(toolName)) return "shell";
  if (FILE_TOOLS.includes(toolName)) return "file";
  if (WEB_TOOLS.includes(toolName)) return "web";
  if (BROWSER_TOOLS.includes(toolName)) return "browser";
  if (SYSTEM_TOOLS.includes(toolName)) return "system";
  return null;
}

// ─── Default policies ─────────────────────────────────────────────────────────

export const DEFAULT_MAIN_POLICY: ToolPolicyConfig = {
  name: "main-agent-full-access",
  rules: [],
  defaultAction: "allow",
};

export const DEFAULT_SANDBOX_POLICY: ToolPolicyConfig = {
  name: "sandbox-agent-restricted",
  rules: [
    { tool: "shell_exec", action: "allow" },
    { tool: "file_read", action: "allow" },
    { tool: "file_write", action: "allow" },
    { tool: "file_list", action: "allow" },
    { tool: "web_search", action: "allow" },
    { tool: "web_fetch", action: "allow" },
    { tool: "fetch_node_page", action: "allow" },
  ],
  defaultAction: "deny",
};

export const DEFAULT_GROUP_POLICY: ToolPolicyConfig = {
  name: "group-chat-restricted",
  rules: [
    { tool: "browser_*", action: "deny" },
    { tool: "shell_exec", action: "deny" },
    { tool: "file_delete", action: "deny" },
  ],
  defaultAction: "allow",
};

// ─── Tool Policy Manager ──────────────────────────────────────────────────────

export class ToolPolicyManager {
  private policies = new Map<string, ToolPolicyConfig>();
  private agentPolicies = new Map<string, string>(); // agentId → policyName

  constructor() {
    this.registerPolicy(DEFAULT_MAIN_POLICY);
    this.registerPolicy(DEFAULT_SANDBOX_POLICY);
    this.registerPolicy(DEFAULT_GROUP_POLICY);
  }

  /** Register a named policy */
  registerPolicy(policy: ToolPolicyConfig): void {
    this.policies.set(policy.name, policy);
  }

  /** Assign a policy to an agent */
  assignPolicy(agentId: string, policyName: string): void {
    if (!this.policies.has(policyName)) {
      throw new Error(`Unknown policy: ${policyName}`);
    }
    this.agentPolicies.set(agentId, policyName);
  }

  /** Remove agent policy assignment */
  removeAssignment(agentId: string): void {
    this.agentPolicies.delete(agentId);
  }

  /** Check if a tool access request is allowed */
  evaluate(request: ToolAccessRequest): ToolAccessDecision {
    // 1. Check agent-specific tool policy (from AgentRouter)
    if (request.agentPolicy) {
      const decision = this.evaluateAgentPolicy(request.toolName, request.agentPolicy);
      if (decision !== null) return decision;
    }

    // 2. Check assigned named policy
    const policyName = this.agentPolicies.get(request.agentId);
    if (policyName) {
      const policy = this.policies.get(policyName);
      if (policy) {
        return this.evaluatePolicy(request.toolName, policy, request.parameters);
      }
    }

    // 3. Default: fall back to sandbox policy for ALL agents (including
    //    "main"/"default"). Previously these IDs bypassed all policy checks,
    //    which meant a compromised or misconfigured main agent could call any
    //    tool without restriction. The sandbox policy is permissive enough for
    //    normal operation while still blocking explicitly denied tools.
    const sandbox = this.policies.get(DEFAULT_SANDBOX_POLICY.name);
    if (sandbox) {
      return this.evaluatePolicy(request.toolName, sandbox, request.parameters);
    }

    return { allowed: false, reason: "No policy assigned" };
  }

  /** Evaluate against an agent-specific ToolPolicy */
  private evaluateAgentPolicy(
    toolName: string,
    policy: AgentToolPolicy
  ): ToolAccessDecision | null {
    if (policy.mode === "allowlist") {
      if (policy.tools.includes("*")) return { allowed: true };
      if (policy.tools.includes(toolName)) return { allowed: true };

      // Check category-level permissions
      const category = getToolCategory(toolName);
      if (category === "shell" && policy.allowShell === false) {
        return { allowed: false, reason: "Shell access denied", requiresApproval: true };
      }
      if (category === "file" && policy.allowFileOps === false) {
        return { allowed: false, reason: "File operations denied" };
      }
      if (category === "web" && policy.allowWeb === false) {
        return { allowed: false, reason: "Web access denied" };
      }
      if (category === "browser" && policy.allowBrowser === false) {
        return { allowed: false, reason: "Browser access denied" };
      }

      return { allowed: false, reason: `Tool "${toolName}" not in allowlist` };
    }

    if (policy.mode === "denylist") {
      if (policy.tools.includes(toolName)) {
        return { allowed: false, reason: `Tool "${toolName}" is denied` };
      }
      return { allowed: true };
    }

    return null;
  }

  /** Evaluate against a named ToolPolicyConfig */
  private evaluatePolicy(
    toolName: string,
    policy: ToolPolicyConfig,
    params?: Record<string, unknown>
  ): ToolAccessDecision {
    // Check each rule in order
    for (const rule of policy.rules) {
      if (this.matchesRule(toolName, rule)) {
        const decision: ToolAccessDecision = {
          allowed: rule.action === "allow",
          reason: rule.action === "deny" ? `Tool "${toolName}" denied by policy "${policy.name}"` : undefined,
          requiresApproval: rule.condition?.requireApproval,
        };

        // Check conditions
        if (decision.allowed && rule.condition) {
          if (rule.condition.maxFileSize && params?.size) {
            const size = Number(params.size);
            if (!Number.isFinite(size) || size > rule.condition.maxFileSize) {
              return { allowed: false, reason: `File size ${size} exceeds limit ${rule.condition.maxFileSize}` };
            }
          }
          if (rule.condition.allowedDomains && params?.url) {
            const url = String(params.url);
            const domain = this.extractDomain(url);
            // BUG 22.1 fix: domain.endsWith(d) 会被子域名攻击绕过。
            // 例如 d="evil.com" 会匹配 "notevil.com"。改为精确匹配或
            // 确保前导点（subdomain 匹配）。
            if (
              domain &&
              !rule.condition.allowedDomains.some((d) => {
                const dl = d.toLowerCase();
                const dom = domain.toLowerCase();
                return dom === dl || dom.endsWith("." + dl);
              })
            ) {
              return { allowed: false, reason: `Domain "${domain}" not in allowlist` };
            }
          }
        }

        return decision;
      }
    }

    // Default action
    return {
      allowed: policy.defaultAction === "allow",
      reason: policy.defaultAction === "deny" ? `No matching rule in policy "${policy.name}"` : undefined,
    };
  }

  /** Check if a rule matches a tool name (supports wildcards) */
  private matchesRule(toolName: string, rule: ToolPolicyRule): boolean {
    if (rule.tool === toolName) return true;
    // Wildcard match: "browser_*" matches "browser_navigate"
    if (rule.tool.endsWith("*")) {
      const prefix = rule.tool.slice(0, -1);
      return toolName.startsWith(prefix);
    }
    return false;
  }

  private extractDomain(url: string): string | null {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }

  /** Get all registered policies */
  listPolicies(): ToolPolicyConfig[] {
    return [...this.policies.values()];
  }

  /** Get agent assignments */
  listAssignments(): Array<{ agentId: string; policyName: string }> {
    return [...this.agentPolicies.entries()].map(([agentId, policyName]) => ({
      agentId,
      policyName,
    }));
  }
}