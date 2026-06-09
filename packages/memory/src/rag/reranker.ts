// ─── Simple Reranker for RAG ─────────────────────────────────────────────────

export interface RerankInput {
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface RerankResult {
  text: string;
  score: number;
  metadata: Record<string, unknown>;
  originalScore: number;
}

// Common English stop words
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
  "neither", "each", "every", "all", "any", "few", "more", "most", "other",
  "some", "such", "no", "only", "own", "same", "than", "too", "very",
  "just", "because", "if", "when", "where", "how", "what", "which", "who",
  "that", "this", "these", "those", "i", "me", "my", "we", "our", "you",
  "your", "he", "him", "his", "she", "her", "it", "its", "they", "them",
]);

// CJK Unified Ideographs range
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * Tokenize text into tokens, handling both English and Chinese text.
 * - English: lowercase, split on non-alphanumeric, filter stop words
 * - Chinese: each CJK character becomes a separate token
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();

  let i = 0;
  let buffer = "";

  while (i < lower.length) {
    const ch = lower[i];

    if (CJK_REGEX.test(ch)) {
      // Flush any buffered alphanumeric token
      if (buffer.length > 1 && !STOP_WORDS.has(buffer)) {
        tokens.add(buffer);
      }
      buffer = "";
      // Each CJK character is a token
      tokens.add(ch);
    } else if (/[a-z0-9]/.test(ch)) {
      buffer += ch;
    } else {
      // Non-alphanumeric, non-CJK: flush buffer
      if (buffer.length > 1 && !STOP_WORDS.has(buffer)) {
        tokens.add(buffer);
      }
      buffer = "";
    }

    i++;
  }

  // Flush remaining buffer
  if (buffer.length > 1 && !STOP_WORDS.has(buffer)) {
    tokens.add(buffer);
  }

  return tokens;
}

/**
 * Compute Jaccard similarity between two sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export class SimpleReranker {
  /**
   * Rerank results by combining embedding similarity with keyword overlap signals.
   * Final score = 0.7 * embeddingScore + 0.3 * keywordOverlapScore
   */
  rerank(query: string, results: RerankInput[]): RerankResult[] {
    const queryTokens = tokenize(query);

    const scored = results.map((result) => {
      const chunkTokens = tokenize(result.text);
      const keywordScore = jaccardSimilarity(queryTokens, chunkTokens);
      const finalScore = 0.7 * result.score + 0.3 * keywordScore;

      return {
        text: result.text,
        score: finalScore,
        metadata: result.metadata,
        originalScore: result.score,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }
}
