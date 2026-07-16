/**
 * ToolOutputPruner — 工具输出 3-pass 裁剪器
 *
 * 借鉴 hermes-agent agent/context_compressor.py _prune_old_tool_results（3-pass pruning）：
 *
 * Pass 1: 去重（dedup）
 *   - 对所有工具输出计算 MD5 哈希
 *   - 反向遍历（从最新到最旧）
 *   - 保留每个哈希的最新一份，旧重复替换为占位符
 *   - 这保证了最新上下文优先
 *
 * Pass 2: 信息摘要（informative summary）
 *   - 对超过阈值的工具输出应用工具特定的摘要
 *   - 18+ 工具特定的摘要模式（shell、web_search、web_fetch、email、json 等）
 *   - 保留关键信息，去除冗余
 *
 * Pass 3: 参数 JSON 截断（args truncation）
 *   - 对 tool_calls 中的 args JSON 字段进行截断
 *   - 保持 JSON 有效性（不破坏结构）
 *   - 保留前 N 个字符 + 尾部闭合括号
 *
 * 这三 pass 的顺序很重要：
 *   - 先去重避免对重复内容做无用摘要
 *   - 再摘要减少后续截断的工作量
 *   - 最后截断 args 防止 tool_call 参数膨胀
 */

import { createHash } from "crypto";

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface ToolMessage {
  role: string;
  content: string | unknown[] | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  name?: string;
}

export interface PruningStats {
  deduplicated: number;
  summarized: number;
  argsTruncated: number;
  originalChars: number;
  prunedChars: number;
}

export interface ToolOutputPrunerConfig {
  /** 启用 Pass 1 去重 */
  enableDedup: boolean;
  /** 启用 Pass 2 摘要 */
  enableSummary: boolean;
  /** 启用 Pass 3 args 截断 */
  enableArgsTruncation: boolean;
  /** 工具输出触发摘要的字符阈值 */
  summaryThreshold: number;
  /** args JSON 截断的字符阈值 */
  argsTruncationThreshold: number;
  /** args 截断后保留的头部字符数 */
  argsTruncationHead: number;
  /** 保留最近 N 条工具消息不裁剪 */
  keepRecentN: number;
}

export const DEFAULT_PRUNER_CONFIG: ToolOutputPrunerConfig = {
  enableDedup: true,
  enableSummary: true,
  enableArgsTruncation: true,
  summaryThreshold: 2000,
  argsTruncationThreshold: 500,
  argsTruncationHead: 300,
  keepRecentN: 3,
};

// ── Pass 1: 去重 ────────────────────────────────────────────────────────────

/**
 * 计算 MD5 哈希。
 */
function md5Hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Pass 1: 工具输出去重。
 *
 * 借鉴 hermes-agent _prune_old_tool_results Pass 1：
 *   - 反向遍历（从最新到最旧）
 *   - 用 Set 跟踪已见哈希
 *   - 重复的旧消息替换为占位符
 *
 * @param messages 消息列表
 * @param keepRecentN 保留最近 N 条不裁剪
 * @returns 去重后的消息列表 + 去重计数
 */
function dedupToolOutputs(
  messages: ToolMessage[],
  keepRecentN: number,
): { messages: ToolMessage[]; deduplicated: number } {
  const seenHashes = new Set<string>();
  let deduplicated = 0;

  // 反向遍历：从最新到最旧
  const result = [...messages];
  const toolIndices: number[] = [];
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === "tool" && typeof result[i].content === "string") {
      toolIndices.push(i);
    }
  }

  // 保留最近 N 条工具消息不裁剪
  const protectedIndices = new Set(toolIndices.slice(0, keepRecentN));

  for (const idx of toolIndices) {
    if (protectedIndices.has(idx)) {
      // 仍要记录哈希，避免后续重复
      const content = result[idx].content as string;
      seenHashes.add(md5Hash(content));
      continue;
    }

    const content = result[idx].content as string;
    const hash = md5Hash(content);

    if (seenHashes.has(hash)) {
      // 重复，替换为占位符
      result[idx] = {
        ...result[idx],
        content: `[duplicate tool output removed — ${content.length} chars]`,
      };
      deduplicated++;
    } else {
      seenHashes.add(hash);
    }
  }

  return { messages: result, deduplicated };
}

