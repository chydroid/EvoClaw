/**
 * Human-in-the-Loop (HITL) Approval System
 *
 * Provides a breakpoint mechanism that pauses execution before high-risk
 * tool calls and waits for human approval. Includes risk-level classification,
 * trust whitelisting, timeout handling, and progress event emission.
 */

// ── Types ──────────────────────────────────────────────────

/** Risk levels for tool operations */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/** An operation pending human approval */
export interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  riskLevel: RiskLevel;
  reason: string;
  createdAt: number;
  /** Who requested this (agent name or system) */
  requestedBy: string;
  /** Current status */
  status: "pending" | "approved" | "rejected" | "expired" | "modified";
  /** User who made the decision */
  decidedBy?: string;
  /** When the decision was made */
  decidedAt?: number;
  /** Modified arguments (if user modified before approving) */
  modifiedArgs?: Record<string, unknown>;
  /** Rejection reason */
  rejectionReason?: string;
  /** Auto-approve future operations of this type */
  trustFutureOperations?: boolean;
}

/** Configuration for the approval system */
export interface ApprovalConfig {
  /** Tools that require approval by risk level */
  riskLevels: Record<string, RiskLevel>;
  /** Whether approval is required for each risk level */
  requireApproval: Record<RiskLevel, boolean>;
  /** Timeout for pending approvals in ms (default: 5 minutes) */
  approvalTimeout: number;
  /** Maximum number of pending approvals per session */
  maxPendingPerSession: number;
}

/** A trust rule that auto-approves certain operations */
export interface TrustRule {
  toolName: string;
  /** Optional pattern for argument matching */
  argPattern?: Record<string, string | RegExp>;
  /** Who trusted this rule */
  trustedBy: string;
  /** When the rule was created */
  createdAt: number;
  /** Expiry time (0 = never expires) */
  expiresAt: number;
}

// ── Defaults ───────────────────────────────────────────────

const DEFAULT_RISK_LEVELS: Record<string, RiskLevel> = {
  // Critical risk - always requires approval
  shell_exec: "critical",
  file_delete: "critical",
  // High risk - requires approval by default
  file_modify: "high",
  email_send: "high",
  browser_login: "high",
  // Medium risk - configurable
  file_create: "medium",
  skill_install: "medium",
  video_download: "medium",
  music_download: "medium",
  // Low risk - auto-approved
  web_search: "low",
  web_fetch: "low",
  file_read: "low",
  file_list: "low",
  memory_search: "low",
  memory_store: "low",
};

const DEFAULT_REQUIRE_APPROVAL: Record<RiskLevel, boolean> = {
  critical: true,
  high: true,
  medium: false,
  low: false,
};

// ── HumanApprovalManager ───────────────────────────────────

