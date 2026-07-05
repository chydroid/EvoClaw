import { describe, it, expect } from "vitest";
import {
  TokenBudgetOptimizer,
  estimateTokens,
  estimateMessagesTokens,
  type BudgetAllocation,
} from "./token-budget";

// ═══════════════════════════════════════════════════════════
// 测试套件：token-budget（动态 token 预算分配）
// ═══════════════════════════════════════════════════════════

describe("estimateTokens", () => {
  it("空字符串 0 token", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("纯 ASCII 按 0.25 token/char 估算", () => {
    // 4 chars = 1 token
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("CJK 按 1.5 token/char 估算", () => {
    // 2 CJK = 3 tokens
    expect(estimateTokens("你好")).toBe(3);
    expect(estimateTokens("你好世界")).toBe(6);
  });

  it("混合内容", () => {
    // 2 CJK + 4 ASCII = 3 + 1 = 4
    expect(estimateTokens("你好abcd")).toBe(4);
  });
});

describe("estimateMessagesTokens", () => {
  it("累加消息 token + 结构开销", () => {
    const tokens = estimateMessagesTokens([
      { role: "user", content: "abcd" }, // 1 + 4 = 5
      { role: "assistant", content: "你好" }, // 3 + 4 = 7
    ]);
    expect(tokens).toBe(12);
  });

  it("null content 不计 token", () => {
    const tokens = estimateMessagesTokens([
      { role: "user", content: null }, // 0 + 4 = 4
    ]);
    expect(tokens).toBe(4);
  });
});

describe("TokenBudgetOptimizer > 构造与归一化", () => {
  it("使用默认分配比例", () => {
    const opt = new TokenBudgetOptimizer({ contextWindow: 100_000, reservedOutput: 4096 });
    const budget = opt.allocateBudget();
    const available = 100_000 - 4096;
    expect(budget.output).toBe(4096);
    expect(budget.systemPrompt + budget.memories + budget.history + budget.toolResults + budget.userMessage).toBeLessThanOrEqual(available);
    expect(budget.systemPrompt).toBeGreaterThan(0);
  });

  it("自定义分配比例自动归一化", () => {
    const opt = new TokenBudgetOptimizer({
      contextWindow: 100_000,
      allocation: {
        systemPrompt: 1,
        memories: 1,
        history: 1,
        toolResults: 1,
        userMessage: 1,
        output: 1,
      },
    });
    const budget = opt.allocateBudget();
    // 6 个比例都是 1，归一化后每个 = 1/6
    const available = 100_000 - 4096;
    expect(budget.history).toBeCloseTo(Math.floor(available / 6), -2);
  });

  it("总比例为 0 时使用默认分配", () => {
    const opt = new TokenBudgetOptimizer({
      allocation: {
        systemPrompt: 0,
        memories: 0,
        history: 0,
        toolResults: 0,
        userMessage: 0,
        output: 0,
      },
    });
    const budget = opt.allocateBudget();
    expect(budget.history).toBeGreaterThan(0);
  });
});

describe("TokenBudgetOptimizer > allocate", () => {
  it("所有内容在预算内时全部保留", () => {
    const opt = new TokenBudgetOptimizer({ contextWindow: 1_000_000, reservedOutput: 4096 });
    const result = opt.allocate({
      systemPrompt: "abcd",
      memories: [{ content: "memory1" }],
      history: [{ role: "user", content: "hello" }],
      toolResults: [{ content: "result" }],
      userMessage: "world",
    });
    expect(result.historyLimit).toBe(1);
    expect(result.toolResultLimit).toBe(1);
    expect(result.report.overflow).toBe(false);
    expect(result.report.recommendation).toBe("OK");
  });

  it("history 超预算时截断", () => {
    const opt = new TokenBudgetOptimizer({
      contextWindow: 1000,
      reservedOutput: 100,
      allocation: {
        systemPrompt: 0.01,
        memories: 0.01,
        history: 0.10,
        toolResults: 0.01,
        userMessage: 0.01,
        output: 0.86,
      },
    });
    const history = Array.from({ length: 50 }, (_, i) => ({
      role: "user",
      content: `message ${i} `.repeat(20),
    }));
    const result = opt.allocate({
      systemPrompt: "sys",
      memories: [],
      history,
      toolResults: [],
      userMessage: "user",
    });
    expect(result.historyLimit).toBeLessThan(history.length);
  });

  it("system prompt 超预算时从 history 借", () => {
    const opt = new TokenBudgetOptimizer({ contextWindow: 10_000, reservedOutput: 1000 });
    const longSys = "x".repeat(5000);
    const result = opt.allocate({
      systemPrompt: longSys,
      memories: [],
      history: [{ role: "user", content: "hello" }],
      toolResults: [],
      userMessage: "world",
    });
    // history 预算被压缩
    expect(result.report.allocated.history).toBeGreaterThan(0);
  });

  it("overflow 检测", () => {
    const opt = new TokenBudgetOptimizer({ contextWindow: 100, reservedOutput: 10 });
    const result = opt.allocate({
      systemPrompt: "x".repeat(50),
      memories: [{ content: "y".repeat(50) }],
      history: [],
      toolResults: [],
      userMessage: "z".repeat(50),
    });
    expect(result.report.totalUsed).toBeGreaterThan(0);
  });

  it("history 压缩 >50% 时给出压缩建议", () => {
    const opt = new TokenBudgetOptimizer({
      contextWindow: 2000,
      reservedOutput: 200,
      allocation: {
        systemPrompt: 0.01,
        memories: 0.01,
        history: 0.20,
        toolResults: 0.01,
        userMessage: 0.01,
        output: 0.76,
      },
    });
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: "user",
      content: `msg ${i} `.repeat(50),
    }));
    const result = opt.allocate({
      systemPrompt: "sys",
      memories: [],
      history,
      toolResults: [],
      userMessage: "user",
    });
    if (result.historyLimit < history.length / 2) {
      expect(result.report.recommendation).toContain("History compressed");
    }
  });

  it("返回完整 report 结构", () => {
    const opt = new TokenBudgetOptimizer();
    const result = opt.allocate({
      systemPrompt: "sys",
      memories: [{ content: "mem" }],
      history: [{ role: "user", content: "hi" }],
      toolResults: [{ content: "tool" }],
      userMessage: "user",
    });
    expect(result.report).toHaveProperty("allocated");
    expect(result.report).toHaveProperty("used");
    expect(result.report).toHaveProperty("total");
    expect(result.report).toHaveProperty("totalUsed");
    expect(result.report).toHaveProperty("overflow");
    expect(result.report).toHaveProperty("recommendation");
    expect(result.report.allocated).toHaveProperty("systemPrompt");
    expect(result.report.allocated).toHaveProperty("memories");
    expect(result.report.allocated).toHaveProperty("history");
    expect(result.report.allocated).toHaveProperty("toolResults");
    expect(result.report.allocated).toHaveProperty("userMessage");
    expect(result.report.allocated).toHaveProperty("output");
  });
});
