/**
 * RecallBudget — 双重预算控制。
 *
 * 借鉴 TencentDB-Agent-Memory 的 `src/core/hooks/auto-recall.ts` applyRecallBudget：
 * - maxCharsPerMemory：单条记忆最大字符数（防止单条过大占满预算）
 * - maxTotalRecallChars：总召回字符数预算（防止召回过多挤占用户 prompt）
 *
 * 解决问题：
 * - 召回的单条记忆过长（如整段对话），把用户 prompt 挤到只剩 100 token
 * - 召回 top-K 条记忆总字符数超过预算，导致 LLM 上下文溢出
 */

/** RecallBudget 配置。 */
export interface RecallBudgetOptions {
  /** 单条记忆最大字符数。默认 500。 */
  maxCharsPerMemory?: number;
  /** 总召回字符数预算。默认 3000。 */
  maxTotalRecallChars?: number;
  /** 是否在截断时添加省略标记。默认 true。 */
  addEllipsis?: boolean;
}

const DEFAULT_OPTIONS: Required<RecallBudgetOptions> = {
  maxCharsPerMemory: 500,
  maxTotalRecallChars: 3000,
  addEllipsis: true,
};

/** 召回预算应用结果。 */
export interface BudgetResult<T> {
  /** 通过预算的条目列表（可能被截断）。 */
  items: Array<T & { _truncated?: boolean; _originalLength?: number; _truncatedText?: string }>;
  /** 实际使用的总字符数。 */
  totalChars: number;
  /** 因预算被丢弃的条目数。 */
  droppedCount: number;
  /** 因单条超限被截断的条目数。 */
  truncatedCount: number;
  /** 预算是否用尽。 */
  budgetExhausted: boolean;
}

/**
 * 把召回结果按双重预算裁剪。
 *
 * @param items 召回的条目数组
 * @param getText 从条目提取文本的函数
 * @param options 预算配置
 * @returns 裁剪后的结果
 */
export function applyRecallBudget<T>(
  items: T[],
  getText: (item: T) => string,
  options?: RecallBudgetOptions
): BudgetResult<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const result: BudgetResult<T> = {
    items: [],
    totalChars: 0,
    droppedCount: 0,
    truncatedCount: 0,
    budgetExhausted: false,
  };

  let remaining = opts.maxTotalRecallChars;

  for (const item of items) {
    if (remaining <= 0) {
      result.budgetExhausted = true;
      result.droppedCount = items.length - result.items.length;
      break;
    }

    const text = getText(item) ?? "";
    let truncatedText = text;
    let truncated = false;

    // 第 1 重：单条最大字符数
    if (text.length > opts.maxCharsPerMemory) {
      truncatedText = opts.addEllipsis
        ? text.slice(0, opts.maxCharsPerMemory - 3) + "..."
        : text.slice(0, opts.maxCharsPerMemory);
      truncated = true;
    }

    // 第 2 重：总预算检查
    if (truncatedText.length > remaining) {
      // 这条放不下，截断到剩余预算
      if (remaining > 50) {
        // 剩余空间还够放一段，截断
        truncatedText = opts.addEllipsis
          ? truncatedText.slice(0, remaining - 3) + "..."
          : truncatedText.slice(0, remaining);
        truncated = true;
        result.items.push({
          ...item,
          _truncated: truncated,
          _originalLength: text.length,
          _truncatedText: truncatedText,
        } as T & { _truncated?: boolean; _originalLength?: number; _truncatedText?: string });
        result.totalChars += truncatedText.length;
        remaining = 0;
        result.budgetExhausted = true;
      } else {
        // 剩余空间太小，放弃这条；后续未处理条目也一并计入 droppedCount
        result.droppedCount = items.length - result.items.length;
        result.budgetExhausted = true;
      }
      break;
    }

    if (truncated) {
      result.truncatedCount++;
    }
    result.items.push({
      ...item,
      _truncated: truncated,
      _originalLength: text.length,
      _truncatedText: truncatedText,
    } as T & { _truncated?: boolean; _originalLength?: number; _truncatedText?: string });
    result.totalChars += truncatedText.length;
    remaining -= truncatedText.length;
  }

  return result;
}

/**
 * 计算可用预算（总预算 - 已用）。
 */
export function remainingBudget(
  used: number,
  maxTotal: number = DEFAULT_OPTIONS.maxTotalRecallChars
): number {
  return Math.max(0, maxTotal - used);
}
