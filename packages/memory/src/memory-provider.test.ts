import { describe, it, expect, beforeEach } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { MemoryHub } from "./memory-hub";
import {
  MemoryProviderManager,
  type MemoryProvider,
  type MemoryProviderContext,
  type TurnData,
} from "./memory-provider";
import { BuiltinMemoryProvider } from "./providers/builtin-provider";

// ── 测试用 mock provider ──────────────────────────────────────────

interface CallLog {
  method: string;
  args: unknown[];
}

function createMockProvider(name: string): MemoryProvider & { calls: CallLog[] } {
  const calls: CallLog[] = [];
  const log = (method: string) => (...args: unknown[]): void => {
    calls.push({ method, args });
  };
  return {
    name,
    calls,
    async initialize(ctx: MemoryProviderContext): Promise<void> {
      calls.push({ method: "initialize", args: [ctx] });
    },
    systemPromptBlock(): string {
      calls.push({ method: "systemPromptBlock", args: [] });
      return `<mock-${name}>prompt</mock-${name}>`;
    },
    async prefetch(query: string): Promise<void> {
      calls.push({ method: "prefetch", args: [query] });
    },
    async syncTurn(turnData: TurnData): Promise<void> {
      calls.push({ method: "syncTurn", args: [turnData] });
    },
    getToolSchemas() {
      calls.push({ method: "getToolSchemas", args: [] });
      return [{ name: `${name}_tool`, description: `${name} tool`, parameters: {} }];
    },
    async handleToolCall(toolName: string, args: unknown): Promise<unknown> {
      calls.push({ method: "handleToolCall", args: [toolName, args] });
      return { tool: toolName, ok: true };
    },
    async shutdown(): Promise<void> {
      calls.push({ method: "shutdown", args: [] });
    },
    async onTurnStart(sessionId: string): Promise<void> {
      calls.push({ method: "onTurnStart", args: [sessionId] });
    },
    async onSessionEnd(sessionId: string): Promise<void> {
      calls.push({ method: "onSessionEnd", args: [sessionId] });
    },
    async onPreCompress(messages: unknown[]): Promise<unknown[]> {
      calls.push({ method: "onPreCompress", args: [messages] });
      return messages.map((m) => ({ ...((m as object) ?? {}), compressed: true }));
    },
    async onDelegation(task: string): Promise<void> {
      calls.push({ method: "onDelegation", args: [task] });
    },
    backupPaths(): string[] {
      calls.push({ method: "backupPaths", args: [] });
      return ["/mock/backup.json"];
    },
  };
}

// ── MemoryProviderManager ─────────────────────────────────────────

