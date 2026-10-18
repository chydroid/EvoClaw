import { describe, it, expect, beforeEach } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { AgentModelExecutor } from "./agent-model-executor";
import { DEFAULT_CHILD_BUDGET } from "./iteration-budget";

/**
 * 子会话（subagent）迭代预算隔离回归测试。
 *
 * 背景（hermes 对标缺口①）：DEFAULT_CHILD_BUDGET 曾导出但从未使用——
 * 子代理会话与父会话共享同一份迭代预算配置，子代理的迭代配额
 * 会随父配置浮动（或耗尽「0 轮」兜底文案）。修复：agent-model-executor
 * 按 sessionId 前缀（subsession_）创建 DEFAULT_CHILD_BUDGET 的独立预算。
 */
describe("AgentModelExecutor > 子会话预算隔离", () => {
  let executor: AgentModelExecutor;

  beforeEach(() => {
    const registry = new ServiceRegistry();
    const eventBus = new EventBus();
    executor = new AgentModelExecutor(registry, eventBus);
  });

  it("isSubagentSessionId 识别 subsession_ 前缀", () => {
    expect(executor.isSubagentSessionId("subsession_moa-1-1")).toBe(true);
    expect(executor.isSubagentSessionId("subsession_abc-def")).toBe(true);
    expect(executor.isSubagentSessionId("main")).toBe(false);
    expect(executor.isSubagentSessionId("eval23-o01")).toBe(false);
  });

  it("子会话预算使用 DEFAULT_CHILD_BUDGET（50）而非父配置值", () => {
    const sub = executor.getIterationBudget("subsession_test", executor.isSubagentSessionId("subsession_test"));
    expect(sub.getMax()).toBe(DEFAULT_CHILD_BUDGET);
    expect(sub.getMax()).toBe(50);
  });

  it("父会话预算使用配置值（未配置时默认 20）", () => {
    const parent = executor.getIterationBudget("main", executor.isSubagentSessionId("main"));
    expect(parent.getMax()).toBe(20);
  });

  it("显式配置 maxIterations 时父会话跟随配置、子会话仍固定 50", () => {
    const registry = new ServiceRegistry();
    const eventBus = new EventBus();
    const configured = new AgentModelExecutor(registry, eventBus, { maxIterations: 90 });
    expect(configured.getIterationBudget("main", false).getMax()).toBe(90);
    expect(configured.getIterationBudget("subsession_x", true).getMax()).toBe(DEFAULT_CHILD_BUDGET);
  });

  it("子会话预算实例按 sessionId 隔离（两个子会话互不影响）", async () => {
    const a = executor.getIterationBudget("subsession_a", true);
    const b = executor.getIterationBudget("subsession_b", true);
    await a.consume(50);
    expect(a.isExhausted).toBe(true);
    expect(b.isExhausted).toBe(false);
  });
});
