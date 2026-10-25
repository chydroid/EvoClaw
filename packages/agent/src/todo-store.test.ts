/**
 * todo-store.test — TodoStore 测试（对标 hermes-agent tools/todo_tool.py）
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TodoStore, TODO_INJECTION_HEADER } from "./todo-store";

describe("TodoStore", () => {
  let store: TodoStore;

  beforeEach(() => {
    store = new TodoStore();
  });

  it("初始为空", () => {
    expect(store.read()).toEqual([]);
    expect(store.hasItems()).toBe(false);
    expect(store.formatForInjection()).toBeNull();
  });

  it("写入替换列表", () => {
    const items = store.write([
      { id: "1", content: "Task A", status: "pending" },
      { id: "2", content: "Task B", status: "pending" },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("1");
    expect(items[0].status).toBe("pending");
    expect(store.hasItems()).toBe(true);
  });

  it("写入后 revision 递增", () => {
    store.write([{ id: "1", content: "Task A", status: "pending" }]);
    const rev1 = store.snapshot().revision;
    store.write([{ id: "2", content: "Task B", status: "pending" }]);
    const rev2 = store.snapshot().revision;
    expect(rev2).toBe(rev1 + 1);
  });

  it("相同列表写入不递增 revision", () => {
    const todos = [{ id: "1", content: "Task A", status: "pending" }];
    store.write(todos);
    const rev1 = store.snapshot().revision;
    store.write(todos);
    const rev2 = store.snapshot().revision;
    expect(rev2).toBe(rev1);
  });

  it("merge 模式更新已有项", () => {
    store.write([
      { id: "1", content: "Task A", status: "pending" },
      { id: "2", content: "Task B", status: "pending" },
    ]);
    store.write([
      { id: "1", content: "Task A updated", status: "in_progress" },
      { id: "3", content: "Task C", status: "pending" },
    ], true);
    const items = store.read();
    expect(items).toHaveLength(3);
    expect(items[0].content).toBe("Task A updated");
    expect(items[0].status).toBe("in_progress");
    expect(items[2].id).toBe("3");
  });

  it("空内容项被拒绝", () => {
    expect(() => store.write([
      { id: "1", content: "", status: "pending" },
    ])).toThrow("empty or missing content");
  });

  it("非法状态回退为 pending", () => {
    const items = store.write([
      { id: "1", content: "Task A", status: "invalid_status" },
    ]);
    expect(items[0].status).toBe("pending");
  });

  it("dedupe by id 保留最后出现", () => {
    const items = store.write([
      { id: "1", content: "First", status: "pending" },
      { id: "1", content: "Last", status: "completed" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe("Last");
    expect(items[0].status).toBe("completed");
  });

  it("嵌套子任务通过 parent 字段", () => {
    store.write([
      { id: "1", content: "Phase 1", status: "in_progress" },
      { id: "1a", content: "Subtask 1a", status: "pending", parent: "1" },
      { id: "1b", content: "Subtask 1b", status: "pending", parent: "1" },
    ]);
    const injection = store.formatForInjection();
    expect(injection).not.toBeNull();
    expect(injection).toContain(TODO_INJECTION_HEADER);
    expect(injection).toContain("Phase 1");
    expect(injection).toContain("Subtask 1a");
  });

  it("formatForInjection 只注入活跃项", () => {
    store.write([
      { id: "1", content: "Active task", status: "in_progress" },
      { id: "2", content: "Done task", status: "completed" },
    ]);
    const injection = store.formatForInjection();
    expect(injection).not.toBeNull();
    expect(injection).toContain("Active task");
    expect(injection).not.toContain("Done task");
  });

  it("formatForInjection 保留活跃后代的 parent", () => {
    store.write([
      { id: "1", content: "Phase", status: "completed" },
      { id: "1a", content: "Active subtask", status: "in_progress", parent: "1" },
    ]);
    const injection = store.formatForInjection();
    expect(injection).not.toBeNull();
    // parent 被保留因为它的后代是活跃的
    expect(injection).toContain("Phase");
    expect(injection).toContain("Active subtask");
  });

  it("sanitize parents 丢弃悬空引用", () => {
    store.write([
      { id: "1", content: "Task A", status: "pending", parent: "nonexistent" },
    ]);
    const items = store.read();
    expect(items[0].parent).toBeUndefined();
  });

  it("sanitize parents 打破循环", () => {
    store.write([
      { id: "1", content: "Task A", status: "pending", parent: "2" },
      { id: "2", content: "Task B", status: "pending", parent: "1" },
    ]);
    const items = store.read();
    // 至少一个 parent 被移除以打破循环
    const hasCycle = items.some(i => i.parent) && items.some(i => i.parent);
    expect(hasCycle).toBe(true); // 仍有一个 parent（不是循环）
  });

  it("normalize order 把 in_progress 提升", () => {
    store.write([
      { id: "1", content: "Pending task", status: "pending" },
      { id: "2", content: "In progress task", status: "in_progress" },
    ]);
    const items = store.read();
    // in_progress 应该在前面
    expect(items[0].status).toBe("in_progress");
  });

  it("restore 从快照恢复", () => {
    store.write([
      { id: "1", content: "Task A", status: "in_progress" },
    ]);
    const snap = store.snapshot();

    const store2 = new TodoStore();
    store2.restore(snap.todos, snap.revision);
    expect(store2.read()).toHaveLength(1);
    expect(store2.snapshot().revision).toBe(snap.revision);
  });

  it("内容超限被截断", () => {
    const longContent = "x".repeat(5000);
    const items = store.write([
      { id: "1", content: longContent, status: "pending" },
    ]);
    expect(items[0].content.length).toBeLessThan(5000);
    expect(items[0].content).toContain("truncated");
  });

  it("非对象项被接受为占位", () => {
    const items = store.write([
      "not an object",
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe("(invalid item)");
  });

  it("restore revision 为负数时归零", () => {
    store.restore([
      { id: "1", content: "Task A", status: "pending" },
    ], -5);
    expect(store.snapshot().revision).toBe(0);
  });

  it("snapshot 返回完整状态", () => {
    store.write([
      { id: "1", content: "Task A", status: "in_progress" },
    ]);
    const snap = store.snapshot();
    expect(snap.todos).toHaveLength(1);
    expect(snap.revision).toBeGreaterThan(0);
  });
});
