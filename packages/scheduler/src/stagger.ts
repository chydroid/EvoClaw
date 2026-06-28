/**
 * 错峰执行：避免多个 cron 任务在同一时刻触发造成雪崩。
 *
 * 灵感来自 openclaw-main 的 src/cron/stagger.ts。
 * 当多个任务在同一分钟触发时，按 priority 顺序排队，
 * 每个任务在触发前插入一个 jitter 延迟（0 ~ maxJitterMs）。
 *
 * 设计目标：
 *  - 防止"惊群效应"（top-of-hour 集中触发导致瞬时高负载）
 *  - 让同窗口任务串行错峰，按优先级排序
 *  - 超出并发上限的任务延迟到下一个窗口执行
 */

/** 错峰调度输入条目。 */
export interface StaggerEntry {
  /** 任务 ID。 */
  jobId: string;
  /** 计划触发时间。 */
  scheduledTime: Date;
  /** 优先级（数字越大越优先）。 */
  priority: number;
  /** 预计执行时长（用于估算排队时间，可选）。 */
  estimatedDurationMs?: number;
}

/** 错峰调度决策结果。 */
export interface StaggerDecision {
  /** 任务 ID。 */
  jobId: string;
  /** 实际执行时间。 */
  executeAt: Date;
  /** 延迟毫秒数。 */
  delayMs: number;
  /** 决策原因（用于日志/调试）。 */
  reason: string;
  /** 队列位置（0-based）。 */
  queuePosition: number;
}

/** 错峰协调器配置选项。 */
export interface StaggerCoordinatorOptions {
  /** 时间窗口（默认 60s，同一窗口内的任务视为同时触发）。 */
  windowMs?: number;
  /** 最大 jitter（默认 5s）。 */
  maxJitterMs?: number;
  /** 同窗口内最大并发（默认 10）。 */
  maxConcurrent?: number;
}

/** 默认时间窗口（60 秒，即同一分钟内的任务视为同时触发）。 */
const DEFAULT_WINDOW_MS = 60_000;
/** 默认最大 jitter（5 秒）。 */
const DEFAULT_MAX_JITTER_MS = 5_000;
/** 默认同窗口内最大并发。 */
const DEFAULT_MAX_CONCURRENT = 10;
/** 默认过期记录保留时长（1 小时）。 */
const DEFAULT_PRUNE_AGE_MS = 60 * 60 * 1000;

/**
 * 错峰协调器：决定同窗口内任务的执行时机。
 *
 * 不直接执行任务，只输出决策结果。
 * 调用方根据 delayMs 自行 setTimeout。
 */
export class StaggerCoordinator {
  private windowMs: number;
  private maxJitterMs: number;
  private maxConcurrent: number;
  /** jobId → 最近执行时间列表（用于去重和限流）。 */
  private recentExecutions = new Map<string, number[]>();

  constructor(opts?: StaggerCoordinatorOptions) {
    this.windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxJitterMs = opts?.maxJitterMs ?? DEFAULT_MAX_JITTER_MS;
    this.maxConcurrent = opts?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  /**
   * 计算指定任务的错峰延迟。
   *
   * 算法：
   *  1. 按 scheduledTime 分组（同窗口内为一组，窗口大小为 windowMs）
   *  2. 每组内按 priority 降序排序（priority 相同时按 jobId 字典序稳定排序）
   *  3. 第 i 个任务的 delayMs = (i / groupSize) * maxJitterMs + 随机[0, maxJitterMs/groupSize]
   *  4. 若组内任务数 > maxConcurrent，超出部分延迟一个 windowMs（移到下一窗口）
   *  5. 返回所有任务的决策
   */
  schedule(entries: StaggerEntry[]): StaggerDecision[] {
    if (entries.length === 0) return [];

    // 1. 按窗口分组
    const groups = this.groupByWindow(entries);

    const decisions: StaggerDecision[] = [];

    for (const group of groups) {
      // 2. 按优先级降序排序（priority 相同时按 jobId 稳定排序）
      const sorted = [...group].sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
      });

      const groupSize = sorted.length;
      const overCapacity = groupSize > this.maxConcurrent;
      // 容纳在当前窗口的任务数
      const inWindowSize = overCapacity ? this.maxConcurrent : groupSize;

      for (let i = 0; i < groupSize; i++) {
        const entry = sorted[i];
        const scheduledTime = entry.scheduledTime.getTime();

        if (overCapacity && i >= this.maxConcurrent) {
          // 超出并发上限，延迟到下一个窗口
          const executeAt = new Date(scheduledTime + this.windowMs);
          decisions.push({
            jobId: entry.jobId,
            executeAt,
            delayMs: this.windowMs,
            reason: `over-capacity (pos ${i + 1}/${groupSize}, deferred to next window)`,
            queuePosition: i,
          });
          continue;
        }

        // 3. 在窗口内分配 jitter
        // 防止除零：当 inWindowSize 为 0 时直接 0
        const slot = inWindowSize > 0 ? i / inWindowSize : 0;
        const jitterSlot = inWindowSize > 0 ? this.maxJitterMs / inWindowSize : 0;
        // 在 [0, jitterSlot) 内取一个随机偏移，使同槽任务也略有错开
        const randomOffset = jitterSlot * Math.random();
        const delayMs = Math.floor(slot * this.maxJitterMs + randomOffset);

        decisions.push({
          jobId: entry.jobId,
          executeAt: new Date(scheduledTime + delayMs),
          delayMs,
          reason: `staggered (pos ${i + 1}/${inWindowSize}, slot ${slot.toFixed(2)})`,
          queuePosition: i,
        });
      }
    }

