/**
 * agentskills.io 公开标准兼容层
 *
 * 规范来源：https://agentskills.io/specification.md
 * Agent Skills 是 Anthropic 发起并开放的轻量级技能格式：
 * 一个技能 = 一个目录，至少包含 SKILL.md（YAML frontmatter + Markdown 正文）。
 *
 * frontmatter 字段：
 * - name（必填）：1-64 字符，仅小写字母/数字/连字符，不得以连字符开头或结尾，
 *   不得包含连续连字符，且应与父目录同名
 * - description（必填）：1-1024 字符，非空
 * - license（可选）：许可证名或内置许可文件引用
 * - compatibility（可选）：≤500 字符，声明运行环境要求
 * - metadata（可选）：string→string 任意映射，客户端扩展字段
 * - allowed-tools（可选，实验性）：空格分隔的预授权工具列表
 *
 * 渐进式披露（progressive disclosure）三阶段：
 * 1. 发现：启动时仅加载 name + description（~100 tokens）
 * 2. 激活：任务匹配时加载完整 SKILL.md（建议 <5000 tokens）
 * 3. 执行：按需加载 scripts/ references/ assets/ 等资源
 * 规范建议 SKILL.md 正文 ≤500 行。
 *
 * EvoClaw 定位：
 * - 在 OpenClaw 私标（skill-md-parser.ts 的 OpenClawMetadata）之外增加公开标准支持
 * - 校验（本模块）接入 SkillManager.installSkill / SkillValidator，作为「规范校验」层
 * - frontmatter 解析复用 SKILLmdParser（metadata/compatibility 归一化进 SKILLmdMeta）
 * - 不破坏 OpenClaw 既有字段语义；两者并存，互不覆盖
 */

import type { AgentSkillsMeta } from "@evoclaw/core";

/** 规范上限：SKILL.md 正文建议行数 */
export const AGENT_SKILLS_MAX_BODY_LINES = 500;
/** 规范上限：name 字段最大长度 */
export const AGENT_SKILLS_MAX_NAME_LENGTH = 64;
/** 规范上限：description 字段最大长度 */
export const AGENT_SKILLS_MAX_DESCRIPTION_LENGTH = 1024;
/** 规范上限：compatibility 字段最大长度 */
export const AGENT_SKILLS_MAX_COMPATIBILITY_LENGTH = 500;

/**
 * name 字段规范正则：
 * - 1-64 字符
 * - 仅 unicode 小写字母数字与连字符（不含下划线，规范明确）
 * - 不以连字符开头/结尾
 * - 不含连续连字符
 * /u 标志使 \p{Ll} 匹配 unicode 小写字母；显式排除下划线（\w 含 _，须剔除）。
 */
const AGENT_SKILLS_NAME_REGEX = /^(?![-])(?!.*--)(?!.*-$)[\p{Ll}\p{Nd}·ßçþ-]{1,64}$/u;

export interface AgentSkillsValidation {
  /** 是否符合 agentskills.io 规范（errors 为空即合规） */
  specValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface AgentSkillsValidator {
  /** 校验 frontmatter（data 为解析后的扁平字段，key 为 frontmatter 原始名） */
  validateFrontmatter(
    data: Record<string, unknown>,
    options?: { /** 父目录名，用于 name 一致性检查 */ dirName?: string }
  ): AgentSkillsValidation;
  /** 校验 SKILL.md 正文（渐进式披露约束） */
  validateBody(body: string): AgentSkillsValidation;
  /** 组合校验：frontmatter + body */
  validate(
    data: Record<string, unknown>,
    body: string,
    options?: { dirName?: string }
  ): AgentSkillsValidation;
}

export class AgentSkillsStdValidator implements AgentSkillsValidator {
  validateFrontmatter(
    data: Record<string, unknown>,
    options?: { /** 父目录名，用于 name 一致性检查；显式传 false 跳过（安装/测试等目录名非规范化的场景） */ dirName?: string | false }
  ): AgentSkillsValidation {
    const errors: string[] = [];
    const warnings: string[] = [];

    // ── name（必填）──
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!name) {
      errors.push("agentskills: frontmatter field \"name\" is required");
    } else {
      if (name.length > AGENT_SKILLS_MAX_NAME_LENGTH) {
        errors.push(
          `agentskills: "name" is ${name.length} chars — spec limit is ${AGENT_SKILLS_MAX_NAME_LENGTH}`
        );
      }
      if (!AGENT_SKILLS_NAME_REGEX.test(name)) {
        errors.push(
          `agentskills: "name" must be 1-${AGENT_SKILLS_MAX_NAME_LENGTH} chars of ` +
            "lowercase alphanumerics and hyphens, must not start/end with a hyphen, " +
            `and must not contain consecutive hyphens (got "${name}")`
        );
      }
      // dirName === false 表示调用方显式跳过同名检查（安装目录名可能带
      // EvoClaw 私有前缀，如 data/skills/evoclaw-skill-<name>/，不属于规范形态）
      const dirName = options?.dirName;
      if (dirName !== undefined && dirName !== false && name !== dirName) {
        // 规范：name 必须与父目录同名。
        // 目录名可能本身不合规（如带下划线），此时按「规范形式」比较：
        // 对目录名做同名化（lowercase、_ → -）后仍不一致才判为错误，否则给警告。
        const normalizedDir = dirName.toLowerCase().replace(/_/g, "-");
        if (name === normalizedDir) {
          warnings.push(
            `agentskills: "name" "${name}" matches directory "${dirName}" only after normalization ` +
              "(directory name itself is not spec-compliant)"
          );
        } else {
          errors.push(
            `agentskills: "name" "${name}" must match the parent directory name "${dirName}"`
          );
        }
      }
    }

