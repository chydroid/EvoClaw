/**
 * EvolutionCoordinator — 任务后置分析 → 质量记账 → 演化执行的闭环调度器
 *
 * 借鉴 OpenSpace 的三段式后台闭环：
 *   Recording → ExecutionAnalyzer → SkillQualityStore → SkillEvolver
 *
 * 工程约束（EvoClaw 特有）：
 *   - 严格后台化：任何异常只写 stderr，不影响主任务；不修改 history/system prompt
 *     （缓存神圣原则），只消费已落盘的 recording 快照。
 *   - 串行队列 + 最小间隔 + 每日上限，避免压测/批量任务把 aux 配额打爆。
 *   - 反循环：同一建议键在冷却窗口内只执行一次；执行前先登记，失败也不反复重试。
 *   - 质量过滤只影响「选择排序/演化优先级」，永不删除技能（AGENTS.md）。
 */

import { EventBus } from "@evoclaw/core";
import type {
  ExecutionAnalysis,
  EvolutionSuggestion,
} from "@evoclaw/skills";
import type { AnalyzeExecutionInput, ExecutionAnalyzer } from "./execution-analyzer";
import type { EvolvedSkill, EvolveContext, SkillEvolver } from "./skill-evolver";
import type { SkillQualityStore } from "./skill-quality-store";

// ── 类型 ──────────────────────────────────────────────────────

export interface EvolutionCoordinatorConfig {
  /** 总开关（默认 true；server 侧另有功能开关） */
  enabled?: boolean;
  /** 两次分析开始的最小间隔（默认 15s） */
  minIntervalMs?: number;
  /** 队列上限（默认 8；超出直接丢弃，避免积压） */
  maxQueueDepth?: number;
  /** 单日最多分析次数（默认 300） */
  dailyAnalysisCap?: number;
  /** 单次分析最多执行几条演化建议（默认 3） */
  maxSuggestionsPerRun?: number;
  /** 同一建议键 / 同一目标技能的演化冷却（默认 6h） */
  suggestionCooldownMs?: number;
}

export interface CoordinatorToolQuality {
  recordLlmToolIssues(
    issues: Array<{ toolKey: string; toolName: string; description: string }>,
  ): void;
}

export interface EvolutionCoordinatorDeps {
  analyzer: Pick<ExecutionAnalyzer, "analyze">;
  qualityStore: SkillQualityStore;
  evolver?: Pick<SkillEvolver, "evolve">;
  /** LLM 二次确认（缺省视为已确认：分析器本身即 LLM 判定） */
  confirmSuggestion?: (
    suggestion: EvolutionSuggestion,
  ) => Promise<{ confirmed: boolean; reason?: string }> | { confirmed: boolean; reason?: string };
  toolQuality?: CoordinatorToolQuality;
  eventBus?: EventBus;
  now?: () => number;
}

export interface CoordinatorStats {
  enabled: boolean;
  queued: number;
  analyzed: number;
  skipped: number;
  failed: number;
  dropped: number;
  toolIssueRuns: number;
  suggestions: number;
  confirmed: number;
  evolved: number;
  lastAnalyzedAt: number | null;
  lastEvolutionAt: number | null;
}

export const EVOLUTION_ANALYSIS_EVENT = "evolution.analysis_completed";

const DAY_MS = 24 * 60 * 60 * 1000;

// ── 主类 ──────────────────────────────────────────────────────

export class EvolutionCoordinator {
  private readonly analyzer: Pick<ExecutionAnalyzer, "analyze">;
  private readonly qualityStore: SkillQualityStore;
  private evolver?: Pick<SkillEvolver, "evolve">;
  private readonly confirmSuggestion?: EvolutionCoordinatorDeps["confirmSuggestion"];
  private readonly toolQuality?: CoordinatorToolQuality;
  private readonly eventBus?: EventBus;
  private readonly now: () => number;
  private readonly config: Required<EvolutionCoordinatorConfig>;

  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly handledTasks = new Set<string>();
  private readonly lastSuggestionAt = new Map<string, number>();
  private readonly lastTargetEvolvedAt = new Map<string, number>();
  private dayKey = "";
  private dayCount = 0;

  private stats: CoordinatorStats;

