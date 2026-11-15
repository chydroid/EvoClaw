import { describe, it, expect, beforeEach, vi } from "vitest";
import { EvolutionTriggers, type LlmConfirmationFn } from "./evolution-triggers";
import type { ToolQualityReport } from "@evoclaw/agent";

// ═══════════════════════════════════════════════════════════
// 测试套件：EvolutionTriggers（三触发器演化）
// ═══════════════════════════════════════════════════════════

describe("EvolutionTriggers > post-analysis trigger", () => {
  let triggers: EvolutionTriggers;

  beforeEach(() => {
    triggers = new EvolutionTriggers();
    triggers.startTask("task-1");
  });

  it("无建议时返回空数组", async () => {
    const result = await triggers.processAnalysis({});
    expect(result).toEqual([]);
  });

  it("接受 LLM 确认的建议", async () => {
    const confirmFn: LlmConfirmationFn = vi.fn().mockResolvedValue({ confirmed: true, reason: "OK" });
    triggers.setLlmConfirmFn(confirmFn);

    const result = await triggers.processAnalysis({
      suggestions: [
        {
          type: "fix",
          targetSkillIds: ["skill-1"],
          reason: "bug fix",
          proposedChange: "patch",
        },
      ],
    });

    expect(result.length).toBe(1);
    expect(result[0].llmConfirmed).toBe(true);
    expect(result[0].triggeredBy).toBe("post-analysis");
    expect(confirmFn).toHaveBeenCalledTimes(1);
  });

  it("拒绝 LLM 未确认的建议", async () => {
    const confirmFn: LlmConfirmationFn = vi.fn().mockResolvedValue({ confirmed: false, reason: "no" });
    triggers.setLlmConfirmFn(confirmFn);

    const result = await triggers.processAnalysis({
      suggestions: [
        {
          type: "fix",
          targetSkillIds: ["skill-1"],
          reason: "bug fix",
          proposedChange: "patch",
        },
      ],
    });

    expect(result.length).toBe(0);
  });

  it("超过最大演化次数时停止", async () => {
    triggers = new EvolutionTriggers({ maxEvolutionIterations: 2 });
    triggers.startTask("task-1");

    const confirmFn: LlmConfirmationFn = vi.fn().mockResolvedValue({ confirmed: true, reason: "OK" });
    triggers.setLlmConfirmFn(confirmFn);

    // 前两次通过
    await triggers.processAnalysis({ suggestions: [{ type: "fix", targetSkillIds: [], reason: "r", proposedChange: "" }] });
    await triggers.processAnalysis({ suggestions: [{ type: "fix", targetSkillIds: [], reason: "r", proposedChange: "" }] });

    // 第三次应被拒绝
    const result = await triggers.processAnalysis({ suggestions: [{ type: "fix", targetSkillIds: [], reason: "r", proposedChange: "" }] });
    expect(result.length).toBe(0);
  });
});

