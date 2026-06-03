import { describe, it, expect } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { SkillCurator } from "../src/skill-curator";

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

describe("SkillCurator", () => {
  function createCurator() {
    const registry = new ServiceRegistry();
    const eventBus = new EventBus();
    registry.registerService("eventBus", eventBus);
    const curator = new SkillCurator(registry, eventBus);
    // Auto-extraction is OFF by default — tests must explicitly enable it.
    curator.enableAutoExtraction();
    return { curator, registry, eventBus };
  }

  describe("extractSkillFromSolution", () => {
    it("should extract a skill from a successful task solution", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution(
        "search latest technology news with web api integration",
        LONG_SOLUTION,
        { source: "task-completion", taskId: "test-1" }
      );

      expect(skill).toBeDefined();
      expect(skill!.name).toBeDefined();
      expect(skill!.version).toBe("1.0.0");
      expect(skill!.description).toContain("search");
      expect(skill!.lifecycle.status).toBe("active");
    });

    it("should create evolution entry on extraction", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution(
        "evaluate math expressions from user input queries",
        LONG_SOLUTION,
        { source: "test" }
      );

      const evolution = curator.getSkillEvolution(skill!.id);
      expect(evolution).toBeDefined();
      expect(evolution!.skillName).toBeDefined();
      expect(evolution!.versions).toHaveLength(1);
      expect(evolution!.versions[0].trigger).toBe("extraction");
      expect(evolution!.versions[0].previousVersion).toBeNull();
      expect(evolution!.extractionSource).not.toBeNull();
      expect(evolution!.extractionSource!.task).toBe("evaluate math expressions from user input queries");
    });

    it("should derive appropriate category from task description", async () => {
      const { curator } = createCurator();

      const integrationSkill = await curator.extractSkillFromSolution(
        "fetch data from external api endpoint integration",
        LONG_SOLUTION,
        {}
      );
      expect(integrationSkill!.category).toBe("integration");

      const analysisSkill = await curator.extractSkillFromSolution(
        "analyze sales data and generate statistical reports",
        LONG_SOLUTION,
        {}
      );
      expect(analysisSkill!.category).toBe("analysis");

      const generationSkill = await curator.extractSkillFromSolution(
        "generate project documentation from code structure",
        LONG_SOLUTION,
        {}
      );
      expect(generationSkill!.category).toBe("generation");
    });

    it("should derive triggers from task description", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution(
        "search news and return structured results",
        LONG_SOLUTION,
        {}
      );

      expect(skill!.triggers.length).toBeGreaterThan(0);
      expect(skill!.triggers[0].type).toBe("keyword");
    });

    it("should return null for insufficient task/solution (quality gate)", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution(
        "a",
        "b",
        {}
      );

      expect(skill).toBeNull();
    });

    it("should return null when auto-extraction is disabled", async () => {
      const registry = new ServiceRegistry();
      const eventBus = new EventBus();
      registry.registerService("eventBus", eventBus);
      const curator = new SkillCurator(registry, eventBus);
      // DO NOT enable auto-extraction — verify it returns null by default

      const skill = await curator.extractSkillFromSolution(
        "search latest technology news with web api integration",
        LONG_SOLUTION,
        {}
      );

      expect(skill).toBeNull();
    });
  });

  describe("improveSkill", () => {
    it("should improve skill based on execution failure", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution(
        "file processing utility for reading content",
        LONG_SOLUTION,
        {}
      );

      const executionResult = {
        skillId: skill!.id,
        success: false,
        output: null,
        errors: ["Permission denied: access to /etc/shadow"],
        duration: 5000,
        resourceUsage: { cpuTime: 200, peakMemoryMB: 50, networkBytes: 0 },
      };

      const improved = await curator.improveSkill(
        skill!.id,
        executionResult,
        null
      );

      expect(improved).toBeDefined();
      expect(improved!.version).not.toBe("1.0.0");
      expect(improved!.body.instructions).toContain("权限错误");

      const evolution = curator.getSkillEvolution(skill!.id);
      expect(evolution!.versions.length).toBe(2);
      expect(evolution!.versions[1].trigger).toBe("improvement");
      expect(evolution!.improvementHistory).toHaveLength(1);
    });

    it("should improve skill based on negative user feedback", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution(
        "data conversion tool for csv to json format",
        LONG_SOLUTION,
        {}
      );

      const executionResult = {
        skillId: skill!.id,
        success: true,
        output: { result: "ok" },
        errors: [],
        duration: 1000,
        resourceUsage: { cpuTime: 50, peakMemoryMB: 20, networkBytes: 0 },
      };

      const improved = await curator.improveSkill(
        skill!.id,
        executionResult,
        "太慢了，转换速度不够快"
      );

      expect(improved).toBeDefined();
      expect(improved!.body.instructions).toContain("速度");

      const evolution = curator.getSkillEvolution(skill!.id);
      expect(evolution!.improvementHistory).toHaveLength(1);
    });

    it("should improve skill based on positive user feedback", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution(
        "code formatting tool for typescript source",
        LONG_SOLUTION,
        {}
      );

      const executionResult = {
        skillId: skill!.id,
        success: true,
        output: { result: "formatted" },
        errors: [],
        duration: 500,
        resourceUsage: { cpuTime: 10, peakMemoryMB: 5, networkBytes: 0 },
      };

      const improved = await curator.improveSkill(
        skill!.id,
        executionResult,
        "非常好用，格式化结果很准确"
      );

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

      const skill = await curator.extractSkillFromSolution(
        "deprecated skill test for cleanup verification",
        LONG_SOLUTION,
        {}
      );

      await curator.deprecateSkill(skill!.id, "不再需要");

      const result = await curator.improveSkill(
        skill!.id,
        {
          skillId: skill!.id,
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

      const skill = await curator.extractSkillFromSolution(
        "batch data processing for large records",
        LONG_SOLUTION,
        {}
      );

      const executionResult = {
        skillId: skill!.id,
        success: false,
        output: null,
        errors: ["Execution timed out after 30000ms"],
        duration: 35000,
        resourceUsage: { cpuTime: 30000, peakMemoryMB: 200, networkBytes: 0 },
      };

      const improved = await curator.improveSkill(
        skill!.id,
        executionResult,
        null
      );

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

      const skill = await curator.extractSkillFromSolution(
        "legacy tool handler for migration support",
        LONG_SOLUTION,
        {}
      );

      const result = await curator.deprecateSkill(skill!.id, "已被新工具替代");

      expect(result).toBe(true);

      const evolution = curator.getSkillEvolution(skill!.id);
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

      const skill = await curator.extractSkillFromSolution(
        "duplicate deprecation test case verification",
        LONG_SOLUTION,
        {}
      );

      await curator.deprecateSkill(skill!.id, "第一次弃用");
      const result = await curator.deprecateSkill(skill!.id, "第二次弃用");

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

      const skill = await curator.extractSkillFromSolution(
        "version history test for tracking changes",
        LONG_SOLUTION,
        {}
      );

      await curator.improveSkill(skill!.id, {
        skillId: skill!.id,
        success: false,
        output: null,
        errors: ["test error"],
        duration: 100,
        resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
      }, "不好用");

      await curator.improveSkill(skill!.id, {
        skillId: skill!.id,
        success: false,
        output: null,
        errors: ["another error"],
        duration: 100,
        resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
      }, null);

      const evolution = curator.getSkillEvolution(skill!.id);
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

      await curator.extractSkillFromSolution("task alpha processing pipeline for data analysis", LONG_SOLUTION, {});
      await curator.extractSkillFromSolution("task beta processing pipeline for data analysis", LONG_SOLUTION, {});

      const evolutions = curator.getAllEvolutions();
      expect(evolutions.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("getEvolutionStats", () => {
    it("should return accurate statistics", async () => {
      const { curator } = createCurator();

      const skill1 = await curator.extractSkillFromSolution("stats task one processing pipeline for data analysis", LONG_SOLUTION, {});
      const skill2 = await curator.extractSkillFromSolution("stats task two processing pipeline for data analysis", LONG_SOLUTION, {});

      await curator.improveSkill(skill1!.id, {
        skillId: skill1!.id,
        success: false,
        output: null,
        errors: ["error"],
        duration: 100,
        resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
      }, null);

      await curator.deprecateSkill(skill2!.id, "不再需要");

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

      const skill = await curator.extractSkillFromSolution(
        "version management test case for tracking",
        LONG_SOLUTION,
        {}
      );

      expect(skill!.version).toBe("1.0.0");

      const improved = await curator.improveSkill(skill!.id, {
        skillId: skill!.id,
        success: false,
        output: null,
        errors: ["error"],
        duration: 100,
        resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
      }, null);

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

      const skill = await curator.extractSkillFromSolution(
        "version tracking test case for history",
        LONG_SOLUTION,
        {}
      );

      await curator.improveSkill(skill!.id, {
        skillId: skill!.id,
        success: false,
        output: null,
        errors: ["error"],
        duration: 100,
        resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
      }, null);

      const evolution = curator.getSkillEvolution(skill!.id);
      expect(evolution!.versions[1].previousVersion).toBe("1.0.0");
      expect(evolution!.versions[1].version).toBe("1.0.1");
    });
  });

  describe("autoExtractionToggle", () => {
    it("should default to disabled", () => {
      const registry = new ServiceRegistry();
      const eventBus = new EventBus();
      const curator = new SkillCurator(registry, eventBus);
      expect(curator.isAutoExtractionEnabled()).toBe(false);
    });

    it("should enable and disable auto-extraction", () => {
      const registry = new ServiceRegistry();
      const eventBus = new EventBus();
      const curator = new SkillCurator(registry, eventBus);
      expect(curator.isAutoExtractionEnabled()).toBe(false);
      curator.enableAutoExtraction();
      expect(curator.isAutoExtractionEnabled()).toBe(true);
      curator.disableAutoExtraction();
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