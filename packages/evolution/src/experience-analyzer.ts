import {
  ServiceRegistry,
  EventBus,
  type Skill,
  type EvolutionCandidate,
  type MemoryEntry,
  type MemorySearchQuery,
} from "@evoclaw/core";
import { SemanticEmbedder } from "./semantic-embedder";

export interface ExperiencePattern {
  id: string;
  type: "success" | "failure" | "improvement";
  category: string;
  description: string;
  sourceSkill: string;
  sourceVersion: string;
  failurePattern: string | null;
  solution: string | null;
  codeChanges: string | null;
  confidence: number;
  frequency: number;
  lastSeen: Date;
  relatedPatterns: string[];
  tags: string[];
  performanceDelta: number;
}

export interface ExperienceAnalysis {
  patterns: ExperiencePattern[];
  recommendations: ExperienceRecommendation[];
  similarityScores: SimilarityScore[];
  crossDomainInsights: CrossDomainInsight[];
  summary: string;
}

export interface ExperienceRecommendation {
  id: string;
  urgency: "critical" | "high" | "medium" | "low";
  targetSkill: string;
  suggestedAction: string;
  reasoning: string;
  basedOnPatterns: string[];
  expectedImpact: number;
}

export interface SimilarityScore {
  patternId: string;
  sourceId: string;
  score: number;
  dimension: string;
  matchedFeatures: string[];
}

export interface CrossDomainInsight {
  sourceDomain: string;
  targetDomain: string;
  insight: string;
  transferability: number;
  adaptationCost: number;
  precedents: string[];
}

