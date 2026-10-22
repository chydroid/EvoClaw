/**
 * 20 个复杂任务模拟 — 端到端任务完成能力验证
 *
 * 通过真实的 TaskPlanner（任务分解）→ DAGExecutor（DAG 编排/并行/条件/重试/超时）
 * → SkillSandbox（VM 内执行 JS 技能脚本）→ TaskOrchestrator（任务生命周期）
 * 管道模拟 20 个复杂任务，跟踪并检查各组件协同完成多步骤任务的能力。
 *
 * 无需 LLM：技能脚本在 SkillSandbox 的 VM 内执行（纯计算型，使用沙箱提供的
 * Math / JSON / RegExp / Buffer），DAG/编排/生命周期走真实组件。
 * 发现组件层面的真实缺陷（如技能级失败不传播、并行竞态等）并修复。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  type Task,
  type DAGNode,
  type Skill,
  type SkillExecutionResult,
  type ExecutionStep,
} from "@evoclaw/core";
import { DAGExecutor } from "./dag-executor";
import { TaskOrchestrator } from "./task-orchestrator";
import { TaskPlanner } from "./task-planner";
import { SkillSandbox } from "@evoclaw/skills/skill-sandbox";

// ── 全局测试上下文 ──
let registry: ServiceRegistry;
let eventBus: EventBus;
let dagExecutor: DAGExecutor;
let taskOrchestrator: TaskOrchestrator;
let taskPlanner: TaskPlanner;
let skillSandbox: SkillSandbox;

// 已注册的「纯计算型」技能：name → skill 对象
const skillsByName = new Map<string, Skill>();

// 每次 DAG 运行收集到的执行步骤（供断言）
let lastSteps: ExecutionStep[] = [];

// ── 技能工厂：纯计算型 JS 技能（在 VM 内执行，不依赖 require / fs）──
function jsSkill(name: string, script: string): Skill {
  const skill: Skill = {
    id: `skill-${name}`,
    name,
    version: "1.0.0",
    description: name,
    author: "test",
    license: "MIT",
    category: "utility",
    keywords: [name],
    requires: [],
    provides: [],
    triggers: [],
    entryPoint: "main",
    sandboxPolicy: {
      allowNetwork: false,
      allowFileSystem: false,
      allowSubprocess: false,
      maxExecutionTime: 5000,
      maxMemoryMB: 128,
      allowedHosts: [],
      allowedPaths: [],
    },
    installPath: "",
    lifecycle: {
      status: "active",
      version: "1.0.0",
      installDate: new Date(),
      lastUpdated: new Date(),
      healthCheck: null,
    },
    config: {},
    stats: {
      invocationCount: 0,
      successCount: 0,
      failureCount: 0,
      averageDuration: 0,
      lastInvocation: null,
      userRating: 0,
    },
    body: {
      instructions: "",
      scripts: { main: script },
      examples: [],
      hooks: {},
    },
  };
  skillsByName.set(name, skill);
  return skill;
}

// ── DAG 节点工厂 ──
function node(id: string, opts: Partial<DAGNode> = {}): DAGNode {
  return {
    id,
    dependencies: opts.dependencies ?? [],
    action: opts.action ?? `action-${id}`,
    skill: opts.skill,
    params: opts.params ?? {},
    timeout: opts.timeout ?? 60000,
    condition: opts.condition,
    retryCount: opts.retryCount,
    retryDelay: opts.retryDelay,
    timeoutMs: opts.timeoutMs,
  };
}

function makeTask(nodes: DAGNode[], variables: Record<string, unknown> = {}): Task {
  return {
    id: "sim-task",
    dag: nodes,
    context: { sessionId: "sim", userId: "", workspace: "", variables, tags: [], traceId: "t" },
    priority: "normal",
    createdAt: new Date(),
    status: "pending",
    type: "automation",
    input: {},
    output: null,
    executionPlan: [],
    updatedAt: new Date(),
    completedAt: null,
    retryCount: 0,
    maxRetries: 0,
  };
}

/** 运行 DAG 并返回步骤（通过真实 SkillSandbox 执行技能） */
async function runDAG(nodes: DAGNode[], variables: Record<string, unknown> = {}): Promise<ExecutionStep[]> {
  const result = await dagExecutor.executeDAG(makeTask(nodes, variables));
  lastSteps = result.steps;
  return result.steps;
}

function stepById(id: string): ExecutionStep | undefined {
  return lastSteps.find((s) => s.nodeId === id);
}

