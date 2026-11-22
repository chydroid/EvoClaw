import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillQualityStore } from "./skill-quality-store";
import type { ExecutionAnalysis } from "@evoclaw/skills";

function analysis(overrides: Partial<ExecutionAnalysis> = {}): ExecutionAnalysis {
  return {
    taskId: "task-1",
    taskCompleted: true,
    executionNote: "ok",
    skillJudgments: [],
    suggestions: [],
    toolIssues: [],
    analyzedAt: Date.now(),
    ...overrides,
  };
}

describe("SkillQualityStore", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-quality-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("累加四计数器：applied+completed", async () => {
    const store = new SkillQualityStore({ dataDir });
    store.recordAnalysis(
      analysis({
        skillJudgments: [
          { skillId: "abc12345", skillName: "pdf-extract", skillApplied: true, note: "used" },
        ],
      }),
    );
    await store.flush();

    const entry = store.get("abc12345");
    expect(entry?.totalSelections).toBe(1);
    expect(entry?.totalApplied).toBe(1);
    expect(entry?.totalCompleted).toBe(1);
    expect(entry?.totalFallbacks).toBe(0);
    expect(store.completionRate("abc12345")).toBe(1);
  });

  it("applied 但任务未完成计入 failures，未 applied 且未完成计入 fallbacks", async () => {
    const store = new SkillQualityStore({ dataDir });
    store.recordAnalysis(
      analysis({
        taskCompleted: false,
        skillJudgments: [
          { skillId: "s1", skillName: "one", skillApplied: true, note: "" },
          { skillId: "s2", skillName: "two", skillApplied: false, note: "not relevant" },
        ],
      }),
    );
    await store.flush();

    expect(store.get("s1")?.totalFailures).toBe(1);
    expect(store.get("s2")?.totalFallbacks).toBe(1);
    expect(store.get("s2")?.totalApplied).toBe(0);
  });

  it("低质量判定：选中 ≥2 且 0 完成", async () => {
    const store = new SkillQualityStore({ dataDir });
    store.recordAnalysis(
      analysis({
        taskCompleted: false,
        skillJudgments: [{ skillId: "bad", skillName: "bad", skillApplied: false, note: "" }],
      }),
    );
    store.recordAnalysis(
      analysis({
        taskId: "task-2",
        taskCompleted: false,
        skillJudgments: [{ skillId: "bad", skillName: "bad", skillApplied: false, note: "" }],
      }),
    );
    await store.flush();

    expect(store.isLowQuality("bad")).toBe(true);
    expect(store.isLowQuality("unknown")).toBe(false);
  });

  it("持久化后可重新加载（原子写 + 版本字段）", async () => {
    const first = new SkillQualityStore({ dataDir });
    first.recordAnalysis(
      analysis({
        skillJudgments: [{ skillId: "persist", skillName: "persist", skillApplied: true, note: "" }],
      }),
    );
    await first.flush();

    const file = path.join(dataDir, "skill-curator", "quality.json");
    expect(fs.existsSync(file)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { version: number };
    expect(raw.version).toBe(1);

    const second = new SkillQualityStore({ dataDir });
    expect(second.get("persist")?.totalCompleted).toBe(1);
  });

  it("toTriggerMetrics 输出 applied 口径的指标（非 invocationCount）", async () => {
    const store = new SkillQualityStore({ dataDir });
    store.recordAnalysis(
      analysis({
        skillJudgments: [{ skillId: "m", skillName: "m", skillApplied: true, note: "" }],
      }),
    );
    await store.flush();
    const metrics = store.toTriggerMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ skillId: "m", selections: 1, applied: 1, completions: 1 });
  });
});
