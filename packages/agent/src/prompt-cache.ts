import * as crypto from "crypto";

/**
 * PromptCache — Prompt prefix caching to reduce token costs.
 *
 * Inspired by OpenClaw 2026.4.5's prompt cache improvements.
 * Caches system prompt + conversation prefixes so that repeated
 * prefixes across requests can be reused without re-processing,
 * saving both latency and token cost.
 */

// ─── Interfaces ───────────────────────────────────────────────────────

export interface CacheEntry {
  /** Hash of the prompt prefix */
  key: string;
  /** The cached prefix text */
  promptPrefix: string;
  /** Estimated tokens in the prefix */
  tokenCount: number;
  /** Creation timestamp (ms since epoch) */
  createdAt: number;
  /** Last access timestamp (ms since epoch) */
  lastUsedAt: number;
  /** Number of cache hits */
  hitCount: number;
}

export interface CacheStats {
  entries: number;
  hitRate: number;
  totalHits: number;
  totalMisses: number;
  savedTokens: number;
}

export interface PromptCacheConfig {
  /** Whether prompt caching is enabled */
  enabled: boolean;
  /** Maximum number of cache entries */
  maxEntries: number;
  /** Time-to-live in milliseconds */
  ttlMs: number;
  /** Minimum prefix length (chars) to cache */
  minPrefixLength: number;
  /** Maximum prefix length (chars) to cache */
  maxPrefixLength: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PromptCacheConfig = {
  enabled: true,
  maxEntries: 100,
  ttlMs: 30 * 60 * 1000, // 30 minutes
  minPrefixLength: 100,
  maxPrefixLength: 10000,
};

// ─── Hash function (SHA256 + length disambiguation) ─────────────────────
// 使用 SHA256 + 长度后缀降低碰撞概率，满足项目安全规范对哈希算法的要求。
// 作为内存缓存 key 足够（碰撞时仅返回错误 tokenCount）。

function promptCacheHash(str: string): string {
  const hash = crypto.createHash("sha256").update(str, "utf-8").digest("hex").slice(0, 16);
  return `${hash}:${str.length.toString(36)}`;
}

// ─── Anthropic cache_control 注入 ─────────────────────────────────────
// 灵感来自 hermes-agent 的 system_and_3 策略：在 system prompt + 最后 3 条
// 非系统消息上注入 cache_control: {type: "ephemeral"} 标记，启用 Anthropic
// 服务端 prompt 缓存，可减少约 75% 的输入 token 成本（命中缓存时按 10% 计费）。
//
// Anthropic OpenAI-compatible endpoint 在 message 对象上接受 cache_control
// 字段。本函数返回新的 messages 数组，不修改原数组。

export interface AnthropicCacheableMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
  cache_control?: { type: "ephemeral" };
}

/**
 * 在 messages 数组上应用 Anthropic cache_control 断点。
 *
 * 策略 system_and_3：
 * 1. 首条 system 消息（或按 stableLength 拆分的稳定段）标记 cache_control
 * 2. volatile 区域之前的最后 3 条非 system 消息标记 cache_control
 *    （P0-5：布局 [sys, history..., skills?, tail?, user] 下即 history 尾部；
 *    末尾 user 消息逐轮必变，永不挂断点）
 *
 * Anthropic 限制最多 4 个 cache_control 断点（system 算 1 个 + 3 个尾部）。
 *
 * P0-3 缓存稳定化（2026-10-16）：可选 `stableLength` 参数——首条 system 消息的
 * **稳定前缀**字符长度（ContextEngine frozen 段长度）。提供且有效时，把首条
 * system 拆成两条：稳定段（带 cache_control，逐轮字节不变 → 命中）+ 易变尾
 * （不带断点，只重价尾段）。缺省行为不变（整条 system 一个断点）。
 *
 * @param messages 输入消息数组
 * @param stableLength 首条 system 消息中稳定前缀的字符长度（0/undefined = 旧行为）
 * @returns 新的消息数组，带 cache_control 标记（不修改原数组）
 */
