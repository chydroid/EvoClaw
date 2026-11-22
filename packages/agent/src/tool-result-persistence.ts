/**
 * ToolResultPersistenceManager — 工具结果持久化管理器（三层防御）
 *
 * 借鉴 hermes-agent tools/tool_result_storage.py + tools/budget_config.py：
 *
 * 三层防御架构：
 *   Layer 1: Per-tool output cap（工具内预截断）
 *     - 工具如 search_files 自行预截断到 max_result_size_chars
 *     - 这是第一道防线，防止单个工具产生过大输出
 *
 *   Layer 2: Per-result persistence（maybe_persist_tool_result）
 *     - 超过阈值的结果写入 sandbox temp dir
 *     - 返回 <persisted-output> 预览块
 *     - 模型可通过 read_file 访问完整输出
 *
 *   Layer 3: Per-turn aggregate budget（enforce_turn_budget）
 *     - turn 结束时检查总输出大小
 *     - 超过 200K 时将最大的非持久化结果 spill 到磁盘
 *
 * 关键设计：
 *   - PINNED_THRESHOLDS：read_file = Infinity，防止 persist→read→persist 死循环
 *   - generate_preview：在最后一个换行处截断，保持可读性
 *   - <persisted-output> 标签协议：预览 + 文件路径引用
 *   - 通过 stdin 写入避免 MAX_ARG_STRLEN 限制
 */

import { existsSync, mkdirSync, readFileSync, statSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { homedir, tmpdir } from "os";
import { atomicWriteFileSync } from "@evoclaw/core";
import { wrapLongLines, truncateHeadTail } from "./tool-output-spill";

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface BudgetConfig {
  /** 单工具结果默认阈值（字符） */
  defaultResultSizeChars: number;
  /** 单 turn 总预算（字符） */
  turnBudgetChars: number;
  /** 预览大小（字符） */
  previewSizeChars: number;
  /** 每工具覆盖阈值 */
  toolOverrides: Record<string, number>;
  /** 固定阈值（不可覆盖） */
  pinnedThresholds: Record<string, number>;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  defaultResultSizeChars: 100_000,
  turnBudgetChars: 200_000,
  previewSizeChars: 1_500,
  toolOverrides: {},
  // read_file = Infinity 防止 persist→read→persist 死循环
  pinnedThresholds: {
    read_file: Infinity,
    readFile: Infinity,
    cat: Infinity,
    head: Infinity,
    tail: Infinity,
  },
};

// ── budget 按模型上下文窗口缩放（借鉴 hermes-agent budget_for_context_window） ──

/**
 * 最小上下文长度阈值。低于此值的 aux 模型不应承担工具结果处理。
 */
const MINIMUM_CONTEXT_LENGTH = 16_384;

/**
 * 基准上下文长度。budget 默认值对应此上下文规模。
 */
const BASELINE_CONTEXT_LENGTH = 128_000;

/**
 * 根据模型上下文窗口动态缩放 budget 配置。
 *
 * 借鉴 hermes-agent tools/budget_config.py 的 budget_for_context_window：
 *   - 小上下文模型（如本地 32K 模型）：按比例缩小 budget
 *   - 大上下文模型（200K+）：保持默认值
 *   - 防止单个工具结果把请求推过模型上限
 *
 * @param contextLength 模型的上下文窗口长度（tokens）
 * @param baseConfig 基准配置（默认 DEFAULT_BUDGET_CONFIG）
 * @returns 缩放后的 BudgetConfig
 */
export function budgetForContextWindow(
  contextLength: number,
  baseConfig: BudgetConfig = DEFAULT_BUDGET_CONFIG,
): BudgetConfig {
  // 上下文长度未知或异常大时，使用默认配置
  if (!contextLength || contextLength <= 0 || contextLength >= BASELINE_CONTEXT_LENGTH) {
    return baseConfig;
  }

  // 低于最小阈值时，返回极保守配置（仅保留 pinned 防死循环）
  if (contextLength < MINIMUM_CONTEXT_LENGTH) {
    return {
      ...baseConfig,
      defaultResultSizeChars: 4_000,
      turnBudgetChars: 8_000,
      previewSizeChars: 500,
    };
  }

  // 按比例缩放：contextLength / BASELINE
  const scale = contextLength / BASELINE_CONTEXT_LENGTH;
  return {
    ...baseConfig,
    defaultResultSizeChars: Math.max(8_000, Math.floor(baseConfig.defaultResultSizeChars * scale)),
    turnBudgetChars: Math.max(16_000, Math.floor(baseConfig.turnBudgetChars * scale)),
    previewSizeChars: Math.max(500, Math.floor(baseConfig.previewSizeChars * scale)),
  };
}

export interface PersistedOutputInfo {
  /** 是否被持久化 */
  persisted: boolean;
  /** 处理后的内容（持久化时为预览块，否则为原内容） */
  content: string;
  /** 原始大小（字符） */
  originalSize: number;
  /** 持久化文件路径（如果持久化） */
  filePath?: string;
}

export interface TurnBudgetResult {
  /** spill 到磁盘的结果数 */
  spilled: number;
  /** 修改后的消息列表 */
  messages: TurnMessage[];
  /** turn 总字符数（spill 后） */
  totalChars: number;
}

export interface TurnMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  name?: string;
}

