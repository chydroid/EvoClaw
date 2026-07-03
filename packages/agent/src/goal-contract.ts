/**
 * Goal Contract — 目标合约验证系统。
 *
 * 对标 Hermes v0.18.0 "Goal Contract"：
 * - /goal 设置目标
 * - /goal contract 设置完成合约（"done" 的验证条件）
 * - Agent 持续运行直到验证条件全部满足
 * - pre_verify 钩子接入自定义检查
 *
 * 核心区别：
 * - 旧模式：Agent 说"我觉得修好了" → 用户手动验证
 * - 新模式：Agent 运行验证命令 → "测试通过了，这是证据"
 *
 * 设计原则：
 * 1. 合约是结构化的 —— 每条 clause 有命令、期望输出、超时
 * 2. 验证是真实的 —— 实际运行 shell 命令，不是 LLM 自评
 * 3. 证据是可查的 —— 每次验证记录 stdout/stderr/exitCode/duration
 * 4. 钩子是可插的 —— pre_verify 钩子允许自定义检查逻辑
 * 5. 循环是有限的 —— maxAttempts 防止无限循环
 *
 * 用法：
 * ```ts
 * const goal = new GoalContract({
 *   description: "把登录页面改成响应式布局",
 *   contract: [
 *     { command: "npm test", expectExitCode: 0, timeoutMs: 60000 },
 *     { command: "npx lighthouse --threshold 85", expectExitCode: 0, timeoutMs: 120000 },
 *   ],
 *   maxAttempts: 5,
 * });
 * const result = await goal.verify();
 * if (result.allPassed) { console.log("合约满足，目标完成"); }
 * ```
 */

import { exec as execCallback } from "child_process";
import { promisify } from "util";

const execAsync = promisify(execCallback);

// ── Types ─────────────────────────────────────────────────

/** 合约条款 —— 一条需要通过的验证命令 */
export interface ContractClause {
  /** 唯一 ID（自动生成如 "clause-1"） */
  id?: string;
  /** 验证命令（shell） */
  command: string;
  /** 期望的退出码（默认 0） */
  expectExitCode?: number;
  /** 期望 stdout 包含的文本（可选，大小写敏感） */
  expectStdoutContains?: string;
  /** 期望 stdout 不包含的文本（可选） */
  expectStdoutNotContains?: string;
  /** 超时（ms，默认 60000） */
  timeoutMs?: number;
  /** 工作目录（默认 process.cwd()） */
  cwd?: string;
  /** 描述（人类可读） */
  description?: string;
}

/** 单条合约的验证结果 */
export interface ClauseResult {
  /** 条款 ID */
  id: string;
  /** 验证命令 */
  command: string;
  /** 是否通过 */
  passed: boolean;
  /** 退出码 */
  exitCode: number | null;
  /** stdout（截断到 10000 字符） */
  stdout: string;
  /** stderr（截断到 5000 字符） */
  stderr: string;
  /** 耗时（ms） */
  durationMs: number;
  /** 失败原因（passed=false 时） */
  failureReason?: string;
  /** 是否因超时终止 */
  timedOut: boolean;
}

/** 整个合约的验证结果 */
export interface ContractVerificationResult {
  /** 是否所有条款都通过 */
  allPassed: boolean;
  /** 通过的条款数 */
  passedCount: number;
  /** 总条款数 */
  totalCount: number;
  /** 各条款结果 */
  results: ClauseResult[];
  /** 验证总耗时（ms） */
  totalDurationMs: number;
  /** 验证时间戳 */
  timestamp: number;
  /** 摘要文本 */
  summary: string;
}

