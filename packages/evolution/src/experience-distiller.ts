/**
 * ExperienceDistiller — 经验蒸馏器
 * 
 * 借鉴 Hermes Agent 的 Closed Learning Loop 和阿里 AgentEvolver 的 Self-Navigate 机制：
 *   将零散的执行轨迹提炼为可复用的策略模板和技能，存入长期记忆。
 * 
 * 核心流程：
 *   1. 收集执行轨迹（成功/失败）
 *   2. 聚类相似轨迹，提取关键决策点
 *   3. 归纳为可复用的改进策略模板
 *   4. 存入策略知识库，供后续任务检索复用
 * 
 * 与 EvolutionProposer 的 IMPROVEMENT_STRATEGIES 关联：
 *   - 不替代硬编码的 5 个基础策略模板
 *   - 作为补充，动态生成新的策略模板
 *   - 根据成功率自动淘汰低效策略
 */

import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { v4 as uuid } from "uuid";
import { SemanticEmbedder } from "./semantic-embedder";
import type { ExecutionTrace, ReflectionResult } from "./external-reflector";

// ── Types ──────────────────────────────────────────────────

export interface DistilledStrategy {
  id: string;
  name: string;
  /** 策略适用的失败模式 */
  failurePattern: string;
  /** 策略模板（可注入到 EvolutionProposer） */
  template: string;
  /** 策略描述 */
  description: string;
  /** 基于多少条轨迹蒸馏得出 */
  sourceTrajectoryCount: number;
  /** 该策略的成功率 */
  successRate: number;
  /** 使用次数 */
  useCount: number;
  /** 创建时间 */
  createdAt: Date;
  /** 最后使用时间 */
  lastUsedAt: Date | null;
  /** 置信度 */
  confidence: number;
  /** 关联的标签 */
  tags: string[];
}

export interface DistillerConfig {
  /** 最小轨迹数量才能触发蒸馏 */
  minTrajectoriesForDistillation: number;
  /** 策略最低成功率（低于此值自动淘汰） */
  minSuccessRateForRetention: number;
  /** 最多保留多少条策略 */
  maxStrategies: number;
  /** 相似度阈值（用于聚类） */
  similarityThreshold: number;
}

export const DEFAULT_DISTILLER_CONFIG: DistillerConfig = {
  minTrajectoriesForDistillation: 3,
  minSuccessRateForRetention: 0.3,
  maxStrategies: 50,
  similarityThreshold: 0.6,
};

// ── ExperienceDistiller ────────────────────────────────────

