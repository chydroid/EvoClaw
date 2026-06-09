import type { AgentModelExecutor } from "@evoclaw/agent";
import type { SkillIndex } from "@evoclaw/skills";

export function registerSkillIndexTools(
  executor: AgentModelExecutor,
  skillIndex: SkillIndex
): void {
  const index = skillIndex;

  executor.registerTool(
    "skill_view",
    {
      name: "skill_view",
      description: "View a skill at a specific detail level. Level 0 = brief (~20 tokens), Level 1 = detailed (~200 tokens), Level 2 = full instructions (~1000+ tokens). Default: Level 1.",
      parameters: {
        skill: { type: "string", description: "Skill name or ID to view" },
        level: { type: "number", description: "Detail level: 0 (brief), 1 (detailed), 2 (full). Default: 1" },
      },
    },
    async (params: Record<string, unknown>) => {
      const skillName = String(params.skill || "");
      const level = Number(params.level ?? 1) as 0 | 1 | 2;
      const allEntries = index.getAll();
      const entry = allEntries.find(e => e.name === skillName || e.id === skillName);
      if (!entry) return { error: `Skill "${skillName}" not found in index` };
      const content = index.getSkillLevel(entry.id, level);
      if (!content) return { error: `Skill "${skillName}" level ${level} not available` };
      return { skillName: entry.name, level, content, successRate: entry.successRate, useCount: entry.useCount };
    }
  );

  executor.registerTool(
    "skill_index_list",
    {
      name: "skill_index_list",
      description: "List all skills in the compact Level 0 index (minimal token usage)",
      parameters: {},
    },
    async () => {
      const level0 = index.getLevel0Index();
      const count = index.getSize();
      return { count, index: level0 };
    }
  );
}
