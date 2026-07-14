/**
 * Cache 命中追踪：记录每次 LLM 请求的 cache 命中情况。
 *
 * 灵感来自 openclaw-main 的 src/agents/cache-trace.ts。
 *
 * 与 openclaw-main 的差异：
 * - openclaw-main：JSONL 文件 + 队列写入器（持久化诊断日志）
 * - 本模块：内存追踪 + 成本/延迟估算 + 统计聚合（更轻量，适合运行时观测）
 *
 * 用于事后分析：哪些请求命中 cache、哪些断开、断开原因、估算节省的成本。
 */

import type { CacheProvider } from "./prompt-cache-stability";
import * as crypto from "crypto";

export interface CacheTraceEntry {
  /** uuid */
  id: string;
  timestamp: Date;
  sessionId?: string;
  provider: CacheProvider;
  model?: string;

  // Cache 信息
  /** cache 命中的 token 数 */
  cacheHitTokens: number;
  /** cache 未命中的 token 数 */
  cacheMissTokens: number;
  /** 断开位置 */
  cacheBrokenAt?: number;
  /** 断开原因 */
  cacheBrokenReason?: string;

  // 成本估算
  /** 节省的 input 成本（USD） */
  estimatedInputCostSaved?: number;
  /** 节省的延迟（ms） */
  estimatedLatencySavedMs?: number;

  // 元数据
  requestId?: string;
  durationMs?: number;
}

export interface CacheTraceQuery {
  sessionId?: string;
  provider?: CacheProvider;
  after?: Date;
  before?: Date;
  minCacheMissTokens?: number;
  limit?: number;
}

export interface CacheTraceStats {
  totalRequests: number;
  totalCacheHitTokens: number;
  totalCacheMissTokens: number;
  /** hitTokens / (hitTokens + missTokens) */
  overallHitRate: number;

  // 按 provider 分组
  byProvider: Record<
    string,
    {
      requests: number;
      hitTokens: number;
      missTokens: number;
      hitRate: number;
    }
  >;

  // 按 session 分组
  bySession: Record<
    string,
    {
      requests: number;
      hitTokens: number;
      missTokens: number;
      hitRate: number;
    }
  >;

  // 成本节省
  totalEstimatedCostSaved: number;
  totalEstimatedLatencySavedMs: number;

  // 反模式
  worstBrokenReasons: Array<{ reason: string; count: number }>;
}

