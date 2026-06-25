/**
 * MemoryCuratorV2 — 记忆衰减与重要性评分
 *
 * 实现记忆的生命周期管理：
 *   - 重要性评分：基于时效性、访问频率、内容长度、类型
 *   - 保留决策：判断记忆是否应保留
 *   - 批量策展：批量处理记忆的保留/衰减
 *   - 压缩旧记忆：对旧记忆进行摘要压缩
 */

// ── Types ──────────────────────────────────────────────────

import * as crypto from "crypto";

export interface MemoryEntryInput {
  content: string;
  type: string;
  accessCount: number;
  age: number; // in days
}

export interface MemoryEntryWithId extends MemoryEntryInput {
  id: string;
  importance?: number;
}

export interface CompressibleEntry {
  id: string;
  content: string;
  type: string;
  age: number; // in days
}

export interface CompressedMemory {
  id: string;
  summary: string;
}

export interface CurationResult {
  retain: string[];
  decay: string[];
}

// ── Constants ──────────────────────────────────────────────

/** Half-life for exponential decay: 7 days */
const RECENCY_HALF_LIFE_DAYS = 7;

/** Maximum age before considering removal (days) */
const MAX_AGE_THRESHOLD = 90;

/** Minimum access count to retain old memories */
const MIN_ACCESS_COUNT_FOR_OLD = 2;

/** Minimum importance to retain old memories */
const MIN_IMPORTANCE_FOR_OLD = 0.2;

/** Type importance weights */
const TYPE_WEIGHTS: Record<string, number> = {
  system: 1.0,
  preference: 0.8,
  fact: 0.6,
  conversation: 0.3,
};

/** Default type weight for unknown types */
const DEFAULT_TYPE_WEIGHT = 0.4;

/** Optimal content length range */
const OPTIMAL_LENGTH_MIN = 100;
const OPTIMAL_LENGTH_MAX = 500;

// ── MemoryCuratorV2 ────────────────────────────────────────

export class MemoryCuratorV2 {
  /**
   * 评分记忆的重要性 (0-1)。
   *
   * 评分维度：
   *   - 时效性：越新越高（指数衰减，半衰期 7 天）
   *   - 访问频率：越常访问越高（对数尺度）
   *   - 内容长度：适中长度 (100-500 字符) 得分更高
   *   - 类型权重：system > preference > fact > conversation
   */
  scoreImportance(entry: MemoryEntryInput): number {
    const recencyScore = this.computeRecencyScore(entry.age);
    const accessScore = this.computeAccessScore(entry.accessCount);
    const lengthScore = this.computeLengthScore(entry.content.length);
    const typeScore = this.computeTypeScore(entry.type);

    // Weighted combination
    const importance =
      recencyScore * 0.35 +
      accessScore * 0.25 +
      lengthScore * 0.15 +
      typeScore * 0.25;

    return Math.max(0, Math.min(1, importance));
  }

  /**
   * 判断记忆是否应保留。
   *
   * 返回 false 的条件：
   *   - 年龄 > 90 天 AND 访问次数 < 2 AND 重要性 < 0.2
   *   - 内容与另一条目重复或近似重复
   */
  shouldRetain(entry: MemoryEntryInput & { importance?: number }): boolean {
    const importance = entry.importance ?? this.scoreImportance(entry);

    // Age + access + importance threshold
    if (
      entry.age > MAX_AGE_THRESHOLD &&
      entry.accessCount < MIN_ACCESS_COUNT_FOR_OLD &&
      importance < MIN_IMPORTANCE_FOR_OLD
    ) {
      return false;
    }

    return true;
  }

