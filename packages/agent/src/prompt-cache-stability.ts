/**
 * Prompt cache 稳定性管理。
 *
 * 灵感来自 openclaw-main 的 src/agents/prompt-cache-stability.ts。
 *
 * LLM provider（如 OpenAI/Anthropic）使用前缀匹配 cache：
 * - Anthropic：messages 数组前缀 + system prompt
 * - OpenAI：system prompt + tools + 前若干 messages
 *
 * 任何前缀变化都会使 cache 失效，导致：
 * 1. 重新处理整个前缀（CPU/IO 成本）
 * 2. 重新计费（input tokens 重新计费）
 * 3. 延迟增加（无 cache hit）
 *
 * 此模块帮助识别哪些变更会破坏 cache，让开发者避免不必要的破坏。
 *
 * 与 packages/agent/src/prompt-cache.ts（本地前缀缓存）的区别：
 * - prompt-cache.ts：本地缓存 LLM 响应前缀
 * - 本模块：分析请求之间的 cache 稳定性，不做 LLM 调用
 */

import {
  stableHash,
  stableDiff,
  stableStringify,
  type StableDiffResult,
} from "./stable-stringify";

export type CacheProvider = "anthropic" | "openai" | "google" | "unknown";

export interface PromptCacheKey {
  provider: CacheProvider;
  systemPrompt?: string;
  /** 工具定义数组 */
  tools?: unknown[];
  /** 消息数组（前缀部分参与 cache） */
  messages: unknown[];
  model?: string;
  /** 参与缓存的最大消息数（OpenAI 限制） */
  maxCacheMessages?: number;
}

export interface CacheStabilityResult {
  /** 当前请求与上次是否一致（cache hit） */
  isStable: boolean;
  /** 与上次共享的稳定前缀长度（消息数） */
  stablePrefixLength: number;
  /** 在第几条消息处断开（cache miss 起点） */
  brokenAt?: number;
  /** 断开原因 */
  brokenReason?: string;
  /** 具体差异 */
  diffs?: StableDiffResult[];
  /** 估算 cache 命中的 token 数 */
  estimatedCacheHitTokens?: number;
  /** 估算 cache 未命中的 token 数 */
  estimatedCacheMissTokens?: number;
  previousCacheKeyHash?: string;
  currentCacheKeyHash?: string;
}

interface HistoryEntry {
  at: Date;
  key: PromptCacheKey;
  hash: string;
  isStable: boolean;
  stablePrefixLength: number;
  brokenAt?: number;
  brokenReason?: string;
}

interface AntiPattern {
  pattern: string;
  severity: "info" | "warning" | "error";
  evidence: string;
}

const DEFAULT_MAX_HISTORY = 100;
/** 粗略 token 估算：4 chars ≈ 1 token */
const CHARS_PER_TOKEN = 4;

/**
 * 粗略估算字符串/对象的 token 数（4 chars/token）。
 */
export function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return Math.ceil(value.length / CHARS_PER_TOKEN);
  const s = stableStringify(value);
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

export class PromptCacheStabilityManager {
  private lastKey: PromptCacheKey | null = null;
  private lastKeyHash: string | null = null;
  private history: HistoryEntry[] = [];
  private readonly maxHistorySize: number;

  constructor(opts?: { maxHistorySize?: number }) {
    this.maxHistorySize = opts?.maxHistorySize ?? DEFAULT_MAX_HISTORY;
  }

