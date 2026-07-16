/**
 * Approval Runtime — 审批流程运行时辅助。
 *
 * 对标 OpenClaw `@openclaw/plugin-sdk/exec-approvals-runtime`。
 *
 * 工具/命令执行前的审批流程：插件可注册自定义审批策略（如 always-ask、
 * auto-approve-sandboxsafe、ask-once-per-session 等）。
 */
import type { PluginLogger } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

export type ApprovalDecision = "approve" | "deny" | "defer";

export interface ApprovalRequest {
  /** 触发审批的操作类型 */
  kind: "tool" | "exec" | "file_write" | "net" | "skill_install";
  /** 操作名（如工具名、命令名） */
  operation: string;
  /** 参数 */
  args?: Readonly<Record<string, unknown>>;
  /** 调用方 session/agent 信息 */
  caller?: {
    sessionId?: string;
    agentId?: string;
    channelId?: string;
  };
  /** 申请原因（由执行方填写） */
  reason?: string;
  /** 风险等级（由执行方或策略填写） */
  riskLevel?: "low" | "medium" | "high" | "critical";
}

export interface ApprovalResult {
  decision: ApprovalDecision;
  /** deny/defer 时的原因 */
  reason?: string;
  /** 审批者（用户/auto policy） */
  approver?: string;
  /** 此次审批的 TTL（ms），同 session 内复用 */
  ttlMs?: number;
}

export interface ApprovalPolicy {
  policyId: string;
  /** 评估请求并返回决策。返回 defer 表示本策略不决策，交下一个策略。 */
  evaluate(req: ApprovalRequest): Promise<ApprovalResult | "defer">;
}

// ── Runtime ──────────────────────────────────────────────────────────

/** 审批运行时上下文。 */
export interface ApprovalRuntimeContext {
  logger: PluginLogger;
  /** 已注册的审批策略（按优先级排序） */
  policies: ReadonlyArray<ApprovalPolicy>;
  /** 默认决策（无策略匹配时） */
  defaultDecision: ApprovalDecision;
}

/**
 * 执行审批流程：按策略优先级依次评估，首个非 defer 结果胜出。
 * 全部 defer 时返回 defaultDecision。
 */
export async function evaluateApproval(
  ctx: ApprovalRuntimeContext,
  req: ApprovalRequest,
): Promise<ApprovalResult> {
  for (const policy of ctx.policies) {
    try {
      const result = await policy.evaluate(req);
      if (result !== "defer") {
        return result;
      }
    } catch (err) {
      ctx.logger.warn(
        `approval policy "${policy.policyId}" threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { decision: ctx.defaultDecision, reason: "no policy matched" };
}

/**
 * 工厂：创建一个 always-ask 策略（每次都返回 defer，等用户决策）。
 * 用于调试或作为兜底策略。
 */
export function createAlwaysAskPolicy(): ApprovalPolicy {
  return {
    policyId: "always-ask",
    async evaluate() {
      return "defer";
    },
  };
}

/**
 * 工厂：创建一个 auto-approve 策略，匹配指定 kind/operation。
 */
export function createAutoApprovePolicy(opts: {
  policyId: string;
  matchKinds?: ReadonlyArray<ApprovalRequest["kind"]>;
  matchOperations?: ReadonlyArray<string>;
  maxRiskLevel?: ApprovalRequest["riskLevel"];
}): ApprovalPolicy {
  const riskRank: Record<NonNullable<ApprovalRequest["riskLevel"]>, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  const maxRisk = opts.maxRiskLevel ? riskRank[opts.maxRiskLevel] : Infinity;
  return {
    policyId: opts.policyId,
    async evaluate(req) {
      if (opts.matchKinds && !opts.matchKinds.includes(req.kind)) return "defer";
      if (opts.matchOperations && !opts.matchOperations.includes(req.operation)) return "defer";
      const reqRisk = req.riskLevel ? riskRank[req.riskLevel] : 0;
      if (reqRisk > maxRisk) return "defer";
      return { decision: "approve", approver: opts.policyId };
    },
  };
}
