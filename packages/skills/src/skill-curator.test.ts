import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { SkillCurator, type SkillEvolutionEntry, type SkillUsageStats } from "../src/skill-curator";
import { v4 as uuid } from "uuid";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Minimum solution length to pass the 300-char instruction quality gate.
// The derived instructions include a heading and task prefix (~50 chars), so the
// solution itself needs to provide the remaining ~250 chars.
const LONG_SOLUTION = [
  "Step 1: Initialize the environment and load all necessary dependencies and configurations.",
  "Step 2: Parse the input parameters and validate them against the expected schema.",
  "Step 3: Execute the core logic by calling the appropriate processing pipeline.",
  "Step 4: Handle edge cases and errors gracefully with proper fallback mechanisms.",
  "Step 5: Format the output results according to the specified output schema.",
  "Step 6: Log the execution details and return the final result to the caller.",
  "Step 7: Clean up any temporary resources and close open connections.",
].join("\n");

/**
 * 向 SkillCurator 内部 evolutions Map 注入一条演化记录。
 *
 * 历史上这些记录由 extractSkillFromSolution 自动创建，但自动提取已永久禁用
 * （详见 skill-curator.ts）。测试中通过此辅助函数直接注入记录，
 * 以便测试 improveSkill / deprecateSkill 等演化功能仍然可用。
 */
function seedEvolutionEntry(
  curator: SkillCurator,
  skillName: string,
  overrides: Partial<SkillEvolutionEntry> = {}
): string {
  const skillId = uuid();
  const entry: SkillEvolutionEntry = {
    skillId,
    skillName,
    versions: [
      {
        version: "1.0.0",
        timestamp: new Date(),
        changes: `手动创建: ${skillName}`,
        trigger: "extraction",
        previousVersion: null,
      },
    ],
    extractionSource: { task: skillName, solution: LONG_SOLUTION, context: {} },
    improvementHistory: [],
    deprecation: null,
    createdAt: new Date(),
    lastUpdatedAt: new Date(),
    ...overrides,
  };
  // 直接访问私有字段注入记录（仅用于测试）
  (curator as unknown as { evolutions: Map<string, SkillEvolutionEntry> }).evolutions.set(skillId, entry);
  return skillId;
}

