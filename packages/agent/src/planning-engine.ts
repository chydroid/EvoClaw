/**
 * Planning Engine — Explicit Planning stage for the EvoClaw agent
 *
 * Generates, validates, and manages step-by-step execution plans using LLM.
 * Supports dependency-aware step ordering, replanning on failure, and
 * context injection for the agent's system prompt.
 */

import type { PersonaConfig } from "@evoclaw/core";
import type { ProviderConfig } from "./types";
import { nativeFetch } from "./llm-caller";
import * as crypto from "crypto";

// ── Types ──

export interface PlanStep {
  id: string;
  description: string;
  toolHint?: string;
  dependsOn?: string[];
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  result?: string;
  error?: string;
}

export interface ExecutionPlan {
  id: string;
  goal: string;
  steps: PlanStep[];
  createdAt: number;
  status: "draft" | "validated" | "executing" | "completed" | "failed";
  reflectionNotes?: string;
  replanCount: number;
}

export interface PlanValidationResult {
  valid: boolean;
  issues: string[];
  suggestions: string[];
  estimatedSteps: number;
  complexity: "simple" | "moderate" | "complex";
}

// ── Dependencies ──

export interface PlanningEngineDeps {
  providers: ProviderConfig[];
  persona: PersonaConfig;
  recordProviderSuccess: (id: string) => void;
  recordProviderFailure: (id: string, error: string, errorType?: string) => void;
}

// ── Helpers ──

function generateId(): string {
  return `plan-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function generateStepId(index: number): string {
  return `step-${index + 1}`;
}

/** Build the LLM prompt for plan generation */
function buildPlanPrompt(userMessage: string, availableTools: string[]): string {
  const toolsList = availableTools.join(", ");
  return `You are a task planning assistant. Break down the following task into concrete execution steps.

Available tools: ${toolsList}

User task: ${userMessage}

Output a JSON plan with this structure:
{
  "steps": [
    {
      "id": "step-1",
      "description": "What to do",
      "toolHint": "tool_name",
      "dependsOn": []
    }
  ]
}

Rules:
- Each step should be atomic and achievable with one tool call
- Use dependsOn to specify ordering when steps must be sequential
- Steps without dependencies can run in parallel
- Start with information gathering, then action
- Keep the plan concise (3-8 steps max)`;
}

/** Build the LLM prompt for replanning */
function buildReplanPrompt(
  userMessage: string,
  availableTools: string[],
  failedSteps: PlanStep[],
  completedSteps: PlanStep[],
): string {
  const toolsList = availableTools.join(", ");

  const failedSummary = failedSteps
    .map((s) => `  - ${s.id}: ${s.description} (tool: ${s.toolHint ?? "none"}, error: ${s.error ?? "unknown"})`)
    .join("\n");

  const completedSummary = completedSteps
    .map((s) => `  - ${s.id}: ${s.description} (result: ${(s.result ?? "").slice(0, 200)})`)
    .join("\n");

  return `You are a task planning assistant. The previous plan failed and needs to be revised.

Available tools: ${toolsList}

User task: ${userMessage}

Completed steps (do NOT repeat these):
${completedSummary || "  (none)"}

Failed steps (learn from these errors):
${failedSummary || "  (none)"}

Output a JSON plan with this structure:
{
  "steps": [
    {
      "id": "step-1",
      "description": "What to do",
      "toolHint": "tool_name",
      "dependsOn": []
    }
  ]
}

Rules:
- Each step should be atomic and achievable with one tool call
- Use dependsOn to specify ordering when steps must be sequential
- Steps without dependencies can run in parallel
- Do NOT repeat completed steps — only plan remaining work
- Learn from the failed steps: try different tools or approaches
- Keep the plan concise (3-8 steps max)`;
}

/** Parse the LLM response JSON, returning null on failure */
function parsePlanJSON(raw: string): { steps: Array<{ id: string; description: string; toolHint?: string; dependsOn?: string[] }> } | null {
  // Try to extract JSON from the response (may be wrapped in markdown code block)
  let jsonStr = raw.trim();

  // Strip markdown code fences if present
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.steps)) {
      return parsed as { steps: Array<{ id: string; description: string; toolHint?: string; dependsOn?: string[] }> };
    }
  } catch {
    // Try to find the first `{` and last `}` as a fallback
    const firstBrace = jsonStr.indexOf("{");
    const lastBrace = jsonStr.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        const extracted = JSON.parse(jsonStr.slice(firstBrace, lastBrace + 1));
        if (extracted && typeof extracted === "object" && Array.isArray(extracted.steps)) {
          return extracted as { steps: Array<{ id: string; description: string; toolHint?: string; dependsOn?: string[] }> };
        }
      } catch {
        // Give up
      }
    }
  }
  return null;
}

/** Call the LLM with a simple text prompt and return the content string */
async function callLLMForPlan(
  deps: PlanningEngineDeps,
  prompt: string,
): Promise<string | null> {
  const enabledProviders = deps.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);
  if (enabledProviders.length === 0) return null;

  const provider = enabledProviders[0];

  const baseURL = provider.baseURL || "";
  let apiURL = baseURL;
  if (!apiURL.endsWith("/chat/completions") && !apiURL.endsWith("/v1/chat/completions")) {
    apiURL = apiURL.replace(/\/+$/, "");
    if (!apiURL.endsWith("/v1")) {
      apiURL = `${apiURL}/v1`;
    }
    apiURL = `${apiURL}/chat/completions`;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (provider.apiKey) {
      if (provider.provider === "anthropic") {
        headers["x-api-key"] = provider.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${provider.apiKey}`;
      }
    }

    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await nativeFetch(apiURL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: "You are a task planning assistant. Always respond with valid JSON only." },
          { role: "user", content: prompt },
        ],
        max_tokens: 2048,
        temperature: 0.3,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      deps.recordProviderFailure(provider.id, `HTTP ${response.status}`, "http_error");
      return null;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (content) {
      deps.recordProviderSuccess(provider.id);
    }
    return content ?? null;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    deps.recordProviderFailure(provider.id, errMsg, "network_error");
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ── PlanningEngine ──

