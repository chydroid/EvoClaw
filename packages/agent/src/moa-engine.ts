/**
 * MoA Engine — 增强的多阶段 Mixture-of-Agents 推理引擎。
 *
 * 对标 hermes-agent 的 MoA 实现（agent/moa_loop.py + agent/moa_trace.py +
 * hermes_cli/moa_config.py + hermes_cli/moa_cmd.py）：
 *   - 4 阶段流水线：Proposal → Aggregation → Verification → Synthesis
 *   - 模型角色分离：Proposer / Aggregator / Verifier / Synthesizer
 *   - 4 种聚合策略：concat / best / vote / weighted
 *   - 超时控制（AbortController）+ 容错（Promise.allSettled）
 *   - 阶段级延迟 / token / 成本追踪
 *
 * 与 MoaCommittee 的关系：
 *   MoaCommittee 是 2 阶段（fan-out → aggregate）的轻量委员会；
 *   MoaEngine 是 4 阶段的完整 MoA 流水线，支持验证回路与多策略聚合。
 *
 * 设计原则：
 * 1. ChatFn 注入 —— 不绑定具体 provider，调用方提供 `(prompt, model) => Promise<{content, tokensUsed}>`
 * 2. 也可从 ServiceRegistry 解析 AgentModelExecutor 构建默认 ChatFn 适配器
 * 3. 并行 fan-out —— Proposer 全部并发，Promise.allSettled 容错
 * 4. 超时 —— 单一 AbortController 贯穿所有阶段，超时即中断
 * 5. 精确追踪 —— 每阶段记录 latency / tokens，累计为 totalLatency / totalTokens / totalCost
 */

import type { ServiceRegistry } from "@evoclaw/core";

// ── Types ─────────────────────────────────────────────────

/** 模型引用 */
export interface ModelRef {
  /** Provider 标识，如 "openai" / "anthropic" / "deepseek" */
  provider: string;
  /** 模型 ID，如 "gpt-5" / "claude-sonnet-4" */
  model: string;
  /** 权重（用于 weighted 聚合策略，默认 0） */
  weight?: number;
}

/** MoA 引擎配置 */
export interface MoaConfig {
  /** Proposer 模型列表（并行生成初始提案） */
  proposers: ModelRef[];
  /** 聚合模型（合并/去重提案）。best / vote 策略必需 */
  aggregator?: ModelRef;
  /** 验证模型（检查聚合结果）。verificationEnabled=true 时必需 */
  verifier?: ModelRef;
  /** 综合模型（生成最终答案） */
  synthesizer: ModelRef;
  /** 最大提案数（超过则截断 proposer 列表） */
  maxProposals?: number;
  /** 聚合策略，默认 "concat" */
  aggregationStrategy?: "concat" | "best" | "vote" | "weighted";
  /** 是否启用验证阶段，默认 false */
  verificationEnabled?: boolean;
  /** 总超时（ms），超时则中断整个 execute */
  timeoutMs?: number;
}

/** 单个提案（内部结构，含权重 / token / 成功标志） */
export interface Proposal {
  /** 模型标识 `provider/model` */
  model: string;
  /** 提案内容（失败时为空串） */
  content: string;
  /** 延迟（ms） */
  latency: number;
  /** token 用量 */
  tokens: number;
  /** 权重（来自 ModelRef.weight） */
  weight: number;
  /** 是否成功 */
  success: boolean;
  /** 失败原因 */
  error?: string;
}

/** 聚合结果 */
export interface AggregationResult {
  /** 使用的策略名 */
  strategy: string;
  /** 聚合后的内容 */
  aggregatedContent: string;
  /** 延迟（ms） */
  latency: number;
  /** token 用量 */
  tokens: number;
}

/** 验证结果 */
export interface VerificationResult {
  /** 是否通过 */
  passed: boolean;
  /** 识别到的冲突列表 */
  conflicts: string[];
  /** 延迟（ms） */
  latency: number;
  /** token 用量 */
  tokens: number;
}

