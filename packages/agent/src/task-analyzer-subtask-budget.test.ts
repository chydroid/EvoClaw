import { describe, it, expect, vi } from "vitest";
import {
  handleMultipleTasks,
  executeSubtasksFromCheckpoint,
  isSubtaskHardFailure,
  type TaskAnalyzerDeps,
} from "./task-analyzer";
import { taskCheckpointManager, type TaskCheckpoint } from "./task-checkpoint-manager";

/**
 * 子任务预算隔离 + 硬失败计数回归测试（2026-10-18 eval23 o09 事故）。
 *
 * 背景：多任务/子任务路径与父 turn 共享同一个 IterationBudget 对象。
 * 父 turn 循环耗尽预算后，每个子任务第一轮即撞 budget.isExhausted
 * （「迭代预算已耗尽（0 轮）」），0 次工具调用就中断，且汇总头
 * 仍显示「🎉 所有 N 个子任务已成功完成」（成功/失败计数虚高）。
 *
 * 修复两条不变量：
 * 1. 每个子任务（含重试）执行前调 deps.resetIterationBudget —— 子任务领新预算；
 * 2. 硬失败占位文案（含「迭代预算已耗尽」）不得记 completed，
 *    必须走 failed 分支（单一事实源）。
 */

function makeDeps(overrides: Partial<TaskAnalyzerDeps> = {}): TaskAnalyzerDeps {
  return {
    providers: [],
    config: { maxTokens: 4096 } as TaskAnalyzerDeps["config"],
    persona: {} as TaskAnalyzerDeps["persona"],
    conversationHistory: new Map(),
    callLLMOnce: vi.fn(async () => null),
    tryCallLLM: vi.fn(async () => null),
    buildSystemPrompt: vi.fn(() => "sys"),
    generateChatResponse: vi.fn(async () => "fallback"),
    estimateTokenCount: (t: string) => t.length,
    resolveService: vi.fn(() => undefined),
    ...overrides,
  };
}

describe("task-analyzer 子任务预算隔离", () => {
  it("handleMultipleTasks：每个子任务执行前重置迭代预算", async () => {
    const reset = vi.fn();
    const deps = makeDeps({
      providers: [{ enabled: true, order: 0, model: "m", provider: "p", name: "p" } as never],
      tryCallLLM: vi.fn(async () => ({
        reply: "ok",
        tokensUsed: 1,
        duration: 1,
        permissionRequests: [],
        toolsExecuted: true,
      })),
      resetIterationBudget: reset,
    });

    const result = await handleMultipleTasks(
      deps,
      ["任务 A 做点什么", "任务 B 做点别的"],
      "sess-budget",
      [],
      Date.now(),
    );
    expect(result.reply).toContain("共处理 2 个任务");
    // 每个子任务前各重置一次（2 个子任务 = 2 次）
    expect(reset).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenNthCalledWith(1, "sess-budget");
  });

  it("executeSubtasksFromCheckpoint：子任务执行前 + 每次重试前都重置预算", async () => {
    const reset = vi.fn();
    const deps = makeDeps({
      providers: [{ enabled: true, order: 0, model: "m", provider: "p", name: "p" } as never],
      // 首跑与重试都返回 null（模拟 5 分钟超时）→ 进完整重试路径
      tryCallLLM: vi.fn(async () => null),
      generateChatResponse: vi.fn(async () => "fallback"),
      resetIterationBudget: reset,
    });

    const sessionId = "sess-cp-reset";
    const checkpoint: TaskCheckpoint = {
      sessionId,
      originalMessage: "主任务",
      subtasks: [{ id: "sub-1", description: "子任务 1", status: "pending" }],
      completedCount: 0,
      totalSubtasks: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    taskCheckpointManager.save(sessionId, checkpoint);

    await executeSubtasksFromCheckpoint(deps, checkpoint, sessionId, [], Date.now());

    // 首跑 1 次 + 重试 2 次（retryCount 1、2）= 3 次重置
    expect(reset).toHaveBeenCalledTimes(3);
    taskCheckpointManager.delete(sessionId);
  });

  it("executeSubtasksFromCheckpoint：预算耗尽占位文案不得记 completed（单一事实源）", async () => {
    const deps = makeDeps({
      providers: [{ enabled: true, order: 0, model: "m", provider: "p", name: "p" } as never],
      // 首跑与两次重试全部返回预算耗尽占位 → 子任务必须记 failed
      tryCallLLM: vi.fn(async () => ({
        reply: "⏰ 迭代预算已耗尽（0 轮），任务在此中断。",
        tokensUsed: 0,
        duration: 1,
        permissionRequests: [],
        toolsExecuted: false,
      })),
      generateChatResponse: vi.fn(async () => "fallback"),
      resetIterationBudget: vi.fn(),
    });

    const sessionId = "sess-cp-hardfail";
    const checkpoint: TaskCheckpoint = {
      sessionId,
      originalMessage: "主任务",
      subtasks: [{ id: "sub-1", description: "子任务 1", status: "pending" }],
      completedCount: 0,
      totalSubtasks: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    taskCheckpointManager.save(sessionId, checkpoint);

    const result = await executeSubtasksFromCheckpoint(deps, checkpoint, sessionId, [], Date.now());

    const cp = taskCheckpointManager.get(sessionId);
    expect(cp?.subtasks[0].status).toBe("failed");
    expect(result.reply).toContain("0/1");
    expect(result.reply).not.toContain("🎉 所有 1 个子任务已成功完成");
    expect(result.reply).toContain("❌");
    taskCheckpointManager.delete(sessionId);
  });

  it("isSubtaskHardFailure：仅识别预算耗尽占位文案，正常回复不误判", () => {
    expect(isSubtaskHardFailure("⏰ 迭代预算已耗尽（0 轮），任务在此中断。")).toBe(true);
    expect(isSubtaskHardFailure("迭代预算已耗尽，最终总结请求也未能完成。")).toBe(true);
    expect(isSubtaskHardFailure("✅ 合同已创建并验证通过")).toBe(false);
    expect(isSubtaskHardFailure("")).toBe(false);
  });
});
