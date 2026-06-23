import { describe, it, expect } from "vitest";
import {
  isTransientReason,
  isNonTransientReason,
  shouldAllowCooldownProbeForReason,
  shouldUseTransientCooldownProbeSlot,
  shouldPreserveTransientCooldownProbeSlot,
  resolveFailoverReason,
  shouldProbeCooldown,
  consumeProbeBudget,
  type FailoverReason,
  type CooldownProbeState,
} from "./failover-policy";

// ═══════════════════════════════════════════════════════════
// 测试套件 2: failover-policy（transient分类+cooldown探测）
// 覆盖：基础功能验证、边界条件、异常输入
// ═══════════════════════════════════════════════════════════

describe("failover-policy > isTransientReason", () => {
  // TC-024: transient 原因识别
  it("TC-024: rate_limit/overloaded/timeout 是 transient", () => {
    expect(isTransientReason("rate_limit")).toBe(true);
    expect(isTransientReason("overloaded")).toBe(true);
    expect(isTransientReason("timeout")).toBe(true);
    expect(isTransientReason("network")).toBe(true);
    expect(isTransientReason("unknown")).toBe(true);
    expect(isTransientReason("empty_response")).toBe(true);
  });

  // TC-025: non-transient 原因识别
  it("TC-025: auth/billing/model_not_found 不是 transient", () => {
    expect(isTransientReason("auth")).toBe(false);
    expect(isTransientReason("auth_permanent")).toBe(false);
    expect(isTransientReason("billing")).toBe(false);
    expect(isTransientReason("model_not_found")).toBe(false);
    expect(isTransientReason("format")).toBe(false);
    expect(isTransientReason("session_expired")).toBe(false);
  });

  // TC-026: null/undefined 边界
  it("TC-026: null/undefined 不是 transient", () => {
    expect(isTransientReason(null)).toBe(false);
    expect(isTransientReason(undefined)).toBe(false);
  });
});

describe("failover-policy > isNonTransientReason", () => {
  // TC-027: non-transient 原因识别
  it("TC-027: auth/billing/model_not_found 是 non-transient", () => {
    expect(isNonTransientReason("auth")).toBe(true);
    expect(isNonTransientReason("billing")).toBe(true);
    expect(isNonTransientReason("model_not_found")).toBe(true);
    expect(isNonTransientReason("format")).toBe(true);
  });

  // TC-028: transient 原因不是 non-transient
  it("TC-028: rate_limit/timeout 不是 non-transient", () => {
    expect(isNonTransientReason("rate_limit")).toBe(false);
    expect(isNonTransientReason("timeout")).toBe(false);
  });
});

describe("failover-policy > shouldAllowCooldownProbeForReason", () => {
  // TC-029: transient 失败允许探测
  it("TC-029: rate_limit/overloaded 允许 cooldown 探测", () => {
    expect(shouldAllowCooldownProbeForReason("rate_limit")).toBe(true);
    expect(shouldAllowCooldownProbeForReason("overloaded")).toBe(true);
    expect(shouldAllowCooldownProbeForReason("timeout")).toBe(true);
  });

  // TC-030: non-transient 失败不允许探测
  it("TC-030: auth/model_not_found 不允许 cooldown 探测", () => {
    expect(shouldAllowCooldownProbeForReason("auth")).toBe(false);
    expect(shouldAllowCooldownProbeForReason("model_not_found")).toBe(false);
    expect(shouldAllowCooldownProbeForReason("format")).toBe(false);
  });
});

describe("failover-policy > shouldPreserveTransientCooldownProbeSlot", () => {
  // TC-031: non-transient 保留 probe 预算
  it("TC-031: auth/model_not_found 保留 transient probe 预算", () => {
    expect(shouldPreserveTransientCooldownProbeSlot("auth")).toBe(true);
    expect(shouldPreserveTransientCooldownProbeSlot("model_not_found")).toBe(true);
    expect(shouldPreserveTransientCooldownProbeSlot("format")).toBe(true);
    expect(shouldPreserveTransientCooldownProbeSlot("session_expired")).toBe(true);
  });

  // TC-032: transient 不保留 probe 预算
  it("TC-032: rate_limit/timeout 不保留 probe 预算", () => {
    expect(shouldPreserveTransientCooldownProbeSlot("rate_limit")).toBe(false);
    expect(shouldPreserveTransientCooldownProbeSlot("timeout")).toBe(false);
  });
});