  /**
   * 评估当前请求的 cache 稳定性。
   *
   * 比较顺序：provider → model → systemPrompt → tools → messages（逐条）。
   * 任何前置差异都会导致后续比较短路。
   */
  evaluate(currentKey: PromptCacheKey): CacheStabilityResult {
    const currentHash = stableHash(currentKey);

    // 首次评估 → 无 cache，整体 miss
    if (this.lastKey === null) {
      const result: CacheStabilityResult = {
        isStable: false,
        stablePrefixLength: 0,
        brokenAt: 0,
        brokenReason: "首次评估，无历史 cache key",
        estimatedCacheHitTokens: 0,
        estimatedCacheMissTokens: estimateMessagesTokens(currentKey),
        currentCacheKeyHash: currentHash,
      };
      this.pushHistory({
        at: new Date(),
        key: currentKey,
        hash: currentHash,
        isStable: false,
        stablePrefixLength: 0,
        brokenAt: 0,
        brokenReason: "首次评估，无历史 cache key",
      });
      this.lastKey = currentKey;
      this.lastKeyHash = currentHash;
      return result;
    }

    const last = this.lastKey;

    // provider 不同 → 整体 cache 失效
    if (last.provider !== currentKey.provider) {
      const reason = `provider 变更: ${last.provider} → ${currentKey.provider}`;
      return this.finalizeUnstable(
        currentKey,
        currentHash,
        0,
        reason,
        estimateMessagesTokens(currentKey),
      );
    }

    // model 不同 → 整体 cache 失效
    if ((last.model ?? "") !== (currentKey.model ?? "")) {
      const reason = `model 变更: ${last.model ?? "(none)"} → ${currentKey.model ?? "(none)"}`;
      return this.finalizeUnstable(
        currentKey,
        currentHash,
        0,
        reason,
        estimateMessagesTokens(currentKey),
      );
    }

    // systemPrompt 不同 → brokenAt=0
    const lastSystem = last.systemPrompt ?? "";
    const curSystem = currentKey.systemPrompt ?? "";
    if (lastSystem !== curSystem) {
      const diffs = stableDiff({ system: lastSystem }, { system: curSystem });
      return this.finalizeUnstable(
        currentKey,
        currentHash,
        0,
        "systemPrompt 变更",
        estimateMessagesTokens(currentKey),
        diffs,
      );
    }

    // tools 不同 → brokenAt=0（tools 位于前缀最前面，变化即整体失效）
    if (!toolsEqual(last.tools, currentKey.tools)) {
      const diffs = stableDiff(
        { tools: last.tools ?? [] },
        { tools: currentKey.tools ?? [] },
      );
      return this.finalizeUnstable(
        currentKey,
        currentHash,
        0,
        "tools 变更",
        estimateMessagesTokens(currentKey),
        diffs,
      );
    }

    // 逐条比较 messages，找出第一条差异处
    const lastMsgs = last.messages ?? [];
    const curMsgs = currentKey.messages ?? [];
    const maxCache = Math.min(
      curMsgs.length,
      currentKey.maxCacheMessages ?? Number.MAX_SAFE_INTEGER,
    );
    let brokenAt: number | undefined;
    let brokenReason: string | undefined;
    let diffs: StableDiffResult[] | undefined;

    const minLen = Math.min(lastMsgs.length, curMsgs.length);
    for (let i = 0; i < minLen; i++) {
      if (!messagesEqual(lastMsgs[i], curMsgs[i])) {
        brokenAt = i;
        brokenReason = `第 ${i} 条 message 内容变化`;
        diffs = stableDiff(lastMsgs[i], curMsgs[i], `messages[${i}]`);
        break;
      }
    }

    if (brokenAt === undefined && lastMsgs.length !== curMsgs.length) {
      // 前缀完全一致但长度不同：长度增加不破坏 cache（仅追加部分 miss）
      brokenAt = minLen;
      brokenReason = `messages 长度变化: ${lastMsgs.length} → ${curMsgs.length}`;
    }

    // 计算 stablePrefixLength
    const stablePrefixLength =
      brokenAt === undefined ? Math.min(maxCache, curMsgs.length) : Math.min(brokenAt, maxCache);

    // 计算 token 估算
    const hitTokens = estimatePrefixTokens(currentKey, stablePrefixLength);
    const missTokens = estimatePrefixTokens(currentKey, curMsgs.length) - hitTokens;

    const isStable = brokenAt === undefined || brokenAt >= curMsgs.length;

    const result: CacheStabilityResult = {
      isStable,
      stablePrefixLength,
      brokenAt: brokenAt === undefined ? undefined : brokenAt,
      brokenReason,
      diffs,
      estimatedCacheHitTokens: Math.max(0, hitTokens),
      estimatedCacheMissTokens: Math.max(0, missTokens),
      previousCacheKeyHash: this.lastKeyHash ?? undefined,
      currentCacheKeyHash: currentHash,
    };

    this.pushHistory({
      at: new Date(),
      key: currentKey,
      hash: currentHash,
      isStable,
      stablePrefixLength,
      brokenAt,
      brokenReason,
    });
    this.lastKey = currentKey;
    this.lastKeyHash = currentHash;
    return result;
  }

  /**
   * 手动重置 cache 状态（如会话切换、模型切换）。
   */
  reset(): void {
    this.lastKey = null;
    this.lastKeyHash = null;
  }

  /**
   * 获取 cache 命中历史。
   */
  getHistory(limit?: number): Array<{
    at: Date;
    isStable: boolean;
    stablePrefixLength: number;
    brokenAt?: number;
    brokenReason?: string;
  }> {
    const slice = limit ? this.history.slice(-limit) : this.history;
    return slice.map((h) => ({
      at: h.at,
      isStable: h.isStable,
      stablePrefixLength: h.stablePrefixLength,
      brokenAt: h.brokenAt,
      brokenReason: h.brokenReason,
    }));
  }

  /**
   * 计算 cache 命中率（最近 N 次请求中 stable 的比例）。
   */
  getHitRate(windowSize?: number): number {
    if (this.history.length === 0) return 0;
    const size = windowSize ?? this.history.length;
    const slice = this.history.slice(-size);
    const stableCount = slice.filter((h) => h.isStable).length;
    return stableCount / slice.length;
  }

