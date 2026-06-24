/**
 * Task Orchestrator — 编程任务调度编排器
 * 
 * 核心协调器，整合任务分解、LLM调度、结果处理、错误恢复和进度监控。
 * 借鉴 Claude Code 的 Plan-Execute-Verify 循环和自我修正机制。
 */

import { ServiceRegistry, EventBus } from "@evoclaw/core";
import {
  TaskDecomposer,
  type TaskPlan,
  type SubTask,
  type SubTaskResult,
  type DecompositionContext,
  type TaskStatus,
  TaskPriority,
  DecompositionStrategy,
} from "./task-decomposer";
import {
  LLMDispatcher,
  type LLMDispatchRequest,
  DEFAULT_LLM_CONFIG,
} from "./llm-dispatcher";

// ── Types ──────────────────────────────────────────────────

export interface OrchestratorConfig {
  maxConcurrentTasks: number;
  maxRetriesPerTask: number;
  maxRedecompositions: number;
  capabilityUpgradeThreshold: number; // 0-1, failure rate above this triggers upgrade
  progressCallbackIntervalMs: number;
  autoVerifyResults: boolean;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxConcurrentTasks: 3,
  maxRetriesPerTask: 2,
  maxRedecompositions: 2,
  capabilityUpgradeThreshold: 0.5,
  progressCallbackIntervalMs: 1000,
  autoVerifyResults: true,
};

export type ProgressPhase = "decomposing" | "dispatching" | "verifying" | "integrating" | "completed" | "failed";

export interface ProgressEvent {
  planId: string;
  phase: ProgressPhase;
  currentTask?: string;
  completedTasks: number;
  totalTasks: number;
  percentComplete: number;
  message: string;
  timestamp: Date;
}

export interface ExecutionResult {
  planId: string;
  success: boolean;
  rootTaskId: string;
  completedTasks: SubTaskResult[];
  failedTasks: Array<{ task: SubTask; error: string }>;
  totalDurationMs: number;
  totalTokenUsage: { input: number; output: number };
  integratedResult: string;
  capabilityAssessment: CapabilityAssessment;
}

export interface CapabilityAssessment {
  level: number; // 1-10
  strengths: string[];
  weaknesses: string[];
  failureRate: number;
  averageTaskDurationMs: number;
  recommendation: string;
  needsUpgrade: boolean;
}

export type ProgressCallback = (event: ProgressEvent) => void;

// ── Task Orchestrator ──────────────────────────────────────

export class TaskOrchestrator {
  private decomposer: TaskDecomposer;
  private dispatcher: LLMDispatcher;
  private config: OrchestratorConfig;
  private activeExecutions = new Map<string, { cancel: () => void }>();
  private executionHistory: ExecutionResult[] = [];

  constructor(
    private registry?: ServiceRegistry,
    private eventBus?: EventBus,
    config?: Partial<OrchestratorConfig>,
  ) {
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
    this.decomposer = new TaskDecomposer(registry, eventBus);
    this.dispatcher = new LLMDispatcher(registry, eventBus);
  }

