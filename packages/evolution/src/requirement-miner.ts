import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  type EvolutionInput,
} from "@evoclaw/core";

interface AnalyzedRequirement {
  type: "new_skill" | "skill_update" | "code_patch" | "config_change";
  source: EvolutionInput["triggerEvent"];
  description: string;
  relatedSkills: string[];
  failurePattern: string | null;
  confidence: number;
}

export class RequirementMiner {
  private observedPatterns = new Map<string, number>();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.eventBus.subscribe(SystemEvents.SKILL_FAILED, async (event) => {
      const data = event.data as Record<string, unknown>;
      if (data?.skillId) {
        this.observeFailure(String(data.skillId));
      }
    });
  }

  async analyze(input: EvolutionInput): Promise<AnalyzedRequirement[]> {
    const requirements: AnalyzedRequirement[] = [];

    for (const log of input.failureLogs) {
      const pattern = this.extractFailurePattern(log);
      if (pattern) {
        requirements.push({
          type: "skill_update",
          source: input.triggerEvent,
          description: `Detected failure pattern: ${pattern}`,
          relatedSkills: input.relatedSkills,
          failurePattern: pattern,
          confidence: input.successRate < 0.5 ? 0.8 : 0.4,
        });
      }
    }

    if (requirements.length === 0 && input.successRate < 0.3) {
      requirements.push({
        type: "code_patch",
        source: input.triggerEvent,
        description: "Low success rate detected, generating improvement candidate",
        relatedSkills: input.relatedSkills,
        failurePattern: "low_success_rate",
        confidence: 0.6,
      });
    }

    return requirements;
  }

  observePattern(userIntent: string): void {
    const count = this.observedPatterns.get(userIntent) || 0;
    this.observedPatterns.set(userIntent, count + 1);

    if (count + 1 >= 5) {
      console.log(`[RequirementMiner] Pattern detected: "${userIntent}" has ${count + 1} occurrences`);
    }
  }

  getFrequentPatterns(threshold = 3): string[] {
    const results: string[] = [];
    for (const [pattern, count] of this.observedPatterns) {
      if (count >= threshold) {
        results.push(pattern);
      }
    }
    return results;
  }

  private observeFailure(skillId: string): void {
    const key = `failure:${skillId}`;
    this.observedPatterns.set(key, (this.observedPatterns.get(key) || 0) + 1);
  }

  private extractFailurePattern(log: string): string | null {
    const patterns = [
      { regex: /dependency\s*["']?(\w+)["']?\s*not found/i, pattern: "missing_dependency" },
      { regex: /permission denied/i, pattern: "insufficient_permissions" },
      { regex: /timeout/i, pattern: "execution_timeout" },
      { regex: /out of memory/i, pattern: "memory_exhaustion" },
    ];

    for (const { regex, pattern } of patterns) {
      if (regex.test(log)) {
        return pattern;
      }
    }
    return null;
  }
}