// ── 常量 ────────────────────────────────────────────────────────────────────

const PERSISTED_OUTPUT_TAG = "<persisted-output>";
const PERSISTED_OUTPUT_END_TAG = "</persisted-output>";
const STORAGE_DIR_NAME = "evoclaw-results";

// ── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 解析存储目录。
 * 借鉴 hermes-agent _resolve_storage_dir：
 *   优先使用 temp-backed 目录，支持 Termux。
 */
function resolveStorageDir(): string {
  // 优先使用系统 temp 目录（通常是 tmpfs/RAM-backed）
  const tmp = tmpdir();
  const storageDir = join(tmp, STORAGE_DIR_NAME);
  if (!existsSync(storageDir)) {
    try {
      mkdirSync(storageDir, { recursive: true });
    } catch {
      // 回退到用户目录
      return join(homedir(), ".evoclaw", "results");
    }
  }
  return storageDir;
}

/**
 * 生成预览。
 * 借鉴 hermes-agent `_head_tail_preview`（head + elision marker + tail）：
 *   工具结果（尤其 exec JSON）把退出码 / error 等关键字段放在对象**尾部**，
 *   只保留头部预览等于让模型永远看不到失败原因。头部按换行对齐，尾部保底
 *   保留 30%（至少 200 字符）。
 */
export function generatePreview(content: string, maxChars: number): { preview: string; hasMore: boolean } {
  if (content.length <= maxChars) {
    return { preview: content, hasMore: false };
  }

  const headLen = Math.max(1, Math.floor(maxChars * 0.7));
  let head = content.slice(0, headLen);
  // 头段尽量在换行处收口，避免半行/半个 JSON 字段
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline > headLen * 0.5) head = head.slice(0, lastNewline);

  const tailLen = Math.max(Math.min(200, Math.floor(maxChars * 0.3)), maxChars - head.length);
  const tail = content.slice(-tailLen);
  const elided = Math.max(0, content.length - head.length - tail.length);
  const preview = `${head}\n... [${elided} chars elided] ...\n${tail}`;
  return { preview, hasMore: true };
}

/**
 * exec 结果专用预览（hermes `_head_tail_preview` 语义）：
 * 元数据 + 输出头 + elision 标记 + **输出尾**。
 *
 * 通用头尾预览作用在渲染后的全文上，尾部可能是 `--- stderr/error ---` 区块；
 * 而失败构建的报错行通常位于 output 的**最后一行**，模型必须不读文件就能看到。
 * 因此这里显式取 output 文本的尾部（绝不取元数据块尾部），元数据/error 摘要
 * 放在头部 lead。仅对带 exitCode/exit_code 的命令结果生效。
 */