describe("SkillCurator", () => {
  function createCurator() {
    const registry = new ServiceRegistry();
    const eventBus = new EventBus();
    registry.registerService("eventBus", eventBus);
    const curator = new SkillCurator(registry, eventBus);
    return { curator, registry, eventBus };
  }

  // ── 自动提取已永久禁用 ──
  // 历史上 extractSkillFromSolution 会从任务解决方案中提取技能，
  // 但生成的技能质量过低（通用 7 步骤模板、机械关键词触发器），
  // 导致 data/skills/ 堆积大量 evoclaw-curator 自动生成的无用技能。
  // 现在此方法永远返回 null，技能只能通过 WebUI 手动创建。
  describe("extractSkillFromSolution (permanently disabled)", () => {
    it("should return null regardless of input quality", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution(
        "search latest technology news with web api integration",
        LONG_SOLUTION,
        { source: "task-completion", taskId: "test-1" }
      );

      expect(skill).toBeNull();
    });

    it("should return null even when called with rich solution", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution(
        "evaluate math expressions from user input queries",
        LONG_SOLUTION,
        { source: "test" }
      );

      expect(skill).toBeNull();
    });

    it("should return null for insufficient task/solution", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution("a", "b", {});

      expect(skill).toBeNull();
    });

    it("should NOT create evolution entry", async () => {
      const { curator } = createCurator();
      const initialCount = curator.getAllEvolutions().length;

      await curator.extractSkillFromSolution(
        "search latest technology news with web api integration",
        LONG_SOLUTION,
        {}
      );

      // 不应增加任何演化记录（自动提取已永久禁用）
      expect(curator.getAllEvolutions().length).toBe(initialCount);
    });

    it("should NOT write any files to disk", async () => {
      const { curator } = createCurator();
      const initialCount = curator.getAllEvolutions().length;

      await curator.extractSkillFromSolution(
        "fetch data from external api endpoint integration",
        LONG_SOLUTION,
        {}
      );

      // 确认没有新增演化记录（间接验证没有写文件）
      expect(curator.getAllEvolutions().length).toBe(initialCount);
    });
  });

  // ── considerExtraction 已永久禁用 ──
  // 历史上每 15 次工具调用会触发此方法，现已移除调用点（llm-caller.ts）
  // 且方法本身为 no-op。
  describe("considerExtraction (permanently disabled)", () => {
    it("should be a no-op (no evolution entries created)", () => {
      const { curator } = createCurator();
      const initialCount = curator.getAllEvolutions().length;

      // 调用多次不应产生任何效果
      curator.considerExtraction("session-1", 15, "some result", "some task");
      curator.considerExtraction("session-1", 30, "another result", "another task");
      curator.considerExtraction("session-1", 45, "yet another", "yet another task");

      // 不应增加任何演化记录
      expect(curator.getAllEvolutions().length).toBe(initialCount);
    });
  });

  describe("improveSkill", () => {
    it("should improve skill based on execution failure", async () => {
      const { curator } = createCurator();
      const skillId = seedEvolutionEntry(curator, "file processing utility for reading content");

      const executionResult = {
        skillId,
        success: false,
        output: null,
        errors: ["Permission denied: access to /etc/shadow"],
        duration: 5000,
        resourceUsage: { cpuTime: 200, peakMemoryMB: 50, networkBytes: 0 },
      };

      const improved = await curator.improveSkill(skillId, executionResult, null);

      expect(improved).toBeDefined();
      expect(improved!.version).not.toBe("1.0.0");
      expect(improved!.body.instructions).toContain("权限错误");

      const evolution = curator.getSkillEvolution(skillId);
      expect(evolution!.versions.length).toBe(2);
      expect(evolution!.versions[1].trigger).toBe("improvement");
      expect(evolution!.improvementHistory).toHaveLength(1);
    });

    it("should improve skill based on negative user feedback", async () => {
      const { curator } = createCurator();
      const skillId = seedEvolutionEntry(curator, "data conversion tool for csv to json format");

      const executionResult = {
        skillId,
        success: true,
        output: { result: "ok" },
        errors: [],
        duration: 1000,
        resourceUsage: { cpuTime: 50, peakMemoryMB: 20, networkBytes: 0 },
      };

      const improved = await curator.improveSkill(skillId, executionResult, "太慢了，转换速度不够快");

      expect(improved).toBeDefined();
      expect(improved!.body.instructions).toContain("速度");

      const evolution = curator.getSkillEvolution(skillId);
      expect(evolution!.improvementHistory).toHaveLength(1);
    });

    it("should improve skill based on positive user feedback", async () => {
      const { curator } = createCurator();
      const skillId = seedEvolutionEntry(curator, "code formatting tool for typescript source");

      const executionResult = {
        skillId,
        success: true,
        output: { result: "formatted" },
        errors: [],
        duration: 500,
        resourceUsage: { cpuTime: 10, peakMemoryMB: 5, networkBytes: 0 },
      };

      const improved = await curator.improveSkill(skillId, executionResult, "非常好用，格式化结果很准确");

      expect(improved).toBeDefined();
      expect(improved!.body.instructions).toContain("最佳实践");
    });

    it("should return null for unknown skill id", async () => {
      const { curator } = createCurator();

      const result = await curator.improveSkill(
        "non-existent-id",
        {
          skillId: "non-existent-id",
          success: false,
          output: null,
          errors: ["error"],
          duration: 0,
          resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
        },
        null
      );

      expect(result).toBeNull();
    });

    it("should return null for deprecated skill", async () => {
      const { curator } = createCurator();
      const skillId = seedEvolutionEntry(curator, "deprecated skill test for cleanup verification");

      await curator.deprecateSkill(skillId, "不再需要");

      const result = await curator.improveSkill(
        skillId,
        {
          skillId,
          success: false,
          output: null,
          errors: ["error"],
          duration: 0,
          resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
        },
        null
      );

      expect(result).toBeNull();
    });

    it("should add timeout trigger when failure analysis detects timeout", async () => {
      const { curator } = createCurator();
      const skillId = seedEvolutionEntry(curator, "batch data processing for large records");

      const executionResult = {
        skillId,
        success: false,
        output: null,
        errors: ["Execution timed out after 30000ms"],
        duration: 35000,
        resourceUsage: { cpuTime: 30000, peakMemoryMB: 200, networkBytes: 0 },
      };

      const improved = await curator.improveSkill(skillId, executionResult, null);

      expect(improved).toBeDefined();
      const hasTimeoutTrigger = improved!.triggers.some(
        (t) => t.type === "event" && t.pattern === "skill.timeout"
      );
      expect(hasTimeoutTrigger).toBe(true);
    });
  });

  describe("deprecateSkill", () => {
    it("should deprecate a skill", async () => {
      const { curator } = createCurator();
      const skillId = seedEvolutionEntry(curator, "legacy tool handler for migration support");

      const result = await curator.deprecateSkill(skillId, "已被新工具替代");

      expect(result).toBe(true);

      const evolution = curator.getSkillEvolution(skillId);
      expect(evolution!.deprecation).not.toBeNull();
      expect(evolution!.deprecation!.reason).toBe("已被新工具替代");
      expect(evolution!.versions.length).toBe(2);
      expect(evolution!.versions[1].trigger).toBe("deprecation");
    });

    it("should return false for unknown skill id", async () => {
      const { curator } = createCurator();

      const result = await curator.deprecateSkill("non-existent", "reason");

      expect(result).toBe(false);
    });

    it("should return false for already deprecated skill", async () => {
      const { curator } = createCurator();
      const skillId = seedEvolutionEntry(curator, "duplicate deprecation test case verification");

      await curator.deprecateSkill(skillId, "第一次弃用");
      const result = await curator.deprecateSkill(skillId, "第二次弃用");

      expect(result).toBe(false);
    });
  });

  describe("getSkillEvolution", () => {
    it("should return null for unknown skill", () => {
      const { curator } = createCurator();
      const evolution = curator.getSkillEvolution("unknown");
      expect(evolution).toBeNull();
    });

    it("should return evolution with full version history", async () => {
      const { curator } = createCurator();
      const skillId = seedEvolutionEntry(curator, "version history test for tracking changes");

      await curator.improveSkill(skillId, {
        skillId,
        success: false,
        output: null,
        errors: ["test error"],
        duration: 100,
        resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
      }, "不好用");

      await curator.improveSkill(skillId, {
        skillId,
        success: false,
        output: null,
        errors: ["another error"],
        duration: 100,
        resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
      }, null);

      const evolution = curator.getSkillEvolution(skillId);
      expect(evolution).toBeDefined();
      expect(evolution!.versions).toHaveLength(3);
      expect(evolution!.versions[0].trigger).toBe("extraction");
      expect(evolution!.versions[1].trigger).toBe("improvement");
      expect(evolution!.versions[2].trigger).toBe("improvement");
      expect(evolution!.improvementHistory).toHaveLength(2);
    });
  });

  describe("getAllEvolutions", () => {
    it("should return all tracked evolutions", async () => {
      const { curator } = createCurator();

      seedEvolutionEntry(curator, "task alpha processing pipeline for data analysis");
      seedEvolutionEntry(curator, "task beta processing pipeline for data analysis");

      const evolutions = curator.getAllEvolutions();
      expect(evolutions.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("getEvolutionStats", () => {
    it("should return accurate statistics", async () => {
      const { curator } = createCurator();

      const skill1 = seedEvolutionEntry(curator, "stats task one processing pipeline for data analysis");
      const skill2 = seedEvolutionEntry(curator, "stats task two processing pipeline for data analysis");

      await curator.improveSkill(skill1, {
        skillId: skill1,
        success: false,
        output: null,
        errors: ["error"],
        duration: 100,
        resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
      }, null);

      await curator.deprecateSkill(skill2, "不再需要");

      const stats = curator.getEvolutionStats();
      expect(stats.totalTracked).toBeGreaterThanOrEqual(2);
      expect(stats.totalExtractions).toBeGreaterThanOrEqual(2);
      expect(stats.totalImprovements).toBeGreaterThanOrEqual(1);
      expect(stats.totalDeprecations).toBeGreaterThanOrEqual(1);
      expect(stats.averageVersionsPerSkill).toBeGreaterThan(0);
    });
  });

  describe("version management", () => {
    it("should increment patch version on improvement", async () => {
      const { curator } = createCurator();
      const skillId = seedEvolutionEntry(curator, "version management test case for tracking");

      // 通过 improveSkill 获取重构的技能
      const improved = await curator.improveSkill(skillId, {
        skillId,
        success: false,
        output: null,
        errors: ["error"],
        duration: 100,
        resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
      }, null);

      expect(improved).toBeDefined();
      expect(improved!.version).toBe("1.0.1");

      const improved2 = await curator.improveSkill(improved!.id, {
        skillId: improved!.id,
        success: false,
        output: null,
        errors: ["error"],
        duration: 100,
        resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
      }, null);

      expect(improved2!.version).toBe("1.0.2");
    });

    it("should track previous version in evolution history", async () => {
      const { curator } = createCurator();
      const skillId = seedEvolutionEntry(curator, "version tracking test case for history");

      await curator.improveSkill(skillId, {
        skillId,
        success: false,
        output: null,
        errors: ["error"],
        duration: 100,
        resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
      }, null);

      const evolution = curator.getSkillEvolution(skillId);
      expect(evolution!.versions[1].previousVersion).toBe("1.0.0");
      expect(evolution!.versions[1].version).toBe("1.0.1");
    });
  });

  // ── autoExtractionToggle 已永久禁用 ──
  // enableAutoExtraction() 现在是 no-op，isAutoExtractionEnabled() 永远返回 false。
  // 这确保即使有代码尝试启用自动提取，也不会产生效果。
  describe("autoExtractionToggle (permanently disabled)", () => {
    it("should default to disabled", () => {
      const registry = new ServiceRegistry();
      const eventBus = new EventBus();
      const curator = new SkillCurator(registry, eventBus);
      expect(curator.isAutoExtractionEnabled()).toBe(false);
    });

    it("should remain disabled even after calling enableAutoExtraction", () => {
      const registry = new ServiceRegistry();
      const eventBus = new EventBus();
      const curator = new SkillCurator(registry, eventBus);
      expect(curator.isAutoExtractionEnabled()).toBe(false);

      // 尝试启用 — 应为 no-op
      curator.enableAutoExtraction();

      // 仍然应该返回 false
      expect(curator.isAutoExtractionEnabled()).toBe(false);
    });

    it("should remain disabled after disableAutoExtraction", () => {
      const registry = new ServiceRegistry();
      const eventBus = new EventBus();
      const curator = new SkillCurator(registry, eventBus);

      curator.disableAutoExtraction();
      expect(curator.isAutoExtractionEnabled()).toBe(false);

      // 即使尝试启用，仍应保持禁用
      curator.enableAutoExtraction();
      expect(curator.isAutoExtractionEnabled()).toBe(false);
    });
  });

  describe("healthCheck", () => {
    it("should return true", async () => {
      const { curator } = createCurator();
      const healthy = await curator.healthCheck();
      expect(healthy).toBe(true);
    });
  });

  // ── 技能生命周期：使用跟踪、自动归档、恢复 ──
  // 以下测试验证任务新增的功能：
  //   - recordUsage / getUsageStats：使用统计
  //   - recordEvolution / getEvolutionHistory：进化记录
  //   - archiveSkill / restoreSkill：归档与恢复
  //   - runCycle：过期自动归档（mock 时间）
  //   - start/stop：定时扫描
  //   - 并发安全（CrossProcessLock 可重入）
  describe("lifecycle: usage tracking + archive + restore", () => {
    let tmpRoot: string;
    let skillsDir: string;
    let archiveDir: string;
    let dataDir: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-curator-lifecycle-"));
      skillsDir = path.join(tmpRoot, "skills");
      archiveDir = path.join(tmpRoot, "skills-archive");
      dataDir = path.join(tmpRoot, "skill-curator");
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });
    });

    afterEach(() => {
      vi.useRealTimers();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    function createCuratorWithDirs() {
      const registry = new ServiceRegistry();
      const eventBus = new EventBus();
      registry.registerService("eventBus", eventBus);
      const curator = new SkillCurator(registry, eventBus, skillsDir, archiveDir, dataDir);
      return { curator, registry, eventBus };
    }

    /** 在 skillsDir 下创建一个技能目录（含 SKILL.md）。 */
    function seedSkillDir(name: string): string {
      const dir = path.join(skillsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\nversion: 1.0.0\n---\n# ${name}\nInstructions here.\n`
      );
      return dir;
    }

    it("基本生命周期：创建 → 记录使用 → 归档 → 恢复", async () => {
      const { curator } = createCuratorWithDirs();
      const skillName = "web-fetcher";
      const skillDir = seedSkillDir(skillName);

      // 记录使用
      curator.recordUsage(skillName);
      // 等待异步 persistUsage 完成
      await new Promise(resolve => setTimeout(resolve, 50));

      const stats = curator.getUsageStats().get(skillName);
      expect(stats).toBeDefined();
      expect(stats!.useCount).toBe(1);
      expect(stats!.status).toBe("active");

      // 归档
      await curator.archiveSkill(skillName);

      // 原目录应不存在；归档目录应存在
      expect(fs.existsSync(skillDir)).toBe(false);
      const archiveEntries = fs.readdirSync(archiveDir);
      expect(archiveEntries.length).toBeGreaterThan(0);
      expect(archiveEntries[0]).toContain(skillName);

      // 使用统计状态应更新为 archived
      const archivedStats = curator.getUsageStats().get(skillName);
      expect(archivedStats!.status).toBe("archived");

      // 恢复
      await curator.restoreSkill(skillName);

      // 原目录应恢复
      expect(fs.existsSync(skillDir)).toBe(true);
      expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);

      // 使用统计状态应恢复为 active
      const restoredStats = curator.getUsageStats().get(skillName);
      expect(restoredStats!.status).toBe("active");

      curator.dispose();
    });

    it("使用统计查询：多次 recordUsage 累加 useCount", async () => {
      const { curator } = createCuratorWithDirs();
      const skillName = "stats-skill";
      seedSkillDir(skillName);

      curator.recordUsage(skillName);
      curator.recordUsage(skillName);
      curator.recordUsage(skillName);
      await new Promise(resolve => setTimeout(resolve, 50));

      const stats = curator.getUsageStats().get(skillName);
      expect(stats).toBeDefined();
      expect(stats!.useCount).toBe(3);
      expect(stats!.lastUsedAt).not.toBeNull();

      // getUsageStats 返回副本，修改不影响内部状态
      const snapshot = curator.getUsageStats();
      snapshot.delete(skillName);
      expect(curator.getUsageStats().has(skillName)).toBe(true);

      curator.dispose();
    });

    it("进化记录：recordEvolution 追加到历史并支持按技能过滤", () => {
      const { curator } = createCuratorWithDirs();

      curator.recordEvolution("skill-a", {
        type: "improvement",
        description: "改进了触发器",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      curator.recordEvolution("skill-a", {
        type: "archive",
        description: "已归档",
        timestamp: "2026-01-02T00:00:00.000Z",
      });
      curator.recordEvolution("skill-b", {
        type: "restore",
        description: "已恢复",
        timestamp: "2026-01-03T00:00:00.000Z",
      });

      const all = curator.getEvolutionHistory();
      expect(all.length).toBe(3);

      const skillAHistory = curator.getEvolutionHistory("skill-a");
      expect(skillAHistory.length).toBe(2);
      expect(skillAHistory[0].type).toBe("improvement");
      expect(skillAHistory[1].type).toBe("archive");

      const skillBHistory = curator.getEvolutionHistory("skill-b");
      expect(skillBHistory.length).toBe(1);
      expect(skillBHistory[0].type).toBe("restore");

      curator.dispose();
    });

    it("过期技能自动归档（mock 时间）", async () => {
      const { curator } = createCuratorWithDirs();
      const skillName = "expired-skill";
      const skillDir = seedSkillDir(skillName);

      // 记录一次使用（设置 lastUsedAt）
      curator.recordUsage(skillName);
      await new Promise(resolve => setTimeout(resolve, 50));

      // 推进时间 31 天（超过默认 30 天阈值）
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));

      const result = await curator.runCycle();

      expect(result.expired).toContain(skillName);
      expect(result.archived).toContain(skillName);
      expect(fs.existsSync(skillDir)).toBe(false);

      // 归档目录应有内容
      const archiveEntries = fs.readdirSync(archiveDir);
      expect(archiveEntries.length).toBeGreaterThan(0);

      curator.dispose();
    });

    it("未过期技能不被归档（mock 时间）", async () => {
      const { curator } = createCuratorWithDirs();
      const skillName = "fresh-skill";
      const skillDir = seedSkillDir(skillName);

      curator.recordUsage(skillName);
      await new Promise(resolve => setTimeout(resolve, 50));

      // 仅推进 5 天（未超过 30 天阈值）
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 5 * 24 * 60 * 60 * 1000));

      const result = await curator.runCycle();

      expect(result.archived).not.toContain(skillName);
      expect(fs.existsSync(skillDir)).toBe(true);

      curator.dispose();
    });

    it("从未使用过的技能视为过期候选", async () => {
      const { curator } = createCuratorWithDirs();
      const skillName = "never-used-skill";
      seedSkillDir(skillName);

      // 不调用 recordUsage，直接 runCycle
      const result = await curator.runCycle();

      expect(result.expired).toContain(skillName);
      expect(result.archived).toContain(skillName);

      curator.dispose();
    });

    it("并发安全：多次并行 recordUsage 不损坏 usage.json", async () => {
      const { curator } = createCuratorWithDirs();
      const skillName = "concurrent-skill";
      seedSkillDir(skillName);

      // 并行调用 5 次 recordUsage（每次触发 persistUsage）
      curator.recordUsage(skillName);
      curator.recordUsage(skillName);
      curator.recordUsage(skillName);
      curator.recordUsage(skillName);
      curator.recordUsage(skillName);

      // 等待所有异步 persistUsage 完成
      await new Promise(resolve => setTimeout(resolve, 200));

      // useCount 应为 5（每次 recordUsage 同步累加）
      const stats = curator.getUsageStats().get(skillName);
      expect(stats).toBeDefined();
      expect(stats!.useCount).toBe(5);

      // usage.json 应可正确解析（未被并发写入损坏）
      const usagePath = path.join(dataDir, "usage.json");
      expect(fs.existsSync(usagePath)).toBe(true);
      const raw = fs.readFileSync(usagePath, "utf-8");
      const data = JSON.parse(raw) as { usage: SkillUsageStats[] };
      const entry = data.usage.find(u => u.skillName === skillName);
      expect(entry).toBeDefined();
      expect(entry!.useCount).toBe(5);

      curator.dispose();
    });

    it("start/stop 定时器：start 后 stop 不抛错且可重复调用", () => {
      const { curator } = createCuratorWithDirs();

      // start 应该设置定时器（不抛错）
      expect(() => curator.start()).not.toThrow();
      // 重复 start 应为 no-op（不重复创建定时器）
      expect(() => curator.start()).not.toThrow();
      // stop 应该清除定时器
      expect(() => curator.stop()).not.toThrow();
      // 重复 stop 应为 no-op
      expect(() => curator.stop()).not.toThrow();

      curator.dispose();
    });

    it("不存在的技能归档失败：抛出错误", async () => {
      const { curator } = createCuratorWithDirs();

      await expect(curator.archiveSkill("non-existent-skill")).rejects.toThrow(
        /Skill directory not found/
      );

      curator.dispose();
    });

    it("空 skillName 归档失败：抛出错误", async () => {
      const { curator } = createCuratorWithDirs();

      await expect(curator.archiveSkill("")).rejects.toThrow(/skillName is required/);

      curator.dispose();
    });

    it("恢复不存在的归档失败：抛出错误", async () => {
      const { curator } = createCuratorWithDirs();

      await expect(curator.restoreSkill("non-existent-archive")).rejects.toThrow(
        /No archive found for skill/
      );

      curator.dispose();
    });

    it("恢复时空 archiveDir 失败：抛出错误", async () => {
      const { curator } = createCuratorWithDirs();
      // 删除 archiveDir 模拟不存在场景
      fs.rmSync(archiveDir, { recursive: true, force: true });

      await expect(curator.restoreSkill("any-skill")).rejects.toThrow(
        /Archive directory not found/
      );

      curator.dispose();
    });

    it("listArchivedSkills 列出已归档技能", async () => {
      const { curator } = createCuratorWithDirs();
      const skillName = "listable-skill";
      seedSkillDir(skillName);

      await curator.archiveSkill(skillName);

      const archived = curator.listArchivedSkills();
      expect(archived.length).toBe(1);
      expect(archived[0].skillName).toBe(skillName);
      expect(archived[0].reason).toBe("archive");

      curator.dispose();
    });

    it("Pinned 技能豁免自动归档", async () => {
      const { curator } = createCuratorWithDirs();
      const skillName = "pinned-skill";
      const skillDir = seedSkillDir(skillName);

      // 注入一条 pinned 演化记录（使用 seedEvolutionEntry 辅助函数）
      seedEvolutionEntry(curator, skillName, { pinned: true, pinnedAt: new Date() });

      // runCycle 应跳过 pinned 技能
      const result = await curator.runCycle();

      expect(result.expired).toContain(skillName);
      expect(result.archived).not.toContain(skillName);
      expect(fs.existsSync(skillDir)).toBe(true);

      curator.dispose();
    });
  });
});
