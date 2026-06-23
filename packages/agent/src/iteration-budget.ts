/**
 * IterationBudget — 线程安全的迭代预算计数器
 *
 * 借鉴 hermes-agent 的 iteration_budget.py 设计：
 * - 支持 consume / refund / used / remaining
 * - 父 agent 默认 90 次迭代，子 agent 默认 50 次
 * - 防止失控的递归或无限工具调用循环
 * - Grace Call：预算耗尽后允许一次无工具的最终调用
 *
 * execute_code 退款机制（借鉴 hermes-agent iteration_budget.py）：
 *   - 当一轮中只调用了 execute_code 类工具时，退还该次迭代
 *   - 运行时上下文错误退款
 *   - 压缩重启退款
 *   这些退款防止"工具调用本身"消耗预算，让预算真正反映"决策次数"。
 */

export const DEFAULT_PARENT_BUDGET = 90;
export const DEFAULT_CHILD_BUDGET = 50;

/**
 * execute_code 类工具名称集合。
 *
 * 借鉴 hermes-agent iteration_budget.py EXECUTE_CODE_TOOL_NAMES：
 *   这些工具的调用不应消耗迭代预算，因为它们是"执行"而非"决策"。
 *   退还这些调用让 agent 能完成更多实际工作。
 */
const EXECUTE_CODE_TOOL_NAMES = new Set([
  "execute_code",
  "exec_code",
  "run_code",
  "python",
  "python_repl",
  "node",
  "nodejs",
  "bash",
  "shell",
  "shell_exec",
  "terminal",
  "cmd",
  "command",
  "execute",
  "run",
  "eval",
  "evaluate",
]);

/**
 * 判断工具是否属于 execute_code 类（可退款）。
 */
export function isExecuteCodeTool(toolName: string): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  if (EXECUTE_CODE_TOOL_NAMES.has(lower)) return true;
  // 模糊匹配：包含 execute + code/run/shell/terminal
  if (lower.includes("execute") && (lower.includes("code") || lower.includes("script"))) return true;
  if (lower.includes("run") && lower.includes("code")) return true;
  return false;
}

export interface IterationBudgetConfig {
  maxIterations: number;
  enableGraceCall?: boolean;
  /** 启用 execute_code 退款 */
  enableExecuteCodeRefund?: boolean;
  /** 启用运行时错误退款 */
  enableRuntimeErrorRefund?: boolean;
  /** 启用压缩重启退款 */
  enableCompactionRefund?: boolean;
}

export interface IterationBudgetStatus {
  used: number;
  remaining: number;
  max: number;
  exhausted: boolean;
  graceCallAvailable: boolean;
  /** execute_code 退款次数 */
  executeCodeRefunds: number;
  /** 运行时错误退款次数 */
  runtimeErrorRefunds: number;
  /** 压缩重启退款次数 */
  compactionRefunds: number;
}

export class IterationBudget {
  private consumed = 0;
  private readonly max: number;
  private readonly enableGraceCall: boolean;
  private readonly enableExecuteCodeRefund: boolean;
  private readonly enableRuntimeErrorRefund: boolean;
  private readonly enableCompactionRefund: boolean;
  private graceCallUsed = false;
  private executeCodeRefundCount = 0;
  private runtimeErrorRefundCount = 0;
  private compactionRefundCount = 0;
  private readonly lock = { current: Promise.resolve() };

  /** 单类退款上限，防止滥用 */
  private static readonly MAX_REFUNDS_PER_TYPE = 20;

