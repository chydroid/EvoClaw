import {
  type SKILLmdDocument,
  type SKILLmdMeta,
  type SkillTrigger,
} from "@evoclaw/core";

const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/;
const NAME_REGEX = /^[a-z][a-z0-9-]*$/;
const VALID_TRIGGER_TYPES: SkillTrigger["type"][] = [
  "keyword",
  "intent",
  "schedule",
  "event",
  "webhook",
];

// Content quality: patterns that indicate placeholder/garbage skill content
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^执行操作(?:。)?$/,
  /^execut(?:e|ing)\s+(?:the\s+)?task/i,
  /^方案\d*$/,
  /^解决[方方]案[ABCDEFG]?(?:方案)?$/,
  /^任务[ABCDEFG]?(?:描述)?$/,
  /^auto-generated/i,
  /^placeholder/i,
  /^te?mp$/i,
  /^follow\s+the\s+steps$/i,
  /^do\s+the\s+thing$/i,
];

const RESERVED_PREFIXES = ["curated-skill", "custom-skill", "new-skill", "test-skill", "temp-"];
const GENERIC_NAMES = ["task", "test", "skill", "tool", "helper", "util", "plugin", "script", "module", "action"];

export class SkillValidator {
  validateManifest(meta: SKILLmdMeta): {
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!meta.name || meta.name.trim() === "") {
      errors.push("Skill name is required");
    } else if (!NAME_REGEX.test(meta.name)) {
      errors.push(
        `Skill name "${meta.name}" does not follow naming convention (lowercase, starts with letter, alphanumeric and hyphens only)`
      );
    } else {
      if (meta.name.length < 3) {
        warnings.push(`Skill name "${meta.name}" is very short — consider a more descriptive name`);
      }
      if (meta.name.length > 64) {
        errors.push(`Skill name "${meta.name}" exceeds 64 characters`);
      }
      for (const prefix of RESERVED_PREFIXES) {
        if (meta.name.startsWith(prefix)) {
          warnings.push(`Skill name "${meta.name}" starts with reserved prefix "${prefix}" — may indicate an auto-generated placeholder skill`);
          break;
        }
      }
      if (GENERIC_NAMES.includes(meta.name)) {
        warnings.push(`Skill name "${meta.name}" is too generic — consider a more specific name describing the actual workflow`);
      }
    }

    if (!meta.version || meta.version.trim() === "") {
      errors.push("Skill version is required");
    } else if (!SEMVER_REGEX.test(meta.version)) {
      errors.push(
        `Skill version "${meta.version}" is not a valid semver (e.g., 1.0.0)`
      );
    }

    if (!meta.description || meta.description.trim() === "") {
      errors.push("Skill description is required and cannot be empty");
    } else {
      const desc = meta.description.trim();
      if (desc.length < 20) {
        warnings.push(
          `Skill description is very short (${desc.length} chars) — provide a meaningful description of what problem this solves and when to use it`
        );
      }
      for (const pattern of PLACEHOLDER_PATTERNS) {
        if (pattern.test(desc)) {
          warnings.push(
            `Skill description "${desc}" appears to be a placeholder — this skill may be auto-generated garbage`
          );
          break;
        }
      }
    }

    if (
      !meta.triggers ||
      !Array.isArray(meta.triggers) ||
      meta.triggers.length === 0
    ) {
      errors.push("Skill triggers must be a non-empty array");
    }

    if (!meta.author || meta.author.trim() === "") {
      errors.push("Skill author is required and cannot be empty");
    } else if (meta.author === "evoclaw-curator") {
      warnings.push(
        "Skill author is 'evoclaw-curator' — this skill may be auto-generated and should be reviewed for quality"
      );
    }

    return { errors, warnings };
  }

  validateTriggers(triggers: SkillTrigger[]): {
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!Array.isArray(triggers)) {
      errors.push("Triggers must be an array");
      return { errors, warnings };
    }

    for (let i = 0; i < triggers.length; i++) {
      const trigger = triggers[i];
      if (!trigger.type || !VALID_TRIGGER_TYPES.includes(trigger.type)) {
        errors.push(
          `Trigger[${i}] has invalid type "${trigger.type}" (must be one of: ${VALID_TRIGGER_TYPES.join(", ")})`
        );
      }
      if (!trigger.pattern || trigger.pattern.trim() === "") {
        errors.push(`Trigger[${i}] has empty pattern`);
      }
    }

    return { errors, warnings };
  }

  validateScripts(scripts: Record<string, string>): {
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!scripts || typeof scripts !== "object") {
      return { errors, warnings };
    }

    for (const [key, code] of Object.entries(scripts)) {
      if (typeof code !== "string") {
        errors.push(`Script "${key}" is not a string`);
        continue;
      }

      const isTypeScript =
        /:\s*(string|number|boolean|void|any|unknown|Promise|Record|Array)\b/.test(
          code
        ) ||
        /interface\s+\w+/.test(code) ||
        /type\s+\w+\s*=/.test(code);

      if (isTypeScript && !/export\s+(async\s+)?function\s+/.test(code)) {
        warnings.push(
          `TypeScript script "${key}" should contain an export function`
        );
      }
    }

    return { errors, warnings };
  }

  validate(skill: SKILLmdDocument): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const allErrors: string[] = [];
    const allWarnings: string[] = [];

    const manifestResult = this.validateManifest(skill.meta);
    allErrors.push(...manifestResult.errors);
    allWarnings.push(...manifestResult.warnings);

    const triggersResult = this.validateTriggers(skill.meta.triggers);
    allErrors.push(...triggersResult.errors);
    allWarnings.push(...triggersResult.warnings);

    // Validate instructions content quality
    if (skill.instructions && skill.instructions.trim()) {
      const instr = skill.instructions.trim();
      if (instr.length < 50) {
        allWarnings.push(
          `Skill instructions are very short (${instr.length} chars) — provide detailed step-by-step instructions`
        );
      }
      for (const pattern of PLACEHOLDER_PATTERNS) {
        if (pattern.test(instr)) {
          allWarnings.push(
            `Skill instructions appear to be a placeholder — this skill may be auto-generated garbage`
          );
          break;
        }
      }
    } else {
      allWarnings.push("Skill has no instructions — add detailed step-by-step instructions for how to use this skill");
    }

    if (skill.scripts && Object.keys(skill.scripts).length > 0) {
      const scriptsResult = this.validateScripts(skill.scripts);
      allErrors.push(...scriptsResult.errors);
      allWarnings.push(...scriptsResult.warnings);
    }

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
      warnings: allWarnings,
    };
  }
}
