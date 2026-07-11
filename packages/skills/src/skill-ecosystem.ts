/**
 * Skill Ecosystem — manages skill ecosystem growth and quality.
 *
 * Provides:
 *  - Ecosystem statistics (total skills, categories, quality, recent additions)
 *  - Skill recommendations based on user history (keyword matching)
 *  - Skill quality validation (SKILL.md checks)
 *  - Auto-categorization of skills
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EcosystemStats {
  totalSkills: number;
  categories: Record<string, number>;
  avgQuality: number;
  recentAdditions: number;
}

export interface SkillRecommendation {
  skillId: string;
  reason: string;
  relevanceScore: number;
}

export interface QualityReport {
  score: number;
  issues: string[];
  suggestions: string[];
}

export type SkillCategory =
  | "web"
  | "browser"
  | "file"
  | "code"
  | "email"
  | "scheduler"
  | "media"
  | "data"
  | "system"
  | "other";

// ─── Internal Skill Entry ────────────────────────────────────────────────────

interface SkillEntry {
  skillId: string;
  name: string;
  description: string;
  category: string;
  keywords: string[];
  qualityScore: number;
  addedAt: Date;
}

// ─── Category Keywords ────────────────────────────────────────────────────────

const CATEGORY_KEYWORDS: Record<SkillCategory, string[]> = {
  web: [
    "web", "website", "http", "url", "api", "rest", "html", "css", "fetch",
    "request", "endpoint", "server", "scrape", "crawl", "download", "upload",
  ],
  browser: [
    "browser", "chrome", "firefox", "selenium", "playwright", "puppeteer",
    "page", "dom", "click", "screenshot", "navigate", "tab",
  ],
  file: [
    "file", "directory", "folder", "read", "write", "csv", "json", "xml",
    "yaml", "pdf", "doc", "spreadsheet", "excel", "path", "filesystem",
  ],
  code: [
    "code", "program", "compile", "build", "test", "debug", "refactor",
    "lint", "format", "git", "repository", "commit", "branch", "deploy",
  ],
  email: [
    "email", "mail", "smtp", "imap", "inbox", "send", "compose", "draft",
    "attachment", "newsletter", "outlook", "gmail",
  ],
  scheduler: [
    "schedule", "cron", "timer", "alarm", "reminder", "calendar", "event",
    "recurring", "interval", "delay", "timeout", "job",
  ],
  media: [
    "image", "video", "audio", "photo", "music", "ffmpeg", "transcode",
    "resize", "crop", "thumbnail", "gif", "stream", "record", "convert",
  ],
  data: [
    "data", "database", "sql", "query", "table", "chart", "graph",
    "analytics", "transform", "etl", "pipeline", "export", "import",
    "aggregate", "filter", "sort",
  ],
  system: [
    "system", "process", "shell", "command", "terminal", "docker",
    "container", "monitor", "log", "service", "daemon", "environment",
    "config", "install", "update",
  ],
  other: [],
};

// ─── SkillEcosystem ──────────────────────────────────────────────────────────

export class SkillEcosystem {
  private skills = new Map<string, SkillEntry>();
  private recentThresholdDays: number;

  constructor(options?: { recentThresholdDays?: number }) {
    this.recentThresholdDays = options?.recentThresholdDays ?? 30;
  }

  // ─── Skill Registration ─────────────────────────────────────────────────

  /** Register a skill in the ecosystem */
  registerSkill(skill: {
    skillId: string;
    name: string;
    description: string;
    category?: string;
    keywords?: string[];
    qualityScore?: number;
    addedAt?: Date;
  }): void {
    const entry: SkillEntry = {
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description,
      category: skill.category ?? this.autoCategorize(skill.name, skill.description),
      keywords: skill.keywords ?? [],
      qualityScore: skill.qualityScore ?? 0.5,
      addedAt: skill.addedAt ?? new Date(),
    };

    this.skills.set(skill.skillId, entry);
  }

  /** Unregister a skill from the ecosystem */
  unregisterSkill(skillId: string): boolean {
    return this.skills.delete(skillId);
  }

  // ─── Ecosystem Statistics ───────────────────────────────────────────────

  getEcosystemStats(): EcosystemStats {
    const allSkills = Array.from(this.skills.values());
    const categories: Record<string, number> = {};
    let totalQuality = 0;
    let recentCount = 0;

    const now = Date.now();
    const recentThreshold = now - this.recentThresholdDays * 24 * 60 * 60 * 1000;

    for (const skill of allSkills) {
      // Count categories
      const cat = skill.category;
      categories[cat] = (categories[cat] ?? 0) + 1;

      // Sum quality
      totalQuality += skill.qualityScore;

      // Count recent additions
      if (skill.addedAt.getTime() >= recentThreshold) {
        recentCount++;
      }
    }

    return {
      totalSkills: allSkills.length,
      categories,
      avgQuality: allSkills.length > 0 ? totalQuality / allSkills.length : 0,
      recentAdditions: recentCount,
    };
  }

  // ─── Skill Recommendations ──────────────────────────────────────────────

  recommendSkills(userHistory: string[]): SkillRecommendation[] {
    if (userHistory.length === 0 || this.skills.size === 0) {
      return [];
    }

    const allSkills = Array.from(this.skills.values());
    const scored: Array<{ skill: SkillEntry; score: number; reason: string }> = [];

    // Build a keyword frequency map from user history
    const historyKeywords = new Map<string, number>();
    for (const entry of userHistory) {
      const words = entry.toLowerCase().split(/[\s,.;:!?()[\]{}'"\/\\]+/).filter((w) => w.length > 1);
      for (const word of words) {
        historyKeywords.set(word, (historyKeywords.get(word) ?? 0) + 1);
      }
    }

    for (const skill of allSkills) {
      let score = 0;
      let bestMatch = "";

      // Match against skill name
      const nameLower = skill.name.toLowerCase();
      for (const [keyword, freq] of historyKeywords) {
        if (nameLower.includes(keyword)) {
          score += 3 * freq;
          if (!bestMatch) bestMatch = `name matches "${keyword}"`;
        }
      }

      // Match against skill description
      const descLower = skill.description.toLowerCase();
      for (const [keyword, freq] of historyKeywords) {
        if (descLower.includes(keyword)) {
          score += 2 * freq;
          if (!bestMatch) bestMatch = `description matches "${keyword}"`;
        }
      }

      // Match against skill keywords
      for (const skillKw of skill.keywords) {
        const kwLower = skillKw.toLowerCase();
        for (const [keyword, freq] of historyKeywords) {
          if (kwLower === keyword || kwLower.includes(keyword) || keyword.includes(kwLower)) {
            score += 4 * freq;
            if (!bestMatch) bestMatch = `keyword matches "${skillKw}"`;
          }
        }
      }

      // Match against category
      const catLower = skill.category.toLowerCase();
      for (const [keyword, freq] of historyKeywords) {
        if (catLower.includes(keyword)) {
          score += freq;
          if (!bestMatch) bestMatch = `category "${skill.category}" matches "${keyword}"`;
        }
      }

      if (score > 0) {
        // Normalize score to 0–1 range (cap at a reasonable max)
        const normalizedScore = Math.min(score / 20, 1.0);
        scored.push({
          skill,
          score: normalizedScore,
          reason: bestMatch || "relevant to your activity",
        });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, 10).map((s) => ({
      skillId: s.skill.skillId,
      reason: s.reason,
      relevanceScore: Math.round(s.score * 100) / 100,
    }));
  }

  // ─── Quality Validation ─────────────────────────────────────────────────

  async validateSkillQuality(skillPath: string): Promise<QualityReport> {
    const issues: string[] = [];
    const suggestions: string[] = [];
    let score = 1.0;

    // Check that the skill directory exists
    if (!existsSync(skillPath)) {
      return {
        score: 0.0,
        issues: [`Skill path does not exist: ${skillPath}`],
        suggestions: ["Create the skill directory with a SKILL.md file"],
      };
    }

    // Check SKILL.md exists
    const skillMdPath = skillPath.replace(/[/\\]?$/, "") + "/SKILL.md";
    if (!existsSync(skillMdPath)) {
      return {
        score: 0.0,
        issues: ["SKILL.md file is missing"],
        suggestions: ["Create a SKILL.md file with name, description, and tools fields"],
      };
    }

    // Read and parse SKILL.md
    let content: string;
    try {
      content = await readFile(skillMdPath, "utf-8");
    } catch (err) {
      return {
        score: 0.0,
        issues: [`Cannot read SKILL.md: ${err instanceof Error ? err.message : String(err)}`],
        suggestions: ["Ensure SKILL.md is readable"],
      };
    }

    // Parse YAML frontmatter
    const frontmatter = this.parseFrontmatter(content);

    // Check required field: name
    if (!frontmatter.name || String(frontmatter.name).trim() === "") {
      issues.push("SKILL.md is missing required field: name");
      score -= 0.25;
    }

    // Check required field: description
    if (!frontmatter.description || String(frontmatter.description).trim() === "") {
      issues.push("SKILL.md is missing required field: description");
      score -= 0.25;
    } else {
      // Check description length
      const descLength = String(frontmatter.description).trim().length;
      if (descLength <= 20) {
        issues.push(`Description is too short (${descLength} chars) — must be > 20 characters`);
        score -= 0.15;
        suggestions.push("Provide a more detailed description explaining what the skill does and when to use it");
      }
    }

    // Check required field: tools
    if (!frontmatter.tools || (Array.isArray(frontmatter.tools) && frontmatter.tools.length === 0)) {
      issues.push("SKILL.md is missing required field: tools, or tools list is empty");
      score -= 0.2;
      suggestions.push("Specify at least one tool that this skill uses (e.g., web-search, file-read)");
    } else if (Array.isArray(frontmatter.tools) && frontmatter.tools.length > 0) {
      // Tools present — good
    } else if (typeof frontmatter.tools === "string" && frontmatter.tools.trim() !== "") {
      // Single tool as string — acceptable
    }

    // Check steps are documented
    const hasSteps = this.checkStepsDocumented(content);
    if (!hasSteps) {
      issues.push("SKILL.md does not document any steps or instructions");
      score -= 0.15;
      suggestions.push("Add a ## Steps or ## Instructions section with numbered steps for how to execute the skill");
    }

    // Clamp score
    score = Math.max(0.0, Math.min(1.0, score));

    return { score, issues, suggestions };
  }

  // ─── Auto-Categorization ────────────────────────────────────────────────

  autoCategorize(skillName: string, description: string): SkillCategory {
    const text = `${skillName} ${description}`.toLowerCase();
    const scores: Array<{ category: SkillCategory; score: number }> = [];

    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as [SkillCategory, string[]][]) {
      if (category === "other") continue;

      let categoryScore = 0;
      for (const keyword of keywords) {
        if (text.includes(keyword)) {
          categoryScore += 1;
        }
      }
      scores.push({ category, score: categoryScore });
    }

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    // Return the best match if it has any score, otherwise "other"
    if (scores.length > 0 && scores[0].score > 0) {
      return scores[0].category;
    }

    return "other";
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private parseFrontmatter(content: string): Record<string, unknown> {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};

    const yaml = match[1];
    const result: Record<string, unknown> = {};

    // Simple YAML parser for flat key-value pairs and arrays.
    // 支持 block scalar（`|` 和 `>`）：当值是 `|` 或 `>` 时，
    // 收集后续缩进行作为多行字符串值，避免把 description 等多行字段误设为空数组。
    const lines = yaml.split("\n");
    let currentKey = "";
    let currentArray: unknown[] = [];
    let blockScalarKey: string | null = null;
    let blockScalarLines: string[] = [];
    let blockScalarMinIndent = -1;

    const flushBlockScalar = () => {
      if (blockScalarKey !== null) {
        // 去除每行首部多余的缩进（按最小缩进裁剪）
        const trimmed = blockScalarLines
          .map((l) => l.slice(blockScalarMinIndent))
          .join("\n")
          .replace(/\n+$/, ""); // 去除尾部空行（block scalar 语义）
        result[blockScalarKey] = trimmed;
        blockScalarKey = null;
        blockScalarLines = [];
        blockScalarMinIndent = -1;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 正在收集 block scalar：检查当前行是否仍属于该 block（有缩进或空行）
      if (blockScalarKey !== null) {
        if (line.trim() === "") {
          blockScalarLines.push(line);
          continue;
        }
        const indent = line.length - line.trimStart().length;
        if (indent > 0) {
          if (blockScalarMinIndent < 0 || indent < blockScalarMinIndent) {
            blockScalarMinIndent = indent;
          }
          blockScalarLines.push(line);
          continue;
        }
        // 当前行无缩进 → block scalar 结束，先 flush 再按普通行处理
        flushBlockScalar();
      }

      const trimmed = line.trim();

      // Array item
      if (trimmed.startsWith("- ") && currentKey) {
        const value = trimmed.slice(2).trim().replace(/^['"]|['"]$/g, "");
        if (!Array.isArray(result[currentKey])) {
          currentArray = [];
          result[currentKey] = currentArray;
        }
        currentArray.push(value);
        continue;
      }

      // Key-value pair
      const kvMatch = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
      if (kvMatch) {
        // Flush previous array
        currentKey = kvMatch[1];
        const value = kvMatch[2].trim();

        if (value === "|" || value === ">") {
          // block scalar：后续缩进行作为多行字符串
          blockScalarKey = currentKey;
          blockScalarLines = [];
          blockScalarMinIndent = -1;
        } else if (value === "") {
          currentArray = [];
          result[currentKey] = currentArray;
        } else if (value.startsWith("[") && value.endsWith("]")) {
          // Inline array
          const items = value
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
            .filter((s) => s.length > 0);
          result[currentKey] = items;
          currentArray = [];
        } else {
          result[currentKey] = value.replace(/^['"]|['"]$/g, "");
          currentArray = [];
        }
      }
    }

    // 文件结束时如果仍在收集 block scalar，flush 它
    flushBlockScalar();

    return result;
  }

  private checkStepsDocumented(content: string): boolean {
    // Check for common step/instruction section headers
    const stepPatterns = [
      /^##\s+steps\b/mi,
      /^##\s+instructions\b/mi,
      /^##\s+how\s+to\b/mi,
      /^##\s+usage\b/mi,
      /^##\s+guide\b/mi,
      /^##\s+procedure\b/mi,
      /^\d+\.\s+/m,       // Numbered list
      /^-\s+step\s/mi,    // Bullet steps
    ];

    for (const pattern of stepPatterns) {
      if (pattern.test(content)) {
        return true;
      }
    }

    return false;
  }
}