  constructor(deps: EvolutionCoordinatorDeps, config: EvolutionCoordinatorConfig = {}) {
    this.analyzer = deps.analyzer;
    this.qualityStore = deps.qualityStore;
    this.evolver = deps.evolver;
    this.confirmSuggestion = deps.confirmSuggestion;
    this.toolQuality = deps.toolQuality;
    this.eventBus = deps.eventBus;
    this.now = deps.now ?? (() => Date.now());
    this.config = {
      enabled: config.enabled ?? true,
      minIntervalMs: config.minIntervalMs ?? 15_000,
      maxQueueDepth: config.maxQueueDepth ?? 8,
      dailyAnalysisCap: config.dailyAnalysisCap ?? 300,
      maxSuggestionsPerRun: config.maxSuggestionsPerRun ?? 3,
      suggestionCooldownMs: config.suggestionCooldownMs ?? 6 * 60 * 60 * 1000,
    };
    this.stats = {
      enabled: this.config.enabled,
      queued: 0,
      analyzed: 0,
      skipped: 0,
      failed: 0,
      dropped: 0,
      toolIssueRuns: 0,
      suggestions: 0,
      confirmed: 0,
      evolved: 0,
      lastAnalyzedAt: null,
      lastEvolutionAt: null,
    };
  }

  setEvolver(evolver: Pick<SkillEvolver, "evolve"> | undefined): void {
    this.evolver = evolver;
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.stats.enabled = enabled;
  }

