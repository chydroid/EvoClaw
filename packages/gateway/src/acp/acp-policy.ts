/**
 * ACP 策略门控 — 对标 OpenClaw src/acp/policy.ts。
 *
 * 控制 ACP 功能的启停与权限检查，避免在未配置或被禁用时
 * 意外暴露 ACP 服务端。
 */

import { AcpError } from "./acp-protocol.js";

// ─── 配置类型 ──────────────────────────────────────────────────────────

/** ACP 配置（对标 OpenClaw AcpConfig 的子集） */
export interface AcpConfig {
  /** 是否启用 ACP（默认 true） */
  enabled?: boolean;
  /** 是否启用 dispatch（默认 true） */
  dispatch?: { enabled?: boolean };
  /** 后端 ID */
  backend?: string;
  /** 备选后端列表 */
  fallbacks?: string[];
  /** 默认代理 */
  defaultAgent?: string;
  /** 允许的代理列表 */
  allowedAgents?: string[];
  /** 最大并发会话数 */
  maxConcurrentSessions?: number;
}

// ─── 策略检查 ──────────────────────────────────────────────────────────

/**
 * 检查 ACP 是否被策略允许。
 *
 * 对标 OpenClaw isAcpEnabledByPolicy(cfg)。
 * 规则：cfg.acp?.enabled !== false（未配置视为启用）。
 */
export function isAcpEnabledByPolicy(cfg: AcpConfig | undefined): boolean {
  return cfg?.enabled !== false;
}

/**
 * 检查 ACP dispatch 是否被策略允许。
 *
 * 对标 OpenClaw resolveAcpDispatchPolicyError()。
 * dispatch 被禁时抛出 AcpError。
 */
export function resolveAcpDispatchPolicyError(cfg: AcpConfig | undefined): AcpError | null {
  if (!isAcpEnabledByPolicy(cfg)) {
    return new AcpError("ACP_DISPATCH_DISABLED", "ACP is disabled by policy");
  }
  if (cfg?.dispatch?.enabled === false) {
    return new AcpError("ACP_DISPATCH_DISABLED", "ACP dispatch is disabled by policy");
  }
  return null;
}

/**
 * 检查 ACP turn 是否被策略允许。
 *
 * 对标 OpenClaw resolveAcpExplicitTurnPolicyError()。
 */
export function resolveAcpExplicitTurnPolicyError(cfg: AcpConfig | undefined): AcpError | null {
  if (!isAcpEnabledByPolicy(cfg)) {
    return new AcpError("ACP_SESSION_INIT_FAILED", "ACP is globally disabled");
  }
  return null;
}

/**
 * 检查代理是否在允许列表中。
 *
 * 对标 OpenClaw resolveAcpAgentPolicyError()。
 * 如果 allowedAgents 未配置或为空，允许所有代理。
 * 如果配置了，代理必须在列表中。
 */
export function resolveAcpAgentPolicyError(
  agentId: string,
  cfg: AcpConfig | undefined,
): AcpError | null {
  if (!isAcpEnabledByPolicy(cfg)) {
    return new AcpError("ACP_SESSION_INIT_FAILED", "ACP is disabled");
  }

  const allowed = cfg?.allowedAgents;
  if (allowed && allowed.length > 0 && !allowed.includes(agentId)) {
    return new AcpError(
      "ACP_SESSION_INIT_FAILED",
      `Agent "${agentId}" is not in the allowed list`,
    );
  }
  return null;
}

/**
 * 检查并发会话数是否超限。
 *
 * @param currentCount 当前活跃会话数
 * @param cfg ACP 配置
 * @returns 超限时返回错误，否则返回 null
 */
export function resolveConcurrentSessionLimitError(
  currentCount: number,
  cfg: AcpConfig | undefined,
): AcpError | null {
  const max = cfg?.maxConcurrentSessions;
  if (max !== undefined && currentCount >= max) {
    return new AcpError(
      "ACP_SESSION_INIT_FAILED",
      `Max concurrent sessions (${max}) reached`,
    );
  }
  return null;
}
