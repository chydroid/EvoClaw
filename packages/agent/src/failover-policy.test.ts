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
  FAILOVER_REASONS,
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
    expect(resolveFailoverReason(403, "rejected as a result of our safety system")).toBe("content_policy_blocked");
    // 反例：裸「our safety system」不得判为确定性拒绝——瞬时故障必须可重试，
    // 否则 provider 被 skip 300s，与 v34 的漂移缺陷同族。
    expect(resolveFailoverReason(503, "our safety system is temporarily unavailable, please retry")).toBe("overloaded");
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

  // ★ v35（对标 hermes `_classify_400`）：具体措辞优先于通用 format_error，
  //   但只放行 `_400_TAIL_RULES` / `_IMAGE_TOOL_RULES` 那几种 reason。
  it("TC-035j: 未单列的 4xx 措辞 → format_error（不可重试）", () => {
    expect(resolveFailoverReason(400, "invalid request body")).toBe("format_error");
    expect(resolveFailoverReason(400, "malformed json")).toBe("format_error");
    expect(resolveFailoverReason(405, "method not allowed")).toBe("format_error");
    expect(resolveFailoverReason(415, "unsupported media type")).toBe("format_error");
    expect(resolveFailoverReason(431, "request header fields too large")).toBe("format_error");
  });

  it("TC-035k: 4xx 里出现的传输层措辞不精化（防熔断风暴）", () => {
    // "upstream timeout" 是网关复述的噪声：请求体必然再被拒，不能变成可重试
    expect(resolveFailoverReason(400, "upstream timeout, invalid request")).toBe("format_error");
    expect(resolveFailoverReason(400, "upstream connect error or disconnect/reset before headers")).toBe("format_error");
    expect(resolveFailoverReason(400, "service unavailable, bad request")).toBe("format_error");
    expect(resolveFailoverReason(400, "unauthorized field in request")).toBe("format_error");
  });

  it("TC-035l: 4xx 允许的精化 reason 生效", () => {
    expect(resolveFailoverReason(400, "context length exceeded")).toBe("context_overflow");
    expect(resolveFailoverReason(400, "image too large for this endpoint")).toBe("image_too_large");
    expect(resolveFailoverReason(400, "payload too large")).toBe("payload_too_large");
    expect(resolveFailoverReason(400, "rate limit exceeded")).toBe("rate_limit");
    expect(resolveFailoverReason(400, "insufficient_quota")).toBe("billing");
    expect(resolveFailoverReason(400, "model not found")).toBe("model_not_found");
  });

  // ★ v36（对标 hermes `_status_403`）：403 的三种语义必须分开——
  //   此前一律判 auth → skip provider 300s + 谎称「检查 API Key」，
  //   而实际可能是额度墙或 provider 前方的 WAF（凭证根本没送到）。
  it("TC-035m: 403 三分解——额度墙 / WAF 拦截 / 裸 403", () => {
    // ① 账户/额度墙 → billing（下一步是充值，不是换 key）
    expect(resolveFailoverReason(403, "Budget limit exceeded (monthly limit)")).toBe("billing");
    expect(resolveFailoverReason(403, "insufficient credits")).toBe("billing");
    // ② WAF/CDN 挑战页 → upstream_blocked（key 健康，换人但不熔断）
    expect(resolveFailoverReason(403, "Attention Required! | Cloudflare")).toBe("upstream_blocked");
    expect(resolveFailoverReason(403, "Sorry, you have been blocked")).toBe("upstream_blocked");
    expect(resolveFailoverReason(403, "Please enable JavaScript and cookies to continue")).toBe("upstream_blocked");
    // ③ 裸 403 / 无措辞 → 仍是 auth（保守；由 caller 决定不熔断）
    expect(resolveFailoverReason(403)).toBe("auth");
    expect(resolveFailoverReason(403, "Forbidden")).toBe("auth");
    // 反例纪律：泛化词不得被当成 WAF 证据（provider 描述真实权限错误时也用它们）
    expect(resolveFailoverReason(403, "access denied: this key lacks the model scope")).toBe("auth");
  });

  it("TC-035n: 403 判定的优先级——额度墙先于 WAF 措辞", () => {
    // 某些网关的 403 页同时含 Cloudflare 标记和额度措辞；hermes 顺序是
    // 先 billing 再 upstream_blocked（额度是可操作结论，WAF 只是表象）。
    expect(
      resolveFailoverReason(403, "insufficient credits — Cloudflare"),
    ).toBe("billing");
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

  // ★ v36：三个 probe 谓词现在由 transient/non-transient 判定派生，
  //   不再各自手抄 reason 清单（此前清单漏了 upstream_blocked）。
  it("upstream_blocked：non-transient / 不探测 / 保留预算", () => {
    expect(isNonTransientReason("upstream_blocked")).toBe(true);
    expect(isTransientReason("upstream_blocked")).toBe(false);
    expect(shouldAllowCooldownProbeForReason("upstream_blocked")).toBe(false);
    expect(shouldUseTransientCooldownProbeSlot("upstream_blocked")).toBe(false);
    expect(shouldPreserveTransientCooldownProbeSlot("upstream_blocked")).toBe(true);
  });

  it("★ 全取值域不变式：三个 probe 谓词与 transient 判定不得漂移", () => {
    // 明确列出「既非 transient 也非 non-transient」的 reason：
    //   - context_overflow：需压缩后重试，走独立的压缩路径
    //   - aborted：用户/系统主动取消，不是 provider 裁定（caller 直接返回）
    // 其余每个 reason 必须恰好属于一侧；新增 reason 若未归位，本测试失败。
    const NEITHER = new Set<string>(["context_overflow", "aborted"]);
    for (const r of FAILOVER_REASONS) {
      const transient = isTransientReason(r);
      const nonTransient = isNonTransientReason(r);
      if (NEITHER.has(r)) {
        expect(transient || nonTransient, `${r} 不应被归入 transient/non-transient`).toBe(false);
        continue;
      }
      expect(transient !== nonTransient, `${r} 必须且只能属于 transient 或 non-transient`).toBe(true);
      // 允许探测 ⇔ transient 或 billing（唯一例外）
      expect(shouldAllowCooldownProbeForReason(r), `probe-allow drift for ${r}`).toBe(transient || r === "billing");
      // 消耗预算 ⇔ transient
      expect(shouldUseTransientCooldownProbeSlot(r), `probe-slot drift for ${r}`).toBe(transient);
      // 保留预算 ⇔ non-transient 且非 billing
      expect(shouldPreserveTransientCooldownProbeSlot(r), `probe-preserve drift for ${r}`).toBe(
        nonTransient && r !== "billing",
      );
    }
  });

  it("aborted / output_cap 的归属（曾漏出三份清单）", () => {
    expect(isTransientReason("aborted")).toBe(false);
    expect(isNonTransientReason("aborted")).toBe(false); // 不是 provider 裁定
    expect(isTransientReason("output_cap")).toBe(true);
    expect(shouldAllowCooldownProbeForReason("output_cap")).toBe(true);
    expect(shouldUseTransientCooldownProbeSlot("output_cap")).toBe(true);
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