  /**
   * 检测 cache-breaking 反模式。
   *
   * 反模式：
   * 1. 在 messages 中间插入时间戳（每次都不同）
   * 2. 在 system prompt 中包含随机 ID
   * 3. tools 数组顺序不稳定（应用 stableStringify 后再比较）
   * 4. 频繁切换 model
   */
  detectAntiPatterns(): AntiPattern[] {
    const patterns: AntiPattern[] = [];
    if (this.history.length < 2) return patterns;

    // 反模式 1: brokenAt 频繁落在固定位置（非首末）
    const brokenAtCounts = new Map<number, number>();
    for (const h of this.history) {
      if (h.brokenAt !== undefined && h.brokenAt > 0) {
        brokenAtCounts.set(h.brokenAt, (brokenAtCounts.get(h.brokenAt) ?? 0) + 1);
      }
    }
    for (const [at, count] of brokenAtCounts) {
      if (count >= 2) {
        patterns.push({
          pattern: "messages 中间内容频繁变化",
          severity: count >= 3 ? "error" : "warning",
          evidence: `brokenAt=${at} 出现 ${count} 次（同一位置反复破坏 cache）`,
        });
      }
    }

    // 反模式 2: brokenReason 含 timestamp/random/uuid 等模式
    const volatileKeywords = ["timestamp", "random", "uuid", "now", "date", "time"];
    const reasonCounts = new Map<string, number>();
    for (const h of this.history) {
      if (!h.brokenReason) continue;
      const lower = h.brokenReason.toLowerCase();
      for (const kw of volatileKeywords) {
        if (lower.includes(kw)) {
          const key = `volatile:${kw}`;
          reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
          break;
        }
      }
    }
    for (const [key, count] of reasonCounts) {
      if (count >= 2) {
        patterns.push({
          pattern: "前缀中包含易变字段（timestamp/random/uuid 等）",
          severity: count >= 3 ? "error" : "warning",
          evidence: `${key} 模式触发 ${count} 次`,
        });
      }
    }

    // 反模式 3: 频繁切换 model
    const models = new Set<string>();
    for (const h of this.history) {
      if (h.key.model) models.add(h.key.model);
    }
    if (models.size >= 2 && this.history.length >= 3) {
      const switchCount = countModelSwitches(this.history);
      if (switchCount >= 2) {
        patterns.push({
          pattern: "频繁切换 model",
          severity: switchCount >= 3 ? "warning" : "info",
          evidence: `${models.size} 个不同 model，${switchCount} 次切换`,
        });
      }
    }

    return patterns;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private finalizeUnstable(
    currentKey: PromptCacheKey,
    currentHash: string,
    stablePrefixLength: number,
    reason: string,
    missTokens: number,
    diffs?: StableDiffResult[],
  ): CacheStabilityResult {
    const result: CacheStabilityResult = {
      isStable: false,
      stablePrefixLength,
      brokenAt: 0,
      brokenReason: reason,
      diffs,
      estimatedCacheHitTokens: 0,
      estimatedCacheMissTokens: missTokens,
      previousCacheKeyHash: this.lastKeyHash ?? undefined,
      currentCacheKeyHash: currentHash,
    };
    this.pushHistory({
      at: new Date(),
      key: currentKey,
      hash: currentHash,
      isStable: false,
      stablePrefixLength,
      brokenAt: 0,
      brokenReason: reason,
    });
    this.lastKey = currentKey;
    this.lastKeyHash = currentHash;
    return result;
  }

  private pushHistory(entry: HistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }
}

// ── Helper functions ─────────────────────────────────────────────────

function toolsEqual(
  a: unknown[] | undefined,
  b: unknown[] | undefined,
): boolean {
  const arrA = a ?? [];
  const arrB = b ?? [];
  if (arrA.length !== arrB.length) return false;
  // tools 数组顺序不影响 cache（OpenAI/Anthropic 按 tool name 索引），
  // 因此先对每个元素 stableStringify，再按字典序排序比较，避免顺序差异导致 false negative。
  const normA = arrA.map((t) => stableStringify(t)).sort();
  const normB = arrB.map((t) => stableStringify(t)).sort();
  return normA.every((s, i) => s === normB[i]);
}

function messagesEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function estimateMessagesTokens(key: PromptCacheKey): number {
  let total = 0;
  total += estimateTokens(key.systemPrompt ?? "");
  total += estimateTokens(key.tools ?? []);
  total += estimateTokens(key.messages ?? []);
  return total;
}

function estimatePrefixTokens(key: PromptCacheKey, msgCount: number): number {
  let total = 0;
  total += estimateTokens(key.systemPrompt ?? "");
  total += estimateTokens(key.tools ?? []);
  const msgs = key.messages ?? [];
  for (let i = 0; i < Math.min(msgCount, msgs.length); i++) {
    total += estimateTokens(msgs[i]);
  }
  return total;
}

function countModelSwitches(history: HistoryEntry[]): number {
  let switches = 0;
  let lastModel: string | undefined;
  for (const h of history) {
    if (lastModel !== undefined && h.key.model !== lastModel) {
      switches++;
    }
    lastModel = h.key.model;
  }
  return switches;
}
