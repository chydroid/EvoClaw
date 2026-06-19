/**
 * Failover Policy — 借鉴 openclaw 的 failover 策略。
 *
 * 核心改进（相比原 EvoClaw 的简单 retryable 布尔值）：
 *  1. transient vs non-transient 失败分类
 *  2. cooldown 探测：允许在冷却期探测瞬时故障
 *  3. probe 预算保护：non-transient 失败不消耗 transient probe 预算
 *  4. 精确的 reason 分类：rate_limit/overloaded/billing/timeout/auth 等
 *
 * 参考：openclaw-main/src/agents/failover-policy.ts
 *
 * 设计哲学（来自 openclaw AGENTS.md）：
 * "Fallback is a product decision, not an implementation convenience"
 * fallback 不是无脑重试，而是基于失败语义的精确决策。
 */

// ── Failover Reason ───────────────────────────────────────

/**
 * 失败原因分类。
 * 区分 transient（可重试）和 non-transient（不可重试）。
 */
export type FailoverReason =
  | "rate_limit"        // 429 限流（transient）
  | "overloaded"        // 529 过载（transient）
  | "billing"           // 402 计费问题（non-transient）
  | "unknown"           // 未知错误（transient，保守重试）
  | "empty_response"    // 空响应（transient）
  | "no_error_details"  // 无错误详情（transient）
  | "unclassified"      // 未分类（transient）
  | "timeout"           // 超时（transient）
  | "model_not_found"   // 模型不存在（non-transient）
  | "format"            // 格式错误（non-transient）
  | "auth"              // 认证失败（non-transient）
  | "auth_permanent"    // 永久认证失败（non-transient）
  | "session_expired"   // 会话过期（non-transient）
  | "context_overflow"  // 上下文溢出（需压缩后重试）
  | "network";          // 网络错误（transient）

// ── Transient Classification ──────────────────────────────

/**
 * 判断失败原因是否为 transient（瞬时，可重试）。
 *
 * transient 失败包括：限流、过载、超时、网络错误、未知错误等。
 * 这些失败通常会在一段时间后自行恢复，适合重试。
 */
export function isTransientReason(reason: FailoverReason | null | undefined): boolean {
  return (
    reason === "rate_limit" ||
    reason === "overloaded" ||
    reason === "unknown" ||
    reason === "empty_response" ||
    reason === "no_error_details" ||
    reason === "unclassified" ||
    reason === "timeout" ||
    reason === "network"
  );
}

/**
 * 判断失败原因是否为 non-transient（非瞬时，不可重试）。
 *
 * non-transient 失败包括：模型不存在、格式错误、认证失败、会话过期等。
 * 这些失败不会自行恢复，重试无意义，应直接 failover 到下一个 provider。
 */
export function isNonTransientReason(reason: FailoverReason | null | undefined): boolean {
  return (
    reason === "model_not_found" ||
    reason === "format" ||
    reason === "auth" ||
    reason === "auth_permanent" ||
    reason === "session_expired" ||
    reason === "billing"
  );
}

// ── Cooldown Probe Policy ─────────────────────────────────

/**
 * 判断失败的模型是否允许在冷却期进行探测。
 *
 * 只有 transient 失败才允许探测——因为它们可能已经恢复。
 * non-transient 失败（如认证错误）不会因为等待而恢复，探测无意义。
 *
 * 参考：openclaw shouldAllowCooldownProbeForReason
 */
export function shouldAllowCooldownProbeForReason(
  reason: FailoverReason | null | undefined,
): boolean {
  return (
    reason === "rate_limit" ||
    reason === "overloaded" ||
    reason === "billing" ||
    reason === "unknown" ||
    reason === "empty_response" ||
    reason === "no_error_details" ||
    reason === "unclassified" ||
    reason === "timeout"
  );
}

/**
 * 判断 transient 失败是否应消耗 transient probe 预算。
 *
 * 所有 transient 失败都应消耗预算，确保探测有上限。
 *
 * 参考：openclaw shouldUseTransientCooldownProbeSlot
 */
export function shouldUseTransientCooldownProbeSlot(
  reason: FailoverReason | null | undefined,
): boolean {
  return (
    reason === "rate_limit" ||
    reason === "overloaded" ||
    reason === "unknown" ||
    reason === "empty_response" ||
    reason === "no_error_details" ||
    reason === "unclassified" ||
    reason === "timeout"
  );
}