/** Goal Contract 配置 */
export interface GoalContractConfig {
  /** 目标描述（人类可读） */
  description: string;
  /** 合约条款列表 */
  contract: ContractClause[];
  /** 最大尝试次数（默认 5） */
  maxAttempts?: number;
  /** 每次尝试之间的间隔（ms，默认 2000） */
  retryDelayMs?: number;
  /** pre_verify 钩子 —— 在验证前调用，可修改合约或阻止验证 */
  preVerify?: (attempt: number, contract: ContractClause[]) => Promise<{ proceed: boolean; modifiedContract?: ContractClause[] }>;
  /** 验证后钩子 —— 在验证完成后调用 */
  postVerify?: (result: ContractVerificationResult, attempt: number) => Promise<void>;
  /** 执行命令的函数（默认 child_process exec，可注入 mock） */
  executor?: (command: string, options: { cwd?: string; timeoutMs: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Goal 运行状态 */
export type GoalStatus = "pending" | "running" | "verified" | "failed" | "cancelled";

/** Goal 运行记录 */
export interface GoalRunRecord {
  /** 目标描述 */
  description: string;
  /** 最终状态 */
  status: GoalStatus;
  /** 总尝试次数 */
  totalAttempts: number;
  /** 最后一次验证结果 */
  lastResult?: ContractVerificationResult;
  /** 所有尝试的结果 */
  attemptHistory: ContractVerificationResult[];
  /** 创建时间 */
  createdAt: number;
  /** 完成时间 */
  completedAt?: number;
}

// ── GoalContract ──────────────────────────────────────────

/**
 * Goal Contract —— 目标合约验证系统。
 *
 * 不是"模型说修好了就行了"，而是"测试通过了才算"。
 * Agent 持续运行直到验证条件全部满足或达到最大尝试次数。
 */
export class GoalContract {
  private config: Required<Omit<GoalContractConfig, "preVerify" | "postVerify" | "executor">> &
    Pick<GoalContractConfig, "preVerify" | "postVerify" | "executor">;
  private status: GoalStatus = "pending";
  private attemptHistory: ContractVerificationResult[] = [];

  constructor(config: GoalContractConfig) {
    this.config = {
      maxAttempts: 5,
      retryDelayMs: 2000,
      ...config,
    };
  }

  /** 获取当前状态 */
  getStatus(): GoalStatus {
    return this.status;
  }

  /** 获取尝试历史 */
  getAttemptHistory(): ContractVerificationResult[] {
    return [...this.attemptHistory];
  }

  /** 获取目标描述 */
  get description(): string {
    return this.config.description;
  }

  /** 获取合约条款 */
  get contract(): ContractClause[] {
    return this.config.contract;
  }

  /**
   * 设置/替换合约条款。
   * 仅在 status === "pending" 时允许修改，运行中不可变。
   */
  setContract(clauses: ContractClause[]): void {
    if (this.status !== "pending") {
      throw new Error(`Cannot set contract: goal is in status "${this.status}" (only "pending" allows modification)`);
    }
    if (!Array.isArray(clauses)) {
      throw new Error("Contract clauses must be an array");
    }
    this.config.contract = clauses;
  }

  /**
   * 执行一次合约验证（不重试）。
   * 返回验证结果，但不改变 goal 状态。
   */
  async verifyOnce(): Promise<ContractVerificationResult> {
    const startTime = Date.now();
    const clauses = this.config.contract.map((c, idx) => ({
      ...c,
      id: c.id ?? `clause-${idx + 1}`,
    }));

    const results: ClauseResult[] = [];
    for (const clause of clauses) {
      const result = await this.verifyClause(clause);
      results.push(result);
    }

    const passedCount = results.filter((r) => r.passed).length;
    const allPassed = passedCount === results.length;
    const totalDurationMs = Date.now() - startTime;

    const summary = this.buildSummary(allPassed, passedCount, results.length, totalDurationMs);
    const verificationResult: ContractVerificationResult = {
      allPassed,
      passedCount,
      totalCount: results.length,
      results,
      totalDurationMs,
      timestamp: Date.now(),
      summary,
    };

    return verificationResult;
  }

  /**
   * 运行完整验证循环（含重试）。
   * Agent 持续运行直到验证条件全部满足或达到最大尝试次数。
   */
  async run(): Promise<GoalRunRecord> {
    const createdAt = Date.now();
    this.status = "running";
    this.attemptHistory = [];

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      // pre_verify 钩子
      if (this.config.preVerify) {
        const hookResult = await this.config.preVerify(attempt, this.config.contract);
        if (!hookResult.proceed) {
          this.status = "cancelled";
          return {
            description: this.config.description,
            status: this.status,
            totalAttempts: attempt - 1,
            attemptHistory: this.attemptHistory,
            createdAt,
            completedAt: Date.now(),
          };
        }
        if (hookResult.modifiedContract) {
          this.config.contract = hookResult.modifiedContract;
        }
      }

      // 执行验证
      const result = await this.verifyOnce();
      this.attemptHistory.push(result);

      // post_verify 钩子
      if (this.config.postVerify) {
        await this.config.postVerify(result, attempt);
      }

      if (result.allPassed) {
        this.status = "verified";
        return {
          description: this.config.description,
          status: this.status,
          totalAttempts: attempt,
          lastResult: result,
          attemptHistory: this.attemptHistory,
          createdAt,
          completedAt: Date.now(),
        };
      }

      // 未通过，等待后重试
      if (attempt < this.config.maxAttempts) {
        await this.sleep(this.config.retryDelayMs);
      }
    }

    this.status = "failed";
    const lastResult = this.attemptHistory[this.attemptHistory.length - 1];
    return {
      description: this.config.description,
      status: this.status,
      totalAttempts: this.attemptHistory.length,
      lastResult,
      attemptHistory: this.attemptHistory,
      createdAt,
      completedAt: Date.now(),
    };
  }

  /** 取消验证 */
  cancel(): void {
    this.status = "cancelled";
  }

  // ── Internal ────────────────────────────────────────────

  /** 验证单条合约条款 */
  private async verifyClause(clause: ContractClause): Promise<ClauseResult> {
    const startTime = Date.now();
    const timeoutMs = clause.timeoutMs ?? 60000;
    const cwd = clause.cwd ?? process.cwd();
    const expectExitCode = clause.expectExitCode ?? 0;

    try {
      const executor = this.config.executor ?? this.defaultExecutor;
      const { stdout, stderr, exitCode } = await executor(clause.command, { cwd, timeoutMs });

      const result: ClauseResult = {
        id: clause.id ?? "clause",
        command: clause.command,
        passed: true,
        exitCode,
        stdout: this.truncate(stdout, 10000),
        stderr: this.truncate(stderr, 5000),
        durationMs: Date.now() - startTime,
        timedOut: false,
      };

      // 检查退出码
      if (exitCode !== expectExitCode) {
        result.passed = false;
        result.failureReason = `exit code ${exitCode} !== expected ${expectExitCode}`;
      }

      // 检查 stdout 包含
      if (clause.expectStdoutContains && !stdout.includes(clause.expectStdoutContains)) {
        result.passed = false;
        result.failureReason = `stdout does not contain "${clause.expectStdoutContains}"`;
      }

      // 检查 stdout 不包含
      if (clause.expectStdoutNotContains && stdout.includes(clause.expectStdoutNotContains)) {
        result.passed = false;
        result.failureReason = `stdout contains forbidden "${clause.expectStdoutNotContains}"`;
      }

      return result;
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.includes("timed out");
      return {
        id: clause.id ?? "clause",
        command: clause.command,
        passed: false,
        exitCode: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
        failureReason: isTimeout ? `timed out after ${timeoutMs}ms` : (err instanceof Error ? err.message : String(err)),
        timedOut: isTimeout,
      };
    }
  }

  /** 默认命令执行器 —— 使用 child_process exec */
  private async defaultExecutor(
    command: string,
    options: { cwd?: string; timeoutMs: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 1024 * 1024 * 10, // 10MB
      });
      return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; message?: string };
      if (e.killed) {
        throw new Error(`command timed out after ${options.timeoutMs}ms`);
      }
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        exitCode: typeof e.code === "number" ? e.code : 1,
      };
    }
  }

  /** 构建摘要文本 */
  private buildSummary(allPassed: boolean, passed: number, total: number, durationMs: number): string {
    const status = allPassed ? "✅ ALL PASSED" : "❌ FAILED";
    return `${status} — ${passed}/${total} clauses passed in ${durationMs}ms`;
  }

  /** 截断文本 */
  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + `\n... [truncated, ${text.length - maxLen} more chars]`;
  }

  /** sleep 工具 */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ── GoalRegistry — 多目标管理 ─────────────────────────────