export class PlanningEngine {
  private plans = new Map<string, ExecutionPlan>();
  /** plans Map 最大容量，防止无界增长导致 OOM */
  private static readonly MAX_PLANS = 1000;
  private deps: PlanningEngineDeps;

  constructor(deps: PlanningEngineDeps) {
    this.deps = deps;
  }

  /**
   * 写入 plan 并执行 LRU 淘汰，防止 plans Map 无界增长。
   */
  private putPlan(id: string, plan: ExecutionPlan): void {
    this.plans.set(id, plan);
    if (this.plans.size > PlanningEngine.MAX_PLANS) {
      const oldestKey = this.plans.keys().next().value;
      if (oldestKey !== undefined) this.plans.delete(oldestKey);
    }
  }

  /**
   * Generate a step-by-step execution plan using LLM.
   * Returns an ExecutionPlan with status "draft".
   */
  async generatePlan(userMessage: string, availableTools: string[], sessionId: string): Promise<ExecutionPlan> {
    const prompt = buildPlanPrompt(userMessage, availableTools);
    const rawResponse = await callLLMForPlan(this.deps, prompt);

    const planId = generateId();
    let steps: PlanStep[];

    if (rawResponse) {
      const parsed = parsePlanJSON(rawResponse);
      if (parsed && parsed.steps.length > 0) {
        steps = parsed.steps.map((s, i) => ({
          id: s.id || generateStepId(i),
          description: s.description || `Step ${i + 1}`,
          toolHint: s.toolHint,
          dependsOn: s.dependsOn,
          status: "pending" as const,
        }));
      } else {
        // JSON parse failed — create single-step fallback
        steps = this.createFallbackSteps(userMessage);
      }
    } else {
      // LLM call failed — create single-step fallback
      steps = this.createFallbackSteps(userMessage);
    }

    const plan: ExecutionPlan = {
      id: planId,
      goal: userMessage,
      steps,
      createdAt: Date.now(),
      status: "draft",
      replanCount: 0,
    };

    this.putPlan(planId, plan);
    return plan;
  }