  /**
   * 提交一次执行分析（串行后台）。返回本次分析结果（若启用/有产出）。
   * 调用方可以 fire-and-forget；返回 Promise 便于测试与关停时等待。
   */
  handleRun(input: AnalyzeExecutionInput): Promise<ExecutionAnalysis | null> {
    if (!this.config.enabled) return Promise.resolve(null);
    if (input.isSubagent || input.skip) return Promise.resolve(null);
    if (this.handledTasks.has(input.taskId)) return Promise.resolve(null);
    if (this.pending >= this.config.maxQueueDepth) {
      this.stats.dropped++;
      return Promise.resolve(null);
    }
    this.handledTasks.add(input.taskId);
    if (this.handledTasks.size > 1_000) {
      const first = this.handledTasks.values().next().value;
      if (typeof first === "string") this.handledTasks.delete(first);
    }

    this.pending++;
    const result = this.chain.then(async () => {
      // 排队期间可能被关停
      if (!this.config.enabled) return null;
      await this.waitForGap();
      return this.process(input);
    });
    // chain 必须吞掉异常，否则一次失败会中断后续队列
    this.chain = result.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.pending--;
    });
    return result.catch((err: unknown) => {
      this.stats.failed++;
      process.stderr.write(
        `[EvolutionCoordinator] analysis failed for ${input.taskId}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return null;
    });
  }

  /** 等待队列清空（测试/shutdown）。 */
  async flush(): Promise<void> {
    await this.chain;
    await this.qualityStore.flush();
  }

  getStats(): CoordinatorStats {
    return { ...this.stats, queued: this.pending };
  }

  /** 便于测试重置冷却/日配额状态。 */
  resetState(): void {
    this.handledTasks.clear();
    this.lastSuggestionAt.clear();
    this.lastTargetEvolvedAt.clear();
    this.dayKey = "";
    this.dayCount = 0;
  }

  // ── 内部 ────────────────────────────────────────────────

  private async process(input: AnalyzeExecutionInput): Promise<ExecutionAnalysis | null> {
    if (!this.consumeDailyQuota()) {
      this.stats.skipped++;
      return null;
    }

    const analysis = await this.analyzer.analyze(input);
    if (!analysis) {
      this.stats.skipped++;
      return null;
    }
    this.stats.analyzed++;
    this.stats.lastAnalyzedAt = this.now();

    // 1) 质量四计数器落盘
    try {
      this.qualityStore.recordAnalysis(analysis);
    } catch (err) {
      process.stderr.write(
        `[EvolutionCoordinator] quality record failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    // 2) 工具语义问题回灌 ToolQualityManager
    if (this.toolQuality && analysis.toolIssues.length > 0) {
      try {
        this.toolQuality.recordLlmToolIssues(analysis.toolIssues);
        this.stats.toolIssueRuns++;
      } catch { /* best-effort */ }
    }

    // 3) 演化建议：过滤 / 确认 / 执行
    const suggestions = analysis.suggestions.slice(0, this.config.maxSuggestionsPerRun);
    const evolved = await this.executeSuggestions(suggestions, analysis, input);

    await this.publishAnalysis(analysis, evolved);
    return analysis;
  }

  private async executeSuggestions(
    suggestions: EvolutionSuggestion[],
    analysis: ExecutionAnalysis,
    input: AnalyzeExecutionInput,
  ): Promise<EvolvedSkill[]> {
    const results: EvolvedSkill[] = [];
    if (!this.evolver) return results;

    for (const suggestion of suggestions) {
      this.stats.suggestions++;
      const key = suggestionKey(suggestion);
      if (this.isCoolingDown(key, suggestion.targetSkillIds)) {
        this.stats.skipped++;
        continue;
      }

      // 先登记（fail-closed）：即使随后失败也不会高频重试
      const at = this.now();
      this.lastSuggestionAt.set(key, at);
      for (const target of suggestion.targetSkillIds) {
        this.lastTargetEvolvedAt.set(target, at);
      }

      if (this.confirmSuggestion) {
        try {
          const verdict = await this.confirmSuggestion(suggestion);
          if (!verdict.confirmed) {
            this.stats.skipped++;
            continue;
          }
          suggestion.llmConfirmed = true;
          suggestion.llmConfirmationReason = verdict.reason;
        } catch (err) {
          process.stderr.write(
            `[EvolutionCoordinator] confirmation failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          this.stats.skipped++;
          continue;
        }
      }
      this.stats.confirmed++;

      const context: EvolveContext = {
        analysis,
        taskDescription: input.message,
        quality: this.qualityForSuggestions(suggestion),
      };
      try {
        const result = await this.evolver.evolve(suggestion, context);
        if (!result) {
          this.stats.failed++;
          continue;
        }
        results.push(result);
        this.stats.evolved++;
        this.stats.lastEvolutionAt = this.now();
        try {
          this.qualityStore.markEvolved(result.skillId);
          this.qualityStore.markEvolved(result.name);
        } catch { /* best-effort */ }
      } catch (err) {
        this.stats.failed++;
        process.stderr.write(
          `[EvolutionCoordinator] evolution failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    return results;
  }

  private qualityForSuggestions(
    suggestion: EvolutionSuggestion,
  ): EvolveContext["quality"] | undefined {
    const target = suggestion.targetSkillIds[0];
    if (!target) return undefined;
    const entry = this.qualityStore.get(target);
    if (!entry) return undefined;
    return {
      selections: entry.totalSelections,
      applied: entry.totalApplied,
      completions: entry.totalCompleted,
      fallbacks: entry.totalFallbacks,
    };
  }

  private isCoolingDown(key: string, targets: string[]): boolean {
    const cutoff = this.now() - this.config.suggestionCooldownMs;
    const keyAt = this.lastSuggestionAt.get(key);
    if (typeof keyAt === "number" && keyAt > cutoff) return true;
    for (const target of targets) {
      const at = this.lastTargetEvolvedAt.get(target);
      if (typeof at === "number" && at > cutoff) return true;
    }
    return false;
  }

  private consumeDailyQuota(): boolean {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.dayKey) {
      this.dayKey = day;
      this.dayCount = 0;
    }
    if (this.dayCount >= this.config.dailyAnalysisCap) return false;
    this.dayCount++;
    return true;
  }

  private async waitForGap(): Promise<void> {
    if (this.config.minIntervalMs <= 0) return;
    const gap = this.stats.lastAnalyzedAt === null
      ? 0
      : this.now() - (this.stats.lastAnalyzedAt + this.config.minIntervalMs);
    if (gap >= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, -gap);
      timer.unref?.();
    });
  }

  private async publishAnalysis(
    analysis: ExecutionAnalysis,
    evolved: EvolvedSkill[],
  ): Promise<void> {
    if (!this.eventBus) return;
    try {
      await this.eventBus.publish(
        EVOLUTION_ANALYSIS_EVENT,
        {
          taskId: analysis.taskId,
          taskCompleted: analysis.taskCompleted ?? null,
          executionNote: analysis.executionNote ?? "",
          toolIssues: analysis.toolIssues.length,
          suggestions: analysis.suggestions.length,
          evolved: evolved.map((e) => ({
            skillId: e.skillId,
            name: e.name,
            evolutionType: e.evolutionType,
            parentIds: e.parentIds,
            changeSummary: e.changeSummary,
          })),
          analyzedAt: analysis.analyzedAt,
        },
        "evolution-coordinator",
      );
    } catch { /* best-effort */ }
  }
}

// ── 工具函数 ──────────────────────────────────────────────────

/** 建议去重键（类型 + 目标 + 方向前缀）。 */
export function suggestionKey(suggestion: EvolutionSuggestion): string {
  const targets = [...suggestion.targetSkillIds].sort().join(",");
  const direction = suggestion.reason
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${suggestion.type}|${targets}|${direction}`;
}

/** 日界重置辅助（导出便于测试）。 */
export function dayKeyOf(timestamp: number): string {
  return new Date(Math.floor(timestamp / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}
