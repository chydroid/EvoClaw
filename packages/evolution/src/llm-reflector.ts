/**
 * LLMReflector — LLM驱动的Critic反思Agent
 * 
 * 借鉴 Hermes Agent 的 Closed Learning Loop 设计：
 *   Execute → Evaluate → Extract → Retrieve
 * 
 * 与 ExternalReflector（正则引擎）的关系：
 *   - LLMReflector 优先使用 LLM 进行深度语义分析
 *   - LLM 不可用时自动降级为 ExternalReflector 的规则匹配
 *   - 两者共享相同的 ReflectionResult 接口，确保兼容
 */

import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { ExternalReflector } from "./external-reflector";
import type { ReflectionResult, ExecutionTrace } from "./external-reflector";

// ── LLM Prompt Templates ────────────────────────────────────

const REFLECTION_SYSTEM_PROMPT = `你是 EvoClaw 自进化引擎的**反思评审Agent**（Critic）。
你的职责是对智能体执行轨迹进行深度分析，输出结构化的反思结果。

分析维度：
1. **失败分类**：transient（瞬态/网络/超时）、systematic（逻辑/代码错误）、environmental（环境/权限/资源缺失）、unknown
2. **根因推断**：链式因果推理，从错误追溯到根本原因，不只描述表面现象
3. **改进建议**：具体、可执行的修复方案，按优先级排序
4. **是否需要进化**：transient 和 environmental 类错误通常不需要代码进化，systematic 需要

参考 Hermes Agent 的反思模式：
- 分析执行步骤之间的因果关系
- 识别可复用的成功模式和需要避免的失败模式
- 如果发现可复用的工作流，建议提取为技能

输出要求：必须返回严格的 JSON 格式，不要有多余的解释文字。`;

const REFLECTION_USER_PROMPT_TEMPLATE = `请分析以下智能体执行轨迹，给出结构化反思：

## 任务信息
- 任务ID: {taskId}
- 技能ID: {skillId}
- 错误信息: {error}

## 执行步骤
{steps}

## 上下文
{context}

## 分析要求
1. 将失败归类为: transient, systematic, environmental, 或 unknown
2. 推断根本原因（链式因果推理）
3. 给出3-5条具体的改进建议
4. 判断是否需要触发代码进化（shouldEvolve: true/false）
5. 给出置信度评分 (0-1)

返回 JSON 格式:
{
  "rootCause": "根因分析...",
  "failureCategory": "transient|systematic|environmental|unknown",
  "suggestedImprovements": ["建议1", "建议2", ...],
  "confidenceScore": 0.0-1.0,
  "shouldEvolve": true/false
}`;

// ── LLMReflector ────────────────────────────────────────────

export class LLMReflector {
  private registry: ServiceRegistry;
  private eventBus: EventBus;
  private fallbackReflector: ExternalReflector;
  private llmEnabled = true;
  private llmTimeoutMs = 30000;
  private maxRetries = 2;

  constructor(registry: ServiceRegistry, eventBus: EventBus) {
    this.registry = registry;
    this.eventBus = eventBus;
    this.fallbackReflector = new ExternalReflector(registry, eventBus);
  }

  /**
   * 对执行轨迹进行深度反思分析。
   * 优先使用 LLM 进行语义分析，LLM 不可用时降级为规则匹配。
   */
  async reflect(trace: ExecutionTrace): Promise<ReflectionResult> {
    // 先尝试 LLM 分析
    if (this.llmEnabled) {
      try {
        const llmResult = await this.reflectWithLLM(trace);
        if (llmResult) {
          // 发布反思事件
          this.eventBus?.publish(
            "evolution.llm_reflection_completed",
            {
              taskId: trace.taskId,
              skillId: trace.skillId,
              category: llmResult.failureCategory,
              confidence: llmResult.confidenceScore,
              source: "llm",
            },
            "llm-reflector"
          ).catch(() => {});
          return llmResult;
        }
      } catch (err) {
        process.stderr.write(
          `[LLMReflector] LLM reflection failed, falling back to rule-based:` + " " + (err instanceof Error ? err.message : String(err)) + "\n"
        );
      }
    }

    // 降级到规则引擎
    const fallbackResult = await this.fallbackReflector.reflect(trace);
    this.eventBus?.publish(
      "evolution.llm_reflection_fallback",
      {
        taskId: trace.taskId,
        skillId: trace.skillId,
        source: "regex",
      },
      "llm-reflector"
    ).catch(() => {});
    return fallbackResult;
  }

  /**
   * 交叉验证：结合 LLM 反思和内部评分
   */
  async crossValidate(
    internalScore: number,
    reflection: ReflectionResult
  ): Promise<{ finalScore: number; trusted: boolean }> {
    return this.fallbackReflector.crossValidate(internalScore, reflection);
  }

  /**
   * 启用/禁用 LLM 反思
   */
  setLLMEnabled(enabled: boolean): void {
    this.llmEnabled = enabled;
  }

  /**
   * 设置 LLM 超时时间
   */
  setLLMTimeout(ms: number): void {
    this.llmTimeoutMs = ms;
  }

  // ── Private Methods ──────────────────────────────────────