describe("failover-policy > resolveFailoverReason", () => {
  // TC-033: 状态码解析
  it("TC-033: 429 → rate_limit, 401 → auth, 402 → billing", () => {
    expect(resolveFailoverReason(429)).toBe("rate_limit");
    expect(resolveFailoverReason(401)).toBe("auth");
    expect(resolveFailoverReason(403)).toBe("auth");
    expect(resolveFailoverReason(402)).toBe("billing");
    expect(resolveFailoverReason(404)).toBe("model_not_found");
    expect(resolveFailoverReason(408)).toBe("timeout");
    // 413 现在分类为 payload_too_large（对齐 hermes-agent），不再笼统归为 context_overflow
    expect(resolveFailoverReason(413)).toBe("payload_too_large");
    // 500/502 现在分类为 server_error（对齐 hermes-agent），503/529 仍为 overloaded
    expect(resolveFailoverReason(500)).toBe("server_error");
    expect(resolveFailoverReason(502)).toBe("server_error");
    expect(resolveFailoverReason(503)).toBe("overloaded");
    expect(resolveFailoverReason(529)).toBe("overloaded");
    expect(resolveFailoverReason(504)).toBe("timeout");
  });

  // TC-034: 文本匹配解析
  it("TC-034: 从错误文本解析 reason", () => {
    expect(resolveFailoverReason(undefined, "rate limit exceeded")).toBe("rate_limit");
    expect(resolveFailoverReason(undefined, "invalid api key")).toBe("auth");
    expect(resolveFailoverReason(undefined, "insufficient quota")).toBe("billing");
    expect(resolveFailoverReason(undefined, "request timed out")).toBe("timeout");
    expect(resolveFailoverReason(undefined, "ECONNRESET")).toBe("network");
    expect(resolveFailoverReason(undefined, "context length exceeded")).toBe("context_overflow");
  });

  // TC-035: 无信息返回 unknown
  it("TC-035: 无状态码和文本返回 unknown", () => {
    expect(resolveFailoverReason(undefined, undefined)).toBe("unknown");
    expect(resolveFailoverReason(undefined, "")).toBe("unknown");
  });

  // TC-035a: hermes-agent 对齐的新原因 — provider-specific patterns
  it("TC-035a: thinking_signature 从 400 + thinking + signature 识别", () => {
    expect(resolveFailoverReason(400, "thinking block signature invalid")).toBe("thinking_signature");
    expect(resolveFailoverReason(400, "thinking blocks cannot be modified")).toBe("thinking_signature");
    expect(resolveFailoverReason(400, "thinking must remain as they were")).toBe("thinking_signature");
  });

  it("TC-035b: long_context_tier 从 429 + extra usage + long context 识别", () => {
    expect(resolveFailoverReason(429, "extra usage: long context tier required")).toBe("long_context_tier");
  });

  it("TC-035c: content_policy_blocked 从安全过滤消息识别", () => {
    expect(resolveFailoverReason(400, "content_filter triggered")).toBe("content_policy_blocked");
    expect(resolveFailoverReason(undefined, "prompt was flagged by our safety system")).toBe("content_policy_blocked");
    expect(resolveFailoverReason(undefined, "violates our usage policies")).toBe("content_policy_blocked");
  });

  it("TC-035d: provider_policy_blocked 从 OpenRouter 消息识别", () => {
    expect(resolveFailoverReason(404, "no endpoints available matching your data policy")).toBe("provider_policy_blocked");
    expect(resolveFailoverReason(undefined, "no endpoints found matching your data policy")).toBe("provider_policy_blocked");
  });

  it("TC-035e: multimodal_tool_content_unsupported 从 400 消息识别", () => {
    expect(resolveFailoverReason(400, "tool message content must be a string")).toBe("multimodal_tool_content_unsupported");
    expect(resolveFailoverReason(400, "expected string, got list")).toBe("multimodal_tool_content_unsupported");
  });

  it("TC-035f: invalid_encrypted_content 从 replay blob 消息识别", () => {
    expect(resolveFailoverReason(400, "invalid_encrypted_content")).toBe("invalid_encrypted_content");
    expect(resolveFailoverReason(undefined, "encrypted content for item could not be verified")).toBe("invalid_encrypted_content");
  });

  it("TC-035g: image_too_large 从图片过大消息识别", () => {
    expect(resolveFailoverReason(400, "image exceeds 5 MB maximum")).toBe("image_too_large");
    expect(resolveFailoverReason(undefined, "image dimensions exceed max allowed size")).toBe("image_too_large");
  });

  it("TC-035h: payload_too_large 从 413 或消息识别", () => {
    expect(resolveFailoverReason(413)).toBe("payload_too_large");
    expect(resolveFailoverReason(undefined, "request entity too large")).toBe("payload_too_large");
  });

  it("TC-035i: server_error 从 500/502 识别", () => {
    expect(resolveFailoverReason(500)).toBe("server_error");
    expect(resolveFailoverReason(502)).toBe("server_error");
  });
});

