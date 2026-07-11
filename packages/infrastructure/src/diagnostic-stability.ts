/**
 * 稳定性诊断：检测会话/任务的抖动与不稳定模式。
 *
 * 灵感来自 openclaw-main 的 src/logging/diagnostic-stability.ts。
 *
 * 检测：
 * 1. 频繁重试（同一操作在 retryWindowMs 内重试 >= retryThreshold 次）
 * 2. 阶段切换抖动（A→B→A→B 来回切换，切换次数 >= phaseFlapCount）
 * 3. 错误率突增（最近 errorRateWindowMs 内错误率 > errorRateThreshold）
 * 4. 长时间未完成（任务已运行 >= stalledThresholdMs 但仍未结束）
 * 5. 资源占用异常（指标相对基线增长 >= resourceSpikeRatio）
 *
 * 用法：监控器是有状态的，业务侧在事件发生时调用 record* 方法，
 * 然后周期性调用 assess() 检查当前实体的稳定性。
 */

import type { DiagnosticSeverity } from "./diagnostic-payload";

/** 稳定性问题类型。 */
export type StabilityIssue =
  | "frequent-retry"
  | "phase-flapping"
  | "error-spike"
  | "stalled"
  | "resource-spike"
  | "none";

/** 稳定性评估结果。 */
export interface StabilityAssessment {
  issue: StabilityIssue;
  severity: DiagnosticSeverity;
  entityId: string;
  reason: string;
  /** 具体证据（重试次数、错误率等） */
  evidence: Record<string, unknown>;
  /** 建议操作（可选） */
  suggestedAction?: string;
}

/** 稳定性监控配置。 */
export interface StabilityConfig {
  /** 重试检测窗口（默认 60s） */
  retryWindowMs: number;
  /** 触发 frequent-retry 的最小重试次数（默认 3） */
  retryThreshold: number;
  /** 触发 phase-flapping 的最小切换次数（默认 4） */
  phaseFlapCount: number;
  /** 触发 error-spike 的错误率阈值（0-1，默认 0.8） */
  errorRateThreshold: number;
  /** 错误率检测窗口（默认 5 分钟） */
  errorRateWindowMs: number;
  /** 触发 stalled 的时长（默认 30 分钟） */
  stalledThresholdMs: number;
  /** 触发 resource-spike 的增长比例（默认 2.0） */
  resourceSpikeRatio: number;
}

/** 默认配置。 */
export const DEFAULT_STABILITY_CONFIG: StabilityConfig = {
  retryWindowMs: 60_000,
  retryThreshold: 3,
  phaseFlapCount: 4,
  // 安全：原先 0.5 阈值过低，2 个错误即触发（errorRate=2/3≈0.667）；
  // 提升至 0.8，需 5+ 错误（5/6≈0.833）才触发，避免误报。
  errorRateThreshold: 0.8,
  errorRateWindowMs: 5 * 60_000,
  stalledThresholdMs: 30 * 60_000,
  resourceSpikeRatio: 2.0,
};

interface ResourceSample {
  at: Date;
  value: number;
}

/**
 * 稳定性监控器：累积事件并评估实体的稳定性。
 */
export class StabilityMonitor {
  private config: StabilityConfig;
  private retryTracker = new Map<string, Date[]>();
  private phaseHistory = new Map<string, string[]>();
  private errorEvents = new Map<string, Array<{ at: Date; severity: string }>>();
  private startedAt = new Map<string, Date>();
  private resourceBaseline = new Map<string, number>();
  private resourceSamples = new Map<string, Map<string, ResourceSample[]>>();

  constructor(config?: Partial<StabilityConfig>) {
    this.config = { ...DEFAULT_STABILITY_CONFIG, ...config };
  }

  /** 记录重试事件。 */
  recordRetry(entityId: string, at: Date = new Date()): void {
    const list = this.retryTracker.get(entityId) ?? [];
    list.push(at);
    this.retryTracker.set(entityId, list);
  }

  /** 记录阶段切换（用于检测抖动）。 */
  recordPhaseTransition(
    entityId: string,
    newPhase: string,
    at: Date = new Date(),
  ): void {
    const list = this.phaseHistory.get(entityId) ?? [];
    // 同时记录阶段名与时间戳，便于后续 prune 与抖动检测
    list.push(`${newPhase}@${at.getTime()}`);
    this.phaseHistory.set(entityId, list);
  }