describe("EvolutionTriggers > tool-degradation trigger", () => {
  it("低成功率工具触发演化", async () => {
    const triggers = new EvolutionTriggers({ toolDegradationThreshold: 0.4 });
    triggers.startTask("task-1");
    triggers.setLlmConfirmFn(async () => ({ confirmed: true, reason: "OK" }));

    const report: ToolQualityReport = {
      summary: { totalTools: 1, trackedTools: 1, avgSuccessRate: 0.3, problematicTools: 1 },
      byTool: [],
      problematicTools: [
        {
          toolKey: "tool-1",
          penalty: 0.5,
          recentSuccessRate: 0.2,
          consecutiveFailures: 5,
          llmFlagged: false,
          reasons: ["low success rate"],
        },
      ],
      recommendations: [],
    };

    const result = await triggers.processToolDegradation(report);
    expect(result.length).toBe(1);
    expect(result[0].triggeredBy).toBe("tool-degradation");
    expect(result[0].triggerMetrics?.successRate).toBe(0.2);
  });

  it("高成功率工具不触发", async () => {
    const triggers = new EvolutionTriggers({ toolDegradationThreshold: 0.4 });
    triggers.startTask("task-1");

    const report: ToolQualityReport = {
      summary: { totalTools: 1, trackedTools: 1, avgSuccessRate: 0.9, problematicTools: 0 },
      byTool: [],
      problematicTools: [],
      recommendations: [],
    };

    const result = await triggers.processToolDegradation(report);
    expect(result.length).toBe(0);
  });

  it("防循环：去重窗口内不重复触发", async () => {
    const triggers = new EvolutionTriggers({
      toolDegradationThreshold: 0.4,
      dedupWindowMs: 60_000,
    });
    triggers.startTask("task-1");
    triggers.setLlmConfirmFn(async () => ({ confirmed: true, reason: "OK" }));

    const report: ToolQualityReport = {
      summary: { totalTools: 1, trackedTools: 1, avgSuccessRate: 0.2, problematicTools: 1 },
      byTool: [],
      problematicTools: [
        {
          toolKey: "tool-1",
          penalty: 0.5,
          recentSuccessRate: 0.2,
          consecutiveFailures: 5,
          llmFlagged: false,
          reasons: ["low"],
        },
      ],
      recommendations: [],
    };

    // 第一次触发
    const r1 = await triggers.processToolDegradation(report);
    expect(r1.length).toBe(1);

    // 第二次在去重窗口内：不触发
    const r2 = await triggers.processToolDegradation(report);
    expect(r2.length).toBe(0);
  });
});

describe("EvolutionTriggers > metric-monitor trigger", () => {
  it("应用次数足够但完成率低触发演化", async () => {
    const triggers = new EvolutionTriggers({
      metricMonitorMinSelections: 5,
      metricMonitorLowCompletionThreshold: 0.35,
    });
    triggers.startTask("task-1");
    triggers.setLlmConfirmFn(async () => ({ confirmed: true, reason: "OK" }));

    const result = await triggers.processMetricCheck([
      {
        skillId: "skill-1",
        skillName: "my-skill",
        selections: 10,
        applied: 10,
        completions: 2, // 20% 完成率
        fallbacks: 5,
      },
    ]);

    expect(result.length).toBe(1);
    expect(result[0].triggeredBy).toBe("metric-monitor");
    expect(result[0].triggerMetrics?.completionRate).toBeCloseTo(0.2, 5);
  });

  it("应用次数不足不触发", async () => {
    const triggers = new EvolutionTriggers({ metricMonitorMinSelections: 5 });
    triggers.startTask("task-1");

    const result = await triggers.processMetricCheck([
      {
        skillId: "skill-1",
        skillName: "my-skill",
        selections: 3,
        applied: 3,
        completions: 0,
        fallbacks: 0,
      },
    ]);

    expect(result.length).toBe(0);
  });

  it("完成率达标不触发", async () => {
    const triggers = new EvolutionTriggers({
      metricMonitorMinSelections: 5,
      metricMonitorLowCompletionThreshold: 0.35,
    });
    triggers.startTask("task-1");

    const result = await triggers.processMetricCheck([
      {
        skillId: "skill-1",
        skillName: "my-skill",
        selections: 10,
        applied: 10,
        completions: 8, // 80% 完成率
        fallbacks: 1,
      },
    ]);

    expect(result.length).toBe(0);
  });
});

describe("EvolutionTriggers > getStats", () => {
  it("返回正确的统计信息", async () => {
    const triggers = new EvolutionTriggers();
    triggers.startTask("task-1");
    triggers.setLlmConfirmFn(async () => ({ confirmed: true, reason: "OK" }));

    await triggers.processAnalysis({
      suggestions: [{ type: "fix", targetSkillIds: [], reason: "r", proposedChange: "" }],
    });

    const stats = triggers.getStats();
    expect(stats.evolutionIterations).toBe(1);
    expect(stats.currentTaskId).toBe("task-1");
  });
});
