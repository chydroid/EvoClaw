/**
 * EvolutionTriggers — 三触发器演化系统
 *
 * 借鉴 OpenSpace skill_engine/evolver.py 的三个触发器：
 *   1. post-analysis: LLM 分析后接受 EvolutionSuggestion
 *   2. tool-degradation: 工具成功率跌破阈值时触发（联动 ToolQualityManager）
 *   3. metric-monitor: 技能应用 ≥5 次但完成率 < 0.35 时触发
 *
 * 关键工程细节（OpenSpace 防循环机制）：
 *   - _addressed_degradations dict 防止同一问题重复触发
 *   - _MAX_EVOLUTION_ITERATIONS=5 单任务最多 5 次演化
 *   - _MAX_EVOLUTION_ATTEMPTS=3 同一问题最多 3 次尝试
 *   - 必须 LLM 二次确认（_llm_confirm_evolution）才执行
 *
 * EvoClaw 落地点：
 *   - 联动 ToolQualityManager（tool-degradation trigger）
 *   - 联动 SkillCurator（metric-monitor trigger）
 *   - 联动 RecordingManager（post-analysis trigger）
 *   - 产出 EvolutionSuggestion，由 EvolutionEngine 执行
 */

import { EventEmitter } from "events";
import type { EvolutionSuggestion } from "@evoclaw/skills";
import type { ToolQualityReport } from "@evoclaw/agent";

// ── 配置 ──────────────────────────────────────────────────────

export interface EvolutionTriggerConfig {
  /** 工具退化触发阈值：成功率低于此值触发（默认 0.4） */
  toolDegradationThreshold?: number;
  /** 指标监控：最少应用次数（默认 5） */
  metricMonitorMinSelections?: number;
  /** 指标监控：完成率低于此值触发（默认 0.35） */
  metricMonitorLowCompletionThreshold?: number;
  /** 单任务最多演化次数（默认 5） */
  maxEvolutionIterations?: number;
  /** 同一问题最多尝试次数（默认 3） */
  maxEvolutionAttempts?: number;
  /** 防循环窗口：已处理问题在 N ms 内不重复触发（默认 1 小时） */
  dedupWindowMs?: number;
}

const DEFAULT_CONFIG: Required<EvolutionTriggerConfig> = {
  toolDegradationThreshold: 0.4,
  metricMonitorMinSelections: 5,
  metricMonitorLowCompletionThreshold: 0.35,
  maxEvolutionIterations: 5,
  maxEvolutionAttempts: 3,
  dedupWindowMs: 60 * 60 * 1000, // 1 hour
};

// ── LLM 确认函数类型 ──────────────────────────────────────────

/**
 * LLM 二次确认函数。
 * 借鉴 OpenSpace _llm_confirm_evolution()：强制 LLM 确认演化建议，避免误报。
 */
export type LlmConfirmationFn = (
  suggestion: EvolutionSuggestion,
) => Promise<{ confirmed: boolean; reason: string }>;

// ── 技能指标 ──────────────────────────────────────────────────

export interface SkillMetrics {
  skillId: string;
  skillName: string;
  /** 被选中次数 */
  selections: number;
  /** 被应用次数 */
  applied: number;
  /** 完成次数（成功执行到底） */
  completions: number;
  /** 回退次数（执行中切换到其他技能） */
  fallbacks: number;
}

// ── 主类 ──────────────────────────────────────────────────────

/**
 * EvolutionTriggers
 *
 * 三个触发器分别检测：
 *   1. post-analysis: 由 caller 显式调用 processAnalysis()，传入 LLM 分析结果
 *   2. tool-degradation: 由 caller 调用 processToolDegradation()，传入 ToolQualityReport
 *   3. metric-monitor: 由 caller 调用 processMetricCheck()，传入 SkillMetrics[]
 *
 * 每个触发器产出 EvolutionSuggestion，但必须经 LLM 二次确认才会 emit "evolution:confirmed" 事件。
 * EvolutionEngine 监听此事件执行实际演化。
 */
export class EvolutionTriggers extends EventEmitter {
  private config: Required<EvolutionTriggerConfig>;
  private llmConfirm: LlmConfirmationFn | null;

  /** 已处理的退化问题（防循环） */
  private addressedDegradations = new Map<string, { count: number; lastAt: number }>();
  /** 已处理的指标问题 */
  private addressedMetrics = new Map<string, { count: number; lastAt: number }>();
  /** 当前任务的演化次数 */
  private evolutionIterations = 0;
  /** 当前任务 ID */
  private currentTaskId: string | null = null;

