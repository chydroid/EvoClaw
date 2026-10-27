import { describe, it, expect, beforeEach } from "vitest";
import { ServiceRegistry, EventBus, type EvoEvent } from "@evoclaw/core";
import { ExperienceDistiller } from "../src/experience-distiller";
import type { ExecutionTrace, ReflectionResult } from "../src/external-reflector";

describe("ExperienceDistiller knowledge wiring", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let published: EvoEvent[];

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    published = [];
    eventBus.subscribe("knowledge.improvement_found", async (e) => {
      published.push(e);
    });
    eventBus.subscribe("evolution.strategy_distilled", async (e) => {
      published.push(e);
    });
  });

  function trace(id: string, category: ReflectionResult["failureCategory"]): ExecutionTrace {
    return { taskId: id, error: `boom-${id}`, steps: [], context: { category } };
  }

  function reflection(category: ReflectionResult["failureCategory"]): ReflectionResult {
    return {
      rootCause: `root cause for ${category}`,
      failureCategory: category,
      suggestedImprovements: ["retry once with backoff", "validate input before call"],
      confidenceScore: 0.6,
      shouldEvolve: false,
    };
  }

  it("蒸馏出策略时广播 knowledge.improvement_found（断点1触发源）", async () => {
    const distiller = new ExperienceDistiller(registry, eventBus, {
      minTrajectoriesForDistillation: 2,
    });

    await distiller.addTrajectory(trace("t1", "transient"), reflection("transient"));
    await distiller.addTrajectory(trace("t2", "transient"), reflection("transient"));

    const knowledgeEvents = published.filter((e) => e.type === "knowledge.improvement_found");
    expect(knowledgeEvents).toHaveLength(1);
    const data = knowledgeEvents[0].data as Record<string, unknown>;
    expect(data.source).toBe("experience-distiller");
    expect(data.triggerEvolution).toBe(true);
    expect(typeof data.recommendedAction).toBe("string");
    expect((data.recommendedAction as string).length).toBeGreaterThan(0);

    // 同时保留原有的 strategy_distilled 事件
    const strategyEvents = published.filter((e) => e.type === "evolution.strategy_distilled");
    expect(strategyEvents).toHaveLength(1);
  });

  it("轨迹不足时不触发蒸馏", async () => {
    const distiller = new ExperienceDistiller(registry, eventBus, {
      minTrajectoriesForDistillation: 3,
    });

    await distiller.addTrajectory(trace("t1", "transient"), reflection("transient"));

    expect(published.filter((e) => e.type === "knowledge.improvement_found")).toHaveLength(0);
  });
});
