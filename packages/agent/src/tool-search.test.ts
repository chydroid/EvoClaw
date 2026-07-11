import { describe, it, expect } from "vitest";
import {
  ToolSearchEngine,
  estimateTokens,
  estimateToolTokens,
  estimateTotalTokens,
  type ToolMeta,
  ToolSearchIndex,
  type IndexedTool,
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

// ── ToolSearchIndex 测试 ──

describe("ToolSearchIndex", () => {
  it("索引单个工具", () => {
    const index = new ToolSearchIndex();
    index.indexTool("read_file", "Read a file from disk", ["file", "read", "filesystem"], { type: "object" });
    expect(index.size).toBe(1);
    const all = index.getAllTools();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("read_file");
    expect(all[0].keywords).toEqual(["file", "read", "filesystem"]);
  });

  it("批量索引", () => {
    const index = new ToolSearchIndex();
    const tools: IndexedTool[] = [
      { name: "read_file", description: "Read a file from disk", keywords: ["file", "read"], definition: { type: "object" } },
      { name: "write_file", description: "Write content to a file", keywords: ["file", "write"], definition: { type: "object" } },
      { name: "list_dir", description: "List directory contents", keywords: ["directory", "list"], definition: { type: "object" } },
    ];
    index.indexBatch(tools);
    expect(index.size).toBe(3);
    expect(index.getAllTools()).toHaveLength(3);
  });

  it("搜索匹配 — 英文", () => {
    const index = new ToolSearchIndex();
    index.indexBatch([
      { name: "read_file", description: "Read a file from disk", keywords: ["file", "read", "filesystem"], definition: {} },
      { name: "write_file", description: "Write content to a file", keywords: ["file", "write"], definition: {} },
      { name: "send_email", description: "Send an email message", keywords: ["email", "send", "smtp"], definition: {} },
    ]);
    const results = index.searchTools("file read");
    expect(results.length).toBeGreaterThan(0);
    // read_file 应排在最前（同时匹配 file + read 关键词）
    expect(results[0].name).toBe("read_file");
    expect(results[0].matchedTerms.length).toBeGreaterThan(0);
    // send_email 不应出现在结果中
    const names = results.map((r) => r.name);
    expect(names).not.toContain("send_email");
  });

  it("搜索匹配 — 中文", () => {
    const index = new ToolSearchIndex();
    index.indexBatch([
      { name: "read_file", description: "读取磁盘文件", keywords: ["文件", "读取", "磁盘"], definition: {} },
      { name: "send_email", description: "发送电子邮件", keywords: ["邮件", "发送", "smtp"], definition: {} },
    ]);
    const results = index.searchTools("读取文件");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("read_file");
    expect(results[0].matchedTerms.length).toBeGreaterThan(0);
  });

  it("搜索匹配 — 中英文混合", () => {
    const index = new ToolSearchIndex();
    index.indexBatch([
      { name: "browser_navigate", description: "浏览器导航到指定 URL", keywords: ["browser", "浏览器", "navigate", "url"], definition: {} },
      { name: "read_file", description: "读取文件", keywords: ["file", "文件"], definition: {} },
    ]);
    const results = index.searchTools("browser 浏览器");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("browser_navigate");
  });

  it("空查询返回默认工具集", () => {
    const index = new ToolSearchIndex(10);
    index.indexBatch([
      { name: "tool_a", description: "alpha", keywords: ["a"], definition: {} },
      { name: "tool_b", description: "beta", keywords: ["b"], definition: {} },
      { name: "tool_c", description: "gamma", keywords: ["c"], definition: {} },
    ]);
    const results = index.searchTools("");
    // 无使用统计时返回全部工具（截断到 maxTools）
    expect(results).toHaveLength(3);
    // 所有结果 score = 1.0
    for (const r of results) {
      expect(r.score).toBe(1.0);
      expect(r.matchedTerms).toEqual([]);
    }
  });

  it("空查询有使用统计时返回最常用工具", () => {
    const index = new ToolSearchIndex(2);
    index.indexBatch([
      { name: "tool_a", description: "alpha", keywords: ["a"], definition: {} },
      { name: "tool_b", description: "beta", keywords: ["b"], definition: {} },
      { name: "tool_c", description: "gamma", keywords: ["c"], definition: {} },
    ]);
    // tool_c 使用最多
    index.recordUsage("tool_c");
    index.recordUsage("tool_c");
    index.recordUsage("tool_a");
    const results = index.searchTools("");
    // maxTools=2 → 返回 2 个，tool_c 应排第一（使用次数最高）
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("tool_c");
  });

  it("maxTools 限制结果数", () => {
    const index = new ToolSearchIndex(2);
    index.indexBatch([
      { name: "read_file", description: "Read a file from disk", keywords: ["file"], definition: {} },
      { name: "write_file", description: "Write content to a file", keywords: ["file"], definition: {} },
      { name: "delete_file", description: "Delete a file", keywords: ["file"], definition: {} },
      { name: "copy_file", description: "Copy a file", keywords: ["file"], definition: {} },
    ]);
    // 搜索 "file" 应匹配所有 4 个，但 maxTools=2 限制只返回 2 个
    const results = index.searchTools("file");
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("移除工具", () => {
    const index = new ToolSearchIndex();
    index.indexBatch([
      { name: "read_file", description: "Read a file", keywords: ["file"], definition: {} },
      { name: "write_file", description: "Write a file", keywords: ["file"], definition: {} },
    ]);
    expect(index.size).toBe(2);

    // 移除存在的工具
    expect(index.removeTool("read_file")).toBe(true);
    expect(index.size).toBe(1);
    expect(index.getAllTools().map((t) => t.name)).toEqual(["write_file"]);

    // 移除不存在的工具
    expect(index.removeTool("nonexistent")).toBe(false);

    // 移除后搜索不应返回已移除的工具
    const results = index.searchTools("file");
    const names = results.map((r) => r.name);
    expect(names).not.toContain("read_file");
  });

  it("评分排序 — 高相关工具排在前面", () => {
    const index = new ToolSearchIndex();
    index.indexBatch([
      { name: "file_read", description: "Read file content", keywords: ["file", "read"], definition: {} },
      { name: "file_write", description: "Write to file", keywords: ["file", "write"], definition: {} },
      { name: "disk_info", description: "Get disk information", keywords: ["disk", "info"], definition: {} },
    ]);
    // 搜索 "file read" 应让 file_read 排第一（同时匹配 file + read 关键词）
    const results = index.searchTools("file read");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("file_read");
    // 验证分数降序
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("关键词权重高于描述匹配", () => {
    const index = new ToolSearchIndex();
    // tool_a 关键词包含查询词，tool_b 描述包含查询词但关键词不含
    index.indexBatch([
      { name: "tool_keyword", description: "generic description", keywords: ["search"], definition: {} },
      { name: "tool_desc", description: "search engine description", keywords: ["other"], definition: {} },
    ]);
    const results = index.searchTools("search");
    expect(results.length).toBeGreaterThan(0);
    // tool_keyword 的关键词匹配权重更高，应排在前面
    expect(results[0].name).toBe("tool_keyword");
  });

  it("getToolset 返回工具定义（schema）", () => {
    const index = new ToolSearchIndex();
    const schema1 = { type: "object", properties: { path: { type: "string" } } };
    const schema2 = { type: "object", properties: { url: { type: "string" } } };
    index.indexBatch([
      { name: "read_file", description: "Read a file from disk", keywords: ["file", "read"], definition: schema1 },
      { name: "fetch_url", description: "Fetch a URL", keywords: ["url", "fetch"], definition: schema2 },
    ]);
    const toolset = index.getToolset("file read");
    expect(toolset.length).toBeGreaterThan(0);
    expect(toolset[0]).toEqual(schema1);
  });

  it("getToolset 跳过无 definition 的工具", () => {
    const index = new ToolSearchIndex();
    index.indexTool("no_schema", "A tool without schema", ["test"]);
    index.indexTool("with_schema", "A tool with schema", ["test"], { type: "object" });
    const toolset = index.getToolset("test");
    expect(toolset).toHaveLength(1);
    expect(toolset[0]).toEqual({ type: "object" });
  });

  it("空索引搜索不抛错", () => {
    const index = new ToolSearchIndex();
    expect(() => index.searchTools("anything")).not.toThrow();
    expect(index.searchTools("anything")).toEqual([]);
    expect(index.getToolset("anything")).toEqual([]);
  });

  it("重新索引同名工具应覆盖旧条目", () => {
    const index = new ToolSearchIndex();
    index.indexTool("read_file", "old description", ["old"]);
    index.indexTool("read_file", "new description", ["new"]);
    expect(index.size).toBe(1);
    const all = index.getAllTools();
    expect(all).toHaveLength(1);
    expect(all[0].description).toBe("new description");
    expect(all[0].keywords).toEqual(["new"]);
  });
});
