import { describe, it, expect, beforeEach } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import {
  MoaEngine,
  type MoaConfig,
  type ModelRef,
  type MoaEngineChatFn,
} from "./moa-engine";

// ── 测试夹具 ───────────────────────────────────────────────

/** 模型定义 */
const OPENAI: ModelRef = { provider: "openai", model: "gpt-5" };
const ANTHROPIC: ModelRef = { provider: "anthropic", model: "claude-sonnet-4" };
const DEEPSEEK: ModelRef = { provider: "deepseek", model: "deepseek-v4" };
const SYNTHESIZER: ModelRef = { provider: "anthropic", model: "claude-opus-4" };
const VERIFIER: ModelRef = { provider: "openai", model: "gpt-4o" };

type MockResp = {
  content: string;
  tokensUsed?: number;
  delayMs?: number;
  reject?: boolean;
};

/** 构建可配置的 mock chatFn —— 通过 prompt/model 决定返回值 */
function createMockChatFn(
  handler: (prompt: string, model: ModelRef) => MockResp | Promise<MockResp>,
): MoaEngineChatFn {
  return async (prompt, model, opts) => {
    const r = await handler(prompt, model);
    if (r.reject) {
      throw new Error(`mock reject for ${model.provider}/${model.model}`);
    }
    if (r.delayMs) {
      await sleep(r.delayMs, opts?.signal);
    }
    return { content: r.content, tokensUsed: r.tokensUsed ?? 10 };
  };
}

/** 可中断的 sleep（signal abort 时 reject） */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** 基础配置（3 proposer + synthesizer，concat 策略，无验证） */
function baseConfig(overrides: Partial<MoaConfig> = {}): MoaConfig {
  return {
    proposers: [OPENAI, ANTHROPIC, DEEPSEEK],
    synthesizer: SYNTHESIZER,
    aggregationStrategy: "concat",
    ...overrides,
  };
}

/** 默认 mock：proposer 返回各自答案，synthesizer 返回综合答案 */
function defaultChatFn(): MoaEngineChatFn {
  return createMockChatFn((_prompt, model) => {
    if (model.provider === "openai" && model.model === "gpt-5") {
      return { content: "GPT5 answer", tokensUsed: 20 };
    }
    if (model.provider === "anthropic" && model.model === "claude-sonnet-4") {
      return { content: "Claude answer", tokensUsed: 30 };
    }
    if (model.provider === "deepseek" && model.model === "deepseek-v4") {
      return { content: "DeepSeek answer", tokensUsed: 25 };
    }
    // synthesizer / aggregator / verifier
    return { content: "Synthesized final answer", tokensUsed: 40 };
  });
}

// ── Tests ─────────────────────────────────────────────────

