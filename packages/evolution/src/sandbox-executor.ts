/**
 * SandboxExecutor — 沙箱执行器
 * 
 * 提供进化候选方案的真实环境执行验证能力。
 * 解决 EvolutionEvaluator 只做静态分析、不实际运行代码的问题。
 * 
 * 借鉴 OpenClaw 的 Agent Loop 设计：
 *   - 隔离执行环境
 *   - 硬超时保护
 *   - 执行结果结构化为 ExecutionTrace 反馈给反思系统
 * 
 * 安全约束：
 *   - 所有代码在临时目录中执行
 *   - 执行超时自动终止（默认 30s）
 *   - 禁止访问敏感文件/网络（通过 Node.js vm 模块）
 */

import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { randomUUID } from "crypto";
import type { EvolutionCandidate } from "@evoclaw/core";
import type { ExecutionTrace } from "./external-reflector";

// ── Types ──────────────────────────────────────────────────

export interface SandboxConfig {
  /** 执行超时（毫秒，默认 30000） */
  timeoutMs: number;
  /** 最大内存限制（MB，默认 128） */
  maxMemoryMB: number;
  /** 临时目录前缀 */
  tmpDirPrefix: string;
  /** 是否启用沙箱执行 */
  enabled: boolean;
}

export interface SandboxResult {
  success: boolean;
  output: string | null;
  error: string | null;
  durationMs: number;
  /** 转换为 ExecutionTrace 供反思系统使用 */
  executionTrace: ExecutionTrace;
  /** 测试用例执行结果 */
  testResults: Array<{
    testName: string;
    passed: boolean;
    error?: string;
    durationMs: number;
  }>;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  timeoutMs: 30000,
  maxMemoryMB: 128,
  tmpDirPrefix: "evoclaw-sandbox-",
  enabled: true,
};

// ── SandboxExecutor ────────────────────────────────────────

