// ── Token Usage Tracker ──
// Hermes Desktop 0.16 引入: 实时token/cost显示
// 追踪每次LLM调用的输入/输出tokens和估算成本

/** Model cost info - 镜像GatewayMetadataCache的ModelCostInfo以避免跨包循环依赖 */
export interface ModelCostInfo {
  provider: string;
  model: string;
  inputCostPer1k: number;
  outputCostPer1k: number;
  contextWindow: number;
  updatedAt: number;
}

/** 一次LLM调用的usage记录 */
export interface UsageRecord {
  id: string;
  sessionId: string;
  userId?: string;
  channel?: string;
  agentId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** 估算成本(USD) */
  inputCost: number;
  outputCost: number;
  totalCost: number;
  /** 调用时间 */
  calledAt: number;
  /** 调用耗时(ms) */
  durationMs?: number;
  /** 提示缓存命中的token数 */
  cacheHitTokens?: number;
  /** 工具调用次数 */
  toolCalls?: number;
}

/** 汇总统计 */
export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheHitTokens: number;
  totalCost: number;
  totalCalls: number;
  byProvider: Record<string, { calls: number; tokens: number; cost: number }>;
  byModel: Record<string, { calls: number; tokens: number; cost: number }>;
  byChannel: Record<string, { calls: number; tokens: number; cost: number }>;
  byUser: Record<string, { calls: number; tokens: number; cost: number }>;
  /** 趋势(最近24小时,按小时分组) */
  hourlyTrend: Array<{ hour: number; calls: number; tokens: number; cost: number }>;
}

/** 配置 */
export interface TokenUsageTrackerConfig {
  cache?: ModelCostProvider;
  /** 保留历史数量 */
  retainCount?: number;
  /** 价格未配置时的默认值 */
  defaultInputCostPer1k?: number;
  defaultOutputCostPer1k?: number;
  /** 回调 - 每次记录后 */
  onRecord?: (record: UsageRecord) => void;
}

/** 简化的Model cost provider接口 - 兼容GatewayMetadataCache */
export interface ModelCostProvider {
  getModelCost(provider: string, model: string): ModelCostInfo | undefined;
}

/**
 * TokenUsageTracker
 * 追踪所有LLM调用的token消耗和成本
 * 与GatewayMetadataCache的ModelCostIndex联动获取最新价格
 */
export const DEFAULT_MODEL_COSTS: ModelCostInfo[] = [
  { provider: "openai", model: "gpt-4", inputCostPer1k: 0.03, outputCostPer1k: 0.06, contextWindow: 8192, updatedAt: 0 },
  { provider: "openai", model: "gpt-4-turbo", inputCostPer1k: 0.01, outputCostPer1k: 0.03, contextWindow: 128000, updatedAt: 0 },
  { provider: "openai", model: "gpt-3.5-turbo", inputCostPer1k: 0.0005, outputCostPer1k: 0.0015, contextWindow: 16385, updatedAt: 0 },
  { provider: "anthropic", model: "claude-3-5-sonnet-20241022", inputCostPer1k: 0.003, outputCostPer1k: 0.015, contextWindow: 200000, updatedAt: 0 },
  { provider: "anthropic", model: "claude-3-haiku-20240307", inputCostPer1k: 0.00025, outputCostPer1k: 0.00125, contextWindow: 200000, updatedAt: 0 },
  { provider: "google", model: "gemini-1.5-pro", inputCostPer1k: 0.00125, outputCostPer1k: 0.005, contextWindow: 2000000, updatedAt: 0 },
  { provider: "google", model: "gemini-1.5-flash", inputCostPer1k: 0.000075, outputCostPer1k: 0.0003, contextWindow: 1000000, updatedAt: 0 },
];

export class TokenUsageTracker {
  private config: Required<TokenUsageTrackerConfig>;
  private records: UsageRecord[] = [];
  private cache?: ModelCostProvider;
  private counter = 0;

  constructor(config: Partial<TokenUsageTrackerConfig> = {}) {
    this.config = {
      cache: config.cache as ModelCostProvider,
      retainCount: config.retainCount ?? 10000,
      defaultInputCostPer1k: config.defaultInputCostPer1k ?? 0.002,
      defaultOutputCostPer1k: config.defaultOutputCostPer1k ?? 0.006,
      onRecord: config.onRecord ?? (() => {}),
    };
    this.cache = this.config.cache;
  }

  /**
   * 记录一次LLM调用的token使用
   */
  record(usage: {
    sessionId: string;
    userId?: string;
    channel?: string;
    agentId?: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens?: number;
    durationMs?: number;
    toolCalls?: number;
  }): UsageRecord {
    const cost = this.calculateCost(usage.provider, usage.model, usage.inputTokens, usage.outputTokens);
    const record: UsageRecord = {
      id: `usage-${++this.counter}-${Date.now()}`,
      sessionId: usage.sessionId,
      userId: usage.userId,
      channel: usage.channel,
      agentId: usage.agentId,
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      inputCost: cost.input,
      outputCost: cost.output,
      totalCost: cost.total,
      calledAt: Date.now(),
      durationMs: usage.durationMs,
      cacheHitTokens: usage.cacheHitTokens,
      toolCalls: usage.toolCalls,
    };
    this.records.push(record);
    if (this.records.length > this.config.retainCount) {
      this.records.shift();
    }
    this.config.onRecord(record);
    return record;
  }