// ── Pass 2: 信息摘要 ────────────────────────────────────────────────────────

/**
 * Pass 2: 对超长工具输出应用工具特定摘要。
 *
 * 借鉴 hermes-agent _prune_old_tool_results Pass 2：
 *   - 18+ 工具特定的摘要模式
 *   - 保留关键信息，去除冗余
 *
 * EvoClaw 已有 summarizeToolResult（text-processor.ts），这里做轻量级分发。
 */
function summarizeToolOutput(
  toolName: string,
  content: string,
  threshold: number,
): string {
  if (!content || content.length < threshold) return content;

  // 根据工具名称选择摘要策略
  const name = toolName.toLowerCase();

  // shell/exec 类：保留首尾行
  if (name.includes("shell") || name.includes("exec") || name.includes("bash") || name.includes("terminal")) {
    return summarizeShellOutput(content);
  }

  // web_search 类：提取结构化结果
  if (name.includes("search")) {
    return summarizeSearchOutput(content);
  }

  // web_fetch/browser 类：保留首尾段落
  if (name.includes("fetch") || name.includes("browser") || name.includes("scrape")) {
    return summarizeWebOutput(content);
  }

  // email 类：保留邮件头
  if (name.includes("email") || name.includes("mail")) {
    return summarizeEmailOutput(content);
  }

  // file read 类：保留首尾
  if (name.includes("read") || name.includes("file") || name.includes("cat")) {
    return summarizeFileOutput(content);
  }

  // list/glob 类：压缩重复模式
  if (name.includes("list") || name.includes("glob") || name.includes("find")) {
    return summarizeListOutput(content);
  }

  // 默认：智能截断
  return summarizeDefault(content);
}

function summarizeShellOutput(content: string): string {
  const maxLen = 4000;
  if (content.length <= maxLen) return content;
  const lines = content.split("\n");
  if (lines.length <= 30) {
    return lines.map((l) => l.length > 300 ? l.slice(0, 300) + "...[truncated]" : l).join("\n").slice(0, maxLen);
  }
  const head = lines.slice(0, 15);
  const tail = lines.slice(-10);
  const middleCount = lines.length - 25;
  return [...head, `  ... [${middleCount} lines omitted] ...`, ...tail].join("\n").slice(0, maxLen);
}

function summarizeSearchOutput(content: string): string {
  const maxLen = 3000;
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const summarized = parsed.slice(0, 5).map((item: Record<string, unknown>, i: number) => {
        const title = String(item.title || item.name || `Result ${i + 1}`);
        const snippet = String(item.snippet || item.content || "").slice(0, 150);
        const url = String(item.url || item.link || "");
        return `${i + 1}. ${title}\n   ${snippet}${url ? `\n   ${url}` : ""}`;
      });
      const more = parsed.length > 5 ? `\n\n... [${parsed.length - 5} more results]` : "";
      return (summarized.join("\n\n") + more).slice(0, maxLen);
    }
  } catch {
    // 非 JSON
  }
  return content.slice(0, maxLen) + "\n... [truncated]";
}

function summarizeWebOutput(content: string): string {
  const maxLen = 4000;
  if (content.length <= maxLen) return content;
  const head = content.slice(0, Math.floor(maxLen * 0.6));
  const tail = content.slice(-Math.floor(maxLen * 0.3));
  return `${head}\n\n... [content truncated ${content.length - maxLen} chars] ...\n\n${tail}`;
}