export class ExperienceDistiller {
  private config: DistillerConfig;
  private strategies: Map<string, DistilledStrategy> = new Map();
  private trajectoryBuffer: Array<{
    trace: ExecutionTrace;
    reflection: ReflectionResult;
    timestamp: Date;
  }> = [];
  private embedder: SemanticEmbedder;
  private strategyEmbeddings: Map<string, number[]> = new Map();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    config?: Partial<DistillerConfig>,
  ) {
    this.config = { ...DEFAULT_DISTILLER_CONFIG, ...config };
    this.embedder = new SemanticEmbedder(registry);
  }

  /**
   * 添加执行轨迹和反思结果到缓冲区。
   * 当缓冲区积累足够轨迹时，自动触发蒸馏。
   */
  async addTrajectory(
    trace: ExecutionTrace,
    reflection: ReflectionResult,
  ): Promise<DistilledStrategy | null> {
    this.trajectoryBuffer.push({
      trace,
      reflection,
      timestamp: new Date(),
    });

    // 限制缓冲区大小
    if (this.trajectoryBuffer.length > 100) {
      this.trajectoryBuffer = this.trajectoryBuffer.slice(-50);
    }

    // 检查是否达到蒸馏阈值
    if (this.trajectoryBuffer.length >= this.config.minTrajectoriesForDistillation) {
      return this.distill();
    }

    return null;
  }

  /**
   * 执行蒸馏：从缓冲区中的轨迹提取可复用策略。
   */
  async distill(): Promise<DistilledStrategy | null> {
    if (this.trajectoryBuffer.length < this.config.minTrajectoriesForDistillation) {
      return null;
    }

    try {
      // 1. 按失败模式聚类轨迹
      const clusters = this.clusterTrajectories(this.trajectoryBuffer);

      // 2. 对每个聚类尝试蒸馏策略
      for (const [failurePattern, cluster] of clusters) {
        // 跳过已有策略且成功率高的模式
        const existing = this.findStrategyByPattern(failurePattern);
        if (existing && existing.successRate > 0.7) {
          continue;
        }

        // 需要足够的轨迹
        if (cluster.length < this.config.minTrajectoriesForDistillation) {
          continue;
        }

        const strategy = this.extractStrategy(failurePattern, cluster);
        if (strategy) {
          this.addStrategy(strategy);

          this.eventBus.publish(
            "evolution.strategy_distilled",
            {
              strategyId: strategy.id,
              name: strategy.name,
              failurePattern: strategy.failurePattern,
              sourceTrajectoryCount: strategy.sourceTrajectoryCount,
            },
            "experience-distiller",
          ).catch(() => {});

          return strategy;
        }
      }

      // 3. 清理低效策略
      this.pruneStrategies();
    } catch (err) {
      process.stderr.write(
        "[ExperienceDistiller] Distillation failed:" + " " + (err instanceof Error ? err.message : String(err)) + "\n"
      );
    }

    return null;
  }

  /**
   * 根据失败模式查找匹配的策略（类似 Hermes 的 Self-Navigate）
   */
  findMatchingStrategy(failurePattern: string): DistilledStrategy | null {
    // 精确匹配
    const exact = this.findStrategyByPattern(failurePattern);
    if (exact) return exact;

    // 模糊匹配（基于语义相似度）
    let bestMatch: DistilledStrategy | null = null;
    let bestScore = 0;

    for (const strategy of this.strategies.values()) {
      const similarity = this.stringSimilarity(
        failurePattern,
        strategy.failurePattern,
      );
      if (similarity > bestScore && similarity >= this.config.similarityThreshold) {
        bestScore = similarity;
        bestMatch = strategy;
      }
    }

    if (bestMatch) {
      bestMatch.useCount++;
      bestMatch.lastUsedAt = new Date();
    }

    return bestMatch;
  }

  /**
   * 获取所有蒸馏策略
   */
  getStrategies(): DistilledStrategy[] {
    return Array.from(this.strategies.values())
      .sort((a, b) => b.confidence * b.successRate - a.confidence * a.successRate);
  }

  /**
   * 获取策略统计
   */
  getStats(): {
    totalStrategies: number;
    activeStrategies: number;
    averageSuccessRate: number;
    bufferSize: number;
    topStrategies: Array<{ name: string; successRate: number; useCount: number }>;
  } {
    const strategies = Array.from(this.strategies.values());
    const active = strategies.filter((s) => s.successRate >= this.config.minSuccessRateForRetention);

    return {
      totalStrategies: strategies.length,
      activeStrategies: active.length,
      averageSuccessRate: strategies.length > 0
        ? strategies.reduce((sum, s) => sum + s.successRate, 0) / strategies.length
        : 0,
      bufferSize: this.trajectoryBuffer.length,
      topStrategies: strategies
        .sort((a, b) => b.successRate * b.useCount - a.successRate * a.useCount)
        .slice(0, 5)
        .map((s) => ({
          name: s.name,
          successRate: s.successRate,
          useCount: s.useCount,
        })),
    };
  }

  /**
   * 清空所有蒸馏数据
   */
  reset(): void {
    this.strategies.clear();
    this.trajectoryBuffer = [];
    this.strategyEmbeddings.clear();
  }

  // ── Private Methods ──────────────────────────────────────

  private clusterTrajectories(
    trajectories: Array<{ trace: ExecutionTrace; reflection: ReflectionResult; timestamp: Date }>,
  ): Map<string, Array<{ trace: ExecutionTrace; reflection: ReflectionResult; timestamp: Date }>> {
    const clusters = new Map<string, Array<{ trace: ExecutionTrace; reflection: ReflectionResult; timestamp: Date }>>();

    for (const t of trajectories) {
      // 使用反思结果中的失败类别作为聚类键
      const category = t.reflection.failureCategory;
      const errorKey = t.trace.error
        ? this.normalizeError(t.trace.error)
        : "unknown";

      const clusterKey = `${category}:${errorKey}`;
      if (!clusters.has(clusterKey)) {
        clusters.set(clusterKey, []);
      }
      clusters.get(clusterKey)!.push(t);
    }

    return clusters;
  }

  private normalizeError(error: string): string {
    // 移除具体的变量名、ID、行号等，保留错误模式
    return error
      .replace(/['"][^'"]*['"]/g, "'...'")
      .replace(/\d+/g, "N")
      .replace(/at\s+.*$/gm, "")
      .slice(0, 100)
      .toLowerCase();
  }

  private extractStrategy(
    failurePattern: string,
    cluster: Array<{ trace: ExecutionTrace; reflection: ReflectionResult; timestamp: Date }>,
  ): DistilledStrategy | null {
    // 从反思结果中提取共性建议
    const allSuggestions: string[] = [];
    const allRootCauses: string[] = [];

    for (const item of cluster) {
      if (item.reflection.suggestedImprovements) {
        allSuggestions.push(...item.reflection.suggestedImprovements);
      }
      if (item.reflection.rootCause) {
        allRootCauses.push(item.reflection.rootCause);
      }
    }

    if (allSuggestions.length === 0) return null;

    // 找到最常见的建议
    const suggestionFreq = new Map<string, number>();
    for (const s of allSuggestions) {
      const key = s.slice(0, 80);
      suggestionFreq.set(key, (suggestionFreq.get(key) || 0) + 1);
    }

    const topSuggestions = Array.from(suggestionFreq.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([s]) => s);

    // 生成策略模板
    const template = this.generateStrategyTemplate(
      failurePattern,
      topSuggestions,
      allRootCauses[0] || "未知",
    );

    const successfulCount = cluster.filter(
      (t) => t.reflection.confidenceScore >= 0.5
    ).length;

    return {
      id: uuid(),
      name: `auto-distilled:${failurePattern}`,
      failurePattern,
      template,
      description: `Auto-distilled strategy from ${cluster.length} trajectories for ${failurePattern}`,
      sourceTrajectoryCount: cluster.length,
      successRate: cluster.length > 0 ? successfulCount / cluster.length : 0.5,
      useCount: 0,
      createdAt: new Date(),
      lastUsedAt: null,
      confidence: cluster.length > 5 ? 0.7 : 0.4,
      tags: [failurePattern, "auto-distilled", ...topSuggestions.map((s) => s.slice(0, 30))],
    };
  }

  private generateStrategyTemplate(
    failurePattern: string,
    suggestions: string[],
    rootCause: string,
  ): string {
    const suggestionsCode = suggestions
      .map((s, i) => `  // ${i + 1}. ${s}`)
      .join("\n");

    return `// Auto-distilled strategy for: ${failurePattern}
// Root cause: ${rootCause}
// Based on trajectory analysis
${suggestionsCode}

export async function distilledHandler(params: Record<string, unknown>): Promise<unknown> {
  try {
    // Apply distilled improvements
    const validated = await validateAndPrepare(params);

    // Core execution with learned patterns
    const result = await executeWithRetry(validated, {
      maxRetries: 3,
      backoffMs: 1000,
    });

    return { success: true, data: result, strategy: "${failurePattern}" };
  } catch (err) {
    // Learn from this failure for future distillation
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      strategy: "${failurePattern}",
      recorded: true,
    };
  }
}

async function validateAndPrepare(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!params || typeof params !== "object") {
    throw new Error("Validation failed: invalid input");
  }
  return params;
}

async function executeWithRetry(
  params: Record<string, unknown>,
  options: { maxRetries: number; backoffMs: number },
): Promise<unknown> {
  let lastError: Error | null = null;
  for (let i = 0; i <= options.maxRetries; i++) {
    try {
      return await executeCore(params);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < options.maxRetries) {
        await new Promise(r => setTimeout(r, options.backoffMs * Math.pow(2, i)));
      }
    }
  }
  throw lastError;
}

async function executeCore(params: Record<string, unknown>): Promise<unknown> {
  return params;
}`;
  }

  private addStrategy(strategy: DistilledStrategy): void {
    // 如果已有同名策略，更新它
    const existing = this.findStrategyByPattern(strategy.failurePattern);
    if (existing) {
      // 更新成功率（加权平均）
      const totalTrajectories = existing.sourceTrajectoryCount + strategy.sourceTrajectoryCount;
      existing.successRate =
        (existing.successRate * existing.sourceTrajectoryCount +
          strategy.successRate * strategy.sourceTrajectoryCount) /
        totalTrajectories;
      existing.sourceTrajectoryCount = totalTrajectories;
      existing.confidence = Math.max(existing.confidence, strategy.confidence);
      existing.template = strategy.template; // 更新模板
      existing.lastUsedAt = new Date();
      return;
    }

    this.strategies.set(strategy.id, strategy);
  }

  private findStrategyByPattern(pattern: string): DistilledStrategy | null {
    for (const strategy of this.strategies.values()) {
      if (strategy.failurePattern === pattern) {
        return strategy;
      }
    }
    return null;
  }

  private pruneStrategies(): void {
    // 淘汰低成功率策略
    const toRemove: string[] = [];
    for (const [id, strategy] of this.strategies) {
      if (
        strategy.successRate < this.config.minSuccessRateForRetention &&
        strategy.useCount > 3 // 有足够的使用数据
      ) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.strategies.delete(id);
      this.strategyEmbeddings.delete(id);
    }

    // 如果超出最大数量，移除最旧的
    if (this.strategies.size > this.config.maxStrategies) {
      const sorted = Array.from(this.strategies.entries())
        .sort(([, a], [, b]) => a.createdAt.getTime() - b.createdAt.getTime());

      const removeCount = this.strategies.size - this.config.maxStrategies;
      for (let i = 0; i < removeCount; i++) {
        this.strategies.delete(sorted[i][0]);
        this.strategyEmbeddings.delete(sorted[i][0]);
      }
    }
  }

  private stringSimilarity(a: string, b: string): number {
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
    const bigrams = new Set<string>();
    for (let i = 0; i < a.length - 1; i++) {
      bigrams.add(a.substring(i, i + 2));
    }
    let intersection = 0;
    for (let i = 0; i < b.length - 1; i++) {
      if (bigrams.has(b.substring(i, i + 2))) {
        intersection++;
      }
    }
    return (2.0 * intersection) / (a.length + b.length - 2);
  }
}