  /**
   * Execute a complex programming task end-to-end.
   */
  async execute(
    taskDescription: string,
    options?: {
      strategy?: DecompositionStrategy;
      context?: DecompositionContext;
      onProgress?: ProgressCallback;
    },
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const strategy = options?.strategy ?? DecompositionStrategy.HYBRID;
    let cancelled = false;
    const abortController = new AbortController();

    // Register for cancellation
    const planIdPlaceholder = `exec_${Date.now()}`;
    let currentKey = planIdPlaceholder;
    this.activeExecutions.set(planIdPlaceholder, {
      cancel: () => {
        cancelled = true;
        abortController.abort();
      },
    });

    try {
      // ── Phase 1: Decompose ──
      this.emitProgress(options?.onProgress, {
        planId: planIdPlaceholder,
        phase: "decomposing",
        completedTasks: 0,
        totalTasks: 0,
        percentComplete: 0,
        message: "正在分解任务...",
        timestamp: new Date(),
      });

      const plan = await this.decomposer.decompose(taskDescription, strategy, options?.context);
      
      // Update the active execution key
      this.activeExecutions.delete(planIdPlaceholder);
      this.activeExecutions.set(plan.id, { cancel: () => { cancelled = true; abortController.abort(); } });
      currentKey = plan.id;

      this.emitProgress(options?.onProgress, {
        planId: plan.id,
        phase: "dispatching",
        completedTasks: 0,
        totalTasks: plan.subTasks.length,
        percentComplete: 0,
        message: `任务已分解为 ${plan.subTasks.length} 个子任务`,
        timestamp: new Date(),
      });

      // ── Phase 2: Execute subtasks ──
      const completedResults: SubTaskResult[] = [];
      const failedTasks: Array<{ task: SubTask; error: string }> = [];
      const taskResultMap = new Map<string, SubTaskResult>();
      let redecompositionCount = 0;

      // Build dependency graph
      const pendingTasks = new Map(plan.subTasks.map(t => [t.id, t]));
      const runningTasks = new Set<string>();

      while (pendingTasks.size > 0 && !cancelled) {
        // Find tasks ready to execute (all dependencies met)
        const readyTasks = this.findReadyTasks(pendingTasks, taskResultMap, runningTasks);

        if (readyTasks.length === 0 && runningTasks.size === 0) {
          // Deadlock: no tasks can run and none are running
          for (const [id, task] of pendingTasks) {
            failedTasks.push({ task, error: "Deadlock: unresolvable dependencies" });
          }
          break;
        }

        if (readyTasks.length === 0) {
          // Wait for running tasks to complete
          await this.sleep(500);
          continue;
        }

        // Execute ready tasks (up to max concurrency)
        const tasksToRun = readyTasks.slice(0, this.config.maxConcurrentTasks - runningTasks.size);

        const dispatchPromises = tasksToRun.map(async (task) => {
          runningTasks.add(task.id);
          task.status = "running" as TaskStatus;
          task.startedAt = new Date();

          try {
            // Build context from completed dependencies
            const depContext = this.buildDependencyContext(task, taskResultMap);

            const request: LLMDispatchRequest = {
              task,
              additionalContext: depContext,
            };

            const result = await this.dispatcher.dispatch(request);

            if (result.success) {
              task.status = "completed" as TaskStatus;
              task.result = result;
              task.completedAt = new Date();
              taskResultMap.set(task.id, result);
              completedResults.push(result);
            } else {
              // Handle failure
              task.retryCount++;
              
              if (task.retryCount < task.maxRetries) {
                // Retry
                task.status = "pending" as TaskStatus;
                runningTasks.delete(task.id);
                pendingTasks.set(task.id, task);
                return;
              }

              // Check if we should re-decompose
              if (task.estimatedComplexity >= 6 && redecompositionCount < this.config.maxRedecompositions) {
                try {
                  const newTasks = await this.decomposer.reDecompose(
                    plan.id,
                    task.id,
                    `Task failed: ${result.issues.join("; ")}`,
                  );
                  
                  // Add new tasks to pending
                  for (const nt of newTasks) {
                    pendingTasks.set(nt.id, nt);
                  }
                  redecompositionCount++;
                  
                  task.status = "cancelled" as TaskStatus;
                } catch {
                  task.status = "failed" as TaskStatus;
                  failedTasks.push({ task, error: result.issues.join("; ") });
                }
              } else {
                task.status = "failed" as TaskStatus;
                failedTasks.push({ task, error: result.issues.join("; ") });
              }
            }
          } catch (err) {
            task.status = "failed" as TaskStatus;
            failedTasks.push({
              task,
              error: err instanceof Error ? err.message : String(err),
            });
          } finally {
            runningTasks.delete(task.id);
            if (task.status !== "pending") {
              pendingTasks.delete(task.id);
            }
          }

          // Emit progress
          const completed = completedResults.length;
          const total = plan.subTasks.length;
          this.emitProgress(options?.onProgress, {
            planId: plan.id,
            phase: "dispatching",
            currentTask: task.name,
            completedTasks: completed,
            totalTasks: total,
            percentComplete: Math.round((completed / total) * 100),
            message: `完成: ${task.name} (${completed}/${total})`,
            timestamp: new Date(),
          });
        });

        await Promise.all(dispatchPromises);
      }

      // ── Phase 3: Verify results ──
      if (this.config.autoVerifyResults && completedResults.length > 0) {
        this.emitProgress(options?.onProgress, {
          planId: plan.id,
          phase: "verifying",
          completedTasks: completedResults.length,
          totalTasks: plan.subTasks.length,
          percentComplete: 90,
          message: "正在验证结果...",
          timestamp: new Date(),
        });

        // Verification is done by checking acceptance criteria
        for (const task of plan.subTasks) {
          if (task.result?.success && task.acceptanceCriteria.length > 0) {
            // Basic verification: check if output mentions key terms from acceptance criteria
            const output = String(task.result.output || "");
            const unmetCriteria = task.acceptanceCriteria.filter(
              c => !this.isCriterionLikelyMet(c, output),
            );
            if (unmetCriteria.length > 0) {
              task.result.issues.push(`可能未满足的验收标准: ${unmetCriteria.join(", ")}`);
            }
          }
        }
      }

      // ── Phase 4: Integrate results ──
      this.emitProgress(options?.onProgress, {
        planId: plan.id,
        phase: "integrating",
        completedTasks: completedResults.length,
        totalTasks: plan.subTasks.length,
        percentComplete: 95,
        message: "正在整合结果...",
        timestamp: new Date(),
      });

      const integratedResult = this.integrateResults(plan, completedResults);

      // ── Capability Assessment ──
      const capabilityAssessment = this.assessCapability(plan, completedResults, failedTasks, Date.now() - startTime);

      // ── Final Result ──
      const result: ExecutionResult = {
        planId: plan.id,
        success: failedTasks.length === 0,
        rootTaskId: plan.rootTask.id,
        completedTasks: completedResults,
        failedTasks,
        totalDurationMs: Date.now() - startTime,
        totalTokenUsage: {
          input: completedResults.reduce((sum, r) => sum + (r.tokenUsage?.input || 0), 0),
          output: completedResults.reduce((sum, r) => sum + (r.tokenUsage?.output || 0), 0),
        },
        integratedResult,
        capabilityAssessment,
      };

      this.executionHistory.push(result);

      this.emitProgress(options?.onProgress, {
        planId: plan.id,
        phase: result.success ? "completed" : "failed",
        completedTasks: completedResults.length,
        totalTasks: plan.subTasks.length,
        percentComplete: 100,
        message: result.success ? "任务完成" : `任务部分失败 (${failedTasks.length} 个子任务失败)`,
        timestamp: new Date(),
      });

      this.eventBus?.publish("claude-code-tools:task-completed", {
        planId: plan.id,
        success: result.success,
        completedCount: completedResults.length,
        failedCount: failedTasks.length,
        durationMs: result.totalDurationMs,
      }, "task-orchestrator").catch(() => {});

      // Trigger capability upgrade if needed
      if (capabilityAssessment.needsUpgrade) {
        this.eventBus?.publish("claude-code-tools:capability-upgrade-needed", {
          planId: plan.id,
          assessment: capabilityAssessment,
        }, "task-orchestrator").catch(() => {});
      }

      return result;
    } finally {
      this.activeExecutions.delete(currentKey);
    }
  }

