/**
 * L1 智能去重 — 3 层降级策略。
 *
 * 借鉴 TencentDB-Agent-Memory 的 `src/core/record/l1-dedup.ts`：
 *   第 1 层：findCandidatesByVector — 批量 embedding 召回相似记忆
 *   第 2 层：findCandidatesByFts — 使用关键词检索（jieba 分词 + BM25）
 *   第 3 层：skip dedup — 前两层失败时跳过去重（不阻塞写入）
 *
 * 支持 4 种 action：
 *   - store：新记忆，直接存
 *   - update：替换已有记忆（更高优先级）
 *   - merge：合并到已有记忆（保留双方信息）
 *   - skip：跳过（重复）
 *
 * 解决问题：L1 提取器无去重，会产生大量重复记忆（"我喜欢 TypeScript" 出现 10 次）。
 */

import type { AtomicMemory } from "./atomic-memory-extractor";

/** 去重决策动作。 */
export type DedupAction = "store" | "update" | "merge" | "skip";

/** 去重决策结果。 */
export interface DedupDecision {
  /** 动作。 */
  action: DedupAction;
  /** 匹配到的已有记忆 ID（update/merge/skip 时有值）。 */
  existingId?: string;
  /** 相似度分数（0-1）。 */
  similarity?: number;
  /** 匹配策略：vector / fts / keyword / none。 */
  matchedBy?: "vector" | "fts" | "keyword" | "none";
  /** 决策理由（调试用）。 */
  reason?: string;
}

/** 去重配置。 */
export interface L1DedupOptions {
  /** 第 1 层：向量相似度阈值（>= 此值视为重复）。默认 0.85。 */
  vectorThreshold?: number;
  /** 第 2 层：FTS/关键词匹配阈值（共享关键词比例 >= 此值视为重复）。默认 0.6。 */
  ftsThreshold?: number;
  /** 第 3 层：简单关键词匹配阈值。默认 0.7。 */
  keywordThreshold?: number;
  /** skip 动作的相似度阈值（>= 此值直接跳过）。默认 0.95。 */
  skipThreshold?: number;
  /** 是否启用向量去重（需要 embedding 服务）。默认 false（无 embedding 时降级）。 */
  enableVectorDedup?: boolean;
}

const DEFAULT_OPTIONS: Required<L1DedupOptions> = {
  vectorThreshold: 0.85,
  ftsThreshold: 0.6,
  keywordThreshold: 0.7,
  skipThreshold: 0.95,
  enableVectorDedup: false,
};

/** Embedding 函数类型（可选注入）。 */
export type EmbedFn = (text: string) => Promise<number[] | null>;

/**
 * L1 智能去重器。
 *
 * 使用方式：
 *   const dedup = new L1Dedupifier(existingMemories);
 *   const decision = await dedup.check(newMemory);
 *   if (decision.action === "store") { ... }
 */
export class L1Dedupifier {
  private opts: Required<L1DedupOptions>;
  private existingMemories: AtomicMemory[];
  private embedFn?: EmbedFn;

  constructor(
    existingMemories: AtomicMemory[],
    options?: L1DedupOptions,
    embedFn?: EmbedFn
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.existingMemories = existingMemories;
    this.embedFn = embedFn;
  }

  /** 更新已有记忆列表（写入后调用）。 */
  updateExisting(memories: AtomicMemory[]): void {
    this.existingMemories = memories;
  }

  /**
   * 检查新记忆是否与已有记忆重复。
   * 3 层降级：向量 → FTS/关键词 → 跳过。
   */
  async check(newMemory: AtomicMemory): Promise<DedupDecision> {
    if (this.existingMemories.length === 0) {
      return { action: "store", matchedBy: "none", reason: "no existing memories" };
    }

    // 第 1 层：向量去重（可选）
    if (this.opts.enableVectorDedup && this.embedFn) {
      try {
        const decision = await this.checkByVector(newMemory);
        if (decision.matchedBy === "vector") return decision;
      } catch {
        // 向量去重失败，降级到 FTS
      }
    }

    // 第 2 层：FTS / 关键词去重
    const ftsDecision = this.checkByFts(newMemory);
    if (ftsDecision.matchedBy === "fts") return ftsDecision;

    // 第 3 层：简单关键词去重
    const kwDecision = this.checkByKeyword(newMemory);
    if (kwDecision.matchedBy === "keyword") return kwDecision;

    return { action: "store", matchedBy: "none", reason: "no match" };
  }

