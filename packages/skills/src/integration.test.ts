import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { SkillManager } from "../src/skill-manager";
import type { Skill, SkillExecutionResult } from "@evoclaw/core";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";

const TEST_SKILL_CONTENT = `---
name: test-math-helper
version: 1.0.0
description: A simple math utility for testing
author: EvoClaw Test Team
triggers:
  - type: keyword
    pattern: "calculate|math|compute"
    description: Triggers on math-related queries
requires:
  - name: lodash
    version: ">=4.0.0"
    optional: true
config:
  precision: 2
---

## Instructions

This skill performs basic mathematical calculations.

1. Parse the input to extract numbers and operations
2. Perform the calculation
3. Return formatted result

## Scripts

\`\`\`typescript
function calculate(operation, a, b) {
  switch (operation) {
    case "add": return a + b;
    case "subtract": return a - b;
    case "multiply": return a * b;
    case "divide":
      if (b === 0) throw new Error("Division by zero");
      return a / b;
    default:
      return a + b;
  }
}

_result = calculate(
  params.operation || "add",
  Number(params.a) || 0,
  Number(params.b) || 0
);
\`\`\`

## Examples

User: "Calculate 5 + 3"
Result: 8
`;

describe("SkillManager Integration", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let skillManager: SkillManager;
  let testSkillPath: string;

  beforeAll(async () => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    registry.registerService("eventBus", eventBus);

    skillManager = new SkillManager(registry, eventBus);

    const skillDir = path.join(os.tmpdir(), "evoclaw-skill-test-math");
    await fs.mkdir(skillDir, { recursive: true });
    testSkillPath = path.join(skillDir, "test-math.SKILL.md");
    await fs.writeFile(testSkillPath, TEST_SKILL_CONTENT, "utf-8");
  });

  afterAll(async () => {
    try {
      await fs.rm(path.dirname(testSkillPath), { recursive: true, force: true });
    } catch {
    }
  });

  describe("Skill Installation", () => {
    it("should install a skill from a SKILL.md file", async () => {
      const skill = await skillManager.installSkill(testSkillPath);

      expect(skill).toBeDefined();
      expect(skill.name).toBe("test-math-helper");
      expect(skill.version).toBe("1.0.0");
      expect(skill.description).toBe("A simple math utility for testing");
      expect(skill.author).toBe("EvoClaw Test Team");
      expect(skill.category).toBe("custom");
      expect(skill.triggers).toHaveLength(1);
      expect(skill.triggers[0].type).toBe("keyword");
      expect(skill.requires).toHaveLength(1);
      expect(skill.config.precision).toBe(2);
    });

    it("should store skill body (instructions and scripts)", async () => {
      const skill = await skillManager.installSkill(testSkillPath);

      expect(skill.body).toBeDefined();
      expect(skill.body.instructions).toContain("mathematical calculations");
      expect(skill.body.scripts).toBeDefined();
      expect(Object.keys(skill.body.scripts).length).toBeGreaterThan(0);
      expect(skill.body.examples).toHaveLength(1);
    });

    it("should activate skill on install with lifecycle status active", async () => {
      const skill = await skillManager.installSkill(testSkillPath);

      expect(skill.lifecycle.status).toBe("active");
      expect(skill.lifecycle.installDate).toBeInstanceOf(Date);
    });
  });

  describe("Skill Execution", () => {
    it("should execute a skill and return result", async () => {
      const skill = await skillManager.installSkill(testSkillPath);

      const result = await skillManager.executeSkill(skill.id, {
        operation: "add",
        a: 5,
        b: 3,
      });

      expect(result.success).toBe(true);
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.output).toBe(8);
    });

    it("should return error for unknown skill", async () => {
      const result = await skillManager.executeSkill("non-existent-id", {});

      expect(result.success).toBe(false);
      expect(result.errors).toContain("Skill not found");
    });

    it("should update skill stats after execution", async () => {
      const skill = await skillManager.installSkill(testSkillPath);

      await skillManager.executeSkill(skill.id, { operation: "add", a: 1, b: 1 });
      await skillManager.executeSkill(skill.id, { operation: "multiply", a: 3, b: 4 });

      const updated = await skillManager.getSkill(skill.id);
      expect(updated).toBeDefined();
      expect(updated!.stats.invocationCount).toBeGreaterThanOrEqual(2);
      expect(updated!.stats.successCount).toBeGreaterThanOrEqual(2);
      expect(updated!.stats.lastInvocation).toBeInstanceOf(Date);
    });
  });

  describe("Skill Search", () => {
    it("should search skills by keyword", { timeout: 15000 }, async () => {
      await skillManager.installSkill(testSkillPath);

      const result = await skillManager.searchSkills({ keyword: "math" });

      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.entries[0].name).toBe("test-math-helper");
    });

    it("should search local skills", async () => {
      const result = await skillManager.searchLocalSkills({ keyword: "helper" });

      expect(result.total).toBeGreaterThan(0);
    });

    it("should list all skills", async () => {
      const skills = await skillManager.listSkills();

      expect(skills.length).toBeGreaterThan(0);
    });
  });

  describe("Skill Health", () => {
    it("should check skill health", async () => {
      const skill = await skillManager.installSkill(testSkillPath);

      const healthResult = await skillManager.checkSkillHealth(skill.id);

      expect(healthResult).toBeDefined();
      expect(healthResult!.healthy).toBe(true);
    });

    it("should get health report with statistics", async () => {
      const skill = await skillManager.installSkill(testSkillPath);

      const report = skillManager.getSkillHealthReport(skill.id);

      expect(report).toBeDefined();
      expect(report!.skillName).toBe("test-math-helper");
      expect(report!.healthy).toBe(true);
      expect(report!.recommendation).toBeDefined();
      expect(report!.recommendation!.length).toBeGreaterThan(0);
    });
  });

  describe("Skill Uninstallation", () => {
    it("should uninstall a skill", async () => {
      const skill = await skillManager.installSkill(testSkillPath);

      await skillManager.uninstallSkill(skill.id);

      const removed = await skillManager.getSkill(skill.id);
      expect(removed).toBeUndefined();
    });
  });
});

