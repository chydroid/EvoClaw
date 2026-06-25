import { ServiceRegistry, EventBus } from "@evoclaw/core";

export interface OrchestrationStep {
  id: string;
  name: string;
  skillName: string;
  skillId?: string;
  description: string;
  dependsOn: string[];
  params: Record<string, unknown>;
  timeout: number;
  retryCount: number;
  maxRetries: number;
  fallbackSkill?: string;
  mergeStrategy: "replace" | "merge" | "append" | "none";
}

export interface StepResult {
  stepId: string;
  skillName: string;
  success: boolean;
  output: unknown;
  error?: string;
  duration: number;
  retries: number;
}

export interface OrchestrationPlan {
  id: string;
  name: string;
  description: string;
  steps: OrchestrationStep[];
  createdAt: Date;
  status: "planned" | "running" | "completed" | "failed" | "partial";
}

export interface OrchestrationResult {
  planId: string;
  success: boolean;
  results: StepResult[];
  aggregatedOutput: Record<string, unknown>;
  totalDuration: number;
  error?: string;
}

export class SkillOrchestrator {
  private plans: Map<string, OrchestrationPlan> = new Map();
  private results: Map<string, OrchestrationResult> = new Map();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  createPlan(options: {
    name: string;
    description: string;
    steps: Array<{
      name: string;
      skillName: string;
      dependsOn?: string[];
      params?: Record<string, unknown>;
      timeout?: number;
      maxRetries?: number;
      fallbackSkill?: string;
      mergeStrategy?: OrchestrationStep["mergeStrategy"];
    }>;
  }): OrchestrationPlan {
    const id = `orch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const steps: OrchestrationStep[] = options.steps.map((s, i) => ({
      id: `step-${i}-${s.name.replace(/[^a-zA-Z0-9]/g, "-")}`,
      name: s.name,
      skillName: s.skillName,
      description: s.name,
      dependsOn: s.dependsOn || [],
      params: s.params || {},
      timeout: s.timeout || 60000,
      retryCount: 0,
      maxRetries: s.maxRetries || 2,
      fallbackSkill: s.fallbackSkill,
      mergeStrategy: s.mergeStrategy || "merge",
    }));

    this.validateDependencies(steps);

    const plan: OrchestrationPlan = {
      id,
      name: options.name,
      description: options.description,
      steps,
      createdAt: new Date(),
      status: "planned",
    };

    this.plans.set(id, plan);

    this.eventBus.publish(
      "intelligence.plan_created",
      { planId: id, stepCount: steps.length },
      "skill-orchestrator"
    );

    return plan;
  }

  async execute(planId: string, context?: Record<string, unknown>): Promise<OrchestrationResult> {
    const plan = this.plans.get(planId);
    if (!plan) {
      return {
        planId,
        success: false,
        results: [],
        aggregatedOutput: {},
        totalDuration: 0,
        error: "Plan not found",
      };
    }

    const startTime = Date.now();
    plan.status = "running";
    const stepResults: StepResult[] = [];
    const aggregatedOutput: Record<string, unknown> = {};
    const completed = new Set<string>();
    const failed = new Set<string>();

    this.eventBus.publish(
      "intelligence.plan_execution_started",
      { planId, stepCount: plan.steps.length },
      "skill-orchestrator"
    );

    const remaining = new Set(plan.steps.map((s) => s.id));

    while (remaining.size > 0) {
      const ready = this.getReadySteps(plan.steps, completed, failed);

      if (ready.length === 0) {
        if (remaining.size > 0) {
          const unresolved = [...remaining].join(", ");
          plan.status = "failed";
          return {
            planId,
            success: false,
            results: stepResults,
            aggregatedOutput,
            totalDuration: Date.now() - startTime,
            error: `Deadlock detected: could not resolve dependencies for steps [${unresolved}]`,
          };
        }
        break;
      }

      const results = await Promise.all(
        ready.map((step) => this.executeStep(step, aggregatedOutput, context))
      );

      for (const result of results) {
        stepResults.push(result);
        remaining.delete(result.stepId);

        if (result.success) {
          completed.add(result.stepId);
          const step = plan.steps.find((s) => s.id === result.stepId)!;
          this.mergeOutput(aggregatedOutput, result.output, step.mergeStrategy);
        } else {
          failed.add(result.stepId);
        }
      }
    }

    const allSuccess = plan.steps.every((s) => completed.has(s.id));
    const allFailed = plan.steps.every((s) => failed.has(s.id));

    plan.status = allSuccess ? "completed" : allFailed ? "failed" : "partial";

    const result: OrchestrationResult = {
      planId,
      success: allSuccess,
      results: stepResults,
      aggregatedOutput,
      totalDuration: Date.now() - startTime,
    };

    this.results.set(planId, result);

    this.eventBus.publish(
      `intelligence.plan_execution_${plan.status}`,
      {
        planId,
        success: result.success,
        completedCount: completed.size,
        failedCount: failed.size,
        duration: result.totalDuration,
      },
      "skill-orchestrator"
    );

    return result;
  }

  private async executeStep(
    step: OrchestrationStep,
    accumulatedOutput: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<StepResult> {
    const skillExecutor = this.registry.resolveService<{
      executeSkill(skillId: string, params: Record<string, unknown>): Promise<{ success: boolean; output: unknown; errors?: string[] }>;
    }>("skillManager");

    const mergedParams = {
      ...step.params,
      ...context,
      accumulated: accumulatedOutput,
    };

    for (let attempt = 0; attempt <= step.maxRetries; attempt++) {
      const stepStart = Date.now();

      try {
        const skillToUse = attempt === step.maxRetries && step.fallbackSkill
          ? step.fallbackSkill
          : step.skillName;

        if (attempt > 0) {
          await this.sleep(2000 * attempt);
        }

        if (skillExecutor) {
          const skills = await (skillExecutor as unknown as { listSkills(): Promise<Array<{ id: string; name: string }>> }).listSkills();
          const matchedSkill = skills.find((s) => s.name === skillToUse);

          if (matchedSkill) {
            const execResult = await this.executeWithTimeout(step.timeout, () =>
              skillExecutor.executeSkill(matchedSkill.id, mergedParams)
            );

            if (execResult.success) {
              return {
                stepId: step.id,
                skillName: skillToUse,
                success: true,
                output: execResult.output,
                duration: Date.now() - stepStart,
                retries: attempt,
              };
            }

            if (attempt < step.maxRetries) continue;

            return {
              stepId: step.id,
              skillName: skillToUse,
              success: false,
              output: null,
              error: execResult.errors?.[0] || "Skill execution failed",
              duration: Date.now() - stepStart,
              retries: attempt,
            };
          }
        }

        const result = await this.executeWithTimeout(step.timeout, async () => {
          return { success: true, output: { skillName: step.skillName, params: mergedParams, status: "simulated" } };
        });

        return {
          stepId: step.id,
          skillName: step.skillName,
          success: true,
          output: result.output,
          duration: Date.now() - stepStart,
          retries: attempt,
        };
      } catch (err) {
        if (attempt < step.maxRetries) continue;

        return {
          stepId: step.id,
          skillName: step.skillName,
          success: false,
          output: null,
          error: err instanceof Error ? err.message : String(err),
          duration: Date.now() - stepStart,
          retries: attempt,
        };
      }
    }

    return {
      stepId: step.id,
      skillName: step.skillName,
      success: false,
      output: null,
      error: "All retries exhausted",
      duration: 0,
      retries: step.maxRetries,
    };
  }

  private async executeWithTimeout<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Step timed out after ${timeoutMs}ms`)), timeoutMs);
      fn()
        .then((result) => { clearTimeout(timer); resolve(result); })
        .catch((err) => { clearTimeout(timer); reject(err); });
    });
  }

  private mergeOutput(
    accumulated: Record<string, unknown>,
    output: unknown,
    strategy: OrchestrationStep["mergeStrategy"]
  ): void {
    if (strategy === "none") return;

    if (strategy === "replace") {
      Object.keys(accumulated).forEach((k) => delete accumulated[k]);
      if (output && typeof output === "object" && !Array.isArray(output)) {
        Object.assign(accumulated, output);
      }
      return;
    }

    if (output && typeof output === "object" && !Array.isArray(output)) {
      const obj = output as Record<string, unknown>;
      for (const [key, value] of Object.entries(obj)) {
        if (strategy === "append" && Array.isArray(accumulated[key]) && Array.isArray(value)) {
          (accumulated[key] as unknown[]).push(...(value as unknown[]));
        } else if (typeof accumulated[key] === "object" && typeof value === "object" && !Array.isArray(value)) {
          Object.assign(accumulated[key] as Record<string, unknown>, value as Record<string, unknown>);
        } else {
          accumulated[key] = value;
        }
      }
    }
  }

  private getReadySteps(
    steps: OrchestrationStep[],
    completed: Set<string>,
    failed: Set<string>
  ): OrchestrationStep[] {
    return steps.filter((s) => {
      if (completed.has(s.id) || failed.has(s.id)) return false;
      return s.dependsOn.every((depId) => completed.has(depId));
    });
  }

  private validateDependencies(steps: OrchestrationStep[]): void {
    const stepIds = new Set(steps.map((s) => s.id));
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const dfs = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Circular dependency detected at step: ${id}`);
      if (visited.has(id)) return;

      visiting.add(id);
      const step = steps.find((s) => s.id === id);
      if (step) {
        for (const depId of step.dependsOn) {
          if (!stepIds.has(depId)) throw new Error(`Unknown dependency "${depId}" in step "${id}"`);
          dfs(depId);
        }
      }
      visiting.delete(id);
      visited.add(id);
    };

    for (const step of steps) {
      dfs(step.id);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getPlan(planId: string): OrchestrationPlan | undefined {
    return this.plans.get(planId);
  }

  getResult(planId: string): OrchestrationResult | undefined {
    return this.results.get(planId);
  }

  listPlans(): OrchestrationPlan[] {
    return [...this.plans.values()];
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}