export function applyAnthropicCacheControl(
  messages: Array<Record<string, unknown>>,
  stableLength?: number,
): Array<Record<string, unknown>> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const result = messages.map((m) => ({ ...m }));

  // ── P0-3：把首条 system（frozen 段 + ephemeral 尾拼接而成）拆成两条 ──
  // 稳定段（frozen，逐轮字节不变）带断点，provider 缓存命中到此；
  // 易变尾（"Today is:" 等，随时间变）不带断点，只被尾部重价。
  // 拆分后所有 system 消息中只有第 0 条（稳定段）拿断点，
  // 其余 system（易变尾、llm-caller 动态尾）一律不补断点——
  // 避免把逐轮变动的字节拉进缓存块、且保持 ≤4 断点。
  let stableSystemIdx = -1;
  if (
    typeof stableLength === "number" &&
    stableLength > 0 &&
    result[0].role === "system" &&
    typeof result[0].content === "string" &&
    result[0].content.length > stableLength
  ) {
    const full = result[0].content as string;
    const stablePart: Record<string, unknown> = { ...result[0], content: full.slice(0, stableLength) };
    const tailPart: Record<string, unknown> = { ...result[0], content: full.slice(stableLength) };
    stablePart.cache_control = { type: "ephemeral" };
    result[0] = stablePart;
    result.splice(1, 0, tailPart);
    stableSystemIdx = 0;
  }

  // ── 断点 1：稳定 system 段 ──
  // 未拆分时，稳定段就是首条 system（整条）；拆分时即上面已标记的稳定段。
  if (stableSystemIdx === -1) {
    // 首条 system 作为单个缓存块（旧行为）
    let firstSystemIdx = -1;
    for (let i = 0; i < result.length; i++) {
      if (result[i].role === "system") {
        firstSystemIdx = i;
        break;
      }
    }
    if (firstSystemIdx >= 0) {
      result[firstSystemIdx].cache_control = { type: "ephemeral" };
      stableSystemIdx = firstSystemIdx;
    }
  }

  // ── 断点 2-4：volatile 区域之前的最后 3 条非 system 消息（history 尾部） ──
  // 旧实现把断点放在最早 3 条非 system 消息上——仅当易变内容位于 history
  // 之后时才成立。P0-5 布局 [sys, history..., skills?, tail?, user] 下，
  // 最后 3 条非 system 消息（排除末尾 user）即 history 尾部——它们是逐轮
  // 字节不变的稳定前缀，断点可稳定命中，缓存覆盖 system + 几乎全部 history。
  // history 短于 3 条时槽位顺延给 skills/tail 消息（它们在会话内同样稳定）。
  // 注意：**末尾 user 消息永远不挂断点**（逐轮必变，挂上只是浪费槽位）。
  const nonSysIndices: number[] = [];
  for (let i = 0; i < result.length; i++) {
    if (result[i].role !== "system" && !result[i].cache_control) {
      nonSysIndices.push(i);
    }
  }
  // 排除最后一条非 system 消息（当前 user 消息，逐轮必变）
  const stableNonSys = nonSysIndices.slice(0, -1);
  for (const idx of stableNonSys.slice(-3)) {
    result[idx].cache_control = { type: "ephemeral" };
  }

  return result;
}

// ─── PromptCache class ────────────────────────────────────────────────

export class PromptCache {
  private config: PromptCacheConfig;
  private cache = new Map<string, CacheEntry>();
  private totalHits = 0;
  private totalMisses = 0;
  private savedTokens = 0;

  constructor(config?: Partial<PromptCacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Find the longest matching prefix from cached entries.
   *
   * Strategy: build progressively longer prefix strings from
   * system prompt + first N messages, hash each, and check
   * the cache. Return the longest match found.
   */
  findMatchingPrefix(
    messages: Array<{ role: string; content: string }>,
  ): CacheEntry | null {
    if (!this.config.enabled) return null;

    // Separate system messages from conversation messages
    const systemParts: string[] = [];
    const conversationParts: string[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemParts.push(msg.content);
      } else {
        conversationParts.push(msg.content);
      }
    }

    const systemText = systemParts.join("\n");

    // If there is no system text and no conversation, nothing to match
    if (systemText.length === 0 && conversationParts.length === 0) {
      this.totalMisses++;
      return null;
    }

    let bestMatch: CacheEntry | null = null;

    // Try system prompt alone
    if (systemText.length >= this.config.minPrefixLength) {
      const key = promptCacheHash(systemText);
      const entry = this.cache.get(key);
      if (entry && !this.isExpired(entry)) {
        bestMatch = entry;
      }
    }

    // Try system prompt + first N conversation messages
    let prefix = systemText;
    for (let i = 0; i < conversationParts.length; i++) {
      prefix = prefix + "\n" + conversationParts[i];

      if (prefix.length < this.config.minPrefixLength) continue;
      if (prefix.length > this.config.maxPrefixLength) break;

      const key = promptCacheHash(prefix);
      const entry = this.cache.get(key);
      if (entry && !this.isExpired(entry)) {
        // Prefer longer matches
        if (!bestMatch || entry.tokenCount > bestMatch.tokenCount) {
          bestMatch = entry;
        }
      }
    }

    if (bestMatch) {
      bestMatch.hitCount++;
      bestMatch.lastUsedAt = Date.now();
      this.totalHits++;
      this.savedTokens += bestMatch.tokenCount;
      return { ...bestMatch };
    }

    this.totalMisses++;
    return null;
  }

