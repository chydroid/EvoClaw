import { describe, it, expect } from "vitest";
import { extendRoundLimitForRefund, MAX_REFUND_ROUND_EXTENSION } from "./llm-caller";

/**
 * execute_code 退款延长工具循环上限的回归测试。
 *
 * 背景（v26 压测 T9 实证）：IterationBudget 的 execute_code 退款只递减
 * budget 计数器，而循环边界是 maxToolRounds（budget max=300 远大于它），
 * 退款实际空转——25 轮里打出 11 次 "Execute-code refund" 日志，仍在第
 * 25 轮截断，token 预算还剩近一半。修复：退款按轮延长循环上限，
 * 上限封顶 baseLimit + MAX_REFUND_ROUND_EXTENSION，token 预算仍兜底。
 */
describe("extendRoundLimitForRefund — execute_code 退款延长循环上限", () => {
  it("无退款时上限不变", () => {
    expect(extendRoundLimitForRefund(25, 25, 0)).toBe(25);
    expect(extendRoundLimitForRefund(25, 25, -1)).toBe(25);
  });

  it("每次退款延长一轮", () => {
    expect(extendRoundLimitForRefund(25, 25, 1)).toBe(26);
    expect(extendRoundLimitForRefund(30, 25, 5)).toBe(35);
  });

  it("累计延长封顶 baseLimit + MAX_REFUND_ROUND_EXTENSION", () => {
    const cap = 25 + MAX_REFUND_ROUND_EXTENSION;
    expect(extendRoundLimitForRefund(cap, 25, 1)).toBe(cap);
    // 一次传入超过剩余额度的退款也只到封顶
    expect(extendRoundLimitForRefund(44, 25, 20)).toBe(cap);
  });

  it("MAX_REFUND_ROUND_EXTENSION 与 IterationBudget 单类退款上限一致（20）", () => {
    expect(MAX_REFUND_ROUND_EXTENSION).toBe(20);
  });
});
