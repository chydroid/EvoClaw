/**
 * Claude Code Plugin — EvoClaw 编程任务调度插件
 *
 * 将编程任务调度能力集成到 EvoClaw 插件系统，提供：
 *   - 编程任务分解与调度
 *   - LLM 调用管理
 *   - 结果整合与验证
 *   - 能力评估与自动提升
 */

import { ServiceRegistry, EventBus, SystemEvents } from "@evoclaw/core";
import { TaskDecomposer, type TaskPlan, type SubTask, DecompositionStrategy, type DecompositionContext } from "./task-decomposer";
import { LLMDispatcher } from "./llm-dispatcher";
import { TaskOrchestrator, type ExecutionResult, type ProgressCallback, type ProgressEvent } from "./task-orchestrator";
import { CapabilityUpgrader, type UpgradeAction } from "./capability-upgrade";
import type { CapabilityAssessment } from "./task-orchestrator";

// ── Plugin Info ────────────────────────────────────────────

export const CLAUDE_CODE_PLUGIN_INFO = {
  name: "Claude Code Tools",
  version: "1.0.0",
  description: "编程任务调度插件 — 复杂编程项目任务的分解、LLM调度与结果整合",
  author: "EvoClaw",
  capabilities: [
    "task_decomposition",
    "llm_dispatch",
    "result_integration",
    "error_recovery",
    "capability_assessment",
    "auto_upgrade",
  ],
};

// ── Plugin Class ───────────────────────────────────────────

