/**
 * ConversationFormatter — 对话优先级截断
 *
 * 借鉴 OpenSpace skill_engine/conversation_formatter.py：
 *   0-5 级优先级（用户指令=0，最终迭代=1，工具错误=2，工具结果=3，中间迭代=4，系统消息=5）
 *   低数字 = 高优先级，截断时优先保留低数字。
 *
 * 用途：
 *   - 把 80k+ 字符的对话塞进 LLM 上下文
 *   - 保留关键信息（用户指令、错误、最终结果），丢弃中间噪声
 */

// ── 优先级定义 ────────────────────────────────────────────────

export enum MessagePriority {
  /** 用户原始指令 — 永不裁剪 */
  USER_INSTRUCTION = 0,
  /** 最终迭代结果 — 高优先级保留 */
  FINAL_ITERATION = 1,
  /** 工具错误 — 用于反思与修复 */
  TOOL_ERROR = 2,
  /** 工具结果 — 中等优先级 */
  TOOL_RESULT = 3,
  /** 中间迭代 — 低优先级，优先裁剪 */
  INTERMEDIATE_ITERATION = 4,
  /** 系统消息 — 最低优先级 */
  SYSTEM_MESSAGE = 5,
}

export interface PrioritizedMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  priority: MessagePriority;
  /** 工具调用 ID（如果是 tool 消息） */
  toolCallId?: string;
  /** 工具名 */
  toolName?: string;
  /** 迭代轮次（如果是迭代消息） */
  iteration?: number;
  /** 时间戳 */
  timestamp: number;
}

export interface TruncationResult {
  /** 截断后的消息列表 */
  messages: PrioritizedMessage[];
  /** 是否发生了截断 */
  truncated: boolean;
  /** 原始 token 估算 */
  originalTokenEstimate: number;
  /** 截断后 token 估算 */
  truncatedTokenEstimate: number;
  /** 被丢弃的消息数（按优先级分桶） */
  droppedByPriority: Record<number, number>;
}

export interface TruncationOptions {
  /** 目标 token 预算 */
  targetTokenBudget?: number;
  /** 至少保留最近 N 轮迭代 */
  keepRecentIterations?: number;
  /** 单条消息最大长度（字符数），超出后截断 */
  maxMessageLength?: number;
  /** 是否保留所有错误消息 */
  keepAllErrors?: boolean;
}

const DEFAULT_TRUNCATION_OPTIONS: Required<TruncationOptions> = {
  targetTokenBudget: 100_000,
  keepRecentIterations: 3,
  maxMessageLength: 10_000,
  keepAllErrors: true,
};

// ── token 估算（粗略 4 字符 = 1 token） ───────────────────────

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(msg: PrioritizedMessage): number {
  return estimateTokens(msg.content) + 4; // +4 for role overhead
}

// ── 主类 ──────────────────────────────────────────────────────

export class ConversationFormatter {
  /**
   * 按优先级截断对话。
   *
   * 算法：
   *   1. 计算总 token 估算
   *   2. 如果在预算内，直接返回
   *   3. 否则按优先级从高到低保留：
   *      a. P0 用户指令永远保留
   *      b. P1 最终迭代保留
   *      c. P2 工具错误保留（如 keepAllErrors=true）
   *      d. P3 工具结果按时间倒序保留
   *      e. P4 中间迭代按"最近 N 轮保留 + 其余按时间倒序"保留
   *      f. P5 系统消息优先丢弃
   *   4. 单条超长消息先截断到 maxMessageLength
   */
  static truncate(
    messages: PrioritizedMessage[],
    options: TruncationOptions = {},
  ): TruncationResult {
    const opts = { ...DEFAULT_TRUNCATION_OPTIONS, ...options };
    const droppedByPriority: Record<number, number> = {};

    // 步骤 1：单条截断
    const cappedMessages = messages.map((msg) => {
      const contentLen = msg.content?.length ?? 0;
      if (contentLen > opts.maxMessageLength) {
        return {
          ...msg,
          content: msg.content.slice(0, opts.maxMessageLength) + "\n... [truncated]",
        };
      }
      return msg;
    });

    // 步骤 2：计算总 token
    const originalTokens = cappedMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    if (originalTokens <= opts.targetTokenBudget) {
      return {
        messages: cappedMessages,
        truncated: false,
        originalTokenEstimate: originalTokens,
        truncatedTokenEstimate: originalTokens,
        droppedByPriority,
      };
    }

    // 步骤 3：按优先级分桶
    const buckets = new Map<MessagePriority, PrioritizedMessage[]>();
    for (const msg of cappedMessages) {
      const bucket = buckets.get(msg.priority) ?? [];
      bucket.push(msg);
      buckets.set(msg.priority, bucket);
    }

    // 步骤 4：按优先级从高到低挑选
    const selected: PrioritizedMessage[] = [];
    let currentTokens = 0;
    // 数字枚举的 Object.values 会同时返回数值和键名（字符串），需过滤数字
    const priorities = (Object.values(MessagePriority) as unknown[])
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b) as MessagePriority[];

