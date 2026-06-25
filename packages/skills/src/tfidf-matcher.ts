/**
 * TF-IDF Semantic Matcher
 * 
 * Shared utility for semantic text matching using TF-IDF vectors.
 * Used by AutoSkillManager for task-to-skill matching,
 * and can be used by other modules for intent detection.
 */

export interface TfidfMatchResult {
  target: string;      // matched item name/identifier
  score: number;       // 0-1 relevance score
  matchedTerms: string[];
  source: string;      // description snippet
}

export class TfidfMatcher {
  private documentFrequency = new Map<string, number>();
  private docVectors: Array<{ id: string; vector: Map<string, number>; metadata: Record<string, string> }> = [];
  private initialized = false;

  private static readonly STOP_WORDS = new Set([
    // Chinese stopwords
    "的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一", "一个",
    "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好",
    "自己", "这", "他", "她", "它", "们", "那", "些", "什么", "怎么", "如何",
    "可以", "能", "请", "帮", "让", "把", "被", "从", "对", "为", "以", "及",
    "但", "而", "与", "或", "如果", "因为", "所以", "虽然", "但是",
    // English stopwords
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
    "her", "was", "one", "our", "out", "has", "have", "from", "this",
    "that", "with", "will", "been", "they", "their", "which", "would",
    "there", "could", "other", "into", "more", "some", "than", "its",
    "over", "such", "after", "just", "also", "about", "want", "need",
    "help", "please", "like", "does", "make", "when", "what", "how",
    "where", "who", "why", "your", "them", "then", "only", "very",
  ]);

  /**
   * Initialize the matcher with a corpus of documents
   */
  initialize(documents: Array<{ id: string; text: string; metadata?: Record<string, string> }>): void {
    this.docVectors = [];
    this.documentFrequency.clear();

    // Compute TF for each document
    for (const doc of documents) {
      const vector = this.computeTf(doc.text);
      this.docVectors.push({ id: doc.id, vector, metadata: doc.metadata || {} });
    }

    // Compute IDF
    const allTerms = new Set<string>();
    for (const doc of this.docVectors) {
      for (const term of doc.vector.keys()) {
        allTerms.add(term);
      }
    }

    const numDocs = documents.length || 1;
    for (const term of allTerms) {
      let docCount = 0;
      for (const doc of this.docVectors) {
        if (doc.vector.has(term)) docCount++;
      }
      this.documentFrequency.set(term, Math.log(numDocs / (docCount + 1)));
    }

    this.initialized = true;
  }

  /**
   * Find best matching documents for a query
   */
  search(query: string, minScore = 0.1, maxResults = 10): TfidfMatchResult[] {
    if (!this.initialized || this.docVectors.length === 0) return [];

    const queryVector = this.computeTfidf(query);
    const results: TfidfMatchResult[] = [];

    for (const doc of this.docVectors) {
      const docVector = this.tfToTfidf(doc.vector);
      const similarity = this.cosineSimilarity(queryVector, docVector);
      
      if (similarity >= minScore) {
        // Find matching terms
        const matchedTerms: string[] = [];
        for (const [term] of queryVector) {
          if (doc.vector.has(term)) matchedTerms.push(term);
        }

        results.push({
          target: doc.id,
          score: similarity,
          matchedTerms,
          source: doc.metadata?.description || doc.metadata?.source || '',
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  /**
   * Compute TF-IDF vector for a query text
   */
  private computeTfidf(text: string): Map<string, number> {
    const tf = this.computeTf(text);
    return this.tfToTfidf(tf);
  }

  /**
   * Convert a term-frequency map to TF-IDF vector
   */
  private tfToTfidf(tf: Map<string, number>): Map<string, number> {
    const tfidf = new Map<string, number>();
    const totalTerms = this.docVectors.length || 1;

    for (const [term, tfValue] of tf) {
      const idf = this.documentFrequency.get(term) || Math.log(totalTerms);
      tfidf.set(term, tfValue * idf);
    }

    return tfidf;
  }

  /**
   * Compute term frequency
   */
  private computeTf(text: string): Map<string, number> {
    const terms = this.tokenize(text);
    const tf = new Map<string, number>();
    const total = terms.length || 1;

    for (const term of terms) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }

    // Normalize
    for (const [term, count] of tf) {
      tf.set(term, count / total);
    }

    return tf;
  }

  /**
   * Tokenize text (Chinese + English mixed)
   */
  private tokenize(text: string): string[] {
    const terms: string[] = [];
    const lower = text.toLowerCase();

    // Chinese: extract 2-4 char n-grams
    const chineseChars = lower.match(/[\u4e00-\u9fff]+/g) || [];
    for (const segment of chineseChars) {
      if (segment.length >= 2) terms.push(segment);
      // Bigrams for partial matching
      for (let i = 0; i <= segment.length - 2; i++) {
        terms.push(segment.substring(i, i + 2));
      }
      // Trigrams for 3+ character words
      for (let i = 0; i <= segment.length - 3; i++) {
        terms.push(segment.substring(i, i + 3));
      }
    }

    // English words
    const englishWords = lower.match(/[a-z][a-z0-9]{1,}/g) || [];
    terms.push(...englishWords);

    // Split on punctuation for mixed terms
    const segments = lower.split(/[\s,.;:!?()\[\]{}""''<>，。！？、；：（）【】《》""'']+/)
      .filter(s => s.length >= 2);
    terms.push(...segments);

    // Filter stopwords
    return terms.filter(t => !TfidfMatcher.STOP_WORDS.has(t) && t.length >= 2);
  }

  /**
   * Cosine similarity between two vectors
   */
  private cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
    if (a.size === 0 || b.size === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (const [term, valueA] of a) {
      const valueB = b.get(term) || 0;
      dotProduct += valueA * valueB;
      normA += valueA * valueA;
    }

    for (const valueB of b.values()) {
      normB += valueB * valueB;
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Simple keyword match (fast pre-filter before TF-IDF)
   */
  static keywordScore(query: string, target: string): number {
    const queryLower = query.toLowerCase();
    const targetLower = target.toLowerCase();
    
    // Exact match
    if (targetLower.includes(queryLower) || queryLower.includes(targetLower)) {
      return 1.0;
    }

    // Word-level matching
    const queryWords = queryLower.split(/[\s,.;:!?()\[\]{}""''<>，。！？、；：（）【】《》""'']+/)
      .filter(w => w.length >= 2);
    const targetWords = new Set(
      targetLower.split(/[\s,.;:!?()\[\]{}""''<>，。！？、；：（）【】《》""'']+/)
        .filter(w => w.length >= 2)
    );

    let matchCount = 0;
    for (const word of queryWords) {
      if (targetWords.has(word)) matchCount++;
    }

    return queryWords.length > 0 ? matchCount / queryWords.length : 0;
  }
}