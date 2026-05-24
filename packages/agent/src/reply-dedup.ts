/**
 * Reply Deduplication — prevents duplicate responses from being sent.
 *
 * In multi-channel environments, the same request might arrive via different
 * paths (e.g., webhook retry + user re-send). This module detects duplicate
 * messages and suppresses repeated LLM calls.
 *
 * Features:
 * - Content-based dedup (hash of normalized message text)
 * - Time-window dedup (ignore duplicates within N seconds)
 * - Per-session dedup tracking
 * - Configurable dedup window and max cache size
 */

import * as crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DedupConfig {
  /** Time window in ms for considering messages as duplicates */
  dedupWindowMs: number;
  /** Maximum number of cached message hashes */
  maxCacheSize: number;
  /** Whether to normalize whitespace before hashing */
  normalizeWhitespace: boolean;
  /** Whether to strip emojis before hashing */
  stripEmojis: boolean;
  /** Whether to case-fold before hashing */
  caseFold: boolean;
}

export interface DedupEntry {
  hash: string;
  timestamp: number;
  channel: string;
  sessionId: string;
  replyTo?: string;
}

export interface DedupCheckResult {
  /** Whether this message is a duplicate */
  isDuplicate: boolean;
  /** The hash of the normalized message */
  hash: string;
  /** If duplicate, the original entry that matched */
  originalEntry?: DedupEntry;
  /** Suggested action */
  action: "process" | "skip" | "warn";
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DedupConfig = {
  dedupWindowMs: 30_000,    // 30 seconds
  maxCacheSize: 500,
  normalizeWhitespace: true,
  stripEmojis: true,
  caseFold: true,
};

// ─── Reply Deduplicator ─────────────────────────────────────────────────────

export class ReplyDeduplicator {
  private config: DedupConfig;
  private entries: DedupEntry[] = [];

  constructor(config?: Partial<DedupConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a message is a duplicate of a recently processed message.
   * Returns the check result with recommendation.
   */
  check(
    message: string,
    channel: string,
    sessionId: string,
    options?: {
      replyTo?: string;
    },
  ): DedupCheckResult {
    const hash = this.computeHash(message);

    // Clean expired entries
    this.pruneExpired();

    // Find matching hash
    const existing = this.entries.find(
      (e) => e.hash === hash,
    );

    if (existing) {
      // Same session and channel — likely duplicate
      if (existing.sessionId === sessionId && existing.channel === channel) {
        return {
          isDuplicate: true,
          hash,
          originalEntry: existing,
          action: "skip",
        };
      }

      // Different session or channel — might be cross-session duplicate
      const elapsed = Date.now() - existing.timestamp;
      if (elapsed < this.config.dedupWindowMs * 0.5) {
        return {
          isDuplicate: true,
          hash,
          originalEntry: existing,
          action: "warn",
        };
      }
    }

    // Not a duplicate — record it
    this.entries.push({
      hash,
      timestamp: Date.now(),
      channel,
      sessionId,
      replyTo: options?.replyTo,
    });

    // Trim cache if over limit
    while (this.entries.length > this.config.maxCacheSize) {
      this.entries.shift();
    }

    return {
      isDuplicate: false,
      hash,
      action: "process",
    };
  }

  /**
   * Compute hash of a normalized message.
   */
  computeHash(message: string): string {
    let normalized = message;

    if (this.config.caseFold) {
      normalized = normalized.toLowerCase();
    }

    if (this.config.normalizeWhitespace) {
      normalized = normalized.replace(/\s+/g, " ").trim();
    }

    if (this.config.stripEmojis) {
      normalized = normalized.replace(
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
        "",
      ).trim();
    }

    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  /**
   * Check if two messages are fuzzy duplicates using similarity threshold.
   */
  isFuzzyDuplicate(message1: string, message2: string, threshold = 0.9): boolean {
    const sim = this.jaccardSimilarity(message1, message2);
    return sim >= threshold;
  }

  /**
   * Clear all dedup entries.
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Clear entries for a specific session.
   */
  clearSession(sessionId: string): void {
    this.entries = this.entries.filter((e) => e.sessionId !== sessionId);
  }

  /**
   * Get dedup statistics.
   */
  getStats(): { totalEntries: number; oldestEntry: number | null } {
    this.pruneExpired();
    const oldest = this.entries.length > 0
      ? Math.min(...this.entries.map((e) => e.timestamp))
      : null;

    return {
      totalEntries: this.entries.length,
      oldestEntry: oldest,
    };
  }

  /**
   * Update configuration.
   */
  configure(updates: Partial<DedupConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private pruneExpired(): void {
    const cutoff = Date.now() - this.config.dedupWindowMs;
    this.entries = this.entries.filter((e) => e.timestamp > cutoff);
  }

  /**
   * Jaccard similarity between two strings (character bigram-based).
   * Returns a value between 0 (completely different) and 1 (identical).
   */
  private jaccardSimilarity(str1: string, str2: string): number {
    const bigrams1 = this.getBigrams(str1);
    const bigrams2 = this.getBigrams(str2);

    const set1 = new Set(bigrams1);
    const set2 = new Set(bigrams2);

    const intersection = new Set([...set1].filter((x) => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    if (union.size === 0) return 1.0;
    return intersection.size / union.size;
  }

  private getBigrams(str: string): string[] {
    const bigrams: string[] = [];
    for (let i = 0; i < str.length - 1; i++) {
      bigrams.push(str.slice(i, i + 2));
    }
    return bigrams;
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

/**
 * Simple content-based dedup without a class instance.
 * Compares the hash of two messages.
 */
export function areMessagesDuplicate(
  msg1: string,
  msg2: string,
): boolean {
  const normalizer = (s: string) =>
    s.toLowerCase().replace(/\s+/g, " ").trim();

  const n1 = normalizer(msg1);
  const n2 = normalizer(msg2);

  return n1 === n2;
}