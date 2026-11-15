import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ToolResultPersistenceManager } from "./tool-result-persistence";

/**
 * 回归：per-result 落盘与 turn 级聚合预算（Layer 2/3）的接线行为。
 */
describe("ToolResultPersistenceManager", () => {
  const files: string[] = [];

  afterEach(() => {
    for (const file of files.splice(0)) {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
  });

  it("未超阈值不落盘，但计入统计", () => {
    const mgr = new ToolResultPersistenceManager({ defaultResultSizeChars: 100 });
    const result = mgr.maybePersistToolResult("short output", "shell_exec", "persist-test-short");

    expect(result.persisted).toBe(false);
    expect(result.content).toBe("short output");
    expect(mgr.getStats().maybePersistCalls).toBe(1);
    expect(mgr.getStats().persisted).toBe(0);
    expect(mgr.getStats().totalChars).toBe("short output".length);
  });

  it("超阈值落盘并返回 <persisted-output> 预览", () => {
    const mgr = new ToolResultPersistenceManager({
      defaultResultSizeChars: 50,
      previewSizeChars: 20,
    });
    const id = "persist-test-long";
    const content = "line\n".repeat(100);

    const result = mgr.maybePersistToolResult(content, "shell_exec", id);
    if (result.filePath) files.push(result.filePath);

    expect(result.persisted).toBe(true);
    expect(result.content).toContain("<persisted-output>");
    expect(result.filePath).toBeTruthy();
    expect(mgr.readPersistedResult(result.filePath!)).toBe(content);
    expect(mgr.getStats().persisted).toBe(1);
  });

  it("read_file 为 pinned 阈值，永不落盘（避免 persist→read→persist 死循环）", () => {
    const mgr = new ToolResultPersistenceManager({ defaultResultSizeChars: 10 });
    const result = mgr.maybePersistToolResult("x".repeat(500), "read_file", "persist-test-pinned");

    expect(result.persisted).toBe(false);
    expect(result.content).toHaveLength(500);
  });

  it("enforceTurnBudget 将最大的非持久化结果 spill 到磁盘", () => {
    const mgr = new ToolResultPersistenceManager({
      defaultResultSizeChars: 40,
      turnBudgetChars: 220,
      previewSizeChars: 10,
    });
    const id = "persist-test-turn-budget";
    files.push(path.join(mgr.getStorageDir(), `${id}.txt`));

    const result = mgr.enforceTurnBudget([
      { role: "tool", content: "y".repeat(400), tool_call_id: id, name: "shell_exec" },
    ]);

    // 单条 400 字超 220 预算 → 溢出为预览块（~200 字，含标签与文件路径），
    // 总量回到预算内，恰好一次，不下溢为 0。
    expect(result.spilled).toBe(1);
    expect(result.messages[0]?.content).toContain("<persisted-output>");
    expect(result.messages[0]?.content.length).toBeGreaterThan(0);
    expect(result.messages[0]?.content.length).toBeLessThan(400);
    expect(mgr.getStats().turns).toBe(1);
    expect(mgr.getStats().spilled).toBe(1);
  });
});
