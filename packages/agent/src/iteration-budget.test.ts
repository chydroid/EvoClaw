import { describe, it, expect, beforeEach } from "vitest";
import { IterationBudget, DEFAULT_PARENT_BUDGET, DEFAULT_CHILD_BUDGET } from "./iteration-budget";

describe("IterationBudget", () => {
  let budget: IterationBudget;

  beforeEach(() => {
    budget = new IterationBudget(10);
  });

  it("应使用默认父 agent 预算 90", () => {
    expect(DEFAULT_PARENT_BUDGET).toBe(90);
  });

  it("应使用默认子 agent 预算 50", () => {
    expect(DEFAULT_CHILD_BUDGET).toBe(50);
  });

  it("consume 应返回 true 直到预算耗尽", async () => {
    for (let i = 0; i < 10; i++) {
      expect(await budget.consume()).toBe(true);
    }
    expect(await budget.consume()).toBe(false);
  });

  it("getUsed 应返回已消耗次数", async () => {
    await budget.consume();
    await budget.consume();
    await budget.consume();
    expect(budget.getUsed()).toBe(3);
  });

  it("getRemaining 应返回剩余次数", async () => {
    await budget.consume();
    await budget.consume();
    expect(budget.getRemaining()).toBe(8);
  });

  it("getMax 应返回最大预算", () => {
    expect(budget.getMax()).toBe(10);
  });

  it("isExhausted 在预算耗尽时返回 true", async () => {
    expect(budget.isExhausted).toBe(false);
    for (let i = 0; i < 10; i++) await budget.consume();
    expect(budget.isExhausted).toBe(true);
  });

  it("refund 应归还一次迭代", async () => {
    await budget.consume();
    await budget.consume();
    expect(budget.getUsed()).toBe(2);
    await budget.refund();
    expect(budget.getUsed()).toBe(1);
  });

  it("refund 不会使 consumed 变为负数", async () => {
    await budget.refund();
    expect(budget.getUsed()).toBe(0);
  });

  it("reset 应重置计数器", async () => {
    await budget.consume();
    await budget.consume();
    budget.reset();
    expect(budget.getUsed()).toBe(0);
    expect(budget.getRemaining()).toBe(10);
  });

  it("并发 consume 应保持原子性", async () => {
    const budget = new IterationBudget(100);
    const promises: Promise<boolean>[] = [];
    for (let i = 0; i < 200; i++) {
      promises.push(budget.consume());
    }
    const results = await Promise.all(promises);
    const successCount = results.filter((r) => r).length;
    expect(successCount).toBe(100);
    expect(budget.getUsed()).toBe(100);
  });

  it("使用默认预算创建", () => {
    const b = new IterationBudget();
    expect(b.getMax()).toBe(DEFAULT_PARENT_BUDGET);
  });
});
