import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EvolutionCoordinator } from "./evolution-coordinator";
import { SkillQualityStore } from "./skill-quality-store";
import type { ExecutionAnalysis, EvolutionSuggestion } from "@evoclaw/skills";

function analysis(taskId: string, suggestion?: EvolutionSuggestion): ExecutionAnalysis {
  return {
    taskId,
    taskCompleted: false,
    executionNote: "tool failed",
    skillJudgments: [
      { skillId: "demo-id", skillName: "demo", skillApplied: true, note: "tried but failed" },
    ],
    suggestions: suggestion ? [suggestion] : [],
    toolIssues: [{ toolKey: "shell_exec", toolName: "shell_exec", description: "not found" }],
    analyzedAt: Date.now(),
  };
}

function fixSuggestion(target = "demo-id"): EvolutionSuggestion {
  return {
    type: "fix",
    targetSkillIds: [target],
    reason: "pdftotext missing",
    proposedChange: "pdftotext missing",
    triggeredBy: "post-analysis",
    llmConfirmed: false,
    createdAt: Date.now(),
  };
}

const input = (taskId: string) => ({
  taskId,
  sessionId: "s1",
  message: "extract tables",
  reply: "failed",
  status: "completed" as const,
});

describe("EvolutionCoordinator", () => {
  let dataDir: string;
  let store: SkillQualityStore;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-coordinator-"));
    store = new SkillQualityStore({ dataDir });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("关闭时不分析", async () => {
    const analyze = vi.fn();
    const coordinator = new EvolutionCoordinator(
      { analyzer: { analyze }, qualityStore: store },
      { enabled: false },
    );
    expect(await coordinator.handleRun(input("t0"))).toBeNull();
    expect(analyze).not.toHaveBeenCalled();
  });

  it("分析 → 质量记账 → 确认 → 演化 → markEvolved", async () => {
    const suggestion = fixSuggestion();
    const analyze = vi.fn().mockResolvedValue(analysis("t1", suggestion));
    const evolve = vi.fn().mockResolvedValue({
      skillId: "new-id",
      name: "demo",
      path: "/tmp/x",
      skillDir: "/tmp",
      evolutionType: "fix",
      parentIds: ["demo-id"],
      changeSummary: "ok",
    });
    const recordLlmToolIssues = vi.fn();
    const coordinator = new EvolutionCoordinator(
      {
        analyzer: { analyze },
        qualityStore: store,
        evolver: { evolve },
        confirmSuggestion: () => ({ confirmed: true, reason: "good" }),
        toolQuality: { recordLlmToolIssues },
      },
      { minIntervalMs: 0 },
    );

    const result = await coordinator.handleRun(input("t1"));
    await coordinator.flush();

    expect(result?.taskId).toBe("t1");
    expect(evolve).toHaveBeenCalledTimes(1);
    expect(recordLlmToolIssues).toHaveBeenCalledWith(analysis("t1").toolIssues);
    expect(store.get("demo-id")?.totalApplied).toBe(1);
    expect(store.get("demo-id")?.totalFailures).toBe(1);
    const stats = coordinator.getStats();
    expect(stats.analyzed).toBe(1);
    expect(stats.confirmed).toBe(1);
    expect(stats.evolved).toBe(1);
    expect(store.get("demo-id")?.lastEvolvedAt).toBeTypeOf("number");
  });

  it("确认被拒绝时不执行演化", async () => {
    const analyze = vi.fn().mockResolvedValue(analysis("t2", fixSuggestion()));
    const evolve = vi.fn();
    const coordinator = new EvolutionCoordinator(
      {
        analyzer: { analyze },
        qualityStore: store,
        evolver: { evolve },
        confirmSuggestion: () => ({ confirmed: false, reason: "vague" }),
      },
      { minIntervalMs: 0 },
    );
    await coordinator.handleRun(input("t2"));
    await coordinator.flush();
    expect(evolve).not.toHaveBeenCalled();
    expect(coordinator.getStats().skipped).toBe(1);
  });

  it("同一建议键在冷却窗口内只执行一次", async () => {
    const suggestion = fixSuggestion();
    const analyze = vi.fn().mockImplementation(async (i: { taskId: string }) =>
      analysis(i.taskId, { ...suggestion }),
    );
    const evolve = vi.fn().mockResolvedValue({
      skillId: "new-id",
      name: "demo",
      path: "/tmp/x",
      skillDir: "/tmp",
      evolutionType: "fix",
      parentIds: ["demo-id"],
      changeSummary: "ok",
    });
    const coordinator = new EvolutionCoordinator(
      {
        analyzer: { analyze },
        qualityStore: store,
        evolver: { evolve },
        confirmSuggestion: () => ({ confirmed: true }),
      },
      { minIntervalMs: 0, suggestionCooldownMs: 60_000 },
    );

    await coordinator.handleRun(input("t3"));
    await coordinator.handleRun(input("t4"));
    await coordinator.flush();
    expect(evolve).toHaveBeenCalledTimes(1);
    expect(coordinator.getStats().suggestions).toBe(2);
  });

  it("子代理任务跳过；日配额耗尽后跳过", async () => {
    const analyze = vi.fn().mockResolvedValue(analysis("t5"));
    const coordinator = new EvolutionCoordinator(
      { analyzer: { analyze }, qualityStore: store },
      { minIntervalMs: 0, dailyAnalysisCap: 1 },
    );
    await coordinator.handleRun({ ...input("t5"), isSubagent: true });
    expect(analyze).not.toHaveBeenCalled();

    await coordinator.handleRun(input("t5"));
    await coordinator.handleRun(input("t6"));
    await coordinator.flush();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(coordinator.getStats().skipped).toBe(1);
  });

  it("分析器返回 null 时静默跳过", async () => {
    const coordinator = new EvolutionCoordinator(
      { analyzer: { analyze: vi.fn().mockResolvedValue(null) }, qualityStore: store },
      { minIntervalMs: 0 },
    );
    expect(await coordinator.handleRun(input("t7"))).toBeNull();
    expect(coordinator.getStats().skipped).toBe(1);
  });
});
