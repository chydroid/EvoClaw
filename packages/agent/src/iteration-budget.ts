// ── Iteration Budget ──
// Hermes 风格的迭代预算追踪器
// 用于 LLM Agent 循环中限制最大迭代次数，防止无限循环
// Grace Call 机制: 预算耗尽后允许一次无工具调用，让 Agent 产出最终文本回答

/** 迭代预算配置 */
export interface IterationBudgetConfig {
  /** 最大迭代次数 (default: 20) */
  maxIterations?: number;
  /** 是否启用 Grace Call 机制 (default: true) */
  enableGraceCall?: boolean;
  /** 预算耗尽时的回调 */
  onBudgetExhausted?: (remaining: number) => void;
}

/** 预算状态快照 */
export interface IterationBudgetStatus {
  total: number;
  consumed: number;
  remaining: number;
  exhausted: boolean;
  graceCallAvailable: boolean;
}

/**
 * IterationBudget
 * 线程安全的迭代预算追踪器，用于 LLM Agent 循环
 *
 * Grace Call 机制:
 * 当迭代预算耗尽时，Agent 仍可获得一次无工具调用的机会，
 * 产出最终的文本回答，避免 Agent 在任务中途被截断无法响应。
 *
 * 线程安全:
 * Node.js 虽为单线程，但 async 操作可能交错执行。
 * 使用简单的锁标志防止并发 consume/refund 导致状态不一致。
 */
export class IterationBudget {
  private readonly _maxIterations: number;
  private readonly _enableGraceCall: boolean;
  private readonly _onBudgetExhausted?: (remaining: number) => void;

  private _consumed: number = 0;
  private _graceCallUsed: boolean = false;
  private _locked: boolean = false;

  constructor(config: IterationBudgetConfig = {}) {
    this._maxIterations = config.maxIterations ?? 20;
    this._enableGraceCall = config.enableGraceCall ?? true;
    this._onBudgetExhausted = config.onBudgetExhausted;

    if (this._maxIterations < 0) {
      throw new RangeError(`maxIterations must be >= 0, got ${this._maxIterations}`);
    }
  }

  /** 剩余迭代次数 */
  get remaining(): number {
    return Math.max(0, this._maxIterations - this._consumed);
  }

  /** 预算是否已耗尽 */
  get isExhausted(): boolean {
    return this._consumed >= this._maxIterations;
  }

  /** Grace Call 是否可用 (预算耗尽且 Grace Call 尚未使用) */
  get graceCallAvailable(): boolean {
    return this._enableGraceCall && this.isExhausted && !this._graceCallUsed;
  }

  /**
   * 消费预算
   * @param count 消费次数 (必须 >= 0)
   * @returns true 表示消费成功，false 表示预算不足
   * @throws {Error} 锁定期间调用
   * @throws {RangeError} count < 0
   */
  consume(count: number = 1): boolean {
    this._ensureUnlocked();
    if (count < 0) {
      throw new RangeError(`consume count must be >= 0, got ${count}`);
    }
    if (count > this.remaining) {
      return false;
    }
    this._consumed += count;
    if (this.isExhausted) {
      this._onBudgetExhausted?.(this.remaining);
    }
    return true;
  }

  /**
   * 退还未使用的预算
   * @param count 退还次数 (必须 >= 0，且不超过已消费量)
   * @throws {Error} 锁定期间调用
   * @throws {RangeError} count < 0 或 count > consumed
   */
  refund(count: number): void {
    this._ensureUnlocked();
    if (count < 0) {
      throw new RangeError(`refund count must be >= 0, got ${count}`);
    }
    if (count > this._consumed) {
      throw new RangeError(`refund count ${count} exceeds consumed ${this._consumed}`);
    }
    this._consumed -= count;
  }

  /**
   * 使用 Grace Call
   * 当预算耗尽时，Agent 可获得一次无工具调用的机会来产出最终回答
   * @returns true 表示 Grace Call 使用成功，false 表示不可用
   * @throws {Error} 锁定期间调用
   */
  useGraceCall(): boolean {
    this._ensureUnlocked();
    if (!this.graceCallAvailable) {
      return false;
    }
    this._graceCallUsed = true;
    return true;
  }

  /**
   * 重置预算，用于新一轮对话
   * 清零已消费次数和 Grace Call 状态
   */
  reset(): void {
    this._ensureUnlocked();
    this._consumed = 0;
    this._graceCallUsed = false;
  }

  /** 获取预算状态快照 */
  getBudgetStatus(): IterationBudgetStatus {
    return {
      total: this._maxIterations,
      consumed: this._consumed,
      remaining: this.remaining,
      exhausted: this.isExhausted,
      graceCallAvailable: this.graceCallAvailable,
    };
  }

  /**
   * 获取锁 - 在 async 操作前调用，防止状态交错
   * @returns unlock 函数，必须在操作完成后调用
   */
  acquireLock(): () => void {
    if (this._locked) {
      throw new Error("IterationBudget: lock already held by another operation");
    }
    this._locked = true;
    return () => {
      this._locked = false;
    };
  }

  /** 锁是否被持有 */
  get isLocked(): boolean {
    return this._locked;
  }

  private _ensureUnlocked(): void {
    if (this._locked) {
      throw new Error("IterationBudget: cannot modify budget while lock is held");
    }
  }
}