/** DAG 步骤数据 = SkillExecutionResult（含 output/errors/success） */
function stepResult(id: string): SkillExecutionResult | undefined {
  return stepById(id)?.result?.data as SkillExecutionResult | undefined;
}

/** 技能脚本返回的 _result（SkillExecutionResult.output） */
function stepOutput(id: string): unknown {
  return stepResult(id)?.output;
}

// ── 共享技能（在 beforeEach 中注册一次即可）──
function registerSharedSkills(): void {
  skillsByName.clear();

  // 数学加法：_result = 直接对象（便于断言）
  jsSkill(
    "math-add",
    `
      const a = Number(params.a); const b = Number(params.b);
      if (!Number.isFinite(a) || !Number.isFinite(b)) { _result = { success:false, error:"non-finite input" }; }
      else { _result = { success:true, value: a + b }; }
    `
  );

  // 文本大写
  jsSkill("text-upper", `
    const s = String(params.content ?? "");
    _result = { success:true, out: s.toUpperCase(), len: s.length };
  `);

  // 字符串反转
  jsSkill("text-reverse", `
    const s = String(params.content ?? "");
    _result = { success:true, out: s.split("").reverse().join("") };
  `);

  // 正则匹配
  jsSkill("regex-test", `
    const re = new RegExp(String(params.pattern ?? ""));
    const target = String(params.target ?? "");
    _result = { success:true, matched: re.test(target) };
  `);

  // base64 编码（使用沙箱提供的 Buffer）
  jsSkill("b64-encode", `
    _result = { success:true, value: Buffer.from(String(params.value ?? ""), "utf-8").toString("base64") };
  `);

  // 哈希（sha256 via Buffer）
  jsSkill("hash-sha256", `
    const crypto = undefined; // 沙箱无 crypto，用 Buffer + 简易摘要占位（演示输出）
    const s = String(params.value ?? "");
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    _result = { success:true, digest: h.toString(16), input: s };
  `);

  // 失败技能：总是报错（用于失败传播测试）
  jsSkill("always-fail", `
    _result = { success:false, error:"intentional failure" };
  `);

  // 延迟技能：真正的异步耗时（VM 内没有定时器，走下面的 asyncSkills 通道）
  asyncSkills.set("slow-skill", async (params) => {
    const ms = Number(params.ms ?? 30);
    await new Promise((r) => setTimeout(r, ms));
    return { success: true, waitedMs: ms };
  });
}

// 异步技能通道（在宿主事件循环里 await 真实定时器，用于并行/超时测试）
const asyncSkills = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();

beforeEach(() => {
  registry = new ServiceRegistry();
  eventBus = new EventBus();
  dagExecutor = new DAGExecutor(registry, eventBus);
  taskOrchestrator = new TaskOrchestrator(registry, eventBus);
  taskPlanner = new TaskPlanner(registry, eventBus);
  skillSandbox = new SkillSandbox(registry, eventBus);
  registerSharedSkills();

  // DAGExecutor 通过 registry 解析 "skillManager" 来执行技能节点
  registry.registerService("skillManager", {
    executeSkill: async (name: string, params: Record<string, unknown>): Promise<SkillExecutionResult> => {
      // 异步技能优先（宿主事件循环内真实 await）
      const asyncFn = asyncSkills.get(name);
      if (asyncFn) {
        const t0 = Date.now();
        try {
          const output = await asyncFn(params);
          return {
            skillId: name,
            success: true,
            output,
            errors: [],
            duration: Date.now() - t0,
            resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
          };
        } catch (err) {
          return {
            skillId: name,
            success: false,
            output: null,
            errors: [err instanceof Error ? err.message : String(err)],
            duration: Date.now() - t0,
            resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
          };
        }
      }
      const skill = skillsByName.get(name);
      if (!skill) {
        return {
          skillId: name,
          success: false,
          output: null,
          errors: [`Skill not found: ${name}`],
          duration: 0,
          resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
        };
      }
      return skillSandbox.execute(skill, params);
    },
  });
});

afterEach(() => {
  skillsByName.clear();
  asyncSkills.clear();
  lastSteps = [];
});