export class ClaudeCodePlugin {
  private orchestrator!: TaskOrchestrator;
  private upgrader!: CapabilityUpgrader;
  private initialized = false;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
  ) {}

  /**
   * Initialize the plugin and register services.
   */
  initialize(): void {
    if (this.initialized) return;

    // Create core components
    this.orchestrator = new TaskOrchestrator(this.registry, this.eventBus);
    this.upgrader = new CapabilityUpgrader(this.registry, this.eventBus);

    // Register services
    this.registry.registerService("claudeCodeOrchestrator", this.orchestrator);
    this.registry.registerService("claudeCodeDecomposer", this.orchestrator.getDecomposer());
    this.registry.registerService("claudeCodeDispatcher", this.orchestrator.getDispatcher());
    this.registry.registerService("claudeCodeUpgrader", this.upgrader);

    // Register agent tools
    this.registerTools();

    // Listen for capability upgrade events
    this.eventBus.subscribe("claude-code-tools:capability-upgrade-needed", async (event) => {
      const data = event.data as { planId: string; assessment: CapabilityAssessment };
      this.handleCapabilityUpgradeNeeded(data.assessment);
    });

    this.initialized = true;
    console.log(`[ClaudeCodePlugin] Initialized — ${CLAUDE_CODE_PLUGIN_INFO.name} v${CLAUDE_CODE_PLUGIN_INFO.version}`);
  }

  /**
   * Execute a complex programming task.
   */
  async executeTask(
    taskDescription: string,
    options?: {
      strategy?: DecompositionStrategy;
      context?: DecompositionContext;
      onProgress?: ProgressCallback;
    },
  ): Promise<ExecutionResult> {
    if (!this.initialized) {
      throw new Error("ClaudeCodePlugin not initialized. Call initialize() first.");
    }

    const result = await this.orchestrator.execute(taskDescription, options);

    // Analyze and potentially upgrade
    if (result.capabilityAssessment.needsUpgrade) {
      const actions = this.upgrader.analyzeExecution(result);
      if (actions.length > 0) {
        console.log(`[ClaudeCodePlugin] Capability upgrade needed: ${actions.length} actions`);
        // Apply top priority action
        await this.upgrader.applyAction(actions[0]);
      }
    }

    return result;
  }

  /**
   * Decompose a task without executing it.
   */
  async decomposeTask(
    taskDescription: string,
    strategy?: DecompositionStrategy,
    context?: DecompositionContext,
  ): Promise<TaskPlan> {
    return this.orchestrator.getDecomposer().decompose(taskDescription, strategy, context);
  }

  /**
   * Get current capability assessment.
   */
  getCapabilityAssessment(): CapabilityAssessment {
    return this.upgrader.getCurrentAssessment();
  }

  /**
   * Get execution history.
   */
  getExecutionHistory(): ExecutionResult[] {
    return this.orchestrator.getHistory();
  }

  /**
   * Health check.
   */
  async healthCheck(): Promise<boolean> {
    return this.initialized;
  }

  // ── Private Methods ──────────────────────────────────────

  private registerTools(): void {
    const agentExecutor = this.registry.resolveService<{
      registerTool(
        name: string,
        definition: { name: string; description: string; parameters: Record<string, unknown> },
        handler: (params: Record<string, unknown>) => Promise<unknown>,
      ): void;
    }>("agentModelExecutor");

    if (!agentExecutor) return;

    // Tool: Execute programming task
    agentExecutor.registerTool(
      "execute_programming_task",
      {
        name: "execute_programming_task",
        description: "执行复杂编程任务：自动分解为子任务、调度LLM完成、整合结果。适用于需要多步骤的编程项目任务。",
        parameters: {
          task_description: {
            type: "string",
            description: "编程任务的详细描述，包括需求、约束和期望输出",
          },
          strategy: {
            type: "string",
            description: "分解策略: sequential(顺序), parallel(并行), hybrid(混合，推荐)",
          },
          language: {
            type: "string",
            description: "编程语言（可选）",
          },
          framework: {
            type: "string",
            description: "使用的框架（可选）",
          },
        },
      },
      async (params) => {
        const strategy = params.strategy === "sequential" ? DecompositionStrategy.SEQUENTIAL
          : params.strategy === "parallel" ? DecompositionStrategy.PARALLEL
          : DecompositionStrategy.HYBRID;

        const context: DecompositionContext = {
          language: params.language as string | undefined,
          framework: params.framework as string | undefined,
        };

        const result = await this.executeTask(
          params.task_description as string,
          { strategy, context },
        );

        return {
          success: result.success,
          summary: result.integratedResult,
          completedTasks: result.completedTasks.length,
          failedTasks: result.failedTasks.length,
          totalDurationMs: result.totalDurationMs,
          capabilityLevel: result.capabilityAssessment.level,
        };
      },
    );

    // Tool: Decompose task (preview only)
    agentExecutor.registerTool(
      "decompose_programming_task",
      {
        name: "decompose_programming_task",
        description: "预览编程任务的分解方案，不执行。用于评估任务复杂度和规划。",
        parameters: {
          task_description: {
            type: "string",
            description: "编程任务描述",
          },
        },
      },
      async (params) => {
        const plan = await this.decomposeTask(params.task_description as string);
        return {
          planId: plan.id,
          rootTask: plan.rootTask.name,
          subTaskCount: plan.subTasks.length,
          subTasks: plan.subTasks.map(t => ({
            name: t.name,
            type: t.type,
            complexity: t.estimatedComplexity,
            dependencies: t.dependencies.length,
          })),
          totalComplexity: plan.estimatedTotalComplexity,
          criticalPathLength: plan.criticalPath.length,
        };
      },
    );

    // Tool: Assess capability
    agentExecutor.registerTool(
      "assess_coding_capability",
      {
        name: "assess_coding_capability",
        description: "评估当前编程任务调度能力等级，获取优劣势分析和改进建议。",
        parameters: {},
      },
      async () => {
        const assessment = this.getCapabilityAssessment();
        return {
          level: assessment.level,
          strengths: assessment.strengths,
          weaknesses: assessment.weaknesses,
          failureRate: assessment.failureRate,
          recommendation: assessment.recommendation,
          needsUpgrade: assessment.needsUpgrade,
        };
      },
    );
  }

  private async handleCapabilityUpgradeNeeded(assessment: CapabilityAssessment): Promise<void> {
    console.log(`[ClaudeCodePlugin] Capability upgrade triggered — level: ${assessment.level}, failureRate: ${(assessment.failureRate * 100).toFixed(0)}%`);

    // Create a synthetic execution result for analysis
    const syntheticResult: ExecutionResult = {
      planId: "upgrade-trigger",
      success: false,
      rootTaskId: "",
      completedTasks: [],
      failedTasks: [],
      totalDurationMs: 0,
      totalTokenUsage: { input: 0, output: 0 },
      integratedResult: "",
      capabilityAssessment: assessment,
    };

    const actions = this.upgrader.analyzeExecution(syntheticResult);

    // Apply the highest priority action
    if (actions.length > 0) {
      const result = await this.upgrader.applyAction(actions[0]);
      console.log(`[ClaudeCodePlugin] Upgrade applied: ${result.message}`);
    }
  }
}
