import type { AgentModelExecutor } from "@evoclaw/agent";
import type { AutoSkillManager, SkillIndex, SkillManager } from "@evoclaw/skills";

/**
 * Skill Index Tools — 技能索引复合工具
 *
 * `skill_view` 保持不变；原 `skill_index_list` 与 `skill_search`（后者实现自
 * skill-tools.ts 迁入）合并为 `skill_list`，通过 `action` 判别字段分发：
 *   - skill_list (action=index)   列出 Level 0 紧凑索引
 *   - skill_list (action=search)  按任务描述搜索技能
 */
export function registerSkillIndexTools(
  executor: AgentModelExecutor,
  skillIndex: SkillIndex,
  autoSkillManager?: AutoSkillManager,
  skillManager?: SkillManager
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
      const parsedLevel = Number(params.level ?? 1);
      // 值域校验：仅接受 0/1/2，其余回退为默认 1，避免任意值通过类型断言
      const level: 0 | 1 | 2 = [0, 1, 2].includes(parsedLevel) ? (parsedLevel as 0 | 1 | 2) : 1;
      const allEntries = index.getAll();
      const entry = allEntries.find(e => e.name === skillName || e.id === skillName);
      if (!entry) return { success: false, error: `Skill "${skillName}" not found in index` };
      const content = index.getSkillLevel(entry.id, level);
      if (!content) return { success: false, error: `Skill "${skillName}" level ${level} not available` };
      return { skillName: entry.name, level, content, successRate: entry.successRate, useCount: entry.useCount };
    }
  );

  // ── action=index（原 skill_index_list）：列出 Level 0 紧凑索引 ─
  const handleIndexList = async (_params: Record<string, unknown>) => {
    const level0 = index.getLevel0Index();
    const count = index.getSize();
    return { count, index: level0 };
  };

  // ── action=search（原 skill_search，实现自 skill-tools.ts 迁入）──
  const handleSearch = async (params: Record<string, unknown>) => {
    const task = String(params.task || "");
    if (!autoSkillManager || !skillManager) {
      return { success: false, error: "AutoSkill/SkillManager service not available" };
    }
    const match = await autoSkillManager.findSkillForTask(task);
    if (!match) return { success: true, found: false, reason: "No matching skill found" };

    // If the skill is already installed, include its command templates
    const result: Record<string, unknown> = {
      success: true,
      found: true,
      skillName: match.skillName,
      skillPath: match.skillPath,
      relevance: match.relevance,
      reason: match.reason,
    };

    try {
      const skills = await skillManager.listSkills();
      const installed = skills.find(s =>
        s.name === match.skillName || s.name.replace(/[_-]/g, "") === match.skillName.replace(/[_-]/g, "")
      );
      if (installed) {
        result.installed = true;
        result.installPath = installed.installPath;
        // Extract command templates from SKILL.md instructions
        const instructions = installed.body?.instructions || "";
        const commandLines: string[] = [];
        const codeBlockRegex = /```(?:bash|shell|sh)?\s*\n([\s\S]*?)```/g;
        let blockMatch: RegExpExecArray | null;
        while ((blockMatch = codeBlockRegex.exec(instructions)) !== null) {
          const block = blockMatch[1];
          for (const line of block.split("\n")) {
            const trimmed = line.trim();
            if (trimmed && (trimmed.startsWith("python") || trimmed.startsWith("node") || trimmed.startsWith("bash") || trimmed.startsWith("sh "))) {
              commandLines.push(trimmed);
            }
          }
        }
        if (commandLines.length > 0) {
          result.commands = commandLines;
          result.hint = "Use shell_exec to run these commands. Replace {baseDir} with the skill's directory.";
        }
      }
    } catch { /* best-effort */ }

    return result;
  };

  executor.registerTool(
    "skill_list",
    {
      name: "skill_list",
      description:
        "List or search available skills. " +
        "action=index: list all skills in the compact Level 0 index (minimal token usage); " +
        "action=search: search for available skills matching a task description.",
      parameters: {
        action: { type: "string", description: "skill_list 操作类型", required: true, enum: ["index", "search"] },
        task: { type: "string", description: "Description of the task to search skills for（action=search 使用）", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "index");
      if (action === "index") return await handleIndexList(params);
      if (action === "search") return await handleSearch(params);
      return { success: false, error: `未知 skill_list action: ${action}（仅支持 index / search）` };
    }
  );
}
