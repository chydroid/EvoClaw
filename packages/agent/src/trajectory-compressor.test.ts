/**
 * TrajectoryCompressor 测试 — 对标 Hermes trajectory_compressor.py 核心算法。
 *
 * 验证：
 * - 低于预算 → 跳过（skippedUnderTarget）
 * - 头部保护（第一条 system/human/gpt/tool 不被压缩）
 * - 尾部保护（最后 N 轮不被压缩）
 * - 中间压缩：累积 token 直到覆盖超额 + 摘要本身
 * - 边界对齐：不在 tool 轮上切分（不拆分 gpt tool_call/tool response 对）
 * - 摘要生成：LLM 调用 + 重试 + fallback
 * - 组装：头部（追加 summary notice）+ 摘要 human 轮 + 尾部
 */

import { describe, it, expect, vi } from "vitest";
import { TrajectoryCompressor, type TrajectoryCompressionConfig } from "./trajectory-compressor";
import type { LLMMessage } from "./llm-caller";

function makeTrajectory(opts: {
  systemTurns?: number;
  assistantTurns?: number;
  toolTurns?: number;
  userTurns?: number;
  contentSize?: number;
}): LLMMessage[] {
  const trajectory: LLMMessage[] = [];
  const contentSize = opts.contentSize ?? 100;

  // system
  for (let i = 0; i < (opts.systemTurns ?? 1); i++) {
    trajectory.push({ role: "system", content: `System prompt ${i}. ` + "x".repeat(contentSize) });
  }
  // user
  for (let i = 0; i < (opts.userTurns ?? 1); i++) {
    trajectory.push({ role: "user", content: `User message ${i}. ` + "y".repeat(contentSize) });
  }
  // assistant + tool pairs
  for (let i = 0; i < (opts.assistantTurns ?? 3); i++) {
    trajectory.push({ role: "assistant", content: `Assistant reply ${i}. ` + "z".repeat(contentSize) });
    if (opts.toolTurns && i < opts.toolTurns) {
      trajectory.push({ role: "tool", content: `Tool result ${i}. ` + "t".repeat(contentSize), tool_call_id: `call_${i}` });
    }
  }
  return trajectory;
}

const baseConfig: Partial<TrajectoryCompressionConfig> = {
  targetMaxTokens: 500,
  summaryTargetTokens: 50,
  protectLastNTurns: 2,
  maxRetries: 2,
  retryDelay: 0,
};