/**
 * 判断 non-transient 失败是否应保留 transient probe 预算。
 *
 * non-transient 失败不应消耗为 transient 失败预留的 probe 预算。
 * 这是对传统熔断器的精细化改进——
 * 传统熔断器只有开/关两态，而这里区分了"为什么开"，
 * 避免因为配置错误（non-transient）耗尽了为临时故障（transient）预留的恢复预算。
 *
 * 参考：openclaw shouldPreserveTransientCooldownProbeSlot
 */
export function shouldPreserveTransientCooldownProbeSlot(
  reason: FailoverReason | null | undefined,
): boolean {
  return (
    reason === "model_not_found" ||
    reason === "format" ||
    reason === "auth" ||
    reason === "auth_permanent" ||
    reason === "session_expired"
  );
}

// ── Reason Resolution ─────────────────────────────────────

/**
 * 从 HTTP 状态码和错误文本解析 FailoverReason。
 *
 * 状态码优先，其次匹配错误文本模式。
 */
export function resolveFailoverReason(
  statusCode?: number,
  errorText?: string,
): FailoverReason {
  // 状态码优先
  if (statusCode === 429) return "rate_limit";
  if (statusCode === 401 || statusCode === 403) return "auth";
  if (statusCode === 402) return "billing";
  if (statusCode === 404) return "model_not_found";
  if (statusCode === 408) return "timeout";
  if (statusCode === 413) return "context_overflow";
  if (statusCode === 422) return "format";
  if (statusCode === 429) return "rate_limit";
  if (statusCode === 500 || statusCode === 502 || statusCode === 503) return "overloaded";
  if (statusCode === 504) return "timeout";
  if (statusCode === 529) return "overloaded";

  // 文本匹配
  if (!errorText) return "unknown";

  const lower = errorText.toLowerCase();

  // 上下文溢出
  if (/context.length.exceeded|request_too_large|input.is.too.long|too.many.tokens|token.limit/.test(lower)) {
    return "context_overflow";
  }

  // 限流
  if (/rate.limit|too.many.requests|throttl|requests.too.frequent/.test(lower)) {
    return "rate_limit";
  }

  // 认证
  if (/invalid.api.key|unauthorized|auth.failed|incorrect.api.key|not.authorized|access.denied|permission.denied/.test(lower)) {
    return "auth";
  }

  // 计费
  if (/billing|insufficient.quota|insufficient_quota|account.*balance|payment|credit|usage.limit|subscription/.test(lower)) {
    return "billing";
  }

  // 超时
  if (/timeout|timed.out|etimedout|socket.hang.up/.test(lower)) {
    return "timeout";
  }

  // 网络
  if (/econnreset|enetunreach|ehostunreach|enotfound/.test(lower)) {
    return "network";
  }

  // 过载
  if (/overloaded|service.unavailable|internal.server.error/.test(lower)) {
    return "overloaded";
  }

  // 空响应
  if (/empty.response|no.content|empty.body/.test(lower)) {
    return "empty_response";
  }

  return "unclassified";
}

// ── Cooldown Probe State ──────────────────────────────────

export interface CooldownProbeState {
  /** provider ID */
  providerId: string;
  /** 当前 probe 预算（剩余探测次数） */
  transientProbeBudget: number;
  /** 冷却开始时间 */
  cooldownStartedAt: number;
  /** 冷却持续时间 */
  cooldownDurationMs: number;
  /** 失败原因 */
  reason: FailoverReason;
}

/**
 * 判断是否应执行 cooldown 探测。
 *
 * 只有 transient 失败且 probe 预算 > 0 时才探测。
 */
export function shouldProbeCooldown(
  state: CooldownProbeState,
  now: number = Date.now(),
): boolean {
  // 冷却期未过半，不探测
  const elapsed = now - state.cooldownStartedAt;
  if (elapsed < state.cooldownDurationMs * 0.5) {
    return false;
  }

  // non-transient 失败不探测
  if (!shouldAllowCooldownProbeForReason(state.reason)) {
    return false;
  }

  // 预算耗尽不探测
  if (state.transientProbeBudget <= 0) {
    return false;
  }

  return true;
}

/**
 * 消耗一个 probe 预算（仅对 transient 失败）。
 */
export function consumeProbeBudget(
  state: CooldownProbeState,
  reason: FailoverReason,
): CooldownProbeState {
  if (shouldUseTransientCooldownProbeSlot(reason)) {
    return {
      ...state,
      transientProbeBudget: Math.max(0, state.transientProbeBudget - 1),
    };
  }
  // non-transient 失败保留预算
  return state;
}
