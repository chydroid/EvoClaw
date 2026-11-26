/**
 * memory 工具 — P4 写入闸门测试（Hermes memory_tool_store.py 对齐）。
 *
 * 验证：
 * - patch：id 精确 / 唯一匹配 / 歧义候选 / not_found 最近条目 / 出现多次拒绝 / no-op 拒绝
 * - 原地更新：不新建 id、条目数不变
 * - remove：id 不存在报错；唯一匹配删除；歧义返回候选
 * - schema：action 枚举与定位参数
 */

import { describe, it, expect } from "vitest";
import type { MemoryEntry } from "@evoclaw/core";
import { registerMemoryTools } from "../src/tools/memory-tools";

interface Registered {
  name: string;
  definition: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  handler: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

interface ToolResult {
  success: boolean;
  error?: string;
  id?: string;
  candidates?: Array<{ id: string; content: string }>;
  nearest?: { id: string; content: string };
  message?: string;
}

function makeEntry(id: string, content: string): MemoryEntry {
  const now = new Date("2026-11-13T00:00:00Z");
  return {
    id,
    type: "knowledge",
    content,
    embedding: null,
    metadata: {
      source: "agent",
      sessionId: "s-1",
      userId: "u-1",
      tags: [],
      importance: 0.5,
      associations: [],
      entities: [],
    },
    ttl: 0,
    createdAt: now,
    accessedAt: now,
  };
}

function createHarness(initial: MemoryEntry[]) {
  const entries = new Map(initial.map((e) => [e.id, e]));
  const longTerm = {
    async get(id: string): Promise<MemoryEntry | undefined> {
      return entries.get(id);
    },
    async getAll(): Promise<MemoryEntry[]> {
      return Array.from(entries.values());
    },
    async delete(id: string): Promise<boolean> {
      return entries.delete(id);
    },
  };
  const memoryHub = {
    getLongTerm: () => longTerm,
    async semanticSearch(query: string, _limit: number) {
      return [{ id: query, content: query }];
    },
    async getLayeredStats() {
      return {};
    },
    getShortTerm: () => ({ keys: async () => [] }),
    async updateMemoryContent(id: string, content: string): Promise<MemoryEntry | null> {
      const existing = entries.get(id);
      if (!existing) return null;
      const updated: MemoryEntry = { ...existing, content, accessedAt: new Date() };
      entries.set(id, updated);
      return updated;
    },
  };

  const registered: Registered[] = [];
  const executor = {
    // memory-tools 通过 (executor as any).registry 解析内存服务
    registry: {
      resolveService: (name: string) => (name === "memoryHub" ? memoryHub : undefined),
    },
    registerTool(
      name: string,
      definition: Registered["definition"],
      handler: Registered["handler"],
    ) {
      registered.push({ name, definition, handler });
    },
  };

  registerMemoryTools(executor as never);
  const tool = registered.find((r) => r.name === "memory");
  if (!tool) throw new Error("memory tool not registered");
  const call = (params: Record<string, unknown>) => tool.handler(params) as Promise<ToolResult>;

  return { entries, tool, call };
}

describe("memory 工具 schema（P4）", () => {
  it("action 枚举包含 patch/remove，id/old_string 均非必填", () => {
    const { tool } = createHarness([]);
    // 本仓库工具定义风格：parameters 直接是「参数名 → schema」映射
    const params = tool.definition.parameters as Record<
      string,
      { required?: boolean; enum?: string[] }
    >;
    expect(params.action.enum).toEqual(["add", "patch", "remove", "search", "stats"]);
    // 判别字段有默认值（search）→ 非必填，省略即用默认（对齐 hermes）
    expect(params.action.required).toBe(false);
    expect((params.action as { default?: string }).default).toBe("search");
    expect(params.id.required).toBe(false);
    expect(params.old_string.required).toBe(false);
  });
});

describe("action=patch — 唯一匹配 + 原地更新", () => {
  const base = [
    makeEntry("m1", "项目进度：完成登录页"),
    makeEntry("m2", "项目进度：完成注册页"),
    makeEntry("m3", "季度目标"),
  ];

  it("无 id：唯一子串命中并原地更新（id 不变、条目数不变）", async () => {
    const h = createHarness(base);
    const res = await h.call({ action: "patch", old_string: "季度目标", new_string: "年度目标" });
    expect(res.success).toBe(true);
    expect(res.id).toBe("m3");
    expect(h.entries.size).toBe(3);
    expect(h.entries.get("m3")?.content).toBe("年度目标");
  });

  it("有 id：即使 old_string 跨条目歧义，也精确定位该条目", async () => {
    const h = createHarness(base);
    const res = await h.call({
      action: "patch",
      id: "m2",
      old_string: "注册页",
      new_string: "注册与找回页",
    });
    expect(res.success).toBe(true);
    expect(h.entries.get("m2")?.content).toBe("项目进度：完成注册与找回页");
    expect(h.entries.get("m1")?.content).toBe("项目进度：完成登录页");
  });

  it("跨条目歧义 → 拒绝并返回候选，不改动任何条目", async () => {
    const h = createHarness(base);
    const res = await h.call({ action: "patch", old_string: "项目进度", new_string: "X" });
    expect(res.success).toBe(false);
    expect(res.candidates?.map((c) => c.id)).toEqual(["m1", "m2"]);
    expect(h.entries.get("m1")?.content).toBe("项目进度：完成登录页");
  });

  it("无匹配 → not_found 附带最近条目", async () => {
    const h = createHarness(base);
    const res = await h.call({ action: "patch", old_string: "登录页进度", new_string: "X" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("No memory entry found");
    expect(res.nearest?.id).toBe("m1");
  });

  it("old_string 在目标条目内出现多次 → 拒绝", async () => {
    const h = createHarness([makeEntry("m1", "todo: a; todo: b")]);
    const res = await h.call({ action: "patch", id: "m1", old_string: "todo", new_string: "done" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("appears 2 times");
    expect(h.entries.get("m1")?.content).toBe("todo: a; todo: b");
  });

  it("id 不存在 → 拒绝，不静默新建", async () => {
    const h = createHarness(base);
    const res = await h.call({ action: "patch", id: "nope", old_string: "x", new_string: "y" });
    expect(res.success).toBe(false);
    expect(res.error).toContain('No memory entry with id "nope"');
    expect(h.entries.size).toBe(3);
  });

  it("new_string 与 old_string 相同 → no-op 拒绝", async () => {
    const h = createHarness(base);
    const res = await h.call({ action: "patch", id: "m1", old_string: "登录页", new_string: "登录页" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("no-op");
  });
});

describe("action=remove — 必须命中唯一目标", () => {
  const base = [
    makeEntry("m1", "项目进度：完成登录页"),
    makeEntry("m2", "项目进度：完成注册页"),
  ];

  it("有 id 且存在 → 删除", async () => {
    const h = createHarness(base);
    const res = await h.call({ action: "remove", id: "m1" });
    expect(res.success).toBe(true);
    expect(res.id).toBe("m1");
    expect(h.entries.has("m1")).toBe(false);
  });

  it("id 不存在 → 报错，不再静默成功", async () => {
    const h = createHarness(base);
    const res = await h.call({ action: "remove", id: "ghost" });
    expect(res.success).toBe(false);
    expect(res.error).toContain('No memory entry with id "ghost"');
    expect(h.entries.size).toBe(2);
  });

  it("跨条目歧义 → 返回候选，不删除", async () => {
    const h = createHarness(base);
    const res = await h.call({ action: "remove", old_string: "项目进度" });
    expect(res.success).toBe(false);
    expect(res.candidates?.map((c) => c.id)).toEqual(["m1", "m2"]);
    expect(h.entries.size).toBe(2);
  });

  it("唯一内容匹配 → 删除；无匹配 → not_found + nearest", async () => {
    const h = createHarness(base);
    const ok = await h.call({ action: "remove", old_string: "登录页" });
    expect(ok.success).toBe(true);
    expect(h.entries.has("m1")).toBe(false);

    const miss = await h.call({ action: "remove", old_string: "登录页进度" });
    expect(miss.success).toBe(false);
    expect(miss.nearest?.id).toBe("m2");
  });

  it("既无 id 也无 old_string → 报错", async () => {
    const h = createHarness(base);
    const res = await h.call({ action: "remove" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Either id or old_string");
  });
});

describe("action=search 保持原行为", () => {
  it("返回 semanticSearch 结果与计数", async () => {
    const h = createHarness([]);
    const res = await h.call({ action: "search", query: "登录页" });
    expect(res.success).toBe(true);
    expect(res).toMatchObject({ query: "登录页", count: 1 });
  });
});
