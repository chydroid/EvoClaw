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
}

const DEFAULT_POLICY_CONFIG: Required<IterationPolicyConfig> = {
  capStartIteration: 2,
  capMaxMessageLength: 10_000,
  truncateStartIteration: 5,
  truncateKeepRecent: 8,
  truncateTargetTokenBudget: 120_000,
  stripSkillsStartIteration: 2,
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
  /** 时间戳 */
  timestamp?: number;
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

  constructor(config: IterationPolicyConfig = {}) {
    this.config = { ...DEFAULT_POLICY_CONFIG, ...config };
  }

  /**
   * 根据迭代轮次应用裁剪策略。
   *
   * @param messages 当前消息列表
   * @param iteration 当前迭代轮次（从 1 开始）
   * @returns 处理后的消息列表与策略报告
   */
  applyPolicy(messages: PolicyMessage[], iteration: number): PolicyResult {
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
        appliedStrategies.push(`strip-skills(removed=${before - working.length})`);
      }
    }

    // 策略 2：cap 单条消息长度（第 2 轮起）
    if (iteration >= this.config.capStartIteration) {
      let capCount = 0;
      working = working.map((msg) => {
        if (msg.content.length > this.config.capMaxMessageLength) {
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
        appliedStrategies.push(`cap-messages(count=${capCount}, maxLen=${this.config.capMaxMessageLength})`);
      }
    }

    // 策略 3：truncate 历史（第 5 轮起）
    if (iteration >= this.config.truncateStartIteration && working.length > this.config.truncateKeepRecent) {
      // 转换为 PrioritizedMessage 以复用 ConversationFormatter
      const prioritized: PrioritizedMessage[] = working.map((m, idx) => ({
        role: m.role,
        content: m.content,
        priority: this.classifyPriority(m, idx, working.length, iteration),
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        timestamp: m.timestamp ?? Date.now(),
      }));

      const result = ConversationFormatter.truncate(prioritized, {
        targetTokenBudget: this.config.truncateTargetTokenBudget,
        keepRecentIterations: 3,
        maxMessageLength: this.config.capMaxMessageLength,
        keepAllErrors: true,
      });

      if (result.truncated) {
        working = result.messages.map((m) => ({
          role: m.role,
          content: m.content,
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          timestamp: m.timestamp,
        }));
        truncated = true;
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
