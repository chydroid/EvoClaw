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
 *
 * 借鉴 hermes-agent agent/error_classifier.py FailoverReason 枚举（21 种）。
 * EvoClaw 在原 15 种基础上补充以下 6 种以对齐 hermes-agent 的分类粒度：
 *   - provider_policy_blocked   聚合器（如 OpenRouter）因账户数据/隐私策略阻止
 *   - content_policy_blocked    Provider 安全过滤器拒绝（确定性，不可重试）
 *   - invalid_encrypted_content Responses API replay blob 被拒（剥离后重试）
 *   - multimodal_tool_content_unsupported  Provider 拒绝 tool 消息中的列表内容
 *   - thinking_signature        Anthropic thinking 块签名无效
 *   - long_context_tier         Anthropic "extra usage" 长上下文层级门控
 *   - payload_too_large         413 请求体过大
 *   - image_too_large           图片超过 provider 单图限制
 *   - server_error              500/502 内部服务器错误
 *   - format_error              400 请求格式错误（重命名为 format_error 对齐 hermes-agent）
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
  | "format"            // 格式错误（non-transient，旧名，保留向后兼容）
  | "format_error"      // 格式错误（non-transient，对齐 hermes-agent 命名）
  | "auth"              // 认证失败（non-transient）
  | "auth_permanent"    // 永久认证失败（non-transient）
  | "session_expired"   // 会话过期（non-transient）
  | "context_overflow"  // 上下文溢出（需压缩后重试）
  | "network"           // 网络错误（transient）
  // ── 以下为对齐 hermes-agent 新增的原因 ──
  | "server_error"      // 500/502 内部服务器错误（transient）
  | "payload_too_large" // 413 请求体过大（transient，需压缩）
  | "image_too_large"   // 图片超过 provider 单图限制（transient，需缩小）
  | "provider_policy_blocked"   // 聚合器账户策略阻止（non-transient）
  | "content_policy_blocked"    // Provider 安全过滤拒绝（non-transient，需 fallback）
  | "invalid_encrypted_content" // Responses API replay blob 无效（transient，剥离后重试）
  | "multimodal_tool_content_unsupported" // Provider 拒绝 tool 消息列表内容（transient，降级为文本）
  | "thinking_signature"        // Anthropic thinking 块签名无效（transient，剥离后重试）
  | "long_context_tier";        // Anthropic 长上下文层级门控（transient，需压缩）

// ── Transient Classification ──────────────────────────────

/**
 * 判断失败原因是否为 transient（瞬时，可重试）。
 *
 * transient 失败包括：限流、过载、超时、网络错误、未知错误等。
 * 这些失败通常会在一段时间后自行恢复，适合重试。
 *
 * 新增的 hermes-agent 对齐原因中，以下为 transient：
 *   - server_error              服务器内部错误，可重试
 *   - payload_too_large         请求体过大，压缩后可重试
 *   - image_too_large           图片过大，缩小后可重试
 *   - invalid_encrypted_content replay blob 无效，剥离后可重试
 *   - multimodal_tool_content_unsupported  降级为文本后可重试
 *   - thinking_signature        剥离 thinking 块后可重试
 *   - long_context_tier         压缩上下文后可重试
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
    reason === "network" ||
    reason === "server_error" ||
    reason === "payload_too_large" ||
    reason === "image_too_large" ||
    reason === "invalid_encrypted_content" ||
    reason === "multimodal_tool_content_unsupported" ||
    reason === "thinking_signature" ||
    reason === "long_context_tier"
  );
}

/**
 * 判断失败原因是否为 non-transient（非瞬时，不可重试）。
 *
 * non-transient 失败包括：模型不存在、格式错误、认证失败、会话过期等。
 * 这些失败不会自行恢复，重试无意义，应直接 failover 到下一个 provider。
 *
 * 新增的 hermes-agent 对齐原因中，以下为 non-transient：
 *   - provider_policy_blocked   账户策略阻止，重试无意义
 *   - content_policy_blocked    安全过滤确定性拒绝，重试同样结果
 */
