/**
 * Token Budget Optimizer — 动态 token 预算分配。
 *
 * 借鉴 Claude Code / Cursor / Continue 的 context window 管理：
 * - 按优先级为 system prompt / memory / history / tool results / user message 分配 token 预算
 * - 动态调整 history 长度，防止 context overflow
 * - 优先保留最近的消息和重要工具结果
 * - 提供预算使用报告，便于监控和调优
 *
 * 解决问题：
 * - LLM context window 溢出导致 API 错误
 * - 历史消息过长挤占新消息空间
 * - 工具结果过大占满 context
 */

/** Token 预算分配比例（按优先级从高到低） */
export interface BudgetAllocation {
  /** 系统提示词（最高优先级，必须保留） */
  systemPrompt: number;
  /** 召回的相关记忆 */
  memories: number;
  /** 对话历史（动态可压缩） */
  history: number;
  /** 工具结果（动态可截断） */
  toolResults: number;
  /** 用户当前消息（必须保留） */
  userMessage: number;
  /** 预留给 LLM 生成的输出 */
  output: number;
}

/** Token Budget 配置 */
export interface TokenBudgetOptions {
  /** 模型 context window 大小（token）。默认 200000（Claude 3.5）。 */
  contextWindow?: number;
  /** 预留给输出的 token 数。默认 4096。 */
  reservedOutput?: number;
  /** 各部分预算占比（必须加起来 = 1.0）。 */
  allocation?: Partial<BudgetAllocation>;
}

/** 内部使用的已解析配置（allocation 已归一化为完整对象） */
interface ResolvedTokenBudgetOptions {
  contextWindow: number;
  reservedOutput: number;
  allocation: BudgetAllocation;
}

const DEFAULT_ALLOCATION: BudgetAllocation = {
  systemPrompt: 0.05,   // 5%
  memories: 0.10,       // 10%
  history: 0.40,        // 40%
  toolResults: 0.20,    // 20%
  userMessage: 0.05,    // 5%
  output: 0.20,         // 20%
};

/** 简化 token 估算：4 字符 = 1 token，CJK 1.5 token/char */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u3400-\u9FFF]/g) || []).length;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.5 + otherCount * 0.25);
}

/** 估算消息列表的 token 数 */
export function estimateMessagesTokens(messages: Array<{ role: string; content: string | null }>): number {
  let total = 0;
  for (const msg of messages) {
    total += 4; // 结构开销
    if (msg.content) {
      total += estimateTokens(msg.content);
    }
  }
  return total;
}

/** 预算使用报告 */
export interface BudgetReport {
  /** 各部分分配的预算 */
  allocated: BudgetAllocation;
  /** 各部分实际使用的 token 数 */
  used: BudgetAllocation;
  /** 总 context window */
  total: number;
  /** 总已用 */
  totalUsed: number;
  /** 是否超预算 */
  overflow: boolean;
  /** 压缩建议 */
  recommendation: string;
}

/**
 * Token Budget 优化器。
 *
 * 使用方式：
 * ```ts
 * const optimizer = new TokenBudgetOptimizer({ contextWindow: 200000 });
 * const budget = optimizer.allocate({
 *   systemPrompt: "You are...",
 *   memories: recalledMemories,
 *   history: conversationHistory,
 *   toolResults: recentToolResults,
 *   userMessage: userText,
 * });
 * // 根据 budget.historyLimit 截断历史
 * const truncatedHistory = history.slice(-budget.historyLimit);
 * ```
 */
export class TokenBudgetOptimizer {
  private opts: ResolvedTokenBudgetOptions;

  constructor(options: TokenBudgetOptions = {}) {
    const allocation = { ...DEFAULT_ALLOCATION, ...options.allocation };
    this.normalizeAllocation(allocation);
    this.opts = {
      contextWindow: options.contextWindow ?? 200_000,
      reservedOutput: options.reservedOutput ?? 4096,
      allocation,
    };
  }

  /** 归一化分配比例，确保总和 = 1.0 */
  private normalizeAllocation(a: BudgetAllocation): void {
    const sum = a.systemPrompt + a.memories + a.history + a.toolResults + a.userMessage + a.output;
    if (sum <= 0) {
      Object.assign(a, DEFAULT_ALLOCATION);
      return;
    }
    if (Math.abs(sum - 1.0) > 0.001) {
      a.systemPrompt /= sum;
      a.memories /= sum;
      a.history /= sum;
      a.toolResults /= sum;
      a.userMessage /= sum;
      a.output /= sum;
    }
  }