function summarizeEmailOutput(content: string): string {
  const maxLen = 3000;
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const summarized = parsed.slice(0, 5).map((email: Record<string, unknown>, i: number) => {
        const subject = String(email.subject || "(no subject)");
        const from = String(email.from || "");
        const date = String(email.date || "");
        const body = String(email.body || "").slice(0, 100);
        return `${i + 1}. [${date}] ${from}: ${subject}\n   ${body}${body.length >= 100 ? "..." : ""}`;
      });
      return summarized.join("\n\n").slice(0, maxLen);
    }
  } catch {
    // 非 JSON
  }
  return content.slice(0, maxLen) + "\n... [truncated]";
}

function summarizeFileOutput(content: string): string {
  const maxLen = 4000;
  if (content.length <= maxLen) return content;
  const lines = content.split("\n");
  if (lines.length <= 40) {
    return content.slice(0, maxLen) + "\n... [truncated]";
  }
  const head = lines.slice(0, 20);
  const tail = lines.slice(-10);
  const middleCount = lines.length - 30;
  return [...head, `  ... [${middleCount} lines omitted] ...`, ...tail].join("\n").slice(0, maxLen);
}

function summarizeListOutput(content: string): string {
  const maxLen = 3000;
  if (content.length <= maxLen) return content;
  const lines = content.split("\n");
  if (lines.length <= 50) return content.slice(0, maxLen);
  // 保留首尾 + 采样中间
  const head = lines.slice(0, 20);
  const tail = lines.slice(-10);
  const middleCount = lines.length - 30;
  return [...head, `  ... [${middleCount} entries omitted] ...`, ...tail].join("\n").slice(0, maxLen);
}

function summarizeDefault(content: string): string {
  const maxLen = 4000;
  if (content.length <= maxLen) return content;
  const head = content.slice(0, Math.floor(maxLen * 0.7));
  const tail = content.slice(-Math.floor(maxLen * 0.2));
  return `${head}\n\n... [truncated ${content.length - maxLen} chars] ...\n\n${tail}`;
}

/**
 * 应用 Pass 2 摘要到所有工具消息。
 */
function applySummaryPass(
  messages: ToolMessage[],
  config: ToolOutputPrunerConfig,
): { messages: ToolMessage[]; summarized: number } {
  let summarized = 0;
  // 保留最近 N 条不摘要
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool" && typeof messages[i].content === "string") {
      toolIndices.push(i);
    }
  }
  const protectedSet = new Set(toolIndices.slice(-config.keepRecentN));

  const result = messages.map((msg, idx) => {
    if (msg.role !== "tool" || typeof msg.content !== "string") return msg;
    if (protectedSet.has(idx)) return msg;
    if (msg.content.length < config.summaryThreshold) return msg;
    // 跳过已是被裁剪的占位符
    if (msg.content.startsWith("[duplicate tool output removed")) return msg;

    const toolName = msg.name || "";
    const summarized_content = summarizeToolOutput(toolName, msg.content, config.summaryThreshold);
    if (summarized_content.length < msg.content.length) {
      summarized++;
      return { ...msg, content: summarized_content };
    }
    return msg;
  });

  return { messages: result, summarized };
}

// ── Pass 3: args JSON 截断 ──────────────────────────────────────────────────

/**
 * 安全截断 JSON 字符串，保证输出仍是有效 JSON。
 *
 * 对标 Hermes agent/tool_executor.py 的 JSON 结构感知截断。
 *
 * 旧实现问题：
 *   - 在任意位置切片 → 可能切断 key/value
 *   - 末尾插入 `,"_truncated":true` → 在 key 中间或 value 中间时无效
 *   - 中间插入纯文本 `\n... [args truncated N chars] ...\n` → JSON 解析失败
 *
 * 新实现策略：
 *   1. 尝试 JSON.parse 原始字符串
 *   2. 成功 → walk parsed value，按 key-value/element 边界累加预算，截断后加 _truncated 标记
 *   3. 失败 → 退回保守策略：在最后一个安全边界（逗号、对象闭合、数组闭合）后截断
 *
 * @param jsonStr 原始 JSON 字符串
 * @param headChars 保留的头部字符数预算
 * @returns 截断后的有效 JSON 字符串（含 _truncated 标记）
 */