describe("TrajectoryCompressor", () => {
  it("低于预算 → 跳过（skippedUnderTarget）", async () => {
    const compressor = new TrajectoryCompressor({ targetMaxTokens: 100000, summaryTargetTokens: 50 });
    const traj = makeTrajectory({ contentSize: 10 });
    const summarizer = vi.fn(async () => "[CONTEXT SUMMARY]: test");
    const result = await compressor.compress(traj, summarizer);
    expect(result.metrics.skippedUnderTarget).toBe(true);
    expect(result.metrics.wasCompressed).toBe(false);
    expect(summarizer).not.toHaveBeenCalled();
    expect(result.trajectory).toEqual(traj);
  });

  it("头部保护：第一条 system/human/gpt/tool 不被压缩", async () => {
    const compressor = new TrajectoryCompressor({
      targetMaxTokens: 500,
      summaryTargetTokens: 50,
      protectLastNTurns: 0, // 不保护尾部，测试头部保护
    });
    // 大内容使总 token 超过预算
    const traj = makeTrajectory({ systemTurns: 1, userTurns: 1, assistantTurns: 5, contentSize: 200 });
    const summarizer = vi.fn(async () => "[CONTEXT SUMMARY]: test summary");
    const result = await compressor.compress(traj, summarizer);

    expect(result.metrics.wasCompressed).toBe(true);
    // 第一条 system 应保留
    expect(result.trajectory[0].role).toBe("system");
    expect(result.trajectory[0].content).toContain("System prompt 0");
    // 第一条 user 应保留
    expect(result.trajectory.find(m => m.role === "user" && m.content.includes("User message 0"))).toBeDefined();
  });

  it("尾部保护：最后 N 轮不被压缩", async () => {
    const compressor = new TrajectoryCompressor({
      targetMaxTokens: 500,
      summaryTargetTokens: 50,
      protectLastNTurns: 3,
    });
    const traj = makeTrajectory({ systemTurns: 1, userTurns: 1, assistantTurns: 8, contentSize: 200 });
    const summarizer = vi.fn(async () => "[CONTEXT SUMMARY]: test summary");
    const result = await compressor.compress(traj, summarizer);

    expect(result.metrics.wasCompressed).toBe(true);
    // 最后 3 轮应保留（assistant + tool pairs）
    const lastThree = result.trajectory.slice(-3);
    expect(lastThree.length).toBe(3);
    // 尾部内容应与原始轨迹尾部一致
    expect(lastThree[0].content).toContain("Assistant reply");
  });

  it("中间压缩：累积 token 直到覆盖超额 + 摘要", async () => {
    const compressor = new TrajectoryCompressor({
      targetMaxTokens: 500,
      summaryTargetTokens: 50,
      protectLastNTurns: 2,
    });
    const traj = makeTrajectory({ systemTurns: 1, userTurns: 1, assistantTurns: 10, contentSize: 150 });
    const summarizer = vi.fn(async () => "[CONTEXT SUMMARY]: compressed middle turns");
    const result = await compressor.compress(traj, summarizer);

    expect(result.metrics.wasCompressed).toBe(true);
    expect(result.metrics.turnsRemoved).toBeGreaterThan(0);
    expect(result.metrics.tokensSaved).toBeGreaterThan(0);
    // 摘要轮应存在
    const summaryMsg = result.trajectory.find(m => m.role === "user" && m.content.includes("[CONTEXT SUMMARY]"));
    expect(summaryMsg).toBeDefined();
  });

  it("边界对齐：不在 tool 轮上切分", async () => {
    const compressor = new TrajectoryCompressor({
      targetMaxTokens: 500,
      summaryTargetTokens: 50,
      protectLastNTurns: 0,
    });
    // 构造 assistant + tool 交替的轨迹
    const traj: LLMMessage[] = [
      { role: "system", content: "System. " + "x".repeat(50) },
      { role: "user", content: "User. " + "y".repeat(50) },
      // 大量 assistant + tool pairs
      ...Array.from({ length: 20 }, (_, i) => [
        { role: "assistant", content: `Reply ${i}. ` + "z".repeat(100) },
        { role: "tool", content: `Result ${i}. ` + "t".repeat(100), tool_call_id: `call_${i}` },
      ]).flat() as LLMMessage[],
    ];
    const summarizer = vi.fn(async () => "[CONTEXT SUMMARY]: test");
    const result = await compressor.compress(traj, summarizer);

    expect(result.metrics.wasCompressed).toBe(true);
    // 压缩后，tool 轮不应出现在摘要轮之后（边界已对齐）
    const summaryIdx = result.trajectory.findIndex(m => m.role === "user" && m.content.includes("[CONTEXT SUMMARY]"));
    expect(summaryIdx).toBeGreaterThan(0);
    // summary 之后的第一条不应是 tool（应是 assistant 或尾部）
    const afterSummary = result.trajectory.slice(summaryIdx + 1);
    if (afterSummary.length > 0) {
      expect(afterSummary[0].role).not.toBe("tool");
    }
  });

  it("摘要生成：LLM 调用 + 重试 + fallback", async () => {
    const compressor = new TrajectoryCompressor({
      targetMaxTokens: 500,
      summaryTargetTokens: 50,
      protectLastNTurns: 2,
      maxRetries: 2,
      retryDelay: 0,
    });
    const traj = makeTrajectory({ systemTurns: 1, userTurns: 1, assistantTurns: 8, toolTurns: 8, contentSize: 300 });

    // 第一次失败，第二次成功
    const summarizer = vi.fn()
      .mockRejectedValueOnce(new Error("LLM timeout"))
      .mockResolvedValueOnce("[CONTEXT SUMMARY]: recovered summary");
    const result = await compressor.compress(traj, summarizer);
    expect(result.metrics.wasCompressed).toBe(true);
    expect(result.metrics.summarizationApiCalls).toBe(2);
    expect(result.metrics.summarizationErrors).toBe(1);
    expect(result.trajectory.some(m => m.content.includes("recovered summary"))).toBe(true);

    // 全部失败 → fallback
    const summarizer2 = vi.fn().mockRejectedValue(new Error("LLM always fails"));
    const result2 = await compressor.compress(traj, summarizer2);
    expect(result2.metrics.wasCompressed).toBe(true);
    expect(result2.metrics.summarizationErrors).toBe(2);
    expect(result2.trajectory.some(m => m.content.includes("Summary generation failed"))).toBe(true);
  });

  it("组装：头部追加 summary notice", async () => {
    const compressor = new TrajectoryCompressor({
      targetMaxTokens: 500,
      summaryTargetTokens: 50,
      protectLastNTurns: 0,
      addSummaryNotice: true,
      summaryNoticeText: "\n\n[SUMMARIZED]",
    });
    const traj = makeTrajectory({ systemTurns: 1, userTurns: 1, assistantTurns: 10, toolTurns: 10, contentSize: 300 });
    const summarizer = vi.fn(async () => "[CONTEXT SUMMARY]: test");
    const result = await compressor.compress(traj, summarizer);

    expect(result.metrics.wasCompressed).toBe(true);
    // 第一条 system 应包含 summary notice
    expect(result.trajectory[0].content).toContain("[SUMMARIZED]");
  });

  it("摘要无前缀时自动添加", async () => {
    const compressor = new TrajectoryCompressor({
      targetMaxTokens: 500,
      summaryTargetTokens: 50,
      protectLastNTurns: 0,
    });
    const traj = makeTrajectory({ systemTurns: 1, userTurns: 1, assistantTurns: 10, toolTurns: 10, contentSize: 300 });
    const summarizer = vi.fn(async () => "This is a summary without prefix");
    const result = await compressor.compress(traj, summarizer);

    expect(result.metrics.wasCompressed).toBe(true);
    expect(result.trajectory.some(m => m.content.startsWith("[CONTEXT SUMMARY]: This is a summary"))).toBe(true);
  });

  it("可压缩区域过小（< 摘要大小）→ 不压缩", async () => {
    const compressor = new TrajectoryCompressor({
      targetMaxTokens: 500,
      summaryTargetTokens: 10000, // 摘要比可压缩区域还大
      protectLastNTurns: 0,
    });
    const traj = makeTrajectory({ systemTurns: 1, userTurns: 1, assistantTurns: 2, contentSize: 50 });
    const summarizer = vi.fn(async () => "[CONTEXT SUMMARY]: test");
    const result = await compressor.compress(traj, summarizer);

    // 要么跳过（预算内），要么不压缩（区域太小）
    expect(result.metrics.wasCompressed).toBe(false);
  });
});
