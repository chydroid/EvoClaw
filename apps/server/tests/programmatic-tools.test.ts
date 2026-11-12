/**
 * Programmatic Tool Calling（execute_code programmatic 模式）测试
 *
 * 验证：
 * - 工具定义包含 programmatic 参数
 * - 脚本侧 tools.call() 经 stdout/stderr 协议路由到宿主 executeToolByName
 * - 禁用工具（shell_exec 等）被脚本侧拒绝
 * - 普通沙箱路径（SandboxManager 缺席）保持 service-gated 降级行为
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { runWithToolCallContext } from "@evoclaw/agent";
import { registerShellMediaTools } from "../src/tools/shell-media-tools";

interface ToolDef { name: string; description?: string; parameters: Record<string, unknown> }
interface ToolCallRecord { name: string; params: Record<string, unknown> }

interface MakeExecutorResult {
  /** 传给 registerShellMediaTools 的 executor 桩 */
  executor: {
    registerTool: (name: string, def: ToolDef, handler: (params: Record<string, unknown>) => Promise<unknown>) => void;
    getRegisteredTools: () => Array<{ name: string; description?: string }>;
    executeToolByName: (name: string, params: Record<string, unknown>) => Promise<unknown>;
  };
  /** execute_code 的 handler（注册后捕获） */
  handler: () => (params: Record<string, unknown>) => Promise<unknown>;
  /** execute_code 的 definition（注册后捕获） */
  definition: () => ToolDef;
  /** 宿主侧工具调用记录 */
  calls: ToolCallRecord[];
}

function makeExecutor(
  existingTools: Array<{ name: string; description?: string }> = [],
  options: { isToolEnabled?: (name: string) => boolean } = {},
): MakeExecutorResult {
  const calls: ToolCallRecord[] = [];
  const defs: Array<{ name: string; description?: string }> = [...existingTools];
  let execCodeHandler: ((params: Record<string, unknown>) => Promise<unknown>) | null = null;
  let execCodeDef: ToolDef | null = null;

  const executor = {
    registerTool(name: string, def: ToolDef, handler: (params: Record<string, unknown>) => Promise<unknown>) {
      if (name === "execute_code") { execCodeHandler = handler; execCodeDef = def; }
      defs.push({ name, description: def.description });
    },
    getRegisteredTools: () => defs,
    isToolEnabled: options.isToolEnabled,
    executeToolByName: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      return { success: true, tool: name, echoed: params };
    },
  };

  return {
    executor,
    handler: () => {
      if (!execCodeHandler) throw new Error("execute_code not registered");
      return execCodeHandler;
    },
    definition: () => {
      if (!execCodeDef) throw new Error("execute_code not registered");
      return execCodeDef;
    },
    calls,
  };
}