function truncateJsonSafely(jsonStr: string, headChars: number): string {
  if (jsonStr.length <= headChars) return jsonStr;

  // 策略 1：尝试解析后按结构边界截断（最优路径）
  try {
    const parsed = JSON.parse(jsonStr);
    return truncateParsedJson(parsed, headChars);
  } catch {
    // 原始字符串不是有效 JSON（罕见）→ 退回策略 2
  }

  // 策略 2：保守边界查找 — 在最后一个安全边界（逗号、对象闭合、数组闭合）后截断
  return truncateByBoundary(jsonStr, headChars);
}

/**
 * 对已解析的 JSON 值进行预算感知截断。
 * - 对象：逐 key-value 重新序列化，超过预算时停止并加 _truncated
 * - 数组：逐 element 重新序列化，超过预算时停止
 * - 原始值：直接返回（已经很短）
 */
function truncateParsedJson(value: unknown, headChars: number): string {
  if (Array.isArray(value)) {
    // 数组：保留前 N 个完整 element
    const kept: unknown[] = [];
    let serialized = "[";
    let first = true;
    for (const el of value) {
      const piece = first ? JSON.stringify(el) : "," + JSON.stringify(el);
      if (serialized.length + piece.length + 2 > headChars) break; // +2 for "]"
      serialized += piece;
      kept.push(el);
      first = false;
    }
    if (kept.length < value.length) {
      // 部分截断：加 _truncated 标记（在数组中作为对象元素，避免破坏数组类型）
      serialized += `${first ? "" : ","}{"_truncated":true,"_dropped":${value.length - kept.length}}]`;
    } else {
      serialized += "]";
    }
    return serialized;
  }

  if (value !== null && typeof value === "object") {
    // 对象：逐 key-value 重新序列化
    const entries = Object.entries(value as Record<string, unknown>);
    const kept: Array<[string, unknown]> = [];
    let serialized = "{";
    let first = true;
    for (const [k, v] of entries) {
      const piece = first ? JSON.stringify(k) + ":" + JSON.stringify(v) : "," + JSON.stringify(k) + ":" + JSON.stringify(v);
      if (serialized.length + piece.length + 2 > headChars) break; // +2 for "}"
      serialized += piece;
      kept.push([k, v]);
      first = false;
    }
    if (kept.length < entries.length) {
      serialized += `${first ? "" : ","}"_truncated":true,"_dropped":${entries.length - kept.length}}`;
    } else {
      serialized += "}";
    }
    return serialized;
  }

  // 原始值（string/number/bool/null）：直接 stringify，应该已足够短
  return JSON.stringify(value);
}

/**
 * 边界查找策略：当 JSON.parse 失败时使用。
 * 在 headChars 预算内查找最后一个安全截断点（逗号后或对象/数组闭合后）。
 */
function truncateByBoundary(jsonStr: string, headChars: number): string {
  const head = jsonStr.slice(0, headChars);

  // 扫描 head，跟踪字符串上下文和括号深度
  let lastSafeCut = -1;
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      // 闭合后是一个安全截断点（如果是顶层或接近顶层）
      if (depth <= 1) lastSafeCut = i + 1;
    } else if (ch === "," && depth <= 1) {
      // 逗号后是安全截断点（在顶层或一级嵌套）
      lastSafeCut = i + 1;
    }
  }

  if (lastSafeCut <= 0) {
    // 没找到安全边界 → 返回空对象作为 fallback（避免无效 JSON）
    return '{"_truncated":true,"_reason":"no_safe_boundary"}';
  }

  const partial = jsonStr.slice(0, lastSafeCut);
  // 计算需要闭合的括号数
  let openBraces = 0;
  let openBrackets = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < partial.length; i++) {
    const ch = partial[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") openBraces++;
    else if (ch === "}") openBraces--;
    else if (ch === "[") openBrackets++;
    else if (ch === "]") openBrackets--;
  }

  // 移除末尾悬空的逗号
  let trimmed = partial.replace(/,\s*$/, "");

  // 在末尾加 _truncated 字段（如果当前在对象中）
  let closing = "";
  if (openBraces > 0) {
    closing = `,"_truncated":true`;
  }
  for (let i = 0; i < openBrackets; i++) closing += "]";
  for (let i = 0; i < openBraces; i++) closing += "}";

  return trimmed + closing;
}

