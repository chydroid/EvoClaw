import { describe, it, expect } from "vitest";
import {
  ToolSearchEngine,
  estimateTokens,
  estimateToolTokens,
  estimateTotalTokens,
  type ToolMeta,
} from "./tool-search";

describe("estimateTokens", () => {
  it("4 字符约 1 token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("estimateToolTokens", () => {
  it("应估算工具 schema + 描述的 token 数", () => {
    const tool: ToolMeta = {
      name: "read_file",
      description: "Read a file from disk",
      schema: { type: "object", properties: { path: { type: "string" } } },
    };
    const tokens = estimateToolTokens(tool);
    expect(tokens).toBeGreaterThan(0);
  });

  it("无 schema 时应仅计算描述", () => {
    const tool: ToolMeta = {
      name: "ping",
      description: "pong",
    };
    const tokens = estimateToolTokens(tool);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("estimateTotalTokens", () => {
  it("应累加所有工具的 token 数", () => {
    const tools: ToolMeta[] = [
      { name: "a", description: "desc a" },
      { name: "b", description: "desc b" },
    ];
    const total = estimateTotalTokens(tools);
    const sum = estimateToolTokens(tools[0]) + estimateToolTokens(tools[1]);
    expect(total).toBe(sum);
  });

  it("空列表应返回 0", () => {
    expect(estimateTotalTokens([])).toBe(0);
  });
});

describe("ToolSearchEngine", () => {
  it("F8.1 回归：auto 模式仅看 deferrable 工具", () => {
    // 50 个 alwaysVisible 工具 + 5 个 deferrable 小 schema 工具
    const alwaysVisibleTools: ToolMeta[] = Array.from({ length: 50 }, (_, i) => ({
      name: `tool-${i}`,
      description: `Always visible tool ${i}`,
      alwaysVisible: true,
      schema: { type: "object", properties: { x: { type: "string" } } },
    }));
    const deferrableTools: ToolMeta[] = Array.from({ length: 5 }, (_, i) => ({
      name: `defer-${i}`,
      description: `Deferrable tool ${i}`,
      alwaysVisible: false,
      schema: { type: "object", properties: { y: { type: "string" } } },
    }));

    const engine = new ToolSearchEngine({ mode: "auto" });
    engine.registerTools([...alwaysVisibleTools, ...deferrableTools]);

    // deferrable schema 总 token 远小于 4000 阈值 → 不应激活
    expect(engine.isActivated()).toBe(false);
  });

  it("F8.1：mode 'on' 应始终激活", () => {
    const engine = new ToolSearchEngine({ mode: "on" });
    engine.registerTools([{ name: "t", description: "test" }]);
    expect(engine.isActivated()).toBe(true);
  });

  it("F8.1：mode 'off' 应始终不激活", () => {
    const engine = new ToolSearchEngine({ mode: "off" });
    engine.registerTools([{ name: "t", description: "test" }]);
    expect(engine.isActivated()).toBe(false);
  });

  it("auto 模式：deferrable schema token 超阈值应激活", () => {
    // 用低阈值配置，避免构造超大 schema
    const bigSchema = {
      type: "object",
      properties: {
        param1: { type: "string", description: "x".repeat(500) },
        param2: { type: "string", description: "y".repeat(500) },
        param3: { type: "string", description: "z".repeat(500) },
        param4: { type: "string", description: "w".repeat(500) },
      },
    };
    const tools: ToolMeta[] = [
      { name: "big-tool", description: "A tool with a very large schema", alwaysVisible: false, schema: bigSchema },
    ];
    // 阈值 100 tokens — schema ~573 tokens >> 100 → 应激活
    const engine = new ToolSearchEngine({ mode: "auto", schemaTokenThreshold: 100 });
    engine.registerTools(tools);
    expect(engine.isActivated()).toBe(true);
  });

  it("search 空 index 不应抛错（新增守卫）", () => {
    const engine = new ToolSearchEngine({ mode: "on" });
    engine.registerTools([]);
    expect(() => engine.search("query")).not.toThrow();
    expect(engine.search("query")).toEqual([]);
  });

  it("BM25 排序：查询词在名称中应排名更高", () => {
    const tools: ToolMeta[] = [
      { name: "read_file", description: "Read a file from disk" },
      { name: "write_file", description: "Write content to a file" },
      { name: "list_directory", description: "List directory contents" },
      { name: "delete_file", description: "Remove a file" },
    ];
    const engine = new ToolSearchEngine({ mode: "on" });
    engine.registerTools(tools);

    const results = engine.search("file");
    expect(results.length).toBeGreaterThan(0);
    // read_file 和 write_file 和 delete_file 都含 "file"，应排在 list_directory 前
    const names = results.map((r) => r.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    // list_directory 不含 "file"，应排最后或不在结果中
    const listDirIdx = names.indexOf("list_directory");
    const readFileIdx = names.indexOf("read_file");
    if (listDirIdx !== -1 && readFileIdx !== -1) {
      expect(readFileIdx).toBeLessThan(listDirIdx);
    }
  });

  it("未激活时 search 返回全部工具", () => {
    const tools: ToolMeta[] = [
      { name: "tool-a", description: "alpha" },
      { name: "tool-b", description: "beta" },
    ];
    const engine = new ToolSearchEngine({ mode: "off" });
    engine.registerTools(tools);
    const results = engine.search("anything");
    expect(results).toHaveLength(2);
  });

  it("getToolDetails 应返回工具详情", () => {
    const tools: ToolMeta[] = [
      { name: "read_file", description: "Read file", category: "file" },
    ];
    const engine = new ToolSearchEngine({ mode: "off" });
    engine.registerTools(tools);
    expect(engine.getToolDetails("read_file")?.name).toBe("read_file");
    expect(engine.getToolDetails("nonexistent")).toBeNull();
  });

  it("getVisibleTools 激活时返回 alwaysVisible + 桥接工具", () => {
    const tools: ToolMeta[] = [
      { name: "visible-tool", description: "always visible", alwaysVisible: true },
      { name: "deferred-tool", description: "deferrable", alwaysVisible: false },
    ];
    const engine = new ToolSearchEngine({ mode: "on" });
    engine.registerTools(tools);
    const visible = engine.getVisibleTools();
    const names = visible.map((t) => t.name);
    expect(names).toContain("visible-tool");
    expect(names).not.toContain("deferred-tool");
    // 桥接工具
    expect(names).toContain("search_tools");
    expect(names).toContain("get_tool_details");
    expect(names).toContain("enable_tool");
  });

  it("getVisibleTools 未激活时返回全部", () => {
    const tools: ToolMeta[] = [
      { name: "tool-a", description: "alpha" },
      { name: "tool-b", description: "beta" },
    ];
    const engine = new ToolSearchEngine({ mode: "off" });
    engine.registerTools(tools);
    expect(engine.getVisibleTools()).toHaveLength(2);
  });
});