export class HumanApprovalManager {
  private config: ApprovalConfig;
  private pendingApprovals = new Map<string, PendingApproval>();
  private trustRules: TrustRule[] = [];
  private approvalResolvers = new Map<string, {
    resolve: (decision: "approved" | "rejected" | "modified", modifiedArgs?: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<ApprovalConfig>) {
    this.config = {
      riskLevels: { ...DEFAULT_RISK_LEVELS, ...config?.riskLevels },
      requireApproval: { ...DEFAULT_REQUIRE_APPROVAL, ...config?.requireApproval },
      approvalTimeout: config?.approvalTimeout ?? 5 * 60 * 1000,
      maxPendingPerSession: config?.maxPendingPerSession ?? 10,
    };
    this.startCleanupTimer();
  }

  /** Check if a tool call requires approval */
  requiresApproval(toolName: string, args: Record<string, unknown>): boolean {
    // Check trust rules first
    if (this.isTrusted(toolName, args)) return false;

    const riskLevel = this.config.riskLevels[toolName] || "medium";
    return this.config.requireApproval[riskLevel];
  }

  /** Get the risk level for a tool */
  getRiskLevel(toolName: string): RiskLevel {
    return this.config.riskLevels[toolName] || "medium";
  }

  /** Request approval for an operation. Returns a promise that resolves when approved/rejected */
  async requestApproval(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    requestedBy: string,
  ): Promise<{ decision: "approved" | "rejected" | "modified"; modifiedArgs?: Record<string, unknown> }> {
    // Check trust rules
    if (this.isTrusted(toolName, args)) {
      return { decision: "approved" };
    }

    // Check if approval is needed
    if (!this.requiresApproval(toolName, args)) {
      return { decision: "approved" };
    }

    // Check pending limit
    const sessionPending = Array.from(this.pendingApprovals.values())
      .filter(p => p.sessionId === sessionId && p.status === "pending");
    if (sessionPending.length >= this.config.maxPendingPerSession) {
      return { decision: "rejected" }; // Too many pending
    }

    const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const riskLevel = this.getRiskLevel(toolName);

    const pending: PendingApproval = {
      id,
      sessionId,
      toolName,
      toolArgs: args,
      riskLevel,
      reason: this.generateReason(toolName, args, riskLevel),
      createdAt: Date.now(),
      requestedBy,
      status: "pending",
    };

    this.pendingApprovals.set(id, pending);

    // Create a promise that will be resolved when the user makes a decision
    return new Promise((resolve, reject) => {
      this.approvalResolvers.set(id, {
        resolve: (decision, modifiedArgs) => {
          pending.status = decision === "modified" ? "modified" : decision;
          pending.decidedAt = Date.now();
          if (modifiedArgs) pending.modifiedArgs = modifiedArgs;
          this.pendingApprovals.set(id, pending);
          this.approvalResolvers.delete(id);
          resolve({ decision, modifiedArgs });
        },
        reject: (error) => {
          pending.status = "rejected";
          pending.decidedAt = Date.now();
          pending.rejectionReason = error.message;
          this.pendingApprovals.set(id, pending);
          this.approvalResolvers.delete(id);
          reject(error);
        },
      });

      // Set timeout
      setTimeout(() => {
        if (this.approvalResolvers.has(id)) {
          pending.status = "expired";
          pending.decidedAt = Date.now();
          this.pendingApprovals.set(id, pending);
          this.approvalResolvers.delete(id);
          resolve({ decision: "rejected" });
        }
      }, this.config.approvalTimeout);
    });
  }

  /** Approve a pending operation */
  approve(approvalId: string, decidedBy: string, trustFuture?: boolean, modifiedArgs?: Record<string, unknown>): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.status !== "pending") return false;

    pending.decidedBy = decidedBy;
    pending.trustFutureOperations = trustFuture;

    // Add trust rule if requested
    if (trustFuture) {
      this.addTrustRule({
        toolName: pending.toolName,
        trustedBy: decidedBy,
        createdAt: Date.now(),
        expiresAt: 0, // never expires
      });
    }

