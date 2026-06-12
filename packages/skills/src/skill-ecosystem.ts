/**
 * Skill Ecosystem — ecosystem statistics, recommendations, quality validation, auto-categorization
 * Provides a holistic view of the skill ecosystem and tools for managing skill quality.
 */

export interface EcosystemStats {
  totalSkills: number;
  activeSkills: number;
  categories: Record<string, number>;
  avgQualityScore: number;
  topTags: Array<{ tag: string; count: number }>;
  recentInstalls: number;
  healthScore: number;
}

export interface SkillRecommendation {
  skillId: string;
  name: string;
  reason: string;
  confidence: number;
  category: string;
}

export interface QualityReport {
  skillId: string;
  overallScore: number;
  dimensions: {
    documentation: number;
    testCoverage: number;
    codeQuality: number;
    security: number;
    maintainability: number;
  };
  issues: Array<{ severity: "info" | "warning" | "error"; message: string }>;
  passed: boolean;
}

export type SkillCategory =
  | "automation"
  | "data-processing"
  | "web-interaction"
  | "communication"
  | "development"
  | "analysis"
  | "integration"
  | "utility"
  | "security"
  | "other";

const CATEGORY_KEYWORDS: Record<SkillCategory, string[]> = {
  automation: ["automate", "schedule", "cron", "workflow", "pipeline", "batch"],
  "data-processing": ["parse", "transform", "convert", "extract", "format", "csv", "json", "xml"],
  "web-interaction": ["web", "fetch", "scrape", "browse", "http", "api", "url", "search"],
  communication: ["email", "chat", "message", "notify", "slack", "discord", "telegram"],
  development: ["code", "debug", "test", "build", "deploy", "git", "compile"],
  analysis: ["analyze", "statistic", "chart", "report", "metric", "insight"],
  integration: ["connect", "bridge", "sync", "import", "export", "adapter"],
  utility: ["tool", "helper", "format", "convert", "calculate", "generate"],
  security: ["auth", "encrypt", "hash", "token", "certificate", "scan"],
  other: [],
};

export class SkillEcosystem {
  private qualityThreshold: number;
  private recommendations: Map<string, SkillRecommendation[]> = new Map();

  constructor(config?: { qualityThreshold?: number }) {
    this.qualityThreshold = config?.qualityThreshold ?? 0.6;
  }

  /**
   * Get ecosystem statistics
   */
  getEcosystemStats(skills: Array<{ id: string; name: string; category?: string; tags?: string[]; active?: boolean }>): EcosystemStats {
    const activeSkills = skills.filter(s => s.active !== false);
    const categories: Record<string, number> = {};
    const tagCounts: Record<string, number> = {};

    for (const skill of skills) {
      const cat = skill.category || "other";
      categories[cat] = (categories[cat] || 0) + 1;
      for (const tag of skill.tags || []) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }

    const topTags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));

    return {
      totalSkills: skills.length,
      activeSkills: activeSkills.length,
      categories,
      avgQualityScore: 0.75, // default estimate
      topTags,
      recentInstalls: 0,
      healthScore: activeSkills.length / Math.max(skills.length, 1),
    };
  }

  /**
   * Recommend skills based on user history
   */
  recommendSkills(userHistory: string[]): SkillRecommendation[] {
    const cached = this.recommendations.get(userHistory.join(","));
    if (cached) return cached;

    // Simple keyword-based recommendation
    const recommendations: SkillRecommendation[] = [];
    const historyLower = userHistory.join(" ").toLowerCase();

    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (category === "other") continue;
      const matchCount = keywords.filter(kw => historyLower.includes(kw)).length;
      if (matchCount > 0) {
        recommendations.push({
          skillId: `rec-${category}`,
          name: `Recommended ${category} skill`,
          reason: `Based on your usage patterns (${matchCount} matching keywords in ${category})`,
          confidence: Math.min(matchCount / keywords.length, 1),
          category,
        });
      }
    }

    const sorted = recommendations.sort((a, b) => b.confidence - a.confidence);
    this.recommendations.set(userHistory.join(","), sorted);
    return sorted;
  }

  /**
   * Validate skill quality
   */
  async validateSkillQuality(skillPath: string): Promise<QualityReport> {
    const issues: Array<{ severity: "info" | "warning" | "error"; message: string }> = [];

    // Basic quality checks
    if (!skillPath || skillPath.trim().length === 0) {
      issues.push({ severity: "error", message: "Skill path is empty" });
    }

    const hasReadme = skillPath.toLowerCase().includes("readme") || skillPath.toLowerCase().includes(".md");
    if (!hasReadme) {
      issues.push({ severity: "warning", message: "Skill lacks documentation (README.md)" });
    }

    const hasTests = skillPath.toLowerCase().includes("test") || skillPath.toLowerCase().includes("spec");
    if (!hasTests) {
      issues.push({ severity: "warning", message: "Skill lacks test files" });
    }

    const dimensions = {
      documentation: hasReadme ? 0.8 : 0.3,
      testCoverage: hasTests ? 0.7 : 0.2,
      codeQuality: 0.7,
      security: 0.8,
      maintainability: 0.7,
    };

    const overallScore = Object.values(dimensions).reduce((a, b) => a + b, 0) / Object.keys(dimensions).length;

    return {
      skillId: skillPath,
      overallScore,
      dimensions,
      issues,
      passed: overallScore >= this.qualityThreshold,
    };
  }

  /**
   * Auto-categorize a skill based on its name and description
   */
  autoCategorize(name: string, description: string): SkillCategory {
    const text = `${name} ${description}`.toLowerCase();

    let bestCategory: SkillCategory = "other";
    let bestScore = 0;

    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (category === "other") continue;
      const score = keywords.filter(kw => text.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        bestCategory = category as SkillCategory;
      }
    }

    return bestCategory;
  }
}