  private async reflectWithLLM(
    trace: ExecutionTrace
  ): Promise<ReflectionResult | null> {
    const executor = this.resolveLLMExecutor();
    if (!executor) return null;

    const prompt = this.buildReflectionPrompt(trace);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.llmTimeoutMs);

    try {
      let llmOutput: string;

      // 优先使用 execute 方法（更直接）
      if (typeof executor.execute === "function") {
        const result = await executor.execute(
          { systemPrompt: REFLECTION_SYSTEM_PROMPT, prompt },
          { signal: controller.signal as AbortSignal }
        );
        llmOutput = result.content;
      } else {
        // 使用 providers 直接调用
        const providers = executor.getProviders().filter((p) => p.enabled);
        if (providers.length === 0) return null;

        const provider = providers[0];
        llmOutput = await this.callProviderDirectly(
          provider,
          REFLECTION_SYSTEM_PROMPT,
          prompt,
          controller.signal
        );
      }

      return this.parseReflectionResponse(llmOutput, trace);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        process.stderr.write("[LLMReflector] LLM reflection timed out");
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveLLMExecutor(): LLMExecutor | null {
    try {
      const executor = this.registry.resolveService<LLMExecutor>("agentModelExecutor");
      if (!executor) return null;
      if (typeof executor.getProviders !== "function") return null;
      return executor;
    } catch {
      return null;
    }
  }

  private buildReflectionPrompt(trace: ExecutionTrace): string {
    const stepsText =
      trace.steps.length > 0
        ? trace.steps
            .map(
              (s, i) =>
                `${i + 1}. [${s.success ? "✓" : "✗"}] ${s.action} → ${s.result.slice(0, 200)}`
            )
            .join("\n")
        : "无执行步骤记录";

    return REFLECTION_USER_PROMPT_TEMPLATE
      .replace("{taskId}", trace.taskId)
      .replace("{skillId}", trace.skillId || "unknown")
      .replace("{error}", trace.error || "无错误信息")
      .replace("{steps}", stepsText)
      .replace("{context}", JSON.stringify(trace.context, null, 2).slice(0, 2000));
  }

  private async callProviderDirectly(
    provider: ProviderInfo,
    systemPrompt: string,
    userPrompt: string,
    signal: AbortSignal
  ): Promise<string> {
    const baseURL = provider.baseURL || "https://api.openai.com/v1";
    const apiUrl = `${baseURL.replace(/\/+$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (provider.apiKey) {
      if (provider.provider === "anthropic" || provider.model?.includes("claude")) {
        headers["x-api-key"] = provider.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${provider.apiKey}`;
      }
    }

    const body =
      provider.provider === "anthropic" || provider.model?.includes("claude")
        ? {
            model: provider.model,
            max_tokens: 2048,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
          }
        : {
            model: provider.model,
            max_tokens: 2048,
            temperature: 0.3,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
          };

    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as Record<string, unknown>;

    // OpenAI-style response
    const choices = data.choices as Array<{ message: { content: string } }> | undefined;
    if (choices && choices.length > 0 && choices[0].message?.content) {
      return choices[0].message.content;
    }

    // Anthropic-style response
    const content = data.content as Array<{ type: string; text: string }> | undefined;
    if (content && content.length > 0 && content[0].text) {
      return content[0].text;
    }

    throw new Error("Unable to parse LLM response");
  }

  private parseReflectionResponse(
    content: string,
    trace: ExecutionTrace
  ): ReflectionResult | null {
    try {
      // 尝试提取 JSON 块
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        process.stderr.write("[LLMReflector] No JSON found in LLM response");
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]) as Partial<ReflectionResult>;

      // 验证必需字段
      if (!parsed.rootCause && !parsed.failureCategory) {
        return null;
      }

      const validCategories: ReflectionResult["failureCategory"][] = [
        "transient",
        "systematic",
        "environmental",
        "unknown",
      ];

      return {
        rootCause: parsed.rootCause || `Analysis of: ${trace.error?.slice(0, 100) || "unknown error"}`,
        failureCategory: validCategories.includes(parsed.failureCategory as ReflectionResult["failureCategory"])
          ? (parsed.failureCategory as ReflectionResult["failureCategory"])
          : "unknown",
        suggestedImprovements: Array.isArray(parsed.suggestedImprovements)
          ? parsed.suggestedImprovements.filter((s): s is string => typeof s === "string").slice(0, 7)
          : [],
        confidenceScore: typeof parsed.confidenceScore === "number"
          ? Math.max(0, Math.min(1, parsed.confidenceScore))
          : 0.6,
        shouldEvolve: typeof parsed.shouldEvolve === "boolean" ? parsed.shouldEvolve : false,
      };
    } catch (err) {
      process.stderr.write(
        "[LLMReflector] Failed to parse LLM response:" + " " + (err instanceof Error ? err.message : String(err)) + "\n"
      );
      return null;
    }
  }
}

// ── Internal Types ─────────────────────────────────────────

interface LLMExecutor {
  getProviders(): ProviderInfo[];
  execute?(
    input: { systemPrompt: string; prompt: string },
    context?: Record<string, unknown>
  ): Promise<{
    content: string;
    usage?: { promptTokens: number; completionTokens: number };
    model?: string;
    finishReason?: string;
  }>;
}

interface ProviderInfo {
  id: string;
  name: string;
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
  enabled: boolean;
  order: number;
}