  /** 记录错误事件。 */
  recordError(
    entityId: string,
    severity: "warning" | "error" | "critical",
    at: Date = new Date(),
  ): void {
    const list = this.errorEvents.get(entityId) ?? [];
    list.push({ at, severity });
    this.errorEvents.set(entityId, list);
  }

  /** 记录任务开始（用于 stalled 检测）。 */
  recordStart(entityId: string, at: Date = new Date()): void {
    this.startedAt.set(entityId, at);
  }

  /** 记录资源指标（同一 metric 第一次记录作为基线）。 */
  recordResourceUsage(
    entityId: string,
    metric: string,
    value: number,
    at: Date = new Date(),
  ): void {
    const key = `${entityId}::${metric}`;
    if (!this.resourceBaseline.has(key)) {
      this.resourceBaseline.set(key, value);
    }
    const samples = this.resourceSamples.get(entityId) ?? new Map();
    const list = samples.get(metric) ?? [];
    list.push({ at, value });
    // 限制每个 metric 的样本数，防止内存膨胀
    if (list.length > 100) list.splice(0, list.length - 100);
    samples.set(metric, list);
    this.resourceSamples.set(entityId, samples);
  }

  /** 评估单个实体的稳定性。 */
  assess(entityId: string, now: Date = new Date()): StabilityAssessment {
    // 1. frequent-retry
    const retries = this.retryTracker.get(entityId) ?? [];
    const recentRetries = retries.filter(
      (t) => now.getTime() - t.getTime() <= this.config.retryWindowMs,
    );
    if (recentRetries.length >= this.config.retryThreshold) {
      return {
        issue: "frequent-retry",
        severity: "warning",
        entityId,
        reason: `检测到 ${recentRetries.length} 次重试（窗口 ${this.config.retryWindowMs}ms）`,
        evidence: {
          retryCount: recentRetries.length,
          windowMs: this.config.retryWindowMs,
          threshold: this.config.retryThreshold,
          lastRetryAt: recentRetries[recentRetries.length - 1],
        },
        suggestedAction: "检查失败原因或退避策略",
      };
    }

    // 2. phase-flapping：检测 A→B→A→B 重复模式
    const phaseSeq = this.phaseHistory.get(entityId) ?? [];
    if (phaseSeq.length >= this.config.phaseFlapCount) {
      const phaseNames = phaseSeq.map((p) => p.split("@")[0]);
      const flapDetected = detectFlapping(phaseNames, this.config.phaseFlapCount);
      if (flapDetected) {
        return {
          issue: "phase-flapping",
          severity: "warning",
          entityId,
          reason: `阶段切换抖动：序列长度 ${phaseNames.length}`,
          evidence: {
            phaseSequence: phaseNames.slice(-10),
            transitions: phaseNames.length,
            threshold: this.config.phaseFlapCount,
          },
          suggestedAction: "检查是否有触发循环的状态条件",
        };
      }
    }

    // 3. error-spike：错误率检测窗口内
    const errors = this.errorEvents.get(entityId) ?? [];
    const windowStart = now.getTime() - this.config.errorRateWindowMs;
    const recentErrors = errors.filter((e) => e.at.getTime() >= windowStart);
    // 简化估计：错误事件数 / (错误事件数 + 1) 作为错误率近似
    // 这里以"窗口内错误数 / 阈值次数"判定，避免引入额外的事件计数器
    if (recentErrors.length > 0) {
      const errorRate = recentErrors.length / (recentErrors.length + 1);
      if (errorRate > this.config.errorRateThreshold) {
        return {
          issue: "error-spike",
          severity: "error",
          entityId,
          reason: `错误率突增：${(errorRate * 100).toFixed(1)}% (窗口 ${this.config.errorRateWindowMs}ms)`,
          evidence: {
            errorCount: recentErrors.length,
            errorRate,
            threshold: this.config.errorRateThreshold,
            severities: recentErrors.map((e) => e.severity),
          },
          suggestedAction: "查看错误事件详情，定位根因",
        };
      }
    }

    // 4. stalled：任务已运行超过阈值
    const started = this.startedAt.get(entityId);
    if (started) {
      const ageMs = now.getTime() - started.getTime();
      if (ageMs >= this.config.stalledThresholdMs) {
        return {
          issue: "stalled",
          severity: "critical",
          entityId,
          reason: `任务运行 ${Math.round(ageMs / 1000)}s 未完成`,
          evidence: {
            ageMs,
            startedAt: started,
            thresholdMs: this.config.stalledThresholdMs,
          },
          suggestedAction: "检查是否有阻塞点或资源泄漏",
        };
      }
    }

    // 5. resource-spike：资源指标相对基线增长
    const samples = this.resourceSamples.get(entityId);
    if (samples) {
      for (const [metric, list] of samples) {
        if (list.length === 0) continue;
        const baseline = this.resourceBaseline.get(`${entityId}::${metric}`);
        if (baseline === undefined || baseline <= 0) continue;
        const latest = list[list.length - 1].value;
        const ratio = latest / baseline;
        if (ratio >= this.config.resourceSpikeRatio) {
          return {
            issue: "resource-spike",
            severity: "warning",
            entityId,
            reason: `资源 ${metric} 增长 ${ratio.toFixed(2)}x（基线 ${baseline}，当前 ${latest}）`,
            evidence: {
              metric,
              baseline,
              current: latest,
              ratio,
              thresholdRatio: this.config.resourceSpikeRatio,
            },
            suggestedAction: "检查是否有内存/CPU 泄漏",
          };
        }
      }
    }

    return {
      issue: "none",
      severity: "info",
      entityId,
      reason: "未检测到稳定性问题",
      evidence: {},
    };
  }

