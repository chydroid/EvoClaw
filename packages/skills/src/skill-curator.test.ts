import { describe, it, expect, beforeAll } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { SkillCurator } from "../src/skill-curator";
import type { SkillEvolutionEntry } from "../src/skill-curator";

describe("SkillCurator", () => {
  function createCurator() {
    const registry = new ServiceRegistry();
    const eventBus = new EventBus();
    registry.registerService("eventBus", eventBus);
    const curator = new SkillCurator(registry, eventBus);
    return { curator, registry, eventBus };
  }

  describe("extractSkillFromSolution", () => {
    it("should extract a skill from a successful task solution", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution(
        "搜索最新的科技新闻",
        "1. 调用搜索API获取关键词结果\n2. 过滤和排序结果\n3. 返回格式化的新闻列表",
        { source: "task-completion", taskId: "test-1" }
      );

      expect(skill).toBeDefined();
      expect(skill!.name).toBeDefined();
      expect(skill!.version).toBe("1.0.0");
      expect(skill!.description).toContain("搜索");
      expect(skill!.lifecycle.status).toBe("active");
    });

    it("should create evolution entry on extraction", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution(
        "计算数学表达式",
        "解析表达式并返回计算结果",
        { source: "test" }
      );

      const evolution = curator.getSkillEvolution(skill!.id);
      expect(evolution).toBeDefined();
      expect(evolution!.skillName).toBeDefined();
      expect(evolution!.versions).toHaveLength(1);
      expect(evolution!.versions[0].trigger).toBe("extraction");
      expect(evolution!.versions[0].previousVersion).toBeNull();
      expect(evolution!.extractionSource).not.toBeNull();
      expect(evolution!.extractionSource!.task).toBe("计算数学表达式");
    });

    it("should derive appropriate category from task description", async () => {
      const { curator } = createCurator();

      const integrationSkill = await curator.extractSkillFromSolution(
        "调用外部API获取数据",
        "使用fetch调用REST API",
        {}
      );
      expect(integrationSkill!.category).toBe("integration");

      const analysisSkill = await curator.extractSkillFromSolution(
        "分析销售数据并生成统计报告",
        "聚合数据并计算统计指标",
        {}
      );
      expect(analysisSkill!.category).toBe("analysis");

      const generationSkill = await curator.extractSkillFromSolution(
        "生成项目文档",
        "根据代码结构自动生成文档",
        {}
      );
      expect(generationSkill!.category).toBe("generation");
    });

    it("should derive triggers from task description", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution(
        "搜索新闻并返回结果",
        "执行搜索查询",
        {}
      );

      expect(skill!.triggers.length).toBeGreaterThan(0);
      expect(skill!.triggers[0].type).toBe("keyword");
    });

    it("should handle empty or minimal task/solution gracefully", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution(
        "a",
        "b",
        {}
      );

      expect(skill).toBeDefined();
      expect(skill!.name).toBeDefined();
    });
  });

  describe("improveSkill", () => {
    it("should improve skill based on execution failure", async () => {
      const { curator } = createCurator();

      const skill = await curator.extractSkillFromSolution(
        "文件处理工具",
        "读取文件内容并处理",
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
        "数据转换工具",
        "将CSV转换为JSON格式",
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
        "代码格式化工具",
        "格式化TypeScript代码",
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
        "待弃用技能",
        "执行某些操作",
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
        "批量数据处理",
        "处理大量数据记录",
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
        "旧版工具",
        "执行旧版操作",
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
        "重复弃用测试",
        "执行操作",
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
        "版本历史测试",
        "执行操作",
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

      await curator.extractSkillFromSolution("任务A", "解决方案A", {});
      await curator.extractSkillFromSolution("任务B", "解决方案B", {});

      const evolutions = curator.getAllEvolutions();
      expect(evolutions.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("getEvolutionStats", () => {
    it("should return accurate statistics", async () => {
      const { curator } = createCurator();

      const skill1 = await curator.extractSkillFromSolution("统计任务1", "方案1", {});
      const skill2 = await curator.extractSkillFromSolution("统计任务2", "方案2", {});

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
        "版本管理测试",
        "执行操作",
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
        "版本追踪测试",
        "执行操作",
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

  describe("healthCheck", () => {
    it("should return true", async () => {
      const { curator } = createCurator();
      const healthy = await curator.healthCheck();
      expect(healthy).toBe(true);
    });
  });
});
