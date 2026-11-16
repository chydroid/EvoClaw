import { describe, it, expect } from "vitest";
import { registerTodoTools } from "../src/tools/todo-tools";

/**
 * todo_list 参数契约回归（2026-11-16）。
 *
 * 事故：`todos` 参数标了 `required: true`，但工具描述与实现都支持
 * 「无参数读取当前列表」。flat schema（无顶层 required 数组）走逐属性
 * 启发式，required:true 会让读取模式在校验层被拒：
 * Missing required parameter "todos" for tool "todo_list"。
 *
 * 修复：`todos.required` 改为 false，读写模式的区分留在 handler 内。
 */

interface Captured {
  definition: { parameters: Record<string, Record<string, unknown>> };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

let seq = 0;

function mount(): Captured {
  let captured: Captured | undefined;
  const sessionId = `sess-todo-test-${++seq}`;
  const executor = {
    registerTool(
      _name: string,
      definition: Captured["definition"],
      handler: Captured["handler"],
    ) {
      captured = { definition, handler };
    },
  } as never;
  registerTodoTools({ executor, getSessionId: () => sessionId });
  if (!captured) throw new Error("todo_list 未注册");
  return captured;
}

describe("todo_list 参数契约", () => {
  it("todos 为非必填（读取模式不被校验层拒绝）", () => {
    const { definition } = mount();
    expect(definition.parameters.todos.required).toBe(false);
  });

  it("merge 为非必填布尔参数", () => {
    const { definition } = mount();
    expect(definition.parameters.merge.required).not.toBe(true);
    expect(definition.parameters.merge.type).toBe("boolean");
  });

  it("读取模式（无参数）返回当前列表", async () => {
    const { handler } = mount();
    const out = JSON.parse(String(await handler({})));
    expect(out.success).toBe(true);
    expect(Array.isArray(out.todos)).toBe(true);
  });

  it("写入模式返回完整列表与 summary", async () => {
    const { handler } = mount();
    const out = JSON.parse(
      String(await handler({ todos: [{ id: "1", content: "写测试", status: "pending" }] })),
    );
    expect(out.success).toBe(true);
    expect(out.todos).toHaveLength(1);
    expect(out.summary.total).toBe(1);
  });
});
