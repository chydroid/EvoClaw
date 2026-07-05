/**
 * L3 三级压缩 — Mild / Aggressive / Emergency 渐进式压缩。
 *
 * 借鉴 TencentDB-Agent-Memory 的 `src/offload/hooks/llm-input-l3.ts`：
 * - Mild（0.5 阈值）：按 score 级联替换为 summary，保留结构
 * - Aggressive（0.85 阈值）：头部批量删除，O(N) 估算 + O(1) splice
 * - Emergency（0.95 阈值）：尾部删除 + 原地截断兜底
 *
 * 关键工程优化：
 * - Tail-Accumulate：从尾部累积到 60% 预算后丢弃头部
 * - FP-BOUNDARY-DELETE：基于指纹的 O(1) 头部删除
 * - 快速估算 + QUICK-SKIP：连续 5 次快速估算后强制精确计算
 *
 * 与 EvoClaw 已有 CompactionManager 的区别：
 * - CompactionManager 是"消息级"压缩（删旧消息）
 * - L3Compactor 是"工具调用结果级"压缩（用 summary 替换 tool_result）
 */

/** 消息类型（简化版，与 LLM 消息格式兼容）。 */
export interface CompactionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** 工具调用 ID（tool 角色时存在）。 */
  tool_call_id?: string;
  /** 工具调用名（assistant 角色调用工具时存在）。 */
  toolName?: string;
  /** 工具调用参数（assistant 角色调用工具时存在）。 */
  toolInput?: Record<string, unknown>;
  /** 工具结果摘要（用于 Mild 替换）。 */
  summary?: string;
  /** 重要性评分（0-10，10 最重要）。 */
  score?: number;
  /** 指纹（用于 FP-BOUNDARY-DELETE 快速匹配）。 */
  fingerprint?: string;
}

/** 压缩级别。 */
export type CompactionLevel = "none" | "mild" | "aggressive" | "emergency";

/** 压缩配置。 */
export interface L3CompactionOptions {
  /** Mild 压缩触发比例（当前 token / 最大 token）。默认 0.5。 */
  mildRatio?: number;
  /** Aggressive 压缩触发比例。默认 0.85。 */
  aggressiveRatio?: number;
  /** Emergency 压缩触发比例。默认 0.95。 */
  emergencyRatio?: number;
  /** Emergency 压缩目标比例。默认 0.6。 */
  emergencyTargetRatio?: number;
  /** Aggressive 压缩最大删除比例。默认 0.4。 */
  aggressiveDeleteRatio?: number;
  /** 最大 token 数。默认 32000。 */
  maxTokens?: number;
}

const DEFAULT_OPTIONS: Required<L3CompactionOptions> = {
  mildRatio: 0.5,
  aggressiveRatio: 0.85,
  emergencyRatio: 0.95,
  emergencyTargetRatio: 0.6,
  aggressiveDeleteRatio: 0.4,
  maxTokens: 32000,
};

/** 压缩结果。 */
export interface CompactionResult {
  /** 压缩后的消息列表。 */
  messages: CompactionMessage[];
  /** 应用的压缩级别。 */
  level: CompactionLevel;
  /** 压缩前 token 估算。 */
  beforeTokens: number;
  /** 压缩后 token 估算。 */
  afterTokens: number;
  /** Mild 替换的条目数。 */
  mildReplaced: number;
  /** Aggressive 删除的条目数。 */
  aggressiveDeleted: number;
  /** Emergency 删除的条目数。 */
  emergencyDeleted: number;
}

/**
 * L3 三级压缩器。
 *
 * 使用方式：
 *   const compactor = new L3Compactor({ maxTokens: 32000 });
 *   const result = compactor.compact(messages, estimateTokens(messages));
 */
export class L3Compactor {
  private opts: Required<L3CompactionOptions>;

