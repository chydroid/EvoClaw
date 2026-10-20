import { describe, it, expect } from "vitest";
import {
  SITE_FAILURE_CODES,
  isSiteFailureCode,
  stampFailure,
  failedTurnNotice,
  FAILED_TURN_NOTICE,
  PARTIAL_FAILED_TURN_NOTICE,
  FAILURE_CAUSE_GLOSS,
  failureCauseGloss,
  exhaustedCopy,
  nonretryableCopy,
  siteCopy,
  terminalFailureCopy,
  shortDetail,
  formatResetWindow,
} from "./turn-failure-copy";

// 所有合法 failure_reason 取值域 = FailoverReason（25）+ SITE_FAILURE_CODES。
const FAILOVER_REASONS = [
  "rate_limit", "overloaded", "billing", "unknown", "empty_response",
  "no_error_details", "unclassified", "timeout", "model_not_found", "format",
  "format_error", "auth", "auth_permanent", "session_expired", "context_overflow",
  "network", "server_error", "payload_too_large", "image_too_large",
  "provider_policy_blocked", "content_policy_blocked", "invalid_encrypted_content",
  "multimodal_tool_content_unsupported", "thinking_signature", "long_context_tier",
];

// ═══════════════════════════════════════════════════════════
// ① 盖码不变式（stampFailure）
// ═══════════════════════════════════════════════════════════
describe("stampFailure（盖码不变式）", () => {
  it("终态结果必带 failure_reason + failure_retryable", () => {
    const r = {} as { failureReason?: string; failureRetryable?: boolean };
    stampFailure(r, "rate_limit", true);
    expect(r.failureReason).toBe("rate_limit");
    expect(r.failureRetryable).toBe(true);
  });

  it("非可重试 reason 盖 retryable=false", () => {
    const r: { failureReason?: string; failureRetryable?: boolean } = {};
    stampFailure(r, "auth", false);
    expect(r.failureReason).toBe("auth");
    expect(r.failureRetryable).toBe(false);
  });

  it("advisory：只改判定字段，不动其它终态字段（真失败/completed 不被混淆）", () => {
    const r = { reply: "x", completed: false, failed: true, failureReason: undefined as string | undefined, failureRetryable: undefined as boolean | undefined };
    stampFailure(r, "loop_error", true);
    expect(r.failed).toBe(true); // advisory 不改 failed
    expect(r.completed).toBe(false); // advisory 不改 completed
    expect(r.reply).toBe("x"); // 正文不动
    expect(r.failureReason).toBe("loop_error");
    expect(r.failureRetryable).toBe(true);
  });

  it("返回值即传入对象（原地盖码）", () => {
    const r = {} as { failureReason?: string; failureRetryable?: boolean };
    expect(stampFailure(r, "timeout", true)).toBe(r);
  });
});

// ═══════════════════════════════════════════════════════════
// ② 边界文案二分（failedTurnNotice）
// ═══════════════════════════════════════════════════════════
describe("failedTurnNotice（二分文案）", () => {
  it("纯空 turn（无 tool 行、无 tool_calls）→ 完全失败文案", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "thinking..." },
    ];
    expect(failedTurnNotice(msgs)).toBe(FAILED_TURN_NOTICE);
  });

  it("空 / null → 完全失败文案", () => {
    expect(failedTurnNotice([])).toBe(FAILED_TURN_NOTICE);
    expect(failedTurnNotice(null)).toBe(FAILED_TURN_NOTICE);
    expect(failedTurnNotice(undefined)).toBe(FAILED_TURN_NOTICE);
  });

  it("出现过 role=tool → 部分执行失败文案", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "1", content: "ok" },
    ];
    expect(failedTurnNotice(msgs)).toBe(PARTIAL_FAILED_TURN_NOTICE);
  });

  it("assistant 带非空 tool_calls → 部分执行失败文案", () => {
    const msgs = [
      { role: "assistant", content: "", tool_calls: [{ id: "a", function: { name: "f" } }] },
    ];
    expect(failedTurnNotice(msgs)).toBe(PARTIAL_FAILED_TURN_NOTICE);
  });

  it("assistant 带空 tool_calls 数组 → 不算动作，仍完全失败", () => {
    const msgs = [{ role: "assistant", content: "", tool_calls: [] }];
    expect(failedTurnNotice(msgs)).toBe(FAILED_TURN_NOTICE);
  });

  it("两文案互不相同（防回归）", () => {
    expect(PARTIAL_FAILED_TURN_NOTICE).not.toBe(FAILED_TURN_NOTICE);
    expect(PARTIAL_FAILED_TURN_NOTICE).toContain("核实");
    expect(FAILED_TURN_NOTICE).toContain("重新发送");
  });
});

