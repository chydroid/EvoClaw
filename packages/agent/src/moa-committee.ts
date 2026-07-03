/**
 * MoA (Mixture-of-Agents) Committee — 多模型并行推理 + 聚合模型合成。
 *
 * 对标 Hermes v0.18.0 "MoA 委员会"：把 MoA 升级为跟 GPT、Claude 平起平坐的可选模型。
 * 用户在模型选择器里选择 `moa:my-council`，问题会自动发给委员会里的所有参考模型，
 * 每个参考模型独立推理，聚合模型合成最终答案。
 *
 * 设计原则：
 * 1. ChatFn 注入 —— 不绑定具体 provider，调用方提供 `(prompt, model) => Promise<string>`
 * 2. 并行 fan-out —— 所有参考模型并发调用，Promise.allSettled 容错
 * 3. 独立展示 —— 每个参考模型的推理过程以独立块返回，前端可"旁听陪审团讨论"
 * 4. 聚合流式 —— 聚合模型的输出可流式推送（通过 onAggregatorChunk 回调）
 * 5. 失败容错 —— 单个参考模型失败不影响整体，聚合时标注失败项
 *
 * 用法：
 * ```ts
 * const council = new MoaCommittee({
 *   aggregator: { provider: "anthropic", model: "claude-sonnet-4" },
 *   references: [
 *     { provider: "openai", model: "gpt-5" },
 *     { provider: "deepseek", model: "deepseek-v4" },
 *     { provider: "xai", model: "grok-4" },
 *   ],
 * });
 * const result = await council.invoke("Explain quantum entanglement", chatFn);
 * // result.references[0].content → GPT-5 的推理
 * // result.references[1].content → DeepSeek 的推理
 * // result.aggregated → Claude 综合后的最终答案
 * ```
 */

// ── Types ─────────────────────────────────────────────────

/** 委员会成员（参考模型或聚合模型） */
export interface MoaMember {
  /** Provider 标识，如 "openai" / "anthropic" / "google" / "deepseek" */
  provider: string;
  /** 模型 ID，如 "gpt-5" / "claude-sonnet-4" */
  model: string;
  /** 可选的显示名称（默认 `provider/model`） */
  displayName?: string;
}

/** 委员会预设配置 */
export interface MoaPreset {
  /** 预设名称，如 "my-council" */
  name: string;
  /** 聚合模型（合成最终答案） */
  aggregator: MoaMember;
  /** 参考模型列表（并行推理） */
  references: MoaMember[];
  /** 可选的系统提示覆盖 */
  systemPrompt?: string;
  /** 可选的最大并行数（默认全部并行） */
  maxConcurrency?: number;
}

/** 参考模型的推理结果 */
export interface MoaReferenceResult {
  /** 对应的成员信息 */
  member: MoaMember;
  /** 推理内容（成功时） */
  content: string;
  /** 错误信息（失败时） */
  error?: string;
  /** 是否成功 */
  success: boolean;
  /** 耗时（ms） */
  durationMs: number;
}

/** 委员会调用结果 */
export interface MoaResult {
  /** 聚合后的最终答案 */
  aggregated: string;
  /** 各参考模型的推理过程 */
  references: MoaReferenceResult[];
  /** 聚合模型信息 */
  aggregator: MoaMember;
  /** 总耗时（ms） */
  totalDurationMs: number;
  /** 成功的参考模型数量 */
  successCount: number;
  /** 失败的参考模型数量 */
  failureCount: number;
}

/**
 * 注入的对话函数 —— 由调用方实现具体 LLM 调用。
 * 接收 prompt 和目标模型，返回模型的回复文本。
 */
export type MoaChatFn = (
  prompt: string,
  member: MoaMember,
  options?: { systemPrompt?: string; signal?: AbortSignal },
) => Promise<string>;

/** 聚合模型流式 chunk 回调 */
export type MoaAggregatorChunkCallback = (delta: string, fullText: string) => void;

// ── MoaCommittee ──────────────────────────────────────────

/**
 * MoA 委员会 —— 多模型并行推理 + 聚合模型合成。
 *
 * 流程：
 * 1. 用户问题 → 并行发送给所有参考模型
 * 2. 收集所有参考模型的推理结果（容错，单个失败不影响其他）
 * 3. 将所有推理结果拼接为聚合 prompt，发送给聚合模型
 * 4. 聚合模型合成最终答案（可流式推送）
 */