/** MoA 执行结果 */
export interface MoaResult {
  /** 综合后的最终答案 */
  finalAnswer: string;
  /** 各 proposer 的提案（slim 视图，含失败项 content=""） */
  proposals: Array<{ model: string; content: string; latency: number }>;
  /** 聚合阶段信息 */
  aggregation: {
    strategy: string;
    aggregatedContent: string;
  };
  /** 验证阶段信息（未启用时为 undefined） */
  verification?: {
    passed: boolean;
    conflicts: string[];
  };
  /** 总延迟（ms） */
  totalLatency: number;
  /** 总 token 用量 */
  totalTokens: number;
  /** 总成本（当前为 0，预留计费扩展） */
  totalCost: number;
}

/** 执行统计 */
export interface MoaStats {
  /** 总执行次数 */
  totalRuns: number;
  /** 成功次数 */
  successfulRuns: number;
  /** 失败次数 */
  failedRuns: number;
  /** 累计延迟（ms） */
  totalLatencyMs: number;
  /** 累计 token */
  totalTokens: number;
  /** 累计成本 */
  totalCost: number;
  /** 平均延迟（ms） */
  averageLatencyMs: number;
}

/**
 * Chat 函数 —— 由调用方注入具体 LLM 调用。
 * 返回内容与 token 用量，由 MoaEngine 负责计时。
 */
export type MoaEngineChatFn = (
  prompt: string,
  model: ModelRef,
  options?: { systemPrompt?: string; signal?: AbortSignal },
) => Promise<{ content: string; tokensUsed: number }>;

/** AgentModelExecutor 的最小可见接口（仅 chat 方法），避免重型导入与循环依赖 */
interface AgentModelExecutorLike {
  chat(
    message: string,
    context?: Record<string, unknown>,
    onProgress?: unknown,
  ): Promise<{ reply: string; tokensUsed: number }>;
}

// ── MoaEngine ─────────────────────────────────────────────

/**
 * MoA Engine —— 多阶段 Mixture-of-Agents 推理引擎。
 *
 * 流程：
 * 1. Proposal：多个 proposer 并行生成初始答案（Promise.allSettled 容错）
 * 2. Aggregation：按策略聚合所有提案（concat / best / vote / weighted）
 * 3. Verification：verifier 检查聚合结果的准确性与冲突（可选）
 * 4. Synthesis：synthesizer 综合生成最终答案
 */
export class MoaEngine {
  private config: MoaConfig;
  private chatFn: MoaEngineChatFn;
  private stats: MoaStats = {
    totalRuns: 0,
    successfulRuns: 0,
    failedRuns: 0,
    totalLatencyMs: 0,
    totalTokens: 0,
    totalCost: 0,
    averageLatencyMs: 0,
  };

  constructor(
    config: MoaConfig,
    options?: { chatFn?: MoaEngineChatFn; registry?: ServiceRegistry },
  ) {
    this.validateConfig(config);
    this.config = config;

    if (options?.chatFn) {
      this.chatFn = options.chatFn;
    } else if (options?.registry) {
      // 通过 ServiceRegistry 解析 AgentModelExecutor，构建默认 ChatFn 适配器
      this.chatFn = this.buildAdapterChatFn(options.registry);
    } else {
      // 无 chatFn 也无 registry —— 占位，execute 时会因 chatFn 报错
      this.chatFn = async () => {
        throw new Error("MoaEngine: chatFn not configured (provide chatFn or registry)");
      };
    }

    // 只要提供了 registry 就注册自身（无论 chatFn 是否注入）
    if (options?.registry) {
      this.registerSelf(options.registry);
    }
  }

  // ── 公共 API ────────────────────────────────────────────