// ═══════════════════════════════════════════════════════════
// ③ gloss 表全覆盖（25 reason + 站内码 无 undefined）
// ═══════════════════════════════════════════════════════════
describe("FAILURE_CAUSE_GLOSS（全覆盖）", () => {
  it("25 个 FailoverReason 全部有 gloss", () => {
    for (const r of FAILOVER_REASONS) {
      expect(FAILURE_CAUSE_GLOSS[r], `missing gloss for ${r}`).toBeTruthy();
      expect(failureCauseGloss(r)).toBeTruthy();
    }
  });

  it("SITE_FAILURE_CODES 全部有 gloss", () => {
    for (const c of Array.from(SITE_FAILURE_CODES)) {
      expect(FAILURE_CAUSE_GLOSS[c], `missing gloss for site code ${c}`).toBeTruthy();
    }
  });

  it("合法取值域内没有任何 undefined", () => {
    const domain = [...FAILOVER_REASONS, ...Array.from(SITE_FAILURE_CODES)];
    for (const r of domain) {
      expect(FAILURE_CAUSE_GLOSS[r]).toBeDefined();
    }
  });

  it("表外 reason / 空值 → null（退回原始错误文本口径）", () => {
    expect(failureCauseGloss("nonexistent_reason")).toBeNull();
    expect(failureCauseGloss("")).toBeNull();
    expect(failureCauseGloss(null)).toBeNull();
    expect(failureCauseGloss(undefined)).toBeNull();
    expect(failureCauseGloss(42)).toBeNull();
  });
});