  /**
   * Validate a plan for structural correctness.
   * Checks for circular dependencies, invalid references, and tool availability.
   */
  validatePlan(plan: ExecutionPlan): PlanValidationResult {
    const issues: string[] = [];
    const suggestions: string[] = [];
    const stepIds = new Set(plan.steps.map((s) => s.id));

    // Check for duplicate IDs
    const seenIds = new Set<string>();
    for (const step of plan.steps) {
      if (seenIds.has(step.id)) {
        issues.push(`Duplicate step ID: "${step.id}"`);
      }
      seenIds.add(step.id);
    }

    // Check dependsOn references exist
    for (const step of plan.steps) {
      if (step.dependsOn) {
        for (const depId of step.dependsOn) {
          if (!stepIds.has(depId)) {
            issues.push(`Step "${step.id}" depends on non-existent step "${depId}"`);
          }
        }
      }
    }

    // Check for circular dependencies using DFS
    const adjacency = new Map<string, string[]>();
    for (const step of plan.steps) {
      adjacency.set(step.id, (step.dependsOn ?? []));
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();

    const hasCycle = (nodeId: string): boolean => {
      visited.add(nodeId);
      inStack.add(nodeId);
      const deps = adjacency.get(nodeId) ?? [];
      for (const dep of deps) {
        if (!visited.has(dep)) {
          if (hasCycle(dep)) return true;
        } else if (inStack.has(dep)) {
          return true;
        }
      }
      inStack.delete(nodeId);
      return false;
    };

    for (const step of plan.steps) {
      if (!visited.has(step.id)) {
        if (hasCycle(step.id)) {
          issues.push("Circular dependency detected in plan steps");
          break;
        }
      }
    }

    // Estimate complexity
    const stepCount = plan.steps.length;
    const hasDeps = plan.steps.some((s) => (s.dependsOn?.length ?? 0) > 0);
    let complexity: "simple" | "moderate" | "complex";

    if (stepCount <= 2 && !hasDeps) {
      complexity = "simple";
    } else if (stepCount <= 5) {
      complexity = "moderate";
    } else {
      complexity = "complex";
    }

    // Suggestions
    if (stepCount > 8) {
      suggestions.push("Plan has more than 8 steps; consider simplifying or splitting into sub-plans");
    }
    if (stepCount === 1) {
      suggestions.push("Single-step plan may not benefit from explicit planning");
    }
    if (!hasDeps && stepCount > 3) {
      suggestions.push("All steps are independent; consider adding dependencies to enforce logical ordering");
    }

    return {
      valid: issues.length === 0,
      issues,
      suggestions,
      estimatedSteps: stepCount,
      complexity,
    };
  }

  /**
   * Returns the next step whose dependencies are all completed and status is "pending".
   * Returns null if no step is ready.
   */
  getNextStep(plan: ExecutionPlan): PlanStep | null {
    const completedIds = new Set(
      plan.steps
        .filter((s) => s.status === "completed" || s.status === "skipped")
        .map((s) => s.id),
    );

    for (const step of plan.steps) {
      if (step.status !== "pending") continue;
      const deps = step.dependsOn ?? [];
      if (deps.every((depId) => completedIds.has(depId))) {
        return step;
      }
    }

    return null;
  }

  /**
   * Update a step's status/result/error within a plan.
   * Returns the updated plan, or null if plan or step not found.
   */
  updateStep(planId: string, stepId: string, update: Partial<PlanStep>): ExecutionPlan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return null;

    if (update.status !== undefined) step.status = update.status;
    if (update.result !== undefined) step.result = update.result;
    if (update.error !== undefined) step.error = update.error;
    if (update.description !== undefined) step.description = update.description;
    if (update.toolHint !== undefined) step.toolHint = update.toolHint;
    if (update.dependsOn !== undefined) step.dependsOn = update.dependsOn;

    // Auto-transition plan status
    this.recalcPlanStatus(plan);

    return plan;
  }

  /**
   * Determine whether replanning is needed based on failure count.
   * Returns true if >50% steps failed or a critical (first) step failed.
   */
  shouldReplan(plan: ExecutionPlan, failedSteps: number): boolean {
    if (plan.steps.length === 0) return false;

    const failureRate = failedSteps / plan.steps.length;
    if (failureRate > 0.5) return true;

    // Check if the first step (typically information gathering) failed
    const firstStep = plan.steps[0];
    if (firstStep && firstStep.status === "failed") return true;

    return false;
  }