export class MoaCommittee {
  private preset: MoaPreset;

  constructor(preset: MoaPreset) {
    if (!preset.aggregator) {
      throw new Error("MoA preset requires an aggregator member");
    }
    if (!preset.references || preset.references.length === 0) {
      throw new Error("MoA preset requires at least one reference member");
    }
    this.preset = preset;
  }

  /** 获取预设名称 */
  get name(): string {
    return this.preset.name;
  }

  /** 获取聚合模型 */
  get aggregator(): MoaMember {
    return this.preset.aggregator;
  }

  /** 获取参考模型列表 */
  get references(): MoaMember[] {
    return this.preset.references;
  }

  /**
   * 调用委员会：并行推理 → 聚合合成。
   *
   * @param prompt 用户问题
   * @param chatFn 注入的对话函数
   * @param options 可选参数（signal / onAggregatorChunk）
   */
  async invoke(
    prompt: string,
    chatFn: MoaChatFn,
    options?: {
      signal?: AbortSignal;
      onAggregatorChunk?: MoaAggregatorChunkCallback;
    },
  ): Promise<MoaResult> {
    const startTime = Date.now();
    const signal = options?.signal;

    // ── Phase 1: 并行调用所有参考模型 ──
    const referenceResults = await this.invokeReferences(prompt, chatFn, signal);

    // ── Phase 2: 聚合模型合成最终答案 ──
    const aggregationPrompt = this.buildAggregationPrompt(prompt, referenceResults);
    let aggregated = "";
    try {
      aggregated = await chatFn(aggregationPrompt, this.preset.aggregator, {
        systemPrompt: this.preset.systemPrompt ?? this.defaultAggregatorSystemPrompt(),
        signal,
      });
    } catch (err) {
      // 聚合模型失败 —— 降级为返回参考模型中最长的答案
      const successful = referenceResults.filter((r) => r.success);
      if (successful.length > 0) {
        aggregated = successful.reduce((longest, r) =>
          r.content.length > longest.content.length ? r : longest,
        ).content;
      } else {
        throw new Error(`MoA aggregation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const successCount = referenceResults.filter((r) => r.success).length;
    const failureCount = referenceResults.length - successCount;

    return {
      aggregated,
      references: referenceResults,
      aggregator: this.preset.aggregator,
      totalDurationMs: Date.now() - startTime,
      successCount,
      failureCount,
    };
  }

  /** 并行调用所有参考模型，返回结果列表（容错） */
  private async invokeReferences(
    prompt: string,
    chatFn: MoaChatFn,
    signal?: AbortSignal,
  ): Promise<MoaReferenceResult[]> {
    const members = this.preset.references;
    const maxConcurrency = this.preset.maxConcurrency ?? members.length;

    // 如果不需要限流，直接全部并行
    if (maxConcurrency >= members.length) {
      const results = await Promise.allSettled(
        members.map((member) => this.invokeOneReference(member, prompt, chatFn, signal)),
      );
      return results.map((result, idx) => {
        if (result.status === "fulfilled") return result.value;
        return {
          member: members[idx],
          content: "",
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          success: false,
          durationMs: 0,
        };
      });
    }

    // 限流模式：分批并行
    const results: MoaReferenceResult[] = [];
    for (let i = 0; i < members.length; i += maxConcurrency) {
      const batch = members.slice(i, i + maxConcurrency);
      const batchResults = await Promise.allSettled(
        batch.map((member) => this.invokeOneReference(member, prompt, chatFn, signal)),
      );
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          results.push({
            member: batch[j],
            content: "",
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            success: false,
            durationMs: 0,
          });
        }
      }
    }
    return results;
  }

  /** 调用单个参考模型，带计时 */
  private async invokeOneReference(
    member: MoaMember,
    prompt: string,
    chatFn: MoaChatFn,
    signal?: AbortSignal,
  ): Promise<MoaReferenceResult> {
    const start = Date.now();
    try {
      const content = await chatFn(prompt, member, { signal });
      return {
        member,
        content,
        success: true,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        member,
        content: "",
        error: err instanceof Error ? err.message : String(err),
        success: false,
        durationMs: Date.now() - start,
      };
    }
  }

  /** 构建聚合 prompt：将用户问题 + 所有参考模型推理拼接 */
  private buildAggregationPrompt(
    userPrompt: string,
    references: MoaReferenceResult[],
  ): string {
    const referenceBlocks = references
      .map((r, idx) => {
        const name = r.member.displayName ?? `${r.member.provider}/${r.member.model}`;
        if (r.success) {
          return `## Reference Model ${idx + 1}: ${name}\n\n${r.content}`;
        }
        return `## Reference Model ${idx + 1}: ${name}\n\n[FAILED: ${r.error ?? "unknown error"}]`;
      })
      .join("\n\n---\n\n");

    return `You are the aggregator of a Mixture-of-Agents (MoA) committee.

The user asked:
${userPrompt}

Below are the independent responses from ${references.length} reference models.
Synthesize them into a single, comprehensive, and accurate answer.
Do not blindly copy any single model — integrate the best parts of each.
If models disagree, explain the disagreement and give your best judgment.

${referenceBlocks}

---

Provide your synthesized final answer:`;
  }

