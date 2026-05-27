/**
 * Capability Upgrade — 能力评估与自动提升机制
 * 
 * 当检测到当前插件能力不足以支撑特定任务时，自动触发能力提升流程。
 * 包括：策略优化、提示词改进、模型参数调整、技能学习等。
 */

import { ServiceRegistry, EventBus } from "@evoclaw/core";
import type { CapabilityAssessment, ExecutionResult } from "./task-orchestrator";
import type { TaskType } from "./task-decomposer";

// ── Types ──────────────────────────────────────────────────

export interface UpgradeAction {
  type: "prompt_refinement" | "decomposition_adjustment" | "model_switch" | "context_enrichment" | "skill_learning" | "strategy_change";
  description: string;
  target: string;  // What to upgrade
  params: Record<string, unknown>;
  priority: number; // 1-10
  estimatedImpact: number; // 0-1
}

export interface UpgradeResult {
  action: UpgradeAction;
  applied: boolean;
  beforeAssessment: CapabilityAssessment;
  afterAssessment?: CapabilityAssessment;
  message: string;
}

export interface CapabilityProfile {
  level: number;
  taskTypeSuccessRates: Map<string, number>;
  totalExecutions: number;
  totalSuccesses: number;
  totalFailures: number;
  averageDurationMs: number;
  recentTrend: "improving" | "stable" | "declining";
  upgradeHistory: UpgradeResult[];
  lastUpgradeAt?: Date;
}

// ── Capability Upgrader ────────────────────────────────────

export class CapabilityUpgrader {
  private profile: CapabilityProfile;
  private pendingActions: UpgradeAction[] = [];

  constructor(
    private registry?: ServiceRegistry,
    private eventBus?: EventBus,
  ) {
    this.profile = {
      level: 5,
      taskTypeSuccessRates: new Map(),
      totalExecutions: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      averageDurationMs: 0,
      recentTrend: "stable",
      upgradeHistory: [],
    };
  }

  /**
   * Analyze an execution result and determine if upgrade is needed.
   */
  analyzeExecution(result: ExecutionResult): UpgradeAction[] {
    const actions: UpgradeAction[] = [];
    const assessment = result.capabilityAssessment;

    // Update profile
    this.updateProfile(result);

    // Check for upgrade triggers
    if (assessment.needsUpgrade) {
      // 1. Prompt refinement for weak task types
      for (const weakness of assessment.weaknesses) {
        const taskTypeMatch = weakness.match(/^(\w+)\s/);
        if (taskTypeMatch) {
          actions.push({
            type: "prompt_refinement",
            description: `优化 ${taskTypeMatch[1]} 类型任务的系统提示`,
            target: taskTypeMatch[1],
            params: {
              currentSuccessRate: assessment.failureRate,
              weakness,
            },
            priority: 7,
            estimatedImpact: 0.3,
          });
        }
      }

      // 2. Decomposition adjustment if tasks are too complex
      if (result.failedTasks.some(f => f.task.estimatedComplexity >= 7)) {
        actions.push({
          type: "decomposition_adjustment",
          description: "降低子任务复杂度，增加分解粒度",
          target: "decomposer",
          params: {
            maxComplexity: 5,
            increaseGranularity: true,
          },
          priority: 8,
          estimatedImpact: 0.4,
        });
      }

      // 3. Context enrichment if tasks lack context
      if (result.failedTasks.some(f => f.error.includes("context") || f.error.includes("上下文"))) {
        actions.push({
          type: "context_enrichment",
          description: "增强任务上下文注入，提供更多项目信息",
          target: "dispatcher",
          params: {
            includeProjectStructure: true,
            includeRelatedFiles: true,
            maxContextTokens: 8000,
          },
          priority: 6,
          estimatedImpact: 0.25,
        });
      }

      // 4. Strategy change if sequential tasks are failing
      if (assessment.failureRate > 0.6) {
        actions.push({
          type: "strategy_change",
          description: "切换到更保守的顺序执行策略",
          target: "orchestrator",
          params: {
            strategy: "sequential",
            maxConcurrentTasks: 1,
            maxRetriesPerTask: 3,
          },
          priority: 9,
          estimatedImpact: 0.5,
        });
      }

      // 5. Model switch if performance is consistently poor
      if (this.profile.recentTrend === "declining" && assessment.failureRate > 0.7) {
        actions.push({
          type: "model_switch",
          description: "建议切换到更强大的模型",
          target: "model",
          params: {
            reason: "当前模型在复杂编程任务上表现不佳",
            suggestedCapability: "high",
          },
          priority: 10,
          estimatedImpact: 0.6,
        });
      }
    }

    // Sort by priority
    actions.sort((a, b) => b.priority - a.priority);
    this.pendingActions = actions;

    return actions;
  }

