/**
 * Memory Match — 记忆写入闸门的唯一匹配器（P4）。
 *
 * 对标 Hermes `memory_tool_store.py:96-165` 的不变量：
 * - 删除/替换必须命中**唯一**目标；
 * - 整条精确匹配（content === old_string）优先于子串匹配；
 * - 子串跨条目歧义时必须返回候选，让模型自我纠正；
 * - 无匹配时返回「最近条目」，而不是一句冰冷的 not found。
 */

/** 匹配所需的最小条目形状 */
export interface MemoryMatchTarget {
  id: string;
  content: string;
}

/** 返回给模型/用户的候选（内容截断，避免把整库记忆回灌进上下文） */
export interface MemoryMatchCandidate {
  id: string;
  content: string;
}

export type MemoryMatchOutcome<T extends MemoryMatchTarget> =
  | { status: "matched"; entry: T; exact: boolean }
  | { status: "ambiguous"; candidates: MemoryMatchCandidate[] }
  | { status: "not_found"; nearest?: MemoryMatchCandidate };

/** 最近条目的扫描上限：避免超大记忆库把一次 not_found 变成 O(n) 全文打分 */
const MAX_NEAREST_SCAN = 500;
/** 候选内容截断长度 */
const CANDIDATE_EXCERPT_LEN = 200;

function excerpt(content: string): string {
  return content.length > CANDIDATE_EXCERPT_LEN
    ? content.slice(0, CANDIDATE_EXCERPT_LEN) + "…"
    : content;
}

/** 字符二元组集合（CJK 与英文通用，不需要分词依赖） */
function bigrams(input: string): Set<string> {
  const s = input.toLowerCase();
  const set = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 简单 bigram 相似度（0..1）；用于无匹配时给出「最近条目」 */
export function memorySimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const gram of A) {
    if (B.has(gram)) common++;
  }
  return common / Math.min(A.size, B.size);
}

/**
 * 查找唯一匹配条目。
 *
 * 顺序：整条精确匹配 → 子串匹配。
 * - 精确匹配恰好 1 条：matched(exact=true)
 * - 子串匹配恰好 1 条：matched(exact=false)
 * - 多条：ambiguous（附候选）
 * - 0 条：not_found（附最近条目）
 */
export function findUniqueMemoryMatch<T extends MemoryMatchTarget>(
  entries: readonly T[],
  oldString: string,
): MemoryMatchOutcome<T> {
  const needle = oldString;
  if (!needle) return { status: "not_found" };

  const exact = entries.filter((e) => e.content === needle);
  if (exact.length === 1) return { status: "matched", entry: exact[0], exact: true };
  if (exact.length > 1) {
    return { status: "ambiguous", candidates: exact.map((e) => ({ id: e.id, content: excerpt(e.content) })) };
  }

  const substring = entries.filter((e) => e.content.includes(needle));
  if (substring.length === 1) return { status: "matched", entry: substring[0], exact: false };
  if (substring.length > 1) {
    return { status: "ambiguous", candidates: substring.map((e) => ({ id: e.id, content: excerpt(e.content) })) };
  }

  return { status: "not_found", nearest: findNearestMemory(entries, needle) };
}

/** 无匹配时返回最近条目（bigram 相似度最高的前 1 条） */
export function findNearestMemory<T extends MemoryMatchTarget>(
  entries: readonly T[],
  needle: string,
): MemoryMatchCandidate | undefined {
  if (!needle || entries.length === 0) return undefined;
  let best: T | undefined;
  let bestScore = 0;
  const scan = entries.slice(0, MAX_NEAREST_SCAN);
  for (const entry of scan) {
    const score = memorySimilarity(entry.content, needle);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  if (!best || bestScore <= 0) return undefined;
  return { id: best.id, content: excerpt(best.content) };
}

/** 统计子串出现次数（用于 patch 的 old_string 必须恰好出现一次） */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}
