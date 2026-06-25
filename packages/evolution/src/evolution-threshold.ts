/**
 * EvolutionThreshold — 进化触发门槛控制
 * 
 * 参考文章要求："触发门槛：达到指定失败率/成功率阈值才启动进化，避免频繁无效迭代"
 * 
 * 功能：
 * 1. 失败计数阈值：达到最小失败次数才触发进化
 * 2. 时间窗口限制：每个时间窗口内限制进化周期数
 * 3. 冷却期：两次进化之间必须间隔指定时间
 * 4. 成功率阈值：如果成功率高于阈值，跳过进化
 * 5. 状态持久化：内存中记录触发历史，支持重置
 */

export interface EvolutionThresholdConfig {
  /** 触发进化前需要的最小失败次数（默认 3） */
  minFailuresBeforeEvolution: number;
  /** 每个时间窗口内最大进化周期数（默认 5） */
  maxEvolutionCyclesPerWindow: number;
  /** 时间窗口大小（毫秒，默认 1小时） */
  evolutionWindowMs: number;
  /** 两次进化之间的冷却时间（毫秒，默认 5分钟） */
  cooldownPeriodMs: number;
  /** 如果成功率高于此阈值，跳过进化（默认 0.7） */
  minSuccessRateForSkip: number;
  /** 是否启用门槛控制（默认 true） */
  enabled: boolean;
}

export const DEFAULT_THRESHOLD_CONFIG: EvolutionThresholdConfig = {
  minFailuresBeforeEvolution: 3,
  maxEvolutionCyclesPerWindow: 5,
  evolutionWindowMs: 60 * 60 * 1000, // 1 hour
  cooldownPeriodMs: 5 * 60 * 1000, // 5 minutes
  minSuccessRateForSkip: 0.7,
  enabled: true,
};

export interface ThresholdCheckResult {
  allowed: boolean;
  reason: string;
  pendingFailures: number;
  cyclesInWindow: number;
  lastEvolutionTime: number | null;
}

export class EvolutionThreshold {
  private config: EvolutionThresholdConfig;
  private failureCounts: Map<string, number> = new Map();
  private evolutionTimestamps: number[] = [];
  private lastEvolutionTime: number | null = null;

  constructor(config?: Partial<EvolutionThresholdConfig>) {
    this.config = { ...DEFAULT_THRESHOLD_CONFIG, ...config };
  }

  /**
   * 检查是否允许触发进化
   */
  check(source: string, skillId: string | null, currentSuccessRate?: number): ThresholdCheckResult {
    if (!this.config.enabled) {
      return this.allowed("Threshold control disabled");
    }

    const now = Date.now();
    const key = skillId || source;

    // 1. 成功率检查：如果成功率高于阈值，不进化
    if (currentSuccessRate !== undefined && currentSuccessRate >= this.config.minSuccessRateForSkip) {
      return this.denied(
        `Success rate (${(currentSuccessRate * 100).toFixed(1)}%) is above threshold (${(this.config.minSuccessRateForSkip * 100).toFixed(1)}%)`,
        key
      );
    }

    // 2. 冷却期检查
    if (this.lastEvolutionTime !== null && (now - this.lastEvolutionTime) < this.config.cooldownPeriodMs) {
      const remainingMs = this.config.cooldownPeriodMs - (now - this.lastEvolutionTime);
      return this.denied(
        `Cooldown period active: ${Math.ceil(remainingMs / 1000)}s remaining`,
        key
      );
    }

    // 3. 时间窗口内周期数检查
    this.cleanupTimestamps(now);
    if (this.evolutionTimestamps.length >= this.config.maxEvolutionCyclesPerWindow) {
      return this.denied(
        `Max evolution cycles (${this.config.maxEvolutionCyclesPerWindow}) reached in current window`,
        key
      );
    }

    // 4. 失败次数检查
    const currentFailures = this.failureCounts.get(key) || 0;
    if (currentFailures < this.config.minFailuresBeforeEvolution) {
      return this.denied(
        `Need ${this.config.minFailuresBeforeEvolution - currentFailures} more failure(s) before evolution (current: ${currentFailures})`,
        key
      );
    }

    return this.allowed("All threshold checks passed");
  }

  /**
   * 记录一次失败（增加失败计数）
   */
  recordFailure(skillId: string | null, source: string): void {
    const key = skillId || source;
    this.failureCounts.set(key, (this.failureCounts.get(key) || 0) + 1);
  }

  /**
   * 记录一次进化触发（重置计数、更新时间戳）
   *
   * 当传入 skillId 或 source 时，仅清除对应 key 的失败计数；
   * 不传参数时保持向后兼容，清除所有失败计数。
   */
  recordEvolution(skillId?: string, source?: string): void {
    const now = Date.now();
    this.evolutionTimestamps.push(now);
    this.lastEvolutionTime = now;
    const key = skillId || source;
    if (key) {
      this.failureCounts.delete(key);
    } else {
      this.failureCounts.clear();
    }
  }

  /**
   * 重置指定来源的失败计数（进化成功或手动清除后）
   */
  resetFailures(skillId: string | null, source: string): void {
    const key = skillId || source;
    this.failureCounts.set(key, 0);
  }

  /**
   * 更新配置
   */
  configure(config: Partial<EvolutionThresholdConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前状态
   */
  getStats(): {
    totalFailures: number;
    cyclesInWindow: number;
    lastEvolutionTime: number | null;
    cooldownRemaining: number | null;
    failureBreakdown: Array<{ key: string; count: number }>;
  } {
    const now = Date.now();
    this.cleanupTimestamps(now);

    const cooldownRemaining =
      this.lastEvolutionTime !== null
        ? Math.max(0, this.config.cooldownPeriodMs - (now - this.lastEvolutionTime))
        : null;

    return {
      totalFailures: Array.from(this.failureCounts.values()).reduce((a, b) => a + b, 0),
      cyclesInWindow: this.evolutionTimestamps.length,
      lastEvolutionTime: this.lastEvolutionTime,
      cooldownRemaining,
      failureBreakdown: Array.from(this.failureCounts.entries()).map(([key, count]) => ({
        key,
        count,
      })),
    };
  }

  /**
   * 完全重置所有状态
   */
  reset(): void {
    this.failureCounts.clear();
    this.evolutionTimestamps = [];
    this.lastEvolutionTime = null;
  }

  // ── Private Helpers ──────────────────────────────────────

  private allowed(reason: string): ThresholdCheckResult {
    return {
      allowed: true,
      reason,
      pendingFailures: Array.from(this.failureCounts.values()).reduce((a, b) => a + b, 0),
      cyclesInWindow: this.evolutionTimestamps.length,
      lastEvolutionTime: this.lastEvolutionTime,
    };
  }

  private denied(reason: string, key: string): ThresholdCheckResult {
    return {
      allowed: false,
      reason,
      pendingFailures: this.failureCounts.get(key) || 0,
      cyclesInWindow: this.evolutionTimestamps.length,
      lastEvolutionTime: this.lastEvolutionTime,
    };
  }

  private cleanupTimestamps(now: number): void {
    const cutoff = now - this.config.evolutionWindowMs;
    this.evolutionTimestamps = this.evolutionTimestamps.filter((t) => t > cutoff);
  }
}