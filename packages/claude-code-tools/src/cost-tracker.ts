/**
 * Cost Tracker — Token 用量与成本追踪
 *
 * 借鉴 Claude Code 的成本追踪能力：
 *   - 统计输入/输出 token 用量
 *   - 按模型计算成本
 *   - 会话级别成本聚合
 *   - 预算告警
 *
 * 参考: https://code.claude.com/docs/en/agent-sdk/cost-tracking
 */

// ── Types ──

export interface TokenUsage {
  /** Input tokens consumed */
  inputTokens: number;
  /** Output tokens generated */
  outputTokens: number;
  /** Cache write tokens (Anthropic prompt caching) */
  cacheWriteTokens?: number;
  /** Cache read tokens */
  cacheReadTokens?: number;
}

export interface CostRecord {
  /** Session ID */
  sessionId: string;
  /** Model name (e.g. "claude-sonnet-4-20250514") */
  model: string;
  /** Token usage breakdown */
  usage: TokenUsage;
  /** Cost in USD */
  costUsd: number;
  /** Timestamp */
  timestamp: number;
}

/** Price per 1M tokens (USD) — current as of 2025 */
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite?: number; cacheRead?: number }> = {
  // Claude models (Anthropic)
  "claude-sonnet-4-20250514": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-opus-4-20250514": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-3.5-haiku": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  // OpenAI models
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  // DeepSeek models
  "deepseek-chat": { input: 0.14, output: 0.28 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  // Google models
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-pro": { input: 1.25, output: 5 },
};

// ── Cost Calculator ──

export class CostTracker {
  private records: CostRecord[] = [];
  private budgetLimit: number | null;
  private budgetUsed: number = 0;

  constructor(options: { budgetLimit?: number } = {}) {
    this.budgetLimit = options.budgetLimit ?? null;
  }

  /**
   * Calculate cost from token usage and model pricing.
   */
  static calculateCost(model: string, usage: TokenUsage): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) {
      // Fallback: estimate at $2/$10 per 1M tokens (generic)
      return (usage.inputTokens / 1_000_000) * 2 + (usage.outputTokens / 1_000_000) * 10;
    }

    let cost = 0;
    cost += (usage.inputTokens / 1_000_000) * pricing.input;
    cost += (usage.outputTokens / 1_000_000) * pricing.output;

    if (pricing.cacheWrite && usage.cacheWriteTokens) {
      cost += (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWrite;
    }
    if (pricing.cacheRead && usage.cacheReadTokens) {
      cost += (usage.cacheReadTokens / 1_000_000) * pricing.cacheRead;
    }

    return Math.round(cost * 10000) / 10000; // Round to 4 decimal places
  }

  /**
   * Record a token usage event.
   * Returns true if within budget, false if budget exceeded.
   */
  record(sessionId: string, model: string, usage: TokenUsage): { cost: number; withinBudget: boolean } {
    const cost = CostTracker.calculateCost(model, usage);
    const record: CostRecord = {
      sessionId,
      model,
      usage,
      costUsd: cost,
      timestamp: Date.now(),
    };

    this.records.push(record);
    this.budgetUsed += cost;

    return {
      cost,
      withinBudget: this.budgetLimit === null || this.budgetUsed <= this.budgetLimit,
    };
  }

  /**
   * Get total cost for all sessions.
   */
  get totalCost(): number {
    return Math.round(this.budgetUsed * 10000) / 10000;
  }

  /**
   * Get total tokens consumed across all sessions.
   */
  get totalTokens(): { input: number; output: number } {
    let input = 0;
    let output = 0;
    for (const r of this.records) {
      input += r.usage.inputTokens;
      output += r.usage.outputTokens;
    }
    return { input, output };
  }

  /**
   * Get cost breakdown by session.
   */
  getBySession(): Map<string, { cost: number; records: number; models: string[] }> {
    const map = new Map<string, { cost: number; records: number; models: Set<string> }>();

    for (const r of this.records) {
      const entry = map.get(r.sessionId) ?? { cost: 0, records: 0, models: new Set() };
      entry.cost += r.costUsd;
      entry.records++;
      entry.models.add(r.model);
      map.set(r.sessionId, entry);
    }

    return new Map(
      Array.from(map.entries()).map(([id, v]) => [id, {
        cost: Math.round(v.cost * 10000) / 10000,
        records: v.records,
        models: Array.from(v.models),
      }]),
    );
  }

  /**
   * Get cost breakdown by model.
   */
  getByModel(): Map<string, { cost: number; tokens: { input: number; output: number }; records: number }> {
    const map = new Map<string, { cost: number; tokens: { input: number; output: number }; records: number }>();

    for (const r of this.records) {
      const entry = map.get(r.model) ?? { cost: 0, tokens: { input: 0, output: 0 }, records: 0 };
      entry.cost += r.costUsd;
      entry.tokens.input += r.usage.inputTokens;
      entry.tokens.output += r.usage.outputTokens;
      entry.records++;
      map.set(r.model, entry);
    }

    return new Map(
      Array.from(map.entries()).map(([id, v]) => [id, {
        cost: Math.round(v.cost * 10000) / 10000,
        tokens: v.tokens,
        records: v.records,
      }]),
    );
  }

  /**
   * Get budget status.
   */
  get budget(): { limit: number | null; used: number; remaining: number | null; percentUsed: number | null } {
    return {
      limit: this.budgetLimit,
      used: Math.round(this.budgetUsed * 10000) / 10000,
      remaining: this.budgetLimit !== null ? Math.round((this.budgetLimit - this.budgetUsed) * 10000) / 10000 : null,
      percentUsed: this.budgetLimit !== null && this.budgetLimit > 0 ? Math.round((this.budgetUsed / this.budgetLimit) * 100) : null,
    };
  }

  /**
   * Generate a cost report (human-readable).
   */
  generateReport(): string {
    const byModel = this.getByModel();
    const tokens = this.totalTokens;
    const budget = this.budget;

    const parts: string[] = [
      "=== Cost Report ===",
      "",
      `Total cost: $${this.totalCost.toFixed(4)}`,
      `Total tokens: ${tokens.input.toLocaleString()} input + ${tokens.output.toLocaleString()} output`,
    ];

    if (budget.limit !== undefined && budget.limit !== null) {
      parts.push(`Budget: $${budget.used.toFixed(2)} / $${budget.limit.toFixed(2)} (${budget.percentUsed}%)`);
    }

    parts.push("");
    parts.push("By model:");

    for (const [model, stats] of byModel) {
      parts.push(`  ${model}: $${stats.cost.toFixed(4)} | ${stats.tokens.input.toLocaleString()} in / ${stats.tokens.output.toLocaleString()} out | ${stats.records} calls`);
    }

    return parts.join("\n");
  }

  /**
   * Reset all tracking data.
   */
  reset(): void {
    this.records = [];
    this.budgetUsed = 0;
  }

  /**
   * Get recent records (last N).
   */
  recent(n: number = 10): CostRecord[] {
    return this.records.slice(-n);
  }
}