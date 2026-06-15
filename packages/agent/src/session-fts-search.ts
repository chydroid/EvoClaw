// ── Session FTS5 Search ──
// Hermes 0.16 引入: SQLite FTS5 全文本搜索会话
// 在EvoClaw中使用纯内存实现以避免SQLite依赖

/** 索引文档 */
export interface IndexedMessage {
  id: string;
  sessionId: string;
  userId?: string;
  channel?: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tokens: string[]; // 分词结果
  createdAt: number;
}

/** 搜索结果 */
export interface FTSResult {
  message: IndexedMessage;
  /** BM25-like 相关性分数, 越高越相关 */
  score: number;
  /** 匹配的token */
  matchedTokens: string[];
  /** 高亮后的内容片段 */
  snippet: string;
}

/** 配置 */
export interface SessionFTSSearchConfig {
  /** 保留多少个token的snippet */
  snippetLength?: number;
  /** 停用词 */
  stopWords?: string[];
  /** 中文/英文混合分词 */
  enableChineseTokenize?: boolean;
}

/**
 * 内存版 FTS5 风格的会话搜索
 * - 倒排索引
 * - BM25-like 相关性评分
 * - 支持中英文混合分词
 */
export class SessionFTSSearch {
  private config: Required<SessionFTSSearchConfig>;
  /** token -> 出现该token的message IDs */
  private invertedIndex = new Map<string, Set<string>>();
  /** message ID -> IndexedMessage */
  private documents = new Map<string, IndexedMessage>();
  /** 每个token在每个message中的tf (term frequency) */
  private tfCache = new Map<string, Map<string, number>>();
  /** 文档总数 (用于IDF) */
  private docCount = 0;
  /** 平均文档长度 */
  private avgDocLength = 0;
  private totalLength = 0;

  constructor(config: Partial<SessionFTSSearchConfig> = {}) {
    this.config = {
      snippetLength: config.snippetLength ?? 200,
      stopWords: config.stopWords ?? [
        "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
        "in", "on", "at", "to", "for", "of", "with", "by", "from",
        "的", "了", "是", "在", "我", "你", "他", "她", "它", "们", "和", "与", "或", "但", "而",
      ],
      enableChineseTokenize: config.enableChineseTokenize ?? true,
    };
  }

  /** 索引一条消息 */
  index(message: IndexedMessage): void {
    // 如果已存在,先移除旧索引
    if (this.documents.has(message.id)) {
      this.remove(message.id);
    }
    const tokens = this.tokenize(message.content);
    message.tokens = tokens;
    this.documents.set(message.id, message);
    // 倒排索引
    const tfMap = new Map<string, number>();
    for (const token of tokens) {
      if (!this.invertedIndex.has(token)) this.invertedIndex.set(token, new Set());
      this.invertedIndex.get(token)!.add(message.id);
      tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
    }
    this.tfCache.set(message.id, tfMap);
    this.docCount++;
    this.totalLength += tokens.length;
    this.avgDocLength = this.totalLength / this.docCount;
  }

  /** 批量索引 */
  indexBatch(messages: IndexedMessage[]): void {
    for (const m of messages) this.index(m);
  }

