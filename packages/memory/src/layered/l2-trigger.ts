/**
 * L2 Mermaid 独立触发 — null 阈值 + 超时双触发。
 *
 * 借鉴 TencentDB-Agent-Memory 的 `src/offload/pipelines/l2-mermaid.ts`：
 * - 不再由 L1 直接触发 L2 聚合
 * - 双触发条件：
 *   A) null entry 数 >= l2NullThreshold（默认 4）
 *   B) 距上次 L2 超 l2TimeoutSeconds（默认 300s）
 * - 基于 boundary 的分组（短任务跳过）
 *
 * 解决问题：
 * - 旧设计：L1 完成立刻触发 L2，导致 L2 频繁运行但每次数据少
 * - 新设计：积累到一定量或超时后才触发，L2 一次处理更多数据
 */

/** L2 触发配置。 */
export interface L2TriggerOptions {
  /** null entry 阈值（>= 此值触发 L2）。默认 4。 */
  l2NullThreshold?: number;
  /** L2 超时秒数。默认 300。 */
  l2TimeoutSeconds?: number;
  /** L2 最小间隔秒数（防止过于频繁）。默认 60。 */
  l2MinIntervalSeconds?: number;
  /** 是否启用短任务跳过。默认 true。 */
  skipShortTasks?: boolean;
  /** 短任务判断的消息数阈值。默认 3。 */
  shortTaskThreshold?: number;
}

const DEFAULT_OPTIONS: Required<L2TriggerOptions> = {
  l2NullThreshold: 4,
  l2TimeoutSeconds: 300,
  l2MinIntervalSeconds: 60,
  skipShortTasks: true,
  shortTaskThreshold: 3,
};

/** L2 触发评估结果。 */
export interface L2TriggerDecision {
  /** 是否应该触发 L2。 */
  shouldTrigger: boolean;
  /** 触发原因。 */
  reason: string;
  /** 触发条件类型。 */
  triggerType: "null_threshold" | "timeout" | "forced" | "skip_short_task" | "skip_min_interval" | "none";
}

/** L2 触发器状态。 */
export interface L2TriggerState {
  /** 上次 L2 运行时间（epoch ms）。 */
  lastL2RunTime: number;
  /** 当前 null entry 数。 */
  nullEntryCount: number;
  /** 当前会话消息数。 */
  messageCount: number;
}

/**
 * L2 Mermaid 独立触发器。
 *
 * 使用方式：
 *   const trigger = new L2Trigger();
 *   const state = trigger.createInitialState();
 *   // 每次有新 entry 时更新 state
 *   state.nullEntryCount++;
 *   // 评估是否触发
 *   const decision = trigger.evaluate(state);
 *   if (decision.shouldTrigger) {
 *     await runL2Aggregation();
 *     state.lastL2RunTime = Date.now();
 *     state.nullEntryCount = 0;
 *   }
 */
export class L2Trigger {
  private opts: Required<L2TriggerOptions>;

  constructor(options?: L2TriggerOptions) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 创建初始状态。 */
  createInitialState(): L2TriggerState {
    return {
      lastL2RunTime: 0,
      nullEntryCount: 0,
      messageCount: 0,
    };
  }

  /**
   * 评估是否应该触发 L2。
   */
  evaluate(state: L2TriggerState, now: number = Date.now()): L2TriggerDecision {
    // 短任务跳过
    if (this.opts.skipShortTasks && state.messageCount < this.opts.shortTaskThreshold) {
      return {
        shouldTrigger: false,
        reason: `short task: ${state.messageCount} messages < ${this.opts.shortTaskThreshold}`,
        triggerType: "skip_short_task",
      };
    }

    // 条件 A：null entry 数 >= 阈值
    if (state.nullEntryCount >= this.opts.l2NullThreshold) {
      // 检查最小间隔
      const elapsed = (now - state.lastL2RunTime) / 1000;
      if (state.lastL2RunTime > 0 && elapsed < this.opts.l2MinIntervalSeconds) {
        return {
          shouldTrigger: false,
          reason: `min interval not reached: ${elapsed.toFixed(1)}s < ${this.opts.l2MinIntervalSeconds}s`,
          triggerType: "skip_min_interval",
        };
      }
      return {
        shouldTrigger: true,
        reason: `null entries ${state.nullEntryCount} >= ${this.opts.l2NullThreshold}`,
        triggerType: "null_threshold",
      };
    }

    // 条件 B：超时
    if (state.lastL2RunTime > 0) {
      const elapsed = (now - state.lastL2RunTime) / 1000;
      if (elapsed >= this.opts.l2TimeoutSeconds) {
        return {
          shouldTrigger: true,
          reason: `timeout: ${elapsed.toFixed(1)}s >= ${this.opts.l2TimeoutSeconds}s`,
          triggerType: "timeout",
        };
      }
    } else {
      // 从未运行过 + 有数据 + 超过短任务阈值
      if (state.messageCount >= this.opts.shortTaskThreshold && state.nullEntryCount > 0) {
        return {
          shouldTrigger: true,
          reason: `first run: ${state.messageCount} messages, ${state.nullEntryCount} null entries`,
          triggerType: "timeout",
        };
      }
    }

    return {
      shouldTrigger: false,
      reason: "no trigger condition met",
      triggerType: "none",
    };
  }

  /**
   * 强制触发（用于关闭时 flush）。
   */
  forceTrigger(): L2TriggerDecision {
    return {
      shouldTrigger: true,
      reason: "forced flush",
      triggerType: "forced",
    };
  }

  /**
   * 更新状态后触发 L2。
   */
  markTriggered(state: L2TriggerState, now: number = Date.now()): void {
    state.lastL2RunTime = now;
    state.nullEntryCount = 0;
  }

  /** 更新 null entry 计数。 */
  incrementNullEntries(state: L2TriggerState, count = 1): void {
    state.nullEntryCount += count;
  }

  /** 更新消息计数。 */
  incrementMessages(state: L2TriggerState, count = 1): void {
    state.messageCount += count;
  }
}