/** Token 成本表：每百万 token 的 USD 价格（可配置） */
export interface ModelCostEntry {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

export type CostTable = Record<string, ModelCostEntry>;

const DEFAULT_MAX_SIZE = 1000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
/** 估算 cache hit 每 1k token 节省的延迟（ms），粗略值 */
const LATENCY_SAVED_PER_1K_TOKENS_MS = 50;
const TOKENS_PER_MILLION = 1_000_000;

const DEFAULT_COST_TABLE: CostTable = {
  "gpt-4o": { input: 2.5, cacheRead: 1.25, cacheWrite: 5.0 },
  "gpt-4o-mini": { input: 0.15, cacheRead: 0.075, cacheWrite: 0.3 },
  "claude-3-5-sonnet": { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku": { input: 0.8, cacheRead: 0.08, cacheWrite: 1.0 },
};

const PROVIDER_DEFAULT_COST: Record<CacheProvider, ModelCostEntry> = {
  openai: { input: 2.0, cacheRead: 1.0, cacheWrite: 4.0 },
  anthropic: { input: 2.5, cacheRead: 0.3, cacheWrite: 3.5 },
  google: { input: 1.5, cacheRead: 0.75, cacheWrite: 3.0 },
  unknown: { input: 2.0, cacheRead: 1.0, cacheWrite: 4.0 },
};

/**
 * 生成简易 uuid（基于时间戳 + 随机数，不依赖 uuid 包）。
 */
function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

export class CacheTracer {
  private entries: CacheTraceEntry[] = [];
  private readonly maxSize: number;
  private readonly maxAgeMs: number;
  private costTable: CostTable;

  constructor(opts?: { maxSize?: number; maxAgeMs?: number }) {
    this.maxSize = opts?.maxSize ?? DEFAULT_MAX_SIZE;
    this.maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.costTable = { ...DEFAULT_COST_TABLE };
  }

  /**
   * 记录一次 cache trace。
   *
   * 自动填充 id、timestamp、estimatedInputCostSaved、estimatedLatencySavedMs。
   */
  record(
    entry: Omit<CacheTraceEntry, "id" | "timestamp">,
  ): CacheTraceEntry {
    const costSaved = this.estimateCostSaved(entry);
    const latencySaved = this.estimateLatencySaved(entry.cacheHitTokens);
    const full: CacheTraceEntry = {
      ...entry,
      id: generateId(),
      timestamp: new Date(),
      estimatedInputCostSaved: costSaved,
      estimatedLatencySavedMs: latencySaved,
    };
    this.entries.push(full);
    // 容量保护：FIFO 淘汰
    if (this.entries.length > this.maxSize) {
      this.entries.shift();
    }
    return full;
  }

  /**
   * 查询 trace。
   */
  query(q: CacheTraceQuery): CacheTraceEntry[] {
    let result = this.entries;
    if (q.sessionId) {
      result = result.filter((e) => e.sessionId === q.sessionId);
    }
    if (q.provider) {
      result = result.filter((e) => e.provider === q.provider);
    }
    if (q.after) {
      result = result.filter((e) => e.timestamp >= q.after!);
    }
    if (q.before) {
      result = result.filter((e) => e.timestamp <= q.before!);
    }
    if (q.minCacheMissTokens !== undefined) {
      result = result.filter(
        (e) => e.cacheMissTokens >= q.minCacheMissTokens!,
      );
    }
    // 按时间升序
    result = [...result].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    if (q.limit && q.limit > 0) {
      result = result.slice(0, q.limit);
    }
    return result;
  }

  /**
   * 计算统计信息。
   */
  stats(q?: CacheTraceQuery): CacheTraceStats {
    const filtered = q ? this.query(q) : this.entries;
    return computeStats(filtered);
  }

  /**
   * 估算单次请求的成本节省（USD）。
   *
   * 节省 = (input 价格 - cacheRead 价格) * hitTokens / 1_000_000
   */
  estimateCostSaved(entry: {
    provider: CacheProvider;
    model?: string;
    cacheHitTokens: number;
  }): number {
    if (entry.cacheHitTokens <= 0) return 0;
    const cost = this.lookupCost(entry.provider, entry.model);
    if (!cost || cost.input <= cost.cacheRead) return 0;
    return ((cost.input - cost.cacheRead) * entry.cacheHitTokens) / TOKENS_PER_MILLION;
  }

  /**
   * 估算 cache hit 节省的延迟（ms）。
   * 粗略值：每 1k token 节省 50ms。
   */
  estimateLatencySaved(cacheHitTokens: number): number {
    if (cacheHitTokens <= 0) return 0;
    return Math.round((cacheHitTokens / 1000) * LATENCY_SAVED_PER_1K_TOKENS_MS);
  }

  /**
   * 清理过期 trace。返回被清理的条数。
   */
  prune(now: Date = new Date()): number {
    const cutoff = now.getTime() - this.maxAgeMs;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.timestamp.getTime() >= cutoff);
    return before - this.entries.length;
  }

  /**
   * 清空所有 trace。
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * 设置/更新成本表（合并覆盖）。
   */
  setCostTable(table: CostTable): void {
    this.costTable = { ...this.costTable, ...table };
  }

  /** 获取当前条目数（用于测试） */
  size(): number {
    return this.entries.length;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private lookupCost(
    provider: CacheProvider,
    model?: string,
  ): ModelCostEntry | undefined {
    if (model) {
      // 精确匹配
      const exact = this.costTable[model];
      if (exact) return exact;
      // 模糊匹配：model 包含 costTable 中的 key
      for (const [key, val] of Object.entries(this.costTable)) {
        if (model.includes(key)) return val;
      }
    }
    // provider 默认
    return PROVIDER_DEFAULT_COST[provider];
  }
}

// ── 统计计算（模块级函数，便于单测） ──────────────────────────────────

function computeStats(entries: CacheTraceEntry[]): CacheTraceStats {
  const totalRequests = entries.length;
  let totalCacheHitTokens = 0;
  let totalCacheMissTokens = 0;
  let totalEstimatedCostSaved = 0;
  let totalEstimatedLatencySavedMs = 0;

  const byProvider: CacheTraceStats["byProvider"] = {};
  const bySession: CacheTraceStats["bySession"] = {};
  const reasonCounts = new Map<string, number>();

  for (const e of entries) {
    totalCacheHitTokens += e.cacheHitTokens;
    totalCacheMissTokens += e.cacheMissTokens;
    if (e.estimatedInputCostSaved) totalEstimatedCostSaved += e.estimatedInputCostSaved;
    if (e.estimatedLatencySavedMs) totalEstimatedLatencySavedMs += e.estimatedLatencySavedMs;
    if (e.cacheBrokenReason) {
      reasonCounts.set(
        e.cacheBrokenReason,
        (reasonCounts.get(e.cacheBrokenReason) ?? 0) + 1,
      );
    }

    // 按 provider 聚合
    const pKey = e.provider;
    if (!byProvider[pKey]) {
      byProvider[pKey] = { requests: 0, hitTokens: 0, missTokens: 0, hitRate: 0 };
    }
    byProvider[pKey].requests += 1;
    byProvider[pKey].hitTokens += e.cacheHitTokens;
    byProvider[pKey].missTokens += e.cacheMissTokens;

    // 按 session 聚合
    const sKey = e.sessionId ?? "(none)";
    if (!bySession[sKey]) {
      bySession[sKey] = { requests: 0, hitTokens: 0, missTokens: 0, hitRate: 0 };
    }
    bySession[sKey].requests += 1;
    bySession[sKey].hitTokens += e.cacheHitTokens;
    bySession[sKey].missTokens += e.cacheMissTokens;
  }

  // 计算 hitRate
  const totalTokens = totalCacheHitTokens + totalCacheMissTokens;
  const overallHitRate = totalTokens > 0 ? totalCacheHitTokens / totalTokens : 0;

  for (const p of Object.values(byProvider)) {
    const t = p.hitTokens + p.missTokens;
    p.hitRate = t > 0 ? p.hitTokens / t : 0;
  }
  for (const s of Object.values(bySession)) {
    const t = s.hitTokens + s.missTokens;
    s.hitRate = t > 0 ? s.hitTokens / t : 0;
  }

  // worstBrokenReasons：按出现次数倒序
  const worstBrokenReasons = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalRequests,
    totalCacheHitTokens,
    totalCacheMissTokens,
    overallHitRate,
    byProvider,
    bySession,
    totalEstimatedCostSaved,
    totalEstimatedLatencySavedMs,
    worstBrokenReasons,
  };
}
