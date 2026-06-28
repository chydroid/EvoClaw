import { describe, it, expect } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { SkillCurator, type SkillEvolutionEntry } from "../src/skill-curator";
import { v4 as uuid } from "uuid";

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
});
