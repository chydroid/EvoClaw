/**
 * Step 2 产品化命令接线（hermes-alignment-round2）：
 * executor 侧私密 handleSlashCommand 的 /btw（callAuxLLM 侧问通道）、
 * /review（runBackgroundReview fork）、/plan（injectedMessage 注入模板）接线。
 *
 * llm-caller 模块级 mock：side-task 单次调用走 callLLMOnce（回答固定 "SIDE"），
 * 主 turn 循环走 tryCallLLM（未接线即"不消耗主 turn"的证据——
 * /btw /plan 路径对 tryCallLLM 零调用）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockCallLLMOnce, mockTryCallLLM } = vi.hoisted(() => ({
  mockCallLLMOnce: vi.fn(async (
    _provider: unknown,
    _messages: unknown,
  ) => ({ message: { role: "assistant", content: "SIDE" }, tokensUsed: 25, promptTokens: 15 })),
  mockTryCallLLM: vi.fn(async () => ({ reply: "MAIN", tokensUsed: 0 })),
}));

vi.mock("./llm-caller", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./llm-caller")>();
  return { ...actual, callLLMOnce: mockCallLLMOnce, tryCallLLM: mockTryCallLLM };
});

// mock 初始化后再引入被测模块
import { AgentModelExecutor } from "./agent-model-executor";
import { ServiceRegistry, EventBus } from "@evoclaw/core";

describe("executor slash 命令产品化接线（/btw /plan /review）", () => {
  let executor: AgentModelExecutor;

  beforeEach(() => {
    mockCallLLMOnce.mockClear();
    mockTryCallLLM.mockClear();
    executor = new AgentModelExecutor(new ServiceRegistry(), new EventBus());
    executor.configureProviders([
      {
        id: "p1",
        name: "main",
        provider: "anthropic",
        model: "claude-opus-4",
        apiKey: "sk-test",
        maxTokens: 4096,
        temperature: 0,
        timeout: 30_000,
        enabled: true,
        order: 0,
      },
    ]);
    // 预置会话历史（/btw 转录快照、/review 评审快照的输入）
    (executor as any).conversationHistory.set("s1", [
      { role: "user", content: "先帮我验一下缓存" },
      { role: "assistant", content: "命中 92%" },
    ]);
  });

  it("/btw：走 callAuxLLM 侧问通道，回复含答案与消耗，tryCallLLM 零调用（主 turn 不被消耗）", async () => {
    const r = await (executor as any).handleSlashCommand("/btw 缓存上限改善了吗", "s1", Date.now());
    expect(r).not.toBeNull();
    expect(mockCallLLMOnce).toHaveBeenCalledTimes(1);
    expect(mockTryCallLLM).not.toHaveBeenCalled();
    expect(r.reply).toContain("SIDE");
    expect(r.reply).toContain("25 tokens");
    expect(r.tokensUsed).toBe(25);
  });

  it("/plan：注入计划提示词消息（主 turn 以注入消息推进）；本命令不触发 LLM", async () => {
    const r = await (executor as any).handleSlashCommand("/plan 重构登录表单校验", "s1", Date.now());
    expect(r).not.toBeNull();
    expect(r.injectedMessage).toContain("/plan — plan mode");
    expect(r.injectedMessage).toContain("重构登录表单校验");
    expect(r.reply).toContain("规划模式");
    expect(mockCallLLMOnce).not.toHaveBeenCalled();
    expect(mockTryCallLLM).not.toHaveBeenCalled();
    expect(r.tokensUsed).toBe(0);
  });

  it("/review：接线 runBackgroundReview fork——callLLMOnce 执行评审，回复含评审文本", async () => {
    const r = await (executor as any).handleSlashCommand("/review", "s1", Date.now());
    expect(r).not.toBeNull();
    expect(mockCallLLMOnce).toHaveBeenCalledTimes(1);
    expect(mockTryCallLLM).not.toHaveBeenCalled();
    expect(r.reply).toContain("后台评审 fork 已执行");
    expect(r.reply).toContain("SIDE");
    expect(r.tokensUsed).toBe(25);
  });

  it("/review 空会话：直接空提示，不触发 fork", async () => {
    (executor as any).conversationHistory.set("s1", []);
    const r = await (executor as any).handleSlashCommand("/review", "s1", Date.now());
    expect(r.reply).toContain("没有可评审");
    expect(mockCallLLMOnce).not.toHaveBeenCalled();
    expect(mockTryCallLLM).not.toHaveBeenCalled();
  });

  // ── hermes alignment round4：辅助调用成本记账（不丢、不重复）──────
  it("★ /btw 侧问通道：recordTokenUsage 收到 prompt/output 拆分后的 usage", async () => {
    const record = vi.fn();
    executor.setTokenUsageTracker({ record } as never);
    const r = await (executor as any).handleSlashCommand("/btw 缓存上限改善了吗", "s1", Date.now());
    expect(r.tokensUsed).toBe(25); // slash 返回值语义不变
    expect(record).toHaveBeenCalledTimes(1);
    const usage = record.mock.calls[0][0];
    expect(usage.sessionId).toBe("s1");
    expect(usage.model).toBe("claude-opus-4");
    expect(usage.inputTokens).toBe(15);
    expect(usage.outputTokens).toBe(10); // 25 - 15，且不为负
  });

  it("★ /review fork：独立 LLM 调用同样记账，且仍不消耗 tryCallLLM 主 turn", async () => {
    const record = vi.fn();
    executor.setTokenUsageTracker({ record } as never);
    const r = await (executor as any).handleSlashCommand("/review", "s1", Date.now());
    expect(r.reply).toContain("后台评审 fork 已执行");
    expect(mockTryCallLLM).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].sessionId).toBe("s1");
    expect(record.mock.calls[0][0].outputTokens).toBe(10);
  });

  it("tokenUsageTracker 未注入时辅助通道静默跳过，不抛错", async () => {
    const r = await (executor as any).handleSlashCommand("/btw 成本记账会崩吗", "s1", Date.now());
    expect(r.reply).toContain("SIDE");
  });

  it("/btw 未带问题：用法提示，不触发 side 通道", async () => {
    const r = await (executor as any).handleSlashCommand("/btw", "s1", Date.now());
    expect(r.reply).toContain("请在命令后附带侧问内容");
    expect(mockCallLLMOnce).not.toHaveBeenCalled();
    expect(mockTryCallLLM).not.toHaveBeenCalled();
  });

  it("/help 通过 executor 私有分发列出四命令", async () => {
    const r = await (executor as any).handleSlashCommand("/help", "s1", Date.now());
    expect(r.reply).toContain("`/btw");
    expect(r.reply).toContain("`/plan");
    expect(r.reply).toContain("`/review");
    expect(r.reply).toContain("`/learn");
  });
});