  /** 执行 4 阶段 MoA 流水线 */
  async execute(prompt: string, context?: unknown): Promise<MoaResult> {
    const start = Date.now();
    const controller = new AbortController();
    const signal = controller.signal;
    const timeoutMs = this.config.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }

    try {
      // ── Phase 1: Proposal ──
      const proposals = await this.runProposalPhase(prompt, context, signal);
      const successful = proposals.filter((p) => p.success);
      if (successful.length === 0) {
        throw new Error("MoA execute failed: all proposers failed");
      }

      // ── Phase 2: Aggregation ──
      const aggregation = await this.runAggregationPhase(successful, prompt, signal);

      // ── Phase 3: Verification（可选）──
      let verification: VerificationResult | undefined;
      if (this.config.verificationEnabled) {
        verification = await this.runVerificationPhase(aggregation.aggregatedContent, prompt, signal);
      }

      // ── Phase 4: Synthesis ──
      const synthesis = await this.runSynthesisPhase(aggregation, verification, prompt, signal);

      const totalLatency = Date.now() - start;
      const totalTokens =
        proposals.reduce((sum, p) => sum + p.tokens, 0) +
        aggregation.tokens +
        (verification?.tokens ?? 0) +
        synthesis.tokens;

      const result: MoaResult = {
        finalAnswer: synthesis.answer,
        proposals: proposals.map((p) => ({ model: p.model, content: p.content, latency: p.latency })),
        aggregation: {
          strategy: aggregation.strategy,
          aggregatedContent: aggregation.aggregatedContent,
        },
        verification: verification
          ? { passed: verification.passed, conflicts: verification.conflicts }
          : undefined,
        totalLatency,
        totalTokens,
        totalCost: 0,
      };

      this.recordStats(totalLatency, totalTokens, true);
      return result;
    } catch (err) {
      this.recordStats(Date.now() - start, 0, false);
      if (timedOut) {
        throw new Error(`MoA execute timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 更新配置 */
  configure(config: MoaConfig): void {
    this.validateConfig(config);
    this.config = config;
  }

  /** 获取当前配置 */
  getConfig(): MoaConfig {
    return this.config;
  }

  /** 获取执行统计（返回副本，避免外部篡改） */
  getStats(): MoaStats {
    return {
      ...this.stats,
      averageLatencyMs:
        this.stats.totalRuns > 0 ? this.stats.totalLatencyMs / this.stats.totalRuns : 0,
    };
  }

  // ── 阶段实现 ────────────────────────────────────────────

  /** Phase 1: 并行调用所有 proposer，容错收集结果 */
  private async runProposalPhase(
    prompt: string,
    context: unknown,
    signal: AbortSignal,
  ): Promise<Proposal[]> {
    const limit = this.config.maxProposals ?? this.config.proposers.length;
    const proposers = this.config.proposers.slice(0, Math.max(0, limit));
    const contextBlock = this.buildContextBlock(context);
    const systemPrompt =
      "You are a proposer in a Mixture-of-Agents (MoA) system. " +
      "Provide an independent, thorough answer to the user's question. " +
      "Do not reference other models.";

    // Promise.allSettled 容错：单个 proposer 失败不影响整体
    const settled = await Promise.allSettled(
      proposers.map((m) =>
        this.callLLM(m, `${prompt}${contextBlock}\n\nProvide your answer:`, systemPrompt, signal),
      ),
    );

    return settled.map((res, idx) => {
      const ref = proposers[idx];
      const model = this.modelLabel(ref);
      if (res.status === "fulfilled") {
        return {
          model,
          content: res.value.content,
          latency: res.value.latency,
          tokens: res.value.tokens,
          weight: ref.weight ?? 0,
          success: true,
        };
      }
      return {
        model,
        content: "",
        latency: 0,
        tokens: 0,
        weight: ref.weight ?? 0,
        success: false,
        error: res.reason instanceof Error ? res.reason.message : String(res.reason),
      };
    });
  }

  /** Phase 2: 聚合提案 */
  private async runAggregationPhase(
    proposals: Proposal[],
    prompt: string,
    signal: AbortSignal,
  ): Promise<AggregationResult> {
    const strategy = this.config.aggregationStrategy ?? "concat";
    const start = Date.now();

    if (strategy === "concat") {
      const aggregatedContent = proposals
        .map((p, i) => `### Proposal ${i + 1} (${p.model})\n${p.content}`)
        .join("\n\n---\n\n");
      return { strategy, aggregatedContent, latency: 0, tokens: 0 };
    }

    if (strategy === "weighted") {
      // 按 weight 降序排列后拼接（无需 LLM）
      const sorted = [...proposals].sort((a, b) => b.weight - a.weight);
      const aggregatedContent = sorted
        .map((p) => `### ${p.model} (weight=${p.weight})\n${p.content}`)
        .join("\n\n---\n\n");
      return { strategy, aggregatedContent, latency: Date.now() - start, tokens: 0 };
    }

    // best / vote 需要 aggregator LLM
    if (!this.config.aggregator) {
      throw new Error(`Aggregation strategy "${strategy}" requires an aggregator model`);
    }

    const blocks = proposals
      .map((p, i) => `## Proposal ${i + 1} (${p.model})\n${p.content}`)
      .join("\n\n---\n\n");

    const sysPrompt =
      "You are an aggregator in a Mixture-of-Agents system. " +
      "Return ONLY the content of the chosen proposal, unchanged.";

    const userPrompt =
      strategy === "best"
        ? `User question:\n${prompt}\n\nSelect the BEST proposal below and return its content unchanged.\n\n${blocks}`
        : `User question:\n${prompt}\n\nBelow are proposals from multiple models. Vote on the proposal that best represents the consensus and return its content unchanged.\n\n${blocks}`;

    const result = await this.callLLM(
      this.config.aggregator,
      userPrompt,
      sysPrompt,
      signal,
    );
    return {
      strategy,
      aggregatedContent: result.content,
      latency: Date.now() - start,
      tokens: result.tokens,
    };
  }

  /** Phase 3: 验证聚合结果 */
  private async runVerificationPhase(
    aggregated: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<VerificationResult> {
    if (!this.config.verifier) {
      throw new Error("Verification enabled but no verifier model configured");
    }
    const start = Date.now();
    const systemPrompt =
      "You are a verifier in a Mixture-of-Agents system. " +
      'Check the answer for accuracy, completeness, and conflicts. Respond as JSON: {"passed": boolean, "conflicts": string[]}';

    const userPrompt =
      `User question:\n${prompt}\n\nAnswer to verify:\n${aggregated}\n\n` +
      'Return JSON: {"passed": boolean, "conflicts": string[]}';

    const result = await this.callLLM(this.config.verifier, userPrompt, systemPrompt, signal);
    const parsed = this.parseVerificationResponse(result.content);
    return {
      passed: parsed.passed,
      conflicts: parsed.conflicts,
      latency: Date.now() - start,
      tokens: result.tokens,
    };
  }

  /** Phase 4: 综合生成最终答案 */
  private async runSynthesisPhase(
    aggregation: AggregationResult,
    verification: VerificationResult | undefined,
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ answer: string; latency: number; tokens: number }> {
    const start = Date.now();
    const systemPrompt =
      "You are the synthesizer in a Mixture-of-Agents system. " +
      "Produce the final comprehensive, accurate answer. " +
      "Integrate the best parts of the aggregated content and resolve any conflicts.";

    let userPrompt = `User question:\n${prompt}\n\nAggregated content:\n${aggregation.aggregatedContent}`;
    if (verification) {
      userPrompt +=
        `\n\nVerification result: passed=${verification.passed}, ` +
        `conflicts=${JSON.stringify(verification.conflicts)}. ` +
        `Resolve any conflicts in your final answer.`;
    }
    userPrompt += "\n\nProduce the final answer:";

    const result = await this.callLLM(this.config.synthesizer, userPrompt, systemPrompt, signal);
    return { answer: result.content, latency: Date.now() - start, tokens: result.tokens };
  }

  // ── 辅助方法 ────────────────────────────────────────────

  /** 调用 chatFn 并计时 */
  private async callLLM(
    model: ModelRef,
    prompt: string,
    systemPrompt: string,
    signal: AbortSignal,
  ): Promise<{ content: string; tokens: number; latency: number }> {
    const start = Date.now();
    const { content, tokensUsed } = await this.chatFn(prompt, model, { systemPrompt, signal });
    return { content, tokens: tokensUsed, latency: Date.now() - start };
  }

  /** 校验配置 */
  private validateConfig(config: MoaConfig): void {
    if (!config.proposers || config.proposers.length === 0) {
      throw new Error("MoaConfig requires at least one proposer");
    }
    if (!config.synthesizer) {
      throw new Error("MoaConfig requires a synthesizer");
    }
    const strategy = config.aggregationStrategy ?? "concat";
    if ((strategy === "best" || strategy === "vote") && !config.aggregator) {
      throw new Error(`Aggregation strategy "${strategy}" requires an aggregator model`);
    }
    if (config.verificationEnabled && !config.verifier) {
      throw new Error("Verification enabled but no verifier model configured");
    }
  }

  /** 从 AgentModelExecutor 构建默认 ChatFn 适配器 */
  private buildAdapterChatFn(registry: ServiceRegistry): MoaEngineChatFn {
    return async (prompt, _model, options) => {
      const executor = registry.resolveService<AgentModelExecutorLike>("agentModelExecutor");
      if (!executor) {
        throw new Error("agentModelExecutor not registered in ServiceRegistry");
      }
      const ctx: Record<string, unknown> = {};
      if (options?.signal) ctx.signal = options.signal;
      const res = await executor.chat(prompt, ctx);
      return { content: res.reply, tokensUsed: res.tokensUsed };
    };
  }

  /** 注册自身到 ServiceRegistry（已存在则替换） */
  private registerSelf(registry: ServiceRegistry): void {
    if (registry.hasService("moaEngine")) {
      registry.replaceService("moaEngine", this);
    } else {
      registry.registerService("moaEngine", this);
    }
  }

  /** 模型标签 */
  private modelLabel(ref: ModelRef): string {
    return `${ref.provider}/${ref.model}`;
  }

  /** 构建上下文片段 */
  private buildContextBlock(context: unknown): string {
    if (context === undefined || context === null) return "";
    if (typeof context === "string") {
      return context.trim() ? `\n\n[Context]\n${context}` : "";
    }
    try {
      const json = JSON.stringify(context, null, 2);
      return json && json !== "{}" ? `\n\n[Context]\n${json}` : "";
    } catch {
      return "";
    }
  }

  /** 解析验证响应（容错 JSON 解析） */
  private parseVerificationResponse(content: string): { passed: boolean; conflicts: string[] } {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const obj = JSON.parse(match[0]) as { passed?: boolean; conflicts?: unknown };
        return {
          passed: obj.passed !== false,
          conflicts: Array.isArray(obj.conflicts) ? obj.conflicts.map(String) : [],
        };
      } catch {
        // 解析失败，默认通过
      }
    }
    return { passed: true, conflicts: [] };
  }

  /** 记录统计 */
  private recordStats(latencyMs: number, tokens: number, success: boolean): void {
    this.stats.totalRuns++;
    if (success) this.stats.successfulRuns++;
    else this.stats.failedRuns++;
    this.stats.totalLatencyMs += latencyMs;
    this.stats.totalTokens += tokens;
    // totalCost 预留：当前无定价表，保持 0
    this.stats.averageLatencyMs = this.stats.totalLatencyMs / this.stats.totalRuns;
  }
}