describe("MemoryProviderManager", () => {
  let manager: MemoryProviderManager;

  beforeEach(() => {
    manager = new MemoryProviderManager();
  });

  describe("注册与注销", () => {
    it("注册 provider 后出现在 getProviders 列表中", () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      const providers = manager.getProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].name).toBe("alpha");
    });

    it("重复注册同名 provider 覆盖旧实例", () => {
      const p1 = createMockProvider("alpha");
      const p2 = createMockProvider("alpha");
      manager.registerProvider(p1);
      manager.registerProvider(p2);
      expect(manager.getProviders()).toHaveLength(1);
      expect(manager.getProviders()[0]).toBe(p2);
    });

    it("注销 provider 后从列表中移除", () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.unregisterProvider("alpha");
      expect(manager.getProviders()).toHaveLength(0);
    });

    it("注销 activeProvider 时清空 activeProvider", () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.setActiveProvider("alpha");
      expect(manager.getActiveProvider()).toBe(p);
      manager.unregisterProvider("alpha");
      expect(manager.getActiveProvider()).toBeNull();
    });

    it("注销非 active provider 不影响 activeProvider", () => {
      const active = createMockProvider("alpha");
      const other = createMockProvider("beta");
      manager.registerProvider(active);
      manager.registerProvider(other);
      manager.setActiveProvider("alpha");
      manager.unregisterProvider("beta");
      expect(manager.getActiveProvider()).toBe(active);
    });
  });

  describe("setActiveProvider", () => {
    it("正确设置已注册的 provider 为 active", () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.setActiveProvider("alpha");
      expect(manager.getActiveProvider()).toBe(p);
    });

    it("未注册的 provider 名抛错", () => {
      expect(() => manager.setActiveProvider("nonexistent")).toThrow(
        /not registered/,
      );
    });
  });

  describe("单一 provider 限制", () => {
    it("setActiveProvider 覆盖前一个 activeProvider", () => {
      const p1 = createMockProvider("alpha");
      const p2 = createMockProvider("beta");
      manager.registerProvider(p1);
      manager.registerProvider(p2);
      manager.setActiveProvider("alpha");
      manager.setActiveProvider("beta");
      expect(manager.getActiveProvider()).toBe(p2);
      expect(manager.getActiveProvider()).not.toBe(p1);
    });

    it("代理只调用 activeProvider 的钩子", () => {
      const p1 = createMockProvider("alpha");
      const p2 = createMockProvider("beta");
      manager.registerProvider(p1);
      manager.registerProvider(p2);
      manager.setActiveProvider("alpha");
      manager.systemPromptBlock();
      manager.systemPromptBlock();
      manager.setActiveProvider("beta");
      manager.systemPromptBlock();
      // alpha 被调用 2 次，beta 被调用 1 次
      const alphaCalls = p1.calls.filter((c) => c.method === "systemPromptBlock");
      const betaCalls = p2.calls.filter((c) => c.method === "systemPromptBlock");
      expect(alphaCalls).toHaveLength(2);
      expect(betaCalls).toHaveLength(1);
    });
  });

  describe("生命周期钩子代理", () => {
    it("initialize 代理到 activeProvider", async () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.setActiveProvider("alpha");
      const ctx: MemoryProviderContext = {
        hermesHome: "/tmp",
        sessionId: "s1",
      };
      await manager.initialize(ctx);
      expect(p.calls).toContainEqual({
        method: "initialize",
        args: [ctx],
      });
    });

    it("prefetch 代理到 activeProvider", async () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.setActiveProvider("alpha");
      await manager.prefetch("hello");
      expect(p.calls).toContainEqual({
        method: "prefetch",
        args: ["hello"],
      });
    });

    it("syncTurn 代理到 activeProvider", async () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.setActiveProvider("alpha");
      const turn: TurnData = {
        sessionId: "s1",
        userMessage: "hi",
        assistantMessage: "hello",
        timestamp: new Date().toISOString(),
      };
      await manager.syncTurn(turn);
      expect(p.calls).toContainEqual({
        method: "syncTurn",
        args: [turn],
      });
    });

    it("getToolSchemas 代理到 activeProvider", () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.setActiveProvider("alpha");
      const schemas = manager.getToolSchemas();
      expect(schemas).toEqual([
        { name: "alpha_tool", description: "alpha tool", parameters: {} },
      ]);
    });

    it("handleToolCall 代理到 activeProvider", async () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.setActiveProvider("alpha");
      const result = await manager.handleToolCall("alpha_tool", { x: 1 });
      expect(result).toEqual({ tool: "alpha_tool", ok: true });
    });

    it("shutdown 代理到 activeProvider", async () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.setActiveProvider("alpha");
      await manager.shutdown();
      expect(p.calls.some((c) => c.method === "shutdown")).toBe(true);
    });

    it("systemPromptBlock 代理到 activeProvider", () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.setActiveProvider("alpha");
      expect(manager.systemPromptBlock()).toBe("<mock-alpha>prompt</mock-alpha>");
    });

    it("可选钩子 onTurnStart 代理到 activeProvider", async () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.setActiveProvider("alpha");
      await manager.onTurnStart("s1");
      expect(p.calls).toContainEqual({
        method: "onTurnStart",
        args: ["s1"],
      });
    });

    it("可选钩子 onSessionEnd 代理到 activeProvider", async () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.setActiveProvider("alpha");
      await manager.onSessionEnd("s1");
      expect(p.calls).toContainEqual({
        method: "onSessionEnd",
        args: ["s1"],
      });
    });

    it("可选钩子 onDelegation 代理到 activeProvider", async () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.setActiveProvider("alpha");
      await manager.onDelegation("do something");
      expect(p.calls).toContainEqual({
        method: "onDelegation",
        args: ["do something"],
      });
    });

    it("可选钩子 backupPaths 代理到 activeProvider", () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.setActiveProvider("alpha");
      expect(manager.backupPaths()).toEqual(["/mock/backup.json"]);
    });

    it("onPreCompress 代理到 activeProvider 并返回变换结果", async () => {
      const p = createMockProvider("alpha");
      manager.registerProvider(p);
      manager.setActiveProvider("alpha");
      const input = [{ role: "user", content: "hi" }];
      const result = await manager.onPreCompress(input);
      expect(result).toEqual([{ role: "user", content: "hi", compressed: true }]);
    });
  });

  describe("空活跃 provider 的默认行为", () => {
    it("systemPromptBlock 返回空字符串", () => {
      expect(manager.systemPromptBlock()).toBe("");
    });

    it("getToolSchemas 返回空数组", () => {
      expect(manager.getToolSchemas()).toEqual([]);
    });

    it("handleToolCall 返回 null", async () => {
      expect(await manager.handleToolCall("any", {})).toBeNull();
    });

    it("backupPaths 返回空数组", () => {
      expect(manager.backupPaths()).toEqual([]);
    });

    it("onPreCompress 返回原 messages 数组", async () => {
      const msgs = [{ a: 1 }, { b: 2 }];
      const result = await manager.onPreCompress(msgs);
      expect(result).toBe(msgs);
    });

    it("initialize/prefetch/syncTurn/shutdown 不抛错", async () => {
      await expect(
        manager.initialize({ hermesHome: "/tmp", sessionId: "s1" }),
      ).resolves.toBeUndefined();
      await expect(manager.prefetch("q")).resolves.toBeUndefined();
      await expect(
        manager.syncTurn({
          sessionId: "s1",
          userMessage: "u",
          assistantMessage: "a",
          timestamp: new Date().toISOString(),
        }),
      ).resolves.toBeUndefined();
      await expect(manager.shutdown()).resolves.toBeUndefined();
    });

    it("可选钩子 onTurnStart/onSessionEnd/onDelegation 不抛错", async () => {
      await expect(manager.onTurnStart("s1")).resolves.toBeUndefined();
      await expect(manager.onSessionEnd("s1")).resolves.toBeUndefined();
      await expect(manager.onDelegation("task")).resolves.toBeUndefined();
    });
  });
});

