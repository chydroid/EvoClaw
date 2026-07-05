/**
 * ToolQualityManager — 工具质量跟踪 + 惩罚式排序
 *
 * 借鉴 OpenSpace grounding/core/quality/manager.py ToolQualityManager：
 *   - record_execution() 记录每次工具调用（成功/失败/耗时）
 *   - get_penalty() 返回 0.2-1.0 惩罚因子，adjust_ranking() 用 semantic_score * penalty 重排
 *   - 惩罚规则：success_rate < 0.4 才惩罚；连续失败 3 次额外扣 0.1，5 次扣 0.3
 *   - MAX_RECENT_EXECUTIONS=100 滚动窗口
 *
 * EvoClaw 落地点：
 *   - 接入 tool-result-middleware.ts 的 recordExecution()
 *   - tool-search.ts 排序后调用 adjustRanking()
 *   - 与 tool-retry.ts / tool-result-cache.ts 联动
 */

import { EventEmitter } from "events";

// ── 类型 ──────────────────────────────────────────────────────

export interface ToolExecutionRecord {
  /** 工具唯一键（通常是工具名 + 参数 hash） */
  toolKey: string;
  /** 工具名 */
  toolName: string;
  /** 是否成功 */
  success: boolean;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** 错误信息（失败时） */
  error?: string;
  /** 时间戳 */
  timestamp: number;
  /** 来源标记：rule（规则判定）/ llm（LLM 反馈） */
  source: "rule" | "llm";
}

export interface ToolQualityRecord {
  toolKey: string;
  toolName: string;
  /** 最近 N 次执行（滚动窗口） */
  recentExecutions: ToolExecutionRecord[];
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** LLM 标记次数 */
  llmFlaggedCount: number;
  /** 总成功次数 */
  totalSuccess: number;
  /** 总失败次数 */
  totalFailure: number;
  /** 平均耗时 */
  avgLatencyMs: number;
  /** 最近一次执行时间 */
  lastExecutionAt: number | null;
  /** 描述 hash（用于描述变更检测） */
  descriptionHash?: string;
}

export interface ToolPenaltyInfo {
  toolKey: string;
  /** 惩罚因子 0.2-1.0（1.0 = 无惩罚） */
  penalty: number;
  /** 最近成功率 */
  recentSuccessRate: number;
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** 是否被 LLM 标记 */
  llmFlagged: boolean;
}

export interface ToolQualityReport {
  /** 汇总统计 */
  summary: {
    totalTools: number;
    trackedTools: number;
    avgSuccessRate: number;
    problematicTools: number;
  };
  /** 按工具分组（含 penalty） */
  byTool: Array<ToolPenaltyInfo & { totalCalls: number }>;
  /** 问题工具（成功率 < 0.4 或 LLM 标记 ≥ 2） */
  problematicTools: Array<ToolPenaltyInfo & { reasons: string[] }>;
  /** 推荐降级/禁用的工具 */
  recommendations: Array<{ toolKey: string; action: "degrade" | "disable" | "review"; reason: string }>;
}

export interface ToolQualityManagerOptions {
  /** 滚动窗口大小（默认 100） */
  maxRecentExecutions?: number;
  /** records Map 最大条数（默认 5000，防止无限增长） */
  maxRecords?: number;
  /** 触发惩罚的成功率阈值（默认 0.4） */
  penaltyThreshold?: number;
  /** 最小惩罚因子（默认 0.2） */
  minPenalty?: number;
  /** 最大惩罚因子（默认 1.0 = 无惩罚） */
  maxPenalty?: number;
  /** 连续失败 3 次额外扣分（默认 0.1） */
  consecutiveFailurePenalty3?: number;
  /** 连续失败 5 次额外扣分（默认 0.3） */
  consecutiveFailurePenalty5?: number;
  /** LLM 标记阈值（默认 2） */
  llmFlagThreshold?: number;
  /** 自动禁用阈值（连续失败次数，默认 10） */
  autoDisableThreshold?: number;
}

// ── 默认配置 ──────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<ToolQualityManagerOptions> = {
  maxRecentExecutions: 100,
  maxRecords: 5000,
  penaltyThreshold: 0.4,
  minPenalty: 0.2,
  maxPenalty: 1.0,
  consecutiveFailurePenalty3: 0.1,
  consecutiveFailurePenalty5: 0.3,
  llmFlagThreshold: 2,
  autoDisableThreshold: 10,
};