describe("SkillRegistry Integration", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let skillManager: SkillManager;

  beforeAll(async () => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    registry.registerService("eventBus", eventBus);
    skillManager = new SkillManager(registry, eventBus);

    const skillDir = path.join(os.tmpdir(), "evoclaw-skill-registry2");
    await fs.mkdir(skillDir, { recursive: true });
    const testPath = path.join(skillDir, "test-registry2.SKILL.md");
    await fs.writeFile(testPath, TEST_SKILL_CONTENT, "utf-8");
    await skillManager.installSkill(testPath);
    await fs.unlink(testPath).catch(() => {});
  });

  afterAll(async () => {
    try {
      await fs.rm(path.join(os.tmpdir(), "evoclaw-skill-registry2"), { recursive: true, force: true });
    } catch {
    }
  });

  describe("Skill Registration", () => {
    it("should auto-register skill on install", () => {
      const skillReg = skillManager.getSkillRegistry();

      expect(skillReg.getSkillCount()).toBe(1);
    });

    it("should find registered skill in local search", async () => {
      const result = await skillManager.searchLocalSkills({});

      expect(result.total).toBe(1);
      expect(result.entries[0].skillId).toBeDefined();
      expect(result.entries[0].category).toBe("custom");
    });
  });
});

describe("Sandbox Security Integration", () => {
  it("should not expose dangerous globals in sandbox context", async () => {
    const registry = new ServiceRegistry();
    const eventBus = new EventBus();
    registry.registerService("eventBus", eventBus);

    const skillManager = new SkillManager(registry, eventBus);

    const safeSkillContent = `---
name: security-check
version: 1.0.0
description: Security validation test
author: Test
triggers:
  - type: keyword
    pattern: "security-check"
    description: Test trigger
---

## Scripts

\`\`\`typescript
_result = {
  hasProcess: typeof process !== "undefined",
  hasGlobal: typeof global !== "undefined",
  hasRequire: typeof require !== "undefined",
  hasFetch: typeof fetch !== "undefined",
  hasEval: typeof eval !== "undefined",
};
\`\`\`
`;

    const skillDir = path.join(os.tmpdir(), "evoclaw-skill-security");
    await fs.mkdir(skillDir, { recursive: true });
    const testPath = path.join(skillDir, "test-security-check.SKILL.md");
    await fs.writeFile(testPath, safeSkillContent, "utf-8");

    const skill = await skillManager.installSkill(testPath);
    const result = await skillManager.executeSkill(skill.id, {});

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();

    if (typeof result.output === "object" && result.output !== null) {
      const output = result.output as Record<string, boolean>;
      expect(output.hasProcess).toBe(false);
      expect(output.hasGlobal).toBe(false);
      expect(output.hasRequire).toBe(false);
      expect(output.hasEval).toBe(false);
    }

    await fs.rm(skillDir, { recursive: true, force: true }).catch(() => {});
  });
});