  constructor(config: EvolutionTriggerConfig = {}, llmConfirm: LlmConfirmationFn | null = null) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.llmConfirm = llmConfirm;
  }

  /** 设置 LLM 确认函数 */
  setLlmConfirmFn(fn: LlmConfirmationFn | null): void {
    this.llmConfirm = fn;
  }

  /** 开始新任务的演化跟踪 */
  startTask(taskId: string): void {
    this.currentTaskId = taskId;
    this.evolutionIterations = 0;
    this.addressedDegradations.clear();
    this.addressedMetrics.clear();
  }

  /** 结束任务 */
  endTask(): void {
    this.currentTaskId = null;
  }

  // ── Trigger 1: post-analysis ──────────────────────────

  /**
   * 处理 LLM 分析结果，接受其中的演化建议。
   *
   * @param analysis LLM 输出的分析结果（含 suggestions 字段）
   * @returns 已确认的演化建议列表
   */
  async processAnalysis(analysis: {
    suggestions?: Array<Omit<EvolutionSuggestion, "triggeredBy" | "llmConfirmed" | "createdAt">>;
  }): Promise<EvolutionSuggestion[]> {
    if (!analysis.suggestions || analysis.suggestions.length === 0) {
      return [];
    }

    if (this.evolutionIterations >= this.config.maxEvolutionIterations) {
      this.emit("evolution:limit-reached", { reason: "max_iterations", count: this.evolutionIterations });
      return [];
    }

    const confirmed: EvolutionSuggestion[] = [];
    for (const raw of analysis.suggestions) {
      const suggestion: EvolutionSuggestion = {
        ...raw,
        triggeredBy: "post-analysis",
        llmConfirmed: false,
        createdAt: Date.now(),
      };

      const accepted = await this.confirmAndEmit(suggestion);
      if (accepted) confirmed.push(suggestion);
    }

    return confirmed;
  }

  // ── Trigger 2: tool-degradation ───────────────────────

  /**
   * 检测工具退化，对成功率跌破阈值的工具触发演化。
   *
   * 借鉴 OpenSpace evolver.py 的"已处理集合 + 恢复时清理"：
   *   - 当某工具恢复（不再在 problematic 列表），自动清理其 addressed set
   *   - 下次再退化时所有依赖技能被重新评估
   *   - 这是状态驱动的反循环，比时间冷却更精确
   *
   * @param report ToolQualityManager 的质量报告
   * @returns 已确认的演化建议列表
   */
  async processToolDegradation(report: ToolQualityReport): Promise<EvolutionSuggestion[]> {
    if (this.evolutionIterations >= this.config.maxEvolutionIterations) {
      return [];
    }

    // 状态驱动反循环：清理已恢复工具的 addressed 记录
    this.cleanupRecoveredTools(report);

    const confirmed: EvolutionSuggestion[] = [];
    const now = Date.now();

    for (const tool of report.problematicTools) {
      // 防循环：检查是否已处理过此工具
      const addressed = this.addressedDegradations.get(tool.toolKey);
      if (addressed) {
        if (addressed.count >= this.config.maxEvolutionAttempts) {
          continue; // 超过最大尝试次数
        }
        if (now - addressed.lastAt < this.config.dedupWindowMs) {
          continue; // 在去重窗口内
        }
      }

      // 只对成功率低于阈值的工具触发
      if (tool.recentSuccessRate >= this.config.toolDegradationThreshold) {
        continue;
      }

      const suggestion: EvolutionSuggestion = {
        type: "fix",
        targetSkillIds: [], // 由 EvolutionEngine 根据 toolKey 找到对应技能
        reason: `工具退化：${tool.toolKey} 成功率 ${tool.recentSuccessRate.toFixed(2)} < ${this.config.toolDegradationThreshold}，连续失败 ${tool.consecutiveFailures} 次`,
        proposedChange: "", // 由 LLM 填充
        triggeredBy: "tool-degradation",
        triggerMetrics: {
          successRate: tool.recentSuccessRate,
          consecutiveFailures: tool.consecutiveFailures,
        },
        llmConfirmed: false,
        createdAt: now,
      };

      const accepted = await this.confirmAndEmit(suggestion);
      if (accepted) {
        confirmed.push(suggestion);
        this.addressedDegradations.set(tool.toolKey, {
          count: (addressed?.count ?? 0) + 1,
          lastAt: now,
        });
      }
    }

    return confirmed;
  }

  /**
   * 清理已恢复工具的 addressed 记录（借鉴 OpenSpace evolver.py line 336-343）。
   *
   * 当某工具不再出现在 problematicTools 中，说明已恢复，
   * 自动清理其 addressed set，下次再退化时所有依赖技能被重新评估。
   */
  private cleanupRecoveredTools(report: ToolQualityReport): void {
    const problematicKeys = new Set(report.problematicTools.map((t) => t.toolKey));
    const recovered: string[] = [];

    for (const key of this.addressedDegradations.keys()) {
      if (!problematicKeys.has(key)) {
        recovered.push(key);
      }
    }

    for (const key of recovered) {
      this.addressedDegradations.delete(key);
      this.emit("evolution:tool-recovered", { toolKey: key });
    }
  }

  // ── Trigger 3: metric-monitor ─────────────────────────

  /**
   * 检测技能指标，对应用次数足够但完成率低的技能触发演化。
   *
   * @param metrics 技能指标列表
   * @returns 已确认的演化建议列表
   */
  async processMetricCheck(metrics: SkillMetrics[]): Promise<EvolutionSuggestion[]> {
    if (this.evolutionIterations >= this.config.maxEvolutionIterations) {
      return [];
    }

    // 状态驱动反循环：清理已恢复技能的 addressed 记录
    this.cleanupRecoveredMetrics(metrics);

    const confirmed: EvolutionSuggestion[] = [];
    const now = Date.now();

    for (const metric of metrics) {
      // 需要足够的应用次数才触发（数据驱动）
      if (metric.applied < this.config.metricMonitorMinSelections) {
        continue;
      }

      const completionRate = metric.applied > 0 ? metric.completions / metric.applied : 1.0;
      if (completionRate >= this.config.metricMonitorLowCompletionThreshold) {
        continue;
      }

      // 防循环
      const addressed = this.addressedMetrics.get(metric.skillId);
      if (addressed) {
        if (addressed.count >= this.config.maxEvolutionAttempts) {
          continue;
        }
        if (now - addressed.lastAt < this.config.dedupWindowMs) {
          continue;
        }
      }

      const fallbackRate = metric.applied > 0 ? metric.fallbacks / metric.applied : 0;

      const suggestion: EvolutionSuggestion = {
        type: "fix",
        targetSkillIds: [metric.skillId],
        reason: `指标监控：技能 ${metric.skillName} 应用 ${metric.applied} 次，完成率 ${completionRate.toFixed(2)} < ${this.config.metricMonitorLowCompletionThreshold}，回退率 ${fallbackRate.toFixed(2)}`,
        proposedChange: "",
        triggeredBy: "metric-monitor",
        triggerMetrics: {
          completionRate,
          fallbackRate,
        },
        llmConfirmed: false,
        createdAt: now,
      };

      const accepted = await this.confirmAndEmit(suggestion);
      if (accepted) {
        confirmed.push(suggestion);
        this.addressedMetrics.set(metric.skillId, {
          count: (addressed?.count ?? 0) + 1,
          lastAt: now,
        });
      }
    }

    return confirmed;
  }

  /**
   * 清理已恢复技能的 addressed 记录（与 cleanupRecoveredTools 对称）。
   *
   * 当技能指标恢复良好（完成率 ≥ threshold 或应用次数不足触发条件），
   * 自动清理其 addressed set，下次再退化时重新评估。
   */
  private cleanupRecoveredMetrics(metrics: SkillMetrics[]): void {
    const stillProblematic = new Set(
      metrics
        .filter((m) => {
          if (m.applied < this.config.metricMonitorMinSelections) return false;
          const rate = m.applied > 0 ? m.completions / m.applied : 1.0;
          return rate < this.config.metricMonitorLowCompletionThreshold;
        })
        .map((m) => m.skillId),
    );

    const recovered: string[] = [];
    for (const key of this.addressedMetrics.keys()) {
      if (!stillProblematic.has(key)) {
        recovered.push(key);
      }
    }

    for (const key of recovered) {
      this.addressedMetrics.delete(key);
      this.emit("evolution:metric-recovered", { skillId: key });
    }
  }

  // ── 统计 ────────────────────────────────────────────────

  getStats(): {
    evolutionIterations: number;
    maxIterations: number;
    addressedDegradations: number;
    addressedMetrics: number;
    currentTaskId: string | null;
  } {
    return {
      evolutionIterations: this.evolutionIterations,
      maxIterations: this.config.maxEvolutionIterations,
      addressedDegradations: this.addressedDegradations.size,
      addressedMetrics: this.addressedMetrics.size,
      currentTaskId: this.currentTaskId,
    };
  }

  /** 重置所有状态（用于测试） */
  reset(): void {
    this.evolutionIterations = 0;
    this.currentTaskId = null;
    this.addressedDegradations.clear();
    this.addressedMetrics.clear();
  }

  // ── 内部 ────────────────────────────────────────────────

  private async confirmAndEmit(suggestion: EvolutionSuggestion): Promise<boolean> {
    // LLM 二次确认
    if (this.llmConfirm) {
      try {
        const result = await this.llmConfirm(suggestion);
        suggestion.llmConfirmed = result.confirmed;
        suggestion.llmConfirmationReason = result.reason;

        if (!result.confirmed) {
          this.emit("evolution:rejected", { suggestion, reason: result.reason });
          return false;
        }
      } catch (err) {
        // LLM 确认失败：保守起见不执行
        this.emit("evolution:confirmation-error", { suggestion, error: String(err) });
        return false;
      }
    } else {
      // 无 LLM 确认函数：不 emit "evolution:confirmed"（避免绕过 LLM 二次确认）
      // 仅 emit "evolution:needs-confirmation" 让上层决定是否手动确认
      suggestion.llmConfirmed = false;
      this.emit("evolution:needs-confirmation", suggestion);
      return false;
    }

    this.evolutionIterations++;
    this.emit("evolution:confirmed", suggestion);
    return true;
  }
}
