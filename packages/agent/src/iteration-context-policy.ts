/**
 * IterationContextPolicy — 基于迭代轮次的渐进式上下文裁剪
 *
 * 借鉴 OpenSpace agents/grounding_agent.py 的 token 节流策略：
 *   - 第 2 轮起 cap_message_content()（限制单条消息长度）
 *   - 第 5 轮起 truncate_messages(keep_recent=8, max_tokens_estimate=120000)
 *   - 技能上下文首轮后剥离
 *
 * EvoClaw 落地点：
 *   - task-orchestrator.ts 的每轮迭代调用 applyPolicy()
 *   - 复用 ConversationFormatter 的截断能力
 */

import { ConversationFormatter, MessagePriority, type PrioritizedMessage } from "./conversation-formatter";

// ── 配置 ──────────────────────────────────────────────────────

export interface IterationPolicyConfig {
  /** 第 N 轮起开始 cap 单条消息（默认 2） */
  capStartIteration?: number;
  /** 单条消息最大长度（字符，默认 10000） */
  capMaxMessageLength?: number;
  /** 第 N 轮起开始 truncate 历史（默认 5） */
  truncateStartIteration?: number;
  /** truncate 时保留最近 N 条消息（默认 8） */
  truncateKeepRecent?: number;
  /** truncate 时目标 token 预算（默认 120000） */
  truncateTargetTokenBudget?: number;
  /** 第 N 轮起剥离技能上下文（默认 2） */
  stripSkillsStartIteration?: number;
  /** 保护 system 消息不被 cap/truncate（默认 true；系统提示是缓存前缀的根基） */
  preserveSystemMessages?: boolean;
}

const DEFAULT_POLICY_CONFIG: Required<IterationPolicyConfig> = {
  capStartIteration: 2,
  capMaxMessageLength: 10_000,
  truncateStartIteration: 5,
  truncateKeepRecent: 8,
  truncateTargetTokenBudget: 120_000,
  stripSkillsStartIteration: 2,
  preserveSystemMessages: true,
};

// ── 消息类型（简化版，对齐 LLM 消息格式） ────────────────────

export interface PolicyMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** 工具调用 ID（tool 消息） */
  toolCallId?: string;
  /** 工具名 */
  toolName?: string;
  /** 是否是技能上下文消息 */
  isSkillContext?: boolean;
  /** assistant 消息发起的工具调用 ID（用于截断后修复 tool 配对） */
  toolCalls?: Array<{ id: string }>;
  /** 时间戳 */
  timestamp?: number;
}

export interface IterationPolicyStats {
  applications: number;
  cappedRuns: number;
  truncatedRuns: number;
  skillsStrippedRuns: number;
  messagesCapped: number;
  messagesTruncated: number;
  estTokensSaved: number;
}

export interface PolicyResult {
  /** 处理后的消息列表 */
  messages: PolicyMessage[];
  /** 是否应用了 cap */
  capped: boolean;
  /** 是否应用了 truncate */
  truncated: boolean;
  /** 是否剥离了技能上下文 */
  skillsStripped: boolean;
  /** 原始消息数 */
  originalCount: number;
  /** 处理后消息数 */
  resultCount: number;
  /** 原始 token 估算 */
  originalTokenEstimate: number;
  /** 处理后 token 估算 */
  resultTokenEstimate: number;
  /** 应用的策略描述 */
  appliedStrategies: string[];
}

// ── 主类 ──────────────────────────────────────────────────────

/**
 * IterationContextPolicy
 *
 * 根据当前迭代轮次应用不同的上下文裁剪策略：
 *   - iteration < 2: 不裁剪
 *   - 2 ≤ iteration < 5: cap 单条消息长度 + 剥离技能上下文
 *   - iteration ≥ 5: 上述 + truncate 历史到最近 N 条
 *
 * 这样可以在早期保留完整上下文，后期逐步压缩，平衡信息完整性与 token 成本。
 */
export class IterationContextPolicy {
  private config: Required<IterationPolicyConfig>;
  /** 运行期计数：证明策略真的在每轮 LLM 调用前执行 */
  private stats: IterationPolicyStats = {
    applications: 0,
    cappedRuns: 0,
    truncatedRuns: 0,
    skillsStrippedRuns: 0,
    messagesCapped: 0,
    messagesTruncated: 0,
    estTokensSaved: 0,
  };

