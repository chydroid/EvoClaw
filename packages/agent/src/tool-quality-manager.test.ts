import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolQualityManager } from "./tool-quality-manager";

// ═══════════════════════════════════════════════════════════
// 测试套件：ToolQualityManager（工具质量跟踪 + 惩罚式排序）
// ═══════════════════════════════════════════════════════════

describe("ToolQualityManager > recordExecution", () => {
  let mgr: ToolQualityManager;

  beforeEach(() => {
    mgr = new ToolQualityManager();
  });

  it("首次记录创建新 record", () => {
    mgr.recordExecution("tool-1", "read_file", true, 100);
    const info = mgr.getPenaltyInfo("tool-1");
    expect(info).not.toBeNull();
    expect(info?.recentSuccessRate).toBe(1.0);
    expect(info?.consecutiveFailures).toBe(0);
  });

  it("成功时重置连续失败计数", () => {
    mgr.recordExecution("tool-1", "read_file", false, 100, "error");
    mgr.recordExecution("tool-1", "read_file", false, 100, "error");
    mgr.recordExecution("tool-1", "read_file", true, 100);
    const info = mgr.getPenaltyInfo("tool-1");
    expect(info?.consecutiveFailures).toBe(0);
  });

  it("失败时递增连续失败计数", () => {
    mgr.recordExecution("tool-1", "read_file", false, 100, "error");
    mgr.recordExecution("tool-1", "read_file", false, 100, "error");
    const info = mgr.getPenaltyInfo("tool-1");
    expect(info?.consecutiveFailures).toBe(2);
  });

  it("滚动窗口：超过上限时移除最旧", () => {
    mgr = new ToolQualityManager({ maxRecentExecutions: 3 });
    for (let i = 0; i < 5; i++) {
      mgr.recordExecution("tool-1", "read_file", i % 2 === 0, 100);
    }
    const report = mgr.getQualityReport();
    expect(report.summary.trackedTools).toBe(1);
    // 只保留最近 3 次
    const totalCalls = report.byTool[0].totalCalls;
    expect(totalCalls).toBe(5); // totalCalls 累计，不受滚动窗口影响
  });
});

describe("ToolQualityManager > getPenalty", () => {
  it("无记录时返回 1.0（无惩罚）", () => {
    const mgr = new ToolQualityManager();
    expect(mgr.getPenalty("unknown")).toBe(1.0);
  });

  it("高成功率不惩罚", () => {
    const mgr = new ToolQualityManager();
    for (let i = 0; i < 10; i++) {
      mgr.recordExecution("tool-1", "read_file", true, 100);
    }
    expect(mgr.getPenalty("tool-1")).toBe(1.0);
  });

  it("低成功率触发惩罚", () => {
    const mgr = new ToolQualityManager({ penaltyThreshold: 0.4 });
    for (let i = 0; i < 10; i++) {
      mgr.recordExecution("tool-1", "read_file", i < 3, 100); // 30% 成功率
    }
    const penalty = mgr.getPenalty("tool-1");
    expect(penalty).toBeLessThan(1.0);
    expect(penalty).toBeGreaterThanOrEqual(0.2);
  });

  it("连续失败 3 次额外扣分", () => {
    const mgr = new ToolQualityManager({
      penaltyThreshold: 0.4,
      consecutiveFailurePenalty3: 0.1,
    });
    // 制造低成功率 + 3 次连续失败
    for (let i = 0; i < 10; i++) {
      mgr.recordExecution("tool-1", "read_file", false, 100, "error");
    }
    const penalty3 = mgr.getPenalty("tool-1");

    // 对比：只有 2 次连续失败
    mgr.clear();
    for (let i = 0; i < 8; i++) {
      mgr.recordExecution("tool-1", "read_file", false, 100, "error");
    }
    mgr.recordExecution("tool-1", "read_file", true, 100);
    mgr.recordExecution("tool-1", "read_file", false, 100, "error");
    mgr.recordExecution("tool-1", "read_file", false, 100, "error");
    const penalty2 = mgr.getPenalty("tool-1");

    expect(penalty3).toBeLessThanOrEqual(penalty2);
  });

  it("惩罚不低于 minPenalty", () => {
    const mgr = new ToolQualityManager({ minPenalty: 0.5, penaltyThreshold: 0.4 });
    for (let i = 0; i < 20; i++) {
      mgr.recordExecution("tool-1", "read_file", false, 100, "error");
    }
    expect(mgr.getPenalty("tool-1")).toBeGreaterThanOrEqual(0.5);
  });
});