export class ExperienceAnalyzer {
  private patterns = new Map<string, ExperiencePattern>();
  private patternEmbeddings = new Map<string, number[]>();
  private embedder: SemanticEmbedder;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    embedder?: SemanticEmbedder,
  ) {
    this.embedder = embedder || new SemanticEmbedder(registry);
    registry.registerService("experienceAnalyzer", this);
  }

  async analyzeFailures(
    recentFailures: Array<{
      skillId: string;
      skillName: string;
      error: string;
      context: Record<string, unknown>;
    }>
  ): Promise<ExperienceAnalysis> {
    const patterns = this.extractFailurePatterns(recentFailures);

    for (const pattern of patterns) {
      const existing = this.findSimilarPattern(pattern);
      if (existing) {
        existing.frequency++;
        existing.lastSeen = new Date();
        existing.confidence = Math.min(1, existing.confidence + 0.05);
      } else {
        pattern.embedding = this.generatePatternEmbedding(pattern);
        this.patterns.set(pattern.id, pattern);
        this.patternEmbeddings.set(pattern.id, pattern.embedding);
      }
    }

    const historyPatterns = Array.from(this.patterns.values()).slice(-50);

    const ancestors = await this.findRelatedExperiences(recentFailures);

    const similarScenarios = await this.searchSimilarScenarios(
      recentFailures
    );

    const similarities = similarScenarios.map((s) => ({
      patternId: s.patternId,
      sourceId: s.sourceId,
      score: s.score,
      dimension: s.dimension,
      matchedFeatures: s.matchedFeatures,
    }));

    const crossDomain = this.extractCrossDomainInsights(
      recentFailures,
      historyPatterns
    );

    const recommendations = this.generateRecommendations(
      patterns,
      historyPatterns,
      ancestors,
      crossDomain
    );

    const summary = this.generateSummary(
      patterns.length,
      recommendations.length,
      similarities.length,
      crossDomain.length
    );

    const analysis: ExperienceAnalysis = {
      patterns: patterns.map((p) => ({
        id: p.id,
        type: p.type,
        category: p.category,
        description: p.description,
        sourceSkill: p.sourceSkill,
        sourceVersion: p.sourceVersion,
        failurePattern: this.classifyFailure(p.description),
        solution: p.solution || null,
        codeChanges: p.codeChanges || null,
        confidence: p.confidence,
        frequency: p.frequency,
        lastSeen: new Date(),
        relatedPatterns: p.relatedPatterns,
        tags: p.tags,
        performanceDelta: p.performanceDelta,
      })),
      recommendations,
      similarityScores: similarities,
      crossDomainInsights: crossDomain,
      summary,
    };

    await this.eventBus?.publish(
      "evolution.experience_analyzed",
      { analysisId: `analysis_${Date.now()}`, patternCount: patterns.length },
      "experience-analyzer"
    );

    return analysis;
  }

  async findInsights(
    skill: Skill,
    context: Record<string, unknown>
  ): Promise<ExperienceRecommendation[]> {
    const queryContext = {
      skillName: skill.name,
      category: skill.category,
      ...context,
    };

    const contextEmbedding = this.generateTextEmbedding(
      JSON.stringify(queryContext)
    );

    const scored: Array<{ pattern: ExperiencePattern; score: number }> = [];

    for (const [, pattern] of this.patterns) {
      const embedding = this.patternEmbeddings.get(pattern.id);
      if (!embedding) continue;

      const score = this.cosineSimilarity(contextEmbedding, embedding);

      if (pattern.category === skill.category) {
        scored.push({ pattern, score: score * 1.2 });
      } else {
        scored.push({ pattern, score: score * 0.8 });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const topMatches = scored.slice(0, 5).filter((m) => m.score > 0.3);

    return topMatches.map((m) => ({
      id: `rec_${Date.now()}_${m.pattern.id.slice(0, 8)}`,
      urgency: m.score > 0.7 ? "critical" : m.score > 0.5 ? "high" : "medium",
      targetSkill: skill.id,
      suggestedAction: m.pattern.solution || "Review pattern for improvement ideas",
      reasoning: `Pattern "${m.pattern.description}" matched with score ${m.score.toFixed(2)}`,
      basedOnPatterns: [m.pattern.id],
      expectedImpact: Math.round(m.score * 100),
    }));
  }

  getPatterns(): ExperiencePattern[] {
    return Array.from(this.patterns.values());
  }

  getPattern(patternId: string): ExperiencePattern | undefined {
    return this.patterns.get(patternId);
  }

  private extractFailurePatterns(
    failures: Array<{
      skillId: string;
      skillName: string;
      error: string;
      context: Record<string, unknown>;
    }>
  ): (ExperiencePattern & { embedding?: number[] })[] {
    return failures.map((failure, index) => {
      const errorLower = failure.error.toLowerCase();

      let category = "execution_error";
      if (errorLower.includes("timeout")) category = "timeout";
      else if (errorLower.includes("permission") || errorLower.includes("denied")) category = "permission";
      else if (errorLower.includes("dependency") || errorLower.includes("module")) category = "dependency";
      else if (errorLower.includes("memory") || errorLower.includes("heap")) category = "memory";
      else if (errorLower.includes("network") || errorLower.includes("fetch")) category = "network";
      else if (errorLower.includes("syntax") || errorLower.includes("parse")) category = "syntax";
      else if (errorLower.includes("type") || errorLower.includes("undefined")) category = "type_error";

      const pattern: ExperiencePattern & { embedding?: number[] } = {
        id: `pat_${Date.now()}_${index}`,
        type: "failure",
        category,
        description: failure.error,
        sourceSkill: failure.skillName,
        sourceVersion: "unknown",
        failurePattern: null,
        solution: null,
        codeChanges: null,
        confidence: 0.3,
        frequency: 1,
        lastSeen: new Date(),
        relatedPatterns: [],
        tags: [failure.skillName, category],
        performanceDelta: -1,
      };

      return pattern;
    });
  }

  private findSimilarPattern(
    pattern: ExperiencePattern
  ): ExperiencePattern | undefined {
    for (const [, existing] of this.patterns) {
      if (
        existing.category === pattern.category &&
        existing.sourceSkill === pattern.sourceSkill &&
        this.stringSimilarity(existing.description, pattern.description) > 0.7
      ) {
        return existing;
      }
    }
    return undefined;
  }

  private async findRelatedExperiences(
    failures: Array<{
      skillId: string;
      skillName: string;
      error: string;
      context: Record<string, unknown>;
    }>
  ): Promise<MemoryEntry[]> {
    const memoryHub = this.registry.resolveService<{
      recall(query: MemorySearchQuery): Promise<MemoryEntry[]>;
    }>("memoryHub");

    if (!memoryHub) return [];

    try {
      const results = await memoryHub.recall({
        query: failures.map((f) => f.skillName).join(" "),
        tags: ["evolution", "failure", "improvement"],
        limit: 20,
      });
      return results;
    } catch (memoryErr) {
      console.debug("[ExperienceAnalyzer] Memory recall failed, continuing without memory insights:", memoryErr instanceof Error ? memoryErr.message : String(memoryErr));
      return [];
    }
  }

  private async searchSimilarScenarios(
    failures: Array<{
      skillId: string;
      skillName: string;
      error: string;
      context: Record<string, unknown>;
    }>
  ): Promise<
    Array<{
      patternId: string;
      sourceId: string;
      score: number;
      dimension: string;
      matchedFeatures: string[];
    }>
  > {
    const results: Array<{
      patternId: string;
      sourceId: string;
      score: number;
      dimension: string;
      matchedFeatures: string[];
    }> = [];

    for (const failure of failures) {
      const queryEmbedding = this.generateTextEmbedding(
        `${failure.skillName} ${failure.error}`
      );

      const similarityResults = this.searchByEmbedding(
        queryEmbedding,
        5
      );

      for (const sim of similarityResults) {
        results.push({
          patternId: sim.id,
          sourceId: failure.skillId,
          score: Math.round(sim.score * 100) / 100,
          dimension: "semantic",
          matchedFeatures: sim.features,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 10);
  }

  private searchByEmbedding(
    queryEmbedding: number[],
    limit: number
  ): Array<{ id: string; score: number; features: string[] }> {
    const results: Array<{
      id: string;
      score: number;
      features: string[];
    }> = [];

    for (const [patternId, embedding] of this.patternEmbeddings) {
      const score = this.cosineSimilarity(queryEmbedding, embedding);
      if (score > 0.2) {
        results.push({
          id: patternId,
          score,
          features: ["semantic_match"],
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private extractCrossDomainInsights(
    failures: Array<{
      skillId: string;
      skillName: string;
      error: string;
      context: Record<string, unknown>;
    }>,
    historyPatterns: ExperiencePattern[]
  ): CrossDomainInsight[] {
    const insights: CrossDomainInsight[] = [];
    const categories = new Set(historyPatterns.map((p) => p.category));

    for (const failure of failures) {
      const failureCategory = this.classifyFailure(failure.error);

      for (const existingCategory of categories) {
        if (existingCategory === failureCategory) continue;

        const matchingPatterns = historyPatterns.filter(
          (p) => p.category === existingCategory
        );

        if (matchingPatterns.length >= 2) {
          const transferability = matchingPatterns.some(
            (p) => p.confidence > 0.7
          )
            ? 0.5
            : 0.2;

          insights.push({
            sourceDomain: existingCategory,
            targetDomain: failureCategory,
            insight: `Patterns from "${existingCategory}" domain may apply to "${failureCategory}" failures in "${failure.skillName}"`,
            transferability,
            adaptationCost: transferability > 0.4 ? 0.3 : 0.7,
            precedents: matchingPatterns.slice(0, 3).map((p) => p.id),
          });
        }
      }
    }

    return insights;
  }

  private generateRecommendations(
    newPatterns: ExperiencePattern[],
    historyPatterns: ExperiencePattern[],
    ancestors: MemoryEntry[],
    crossDomain: CrossDomainInsight[]
  ): ExperienceRecommendation[] {
    const recommendations: ExperienceRecommendation[] = [];

    for (const pattern of newPatterns) {
      const relatedHistorical = historyPatterns.filter(
        (h) => h.category === pattern.category
      );

      if (relatedHistorical.length > 0) {
        recommendations.push({
          id: `rec_${pattern.id}`,
          urgency: pattern.confidence < 0.3 ? "high" : "medium",
          targetSkill: pattern.sourceSkill,
          suggestedAction:
            relatedHistorical[0].solution ||
            "Apply known fix from historical pattern",
          reasoning: `${relatedHistorical.length} similar patterns found in history`,
          basedOnPatterns: relatedHistorical.map((p) => p.id).slice(0, 3),
          expectedImpact: 70,
        });
      }
    }

    if (ancestors.length > 0) {
      recommendations.push({
        id: `rec_memory_${Date.now()}`,
        urgency: "medium",
        targetSkill: "evolution-engine",
        suggestedAction:
          "Consider applying past successful improvements from memory",
        reasoning: `Found ${ancestors.length} related memory entries`,
        basedOnPatterns: [],
        expectedImpact: 50,
      });
    }

    for (const insight of crossDomain) {
      if (insight.transferability > 0.3) {
        recommendations.push({
          id: `rec_cross_${Date.now()}`,
          urgency: "low",
          targetSkill: "evolution-engine",
          suggestedAction: `Explore cross-domain pattern transfer: ${insight.insight}`,
          reasoning: `Transferability: ${Math.round(insight.transferability * 100)}%, Cost: ${Math.round(insight.adaptationCost * 100)}%`,
          basedOnPatterns: insight.precedents,
          expectedImpact: Math.round(insight.transferability * 80),
        });
      }
    }

    recommendations.sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return order[a.urgency] - order[b.urgency];
    });

    return recommendations;
  }

  private generateSummary(
    newPatterns: number,
    recommendations: number,
    similarities: number,
    crossDomain: number
  ): string {
    const parts: string[] = [];

    if (newPatterns > 0) {
      parts.push(`Detected ${newPatterns} new failure pattern${newPatterns > 1 ? "s" : ""}`);
    }
    if (recommendations > 0) {
      parts.push(`generated ${recommendations} recommendation${recommendations > 1 ? "s" : ""}`);
    }
    if (similarities > 0) {
      parts.push(`found ${similarities} similar scenario${similarities > 1 ? "s" : ""}`);
    }
    if (crossDomain > 0) {
      parts.push(`identified ${crossDomain} cross-domain insight${crossDomain > 1 ? "s" : ""}`);
    }

    return parts.length > 0 ? parts.join(", ") + "." : "No significant patterns detected.";
  }

  private classifyFailure(error: string): string {
    const lower = error.toLowerCase();
    if (lower.includes("timeout")) return "execution_timeout";
    if (lower.includes("permission") || lower.includes("denied")) return "insufficient_permissions";
    if (lower.includes("dependency") || lower.includes("not found")) return "missing_dependency";
    if (lower.includes("memory") || lower.includes("heap")) return "memory_exhaustion";
    if (lower.includes("network") || lower.includes("fetch")) return "network_failure";
    if (lower.includes("syntax") || lower.includes("parse")) return "syntax_error";
    if (lower.includes("type") || lower.includes("undefined")) return "type_error";
    return "execution_error";
  }

  private generatePatternEmbedding(
    pattern: ExperiencePattern
  ): number[] {
    return this.embedder.hashEmbedding(
      `${pattern.sourceSkill} ${pattern.category} ${pattern.description}`
    );
  }

  private generateTextEmbedding(text: string): number[] {
    return this.embedder.hashEmbedding(text);
  }

  /**
   * 异步生成语义嵌入向量（用于外部调用）
   */
  async generateSemanticEmbedding(text: string): Promise<number[]> {
    return this.embedder.embed(text);
  }

  /**
   * 获取嵌入器统计信息
   */
  getEmbedderStats(): ReturnType<SemanticEmbedder["getStats"]> {
    return this.embedder.getStats();
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  private stringSimilarity(a: string, b: string): number {
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

    const bigrams = new Set<string>();
    for (let i = 0; i < a.length - 1; i++) {
      bigrams.add(a.substring(i, i + 2));
    }

    let intersection = 0;
    for (let i = 0; i < b.length - 1; i++) {
      if (bigrams.has(b.substring(i, i + 2))) {
        intersection++;
      }
    }

    return (2.0 * intersection) / (a.length + b.length - 2);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}