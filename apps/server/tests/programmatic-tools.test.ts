/**
 * Programmatic Tool Calling（execute_code programmatic 模式）测试
 *
 * 验证：
 * - 工具定义包含 programmatic 参数
 * - 脚本侧 tools.call() 经 stdout/stderr 协议路由到宿主 executeToolByName
 * - 禁用工具（shell_exec 等）被脚本侧拒绝
 * - 普通沙箱路径（SandboxManager 缺席）保持 service-gated 降级行为
 */
import { describe, it, expect, beforeEach } from "vitest";
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

function makeExecutor(existingTools: Array<{ name: string; description?: string }> = []): MakeExecutorResult {
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