  /** 计算各部分的 token 预算 */
  allocateBudget(): BudgetAllocation {
    const available = this.opts.contextWindow - this.opts.reservedOutput;
    const a = this.opts.allocation;
    return {
      systemPrompt: Math.floor(available * a.systemPrompt),
      memories: Math.floor(available * a.memories),
      history: Math.floor(available * a.history),
      toolResults: Math.floor(available * a.toolResults),
      userMessage: Math.floor(available * a.userMessage),
      output: this.opts.reservedOutput,
    };
  }

  /**
   * 根据实际内容计算预算使用情况，并给出截断建议。
   */
  allocate(input: {
    systemPrompt: string;
    memories: Array<{ content: string }>;
    history: Array<{ role: string; content: string | null }>;
    toolResults: Array<{ content: string }>;
    userMessage: string;
  }): {
    budget: BudgetAllocation;
    /** 历史消息保留条数（从末尾算起） */
    historyLimit: number;
    /** 工具结果保留条数（从末尾算起） */
    toolResultLimit: number;
    report: BudgetReport;
  } {
    const budget = this.allocateBudget();

    const systemTokens = estimateTokens(input.systemPrompt);
    const memoriesTokens = input.memories.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const userTokens = estimateTokens(input.userMessage);

    // 系统 + 用户消息是硬性需求，从 history 和 toolResults 预算中扣除溢出
    let historyBudget = budget.history;
    let toolBudget = budget.toolResults;

    // 系统 prompt 超预算：从 history 借
    if (systemTokens > budget.systemPrompt) {
      const overflow = systemTokens - budget.systemPrompt;
      historyBudget = Math.max(0, historyBudget - overflow);
    }
    // 记忆超预算：从 toolResults 借
    if (memoriesTokens > budget.memories) {
      const overflow = memoriesTokens - budget.memories;
      toolBudget = Math.max(0, toolBudget - overflow);
    }
    // 用户消息超预算：从 history 借
    if (userTokens > budget.userMessage) {
      const overflow = userTokens - budget.userMessage;
      historyBudget = Math.max(0, historyBudget - overflow);
    }

    // 计算 history 保留条数
    let historyLimit = input.history.length;
    let historyUsed = 0;
    for (let i = input.history.length - 1; i >= 0; i--) {
      const msgTokens = estimateTokens(input.history[i].content || "") + 4;
      if (historyUsed + msgTokens > historyBudget) {
        historyLimit = input.history.length - 1 - i;
        break;
      }
      historyUsed += msgTokens;
    }

    // 计算 toolResults 保留条数
    let toolResultLimit = input.toolResults.length;
    let toolUsed = 0;
    for (let i = input.toolResults.length - 1; i >= 0; i--) {
      const tTokens = estimateTokens(input.toolResults[i].content) + 4;
      if (toolUsed + tTokens > toolBudget) {
        toolResultLimit = input.toolResults.length - 1 - i;
        break;
      }
      toolUsed += tTokens;
    }

    const totalUsed = systemTokens + memoriesTokens + historyUsed + toolUsed + userTokens;
    const overflow = totalUsed > this.opts.contextWindow - this.opts.reservedOutput;

    let recommendation = "OK";
    if (overflow) {
      recommendation = "Context overflow: reduce history or tool results";
    } else if (historyLimit < input.history.length / 2) {
      recommendation = "History compressed >50%: consider compaction";
    } else if (historyBudget < budget.history * 0.5) {
      recommendation = "History budget reduced >50%: system prompt too large";
    }

    const report: BudgetReport = {
      allocated: budget,
      used: {
        systemPrompt: systemTokens,
        memories: memoriesTokens,
        history: historyUsed,
        toolResults: toolUsed,
        userMessage: userTokens,
        output: 0,
      },
      total: this.opts.contextWindow,
      totalUsed,
      overflow,
      recommendation,
    };

    return { budget, historyLimit, toolResultLimit, report };
  }
}
