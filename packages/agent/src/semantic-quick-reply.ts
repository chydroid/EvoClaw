/**
 * Semantic quick-reply: use local Transformers embedding to classify user
 * intent by cosine similarity against pre-computed category centroids.
 *
 * This sits *after* the regex-based `tryQuickReply` and *before* the LLM
 * call. It catches messages that the regex table misses (e.g. paraphrased
 * greetings, longer phrasing like "你今天有没有空帮我看看") but are still
 * simple enough to answer without invoking the LLM.
 *
 * Design:
 *   1. On first call, embed a set of "template sentences" per category and
 *      cache the centroid vectors.
 *   2. For each incoming message, embed it and find the closest centroid.
 *   3. If the best score exceeds a threshold, return a quick reply from
 *      the same category reply pool used by `quick-reply.ts`.
 *   4. Fall through to LLM if no category matches.
 */

import type { PersonaConfig } from "@evoclaw/core";
import { __test } from "./quick-reply";

// ── Types ──────────────────────────────────────────────────────────────────

/** Minimal embedding provider interface (avoids cross-package import). */
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimensions?: number;
}

export interface SemanticQuickReplyConfig {
  /** Minimum cosine similarity to accept a category match (0–1). Default 0.45 */
  threshold?: number;
  /** Maximum message length (chars) to consider. Default 40 */
  maxMessageLength?: number;
}

interface CategoryCentroid {
  category: string;
  vector: number[];
}

// ── Template sentences per category ────────────────────────────────────────
// These are representative phrases that capture the *meaning* of each
// category. The embedding model encodes them; the centroid (average) of
// all template embeddings for a category becomes its representative vector.

const CATEGORY_TEMPLATES: Record<string, string[]> = {
  presence: [
    "你在吗", "你在不在", "在吗", "在线吗", "你还在吗",
    "are you there", "are you online", "you around",
  ],
  hello: [
    "你好", "嗨", "哈喽", "早上好", "晚上好", "下午好",
    "hello", "hi", "hey", "good morning", "good evening",
  ],
  identity: [
    "你是谁", "你叫什么", "介绍一下你自己", "你是什么", "你是哪个AI",
    "who are you", "what are you", "introduce yourself",
  ],
  status: [
    "你在忙吗", "你在干嘛", "忙不忙", "在忙啥", "有空吗",
    "are you busy", "what are you doing", "you free",
  ],
  howareyou: [
    "你今天怎么样", "你好吗", "心情怎么样", "你还好吗",
    "how are you", "how's it going", "how do you feel",
  ],
  thanks: [
    "谢谢", "感谢", "多谢", "辛苦了", "thx", "thank you",
  ],
  bye: [
    "再见", "拜拜", "走了", "睡了", "收工了", "bye", "goodbye",
  ],
  capability: [
    "你会什么", "你能做什么", "你有什么功能", "你有什么用",
    "what can you do", "your capabilities",
  ],
  mood: [
    "我好累", "好无聊", "好烦", "郁闷", "开心", "难过",
    "I'm tired", "so bored", "feeling down",
  ],
  worry: [
    "怎么办", "救命", "help me", "怎么解决", "咋办",
  ],
  laugh: [
    "哈哈哈", "笑死", "lol", "太好笑了",
  ],
  apology: [
    "不好意思", "抱歉", "对不起", "打扰了",
    "sorry", "my bad", "excuse me",
  ],
  ack: [
    "好的", "收到", "明白", "知道了", "ok", "sure",
  ],
  encourage: [
    "加油", "挺你", "支持你", "you can do it",
  ],
  hug: [
    "抱抱", "摸摸头", "亲亲", "hug me",
  ],
  // ── Action-oriented intent categories (for skill/tool routing) ──
  skill_install: [
    "帮我装一个翻译技能", "安装翻译技能", "装个技能", "安装一个skill",
    "帮我安装技能", "有没有翻译的技能", "找一个技能装上",
    "install a translate skill", "install a skill for me",
    "add a translation skill", "find and install a skill",
    "装一个天气技能", "安装新闻技能", "帮我装个邮件技能",
  ],
  action_task: [
    "帮我创建一个文件", "搜索一下天气", "读取这个文件", "帮我翻译这段话",
    "帮我抓取网页内容", "执行这个脚本", "帮我发一封邮件",
    "create a file for me", "search the weather", "read this file",
    "translate this for me", "fetch the webpage", "run this script",
    "帮我写一段代码", "生成一个报告", "下载这个文件",
    "帮我分析一下数据", "总结一下这篇文章",
  ],
};

// ── Cosine similarity ──────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ── SemanticQuickReply ─────────────────────────────────────────────────────

export class SemanticQuickReply {
  private provider: EmbeddingProvider | null = null;
  private centroids: CategoryCentroid[] = [];
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private threshold: number;
  private maxMessageLength: number;

  constructor(config?: SemanticQuickReplyConfig) {
    this.threshold = config?.threshold ?? 0.45;
    this.maxMessageLength = config?.maxMessageLength ?? 40;
  }

  /**
   * Set the embedding provider. Must be called before first `classify()`.
   * If the provider is not ready (e.g. model not loaded), classify() will
   * gracefully fall through and return null.
   */
  setProvider(provider: EmbeddingProvider): void {
    this.provider = provider;
    this.initialized = false;
    this.centroids = [];
    this.initPromise = null;
  }