  constructor(configOrMax: IterationBudgetConfig | number = DEFAULT_PARENT_BUDGET) {
    if (typeof configOrMax === "number") {
      this.max = configOrMax;
      this.enableGraceCall = true;
      this.enableExecuteCodeRefund = true;
      this.enableRuntimeErrorRefund = true;
      this.enableCompactionRefund = true;
    } else {
      this.max = configOrMax.maxIterations;
      this.enableGraceCall = configOrMax.enableGraceCall ?? true;
      this.enableExecuteCodeRefund = configOrMax.enableExecuteCodeRefund ?? true;
      this.enableRuntimeErrorRefund = configOrMax.enableRuntimeErrorRefund ?? true;
      this.enableCompactionRefund = configOrMax.enableCompactionRefund ?? true;
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

  /**
   * execute_code 退款：当一轮中只调用了 execute_code 类工具时，退还该次迭代。
   *
   * 借鉴 hermes-agent iteration_budget.py refund_for_execute_code：
   *   - 检查工具名称是否属于 execute_code 类
   *   - 检查退款次数未超上限
   *   - 退还一次迭代
   *
   * @param toolNames 本轮调用的工具名称列表
   * @returns 实际退还的次数（0 或 1）
   */
  async refundForExecuteCode(toolNames: string[]): Promise<number> {
    if (!this.enableExecuteCodeRefund) return 0;
    if (!toolNames || toolNames.length === 0) return 0;

    // 所有工具都必须是 execute_code 类
    const allExecuteCode = toolNames.every(isExecuteCodeTool);
    if (!allExecuteCode) return 0;

    return this.withLock(() => {
      if (this.executeCodeRefundCount >= IterationBudget.MAX_REFUNDS_PER_TYPE) return 0;
      if (this.consumed <= 0) return 0;
      this.consumed--;
      this.executeCodeRefundCount++;
      return 1;
    });
  }

  /**
   * 运行时上下文错误退款。
   *
   * 借鉴 hermes-agent iteration_budget.py refund_for_runtime_error：
   *   当 LLM 调用因运行时上下文错误失败时（非决策错误），退还迭代。
   *
   * @param errorType 错误类型标识
   * @returns 实际退还的次数（0 或 1）
   */
  async refundForRuntimeError(errorType?: string): Promise<number> {
    if (!this.enableRuntimeErrorRefund) return 0;

    // 某些错误类型不退款（决策错误）
    const NON_REFUNDABLE_ERRORS = new Set([
      "content_policy_violation",
      "auth_error",
      "billing_error",
      "model_not_found",
    ]);
    if (errorType && NON_REFUNDABLE_ERRORS.has(errorType)) return 0;

    return this.withLock(() => {
      if (this.runtimeErrorRefundCount >= IterationBudget.MAX_REFUNDS_PER_TYPE) return 0;
      if (this.consumed <= 0) return 0;
      this.consumed--;
      this.runtimeErrorRefundCount++;
      return 1;
    });
  }

  /**
   * 压缩重启退款。
   *
   * 借鉴 hermes-agent iteration_budget.py refund_for_compression：
   *   上下文压缩后重启 turn 时，退还压缩前消耗的迭代。
   *
   * @returns 实际退还的次数（0 或 1）
   */
  async refundForCompaction(): Promise<number> {
    if (!this.enableCompactionRefund) return 0;

    return this.withLock(() => {
      if (this.compactionRefundCount >= IterationBudget.MAX_REFUNDS_PER_TYPE) return 0;
      if (this.consumed <= 0) return 0;
      this.consumed--;
      this.compactionRefundCount++;
      return 1;
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
      executeCodeRefunds: this.executeCodeRefundCount,
      runtimeErrorRefunds: this.runtimeErrorRefundCount,
      compactionRefunds: this.compactionRefundCount,
    };
  }

  /** 重置（用于测试或新 turn 开始） */
  reset(): void {
    this.consumed = 0;
    this.graceCallUsed = false;
    this.executeCodeRefundCount = 0;
    this.runtimeErrorRefundCount = 0;
    this.compactionRefundCount = 0;
  }

  /** 简单的串行锁，确保 consume/refund 原子性 */
  private async withLock<T>(fn: () => T): Promise<T> {
    const next = this.lock.current.then(() => fn());
    this.lock.current = next.then(() => undefined, () => undefined);
    return next;
  }
}