  /**
   * Cache the system prompt + conversation prefix.
   *
   * Evicts expired entries first, then LRU if at capacity.
   */
  cachePrefix(
    messages: Array<{ role: string; content: string }>,
    tokenCount: number,
  ): CacheEntry {
    if (!this.config.enabled) {
      // Return a dummy entry when disabled
      return {
        key: "",
        promptPrefix: "",
        tokenCount: 0,
        createdAt: 0,
        lastUsedAt: 0,
        hitCount: 0,
      };
    }

    // Build the prefix text using the SAME logic as findMatchingPrefix:
    // separate system messages from conversation messages, then join as
    // systemText + "\n" + conversationParts[i] for each conversation msg.
    // (BUG 1.2 fix: previously cachePrefix joined all messages with "\n"
    //  without separating system/conversation, causing key mismatch with
    //  findMatchingPrefix and 100% cache miss.)
    const systemParts: string[] = [];
    const conversationParts: string[] = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        systemParts.push(msg.content);
      } else {
        conversationParts.push(msg.content);
      }
    }
    const systemText = systemParts.join("\n");
    let promptPrefix = systemText;
    for (const part of conversationParts) {
      promptPrefix = promptPrefix + "\n" + part;
    }

    // Enforce length constraints
    if (
      promptPrefix.length < this.config.minPrefixLength ||
      promptPrefix.length > this.config.maxPrefixLength
    ) {
      return {
        key: "",
        promptPrefix: "",
        tokenCount: 0,
        createdAt: 0,
        lastUsedAt: 0,
        hitCount: 0,
      };
    }

    const key = promptCacheHash(promptPrefix);

    // If already cached, update existing entry
    const existing = this.cache.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      existing.tokenCount = tokenCount;
      return { ...existing };
    }

    // Make room if needed
    this.evictIfNeeded();

    const now = Date.now();
    const entry: CacheEntry = {
      key,
      promptPrefix,
      tokenCount,
      createdAt: now,
      lastUsedAt: now,
      hitCount: 0,
    };

    this.cache.set(key, entry);
    return { ...entry };
  }

  /**
   * Return cache statistics.
   */
  getCacheStats(): CacheStats {
    const total = this.totalHits + this.totalMisses;
    return {
      entries: this.cache.size,
      hitRate: total > 0 ? this.totalHits / total : 0,
      totalHits: this.totalHits,
      totalMisses: this.totalMisses,
      savedTokens: this.savedTokens,
    };
  }

  /**
   * Remove a specific cache entry by key.
   */
  invalidate(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear the entire cache.
   */
  invalidateAll(): void {
    this.cache.clear();
    this.totalHits = 0;
    this.totalMisses = 0;
    this.savedTokens = 0;
  }

  /**
   * Remove expired entries. Returns the count of removed entries.
   */
  cleanup(): number {
    let removed = 0;
    const now = Date.now();

    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > this.config.ttlMs) {
        this.cache.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Simple token estimation (length / 4).
   */
  estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.createdAt > this.config.ttlMs;
  }

  private evictIfNeeded(): void {
    // First pass: remove expired entries
    if (this.cache.size >= this.config.maxEntries) {
      this.cleanup();
    }

    // Second pass: LRU eviction if still at capacity
    if (this.cache.size >= this.config.maxEntries) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;

      for (const [key, entry] of this.cache) {
        if (entry.lastUsedAt < oldestTime) {
          oldestTime = entry.lastUsedAt;
          oldestKey = key;
        }
      }

      if (oldestKey !== null) {
        this.cache.delete(oldestKey);
      }
    }
  }
}
