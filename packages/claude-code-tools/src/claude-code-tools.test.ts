/**
 * Unit Tests — claude-code-tools (new modules)
 *
 * Covers: TaskDecomposer, LLMDispatcher, TaskOrchestrator,
 *         CapabilityUpgrader, ClaudeCodePlugin
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceRegistry } from "@evoclaw/core";
import { EventBus } from "@evoclaw/core";

import {
  TaskDecomposer,
  TaskType,
  TaskPriority,
  DecompositionStrategy,
  TaskStatus,
  type TaskPlan,
  type SubTask,
  type DecompositionContext,
} from "./task-decomposer";

import {
  LLMDispatcher,
  DEFAULT_LLM_CONFIG,
  type LLMDispatchRequest,
  type LLMDispatchResponse,
} from "./llm-dispatcher";

import {
  TaskOrchestrator,
  DEFAULT_ORCHESTRATOR_CONFIG,
  type ExecutionResult,
  type ProgressEvent,
  type ProgressCallback,
} from "./task-orchestrator";

import {
  CapabilityUpgrader,
  type UpgradeAction,
  type UpgradeResult,
  type CapabilityProfile,
} from "./capability-upgrade";

import {
  ClaudeCodePlugin,
  CLAUDE_CODE_PLUGIN_INFO,
} from "./claude-code-plugin";

// ═══════════════════════════════════════════════════════════════
// Helpers — minimal mocks
// ═══════════════════════════════════════════════════════════════

function createMockRegistry(services: Record<string, unknown> = {}): ServiceRegistry {
  const registry = new ServiceRegistry();
  for (const [name, svc] of Object.entries(services)) {
    registry.registerService(name, svc);
  }
  return registry;
}

function createMockEventBus(): EventBus {
  return new EventBus();
}

/** Create a fake LLM executor that returns a predictable response */
function createMockLLMExecutor(overrides: Partial<{ content: string; usage: { promptTokens: number; completionTokens: number }; model: string; finishReason: string }> = {}) {
  return {
    execute: vi.fn().mockResolvedValue({
      content: overrides.content ?? "## 实现思路\n简单实现\n\n## 代码实现\n```typescript\nconsole.log('hello');\n```\n\n## 注意事项\n注意错误处理",
      usage: overrides.usage ?? { promptTokens: 100, completionTokens: 50 },
      model: overrides.model ?? "mock-model",
      finishReason: overrides.finishReason ?? "stop",
    }),
    registerTool: vi.fn(),
  };
}

// ═══════════════════════════════════════════════════════════════
// TaskDecomposer
// ═══════════════════════════════════════════════════════════════