export function isNonTransientReason(reason: FailoverReason | null | undefined): boolean {
  return (
    reason === "model_not_found" ||
    reason === "format" ||
    reason === "format_error" ||
    reason === "auth" ||
    reason === "auth_permanent" ||
    reason === "session_expired" ||
    reason === "billing" ||
    reason === "provider_policy_blocked" ||
    reason === "content_policy_blocked"
  );
}

// ── Cooldown Probe Policy ─────────────────────────────────

/**
 * 判断失败的模型是否允许在冷却期进行探测。
 *
 * 只有 transient 失败才允许探测——因为它们可能已经恢复。
 * non-transient 失败（如认证错误）不会因为等待而恢复，探测无意义。
 *
 * 注意：billing 虽为 non-transient，但 hermes-agent 允许其探测
 * （可能是用户在等待期间充值了）。
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
    reason === "timeout" ||
    reason === "server_error" ||
    reason === "payload_too_large" ||
    reason === "image_too_large" ||
    reason === "invalid_encrypted_content" ||
    reason === "multimodal_tool_content_unsupported" ||
    reason === "thinking_signature" ||
    reason === "long_context_tier"
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
    reason === "timeout" ||
    reason === "server_error" ||
    reason === "payload_too_large" ||
    reason === "image_too_large" ||
    reason === "invalid_encrypted_content" ||
    reason === "multimodal_tool_content_unsupported" ||
    reason === "thinking_signature" ||
    reason === "long_context_tier"
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
    reason === "format_error" ||
    reason === "auth" ||
    reason === "auth_permanent" ||
    reason === "session_expired" ||
    reason === "provider_policy_blocked" ||
    reason === "content_policy_blocked"
  );
}

// ── Reason Resolution ─────────────────────────────────────

/**
 * 从 HTTP 状态码和错误文本解析 FailoverReason。
 *
 * 状态码优先，其次匹配错误文本模式。
 *
 * 借鉴 hermes-agent agent/error_classifier.py 的优先级管线：
 *   1. Provider-specific patterns（thinking_signature、long_context_tier 等）
 *   2. HTTP status code + message-aware refinement
 *   3. Error code classification
 *   4. Message pattern matching
 *
 * 注意：EvoClaw 的实现是简化版，只做状态码 + 文本模式匹配。
 * 完整的 8 步分类管线在 error-classifier.ts 中实现。
 */
