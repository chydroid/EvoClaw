/**
 * Human-in-the-Loop (HITL) Approval System
 *
 * Provides a breakpoint mechanism that pauses execution before high-risk
 * tool calls and waits for human approval. Includes risk-level classification,
 * trust whitelisting, timeout handling, and progress event emission.
 *
 * 状态持久化：trustRules 和 pendingApprovals 可选持久化到 JSON 文件，
 * 进程重启后恢复 trust rules，pending approvals 标记为 expired（Promise 无法恢复）。
 */

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { atomicWriteFileSync } from "@evoclaw/core";
import { getActiveSecurityPolicy } from "@evoclaw/security";

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
  /** 持久化文件路径（可选，设置后 trust rules 和 pending approvals 会持久化） */
  storePath?: string;
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

/** 风险等级排序：用于「action 缺省时取该工具最高等级」的保守回落 */
const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

const DEFAULT_RISK_LEVELS: Record<string, RiskLevel> = {
  // Critical risk - always requires approval
  file_delete: "critical",
  // 未合并的独立工具：高风险（browser_login 会暴露凭据）
  browser_login: "high",
  // Medium risk - configurable
  // 复合工具（file_write / email / git / skill_manage / scheduler / music / video /
  // browser_get / browser_act / ...）的 action 级风险见下方 ACTION_RISK_LEVELS，
  // 不再在这里给单一等级——否则要么过度封禁（email 整体 high → 读收件箱也要审批），
  // 要么失去护栏（email 整体 low → 发信免审批）。
  // Low risk - auto-approved
  shell_exec: "low",
  web_search: "low",
  web_fetch: "low",
  file_read: "low",
  file_list: "low",
  memory_store: "low",
  // Browser automation - low risk（未合并的独立浏览器工具：只读导航与交互）
  browser_navigate: "low",
  browser_tabs: "low",
  browser_launch: "low",
  browser_screenshot: "low",
  browser_js_eval: "low",
  browser_wait: "low",
};

/**
 * 复合工具的 action 级风险等级。
 *
 * 合并前每个细粒度工具在 DEFAULT_RISK_LEVELS 里各占一行；合并后一个工具名覆盖多个
 * action，风险跨度很大。此处按 (工具, action) 精确还原合并前的等级语义。
 * 未列出的 action 回落到工具级 DEFAULT_RISK_LEVELS，再回落 "medium"。
 */
