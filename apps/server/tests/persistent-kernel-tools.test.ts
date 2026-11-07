/**
 * execute_code persistent=true（会话持久 kernel，Hermes code_kernel 对齐）测试
 *
 * 验证（handler 级布线 + 内核语义）：
 * - 工具定义包含 persistent 与 reset 参数，描述覆盖持久语义与局限
 * - persistent 路径走 CodeKernelRegistry 常驻进程：变量跨调用存活、
 *   reused/execution_count 增长
 * - reset=true 换新内核（旧变量消失）
 * - timeout kill 内核（state lost 提示 + kernelDiscarded 语义）
 * - 非 python / 非 process 后端 / code 缺失 → 明确报错（非静默降级）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerShellMediaTools } from "../src/tools/shell-media-tools";
import { ServiceRegistry } from "@evoclaw/core";
import { CodeKernelRegistry } from "@evoclaw/infrastructure";
import { spawnSync } from "node:child_process";

interface ToolDef { name: string; description?: string; parameters: Record<string, unknown> }

interface MakeExecutorResult {
  executor: {
    registerTool: (name: string, def: ToolDef, handler: (params: Record<string, unknown>) => Promise<unknown>) => void;
    getRegisteredTools: () => Array<{ name: string; description?: string }>;
    executeToolByName: (name: string, params: Record<string, unknown>) => Promise<unknown>;
  };
  handler: () => (params: Record<string, unknown>) => Promise<unknown>;
  definition: () => ToolDef;
}

function makeExecutor(): MakeExecutorResult {
  let execCodeHandler: ((params: Record<string, unknown>) => Promise<unknown>) | null = null;
  let execCodeDef: ToolDef | null = null;
  const executor = {
    registerTool(name: string, def: ToolDef, handler: (params: Record<string, unknown>) => Promise<unknown>) {
      if (name === "execute_code") { execCodeHandler = handler; execCodeDef = def; }
    },
    getRegisteredTools: () => [],
    executeToolByName: async () => ({ success: true }),
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
  };
}

const hasPython = spawnSync("python3", ["-V"], { encoding: "utf-8" }).status === 0;
const describeIfPython = hasPython ? describe : describe.skip;

describeIfPython("execute_code — persistent session kernel", () => {
  let ex: MakeExecutorResult;
  let handler: (params: Record<string, unknown>) => Promise<unknown>;
  let registry: ServiceRegistry | undefined;
  let kernel: CodeKernelRegistry | undefined;

  /** 注册 sandboxManager 桩（仅 listBackends；persistent 路径不进入会话管理） */
  function registerWithKernel(available: Array<{ type: string; available: boolean }>) {
    registry = new ServiceRegistry();
    kernel = new CodeKernelRegistry({ enableReaper: false });
    registry.registerService("sandboxManager", {
      listBackends: async () => available,
      destroySession: async () => { throw new Error("unexpected destroySession in persistent path"); },
      createSession: async () => { throw new Error("unexpected createSession in persistent path"); },
    });
    registry.registerService("codeKernel", kernel);
    registerShellMediaTools(ex.executor as never, registry);
    handler = ex.handler();
  }

  beforeEach(() => {
    ex = makeExecutor();
    // docker 不可用的测试宿主：backend=process 可用，未指定 → 默认降级 process
    registerWithKernel([
      { type: "docker", available: false },
      { type: "process", available: true },
    ]);
  });

  afterEach(() => {
    try { kernel?.shutdownAll(); } catch { /* ignore */ }
  });

  it("工具定义包含 persistent / reset 参数与双模式/局限描述", () => {
    const def = ex.definition();
    expect(def.name).toBe("execute_code");
    expect(def.parameters.persistent).toBeDefined();
    expect(def.parameters.reset).toBeDefined();
    expect(def.description).toContain("persistent=true");
    expect(def.description).toContain("code_kernel");
  });

  it("persistent：变量与 import 跨调用存活（kernel 结果含 reused/execution_count）", async () => {
    const r1 = (await handler({
      code: "articles = [1, 2, 3]\nprint('init', len(articles))",
      language: "python",
      persistent: true,
      backend: "process",
    })) as Record<string, unknown>;
    expect(r1.success).toBe(true);
    expect(r1.persistent).toBe(true);
    expect(r1.sandbox).toBe("process");
    const k1 = r1.kernel as Record<string, unknown>;
    expect(k1.reused).toBe(false);
    expect(k1.execution_count).toBe(1);
    expect(String(r1.stdout)).toContain("init 3");

    const r2 = (await handler({
      code: "articles.append(4)\nprint('after', sum(articles))",
      language: "python",
      persistent: true,
      backend: "process",
    })) as Record<string, unknown>;
    expect(r2.success).toBe(true);
    const k2 = r2.kernel as Record<string, unknown>;
    expect(k2.reused).toBe(true);
    expect(k2.execution_count).toBe(2);
    expect(String(r2.stdout)).toContain("after 10");
  });

  it("reset=true：换新内核进程，旧变量丢失", async () => {
    await handler({ code: "v = 7", language: "python", persistent: true, backend: "process" });
    const r = (await handler({
      code: "print('kept' if 'v' in dir() else 'reset')",
      language: "python",
      persistent: true,
      backend: "process",
      reset: true,
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    const k = r.kernel as Record<string, unknown>;
    expect(k.state_reset).toBe(true);
    expect(String(r.stdout)).toContain("reset");
  });

  it("timeout：kill 内核，结果带 state lost 提示（下一次调用重启新内核）", async () => {
    const r1 = (await handler({
      code: "slow = 42\nimport time; time.sleep(30)",
      language: "python",
      persistent: true,
      backend: "process",
      timeout: "10",
    })) as Record<string, unknown>;
    expect(r1.success).toBe(false);
    expect(r1.timedOut).toBe(true);
    expect(String(r1.error)).toContain("state");

    // 上一个内核已销毁 → 新内核无此前状态（刻意语义，测试 timeout 上限 10s 内完成）
    const r2 = (await handler({
      code: "print('FRESH' if 'slow' not in dir() else 'KEPT')",
      language: "python",
      persistent: true,
      backend: "process",
      timeout: "15",
    })) as Record<string, unknown>;
    expect(r2.success).toBe(true);
    expect(String(r2.stdout)).toContain("FRESH");
    expect((r2.kernel as Record<string, unknown>).reused).toBe(false);
  }, 40_000);

  it("persistent + 非 python → 明确报错，非静默降级", async () => {
    const r = (await handler({
      code: "console.log('x')",
      language: "node",
      persistent: true,
      backend: "process",
    })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("python");
  });

  it("persistent + docker 后端 → 明确报错（docker per-call exec 不支持常驻内核）", async () => {
    const own = new ServiceRegistry();
    own.registerService("sandboxManager", {
      listBackends: async () => [{ type: "docker", available: true }, { type: "process", available: true }],
    });
    own.registerService("codeKernel", new CodeKernelRegistry({ enableReaper: false }));
    const ex2 = makeExecutor();
    registerShellMediaTools(ex2.executor as never, own);
    const r = (await ex2.handler()({
      code: "print(1)",
      language: "python",
      persistent: true,
      backend: "docker",
    })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("process");
  });

  it("codeKernel 服务缺席 → 明确报错", async () => {
    const slim = new ServiceRegistry();
    slim.registerService("sandboxManager", {
      listBackends: async () => [{ type: "process", available: true }],
    });
    const localEx = makeExecutor();
    registerShellMediaTools(localEx.executor as never, slim);
    const localHandler = localEx.handler();
    const r = (await localHandler({
      code: "print(1)",
      language: "python",
      persistent: true,
      backend: "process",
    })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("CodeKernel");
  });
});