/**
 * Goal 注册表 —— 管理多个并行目标合约。
 */
export class GoalRegistry {
  private goals = new Map<string, GoalContract>();
  private history: GoalRunRecord[] = [];

  /** 创建并注册一个目标 */
  create(id: string, config: GoalContractConfig): GoalContract {
    if (this.goals.has(id)) {
      throw new Error(`Goal "${id}" already exists`);
    }
    const goal = new GoalContract(config);
    this.goals.set(id, goal);
    return goal;
  }

  /** 获取目标 */
  get(id: string): GoalContract | undefined {
    return this.goals.get(id);
  }

  /** 列出所有目标 ID */
  list(): string[] {
    return Array.from(this.goals.keys());
  }

  /** 运行目标并记录历史 */
  async run(id: string): Promise<GoalRunRecord> {
    const goal = this.goals.get(id);
    if (!goal) {
      throw new Error(`Goal "${id}" not found`);
    }
    const record = await goal.run();
    this.history.push(record);
    if (record.status === "verified" || record.status === "failed" || record.status === "cancelled") {
      this.goals.delete(id);
    }
    return record;
  }

  /** 取消目标 */
  cancel(id: string): boolean {
    const goal = this.goals.get(id);
    if (!goal) return false;
    goal.cancel();
    return true;
  }

  /** 获取历史记录 */
  getHistory(): GoalRunRecord[] {
    return [...this.history];
  }
}