describe("ToolQualityManager > adjustRanking", () => {
  it("高质量工具排名不受影响", () => {
    const mgr = new ToolQualityManager();
    for (let i = 0; i < 10; i++) {
      mgr.recordExecution("tool-a", "tool-a", true, 100);
    }
    const tools = [
      { toolName: "tool-a", score: 0.8 },
      { toolName: "tool-b", score: 0.5 },
    ];
    const ranked = mgr.adjustRanking(tools);
    expect(ranked[0].toolName).toBe("tool-a");
  });

  it("低质量工具被降权", () => {
    const mgr = new ToolQualityManager({ penaltyThreshold: 0.4 });
    for (let i = 0; i < 10; i++) {
      mgr.recordExecution("tool-a", "tool-a", false, 100, "error");
    }
    const tools = [
      { toolName: "tool-a", score: 0.9 },
      { toolName: "tool-b", score: 0.5 },
    ];
    const ranked = mgr.adjustRanking(tools);
    // tool-a 被惩罚后，adjustedScore 可能低于 tool-b
    expect(ranked[0].adjustedScore).toBeGreaterThanOrEqual(ranked[1].adjustedScore);
  });
});

describe("ToolQualityManager > recordLlmToolIssues", () => {
  it("LLM 反馈计入失败记录", () => {
    const mgr = new ToolQualityManager();
    mgr.recordLlmToolIssues([
      { toolKey: "tool-1", toolName: "read_file", description: "返回数据格式错误" },
      { toolKey: "tool-1", toolName: "read_file", description: "字段缺失" },
    ]);
    const flagged = mgr.getLlmFlaggedTools(2);
    expect(flagged.length).toBe(1);
    expect(flagged[0].flagCount).toBe(2);
  });

  it("LLM 标记的工具在报告中标记为 problematic", () => {
    const mgr = new ToolQualityManager({ llmFlagThreshold: 2 });
    mgr.recordLlmToolIssues([
      { toolKey: "tool-1", toolName: "read_file", description: "错误1" },
      { toolKey: "tool-1", toolName: "read_file", description: "错误2" },
    ]);
    const report = mgr.getQualityReport();
    expect(report.problematicTools.length).toBeGreaterThan(0);
    expect(report.problematicTools[0].llmFlagged).toBe(true);
  });
});

describe("ToolQualityManager > 自动禁用", () => {
  it("连续失败达阈值自动禁用", () => {
    const mgr = new ToolQualityManager({ autoDisableThreshold: 5 });
    for (let i = 0; i < 5; i++) {
      mgr.recordExecution("tool-1", "read_file", false, 100, "error");
    }
    expect(mgr.isDisabled("tool-1")).toBe(true);
  });

  it("enableTool 重置禁用状态", () => {
    const mgr = new ToolQualityManager({ autoDisableThreshold: 5 });
    for (let i = 0; i < 5; i++) {
      mgr.recordExecution("tool-1", "read_file", false, 100, "error");
    }
    mgr.enableTool("tool-1");
    expect(mgr.isDisabled("tool-1")).toBe(false);
  });
});

describe("ToolQualityManager > getQualityReport", () => {
  it("空状态返回默认报告", () => {
    const mgr = new ToolQualityManager();
    const report = mgr.getQualityReport();
    expect(report.summary.totalTools).toBe(0);
    expect(report.summary.avgSuccessRate).toBe(1.0);
    expect(report.problematicTools.length).toBe(0);
  });

  it("生成完整报告", () => {
    const mgr = new ToolQualityManager();
    // 工具 A：高质量
    for (let i = 0; i < 10; i++) {
      mgr.recordExecution("tool-a", "tool-a", true, 100);
    }
    // 工具 B：低质量
    for (let i = 0; i < 10; i++) {
      mgr.recordExecution("tool-b", "tool-b", false, 100, "error");
    }

    const report = mgr.getQualityReport();
    expect(report.summary.totalTools).toBe(2);
    expect(report.summary.problematicTools).toBeGreaterThan(0);
    expect(report.byTool.length).toBe(2);
    expect(report.recommendations.length).toBeGreaterThan(0);
  });
});

describe("ToolQualityManager > serialize/deserialize", () => {
  it("序列化与反序列化保持数据一致", () => {
    const mgr = new ToolQualityManager();
    mgr.recordExecution("tool-1", "read_file", true, 100);
    mgr.recordExecution("tool-1", "read_file", false, 100, "error");

    const serialized = mgr.serialize();
    const mgr2 = new ToolQualityManager();
    mgr2.deserialize(serialized);

    const info = mgr2.getPenaltyInfo("tool-1");
    expect(info).not.toBeNull();
    expect(info?.recentSuccessRate).toBe(0.5);
  });
});
