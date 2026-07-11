/**
 * ToolSearch — 渐进式工具披露（BM25 catalog + 桥接工具）。
 *
 * 对标 Hermes v0.18.0 `tools/tool_search.py` 的 `assemble_tool_defs`：
 * 当工具数量增长时，避免把全部 schema 注入 system prompt（token 成本线性上升）。
 *
 * 策略：
 * 1. classify_tools：拆分 visible（始终可见）和 deferrable（按需加载）
 * 2. build_catalog：用 BM25 索引构建工具目录
 * 3. 注入 3 个桥接工具：search_tools / get_tool_details / enable_tool
 * 4. LLM 按需检索 → 启用具体工具 → 调用
 *
 * 阈值门控（shouldActivate）：
 *   - 工具数 > 30 或 schema 总 token > 4000 时激活
 *   - 否则全部 visible，不走 BM25
 */

/** 工具元信息（用于索引） */
export interface ToolMeta {
  /** 工具名 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 工具类别（如 file/web/shell/memory） */
  category?: string;
  /** 参数 schema（JSON Schema） */
  schema?: unknown;
  /** 是否始终可见（不参与按需加载） */
  alwaysVisible?: boolean;
}

/** 工具配置 */
export interface ToolSearchConfig {
  /** 激活模式 */
  mode: "auto" | "on" | "off";
  /** 触发激活的工具数阈值（默认 30） */
  toolCountThreshold?: number;
  /** 触发激活的 schema token 阈值（默认 4000） */
  schemaTokenThreshold?: number;
  /** 搜索结果上限（默认 5） */
  maxResults?: number;
}

/** 搜索结果 */
export interface ToolSearchResult {
  /** 工具名 */
  name: string;
  /** 相关性分数（越高越相关） */
  score: number;
  /** 匹配到的查询词列表 */
  matchedTerms: string[];
  /** 命中原因（人类可读） */
  reason: string;
}

/** 桥接工具名 */
const BRIDGE_TOOL_NAMES = ["search_tools", "get_tool_details", "enable_tool"] as const;

// ── BM25 索引 ─────────────────────────────────────────────

/**
 * 简化版 BM25 索引。
 * 不依赖外部库，内联实现 Okapi BM25 算法。
 */
class BM25Index {
  private docs: Array<{ tokens: string[]; fieldLength: number }> = [];
  private termFreq: Map<string, Map<number, number>> = new Map(); // term → docId → freq
  private docFreq: Map<string, number> = new Map(); // term → 包含该词的文档数
  private avgFieldLength = 0;
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  /** 分词：小写 + 按非字母数字分割 + CJK 字符逐字分词 */
  private tokenize(text: string): string[] {
    // CJK 统一表意文字范围（含扩展A）逐字分词，支持中文工具描述索引
    // \u4e00-\u9fff CJK 基本区, \u3400-\u4dbf 扩展A, \u3040-\u30ff 日文假名, \uac00-\ud7af 韩文
    const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/;
    const tokens: string[] = [];
    // 先按非字母数字+CJK边界分割
    const parts = text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]+/);
    for (const part of parts) {
      if (part.length === 0) continue;
      // 对含 CJK 的片段逐字拆分（中文无空格分词）
      if (cjkRegex.test(part)) {
        let buf = "";
        for (const ch of part) {
          if (cjkRegex.test(ch)) {
            // CJK 字符：先 flush 拉丁缓冲区，再单独成词
            if (buf) { tokens.push(buf); buf = ""; }
            tokens.push(ch);
          } else {
            buf += ch;
          }
        }
        if (buf) tokens.push(buf);
      } else {
        tokens.push(part);
      }
    }
    return tokens.filter((t) => t.length > 0);
  }

  /** 添加文档 */
  addDoc(text: string): number {
    const docId = this.docs.length;
    const tokens = this.tokenize(text);
    this.docs.push({ tokens, fieldLength: tokens.length });

    // 统计词频
    const freqInDoc = new Map<string, number>();
    for (const token of tokens) {
      freqInDoc.set(token, (freqInDoc.get(token) ?? 0) + 1);
    }

    for (const [term, freq] of freqInDoc) {
      if (!this.termFreq.has(term)) {
        this.termFreq.set(term, new Map());
      }
      this.termFreq.get(term)!.set(docId, freq);
      this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
    }

    return docId;
  }

  /** 完成索引构建，计算平均字段长度 */
  finalize(): void {
    if (this.docs.length === 0) return;
    const total = this.docs.reduce((sum, d) => sum + d.fieldLength, 0);
    this.avgFieldLength = total / this.docs.length;
  }

  /** 搜索 */
  search(query: string, maxResults: number): Array<{ docId: number; score: number }> {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0 || this.docs.length === 0) return [];

    const scores = new Map<number, number>();
    const N = this.docs.length;

    for (const term of queryTokens) {
      const df = this.docFreq.get(term) ?? 0;
      if (df === 0) continue;

      // IDF
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      const postings = this.termFreq.get(term);
      if (!postings) continue;

      for (const [docId, freq] of postings) {
        const doc = this.docs[docId];
        // BM25 score
        const tfNorm = (freq * (this.k1 + 1)) /
          (freq + this.k1 * (1 - this.b + this.b * (doc.fieldLength / (this.avgFieldLength || 1))));
        const score = idf * tfNorm;
        scores.set(docId, (scores.get(docId) ?? 0) + score);
      }
    }

    return Array.from(scores.entries())
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /** 获取文档数 */
  get size(): number {
    return this.docs.length;
  }
}

