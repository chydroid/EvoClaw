/**
 * Task Decomposer — 编程任务分解引擎
 * 
 * 将复杂编程项目任务分解为可调度的子任务树，支持多种分解策略和LLM辅助分解。
 * 借鉴 Claude Code 的任务规划理念：Plan → Decompose → Schedule → Execute → Verify
 */

import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { v4 as uuid } from "uuid";

// ── Types ──────────────────────────────────────────────────

export enum TaskType {
  CODE_GENERATION = "code_generation",
  CODE_REVIEW = "code_review",
  DEBUGGING = "debugging",
  REFACTORING = "refactoring",
  TESTING = "testing",
  DOCUMENTATION = "documentation",
  ANALYSIS = "analysis",
  DEPLOYMENT = "deployment",
  PROJECT_SETUP = "project_setup",
  INTEGRATION = "integration",
}

export enum TaskPriority {
  CRITICAL = 0,
  HIGH = 1,
  MEDIUM = 2,
  LOW = 3,
}

export enum DecompositionStrategy {
  SEQUENTIAL = "sequential",
  PARALLEL = "parallel",
  HYBRID = "hybrid",
}

export enum TaskStatus {
  PENDING = "pending",
  READY = "ready",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
  BLOCKED = "blocked",
}

export interface SubTask {
  id: string;
  parentId: string | null;
  rootTaskId: string;
  name: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  dependencies: string[];  // IDs of tasks that must complete first
  estimatedComplexity: number; // 1-10
  acceptanceCriteria: string[];
  context: Record<string, unknown> | DecompositionContext;  // Additional context for the subtask
  result?: SubTaskResult;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface SubTaskResult {
  success: boolean;
  output: unknown;
  artifacts: string[];  // Files or resources produced
  issues: string[];     // Issues encountered
  suggestions: string[]; // Suggestions for next tasks
  tokenUsage?: { input: number; output: number };
  durationMs: number;
}

export interface TaskPlan {
  id: string;
  rootTask: SubTask;
  subTasks: SubTask[];
  strategy: DecompositionStrategy;
  createdAt: Date;
  estimatedTotalComplexity: number;
  criticalPath: string[];  // IDs of tasks on the critical path
  metadata: Record<string, unknown>;
}

export interface DecompositionContext {
  projectRoot?: string;
  language?: string;
  framework?: string;
  existingFiles?: string[];
  requirements?: string[];
  constraints?: string[];
}

// ── Task Decomposer ────────────────────────────────────────

export class TaskDecomposer {
  private plans = new Map<string, TaskPlan>();

  constructor(
    private registry?: ServiceRegistry,
    private eventBus?: EventBus,
  ) {}

  /**
   * Decompose a complex programming task into a task plan with subtasks.
   */
  async decompose(
    taskDescription: string,
    strategy: DecompositionStrategy = DecompositionStrategy.HYBRID,
    context?: DecompositionContext,
  ): Promise<TaskPlan> {
    const rootId = uuid();

    // Classify the main task type
    const taskType = this.classifyTaskType(taskDescription);

    // Create root task
    const rootTask: SubTask = {
      id: rootId,
      parentId: null,
      rootTaskId: rootId,
      name: this.extractTaskName(taskDescription),
      description: taskDescription,
      type: taskType,
      status: TaskStatus.PENDING,
      priority: TaskPriority.HIGH,
      dependencies: [],
      estimatedComplexity: this.estimateComplexity(taskDescription),
      acceptanceCriteria: this.generateAcceptanceCriteria(taskDescription, taskType),
      context: context ?? {},
      retryCount: 0,
      maxRetries: 2,
      createdAt: new Date(),
    };

    // Decompose into subtasks based on strategy
    let subTasks: SubTask[];

    if (strategy === DecompositionStrategy.SEQUENTIAL) {
      subTasks = this.decomposeSequential(taskDescription, rootId, context);
    } else if (strategy === DecompositionStrategy.PARALLEL) {
      subTasks = this.decomposeParallel(taskDescription, rootId, context);
    } else {
      subTasks = this.decomposeHybrid(taskDescription, rootId, context);
    }

    // Try LLM-assisted decomposition if available
    const llmSubTasks = await this.tryLlmDecomposition(taskDescription, rootId, context);
    if (llmSubTasks && llmSubTasks.length > subTasks.length) {
      subTasks = llmSubTasks;
    }

    // Build the plan
    const allTasks = [rootTask, ...subTasks];
    const criticalPath = this.computeCriticalPath(allTasks);
    const totalComplexity = allTasks.reduce((sum, t) => sum + t.estimatedComplexity, 0);

    const plan: TaskPlan = {
      id: uuid(),
      rootTask,
      subTasks,
      strategy,
      createdAt: new Date(),
      estimatedTotalComplexity: totalComplexity,
      criticalPath,
      metadata: { context },
    };

    this.plans.set(plan.id, plan);

    this.eventBus?.publish("claude-code-tools:task-decomposed", {
      planId: plan.id,
      rootTaskId: rootId,
      subTaskCount: subTasks.length,
      strategy,
    }, "task-decomposer").catch(() => {});

    return plan;
  }