describe("execute_code — programmatic tool calling", () => {
  let ex: MakeExecutorResult;
  let handler: (params: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    ex = makeExecutor([
      { name: "file_read", description: "Read a file" },
      { name: "file_list", description: "List a directory" },
      { name: "shell_exec", description: "Shell command" },
    ]);
    // registry 传 undefined：sandboxManager 缺席 → 常规路径 service-gated 降级
    registerShellMediaTools(ex.executor as never);
    handler = ex.handler();
  });

  it("工具定义包含 programmatic 参数与双模式描述", () => {
    const def = ex.definition();
    expect(def.name).toBe("execute_code");
    expect(def.parameters.programmatic).toBeDefined();
    expect(def.description).toContain("programmatic=true");
  });

  it("常规路径（SandboxManager 缺席）返回明确降级错误", async () => {
    const result = (await handler({ code: 'console.log("x")' })) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("SandboxManager");
  });

  it("programmatic 模式：tools.call() 路由到宿主工具并合并结果", async () => {
    const script = [
      "const r1 = await tools.call('file_list', { path: '.' });",
      "const r2 = await tools.call('file_read', { path: 'a.json' });",
      "console.log(JSON.stringify({ ok: !!(r1 && r2) }));",
    ].join("\n");
    const result = (await handler({ code: script, programmatic: true, language: "node" })) as Record<string, unknown>;
    // 测试环境无真实 workspace：脚本仍应在宿主 spawn 下运行（cwd 回退 process.cwd()）
    if (process.env.EVOCLAW_DEBUG_PROGRAMMATIC) {
      console.log("STDERR:", result.stderr, "EXIT:", result.exitCode, "TIMEDOUT:", result.timedOut);
    }
    expect(result.success).toBe(true);
    expect(result.sandbox).toBe("local-programmatic");
    expect(result.programmatic).toBe(true);
    expect(result.toolCalls).toBe(2);
    const names = ex.calls.map((c) => c.name).sort();
    expect(names).toEqual(["file_list", "file_read"]);
    // 宿主侧工具执行成功（脚本合并结果由宿主侧 calls 证明，协议行不进 stdout 捕获）
    expect(ex.calls.every((c) => c.name === "file_list" || c.name === "file_read")).toBe(true);
  }, 60_000);

  it("programmatic 模式：禁用工具被脚本侧拒绝（不进宿主执行）", async () => {
    const script = "try { await tools.call('shell_exec', { command: 'ls' }); } catch (e) { console.log('rejected:' + e.message); }";
    const result = (await handler({ code: script, programmatic: true })) as Record<string, unknown>;
    expect(result.success).toBe(true);
    // 脚本侧拒绝（FORBIDDEN 白名单）：宿主可观测的是该工具未进执行队列
    expect(ex.calls.find((c) => c.name === "shell_exec")).toBeUndefined();
    expect(ex.calls.length).toBe(0);
  }, 60_000);

  it("programmatic 模式：python 语言被拒绝", async () => {
    const result = (await handler({ code: "print(1)", programmatic: true, language: "python" })) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("node");
  });
});

// ═══════════════════════════════════════════════════════════
// P1 execute_code RPC 加固（2026-11-13）
// token / allowlist / 预算 / env 清洗 / 审计 run 归属
// ═══════════════════════════════════════════════════════════