function buildExecPreview(content: string, maxChars: number): { preview: string; hasMore: boolean } | null {
  if (content.length <= maxChars) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (!("exitCode" in rec || "exit_code" in rec)) return null;

  const outputKey = ["output", "stdout", "content", "text"].find(
    (key) => typeof rec[key] === "string" && (rec[key] as string).length > 0,
  );
  if (!outputKey) return null;
  const output = rec[outputKey] as string;

  const bodyKeys = new Set(["output", "stdout", "content", "text", "stderr", "error"]);
  const leadLines: string[] = [];
  for (const [key, value] of Object.entries(rec)) {
    if (bodyKeys.has(key) || value === undefined) continue;
    leadLines.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  for (const key of ["error", "stderr"]) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) {
      leadLines.push(`${key}: ${value.slice(0, 300)}${value.length > 300 ? "…" : ""}`);
    }
  }
  const lead = `${leadLines.join("\n")}\n--- ${outputKey} (${output.length} chars) ---\n`;

  const tailLen = Math.min(output.length, Math.max(400, Math.floor((maxChars - lead.length) / 5)));
  let tail = output.slice(-tailLen);
  const firstNewline = tail.indexOf("\n");
  if (firstNewline >= 0 && firstNewline < tail.length - 1) tail = tail.slice(firstNewline + 1);
  const headBudget = maxChars - lead.length - tail.length - 96;
  if (headBudget <= 0) return null;
  let head = output.slice(0, headBudget);
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline > headBudget / 2) head = head.slice(0, lastNewline + 1);
  const hidden = output.length - head.length - tail.length;
  if (hidden <= 0) return null;

  return {
    preview: `${lead}${head}\n[... ${hidden} chars elided; full output in the saved file ...]\n${tail}`,
    hasMore: true,
  };
}

/**
 * 把落盘内容渲染成**可按行分页**的文本（hermes pageable_archive_text）。
 *
 * 原始 `JSON.stringify` 结果是一整行：file_read 以行 offset/limit 分页且有
 * 16K 单页上限，单行文件永远读不到 16K 之后的内容。这里把 JSON 拆成
 * 「元数据行 + output/stdout/content + stderr/error」的可读区块，非 JSON
 * 文本则按 1800 字符切行。落盘的是**全文**（不丢字符），只是加了换行。
 */
function renderPageable(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return wrapLongLines(content);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return wrapLongLines(JSON.stringify(parsed, null, 2) ?? String(parsed));
  }

  const rec = parsed as Record<string, unknown>;
  const bodyKeys = new Set(["output", "stdout", "content", "text", "stderr", "error"]);
  const sections: string[] = [];
  for (const [key, value] of Object.entries(rec)) {
    if (bodyKeys.has(key)) continue;
    if (value === undefined) continue;
    sections.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  for (const key of ["output", "stdout", "content", "text"]) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) {
      sections.push(`--- ${key} (${value.length} chars) ---\n${value}`);
    }
  }
  for (const key of ["stderr", "error"]) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) {
      sections.push(`--- ${key} ---\n${value}`);
    }
  }
  return wrapLongLines(sections.length > 0 ? sections.join("\n") : content);
}

/**
 * 构建 <persisted-output> 消息块。
 * 借鉴 hermes-agent _build_persisted_message：
 *   格式：<persisted-output> 预览内容 ... [full output: path] </persisted-output>
 */
function buildPersistedMessage(
  preview: string,
  hasMore: boolean,
  originalSize: number,
  filePath: string,
): string {
  const lines: string[] = [PERSISTED_OUTPUT_TAG];
  lines.push(preview);
  if (hasMore) {
    lines.push(`... [${originalSize - preview.length} more chars]`);
  }
  lines.push(`[Full output (${originalSize} chars) saved to: ${filePath}]`);
  lines.push(`Use read_file with offset/limit to page through the complete output.`);
  lines.push(PERSISTED_OUTPUT_END_TAG);
  return lines.join("\n");
}

// ── 主类 ────────────────────────────────────────────────────────────────────

