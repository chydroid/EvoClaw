/**
 * blueprint-skill-bridge — 技能前端标记桥接（对标 hermes-agent tools/blueprints.py）
 *
 * 让 SKILL.md 文件通过 `metadata.hermes.blueprint` 前端标记声明自己为自动化蓝图。
 * 技能可以携带完整的 cron 调度定义，用户接受后一键创建为定时任务。
 *
 * SKILL.md 中的蓝图声明格式：
 * ```yaml
 * ---
 * name: my-skill
 * description: A skill that does X
 * metadata:
 *   hermes:
 *     blueprint:
 *       schedule: "0 9 * * *"
 *       deliver: "notify"
 *       prompt: "Do something useful"
 *       no_agent: false
 *       model: "claude-sonnet"
 *       provider: "anthropic"
 *       enabled_toolsets: ["file", "web"]
 * ---
 * # My Skill
 * ```
 *
 * 关键设计（对标 hermes）：
 *   - parse_blueprint：从 SKILL.md 前端标记提取蓝图定义
 *   - blueprint_to_job_spec：蓝图 → cron job 配置
 *   - create_blueprint_job：直接创建 cron job（不经过建议流程）
 *   - register_blueprint_suggestion：注册为建议（consent-first）
 *   - export_blueprint：cron job → SKILL.md（反向操作）
 *   - list_skill_blueprints：扫描技能目录，发现所有携带蓝图的技能
 */

import * as fs from "fs";
import * as path from "path";
import type { ScheduleManager, ScheduledTask } from "./schedule-manager";
import type { CronSuggestionManager, CronSuggestion } from "./cron-suggestions";

// ── 类型 ──────────────────────────────────────────────

/** 从 SKILL.md 前端标记解析出的蓝图规范 */
export interface BlueprintSpec {
  /** 技能名称（来自 frontmatter name 或文件名） */
  skillName: string;
  /** cron 表达式（必填） */
  schedule: string;
  /** 投递方式（默认 "notify"） */
  deliver: string;
  /** 任务提示词 */
  prompt: string;
  /** 是否不使用 agent（直接执行 prompt） */
  noAgent: boolean;
  /** 模型名 */
  model?: string;
  /** 提供方 */
  provider?: string;
  /** 启用的工具集 */
  enabledToolsets?: string[];
}

/** job spec（对标 CronSuggestion.jobSpec） */
export interface BlueprintJobSpec {
  name: string;
  cronExpression: string;
  description?: string;
  handlerType: "email_check" | "report_generate" | "browser_action" | "system_cleanup" | "custom" | "shell";
  handlerConfig?: Record<string, unknown>;
}

/** 蓝图解析错误 */
export class BlueprintParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueprintParseError";
  }
}

// ── 极简 YAML 前端标记解析 ───────────────────────────

/**
 * 解析 SKILL.md 前端标记，提取 `metadata.hermes.blueprint` 块。
 * 使用极简 YAML 子集解析器，不依赖外部 YAML 库。
 *
 * 支持的 YAML 子集：
 *   - 键值对：`key: value`
 *   - 嵌套对象：`key:\n  nested: value`
 *   - 块标量：`key: |` 后跟缩进行
 *   - 行内数组：`key: [a, b, c]`
 *   - 引号字符串：`key: "value"` / `key: 'value'`
 *   - 布尔值：`key: true` / `key: false`
 */
function parseFrontmatter(content: string): Record<string, unknown> {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return {};

  const lines = fmMatch[1].split("\n");
  return parseYamlSubset(lines, 0).data;
}

/**
 * 解析 YAML 子集。基于缩进的递归下降解析。
 * @param lines YAML 行数组
 * @param startIdx 起始行索引
 * @param parentIndent 父级缩进量——缩进小于等于此值时结束当前层级
 */