describe("MoaEngine", () => {
  // ── 构造与配置 ──────────────────────────────────────────

  describe("construction & config", () => {
    it("空 proposer 列表应报错", () => {
      expect(
        () => new MoaEngine({ proposers: [], synthesizer: SYNTHESIZER }),
      ).toThrowError(/at least one proposer/);
    });

    it("缺少 synthesizer 应报错", () => {
      expect(
        () => new MoaEngine({ proposers: [OPENAI] }),
      ).toThrowError(/synthesizer/);
    });

    it("best 策略缺少 aggregator 应报错", () => {
      expect(
        () => new MoaEngine({ proposers: [OPENAI], synthesizer: SYNTHESIZER, aggregationStrategy: "best" }),
      ).toThrowError(/aggregator/);
    });

    it("verificationEnabled 缺少 verifier 应报错", () => {
      expect(
        () => new MoaEngine({ proposers: [OPENAI], synthesizer: SYNTHESIZER, verificationEnabled: true }),
      ).toThrowError(/verifier/);
    });

    it("configure 更新配置应生效", async () => {
      const engine = new MoaEngine(baseConfig(), { chatFn: defaultChatFn() });
      expect(engine.getConfig().aggregationStrategy).toBe("concat");
      engine.configure({ ...baseConfig(), aggregationStrategy: "weighted" });
      expect(engine.getConfig().aggregationStrategy).toBe("weighted");
    });
  });

  // ── 基本执行流程 ────────────────────────────────────────

  describe("execute pipeline", () => {
    it("基本执行流程应完成 4 阶段", async () => {
      const engine = new MoaEngine(
        { ...baseConfig(), verificationEnabled: true, verifier: VERIFIER },
        {
          chatFn: createMockChatFn((_p, model) => {
            if (model.provider === "openai" && model.model === "gpt-4o") {
              // verifier
              return {
                content: '{"passed": true, "conflicts": []}',
                tokensUsed: 5,
              };
            }
            if (model.model === "claude-opus-4") {
              // synthesizer
              return { content: "FINAL ANSWER", tokensUsed: 40 };
            }
            // proposers —— 每个模型返回可识别内容
            return { content: `Proposal from ${model.model}`, tokensUsed: 15 };
          }),
        },
      );

      const result = await engine.execute("What is MoA?");

      expect(result.finalAnswer).toBe("FINAL ANSWER");
      expect(result.proposals).toHaveLength(3);
      expect(result.aggregation.strategy).toBe("concat");
      expect(result.aggregation.aggregatedContent).toContain("Proposal from gpt-5");
      expect(result.aggregation.aggregatedContent).toContain("Proposal from deepseek-v4");
      expect(result.verification).toBeDefined();
      expect(result.verification?.passed).toBe(true);
      expect(result.verification?.conflicts).toEqual([]);
      expect(result.totalLatency).toBeGreaterThanOrEqual(0);
      expect(result.totalTokens).toBeGreaterThan(0);
    });

    it("单个 proposer 应返回单个提案", async () => {
      const engine = new MoaEngine(
        { proposers: [OPENAI], synthesizer: SYNTHESIZER },
        { chatFn: defaultChatFn() },
      );
      const result = await engine.execute("hi");
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0].content).toBe("GPT5 answer");
    });

    it("多个 proposer 并行应全部出现在结果中", async () => {
      const engine = new MoaEngine(baseConfig(), { chatFn: defaultChatFn() });
      const result = await engine.execute("hi");
      const models = result.proposals.map((p) => p.model);
      expect(models).toEqual(
        expect.arrayContaining([
          "openai/gpt-5",
          "anthropic/claude-sonnet-4",
          "deepseek/deepseek-v4",
        ]),
      );
      expect(result.proposals).toHaveLength(3);
    });
  });

  // ── 聚合策略 ────────────────────────────────────────────

  describe("aggregation strategies", () => {
    it("concat 策略应拼接所有提案内容", async () => {
      const engine = new MoaEngine(
        { ...baseConfig(), aggregationStrategy: "concat" },
        { chatFn: defaultChatFn() },
      );
      const result = await engine.execute("q");
      expect(result.aggregation.strategy).toBe("concat");
      expect(result.aggregation.aggregatedContent).toContain("GPT5 answer");
      expect(result.aggregation.aggregatedContent).toContain("Claude answer");
      expect(result.aggregation.aggregatedContent).toContain("DeepSeek answer");
    });

    it("weighted 策略应按权重降序排列", async () => {
      const engine = new MoaEngine(
        {
          proposers: [
            { provider: "openai", model: "gpt-5", weight: 1 },
            { provider: "anthropic", model: "claude-sonnet-4", weight: 5 },
            { provider: "deepseek", model: "deepseek-v4", weight: 3 },
          ],
          synthesizer: SYNTHESIZER,
          aggregationStrategy: "weighted",
        },
        { chatFn: defaultChatFn() },
      );
      const result = await engine.execute("q");
      const content = result.aggregation.aggregatedContent;
      // weight 5 (claude) 应在 weight 3 (deepseek) 之前，weight 3 在 weight 1 (gpt) 之前
      const claudeIdx = content.indexOf("claude-sonnet-4");
      const deepseekIdx = content.indexOf("deepseek-v4");
      const gptIdx = content.indexOf("gpt-5");
      expect(claudeIdx).toBeLessThan(deepseekIdx);
      expect(deepseekIdx).toBeLessThan(gptIdx);
      expect(content).toContain("weight=5");
    });

    it("best 策略应调用 aggregator 返回其内容", async () => {
      const aggregator: ModelRef = { provider: "google", model: "gemini-pro" };
      const engine = new MoaEngine(
        { ...baseConfig(), aggregator, aggregationStrategy: "best" },
        {
          chatFn: createMockChatFn((_p, model) => {
            if (model.provider === "google") {
              return { content: "BEST PICK", tokensUsed: 7 };
            }
            if (model.model === "claude-opus-4") {
              return { content: "FINAL", tokensUsed: 40 };
            }
            return { content: `${model.model}-p`, tokensUsed: 12 };
          }),
        },
      );
      const result = await engine.execute("q");
      expect(result.aggregation.strategy).toBe("best");
      expect(result.aggregation.aggregatedContent).toBe("BEST PICK");
    });

    it("vote 策略应调用 aggregator 返回共识内容", async () => {
      const aggregator: ModelRef = { provider: "google", model: "gemini-pro" };
      const engine = new MoaEngine(
        { ...baseConfig(), aggregator, aggregationStrategy: "vote" },
        {
          chatFn: createMockChatFn((_p, model) => {
            if (model.provider === "google") {
              return { content: "VOTED CONSENSUS", tokensUsed: 8 };
            }
            if (model.model === "claude-opus-4") {
              return { content: "FINAL", tokensUsed: 40 };
            }
            return { content: `${model.model}-p`, tokensUsed: 12 };
          }),
        },
      );
      const result = await engine.execute("q");
      expect(result.aggregation.strategy).toBe("vote");
      expect(result.aggregation.aggregatedContent).toBe("VOTED CONSENSUS");
    });
  });

  // ── 验证阶段 ────────────────────────────────────────────

  describe("verification", () => {
    it("禁用验证时 verification 为 undefined", async () => {
      const engine = new MoaEngine(baseConfig(), { chatFn: defaultChatFn() });
      const result = await engine.execute("q");
      expect(result.verification).toBeUndefined();
    });

    it("启用验证时识别冲突", async () => {
      const engine = new MoaEngine(
        { ...baseConfig(), verificationEnabled: true, verifier: VERIFIER },
        {
          chatFn: createMockChatFn((_p, model) => {
            if (model.provider === "openai" && model.model === "gpt-4o") {
              return {
                content: '{"passed": false, "conflicts": ["fact mismatch", "missing info"]}',
                tokensUsed: 6,
              };
            }
            if (model.model === "claude-opus-4") {
              return { content: "FINAL", tokensUsed: 40 };
            }
            return { content: `${model.model}-p`, tokensUsed: 12 };
          }),
        },
      );
      const result = await engine.execute("q");
      expect(result.verification).toBeDefined();
      expect(result.verification?.passed).toBe(false);
      expect(result.verification?.conflicts).toEqual(["fact mismatch", "missing info"]);
    });
  });

  // ── 容错与超时 ──────────────────────────────────────────

  describe("fault tolerance & timeout", () => {
    it("Proposer 失败容错（Promise.allSettled）不应中断整体", async () => {
      const engine = new MoaEngine(baseConfig(), {
        chatFn: createMockChatFn((_p, model) => {
          // 让 deepseek 失败
          if (model.provider === "deepseek") {
            return { content: "", reject: true };
          }
          if (model.model === "claude-opus-4") {
            return { content: "FINAL", tokensUsed: 40 };
          }
          return { content: `${model.model}-p`, tokensUsed: 12 };
        }),
      });
      const result = await engine.execute("q");
      expect(result.finalAnswer).toBe("FINAL");
      expect(result.proposals).toHaveLength(3);
      const failed = result.proposals.find((p) => p.model === "deepseek/deepseek-v4");
      expect(failed).toBeDefined();
      expect(failed?.content).toBe("");
    });

    it("全部 proposer 失败应抛出错误", async () => {
      const engine = new MoaEngine(baseConfig(), {
        chatFn: createMockChatFn(() => ({ content: "", reject: true })),
      });
      await expect(engine.execute("q")).rejects.toThrowError(/all proposers failed/);
    });

    it("AbortController 超时应在 timeoutMs 后中断", async () => {
      const engine = new MoaEngine(
        { ...baseConfig(), timeoutMs: 50 },
        {
          chatFn: createMockChatFn(() => ({ content: "slow", delayMs: 1000 })),
        },
      );
      await expect(engine.execute("q")).rejects.toThrowError(/timed out after 50ms/);
    });
  });

  // ── 统计与追踪 ──────────────────────────────────────────

  describe("stats & tracking", () => {
    it("统计信息应记录成功与失败次数", async () => {
      const engine = new MoaEngine(
        { ...baseConfig(), timeoutMs: 30 },
        { chatFn: createMockChatFn(() => ({ content: "slow", delayMs: 500 })) },
      );
      // 一次因超时失败
      await expect(engine.execute("q")).rejects.toThrow();
      const stats = engine.getStats();
      expect(stats.totalRuns).toBe(1);
      expect(stats.failedRuns).toBe(1);
      expect(stats.successfulRuns).toBe(0);
      expect(stats.averageLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it("Token/cost 应跨阶段累加", async () => {
      const engine = new MoaEngine(
        { ...baseConfig(), verificationEnabled: true, verifier: VERIFIER },
        {
          chatFn: createMockChatFn((_p, model) => {
            if (model.provider === "openai" && model.model === "gpt-4o") {
              return { content: '{"passed": true, "conflicts": []}', tokensUsed: 5 };
            }
            if (model.model === "claude-opus-4") {
              return { content: "FINAL", tokensUsed: 40 };
            }
            return { content: `${model.model}-p`, tokensUsed: 15 };
          }),
        },
      );
      const result = await engine.execute("q");
      // 3 proposer (15*3) + verifier (5) + synthesizer (40) = 90
      expect(result.totalTokens).toBe(90);
      expect(result.totalCost).toBe(0);
      const stats = engine.getStats();
      expect(stats.totalTokens).toBe(90);
      expect(stats.successfulRuns).toBe(1);
    });

    it("多次执行后统计应累积", async () => {
      const engine = new MoaEngine(baseConfig(), { chatFn: defaultChatFn() });
      await engine.execute("q1");
      await engine.execute("q2");
      const stats = engine.getStats();
      expect(stats.totalRuns).toBe(2);
      expect(stats.successfulRuns).toBe(2);
    });
  });

  // ── ServiceRegistry 集成 ────────────────────────────────

  describe("ServiceRegistry integration", () => {
    it("提供 registry 时应注册 moaEngine 服务", () => {
      const registry = new ServiceRegistry();
      new EventBus(); // 确保 EventBus 可构造（不强制注入）
      // 用 chatFn 避免 registry 解析 agentModelExecutor（无 agent 时 execute 会失败，
      // 此处仅验证注册行为）
      new MoaEngine(baseConfig(), { chatFn: defaultChatFn(), registry });
      expect(registry.hasService("moaEngine")).toBe(true);
      const resolved = registry.resolveService<MoaEngine>("moaEngine");
      expect(resolved).toBeInstanceOf(MoaEngine);
    });

    it("重复构造应替换已注册的 moaEngine", () => {
      const registry = new ServiceRegistry();
      const engine1 = new MoaEngine(baseConfig(), { chatFn: defaultChatFn(), registry });
      const engine2 = new MoaEngine(baseConfig(), { chatFn: defaultChatFn(), registry });
      expect(registry.resolveService<MoaEngine>("moaEngine")).toBe(engine2);
      expect(registry.resolveService<MoaEngine>("moaEngine")).not.toBe(engine1);
    });
  });

  // ── 上下文传递 ──────────────────────────────────────────

  describe("context propagation", () => {
    it("字符串 context 应注入到 proposal prompt", async () => {
      let capturedPrompt = "";
      const engine = new MoaEngine(baseConfig(), {
        chatFn: createMockChatFn((p, model) => {
          if (model.model === "gpt-5") capturedPrompt = p;
          if (model.model === "claude-opus-4") {
            return { content: "FINAL", tokensUsed: 40 };
          }
          return { content: `${model.model}-p`, tokensUsed: 12 };
        }),
      });
      await engine.execute("question", "extra context info");
      expect(capturedPrompt).toContain("[Context]");
      expect(capturedPrompt).toContain("extra context info");
    });
  });
});
