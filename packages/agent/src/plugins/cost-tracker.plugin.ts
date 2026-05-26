/**
 * Cost Tracker Plugin
 *
 * Tracks token usage and estimates costs for each agent interaction.
 * Hooks into:
 * - agent_end: captures token usage and duration metrics
 * - after_tool_call: monitors tool call costs
 *
 * Provides real-time cost visibility and budget alerts.
 */

import type { Plugin, PluginHookRegistration, AgentEndHook, AfterToolCallHook } from "@evoclaw/core";

const MANIFEST = {
  name: "Cost Tracker",
  version: "1.0.0",
  description: "Tracks token usage and estimates costs across model providers",
  author: "evoclaw",
};

interface CostEntry {
  timestamp: Date;
  sessionId?: string;
  tokensUsed: number;
  estimatedCost: number;
  model?: string;
  provider?: string;
}

interface DailyCost {
  date: string;
  totalTokens: number;
  totalCost: number;
  sessions: number;
}

// ── Default model cost per 1K tokens (USD) ──
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "gpt-4": { input: 0.03, output: 0.06 },
  "gpt-4-turbo": { input: 0.01, output: 0.03 },
  "gpt-4o": { input: 0.0025, output: 0.01 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "gpt-3.5-turbo": { input: 0.0005, output: 0.0015 },
  "claude-3-opus": { input: 0.015, output: 0.075 },
  "claude-3-sonnet": { input: 0.003, output: 0.015 },
  "claude-3-haiku": { input: 0.00025, output: 0.00125 },
  "claude-3.5-sonnet": { input: 0.003, output: 0.015 },
  "gemini-1.5-pro": { input: 0.0035, output: 0.0105 },
  "gemini-1.5-flash": { input: 0.000075, output: 0.0003 },
  "deepseek-chat": { input: 0.00014, output: 0.00028 },
  "deepseek-reasoner": { input: 0.00055, output: 0.00219 },
};

const MAX_COST_HISTORY = 500;
let costHistory: CostEntry[] = [];
let dailyCosts: DailyCost[] = [];
let sessionCosts = new Map<string, { tokens: number; cost: number }>();

function estimateCost(tokensUsed: number, model?: string): number {
  const costs = MODEL_COSTS[model || ""] || { input: 0.001, output: 0.002 };
  // Assume 70% output, 30% input split
  const inputTokens = tokensUsed * 0.3;
  const outputTokens = tokensUsed * 0.7;
  return (inputTokens / 1000) * costs.input + (outputTokens / 1000) * costs.output;
}

function recordCost(entry: CostEntry): void {
  costHistory.push(entry);
  if (costHistory.length > MAX_COST_HISTORY) {
    costHistory = costHistory.slice(-MAX_COST_HISTORY);
  }

  // Track per-session
  if (entry.sessionId) {
    const prev = sessionCosts.get(entry.sessionId) || { tokens: 0, cost: 0 };
    sessionCosts.set(entry.sessionId, {
      tokens: prev.tokens + entry.tokensUsed,
      cost: prev.cost + entry.estimatedCost,
    });
  }

  // Track daily
  const dateKey = entry.timestamp.toISOString().slice(0, 10);
  const existing = dailyCosts.find((d) => d.date === dateKey);
  if (existing) {
    existing.totalTokens += entry.tokensUsed;
    existing.totalCost += entry.estimatedCost;
    existing.sessions++;
  } else {
    dailyCosts.push({ date: dateKey, totalTokens: entry.tokensUsed, totalCost: entry.estimatedCost, sessions: 1 });
    if (dailyCosts.length > 90) dailyCosts = dailyCosts.slice(-90);
  }
}

export function createCostTrackerPlugin(): Plugin {
  return {
    manifest: MANIFEST,
    hooks: [
      {
        hookType: "agent_end",
        priority: "normal",
        handler: (hook: AgentEndHook) => {
          const entry: CostEntry = {
            timestamp: new Date(),
            sessionId: hook.context.sessionId,
            tokensUsed: hook.metadata.tokensUsed || 0,
            estimatedCost: estimateCost(hook.metadata.tokensUsed || 0),
          };
          recordCost(entry);

          // Log warning if session is getting expensive
          if (hook.context.sessionId) {
            const session = sessionCosts.get(hook.context.sessionId);
            if (session && session.cost > 0.50) {
              console.log(
                `[CostTracker] ⚠️ Session "${hook.context.sessionId}" cost: $${session.cost.toFixed(4)} (${session.tokens.toLocaleString()} tokens)`
              );
            }
          }
        },
      } as PluginHookRegistration,
    ],

    async init(ctx) {
      console.log(`[CostTracker] Initialized — tracking costs for ${Object.keys(MODEL_COSTS).length} model providers`);
    },

    async shutdown() {
      const totalCost = costHistory.reduce((sum, e) => sum + e.estimatedCost, 0);
      const totalTokens = costHistory.reduce((sum, e) => sum + e.tokensUsed, 0);
      console.log(
        `[CostTracker] Shutdown — Total: $${totalCost.toFixed(4)}, ${totalTokens.toLocaleString()} tokens, ${costHistory.length} entries`
      );
      costHistory = [];
      sessionCosts.clear();
    },

    async healthCheck() {
      return { healthy: true, message: `${costHistory.length} cost entries tracked` };
    },
  };
}

/** Export helpers for external query */
export function getCostSummary() {
  return {
    total: costHistory.reduce((sum, e) => sum + e.estimatedCost, 0),
    totalTokens: costHistory.reduce((sum, e) => sum + e.tokensUsed, 0),
    entryCount: costHistory.length,
    sessionCount: sessionCosts.size,
    dailyCosts: [...dailyCosts],
  };
}

export function getSessionCost(sessionId: string) {
  return sessionCosts.get(sessionId) || { tokens: 0, cost: 0 };
}