function parseYamlSubset(
  lines: string[],
  startIdx: number,
  parentIndent = -1,
): { data: Record<string, unknown>; nextIdx: number } {
  const data: Record<string, unknown> = {};  // eslint-disable-line @typescript-eslint/no-explicit-any
  let i = startIdx;
  let currentIndent = -1;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) { i++; continue; }

    const indent = line.match(/^\s*/)?.[0].length ?? 0;

    // 缩进回到父级或更浅——结束当前层级
    if (indent <= parentIndent) break;
    // 设置当前层级缩进
    if (currentIndent < 0) currentIndent = indent;
    // 安全检查：缩进小于当前层级（不应发生）
    if (indent < currentIndent) break;

    const trimmed = line.trim();

    // 数组项
    if (trimmed.startsWith("- ")) {
      // 不在此处处理——数组由行内语法处理
      i++;
      continue;
    }

    // 键值对
    const kvMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!kvMatch) { i++; continue; }

    const key = kvMatch[1].trim();
    let val = kvMatch[2].trim();

    if (val === "") {
      // 可能是嵌套对象或空值——先解析下一层
      const nested = parseYamlSubset(lines, i + 1, indent);
      if (Object.keys(nested.data).length > 0) {
        // 嵌套对象
        data[key] = nested.data;
        i = nested.nextIdx;
      } else {
        // 空值
        data[key] = null;
        i = nested.nextIdx;
      }
    } else if (val === "|" || val === ">") {
      // 块标量——收集缩进行
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (l.trim() === "") { blockLines.push(""); j++; continue; }
        const lIndent = l.match(/^\s*/)?.[0]?.length ?? 0;
        if (lIndent <= indent) break;
        blockLines.push(l.slice(indent + 2));  // 去除缩进
        j++;
      }
      data[key] = blockLines.join("\n").trim();
      i = j;
    } else if (val.startsWith("[") && val.endsWith("]")) {
      // 行内数组
      const items = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      data[key] = items;
      i++;
    } else {
      // 简单值
      if (val === "true") data[key] = true;
      else if (val === "false") data[key] = false;
      else data[key] = val.replace(/^["']|["']$/g, "");
      i++;
    }
  }

  return { data, nextIdx: i };
}

// ── 核心函数 ──────────────────────────────────────────

/**
 * 从 SKILL.md 内容解析蓝图定义。
 * 提取 `metadata.hermes.blueprint` 块并验证必填字段。
 *
 * @returns BlueprintSpec 或 null（无蓝图声明时）
 */
export function parseBlueprintFromSkillMd(content: string): BlueprintSpec | null {
  const fm = parseFrontmatter(content);

  // 提取 name
  const skillName = (fm.name as string) || "unknown";

  // 提取 metadata.hermes.blueprint
  const metadata = fm.metadata as Record<string, unknown> | undefined;
  if (!metadata) return null;

  const hermes = metadata.hermes as Record<string, unknown> | undefined;
  if (!hermes) return null;

  const bpRaw = hermes.blueprint as Record<string, unknown> | undefined;
  if (!bpRaw) return null;

  // schedule 是必填字段
  const schedule = bpRaw.schedule as string | undefined;
  if (!schedule || schedule.trim() === "") return null;

  return {
    skillName,
    schedule: schedule.trim(),
    deliver: (bpRaw.deliver as string) || "notify",
    prompt: (bpRaw.prompt as string) || "",
    noAgent: (bpRaw.no_agent as boolean) || false,
    model: bpRaw.model as string | undefined,
    provider: bpRaw.provider as string | undefined,
    enabledToolsets: bpRaw.enabled_toolsets as string[] | undefined,
  };
}

/**
 * 将蓝图规范转换为 job spec（cron job 配置）。
 */
export function blueprintToJobSpec(spec: BlueprintSpec): BlueprintJobSpec {
  const handlerConfig: Record<string, unknown> = { prompt: spec.prompt };
  if (spec.model) handlerConfig.model = spec.model;
  if (spec.provider) handlerConfig.provider = spec.provider;
  if (spec.enabledToolsets) handlerConfig.enabledToolsets = spec.enabledToolsets;
  if (spec.noAgent) handlerConfig.noAgent = true;

  return {
    name: spec.skillName,
    cronExpression: spec.schedule,
    description: `由技能 ${spec.skillName} 定义的自动化任务`,
    handlerType: "custom",
    handlerConfig,
  };
}