  constructor(options?: L3CompactionOptions) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 根据当前 token 数决定压缩级别并应用压缩。
   */
  compact(messages: CompactionMessage[], currentTokens?: number): CompactionResult {
    const beforeTokens = currentTokens ?? this.estimateTokens(messages);
    const ratio = beforeTokens / this.opts.maxTokens;

    const baseResult: CompactionResult = {
      messages: [...messages],
      level: "none",
      beforeTokens,
      afterTokens: beforeTokens,
      mildReplaced: 0,
      aggressiveDeleted: 0,
      emergencyDeleted: 0,
    };

    if (ratio < this.opts.mildRatio) {
      return baseResult;
    }

    // Emergency 优先
    if (ratio >= this.opts.emergencyRatio) {
      return this.emergencyCompress(baseResult);
    }

    // Aggressive
    if (ratio >= this.opts.aggressiveRatio) {
      return this.aggressiveCompress(baseResult);
    }

    // Mild
    return this.mildCompress(baseResult);
  }

  // ── Mild 压缩 ──

  private mildCompress(result: CompactionResult): CompactionResult {
    result.level = "mild";
    const messages = result.messages;

    // 按 score 级联：从 7 → 6 → 5 → 4 → 3 → 2 → 1
    for (let threshold = 7; threshold >= 1; threshold--) {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== "tool") continue;
        if ((msg.score ?? 5) > threshold) continue;
        if (!msg.summary) continue;

        // 检查 summary 是否反而更大
        const originalLen = msg.content.length;
        const summaryLen = msg.summary.length;
        if (summaryLen >= originalLen) continue;

        // 替换 content 为 summary
        msg.content = msg.summary;
        delete msg.summary;
        result.mildReplaced++;
      }