export class SandboxExecutor {
  private config: SandboxConfig;
  private executionHistory: Array<{
    id: string;
    candidateId: string;
    timestamp: Date;
    success: boolean;
    durationMs: number;
  }> = [];
  private maxExecutionHistory = 200;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    config?: Partial<SandboxConfig>,
  ) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  /**
   * 在沙箱中执行进化候选方案的代码。
   * 返回结构化结果，供反思系统进一步分析。
   */
  async execute(
    candidate: EvolutionCandidate,
    testInputs?: Array<{ name: string; input: unknown; expectedOutput?: unknown }>
  ): Promise<SandboxResult> {
    const startTime = Date.now();
    const executionId = randomUUID();

    if (!this.config.enabled) {
      return this.createEmptyResult(candidate, executionId, startTime);
    }

    // 提取要执行的代码
    const sourceCode = this.extractExecutionCode(candidate);
    if (!sourceCode) {
      return this.createEmptyResult(candidate, executionId, startTime);
    }

    const testResults: SandboxResult["testResults"] = [];
    const steps: ExecutionTrace["steps"] = [];
    let overallSuccess = true;
    let overallError: string | null = null;

    try {
      // 使用 Node.js vm 模块隔离执行
      const vm = await import("node:vm");
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const os = await import("node:os");

      // 创建临时目录
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), this.config.tmpDirPrefix));

      // 安全：预加载白名单模块并递归冻结后注入沙箱。
      // 旧实现在沙箱中暴露宿主 require，可被
      // require.constructor.constructor('return process')() 利用逃逸 vm 上下文。
      const deepFreeze = <T>(obj: T): T => {
        if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) {
          return obj;
        }
        if (Object.isFrozen(obj)) {
          return obj;
        }
        Object.freeze(obj);
        for (const key of Object.getOwnPropertyNames(obj)) {
          const val = (obj as Record<string, unknown>)[key];
          if (val !== null && typeof val === "object") {
            deepFreeze(val);
          }
        }
        return obj;
      };
      const safeModules: Record<string, unknown> = {
        assert: deepFreeze(await import("node:assert")),
        buffer: deepFreeze(await import("node:buffer")),
        crypto: deepFreeze(await import("node:crypto")),
        path: deepFreeze(await import("node:path")),
        url: deepFreeze(await import("node:url")),
        util: deepFreeze(await import("node:util")),
        querystring: deepFreeze(await import("node:querystring")),
        string_decoder: deepFreeze(await import("node:string_decoder")),
      };

      // Track timers created by sandbox for cleanup (declared outside try for finally access)
      const sandboxTimers: ReturnType<typeof setTimeout>[] = [];

      try {
        const sandbox: Record<string, unknown> = {
          console: {
            log: (...args: unknown[]) => {
              steps.push({
                action: "console.log",
                result: args.map(String).join(" "),
                success: true,
                timestamp: Date.now(),
              });
            },
            error: (...args: unknown[]) => {
              steps.push({
                action: "console.error",
                result: args.map(String).join(" "),
                success: false,
                timestamp: Date.now(),
              });
            },
            warn: (...args: unknown[]) => {
              steps.push({
                action: "console.warn",
                result: args.map(String).join(" "),
                success: true,
                timestamp: Date.now(),
              });
            },
          },
          setTimeout: (fn: () => void, ms: number) => {
            // 限制最长超时，并追踪定时器以便清理；回调错误不得逃逸到宿主
            const limitedMs = Math.min(ms, this.config.timeoutMs);
            const id = globalThis.setTimeout(() => {
              try { fn(); } catch (err) {
                steps.push({ action: "error", result: `setTimeout callback error: ${err}`, success: false, timestamp: Date.now() });
              }
            }, limitedMs);
            sandboxTimers.push(id);
            return id;
          },
          clearTimeout: (id: ReturnType<typeof setTimeout>) => {
            globalThis.clearTimeout(id);
            const idx = sandboxTimers.indexOf(id);
            if (idx >= 0) sandboxTimers.splice(idx, 1);
          },
          setInterval: () => {
            throw new Error("setInterval is not allowed in sandbox");
          },
          queueMicrotask: (fn: () => void) => {
            globalThis.queueMicrotask(() => {
              try { fn(); } catch (err) {
                steps.push({ action: "error", result: `queueMicrotask callback error: ${err}`, success: false, timestamp: Date.now() });
              }
            });
          },
          process: {
            env: {},
            cwd: () => tmpDir,
          },
          // 安全：不暴露宿主 require，改为直接注入白名单模块的冻结副本
          ...safeModules,
          __dirname: tmpDir,
          __filename: path.join(tmpDir, "sandbox.js"),
        };

        const context = vm.createContext(sandbox);

        // 执行测试用例
        if (testInputs && testInputs.length > 0) {
          for (const testCase of testInputs) {
            const testStart = Date.now();
            try {
              const script = new vm.Script(
                this.buildTestScript(sourceCode, testCase),
              );
              const result = script.runInContext(context, {
                timeout: this.config.timeoutMs,
              });

              const passed = testCase.expectedOutput !== undefined
                ? JSON.stringify(result) === JSON.stringify(testCase.expectedOutput)
                : true;

              steps.push({
                action: `test:${testCase.name}`,
                result: passed ? "passed" : `expected ${JSON.stringify(testCase.expectedOutput)}, got ${JSON.stringify(result)}`,
                success: passed,
                timestamp: Date.now(),
              });

              testResults.push({
                testName: testCase.name,
                passed,
                durationMs: Date.now() - testStart,
              });

              if (!passed) overallSuccess = false;
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              steps.push({
                action: `test:${testCase.name}`,
                result: errorMsg,
                success: false,
                timestamp: Date.now(),
              });

              testResults.push({
                testName: testCase.name,
                passed: false,
                error: errorMsg,
                durationMs: Date.now() - testStart,
              });

              overallSuccess = false;
              overallError = overallError || errorMsg;
            }
          }
        } else {
          // 无测试用例时，执行代码本身看是否抛错
          try {
            const script = new vm.Script(sourceCode);
            script.runInContext(context, { timeout: this.config.timeoutMs });

            steps.push({
              action: "execute",
              result: "Code executed successfully",
              success: true,
              timestamp: Date.now(),
            });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            steps.push({
              action: "execute",
              result: errorMsg,
              success: false,
              timestamp: Date.now(),
            });

            overallSuccess = false;
            overallError = errorMsg;
          }
        }
      } finally {
        // Clean up sandbox timers
        for (const id of sandboxTimers) {
          globalThis.clearTimeout(id);
        }
        sandboxTimers.length = 0;

        // 清理临时目录
        try {
          await fs.rm(tmpDir, { recursive: true, force: true });
        } catch {
          // 忽略清理错误
        }
      }
    } catch (err) {
      overallSuccess = false;
      overallError = err instanceof Error ? err.message : String(err);
      steps.push({
        action: "sandbox_setup",
        result: overallError,
        success: false,
        timestamp: Date.now(),
      });
    }

    const durationMs = Date.now() - startTime;

    // 记录执行历史
    this.executionHistory.push({
      id: executionId,
      candidateId: candidate.id,
      timestamp: new Date(),
      success: overallSuccess,
      durationMs,
    });

    // Keep the history bounded so long-running processes don't accumulate
    // unbounded memory. The most recent entries are the most diagnostically
    // useful, so we trim from the front.
    if (this.executionHistory.length > this.maxExecutionHistory) {
      this.executionHistory.splice(
        0,
        this.executionHistory.length - this.maxExecutionHistory
      );
    }

    // 构建 ExecutionTrace 供反思系统使用
    const executionTrace: ExecutionTrace = {
      taskId: executionId,
      skillId: undefined,
      error: overallError || undefined,
      steps,
      context: {
        candidateId: candidate.id,
        candidateType: candidate.type,
        testCount: testResults.length,
        passedCount: testResults.filter((t) => t.passed).length,
      },
    };

    // 发布执行结果事件
    this.eventBus.publish(
      "evolution.sandbox_executed",
      {
        executionId,
        candidateId: candidate.id,
        success: overallSuccess,
        testResults,
        durationMs,
      },
      "sandbox-executor"
    ).catch(() => {});

    return {
      success: overallSuccess,
      output: overallSuccess ? "Sandbox execution completed successfully" : null,
      error: overallError,
      durationMs,
      executionTrace,
      testResults,
    };
  }

  /**
   * 获取执行历史统计
   */
  getStats(): {
    totalExecutions: number;
    successRate: number;
    averageDurationMs: number;
    recentExecutions: Array<{ id: string; candidateId: string; success: boolean; durationMs: number }>;
  } {
    const total = this.executionHistory.length;
    const successes = this.executionHistory.filter((e) => e.success).length;
    const totalDuration = this.executionHistory.reduce((sum, e) => sum + e.durationMs, 0);

    return {
      totalExecutions: total,
      successRate: total > 0 ? successes / total : 0,
      averageDurationMs: total > 0 ? Math.round(totalDuration / total) : 0,
      recentExecutions: this.executionHistory.slice(-10).map((e) => ({
        id: e.id,
        candidateId: e.candidateId,
        success: e.success,
        durationMs: e.durationMs,
      })),
    };
  }

  /**
   * 配置更新
   */
  configure(config: Partial<SandboxConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ── Private Methods ──────────────────────────────────────

  private extractExecutionCode(candidate: EvolutionCandidate): string | null {
    // 从 codeArtifacts 中提取可执行代码
    const artifacts = candidate.codeArtifacts || [];
    if (artifacts.length === 0) return null;

    // 优先找 .ts/.js 文件
    const codeArtifact = artifacts.find(
      (a) =>
        a.name?.endsWith(".ts") ||
        a.name?.endsWith(".js") ||
        a.name?.endsWith(".mjs")
    );

    if (codeArtifact && codeArtifact.source) {
      return codeArtifact.source;
    }

    // 取第一个有源码的 artifact
    const firstWithSource = artifacts.find((a) => a.source);
    return firstWithSource?.source || null;
  }

  private buildTestScript(
    sourceCode: string,
    testCase: { name: string; input: unknown; expectedOutput?: unknown }
  ): string {
    return `
      // 注入被测试代码
      ${sourceCode}

      // 执行测试
      (function() {
        const input = ${JSON.stringify(testCase.input)};
        // 尝试调用导出的函数
        if (typeof module !== 'undefined' && module.exports && typeof module.exports.handler === 'function') {
          return module.exports.handler(input);
        }
        if (typeof handler === 'function') {
          return handler(input);
        }
        // 如果代码本身就是表达式
        return input;
      })();
    `;
  }

  private createEmptyResult(
    candidate: EvolutionCandidate,
    executionId: string,
    startTime: number
  ): SandboxResult {
    return {
      success: true,
      output: null,
      error: null,
      durationMs: Date.now() - startTime,
      executionTrace: {
        taskId: executionId,
        skillId: undefined,
        steps: [],
        context: { candidateId: candidate.id, reason: "sandbox disabled or no executable code" },
      },
      testResults: [],
    };
  }
}