  /**
   * 批量策展：返回应保留的 ID 和应衰减/移除的 ID。
   *
   * 处理逻辑：
   *   1. 对每条记忆计算重要性并判断是否保留
   *   2. 检测重复/近似重复内容，仅保留第一条
   */
  curateMemories(entries: MemoryEntryWithId[]): CurationResult {
    const retain: string[] = [];
    const decay: string[] = [];
    const seenContentHashes = new Map<string, { id: string; importance: number }>(); // normalized content hash -> kept entry

    for (const entry of entries) {
      const importance = entry.importance ?? this.scoreImportance(entry);

      // Check retention by importance/age
      if (!this.shouldRetain({ ...entry, importance })) {
        decay.push(entry.id);
        continue;
      }

      // Check for duplicates / near-duplicates
      const normalizedContent = this.normalizeForDuplicateCheck(entry.content);
      const contentHash = this.simpleHash(normalizedContent);

      const existing = seenContentHashes.get(contentHash);
      if (existing !== undefined) {
        // Duplicate found — keep the higher-importance entry, decay the other.
        // Ties keep the earlier (already-seen) entry.
        if (importance > existing.importance) {
          // Current entry wins — decay the previously retained entry
          decay.push(existing.id);
          const idx = retain.indexOf(existing.id);
          if (idx >= 0) retain.splice(idx, 1);
          seenContentHashes.set(contentHash, { id: entry.id, importance });
          retain.push(entry.id);
        } else {
          decay.push(entry.id);
        }
        continue;
      }

      seenContentHashes.set(contentHash, { id: entry.id, importance });
      retain.push(entry.id);
    }

    return { retain, decay };
  }

  /**
   * 压缩旧记忆：保留首句 + 尾句，截断中间。
   */
  compressOldMemories(entries: CompressibleEntry[]): CompressedMemory[] {
    return entries.map((entry) => {
      const summary = this.compressContent(entry.content);
      return { id: entry.id, summary };
    });
  }

  // ── Private: Scoring Helpers ─────────────────────────────

  /**
   * Exponential decay with half-life of 7 days.
   * score = 0.5^(age / halfLife)
   * At age=0: score=1, at age=7: score=0.5, at age=14: score=0.25, etc.
   */
  private computeRecencyScore(ageDays: number): number {
    return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  }

  /**
   * Logarithmic access frequency score.
   * score = log(1 + accessCount) / log(1 + 100)
   * Normalized so that 100 accesses ≈ 1.0
   */
  private computeAccessScore(accessCount: number): number {
    return Math.log(1 + accessCount) / Math.log(101);
  }

  /**
   * Content length score: moderate length (100-500 chars) is optimal.
   * - < 100: linear ramp up from 0.2 to 1.0
   * - 100-500: 1.0 (optimal)
   * - > 500: linear ramp down from 1.0 to 0.3
   */
  private computeLengthScore(length: number): number {
    if (length < OPTIMAL_LENGTH_MIN) {
      return 0.2 + 0.8 * (length / OPTIMAL_LENGTH_MIN);
    }
    if (length <= OPTIMAL_LENGTH_MAX) {
      return 1.0;
    }
    // Ramp down for very long content
    const excess = length - OPTIMAL_LENGTH_MAX;
    return Math.max(0.3, 1.0 - excess / 2000);
  }

  /**
   * Type-based importance weight.
   */
  private computeTypeScore(type: string): number {
    return TYPE_WEIGHTS[type] ?? DEFAULT_TYPE_WEIGHT;
  }

  // ── Private: Duplicate Detection ─────────────────────────

  /**
   * Normalize content for duplicate comparison:
   * - lowercase, trim whitespace, collapse multiple spaces
   * - remove punctuation
   */
  private normalizeForDuplicateCheck(content: string): string {
    return content
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500); // Only compare first 500 chars for efficiency
  }

  /**
   * Cryptographic hash for content comparison (sha256).
   * The previous 32-bit rolling hash could collide on distinct content;
   * sha256 avoids false-positive duplicate detection.
   */
  private simpleHash(str: string): string {
    return crypto.createHash("sha256").update(str).digest("hex");
  }

  // ── Private: Compression ─────────────────────────────────

  /**
   * Compress content by keeping first sentence + last sentence, truncating middle.
   */
  private compressContent(content: string): string {
    const trimmed = content.trim();
    if (trimmed.length <= 200) {
      return trimmed;
    }

    // Split into sentences (handles both English and Chinese punctuation)
    const sentences = trimmed.split(/(?<=[.!?。！？\n])\s*/).filter((s) => s.trim().length > 0);

    if (sentences.length <= 2) {
      // Already very few sentences; just truncate
      return trimmed.slice(0, 150) + "...";
    }

    const firstSentence = sentences[0].trim();
    const lastSentence = sentences[sentences.length - 1].trim();

    const compressed = `${firstSentence} ... ${lastSentence}`;

    // If compression didn't actually shorten much, fall back to truncation
    if (compressed.length >= trimmed.length * 0.8) {
      return trimmed.slice(0, 150) + "...";
    }

    return compressed;
  }
}