  /**
   * Re-decompose a subtask that is too complex.
   */
  async reDecompose(
    planId: string,
    subTaskId: string,
    reason: string,
  ): Promise<SubTask[]> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);

    const subTask = plan.subTasks.find(t => t.id === subTaskId);
    if (!subTask) throw new Error(`SubTask ${subTaskId} not found in plan ${planId}`);

    // Mark original as cancelled
    subTask.status = TaskStatus.CANCELLED;

    // Decompose the subtask further
    const newSubTasks = this.decomposeHybrid(
      `${subTask.description}\n\nRe-decomposition reason: ${reason}`,
      subTask.rootTaskId,
      subTask.context as DecompositionContext,
    );

    // Set parent and dependencies
    for (const nst of newSubTasks) {
      nst.parentId = subTaskId;
      nst.priority = subTask.priority;
      // Inherit dependencies from parent
      nst.dependencies = [...subTask.dependencies];
    }

    // Update tasks that depended on the cancelled task
    for (const t of plan.subTasks) {
      const depIdx = t.dependencies.indexOf(subTaskId);
      if (depIdx >= 0) {
        t.dependencies.splice(depIdx, 1);
        // Now depend on the last new subtask
        t.dependencies.push(newSubTasks[newSubTasks.length - 1].id);
      }
    }

    plan.subTasks.push(...newSubTasks);

    this.eventBus?.publish("claude-code-tools:task-redecomposed", {
      planId,
      originalTaskId: subTaskId,
      newSubTaskCount: newSubTasks.length,
      reason,
    }, "task-decomposer").catch(() => {});

