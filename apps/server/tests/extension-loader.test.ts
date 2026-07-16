/**
 * extension-loader 测试 — 工具扩展注册桥接。
 */
import { describe, it, expect, vi } from "vitest";
import {
  convertToolParameters,
  convertToolDefinition,
  registerToolExtension,
  registerToolExtensions,
  extractToolEntries,
  loadAndRegisterToolExtensions,
} from "../src/tools/extension-loader";
import type { AgentModelExecutor } from "@evoclaw/agent";
import type { ToolRuntime, ToolDefinition } from "@evoclaw/plugin-sdk/tool-runtime";

// ── Mock AgentModelExecutor ──────────────────────────────────────────

function createMockExecutor(): {
  executor: AgentModelExecutor;
  registered: Map<string, { definition: unknown; handler: (p: Record<string, unknown>) => Promise<unknown> }>;
} {
  const registered = new Map<string, { definition: unknown; handler: (p: Record<string, unknown>) => Promise<unknown> }>();
  const executor = {
    registerTool: vi.fn((name: string, definition: unknown, handler: (p: Record<string, unknown>) => Promise<unknown>) => {
      registered.set(name, { definition, handler });
    }),
    unregisterTool: vi.fn((name: string) => {
      registered.delete(name);
    }),
    executeToolByName: vi.fn(async (name: string, params: Record<string, unknown>) => {
      const entry = registered.get(name);
      if (!entry) throw new Error(`Tool not found: ${name}`);
      return entry.handler(params);
    }),
  } as unknown as AgentModelExecutor;
  return { executor, registered };
}

// ── convertToolParameters ────────────────────────────────────────────

describe("convertToolParameters", () => {
  it("将 JSON Schema 风格参数转换为扁平 map", () => {
    const result = convertToolParameters({
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "内容" },
        overwrite: { type: "boolean", description: "是否覆盖", default: false },
      },
      required: ["path", "content"],
    });

    expect(result).toEqual({
      path: { type: "string", description: "文件路径", required: true },
      content: { type: "string", description: "内容", required: true },
      overwrite: { type: "boolean", description: "是否覆盖", required: false, default: false },
    });
  });

  it("无 required 时所有参数 required=false", () => {
    const result = convertToolParameters({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    });

    expect(result["name"]["required"]).toBe(false);
  });

  it("保留 enum 和 items", () => {
    const result = convertToolParameters({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["a", "b", "c"] },
        items: { type: "array", items: { type: "string" } },
      },
    });

    expect(result["mode"]["enum"]).toEqual(["a", "b", "c"]);
    expect(result["items"]["items"]).toEqual({ type: "string" });
  });

  it("空 properties 返回空对象", () => {
    const result = convertToolParameters({
      type: "object",
      properties: {},
    });
    expect(result).toEqual({});
  });
});

// ── convertToolDefinition ────────────────────────────────────────────

describe("convertToolDefinition", () => {
  it("完整转换工具定义", () => {
    const sdkDef: ToolDefinition = {
      name: "test_tool",
      description: "A test tool",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "输入" },
        },
        required: ["input"],
      },
      requiresApproval: false,
    };

    const result = convertToolDefinition(sdkDef);
    expect(result.name).toBe("test_tool");
    expect(result.description).toBe("A test tool");
    expect(result.parameters["input"]["required"]).toBe(true);
  });
});

// ── registerToolExtension ────────────────────────────────────────────

describe("registerToolExtension", () => {
  it("注册工具到 executor 并可执行", async () => {
    const { executor, registered } = createMockExecutor();
    const runtime: ToolRuntime = {
      definition: {
        name: "echo",
        description: "Echo back input",
        parameters: {
          type: "object",
          properties: {
            msg: { type: "string", description: "消息" },
          },
          required: ["msg"],
        },
      },
      async execute(request) {
        return { content: `echo: ${request.arguments["msg"]}` };
      },
    };

    registerToolExtension(executor, runtime);

    expect(registered.has("echo")).toBe(true);
    const entry = registered.get("echo")!;
    const result = await entry.handler({ msg: "hello" });
    expect(result).toEqual({ content: "echo: hello" });
  });

  it("requiresApproval=true 且审批拒绝时返回错误", async () => {
    const { executor, registered } = createMockExecutor();
    const runtime: ToolRuntime = {
      definition: {
        name: "dangerous_op",
        description: "危险操作",
        parameters: { type: "object", properties: {} },
        requiresApproval: true,
      },
      async execute() {
        return { content: "should not reach here" };
      },
    };

    registerToolExtension(executor, runtime, {
      requestApproval: async () => ({ approved: false, reason: "user denied" }),
    });

    const entry = registered.get("dangerous_op")!;
    const result = await entry.handler({});
    expect(result).toMatchObject({ error: true, content: expect.stringContaining("user denied") });
  });

  it("requiresApproval=true 且审批通过时正常执行", async () => {
    const { executor, registered } = createMockExecutor();
    const runtime: ToolRuntime = {
      definition: {
        name: "approved_op",
        description: "需审批",
        parameters: { type: "object", properties: {} },
        requiresApproval: true,
      },
      async execute() {
        return { content: "executed" };
      },
    };

    registerToolExtension(executor, runtime, {
      requestApproval: async () => ({ approved: true }),
    });

    const entry = registered.get("approved_op")!;
    const result = await entry.handler({});
    expect(result).toEqual({ content: "executed" });
  });
});

