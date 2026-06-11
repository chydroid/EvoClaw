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

// ─── Hash function (djb2) ─────────────────────────────────────────────

function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
  }
  return hash.toString(36);
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
      const key = djb2Hash(systemText);
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

      const key = djb2Hash(prefix);
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

    // Build the prefix text from system + conversation messages
    const parts: string[] = [];
    for (const msg of messages) {
      parts.push(msg.content);
    }
    const promptPrefix = parts.join("\n");

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

    const key = djb2Hash(promptPrefix);

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