  /**
   * Cancel a running execution.
   */
  cancel(planId: string): boolean {
    const execution = this.activeExecutions.get(planId);
    if (execution) {
      execution.cancel();
      return true;
    }
    return false;
  }

  /**
   * Get execution history.
   */
  getHistory(): ExecutionResult[] {
    return [...this.executionHistory];
  }

  /**
   * Get the task decomposer instance.
   */
  getDecomposer(): TaskDecomposer {
    return this.decomposer;
  }

  /**
   * Get the LLM dispatcher instance.
   */
  getDispatcher(): LLMDispatcher {
    return this.dispatcher;
  }

  // ── Private Methods ──────────────────────────────────────

  private findReadyTasks(
    pending: Map<string, SubTask>,
    results: Map<string, SubTaskResult>,
    running: Set<string>,
  ): SubTask[] {
    const ready: SubTask[] = [];
    
    for (const [id, task] of pending) {
      if (running.has(id)) continue;
      
      // Check all dependencies are completed
      const depsMet = task.dependencies.every(depId => results.has(depId));
      if (depsMet) {
        ready.push(task);
      }
    }

    // Sort by priority
    ready.sort((a, b) => a.priority - b.priority);
    return ready;
  }

  private buildDependencyContext(task: SubTask, results: Map<string, SubTaskResult>): string {
    if (task.dependencies.length === 0) return "";
    
    const parts: string[] = ["## 前序任务结果"];
    
    for (const depId of task.dependencies) {
      const result = results.get(depId);
      if (result?.success && result.output) {
        const output = String(result.output);
        // Truncate long outputs
        const truncated = output.length > 2000 ? output.substring(0, 2000) + "\n...(已截断)" : output;
        parts.push(`### 前序任务 ${depId.slice(0, 8)} 的结果:\n${truncated}`);
      }
    }

    return parts.join("\n\n");
  }

