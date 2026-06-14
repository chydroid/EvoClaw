import path from "path";
import type { AgentModelExecutor } from "@evoclaw/agent";
import type { AutoSkillManager, SkillManager } from "@evoclaw/skills";
import type { ServiceRegistry } from "@evoclaw/core";

export function registerAutoSkillTools(
  executor: AgentModelExecutor,
  autoSkillManager: AutoSkillManager,
  skillManager: SkillManager,
  registry: ServiceRegistry
): void {
  const autoSkill = autoSkillManager;

  executor.registerTool(
    "skill_find_and_install",
    {
      name: "skill_find_and_install",
      description: "Automatically find a suitable skill for a task and install it",
      parameters: {
        task: { type: "string", description: "Description of the task to find a skill for" },
      },
    },
    async (params: Record<string, unknown>) => {
      const task = String(params.task || "");
      return await autoSkill.autoInstallForTask(task);
    }
  );

  // ---- Skill lifecycle tools ----

  executor.registerTool(
    "skill_install",
    {
      name: "skill_install",
      description: "Install a skill from its SKILL.md file path or skills directory. Use after skill_search finds a match.",
      parameters: {
        path: { type: "string", description: "Path to the SKILL.md file or skill folder" },
      },
    },
    async (params: Record<string, unknown>) => {
      const skillPath = String(params.path || "");
      try {
        const installed = await skillManager.installSkill(skillPath);
        return { success: true, skillId: installed.id, skillName: installed.name, description: installed.description };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  executor.registerTool(
    "skill_execute",
    {
      name: "skill_execute",
      description: "Execute an installed skill by name or ID with parameters",
      parameters: {
        skill: { type: "string", description: "Skill name or ID to execute", required: true },
        params: { type: "object", description: "Parameters to pass to the skill as a JSON object (optional). Can also be a JSON string.", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const skillName = String(params.skill || "");
      let execParams: Record<string, unknown> = {};
      try {
        const rawParams = params.params;
        if (rawParams && typeof rawParams === "object") {
          execParams = rawParams as Record<string, unknown>;
        } else if (rawParams && typeof rawParams === "string") {
          execParams = JSON.parse(rawParams);
        }
      } catch {
        return { success: false, error: "Invalid JSON in params parameter" };
      }
      try {
        const result = await skillManager.executeSkill(skillName, execParams);
        return { success: true, result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  executor.registerTool(
    "skill_create",
    {
      name: "skill_create",
      description: "Create a new reusable Skill when no existing skill matches the task. Only use for genuinely reusable workflows that solve a generalizable problem. Skills must have a meaningful lowercase-hyphenated name (e.g. 'news-search', 'csv-to-json'), a substantive description of what problem it solves and when to use it, and detailed step-by-step instructions with actual tools/APIs/code. DO NOT create skills for one-off tasks, placeholder content, or tasks solvable by a single existing tool.",
      parameters: {
        name: { type: "string", description: "Skill name in lowercase-hyphenated format (e.g. 'news-search'). Must be meaningful and reusable." },
        description: { type: "string", description: "What problem this skill solves and when to use it. Be specific about the use case." },
        instructions: { type: "string", description: "Detailed step-by-step instructions with concrete tools, APIs, and code to execute. Must be specific and actionable." },
      },
    },
    async (params: Record<string, unknown>) => {
      const name = String(params.name || "").trim();
      const desc = String(params.description || "").trim();
      const instructions = String(params.instructions || "").trim();

      // --- Quality Gates ---

      const NAME_REGEX = /^[a-z][a-z0-9-]*$/;
      const RESERVED_PREFIXES = ["curated-skill", "custom-skill", "new-skill", "test-skill", "temp-"];
      const GENERIC_NAMES = ["task", "test", "skill", "tool", "helper", "util", "plugin", "script", "module", "action"];

      const PLACEHOLDER_DESC_PATTERNS: RegExp[] = [
        /^执行操作(?:。)?$/,
        /^方案\d*$/,
        /^解决[方方]案[ABCDEFG]?(?:方案)?$/,
        /^任务[ABCDEFG]?(?:描述)?$/,
        /^auto-generated/i,
        /^placeholder/i,
        /^te?mp$/i,
      ];
      const PLACEHOLDER_INSTR_PATTERNS: RegExp[] = [
        /^执行操作(?:。)?$/,
        /^execut(?:e|ing)\s+(?:the\s+)?task/i,
        /^方案\d*$/,
        /^follow\s+the\s+steps$/i,
      ];

      const errors: string[] = [];

      // 1. Name validation
      if (!name) {
        errors.push("Skill name is required");
      } else if (!NAME_REGEX.test(name)) {
        errors.push(`Skill name "${name}" must be lowercase, start with a letter, and contain only letters, numbers, and hyphens (e.g. 'news-search')`);
      } else if (name.length < 3) {
        errors.push("Skill name must be at least 3 characters");
      } else if (name.length > 64) {
        errors.push("Skill name must not exceed 64 characters");
      } else {
        for (const prefix of RESERVED_PREFIXES) {
          if (name.startsWith(prefix)) {
            errors.push(`Skill name cannot start with "${prefix}"`);
            break;
          }
        }
        if (GENERIC_NAMES.includes(name)) {
          errors.push(`"${name}" is too generic as a skill name. Use a more specific name describing the actual workflow.`);
        }
      }

      // 2. Description quality
      const isPlaceholder = (text: string, patterns: RegExp[]): boolean => {
        for (const p of patterns) {
          if (p.test(text)) return true;
        }
        return false;
      };

      if (!desc) {
        errors.push("Skill description is required");
      } else if (desc.length < 20) {
        errors.push(`Skill description is too short (${desc.length} chars). Provide a meaningful description of what problem this solves and when to use it.`);
      } else if (isPlaceholder(desc, PLACEHOLDER_DESC_PATTERNS)) {
        errors.push(`Skill description "${desc}" appears to be a placeholder. Please provide a meaningful description.`);
      } else if (desc === name || desc.replace(/[-_\s]/g, "") === name.replace(/[-_\s]/g, "")) {
        errors.push("Skill description should not be identical to the skill name. Describe what the skill does.");
      }

      // 3. Instructions quality
      if (!instructions) {
        errors.push("Skill instructions are required");
      } else if (instructions.length < 50) {
        errors.push(`Skill instructions are too short (${instructions.length} chars). Provide detailed step-by-step instructions.`);
      } else if (isPlaceholder(instructions, PLACEHOLDER_INSTR_PATTERNS)) {
        errors.push("Skill instructions appear to be a placeholder. Provide concrete, actionable steps.");
      }

      // 3.1 指令长度门控：instructions 必须 >= 200 字符
      if (instructions && instructions.length < 200) {
        errors.push(`Skill instructions are too short (${instructions.length} chars, minimum 200). Instructions must contain substantive content, not just a template shell.`);
      }

      // 3.2 指令步骤验证：必须包含至少 2 个具体步骤或操作
      if (instructions) {
        const numberedSteps = instructions.match(/\b\d+\.\s/g) || [];
        const listItems = instructions.match(/^[\s]*[-*]\s/gm) || [];
        const totalSteps = numberedSteps.length + listItems.length;
        if (totalSteps < 2) {
          errors.push(`Skill instructions must include at least 2 concrete steps or actions (found ${totalSteps}). Use numbered steps (e.g. "1.") or list items (e.g. "- ").`);
        }
      }

      // 3.3 禁止模板步骤检测：拒绝完全相同的7步模板
      if (instructions) {
        const TEMPLATE_STEPS = ["Initialize", "Parse", "Execute", "Handle edge cases", "Format", "Log", "Cleanup"];
        const allTemplateStepsPresent = TEMPLATE_STEPS.every(step => instructions.includes(step));
        if (allTemplateStepsPresent) {
          errors.push("Skill instructions appear to follow a generic 7-step template (Initialize → Parse → Execute → Handle edge cases → Format → Log → Cleanup). Provide domain-specific steps instead.");
        }
      }

      // 3.4 功能性验证：instructions 必须提及至少一个具体的工具、API、脚本或命令
      if (instructions) {
        const FUNCTIONAL_KEYWORDS = /\b(API|script|fetch|curl|python|node|http|endpoint|command|npm|pip|docker|git|ssh|sql|redis|mongo|postgres|axios|request|shell|bash|powershell|cli|sdk|library|module|import|require|exec|spawn|run)\b/i;
        if (!FUNCTIONAL_KEYWORDS.test(instructions)) {
          errors.push("Skill instructions must reference at least one concrete tool, API, script, or command (e.g. API, fetch, curl, python, node, http, endpoint, command). Purely abstract instructions are not allowed.");
        }
      }

      // 3.5 描述长度门控：description 必须 >= 30 字符
      if (desc && desc.length < 30) {
        errors.push(`Skill description is too short (${desc.length} chars, minimum 30). Provide a more detailed description of what problem this skill solves.`);
      }

      // 3.6 名称与描述相关性：name 中的关键词必须出现在 description 中
      if (name && desc) {
        const nameWords = name.split(/[-_]/).filter(w => w.length > 2);
        const descLower = desc.toLowerCase();
        const matchedWords = nameWords.filter(w => descLower.includes(w));
        if (nameWords.length > 0 && matchedWords.length === 0) {
          errors.push(`Skill name keywords (${nameWords.join(", ")}) do not appear in the description. The description should relate to the skill name.`);
        }
      }

      // 4. Check for duplicate skills
      if (errors.length === 0) {
        try {
          const existing = await skillManager.listSkills();
          const similar = existing.filter((s: { name: string }) =>
            s.name.toLowerCase() === name.toLowerCase() ||
            s.name.toLowerCase().replace(/[-_\s]/g, "") === name.toLowerCase().replace(/[-_\s]/g, "")
          );
          if (similar.length > 0) {
            errors.push(`A skill with a similar name "${similar[0].name}" already exists. Use skill_improve to update it instead.`);
          }
        } catch {
          // listSkills may fail — non-fatal
        }
      }

      if (errors.length > 0) {
        return {
          success: false,
          error: `Skill creation rejected. ${errors.join("; ")}`,
          details: {
            rejected: true,
            reason: "quality_gate",
            errors,
            hint: "Skills should represent reusable, generalizable workflows with concrete instructions. Do not create skills for one-off tasks or with placeholder content.",
          },
        };
      }

      // --- Create the skill ---
      try {
        const fsMgr = registry.resolveService<{ createFile(path: string, content: string): Promise<{ path: string; size: number }> }>("fileSystemManager");
        const skillDir = path.resolve(__dirname, "..", "..", "..", "data", "workspace", "skills", name);
        const skillContent = `# ${name}\n\n> ${desc}\n\n## Instructions\n\n${instructions}\n\n## Config\n\n\`\`\`yaml\nname: ${name}\ndescription: "${desc.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"\nversion: 1.0.0\ncategory: custom\ninputs:\n  query:\n    type: string\n    required: true\n\`\`\`\n`;
        if (fsMgr) {
          await fsMgr.createFile(`${skillDir}/SKILL.md`, skillContent);
        } else {
          const fsPath = require("path");
          const skillFullPath = fsPath.resolve(__dirname, "..", "..", "..", skillDir);
          require("fs").mkdirSync(skillFullPath, { recursive: true });
          require("fs").writeFileSync(fsPath.join(skillFullPath, "SKILL.md"), skillContent, "utf-8");
        }
        const installed = await skillManager.installSkill(skillDir);
        return { success: true, skillId: installed.id, skillName: installed.name, message: `Skill "${name}" has been created, installed, and is ready to use!` };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  executor.registerTool(
    "skill_search",
    {
      name: "skill_search",
      description: "Search for available skills matching a task description",
      parameters: {
        task: { type: "string", description: "Description of the task to search skills for" },
      },
    },
    async (params: Record<string, unknown>) => {
      const task = String(params.task || "");
      const match = await autoSkill.findSkillForTask(task);
      if (!match) return { found: false, reason: "No matching skill found" };

      // If the skill is already installed, include its command templates
      const result: Record<string, unknown> = {
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
    }
  );
}
