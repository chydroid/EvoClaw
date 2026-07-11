/**
 * SkillContentUtils — 技能内容工具函数
 *
 * 借鉴 OpenSpace skill_engine/skill_utils.py：
 *   - 两级安全规则（blocked vs suspicious）：blocked 阻断，suspicious 仅警告
 *   - YAML 自动引号（特殊字符检测）：防 LLM 写出破坏 YAML 的内容
 *   - CHANGE_SUMMARY 首行提取（容 markdown 修饰 + 中英冒号）
 *   - 非阻塞验证（核心 error，辅助 warn）
 *
 * EvoClaw 落地点：
 *   - skill-curator.ts 写入技能前调用 yamlQuote/safetyCheck
 *   - skill-validator.ts 调用 validateSkillDir 分级报错
 *   - skill-learner.ts 提取 change_summary 用于演化记录
 */

import * as fs from "fs";

// ── 两级安全规则（借鉴 OpenSpace _SAFETY_RULES + _BLOCKING_FLAGS） ───

export type SafetyLevel = "safe" | "suspicious" | "blocked";

export interface SafetyCheckResult {
  level: SafetyLevel;
  /** 命中的 blocked 规则（如果有） */
  blockedRules: string[];
  /** 命中的 suspicious 规则（如果有） */
  suspiciousRules: string[];
}