describe("SITE_FAILURE_CODES（站内码集合）", () => {
  it("包含 hermes 对齐的 9 个站内码", () => {
    for (const c of [
      "context_overflow", "truncated", "invalid_response", "empty_response",
      "loop_error", "interpreter_shutdown", "session_busy", "gateway_connection",
      "host_error",
    ]) {
      expect(isSiteFailureCode(c)).toBe(true);
    }
  });

  it("provider 裁定 reason 不算站内码", () => {
    expect(isSiteFailureCode("rate_limit")).toBe(false);
    expect(isSiteFailureCode("auth")).toBe(false);
    expect(isSiteFailureCode(99)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// ⑤ 耗尽文案带 reset 时间分支
// ═══════════════════════════════════════════════════════════
describe("exhaustedCopy（耗尽文案 + reset 时间分支）", () => {
  it("已知 reset ≥2min → 点名具体重置时间", () => {
    const copy = exhaustedCopy("rate_limit", "DeepSeek", 3, { resetSeconds: 3600 });
    expect(copy).toContain("1 小时"); // formatResetWindow(3600)
    expect(copy).toContain("重置");
  });

  it("未提供 reset → 通用「稍后重试」", () => {
    const copy = exhaustedCopy("rate_limit", "DeepSeek", 3);
    expect(copy).toContain("稍后重试");
    expect(copy).not.toContain("重置");
  });

  it("reset < 2min 阈值 → 仍走通用文案（不点名过短的窗口）", () => {
    const copy = exhaustedCopy("rate_limit", "DeepSeek", 3, { resetSeconds: 60 });
    expect(copy).not.toContain("重置");
  });

  it("按 reason 分句（rate_limit / timeout 主句不同）", () => {
    expect(exhaustedCopy("rate_limit", "P", 5)).toContain("被限流");
    expect(exhaustedCopy("timeout", "P", 5)).toContain("未及时响应");
  });

  it("detail 进尾部「服务方描述」行", () => {
    const copy = exhaustedCopy("overloaded", "P", 2, { detail: "line1\nline2" });
    expect(copy).toContain("服务方描述：line1");
  });
});

describe("formatResetWindow（重置窗口格式化）", () => {
  it("秒 / 分钟 / 小时分段", () => {
    expect(formatResetWindow(30)).toContain("秒");
    expect(formatResetWindow(1800)).toBe("约 30 分钟");
    expect(formatResetWindow(3600)).toBe("约 1 小时");
    expect(formatResetWindow(5400)).toBe("约 1 小时 30 分钟");
  });
});

// ═══════════════════════════════════════════════════════════
// ⑥ 非可重试 reason 终态文案
// ═══════════════════════════════════════════════════════════
describe("nonretryableCopy（非可重试终态文案）", () => {
  it("model_not_found → 换模型指引", () => {
    const c = nonretryableCopy("model_not_found", "P", { model: "gpt-9" });
    expect(c).toContain("gpt-9");
    expect(c).toContain("换一个模型");
  });

  it("auth → 检查 API Key 指引", () => {
    expect(nonretryableCopy("auth", "P")).toContain("API Key");
  });

  it("billing → 额度/充值指引", () => {
    expect(nonretryableCopy("billing", "P")).toContain("额度");
  });

  it("未知 reason → 通用默认文案（不 undefined 崩）", () => {
    expect(nonretryableCopy("some_unknown", "P")).toContain("切换到其他模型");
  });

  it("detail 进尾部「服务方描述」行", () => {
    expect(nonretryableCopy("auth", "P", { detail: "401 Unauthorized" })).toContain("401 Unauthorized");
  });
});

// ═══════════════════════════════════════════════════════════
// 站内码文案
// ═══════════════════════════════════════════════════════════
describe("siteCopy（站内码文案）", () => {
  it("truncated → 拆小步 / raise max_tokens 指引", () => {
    expect(siteCopy("truncated")).toContain("max_tokens");
  });

  it("context_overflow → 开新会话指引", () => {
    expect(siteCopy("context_overflow")).toContain("新会话");
  });

  it("payload_too_large 复用 COMPRESSION_EXHAUSTED 语义", () => {
    expect(siteCopy("payload_too_large")).toContain("payload too large, compression exhausted");
  });

  it("未知码 → 空串（调用方兜底）", () => {
    expect(siteCopy("does_not_exist")).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════
// 组合：终态兜底回复
// ═══════════════════════════════════════════════════════════
describe("terminalFailureCopy（组合兜底文案）", () => {
  it("partial=true → PARTIAL 开头 + 工具统计", () => {
    const c = terminalFailureCopy(
      { reason: "timeout", label: "P", attempts: 2, retryable: true },
      { partial: true, toolStats: { executed: 3, failed: [{ name: "shell_exec", error: "boom" }] } },
    );
    expect(c).toContain(PARTIAL_FAILED_TURN_NOTICE);
    expect(c).toContain("本轮已执行 3 次工具");
    expect(c).toContain("shell_exec");
  });

  it("partial=false → FULL 开头", () => {
    const c = terminalFailureCopy(
      { reason: "auth", label: "P", attempts: 1, retryable: false, detail: "401" },
      { partial: false },
    );
    expect(c).toContain(FAILED_TURN_NOTICE);
    expect(c).toContain("API Key");
    expect(c).toContain("401");
  });

  it("reason=null → 通用「检查 API Key/在线/网络」文案", () => {
    const c = terminalFailureCopy(
      { reason: null, label: "P", attempts: 3, retryable: true },
      { partial: false },
    );
    expect(c).toContain("均未能响应");
  });
});

describe("shortDetail（尾部详情行）", () => {
  it("取第一行并按 limit 截断", () => {
    expect(shortDetail("first\nsecond", 5)).toBe("first"); // 恰好 5 字符不截断
    expect(shortDetail("first\nsecond", 4)).toBe("fir…");
    expect(shortDetail("short", 200)).toBe("short");
    expect(shortDetail(null)).toBe("（无详情）");
  });
});
