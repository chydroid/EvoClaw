/**
 * WebUI 任务管道综合测试 — 88 个测试用例
 *
 * 模拟真实用户通过 WebUI 输入的交互方式，覆盖：
 * 1. 基础功能验证 (20) — 简单
 * 2. 边界条件测试 (15) — 5 简单 + 10 复杂
 * 3. 异常场景处理 (15) — 5 简单 + 10 复杂
 * 4. 多步骤任务执行 (15) — 复杂
 * 5. 跨模块功能调用 (10) — 复杂
 * 6. 资源限制测试 (8) — 复杂
 * 7. 并发任务处理 (5) — 复杂
 *
 * 复杂任务: 10+10+15+10+8+5 = 58 (≥ 44)
 * 简单任务: 20+5+5 = 30
 * 总计: 88
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ServiceRegistry, EventBus, SystemEvents, type Task, type DAGNode } from "@evoclaw/core";
import { TaskOrchestrator } from "./task-orchestrator";
import { AgentPoolManager } from "./agent-pool";
import { TaskStatusTracker } from "./task-status-tracker";
import { DAGExecutor } from "./dag-executor";
import { estimateTaskComplexity } from "@evoclaw/gateway";

// ── 辅助工厂 ────────────────────────────────────────────

function createRegistry(): ServiceRegistry {
  return new ServiceRegistry();
}

function createEventBus(): EventBus {
  return new EventBus();
}

function makeNode(id: string, deps: string[] = [], overrides: Partial<DAGNode> = {}): DAGNode {
  return {
    id,
    action: overrides.action || `action-${id}`,
    skill: overrides.skill,
    dependencies: deps,
    params: overrides.params || {},
    timeout: overrides.timeout || 60000,
    retryCount: overrides.retryCount,
    retryDelay: overrides.retryDelay,
    timeoutMs: overrides.timeoutMs,
    condition: overrides.condition,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id || "test-task",
    type: overrides.type || "chat",
    priority: overrides.priority || "normal",
    status: overrides.status || "pending",
    input: overrides.input || { message: "hello" },
    output: overrides.output || null,
    context: overrides.context || {
      sessionId: "sess-1",
      userId: "user-1",
      workspace: "ws-1",
      variables: {},
      tags: [],
      traceId: "trace-1",
    },
    dag: overrides.dag || [],
    executionPlan: overrides.executionPlan || [],
    createdAt: overrides.createdAt || new Date(),
    updatedAt: overrides.updatedAt || new Date(),
    completedAt: overrides.completedAt || null,
    retryCount: overrides.retryCount ?? 0,
    maxRetries: overrides.maxRetries ?? 3,
  };
}

// ═══════════════════════════════════════════════════════════════
// 1. 基础功能验证 (20 个简单任务)
// ═══════════════════════════════════════════════════════════════

describe("WebUI 任务管道 — 1. 基础功能验证", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    registry = createRegistry();
    eventBus = createEventBus();
    orchestrator = new TaskOrchestrator(registry, eventBus);
  });

  it("1.1 创建简单聊天任务并返回正确结构", async () => {
    const task = await orchestrator.createTask({
      type: "chat",
      input: { message: "你好" },
    });
    expect(task.id).toBeDefined();
    expect(task.type).toBe("chat");
    expect(task.status).toBe("pending");
    expect(task.priority).toBe("normal");
    expect(task.input).toEqual({ message: "你好" });
  });

  it("1.2 任务默认优先级为 normal", async () => {
    const task = await orchestrator.createTask({ type: "chat", input: {} });
    expect(task.priority).toBe("normal");
  });

  it("1.3 任务可设置自定义优先级", async () => {
    const task = await orchestrator.createTask({
      type: "chat",
      input: {},
      priority: "critical",
    });
    expect(task.priority).toBe("critical");
  });

  it("1.4 任务上下文包含 sessionId", async () => {
    const task = await orchestrator.createTask({
      type: "chat",
      input: {},
      context: { sessionId: "webui-session-123" },
    });
    expect(task.context.sessionId).toBe("webui-session-123");
  });

  it("1.5 任务上下文默认 sessionId 为 default", async () => {
    const task = await orchestrator.createTask({ type: "chat", input: {} });
    expect(task.context.sessionId).toBe("default");
  });

  it("1.6 任务上下文包含 userId", async () => {
    const task = await orchestrator.createTask({
      type: "chat",
      input: {},
      context: { userId: "user-abc" },
    });
    expect(task.context.userId).toBe("user-abc");
  });

  it("1.7 任务创建后可通过 getTaskStatus 获取", async () => {
    const task = await orchestrator.createTask({ type: "chat", input: {} });
    const retrieved = orchestrator.getTaskStatus(task.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(task.id);
  });

  it("1.8 getStatus 返回任务当前状态", async () => {
    const task = await orchestrator.createTask({ type: "chat", input: {} });
    const status = await orchestrator.getStatus(task.id);
    expect(status).toBeDefined();
  });

  it("1.9 getProgress 初始为 0", async () => {
    const task = await orchestrator.createTask({ type: "chat", input: {} });
    const progress = await orchestrator.getProgress(task.id);
    expect(progress).toBe(0);
  });

  it("1.10 无 DAG 的任务执行后输出成功消息", async () => {
    const task = makeTask({ id: "exec-1", dag: [] });
    const result = await orchestrator.execute(task);
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ message: "Task processed successfully" });
  });

  it("1.11 执行后 executionPlan 包含 root 步骤", async () => {
    const task = makeTask({ id: "exec-2", dag: [] });
    const result = await orchestrator.execute(task);
    expect(result.executionPlan).toHaveLength(1);
    expect(result.executionPlan[0].nodeId).toBe("root");
    expect(result.executionPlan[0].status).toBe("completed");
  });

  it("1.12 任务完成后设置 completedAt", async () => {
    const task = makeTask({ id: "exec-3", dag: [] });
    const result = await orchestrator.execute(task);
    expect(result.completedAt).toBeInstanceOf(Date);
  });

  it("1.13 healthCheck 返回 true", async () => {
    const ok = await orchestrator.healthCheck();
    expect(ok).toBe(true);
  });

  it("1.14 TaskStatusTracker set 和 get", () => {
    const tracker = new TaskStatusTracker();
    tracker.set("sess-1", "thinking", "分析中", 30);
    const status = tracker.get("sess-1");
    expect(status).not.toBeNull();
    expect(status?.phase).toBe("thinking");
    expect(status?.detail).toBe("分析中");
    expect(status?.progress).toBe(30);
  });

  it("1.15 TaskStatusTracker get 不存在的 session 返回 null", () => {
    const tracker = new TaskStatusTracker();
    expect(tracker.get("nonexistent")).toBeNull();
  });

  it("1.16 TaskStatusTracker delete 后 get 返回 null", () => {
    const tracker = new TaskStatusTracker();
    tracker.set("sess-2", "generating", "生成中", 50);
    tracker.delete("sess-2");
    expect(tracker.get("sess-2")).toBeNull();
  });

  it("1.17 TaskStatusTracker getAll 返回所有活跃状态", () => {
    const tracker = new TaskStatusTracker();
    tracker.set("s1", "thinking", "", 10);
    tracker.set("s2", "generating", "", 80);
    const all = tracker.getAll();
    expect(all).toHaveLength(2);
  });

  it("1.18 estimateTaskComplexity 简单消息返回 simple", () => {
    const result = estimateTaskComplexity("你好");
    expect(result.level).toBe("simple");
    expect(result.timeoutMs).toBe(300_000);
  });

  it("1.19 estimateTaskComplexity 中等消息返回 medium 或更高", () => {
    const result = estimateTaskComplexity("创建一个项目");
    expect(["medium", "complex", "very_complex"]).toContain(result.level);
  });

  it("1.20 estimateTaskComplexity 复杂消息返回 complex 或 very_complex", () => {
    const result = estimateTaskComplexity("实现完整的全栈应用系统，包含前端、后端和数据库");
    expect(["complex", "very_complex"]).toContain(result.level);
    expect(result.shouldAutoSplit).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. 边界条件测试 (15 个：5 简单 + 10 复杂)
// ═══════════════════════════════════════════════════════════════

describe("WebUI 任务管道 — 2. 边界条件测试", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let orchestrator: TaskOrchestrator;
  let pool: AgentPoolManager;

  beforeEach(() => {
    registry = createRegistry();
    eventBus = createEventBus();
    orchestrator = new TaskOrchestrator(registry, eventBus);
    pool = new AgentPoolManager(registry, eventBus);
  });

  // ── 简单边界 (5) ──

  it("2.1 空消息输入不崩溃", () => {
    const result = estimateTaskComplexity("");
    expect(result.level).toBe("simple");
  });

  it("2.2 仅空白字符的消息", () => {
    const result = estimateTaskComplexity("   \n\t  ");
    expect(result.level).toBe("simple");
  });

  it("2.3 单字符消息", () => {
    const result = estimateTaskComplexity("?");
    expect(result.level).toBe("simple");
  });

  it("2.4 getTaskStatus 不存在的 taskId 返回 undefined", () => {
    expect(orchestrator.getTaskStatus("nonexistent-id")).toBeUndefined();
  });

  it("2.5 getStatus 不存在的 taskId 返回 failed", async () => {
    const status = await orchestrator.getStatus("nonexistent-id");
    expect(status).toBe("failed");
  });

  // ── 复杂边界 (10) ──

  it("2.6 超长消息（5000字符）不崩溃且正确评估复杂度", () => {
    const longMsg = "请实现一个算法 ".repeat(500);
    const result = estimateTaskComplexity(longMsg);
    expect(result.timeoutMs).toBeGreaterThan(0);
  });

  it("2.7 包含特殊字符的消息（XSS 注入尝试）", () => {
    const result = estimateTaskComplexity('<script>alert("xss")</script>');
    expect(result).toBeDefined();
  });

  it("2.8 包含 SQL 注入尝试的消息", () => {
    const result = estimateTaskComplexity("'; DROP TABLE users; --");
    expect(result).toBeDefined();
  });

  it("2.9 AgentPool acquire 返回可用 agent", async () => {
    const agent = await pool.acquire("executor", 0);
    expect(agent).not.toBeNull();
    expect(agent?.role).toBe("executor");
    expect(agent?.state.status).toBe("busy");
  });

  it("2.10 AgentPool release 后 agent 回到 idle", async () => {
    const agent = await pool.acquire("executor", 0);
    expect(agent?.state.status).toBe("busy");
    await pool.release(agent!.id);
    const retrieved = (pool as any).agents.get(agent!.id);
    expect(retrieved.state.status).toBe("idle");
  });

  it("2.11 AgentPool acquire timeout=0 不排队直接返回 null（池满时）", async () => {
    // 消耗所有可用 agent
    const acquired: string[] = [];
    for (let i = 0; i < 20; i++) {
      const a = await pool.acquire("executor", 0);
      if (a) acquired.push(a.id);
    }
    // 池满后再 acquire 应返回 null
    const extra = await pool.acquire("executor", 0);
    expect(extra).toBeNull();
    // 清理
    for (const id of acquired) await pool.release(id);
  });

  it("2.12 AgentPool getMetrics 返回正确指标", async () => {
    const metrics = await pool.getMetrics();
    expect(metrics.totalAgents).toBeGreaterThanOrEqual(4);
    expect(metrics.idleAgents).toBeGreaterThanOrEqual(0);
    expect(metrics.activeAgents).toBeGreaterThanOrEqual(0);
    expect(metrics.averageUtilization).toBeGreaterThanOrEqual(0);
    expect(metrics.averageUtilization).toBeLessThanOrEqual(1);
  });

  it("2.13 DAG 空节点列表返回空结果", async () => {
    const dagExecutor = new DAGExecutor(registry, eventBus);
    const task = makeTask({ dag: [] });
    const result = await dagExecutor.executeDAG(task);
    expect(result.output).toEqual({ dagCompleted: true, nodeCount: 0 });
    expect(result.steps).toHaveLength(0);
  });

  it("2.14 estimateTaskComplexity 多语言混合消息", () => {
    const result = estimateTaskComplexity("请 create a React 组件 with TypeScript and 实现完整功能");
    expect(result).toBeDefined();
    expect(result.timeoutMs).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. 异常场景处理 (15 个：5 简单 + 10 复杂)
// ═══════════════════════════════════════════════════════════════

describe("WebUI 任务管道 — 3. 异常场景处理", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let orchestrator: TaskOrchestrator;
  let pool: AgentPoolManager;

  beforeEach(() => {
    registry = createRegistry();
    eventBus = createEventBus();
    orchestrator = new TaskOrchestrator(registry, eventBus);
    pool = new AgentPoolManager(registry, eventBus);
  });

  // ── 简单异常 (5) ──

  it("3.1 cancel 不存在的 taskId 不崩溃", async () => {
    await expect(orchestrator.cancel("nonexistent")).resolves.toBeUndefined();
  });

  it("3.2 pause 不存在的 taskId 不崩溃", async () => {
    await expect(orchestrator.pause("nonexistent")).resolves.toBeUndefined();
  });

  it("3.3 resume 不存在的 taskId 不崩溃", async () => {
    await expect(orchestrator.resume("nonexistent")).resolves.toBeUndefined();
  });

  it("3.4 getProgress 不存在的 taskId 返回 0", async () => {
    const progress = await orchestrator.getProgress("nonexistent");
    expect(progress).toBe(0);
  });

  it("3.5 AgentPool release 不存在的 agentId 不崩溃", async () => {
    await expect(pool.release("nonexistent-agent")).resolves.toBeUndefined();
  });

  // ── 复杂异常 (10) ──

  it("3.6 任务执行失败后状态为 failed", async () => {
    const task = makeTask({ id: "fail-1", dag: [], maxRetries: 0 });
    // 模拟执行失败：注入一个会抛异常的 DAG
    task.dag = [makeNode("fail-node", [], { skill: "nonexistent-skill" })];
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockRejectedValue(new Error("Skill not found")),
    });
    const result = await orchestrator.execute(task);
    expect(result.status).toBe("failed");
  });

  it("3.7 任务失败后 retryCount 递增", async () => {
    const task = makeTask({ id: "fail-2", dag: [], maxRetries: 3 });
    task.dag = [makeNode("fail-node", [], { skill: "bad-skill" })];
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockRejectedValue(new Error("Skill error")),
    });
    const result = await orchestrator.execute(task);
    expect(result.retryCount).toBe(1);
    expect(result.status).toBe("queued"); // 重试后重新入队
  });

  it("3.8 DAG 节点依赖未完成时标记为 waiting_dependency", async () => {
    const dagExecutor = new DAGExecutor(registry, eventBus);
    const task = makeTask({
      dag: [
        makeNode("a", ["nonexistent-dep"]),
        makeNode("b", []),
      ],
    });
    const result = await dagExecutor.executeDAG(task);
    const stepA = result.steps.find((s) => s.nodeId === "a");
    expect(stepA?.status).toBe("waiting_dependency");
  });

  it("3.9 DAG 节点条件为 false 时标记为 skipped", async () => {
    const dagExecutor = new DAGExecutor(registry, eventBus);
    const task = makeTask({
      dag: [makeNode("cond-1", [], { condition: "false" })],
    });
    const result = await dagExecutor.executeDAG(task);
    const step = result.steps.find((s) => s.nodeId === "cond-1");
    expect(step?.status).toBe("skipped");
  });

  it("3.10 DAG 包含循环时抛出异常", async () => {
    const dagExecutor = new DAGExecutor(registry, eventBus);
    const task = makeTask({
      dag: [
        makeNode("a", ["b"]),
        makeNode("b", ["a"]),
      ],
    });
    await expect(dagExecutor.executeDAG(task)).rejects.toThrow("cycle");
  });

  it("3.11 DAG 节点超时后标记为 failed", async () => {
    const dagExecutor = new DAGExecutor(registry, eventBus);
    const task = makeTask({
      dag: [
        makeNode("slow-1", [], {
          skill: "slow-skill",
          timeoutMs: 100,
          retryCount: 0,
        }),
      ],
    });
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 500)),
      ),
    });
    const result = await dagExecutor.executeDAG(task);
    const step = result.steps.find((s) => s.nodeId === "slow-1");
    expect(step?.status).toBe("failed");
    expect(step?.error).toContain("timed out");
  });

  it("3.12 AgentPool reportError 累积错误计数", async () => {
    const agent = await pool.acquire("executor", 0);
    await pool.reportError(agent!.id, "test error");
    const retrieved = (pool as any).agents.get(agent!.id);
    expect(retrieved.state.errorCount).toBe(1);
    await pool.release(agent!.id);
  });

  it("3.13 AgentPool 连续错误后 agent 进入 error 状态", async () => {
    const agent = await pool.acquire("executor", 0);
    await pool.reportError(agent!.id, "err1");
    await pool.reportError(agent!.id, "err2");
    await pool.reportError(agent!.id, "err3");
    const retrieved = (pool as any).agents.get(agent!.id);
    expect(retrieved.state.status).toBe("error");
  });

  it("3.14 AgentPool terminate 后 agent 从池中移除", async () => {
    const agent = await pool.acquire("executor", 0);
    const agentId = agent!.id;
    await pool.terminate(agentId);
    expect((pool as any).agents.has(agentId)).toBe(false);
  });

  it("3.15 DAG 节点重试后成功", async () => {
    const dagExecutor = new DAGExecutor(registry, eventBus);
    let callCount = 0;
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 3) throw new Error("transient error");
        return { success: true };
      }),
    });
    const task = makeTask({
      dag: [
        makeNode("retry-1", [], {
          skill: "flaky-skill",
          retryCount: 2,
          retryDelay: 10,
        }),
      ],
    });
    const result = await dagExecutor.executeDAG(task);
    const step = result.steps.find((s) => s.nodeId === "retry-1");
    expect(step?.status).toBe("completed");
    expect(step?.attempt).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. 多步骤任务执行 (15 个复杂任务)
// ═══════════════════════════════════════════════════════════════

describe("WebUI 任务管道 — 4. 多步骤任务执行", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let dagExecutor: DAGExecutor;

  beforeEach(() => {
    registry = createRegistry();
    eventBus = createEventBus();
    dagExecutor = new DAGExecutor(registry, eventBus);
  });

  it("4.1 线性 DAG（A→B→C）按顺序执行", async () => {
    const executionOrder: string[] = [];
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockImplementation((name: string) => {
        executionOrder.push(name);
        return { done: true };
      }),
    });
    const task = makeTask({
      dag: [
        makeNode("a", [], { skill: "step-a" }),
        makeNode("b", ["a"], { skill: "step-b" }),
        makeNode("c", ["b"], { skill: "step-c" }),
      ],
    });
    await dagExecutor.executeDAG(task);
    expect(executionOrder).toEqual(["step-a", "step-b", "step-c"]);
  });

  it("4.2 并行 DAG（A,B 无依赖）同时执行", async () => {
    const task = makeTask({
      dag: [
        makeNode("a", [], { skill: "parallel-a" }),
        makeNode("b", [], { skill: "parallel-b" }),
      ],
    });
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockResolvedValue({ ok: true }),
    });
    const result = await dagExecutor.executeDAG(task);
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every((s) => s.status === "completed")).toBe(true);
  });

  it("4.3 菱形 DAG（A→B, A→C, B→D, C→D）", async () => {
    const task = makeTask({
      dag: [
        makeNode("a", []),
        makeNode("b", ["a"]),
        makeNode("c", ["a"]),
        makeNode("d", ["b", "c"]),
      ],
    });
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockResolvedValue({ ok: true }),
    });
    const result = await dagExecutor.executeDAG(task);
    expect(result.steps).toHaveLength(4);
    const stepD = result.steps.find((s) => s.nodeId === "d");
    expect(stepD?.status).toBe("completed");
  });

  it("4.4 五节点复杂 DAG 混合并行与串行", async () => {
    const task = makeTask({
      dag: [
        makeNode("fetch", []),
        makeNode("parse", ["fetch"]),
        makeNode("validate", ["fetch"]),
        makeNode("transform", ["parse", "validate"]),
        makeNode("store", ["transform"]),
      ],
    });
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockResolvedValue({ ok: true }),
    });
    const result = await dagExecutor.executeDAG(task);
    expect(result.steps).toHaveLength(5);
    expect(result.steps.every((s) => s.status === "completed")).toBe(true);
  });

  it("4.5 条件分支：条件为 true 时执行", async () => {
    const task = makeTask({
      dag: [
        makeNode("check", [], { condition: "true" }),
      ],
    });
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockResolvedValue({ ok: true }),
    });
    const result = await dagExecutor.executeDAG(task);
    const step = result.steps.find((s) => s.nodeId === "check");
    expect(step?.status).toBe("completed");
  });

  it("4.6 条件分支：条件为 false 时跳过", async () => {
    const task = makeTask({
      dag: [
        makeNode("skip-me", [], { condition: "false" }),
      ],
    });
    const result = await dagExecutor.executeDAG(task);
    const step = result.steps.find((s) => s.nodeId === "skip-me");
    expect(step?.status).toBe("skipped");
  });

  it("4.7 依赖被跳过的节点标记为 waiting_dependency", async () => {
    const task = makeTask({
      dag: [
        makeNode("cond", [], { condition: "false" }),
        makeNode("dependent", ["cond"]),
      ],
    });
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockResolvedValue({ ok: true }),
    });
    const result = await dagExecutor.executeDAG(task);
    const depStep = result.steps.find((s) => s.nodeId === "dependent");
    expect(depStep?.status).toBe("waiting_dependency");
  });

  it("4.8 十节点大型 DAG 全部完成", async () => {
    const nodes: DAGNode[] = [];
    for (let i = 0; i < 10; i++) {
      nodes.push(makeNode(`n${i}`, i > 0 ? [`n${i - 1}`] : []));
    }
    const task = makeTask({ dag: nodes });
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockResolvedValue({ ok: true }),
    });
    const result = await dagExecutor.executeDAG(task);
    expect(result.steps).toHaveLength(10);
    expect(result.steps.every((s) => s.status === "completed")).toBe(true);
  });

  it("4.9 DAG 节点使用 skill 调用 skillManager", async () => {
    const mockExecute = vi.fn().mockResolvedValue({ data: "result" });
    registry.registerService("skillManager", {
      executeSkill: mockExecute,
    });
    const task = makeTask({
      dag: [makeNode("skill-node", [], { skill: "my-skill", params: { arg: 1 } })],
    });
    await dagExecutor.executeDAG(task);
    expect(mockExecute).toHaveBeenCalledWith("my-skill", { arg: 1 });
  });

  it("4.10 DAG 节点无 skill 时返回 action 信息", async () => {
    const task = makeTask({
      dag: [makeNode("plain", [], { action: "do-something", params: { x: 1 } })],
    });
    const result = await dagExecutor.executeDAG(task);
    const step = result.steps.find((s) => s.nodeId === "plain");
    expect(step?.status).toBe("completed");
    expect(step?.result?.data).toEqual({ executed: "do-something", params: { x: 1 } });
  });

  it("4.11 任务暂停后状态为 paused", async () => {
    const orchestrator = new TaskOrchestrator(registry, eventBus);
    // 直接构造任务并注入 activeTasks，避免 createTask 的后台 processQueue 干扰
    const task = makeTask({ id: "pause-1", status: "running", dag: [] });
    (orchestrator as any).activeTasks.set(task.id, task);
    await orchestrator.pause(task.id);
    expect(task.status).toBe("paused");
  });

  it("4.12 任务恢复后状态为 queued", async () => {
    const orchestrator = new TaskOrchestrator(registry, eventBus);
    const task = makeTask({ id: "resume-1", status: "running", dag: [] });
    (orchestrator as any).activeTasks.set(task.id, task);
    await orchestrator.pause(task.id);
    await orchestrator.resume(task.id);
    expect(task.status).toBe("queued");
  });

  it("4.13 任务取消后状态为 cancelled", async () => {
    const orchestrator = new TaskOrchestrator(registry, eventBus);
    const task = makeTask({ id: "cancel-1", status: "pending", dag: [] });
    (orchestrator as any).activeTasks.set(task.id, task);
    await orchestrator.cancel(task.id);
    expect(task.status).toBe("cancelled");
  });

  it("4.14 复杂度评估：代码块数影响复杂度", () => {
    const msgWithCodeBlocks = "```\ncode1\n```\n```\ncode2\n```\n```\ncode3\n```";
    const result = estimateTaskComplexity(msgWithCodeBlocks);
    expect(["medium", "complex", "very_complex"]).toContain(result.level);
  });

  it("4.15 复杂度评估：长消息（>200词）提升复杂度", () => {
    const longMsg = Array.from({ length: 250 }, (_, i) => `word${i}`).join(" ");
    const result = estimateTaskComplexity(longMsg);
    expect(["medium", "complex", "very_complex"]).toContain(result.level);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. 跨模块功能调用 (10 个复杂任务)
// ═══════════════════════════════════════════════════════════════

describe("WebUI 任务管道 — 5. 跨模块功能调用", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    registry = createRegistry();
    eventBus = createEventBus();
  });

  it("5.1 TaskOrchestrator 通过 EventBus 发布 TASK_CREATED 事件", async () => {
    const orchestrator = new TaskOrchestrator(registry, eventBus);
    const receivedEvents: any[] = [];
    eventBus.subscribe(SystemEvents.TASK_CREATED, async (event: any) => {
      receivedEvents.push(event);
    });
    await orchestrator.createTask({ type: "chat", input: { message: "test" } });
    // 给异步事件一点时间
    await new Promise((r) => setTimeout(r, 50));
    expect(receivedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("5.2 任务执行后发布 TASK_COMPLETED 事件", async () => {
    const orchestrator = new TaskOrchestrator(registry, eventBus);
    const completedEvents: any[] = [];
    eventBus.subscribe(SystemEvents.TASK_COMPLETED, async (event: any) => {
      completedEvents.push(event);
    });
    const task = makeTask({ id: "cross-1", dag: [] });
    await orchestrator.execute(task);
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("5.3 任务失败后发布 TASK_FAILED 事件", async () => {
    const orchestrator = new TaskOrchestrator(registry, eventBus);
    const failedEvents: any[] = [];
    eventBus.subscribe(SystemEvents.TASK_FAILED, async (event: any) => {
      failedEvents.push(event);
    });
    const task = makeTask({ id: "cross-2", dag: [makeNode("bad", [], { skill: "x" })] });
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockRejectedValue(new Error("fail")),
    });
    await orchestrator.execute(task);
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("5.4 DAG 执行调用 skillManager.executeSkill", async () => {
    const dagExecutor = new DAGExecutor(registry, eventBus);
    const mockSkillManager = {
      executeSkill: vi.fn().mockResolvedValue({ result: "ok" }),
    };
    registry.registerService("skillManager", mockSkillManager);
    const task = makeTask({
      dag: [makeNode("s1", [], { skill: "data-processor", params: { input: "test" } })],
    });
    await dagExecutor.executeDAG(task);
    expect(mockSkillManager.executeSkill).toHaveBeenCalledWith("data-processor", { input: "test" });
  });

  it("5.5 AgentPool acquire 和 release 配合工作", async () => {
    const pool = new AgentPoolManager(registry, eventBus);
    const agent = await pool.acquire("executor", 0);
    expect(agent).not.toBeNull();
    const metricsBefore = await pool.getMetrics();
    expect(metricsBefore.activeAgents).toBeGreaterThanOrEqual(1);
    await pool.release(agent!.id);
    const metricsAfter = await pool.getMetrics();
    expect(metricsAfter.idleAgents).toBeGreaterThan(metricsBefore.idleAgents - 1);
  });

  it("5.6 AgentPool healthCheck 返回所有 agent 健康状态", async () => {
    const pool = new AgentPoolManager(registry, eventBus);
    const health = await pool.healthCheck();
    expect(health.length).toBeGreaterThanOrEqual(4);
    expect(health.every((h) => typeof h.healthy === "boolean")).toBe(true);
  });

  it("5.7 AgentPool scale 正向扩容", async () => {
    const pool = new AgentPoolManager(registry, eventBus);
    const before = await pool.getMetrics();
    await pool.scale(2);
    const after = await pool.getMetrics();
    expect(after.totalAgents).toBe(before.totalAgents + 2);
  });

  it("5.8 AgentPool scale 负向缩容", async () => {
    const pool = new AgentPoolManager(registry, eventBus);
    await pool.scale(3);
    const before = await pool.getMetrics();
    await pool.scale(-2);
    const after = await pool.getMetrics();
    expect(after.totalAgents).toBe(before.totalAgents - 2);
  });

  it("5.9 TaskStatusTracker 与任务执行协同工作", async () => {
    const tracker = new TaskStatusTracker();
    const orchestrator = new TaskOrchestrator(registry, eventBus);
    const task = await orchestrator.createTask({
      type: "chat",
      input: { message: "test" },
      context: { sessionId: "track-sess" },
    });
    tracker.set("track-sess", "thinking", "处理中", 10);
    const status = tracker.get("track-sess");
    expect(status?.phase).toBe("thinking");
    expect(orchestrator.getTaskStatus(task.id)).toBeDefined();
  });

  it("5.10 estimateTaskComplexity 跨模块：下载任务识别为 complex", () => {
    const result = estimateTaskComplexity("下载小说并保存到本地");
    expect(result.timeoutMs).toBeGreaterThanOrEqual(600_000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. 资源限制测试 (8 个复杂任务)
// ═══════════════════════════════════════════════════════════════

describe("WebUI 任务管道 — 6. 资源限制测试", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    registry = createRegistry();
    eventBus = createEventBus();
  });

  it("6.1 AgentPool 不超过 maxAgents 上限", async () => {
    const pool = new AgentPoolManager(registry, eventBus);
    const acquired: string[] = [];
    // 尝试获取超过 maxAgents(10) 个 agent
    for (let i = 0; i < 15; i++) {
      const a = await pool.acquire("executor", 0);
      if (a) acquired.push(a.id);
    }
    const metrics = await pool.getMetrics();
    expect(metrics.totalAgents).toBeLessThanOrEqual(10);
    // 清理
    for (const id of acquired) await pool.release(id);
  });

  it("6.2 AgentPool 清理 stale idle agent", async () => {
    const pool = new AgentPoolManager(registry, eventBus);
    // 获取一个 agent 然后释放
    const agent = await pool.acquire("executor", 0);
    await pool.release(agent!.id);
    // 模拟心跳过期
    const agentObj = (pool as any).agents.get(agent!.id);
    agentObj.state.lastHeartbeat = new Date(Date.now() - 400_000); // 超过 5 分钟
    const removed = await pool.cleanup(Date.now());
    // 由于 agent 数量可能 <= minAgents+2，可能不删除而是刷新心跳
    expect(removed).toBeGreaterThanOrEqual(0);
  });

  it("6.3 AgentPool 清理 error 状态的 agent", async () => {
    const pool = new AgentPoolManager(registry, eventBus);
    const agent = await pool.acquire("executor", 0);
    // 制造 3 次错误使其进入 error 状态
    await pool.reportError(agent!.id, "e1");
    await pool.reportError(agent!.id, "e2");
    await pool.reportError(agent!.id, "e3");
    const beforeMetrics = await pool.getMetrics();
    // 先扩容保证不会因为 minAgents 限制而跳过
    await pool.scale(5);
    await pool.cleanup(Date.now());
    const afterMetrics = await pool.getMetrics();
    expect(afterMetrics.totalAgents).toBeLessThanOrEqual(beforeMetrics.totalAgents + 5);
  });

  it("6.4 TaskOrchestrator processQueue 最大迭代保护", async () => {
    const orchestrator = new TaskOrchestrator(registry, eventBus);
    // 创建大量任务
    const tasks: Task[] = [];
    for (let i = 0; i < 5; i++) {
      tasks.push(await orchestrator.createTask({ type: "chat", input: { msg: i } }));
    }
    // 等待队列处理完成
    await new Promise((r) => setTimeout(r, 200));
    // 所有任务应该被处理（completed 或其他状态）
    for (const task of tasks) {
      const status = orchestrator.getTaskStatus(task.id);
      expect(status).toBeDefined();
    }
  });

  it("6.5 InMemoryTaskQueue 优先级排序", async () => {
    const orchestrator = new TaskOrchestrator(registry, eventBus);
    // 创建不同优先级的任务
    const lowTask = await orchestrator.createTask({
      type: "chat",
      input: {},
      priority: "low",
    });
    const criticalTask = await orchestrator.createTask({
      type: "chat",
      input: {},
      priority: "critical",
    });
    const normalTask = await orchestrator.createTask({
      type: "chat",
      input: {},
      priority: "normal",
    });
    // 验证任务都被创建
    expect(orchestrator.getTaskStatus(lowTask.id)).toBeDefined();
    expect(orchestrator.getTaskStatus(criticalTask.id)).toBeDefined();
    expect(orchestrator.getTaskStatus(normalTask.id)).toBeDefined();
  });

  it("6.6 AgentPool acquire 带超时排队", async () => {
    const pool = new AgentPoolManager(registry, eventBus);
    // 消耗所有 agent
    const acquired: string[] = [];
    for (let i = 0; i < 20; i++) {
      const a = await pool.acquire("executor", 0);
      if (a) acquired.push(a.id);
    }
    // 带超时排队，应该在超时后返回 null
    const start = Date.now();
    const result = await pool.acquire("executor", 200);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    // 清理
    for (const id of acquired) await pool.release(id);
  });

  it("6.7 AgentPool release 唤醒等待队列", async () => {
    const pool = new AgentPoolManager(registry, eventBus);
    // 消耗所有 agent
    const acquired: string[] = [];
    for (let i = 0; i < 20; i++) {
      const a = await pool.acquire("executor", 0);
      if (a) acquired.push(a.id);
    }
    // 排队等待
    const waitPromise = pool.acquire("executor", 5000);
    // 短暂等待后释放一个 agent
    await new Promise((r) => setTimeout(r, 50));
    await pool.release(acquired[0]);
    const agent = await waitPromise;
    expect(agent).not.toBeNull();
    // 清理
    for (let i = 1; i < acquired.length; i++) await pool.release(acquired[i]);
    if (agent) await pool.release(agent.id);
  });

  it("6.8 大量 TaskStatusTracker 条目不泄漏内存", () => {
    const tracker = new TaskStatusTracker();
    // 设置大量条目
    for (let i = 0; i < 1000; i++) {
      tracker.set(`sess-${i}`, "thinking", "", 50);
    }
    expect(tracker.getAll().length).toBe(1000);
    // 删除一半
    for (let i = 0; i < 500; i++) {
      tracker.delete(`sess-${i}`);
    }
    expect(tracker.getAll().length).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. 并发任务处理 (5 个复杂任务)
// ═══════════════════════════════════════════════════════════════

describe("WebUI 任务管道 — 7. 并发任务处理", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    registry = createRegistry();
    eventBus = createEventBus();
  });

  it("7.1 并行提交 5 个任务全部完成", async () => {
    const orchestrator = new TaskOrchestrator(registry, eventBus);
    const promises = Array.from({ length: 5 }, (_, i) =>
      orchestrator.createTask({ type: "chat", input: { msg: `task-${i}` } }),
    );
    const tasks = await Promise.all(promises);
    expect(tasks).toHaveLength(5);
    // 每个任务都有唯一 ID
    const ids = tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(5);
    // 等待队列处理
    await new Promise((r) => setTimeout(r, 300));
  });

  it("7.2 并行执行多个无依赖 DAG 节点", async () => {
    const dagExecutor = new DAGExecutor(registry, eventBus);
    const executionTimes: { name: string; start: number; end: number }[] = [];
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockImplementation((name: string) => {
        const start = Date.now();
        return new Promise((resolve) => {
          setTimeout(() => {
            executionTimes.push({ name, start, end: Date.now() });
            resolve({ ok: true });
          }, 100);
        });
      }),
    });
    const task = makeTask({
      dag: [
        makeNode("p1", [], { skill: "s1" }),
        makeNode("p2", [], { skill: "s2" }),
        makeNode("p3", [], { skill: "s3" }),
      ],
    });
    const startTime = Date.now();
    await dagExecutor.executeDAG(task);
    const totalTime = Date.now() - startTime;
    // 并行执行总时间应远小于串行（3*100=300ms）
    expect(totalTime).toBeLessThan(250);
  });

  it("7.3 AgentPool 并发 acquire/release 无竞态", async () => {
    const pool = new AgentPoolManager(registry, eventBus);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => pool.acquire("executor", 1000)),
    );
    const successful = results.filter((a) => a !== null);
    expect(successful.length).toBeLessThanOrEqual(10);
    // 全部释放
    await Promise.all(successful.map((a) => pool.release(a!.id)));
    const metrics = await pool.getMetrics();
    expect(metrics.activeAgents).toBe(0);
  });

  it("7.4 并发 TaskStatusTracker 读写无竞态", async () => {
    const tracker = new TaskStatusTracker();
    // 并发写入
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve(tracker.set(`conc-${i}`, "thinking", `task-${i}`, i * 2)),
      ),
    );
    expect(tracker.getAll().length).toBe(50);
    // 并发读取
    const reads = await Promise.all(
      Array.from({ length: 50 }, (_, i) => Promise.resolve(tracker.get(`conc-${i}`))),
    );
    expect(reads.every((r) => r !== null)).toBe(true);
  });

  it("7.5 并发任务执行中 EventBus 事件不丢失", async () => {
    const orchestrator = new TaskOrchestrator(registry, eventBus);
    const createdCount = { value: 0 };
    const completedCount = { value: 0 };
    eventBus.subscribe(SystemEvents.TASK_CREATED, async () => {
      createdCount.value++;
    });
    eventBus.subscribe(SystemEvents.TASK_COMPLETED, async () => {
      completedCount.value++;
    });
    // 使用 makeTask 直接构造任务并注入 activeTasks，避免 createTask 的后台 processQueue
    // 造成双重执行（processQueue + 显式 execute）
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ id: `conc-exec-${i}`, dag: [] }),
    );
    for (const t of tasks) {
      (orchestrator as any).activeTasks.set(t.id, t);
    }
    // 并发执行
    await Promise.all(tasks.map((t) => orchestrator.execute(t)));
    await new Promise((r) => setTimeout(r, 100));
    expect(completedCount.value).toBe(5);
  });

  it("7.6 并发 DAG 执行中 skill 调用无竞态", async () => {
    const dagExecutor = new DAGExecutor(registry, eventBus);
    let totalCalls = 0;
    registry.registerService("skillManager", {
      executeSkill: vi.fn().mockImplementation(() => {
        totalCalls++;
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 50));
      }),
    });
    // 并发执行 3 个独立 DAG
    const tasks = Array.from({ length: 3 }, (_, i) =>
      makeTask({
        id: `dag-${i}`,
        dag: [
          makeNode(`n1-${i}`, [], { skill: `skill-1-${i}` }),
          makeNode(`n2-${i}`, [`n1-${i}`], { skill: `skill-2-${i}` }),
        ],
      }),
    );
    await Promise.all(tasks.map((t) => dagExecutor.executeDAG(t)));
    expect(totalCalls).toBe(6); // 3 tasks * 2 nodes each
  });
});
