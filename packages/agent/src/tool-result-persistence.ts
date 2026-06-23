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

import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir, tmpdir } from "os";

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
 * 借鉴 hermes-agent generate_preview：
 *   在 max_chars 内的最后一个换行处截断，保持可读性。
 */
export function generatePreview(content: string, maxChars: number): { preview: string; hasMore: boolean } {
  if (content.length <= maxChars) {
    return { preview: content, hasMore: false };
  }

  const slice = content.slice(0, maxChars);
  // 在最后一个换行处截断
  const lastNewline = slice.lastIndexOf("\n");
  const cutAt = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;
  const preview = slice.slice(0, cutAt).trimEnd();
  return { preview, hasMore: true };
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
  lines.push(`Use read_file to access the complete output.`);
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

    // 不超过阈值，直接返回
    if (threshold === Infinity || content.length <= threshold) {
      this.turnResults.push({ toolCallId, content, size: content.length, persisted: false });
      return {
        persisted: false,
        content,
        originalSize: content.length,
      };
    }

    // 生成预览
    const { preview, hasMore } = generatePreview(content, this.config.previewSizeChars);

    // 写入文件
    const fileName = `${toolCallId}.txt`;
    const filePath = join(this.storageDir, fileName);

    try {
      // 确保目录存在
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
      }
      writeFileSync(filePath, content, "utf8");

      const persistedContent = buildPersistedMessage(preview, hasMore, content.length, filePath);

      this.turnResults.push({ toolCallId, content: persistedContent, size: content.length, persisted: true });

      return {
        persisted: true,
        content: persistedContent,
        originalSize: content.length,
        filePath,
      };
    } catch (err) {
      // 写入失败，回退到截断
      const truncated = content.slice(0, threshold) + `\n... [truncated, ${content.length - threshold} chars omitted]`;
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