describe("execute_code — programmatic RPC 加固（P1）", () => {
  const BASE_TOOLS = [
    { name: "file_read", description: "Read a file" },
    { name: "file_list", description: "List a directory" },
    { name: "email", description: "Email tool" },
    { name: "shell_exec", description: "Shell command" },
  ];

  function setup(options: { isToolEnabled?: (name: string) => boolean } = {}) {
    const ex = makeExecutor(BASE_TOOLS, options);
    registerShellMediaTools(ex.executor as never);
    return { ex, handler: ex.handler() };
  }

  let savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedEnv = {
      EVOCLAW_PROGRAMMATIC_MAX_TOOL_CALLS: process.env.EVOCLAW_PROGRAMMATIC_MAX_TOOL_CALLS,
      EVOCLAW_TEST_SECRET: process.env.EVOCLAW_TEST_SECRET,
    };
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("allowlist 外工具不出现在 tools.list()，调用返回可读错误", async () => {
    const { ex, handler } = setup();
    const script = [
      "console.log('TOOLS:' + tools.list().join(','));",
      "try { await tools.call('email', { action: 'list' }); } catch (e) { console.log('REJECTED:' + e.message); }",
    ].join("\n");
    const result = (await handler({ code: script, programmatic: true })) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(String(result.stdout)).toContain("TOOLS:file_read,file_list");
    expect(String(result.stdout)).not.toContain("shell_exec");
    expect(String(result.stdout)).toContain("not available in execute_code");
    expect(ex.calls.length).toBe(0);
  }, 60_000);

  it("checkFn=false 的工具不暴露（allowlist ∩ enabled）", async () => {
    const { ex, handler } = setup({ isToolEnabled: (name) => name !== "file_list" });
    const script = [
      "console.log('TOOLS:' + tools.list().join(','));",
      "try { await tools.call('file_list', {}); } catch (e) { console.log('REJECTED:' + e.message); }",
    ].join("\n");
    const result = (await handler({ code: script, programmatic: true })) as Record<string, unknown>;
    // 只看 tools.list() 那一行：拒绝信息本身会提到被拒工具名
    const toolListLine = String(result.stdout).split("\n").find((l) => l.startsWith("TOOLS:")) ?? "";
    expect(toolListLine).toBe("TOOLS:file_read");
    expect(String(result.stdout)).toContain("not available in execute_code");
    expect(ex.calls.length).toBe(0);
  }, 60_000);

  it("token 缺失 / 错误：宿主拒绝派发（fail-closed）", async () => {
    const { ex, handler } = setup();
    const script = [
      // 绕过 wrapper，直接伪造协议行
      "process.stdout.write(JSON.stringify({ __evoclaw_call: { id: 1, name: 'file_read', params: {} } }) + '\\n');",
      "process.stdout.write(JSON.stringify({ __evoclaw_call: { id: 2, name: 'file_read', params: {}, token: 'wrong' } }) + '\\n');",
      "await new Promise(r => setTimeout(r, 300));",
    ].join("\n");
    const result = (await handler({ code: script, programmatic: true })) as Record<string, unknown>;
    expect(ex.calls.length).toBe(0);
    expect(result.rejectedCalls).toBe(2);
  }, 60_000);

  it("正确 token：协议行通过并派发（脚本 wrapper 自带）", async () => {
    const { ex, handler } = setup();
    const script = "await tools.call('file_read', { path: 'a.txt' });";
    const result = (await handler({ code: script, programmatic: true })) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(ex.calls.map((c) => c.name)).toEqual(["file_read"]);
    expect(result.rejectedCalls).toBe(0);
  }, 60_000);

  it("总调用预算：默认/显式上限，超限返回错误且不派发", async () => {
    process.env.EVOCLAW_PROGRAMMATIC_MAX_TOOL_CALLS = "2";
    const { ex, handler } = setup();
    const script = [
      "for (let i = 0; i < 3; i++) {",
      "  try { await tools.call('file_read', { path: 'f' + i }); } catch (e) { console.log('ERR:' + e.message); }",
      "}",
    ].join("\n");
    const result = (await handler({ code: script, programmatic: true })) as Record<string, unknown>;
    expect(ex.calls.length).toBe(2);
    expect(result.dispatchedCalls).toBe(2);
    expect(result.maxToolCalls).toBe(2);
    expect(result.budgetExhausted).toBe(true);
    expect(String(result.stdout)).toContain("Tool call limit reached (2)");
  }, 60_000);

  it("env 清洗：provider key 不继承，RPC token 在用户脚本执行前已删除", async () => {
    process.env.EVOCLAW_TEST_SECRET = "sk-should-not-leak";
    const { handler } = setup();
    const script = [
      "console.log('SECRET:' + (process.env.EVOCLAW_TEST_SECRET || 'absent'));",
      "console.log('TOKEN:' + (process.env.EVOCLAW_RPC_TOKEN ? 'leaked' : 'cleared'));",
      "console.log('PATH:' + (process.env.PATH ? 'present' : 'missing'));",
    ].join("\n");
    const result = (await handler({ code: script, programmatic: true })) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(String(result.stdout)).toContain("SECRET:absent");
    expect(String(result.stdout)).toContain("TOKEN:cleared");
    expect(String(result.stdout)).toContain("PATH:present");
  }, 60_000);

  it("审计记录含 sessionId/runId 与 token 归属（不落 token 明文）", async () => {
    const { handler } = setup();
    const runId = `run-p1-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const result = (await runWithToolCallContext(
      { sessionId: "sess-p1", runId },
      () => handler({ code: "await tools.call('file_read', {});", programmatic: true }),
    )) as Record<string, unknown>;
    expect(result.success).toBe(true);

    const auditPath = path.resolve(__dirname, "../../../data/logs/programmatic-calls.jsonl");
    const lines = fs.readFileSync(auditPath, "utf-8").trim().split("\n");
    const record = lines.map((l) => JSON.parse(l)).find((r) => r.runId === runId);
    expect(record).toBeDefined();
    expect(record.sessionId).toBe("sess-p1");
    expect(record.rpcRunTag).toHaveLength(12);
    expect(JSON.stringify(record)).not.toContain("EVOCLAW_RPC_TOKEN");
  }, 60_000);
});