  /** 批量检查多个新记忆。 */
  async checkBatch(newMemories: AtomicMemory[]): Promise<Array<{ memory: AtomicMemory; decision: DedupDecision }>> {
    const results: Array<{ memory: AtomicMemory; decision: DedupDecision }> = [];
    for (const mem of newMemories) {
      const decision = await this.check(mem);
      results.push({ memory: mem, decision });
    }
    return results;
  }

  // ── 私有：第 1 层 向量去重 ──

  private async checkByVector(newMemory: AtomicMemory): Promise<DedupDecision> {
    if (!this.embedFn) return { action: "store", matchedBy: "none" };

    const newVec = await this.embedFn(newMemory.content);
    if (!newVec) return { action: "store", matchedBy: "none" };

    let bestSim = 0;
    let bestId: string | undefined;
    for (const existing of this.existingMemories) {
      const existingVec = await this.embedFn(existing.content);
      if (!existingVec) continue;
      const sim = cosineSimilarity(newVec, existingVec);
      if (sim > bestSim) {
        bestSim = sim;
        bestId = existing.id;
      }
    }

    if (bestSim >= this.opts.skipThreshold && bestId) {
      return {
        action: "skip",
        existingId: bestId,
        similarity: bestSim,
        matchedBy: "vector",
        reason: `vector similarity ${bestSim.toFixed(3)} >= skip threshold`,
      };
    }
    if (bestSim >= this.opts.vectorThreshold && bestId) {
      // 高相似但不到 skip：根据优先级决定 update / merge
      const existing = this.existingMemories.find((m) => m.id === bestId);
      if (existing && newMemory.priority > existing.priority) {
        return {
          action: "update",
          existingId: bestId,
          similarity: bestSim,
          matchedBy: "vector",
          reason: `vector sim ${bestSim.toFixed(3)}, new priority higher`,
        };
      }
      return {
        action: "merge",
        existingId: bestId,
        similarity: bestSim,
        matchedBy: "vector",
        reason: `vector sim ${bestSim.toFixed(3)}, merge`,
      };
    }
    return { action: "store", matchedBy: "none" };
  }

  // ── 私有：第 2 层 FTS/关键词去重 ──

  private checkByFts(newMemory: AtomicMemory): DedupDecision {
    const newKeywords = extractKeywords(newMemory.content);
    if (newKeywords.size === 0) return { action: "store", matchedBy: "none" };

    let bestOverlap = 0;
    let bestId: string | undefined;
    let bestRatio = 0;
    for (const existing of this.existingMemories) {
      const existingKeywords = extractKeywords(existing.content);
      if (existingKeywords.size === 0) continue;
      let overlap = 0;
      for (const k of newKeywords) {
        if (existingKeywords.has(k)) overlap++;
      }
      // Jaccard 相似度
      const union = newKeywords.size + existingKeywords.size - overlap;
      const ratio = union > 0 ? overlap / union : 0;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestOverlap = overlap;
        bestId = existing.id;
      }
    }