/**
 * 从技能内容直接创建 cron job（不经过建议流程）。
 * 用于用户明确要求"从这个技能创建定时任务"的场景。
 */
export function createBlueprintJob(
  spec: BlueprintSpec,
  scheduleManager: ScheduleManager,
): ScheduledTask {
  const jobSpec = blueprintToJobSpec(spec);
  return scheduleManager.createTask({
    name: jobSpec.name,
    cronExpression: jobSpec.cronExpression,
    description: jobSpec.description,
    handlerType: jobSpec.handlerType,
    handlerConfig: jobSpec.handlerConfig,
  });
}

/**
 * 将蓝图注册为建议（consent-first 流程）。
 * 用户接受建议后才真正创建 cron job。
 */
export function registerBlueprintSuggestion(
  spec: BlueprintSpec,
  suggestionManager: CronSuggestionManager,
): CronSuggestion | null {
  const jobSpec = blueprintToJobSpec(spec);
  return suggestionManager.addSuggestion({
    title: `${spec.skillName} 自动化`,
    description: spec.prompt || `由技能 ${spec.skillName} 定义的定时任务`,
    source: "blueprint",
    dedupKey: `blueprint:${spec.skillName}`,
    jobSpec,
  });
}

/**
 * 将 cron job 导出为 SKILL.md 格式的蓝图声明。
 * 这是 parseBlueprintFromSkillMd 的逆操作。
 */
export function exportBlueprintToSkillMd(task: ScheduledTask, spec: BlueprintSpec): string {
  const toolsets = spec.enabledToolsets ? `\n      enabled_toolsets: [${spec.enabledToolsets.map((t) => `"${t}"`).join(", ")}]` : "";
  const modelLine = spec.model ? `\n      model: "${spec.model}"` : "";
  const providerLine = spec.provider ? `\n      provider: "${spec.provider}"` : "";
  const noAgentLine = spec.noAgent ? "\n      no_agent: true" : "";

  return `---
name: ${spec.skillName}
description: ${task.description || spec.skillName}
metadata:
  hermes:
    blueprint:
      schedule: "${spec.schedule}"
      deliver: "${spec.deliver}"
      prompt: "${spec.prompt.replace(/"/g, '\\"')}"${modelLine}${providerLine}${noAgentLine}${toolsets}
---
# ${spec.skillName}

由 EvoClaw 自动化系统管理的定时任务。

## 调度

- Cron: \`${spec.schedule}\`
- 投递: \`${spec.deliver}\`

## 任务定义

${spec.prompt}
`;
}

/**
 * 扫描技能目录，发现所有携带蓝图声明的技能。
 *
 * @param skillDir 技能根目录（包含 SKILL.md 文件的目录）
 * @returns 所有发现的蓝图规范列表
 */
export function listSkillBlueprints(skillDir: string): BlueprintSpec[] {
  const results: BlueprintSpec[] = [];

  if (!fs.existsSync(skillDir)) return results;

  // 扫描一级子目录中的 SKILL.md 文件
  const entries = fs.readdirSync(skillDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(skillDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      // 有些技能可能直接在根目录
      const rootSkillMd = path.join(skillDir, "SKILL.md");
      if (entry.name === "." || fs.existsSync(rootSkillMd)) {
        // skip
      }
      continue;
    }
    try {
      const content = fs.readFileSync(skillMdPath, "utf8");
      const spec = parseBlueprintFromSkillMd(content);
      if (spec) {
        results.push(spec);
      }
    } catch {
      // 读取失败——跳过
    }
  }

  return results;
}

/**
 * 从单个 SKILL.md 文件解析蓝图。
 */
export function parseBlueprintFromFile(filePath: string): BlueprintSpec | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return parseBlueprintFromSkillMd(content);
  } catch {
    return null;
  }
}