// ── ToolSearchEngine ─────────────────────────────────────

/**
 * 工具搜索引擎。
 * 维护 BM25 索引，支持按查询检索工具。
 */
export class ToolSearchEngine {
  private config: Required<ToolSearchConfig>;
  private tools: ToolMeta[] = [];
  private index: BM25Index;
  private docIdToToolIdx: number[] = [];
  private activated = false;

  constructor(config: ToolSearchConfig = { mode: "auto" }) {
    this.config = {
      mode: config.mode,
      toolCountThreshold: config.toolCountThreshold ?? 30,
      schemaTokenThreshold: config.schemaTokenThreshold ?? 4000,
      maxResults: config.maxResults ?? 5,
    };
    this.index = new BM25Index();
  }

  /** 注册工具列表 */
  registerTools(tools: ToolMeta[]): void {
    this.tools = tools;
    this.rebuildIndex();
    this.activated = this.shouldActivate();
  }

  /** 重建 BM25 索引 */
  private rebuildIndex(): void {
    this.index = new BM25Index();
    this.docIdToToolIdx = [];

    for (let i = 0; i < this.tools.length; i++) {
      const tool = this.tools[i];
      // 索引文本 = 工具名 + 描述 + 类别
      const docText = `${tool.name} ${tool.category ?? ""} ${tool.description}`;
      const docId = this.index.addDoc(docText);
      this.docIdToToolIdx[docId] = i;
    }

    this.index.finalize();
  }

  /** 是否应激活工具搜索 */
  private shouldActivate(): boolean {
    if (this.config.mode === "on") return true;
    if (this.config.mode === "off") return false;

    // auto 模式：仅根据 deferrable 工具的 schema token 阈值判断。
    // 与 Python tool_search.py should_activate 一致：always-visible 工具
    // 不参与计算（它们总会被注入 prompt，搜索它们无收益）。
    const deferrableTools = this.tools.filter((t) => !t.alwaysVisible);

    // 估算 deferrable schema token（4 字符 ≈ 1 token）
    const schemaChars = deferrableTools.reduce((sum, t) => {
      const schemaStr = JSON.stringify(t.schema ?? "");
      const descLen = t.description.length + t.name.length;
      return sum + schemaStr.length + descLen;
    }, 0);
    const estimatedTokens = Math.ceil(schemaChars / 4);

    return estimatedTokens >= this.config.schemaTokenThreshold;
  }

  /** 是否已激活 */
  isActivated(): boolean {
    return this.activated;
  }

