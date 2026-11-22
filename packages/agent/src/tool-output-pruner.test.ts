import { describe, it, expect } from "vitest";
import { ToolOutputPruner, type ToolMessage } from "./tool-output-pruner";

/**
 * R12（hermes compression archive 对齐）：
 * - exec 单行 JSON 摘要必须保留 exitCode/error 与 output 尾部；
 * - 摘要前归档原文并在 stub 里给出回读路径；
 * - 归档/摘要结果幂等（下一轮不得二次压缩，否则前缀缓存字节漂移）。
 */
describe("ToolOutputPruner — exec 摘要与归档", () => {
  const small = (i: number): ToolMessage => ({
    role: "tool",
    name: "file_read",
    content: `small result ${i}`,
  });

  it("exec JSON 摘要保留 exitCode 与 output 尾行，并附归档路径", () => {
    const output = "HEAD_MARKER\n" + "filler\n".repeat(800) + "TAIL_ERROR_MARKER";
    const big = JSON.stringify({ success: false, exitCode: 2, output, stderr: "boom" });
    const pruner = new ToolOutputPruner({ summaryThreshold: 100, keepRecentN: 1 });
    let archived = 0;

    const result = pruner.prune(
      [{ role: "tool", name: "shell_exec", content: big }, small(1)],
      {
        archive: () => {
          archived++;
          return "/tmp/pruned-archive.log";
        },
      },
    );

    expect(result.stats.summarized).toBe(1);
    const content = result.messages[0].content as string;
    expect(content).toContain('"exitCode":2');
    expect(content).toContain('"stderr":"boom"');
    expect(content).toContain("TAIL_ERROR_MARKER");
    expect(content).toContain("[Full output archived at: /tmp/pruned-archive.log");
    expect(content.length).toBeLessThan(big.length);
    expect(archived).toBe(1);
  });

  it("二次裁剪幂等：不再摘要、不再归档", () => {
    const big = JSON.stringify({ success: true, exitCode: 0, output: "x".repeat(6000) });
    const pruner = new ToolOutputPruner({ summaryThreshold: 100, keepRecentN: 1 });
    let archived = 0;
    const first = pruner.prune(
      [{ role: "tool", name: "shell_exec", content: big }, small(1)],
      { archive: () => { archived++; return "/tmp/a.log"; } },
    );

    const second = pruner.prune(first.messages, {
      archive: () => { archived++; return "/tmp/b.log"; },
    });

    expect(second.stats.summarized).toBe(0);
    expect(second.messages[0].content).toBe(first.messages[0].content);
    expect(archived).toBe(1);
  });

  it("archive 返回 null 时摘要照常输出（归档是 best-effort）", () => {
    const big = "y".repeat(5000);
    const pruner = new ToolOutputPruner({ summaryThreshold: 100, keepRecentN: 1 });
    const result = pruner.prune(
      [{ role: "tool", name: "web_fetch", content: big }, small(1)],
      { archive: () => null },
    );
    expect(result.stats.summarized).toBe(1);
    expect(result.messages[0].content as string).not.toContain("archived at:");
  });
});
