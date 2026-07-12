// ── Approval Timeout Manager ──
// 实现 OpenClaw 6.6 引入的"approval fail-closed on timeout"语义
// 关键不变量: 超时后默认拒绝执行, 避免无限等待带来的歧义

/** 审批状态 */
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "error";

/** 审批请求 */
export interface ApprovalRequest {
  id: string;
  prompt: string;
  context: Record<string, unknown>;
  requestedAt: number;
  expiresAt: number; // 过期时间戳
  timeoutMs: number; // 超时时间
  requester: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  channel?: string; // 来自哪个channel (telegram/discord/signal等)
  metadata?: Record<string, unknown>;
  /** 单个请求的 fallback 覆盖（优先于全局配置） */
  fallbackOverride?: "deny" | "allow" | "fail-closed";
}

/** 审批决策 */
export interface ApprovalDecision {
  id: string;
  requestId: string;
  status: ApprovalStatus;
  decidedBy?: string; // 决策者
  decidedAt?: number;
  reason?: string; // 决策理由
  autoDecisionReason?: string; // 自动决策理由(如超时)
}

/** 审批管理器配置 */
export interface ApprovalTimeoutConfig {
  defaultTimeoutMs?: number; // 默认超时(5000ms)
  lowRiskTimeoutMs?: number; // 低风险超时(3000ms)
  mediumRiskTimeoutMs?: number; // 中风险超时(5000ms)
  highRiskTimeoutMs?: number; // 高风险超时(10000ms)
  criticalRiskTimeoutMs?: number; // 极高风险超时(15000ms)
  onExpired?: (request: ApprovalRequest) => Promise<void> | void; // 超时回调
  onApproved?: (request: ApprovalRequest) => Promise<void> | void;
  onDenied?: (request: ApprovalRequest, reason?: string) => Promise<void> | void;
  cleanupIntervalMs?: number; // 清理间隔(默认60000ms)
  /** 超时后的回退策略，默认 "fail-closed"（fail-closed） */
  askFallback?: "deny" | "allow" | "fail-closed";
}

/** 审计日志条目 */
export interface ApprovalAuditEntry {
  id: string;
  requestId: string;
  action: "timeout" | "approved" | "denied" | "fail-closed";
  riskLevel: string;
  timeoutMs: number;
  timestamp: number;
  fallbackPolicy: string;
  metadata?: Record<string, unknown>;
}

/** 审计日志最大保留条数（防止 auditLog 无界增长） */
const MAX_AUDIT_LOG = 1000;

/** 审批等待Promise解析器 */
interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

/**
 * ApprovalTimeoutManager
 * 核心原则: timeout → fail-closed (deny)
 * 即使UI没响应, 系统也不会无限期等待
 */
export class ApprovalTimeoutManager {
  private defaultTimeoutMs: number;
  private riskTimeouts: Record<string, number>;
  private onExpired?: (req: ApprovalRequest) => Promise<void> | void;
  private onApproved?: (req: ApprovalRequest) => Promise<void> | void;
  private onDenied?: (req: ApprovalRequest, reason?: string) => Promise<void> | void;
  private cleanupIntervalMs: number;
  private askFallback: "deny" | "allow" | "fail-closed";

  private pending = new Map<string, PendingApproval>();
  private history: ApprovalDecision[] = [];
  private auditLog: ApprovalAuditEntry[] = [];
  private cleanupTimer?: NodeJS.Timeout;
  private approvalCounter = 0;
  private stats = {
    total: 0,
    approved: 0,
    denied: 0,
    expired: 0,
    errored: 0,
    avgResponseMs: 0,
    totalResponseMs: 0,
  };

