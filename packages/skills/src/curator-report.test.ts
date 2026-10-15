import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SkillCurator } from "./skill-curator";
import {
  newCuratorRunId,
  renderCuratorReportMarkdown,
  summarizeUsage,
  writeCuratorReport,
  type CuratorRunReport,
} from "./curator-report";

function baseReport(overrides: Partial<CuratorRunReport> = {}): CuratorRunReport {
  return {
    runId: newCuratorRunId(),
    trigger: "manual",
    startedAt: "2026-10-14T00:00:00.000Z",
    finishedAt: "2026-10-14T00:00:01.000Z",
    durationMs: 1000,
    scanned: 3,
    outcomes: [
      { skillName: "active-skill", classification: "consolidated", reason: "未过期，保留为活跃" },
      { skillName: "stale-skill", classification: "pruned", reason: "超过 30 天未使用，已归档（永不删除，可恢复）" },
      { skillName: "pinned-skill", classification: "pinned-exempt", reason: "已过期但 pinned，豁免归档" },
    ],
    archived: ["stale-skill"],
    expired: ["stale-skill", "pinned-skill"],
    evolutionStats: {
      totalTracked: 2,
      totalExtractions: 2,
      totalImprovements: 1,
      totalDeprecations: 0,
      averageVersionsPerSkill: 1.5,
    },
    usageTotals: { active: 2, archived: 1, totalTracked: 3 },
    recentRecords: [
      { skillName: "stale-skill", type: "archive", description: "自动归档", timestamp: "2026-10-14T00:00:01.000Z" },
    ],
    ...overrides,
  };
}

describe("curator-report", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-report-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("renderCuratorReportMarkdown", () => {
    it("包含分类计数、明细表与归档清单", () => {
      const md = renderCuratorReportMarkdown(baseReport());
      expect(md).toContain("# Skill Curator 运行报告");
      expect(md).toContain("consolidated: 1；pruned: 1；pinned-exempt: 1");
      expect(md).toContain("| active-skill | consolidated |");
      expect(md).toContain("| stale-skill | pruned |");
      expect(md).toContain("| pinned-skill | pinned-exempt |");
      expect(md).toContain("- stale-skill");
      expect(md).toContain("`archive` **stale-skill**");
      expect(md).toContain("追踪技能: 2");
    });

    it("空扫描时仍产出合法报告", () => {
      const md = renderCuratorReportMarkdown(baseReport({ scanned: 0, outcomes: [], archived: [], expired: [] }));
      expect(md).toContain("| （无） | - | - |");
      expect(md).toContain("consolidated: 0；pruned: 0；pinned-exempt: 0");
    });

    it("timer 触发标注后台定时", () => {
      const md = renderCuratorReportMarkdown(baseReport({ trigger: "timer" }));
      expect(md).toContain("后台定时");
    });
  });

  describe("writeCuratorReport", () => {
    it("原子写入 run.json 与 REPORT.md", async () => {
      const report = baseReport();
      await writeCuratorReport(tmpDir, report);

      const runJson = JSON.parse(fs.readFileSync(path.join(tmpDir, "run.json"), "utf-8")) as CuratorRunReport;
      expect(runJson.runId).toBe(report.runId);
      expect(runJson.outcomes).toHaveLength(3);
      expect(runJson.archived).toEqual(["stale-skill"]);

      const md = fs.readFileSync(path.join(tmpDir, "REPORT.md"), "utf-8");
      expect(md).toContain("# Skill Curator 运行报告");

      // 锁文件在写完后应已释放，不留残留
      expect(fs.existsSync(path.join(tmpDir, "curator-report.lock"))).toBe(false);
    });

    it("重复写入覆盖为最新一次", async () => {
      await writeCuratorReport(tmpDir, baseReport({ runId: "first" }));
      await writeCuratorReport(tmpDir, baseReport({ runId: "second" }));
      const runJson = JSON.parse(fs.readFileSync(path.join(tmpDir, "run.json"), "utf-8")) as CuratorRunReport;
      expect(runJson.runId).toBe("second");
    });
  });

  describe("summarizeUsage", () => {
    it("按 status 计数", () => {
      const stats = new Map([
        ["a", { skillName: "a", lastUsedAt: null, useCount: 0, createdAt: "", status: "active" as const }],
        ["b", { skillName: "b", lastUsedAt: null, useCount: 0, createdAt: "", status: "archived" as const }],
        ["c", { skillName: "c", lastUsedAt: null, useCount: 0, createdAt: "", status: "active" as const }],
      ]);
      expect(summarizeUsage(stats)).toEqual({ active: 2, archived: 1, totalTracked: 3 });
    });
  });
});