    return decisions;
  }

  /**
   * 记录任务已执行（用于去重和限流）。
   */
  markExecuted(jobId: string, executedAt: Date = new Date()): void {
    const list = this.recentExecutions.get(jobId) ?? [];
    list.push(executedAt.getTime());
    // 排序保持时间顺序
    list.sort((a, b) => a - b);
    this.recentExecutions.set(jobId, list);
  }

  /**
   * 获取指定任务的最近执行时间（在 withinMs 时间窗口内）。
   */
  getRecentExecutions(jobId: string, withinMs: number, now: Date = new Date()): Date[] {
    const list = this.recentExecutions.get(jobId);
    if (!list || list.length === 0) return [];
    const cutoff = now.getTime() - withinMs;
    return list.filter((ts) => ts >= cutoff).map((ts) => new Date(ts));
  }

  /**
   * 清理过期的执行记录（用于防止 Map 无限增长）。
   * 返回被清理的记录数。
   */
  prune(olderThanMs: number = DEFAULT_PRUNE_AGE_MS, now: Date = new Date()): number {
    const cutoff = now.getTime() - olderThanMs;
    let removed = 0;

    for (const [jobId, timestamps] of this.recentExecutions) {
      const kept = timestamps.filter((ts) => ts >= cutoff);
      if (kept.length < timestamps.length) {
        removed += timestamps.length - kept.length;
        if (kept.length === 0) {
          this.recentExecutions.delete(jobId);
        } else {
          this.recentExecutions.set(jobId, kept);
        }
      }
    }

    return removed;
  }

  /**
   * 重置内部状态（主要用于测试）。
   */
  reset(): void {
    this.recentExecutions.clear();
  }

  // ── 私有方法 ──────────────────────────────────────────────

  /**
   * 按时间窗口分组：scheduledTime 落在同一 windowMs 窗口内的为一组。
   * 窗口起点对齐到 epoch。
   */
  private groupByWindow(entries: StaggerEntry[]): StaggerEntry[][] {
    if (entries.length === 0) return [];

    // 计算每个 entry 的窗口索引
    const withWindow = entries.map((e) => ({
      entry: e,
      windowIndex: Math.floor(e.scheduledTime.getTime() / this.windowMs),
    }));

    // 按窗口索引排序
    withWindow.sort((a, b) => a.windowIndex - b.windowIndex);

    const groups: StaggerEntry[][] = [];
    let currentWindow = withWindow[0].windowIndex;
    let currentGroup: StaggerEntry[] = [];

    for (const item of withWindow) {
      if (item.windowIndex !== currentWindow) {
        if (currentGroup.length > 0) groups.push(currentGroup);
        currentGroup = [];
        currentWindow = item.windowIndex;
      }
      currentGroup.push(item.entry);
    }
    if (currentGroup.length > 0) groups.push(currentGroup);

    return groups;
  }
}

/**
 * 工具函数：判断给定 cron 表达式是否会在整点触发（top-of-hour）。
 *
 * 灵感来自 openclaw-main 的 isRecurringTopOfHourCronExpr。
 * 用于判断是否需要应用默认 stagger。
 */
export function isTopOfHourCronExpr(expr: string): boolean {
  const fields = expr.trim().split(/\s+/).filter(Boolean);
  if (fields.length === 5) {
    const [minuteField, hourField] = fields;
    return minuteField === "0" && hasWildcardHour(hourField);
  }
  if (fields.length === 6) {
    const [secondField, minuteField, hourField] = fields;
    return secondField === "0" && minuteField === "0" && hasWildcardHour(hourField);
  }
  return false;
}

/** 整点 wildcard 检测：hour 字段为 * 或星号斜杠N 形式。 */
function hasWildcardHour(field: string): boolean {
  if (field === "*" || field === "?") return true;
  // 形如 "*/N" 或 "?/N"（步长通配）
  if (field.startsWith("*/") || field.startsWith("?/")) return true;
  return false;
}

/** top-of-hour cron 表达式的默认 stagger（5 分钟，避免整点集中触发）。 */
export const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

/**
 * 解析配置中的 stagger 值。
 * - 数字或数字字符串 → 非负整数毫秒
 * - 非法值 → undefined（由调用方决定是否使用默认值）
 */
export function normalizeCronStaggerMs(raw: unknown): number | undefined {
  let numeric: number;
  if (typeof raw === "number") {
    numeric = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return undefined;
    numeric = parsed;
  } else {
    return undefined;
  }

  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return Math.max(0, Math.floor(numeric));
}

/**
 * 为给定的 cron 表达式返回默认 stagger（仅 top-of-hour 表达式有默认值）。
 * 其他表达式返回 undefined（表示无默认错峰）。
 */
export function resolveDefaultCronStaggerMs(expr: string): number | undefined {
  return isTopOfHourCronExpr(expr) ? DEFAULT_TOP_OF_HOUR_STAGGER_MS : undefined;
}