// ── 主类 ──────────────────────────────────────────────────────

/**
 * ToolQualityManager
 *
 * 工作机制：
 *   1. recordExecution() 记录每次工具调用的成功/失败/耗时
 *   2. getPenalty(toolKey) 基于滚动窗口的成功率计算惩罚因子
 *   3. adjustRanking(toolsWithScores) 在排序后调用，惩罚低质量工具
 *   4. recordLlmToolIssues() 让 LLM 反馈语义失败（HTTP 200 但数据错误）
 *   5. getQualityReport() 生成质量报告
 *
 * 线程安全：所有方法同步执行，无需锁。
 * 持久化：内存模式不持久化；如需持久化可由 caller 定期调用 serialize()。
 */
export class ToolQualityManager extends EventEmitter {
  private opts: Required<ToolQualityManagerOptions>;
  private records = new Map<string, ToolQualityRecord>();
  private disabledTools = new Set<string>();

  constructor(options: ToolQualityManagerOptions = {}) {
    super();
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  // ── 记录 ────────────────────────────────────────────────

  /**
   * 记录一次工具执行。
   * @param toolKey 工具唯一键（如 "read_file:/path/to/file"）
   * @param toolName 工具名
   * @param success 是否成功
   * @param durationMs 耗时（毫秒）
   * @param error 错误信息
   * @param source 来源：rule（规则判定）/ llm（LLM 反馈）
   */
  recordExecution(
    toolKey: string,
    toolName: string,
    success: boolean,
    durationMs: number,
    error?: string,
    source: "rule" | "llm" = "rule",
  ): void {
    // LRU 上限保护：records Map 超过上限时淘汰最久未访问的记录
    if (this.records.size >= this.opts.maxRecords && !this.records.has(toolKey)) {
      const oldestKey = this.findOldestRecordKey();
      if (oldestKey) {
        this.records.delete(oldestKey);
      }
    }

    let record = this.records.get(toolKey);
    if (!record) {
      record = {
        toolKey,
        toolName,
        recentExecutions: [],
        consecutiveFailures: 0,
        llmFlaggedCount: 0,
        totalSuccess: 0,
        totalFailure: 0,
        avgLatencyMs: 0,
        lastExecutionAt: null,
      };
      this.records.set(toolKey, record);
    }

    const now = Date.now();
    const execution: ToolExecutionRecord = {
      toolKey,
      toolName,
      success,
      durationMs,
      error,
      timestamp: now,
      source,
    };

    // 滚动窗口：超过上限时移除最旧
    record.recentExecutions.push(execution);
    if (record.recentExecutions.length > this.opts.maxRecentExecutions) {
      record.recentExecutions.shift();
    }

    // 更新统计
    if (success) {
      record.consecutiveFailures = 0;
      record.totalSuccess++;
    } else {
      record.consecutiveFailures++;
      record.totalFailure++;
      // LLM 标记的失败单独计数
      if (source === "llm") {
        record.llmFlaggedCount++;
      }
    }

    // EMA 平均耗时
    if (record.avgLatencyMs === 0) {
      record.avgLatencyMs = durationMs;
    } else {
      record.avgLatencyMs = record.avgLatencyMs * 0.7 + durationMs * 0.3;
    }
    record.lastExecutionAt = now;

    // 自动禁用检查
    if (record.consecutiveFailures >= this.opts.autoDisableThreshold) {
      if (!this.disabledTools.has(toolKey)) {
        this.disabledTools.add(toolKey);
        this.emit("tool:disabled", { toolKey, toolName, reason: "consecutive_failures", count: record.consecutiveFailures });
      }
    }

    // 触发降级事件
    const penalty = this.computePenalty(record);
    if (penalty < this.opts.maxPenalty) {
      this.emit("tool:penalty", { toolKey, toolName, penalty, successRate: this.computeSuccessRate(record) });
    }
  }

  /**
   * 找出 lastExecutionAt 最早（或 null）的记录键，用于 LRU 淘汰。
   */
  private findOldestRecordKey(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, record] of this.records) {
      const time = record.lastExecutionAt ?? 0;
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }
    return oldestKey;
  }

  /**
   * LLM 反馈的工具问题（语义失败）。
   * 借鉴 OpenSpace record_llm_tool_issues()：把 LLM 识别的"HTTP 200 但数据错误"注入为 [LLM] 失败记录。
   */
  recordLlmToolIssues(issues: Array<{ toolKey: string; toolName: string; description: string }>): void {
    for (const issue of issues) {
      this.recordExecution(
        issue.toolKey,
        issue.toolName,
        false,
        0,
        `[LLM] ${issue.description}`,
        "llm",
      );
    }
    if (issues.length > 0) {
      this.emit("llm:issues-recorded", { count: issues.length });
    }
  }

  // ── 查询 ────────────────────────────────────────────────

  /** 检查工具是否被禁用 */
  isDisabled(toolKey: string): boolean {
    return this.disabledTools.has(toolKey);
  }

  /** 启用被自动禁用的工具 */
  enableTool(toolKey: string): void {
    this.disabledTools.delete(toolKey);
    const record = this.records.get(toolKey);
    if (record) {
      record.consecutiveFailures = 0;
    }
    this.emit("tool:enabled", { toolKey });
  }

  /** 计算工具的惩罚因子（0.2-1.0） */
  getPenalty(toolKey: string): number {
    const record = this.records.get(toolKey);
    if (!record || record.recentExecutions.length === 0) {
      return this.opts.maxPenalty;
    }
    return this.computePenalty(record);
  }

  /** 获取工具的惩罚详情 */
  getPenaltyInfo(toolKey: string): ToolPenaltyInfo | null {
    const record = this.records.get(toolKey);
    if (!record) return null;
    return {
      toolKey,
      penalty: this.computePenalty(record),
      recentSuccessRate: this.computeSuccessRate(record),
      consecutiveFailures: record.consecutiveFailures,
      llmFlagged: record.llmFlaggedCount >= this.opts.llmFlagThreshold,
    };
  }

  /**
   * 调整工具排序：对低质量工具施加惩罚。
   * @param toolsWithScores 工具列表（含语义分数）
   * @returns 调整后的排序（高分在前）
   */
  adjustRanking<T extends { toolKey?: string; toolName: string; score: number }>(
    toolsWithScores: T[],
  ): T[] {
    return toolsWithScores
      .map((tool) => {
        const key = tool.toolKey ?? tool.toolName;
        const penalty = this.getPenalty(key);
        return { ...tool, adjustedScore: tool.score * penalty };
      })
      .sort((a, b) => b.adjustedScore - a.adjustedScore);
  }

  /** 生成质量报告 */
  getQualityReport(): ToolQualityReport {
    const tracked = Array.from(this.records.values());
    const byTool: ToolQualityReport["byTool"] = [];
    const problematic: ToolQualityReport["problematicTools"] = [];
    const recommendations: ToolQualityReport["recommendations"] = [];

    let totalSuccessRate = 0;
    let problemCount = 0;

    for (const record of tracked) {
      const successRate = this.computeSuccessRate(record);
      const penalty = this.computePenalty(record);
      const totalCalls = record.totalSuccess + record.totalFailure;
      totalSuccessRate += successRate;

      byTool.push({
        toolKey: record.toolKey,
        penalty,
        recentSuccessRate: successRate,
        consecutiveFailures: record.consecutiveFailures,
        llmFlagged: record.llmFlaggedCount >= this.opts.llmFlagThreshold,
        totalCalls,
      });

      const reasons: string[] = [];
      if (successRate < this.opts.penaltyThreshold) {
        reasons.push(`success_rate=${successRate.toFixed(2)} < ${this.opts.penaltyThreshold}`);
        problemCount++;
      }
      if (record.llmFlaggedCount >= this.opts.llmFlagThreshold) {
        reasons.push(`llm_flagged=${record.llmFlaggedCount} >= ${this.opts.llmFlagThreshold}`);
        problemCount++;
      }
      if (record.consecutiveFailures >= 5) {
        reasons.push(`consecutive_failures=${record.consecutiveFailures}`);
        problemCount++;
      }

      if (reasons.length > 0) {
        problematic.push({
          toolKey: record.toolKey,
          penalty,
          recentSuccessRate: successRate,
          consecutiveFailures: record.consecutiveFailures,
          llmFlagged: record.llmFlaggedCount >= this.opts.llmFlagThreshold,
          reasons,
        });

        // 推荐动作
        if (this.disabledTools.has(record.toolKey)) {
          recommendations.push({
            toolKey: record.toolKey,
            action: "disable",
            reason: `已自动禁用（连续失败 ${record.consecutiveFailures} 次）`,
          });
        } else if (record.consecutiveFailures >= 5 || successRate < 0.2) {
          recommendations.push({
            toolKey: record.toolKey,
            action: "disable",
            reason: `建议禁用：成功率 ${successRate.toFixed(2)}，连续失败 ${record.consecutiveFailures} 次`,
          });
        } else if (record.llmFlaggedCount >= this.opts.llmFlagThreshold) {
          recommendations.push({
            toolKey: record.toolKey,
            action: "review",
            reason: `建议人工审查：LLM 标记 ${record.llmFlaggedCount} 次`,
          });
        } else {
          recommendations.push({
            toolKey: record.toolKey,
            action: "degrade",
            reason: `建议降级：惩罚因子 ${penalty.toFixed(2)}`,
          });
        }
      }
    }

    return {
      summary: {
        totalTools: tracked.length,
        trackedTools: tracked.length,
        avgSuccessRate: tracked.length > 0 ? totalSuccessRate / tracked.length : 1.0,
        problematicTools: problemCount,
      },
      byTool: byTool.sort((a, b) => a.penalty - b.penalty),
      problematicTools: problematic.sort((a, b) => a.penalty - b.penalty),
      recommendations,
    };
  }

  /** 获取所有被 LLM 标记的工具 */
  getLlmFlaggedTools(minFlags = 2): Array<{ toolKey: string; toolName: string; flagCount: number }> {
    const result: Array<{ toolKey: string; toolName: string; flagCount: number }> = [];
    for (const record of this.records.values()) {
      if (record.llmFlaggedCount >= minFlags) {
        result.push({
          toolKey: record.toolKey,
          toolName: record.toolName,
          flagCount: record.llmFlaggedCount,
        });
      }
    }
    return result.sort((a, b) => b.flagCount - a.flagCount);
  }

  /** 清空某工具的质量记录 */
  resetTool(toolKey: string): void {
    this.records.delete(toolKey);
    this.disabledTools.delete(toolKey);
  }

  /** 清空所有记录 */
  clear(): void {
    this.records.clear();
    this.disabledTools.clear();
  }

  // ── 内部计算 ────────────────────────────────────────────

  /** 计算最近成功率 */
  private computeSuccessRate(record: ToolQualityRecord): number {
    if (record.recentExecutions.length === 0) return 1.0;
    const success = record.recentExecutions.filter((e) => e.success).length;
    return success / record.recentExecutions.length;
  }

  /**
   * 计算惩罚因子（0.2-1.0）。
   *
   * 借鉴 OpenSpace get_penalty()：
   *   - success_rate < 0.4 才惩罚
   *   - 连续失败 3 次额外扣 0.1
   *   - 连续失败 5 次额外扣 0.3
   *   - LLM 标记 ≥ 2 次额外扣 0.2
   *   - 最终值 clamp 到 [minPenalty, maxPenalty]
   */
  private computePenalty(record: ToolQualityRecord): number {
    const successRate = this.computeSuccessRate(record);

    // 成功率高于阈值：不惩罚
    if (successRate >= this.opts.penaltyThreshold) {
      return this.opts.maxPenalty;
    }

    // 基础惩罚：成功率越低，惩罚越重
    let penalty = this.opts.maxPenalty - (this.opts.penaltyThreshold - successRate);

    // 连续失败额外扣分
    if (record.consecutiveFailures >= 5) {
      penalty -= this.opts.consecutiveFailurePenalty5;
    } else if (record.consecutiveFailures >= 3) {
      penalty -= this.opts.consecutiveFailurePenalty3;
    }

    // LLM 标记额外扣分
    if (record.llmFlaggedCount >= this.opts.llmFlagThreshold) {
      penalty -= 0.2;
    }

    return Math.max(this.opts.minPenalty, Math.min(this.opts.maxPenalty, penalty));
  }

  // ── 序列化（可选持久化） ────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      records: Array.from(this.records.entries()),
      disabledTools: Array.from(this.disabledTools),
    });
  }

  deserialize(data: string): void {
    try {
      const parsed = JSON.parse(data);
      this.records = new Map(parsed.records);
      this.disabledTools = new Set(parsed.disabledTools);
    } catch {
      // 反序列化失败：保持空状态
    }
  }
}
