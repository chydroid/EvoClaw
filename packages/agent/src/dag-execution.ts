/**
 * DAG execution methods extracted from AgentModelExecutor.
 *
 * Standalone functions for DAG node execution, skill execution,
 * reasoning generation, tool parameter extraction, default output
 * generation, and keyword extraction.
 */

import type { ServiceRegistry, EventBus, DAGNode, Skill, SkillExecutionResult } from "@evoclaw/core";
import type { ModelConfig, ProviderConfig, AgentExecutionResult, ToolDefinition } from "./types";

// ── Dependencies interface ──

export interface DAGExecutionDeps {
  registeredTools: Map<string, { definition: ToolDefinition; handler: (params: Record<string, unknown>) => Promise<unknown> }>;
  config: ModelConfig;
  providers: ProviderConfig[];
  eventBus: EventBus;
  registry: ServiceRegistry;
  estimateTokenCount: (text: string) => number;
}

// ── Standalone functions ──

/**
 * Execute a DAG node with tool calls.
 */
export async function execute(
  deps: DAGExecutionDeps,
  prompt: string,
  node: DAGNode,
  options?: {
    tools?: string[];
    context?: Record<string, unknown>;
    modelOverride?: Partial<ModelConfig>;
  }
): Promise<AgentExecutionResult> {
  const startTime = Date.now();
  const mergedConfig = { ...deps.config, ...options?.modelOverride };

  try {
    const enabledTools = options?.tools
      ? options.tools
          .filter((name) => deps.registeredTools.has(name))
          .map((name) => deps.registeredTools.get(name)!)
      : [];

    const reasoning = generateReasoning(mergedConfig, prompt, node, options?.context);
    const toolCalls: Array<{ name: string; result: unknown }> = [];

    let output: unknown = null;

    for (const tool of enabledTools) {
      try {
        const toolParams = extractToolParams(prompt, tool.definition);

        const toolResult = await tool.handler(toolParams);
        toolCalls.push({ name: tool.definition.name, result: toolResult });
        output = toolResult;
      } catch (err) {
        process.stderr.write(
          `[DAGExecution] Tool "${tool.definition.name}" failed:` + " " + (err instanceof Error ? err.message : String(err)) + "\n"
        );
      }
    }

    if (toolCalls.length === 0 && enabledTools.length > 0) {
      const allErrors = enabledTools.map((t) => `"${t.definition.name}": execution failed`)
        .join("; ");
      const result: AgentExecutionResult = {
        success: false,
        output: null,
        reasoning,
        tokensUsed: deps.estimateTokenCount(prompt + reasoning),
        duration: Date.now() - startTime,
        toolCalls: [],
        error: `All tools failed to execute — ${allErrors}. Please check tool configurations and retry.`,
      };
      return result;
    }

    if (output === null) {
      output = generateDefaultOutput(mergedConfig, prompt, reasoning);
    }

    const duration = Date.now() - startTime;

    const result: AgentExecutionResult = {
      success: true,
      output,
      reasoning,
      tokensUsed: deps.estimateTokenCount(prompt + reasoning),
      duration,
      toolCalls,
    };

    await deps.eventBus?.publish(
      "agent.execution_complete",
      { nodeId: node.id, success: true, duration },
      "agent-model-executor"
    );

    return result;
  } catch (err) {
    const duration = Date.now() - startTime;

    const result: AgentExecutionResult = {
      success: false,
      output: null,
      reasoning: "",
      tokensUsed: 0,
      duration,
      toolCalls: [],
      error: err instanceof Error ? err.message : String(err),
    };

    await deps.eventBus?.publish(
      "agent.execution_failed",
      { nodeId: node.id, error: result.error },
      "agent-model-executor"
    );

    return result;
  }
}

/**
 * Execute a skill directly via sandbox or skillManager.
 */
