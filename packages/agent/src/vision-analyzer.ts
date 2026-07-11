/**
 * VisionAnalyzer — VLM (Vision Language Model) 视觉分析模块。
 *
 * 对标 Claude Computer Use / Devin 的视觉理解能力：分析 browser_screenshot
 * 返回的截图，识别 UI 元素、布局问题、错误状态等。
 *
 * 设计要点：
 *   - 不绑定具体 LLM provider：通过注入 `VisionChatFn` 调用任意 vision 模型
 *     （OpenAI gpt-4o / Anthropic claude-3-opus / Google gemini-pro-vision 等）。
 *   - 构造标准 vision message（OpenAI/Anthropic 通用格式），包含 text + image_url。
 *   - LRU + TTL 缓存：相同 prompt + image 不重复调用，节省 token。
 *   - 防御性解析：先尝试 JSON.parse，失败则用正则提取结构化信息。
 *   - 错误隔离：chatFn 抛错时包装为 Error，附加图片大小信息（不泄露 base64 内容）。
 */

import * as crypto from "crypto";

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface VisionAnalysisRequest {
  /** Base64 编码的图片数据（不含 data: 前缀） */
  imageBase64: string;
  /** 图片 MIME 类型，默认 image/png */
  imageMimeType?: "image/png" | "image/jpeg" | "image/webp";
  /** 分析提示词 */
  prompt: string;
  /** 最大输出 token 数 */
  maxTokens?: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 可选标签（如 "登录按钮"） */
  label?: string;
}

export interface UIElement {
  type:
    | "button"
    | "input"
    | "link"
    | "text"
    | "image"
    | "form"
    | "menu"
    | "dialog"
    | "unknown";
  text?: string;
  bbox: BoundingBox;
  attributes?: Record<string, string>;
}

export interface VisionAnalysisResult {
  description: string;
  elements: UIElement[];
  issues: Array<{
    severity: "info" | "warning" | "error";
    description: string;
    bbox?: BoundingBox;
  }>;
  rawResponse?: unknown;
}

export type VisionChatFn = (
  messages: Array<{ role: string; content: unknown }>,
  options?: {
    image?: { base64: string; mimeType: string };
    maxTokens?: number;
  },
) => Promise<unknown>;

export interface VisionAnalyzerConfig {
  defaultModel?: string;
  defaultMaxTokens?: number;
  /** 是否启用缓存，默认 true */
  cacheEnabled?: boolean;
  /** 缓存 TTL（毫秒），默认 5 分钟 */
  cacheTtlMs?: number;
}

// ── 默认配置 ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟
const DEFAULT_CACHE_MAX_ENTRIES = 100; // LRU 最多 100 条

// ── Prompt 模板（中文） ─────────────────────────────────────────────────────

const PROMPT_DESCRIBE_SCREEN =
  "请详细描述这个屏幕截图中的内容，包括页面布局、可见文本、按钮、表单元素和任何错误提示。";

const PROMPT_FIND_ELEMENTS =
  "请识别图中所有 {type} 元素，返回每个元素的位置 (x, y, width, height) 和文本标签（如有）。";

const PROMPT_DETECT_UI_ISSUES =
  "请分析这个 UI 截图，识别可能的视觉问题：错位、重叠、文字截断、对比度不足、响应式适配错误等。每个问题给出严重级别和位置。";

const PROMPT_COMPARE_IMAGES =
  "对比这两张截图，描述它们的差异，并估算相似度（0-1）。";

// ── 缓存条目 ────────────────────────────────────────────────────────────────

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  /** LRU 链表顺序：最近访问的时间戳 */
  lastAccessed: number;
}

// ── 主类 ────────────────────────────────────────────────────────────────────

export class VisionAnalyzer {
  private readonly chatFn: VisionChatFn;
  private readonly defaultMaxTokens: number;
  private readonly cacheEnabled: boolean;
  private readonly cacheTtlMs: number;
  private readonly cache: Map<string, CacheEntry<unknown>> = new Map();
  /**
   * in-flight 去重：key 形如 `methodName:cacheKey`，value 为进行中的 Promise。
   * 并发相同请求复用同一个 Promise，避免重复调用 VLM 浪费 token/费用。
   */
  private readonly inFlight: Map<string, Promise<unknown>> = new Map();