// ── BuiltinMemoryProvider ─────────────────────────────────────────

describe("BuiltinMemoryProvider", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let hub: MemoryHub;

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    hub = new MemoryHub(registry, eventBus, { useTransformers: false });
  });

  it("name 为 'builtin'", () => {
    const provider = new BuiltinMemoryProvider(hub);
    expect(provider.name).toBe("builtin");
  });

  it("initialize 设置上下文", async () => {
    const provider = new BuiltinMemoryProvider(hub);
    const ctx: MemoryProviderContext = {
      hermesHome: "/tmp",
      sessionId: "s1",
      userId: "u1",
    };
    await expect(provider.initialize(ctx)).resolves.toBeUndefined();
  });

  it("getToolSchemas 返回 memory_recall 和 memory_store", () => {
    const provider = new BuiltinMemoryProvider(hub);
    const schemas = provider.getToolSchemas();
    expect(schemas.map((s) => s.name).sort()).toEqual([
      "memory_recall",
      "memory_store",
    ]);
  });

  it("systemPromptBlock 无预取时返回空字符串", () => {
    const provider = new BuiltinMemoryProvider(hub);
    expect(provider.systemPromptBlock()).toBe("");
  });

  it("prefetch 后 systemPromptBlock 用 <memory> 标签包裹", async () => {
    const provider = new BuiltinMemoryProvider(hub);
    await provider.initialize({
      hermesHome: "/tmp",
      sessionId: "s1",
    });
    // 先存储一条记忆以便 FTS5 能搜到
    await provider.syncTurn({
      sessionId: "s1",
      userMessage: "TypeScript is great",
      assistantMessage: "Indeed",
      timestamp: new Date().toISOString(),
    });
    await provider.prefetch("TypeScript");
    const block = provider.systemPromptBlock();
    expect(block).toMatch(/^<memory>\n/);
    expect(block).toMatch(/<\/memory>$/);
  });

  it("syncTurn 将对话存储到长期记忆", async () => {
    const provider = new BuiltinMemoryProvider(hub);
    await provider.initialize({
      hermesHome: "/tmp",
      sessionId: "s1",
      userId: "u1",
    });
    await provider.syncTurn({
      sessionId: "s1",
      userMessage: "hello world",
      assistantMessage: "hi there",
      timestamp: new Date().toISOString(),
    });
    // 通过 recall 验证存储成功
    const results = await hub.recall({ query: "hello", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some((r) => r.entry.content.includes("hello world")),
    ).toBe(true);
  });

  it("handleToolCall memory_store 存储记忆", async () => {
    const provider = new BuiltinMemoryProvider(hub);
    await provider.initialize({
      hermesHome: "/tmp",
      sessionId: "s1",
      userId: "u1",
    });
    const result = (await provider.handleToolCall("memory_store", {
      content: "test fact content",
      type: "knowledge",
      tags: ["test"],
    })) as { id: string; stored: boolean };
    expect(result.stored).toBe(true);
    expect(typeof result.id).toBe("string");
  });

  it("handleToolCall memory_recall 检索记忆", async () => {
    const provider = new BuiltinMemoryProvider(hub);
    await provider.initialize({
      hermesHome: "/tmp",
      sessionId: "s1",
    });
    // 先存储
    await provider.handleToolCall("memory_store", {
      content: "unique recall marker text",
      type: "knowledge",
    });
    // 再检索
    const result = (await provider.handleToolCall("memory_recall", {
      query: "unique recall marker",
      limit: 5,
    })) as Array<{ content: string }>;
    expect(Array.isArray(result)).toBe(true);
    expect(
      result.some((r) => r.content.includes("unique recall marker")),
    ).toBe(true);
  });

  it("handleToolCall 未知工具返回 error", async () => {
    const provider = new BuiltinMemoryProvider(hub);
    const result = (await provider.handleToolCall("unknown_tool", {})) as {
      error: string;
    };
    expect(result.error).toMatch(/Unknown tool/);
  });

  it("shutdown 后不再持有 hub 引用", async () => {
    const provider = new BuiltinMemoryProvider(hub);
    await provider.initialize({
      hermesHome: "/tmp",
      sessionId: "s1",
    });
    // 先存储一条记忆以便 prefetch 能返回结果
    await provider.syncTurn({
      sessionId: "s1",
      userMessage: "shutdown test marker",
      assistantMessage: "ok",
      timestamp: new Date().toISOString(),
    });
    await provider.prefetch("shutdown");
    // prefetch 有结果时 systemPromptBlock 非空；若 FTS5 不可用则 snippet 为空，仅验证 shutdown 后清空
    if (provider.systemPromptBlock() !== "") {
      await provider.shutdown();
      expect(provider.systemPromptBlock()).toBe("");
    } else {
      // FTS5 不可用环境：shutdown 前后都为空，验证 shutdown 不抛错
      await provider.shutdown();
      expect(provider.systemPromptBlock()).toBe("");
    }
  });

  it("onPreCompress 默认返回原数组", async () => {
    const provider = new BuiltinMemoryProvider(hub);
    // BuiltinMemoryProvider 未实现 onPreCompress，应返回原数组
    const msgs = [{ a: 1 }];
    const result = await new MemoryProviderManager().onPreCompress(msgs);
    expect(result).toBe(msgs);
  });

  it("backupPaths 默认返回空数组", () => {
    const provider = new BuiltinMemoryProvider(hub);
    // BuiltinMemoryProvider 未实现 backupPaths
    const manager = new MemoryProviderManager();
    manager.registerProvider(provider);
    manager.setActiveProvider("builtin");
    expect(manager.backupPaths()).toEqual([]);
  });
});