  constructor(config: IterationPolicyConfig = {}) {
    this.config = { ...DEFAULT_POLICY_CONFIG, ...config };
  }

  getStats(): IterationPolicyStats & { config: Required<IterationPolicyConfig> } {
    return { ...this.stats, config: this.getConfig() };
  }

  /**
   * 根据迭代轮次应用裁剪策略。
   *
   * @param messages 当前消息列表
   * @param iteration 当前迭代轮次（从 1 开始）
   * @returns 处理后的消息列表与策略报告
   */
  applyPolicy(messages: PolicyMessage[], iteration: number): PolicyResult {
    this.stats.applications++;
    const appliedStrategies: string[] = [];
    let working = [...messages];
    let capped = false;
    let truncated = false;
    let skillsStripped = false;

    const originalCount = messages.length;
    const originalTokenEstimate = this.estimateTokens(working);

    // 策略 1：剥离技能上下文（第 2 轮起）
    if (iteration >= this.config.stripSkillsStartIteration) {
      const before = working.length;
      working = working.filter((m) => !m.isSkillContext);
      if (working.length < before) {
        skillsStripped = true;
        this.stats.skillsStrippedRuns++;
        appliedStrategies.push(`strip-skills(removed=${before - working.length})`);
      }
    }

    // 策略 2：cap 单条消息长度（第 2 轮起）
    if (iteration >= this.config.capStartIteration) {
      let capCount = 0;
      working = working.map((msg) => {
        // system 消息（冻结系统提示/技能段/动态尾）是缓存前缀的根基，
        // 绝不能被按单条 10K 上限截断——否则每轮系统提示残缺且缓存失效。
        if (this.config.preserveSystemMessages && msg.role === "system") return msg;
        const contentLen = msg.content?.length ?? 0;
        if (contentLen > this.config.capMaxMessageLength) {
          capCount++;
          return {
            ...msg,
            content: msg.content.slice(0, this.config.capMaxMessageLength) + "\n... [capped by IterationContextPolicy]",
          };
        }
        return msg;
      });
      if (capCount > 0) {
        capped = true;
        this.stats.cappedRuns++;
        this.stats.messagesCapped += capCount;
        appliedStrategies.push(`cap-messages(count=${capCount}, maxLen=${this.config.capMaxMessageLength})`);
      }
    }

    // 策略 3：truncate 历史（第 5 轮起）
    if (iteration >= this.config.truncateStartIteration && working.length > this.config.truncateKeepRecent) {
      // system 消息单独保留（不动缓存前缀根基），只对非 system 消息做优先级截断。
      const systemMessages = this.config.preserveSystemMessages
        ? working.filter((m) => m.role === "system")
        : [];
      const trimmable = this.config.preserveSystemMessages
        ? working.filter((m) => m.role !== "system")
        : working;

      // 转换为 PrioritizedMessage 以复用 ConversationFormatter。
      // timestamp 用下标而非 Date.now()：同等优先级下保持原始顺序（稳定且可预测）。
      const prioritized: PrioritizedMessage[] = trimmable.map((m, idx) => ({
        role: m.role,
        content: m.content,
        priority: this.classifyPriority(m, idx, trimmable.length, iteration),
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        timestamp: idx,
      }));

      const result = ConversationFormatter.truncate(prioritized, {
        targetTokenBudget: this.config.truncateTargetTokenBudget,
        keepRecentIterations: 3,
        maxMessageLength: this.config.capMaxMessageLength,
        keepAllErrors: true,
      });

      if (result.truncated) {
        let trimmed = result.messages.map((m) => {
          const orig = trimmable[m.timestamp];
          return {
            role: m.role,
            content: m.content,
            toolCallId: m.toolCallId,
            toolName: m.toolName,
            toolCalls: orig?.toolCalls,
            timestamp: m.timestamp,
          } as PolicyMessage;
        });
        // 截断会按消息独立丢弃 → 可能留下孤儿 tool 消息或缺失 tool 响应的
        // assistant.tool_calls（两者都会让 provider 直接 400）。这里做配对修复：
        // 没有对应 tool 响应的 assistant 消息整条移除，没有对应 assistant
        // tool_call 的 tool 消息也整条移除。
        trimmed = this.repairToolPairing(trimmed);
        working = [...systemMessages, ...trimmed];
        truncated = true;
        this.stats.truncatedRuns++;
        this.stats.messagesTruncated += result.messages.length;
        this.stats.estTokensSaved += Math.max(0, result.originalTokenEstimate - result.truncatedTokenEstimate);
        appliedStrategies.push(`truncate(kept=${working.length}/${prioritized.length}, tokens=${result.truncatedTokenEstimate}/${result.originalTokenEstimate})`);
      }
    }

    const resultTokenEstimate = this.estimateTokens(working);

    return {
      messages: working,
      capped,
      truncated,
      skillsStripped,
      originalCount,
      resultCount: working.length,
      originalTokenEstimate,
      resultTokenEstimate,
      appliedStrategies,
    };
  }