/**
 * 工具结果持久化管理器。
 *
 * 借鉴 hermes-agent tools/tool_result_storage.py。
 */
export class ToolResultPersistenceManager {
  private config: BudgetConfig;
  private storageDir: string;
  /** turn 内已持久化的结果跟踪 */
  private turnResults: Array<{ toolCallId: string; content: string; size: number; persisted: boolean }> = [];
  /** 进程级累计统计（跨 turn，供 EnhancementHub 展示真实接线） */
  private stats = {
    turns: 0,
    maybePersistCalls: 0,
    persisted: 0,
    spilled: 0,
    totalChars: 0,
  };

  constructor(config: Partial<BudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };
    this.storageDir = resolveStorageDir();
  }

  /**
   * 解析工具的阈值。
   * 借鉴 hermes-agent BudgetConfig.resolve_threshold：
   *   优先级：pinned → tool_overrides → default
   */
  resolveThreshold(toolName: string): number {
    // pinned 优先（不可覆盖）
    if (toolName in this.config.pinnedThresholds) {
      return this.config.pinnedThresholds[toolName];
    }
    // tool_overrides
    if (toolName in this.config.toolOverrides) {
      return this.config.toolOverrides[toolName];
    }
    // default
    return this.config.defaultResultSizeChars;
  }

  /**
   * Layer 2: 持久化单个工具结果（如果超过阈值）。
   *
   * 借鉴 hermes-agent maybe_persist_tool_result：
   *   1. 检查是否超过阈值
   *   2. 生成预览
   *   3. 写入 sandbox temp dir
   *   4. 返回 <persisted-output> 块
   *
   * @param content 工具输出内容
   * @param toolName 工具名称
   * @param toolCallId 工具调用 ID（用于文件名）
   */
  maybePersistToolResult(
    content: string,
    toolName: string,
    toolCallId: string,
  ): PersistedOutputInfo {
    const threshold = this.resolveThreshold(toolName);
    this.stats.maybePersistCalls++;
    this.stats.totalChars += content.length;

    // 不超过阈值，直接返回
    if (threshold === Infinity || content.length <= threshold) {
      this.turnResults.push({ toolCallId, content, size: content.length, persisted: false });
      return {
        persisted: false,
        content,
        originalSize: content.length,
      };
    }

    // 生成可按行分页的全文 + 头尾预览。exec 结果优先使用「输出尾」预览
    // （失败行通常在 output 末尾）；其余结果基于渲染文本做通用头尾预览。
    const rendered = renderPageable(content);
    const { preview, hasMore } =
      buildExecPreview(content, this.config.previewSizeChars) ??
      generatePreview(rendered, this.config.previewSizeChars);

    // 写入文件
    const fileName = `${toolCallId}.txt`;
    const filePath = join(this.storageDir, fileName);

    try {
      // 确保目录存在
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
      }
      atomicWriteFileSync(filePath, rendered);

      const persistedContent = buildPersistedMessage(preview, hasMore, rendered.length, filePath);

      this.turnResults.push({ toolCallId, content: persistedContent, size: content.length, persisted: true });
      this.stats.persisted++;

      return {
        persisted: true,
        content: persistedContent,
        originalSize: content.length,
        filePath,
      };
    } catch (err) {
      // 写入失败，回退到头尾截断（尾部错误信息优先保留）
      const truncated = truncateHeadTail(content, threshold);
      this.turnResults.push({ toolCallId, content: truncated, size: content.length, persisted: false });
      return {
        persisted: false,
        content: truncated,
        originalSize: content.length,
      };
    }
  }

  /**
   * Layer 3: 强制 turn 预算。
   *
   * 借鉴 hermes-agent enforce_turn_budget：
   *   1. 计算 turn 总字符数
   *   2. 如果超过预算，将最大的非持久化结果 spill 到磁盘
   *   3. 重复直到总字符数在预算内
   *
   * @param messages turn 内的所有工具消息
   */
  enforceTurnBudget(messages: TurnMessage[]): TurnBudgetResult {
    this.stats.turns++;
    let current = [...messages];
    let totalChars = current.reduce((sum, m) => sum + m.content.length, 0);
    let spilled = 0;

    while (totalChars > this.config.turnBudgetChars && spilled < 10) {
      // 找到最大的非持久化工具消息
      let largestIdx = -1;
      let largestSize = 0;
      for (let i = 0; i < current.length; i++) {
        const msg = current[i];
        // 跳过已持久化的（含 <persisted-output> 标签）
        if (msg.content.includes(PERSISTED_OUTPUT_TAG)) continue;
        // 跳过非工具消息
        if (msg.role !== "tool") continue;
        if (msg.content.length > largestSize) {
          largestSize = msg.content.length;
          largestIdx = i;
        }
      }

      if (largestIdx === -1) break; // 没有可 spill 的

      // spill 最大的
      const msg = current[largestIdx];
      const toolCallId = msg.tool_call_id || `spill-${spilled}`;
      const result = this.maybePersistToolResult(msg.content, msg.name || "unknown", toolCallId);

      current[largestIdx] = {
        ...msg,
        content: result.content,
      };

      totalChars = current.reduce((sum, m) => sum + m.content.length, 0);
      spilled++;
    }

    this.stats.spilled += spilled;
    return { spilled, messages: current, totalChars };
  }

  /**
   * 读取持久化的完整输出。
   */
  readPersistedResult(filePath: string): string | null {
    try {
      if (!existsSync(filePath)) return null;
      return readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * 清理过期的持久化文件。
   * 借鉴 hermes-agent 的清理逻辑：删除超过 maxAgeMs 的文件。
   */
  cleanupOldResults(maxAgeMs: number = 3600_000): number {
    let cleaned = 0;
    try {
      if (!existsSync(this.storageDir)) return 0;
      const { readdirSync, unlinkSync } = require("fs") as typeof import("fs");
      const now = Date.now();
      for (const file of readdirSync(this.storageDir)) {
        const filePath = join(this.storageDir, file);
        try {
          const stat = statSync(filePath);
          if (now - stat.mtimeMs > maxAgeMs) {
            unlinkSync(filePath);
            cleaned++;
          }
        } catch {
          // 跳过无法访问的文件
        }
      }
    } catch {
      // 清理失败不影响主流程
    }
    return cleaned;
  }

  /**
   * 重置 turn 状态（新 turn 开始时调用）。
   */
  resetTurn(): void {
    this.turnResults = [];
  }

  /**
   * 获取当前 turn 的结果统计。
   */
  getTurnStats(): { totalResults: number; persistedResults: number; totalChars: number } {
    return {
      totalResults: this.turnResults.length,
      persistedResults: this.turnResults.filter((r) => r.persisted).length,
      totalChars: this.turnResults.reduce((sum, r) => sum + r.size, 0),
    };
  }

  /**
   * 进程级统计（跨 turn）。
   */
  getStats(): {
    turns: number;
    maybePersistCalls: number;
    persisted: number;
    spilled: number;
    totalChars: number;
    turnResults: number;
    turnBudgetChars: number;
    storageDir: string;
  } {
    return {
      ...this.stats,
      turnResults: this.turnResults.length,
      turnBudgetChars: this.config.turnBudgetChars,
      storageDir: this.storageDir,
    };
  }

  /**
   * 获取配置。
   */
  getConfig(): BudgetConfig {
    return { ...this.config };
  }

  /**
   * 更新配置。
   */
  updateConfig(config: Partial<BudgetConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取存储目录。
   */
  getStorageDir(): string {
    return this.storageDir;
  }
}

// ── 单例 ────────────────────────────────────────────────────────────────────

let singleton: ToolResultPersistenceManager | null = null;

export function getToolResultPersistenceManager(config?: Partial<BudgetConfig>): ToolResultPersistenceManager {
  if (!singleton) {
    singleton = new ToolResultPersistenceManager(config);
  } else if (config) {
    singleton.updateConfig(config);
  }
  return singleton;
}

export function resetToolResultPersistenceManager(): void {
  singleton = null;
}