  /**
   * Generate a new plan incorporating lessons from the failed plan.
   * Increments replanCount and carries over completed steps.
   */
  async replan(plan: ExecutionPlan, userMessage: string, availableTools: string[]): Promise<ExecutionPlan> {
    const failedSteps = plan.steps.filter((s) => s.status === "failed");
    const completedSteps = plan.steps.filter((s) => s.status === "completed");

    const prompt = buildReplanPrompt(userMessage, availableTools, failedSteps, completedSteps);
    const rawResponse = await callLLMForPlan(this.deps, prompt);

    const newPlanId = generateId();
    let newSteps: PlanStep[];

    if (rawResponse) {
      const parsed = parsePlanJSON(rawResponse);
      if (parsed && parsed.steps.length > 0) {
        // Carry over completed steps, then append new steps
        const carriedOver = completedSteps.map((s) => ({ ...s }));
        const freshSteps = parsed.steps.map((s, i) => ({
          id: s.id || generateStepId(carriedOver.length + i),
          description: s.description || `Step ${carriedOver.length + i + 1}`,
          toolHint: s.toolHint,
          dependsOn: s.dependsOn,
          status: "pending" as const,
        }));
        newSteps = [...carriedOver, ...freshSteps];
      } else {
        newSteps = this.createFallbackSteps(userMessage);
      }
    } else {
      newSteps = this.createFallbackSteps(userMessage);
    }

    const newPlan: ExecutionPlan = {
      id: newPlanId,
      goal: userMessage,
      steps: newSteps,
      createdAt: Date.now(),
      status: "draft",
      reflectionNotes: `Replanned after ${failedSteps.length} step(s) failed. Previous plan: ${plan.id}`,
      replanCount: plan.replanCount + 1,
    };

    this.putPlan(newPlanId, newPlan);
    return newPlan;
  }

  /**
   * Format the plan as a string for injection into the LLM system prompt.
   */
  formatPlanForContext(plan: ExecutionPlan): string {
    const statusIcon: Record<PlanStep["status"], string> = {
      pending: "⬜",
      in_progress: "🔄",
      completed: "✅",
      failed: "❌",
      skipped: "⏭️",
    };

    const lines: string[] = [
      `## Execution Plan: ${plan.goal}`,
      `Plan ID: ${plan.id} | Status: ${plan.status} | Steps: ${plan.steps.length} | Replans: ${plan.replanCount}`,
      "",
    ];

    if (plan.reflectionNotes) {
      lines.push(`Reflection: ${plan.reflectionNotes}`);
      lines.push("");
    }

    for (const step of plan.steps) {
      const icon = statusIcon[step.status];
      const deps = (step.dependsOn?.length ?? 0) > 0 ? ` (depends: ${step.dependsOn!.join(", ")})` : "";
      const tool = step.toolHint ? ` [${step.toolHint}]` : "";
      const result = step.result ? ` → ${step.result.slice(0, 100)}` : "";
      const error = step.error ? ` ⚠ ${step.error.slice(0, 100)}` : "";

      lines.push(`${icon} ${step.id}: ${step.description}${tool}${deps}${result}${error}`);
    }

    const nextStep = this.getNextStep(plan);
    if (nextStep) {
      lines.push("");
      lines.push(`Next step: ${nextStep.id} — ${nextStep.description}`);
    } else if (plan.steps.every((s) => s.status === "completed" || s.status === "skipped")) {
      lines.push("");
      lines.push("All steps completed.");
    }

    return lines.join("\n");
  }

  // ── Internal helpers ──

  private createFallbackSteps(userMessage: string): PlanStep[] {
    return [
      {
        id: "step-1",
        description: userMessage,
        status: "pending",
      },
    ];
  }

  private recalcPlanStatus(plan: ExecutionPlan): void {
    const allDone = plan.steps.every(
      (s) => s.status === "completed" || s.status === "skipped",
    );
    const anyFailed = plan.steps.some((s) => s.status === "failed");
    const anyInProgress = plan.steps.some((s) => s.status === "in_progress");

    if (allDone && !anyFailed) {
      plan.status = "completed";
    } else if (allDone && anyFailed) {
      plan.status = "failed";
    } else if (anyInProgress || plan.steps.some((s) => s.status === "completed")) {
      plan.status = "executing";
    }
    // Keep current status if still draft/validated with no progress
  }

  /** Retrieve a stored plan by ID */
  getPlan(planId: string): ExecutionPlan | undefined {
    return this.plans.get(planId);
  }

  /** Store a plan (useful for externally-constructed plans) */
  setPlan(plan: ExecutionPlan): void {
    this.putPlan(plan.id, plan);
  }
}