    // ── description（必填，1-1024）──
    const description = typeof data.description === "string" ? data.description.trim() : "";
    if (!description) {
      errors.push("agentskills: frontmatter field \"description\" is required (non-empty, 1-1024 chars)");
    } else if (description.length > AGENT_SKILLS_MAX_DESCRIPTION_LENGTH) {
      errors.push(
        `agentskills: "description" is ${description.length} chars — spec limit is ${AGENT_SKILLS_MAX_DESCRIPTION_LENGTH}`
      );
    }

    // ── compatibility（可选，≤500）──
    if (data.compatibility !== undefined && typeof data.compatibility === "string") {
      const compat = data.compatibility;
      if (compat.length > AGENT_SKILLS_MAX_COMPATIBILITY_LENGTH) {
        errors.push(
          `agentskills: "compatibility" is ${compat.length} chars — spec limit is ${AGENT_SKILLS_MAX_COMPATIBILITY_LENGTH}`
        );
      } else if (compat.trim() === "") {
        warnings.push("agentskills: \"compatibility\" is present but empty — omit it instead");
      }
    } else if (data.compatibility !== undefined) {
      errors.push('agentskills: "compatibility" must be a string');
    }

    // ── license（可选，字符串）──
    if (data.license !== undefined && typeof data.license !== "string") {
      errors.push('agentskills: "license" must be a string (license name or bundled file reference)');
    }

    // ── metadata（可选，string→string 映射）──
    const metadata = data.metadata;
    if (metadata !== undefined) {
      if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
        errors.push('agentskills: "metadata" must be a mapping of string keys to string values');
      } else {
        for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
          if (typeof value !== "string") {
            errors.push(
              `agentskills: metadata["${key}"] must be a string (got ${Array.isArray(value) ? "array" : typeof value}) — ` +
                "nested structures are not allowed by the spec"
            );
          }
        }
      }
    }

    // ── allowed-tools（可选、实验性：空格分隔字符串）──
    // 规范定义为 space-separated string；EvoClaw 同时容忍数组形态（OpenClaw 私标习惯），
    // 数组形态只给警告不判错，保持向后兼容。
    const allowedTools = data["allowed-tools"];
    if (allowedTools !== undefined) {
      if (typeof allowedTools === "string") {
        if (allowedTools.trim() === "") {
          warnings.push('agentskills: "allowed-tools" is present but empty — omit it instead');
        }
      } else if (Array.isArray(allowedTools)) {
        warnings.push('agentskills: "allowed-tools" should be a space-separated string (array form is non-standard)');
      } else {
        errors.push('agentskills: "allowed-tools" must be a string or array of strings');
      }
    }

    return {
      specValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  validateBody(body: string): AgentSkillsValidation {
    const errors: string[] = [];
    const warnings: string[] = [];

    const lines = body.split("\n");
    if (lines.length > AGENT_SKILLS_MAX_BODY_LINES) {
      warnings.push(
        `agentskills: SKILL.md body has ${lines.length} lines — exceeds the recommended ${AGENT_SKILLS_MAX_BODY_LINES} lines; ` +
          "move detailed reference material into references/ or assets/ (progressive disclosure)"
      );
    }

    // 执行阶段约束：正文中的文件引用应保持相对路径、一层深度（规范建议，仅警告）
    // 匹配形如 [x](a/b/FILE.md) 的 markdown 链接，其中路径含 ≥2 个 /（嵌套超一层）
    const deepRef = /\]\((?:[^\n\r)]*\/){2,}[^\n\r)]+\.(?:md|txt|pdf|json|yaml|yml|csv)\)/.exec(body);
    if (deepRef) {
      warnings.push(
        "agentskills: file reference is nested more than one level deep from SKILL.md — " +
          "the spec recommends keeping references one level deep"
      );
    }

    return { specValid: errors.length === 0, errors, warnings };
  }

  validate(
    data: Record<string, unknown>,
    body: string,
    options?: { dirName?: string }
  ): AgentSkillsValidation {
    const fm = this.validateFrontmatter(data, options);
    const bd = this.validateBody(body);
    return {
      specValid: fm.specValid && bd.specValid,
      errors: [...fm.errors, ...bd.errors],
      warnings: [...fm.warnings, ...bd.warnings],
    };
  }
}

/**
 * 从 frontmatter 原始数据中提取 agentskills.io 元数据，归一化为 AgentSkillsMeta。
 * 供 SKILLmdParser 填充 SKILLmdMeta.agentskillsMetadata / compatibility。
 */
export function extractAgentSkillsMeta(
  data: Record<string, unknown>
): Omit<AgentSkillsMeta, "specValid" | "specErrors" | "specWarnings"> {
  const out: Omit<AgentSkillsMeta, "specValid" | "specErrors" | "specWarnings"> = {};

  if (data.metadata !== undefined && typeof data.metadata === "object" && data.metadata !== null && !Array.isArray(data.metadata)) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(data.metadata as Record<string, unknown>)) {
      // 规范：metadata 是 string→string 映射；非字符串值转 JSON 字符串保留信息
      map[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    out.metadata = map;
  }

  if (typeof data.compatibility === "string" && data.compatibility.trim() !== "") {
    out.compatibility = data.compatibility;
  }

  return out;
}