/**
 * Pass 3: 截断 tool_calls 中的 args JSON。
 */
function truncateToolCallArgs(
  messages: ToolMessage[],
  config: ToolOutputPrunerConfig,
): { messages: ToolMessage[]; argsTruncated: number } {
  let argsTruncated = 0;

  const result = messages.map((msg) => {
    if (!msg.tool_calls || !Array.isArray(msg.tool_calls)) return msg;

    let modified = false;
    const newToolCalls = msg.tool_calls.map((tc) => {
      const args = tc.function?.arguments;
      if (!args || typeof args !== "string") return tc;
      if (args.length < config.argsTruncationThreshold) return tc;

      const truncated = truncateJsonSafely(args, config.argsTruncationHead);
      if (truncated !== args) {
        modified = true;
        argsTruncated++;
        return {
          ...tc,
          function: {
            ...tc.function,
            arguments: truncated,
          },
        };
      }
      return tc;
    });

    return modified ? { ...msg, tool_calls: newToolCalls } : msg;
  });

  return { messages: result, argsTruncated };
}

// ── 主类 ────────────────────────────────────────────────────────────────────

/**
 * 工具输出 3-pass 裁剪器。
 *
 * 借鉴 hermes-agent agent/context_compressor.py _prune_old_tool_results。
 */
export class ToolOutputPruner {
  private config: ToolOutputPrunerConfig;

  constructor(config: Partial<ToolOutputPrunerConfig> = {}) {
    this.config = { ...DEFAULT_PRUNER_CONFIG, ...config };
  }

  /**
   * 执行 3-pass 裁剪。
   *
   * @param messages 消息列表
   * @returns 裁剪后的消息列表 + 统计
   */
  prune(messages: ToolMessage[]): { messages: ToolMessage[]; stats: PruningStats } {
    const originalChars = this.countChars(messages);
    let current = messages;
    const stats: PruningStats = {
      deduplicated: 0,
      summarized: 0,
      argsTruncated: 0,
      originalChars,
      prunedChars: 0,
    };

    // Pass 1: 去重
    if (this.config.enableDedup) {
      const result = dedupToolOutputs(current, this.config.keepRecentN);
      current = result.messages;
      stats.deduplicated = result.deduplicated;
    }

    // Pass 2: 摘要
    if (this.config.enableSummary) {
      const result = applySummaryPass(current, this.config);
      current = result.messages;
      stats.summarized = result.summarized;
    }

    // Pass 3: args 截断
    if (this.config.enableArgsTruncation) {
      const result = truncateToolCallArgs(current, this.config);
      current = result.messages;
      stats.argsTruncated = result.argsTruncated;
    }

    stats.prunedChars = originalChars - this.countChars(current);
    return { messages: current, stats };
  }

  private countChars(messages: ToolMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        total += msg.content.length;
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            total += tc.function.arguments.length;
          }
        }
      }
    }
    return total;
  }

  /**
   * 更新配置。
   */
  updateConfig(config: Partial<ToolOutputPrunerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置。
   */
  getConfig(): ToolOutputPrunerConfig {
    return { ...this.config };
  }
}

// ── 单例 ────────────────────────────────────────────────────────────────────

let singleton: ToolOutputPruner | null = null;

export function getToolOutputPruner(config?: Partial<ToolOutputPrunerConfig>): ToolOutputPruner {
  if (!singleton) {
    singleton = new ToolOutputPruner(config);
  } else if (config) {
    singleton.updateConfig(config);
  }
  return singleton;
}

export function resetToolOutputPruner(): void {
  singleton = null;
}