describe("failover-policy > 新增 hermes-agent 原因的 transient/non-transient 分类", () => {
  it("新增 transient 原因正确分类", () => {
    expect(isTransientReason("server_error")).toBe(true);
    expect(isTransientReason("payload_too_large")).toBe(true);
    expect(isTransientReason("image_too_large")).toBe(true);
    expect(isTransientReason("invalid_encrypted_content")).toBe(true);
    expect(isTransientReason("multimodal_tool_content_unsupported")).toBe(true);
    expect(isTransientReason("thinking_signature")).toBe(true);
    expect(isTransientReason("long_context_tier")).toBe(true);
  });

  it("新增 non-transient 原因正确分类", () => {
    expect(isNonTransientReason("provider_policy_blocked")).toBe(true);
    expect(isNonTransientReason("content_policy_blocked")).toBe(true);
    expect(isNonTransientReason("format_error")).toBe(true);
  });

  it("新增 transient 原因允许 cooldown 探测", () => {
    expect(shouldAllowCooldownProbeForReason("server_error")).toBe(true);
    expect(shouldAllowCooldownProbeForReason("payload_too_large")).toBe(true);
    expect(shouldAllowCooldownProbeForReason("thinking_signature")).toBe(true);
  });

  it("新增 non-transient 原因不允许 cooldown 探测", () => {
    expect(shouldAllowCooldownProbeForReason("provider_policy_blocked")).toBe(false);
    expect(shouldAllowCooldownProbeForReason("content_policy_blocked")).toBe(false);
  });

  it("新增 non-transient 原因保留 transient probe 预算", () => {
    expect(shouldPreserveTransientCooldownProbeSlot("provider_policy_blocked")).toBe(true);
    expect(shouldPreserveTransientCooldownProbeSlot("content_policy_blocked")).toBe(true);
  });

  it("新增 transient 原因消耗 probe 预算", () => {
    expect(shouldUseTransientCooldownProbeSlot("server_error")).toBe(true);
    expect(shouldUseTransientCooldownProbeSlot("thinking_signature")).toBe(true);
  });
});

describe("failover-policy > shouldProbeCooldown", () => {
  // TC-036: 冷却期过半且 transient 允许探测
  it("TC-036: 冷却期过半 + transient + 有预算 → 允许探测", () => {
    const state: CooldownProbeState = {
      providerId: "test",
      transientProbeBudget: 3,
      cooldownStartedAt: Date.now() - 6000,
      cooldownDurationMs: 10000,
      reason: "rate_limit",
    };
    expect(shouldProbeCooldown(state)).toBe(true);
  });

  // TC-037: 冷却期未过半不探测
  it("TC-037: 冷却期未过半 → 不允许探测", () => {
    const state: CooldownProbeState = {
      providerId: "test",
      transientProbeBudget: 3,
      cooldownStartedAt: Date.now() - 1000,
      cooldownDurationMs: 10000,
      reason: "rate_limit",
    };
    expect(shouldProbeCooldown(state)).toBe(false);
  });

  // TC-038: non-transient 不探测
  it("TC-038: non-transient reason → 不允许探测", () => {
    const state: CooldownProbeState = {
      providerId: "test",
      transientProbeBudget: 3,
      cooldownStartedAt: Date.now() - 6000,
      cooldownDurationMs: 10000,
      reason: "auth",
    };
    expect(shouldProbeCooldown(state)).toBe(false);
  });

  // TC-039: 预算耗尽不探测
  it("TC-039: probe 预算为 0 → 不允许探测", () => {
    const state: CooldownProbeState = {
      providerId: "test",
      transientProbeBudget: 0,
      cooldownStartedAt: Date.now() - 6000,
      cooldownDurationMs: 10000,
      reason: "rate_limit",
    };
    expect(shouldProbeCooldown(state)).toBe(false);
  });
});

describe("failover-policy > consumeProbeBudget", () => {
  // TC-040: transient 消耗预算
  it("TC-040: transient reason 消耗 probe 预算", () => {
    const state: CooldownProbeState = {
      providerId: "test",
      transientProbeBudget: 3,
      cooldownStartedAt: Date.now(),
      cooldownDurationMs: 10000,
      reason: "rate_limit",
    };
    const newState = consumeProbeBudget(state, "rate_limit");
    expect(newState.transientProbeBudget).toBe(2);
  });

  // TC-041: non-transient 保留预算
  it("TC-041: non-transient reason 保留 probe 预算", () => {
    const state: CooldownProbeState = {
      providerId: "test",
      transientProbeBudget: 3,
      cooldownStartedAt: Date.now(),
      cooldownDurationMs: 10000,
      reason: "auth",
    };
    const newState = consumeProbeBudget(state, "auth");
    expect(newState.transientProbeBudget).toBe(3);
  });

  // TC-042: 预算不为负
  it("TC-042: 预算不会降到负数", () => {
    const state: CooldownProbeState = {
      providerId: "test",
      transientProbeBudget: 0,
      cooldownStartedAt: Date.now(),
      cooldownDurationMs: 10000,
      reason: "rate_limit",
    };
    const newState = consumeProbeBudget(state, "rate_limit");
    expect(newState.transientProbeBudget).toBe(0);
  });
});
