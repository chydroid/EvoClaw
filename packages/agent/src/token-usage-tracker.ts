// ── Token Usage Tracker ──
// Hermes Desktop 0.16 引入: 实时token/cost显示
// 追踪每次LLM调用的输入/输出tokens和估算成本

import * as fs from "fs";
import * as path from "path";

/** Model cost info - 镜像GatewayMetadataCache的ModelCostInfo以避免跨包循环依赖 */
export interface ModelCostInfo {
  provider: string;
  model: string;
  inputCostPer1k: number;
  outputCostPer1k: number;
  /** 推理token每千个的成本（o1/o3等推理模型使用） */
  reasoningCostPer1k?: number;
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
  /** 推理token数（o1/o3等推理模型使用） */
  reasoningTokens?: number;
  /** 估算成本(USD) */
  inputCost: number;
  outputCost: number;
  /** 推理成本(USD) */
  reasoningCost?: number;
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
  totalReasoningTokens: number;
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
  /** 默认推理token每千个成本 */
  defaultReasoningCostPer1k?: number;
  /** 回调 - 每次记录后 */
  onRecord?: (record: UsageRecord) => void;
  /** 预算限制配置 */
  budget?: BudgetConfig;
  /** 持久化目录路径 */
  storeDir?: string;
}

/** 简化的Model cost provider接口 - 兼容GatewayMetadataCache */
export interface ModelCostProvider {
  getModelCost(provider: string, model: string): ModelCostInfo | undefined;
}

/** 预算限制配置 */
export interface BudgetConfig {
  /** 硬预算限制(USD)，超过后拒绝所有LLM调用 */
  hardBudgetUsd?: number;
  /** 软预算限制(USD)，超过后发出警告但仍允许调用 */
  softBudgetUsd?: number;
  /** 预算周期：daily/weekly/monthly/total */
  budgetPeriod: "daily" | "weekly" | "monthly" | "total";
  /** 超过软预算时的回调 */
  onSoftBudgetExceeded?: (currentSpend: number, softLimit: number) => void;
  /** 超过硬预算时的回调 */
  onHardBudgetExceeded?: (currentSpend: number, hardLimit: number) => void;
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
  { provider: "openai", model: "o1", inputCostPer1k: 0.015, outputCostPer1k: 0.06, reasoningCostPer1k: 0.06, contextWindow: 128000, updatedAt: 0 },
  { provider: "openai", model: "o1-mini", inputCostPer1k: 0.003, outputCostPer1k: 0.012, reasoningCostPer1k: 0.012, contextWindow: 128000, updatedAt: 0 },
  { provider: "openai", model: "o3-mini", inputCostPer1k: 0.0011, outputCostPer1k: 0.0044, reasoningCostPer1k: 0.0044, contextWindow: 200000, updatedAt: 0 },
  { provider: "anthropic", model: "claude-3-5-sonnet-20241022", inputCostPer1k: 0.003, outputCostPer1k: 0.015, reasoningCostPer1k: 0.015, contextWindow: 200000, updatedAt: 0 },
  { provider: "anthropic", model: "claude-3-haiku-20240307", inputCostPer1k: 0.00025, outputCostPer1k: 0.00125, contextWindow: 200000, updatedAt: 0 },
  { provider: "google", model: "gemini-1.5-pro", inputCostPer1k: 0.00125, outputCostPer1k: 0.005, contextWindow: 2000000, updatedAt: 0 },
  { provider: "google", model: "gemini-1.5-flash", inputCostPer1k: 0.000075, outputCostPer1k: 0.0003, contextWindow: 1000000, updatedAt: 0 },
];