    const resolver = this.approvalResolvers.get(approvalId);
    if (resolver) {
      if (modifiedArgs) {
        resolver.resolve("modified", modifiedArgs);
      } else {
        resolver.resolve("approved");
      }
    }
    return true;
  }

  /** Reject a pending operation */
  reject(approvalId: string, decidedBy: string, reason?: string): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.status !== "pending") return false;

    pending.decidedBy = decidedBy;
    pending.rejectionReason = reason;

    const resolver = this.approvalResolvers.get(approvalId);
    if (resolver) {
      resolver.resolve("rejected");
    }
    return true;
  }

  /** Get all pending approvals */
  getPendingApprovals(sessionId?: string): PendingApproval[] {
    const all = Array.from(this.pendingApprovals.values())
      .filter(p => p.status === "pending");
    if (sessionId) return all.filter(p => p.sessionId === sessionId);
    return all;
  }

  /** Get a specific approval */
  getApproval(approvalId: string): PendingApproval | undefined {
    return this.pendingApprovals.get(approvalId);
  }

  /** Add a trust rule */
  addTrustRule(rule: TrustRule): void {
    this.trustRules.push(rule);
  }

  /** Remove a trust rule */
  removeTrustRule(toolName: string): void {
    this.trustRules = this.trustRules.filter(r => r.toolName !== toolName);
  }

  /** Get all trust rules */
  getTrustRules(): TrustRule[] {
    return [...this.trustRules];
  }

  /** Check if a tool+args combination is trusted */
  private isTrusted(toolName: string, args: Record<string, unknown>): boolean {
    const now = Date.now();
    return this.trustRules.some(rule => {
      if (rule.toolName !== toolName) return false;
      if (rule.expiresAt > 0 && now > rule.expiresAt) return false;
      if (rule.argPattern) {
        return Object.entries(rule.argPattern).every(([key, pattern]) => {
          const val = String(args[key] ?? "");
          if (pattern instanceof RegExp) return pattern.test(val);
          return val === pattern;
        });
      }
      return true;
    });
  }

  /** Generate a human-readable reason for the approval request */
  private generateReason(toolName: string, args: Record<string, unknown>, riskLevel: RiskLevel): string {
    const riskLabels: Record<RiskLevel, string> = {
      critical: "\u26a0\ufe0f \u5173\u952e\u98ce\u9669",
      high: "\ud83d\udd34 \u9ad8\u98ce\u9669",
      medium: "\ud83d\udfe1 \u4e2d\u7b49\u98ce\u9669",
      low: "\ud83d\udfe2 \u4f4e\u98ce\u9669",
    };

    const toolDescriptions: Record<string, string> = {
      shell_exec: `\u6267\u884cShell\u547d\u4ee4: ${String(args.command ?? "").slice(0, 100)}`,
      file_delete: `\u5220\u9664\u6587\u4ef6: ${String(args.path ?? "")}`,
      file_modify: `\u4fee\u6539\u6587\u4ef6: ${String(args.path ?? "")}`,
      file_create: `\u521b\u5efa\u6587\u4ef6: ${String(args.path ?? "")}`,
      email_send: `\u53d1\u9001\u90ae\u4ef6\u81f3: ${String(args.to ?? "")}`,
      browser_login: `\u767b\u5f55\u7f51\u7ad9: ${String(args.url ?? "")}`,
      skill_install: `\u5b89\u88c5\u6280\u80fd: ${String(args.name ?? args.url ?? "")}`,
      video_download: `\u4e0b\u8f7d\u89c6\u9891: ${String(args.url ?? "")}`,
      music_download: `\u4e0b\u8f7d\u97f3\u4e50: ${String(args.query ?? args.url ?? "")}`,
    };

    const desc = toolDescriptions[toolName] || `\u6267\u884c\u5de5\u5177: ${toolName}`;
    return `${riskLabels[riskLevel]} - ${desc}`;
  }

  /** Clean up expired approvals */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, pending] of this.pendingApprovals) {
        if (pending.status === "pending" && now - pending.createdAt > this.config.approvalTimeout) {
          pending.status = "expired";
          pending.decidedAt = now;
          const resolver = this.approvalResolvers.get(id);
          if (resolver) {
            resolver.resolve("rejected");
            this.approvalResolvers.delete(id);
          }
        }
      }
      // Clean up old non-pending approvals (keep for 1 hour)
      for (const [id, pending] of this.pendingApprovals) {
        if (pending.status !== "pending" && pending.decidedAt && now - pending.decidedAt > 60 * 60 * 1000) {
          this.pendingApprovals.delete(id);
        }
      }
    }, 30_000);
  }

  /** Stop the cleanup timer */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Reject all pending approvals
    for (const [, resolver] of this.approvalResolvers) {
      resolver.resolve("rejected");
    }
    this.approvalResolvers.clear();
  }

  /** Update configuration */
  updateConfig(config: Partial<ApprovalConfig>): void {
    if (config.riskLevels) this.config.riskLevels = { ...this.config.riskLevels, ...config.riskLevels };
    if (config.requireApproval) this.config.requireApproval = { ...this.config.requireApproval, ...config.requireApproval };
    if (config.approvalTimeout) this.config.approvalTimeout = config.approvalTimeout;
    if (config.maxPendingPerSession) this.config.maxPendingPerSession = config.maxPendingPerSession;
  }

  /** Get current configuration */
  getConfig(): Readonly<ApprovalConfig> {
    return this.config;
  }
}
