/**
 * 快速 token 估算 — 无 tiktoken 依赖的轻量估算。
 *
 * 借鉴 TencentDB-Agent-Memory 的 `src/offload/hooks/after-tool-call.ts` quickTokenEstimate：
 * - CJK 字符 1.5 token/char
 * - 其他字符 0.25 token/char（约 4 字符/token）
 * - 误差 < 15%，足够用于预算控制
 *
 * 配合 `MAX_CONSECUTIVE_QUICK_SKIPS=5` 强制精确计算防止漂移：
 * 连续 5 次快速估算后，第 6 次应调用精确计算（调用方负责）。
 */

/** CJK 字符范围正则（中日韩统一表意文字 + 扩展 A 区 + 兼容表意文字）。 */
const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;

/**
 * 快速估算文本的 token 数。
 *
 * 启发式：
 * - CJK 字符按 1.5 token/char（中文一字约 1-2 token）
 * - 其他字符按 0.25 token/char（英文约 4 字符/token）
 * - 空白字符不计
 *
 * @param text 待估算文本
 * @returns 估算的 token 数（整数）
 */
export function quickTokenEstimate(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = text.length - cjkCount;
  // CJK 1.5 tok/char + 其他 0.25 tok/char
  const estimate = cjkCount * 1.5 + otherCount * 0.25;
  return Math.ceil(estimate);
}

/**
 * 估算消息数组的总 token 数。
 *
 * 每条消息额外计入 4 token 的结构开销（role/content 等字段）。
 */
export function estimateMessagesTokens(
  messages: Array<{ role?: string; content?: string | unknown }>
): number {
  let total = 0;
  for (const msg of messages) {
    total += 4; // 结构开销
    if (typeof msg.content === "string") {
      total += quickTokenEstimate(msg.content);
    } else if (msg.content && typeof msg.content === "object") {
      // 多模态消息：序列化后估算
      try {
        total += quickTokenEstimate(JSON.stringify(msg.content));
      } catch {
        total += 50; // 兜底
      }
    }
  }
  return total;
}

/** 连续快速估算计数器（用于 MAX_CONSECUTIVE_QUICK_SKIPS 逻辑）。 */
export class QuickSkipCounter {
  private count = 0;
  private readonly maxConsecutive: number;

  constructor(maxConsecutive = 5) {
    this.maxConsecutive = maxConsecutive;
  }

  /** 记录一次快速估算。 */
  increment(): void {
    this.count++;
  }

  /** 重置计数器（精确计算后调用）。 */
  reset(): void {
    this.count = 0;
  }

  /** 是否应该强制精确计算。 */
  shouldForceExact(): boolean {
    return this.count >= this.maxConsecutive;
  }

  /** 当前连续快速估算次数。 */
  get current(): number {
    return this.count;
  }
}