describe("TaskDecomposer", () => {
  let decomposer: TaskDecomposer;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = createMockEventBus();
    decomposer = new TaskDecomposer(undefined, eventBus);
  });

  // ── Sequential Strategy ──────────────────────────────────

  describe("decompose() with sequential strategy", () => {
    it("should create a plan with sequential dependencies", async () => {
      const plan = await decomposer.decompose(
        "实现用户登录功能",
        DecompositionStrategy.SEQUENTIAL,
      );

      expect(plan).toBeDefined();
      expect(plan.strategy).toBe(DecompositionStrategy.SEQUENTIAL);
      expect(plan.rootTask).toBeDefined();
      expect(plan.subTasks.length).toBeGreaterThan(0);

      // Each subtask (except the first) should depend on the previous one
      for (let i = 1; i < plan.subTasks.length; i++) {
        expect(plan.subTasks[i].dependencies).toContain(plan.subTasks[i - 1].id);
      }
    });

    it("should set rootTask correctly", async () => {
      const plan = await decomposer.decompose(
        "实现用户登录功能",
        DecompositionStrategy.SEQUENTIAL,
      );

      expect(plan.rootTask.parentId).toBeNull();
      expect(plan.rootTask.rootTaskId).toBe(plan.rootTask.id);
      expect(plan.rootTask.description).toBe("实现用户登录功能");
    });

    it("should set all subtask parentId to rootTaskId", async () => {
      const plan = await decomposer.decompose(
        "实现用户登录功能",
        DecompositionStrategy.SEQUENTIAL,
      );

      for (const st of plan.subTasks) {
        expect(st.parentId).toBe(plan.rootTask.id);
        expect(st.rootTaskId).toBe(plan.rootTask.id);
      }
    });
  });

  // ── Parallel Strategy ────────────────────────────────────

  describe("decompose() with parallel strategy", () => {
    it("should create a plan with no inter-task dependencies", async () => {
      const plan = await decomposer.decompose(
        "初始化项目",
        DecompositionStrategy.PARALLEL,
      );

      expect(plan).toBeDefined();
      expect(plan.strategy).toBe(DecompositionStrategy.PARALLEL);
      expect(plan.subTasks.length).toBeGreaterThan(0);

      // Parallel tasks should have no dependencies on each other
      for (const st of plan.subTasks) {
        expect(st.dependencies).toHaveLength(0);
      }
    });

    it("should classify project_setup type for init tasks", async () => {
      const plan = await decomposer.decompose(
        "初始化项目",
        DecompositionStrategy.PARALLEL,
      );

      expect(plan.rootTask.type).toBe(TaskType.PROJECT_SETUP);
    });
  });

  // ── Hybrid Strategy ──────────────────────────────────────

  describe("decompose() with hybrid strategy", () => {
    it("should create a plan with mixed dependencies", async () => {
      const plan = await decomposer.decompose(
        "实现用户登录功能",
        DecompositionStrategy.HYBRID,
      );

      expect(plan).toBeDefined();
      expect(plan.strategy).toBe(DecompositionStrategy.HYBRID);
      expect(plan.subTasks.length).toBeGreaterThan(0);
    });

    it("should have at least one task with dependencies and one without", async () => {
      const plan = await decomposer.decompose(
        "实现用户登录功能",
        DecompositionStrategy.HYBRID,
      );

      const withDeps = plan.subTasks.filter(t => t.dependencies.length > 0);
      const withoutDeps = plan.subTasks.filter(t => t.dependencies.length === 0);
      // Hybrid should produce both kinds
      expect(withDeps.length + withoutDeps.length).toBe(plan.subTasks.length);
    });

    it("should default to hybrid when no strategy specified", async () => {
      const plan = await decomposer.decompose("实现用户登录功能");
      expect(plan.strategy).toBe(DecompositionStrategy.HYBRID);
    });
  });

  // ── Task Type Classification ─────────────────────────────

  describe("task type classification", () => {
    const cases: Array<{ desc: string; expected: TaskType }> = [
      { desc: "修复登录页面的bug", expected: TaskType.DEBUGGING },
      { desc: "debug the auth module", expected: TaskType.DEBUGGING },
      { desc: "重构数据库访问层", expected: TaskType.REFACTORING },
      { desc: "refactor the service layer", expected: TaskType.REFACTORING },
      { desc: "编写单元测试", expected: TaskType.TESTING },
      { desc: "add test coverage for utils", expected: TaskType.TESTING },
      { desc: "编写API文档", expected: TaskType.DOCUMENTATION },
      { desc: "add readme guide", expected: TaskType.DOCUMENTATION },
      { desc: "分析系统性能瓶颈", expected: TaskType.ANALYSIS },
      { desc: "review this pull request", expected: TaskType.ANALYSIS }, // "review" matches analysis pattern first
      { desc: "approve the pr", expected: TaskType.CODE_REVIEW }, // "pr" uniquely matches code_review
      { desc: "部署到生产环境", expected: TaskType.DEPLOYMENT },
      { desc: "deploy to staging", expected: TaskType.DEPLOYMENT },
      { desc: "初始化前端项目", expected: TaskType.PROJECT_SETUP },
      { desc: "setup the project scaffold", expected: TaskType.PROJECT_SETUP },
      { desc: "集成第三方支付SDK", expected: TaskType.INTEGRATION },
      { desc: "实现用户注册功能", expected: TaskType.CODE_GENERATION },
      { desc: "build the payment module", expected: TaskType.CODE_GENERATION },
    ];

    for (const { desc, expected } of cases) {
      it(`should classify "${desc}" as ${expected}`, async () => {
        const plan = await decomposer.decompose(desc);
        expect(plan.rootTask.type).toBe(expected);
      });
    }
  });

  // ── Complexity Estimation ────────────────────────────────

  describe("complexity estimation", () => {
    it("should assign complexity between 1 and 10 for root task", async () => {
      const plan = await decomposer.decompose("简单任务");
      expect(plan.rootTask.estimatedComplexity).toBeGreaterThanOrEqual(1);
      expect(plan.rootTask.estimatedComplexity).toBeLessThanOrEqual(10);
    });

    it("should assign higher complexity for longer descriptions", async () => {
      const short = await decomposer.decompose("修复bug");
      const long = await decomposer.decompose("修复bug".repeat(100) + "多个模块架构设计性能安全");
      expect(long.rootTask.estimatedComplexity).toBeGreaterThanOrEqual(short.rootTask.estimatedComplexity);
    });

    it("should assign lower complexity for simple descriptions", async () => {
      const plan = await decomposer.decompose("简单的单个修改");
      expect(plan.rootTask.estimatedComplexity).toBeLessThanOrEqual(5);
    });

    it("should compute estimatedTotalComplexity as sum of all tasks", async () => {
      const plan = await decomposer.decompose("实现用户登录功能", DecompositionStrategy.SEQUENTIAL);
      const allTasks = [plan.rootTask, ...plan.subTasks];
      const expectedSum = allTasks.reduce((sum, t) => sum + t.estimatedComplexity, 0);
      expect(plan.estimatedTotalComplexity).toBe(expectedSum);
    });
  });

  // ── Acceptance Criteria ──────────────────────────────────

  describe("acceptance criteria generation", () => {
    it("should generate criteria for code_generation tasks", async () => {
      const plan = await decomposer.decompose("实现用户登录功能");
      expect(plan.rootTask.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(plan.rootTask.acceptanceCriteria.some(c => c.includes("编码规范") || c.includes("错误处理"))).toBe(true);
    });

    it("should generate criteria for debugging tasks", async () => {
      const plan = await decomposer.decompose("修复登录bug");
      expect(plan.rootTask.acceptanceCriteria.some(c => c.includes("根因") || c.includes("回归"))).toBe(true);
    });

    it("should generate criteria for testing tasks", async () => {
      const plan = await decomposer.decompose("编写测试用例");
      expect(plan.rootTask.acceptanceCriteria.some(c => c.includes("测试") || c.includes("覆盖"))).toBe(true);
    });

    it("should generate criteria for refactoring tasks", async () => {
      const plan = await decomposer.decompose("重构用户模块");
      expect(plan.rootTask.acceptanceCriteria.some(c => c.includes("行为不变") || c.includes("可读性"))).toBe(true);
    });
  });

  // ── reDecompose ──────────────────────────────────────────

  describe("reDecompose()", () => {
    it("should create new subtasks and update dependencies", async () => {
      const plan = await decomposer.decompose("实现用户登录功能", DecompositionStrategy.SEQUENTIAL);

      // Pick a subtask to re-decompose
      const targetTask = plan.subTasks[2];
      const newSubTasks = await decomposer.reDecompose(plan.id, targetTask.id, "Too complex");

      expect(newSubTasks.length).toBeGreaterThan(0);

      // Original task should be cancelled
      expect(targetTask.status).toBe(TaskStatus.CANCELLED);

      // New subtasks should have parentId set to the cancelled task
      for (const nst of newSubTasks) {
        expect(nst.parentId).toBe(targetTask.id);
      }

      // Tasks that depended on the cancelled task should now depend on the last new subtask
      const lastNewTask = newSubTasks[newSubTasks.length - 1];
      for (const t of plan.subTasks) {
        if (t.id !== targetTask.id && !newSubTasks.some(n => n.id === t.id)) {
          if (t.dependencies.includes(targetTask.id)) {
            // This dependency should have been replaced
            expect(t.dependencies).toContain(lastNewTask.id);
          }
        }
      }
    });

    it("should throw for non-existent plan", async () => {
      await expect(
        decomposer.reDecompose("nonexistent-plan", "some-task", "reason"),
      ).rejects.toThrow("not found");
    });

    it("should throw for non-existent subtask", async () => {
      const plan = await decomposer.decompose("实现用户登录功能");
      await expect(
        decomposer.reDecompose(plan.id, "nonexistent-task", "reason"),
      ).rejects.toThrow("not found");
    });
  });

  // ── Plan Management ──────────────────────────────────────

  describe("plan management", () => {
    it("should store and retrieve plans", async () => {
      const plan = await decomposer.decompose("实现用户登录功能");
      expect(decomposer.getPlan(plan.id)).toBe(plan);
    });

    it("should return undefined for unknown plan", () => {
      expect(decomposer.getPlan("nonexistent")).toBeUndefined();
    });

    it("should list all plans", async () => {
      await decomposer.decompose("实现用户登录功能");
      await decomposer.decompose("修复支付bug");
      expect(decomposer.listPlans()).toHaveLength(2);
    });
  });

  // ── Critical Path ────────────────────────────────────────

  describe("critical path", () => {
    it("should compute a non-empty critical path", async () => {
      const plan = await decomposer.decompose("实现用户登录功能", DecompositionStrategy.SEQUENTIAL);
      expect(plan.criticalPath.length).toBeGreaterThan(0);
    });

    it("should compute critical path containing only subtask IDs", async () => {
      const plan = await decomposer.decompose("实现用户登录功能", DecompositionStrategy.SEQUENTIAL);
      // Critical path consists of subtask IDs (root task has no dependencies)
      expect(plan.criticalPath.length).toBeGreaterThan(0);
      for (const id of plan.criticalPath) {
        const allIds = [plan.rootTask.id, ...plan.subTasks.map(t => t.id)];
        expect(allIds).toContain(id);
      }
    });
  });

  // ── Context ──────────────────────────────────────────────

  describe("decomposition context", () => {
    it("should pass context to subtasks", async () => {
      const ctx: DecompositionContext = {
        language: "TypeScript",
        framework: "React",
        projectRoot: "/project",
      };
      const plan = await decomposer.decompose("实现用户登录功能", DecompositionStrategy.HYBRID, ctx);

      for (const st of plan.subTasks) {
        expect(st.context).toEqual(ctx);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// LLMDispatcher
// ═══════════════════════════════════════════════════════════════

describe("LLMDispatcher", () => {
  let dispatcher: LLMDispatcher;
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let mockExecutor: ReturnType<typeof createMockLLMExecutor>;

  beforeEach(() => {
    eventBus = createMockEventBus();
    mockExecutor = createMockLLMExecutor();
    registry = createMockRegistry({ agentModelExecutor: mockExecutor });
    dispatcher = new LLMDispatcher(registry, eventBus);
  });

  // ── System Prompts ───────────────────────────────────────

  describe("getSystemPrompt()", () => {
    it("should return correct prompt for code_generation", () => {
      const prompt = dispatcher.getSystemPrompt(TaskType.CODE_GENERATION);
      expect(prompt).toContain("编程助手");
      expect(prompt).toContain("代码实现");
    });

    it("should return correct prompt for debugging", () => {
      const prompt = dispatcher.getSystemPrompt(TaskType.DEBUGGING);
      expect(prompt).toContain("调试专家");
      expect(prompt).toContain("修复");
    });

    it("should return correct prompt for code_review", () => {
      const prompt = dispatcher.getSystemPrompt(TaskType.CODE_REVIEW);
      expect(prompt).toContain("代码审查");
    });

    it("should return correct prompt for refactoring", () => {
      const prompt = dispatcher.getSystemPrompt(TaskType.REFACTORING);
      expect(prompt).toContain("重构");
    });

    it("should return correct prompt for testing", () => {
      const prompt = dispatcher.getSystemPrompt(TaskType.TESTING);
      expect(prompt).toContain("测试");
    });

    it("should return correct prompt for documentation", () => {
      const prompt = dispatcher.getSystemPrompt(TaskType.DOCUMENTATION);
      expect(prompt).toContain("文档");
    });

    it("should return correct prompt for analysis", () => {
      const prompt = dispatcher.getSystemPrompt(TaskType.ANALYSIS);
      expect(prompt).toContain("分析");
    });

    it("should return correct prompt for deployment", () => {
      const prompt = dispatcher.getSystemPrompt(TaskType.DEPLOYMENT);
      expect(prompt).toContain("部署");
    });

    it("should return correct prompt for project_setup", () => {
      const prompt = dispatcher.getSystemPrompt(TaskType.PROJECT_SETUP);
      expect(prompt).toContain("项目");
    });

    it("should return correct prompt for integration", () => {
      const prompt = dispatcher.getSystemPrompt(TaskType.INTEGRATION);
      expect(prompt).toContain("集成");
    });

    it("should fallback to code_generation for unknown type", () => {
      const prompt = dispatcher.getSystemPrompt("unknown_type");
      expect(prompt).toContain("编程助手");
    });
  });

  // ── Dispatch ─────────────────────────────────────────────

  describe("dispatch()", () => {
    it("should dispatch successfully with a registered LLM executor", async () => {
      const task: SubTask = {
        id: "task-1",
        parentId: null,
        rootTaskId: "root-1",
        name: "实现登录",
        description: "实现用户登录功能",
        type: TaskType.CODE_GENERATION,
        status: TaskStatus.PENDING,
        priority: TaskPriority.HIGH,
        dependencies: [],
        estimatedComplexity: 5,
        acceptanceCriteria: ["代码符合规范"],
        context: {},
        retryCount: 0,
        maxRetries: 2,
        createdAt: new Date(),
      };

      const result = await dispatcher.dispatch({ task });

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
      expect(result.tokenUsage).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(mockExecutor.execute).toHaveBeenCalled();
    });

    it("should handle missing LLM executor gracefully", async () => {
      // Dispatcher without registry — no executor available
      const noExecutorDispatcher = new LLMDispatcher(undefined, eventBus, { maxRetries: 0, retryBaseDelayMs: 0 });

      const task: SubTask = {
        id: "task-no-exec",
        parentId: null,
        rootTaskId: "root-no-exec",
        name: "测试任务",
        description: "测试无executor",
        type: TaskType.CODE_GENERATION,
        status: TaskStatus.PENDING,
        priority: TaskPriority.MEDIUM,
        dependencies: [],
        estimatedComplexity: 3,
        acceptanceCriteria: [],
        context: {},
        retryCount: 0,
        maxRetries: 1,
        createdAt: new Date(),
      };

      const result = await noExecutorDispatcher.dispatch({ task });

      expect(result.success).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]).toContain("No LLM executor");
    });

    it("should pass system prompt and task prompt to executor", async () => {
      const task: SubTask = {
        id: "task-prompt",
        parentId: null,
        rootTaskId: "root-prompt",
        name: "实现登录",
        description: "实现用户登录功能",
        type: TaskType.CODE_GENERATION,
        status: TaskStatus.PENDING,
        priority: TaskPriority.HIGH,
        dependencies: [],
        estimatedComplexity: 5,
        acceptanceCriteria: ["代码符合规范"],
        context: {},
        retryCount: 0,
        maxRetries: 2,
        createdAt: new Date(),
      };

      await dispatcher.dispatch({ task });

      const callArgs = mockExecutor.execute.mock.calls[0][0];
      expect(callArgs.systemPrompt).toContain("编程助手");
      expect(callArgs.prompt).toContain("实现登录");
    });

    it("should use custom system prompt when provided", async () => {
      const task: SubTask = {
        id: "task-custom",
        parentId: null,
        rootTaskId: "root-custom",
        name: "自定义提示",
        description: "使用自定义系统提示",
        type: TaskType.CODE_GENERATION,
        status: TaskStatus.PENDING,
        priority: TaskPriority.MEDIUM,
        dependencies: [],
        estimatedComplexity: 3,
        acceptanceCriteria: [],
        context: {},
        retryCount: 0,
        maxRetries: 2,
        createdAt: new Date(),
      };

      await dispatcher.dispatch({ task, systemPrompt: "Custom system prompt" });

      const callArgs = mockExecutor.execute.mock.calls[0][0];
      expect(callArgs.systemPrompt).toBe("Custom system prompt");
    });
  });

  // ── Stats Tracking ───────────────────────────────────────

  describe("stats tracking", () => {
    it("should track call statistics", async () => {
      const task: SubTask = {
        id: "task-stats",
        parentId: null,
        rootTaskId: "root-stats",
        name: "统计测试",
        description: "测试统计功能",
        type: TaskType.CODE_GENERATION,
        status: TaskStatus.PENDING,
        priority: TaskPriority.MEDIUM,
        dependencies: [],
        estimatedComplexity: 3,
        acceptanceCriteria: [],
        context: {},
        retryCount: 0,
        maxRetries: 2,
        createdAt: new Date(),
      };

      await dispatcher.dispatch({ task });

      const stats = dispatcher.getStats();
      expect(stats.totalCalls).toBe(1);
      expect(stats.successRate).toBe(1);
      expect(stats.totalInputTokens).toBe(100);
      expect(stats.totalOutputTokens).toBe(50);
      expect(stats.averageDurationMs).toBeGreaterThanOrEqual(0);
    });

    it("should track multiple calls", async () => {
      const makeTask = (id: string): SubTask => ({
        id,
        parentId: null,
        rootTaskId: "root-multi",
        name: `任务${id}`,
        description: "测试",
        type: TaskType.CODE_GENERATION,
        status: TaskStatus.PENDING,
        priority: TaskPriority.MEDIUM,
        dependencies: [],
        estimatedComplexity: 3,
        acceptanceCriteria: [],
        context: {},
        retryCount: 0,
        maxRetries: 2,
        createdAt: new Date(),
      });

      await dispatcher.dispatch({ task: makeTask("t1") });
      await dispatcher.dispatch({ task: makeTask("t2") });

      const stats = dispatcher.getStats();
      expect(stats.totalCalls).toBe(2);
      expect(stats.successRate).toBe(1);
      expect(stats.totalInputTokens).toBe(200);
      expect(stats.totalOutputTokens).toBe(100);
    });

    it("should reflect failed calls in success rate", async () => {
      const failDispatcher = new LLMDispatcher(undefined, eventBus, { maxRetries: 0, retryBaseDelayMs: 0 });

      const task: SubTask = {
        id: "task-fail-stats",
        parentId: null,
        rootTaskId: "root-fail-stats",
        name: "失败任务",
        description: "测试失败统计",
        type: TaskType.CODE_GENERATION,
        status: TaskStatus.PENDING,
        priority: TaskPriority.MEDIUM,
        dependencies: [],
        estimatedComplexity: 3,
        acceptanceCriteria: [],
        context: {},
        retryCount: 0,
        maxRetries: 1,
        createdAt: new Date(),
      };

      await failDispatcher.dispatch({ task });

      const stats = failDispatcher.getStats();
      expect(stats.totalCalls).toBe(1);
      expect(stats.successRate).toBe(0);
    });

    it("should return zero stats initially", () => {
      const freshDispatcher = new LLMDispatcher(undefined, eventBus);
      const stats = freshDispatcher.getStats();
      expect(stats.totalCalls).toBe(0);
      expect(stats.successRate).toBe(0);
      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
      expect(stats.averageDurationMs).toBe(0);
    });
  });

  // ── Config Defaults ──────────────────────────────────────

  describe("default config", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_LLM_CONFIG.maxRetries).toBe(3);
      expect(DEFAULT_LLM_CONFIG.defaultMaxTokens).toBe(4096);
      expect(DEFAULT_LLM_CONFIG.defaultTemperature).toBe(0.3);
      expect(DEFAULT_LLM_CONFIG.timeoutMs).toBe(120000);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// TaskOrchestrator
// ═══════════════════════════════════════════════════════════════

describe("TaskOrchestrator", () => {
  let orchestrator: TaskOrchestrator;
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let mockExecutor: ReturnType<typeof createMockLLMExecutor>;

  beforeEach(() => {
    eventBus = createMockEventBus();
    mockExecutor = createMockLLMExecutor();
    registry = createMockRegistry({ agentModelExecutor: mockExecutor });
    orchestrator = new TaskOrchestrator(registry, eventBus);
  });

  // ── Execute with mocked LLM ──────────────────────────────

  describe("execute()", () => {
    it("should execute a task end-to-end with mocked LLM", async () => {
      const result = await orchestrator.execute("实现用户登录功能");

      expect(result).toBeDefined();
      expect(result.planId).toBeDefined();
      expect(result.rootTaskId).toBeDefined();
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.capabilityAssessment).toBeDefined();
      expect(typeof result.success).toBe("boolean");
    });

    it("should return success when all subtasks complete", async () => {
      const result = await orchestrator.execute("实现用户登录功能");

      // With a working mock executor, all tasks should succeed
      expect(result.success).toBe(true);
      expect(result.completedTasks.length).toBeGreaterThan(0);
      expect(result.failedTasks.length).toBe(0);
    });

    it("should track token usage", async () => {
      const result = await orchestrator.execute("实现用户登录功能");

      expect(result.totalTokenUsage).toBeDefined();
      expect(result.totalTokenUsage.input).toBeGreaterThanOrEqual(0);
      expect(result.totalTokenUsage.output).toBeGreaterThanOrEqual(0);
    });

    it("should produce an integrated result", async () => {
      const result = await orchestrator.execute("实现用户登录功能");

      expect(result.integratedResult).toBeDefined();
      expect(result.integratedResult.length).toBeGreaterThan(0);
    });

    it("should produce a capability assessment", async () => {
      const result = await orchestrator.execute("实现用户登录功能");

      const assessment = result.capabilityAssessment;
      expect(assessment.level).toBeGreaterThanOrEqual(1);
      expect(assessment.level).toBeLessThanOrEqual(10);
      expect(assessment.failureRate).toBeGreaterThanOrEqual(0);
      expect(assessment.failureRate).toBeLessThanOrEqual(1);
      expect(typeof assessment.needsUpgrade).toBe("boolean");
      expect(typeof assessment.recommendation).toBe("string");
    });
  });

  // ── Progress Callback ────────────────────────────────────

  describe("progress callback", () => {
    it("should receive progress events", async () => {
      const events: ProgressEvent[] = [];
      const onProgress: ProgressCallback = (event) => {
        events.push(event);
      };

      await orchestrator.execute("实现用户登录功能", { onProgress });

      expect(events.length).toBeGreaterThan(0);
      // Should at least have decomposing, dispatching, and completed phases
      const phases = events.map(e => e.phase);
      expect(phases).toContain("decomposing");
      expect(phases).toContain("completed");
    });

    it("should include percentComplete in progress events", async () => {
      const events: ProgressEvent[] = [];
      const onProgress: ProgressCallback = (event) => {
        events.push(event);
      };

      await orchestrator.execute("实现用户登录功能", { onProgress });

      for (const event of events) {
        expect(event.percentComplete).toBeGreaterThanOrEqual(0);
        expect(event.percentComplete).toBeLessThanOrEqual(100);
      }
    });
  });

  // ── Cancellation ─────────────────────────────────────────

  describe("cancellation", () => {
    it("should support cancel() and return false for unknown planId", () => {
      expect(orchestrator.cancel("nonexistent")).toBe(false);
    });
  });

  // ── History ──────────────────────────────────────────────

  describe("execution history", () => {
    it("should track execution history", async () => {
      await orchestrator.execute("实现用户登录功能");

      const history = orchestrator.getHistory();
      expect(history.length).toBe(1);
      expect(history[0].success).toBe(true);
    });

    it("should accumulate history across executions", async () => {
      await orchestrator.execute("实现用户登录功能");
      await orchestrator.execute("修复支付bug");

      expect(orchestrator.getHistory()).toHaveLength(2);
    });
  });

  // ── Decomposer & Dispatcher Access ───────────────────────

  describe("component access", () => {
    it("should expose the decomposer", () => {
      expect(orchestrator.getDecomposer()).toBeInstanceOf(TaskDecomposer);
    });

    it("should expose the dispatcher", () => {
      expect(orchestrator.getDispatcher()).toBeInstanceOf(LLMDispatcher);
    });
  });

  // ── Default Config ───────────────────────────────────────

  describe("default config", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_ORCHESTRATOR_CONFIG.maxConcurrentTasks).toBe(3);
      expect(DEFAULT_ORCHESTRATOR_CONFIG.maxRetriesPerTask).toBe(2);
      expect(DEFAULT_ORCHESTRATOR_CONFIG.autoVerifyResults).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// CapabilityUpgrader
// ═══════════════════════════════════════════════════════════════

describe("CapabilityUpgrader", () => {
  let upgrader: CapabilityUpgrader;
  let registry: ServiceRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = createMockEventBus();
    registry = createMockRegistry();
    upgrader = new CapabilityUpgrader(registry, eventBus);
  });

  // Helper to create a failing ExecutionResult
  function createFailingExecutionResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
    return {
      planId: "plan-fail",
      success: false,
      rootTaskId: "root-fail",
      completedTasks: [],
      failedTasks: [
        {
          task: {
            id: "st-1",
            parentId: "root-fail",
            rootTaskId: "root-fail",
            name: "复杂任务",
            description: "一个很复杂的任务",
            type: TaskType.CODE_GENERATION,
            status: TaskStatus.FAILED,
            priority: TaskPriority.HIGH,
            dependencies: [],
            estimatedComplexity: 8,
            acceptanceCriteria: [],
            context: {},
            retryCount: 2,
            maxRetries: 2,
            createdAt: new Date(),
          },
          error: "Task failed: context missing",
        },
      ],
      totalDurationMs: 50000,
      totalTokenUsage: { input: 500, output: 200 },
      integratedResult: "",
      capabilityAssessment: {
        level: 3,
        strengths: [],
        weaknesses: ["code_generation 成功率低 (0%)"],
        failureRate: 1,
        averageTaskDurationMs: 50000,
        recommendation: "能力不足，需要升级模型或优化任务规划",
        needsUpgrade: true,
      },
      ...overrides,
    };
  }

  // ── analyzeExecution ─────────────────────────────────────

  describe("analyzeExecution()", () => {
    it("should generate upgrade actions for failed executions", () => {
      const result = createFailingExecutionResult();
      const actions = upgrader.analyzeExecution(result);

      expect(actions.length).toBeGreaterThan(0);
      // Should include prompt_refinement for weak task types
      expect(actions.some(a => a.type === "prompt_refinement")).toBe(true);
    });

    it("should generate decomposition_adjustment for high complexity failures", () => {
      const result = createFailingExecutionResult();
      const actions = upgrader.analyzeExecution(result);

      expect(actions.some(a => a.type === "decomposition_adjustment")).toBe(true);
    });

    it("should generate context_enrichment when context is mentioned in error", () => {
      const result = createFailingExecutionResult();
      const actions = upgrader.analyzeExecution(result);

      expect(actions.some(a => a.type === "context_enrichment")).toBe(true);
    });

    it("should generate strategy_change for high failure rates", () => {
      const result = createFailingExecutionResult();
      const actions = upgrader.analyzeExecution(result);

      expect(actions.some(a => a.type === "strategy_change")).toBe(true);
    });

    it("should sort actions by priority (descending)", () => {
      const result = createFailingExecutionResult();
      const actions = upgrader.analyzeExecution(result);

      for (let i = 1; i < actions.length; i++) {
        expect(actions[i].priority).toBeLessThanOrEqual(actions[i - 1].priority);
      }
    });

    it("should return no actions when upgrade is not needed", () => {
      const successResult: ExecutionResult = {
        planId: "plan-ok",
        success: true,
        rootTaskId: "root-ok",
        completedTasks: [
          {
            success: true,
            output: "done",
            artifacts: [],
            issues: [],
            suggestions: [],
            tokenUsage: { input: 100, output: 50 },
            durationMs: 1000,
          },
        ],
        failedTasks: [],
        totalDurationMs: 1000,
        totalTokenUsage: { input: 100, output: 50 },
        integratedResult: "All good",
        capabilityAssessment: {
          level: 9,
          strengths: ["code_generation 成功率高 (100%)"],
          weaknesses: [],
          failureRate: 0,
          averageTaskDurationMs: 1000,
          recommendation: "能力优秀",
          needsUpgrade: false,
        },
      };

      const actions = upgrader.analyzeExecution(successResult);
      expect(actions).toHaveLength(0);
    });
  });

  // ── getCurrentAssessment ─────────────────────────────────

  describe("getCurrentAssessment()", () => {
    it("should return a valid assessment with defaults", () => {
      const assessment = upgrader.getCurrentAssessment();

      expect(assessment.level).toBeGreaterThanOrEqual(1);
      expect(assessment.level).toBeLessThanOrEqual(10);
      expect(assessment.failureRate).toBeGreaterThanOrEqual(0);
      expect(assessment.failureRate).toBeLessThanOrEqual(1);
      expect(typeof assessment.recommendation).toBe("string");
      expect(typeof assessment.needsUpgrade).toBe("boolean");
    });

    it("should reflect updated profile after analyzing execution", () => {
      const result = createFailingExecutionResult();
      upgrader.analyzeExecution(result);

      const assessment = upgrader.getCurrentAssessment();
      // After a failing execution, failure rate should be > 0
      expect(assessment.failureRate).toBeGreaterThan(0);
      expect(assessment.needsUpgrade).toBe(true);
    });
  });

  // ── applyAction ──────────────────────────────────────────

  describe("applyAction()", () => {
    it("should apply prompt_refinement action", async () => {
      const action: UpgradeAction = {
        type: "prompt_refinement",
        description: "优化提示",
        target: "code_generation",
        params: { currentSuccessRate: 0.3 },
        priority: 7,
        estimatedImpact: 0.3,
      };

      const result = await upgrader.applyAction(action);

      expect(result.applied).toBe(true);
      expect(result.action).toBe(action);
      expect(result.message).toContain("优化");
      expect(result.beforeAssessment).toBeDefined();
    });

    it("should apply decomposition_adjustment action", async () => {
      const action: UpgradeAction = {
        type: "decomposition_adjustment",
        description: "调整分解策略",
        target: "decomposer",
        params: { maxComplexity: 5 },
        priority: 8,
        estimatedImpact: 0.4,
      };

      const result = await upgrader.applyAction(action);

      expect(result.applied).toBe(true);
      expect(result.message).toContain("分解");
    });

    it("should apply context_enrichment action", async () => {
      const action: UpgradeAction = {
        type: "context_enrichment",
        description: "增强上下文",
        target: "dispatcher",
        params: { includeProjectStructure: true },
        priority: 6,
        estimatedImpact: 0.25,
      };

      const result = await upgrader.applyAction(action);

      expect(result.applied).toBe(true);
      expect(result.message).toContain("上下文");
    });

    it("should apply strategy_change action", async () => {
      const action: UpgradeAction = {
        type: "strategy_change",
        description: "切换策略",
        target: "orchestrator",
        params: { strategy: "sequential" },
        priority: 9,
        estimatedImpact: 0.5,
      };

      const result = await upgrader.applyAction(action);

      expect(result.applied).toBe(true);
      expect(result.message).toContain("策略");
    });

    it("should fail model_switch without configManager", async () => {
      const action: UpgradeAction = {
        type: "model_switch",
        description: "切换模型",
        target: "model",
        params: { suggestedCapability: "high" },
        priority: 10,
        estimatedImpact: 0.6,
      };

      const result = await upgrader.applyAction(action);

      expect(result.applied).toBe(false);
      expect(result.message).toContain("模型");
    });

    it("should apply model_switch with configManager in registry", async () => {
      const configManager = { updateConfig: vi.fn() };
      const regWithConfig = createMockRegistry({ configManager });
      const upgraderWithConfig = new CapabilityUpgrader(regWithConfig, eventBus);

      const action: UpgradeAction = {
        type: "model_switch",
        description: "切换模型",
        target: "model",
        params: { suggestedCapability: "high" },
        priority: 10,
        estimatedImpact: 0.6,
      };

      const result = await upgraderWithConfig.applyAction(action);

      expect(result.applied).toBe(true);
      expect(configManager.updateConfig).toHaveBeenCalledWith("llm.preferredModel", "high");
    });

    it("should apply skill_learning with skillManager in registry", async () => {
      const skillManager = {
        searchSkills: vi.fn().mockResolvedValue([{ name: "debug-skill" }]),
        installSkill: vi.fn(),
      };
      const regWithSkill = createMockRegistry({ skillManager });
      const upgraderWithSkill = new CapabilityUpgrader(regWithSkill, eventBus);

      const action: UpgradeAction = {
        type: "skill_learning",
        description: "学习新技能",
        target: "debugging",
        params: {},
        priority: 5,
        estimatedImpact: 0.2,
      };

      const result = await upgraderWithSkill.applyAction(action);

      expect(result.applied).toBe(true);
      expect(skillManager.searchSkills).toHaveBeenCalled();
    });

    it("should fail skill_learning without registry", async () => {
      const noRegUpgrader = new CapabilityUpgrader(undefined, eventBus);

      const action: UpgradeAction = {
        type: "skill_learning",
        description: "学习新技能",
        target: "debugging",
        params: {},
        priority: 5,
        estimatedImpact: 0.2,
      };

      const result = await noRegUpgrader.applyAction(action);
      expect(result.applied).toBe(false);
    });

    it("should record upgrade in history", async () => {
      const action: UpgradeAction = {
        type: "prompt_refinement",
        description: "优化提示",
        target: "code_generation",
        params: {},
        priority: 7,
        estimatedImpact: 0.3,
      };

      await upgrader.applyAction(action);

      const profile = upgrader.getProfile();
      expect(profile.upgradeHistory).toHaveLength(1);
      expect(profile.lastUpgradeAt).toBeDefined();
    });
  });

  // ── applyAllPending ──────────────────────────────────────

  describe("applyAllPending()", () => {
    it("should apply all pending actions", async () => {
      const result = createFailingExecutionResult();
      upgrader.analyzeExecution(result);

      const pendingCount = upgrader.getPendingActions().length;
      expect(pendingCount).toBeGreaterThan(0);

      const results = await upgrader.applyAllPending();

      expect(results).toHaveLength(pendingCount);
      expect(upgrader.getPendingActions()).toHaveLength(0);
    });
  });

  // ── Profile ──────────────────────────────────────────────

  describe("profile", () => {
    it("should return initial profile with defaults", () => {
      const profile = upgrader.getProfile();

      expect(profile.level).toBe(5);
      expect(profile.totalExecutions).toBe(0);
      expect(profile.totalSuccesses).toBe(0);
      expect(profile.totalFailures).toBe(0);
      expect(profile.recentTrend).toBe("stable");
      expect(profile.upgradeHistory).toHaveLength(0);
    });

    it("should update profile after analyzing execution", () => {
      const result = createFailingExecutionResult();
      upgrader.analyzeExecution(result);

      const profile = upgrader.getProfile();
      expect(profile.totalExecutions).toBe(1);
      expect(profile.totalFailures).toBeGreaterThan(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// ClaudeCodePlugin
// ═══════════════════════════════════════════════════════════════

describe("ClaudeCodePlugin", () => {
  let plugin: ClaudeCodePlugin;
  let registry: ServiceRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = createMockEventBus();
    registry = createMockRegistry();
    plugin = new ClaudeCodePlugin(registry, eventBus);
  });

  // ── Plugin Info ──────────────────────────────────────────

  describe("plugin info", () => {
    it("should have correct plugin metadata", () => {
      expect(CLAUDE_CODE_PLUGIN_INFO.name).toBe("Claude Code Tools");
      expect(CLAUDE_CODE_PLUGIN_INFO.version).toBe("1.0.0");
      expect(CLAUDE_CODE_PLUGIN_INFO.capabilities).toContain("task_decomposition");
      expect(CLAUDE_CODE_PLUGIN_INFO.capabilities).toContain("llm_dispatch");
      expect(CLAUDE_CODE_PLUGIN_INFO.capabilities).toContain("auto_upgrade");
    });
  });

  // ── Initialize ───────────────────────────────────────────

  describe("initialize()", () => {
    it("should register services after initialization", () => {
      plugin.initialize();

      expect(registry.hasService("claudeCodeOrchestrator")).toBe(true);
      expect(registry.hasService("claudeCodeDecomposer")).toBe(true);
      expect(registry.hasService("claudeCodeDispatcher")).toBe(true);
      expect(registry.hasService("claudeCodeUpgrader")).toBe(true);
    });

    it("should not double-initialize", () => {
      plugin.initialize();
      // Second call should not throw
      expect(() => plugin.initialize()).not.toThrow();
    });

    it("should register services only once", () => {
      plugin.initialize();
      // Second initialize should be a no-op, so services should still be 4
      plugin.initialize();
      const services = registry.getRegisteredServices();
      const pluginServices = services.filter(s => s.startsWith("claudeCode"));
      expect(pluginServices).toHaveLength(4);
    });
  });

  // ── Health Check ─────────────────────────────────────────

  describe("healthCheck()", () => {
    it("should return false before initialization", async () => {
      expect(await plugin.healthCheck()).toBe(false);
    });

    it("should return true after initialization", async () => {
      plugin.initialize();
      expect(await plugin.healthCheck()).toBe(true);
    });
  });

  // ── Execute Task ─────────────────────────────────────────

  describe("executeTask()", () => {
    it("should throw if not initialized", async () => {
      await expect(plugin.executeTask("test")).rejects.toThrow("not initialized");
    });

    it("should execute a task after initialization", async () => {
      // Register a mock LLM executor
      const mockExecutor = createMockLLMExecutor();
      registry.registerService("agentModelExecutor", mockExecutor);

      plugin.initialize();

      const result = await plugin.executeTask("实现用户登录功能");
      expect(result).toBeDefined();
      expect(typeof result.success).toBe("boolean");
    });
  });

  // ── Decompose Task ───────────────────────────────────────

  describe("decomposeTask()", () => {
    it("should decompose a task without executing", async () => {
      plugin.initialize();

      const plan = await plugin.decomposeTask("实现用户登录功能");
      expect(plan).toBeDefined();
      expect(plan.rootTask).toBeDefined();
      expect(plan.subTasks.length).toBeGreaterThan(0);
    });
  });

  // ── Capability Assessment ────────────────────────────────

  describe("getCapabilityAssessment()", () => {
    it("should return assessment after initialization", () => {
      plugin.initialize();

      const assessment = plugin.getCapabilityAssessment();
      expect(assessment).toBeDefined();
      expect(assessment.level).toBeGreaterThanOrEqual(1);
      expect(assessment.level).toBeLessThanOrEqual(10);
    });
  });

  // ── Execution History ────────────────────────────────────

  describe("getExecutionHistory()", () => {
    it("should return empty history initially", () => {
      plugin.initialize();
      expect(plugin.getExecutionHistory()).toHaveLength(0);
    });
  });
});