export async function executeSkillDirectly(
  deps: DAGExecutionDeps,
  skill: Skill,
  params: Record<string, unknown>
): Promise<AgentExecutionResult> {
  const startTime = Date.now();

  try {
    const sandbox = deps.registry.resolveService<{
      execute: (skill: Skill, params: Record<string, unknown>) => Promise<SkillExecutionResult>;
    }>("skillSandbox");

    if (sandbox) {
      const result = await sandbox.execute(skill, params);

      return {
        success: result.success,
        output: result.output,
        reasoning: `Skill "${skill.name}" executed via sandbox`,
        tokensUsed: 0,
        duration: Date.now() - startTime,
        toolCalls: [{ name: skill.name, result: result.output }],
        error: result.errors?.[0],
      };
    }

    const skillManager = deps.registry.resolveService<{
      executeSkill: (skillId: string, params: Record<string, unknown>) => Promise<SkillExecutionResult>;
    }>("skillManager");

    if (skillManager) {
      const result = await skillManager.executeSkill(skill.id, params);

      return {
        success: result.success,
        output: result.output,
        reasoning: `Skill "${skill.name}" executed via skillManager`,
        tokensUsed: 0,
        duration: Date.now() - startTime,
        toolCalls: [{ name: skill.name, result: result.output }],
        error: result.errors?.[0],
      };
    }

    return {
      success: false,
      output: null,
      reasoning: "",
      tokensUsed: 0,
      duration: Date.now() - startTime,
      toolCalls: [],
      error: "No skill executor available",
    };
  } catch (err) {
    return {
      success: false,
      output: null,
      reasoning: "",
      tokensUsed: 0,
      duration: Date.now() - startTime,
      toolCalls: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Generate reasoning text for DAG execution.
 */
export function generateReasoning(
  config: ModelConfig,
  prompt: string,
  node: DAGNode,
  context?: Record<string, unknown>
): string {
  const parts: string[] = [
    `Agent executing DAG node "${node.id}" (${node.action})`,
  ];

  if (context) {
    const contextKeys = Object.keys(context);
    if (contextKeys.length > 0) {
      parts.push(`Context: ${contextKeys.join(", ")}`);
    }
  }

  const keywords = extractKeywords(prompt);
  if (keywords.length > 0) {
    parts.push(`Detected keywords: ${keywords.join(", ")}`);
  }

  parts.push(`Model: ${config.model}`);
  parts.push(`Node timeout: ${node.timeout}ms`);

  return parts.join("\n");
}

/**
 * Extract tool parameters from prompt and tool definition.
 */
export function extractToolParams(
  prompt: string,
  definition: ToolDefinition
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    prompt,
    toolName: definition.name,
    timestamp: Date.now(),
  };

  for (const [key, paramDef] of Object.entries(definition.parameters)) {
    const paramInfo = paramDef as Record<string, unknown>;
    const type = paramInfo.type as string;

    if (type === "string") {
      const defaultValue = paramInfo.default as string | undefined;
      params[key] = defaultValue || "";
    } else if (type === "number") {
      params[key] = paramInfo.default as number || 0;
    } else if (type === "boolean") {
      params[key] = paramInfo.default || false;
    }
  }

  return params;
}

/**
 * Generate default output when no tool results are available.
 */
export function generateDefaultOutput(
  config: ModelConfig,
  prompt: string,
  reasoning: string
): unknown {
  return {
    prompt,
    reasoning,
    model: config.model,
    provider: config.provider,
    timestamp: new Date().toISOString(),
    actions: ["parse_input", "analyze_intent", "plan_execution"],
  };
}

/**
 * Extract keywords from text by frequency, excluding stop words.
 */
export function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been",
    "in", "on", "at", "to", "for", "of", "with", "by", "from",
    "and", "or", "but", "not", "this", "that", "it", "if", "then",
    "the", "i", "you", "he", "she", "we", "they",
  ]);

  const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 2);

  const frequencies = new Map<string, number>();
  for (const word of words) {
    if (stopWords.has(word)) continue;
    frequencies.set(word, (frequencies.get(word) || 0) + 1);
  }

  return Array.from(frequencies.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}