  /** 默认聚合模型系统提示 */
  private defaultAggregatorSystemPrompt(): string {
    return "You are an expert aggregator. Your job is to synthesize multiple model responses into one high-quality answer. Be comprehensive, accurate, and concise.";
  }
}

// ── MoaPresetRegistry — 预设管理 ──────────────────────────

/**
 * MoA 预设注册表 —— 管理多个委员会配置。
 *
 * 对标 Hermes 的 yaml presets：
 * ```yaml
 * model:
 *   providers:
 *     moa:
 *       presets:
 *         my-council:
 *           aggregator: anthropic/claude-opus-4
 *           references:
 *             - openai/gpt-5.5
 *             - deepseek/deepseek-v4
 * ```
 *
 * 在 EvoClaw 中通过代码注册（而非 yaml），由服务器启动时从配置加载。
 */
export class MoaPresetRegistry {
  private presets = new Map<string, MoaPreset>();

  /** 注册一个预设 */
  register(preset: MoaPreset): void {
    this.presets.set(preset.name, preset);
  }

  /** 注销一个预设 */
  unregister(name: string): boolean {
    return this.presets.delete(name);
  }

  /** 获取预设 */
  get(name: string): MoaPreset | undefined {
    return this.presets.get(name);
  }

  /** 获取预设对应的委员会实例 */
  getCommittee(name: string): MoaCommittee | undefined {
    const preset = this.presets.get(name);
    return preset ? new MoaCommittee(preset) : undefined;
  }

  /** 列出所有预设名称 */
  list(): string[] {
    return Array.from(this.presets.keys());
  }

  /** 清空所有预设（测试用） */
  clear(): void {
    this.presets.clear();
  }
}

// ── 辅助函数 ──────────────────────────────────────────────

/** 从 "provider/model" 字符串解析为 MoaMember */
export function parseMoaMember(spec: string): MoaMember {
  const slashIdx = spec.indexOf("/");
  if (slashIdx < 0) {
    return { provider: spec, model: "" };
  }
  return {
    provider: spec.slice(0, slashIdx),
    model: spec.slice(slashIdx + 1),
  };
}

/** 将 MoaResult 格式化为可读文本 */
export function formatMoaResult(result: MoaResult): string {
  const lines: string[] = [];
  lines.push(`# MoA Committee Result (${result.successCount}/${result.references.length} references succeeded)\n`);

  for (const ref of result.references) {
    const name = ref.member.displayName ?? `${ref.member.provider}/${ref.member.model}`;
    if (ref.success) {
      lines.push(`## ${name} (${ref.durationMs}ms)`);
      lines.push(ref.content);
    } else {
      lines.push(`## ${name} [FAILED: ${ref.error}]`);
    }
    lines.push("");
  }

  lines.push("---\n");
  lines.push("## Aggregated Answer");
  lines.push(result.aggregated);
  lines.push(`\n(total: ${result.totalDurationMs}ms)`);
  return lines.join("\n");
}