  /** 移除索引 */
  remove(id: string): boolean {
    const doc = this.documents.get(id);
    if (!doc) return false;
    for (const token of doc.tokens) {
      const set = this.invertedIndex.get(token);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.invertedIndex.delete(token);
      }
    }
    this.tfCache.delete(id);
    this.documents.delete(id);
    this.docCount--;
    this.totalLength -= doc.tokens.length;
    this.avgDocLength = this.docCount > 0 ? this.totalLength / this.docCount : 0;
    return true;
  }

  /** 搜索 */
  search(query: string, options?: {
    sessionId?: string;
    userId?: string;
    channel?: string;
    role?: IndexedMessage["role"];
    limit?: number;
  }): FTSResult[] {
    if (!query.trim()) return [];
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return [];

    // 收集候选documents
    const candidates = new Map<string, { matchedTokens: Set<string> }>();
    for (const qt of queryTokens) {
      const postings = this.invertedIndex.get(qt);
      if (!postings) continue;
      for (const id of postings) {
        if (!candidates.has(id)) {
          candidates.set(id, { matchedTokens: new Set() });
        }
        candidates.get(id)!.matchedTokens.add(qt);
      }
    }
    if (candidates.size === 0) return [];

    // 过滤 + BM25评分
    const results: FTSResult[] = [];
    const k1 = 1.2;
    const b = 0.75;
    for (const [id, info] of candidates.entries()) {
      const doc = this.documents.get(id);
      if (!doc) continue;
      // 应用过滤器
      if (options?.sessionId && doc.sessionId !== options.sessionId) continue;
      if (options?.userId && doc.userId !== options.userId) continue;
      if (options?.channel && doc.channel !== options.channel) continue;
      if (options?.role && doc.role !== options.role) continue;

      let score = 0;
      const tfMap = this.tfCache.get(id) ?? new Map();
      const docLen = doc.tokens.length;
      for (const qt of queryTokens) {
        const tf = tfMap.get(qt) ?? 0;
        if (tf === 0) continue;
        const df = this.invertedIndex.get(qt)?.size ?? 1;
        const idf = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));
        const norm = 1 - b + b * (docLen / Math.max(1, this.avgDocLength));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * norm));
      }
      if (score > 0) {
        results.push({
          message: doc,
          score,
          matchedTokens: Array.from(info.matchedTokens),
          snippet: this.buildSnippet(doc.content, queryTokens),
        });
      }
    }
    // 按分数排序
    results.sort((a, b) => b.score - a.score);
    return options?.limit ? results.slice(0, options.limit) : results;
  }

  /** 获取统计 */
  getStats() {
    return {
      indexedCount: this.documents.size,
      uniqueTokens: this.invertedIndex.size,
      avgDocLength: this.avgDocLength,
    };
  }

  /** 清空 */
  clear(): void {
    this.invertedIndex.clear();
    this.documents.clear();
    this.tfCache.clear();
    this.docCount = 0;
    this.avgDocLength = 0;
    this.totalLength = 0;
  }

  /** 分词(支持中英文) */
  private tokenize(text: string): string[] {
    if (!text) return [];
    const lower = text.toLowerCase();
    const tokens: string[] = [];
    // 1) 提取英文单词+数字
    const enMatches = lower.match(/[a-z0-9_\-]+/g);
    if (enMatches) {
      for (const t of enMatches) {
        if (t.length >= 1 && !this.config.stopWords.includes(t)) {
          tokens.push(t);
        }
      }
    }
    // 2) 中文/日文/韩文分字(unigram)
    if (this.config.enableChineseTokenize) {
      const cjkMatches = lower.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g);
      if (cjkMatches) {
        for (const c of cjkMatches) {
          if (!this.config.stopWords.includes(c)) tokens.push(c);
        }
      }
    }
    return tokens;
  }

  /** 构建高亮snippet */
  private buildSnippet(text: string, queryTokens: string[]): string {
    if (!text) return "";
    const lower = text.toLowerCase();
    // 找到第一个匹配位置
    let firstMatchPos = -1;
    for (const qt of queryTokens) {
      const idx = lower.indexOf(qt);
      if (idx >= 0 && (firstMatchPos < 0 || idx < firstMatchPos)) {
        firstMatchPos = idx;
      }
    }
    if (firstMatchPos < 0) {
      return text.slice(0, this.config.snippetLength) + (text.length > this.config.snippetLength ? "..." : "");
    }
    // 居中显示匹配点
    const half = Math.floor(this.config.snippetLength / 2);
    const start = Math.max(0, firstMatchPos - half);
    const end = Math.min(text.length, start + this.config.snippetLength);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < text.length ? "..." : "";
    return prefix + text.slice(start, end) + suffix;
  }
}
