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
  /** BM25 分数 */
  score: number;
  /** 工具描述 */
  description: string;
  /** 工具类别 */
  category?: string;
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

  /** 分词：小写 + 按非字母数字分割 */
  private tokenize(text: string): string[] {
    return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
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
          description: t.description,
          category: t.category,
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
        description: tool.description,
        category: tool.category,
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