  /**
   * Pre-compute category centroids. Called lazily on first classify().
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this._initialize();
    await this.initPromise;
  }

  private async _initialize(): Promise<void> {
    if (!this.provider) {
      console.log(`[SemanticQuickReply] No provider, skipping init`);
      this.initialized = true;
      return;
    }

    try {
      const newCentroids: CategoryCentroid[] = [];

      for (const [category, templates] of Object.entries(CATEGORY_TEMPLATES)) {
        // Embed all templates for this category
        const vectors: number[][] = [];
        for (const tmpl of templates) {
          try {
            const vec = await this.provider.embed(tmpl);
            vectors.push(vec);
          } catch (err) {
            // Skip failed embeddings — still compute centroid from remaining
            console.warn(`[SemanticQuickReply] Failed to embed template "${tmpl}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (vectors.length === 0) continue;

        // Compute centroid (element-wise average)
        const dim = vectors[0].length;
        const centroid = new Array(dim).fill(0);
        for (const vec of vectors) {
          for (let i = 0; i < dim; i++) {
            centroid[i] += vec[i];
          }
        }
        for (let i = 0; i < dim; i++) {
          centroid[i] /= vectors.length;
        }

        newCentroids.push({ category, vector: centroid });
      }

      this.centroids = newCentroids;
      console.log(`[SemanticQuickReply] Initialized: ${this.centroids.length} category centroids`);
    } catch (err) {
      // Non-fatal: semantic quick reply is best-effort
      console.warn(`[SemanticQuickReply] Init failed: ${err instanceof Error ? err.message : String(err)}`);
      this.centroids = [];
    }

    this.initialized = true;
  }

  /**
   * Classify a user message and return a quick reply if it matches a known
   * category with sufficient confidence. Returns null if no match (caller
   * should fall through to LLM).
   */
  async classify(message: string, persona: PersonaConfig): Promise<string | null> {
    // Skip if too long or too short
    const trimmed = message.trim();
    if (trimmed.length < 1 || trimmed.length > this.maxMessageLength) return null;

    // Skip if provider not available
    if (!this.provider) return null;

    // Ensure centroids are computed
    await this.initialize();
    if (this.centroids.length === 0) {
      console.log(`[SemanticQuickReply] No centroids available, skipping classify`);
      return null;
    }

    // Embed the user message
    let msgVec: number[];
    try {
      msgVec = await this.provider.embed(trimmed);
    } catch {
      return null;
    }

    // Find best matching centroid
    let bestCategory: string | null = null;
    let bestScore = -1;
    const scores: Array<{ category: string; score: number }> = [];
    for (const centroid of this.centroids) {
      const score = cosineSimilarity(msgVec, centroid.vector);
      scores.push({ category: centroid.category, score });
      if (score > bestScore) {
        bestScore = score;
        bestCategory = centroid.category;
      }
    }
    // Log top-3 scores for debugging
    scores.sort((a, b) => b.score - a.score);
    const top3 = scores.slice(0, 3).map((s) => `${s.category}=${s.score.toFixed(4)}`).join(", ");
    console.log(`[SemanticQuickReply] "${trimmed.slice(0, 30)}" → top3: ${top3}`);

    if (!bestCategory || bestScore < this.threshold) return null;

    console.log(`[SemanticQuickReply] Matched category="${bestCategory}" score=${bestScore.toFixed(4)} for "${trimmed.slice(0, 30)}"`);

    // Find the reply pool for this category from the regex-based table
    const entry = __test.SIMPLE_GREETING_ENTRIES.find((e: { category: string }) => e.category === bestCategory);
    if (!entry) return null;

    // Pick a reply using the same hash-based picker for consistency
    const reply = __test.pickByHash(entry.replies, trimmed);
    const mt = persona.masterTerm || "主人";
    const me = persona.name || "EvoClaw";
    return reply.replace(/MT/g, mt).replace(/ME/g, me);
  }

  /**
   * Classify user intent for routing purposes (not for quick-reply).
   * Returns the best matching category and its confidence score, or null if
   * no category exceeds the threshold. This is used by the agent to decide
   * whether to auto-trigger skill_search, route to tools, etc.
   */
  async classifyIntent(message: string): Promise<{ category: string; score: number } | null> {
    const trimmed = message.trim();
    if (trimmed.length < 2) return null;
    if (!this.provider) return null;

    await this.initialize();
    if (this.centroids.length === 0) return null;

    let msgVec: number[];
    try { msgVec = await this.provider.embed(trimmed); } catch { return null; }

    let bestCategory: string | null = null;
    let bestScore = -1;
    for (const centroid of this.centroids) {
      const score = cosineSimilarity(msgVec, centroid.vector);
      if (score > bestScore) {
        bestScore = score;
        bestCategory = centroid.category;
      }
    }

    if (!bestCategory || bestScore < this.threshold) return null;
    return { category: bestCategory, score: bestScore };
  }

  /** Expose state for diagnostics */
  getStatus(): { initialized: boolean; centroidCount: number; provider: boolean; threshold: number } {
    return {
      initialized: this.initialized,
      centroidCount: this.centroids.length,
      provider: !!this.provider,
      threshold: this.threshold,
    };
  }
}