  constructor(chatFn: VisionChatFn, config?: VisionAnalyzerConfig) {
    this.chatFn = chatFn;
    this.defaultMaxTokens = config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.cacheEnabled = config?.cacheEnabled ?? true;
    this.cacheTtlMs = config?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * 通用分析入口：发送图片 + prompt 到 VLM，返回解析后的结构化结果。
   */
  async analyze(request: VisionAnalysisRequest): Promise<VisionAnalysisResult> {
    const mimeType = request.imageMimeType ?? "image/png";
    const maxTokens = request.maxTokens ?? this.defaultMaxTokens;

    // 缓存命中检查
    const cacheKey = this.buildCacheKey(
      request.prompt,
      request.imageBase64,
      maxTokens,
      mimeType,
    );
    if (this.cacheEnabled) {
      const cached = this.getFromCache(cacheKey);
      if (cached !== undefined) {
        return this.coerceAnalysisResult(cached, request.prompt);
      }
    }

    // in-flight 去重：并发相同请求复用同一个 Promise，避免重复调用 VLM
    const inflightKey = `analyze:${cacheKey}`;
    const inflight = this.inFlight.get(inflightKey);
    if (inflight) {
      return this.coerceAnalysisResult(await inflight, request.prompt);
    }

    // 构造 vision message（OpenAI/Anthropic 通用格式）
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: request.prompt },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${request.imageBase64}`,
            },
          },
        ],
      },
    ];

    const p = (async () => {
      let rawResponse: unknown;
      try {
        rawResponse = await this.chatFn(messages, {
          image: { base64: request.imageBase64, mimeType },
          maxTokens,
        });
      } catch (err) {
        // 错误隔离：附加图片大小信息，不泄露 base64 内容
        const imageSize = this.estimateBase64Bytes(request.imageBase64);
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `VisionAnalyzer.analyze failed: ${reason} (imageSize=${imageSize}B, mimeType=${mimeType})`,
          { cause: err },
        );
      }

      const parsed = this.parseAnalysisResponse(rawResponse, request.prompt);

      // 写入缓存
      if (this.cacheEnabled) {
        this.putIntoCache(cacheKey, parsed);
      }

      return parsed;
    })();

    this.inFlight.set(inflightKey, p);
    try {
      return this.coerceAnalysisResult(await p, request.prompt);
    } finally {
      this.inFlight.delete(inflightKey);
    }
  }

  /**
   * 描述截图内容（自然语言）。
   */
  async describeScreen(imageBase64: string, prompt?: string): Promise<string> {
    const result = await this.analyze({
      imageBase64,
      prompt: prompt ?? PROMPT_DESCRIBE_SCREEN,
    });
    return result.description;
  }

  /**
   * 识别图中所有指定类型的元素。
   */
  async findElements(
    imageBase64: string,
    elementType?: string,
  ): Promise<UIElement[]> {
    const type = elementType ?? "UI";
    const prompt = PROMPT_FIND_ELEMENTS.replace("{type}", () => type);
    const result = await this.analyze({ imageBase64, prompt });
    return result.elements;
  }

  /**
   * 检测 UI 视觉问题（错位、重叠、对比度等）。
   */
  async detectUIIssues(
    imageBase64: string,
  ): Promise<
    Array<{ severity: string; description: string; bbox?: BoundingBox }>
  > {
    const result = await this.analyze({
      imageBase64,
      prompt: PROMPT_DETECT_UI_ISSUES,
    });
    return result.issues.map((i) => ({
      severity: i.severity,
      description: i.description,
      bbox: i.bbox,
    }));
  }

  /**
   * 对比两张截图，描述差异并估算相似度。
   */
  async compareImages(
    image1Base64: string,
    image2Base64: string,
    prompt?: string,
  ): Promise<{ differences: string; similarity: number }> {
    const finalPrompt = prompt ?? PROMPT_COMPARE_IMAGES;
    const cacheKey = this.buildCacheKey(
      finalPrompt,
      image1Base64 + image2Base64,
      this.defaultMaxTokens,
      "image/png",
    );

    if (this.cacheEnabled) {
      const cached = this.getFromCache(cacheKey);
      if (cached !== undefined) {
        return this.coerceCompareResult(cached);
      }
    }

    // in-flight 去重
    const inflightKey = `compare:${cacheKey}`;
    const inflight = this.inFlight.get(inflightKey);
    if (inflight) {
      return this.coerceCompareResult(await inflight);
    }

    // 同时发送两张图片
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: finalPrompt },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${image1Base64}`,
            },
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${image2Base64}`,
            },
          },
        ],
      },
    ];

    const p = (async () => {
      let rawResponse: unknown;
      try {
        rawResponse = await this.chatFn(messages, {
          maxTokens: this.defaultMaxTokens,
        });
      } catch (err) {
        const size1 = this.estimateBase64Bytes(image1Base64);
        const size2 = this.estimateBase64Bytes(image2Base64);
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `VisionAnalyzer.compareImages failed: ${reason} (image1Size=${size1}B, image2Size=${size2}B)`,
          { cause: err },
        );
      }

      const parsed = this.parseCompareResponse(rawResponse);

      if (this.cacheEnabled) {
        this.putIntoCache(cacheKey, parsed);
      }

      return parsed;
    })();

    this.inFlight.set(inflightKey, p);
    try {
      return this.coerceCompareResult(await p);
    } finally {
      this.inFlight.delete(inflightKey);
    }
  }

  /**
   * 清空缓存。
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ── 私有：缓存 ───────────────────────────────────────────────────────────

  private buildCacheKey(
    prompt: string,
    imageBase64: string,
    maxTokens?: number,
    mimeType?: string,
  ): string {
    // maxTokens / mimeType 会影响 VLM 输出，必须纳入 key 防止误命中
    const hash = crypto
      .createHash("sha256")
      .update(imageBase64)
      .update(`|${maxTokens ?? this.defaultMaxTokens}|${mimeType ?? "image/png"}`)
      .digest("hex")
      .slice(0, 16);
    return `${prompt}:${hash}`;
  }

  private getFromCache<V>(key: string): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU：更新访问时间
    entry.lastAccessed = Date.now();
    return entry.value as V;
  }

  private putIntoCache(key: string, value: unknown): void {
    // 容量淘汰：超过上限时淘汰最久未访问的
    if (this.cache.size >= DEFAULT_CACHE_MAX_ENTRIES) {
      this.evictOldest();
    }
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
      lastAccessed: Date.now(),
    });
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, e] of this.cache) {
      if (e.lastAccessed < oldestTime) {
        oldestTime = e.lastAccessed;
        oldestKey = k;
      }
    }
    if (oldestKey) this.cache.delete(oldestKey);
  }

  // ── 私有：响应解析 ───────────────────────────────────────────────────────

  /**
   * 解析 VLM 响应为 VisionAnalysisResult。
   * 1. 如果响应是对象，直接尝试结构化提取
   * 2. 如果响应是字符串，尝试 JSON.parse
   * 3. 失败则用正则提取结构化信息
   */
  private parseAnalysisResponse(
    raw: unknown,
    fallbackPrompt: string,
  ): VisionAnalysisResult {
    const text = this.coerceText(raw);
    const elements: UIElement[] = [];
    const issues: VisionAnalysisResult["issues"] = [];
    let description = text;

    // 尝试 JSON 解析
    const parsed = this.tryParseJson(text);
    if (parsed !== undefined) {
      if (typeof parsed === "string") {
        description = parsed;
      } else if (this.isRecord(parsed)) {
        if (typeof parsed.description === "string") {
          description = parsed.description;
        }
        if (Array.isArray(parsed.elements)) {
          for (const el of parsed.elements) {
            const ui = this.coerceUIElement(el);
            if (ui) elements.push(ui);
          }
        }
        if (Array.isArray(parsed.issues)) {
          for (const is of parsed.issues) {
            const issue = this.coerceIssue(is);
            if (issue) issues.push(issue);
          }
        }
      } else if (Array.isArray(parsed)) {
        // 数组响应：视为元素列表
        for (const el of parsed) {
          const ui = this.coerceUIElement(el);
          if (ui) elements.push(ui);
        }
        description = `识别到 ${elements.length} 个元素。`;
      }
    } else {
      // 正则兜底：从纯文本中提取 bbox 和 issue
      const bboxMatches = this.matchBboxes(text);
      for (const m of bboxMatches) {
        elements.push({
          type: "unknown",
          text: m.label,
          bbox: { x: m.x, y: m.y, width: m.width, height: m.height },
        });
      }
    }

    if (!description) description = fallbackPrompt;

    return {
      description,
      elements,
      issues,
      rawResponse: raw,
    };
  }

  /**
   * 解析对比结果。期望响应包含 differences 文本和 similarity 数值。
   */
  private parseCompareResponse(raw: unknown): {
    differences: string;
    similarity: number;
  } {
    const text = this.coerceText(raw);
    const parsed = this.tryParseJson(text);

    if (parsed && this.isRecord(parsed)) {
      const differences =
        typeof parsed.differences === "string"
          ? parsed.differences
          : text;
      const similarity = this.coerceSimilarity(parsed.similarity);
      return { differences, similarity };
    }

    // 正则兜底：寻找 "相似度: 0.85" / "similarity: 0.85" 等
    const simMatch = text.match(/(?:相似度|similarity)[^\d]*([0-9]*\.?[0-9]+)/i);
    const similarity = simMatch ? this.clamp01(parseFloat(simMatch[1])) : 0;

    return { differences: text, similarity };
  }

  private coerceAnalysisResult(cached: unknown, fallbackPrompt: string): VisionAnalysisResult {
    if (this.isVisionAnalysisResult(cached)) {
      return cached;
    }
    // 兜底：把缓存值当文本描述
    return {
      description: this.coerceText(cached) || fallbackPrompt,
      elements: [],
      issues: [],
    };
  }

  private coerceCompareResult(cached: unknown): {
    differences: string;
    similarity: number;
  } {
    if (
      cached &&
      typeof cached === "object" &&
      typeof (cached as { differences?: unknown }).differences === "string" &&
      typeof (cached as { similarity?: unknown }).similarity === "number"
    ) {
      return cached as { differences: string; similarity: number };
    }
    return { differences: this.coerceText(cached), similarity: 0 };
  }

  private isVisionAnalysisResult(v: unknown): v is VisionAnalysisResult {
    if (!v || typeof v !== "object") return false;
    const r = v as Record<string, unknown>;
    return (
      typeof r.description === "string" &&
      Array.isArray(r.elements) &&
      Array.isArray(r.issues)
    );
  }

  private coerceUIElement(v: unknown): UIElement | null {
    if (!v || typeof v !== "object") return null;
    const r = v as Record<string, unknown>;
    const bbox = this.coerceBbox(r.bbox ?? r);
    if (!bbox) return null;
    const type = this.coerceElementType(r.type);
    const text = typeof r.text === "string" ? r.text : undefined;
    const attributes =
      r.attributes && typeof r.attributes === "object"
        ? (r.attributes as Record<string, string>)
        : undefined;
    return { type, text, bbox, attributes };
  }

  private coerceIssue(v: unknown): VisionAnalysisResult["issues"][number] | null {
    if (!v || typeof v !== "object") return null;
    const r = v as Record<string, unknown>;
    if (typeof r.description !== "string") return null;
    const severity = this.coerceSeverity(r.severity);
    const bbox = this.coerceBbox(r.bbox ?? r);
    return { severity, description: r.description, bbox: bbox ?? undefined };
  }

  private coerceBbox(v: unknown): BoundingBox | null {
    if (!v || typeof v !== "object") return null;
    const r = v as Record<string, unknown>;
    const x = this.toFiniteNumber(r.x);
    const y = this.toFiniteNumber(r.y);
    const width = this.toFiniteNumber(r.width ?? r.w);
    const height = this.toFiniteNumber(r.height ?? r.h);
    if (x === undefined || y === undefined || width === undefined || height === undefined) {
      return null;
    }
    const label = typeof r.label === "string" ? r.label : undefined;
    return { x, y, width, height, label };
  }

  private coerceElementType(v: unknown): UIElement["type"] {
    if (typeof v !== "string") return "unknown";
    const lower = v.toLowerCase();
    switch (lower) {
      case "button":
      case "input":
      case "link":
      case "text":
      case "image":
      case "form":
      case "menu":
      case "dialog":
        return lower;
      default:
        return "unknown";
    }
  }

  private coerceSeverity(v: unknown): "info" | "warning" | "error" {
    if (typeof v !== "string") return "info";
    const lower = v.toLowerCase();
    if (lower === "warning" || lower === "warn") return "warning";
    if (lower === "error" || lower === "critical") return "error";
    return "info";
  }

  private coerceSimilarity(v: unknown): number {
    const n = this.toFiniteNumber(v);
    if (n === undefined) return 0;
    return this.clamp01(n);
  }

  private toFiniteNumber(v: unknown): number | undefined {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  }

  private clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  private coerceText(v: unknown): string {
    if (typeof v === "string") return v;
    if (v == null) return "";
    if (Array.isArray(v)) {
      // 提取 content 数组中的 text 部分
      const parts: string[] = [];
      for (const c of v) {
        if (typeof c === "string") {
          parts.push(c);
        } else if (c && typeof c === "object") {
          const r = c as Record<string, unknown>;
          if (typeof r.text === "string") parts.push(r.text);
          else if (typeof r.content === "string") parts.push(r.content);
        }
      }
      return parts.join("\n");
    }
    if (typeof v === "object") {
      const r = v as Record<string, unknown>;
      if (typeof r.content === "string") return r.content;
      if (typeof r.text === "string") return r.text;
      if (typeof r.description === "string") return r.description;
      try {
        return JSON.stringify(v);
      } catch {
        return "";
      }
    }
    return String(v);
  }

  private tryParseJson(text: string): unknown {
    if (!text) return undefined;
    const trimmed = text.trim();

    // 直接整体解析
    try {
      return JSON.parse(trimmed);
    } catch {
      // 继续
    }

    // 提取 ```json ... ``` 代码块
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // 继续
      }
    }

    // 提取首个 JSON 对象/数组
    const objMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]);
      } catch {
        // 继续
      }
    }
    const arrMatch = trimmed.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        return JSON.parse(arrMatch[0]);
      } catch {
        // 继续
      }
    }

    return undefined;
  }

  /**
   * 正则兜底：从纯文本中提取 bbox。
   * 支持两种格式：
   *   - "x: 100, y: 200, width: 300, height: 400"
   *   - "(100, 200, 300, 400)"
   */
  private matchBboxes(text: string): Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    label?: string;
  }> {
    const results: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      label?: string;
    }> = [];

    // 格式 1: (x, y, w, h)
    const tupleRe = /\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = tupleRe.exec(text)) !== null) {
      results.push({
        x: parseFloat(m[1]),
        y: parseFloat(m[2]),
        width: parseFloat(m[3]),
        height: parseFloat(m[4]),
      });
    }

    // 格式 2: x: 100, y: 200, width: 300, height: 400
    const namedRe =
      /x\s*:\s*(\d+(?:\.\d+)?)[^x]*y\s*:\s*(\d+(?:\.\d+)?)[^w]*width\s*:\s*(\d+(?:\.\d+)?)[^h]*height\s*:\s*(\d+(?:\.\d+)?)/gi;
    while ((m = namedRe.exec(text)) !== null) {
      results.push({
        x: parseFloat(m[1]),
        y: parseFloat(m[2]),
        width: parseFloat(m[3]),
        height: parseFloat(m[4]),
      });
    }

    return results;
  }

  private isRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  /**
   * 估算 base64 字符串对应的字节数（用于错误日志，不泄露内容）。
   */
  private estimateBase64Bytes(base64: string): number {
    if (!base64) return 0;
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  }
}