    if (bestRatio >= this.opts.skipThreshold && bestId) {
      return {
        action: "skip",
        existingId: bestId,
        similarity: bestRatio,
        matchedBy: "fts",
        reason: `fts jaccard ${bestRatio.toFixed(3)} >= skip threshold, overlap ${bestOverlap}`,
      };
    }
    if (bestRatio >= this.opts.ftsThreshold && bestId) {
      const existing = this.existingMemories.find((m) => m.id === bestId);
      if (existing && newMemory.priority > existing.priority) {
        return {
          action: "update",
          existingId: bestId,
          similarity: bestRatio,
          matchedBy: "fts",
          reason: `fts jaccard ${bestRatio.toFixed(3)}, new priority higher`,
        };
      }
      return {
        action: "merge",
        existingId: bestId,
        similarity: bestRatio,
        matchedBy: "fts",
        reason: `fts jaccard ${bestRatio.toFixed(3)}, merge`,
      };
    }
    return { action: "store", matchedBy: "none" };
  }

  // ── 私有：第 3 层 简单关键词去重 ──

  private checkByKeyword(newMemory: AtomicMemory): DedupDecision {
    // 完全相同内容 → skip
    for (const existing of this.existingMemories) {
      if (existing.content.trim() === newMemory.content.trim()) {
        return {
          action: "skip",
          existingId: existing.id,
          similarity: 1.0,
          matchedBy: "keyword",
          reason: "exact content match",
        };
      }
    }

    // 内容包含关系 → 高度怀疑重复
    for (const existing of this.existingMemories) {
      const a = existing.content.trim();
      const b = newMemory.content.trim();
      if (a.length > 10 && b.length > 10) {
        if (a.includes(b) || b.includes(a)) {
          const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
          if (ratio >= this.opts.keywordThreshold) {
            if (newMemory.priority > existing.priority) {
              return {
                action: "update",
                existingId: existing.id,
                similarity: ratio,
                matchedBy: "keyword",
                reason: `content inclusion, ratio ${ratio.toFixed(3)}`,
              };
            }
            return {
              action: "skip",
              existingId: existing.id,
              similarity: ratio,
              matchedBy: "keyword",
              reason: `content inclusion, ratio ${ratio.toFixed(3)}`,
            };
          }
        }
      }
    }

    return { action: "store", matchedBy: "none" };
  }
}

// ── 辅助函数 ──

/** 余弦相似度。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/** 关键词提取（中英双语，简单分词）。 */
export function extractKeywords(text: string): Set<string> {
  const keywords = new Set<string>();
  if (!text) return keywords;
  // 英文单词（>=4 字符，过滤停用词）
  const en = text.match(/\b[a-zA-Z][a-zA-Z0-9_-]{3,}\b/g);
  if (en) {
    for (const w of en) {
      if (!/^(?:that|this|with|from|have|they|will|your|their|what|when|which|where|while|user)$/.test(w)) {
        keywords.add(w.toLowerCase());
      }
    }
  }
  // 中文连续 2-4 字片段
  const cn = text.match(/[\u4e00-\u9fff]{2,4}/g);
  if (cn) {
    for (const w of cn) keywords.add(w);
  }
  return keywords;
}

/**
 * 把去重决策应用到记忆列表（返回新列表 + 应用统计）。
 */
export function applyDedupDecisions(
  existing: AtomicMemory[],
  newMemories: AtomicMemory[],
  decisions: Array<{ memory: AtomicMemory; decision: DedupDecision }>
): {
  merged: AtomicMemory[];
  stats: { stored: number; updated: number; merged: number; skipped: number };
} {
  const result = [...existing];
  const stats = { stored: 0, updated: 0, merged: 0, skipped: 0 };

  for (const { memory, decision } of decisions) {
    switch (decision.action) {
      case "store":
        result.push(memory);
        stats.stored++;
        break;
      case "update": {
        const idx = result.findIndex((m) => m.id === decision.existingId);
        if (idx >= 0) {
          result[idx] = {
            ...memory,
            id: result[idx].id, // 保留原 ID
            sourceMessageIds: [...result[idx].sourceMessageIds, ...memory.sourceMessageIds],
          };
        } else {
          result.push(memory);
        }
        stats.updated++;
        break;
      }
      case "merge": {
        const idx = result.findIndex((m) => m.id === decision.existingId);
        if (idx >= 0) {
          result[idx] = {
            ...result[idx],
            content: `${result[idx].content} | ${memory.content}`,
            priority: Math.max(result[idx].priority, memory.priority),
            sourceMessageIds: [...result[idx].sourceMessageIds, ...memory.sourceMessageIds],
          };
        } else {
          result.push(memory);
        }
        stats.merged++;
        break;
      }
      case "skip":
        stats.skipped++;
        break;
    }
  }

  return { merged: result, stats };
}