const SAFETY_RULES: Array<{ pattern: RegExp; level: SafetyLevel; name: string }> = [
  // blocked: 阻断拒绝
  { pattern: /rm\s+-rf\s+\//i, level: "blocked", name: "rm-rf-root" },
  { pattern: /mkfs\.\w+\s+\/dev/i, level: "blocked", name: "format-device" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/i, level: "blocked", name: "fork-bomb" },
  { pattern: /curl\s+[^|]*\|\s*sh/i, level: "blocked", name: "curl-pipe-shell" },
  { pattern: /wget\s+[^|]*\|\s*sh/i, level: "blocked", name: "wget-pipe-shell" },
  { pattern: /\bDDoS\b|\bdenial.of.service\b/i, level: "blocked", name: "ddos" },
  { pattern: /\bbackdoor\b|\brootkit\b|\bkeylogger\b/i, level: "blocked", name: "malware" },
  { pattern: /\bpassword\s*=\s*["'][^"']+["']/i, level: "blocked", name: "hardcoded-password" },
  { pattern: /\bapi[_-]?key\s*=\s*["'][^"']+["']/i, level: "blocked", name: "hardcoded-api-key" },

  // suspicious: 仅警告
  { pattern: /\bsudo\s+rm\b/i, level: "suspicious", name: "sudo-rm" },
  { pattern: /\bchmod\s+777\b/i, level: "suspicious", name: "chmod-777" },
  { pattern: /\bexec\s*\(/i, level: "suspicious", name: "exec-call" },
  { pattern: /\beval\s*\(/i, level: "suspicious", name: "eval-call" },
  { pattern: /\b__import__\s*\(/i, level: "suspicious", name: "python-import" },
  { pattern: /base64\s+decode.*exec/i, level: "suspicious", name: "base64-exec" },
  { pattern: /\bdownload\s+and\s+execute\b/i, level: "suspicious", name: "download-execute" },
  { pattern: /npx\s+--yes/i, level: "suspicious", name: "npx-auto-yes" },
];

/**
 * 检查技能内容的安全性。
 *
 * 返回 blocked（阻断）/ suspicious（警告）/ safe 三级。
 */
export function checkSafety(content: string): SafetyCheckResult {
  const blockedRules: string[] = [];
  const suspiciousRules: string[] = [];

  for (const rule of SAFETY_RULES) {
    if (rule.pattern.test(content)) {
      if (rule.level === "blocked") {
        blockedRules.push(rule.name);
      } else if (rule.level === "suspicious") {
        suspiciousRules.push(rule.name);
      }
    }
  }

  let level: SafetyLevel = "safe";
  if (blockedRules.length > 0) {
    level = "blocked";
  } else if (suspiciousRules.length > 0) {
    level = "suspicious";
  }

  return { level, blockedRules, suspiciousRules };
}

/**
 * 便捷函数：是否安全（非 blocked）。
 */
export function isSkillSafe(content: string): boolean {
  return checkSafety(content).level !== "blocked";
}

// ── YAML 自动引号（借鉴 OpenSpace _yaml_quote） ───────────────

const YAML_NEEDS_QUOTE_RE = /[:#\[\]{}&*!|>'"%@`\\]/;

/**
 * 检查 value 是否需要 YAML 引号。
 *
 * 含特殊字符（: # [ ] { } & * ! | > ' " % @ ` \）时需要双引号转义。
 * 空字符串也需要引号（避免被解析为 null）。
 */
export function needsYamlQuote(value: string): boolean {
  // 空字符串需要引号（YAML 中 "key: " 解析为 null，不是空字符串）
  if (value === "") return true;
  if (!value) return false;
  if (YAML_NEEDS_QUOTE_RE.test(value)) return true;
  // 开头特殊字符
  if (/^[-?]/.test(value)) return true;
  // true/false/null/数字
  if (/^(true|false|null|yes|no|on|off)$/i.test(value)) return true;
  if (/^-?\d+(\.\d+)?$/.test(value)) return true;
  // 前后空格
  if (value !== value.trim()) return true;
  // 控制字符（换行、制表符等）需要转义
  if (/[\r\n\t]/.test(value)) return true;
  return false;
}

/**
 * YAML 值自动引号（特殊字符检测 + 转义）。
 */
export function yamlQuote(value: string): string {
  if (!needsYamlQuote(value)) return value;
  // 双引号转义：反斜杠 + 双引号 + 控制字符
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * 设置 frontmatter 字段（自动应用 yamlQuote）。
 *
 * @param frontmatterText 原始 frontmatter 文本（不含 --- 分隔符）
 * @param key 字段名
 * @param value 字段值
 * @returns 更新后的 frontmatter 文本
 */
export function setFrontmatterField(
  frontmatterText: string,
  key: string,
  value: string,
): string {
  const lines = frontmatterText.split("\n");
  const quotedValue = yamlQuote(value);
  let found = false;
  const result: string[] = [];

  for (const line of lines) {
    const match = /^(\s*)([\w-]+)\s*:(.*)$/.exec(line);
    if (match && match[2] === key) {
      result.push(`${match[1]}${key}: ${quotedValue}`);
      found = true;
    } else {
      result.push(line);
    }
  }

  if (!found) {
    result.push(`${key}: ${quotedValue}`);
  }

  return result.join("\n");
}

// ── CHANGE_SUMMARY 首行提取（借鉴 OpenSpace extract_change_summary） ───

const CHANGE_SUMMARY_RE = /^[\s*_]*(?:CHANGE[\s_-]?SUMMARY)[\s*_]*[:：]\s*(.+)/i;

/**
 * 从技能内容中提取 CHANGE_SUMMARY 首行。
 *
 * 容忍：
 *   - markdown 修饰（_ * 等）
 *   - 中英冒号
 *   - CHANGE_SUMMARY / CHANGE-SUMMARY / CHANGE SUMMARY 变体
 *   - 提取后 strip("*_") 去修饰
 */
export function extractChangeSummary(content: string): string | null {
  const lines = content.split("\n");
  for (const line of lines) {
    const match = CHANGE_SUMMARY_RE.exec(line);
    if (match) {
      return match[1].replace(/[*_]+$/g, "").trim();
    }
  }
  return null;
}

// ── 非阻塞验证（借鉴 OpenSpace validate_skill_dir） ─────────────

export interface ValidationResult {
  /** 硬错误（阻断） */
  errors: string[];
  /** 软警告（不阻断） */
  warnings: string[];
}

/**
 * 验证技能目录（非阻塞策略）。
 *
 * 硬错误（error）：
 *   - 目录不存在
 *   - SKILL.md 不存在或为空
 *   - frontmatter 缺 name 字段
 *
 * 软警告（warn）：
 *   - 辅助文件（README.md、examples/ 等）为空
 *   - description 字段缺失
 *   - triggers 字段缺失
 */
export function validateSkillDir(
  skillDir: string,
  fsImpl: {
    existsSync(path: string): boolean;
    readFileSync(path: string, encoding: string): string;
    statSync(path: string): { isDirectory(): boolean };
  } = fs as unknown as {
    existsSync(path: string): boolean;
    readFileSync(path: string, encoding: string): string;
    statSync(path: string): { isDirectory(): boolean };
  },
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 硬错误 1: 目录不存在
  if (!fsImpl.existsSync(skillDir)) {
    errors.push(`Skill directory not found: ${skillDir}`);
    return { errors, warnings };
  }

  // 硬错误 2: SKILL.md 不存在
  const skillMdPath = `${skillDir}/SKILL.md`;
  if (!fsImpl.existsSync(skillMdPath)) {
    errors.push(`SKILL.md not found in ${skillDir}`);
    return { errors, warnings };
  }

  // 硬错误 3: SKILL.md 为空
  const content = fsImpl.readFileSync(skillMdPath, "utf-8");
  if (!content || !content.trim()) {
    errors.push(`SKILL.md is empty in ${skillDir}`);
    return { errors, warnings };
  }

  // 硬错误 4: frontmatter 缺 name
  // 兼容 CRLF（Windows）和 LF（Unix）行尾
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!frontmatterMatch) {
    warnings.push("SKILL.md missing frontmatter");
  } else {
    const frontmatter = frontmatterMatch[1];
    if (!/^name\s*:/m.test(frontmatter)) {
      errors.push("Frontmatter missing 'name' field");
    }
    if (!/^description\s*:/m.test(frontmatter)) {
      warnings.push("Frontmatter missing 'description' field");
    }
    if (!/^triggers\s*:/m.test(frontmatter)) {
      warnings.push("Frontmatter missing 'triggers' field");
    }
  }

  // 软警告：辅助文件
  const auxFiles = ["README.md", "examples", "tests"];
  for (const aux of auxFiles) {
    const auxPath = `${skillDir}/${aux}`;
    if (fsImpl.existsSync(auxPath)) {
      try {
        const stat = fsImpl.statSync(auxPath);
        if (stat.isDirectory()) {
          // 目录：跳过深度检查（保持轻量）
        } else {
          // 文件：检查是否为空
          const auxContent = fsImpl.readFileSync(auxPath, "utf-8");
          if (!auxContent.trim()) {
            warnings.push(`Auxiliary file is empty: ${aux}`);
          }
        }
      } catch {
        // 忽略单个辅助文件检查失败
      }
    }
  }

  return { errors, warnings };
}