// ── registerToolExtensions ───────────────────────────────────────────

describe("registerToolExtensions", () => {
  it("批量注册多个工具", async () => {
    const { executor, registered } = createMockExecutor();
    const runtimes: ToolRuntime[] = [
      {
        definition: { name: "tool_a", description: "A", parameters: { type: "object", properties: {} } },
        async execute() { return { content: "a" }; },
      },
      {
        definition: { name: "tool_b", description: "B", parameters: { type: "object", properties: {} } },
        async execute() { return { content: "b" }; },
      },
    ];

    registerToolExtensions(executor, runtimes);

    expect(registered.has("tool_a")).toBe(true);
    expect(registered.has("tool_b")).toBe(true);

    const resultA = await registered.get("tool_a")!.handler({});
    expect(resultA).toEqual({ content: "a" });
  });
});

// ── extractToolEntries ───────────────────────────────────────────────

describe("extractToolEntries", () => {
  it("从 PluginEntry.tools 数组提取工具扩展", () => {
    const toolEntry = {
      kind: "tool" as const,
      definition: { name: "ext_tool", description: "d", parameters: { type: "object" as const, properties: {} } },
      create: async () => ({
        definition: { name: "ext_tool", description: "d", parameters: { type: "object" as const, properties: {} } },
        async execute() { return { content: "ok" }; },
      }),
    };

    const entry = { manifest: { id: "pkg" }, tools: [toolEntry] };
    const result = extractToolEntries(entry);
    expect(result).toHaveLength(1);
    expect(result[0].definition.name).toBe("ext_tool");
  });

  it("直接是单个 tool entry 时也能提取", () => {
    const toolEntry = {
      kind: "tool" as const,
      definition: { name: "single", description: "d", parameters: { type: "object" as const, properties: {} } },
      create: async () => ({
        definition: { name: "single", description: "d", parameters: { type: "object" as const, properties: {} } },
        async execute() { return { content: "ok" }; },
      }),
    };

    const result = extractToolEntries(toolEntry);
    expect(result).toHaveLength(1);
    expect(result[0].definition.name).toBe("single");
  });

  it("非工具入口返回空数组", () => {
    expect(extractToolEntries(null)).toEqual([]);
    expect(extractToolEntries({})).toEqual([]);
    expect(extractToolEntries({ manifest: { id: "x" } })).toEqual([]);
    expect(extractToolEntries({ tools: [{ kind: "not_tool" }] })).toEqual([]);
  });
});

// ── loadAndRegisterToolExtensions ────────────────────────────────────

describe("loadAndRegisterToolExtensions", () => {
  it("完整流程：从入口列表加载并注册工具", async () => {
    const { executor, registered } = createMockExecutor();

    const toolEntry = {
      kind: "tool" as const,
      definition: { name: "pipeline_tool", description: "Pipeline test", parameters: { type: "object" as const, properties: { x: { type: "string" } } } },
      create: async () => ({
        definition: { name: "pipeline_tool", description: "Pipeline test", parameters: { type: "object" as const, properties: { x: { type: "string" } } } },
        async execute(req) { return { content: `got ${req.arguments["x"] ?? ""}` }; },
      }),
    };

    const result = await loadAndRegisterToolExtensions(
      executor,
      [{ entry: { manifest: { id: "pkg" }, tools: [toolEntry] }, packageName: "@test/pkg" }],
    );

    expect(result.registered).toBe(1);
    expect(result.failed).toEqual([]);
    expect(registered.has("pipeline_tool")).toBe(true);

    const execResult = await registered.get("pipeline_tool")!.handler({ x: "42" });
    expect(execResult).toEqual({ content: "got 42" });
  });

  it("工厂抛异常时记录失败但不中断", async () => {
    const { executor } = createMockExecutor();

    const goodEntry = {
      kind: "tool" as const,
      definition: { name: "good_tool", description: "ok", parameters: { type: "object" as const, properties: {} } },
      create: async () => ({
        definition: { name: "good_tool", description: "ok", parameters: { type: "object" as const, properties: {} } },
        async execute() { return { content: "ok" }; },
      }),
    };
    const badEntry = {
      kind: "tool" as const,
      definition: { name: "bad_tool", description: "fails", parameters: { type: "object" as const, properties: {} } },
      create: async () => { throw new Error("factory boom"); },
    };

    const result = await loadAndRegisterToolExtensions(
      executor,
      [{ entry: { tools: [badEntry, goodEntry] }, packageName: "@test/pkg" }],
    );

    expect(result.registered).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].toolName).toBe("bad_tool");
    expect(result.failed[0].error).toContain("factory boom");
  });

  it("空入口列表返回零注册零失败", async () => {
    const { executor } = createMockExecutor();
    const result = await loadAndRegisterToolExtensions(executor, []);
    expect(result.registered).toBe(0);
    expect(result.failed).toEqual([]);
  });
});
