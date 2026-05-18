import { ServiceRegistry, EventBus } from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";

interface SkillMatch {
  skillPath: string;
  skillName: string;
  relevance: number;
  reason: string;
}

export class AutoSkillManager {
  private skillsDir: string;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    skillsDir: string
  ) {
    this.skillsDir = skillsDir;
    registry.registerService("autoSkillManager", this);
  }

  async findSkillForTask(taskDescription: string): Promise<SkillMatch | null> {
    if (!fs.existsSync(this.skillsDir)) {
      return null;
    }

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    const matches: SkillMatch[] = [];
    const lowerTask = taskDescription.toLowerCase();

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const skillMdPath = path.join(this.skillsDir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillMdPath)) continue;

        try {
          const content = fs.readFileSync(skillMdPath, "utf-8");
          const relevance = this.calculateRelevance(lowerTask, content, entry.name);
          if (relevance > 0) {
            matches.push({
              skillPath: skillMdPath,
              skillName: entry.name,
              relevance,
              reason: this.getMatchReason(lowerTask, content, entry.name),
            });
          }
        } catch {
          continue;
        }
      }
    }

    matches.sort((a, b) => b.relevance - a.relevance);
    return matches[0] || null;
  }

  async autoInstallForTask(taskDescription: string): Promise<{
    installed: boolean;
    skillName?: string;
    reason?: string;
  }> {
    const bestMatch = await this.findSkillForTask(taskDescription);
    if (!bestMatch) {
      return { installed: false, reason: "No matching skill found" };
    }

    if (bestMatch.relevance < 0.3) {
      return {
        installed: false,
        reason: `Best match "${bestMatch.skillName}" has low relevance (${bestMatch.relevance.toFixed(2)})`,
      };
    }

    const skillManager = this.registry.resolveService<{
      installSkill(skillPath: string): Promise<{ id: string; name: string }>;
    }>("skillManager");

    if (!skillManager) {
      return { installed: false, reason: "Skill manager not available" };
    }

    try {
      const skill = await skillManager.installSkill(bestMatch.skillPath);
      console.log(`[AutoSkillManager] Auto-installed skill "${skill.name}" for task: ${taskDescription}`);
      return {
        installed: true,
        skillName: skill.name,
        reason: bestMatch.reason,
      };
    } catch (err) {
      return {
        installed: false,
        reason: `Installation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private calculateRelevance(task: string, skillMdContent: string, dirName: string): number {
    let score = 0;
    const lowerContent = skillMdContent.toLowerCase();
    const lowerDir = dirName.toLowerCase();

    const taskWords = task.split(/\s+/).filter((w) => w.length > 1);

    for (const word of taskWords) {
      if (lowerContent.includes(word)) score += 2;
      if (lowerDir.includes(word)) score += 3;
    }

    const nameMatch = task.includes(lowerDir);
    if (nameMatch) score += 5;

    const keywordFields = lowerContent.match(/keywords?:?\s*\[(.+?)\]/i);
    if (keywordFields) {
      const keywordMatch = keywordFields[1].match(/(\w[\w-]*)/g);
      if (keywordMatch) {
        for (const kw of keywordMatch) {
          if (task.includes(kw.toLowerCase())) score += 2;
        }
      }
    }

    const triggers = lowerContent.match(/triggers?:?\s*\[(.+?)\]/is);
    if (triggers) {
      const patternMatches = triggers[1].match(/pattern:\s*["']?(\S+)["']?/g);
      if (patternMatches) {
        for (const pm of patternMatches) {
          const pattern = pm.replace(/pattern:\s*["']?/, "").replace(/["']$/, "").toLowerCase();
          if (task.includes(pattern)) score += 3;
        }
      }
    }

    const descriptionMatch = skillMdContent.match(/description:\s*(.+)/i);
    if (descriptionMatch) {
      const desc = descriptionMatch[1].toLowerCase();
      for (const word of taskWords) {
        if (desc.includes(word)) score += 1;
      }
    }

    return Math.min(score / 20, 1.0);
  }

  private getMatchReason(task: string, skillMdContent: string, dirName: string): string {
    const reasons: string[] = [];
    const lowerContent = skillMdContent.toLowerCase();
    const lowerDir = dirName.toLowerCase();
    const taskWords = task.split(/\s+/).filter((w) => w.length > 1);

    if (task.includes(lowerDir)) {
      reasons.push(`skill name "${dirName}" matches task`);
    }

    const matchedWords = taskWords.filter((w) => lowerContent.includes(w) || lowerDir.includes(w));
    if (matchedWords.length > 0) {
      reasons.push(`matched keywords: ${matchedWords.join(", ")}`);
    }

    const descriptionMatch = skillMdContent.match(/description:\s*(.+)/i);
    if (descriptionMatch) {
      reasons.push(`skill description: ${descriptionMatch[1].slice(0, 80)}`);
    }

    return reasons.join("; ") || "general match";
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}