  /** 批量评估所有跟踪中的实体。 */
  assessAll(now: Date = new Date()): StabilityAssessment[] {
    const ids = new Set<string>([
      ...this.retryTracker.keys(),
      ...this.phaseHistory.keys(),
      ...this.errorEvents.keys(),
      ...this.startedAt.keys(),
      ...this.resourceSamples.keys(),
    ]);
    const results: StabilityAssessment[] = [];
    for (const id of ids) {
      const a = this.assess(id, now);
      if (a.issue !== "none") {
        results.push(a);
      }
    }
    return results;
  }

  /** 清理过期数据；返回被清理的记录数。 */
  prune(now: Date = new Date()): number {
    let removed = 0;
    const retryCutoff = now.getTime() - this.config.retryWindowMs;
    for (const [id, list] of this.retryTracker) {
      const kept = list.filter((t) => t.getTime() >= retryCutoff);
      removed += list.length - kept.length;
      if (kept.length === 0) {
        this.retryTracker.delete(id);
      } else {
        this.retryTracker.set(id, kept);
      }
    }
    const errCutoff = now.getTime() - this.config.errorRateWindowMs;
    for (const [id, list] of this.errorEvents) {
      const kept = list.filter((e) => e.at.getTime() >= errCutoff);
      removed += list.length - kept.length;
      if (kept.length === 0) {
        this.errorEvents.delete(id);
      } else {
        this.errorEvents.set(id, kept);
      }
    }
    return removed;
  }

  /** 清空所有跟踪数据。 */
  clear(): void {
    this.retryTracker.clear();
    this.phaseHistory.clear();
    this.errorEvents.clear();
    this.startedAt.clear();
    this.resourceBaseline.clear();
    this.resourceSamples.clear();
  }

  /** 获取当前配置（用于诊断）。 */
  getConfig(): StabilityConfig {
    return { ...this.config };
  }
}

/**
 * 检测阶段切换抖动：判断序列中是否存在 A→B→A→B 重复模式。
 *
 * 简化算法：若最近 N 次切换中存在相同阶段重复出现 >= ceil(N/2) 次，
 * 且阶段切换次数 >= threshold，视为抖动。
 */
function detectFlapping(phaseNames: string[], threshold: number): boolean {
  if (phaseNames.length < threshold) return false;
  // 取最近 threshold 次切换
  const recent = phaseNames.slice(-threshold);
  const counts = new Map<string, number>();
  for (const p of recent) {
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  // 若阶段种类 <= 2 且某个阶段出现 >= 2 次，视为抖动
  if (counts.size <= 2) {
    for (const c of counts.values()) {
      if (c >= 2) return true;
    }
  }
  return false;
}