  constructor(config: ApprovalTimeoutConfig = {}) {
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 5000;
    this.riskTimeouts = {
      low: config.lowRiskTimeoutMs ?? 3000,
      medium: config.mediumRiskTimeoutMs ?? 5000,
      high: config.highRiskTimeoutMs ?? 10000,
      critical: config.criticalRiskTimeoutMs ?? 15000,
    };
    this.onExpired = config.onExpired;
    this.onApproved = config.onApproved;
    this.onDenied = config.onDenied;
    this.cleanupIntervalMs = config.cleanupIntervalMs ?? 60000;
    this.askFallback = config.askFallback ?? "fail-closed";

    // 启动定期清理
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  /**
   * 提交审批请求并等待决策
   * 关键: 如果超时, fail-closed → 返回denied决策
   */
  async request(request: Omit<ApprovalRequest, "id" | "requestedAt" | "expiresAt" | "timeoutMs">): Promise<ApprovalDecision> {
    const id = `approval-${++this.approvalCounter}-${Date.now()}`;
    const now = Date.now();
    const timeoutMs = this.riskTimeouts[request.riskLevel] ?? this.defaultTimeoutMs;
    const fullRequest: ApprovalRequest = {
      ...request,
      id,
      requestedAt: now,
      expiresAt: now + timeoutMs,
      timeoutMs,
    };
    this.stats.total++;

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        // 根据 askFallback 决定超时行为 — expireApproval 内部计算正确决策并 resolve
        const fallback = fullRequest.fallbackOverride ?? this.askFallback;
        void this.expireApproval(id, fullRequest, fallback).catch((err) => {
          process.stderr.write("[ApprovalTimeout] expireApproval failed:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
          // 即使 expireApproval 失败也需 resolve，避免调用方永久等待
          resolve({
            id: `decision-${id}-error`,
            requestId: id,
            status: "expired",
            decidedAt: Date.now(),
            reason: `Approval expired but handler failed: ${err instanceof Error ? err.message : String(err)}`,
            autoDecisionReason: "timeout-error",
          });
        });
      }, timeoutMs);
      this.pending.set(id, { request: fullRequest, resolve, timer });
    });
  }

  /** 批准审批 */
  async approve(requestId: string, decidedBy: string, reason?: string): Promise<boolean> {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    const now = Date.now();
    const responseMs = now - pending.request.requestedAt;
    this.stats.approved++;
    this.stats.totalResponseMs += responseMs;
    this.stats.avgResponseMs = this.stats.totalResponseMs / (this.stats.approved + this.stats.denied);
    const decision: ApprovalDecision = {
      id: `decision-${requestId}-approved`,
      requestId,
      status: "approved",
      decidedBy,
      decidedAt: now,
      reason,
    };
    this.history.push(decision);
    if (this.onApproved) {
      try { await this.onApproved(pending.request); } catch (err) { console.debug("[ApprovalTimeout]", err); }
    }
    pending.resolve(decision);
    return true;
  }

  /** 拒绝审批 */
  async deny(requestId: string, decidedBy: string, reason?: string): Promise<boolean> {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    const now = Date.now();
    const responseMs = now - pending.request.requestedAt;
    this.stats.denied++;
    this.stats.totalResponseMs += responseMs;
    this.stats.avgResponseMs = this.stats.totalResponseMs / (this.stats.approved + this.stats.denied);
    const decision: ApprovalDecision = {
      id: `decision-${requestId}-denied`,
      requestId,
      status: "denied",
      decidedBy,
      decidedAt: now,
      reason,
    };
    this.history.push(decision);
    if (this.onDenied) {
      try { await this.onDenied(pending.request, reason); } catch (err) {
        process.stderr.write(`[ApprovalTimeout] onDenied callback failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    pending.resolve(decision);
    return true;
  }

  /** 触发过期 — 根据 fallback 策略计算正确的决策并 resolve */
  private async expireApproval(id: string, request: ApprovalRequest, fallback: "deny" | "allow" | "fail-closed"): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.stats.expired++;

    // 记录审计日志
    const auditAction = fallback === "fail-closed" ? "fail-closed" : "timeout";
    this.auditLog.push({
      id: `audit-${id}-${Date.now()}`,
      requestId: id,
      action: auditAction,
      riskLevel: request.riskLevel,
      timeoutMs: request.timeoutMs,
      timestamp: Date.now(),
      fallbackPolicy: fallback,
      metadata: request.metadata,
    });

    // 根据 fallback 策略计算正确的决策（而非硬编码 "expired"）
    let decision: ApprovalDecision;
    if (fallback === "allow") {
      decision = {
        id: `decision-${id}-timeout-allow`,
        requestId: id,
        status: "approved",
        decidedAt: Date.now(),
        reason: `Approval timed out after ${request.timeoutMs}ms - fallback policy: allow`,
        autoDecisionReason: "timeout-allow",
      };
      this.stats.approved++;
    } else if (fallback === "deny") {
      decision = {
        id: `decision-${id}-timeout-deny`,
        requestId: id,
        status: "denied",
        decidedAt: Date.now(),
        reason: `Approval timed out after ${request.timeoutMs}ms - fallback policy: deny`,
        autoDecisionReason: "timeout-deny",
      };
      this.stats.denied++;
    } else {
      // fail-closed: 拒绝并记录审计日志
      decision = {
        id: `decision-${id}-expired`,
        requestId: id,
        status: "expired",
        decidedAt: Date.now(),
        reason: `Approval timed out after ${request.timeoutMs}ms - fail-closed policy: denied`,
        autoDecisionReason: "timeout",
      };
    }
    this.history.push(decision);
    if (this.onExpired) {
      try { await this.onExpired(request); } catch (err) { console.debug("[ApprovalTimeout]", err); }
    }
    pending.resolve(decision);
  }

  /** 获取待处理列表 */
  getPending(): ApprovalRequest[] {
    return Array.from(this.pending.values()).map((p) => p.request);
  }

  /** 获取历史 */
  getHistory(limit = 100): ApprovalDecision[] {
    return this.history.slice(-limit);
  }

  /** 获取统计 */
  getStats() {
    return { ...this.stats, pendingCount: this.pending.size, askFallback: this.askFallback };
  }

  /**
   * 获取配置（映射为 WebUI ApprovalCenterPage 期望的字段名）。
   * 仅 defaultTimeoutMs 与 askFallback 有真实后端语义；
   * 其余字段返回默认值，前端据此渲染 Settings 表单。
   */
  getConfig() {
    return {
      timeoutSeconds: Math.round(this.defaultTimeoutMs / 1000),
      defaultAction: this.askFallback,
      behaviorMode: "immediate" as const,
      debounceWindowMs: this.cleanupIntervalMs,
      scheduleCron: "",
      escalationEnabled: false,
      escalationTimeout: 60,
    };
  }

  /**
   * 更新可运行时修改的配置字段。
   * 仅 defaultTimeoutMs 与 askFallback 可热更新；
   * 其余字段（behaviorMode / scheduleCron / escalation*）无后端实现，忽略。
   */
  updateConfig(partial: {
    timeoutSeconds?: number;
    defaultAction?: "deny" | "allow" | "fail-closed";
  }): void {
    if (typeof partial.timeoutSeconds === "number" && partial.timeoutSeconds > 0) {
      this.defaultTimeoutMs = partial.timeoutSeconds * 1000;
    }
    if (partial.defaultAction === "deny" || partial.defaultAction === "allow" || partial.defaultAction === "fail-closed") {
      this.askFallback = partial.defaultAction;
    }
  }

  /** 获取审计日志 */
  getAuditLog(limit = 100): ApprovalAuditEntry[] {
    return this.auditLog.slice(-limit);
  }

  /** 清理已完成的过期entries */
  private cleanup(): void {
    const now = Date.now();
    // 清理超过1小时的历史
    const cutoff = now - 3600000;
    this.history = this.history.filter((d) => (d.decidedAt ?? 0) > cutoff);
    // 清理过期的审计日志（基于 timestamp），并限制最大长度防止无界增长
    this.auditLog = this.auditLog.filter((e) => e.timestamp > cutoff);
    if (this.auditLog.length > MAX_AUDIT_LOG) {
      this.auditLog = this.auditLog.slice(-MAX_AUDIT_LOG);
    }
  }

  /** 关闭管理器 */
  shutdown(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    // 根据 askFallback 决定如何处理 pending 请求
    const fallback = this.askFallback;
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      if (fallback === "allow") {
        // 放行所有 pending
        pending.resolve({
          id: `decision-${id}-shutdown`,
          requestId: id,
          status: "approved",
          decidedAt: Date.now(),
          reason: "Manager shutdown - fallback policy: allow",
          autoDecisionReason: "shutdown-allow",
        });
      } else {
        // deny / fail-closed: 拒绝所有 pending
        pending.resolve({
          id: `decision-${id}-shutdown`,
          requestId: id,
          status: "denied",
          decidedAt: Date.now(),
          reason: "Manager shutdown - fail-closed",
          autoDecisionReason: "shutdown",
        });
      }
    }
    this.pending.clear();
  }
}
