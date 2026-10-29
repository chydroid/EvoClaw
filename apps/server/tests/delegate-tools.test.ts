/**
 * delegate_task 工具注册测试（对标 Hermes DELEGATE_TASK_SCHEMA 契约）
 *
 * 验证：
 * - 工具 schema：tasks[]（goal 必填）、action 枚举、subagent_id/message
 * - 控制面：list / steer / stop 的参数校验与路由
 * - spawn：tasks[] 批量、遗留单 goal 形态、非法 tasks 拒绝
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerDelegateTools } from "../src/tools/delegate-tools";
import { DelegateEngine, SubagentRegistry } from "@evoclaw/agent";
import type { DelegateExecutorLike } from "@evoclaw/agent";
import type { EventBus } from "@evoclaw/core";

interface Registered {
  name: string;
  definition: { name: string; description: string; parameters: Record<string, unknown> };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

function createHarness() {
  const calls: Array<{ message: string; sessionId: string }> = [];
  const executor: DelegateExecutorLike = {
    async chat(message: string, context?: Record<string, unknown>) {
      calls.push({ message, sessionId: (context?.sessionId as string) ?? "unknown" });
      return { reply: `done:${calls.length - 1}`, tokensUsed: 5 };
    },
    abortSession() {},
  };
  const eventBus = { publish: async () => {} } as unknown as EventBus;
  const registry = new SubagentRegistry(eventBus, 10);
  const engine = new DelegateEngine({ executor, eventBus, subagentRegistry: registry });

  const registered: Registered[] = [];
  const toolExecutor = {
    registerTool(name: string, definition: Registered["definition"], handler: Registered["handler"]) {
      registered.push({ name, definition, handler });
    },
  };
  registerDelegateTools({
    executor: toolExecutor as never,
    delegateEngine: engine,
    getSessionId: () => "test-session",
  });
  return { engine, registry, registered, calls };
}

describe("delegate_task 工具注册", () => {
  let h: ReturnType<typeof createHarness>;
  let tool: Registered;

  beforeEach(() => {
    h = createHarness();
    tool = h.registered.find((r) => r.name === "delegate_task")!;
    expect(tool).toBeDefined();
  });

  afterEach(() => {
    h.registry.dispose();
  });

  it("schema 契约：tasks[] goal 必填 + action 枚举 + 控制面参数", () => {
    expect(tool.definition.name).toBe("delegate_task");
    const props = tool.definition.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.tasks).toBeDefined();
    const items = props.tasks.items as Record<string, Record<string, unknown>>;
    expect(items.required).toEqual(["goal"]);
    expect(items.properties.goal).toBeDefined();
    expect(props.action.enum).toEqual(["spawn", "list", "steer", "stop"]);
    expect(props.subagent_id).toBeDefined();
    expect(props.message).toBeDefined();
    // 描述含 Hermes 契约关键指引
    expect(tool.definition.description).toContain("USE FOR");
    expect(tool.definition.description).toContain("SELF-REPORTS");
  });

  it("action=list 返回运行列表", async () => {
    const out = JSON.parse((await tool.handler({ action: "list" })) as string);
    expect(out.success).toBe(true);
    expect(Array.isArray(out.runs)).toBe(true);
  });

  it("action=steer 缺参数报错", async () => {
    const out = JSON.parse((await tool.handler({ action: "steer" })) as string);
    expect(out.success).toBe(false);
    expect(out.error).toContain("subagent_id");
    const out2 = JSON.parse((await tool.handler({ action: "steer", subagent_id: "x" })) as string);
    expect(out2.success).toBe(false);
    expect(out2.error).toContain("message");
  });

  it("action=stop 对不存在的 id 报错", async () => {
    const out = JSON.parse((await tool.handler({ action: "stop", subagent_id: "nope" })) as string);
    expect(out.success).toBe(false);
    expect(out.error).toContain("not a running child");
  });

  it("spawn tasks[] 批量前台执行", async () => {
    const out = JSON.parse(
      (await tool.handler({
        tasks: [
          { goal: "a", context: "ctx-a" },
          { goal: "b", output_schema: { type: "object" } },
        ],
      })) as string,
    );
    expect(out.success).toBe(true);
    expect(out.status).toBe("completed");
    expect(out.runs.length).toBe(2);
    expect(out.results?.length).toBe(2);
    expect(out.results?.every((r: { status: string }) => r.status === "completed")).toBe(true);
    // 子代理 prompt 携带各自 context / 契约
    const msgs = h.calls.map((c) => c.message).join("\n---\n");
    expect(msgs).toContain("ctx-a");
    expect(msgs).toContain("【输出契约】");
  });

  it("spawn 遗留单 goal 形态包装为单条 batch", async () => {
    const out = JSON.parse(
      (await tool.handler({ goal: "legacy-task", context: "legacy-ctx" })) as string,
    );
    expect(out.success).toBe(true);
    expect(out.runs.length).toBe(1);
    expect(h.calls[0].message).toContain("legacy-task");
    expect(h.calls[0].message).toContain("legacy-ctx");
  });

  it("spawn 非法 tasks 被拒绝", async () => {
    const out = JSON.parse((await tool.handler({ tasks: [{ context: "no-goal" }] })) as string);
    expect(out.success).toBe(false);
    expect(out.error).toContain("goal is required");
  });

  it("spawn 既不给 tasks 也不给 goal 报错", async () => {
    const out = JSON.parse((await tool.handler({})) as string);
    expect(out.success).toBe(false);
    expect(out.error).toContain("tasks[]");
  });

  it("spawn 遗留 role/max_iterations 触发告警但不影响执行", async () => {
    const out = JSON.parse(
      (await tool.handler({ tasks: [{ goal: "g" }], role: "orchestrator", max_iterations: 999 })) as string,
    );
    expect(out.success).toBe(true);
    expect(out.warnings?.length).toBe(2);
    expect(out.warnings?.[0]).toContain("legacy");
  });

  it("spawn background=true 返回 dispatch 句柄", async () => {
    const out = JSON.parse((await tool.handler({ tasks: [{ goal: "bg" }], background: true })) as string);
    expect(out.success).toBe(true);
    expect(out.status).toBe("dispatched");
    expect(out.runs[0].status).toBe("running");
  });
});
