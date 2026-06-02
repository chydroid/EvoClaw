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
