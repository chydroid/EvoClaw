import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ToolResultPersistenceManager, generatePreview } from "./tool-result-persistence";

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

  it("generatePreview 保留头尾（失败原因在 JSON 尾部也不丢）", () => {
    const content = "HEAD\n" + "x".repeat(3000) + "\nTAIL: exitCode=1";
    const { preview, hasMore } = generatePreview(content, 500);
    expect(hasMore).toBe(true);
    expect(preview).toContain("HEAD");
    expect(preview).toContain("TAIL: exitCode=1");
    expect(preview).toContain("chars elided");
  });

  it("JSON exec 结果落盘为可按行分页的全文（元数据 + output 区块）", () => {
    const mgr = new ToolResultPersistenceManager({
      defaultResultSizeChars: 100,
      previewSizeChars: 120,
    });
    const id = "persist-test-json-pageable";
    const output = "line-" + "y".repeat(9000) + "\nTAIL: FAIL";
    const content = JSON.stringify({ success: false, exitCode: 1, output, error: "boom" });

    const result = mgr.maybePersistToolResult(content, "shell_exec", id);
    if (result.filePath) files.push(result.filePath);

    expect(result.persisted).toBe(true);
    expect(result.content).toContain("exitCode: 1");
    expect(result.content).toContain("TAIL: FAIL");

    const onDisk = mgr.readPersistedResult(result.filePath!)!;
    expect(onDisk).toContain("success: false");
    expect(onDisk).toContain("exitCode: 1");
    expect(onDisk).toContain("--- output");
    expect(onDisk).toContain("--- error ---\nboom");
    expect(onDisk).toContain("TAIL: FAIL");
    // 单行按 1800 字符切开 → file_read 的 offset/limit 可连续翻页
    expect(onDisk.split("\n").every((line) => line.length <= 1800)).toBe(true);
  });

  it("exec 落盘预览的尾部取 output 尾行，而非 stderr/error 元数据", () => {
    const mgr = new ToolResultPersistenceManager({
      defaultResultSizeChars: 100,
      previewSizeChars: 2000,
    });
    const id = "persist-test-exec-tail";
    const output = "HEAD_MARKER\n" + "filler line\n".repeat(2000) + "TAIL_OUTPUT_MARKER: build failed";
    const content = JSON.stringify({
      success: false,
      exitCode: 2,
      output,
      stderr: "warning: " + "s".repeat(3000),
      error: "build failed",
    });

    const result = mgr.maybePersistToolResult(content, "shell_exec", id);
    if (result.filePath) files.push(result.filePath);

    expect(result.persisted).toBe(true);
    expect(result.content).toContain("HEAD_MARKER");
    expect(result.content).toContain("TAIL_OUTPUT_MARKER: build failed");
    expect(result.content).toContain("chars elided");
    // 尾部窗口必须是 output 的最后一行，而不是 stderr 区块
    const previewPart = result.content.slice(0, result.content.indexOf("[Full output"));
    expect(previewPart.indexOf("TAIL_OUTPUT_MARKER")).toBeGreaterThan(previewPart.indexOf("chars elided"));
  });

  it("read_file 为 pinned 阈值，永不落盘（避免 persist→read→persist 死循环）", () => {    const mgr = new ToolResultPersistenceManager({ defaultResultSizeChars: 10 });
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