  /**
   * Apply an upgrade action.
   */
  async applyAction(action: UpgradeAction): Promise<UpgradeResult> {
    const beforeAssessment = this.getCurrentAssessment();
    let applied = false;
    let message = "";

    try {
      switch (action.type) {
        case "prompt_refinement":
          applied = await this.applyPromptRefinement(action);
          message = applied ? `已优化 ${action.target} 类型的系统提示` : `优化 ${action.target} 提示失败`;
          break;

        case "decomposition_adjustment":
          applied = await this.applyDecompositionAdjustment(action);
          message = applied ? "已调整分解策略，降低子任务复杂度" : "分解策略调整失败";
          break;

        case "context_enrichment":
          applied = await this.applyContextEnrichment(action);
          message = applied ? "已增强上下文注入" : "上下文增强失败";
          break;

        case "strategy_change":
          applied = true; // Strategy changes are applied at orchestrator level
          message = `已标记策略变更: ${action.params.strategy}`;
          break;

        case "model_switch":
          applied = await this.applyModelSwitch(action);
          message = applied ? "已建议模型切换" : "模型切换不可用";
          break;

        case "skill_learning":
          applied = await this.applySkillLearning(action);
          message = applied ? "已学习新技能" : "技能学习失败";
          break;

        default:
          message = `未知升级类型: ${action.type}`;
      }
    } catch (err) {
      message = `升级失败: ${err instanceof Error ? err.message : String(err)}`;
    }

    const result: UpgradeResult = {
      action,
      applied,
      beforeAssessment,
      message,
    };

    this.profile.upgradeHistory.push(result);
    this.profile.lastUpgradeAt = new Date();

    this.eventBus?.publish("claude-code-tools:capability-upgraded", {
      actionType: action.type,
      applied,
      message,
    }, "capability-upgrader").catch(() => {});

    return result;
  }

  /**
   * Apply all pending upgrade actions.
   */
  async applyAllPending(): Promise<UpgradeResult[]> {
    const results: UpgradeResult[] = [];
    const actions = [...this.pendingActions];
    this.pendingActions = [];

    for (const action of actions) {
      const result = await this.applyAction(action);
      results.push(result);
    }

    return results;
  }

  /**
   * Get current capability profile.
   */
  getProfile(): CapabilityProfile {
    return { ...this.profile };
  }

  /**
   * Get current assessment summary.
   */
  getCurrentAssessment(): CapabilityAssessment {
    const successRate = this.profile.totalExecutions > 0
      ? this.profile.totalSuccesses / this.profile.totalExecutions
      : 1;

    return {
      level: this.profile.level,
      strengths: this.getStrengths(),
      weaknesses: this.getWeaknesses(),
      failureRate: 1 - successRate,
      averageTaskDurationMs: this.profile.averageDurationMs,
      recommendation: this.getRecommendation(successRate),
      needsUpgrade: successRate < 0.5,
    };
  }

  /**
   * Get pending upgrade actions.
   */
  getPendingActions(): UpgradeAction[] {
    return [...this.pendingActions];
  }

  // ── Private Methods ──────────────────────────────────────