  /**
   * 搜索工具。
   *
   * @param query 查询文本（自然语言）
   * @param maxResults 最大结果数（默认使用配置）
   */
  search(query: string, maxResults?: number): ToolSearchResult[] {
    if (!this.activated) {
      // 未激活：返回全部工具（按名称排序）
      return this.tools
        .map((t) => ({
          name: t.name,
          score: 1.0,
          matchedTerms: [],
          reason: t.description,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    const limit = maxResults ?? this.config.maxResults;
    const results = this.index.search(query, limit);

    const out: ToolSearchResult[] = [];
    for (const { docId, score } of results) {
      const idx = this.docIdToToolIdx[docId];
      const tool = idx === undefined ? undefined : this.tools[idx];
      if (!tool) continue; // 索引未重建或 docId 失效，跳过而非抛错
      out.push({
        name: tool.name,
        score,
        matchedTerms: [],
        reason: tool.description,
      });
    }
    return out;
  }

  /** 获取工具详情 */
  getToolDetails(name: string): ToolMeta | null {
    return this.tools.find((t) => t.name === name) ?? null;
  }

  /**
   * 获取可见工具列表（注入 system prompt 的工具）。
   * 激活时只返回 alwaysVisible + 桥接工具；未激活时返回全部。
   */
  getVisibleTools(): ToolMeta[] {
    if (!this.activated) {
      return [...this.tools];
    }

    const visible = this.tools.filter((t) => t.alwaysVisible);
    // 添加桥接工具
    for (const bridgeName of BRIDGE_TOOL_NAMES) {
      visible.push(this.getBridgeTool(bridgeName));
    }
    return visible;
  }

  /** 获取桥接工具定义 */
  private getBridgeTool(name: typeof BRIDGE_TOOL_NAMES[number]): ToolMeta {
    switch (name) {
      case "search_tools":
        return {
          name: "search_tools",
          description: "搜索可用工具。当需要某个功能但当前工具列表中没有时，先用此工具搜索。",
          category: "meta",
          alwaysVisible: true,
          schema: {
            type: "object",
            properties: {
              query: { type: "string", description: "搜索查询（自然语言描述需要的功能）" },
              max_results: { type: "number", description: "最大结果数（默认 5）" },
            },
            required: ["query"],
          },
        };
      case "get_tool_details":
        return {
          name: "get_tool_details",
          description: "获取指定工具的详细 schema（参数、返回值等）。",
          category: "meta",
          alwaysVisible: true,
          schema: {
            type: "object",
            properties: {
              tool_name: { type: "string", description: "工具名" },
            },
            required: ["tool_name"],
          },
        };
      case "enable_tool":
        return {
          name: "enable_tool",
          description: "启用指定工具（使其在当前会话中可用）。调用前先用 get_tool_details 查看 schema。",
          category: "meta",
          alwaysVisible: true,
          schema: {
            type: "object",
            properties: {
              tool_name: { type: "string", description: "要启用的工具名" },
            },
            required: ["tool_name"],
          },
        };
    }
  }

  /** 获取桥接工具名列表 */
  static getBridgeToolNames(): readonly string[] {
    return BRIDGE_TOOL_NAMES;
  }
}

/**
 * 估算文本的 token 数（4 字符 ≈ 1 token）。
 * 用于工具 schema token 预算计算。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 估算工具 schema 的 token 数。
 */
export function estimateToolTokens(tool: ToolMeta): number {
  const schemaStr = JSON.stringify(tool.schema ?? "");
  const descStr = tool.description + tool.name;
  return estimateTokens(schemaStr + descStr);
}

/**
 * 估算工具列表的总 token 数。
 */
export function estimateTotalTokens(tools: ToolMeta[]): number {
  return tools.reduce((sum, t) => sum + estimateToolTokens(t), 0);
}

// ── ToolSearchIndex（TF-IDF 动态工具发现） ──────────────────
// 借鉴 hermes-agent Tool Search 设计：动态工具发现，避免工具 schema 膨胀。
// 参考 packages/skills/src/tfidf-matcher.ts 的 TF-IDF 实现模式。

/** 已索引工具 */
export interface IndexedTool {
  /** 工具名 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 关键词列表（权重高于描述匹配） */
  keywords: string[];
  /** JSON schema 定义（用于动态注入到 LLM 请求） */
  definition: unknown;
}

/** 中英文停用词 */
const TOOL_SEARCH_STOP_WORDS = new Set<string>([
  // 中文停用词
  "的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一", "一个",
  "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好",
  "自己", "这", "他", "她", "它", "们", "那", "些", "什么", "怎么", "如何",
  "可以", "能", "请", "帮", "让", "把", "被", "从", "对", "为", "以", "及",
  "但", "而", "与", "或", "如果", "因为", "所以", "虽然", "但是",
  // 英文停用词
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "have", "from", "this",
  "that", "with", "will", "been", "they", "their", "which", "would",
  "there", "could", "other", "into", "more", "some", "than", "its",
  "over", "such", "after", "just", "also", "about", "want", "need",
  "help", "please", "like", "does", "make", "when", "what", "how",
  "where", "who", "why", "your", "them", "then", "only", "very",
  "tool", "function", "use", "using",
]);

/**
 * 分词：支持中英文混合。
 * 中文采用 2-3 字符 n-gram；英文按单词分词。
 */
function tokenizeToolText(text: string): string[] {
  const terms: string[] = [];
  const lower = text.toLowerCase();

  // 中文：提取连续 CJK 字符段，生成 bigram/trigram
  const cjkSegments = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || [];
  for (const seg of cjkSegments) {
    if (seg.length >= 2) terms.push(seg);
    for (let i = 0; i <= seg.length - 2; i++) {
      terms.push(seg.substring(i, i + 2));
    }
    for (let i = 0; i <= seg.length - 3; i++) {
      terms.push(seg.substring(i, i + 3));
    }
  }

  // 英文单词（2 字符以上）
  const englishWords = lower.match(/[a-z][a-z0-9_]{1,}/g) || [];
  terms.push(...englishWords);

  // 按标点/空白分割的片段
  const segments = lower
    .split(/[\s,.;:!?()\[\]{}""''<>，。！？、；：（）【】《》""''\-]+/)
    .filter((s) => s.length >= 2);
  terms.push(...segments);

  // 过滤停用词 + 去重
  return terms.filter((t) => !TOOL_SEARCH_STOP_WORDS.has(t) && t.length >= 2);
}

/** 计算词频（归一化） */
function computeTf(terms: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  const total = terms.length || 1;
  for (const term of terms) {
    tf.set(term, (tf.get(term) ?? 0) + 1);
  }
  for (const [term, count] of tf) {
    tf.set(term, count / total);
  }
  return tf;
}

/** 余弦相似度 */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, valueA] of a) {
    const valueB = b.get(term) ?? 0;
    dotProduct += valueA * valueB;
    normA += valueA * valueA;
  }
  for (const valueB of b.values()) {
    normB += valueB * valueB;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 单字段 TF-IDF 倒排索引（内部使用） */
class TfidfFieldIndex {
  private docs = new Map<string, { tf: Map<string, number>; terms: Set<string> }>();
  private documentFrequency = new Map<string, number>();
  private idfCache = new Map<string, number>();
  private built = false;

  /** 添加文档 */
  addDoc(id: string, text: string): void {
    const tokens = tokenizeToolText(text);
    const tf = computeTf(tokens);
    const terms = new Set(tokens);
    this.docs.set(id, { tf, terms });
    this.built = false;
  }

  /** 移除文档 */
  removeDoc(id: string): void {
    this.docs.delete(id);
    this.built = false;
  }

  /** 构建 IDF */
  build(): void {
    this.documentFrequency.clear();
    this.idfCache.clear();
    for (const { terms } of this.docs.values()) {
      for (const term of terms) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
    }
    this.built = true;
  }

  /** 搜索：返回 id → { score, matchedTerms } */
  search(query: string): Map<string, { score: number; matchedTerms: string[] }> {
    if (!this.built) this.build();
    const results = new Map<string, { score: number; matchedTerms: string[] }>();
    if (this.docs.size === 0) return results;

    const queryTerms = tokenizeToolText(query);
    if (queryTerms.length === 0) return results;

    const queryTf = computeTf(queryTerms);
    const queryTfidf = new Map<string, number>();
    const numDocs = this.docs.size;
    for (const [term, tfValue] of queryTf) {
      const df = this.documentFrequency.get(term) ?? 0;
      // 平滑 IDF（sklearn 风格）：log((1+N)/(1+df)) + 1，始终为正，避免小语料 IDF=0
      const idf = Math.log((numDocs + 1) / (df + 1)) + 1;
      this.idfCache.set(term, idf);
      queryTfidf.set(term, tfValue * idf);
    }

    for (const [id, { tf, terms }] of this.docs) {
      const docTfidf = new Map<string, number>();
      for (const [term, tfValue] of tf) {
        const idf = this.idfCache.get(term) ?? (Math.log((numDocs + 1) / ((this.documentFrequency.get(term) ?? 0) + 1)) + 1);
        docTfidf.set(term, tfValue * idf);
      }
      const score = cosineSimilarity(queryTfidf, docTfidf);
      if (score > 0) {
        const matchedTerms = queryTerms.filter((t) => terms.has(t));
        results.set(id, { score, matchedTerms: [...new Set(matchedTerms)] });
      }
    }
    return results;
  }

  /** 文档数 */
  get size(): number {
    return this.docs.size;
  }
}

/**
 * 工具搜索索引。
 * 维护工具名称、描述、关键词的 TF-IDF 倒排索引，
 * 根据查询文本返回最相关的工具列表，用于动态工具发现。
 *
 * 关键词权重高于描述匹配；空查询返回最常用工具或全部工具（截断到 maxTools）。
 */
export class ToolSearchIndex {
  private tools = new Map<string, IndexedTool>();
  private keywordIndex = new TfidfFieldIndex();
  private descIndex = new TfidfFieldIndex();
  private usageCounts = new Map<string, number>();
  private dirty = false;

  constructor(private maxTools: number = 20) {}

  /** 索引单个工具 */
  indexTool(name: string, description: string, keywords: string[], definition?: unknown): void {
    this.removeToolInternal(name);
    const tool: IndexedTool = { name, description, keywords, definition: definition ?? undefined };
    this.tools.set(name, tool);
    this.keywordIndex.addDoc(name, keywords.join(" "));
    this.descIndex.addDoc(name, `${name} ${description}`);
    this.dirty = true;
  }

  /** 批量索引 */
  indexBatch(tools: IndexedTool[]): void {
    for (const t of tools) {
      this.indexTool(t.name, t.description, t.keywords, t.definition);
    }
  }

  /** 移除索引 */
  removeTool(name: string): boolean {
    return this.removeToolInternal(name);
  }

  /** 获取所有已索引工具 */
  getAllTools(): IndexedTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 搜索工具：根据查询文本返回最相关的工具列表。
   * 关键词权重高于描述匹配；结果按 score 降序排列。
   *
   * @param query 查询文本（自然语言，支持中英文混合）
   * @param maxResults 最大结果数（默认 maxTools）
   */
  searchTools(query: string, maxResults?: number): ToolSearchResult[] {
    if (this.tools.size === 0) return [];

    const trimmed = (query ?? "").trim();
    if (trimmed === "") {
      return this.defaultToolset(maxResults);
    }

    this.rebuildIfDirty();

    const keywordResults = this.keywordIndex.search(trimmed);
    const descResults = this.descIndex.search(trimmed);

    // 关键词权重 > 描述权重
    const KEYWORD_WEIGHT = 2.0;
    const DESC_WEIGHT = 1.0;

    const combined = new Map<string, { score: number; matchedTerms: Set<string> }>();
    for (const [name, { score, matchedTerms }] of keywordResults) {
      const entry = combined.get(name) ?? { score: 0, matchedTerms: new Set<string>() };
      entry.score += score * KEYWORD_WEIGHT;
      for (const t of matchedTerms) entry.matchedTerms.add(t);
      combined.set(name, entry);
    }
    for (const [name, { score, matchedTerms }] of descResults) {
      const entry = combined.get(name) ?? { score: 0, matchedTerms: new Set<string>() };
      entry.score += score * DESC_WEIGHT;
      for (const t of matchedTerms) entry.matchedTerms.add(t);
      combined.set(name, entry);
    }

    const results: ToolSearchResult[] = [];
    for (const [name, { score, matchedTerms }] of combined) {
      const tool = this.tools.get(name);
      if (!tool) continue;
      results.push({
        name,
        score,
        matchedTerms: Array.from(matchedTerms),
        reason: tool.description,
      });
    }

    results.sort((a, b) => b.score - a.score);
    const limit = maxResults ?? this.maxTools;
    return results.slice(0, limit);
  }

  /**
   * 获取工具集：返回匹配的工具定义（schema），用于动态注入到 LLM 请求。
   * 仅返回有 definition 的工具。
   *
   * @param query 查询文本（自然语言）
   * @param maxResults 最大结果数（默认 maxTools）
   */
  getToolset(query: string, maxResults?: number): unknown[] {
    const results = this.searchTools(query, maxResults);
    const out: unknown[] = [];
    for (const r of results) {
      const tool = this.tools.get(r.name);
      if (tool && tool.definition !== undefined) {
        out.push(tool.definition);
      }
    }
    return out;
  }

  /** 记录工具使用（用于空查询时返回最常用工具） */
  recordUsage(name: string): void {
    if (this.tools.has(name)) {
      this.usageCounts.set(name, (this.usageCounts.get(name) ?? 0) + 1);
    }
  }

  /** 获取已索引工具数 */
  get size(): number {
    return this.tools.size;
  }

  // ── 内部方法 ──

  private removeToolInternal(name: string): boolean {
    if (!this.tools.has(name)) return false;
    this.tools.delete(name);
    this.keywordIndex.removeDoc(name);
    this.descIndex.removeDoc(name);
    this.usageCounts.delete(name);
    this.dirty = true;
    return true;
  }

  private rebuildIfDirty(): void {
    if (!this.dirty) return;
    this.keywordIndex.build();
    this.descIndex.build();
    this.dirty = false;
  }

  /** 空查询：返回最常用工具（有使用统计时）或所有工具（截断到 maxTools） */
  private defaultToolset(maxResults?: number): ToolSearchResult[] {
    const limit = maxResults ?? this.maxTools;
    const all = Array.from(this.tools.values());

    if (this.usageCounts.size > 0) {
      all.sort((a, b) => (this.usageCounts.get(b.name) ?? 0) - (this.usageCounts.get(a.name) ?? 0));
    }

    return all.slice(0, limit).map((t) => ({
      name: t.name,
      score: 1.0,
      matchedTerms: [],
      reason: t.description,
    }));
  }
}
