import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  type EvolutionCandidate,
  type EvolutionEvaluation,
} from "@evoclaw/core";
import { v4 as uuid } from "uuid";

export interface FitnessScore {
  candidateId: string;
  testPassRate: number;
  securityScore: number;
  performanceScore: number;
  codeQualityScore: number;
  overallFitness: number;
  details: string[];
}

export interface MutationStrategy {
  name: string;
  probability: number;
  description: string;
  apply(candidate: EvolutionCandidate): EvolutionCandidate;
}

export class GeneticEvolutionEngine {
  private population: EvolutionCandidate[] = [];
  private generation = 0;
  private maxGenerations = 10;
  private populationSize = 20;
  private eliteSize = 3;
  private mutationRate = 0.1;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.registerStrategies();
  }

  private registerStrategies(): void {
    // Strategies will be registered per-cycle based on the candidate type
  }

  async evolve(
    seed: EvolutionCandidate,
    evaluator: (c: EvolutionCandidate) => Promise<FitnessScore>
  ): Promise<EvolutionCandidate | null> {
    this.initializePopulation(seed);
    let bestCandidate: EvolutionCandidate | null = null;
    let bestScore = 0;

    for (let gen = 0; gen < this.maxGenerations; gen++) {
      this.generation = gen;

      const scores = await this.evaluatePopulation(evaluator);

      for (const score of scores) {
        if (score.overallFitness > bestScore) {
          bestScore = score.overallFitness;
          bestCandidate = this.population.find((c) => c.id === score.candidateId) || null;
        }
      }

      if (bestScore >= 0.9) {
        await this.eventBus?.publish(
          "evolution.generation_complete",
          { generation: gen, bestScore, converged: true },
          "genetic-engine"
        );
        break;
      }

      this.nextGeneration(scores, seed);

      await this.eventBus?.publish(
        "evolution.generation_complete",
        { generation: gen, bestScore, populationSize: this.population.length },
        "genetic-engine"
      );
    }

    if (bestCandidate && bestScore >= 0.6) {
      bestCandidate.risk.level = bestScore > 0.8 ? "low" : "medium";
    }

    return bestCandidate;
  }

  private initializePopulation(seed: EvolutionCandidate): void {
    this.population = [seed];

    for (let i = 1; i < this.populationSize; i++) {
      const mutant = this.mutate(seed);
      mutant.id = uuid();
      this.population.push(mutant);
    }
  }

  private async evaluatePopulation(
    evaluator: (c: EvolutionCandidate) => Promise<FitnessScore>
  ): Promise<FitnessScore[]> {
    const scores: FitnessScore[] = [];

    for (const candidate of this.population) {
      try {
        const score = await evaluator(candidate);
        scores.push(score);
      } catch (evaluationErr) {
        console.warn(
          `[GeneticEngine] Evaluation failed for candidate ${candidate.id}:`,
          evaluationErr instanceof Error ? evaluationErr.message : String(evaluationErr)
        );
        scores.push({
          candidateId: candidate.id,
          testPassRate: 0,
          securityScore: 0,
          performanceScore: 0,
          codeQualityScore: 0,
          overallFitness: 0,
          details: ["evaluation_failed"],
        });
      }
    }

    return scores;
  }

  private nextGeneration(
    scores: FitnessScore[],
    original: EvolutionCandidate
  ): void {
    const scored = this.population
      .map((c, i) => ({ candidate: c, score: scores[i]?.overallFitness || 0 }))
      .sort((a, b) => b.score - a.score);

    const elites = scored.slice(0, this.eliteSize).map((s) => s.candidate);
    const newPopulation: EvolutionCandidate[] = [...elites];

    while (newPopulation.length < this.populationSize) {
      const parent1 = this.select(scored);
      const parent2 = this.select(scored);
      const child = this.crossover(parent1, parent2);

      if (Math.random() < this.mutationRate) {
        newPopulation.push(this.mutate(child));
      } else {
        newPopulation.push(child);
      }
    }

    if (newPopulation.length < this.populationSize) {
      const remaining = this.populationSize - newPopulation.length;
      for (let i = 0; i < remaining; i++) {
        const fresh = this.mutate(original);
        fresh.id = uuid();
        newPopulation.push(fresh);
      }
    }

    this.population = newPopulation.slice(0, this.populationSize);
  }

  private select(scored: { candidate: EvolutionCandidate; score: number }[]): EvolutionCandidate {
    const total = scored.reduce((sum, s) => sum + Math.max(s.score, 0.01), 0);
    let r = Math.random() * total;

    for (const s of scored) {
      r -= Math.max(s.score, 0.01);
      if (r <= 0) return s.candidate;
    }

    return scored[scored.length - 1].candidate;
  }

  private crossover(parent1: EvolutionCandidate, parent2: EvolutionCandidate): EvolutionCandidate {
    const child: EvolutionCandidate = {
      ...parent1,
      id: uuid(),
      codeArtifacts: [...parent1.codeArtifacts, ...parent2.codeArtifacts.slice(0, 1)],
      proposedChanges: {
        ...parent1.proposedChanges,
        description: `${parent1.proposedChanges.description} (crossed with ${parent2.id.slice(0, 8)})`,
        codeChanges: [
          ...parent1.proposedChanges.codeChanges,
          ...parent2.proposedChanges.codeChanges.slice(0, 1),
        ],
      },
      risk: {
        level: parent1.risk.level,
        factors: [...new Set([...parent1.risk.factors, ...parent2.risk.factors])],
        mitigation: `${parent1.risk.mitigation} | ${parent2.risk.mitigation}`,
      },
      generatedAt: new Date(),
    };

    return child;
  }

  private mutate(candidate: EvolutionCandidate): EvolutionCandidate {
    const mutant: EvolutionCandidate = {
      ...candidate,
      id: uuid(),
      codeArtifacts: candidate.codeArtifacts.map((a) => {
        if (Math.random() < 0.3) {
          return {
            ...a,
            source: this.perturbCode(a.source),
            name: `${a.name}_mut_${uuid().slice(0, 4)}`,
          };
        }
        return a;
      }),
      risk: {
        ...candidate.risk,
      },
      generatedAt: new Date(),
    };

    return mutant;
  }

  private perturbCode(source: string): string {
    const lines = source.split("\n");
    if (lines.length < 3) return source;

    const idx = Math.floor(Math.random() * lines.length);
    const perturbationType = Math.random();
    let perturbation: string;

    if (perturbationType < 0.25) {
      perturbation = `  // Mutation: timeout increased by ${Math.floor(Math.random() * 5000) + 1000}ms`;
    } else if (perturbationType < 0.5) {
      perturbation = `  const retryLimit = ${Math.floor(Math.random() * 5) + 1};`;
    } else if (perturbationType < 0.75) {
      perturbation = `  await new Promise(r => setTimeout(r, ${Math.floor(Math.random() * 500) + 50})); // Adaptive backoff`;
    } else {
      const numLines = Math.floor(Math.random() * 3) + 1;
      perturbation = `  if (typeof fallback === "undefined") { const fallback = () => { throw new Error("Not implemented"); }; }`;
    }

    lines.splice(idx, 0, perturbation);
    return lines.join("\n");
  }

  getGeneration(): number {
    return this.generation;
  }

  getPopulation(): EvolutionCandidate[] {
    return [...this.population];
  }
}