describe("SkillCurator.runCycle 报告链路（集成）", () => {
  let tmpRoot: string;
  let skillsDir: string;
  let archiveDir: string;
  let dataDir: string;
  let reportDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-run-"));
    skillsDir = path.join(tmpRoot, "skills");
    archiveDir = path.join(tmpRoot, "skills-archive");
    dataDir = path.join(tmpRoot, "skill-curator");
    reportDir = path.join(tmpRoot, "logs", "curator");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function createCurator() {
    const registry = new ServiceRegistry();
    const eventBus = new EventBus();
    registry.registerService("eventBus", eventBus);
    const curator = new SkillCurator(registry, eventBus, skillsDir, archiveDir, dataDir, reportDir);
    return { curator, eventBus };
  }

  function seedSkillDir(name: string): string {
    const dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\nversion: 1.0.0\n---\n# ${name}\nInstructions here.\n`
    );
    return dir;
  }

  it("runCycle 后写出 run.json，含 consolidated-vs-pruned 分类", async () => {
    const { curator } = createCurator();
    seedSkillDir("never-used-skill");

    const result = await curator.runCycle("manual");
    expect(result.archived).toContain("never-used-skill");

    const runJson = JSON.parse(fs.readFileSync(path.join(reportDir, "run.json"), "utf-8")) as CuratorRunReport;
    expect(runJson.trigger).toBe("manual");
    expect(runJson.scanned).toBe(1);
    expect(runJson.outcomes).toEqual([
      expect.objectContaining({ skillName: "never-used-skill", classification: "pruned" }),
    ]);
    expect(runJson.archived).toEqual(["never-used-skill"]);

    const md = fs.readFileSync(path.join(reportDir, "REPORT.md"), "utf-8");
    expect(md).toContain("never-used-skill");

    curator.dispose();
  });

  it("未过期技能分类为 consolidated，pinned 过期技能为 pinned-exempt", async () => {
    const { curator } = createCurator();
    seedSkillDir("fresh-skill");
    // 过期 + pinned
    seedSkillDir("old-pinned-skill");
    // 通过私有字段注入 pinned 记录（与 skill-curator.test.ts 同一 seedEvolutionEntry 手法，字段补全）
    const evolutions = (curator as unknown as {
      evolutions: Map<string, Record<string, unknown>>;
    }).evolutions;
    evolutions.set("e1", {
      skillId: "e1",
      skillName: "old-pinned-skill",
      versions: [],
      extractionSource: null,
      improvementHistory: [],
      deprecation: null,
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
      pinned: true,
      pinnedAt: new Date(),
      pinnedReason: "test",
    });

    // 先推进 31 天（让 old-pinned-skill 过期），再给 fresh-skill 记录新使用（未过期）
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
    curator.recordUsage("fresh-skill");
    await curator.runCycle("timer");

    const runJson = JSON.parse(fs.readFileSync(path.join(reportDir, "run.json"), "utf-8")) as CuratorRunReport;
    expect(runJson.trigger).toBe("timer");
    const byName = new Map(runJson.outcomes.map(o => [o.skillName, o.classification]));
    expect(byName.get("fresh-skill")).toBe("consolidated");
    expect(byName.get("old-pinned-skill")).toBe("pinned-exempt");
    expect(runJson.archived).toEqual([]);

    curator.dispose();
  });

  it("runCycle 发布 skill.curator.report 事件", async () => {
    const { curator, eventBus } = createCurator();
    seedSkillDir("evt-skill");

    let caught: CuratorRunReport | null = null;
    const sub = eventBus.subscribe<CuratorRunReport>("skill.curator.report", async (event) => {
      caught = event.data;
    });

    await curator.runCycle();
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(caught).not.toBeNull();
    expect(caught!.outcomes).toHaveLength(1);
    expect(caught!.runId).toBeTruthy();
    eventBus.unsubscribe(sub.id);
    curator.dispose();
  });

  it("skillsDir 不存在时也写出空报告（run.json 保持新鲜）", async () => {
    const registry = new ServiceRegistry();
    const eventBus = new EventBus();
    registry.registerService("eventBus", eventBus);
    const missingDir = path.join(tmpRoot, "no-skills");
    const curator = new SkillCurator(
      registry, eventBus, missingDir, archiveDir, dataDir, reportDir
    );

    await curator.runCycle();
    const runJson = JSON.parse(fs.readFileSync(path.join(reportDir, "run.json"), "utf-8")) as CuratorRunReport;
    expect(runJson.scanned).toBe(0);
    expect(runJson.outcomes).toEqual([]);

    curator.dispose();
  });
});