export class TokenUsageTracker {
  private config: Omit<Required<TokenUsageTrackerConfig>, "cache" | "budget"> & { cache?: ModelCostProvider; budget?: BudgetConfig };
  private records: UsageRecord[] = [];
  private cache?: ModelCostProvider;
  private counter = 0;
  private budgetLimiter?: BudgetLimiter;
  private storeDir: string;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: Partial<TokenUsageTrackerConfig> = {}) {
    this.storeDir = config.storeDir || path.resolve(process.cwd(), "data", "token-usage");
    this.config = {
      cache: config.cache as ModelCostProvider,
      retainCount: config.retainCount ?? 10000,
      defaultInputCostPer1k: config.defaultInputCostPer1k ?? 0.002,
      defaultOutputCostPer1k: config.defaultOutputCostPer1k ?? 0.006,
      defaultReasoningCostPer1k: config.defaultReasoningCostPer1k ?? 0.006,
      onRecord: config.onRecord ?? (() => {}),
      budget: config.budget,
      storeDir: this.storeDir,
    };
    this.cache = this.config.cache;
    if (this.config.budget) {
      this.budgetLimiter = new BudgetLimiter(this, this.config.budget);
    }
    this.loadFromDisk();
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
    reasoningTokens?: number;
    cacheHitTokens?: number;
    durationMs?: number;
    toolCalls?: number;
  }): UsageRecord {
    const cost = this.calculateCost(usage.provider, usage.model, usage.inputTokens, usage.outputTokens, usage.reasoningTokens);
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
      reasoningTokens: usage.reasoningTokens,
      inputCost: cost.input,
      outputCost: cost.output,
      reasoningCost: cost.reasoning,
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
    this.schedulePersist();
    return record;
  }

  /** 计算成本 */
  private calculateCost(provider: string, model: string, inputTokens: number, outputTokens: number, reasoningTokens?: number): { input: number; output: number; reasoning: number; total: number } {
    let costInfo: ModelCostInfo | undefined;
    if (this.cache) {
      costInfo = this.cache.getModelCost(provider, model);
    }
    const inputPer1k = costInfo?.inputCostPer1k ?? this.config.defaultInputCostPer1k;
    const outputPer1k = costInfo?.outputCostPer1k ?? this.config.defaultOutputCostPer1k;
    const reasoningPer1k = costInfo?.reasoningCostPer1k ?? this.config.defaultReasoningCostPer1k;
    const input = (inputTokens / 1000) * inputPer1k;
    const output = (outputTokens / 1000) * outputPer1k;
    const reasoning = reasoningTokens ? (reasoningTokens / 1000) * reasoningPer1k : 0;
    return { input, output, reasoning, total: input + output + reasoning };
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
      totalReasoningTokens: 0,
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
      summary.totalReasoningTokens += r.reasoningTokens ?? 0;
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
    this.persistToDisk();
  }

  /** 设置缓存 */
  setCache(cache: ModelCostProvider): void {
    this.cache = cache;
  }

  /** 获取预算限制器 */
  getBudgetLimiter(): BudgetLimiter | undefined {
    return this.budgetLimiter;
  }

  /** 安排延迟持久化（合并多次写入） */
  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistToDisk(), 5000);
  }

  /** 持久化到磁盘 */
  private persistToDisk(): void {
    try {
      if (!fs.existsSync(this.storeDir)) {
        fs.mkdirSync(this.storeDir, { recursive: true });
      }
      const filePath = path.join(this.storeDir, "records.json");
      const data = {
        counter: this.counter,
        // BUG 7.2 fix: 原代码硬编码 slice(-5000)，与 retainCount 配置不一致。
        // 改用 this.config.retainCount 保持一致。
        records: this.records.slice(-this.config.retainCount),
        savedAt: new Date().toISOString(),
      };
      // BUG 7.1 fix: 使用原子写入（temp + fsync + rename）替代 writeFileSync，
      // 防止进程崩溃或并发写入导致 JSON 文件损坏。
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      const fd = fs.openSync(tmpPath, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(data), "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.renameSync(tmpPath, filePath);
      } catch (renameErr) {
        // EXDEV/EBUSY 跨设备回退：在目标目录侧创建临时文件再 rename
        const dstTmp = `${filePath}.${process.pid}.${Date.now()}.dst.tmp`;
        try {
          fs.copyFileSync(tmpPath, dstTmp);
          fs.renameSync(dstTmp, filePath);
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        } catch (fallbackErr) {
          try { fs.unlinkSync(dstTmp); } catch { /* ignore */ }
          throw fallbackErr;
        }
      }
    } catch (err) {
      process.stderr.write(`[TokenUsageTracker] Failed to persist: ${err}\n`);
    }
  }

  /** 从磁盘加载 */
  private loadFromDisk(): void {
    try {
      const filePath = path.join(this.storeDir, "records.json");
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      if (data.counter && typeof data.counter === "number") {
        this.counter = data.counter;
      }
      if (Array.isArray(data.records)) {
        this.records = data.records;
      }
    } catch (err) {
      process.stderr.write(`[TokenUsageTracker] Failed to load from disk: ${err}\n`);
    }
  }
}

/**
 * BudgetLimiter
 * 预算限制器，基于TokenUsageTracker的消费数据检查预算
 */
export class BudgetLimiter {
  private config: BudgetConfig;
  private tracker: TokenUsageTracker;

  constructor(tracker: TokenUsageTracker, config: BudgetConfig) {
    this.tracker = tracker;
    this.config = config;
  }

  /** 获取当前预算周期内的消费 */
  private getCurrentPeriodSpend(): number {
    const periodMs: Record<string, number> = {
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
      monthly: 30 * 24 * 60 * 60 * 1000,
      total: Infinity,
    };
    const sinceMs = this.config.budgetPeriod === "total" ? undefined : periodMs[this.config.budgetPeriod];
    const summary = this.tracker.getSummary(sinceMs ? { sinceMs } : undefined);
    return summary.totalCost;
  }

  /** 检查是否允许新的LLM调用 */
  canProceed(): { allowed: boolean; reason?: string; currentSpend: number } {
    const currentSpend = this.getCurrentPeriodSpend();

    if (this.config.hardBudgetUsd !== undefined && currentSpend >= this.config.hardBudgetUsd) {
      this.config.onHardBudgetExceeded?.(currentSpend, this.config.hardBudgetUsd);
      return { allowed: false, reason: `Hard budget exceeded: $${currentSpend.toFixed(4)} >= $${this.config.hardBudgetUsd}`, currentSpend };
    }

    if (this.config.softBudgetUsd !== undefined && currentSpend >= this.config.softBudgetUsd) {
      this.config.onSoftBudgetExceeded?.(currentSpend, this.config.softBudgetUsd);
    }

    return { allowed: true, currentSpend };
  }

  /** 获取预算使用情况 */
  getBudgetStatus(): { currentSpend: number; softLimit?: number; hardLimit?: number; percentUsed: number; period: string } {
    const currentSpend = this.getCurrentPeriodSpend();
    const limit = this.config.hardBudgetUsd ?? this.config.softBudgetUsd ?? 0;
    const percentUsed = limit > 0 ? (currentSpend / limit) * 100 : 0;
    return {
      currentSpend,
      softLimit: this.config.softBudgetUsd,
      hardLimit: this.config.hardBudgetUsd,
      percentUsed,
      period: this.config.budgetPeriod,
    };
  }
}