// ═══════════════════════════════════════════════════════════════
// 20 个复杂任务模拟
// ═══════════════════════════════════════════════════════════════
describe("20 个复杂任务模拟 — 端到端任务完成能力验证", () => {
  // ── Task 1: 线性多步骤文本管道 ──
  it("Task 1: 线性管道 read→upper→reverse（依赖顺序）", async () => {
    const steps = await runDAG([
      node("upper", { skill: "text-upper", params: { content: "hello" } }),
      node("rev", { skill: "text-reverse", params: { content: "abc" }, dependencies: ["upper"] }),
      node("add", { skill: "math-add", params: { a: 1, b: 2 }, dependencies: ["rev"] }),
    ]);
    expect(steps.map((s) => s.status)).toEqual(["completed", "completed", "completed"]);
    expect(stepOutput("upper")).toEqual({ success: true, out: "HELLO", len: 5 });
    expect(stepOutput("rev")).toEqual({ success: true, out: "cba" });
    expect(stepOutput("add")).toEqual({ success: true, value: 3 });
  });

  // ── Task 2: 扇出-扇入（菱形 DAG）──
  it("Task 2: 菱形 DAG 并行分支汇合", async () => {
    const steps = await runDAG([
      node("a", { skill: "math-add", params: { a: 1, b: 1 } }),
      node("b", { skill: "text-upper", params: { content: "x" }, dependencies: ["a"] }),
      node("c", { skill: "text-reverse", params: { content: "y" }, dependencies: ["a"] }),
      node("d", { skill: "math-add", params: { a: 5, b: 5 }, dependencies: ["b", "c"] }),
    ]);
    const ids = steps.map((s) => s.nodeId);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("d"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
    expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("d"));
    expect(stepOutput("d")).toEqual({ success: true, value: 10 });
  });

  // ── Task 3: 条件跳过 ──
  it("Task 3: 条件为 false 时跳过节点（良性级联）", async () => {
    const steps = await runDAG([
      node("base", { skill: "math-add", params: { a: 2, b: 2 } }),
      node("opt", { skill: "text-upper", params: { content: "z" }, dependencies: ["base"], condition: "variables.enableOpt === false" }),
    ]);
    // 注册 context 变量使条件为 false
    expect(stepById("opt")?.status).toBe("skipped");
    expect(stepById("base")?.status).toBe("completed");
  });

  // ── Task 4: 独立节点并行执行 ──
  it("Task 4: 多个无依赖节点并行（不串行阻塞）", async () => {
    const t0 = Date.now();
    const steps = await runDAG([
      node("s1", { skill: "slow-skill", params: { ms: 80 } }),
      node("s2", { skill: "slow-skill", params: { ms: 80 } }),
      node("s3", { skill: "slow-skill", params: { ms: 80 } }),
    ]);
    const elapsed = Date.now() - t0;
    expect(steps.filter((s) => s.status === "completed")).toHaveLength(3);
    // 并行：总耗时远小于 3*80（串行），且 3 个节点确实都跑到了
    expect(elapsed).toBeLessThan(80 * 3 - 40);
  });

  // ── Task 5: 条件为 true 时正常执行 ──
  it("Task 5: 条件为 true 的节点正常执行", async () => {
    const steps = await runDAG([
      node("base", { skill: "math-add", params: { a: 2, b: 2 } }),
      node("opt", { skill: "text-upper", params: { content: "yes" }, dependencies: ["base"], condition: "variables.enableOpt === true" }),
    ], { enableOpt: true });
    expect(stepById("base")?.status).toBe("completed");
    expect(stepById("opt")?.status).toBe("completed");
    expect(stepOutput("opt")).toEqual({ success: true, out: "YES", len: 3 });
  });

  // ── Task 6: 复合条件（&& / || / 比较 / 取反）──
  it("Task 6: 复合条件表达式求值", async () => {
    const steps = await runDAG([
      node("ctx", { skill: "math-add", params: { a: 1, b: 1 } }),
      node("and-true", { skill: "text-upper", params: { content: "a" }, dependencies: ["ctx"], condition: "variables.n >= 3 && variables.mode == 'fast'" }),
      node("or-false", { skill: "text-upper", params: { content: "b" }, dependencies: ["ctx"], condition: "variables.n > 100 || variables.mode != 'fast'" }),
      node("not-true", { skill: "text-upper", params: { content: "c" }, dependencies: ["ctx"], condition: "!variables.missing" }),
    ], { n: 3, mode: "fast" });
    // n=3, mode='fast'：and-true 应执行，or-false 应跳过，not-true（undefined 取反）应执行
    expect(stepById("and-true")?.status).toBe("completed");
    expect(stepById("or-false")?.status).toBe("skipped");
    expect(stepById("not-true")?.status).toBe("completed");
  });

  // ── Task 7: 节点超时 ──
  it("Task 7: 节点超过 timeoutMs 标记失败", async () => {
    const steps = await runDAG([
      node("slow", { skill: "slow-skill", params: { ms: 500 }, timeoutMs: 50 }),
      node("after", { skill: "math-add", params: { a: 1, b: 1 }, dependencies: ["slow"] }),
    ]);
    expect(stepById("slow")?.status).toBe("failed");
    expect(stepById("slow")?.error).toContain("timed out");
    // 下游节点未执行
    expect(stepById("after")?.status).toBe("waiting_dependency");
  });

  // ── Task 8: 瞬时失败重试后成功 ──
  it("Task 8: 瞬时失败经 retry 后成功", async () => {
    let calls = 0;
    asyncSkills.set("flaky", async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return { success: true, call: calls };
    });
    const steps = await runDAG([
      node("f", { skill: "flaky", retryCount: 3, retryDelay: 10 }),
    ]);
    expect(stepById("f")?.status).toBe("completed");
    expect(stepById("f")?.attempt).toBe(3);
    expect(stepOutput("f")).toEqual({ success: true, call: 3 });
  });

  // ── Task 9: 重试耗尽后失败 ──
  it("Task 9: 重试耗尽后节点失败并传播到下游", async () => {
    asyncSkills.set("always-fail-async", async () => {
      throw new Error("permanent");
    });
    const steps = await runDAG([
      node("bad", { skill: "always-fail-async", retryCount: 2, retryDelay: 10 }),
      node("down", { skill: "math-add", params: { a: 1, b: 1 }, dependencies: ["bad"] }),
    ]);
    expect(stepById("bad")?.status).toBe("failed");
    expect(stepById("bad")?.attempt).toBe(3);
    expect(stepById("down")?.status).toBe("waiting_dependency");
  });

  // ── Task 10: 技能缺失（SkillManager resolve 失败结果）──
  it("Task 10: 技能不存在时节点失败（success:false 结果上抛）", async () => {
    const steps = await runDAG([
      node("ghost", { skill: "no-such-skill" }),
    ]);
    expect(stepById("ghost")?.status).toBe("failed");
    expect(stepById("ghost")?.error).toContain("Skill not found");
  });

  // ── Task 11: 沙箱技能脚本声明失败（success:false → 假成功修复回归）──
  it("Task 11: 沙箱脚本 _result.success=false 时 DAG 节点失败", async () => {
    const steps = await runDAG([
      node("report-fail", { skill: "always-fail" }),
    ]);
    // 修复点②（DAGExecutor）：resolve 出 success:false 结果不再被当成节点成功。
    // 若仍是假成功，status 会是 completed 而非 failed。
    expect(stepById("report-fail")?.status).toBe("failed");
    expect(stepById("report-fail")?.error).toContain("intentional failure");
    // 修复点①（SkillSandbox）：脚本 _result 声明失败 → SkillExecutionResult.success=false
    // （错误信息经 DAGExecutor 翻译进节点 error，见上行断言）
  });

  // ── Task 12: 失败级联不阻断无关分支 ──
  it("Task 12: 失败级联只影响依赖链，无关分支照常完成", async () => {
    const steps = await runDAG([
      node("bad", { skill: "always-fail" }),
      node("child", { skill: "math-add", params: { a: 1, b: 1 }, dependencies: ["bad"] }),
      node("solo", { skill: "text-upper", params: { content: "ok" } }),
    ]);
    expect(stepById("bad")?.status).toBe("failed");
    expect(stepById("child")?.status).toBe("waiting_dependency");
    expect(stepById("solo")?.status).toBe("completed");
    expect(stepOutput("solo")).toEqual({ success: true, out: "OK", len: 2 });
  });

  // ── Task 13: 宽扇出（一依赖多下游）──
  it("Task 13: 单节点扇出到多个下游全部执行", async () => {
    const steps = await runDAG([
      node("root", { skill: "math-add", params: { a: 10, b: 5 } }),
      node("l", { skill: "text-upper", params: { content: "l" }, dependencies: ["root"] }),
      node("m", { skill: "text-reverse", params: { content: "m" }, dependencies: ["root"] }),
      node("r", { skill: "b64-encode", params: { value: "r" }, dependencies: ["root"] }),
    ]);
    for (const id of ["root", "l", "m", "r"]) {
      expect(stepById(id)?.status).toBe("completed");
    }
    expect(stepOutput("root")).toEqual({ success: true, value: 15 });
    expect(stepOutput("r")).toEqual({ success: true, value: Buffer.from("r").toString("base64") });
  });

  // ── Task 14: 深链（6 层串行依赖）──
  it("Task 14: 六层深链按拓扑序全部完成", async () => {
    const steps = await runDAG([
      node("n1", { skill: "math-add", params: { a: 1, b: 1 } }),
      node("n2", { skill: "math-add", params: { a: 2, b: 2 }, dependencies: ["n1"] }),
      node("n3", { skill: "math-add", params: { a: 3, b: 3 }, dependencies: ["n2"] }),
      node("n4", { skill: "text-upper", params: { content: "deep" }, dependencies: ["n3"] }),
      node("n5", { skill: "text-reverse", params: { content: "deep" }, dependencies: ["n4"] }),
      node("n6", { skill: "regex-test", params: { pattern: "^d", target: "deep" }, dependencies: ["n5"] }),
    ]);
    expect(steps.map((s) => s.status)).toEqual(Array(6).fill("completed"));
    const ids = steps.map((s) => s.nodeId);
    for (let i = 1; i < ids.length; i++) {
      expect(ids.indexOf(`n${i}`)).toBeLessThan(ids.indexOf(`n${i + 1}`));
    }
    expect(stepOutput("n6")).toEqual({ success: true, matched: true });
  });

  // ── Task 15: 双层菱形嵌套 ──
  it("Task 15: 嵌套菱形 DAG（扇出→扇入→再扇出→再扇入）", async () => {
    const steps = await runDAG([
      node("s", { skill: "math-add", params: { a: 1, b: 0 } }),
      node("p", { skill: "text-upper", params: { content: "p" }, dependencies: ["s"] }),
      node("q", { skill: "text-reverse", params: { content: "q" }, dependencies: ["s"] }),
      node("mid", { skill: "math-add", params: { a: 7, b: 7 }, dependencies: ["p", "q"] }),
      node("x", { skill: "text-upper", params: { content: "x" }, dependencies: ["mid"] }),
      node("y", { skill: "text-reverse", params: { content: "y" }, dependencies: ["mid"] }),
      node("t", { skill: "math-add", params: { a: 9, b: 9 }, dependencies: ["x", "y"] }),
    ]);
    expect(steps.every((s) => s.status === "completed")).toBe(true);
    const ids = steps.map((s) => s.nodeId);
    for (const later of ["mid", "x", "y", "t"]) {
      expect(ids.indexOf(later)).toBeGreaterThan(ids.indexOf("s"));
    }
    expect(ids.indexOf("mid")).toBeLessThan(ids.indexOf("t"));
    expect(stepOutput("t")).toEqual({ success: true, value: 18 });
  });

  // ── Task 16: 混合编排（并行 + 串行 + 条件跳过共存）──
  it("Task 16: 并行层 + 串行链 + 条件跳过的混合编排", async () => {
    const steps = await runDAG([
      // 并行层
      node("p1", { skill: "slow-skill", params: { ms: 30 } }),
      node("p2", { skill: "slow-skill", params: { ms: 30 } }),
      // 汇合后串行
      node("join", { skill: "math-add", params: { a: 4, b: 4 }, dependencies: ["p1", "p2"] }),
      // 条件分支
      node("hot", { skill: "text-upper", params: { content: "h" }, dependencies: ["join"], condition: "variables.temp > 30" }),
      node("cold", { skill: "text-upper", params: { content: "c" }, dependencies: ["join"], condition: "variables.temp <= 30" }),
    ], { temp: 22 });
    expect(stepById("join")?.status).toBe("completed");
    expect(stepById("hot")?.status).toBe("skipped");
    expect(stepById("cold")?.status).toBe("completed");
    expect(stepOutput("cold")).toEqual({ success: true, out: "C", len: 1 });
  });

  // ── Task 17: TaskPlanner 分解（模板匹配 + 自定义分析）──
  it("Task 17: TaskPlanner 模板分解生成有依赖的子任务", async () => {
    const plan = taskPlanner.decomposeWithTemplate("创建 React 单页应用", "react_app");
    expect(plan.subtasks.length).toBeGreaterThan(0);
    // 模板含目录任务与文件任务，文件依赖其目录任务
    const dirTasks = plan.subtasks.filter((s) => s.description.startsWith("Create directory"));
    const fileTasks = plan.subtasks.filter((s) => !s.description.startsWith("Create directory"));
    expect(dirTasks.length).toBeGreaterThan(0);
    expect(fileTasks.length).toBeGreaterThan(0);
    // 每个文件任务的依赖都指向已存在的目录任务 id
    for (const ft of fileTasks) {
      for (const dep of ft.dependencies) {
        expect(plan.subtasks.some((s) => s.id === dep)).toBe(true);
      }
    }
    // 自定义分析路径：无模板命中的任务仍能产出子任务
    const generic = taskPlanner.decompose("随便做点什么事");
    expect(generic.subtasks.length).toBeGreaterThan(0);
    expect(generic.subtasks[0].status).toBe("pending");
  });

  // ── Task 18: TaskPlanner 状态推进（进度 + 完成判定 + 重试上限）──
  it("Task 18: 子任务状态推进驱动 plan 进度与终态", async () => {
    const plan = taskPlanner.decomposeWithTemplate("构建 CLI 工具", "cli_tool");
    const ids = plan.subtasks.map((s) => s.id);
    // 全部完成 → plan 完成、进度 100
    for (const id of ids) {
      taskPlanner.updateSubtaskStatus(plan.id, id, "completed", { done: true });
    }
    const done = taskPlanner.getPlan(plan.id)!;
    expect(done.status).toBe("completed");
    expect(done.progress).toBe(100);
    // 失败收尾：先完成其余子任务，最后一个 failed 触发 plan 转失败
    const plan2 = taskPlanner.decomposeWithTemplate("构建 CLI 工具", "cli_tool");
    for (let i = 1; i < plan2.subtasks.length; i++) {
      taskPlanner.updateSubtaskStatus(plan2.id, plan2.subtasks[i].id, "completed");
    }
    taskPlanner.updateSubtaskStatus(plan2.id, plan2.subtasks[0].id, "failed", undefined, "boom");
    const failed = taskPlanner.getPlan(plan2.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.progress).toBeLessThan(100);
    // incrementRetry 尊重 maxRetries
    const plan3 = taskPlanner.decomposeWithTemplate("构建 CLI 工具", "cli_tool");
    const sid = plan3.subtasks[0].id;
    for (let i = 0; i < 3; i++) {
      expect(taskPlanner.incrementRetry(plan3.id, sid)).toBe(true);
    }
    expect(taskPlanner.incrementRetry(plan3.id, sid)).toBe(false); // 超过 maxRetries=3
  });

  // ── Task 19: TaskOrchestrator 生命周期（事件 + 终态 + 输出）──
  it("Task 19: 编排器执行 DAG 任务到 completed 并发布生命周期事件", async () => {
    const started: unknown[] = [];
    const completed: unknown[] = [];
    eventBus.subscribe(SystemEvents.TASK_STARTED, async (e) => { started.push(e); });
    eventBus.subscribe(SystemEvents.TASK_COMPLETED, async (e) => { completed.push(e); });

    // 直接构造带 DAG 的任务并 execute（不经 createTask 的队列，
    // 避免后台 processQueue 在 dag 装配前消费任务的竞态）
    const task = makeTask([
      node("a", { skill: "math-add", params: { a: 21, b: 21 } }),
    ]);
    task.id = "sim-task-19";
    const result = await taskOrchestrator.execute(task);

    expect(result.status).toBe("completed");
    expect(result.completedAt).not.toBeNull();
    expect(result.output).toEqual({ dagCompleted: true, nodeCount: 1 });
    expect(result.executionPlan).toHaveLength(1);
    expect(result.executionPlan[0].status).toBe("completed");
    expect(started.length).toBe(1);
    expect(completed.length).toBe(1);
    // 进度查询（execute 已把任务记入 activeTasks）
    await expect(taskOrchestrator.getProgress(task.id)).resolves.toBe(1);
  });

  // ── Task 20: 失败任务走 orchestrator 重试通道 ──
  it("Task 20: DAG 节点失败触发任务级重试（status 回 queued、retryCount 递增）", async () => {
    const retrying: unknown[] = [];
    eventBus.subscribe(SystemEvents.TASK_RETRYING, async (e) => { retrying.push(e); });

    const task = makeTask([node("boom", { skill: "always-fail" })]);
    task.id = "sim-task-20";
    task.maxRetries = 3;
    const result = await taskOrchestrator.execute(task);
    // 失败后重新入队等待重试（直接 execute 时无后台循环消费，状态稳定停在 queued）
    expect(result.status).toBe("queued");
    expect(result.retryCount).toBe(1);
    expect(retrying.length).toBe(1);
  });
});
