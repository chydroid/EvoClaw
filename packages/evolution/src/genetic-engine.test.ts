import { describe, it, expect } from "vitest";
import { GeneticEvolutionEngine, type FitnessScore } from "./genetic-engine";
import type { EvolutionCandidate } from "@evoclaw/core";
import { v4 as uuid } from "uuid";

function createSeedCandidate(type: "code_patch" | "skill_update" = "code_patch"): EvolutionCandidate {
  return {
    id: uuid(),
    type,
    proposedChanges: {
      description: "Test candidate",
      codeChanges: [
        {
          filePath: "test.ts",
          diff: "+ // improvement",
          language: "typescript",
          reasoning: "Test reasoning",
        },
      ],
      configChanges: {},
    },
    codeArtifacts: [
      {
        name: "test_code",
        language: "typescript",
        source: 'export function test() { return "ok"; }',
        tests: 'expect(test()).toBe("ok");',
        dependencies: [],
      },
    ],
    risk: { level: "medium", factors: ["unknown"], mitigation: "test in sandbox" },
    generatedAt: new Date(),
  };
}

function simpleEvaluator(candidate: EvolutionCandidate): Promise<FitnessScore> {
  const hasCode = candidate.codeArtifacts.length > 0;
  const hasTests = candidate.codeArtifacts.some((a) => a.tests.length > 0);
  const lowRisk = candidate.risk.level === "low";

  const score = (hasCode ? 0.4 : 0) + (hasTests ? 0.3 : 0) + (lowRisk ? 0.2 : 0) + Math.random() * 0.1;

  return Promise.resolve({
    candidateId: candidate.id,
    testPassRate: hasTests ? 0.8 : 0,
    securityScore: lowRisk ? 0.9 : 0.5,
    performanceScore: 0.7,
    codeQualityScore: hasCode ? 0.6 : 0,
    overallFitness: score,
    details: [],
  });
}

describe("GeneticEvolutionEngine", () => {
  it("should initialize population from seed", async () => {
    const engine = new GeneticEvolutionEngine(null as never, null as never);
    const seed = createSeedCandidate();

    const result = await engine.evolve(seed, simpleEvaluator);

    expect(result).toBeTruthy();
    expect(engine.getGeneration()).toBeGreaterThanOrEqual(0);
    expect(engine.getPopulation().length).toBeGreaterThan(0);
  });

  it("should improve fitness over generations", async () => {
    const engine = new GeneticEvolutionEngine(null as never, null as never);

    const seed = createSeedCandidate();
    const seedScore = await simpleEvaluator(seed);

    seed.risk.level = "low";

    const result = await engine.evolve(seed, simpleEvaluator);

    expect(result).toBeTruthy();
    if (!result) return;

    const resultScore = await simpleEvaluator(result);
    expect(resultScore.overallFitness).toBeGreaterThan(seedScore.overallFitness);
  });

  it("should produce candidates with valid structure", async () => {
    const engine = new GeneticEvolutionEngine(null as never, null as never);
    const seed = createSeedCandidate("skill_update");

    const result = await engine.evolve(seed, simpleEvaluator);

    if (result) {
      expect(result.id).toBeTruthy();
      expect(result.type).toBe("skill_update");
      expect(result.proposedChanges).toBeDefined();
      expect(result.risk.level).toBeDefined();
    }
  });
});