  /** 计算成本 */
  private calculateCost(provider: string, model: string, inputTokens: number, outputTokens: number): { input: number; output: number; total: number } {
    let costInfo: ModelCostInfo | undefined;
    if (this.cache) {
      costInfo = this.cache.getModelCost(provider, model);
    }
    const inputPer1k = costInfo?.inputCostPer1k ?? this.config.defaultInputCostPer1k;
    const outputPer1k = costInfo?.outputCostPer1k ?? this.config.defaultOutputCostPer1k;
    const input = (inputTokens / 1000) * inputPer1k;
    const output = (outputTokens / 1000) * outputPer1k;
    return { input, output, total: input + output };
  }

  /** 获取最近records */
  getRecent(limit = 100, filter?: { sessionId?: string; userId?: string; channel?: string; provider?: string; model?: string }): UsageRecord[] {
    let result = this.records;
    if (filter?.sessionId) result = result.filter((r) => r.sessionId === filter.sessionId);
    if (filter?.userId) result = result.filter((r) => r.userId === filter.userId);
    if (filter?.channel) result = result.filter((r) => r.channel === filter.channel);
    if (filter?.provider) result = result.filter((r) => r.provider === filter.provider);
    if (filter?.model) result = result.filter((r) => r.model === filter.model);
    return result.slice(-limit);
  }

  /** 获取session总成本 */
  getSessionCost(sessionId: string): { inputTokens: number; outputTokens: number; totalCost: number; calls: number } {
    const records = this.records.filter((r) => r.sessionId === sessionId);
    return {
      inputTokens: records.reduce((s, r) => s + r.inputTokens, 0),
      outputTokens: records.reduce((s, r) => s + r.outputTokens, 0),
      totalCost: records.reduce((s, r) => s + r.totalCost, 0),
      calls: records.length,
    };
  }

  /** 获取汇总 */
  getSummary(filter?: { sinceMs?: number; userId?: string; channel?: string }): UsageSummary {
    const since = filter?.sinceMs ? Date.now() - filter.sinceMs : 0;
    let records = this.records.filter((r) => r.calledAt >= since);
    if (filter?.userId) records = records.filter((r) => r.userId === filter.userId);
    if (filter?.channel) records = records.filter((r) => r.channel === filter.channel);

    const summary: UsageSummary = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheHitTokens: 0,
      totalCost: 0,
      totalCalls: records.length,
      byProvider: {},
      byModel: {},
      byChannel: {},
      byUser: {},
      hourlyTrend: [],
    };
    const hourlyMap = new Map<number, { calls: number; tokens: number; cost: number }>();
    for (const r of records) {
      summary.totalInputTokens += r.inputTokens;
      summary.totalOutputTokens += r.outputTokens;
      summary.totalCacheHitTokens += r.cacheHitTokens ?? 0;
      summary.totalCost += r.totalCost;

      // By provider
      if (!summary.byProvider[r.provider]) {
        summary.byProvider[r.provider] = { calls: 0, tokens: 0, cost: 0 };
      }
      summary.byProvider[r.provider].calls++;
      summary.byProvider[r.provider].tokens += r.inputTokens + r.outputTokens;
      summary.byProvider[r.provider].cost += r.totalCost;

      // By model
      const modelKey = `${r.provider}/${r.model}`;
      if (!summary.byModel[modelKey]) {
        summary.byModel[modelKey] = { calls: 0, tokens: 0, cost: 0 };
      }
      summary.byModel[modelKey].calls++;
      summary.byModel[modelKey].tokens += r.inputTokens + r.outputTokens;
      summary.byModel[modelKey].cost += r.totalCost;

      // By channel
      if (r.channel) {
        if (!summary.byChannel[r.channel]) {
          summary.byChannel[r.channel] = { calls: 0, tokens: 0, cost: 0 };
        }
        summary.byChannel[r.channel].calls++;
        summary.byChannel[r.channel].tokens += r.inputTokens + r.outputTokens;
        summary.byChannel[r.channel].cost += r.totalCost;
      }
      // By user
      if (r.userId) {
        if (!summary.byUser[r.userId]) {
          summary.byUser[r.userId] = { calls: 0, tokens: 0, cost: 0 };
        }
        summary.byUser[r.userId].calls++;
        summary.byUser[r.userId].tokens += r.inputTokens + r.outputTokens;
        summary.byUser[r.userId].cost += r.totalCost;
      }
      // Hourly
      const hour = Math.floor(r.calledAt / 3600000);
      if (!hourlyMap.has(hour)) {
        hourlyMap.set(hour, { calls: 0, tokens: 0, cost: 0 });
      }
      const h = hourlyMap.get(hour)!;
      h.calls++;
      h.tokens += r.inputTokens + r.outputTokens;
      h.cost += r.totalCost;
    }
    summary.hourlyTrend = Array.from(hourlyMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([hour, data]) => ({ hour, ...data }));
    return summary;
  }

  /** 清空 */
  clear(): void {
    this.records = [];
  }

  /** 设置缓存 */
  setCache(cache: ModelCostProvider): void {
    this.cache = cache;
  }
}