  /** 更新配置 */
  updateConfig(config: Partial<IterationPolicyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** 获取当前配置 */
  getConfig(): Required<IterationPolicyConfig> {
    return { ...this.config };
  }

  // ── 内部 ────────────────────────────────────────────────

  /**
   * 修复截断后的 assistant.tool_calls ↔ tool 消息配对。
   *
   * provider（OpenAI/Anthropic）要求每个 tool_call 都有对应 tool 响应，
   * 且每个 tool 消息必须对应前序 assistant 发起的 tool_call。截断按消息
   * 独立丢弃会破坏该约束，这里以整条 assistant 消息为单位做一致性修复。
   */
  private repairToolPairing(messages: PolicyMessage[]): PolicyMessage[] {
    const responseIds = new Set(
      messages.filter((m) => m.role === "tool" && m.toolCallId).map((m) => m.toolCallId as string),
    );

    // 第一遍：只保留「全部 tool_call 都有响应」的 assistant 消息，
    // 并记录其 tool_call ID 集合。
    const completeCallIds = new Set<string>();
    const keptAssistants = new Set<PolicyMessage>();
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.toolCalls || msg.toolCalls.length === 0) continue;
      if (msg.toolCalls.every((tc) => responseIds.has(tc.id))) {
        keptAssistants.add(msg);
        for (const tc of msg.toolCalls) completeCallIds.add(tc.id);
      }
    }

    // 第二遍：tool 响应必须属于某个被保留的 assistant tool_call。
    const kept: PolicyMessage[] = [];
    for (const msg of messages) {
      if (msg.role === "tool") {
        if (!msg.toolCallId || !completeCallIds.has(msg.toolCallId)) continue;
        kept.push(msg);
        continue;
      }
      if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        if (!keptAssistants.has(msg)) continue;
      }
      kept.push(msg);
    }
    return kept;
  }

  private classifyPriority(
    msg: PolicyMessage,
    index: number,
    total: number,
    iteration: number,
  ): MessagePriority {
    // 第一条 user 消息：最高优先级
    if (msg.role === "user" && index === 0) {
      return MessagePriority.USER_INSTRUCTION;
    }

    // 最后一条消息：最终迭代
    if (index === total - 1) {
      return MessagePriority.FINAL_ITERATION;
    }

    // 工具错误
    const content = msg.content?.toLowerCase() ?? "";
    if (msg.role === "tool" || msg.toolName) {
      if (content.includes("error") || content.includes("failed") || content.includes("exception")) {
        return MessagePriority.TOOL_ERROR;
      }
      return MessagePriority.TOOL_RESULT;
    }

    if (msg.role === "system") {
      return MessagePriority.SYSTEM_MESSAGE;
    }

    return MessagePriority.INTERMEDIATE_ITERATION;
  }

  private estimateTokens(messages: PolicyMessage[]): number {
    return messages.reduce((sum, m) => sum + Math.ceil((m.content?.length ?? 0) / 4) + 4, 0);
  }
}

// ── 单例（llm-caller 每轮调用，stats 端点读取同一实例） ──────

let singleton: IterationContextPolicy | null = null;

export function getIterationContextPolicy(config?: Partial<IterationPolicyConfig>): IterationContextPolicy {
  if (!singleton) {
    singleton = new IterationContextPolicy(config);
  } else if (config) {
    singleton.updateConfig(config);
  }
  return singleton;
}

export function resetIterationContextPolicy(): void {
  singleton = null;
}
