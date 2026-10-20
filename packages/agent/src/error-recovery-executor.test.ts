import { describe, it, expect } from "vitest";
import { ErrorRecoveryExecutor, type RecoveryContext } from "./error-recovery-executor";

function ctx(reason: RecoveryContext["reason"], extra: Partial<RecoveryContext> = {}): RecoveryContext {
  return {
    messages: [],
    reason,
    allowFailover: true,
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════
// 终态文案收口（hermes turn_failure_copy 语义）：
// 其余 reason 的终态 notice 与 compression_exhausted 收口到同一张表
// ═══════════════════════════════════════════════════════════
describe("ErrorRecoveryExecutor 终态 notice（turn_failure_copy 收口）", () => {
  it("transient reason 重试耗尽 → notice 是重试耗尽文案（按 reason 分句）", () => {
    const ex = new ErrorRecoveryExecutor(1); // 只有 1 次重试预算
    const first = ex.executeRecovery(ctx("rate_limit")); // 第 1 次：消耗掉预算
    expect(first.recovered).toBe(true);
    const terminal = ex.executeRecovery(ctx("rate_limit")); // 第 2 次：预算耗尽（通用分支）
    expect(terminal.recovered).toBe(false);
    expect(terminal.action).toBe("retry_budget_exhausted");
    expect(terminal.notice).toContain("被限流");
  });

  it("budget_exhausted 通用分支 → notice 带 reason 分句", () => {
    const ex = new ErrorRecoveryExecutor(0); // 零预算：直接走 retry_budget_exhausted
    const terminal = ex.executeRecovery(ctx("timeout"));
    expect(terminal.action).toBe("retry_budget_exhausted");
    expect(terminal.notice).toContain("未及时响应");
  });

  it("non-transient reason → notice 是不可重试文案（auth 提 API Key）", () => {
    const ex = new ErrorRecoveryExecutor(3);
    const terminal = ex.executeRecovery(ctx("auth", { errorText: "401 Unauthorized" }));
    expect(terminal.shouldFailover).toBe(true);
    expect(terminal.action).toBe("failover_auth");
    expect(terminal.notice).toContain("API Key");
    expect(terminal.notice).toContain("401 Unauthorized");
  });

  it("model_not_found → 换模型指引", () => {
    const ex = new ErrorRecoveryExecutor(3);
    const terminal = ex.executeRecovery(ctx("model_not_found"));
    expect(terminal.notice).toContain("换一个模型");
  });
});
