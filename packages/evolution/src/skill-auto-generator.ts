/**
 * SkillAutoGenerator — 技能自动生成器
 *
 * 从成功的进化结果中自动生成 SKILL.md 文件，遵循标准格式：
 *   - YAML frontmatter (name, version, description, tools)
 *   - Markdown body (with steps)
 *
 * 生成路径: data/skills/auto-generated/
 */

import { mkdir, open, rename, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createHash } from "crypto";

// ── Types ──────────────────────────────────────────────────

export interface EvolutionResult {
  trigger: string;
  solution: string;
  beforeCode: string;
  afterCode: string;
}

export interface GeneratedSkill {
  skillPath: string;
  skillName: string;
}

// ── SkillAutoGenerator ─────────────────────────────────────

export class SkillAutoGenerator {
  private readonly outputDir: string;

  constructor(baseDir?: string) {
    this.outputDir = baseDir ?? join(process.cwd(), "data", "skills", "auto-generated");
  }

  /**
   * 从成功的进化结果生成 SKILL.md 文件。
   * 如果进化结果不适合生成技能，返回 null。
   */
  async generateFromEvolution(evolutionResult: EvolutionResult): Promise<GeneratedSkill | null> {
    if (!this.isSuitableForSkill(evolutionResult)) {
      return null;
    }

    const skillName = this.deriveSkillName(evolutionResult.trigger);
    const skillContent = this.buildSkillMarkdown(skillName, evolutionResult);

    await this.ensureOutputDir();

    const skillPath = join(this.outputDir, `${skillName}.md`);
    await this.atomicWriteFile(skillPath, skillContent);

    return { skillPath, skillName };
  }

  /**
   * 判断进化结果是否适合生成技能。
   * 不适合的条件：
   *   - solution 或 afterCode 为空
   *   - beforeCode 与 afterCode 完全相同（无实际变更）
   *   - trigger 过短（< 5 字符），缺乏足够上下文
   */
  private isSuitableForSkill(result: EvolutionResult): boolean {
    if (!result.solution || result.solution.trim().length === 0) return false;
    if (!result.afterCode || result.afterCode.trim().length === 0) return false;
    if (result.beforeCode === result.afterCode) return false;
    if (!result.trigger || result.trigger.trim().length < 5) return false;
    return true;
  }

  /**
   * 从 trigger 文本派生一个 kebab-case 的技能名称。
   */
  private deriveSkillName(trigger: string): string {
    const slug = trigger
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);

    const hash = createHash("sha256")
      .update(trigger)
      .digest("hex")
      .slice(0, 8);

    return `auto-${slug}-${hash}`;
  }

  /**
   * 构建标准格式的 SKILL.md 内容。
   */
  private buildSkillMarkdown(skillName: string, result: EvolutionResult): string {
    const description = this.summarizeDescription(result);
    const steps = this.extractSteps(result);
    const tools = this.inferTools(result);

    const frontmatter = [
      "---",
      `name: ${skillName}`,
      `version: "1.0.0"`,
      `description: ${description}`,
      `tools:`,
      ...tools.map((t) => `  - ${t}`),
      "---",
    ].join("\n");

    // 简单脱敏：替换疑似 API key、token、密码的字符串，避免敏感信息写入 SKILL.md
    const safeAfterCode = this.redactCode(result.afterCode);
    const safeBeforeCode = this.redactCode(result.beforeCode);

    const body = [
      `# ${skillName}`,
      "",
      `**Trigger:** ${result.trigger}`,
      "",
      "## Steps",
      "",
      ...steps.map((step, i) => `${i + 1}. ${step}`),
      "",
      "## Solution",
      "",
      "```typescript",
      safeAfterCode,
      "```",
      "",
      "## Before (original code)",
      "",
      "```typescript",
      safeBeforeCode,
      "```",
      "",
    ].join("\n");

    return frontmatter + "\n" + body;
  }

  private redactCode(code: string): string {
    return code
      .replace(/(sk-|pk-|api[_-]?key|token|secret|password|passwd|access_token|refresh_token|client_secret)\s*[:=]\s*['"`][^'"`]{8,}['"`]/gi, '$1: "REDACTED"')
      .replace(/(?:Bearer)\s+[A-Za-z0-9_\-\.]{20,}/gi, 'Bearer REDACTED')
      .replace(/(AKIA[0-9A-Z]{16})/g, 'REDACTED')
      .replace(/(ghp_[A-Za-z0-9]{36})/g, 'REDACTED')
      .replace(/(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, 'REDACTED');
  }

  /**
   * 从 solution 文本生成简短描述。
   */
  private summarizeDescription(result: EvolutionResult): string {
    const firstSentence = result.solution.split(/[.!?。！？]/)[0].trim();
    if (firstSentence.length > 0 && firstSentence.length <= 120) {
      return `"${firstSentence}"`;
    }
    if (firstSentence.length > 120) {
      return `"${firstSentence.slice(0, 117)}..."`;
    }
    return `"Auto-generated skill for: ${result.trigger.slice(0, 80)}"`;
  }

  /**
   * 从 solution 文本中提取步骤。
   * 按换行或编号拆分，过滤空行。
   */
  private extractSteps(result: EvolutionResult): string[] {
    const lines = result.solution.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);

    if (lines.length > 0) {
      return lines.slice(0, 10);
    }

    // Fallback: 从代码差异推断步骤
    return [
      "Identify the issue from the trigger context",
      "Apply the code change as shown in the solution",
      "Verify the fix resolves the original problem",
    ];
  }

  /**
   * 从代码内容推断可能使用的工具。
   */
  private inferTools(result: EvolutionResult): string[] {
    const tools = new Set<string>();
    const combined = `${result.beforeCode} ${result.afterCode} ${result.solution}`.toLowerCase();

    if (/\b(read|write|file|fs\.|createfile|readfile)\b/i.test(combined)) {
      tools.add("Read");
      tools.add("Write");
    }
    if (/\b(edit|replace|searchreplace|modify)\b/i.test(combined)) {
      tools.add("Edit");
    }
    if (/\b(grep|search|find|pattern)\b/i.test(combined)) {
      tools.add("Grep");
    }
    if (/\b(run|exec|spawn|command|terminal|shell|npm|pnpm)\b/i.test(combined)) {
      tools.add("RunCommand");
    }
    if (/\b(glob|find.*file|list.*dir)\b/i.test(combined)) {
      tools.add("Glob");
    }

    if (tools.size === 0) {
      tools.add("Read");
      tools.add("Edit");
    }

    return Array.from(tools).sort();
  }

  /**
   * 原子写入：temp + fsync + rename，跨设备（EXDEV/EBUSY）时回退到目标侧写。
   */
  private async atomicWriteFile(targetPath: string, content: string): Promise<void> {
    const dir = dirname(targetPath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmpPath, targetPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EXDEV" || code === "EBUSY") {
        // 跨设备回退：在目标侧写临时文件后 rename，再清理源临时文件
        const dstTmp = `${targetPath}.${process.pid}.dst.tmp`;
        const handle2 = await open(dstTmp, "w");
        try {
          await handle2.writeFile(content, "utf-8");
          await handle2.sync();
        } finally {
          await handle2.close();
        }
        await rename(dstTmp, targetPath);
        try { await unlink(tmpPath); } catch { /* ignore */ }
      } else {
        try { await unlink(tmpPath); } catch { /* ignore */ }
        throw err;
      }
    }
  }

  /**
   * 确保输出目录存在。
   */
  private async ensureOutputDir(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
  }
}