  private updateProfile(result: ExecutionResult): void {
    this.profile.totalExecutions++;
    
    const successCount = result.completedTasks.length;
    const failCount = result.failedTasks.length;
    this.profile.totalSuccesses += successCount;
    this.profile.totalFailures += failCount;

    // Update average duration
    const totalTasks = successCount + failCount;
    if (totalTasks > 0) {
      this.profile.averageDurationMs = Math.round(
        (this.profile.averageDurationMs * (this.profile.totalExecutions - 1) + result.totalDurationMs / totalTasks) /
        this.profile.totalExecutions
      );
    }

    // Update task type success rates
    for (const completed of result.completedTasks) {
      // Find the task in the plan to get its type
      // We'll use a simplified approach
    }
    for (const failed of result.failedTasks) {
      const type = failed.task.type;
      const current = this.profile.taskTypeSuccessRates.get(type) ?? 1;
      // Exponential moving average
      this.profile.taskTypeSuccessRates.set(type, current * 0.8 + 0 * 0.2);
    }

    // Update trend
    const recentHistory = this.profile.upgradeHistory.slice(-5);
    if (recentHistory.length >= 3) {
      const recentApplied = recentHistory.filter(r => r.applied).length;
      if (recentApplied >= 3) {
        this.profile.recentTrend = "improving";
      } else if (recentApplied <= 1) {
        this.profile.recentTrend = "declining";
      } else {
        this.profile.recentTrend = "stable";
      }
    }

    // Update level
    const successRate = this.profile.totalSuccesses / Math.max(this.profile.totalExecutions, 1);
    this.profile.level = Math.max(1, Math.min(10, Math.round(successRate * 8 + 2)));
  }

  private getStrengths(): string[] {
    const strengths: string[] = [];
    for (const [type, rate] of this.profile.taskTypeSuccessRates) {
      if (rate >= 0.8) {
        strengths.push(`${type} 成功率 ${(rate * 100).toFixed(0)}%`);
      }
    }
    if (this.profile.averageDurationMs < 15000) {
      strengths.push("响应速度快");
    }
    return strengths;
  }

  private getWeaknesses(): string[] {
    const weaknesses: string[] = [];
    for (const [type, rate] of this.profile.taskTypeSuccessRates) {
      if (rate < 0.5) {
        weaknesses.push(`${type} 成功率低 (${(rate * 100).toFixed(0)}%)`);
      }
    }
    if (this.profile.averageDurationMs > 60000) {
      weaknesses.push("响应速度慢");
    }
    return weaknesses;
  }

  private getRecommendation(successRate: number): string {
    if (successRate >= 0.9) return "能力优秀，可处理高复杂度任务";
    if (successRate >= 0.7) return "能力良好，建议优化弱项任务类型";
    if (successRate >= 0.5) return "能力一般，建议增强上下文和提示策略";
    return "能力不足，需要升级模型或优化任务规划";
  }

  private async applyPromptRefinement(action: UpgradeAction): Promise<boolean> {
    // In a real implementation, this would modify the system prompts
    // For now, we emit an event so the LLMDispatcher can pick it up
    this.eventBus?.publish("claude-code-tools:prompt-refinement", {
      taskType: action.target,
      params: action.params,
    }, "capability-upgrader").catch(() => {});
    return true;
  }

  private async applyDecompositionAdjustment(action: UpgradeAction): Promise<boolean> {
    this.eventBus?.publish("claude-code-tools:decomposition-adjustment", {
      params: action.params,
    }, "capability-upgrader").catch(() => {});
    return true;
  }

  private async applyContextEnrichment(action: UpgradeAction): Promise<boolean> {
    this.eventBus?.publish("claude-code-tools:context-enrichment", {
      params: action.params,
    }, "capability-upgrader").catch(() => {});
    return true;
  }

  private async applyModelSwitch(action: UpgradeAction): Promise<boolean> {
    // Check if we can switch models via the registry
    if (!this.registry) return false;

    const configManager = this.registry.resolveService<{
      updateConfig(key: string, value: unknown): void;
    }>("configManager");

    if (configManager) {
      try {
        configManager.updateConfig("llm.preferredModel", action.params.suggestedCapability);
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  private async applySkillLearning(action: UpgradeAction): Promise<boolean> {
    // Trigger skill installation for the weak area
    if (!this.registry) return false;

    const skillManager = this.registry.resolveService<{
      searchSkills(query: Record<string, unknown>): Promise<unknown>;
      installSkill(path: string): Promise<unknown>;
    }>("skillManager");

    if (skillManager && action.target) {
      try {
        const results = await skillManager.searchSkills({ keyword: action.target });
        // In a real implementation, we'd install the best matching skill
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }
}