  private integrateResults(plan: TaskPlan, results: SubTaskResult[]): string {
    if (results.length === 0) return "没有完成的子任务";

    const parts: string[] = [];
    parts.push(`# 任务执行报告: ${plan.rootTask.name}`);
    parts.push("");
    parts.push(`执行策略: ${plan.strategy}`);
    parts.push(`子任务总数: ${plan.subTasks.length}`);
    parts.push(`成功完成: ${results.length}`);
    parts.push(`失败: ${plan.subTasks.length - results.length}`);
    parts.push("");

    // Integrate outputs by task order
    for (const subTask of plan.subTasks) {
      if (subTask.result?.success) {
        parts.push(`## ${subTask.name}`);
        parts.push("");
        const output = String(subTask.result.output || "");
        // Include the full output for integration
        parts.push(output);
        parts.push("");
      }
    }

    // Summary
    parts.push("---");
    parts.push("## 执行摘要");
    const totalTokens = results.reduce((sum, r) => sum + (r.tokenUsage?.input || 0) + (r.tokenUsage?.output || 0), 0);
    parts.push(`总 Token 消耗: ${totalTokens}`);
    
    const allArtifacts = results.flatMap(r => r.artifacts);
    if (allArtifacts.length > 0) {
      parts.push(`产出物: ${allArtifacts.join(", ")}`);
    }

    const allIssues = results.flatMap(r => r.issues);
    if (allIssues.length > 0) {
      parts.push(`注意事项: ${allIssues.join("; ")}`);
    }

    return parts.join("\n");
  }

  private isCriterionLikelyMet(criterion: string, output: string): boolean {
    // Simple heuristic: check if key terms from the criterion appear in the output
    const terms = criterion.split(/[\s,，、]+/).filter(t => t.length >= 2);
    if (terms.length === 0) return true;
    
    const lowerOutput = output.toLowerCase();
    const matchedTerms = terms.filter(t => lowerOutput.includes(t.toLowerCase()));
    return matchedTerms.length >= Math.ceil(terms.length * 0.5);
  }

  private assessCapability(
    plan: TaskPlan,
    completed: SubTaskResult[],
    failed: Array<{ task: SubTask; error: string }>,
    totalDurationMs: number,
  ): CapabilityAssessment {
    const total = completed.length + failed.length;
    const failureRate = total > 0 ? failed.length / total : 0;
    const avgDuration = total > 0 ? totalDurationMs / total : 0;

    // Calculate capability level based on success rate and complexity handled
    const successRate = 1 - failureRate;
    const avgComplexity = plan.subTasks.reduce((sum, t) => sum + t.estimatedComplexity, 0) / Math.max(plan.subTasks.length, 1);
    const level = Math.round((successRate * 5 + avgComplexity * 0.5) * 10) / 10;

    const strengths: string[] = [];
    const weaknesses: string[] = [];

    // Analyze by task type
    const typeStats = new Map<string, { success: number; fail: number }>();
    for (const r of completed) {
      const task = plan.subTasks.find(t => t.result === r);
      if (task) {
        const stat = typeStats.get(task.type) || { success: 0, fail: 0 };
        stat.success++;
        typeStats.set(task.type, stat);
      }
    }
    for (const f of failed) {
      const stat = typeStats.get(f.task.type) || { success: 0, fail: 0 };
      stat.fail++;
      typeStats.set(f.task.type, stat);
    }

    for (const [type, stat] of typeStats) {
      const rate = stat.success / (stat.success + stat.fail);
      if (rate >= 0.8) {
        strengths.push(`${type} 任务成功率高 (${(rate * 100).toFixed(0)}%)`);
      } else if (rate < 0.5) {
        weaknesses.push(`${type} 任务成功率低 (${(rate * 100).toFixed(0)}%)`);
      }
    }

    if (avgDuration < 10000) {
      strengths.push("响应速度快");
    } else if (avgDuration > 60000) {
      weaknesses.push("响应速度慢");
    }

    const needsUpgrade = failureRate > this.config.capabilityUpgradeThreshold;

    let recommendation: string;
    if (failureRate === 0) {
      recommendation = "当前能力充足，可处理更复杂任务";
    } else if (failureRate < 0.3) {
      recommendation = "能力基本满足，建议优化失败任务的提示策略";
    } else if (failureRate < 0.5) {
      recommendation = "能力不足，建议增强任务分解粒度和上下文注入";
    } else {
      recommendation = "能力严重不足，需要升级模型或优化任务规划策略";
    }

    return {
      level: Math.max(1, Math.min(10, level)),
      strengths,
      weaknesses,
      failureRate,
      averageTaskDurationMs: Math.round(avgDuration),
      recommendation,
      needsUpgrade,
    };
  }

  private emitProgress(callback: ProgressCallback | undefined, event: ProgressEvent): void {
    if (callback) {
      try {
        callback(event);
      } catch {
        // Ignore callback errors
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