    return newSubTasks;
  }

  getPlan(planId: string): TaskPlan | undefined {
    return this.plans.get(planId);
  }

  listPlans(): TaskPlan[] {
    return Array.from(this.plans.values());
  }

  // ── Decomposition Strategies ─────────────────────────────

  private decomposeSequential(desc: string, rootId: string, ctx?: DecompositionContext): SubTask[] {
    const type = this.classifyTaskType(desc);
    const steps = this.getSequentialSteps(desc, type);

    const tasks = steps.map((step, i) => ({
      id: uuid(),
      parentId: rootId,
      rootTaskId: rootId,
      name: step.name,
      description: step.description,
      type: step.type ?? type,
      status: TaskStatus.PENDING,
      priority: i === 0 ? TaskPriority.HIGH : TaskPriority.MEDIUM,
      dependencies: [] as string[],
      estimatedComplexity: step.complexity ?? 5,
      acceptanceCriteria: step.acceptanceCriteria ?? [],
      context: ctx ?? {},
      retryCount: 0,
      maxRetries: 2,
      createdAt: new Date(),
    }));

    // Fix sequential dependencies: each task depends on the previous one
    for (let i = 1; i < tasks.length; i++) {
      tasks[i].dependencies = [tasks[i - 1].id];
    }

    return tasks;
  }

  private decomposeParallel(desc: string, rootId: string, ctx?: DecompositionContext): SubTask[] {
    const type = this.classifyTaskType(desc);
    const aspects = this.getParallelAspects(desc, type);

    return aspects.map((aspect) => ({
      id: uuid(),
      parentId: rootId,
      rootTaskId: rootId,
      name: aspect.name,
      description: aspect.description,
      type: aspect.type ?? type,
      status: TaskStatus.PENDING,
      priority: TaskPriority.MEDIUM,
      dependencies: [],
      estimatedComplexity: aspect.complexity ?? 4,
      acceptanceCriteria: aspect.acceptanceCriteria ?? [],
      context: ctx ?? {},
      retryCount: 0,
      maxRetries: 2,
      createdAt: new Date(),
    }));
  }

  private decomposeHybrid(desc: string, rootId: string, ctx?: DecompositionContext): SubTask[] {
    const type = this.classifyTaskType(desc);
    const phases = this.getHybridPhases(desc, type);
    const tasks: SubTask[] = [];
    let lastPhaseTaskIds: string[] = [];

    for (const phase of phases) {
      const phaseTaskIds: string[] = [];

      if (phase.parallel) {
        // Parallel tasks within this phase
        for (const step of phase.steps) {
          const taskId = uuid();
          tasks.push({
            id: taskId,
            parentId: rootId,
            rootTaskId: rootId,
            name: step.name,
            description: step.description,
            type: step.type ?? type,
            status: TaskStatus.PENDING,
            priority: step.priority ?? TaskPriority.MEDIUM,
            dependencies: [...lastPhaseTaskIds],
            estimatedComplexity: step.complexity ?? 4,
            acceptanceCriteria: step.acceptanceCriteria ?? [],
            context: ctx ?? {},
            retryCount: 0,
            maxRetries: 2,
            createdAt: new Date(),
          });
          phaseTaskIds.push(taskId);
        }
      } else {
        // Sequential tasks within this phase
        let prevId: string | null = null;
        for (const step of phase.steps) {
          const taskId = uuid();
          const deps = prevId ? [prevId] : [...lastPhaseTaskIds];
          tasks.push({
            id: taskId,
            parentId: rootId,
            rootTaskId: rootId,
            name: step.name,
            description: step.description,
            type: step.type ?? type,
            status: TaskStatus.PENDING,
            priority: step.priority ?? TaskPriority.MEDIUM,
            dependencies: deps,
            estimatedComplexity: step.complexity ?? 4,
            acceptanceCriteria: step.acceptanceCriteria ?? [],
            context: ctx ?? {},
            retryCount: 0,
            maxRetries: 2,
            createdAt: new Date(),
          });
          phaseTaskIds.push(taskId);
          prevId = taskId;
        }
      }

      lastPhaseTaskIds = phaseTaskIds;
    }

    return tasks;
  }

  // ── Task Classification ──────────────────────────────────

  private classifyTaskType(desc: string): TaskType {
    const lower = desc.toLowerCase();

    const patterns: Array<{ regex: RegExp; type: TaskType }> = [
      { regex: /调试|debug|修复|fix|bug|报错|错误|异常|exception|error/i, type: TaskType.DEBUGGING },
      { regex: /重构|refactor|优化|optimize|改进|improve|重写|rewrite/i, type: TaskType.REFACTORING },
      { regex: /测试|test|spec|单元测试|集成测试|e2e|coverage/i, type: TaskType.TESTING },
      { regex: /文档|doc|readme|注释|comment|说明|guide|tutorial/i, type: TaskType.DOCUMENTATION },
      { regex: /分析|analyze|评估|review|审查|检查|inspect|audit/i, type: TaskType.ANALYSIS },
      { regex: /部署|deploy|发布|release|ci\/cd|pipeline|上线/i, type: TaskType.DEPLOYMENT },
      { regex: /初始化|init|setup|搭建|创建项目|脚手架|scaffold/i, type: TaskType.PROJECT_SETUP },
      { regex: /集成|integrate|对接|接入|api|sdk|plugin/i, type: TaskType.INTEGRATION },
      { regex: /审查|review|code review|代码审查|pr|pull request/i, type: TaskType.CODE_REVIEW },
      { regex: /实现|implement|开发|编写|创建|build|generate|add|写/i, type: TaskType.CODE_GENERATION },
    ];

    for (const { regex, type } of patterns) {
      if (regex.test(lower)) return type;
    }

    return TaskType.CODE_GENERATION;
  }

  private estimateComplexity(desc: string): number {
    let complexity = 3;
    if (desc.length > 200) complexity += 2;
    if (desc.length > 500) complexity += 1;
    if (/多个|多个模块|全栈|full.?stack/i.test(desc)) complexity += 2;
    if (/简单|simple|single|单个/i.test(desc)) complexity -= 2;
    if (/架构|architecture|设计|design|系统/i.test(desc)) complexity += 2;
    if (/性能|performance|安全|security/i.test(desc)) complexity += 1;
    return Math.max(1, Math.min(10, complexity));
  }

  private extractTaskName(desc: string): string {
    // Extract first meaningful line or sentence
    const firstLine = desc.split(/\n/)[0].trim();
    if (firstLine.length <= 60) return firstLine;
    return firstLine.substring(0, 57) + "...";
  }

  private generateAcceptanceCriteria(desc: string, type: TaskType): string[] {
    const criteria: string[] = [];

    switch (type) {
      case TaskType.CODE_GENERATION:
        criteria.push("代码符合项目编码规范");
        criteria.push("通过 TypeScript 编译无错误");
        criteria.push("包含必要的错误处理");
        break;
      case TaskType.DEBUGGING:
        criteria.push("定位到根本原因");
        criteria.push("修复后原有功能正常");
        criteria.push("添加回归测试");
        break;
      case TaskType.TESTING:
        criteria.push("测试覆盖核心逻辑");
        criteria.push("所有测试用例通过");
        criteria.push("覆盖边界条件");
        break;
      case TaskType.REFACTORING:
        criteria.push("重构后功能行为不变");
        criteria.push("代码可读性提升");
        criteria.push("现有测试全部通过");
        break;
      default:
        criteria.push("任务目标达成");
        criteria.push("无引入新问题");
    }

    return criteria;
  }

  // ── Step Generation ──────────────────────────────────────

  private getSequentialSteps(desc: string, type: TaskType): Array<{ name: string; description: string; type?: TaskType; complexity?: number; acceptanceCriteria?: string[] }> {
    switch (type) {
      case TaskType.CODE_GENERATION:
        return [
          { name: "需求分析", description: "分析任务需求，明确功能范围、输入输出和约束条件", type: TaskType.ANALYSIS, complexity: 3, acceptanceCriteria: ["需求文档完整", "边界条件明确"] },
          { name: "架构设计", description: "设计模块结构、接口定义和数据流", type: TaskType.ANALYSIS, complexity: 5, acceptanceCriteria: ["接口定义清晰", "模块职责明确"] },
          { name: "核心代码实现", description: "实现核心功能逻辑和数据处理", type: TaskType.CODE_GENERATION, complexity: 7, acceptanceCriteria: ["核心逻辑正确", "错误处理完善"] },
          { name: "测试编写", description: "编写单元测试和集成测试", type: TaskType.TESTING, complexity: 4, acceptanceCriteria: ["测试覆盖核心路径", "边界条件测试"] },
          { name: "代码审查与优化", description: "审查代码质量，优化性能和可读性", type: TaskType.CODE_REVIEW, complexity: 3, acceptanceCriteria: ["无代码坏味道", "性能达标"] },
        ];
      case TaskType.DEBUGGING:
        return [
          { name: "问题复现", description: "复现bug，确认触发条件和影响范围", complexity: 4, acceptanceCriteria: ["稳定复现", "影响范围明确"] },
          { name: "根因分析", description: "通过日志、堆栈和代码分析定位根本原因", type: TaskType.ANALYSIS, complexity: 6, acceptanceCriteria: ["根因定位", "修复方案确定"] },
          { name: "修复实现", description: "实现修复代码", type: TaskType.CODE_GENERATION, complexity: 5, acceptanceCriteria: ["修复正确", "无副作用"] },
          { name: "回归验证", description: "验证修复有效且未引入新问题", type: TaskType.TESTING, complexity: 3, acceptanceCriteria: ["原bug已修复", "回归测试通过"] },
        ];
      case TaskType.REFACTORING:
        return [
          { name: "现状分析", description: "分析当前代码结构和问题点", type: TaskType.ANALYSIS, complexity: 4, acceptanceCriteria: ["问题清单完整"] },
          { name: "重构方案设计", description: "设计重构方案，确保行为不变", type: TaskType.ANALYSIS, complexity: 5, acceptanceCriteria: ["方案可行", "风险评估完成"] },
          { name: "增量重构", description: "分步实施重构，每步保持测试通过", type: TaskType.CODE_GENERATION, complexity: 6, acceptanceCriteria: ["每步可验证", "测试始终通过"] },
          { name: "验证与清理", description: "全面验证重构结果，清理临时代码", type: TaskType.CODE_REVIEW, complexity: 3, acceptanceCriteria: ["功能不变", "代码质量提升"] },
        ];
      default:
        return [
          { name: "任务分析", description: "分析任务需求和约束", type: TaskType.ANALYSIS, complexity: 3 },
          { name: "方案设计", description: "设计实现方案", type: TaskType.ANALYSIS, complexity: 4 },
          { name: "实现执行", description: "执行实现", complexity: 6 },
          { name: "验证确认", description: "验证结果", type: TaskType.TESTING, complexity: 3 },
        ];
    }
  }

  private getParallelAspects(desc: string, type: TaskType): Array<{ name: string; description: string; type?: TaskType; complexity?: number; acceptanceCriteria?: string[] }> {
    switch (type) {
      case TaskType.PROJECT_SETUP:
        return [
          { name: "项目结构搭建", description: "创建项目目录结构和配置文件", complexity: 3, acceptanceCriteria: ["目录结构规范"] },
          { name: "依赖配置", description: "配置项目依赖和构建工具", complexity: 3, acceptanceCriteria: ["依赖安装成功", "构建通过"] },
          { name: "代码规范配置", description: "配置 ESLint、Prettier、TypeScript 等", complexity: 2, acceptanceCriteria: ["lint 通过"] },
          { name: "CI/CD 配置", description: "配置持续集成和部署流程", type: TaskType.DEPLOYMENT, complexity: 3, acceptanceCriteria: ["CI 流水线可运行"] },
        ];
      default:
        return [
          { name: "核心功能实现", description: "实现核心功能", complexity: 6 },
          { name: "辅助功能实现", description: "实现辅助功能", complexity: 4 },
          { name: "测试编写", description: "编写测试用例", type: TaskType.TESTING, complexity: 4 },
        ];
    }
  }

  private getHybridPhases(desc: string, type: TaskType): Array<{ parallel: boolean; steps: Array<{ name: string; description: string; type?: TaskType; complexity?: number; priority?: TaskPriority; acceptanceCriteria?: string[] }> }> {
    // Phase 1: Analysis (sequential)
    // Phase 2: Implementation (can be parallel for independent modules)
    // Phase 3: Testing & Review (sequential)

    switch (type) {
      case TaskType.CODE_GENERATION:
        return [
          {
            parallel: false,
            steps: [
              { name: "需求分析", description: "分析任务需求，明确功能范围", type: TaskType.ANALYSIS, complexity: 3, priority: TaskPriority.HIGH },
            ],
          },
          {
            parallel: true,
            steps: [
              { name: "核心模块实现", description: "实现核心业务逻辑模块", complexity: 7, priority: TaskPriority.HIGH },
              { name: "接口层实现", description: "实现 API 接口和数据模型", complexity: 5, priority: TaskPriority.MEDIUM },
              { name: "工具函数实现", description: "实现辅助工具函数和类型定义", complexity: 3, priority: TaskPriority.LOW },
            ],
          },
          {
            parallel: false,
            steps: [
              { name: "集成测试", description: "编写和运行集成测试", type: TaskType.TESTING, complexity: 4 },
              { name: "代码审查", description: "审查代码质量和一致性", type: TaskType.CODE_REVIEW, complexity: 3 },
            ],
          },
        ];
      case TaskType.DEBUGGING:
        return [
          {
            parallel: false,
            steps: [
              { name: "问题分析", description: "分析错误信息和复现条件", type: TaskType.ANALYSIS, complexity: 5, priority: TaskPriority.CRITICAL },
            ],
          },
          {
            parallel: true,
            steps: [
              { name: "根因定位", description: "定位bug根本原因", type: TaskType.ANALYSIS, complexity: 6, priority: TaskPriority.HIGH },
              { name: "影响范围评估", description: "评估bug影响范围和严重程度", type: TaskType.ANALYSIS, complexity: 3, priority: TaskPriority.MEDIUM },
            ],
          },
          {
            parallel: false,
            steps: [
              { name: "修复实现", description: "实现修复代码", complexity: 5 },
              { name: "回归验证", description: "验证修复有效", type: TaskType.TESTING, complexity: 3 },
            ],
          },
        ];
      default:
        return [
          {
            parallel: false,
            steps: [
              { name: "任务分析", description: "分析任务需求", type: TaskType.ANALYSIS, complexity: 3 },
            ],
          },
          {
            parallel: true,
            steps: [
              { name: "主要实现", description: "实现主要功能", complexity: 6 },
              { name: "辅助实现", description: "实现辅助功能", complexity: 4 },
            ],
          },
          {
            parallel: false,
            steps: [
              { name: "验证确认", description: "验证结果", type: TaskType.TESTING, complexity: 3 },
            ],
          },
        ];
    }
  }

  // ── LLM-Assisted Decomposition ───────────────────────────

  private async tryLlmDecomposition(
    desc: string,
    rootId: string,
    ctx?: DecompositionContext,
  ): Promise<SubTask[] | null> {
    // Try to use the agent model executor for LLM-assisted decomposition
    if (!this.registry) return null;

    const executor = this.registry.resolveService<{
      getProviders(): Array<{
        id: string; name: string; provider: string; model: string;
        apiKey?: string; baseURL?: string; enabled: boolean; order: number;
        maxTokens: number; temperature: number; timeout: number;
      }>;
    }>("agentModelExecutor");

    if (!executor) return null;

    try {
      const providers = executor.getProviders().filter(p => p.enabled);
      if (providers.length === 0) return null;

      const provider = providers[0];
      const prompt = this.buildDecompositionPrompt(desc, ctx);
      const response = await this.callLLMDirect(provider, prompt);

      if (response?.content) {
        return this.parseLlmDecomposition(response.content, rootId, ctx);
      }
    } catch {
      // LLM decomposition failed, fallback to rule-based
    }

    return null;
  }

  /**
   * Direct LLM API call for decomposition — bypasses chat() to avoid nested tool loops.
   */
  private async callLLMDirect(
    provider: {
      provider: string; model: string; apiKey?: string; baseURL?: string;
      maxTokens: number; temperature: number; timeout: number;
    },
    userPrompt: string,
  ): Promise<{ content: string }> {
    let apiURL = provider.baseURL || "";
    if (!apiURL.endsWith("/chat/completions") && !apiURL.endsWith("/v1/chat/completions")) {
      apiURL = apiURL.replace(/\/+$/, "");
      if (!apiURL.endsWith("/v1")) {
        apiURL = `${apiURL}/v1`;
      }
      apiURL = `${apiURL}/chat/completions`;
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (provider.apiKey) {
      if (provider.provider === "anthropic") {
        headers["x-api-key"] = provider.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${provider.apiKey}`;
      }
    }

    const body: Record<string, unknown> = {
      model: provider.model,
      messages: [
        { role: "system", content: "你是一个编程任务分解专家。请严格按照用户要求的JSON格式返回结果。" },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 4096,
      temperature: 0.3,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(apiURL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`LLM API HTTP ${response.status}`);
      }

      const data = await response.json() as any;
      return { content: data.choices?.[0]?.message?.content || "" };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildDecompositionPrompt(desc: string, ctx?: DecompositionContext): string {
    const contextInfo = ctx ? `
项目上下文:
- 语言: ${ctx.language || "未知"}
- 框架: ${ctx.framework || "未知"}
- 项目根目录: ${ctx.projectRoot || "未知"}
${ctx.requirements?.length ? `- 需求: ${ctx.requirements.join(", ")}` : ""}
${ctx.constraints?.length ? `- 约束: ${ctx.constraints.join(", ")}` : ""}
` : "";

    return `你是一个编程任务分解专家。请将以下复杂编程任务分解为具体的子任务列表。

任务描述: ${desc}
${contextInfo}
请以 JSON 格式返回子任务列表，每个子任务包含:
- name: 子任务名称（简短）
- description: 详细描述
- type: 任务类型 (code_generation|code_review|debugging|refactoring|testing|documentation|analysis|deployment|project_setup|integration)
- complexity: 复杂度 (1-10)
- dependencies: 依赖的前序子任务序号（从0开始，-1表示无依赖）
- acceptanceCriteria: 验收标准数组

返回格式:
\`\`\`json
[
  {
    "name": "...",
    "description": "...",
    "type": "...",
    "complexity": 5,
    "dependencies": [-1],
    "acceptanceCriteria": ["..."]
  }
]
\`\`\``;
  }

  private parseLlmDecomposition(content: string, rootId: string, ctx?: DecompositionContext): SubTask[] | null {
    try {
      // Extract JSON from response
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (!jsonMatch) return null;

      const items = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      if (!Array.isArray(items)) return null;

      const taskIds = items.map(() => uuid());

      return items.map((item: any, i: number) => ({
        id: taskIds[i],
        parentId: rootId,
        rootTaskId: rootId,
        name: String(item.name || `子任务 ${i + 1}`),
        description: String(item.description || ""),
        type: this.validateTaskType(item.type),
        status: TaskStatus.PENDING,
        priority: i < 2 ? TaskPriority.HIGH : TaskPriority.MEDIUM,
        dependencies: (item.dependencies as number[] || [])
          .filter((d: number) => d >= 0 && d < taskIds.length)
          .map((d: number) => taskIds[d]),
        estimatedComplexity: Math.max(1, Math.min(10, Number(item.complexity) || 5)),
        acceptanceCriteria: Array.isArray(item.acceptanceCriteria)
          ? item.acceptanceCriteria.map(String) : [],
        context: ctx ?? {},
        retryCount: 0,
        maxRetries: 2,
        createdAt: new Date(),
      }));
    } catch {
      return null;
    }
  }

  private validateTaskType(type: string): TaskType {
    const validTypes = Object.values(TaskType);
    return validTypes.includes(type as TaskType) ? (type as TaskType) : TaskType.CODE_GENERATION;
  }

  // ── Critical Path Computation ────────────────────────────

  private computeCriticalPath(tasks: SubTask[]): string[] {
    if (tasks.length === 0) return [];

    // Build adjacency list
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const inDegree = new Map<string, number>();
    const dist = new Map<string, number>();

    for (const t of tasks) {
      inDegree.set(t.id, t.dependencies.length);
      dist.set(t.id, t.estimatedComplexity);
    }

    // Topological sort with longest path
    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const topoOrder: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      topoOrder.push(current);

      for (const t of tasks) {
        if (t.dependencies.includes(current)) {
          const newDist = (dist.get(current) || 0) + t.estimatedComplexity;
          if (newDist > (dist.get(t.id) || 0)) {
            dist.set(t.id, newDist);
          }
          const newDeg = (inDegree.get(t.id) || 1) - 1;
          inDegree.set(t.id, newDeg);
          if (newDeg === 0) queue.push(t.id);
        }
      }
    }

    // Find the task with maximum distance and trace back
    let maxDist = 0;
    let endTask = tasks[0].id;
    for (const [id, d] of dist) {
      if (d > maxDist) {
        maxDist = d;
        endTask = id;
      }
    }

    // Trace back from end task
    const path: string[] = [endTask];
    let current = endTask;
    while (true) {
      const task = taskMap.get(current);
      if (!task || task.dependencies.length === 0) break;

      // Find the dependency with maximum distance
      let bestDep = task.dependencies[0];
      let bestDist = dist.get(bestDep) || 0;
      for (const dep of task.dependencies) {
        if ((dist.get(dep) || 0) > bestDist) {
          bestDist = dist.get(dep) || 0;
          bestDep = dep;
        }
      }
      path.unshift(bestDep);
      current = bestDep;
    }

    return path;
  }
}
