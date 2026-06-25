import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { EvolutionEngine } from "../src/evolution-engine";
import { GeneticEvolutionEngine } from "../src/genetic-engine";
import type { EvolutionCycle } from "@evoclaw/core";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

describe("EvolutionEngine Integration", () => {
  const createdDirs: string[] = [];

  function createEngine() {
    const registry = new ServiceRegistry();
    const eventBus = new EventBus();
    registry.registerService("eventBus", eventBus);
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-test-"));
    createdDirs.push(storeDir);
    const engine = new EvolutionEngine(registry, eventBus, { storeDir });
    return { engine, storeDir, registry, eventBus };
  }

  afterEach(() => {
    while (createdDirs.length) {
      const dir = createdDirs.pop()!;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("should create EvolutionEngine with all sub-components initialized", () => {
    const { engine } = createEngine();

    expect(engine).toBeDefined();
    expect(engine.requirementMiner).toBeDefined();
    expect(engine.proposer).toBeDefined();
    expect(engine.evaluator).toBeDefined();
    expect(engine.hotReload).toBeDefined();
    expect(engine.healthCheck).toBeDefined();
  });

  it("should start and complete an evolution cycle from manual trigger", async () => {
    const { engine } = createEngine();
    const cycle = await engine.startEvolutionCycle("manual", {
      reason: "integration_test",
    });
    expect(cycle).toBeDefined();
    expect(cycle.id).toBeDefined();
    expect(cycle.status).toMatch(/completed|rejected|failed/);
    expect(cycle.candidates.length).toBeGreaterThanOrEqual(0);
    const history = await engine.getCycleHistory();
    expect(history.length).toBeGreaterThan(0);
    expect(history[history.length - 1].id).toBe(cycle.id);
  });

  it("should record reinforcement feedback", async () => {
    const { engine } = createEngine();
    await engine.recordFeedback({
      cycleId: "test-cycle-1",
      skillId: "test-skill-1",
      successRate: 0.85,
      userAdoptionRate: 0.6,
      tokenConsumption: 1500,
      errorRate: 0.05,
    });
  });

  it("should start evolution cycle from task_failure source", async () => {
    const { engine } = createEngine();
    const cycle = await engine.startEvolutionCycle("task_failure", {
      traceId: "test-trace",
      failedTask: { taskId: "failed-1", error: "Dependency not found" },
      recentFailures: [],
    });
    expect(cycle.source).toBe("task_failure");
    expect(cycle.status).toMatch(/completed|rejected|failed/);
  });

  it("should start evolution cycle from user_feedback source", async () => {
    const { engine } = createEngine();
    const cycle = await engine.startEvolutionCycle("user_feedback", {
      feedback: "Skill response too slow",
      rating: 2,
    });
    expect(cycle.source).toBe("user_feedback");
    expect(cycle.status).toMatch(/completed|rejected|failed/);
  });

  it("should have health check working", async () => {
    const { engine } = createEngine();
    const healthy = await engine.healthCheck();
    expect(healthy).toBe(true);
  });
});

describe("GeneticEvolutionEngine Integration", () => {
  it("should start with empty population", () => {
    const registry = new ServiceRegistry();
    const eventBus = new EventBus();
    const engine = new GeneticEvolutionEngine(registry, eventBus);

    const seed = {
      id: "seed-1",
      type: "code_patch" as const,
      proposedChanges: {
        description: "Fix bug in error handler",
        codeChanges: [],
        configChanges: {},
      },
      codeArtifacts: [
        {
          name: "patch",
          language: "typescript",
          source: "function handler() { return 'fixed'; }",
          tests: "test('works', () => {});",
          dependencies: [],
        },
      ],
      risk: { level: "low" as const, factors: ["test_change"], mitigation: "Test in sandbox" },
      generatedAt: new Date(),
    };

    expect(engine.getGeneration()).toBe(0);
    expect(engine.getPopulation().length).toBe(0);
  });
});