    for (const priority of priorities) {
      const bucket = buckets.get(priority) ?? [];

      // P0 用户指令：全部保留
      if (priority === MessagePriority.USER_INSTRUCTION) {
        for (const msg of bucket) {
          selected.push(msg);
          currentTokens += estimateMessageTokens(msg);
        }
        continue;
      }

      // P2 工具错误：keepAllErrors 时全部保留
      if (priority === MessagePriority.TOOL_ERROR && opts.keepAllErrors) {
        for (const msg of bucket) {
          selected.push(msg);
          currentTokens += estimateMessageTokens(msg);
        }
        continue;
      }

      // 其他优先级：按时间倒序保留，直到预算耗尽
      const sortedBucket = [...bucket].sort((a, b) => b.timestamp - a.timestamp);

      // P4 中间迭代：保留最近 N 轮
      if (priority === MessagePriority.INTERMEDIATE_ITERATION) {
        const recentIterations = new Set<number>();
        for (const msg of sortedBucket) {
          if (msg.iteration !== undefined) {
            recentIterations.add(msg.iteration);
            if (recentIterations.size >= opts.keepRecentIterations) break;
          }
        }
        // 先保留最近 N 轮，再按时间倒序填充其余
        const recent = sortedBucket.filter((m) => m.iteration !== undefined && recentIterations.has(m.iteration));
        const older = sortedBucket.filter((m) => m.iteration === undefined || !recentIterations.has(m.iteration));

        for (const msg of [...recent, ...older]) {
          const tokens = estimateMessageTokens(msg);
          if (currentTokens + tokens > opts.targetTokenBudget) {
            droppedByPriority[priority] = (droppedByPriority[priority] ?? 0) + 1;
            continue;
          }
          selected.push(msg);
          currentTokens += tokens;
        }
        continue;
      }

      // 默认：按时间倒序保留
      for (const msg of sortedBucket) {
        const tokens = estimateMessageTokens(msg);
        if (currentTokens + tokens > opts.targetTokenBudget) {
          droppedByPriority[priority] = (droppedByPriority[priority] ?? 0) + 1;
          continue;
        }
        selected.push(msg);
        currentTokens += tokens;
      }
    }

    // 步骤 5：按时间戳排序输出
    selected.sort((a, b) => a.timestamp - b.timestamp);

    return {
      messages: selected,
      truncated: true,
      originalTokenEstimate: originalTokens,
      truncatedTokenEstimate: currentTokens,
      droppedByPriority,
    };
  }

  /**
   * 为消息分配优先级。
   */
  static classifyMessage(
    msg: { role: string; content: string; toolName?: string; iteration?: number },
    isFinalIteration: boolean,
    isUserInstruction: boolean,
  ): MessagePriority {
    if (isUserInstruction) return MessagePriority.USER_INSTRUCTION;
    if (isFinalIteration) return MessagePriority.FINAL_ITERATION;

    // 工具错误：内容含 error/failed/exception
    const content = msg.content?.toLowerCase() ?? "";
    if (msg.role === "tool" || msg.toolName) {
      if (content.includes("error") || content.includes("failed") || content.includes("exception")) {
        return MessagePriority.TOOL_ERROR;
      }
      return MessagePriority.TOOL_RESULT;
    }

    if (msg.role === "system") return MessagePriority.SYSTEM_MESSAGE;

    return MessagePriority.INTERMEDIATE_ITERATION;
  }
}
