import {
  ServiceRegistry,
  EventBus,
  type Skill,
  type SkillStats,
  type SkillTrigger,
  type SkillCategory,
} from "@evoclaw/core";
import { TfidfMatcher } from "./tfidf-matcher";

export interface CapabilityScore {
  overall: number;
  keywordMatch: number;
  categoryMatch: number;
  triggerMatch: number;
  usageScore: number;
  healthScore: number;
}

const CATEGORY_KEYWORDS: Record<SkillCategory, string[]> = {
  automation: ["自动", "自动化", "定时", "批处理", "脚本", "automate", "schedule", "batch", "cron", "workflow"],
  integration: ["集成", "连接", "同步", "对接", "integrate", "connect", "sync", "api", "webhook", "bridge"],
  analysis: ["分析", "统计", "报表", "数据", "趋势", "analyze", "statistics", "report", "insight", "dashboard"],
  generation: ["生成", "创建", "制作", "编写", "generate", "create", "produce", "compose", "build", "write"],
  utility: ["工具", "辅助", "转换", "格式", "utility", "tool", "convert", "format", "helper", "manage"],
  custom: ["自定义", "特殊", "定制", "custom", "special", "bespoke", "tailored"],
};

export class SkillCapabilityEvaluator {
  private tfidfMatcher: TfidfMatcher;
  private corpusBuilt = false;
  private indexedSkillIds: Set<string> | null = null;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.tfidfMatcher = new TfidfMatcher();
    registry.registerService("skillCapabilityEvaluator", this);
  }

  buildCorpus(skills: Skill[]): void {
    const documents = skills.map(skill => ({
      id: skill.id,
      text: [skill.name, skill.description, ...skill.keywords].join(" "),
      metadata: { description: skill.description, category: skill.category },
    }));
    this.tfidfMatcher.initialize(documents);
    this.indexedSkillIds = new Set(skills.map(s => s.id));
    this.corpusBuilt = true;
  }

  evaluateMatch(skill: Skill, taskDescription: string): CapabilityScore {
    const keywordMatch = this.computeKeywordMatch(skill, taskDescription);
    const categoryMatch = this.computeCategoryMatch(skill, taskDescription);
    const triggerMatch = this.computeTriggerMatch(skill, taskDescription);
    const usageScore = this.computeUsageScore(skill.stats);
    const healthScore = this.computeHealthScore(skill);

    const overall =
      0.3 * keywordMatch +
      0.2 * categoryMatch +
      0.2 * triggerMatch +
      0.15 * usageScore +
      0.15 * healthScore;

    return {
      overall,
      keywordMatch,
      categoryMatch,
      triggerMatch,
      usageScore,
      healthScore,
    };
  }

  findBestMatch(skills: Skill[], taskDescription: string): Skill | null {
    if (skills.length === 0) return null;

    const ranked = this.rankSkills(skills, taskDescription);
    if (ranked.length === 0) return null;

    const best = ranked[0];
    return best.score.overall > 0 ? best.skill : null;
  }

  rankSkills(skills: Skill[], taskDescription: string): Array<{ skill: Skill; score: CapabilityScore }> {
    if (skills.length === 0) return [];

    if (!this.corpusBuilt) {
      this.buildCorpus(skills);
    } else {
      // 直接比较技能 ID 集合，避免依赖 search 结果间接判断（后者逻辑错误）
      const currentIds = new Set(skills.map(s => s.id));
      const indexedIds = this.indexedSkillIds ?? new Set<string>();
      const needsRebuild = currentIds.size !== indexedIds.size ||
        [...currentIds].some(id => !indexedIds.has(id));
      if (needsRebuild) this.buildCorpus(skills);
    }

    const results: Array<{ skill: Skill; score: CapabilityScore }> = [];

    for (const skill of skills) {
      const score = this.evaluateMatch(skill, taskDescription);
      results.push({ skill, score });
    }

    results.sort((a, b) => b.score.overall - a.score.overall);
    return results;
  }

  private computeKeywordMatch(skill: Skill, taskDescription: string): number {
    let score = 0;

    if (this.corpusBuilt) {
      const tfidfResults = this.tfidfMatcher.search(taskDescription, 0, 100);
      const match = tfidfResults.find(r => r.target === skill.id);
      if (match) {
        score = match.score;
      }
    }

    const text = [skill.name, skill.description, ...skill.keywords].join(" ").toLowerCase();
    const task = taskDescription.toLowerCase();
    const keywordScore = TfidfMatcher.keywordScore(task, text);

    return Math.max(score, keywordScore);
  }

  private computeCategoryMatch(skill: Skill, taskDescription: string): number {
    const lowerTask = taskDescription.toLowerCase();
    const categoryKeywords = CATEGORY_KEYWORDS[skill.category] || [];
    if (categoryKeywords.length === 0) return 0;

    let matchCount = 0;
    for (const keyword of categoryKeywords) {
      if (lowerTask.includes(keyword.toLowerCase())) {
        matchCount++;
      }
    }

    return matchCount / categoryKeywords.length;
  }

  private computeTriggerMatch(skill: Skill, taskDescription: string): number {
    const triggers = skill.triggers;
    if (!triggers || triggers.length === 0) return 0;

    // 限制输入文本长度，防止 ReDoS 在超长输入上放大
    const lowerTask = taskDescription.toLowerCase().substring(0, 10000);

    for (const trigger of triggers) {
      if (trigger.type === "keyword") {
        const regex = this.buildSafeTriggerRegex(trigger.pattern);
        if (regex && regex.test(lowerTask)) return 1.0;
        // pattern 不安全或无效时退化为 includes 匹配
        if (lowerTask.includes(trigger.pattern.toLowerCase())) return 1.0;
      } else if (trigger.type === "intent") {
        const regex = this.buildSafeTriggerRegex(trigger.pattern);
        if (regex && regex.test(lowerTask)) return 0.8;
        if (lowerTask.includes(trigger.pattern.toLowerCase())) return 0.8;
      }
    }

    return 0;
  }

  /**
   * 安全地构建 trigger 正则：限制 pattern 长度（< 100）并拒绝嵌套量词
   * （如 (a+)+ ）以防 ReDoS。返回 null 表示 pattern 不安全或无效。
   */
  private buildSafeTriggerRegex(pattern: string): RegExp | null {
    if (!pattern || pattern.length >= 100) return null;
    // 检测嵌套量词：分组内含量词且分组后紧跟量词
    if (/(?:\([^)]*[+*?][^)]*\)[+*?])/.test(pattern)) return null;
    try {
      return new RegExp(pattern, "i");
    } catch {
      return null;
    }
  }

  private computeUsageScore(stats: SkillStats): number {
    if (stats.invocationCount === 0) return 0.3;

    const successRate = stats.invocationCount > 0
      ? stats.successCount / stats.invocationCount
      : 0;

    const invocationFactor = Math.min(stats.invocationCount / 100, 1);
    const ratingFactor = stats.userRating / 5;

    return 0.4 * successRate + 0.3 * invocationFactor + 0.3 * ratingFactor;
  }

  private computeHealthScore(skill: Skill): number {
    const healthCheck = skill.lifecycle?.healthCheck;
    if (!healthCheck) return 0.5;

    if (!healthCheck.healthy) return 0.1;

    let score = 0.8;

    if (healthCheck.errors && healthCheck.errors.length > 0) {
      score -= 0.1 * healthCheck.errors.length;
    }

    if (healthCheck.missingDependencies && healthCheck.missingDependencies.length > 0) {
      score -= 0.15 * healthCheck.missingDependencies.length;
    }

    return Math.max(score, 0);
  }
}