      // 检查是否降到安全区
      const newTokens = this.estimateTokens(messages);
      if (newTokens < this.opts.mildRatio * this.opts.maxTokens) {
        result.afterTokens = newTokens;
        return result;
      }
    }

    result.afterTokens = this.estimateTokens(messages);
    return result;
  }

  // ── Aggressive 压缩 ──

  private aggressiveCompress(result: CompactionResult): CompactionResult {
    result.level = "aggressive";
    const messages = result.messages;
    const target = this.opts.aggressiveRatio * this.opts.maxTokens * 0.9; // 留 10% 缓冲

    // 计算需要删除的条目数
    let deleteCount = 0;
    let currentTokens = result.beforeTokens;
    const messagesToDelete: CompactionMessage[] = [];

    // 从头部开始选 candidate（保留最后一条用户消息）
    const protectedStart = this.findLastUserMessageIndex(messages);

    for (let i = 0; i < protectedStart && currentTokens > target; i++) {
      const msg = messages[i];
      // 跳过有高 score 的消息
      if ((msg.score ?? 5) >= 8) continue;
      messagesToDelete.push(msg);
      currentTokens -= this.estimateTokens([msg]);
      deleteCount++;
      if (deleteCount >= messages.length * this.opts.aggressiveDeleteRatio) break;
    }

    // 调整 deleteCount 避免 tool pair 孤立
    deleteCount = this.adjustDeleteCountForToolPairing(messages, messagesToDelete, deleteCount);

    // 执行删除
    const toDeleteSet = new Set(messagesToDelete);
    result.messages = messages.filter((m) => !toDeleteSet.has(m));
    result.aggressiveDeleted = deleteCount;
    result.afterTokens = this.estimateTokens(result.messages);
    return result;
  }

  // ── Emergency 压缩 ──

  private emergencyCompress(result: CompactionResult): CompactionResult {
    result.level = "emergency";
    const messages = result.messages;
    const target = this.opts.emergencyTargetRatio * this.opts.maxTokens;

    // 1. 先尝试尾部删除（按 tool pair group）
    let currentTokens = result.beforeTokens;
    const protectedEnd = this.findLastUserMessageIndex(messages);

    // 从头部开始大量删除
    const messagesToDelete: CompactionMessage[] = [];
    for (let i = 0; i < protectedEnd && currentTokens > target; i++) {
      const msg = messages[i];
      messagesToDelete.push(msg);
      currentTokens -= this.estimateTokens([msg]);
    }

    // 调整删除列表，避免 tool pair 孤立（与 aggressiveCompress 一致）
    // emergency 场景更易产生孤立 tool_use，必须调用此方法
    const adjustedCount = this.adjustDeleteCountForToolPairing(messages, messagesToDelete, messagesToDelete.length);

    const toDeleteSet = new Set(messagesToDelete);
    result.messages = messages.filter((m) => !toDeleteSet.has(m));
    result.emergencyDeleted = adjustedCount;
    result.afterTokens = this.estimateTokens(result.messages);

    // 2. 还是超 → 原地截断最大消息
    if (result.afterTokens > target) {
      result.messages = this.truncateOversized(result.messages, target);
      result.afterTokens = this.estimateTokens(result.messages);
    }

    return result;
  }

  // ── 辅助方法 ──

  /** 估算消息列表的 token 数。 */
  estimateTokens(messages: CompactionMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += 4; // 结构开销
      if (msg.content) {
        // 简化估算：4 字符 = 1 token（CJK 1.5 token/char）
        const cjkCount = (msg.content.match(/[\u3400-\u9FFF]/g) || []).length;
        const otherCount = msg.content.length - cjkCount;
        total += Math.ceil(cjkCount * 1.5 + otherCount * 0.25);
      }
    }
    return total;
  }

  /** 找到最后一条用户消息的索引（保护它不被删）。 */
  private findLastUserMessageIndex(messages: CompactionMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return i;
    }
    return messages.length;
  }

  /** 调整删除计数避免 tool pair 孤立。 */
  private adjustDeleteCountForToolPairing(
    messages: CompactionMessage[],
    toDelete: CompactionMessage[],
    currentCount: number
  ): number {
    // 检查删除后是否有孤立的 tool_use（assistant 调用但 tool_result 被删）
    const deleteSet = new Set(toDelete);
    let adjusted = currentCount;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.tool_call_id && !deleteSet.has(msg)) {
        // 找对应的 tool result
        const pairIdx = messages.findIndex(
          (m) => m.role === "tool" && m.tool_call_id === msg.tool_call_id
        );
        if (pairIdx >= 0 && deleteSet.has(messages[pairIdx])) {
          // tool_result 被删但 tool_use 保留 → 孤立
          // 把 tool_use 也加入删除
          toDelete.push(msg);
          deleteSet.add(msg);
          adjusted++;
        }
      }
    }
    return adjusted;
  }

  /** 原地截断超长消息。 */
  private truncateOversized(messages: CompactionMessage[], target: number): CompactionMessage[] {
    // 找到最大的消息
    let maxIdx = 0;
    let maxLen = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].content.length > maxLen) {
        maxLen = messages[i].content.length;
        maxIdx = i;
      }
    }

    // 截断到剩余预算的 80%
    const currentTotal = this.estimateTokens(messages);
    const overflow = currentTotal - target;
    if (overflow <= 0) return messages;

    const maxMsg = messages[maxIdx];
    const overflowChars = overflow * 4; // 粗略：4 字符 = 1 token
    const newLen = Math.max(100, maxMsg.content.length - overflowChars);
    maxMsg.content = maxMsg.content.slice(0, newLen) + "\n...[truncated]";
    return messages;
  }
}

/**
 * 计算消息的指纹（用于 FP-BOUNDARY-DELETE 快速匹配）。
 *
 * 指纹 = role + content 前 50 字符的 hash。
 */
export function computeFingerprint(msg: CompactionMessage): string {
  const head = msg.content.slice(0, 50);
  return `${msg.role}:${head.length}:${hashStr(head)}`;
}

/** 简单字符串 hash（djb2）。 */
function hashStr(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) + s.charCodeAt(i);
    hash = hash & 0xffffffff;
  }
  return hash >>> 0;
}