export function resolveFailoverReason(
  statusCode?: number,
  errorText?: string,
): FailoverReason {
  // ── 1. Provider-specific patterns（最高优先级） ──

  // Anthropic thinking block signature（400 + thinking + signature/cannot be modified）
  if (statusCode === 400 && errorText) {
    const lower = errorText.toLowerCase();
    if (lower.includes("thinking") && (
      lower.includes("signature") ||
      lower.includes("cannot be modified") ||
      lower.includes("must remain as they were")
    )) {
      return "thinking_signature";
    }
  }

  // Anthropic long-context tier gate（429 + extra usage + long context）
  if (statusCode === 429 && errorText) {
    const lower = errorText.toLowerCase();
    if (lower.includes("extra usage") && lower.includes("long context")) {
      return "long_context_tier";
    }
  }

  // Provider content-policy / safety-filter block（确定性拒绝，不可重试）
  if (errorText) {
    const lower = errorText.toLowerCase();
    const CONTENT_POLICY_PATTERNS = [
      "flagged for possible cybersecurity risk",
      "trusted access for cyber",
      "violates our usage policies",
      "violates openai's usage policies",
      "your request was flagged by",
      "prompt was flagged by our safety",
      "responses cannot be generated due to safety",
      "content_filter",
      "responsibleaipolicyviolation",
    ];
    if (CONTENT_POLICY_PATTERNS.some((p) => lower.includes(p))) {
      return "content_policy_blocked";
    }
  }

  // OpenRouter provider-policy block（404 + "no endpoints available matching your"）
  if (errorText) {
    const lower = errorText.toLowerCase();
    if (
      lower.includes("no endpoints available matching your guardrail") ||
      lower.includes("no endpoints available matching your data policy") ||
      lower.includes("no endpoints found matching your data policy")
    ) {
      return "provider_policy_blocked";
    }
  }

  // Multimodal tool content unsupported（400 + 特定消息）
  if (statusCode === 400 && errorText) {
    const lower = errorText.toLowerCase();
    const MULTIMODAL_PATTERNS = [
      "text is not set",
      "tool message content must be a string",
      "tool content must be a string",
      "tool message must be a string",
      "expected string, got list",
      "expected string, got array",
      "tool_call.content must be string",
    ];
    if (MULTIMODAL_PATTERNS.some((p) => lower.includes(p))) {
      return "multimodal_tool_content_unsupported";
    }
  }

  // Invalid encrypted content（Responses API replay blob）
  if (errorText) {
    const lower = errorText.toLowerCase();
    if (
      lower.includes("invalid_encrypted_content") ||
      (lower.includes("encrypted content for item") && lower.includes("could not be verified"))
    ) {
      return "invalid_encrypted_content";
    }
  }

  // ── 2. HTTP status code classification ──

  if (statusCode === 429) return "rate_limit";
  if (statusCode === 401 || statusCode === 403) return "auth";
  if (statusCode === 402) return "billing";
  if (statusCode === 404) {
    // 404 可能是 model_not_found 或 provider_policy_blocked（已在上面处理）
    if (errorText) {
      const lower = errorText.toLowerCase();
      if (/is not a valid model|invalid model|model not found|model_not_found|does not exist|no such model|unknown model|unsupported model/.test(lower)) {
        return "model_not_found";
      }
    }
    return "model_not_found";
  }
  if (statusCode === 408) return "timeout";
  if (statusCode === 413) return "payload_too_large";
  if (statusCode === 422) return "format";
  if (statusCode === 500 || statusCode === 502) return "server_error";
  if (statusCode === 503 || statusCode === 529) return "overloaded";
  if (statusCode === 504) return "timeout";

  // ── 3. Message pattern matching（无状态码时） ──

  if (!errorText) return "unknown";

  const lower = errorText.toLowerCase();

  // 上下文溢出
  if (/context.length.exceeded|request_too_large|input.is.too.long|too.many.tokens|token.limit|context.window|prompt.is.too.long|prompt.exceeds.max.length|max_model_len|context.length.exceeded/.test(lower)) {
    return "context_overflow";
  }

  // 图片过大
  if (/image.exceeds|image.too.large|image_too_large|image.size.exceeds|image.dimensions.exceed/.test(lower)) {
    return "image_too_large";
  }

  // 请求体过大
  if (/request.entity.too.large|payload.too.large|error.code:.?413/.test(lower)) {
    return "payload_too_large";
  }

  // 限流
  if (/rate.limit|too.many.requests|throttl|requests.too.frequent|resource.exhausted|try.again.in|please.retry.after/.test(lower)) {
    return "rate_limit";
  }

  // 认证
  if (/invalid.api.key|unauthorized|auth.failed|incorrect.api.key|not.authorized|access.denied|permission.denied|token.expired|token.revoked/.test(lower)) {
    return "auth";
  }

  // 计费
  if (/billing|insufficient.quota|insufficient_quota|account.*balance|payment|credit|usage.limit|subscription|insufficient.credits|credits.exhausted|out.of.funds|balance.depleted/.test(lower)) {
    return "billing";
  }

  // 超时
  if (/timeout|timed.out|etimedout|socket.hang.up|deadline.exceeded/.test(lower)) {
    return "timeout";
  }

  // 网络
  if (/econnreset|enetunreach|ehostunreach|enotfound|server.disconnected|peer.closed.connection|connection.reset.by.peer/.test(lower)) {
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
