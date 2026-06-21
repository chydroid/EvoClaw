/**
 * IterationBudget — 线程安全的迭代预算计数器
 *
 * 借鉴 hermes-agent 的 iteration_budget.py 设计：
 * - 支持 consume / refund / used / remaining
 * - 父 agent 默认 90 次迭代，子 agent 默认 50 次
 * - 防止失控的递归或无限工具调用循环
 * - Grace Call：预算耗尽后允许一次无工具的最终调用
 */

export const DEFAULT_PARENT_BUDGET = 90;
export const DEFAULT_CHILD_BUDGET = 50;

export interface IterationBudgetConfig {
  maxIterations: number;
  enableGraceCall?: boolean;
}

export interface IterationBudgetStatus {
  used: number;
  remaining: number;
  max: number;
  exhausted: boolean;
  graceCallAvailable: boolean;
}

export class IterationBudget {
  private consumed = 0;
  private readonly max: number;
  private readonly enableGraceCall: boolean;
  private graceCallUsed = false;
  private readonly lock = { current: Promise.resolve() };

  constructor(configOrMax: IterationBudgetConfig | number = DEFAULT_PARENT_BUDGET) {
    if (typeof configOrMax === "number") {
      this.max = configOrMax;
      this.enableGraceCall = true;
    } else {
      this.max = configOrMax.maxIterations;
      this.enableGraceCall = configOrMax.enableGraceCall ?? true;
    }
  }

  /** 消耗指定次数迭代。返回 true 表示成功，false 表示预算耗尽。 */
  async consume(count = 1): Promise<boolean> {
    return this.withLock(() => {
      for (let i = 0; i < count; i++) {
        if (this.consumed >= this.max) return false;
        this.consumed++;
      }
      return true;
    });
  }

  /** 归还一次迭代（用于误消耗或回退场景） */
  async refund(): Promise<void> {
    await this.withLock(() => {
      if (this.consumed > 0) this.consumed--;
    });
  }

  /** 已消耗次数 */
  getUsed(): number {
    return this.consumed;
  }

  /** 剩余次数 */
  getRemaining(): number {
    return Math.max(0, this.max - this.consumed);
  }

  /** 最大预算 */
  getMax(): number {
    return this.max;
  }

  /** 是否已耗尽（属性形式，兼容旧代码） */
  get isExhausted(): boolean {
    return this.consumed >= this.max;
  }

  /** Grace Call 是否可用（属性形式，兼容旧代码） */
  get graceCallAvailable(): boolean {
    return this.enableGraceCall && !this.graceCallUsed && this.consumed >= this.max;
  }

  /** 标记 Grace Call 已使用 */
  useGraceCall(): void {
    this.graceCallUsed = true;
  }

  /** 获取状态快照 */
  getStatus(): IterationBudgetStatus {
    return {
      used: this.consumed,
      remaining: this.getRemaining(),
      max: this.max,
      exhausted: this.isExhausted,
      graceCallAvailable: this.graceCallAvailable,
    };
  }

  /** 重置（用于测试或新 turn 开始） */
  reset(): void {
    this.consumed = 0;
    this.graceCallUsed = false;
  }

  /** 简单的串行锁，确保 consume/refund 原子性 */
  private async withLock<T>(fn: () => T): Promise<T> {
    const next = this.lock.current.then(() => fn());
    this.lock.current = next.then(() => undefined, () => undefined);
    return next;
  }
}