const ACTION_RISK_LEVELS: Record<string, Record<string, RiskLevel>> = {
  // file_create=medium / file_modify=high
  file_write: { create: "medium", modify: "high" },
  // email_send=high；email_add_account=low（用户明确要求首次添加邮箱免审批）；
  // 其余只读 action=low
  email: {
    send: "high",
    add_account: "low",
    list_accounts: "low",
    list_inbox: "low",
    get_email: "low",
    analyze: "low",
    summarize: "low",
    inbox_summary: "low",
  },
  // Git 远程/破坏性操作需审批：此前在 security/permission-manager.ts 配了
  // requireExplicitConsent，但本表缺配 → 缺省按 medium 处理（requireApproval=false）
  // 导致 HITL 层直接放行，force push 这类高危操作实际无需审批。此处按 action 补齐对齐。
  git: {
    commit: "high",
    push: "high",
    status: "low",
    diff: "low",
    log: "low",
    blame: "low",
    show: "low",
    add: "low",
  },
  // 自动装技能会引入可执行代码 → medium（medium 默认可配置为需审批）
  skill_manage: {
    create: "medium",
    install: "medium",
    uninstall: "medium",
    find_and_install: "medium",
    execute: "low",
    orchestrate: "low",
  },
  skill_list: { index: "low", search: "low" },
  // video_download / music_download 会拉取外部内容 → medium
  video: { generate: "low", info: "low", download: "medium" },
  music: { search: "low", download: "medium" },
  image_generate: { generate: "low", info: "low" },
  document: { create_docx: "low", create_xlsx: "low", create_pptx: "low" },
  kanban: {
    create_board: "low", add_task: "low", claim_task: "low",
    complete_task: "low", list_tasks: "low", get_stats: "low",
  },
  memory: { search: "low", stats: "low" },
  scheduler: {
    create: "medium", update: "medium", delete: "medium",
    execute: "medium", retry_dlq: "medium",
    list: "low", history: "low",
  },
  dev_check: { test: "low", lint: "low" },
  code_search: { symbol: "low", text: "low", references: "low" },
  // apply_patch 会改代码 → medium；重命名计划/执行只读或受控
  apply_patch: { patch: "medium", plan_rename: "low", apply_rename: "low" },
  // Browser 合并后：全部只读/交互类，沿用合并前的 low
  browser_get: { text: "low", html: "low", elements: "low" },
  browser_act: { click: "low", hover: "low", check: "low", select: "low", fill: "low", submit: "low" },
  browser_scroll: { scroll: "low" },
  browser_extract_dom: { extract: "low", clear: "low" },
  web_search: { search: "low", research: "low", browser: "low" },
  web_fetch: { fetch: "low", stealth: "low", json: "low" },
  vision_analyze: { analyze: "low", describe: "low", find_elements: "low", detect_issues: "low", compare: "low" },
  workflow: { validate: "low", execute: "low", batch: "low" },
  checkpoint: { save: "low", restore: "low", list: "low" },
  task_plan: { decompose: "low", templates: "low", status: "low" },
  report: { generate: "low", templates: "low", weekly: "low", email_digest: "medium" },
  classify_task: { classify: "low", stats: "low" },
  computer_use: {
    screenshot: "low", click: "low", move: "low", drag: "low", scroll: "low",
    type: "low", press: "low", window_list: "low", window_focus: "low",
  },
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
  /** Track active timeout handles so they can be cleared on destroy */
  private pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /** 防抖持久化定时器 */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private destroyed = false;

  constructor(config?: Partial<ApprovalConfig>) {
    this.config = {
      riskLevels: { ...DEFAULT_RISK_LEVELS, ...config?.riskLevels },
      requireApproval: { ...DEFAULT_REQUIRE_APPROVAL, ...config?.requireApproval },
      approvalTimeout: config?.approvalTimeout ?? 5 * 60 * 1000,
      maxPendingPerSession: config?.maxPendingPerSession ?? 10,
      storePath: config?.storePath,
    };
    // 从磁盘恢复状态
    this.loadState();
    this.startCleanupTimer();
  }

  /**
   * 解析风险等级：先看 (工具, action) 二元规则，未命中再看工具级配置。
   *
   * 复合工具的 action 是必填字段，但模型仍可能漏传；此时取该工具**所有 action 的
   * 最高等级**（保守方向）——宁可多审批一次，也不要因为 action 缺失就把
   * email.send 这类高危操作放成 low。
   */
  resolveRiskLevel(toolName: string, args?: Record<string, unknown>): RiskLevel {
    const actionRules = ACTION_RISK_LEVELS[toolName];
    if (actionRules) {
      const action = typeof args?.action === "string" ? args.action : undefined;
      if (action && actionRules[action]) return actionRules[action];
      let worst: RiskLevel = "low";
      for (const level of Object.values(actionRules)) {
        if (RISK_ORDER[level] > RISK_ORDER[worst]) worst = level;
      }
      return worst;
    }
    return this.config.riskLevels[toolName] || "medium";
  }

  /** Check if a tool call requires approval */
  requiresApproval(toolName: string, args: Record<string, unknown>): boolean {
    // Check trust rules first
    if (this.isTrusted(toolName, args)) return false;

    const riskLevel = this.resolveRiskLevel(toolName, args);
    // 「一定风险」档：高危/极高危操作也免人工审批。
    // 极端危险命令（格式化磁盘、删根目录、命令注入）在 shell 层已硬拦，
    // 不依赖这里兜底，故此处放行不会让不可逆操作失去护栏。
    const policy = getActiveSecurityPolicy();
    if (!policy.approveRiskyOperations && (riskLevel === "high" || riskLevel === "critical")) {
      return false;
    }
    return this.config.requireApproval[riskLevel];
  }

  /** Get the risk level for a tool（复合工具需传 args 才能拿到 action 级等级） */
  getRiskLevel(toolName: string, args?: Record<string, unknown>): RiskLevel {
    return this.resolveRiskLevel(toolName, args);
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

    const id = `approval-${Date.now()}-${randomUUID()}`;
    const riskLevel = this.getRiskLevel(toolName, args);

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
    this.markDirty();

    // Create a promise that will be resolved when the user makes a decision
    return new Promise((resolve, reject) => {
      this.approvalResolvers.set(id, {
        resolve: (decision, modifiedArgs) => {
          this.clearPendingTimeout(id);
          pending.status = decision === "modified" ? "modified" : decision;
          pending.decidedAt = Date.now();
          if (modifiedArgs) pending.modifiedArgs = modifiedArgs;
          this.pendingApprovals.set(id, pending);
          this.approvalResolvers.delete(id);
          resolve({ decision, modifiedArgs });
        },
        reject: (error) => {
          this.clearPendingTimeout(id);
          pending.status = "rejected";
          pending.decidedAt = Date.now();
          pending.rejectionReason = error.message;
          this.pendingApprovals.set(id, pending);
          this.approvalResolvers.delete(id);
          reject(error);
        },
      });

      // Set timeout and track handle so it can be cleared on destroy()
      const timeoutId = setTimeout(() => {
        this.pendingTimeouts.delete(id);
        if (this.approvalResolvers.has(id)) {
          pending.status = "expired";
          pending.decidedAt = Date.now();
          this.pendingApprovals.set(id, pending);
          this.approvalResolvers.delete(id);
          resolve({ decision: "rejected" });
        }
      }, this.config.approvalTimeout);
      this.pendingTimeouts.set(id, timeoutId);
    });
  }

  /** Clear the pending timeout for a given approval id (if any) */
  private clearPendingTimeout(id: string): void {
    const handle = this.pendingTimeouts.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.pendingTimeouts.delete(id);
    }
  }

  /** Approve a pending operation */
  approve(approvalId: string, decidedBy: string, trustFuture?: boolean, modifiedArgs?: Record<string, unknown>): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.status !== "pending") return false;

    pending.decidedBy = decidedBy;
    pending.trustFutureOperations = trustFuture;
    // 显式设置状态与决定时间，确保即使没有 resolver（如 loadState 恢复的 pending）状态机也能正确流转
    pending.status = modifiedArgs ? "modified" : "approved";
    pending.decidedAt = Date.now();
    if (modifiedArgs) pending.modifiedArgs = modifiedArgs;

    // Add trust rule if requested
    if (trustFuture) {
      this.addTrustRule({
        toolName: pending.toolName,
        trustedBy: decidedBy,
        createdAt: Date.now(),
        expiresAt: 0, // never expires
      });
    }

    // 清理超时定时器并删除 resolver 条目（防止泄漏与重复处理）
    this.clearPendingTimeout(approvalId);
    const resolver = this.approvalResolvers.get(approvalId);
    if (resolver) {
      this.approvalResolvers.delete(approvalId);
      // 通知等待的 Promise（resolver 内部会冗余设置状态，幂等无副作用）
      if (modifiedArgs) {
        resolver.resolve("modified", modifiedArgs);
      } else {
        resolver.resolve("approved");
      }
    }

    this.markDirty();
    return true;
  }

  /** Reject a pending operation */
  reject(approvalId: string, decidedBy: string, reason?: string): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.status !== "pending") return false;

    pending.decidedBy = decidedBy;
    pending.rejectionReason = reason;
    // 显式设置状态与决定时间，确保状态机正确流转
    pending.status = "rejected";
    pending.decidedAt = Date.now();

    // 清理超时定时器并删除 resolver 条目（防止泄漏与重复处理）
    this.clearPendingTimeout(approvalId);
    const resolver = this.approvalResolvers.get(approvalId);
    if (resolver) {
      this.approvalResolvers.delete(approvalId);
      // 通知等待的 Promise
      resolver.resolve("rejected");
    }

    this.markDirty();
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
    this.markDirty();
  }

  /** Remove a trust rule */
  removeTrustRule(toolName: string): void {
    this.trustRules = this.trustRules.filter(r => r.toolName !== toolName);
    this.markDirty();
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
          if (pattern instanceof RegExp) {
            // 带 g 标志的 RegExp 共享同一实例时 lastIndex 会累积，需重置否则会间歇性失配
            pattern.lastIndex = 0;
            return pattern.test(val);
          }
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

    // \u590d\u5408\u5de5\u5177\uff08file_write / email / skill_manage / video / music\uff09\u7684\u5177\u4f53\u8bed\u4e49
    // \u7531 action \u51b3\u5b9a\uff0c\u6587\u6848\u5fc5\u987b\u6309 action \u53d6\uff1a\u5426\u5219\u5ba1\u6279\u9762\u677f\u4f1a\u9000\u5316\u6210
    // \u300c\u6267\u884c\u5de5\u5177: file_write\u300d\uff0c\u7528\u6237\u65e0\u6cd5\u5224\u65ad\u81ea\u5df1\u6279\u51c6\u7684\u5230\u5e95\u662f\u4ec0\u4e48\u3002
    const actionDescriptions: Record<string, Record<string, string>> = {
      file_write: {
        create: `\u521b\u5efa\u6587\u4ef6: ${String(args.path ?? "")}`,
        modify: `\u4fee\u6539\u6587\u4ef6: ${String(args.path ?? "")}`,
      },
      email: {
        send: `\u53d1\u9001\u90ae\u4ef6\u81f3: ${String(args.to ?? "")}`,
      },
      skill_manage: {
        install: `\u5b89\u88c5\u6280\u80fd: ${String(args.name ?? args.url ?? "")}`,
        find_and_install: `\u67e5\u627e\u5e76\u5b89\u88c5\u6280\u80fd: ${String(args.name ?? args.url ?? "")}`,
      },
      video: {
        download: `\u4e0b\u8f7d\u89c6\u9891: ${String(args.url ?? "")}`,
      },
      music: {
        download: `\u4e0b\u8f7d\u97f3\u4e50: ${String(args.query ?? args.url ?? "")}`,
      },
    };
    const toolDescriptions: Record<string, string> = {
      shell_exec: `\u6267\u884cShell\u547d\u4ee4: ${String(args.command ?? "").slice(0, 100)}`,
      file_delete: `\u5220\u9664\u6587\u4ef6: ${String(args.path ?? "")}`,
      browser_login: `\u767b\u5f55\u7f51\u7ad9: ${String(args.url ?? "")}`,
    };

    const action = typeof args.action === "string" ? args.action : undefined;
    const desc =
      (action !== undefined && actionDescriptions[toolName]?.[action]) ||
      toolDescriptions[toolName] ||
      `\u6267\u884c\u5de5\u5177: ${toolName}`;
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
            this.clearPendingTimeout(id);
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
    // 避免定时器阻止进程退出
    this.cleanupTimer.unref?.();
  }

  /** Stop the cleanup timer and reject all pending approvals */
  destroy(): void {
    this.destroyed = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Clear all pending timeouts
    for (const [, handle] of this.pendingTimeouts) {
      clearTimeout(handle);
    }
    this.pendingTimeouts.clear();
    // Reject all pending approvals
    for (const [, resolver] of this.approvalResolvers) {
      resolver.resolve("rejected");
    }
    this.approvalResolvers.clear();
    // 刷盘确保持久化状态最新
    this.flush();
  }

  /** 标记状态已变更，防抖写入 */
  private markDirty(): void {
    if (this.destroyed) return;
    if (!this.config.storePath) return;
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 2000);
    this.saveTimer.unref?.();
  }

  /** 原子写入状态到磁盘（temp + fsync + rename） */
  private flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.config.storePath) return;
    try {
      const state = {
        trustRules: this.trustRules,
        pendingApprovals: Array.from(this.pendingApprovals.values()).filter(p => p.status === "pending"),
        savedAt: new Date().toISOString(),
      };
      atomicWriteFileSync(this.config.storePath, JSON.stringify(state, null, 2));
      this.dirty = false;
    } catch (err) {
      process.stderr.write("[HumanApproval] flush failed: " + err + "\n");
    }
  }

  /** 从磁盘恢复状态：trust rules 恢复，pending approvals 标记为 expired */
  private loadState(): void {
    if (!this.config.storePath) return;
    try {
      if (!fs.existsSync(this.config.storePath)) return;
      const raw = fs.readFileSync(this.config.storePath, "utf-8");
      const state = JSON.parse(raw);
      if (Array.isArray(state.trustRules)) {
        this.trustRules = state.trustRules;
      }
      if (Array.isArray(state.pendingApprovals)) {
        // Promise resolvers 无法恢复，将 pending 标记为 expired
        const now = Date.now();
        for (const p of state.pendingApprovals) {
          if (p.status === "pending") {
            p.status = "expired";
            p.decidedAt = now;
            p.rejectionReason = "Process restarted";
          }
          if (p.id) {
            this.pendingApprovals.set(p.id, p);
          }
        }
      }
    } catch (err) {
      process.stderr.write("[HumanApproval] loadState failed: " + err + "\n");
    }
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
