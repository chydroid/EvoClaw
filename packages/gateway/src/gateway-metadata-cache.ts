// ── Gateway Metadata Cache ──
// OpenClaw 5.26 引入: stable Gateway metadata caching
// 减少启动和回复路径上的重复扫描与元数据重新发现

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync } from "./atomic-write";

/** Gateway 元数据 */
export interface GatewayMetadata {
  version: string;
  buildHash: string;
  startTime: number;
  nodeVersion: string;
  platform: string;
  arch: string;
  pid: number;
  hostname: string;
  /** 已加载的packages */
  loadedPackages: Array<{ name: string; version: string }>;
  /** 模型providers */
  modelProviders: Array<{ name: string; models: string[]; enabled: boolean }>;
  /** 已注册的channels */
  channels: Array<{ type: string; enabled: boolean; connected: boolean }>;
  /** 已注册的plugins */
  plugins: Array<{ id: string; name: string; version: string; enabled: boolean; loaded: boolean }>;
  /** 已注册的skills */
  skills: Array<{ id: string; name: string; version: string; enabled: boolean }>;
  /** 已加载的MCP servers */
  mcpServers: Array<{ name: string; tools: number; status: string }>;
  /** Capabilities */
  capabilities: string[];
}

/** 模型cost信息 */
export interface ModelCostInfo {
  provider: string;
  model: string;
  inputCostPer1k: number;  // USD per 1K input tokens
  outputCostPer1k: number; // USD per 1K output tokens
  contextWindow: number;
  updatedAt: number;
}

/** 缓存项 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  /** 生成时间 */
  createdAt: number;
  /** 命中次数 */
  hits: number;
}

/** Gateway Metadata Cache 配置 */
export interface GatewayMetadataCacheConfig {
  /** 元数据TTL(ms), 默认5分钟 */
  metadataTtlMs?: number;
  /** Cost index TTL, 默认1小时 */
  costIndexTtlMs?: number;
  /** Channel resolution TTL, 默认30秒 */
  channelResolutionTtlMs?: number;
  /** 持久化路径 */
  persistPath?: string;
  /** 是否启用持久化 */
  persistEnabled?: boolean;
}

/**
 * GatewayMetadataCache
 * 统一管理 gateway 各类元数据的内存缓存, 减少重复I/O与计算
 */
export class GatewayMetadataCache {
  private config: Required<GatewayMetadataCacheConfig>;

  // 不同TTL的子缓存
  private metadataCache = new Map<string, CacheEntry<unknown>>();
  private modelCostIndex = new Map<string, CacheEntry<ModelCostInfo>>();
  private channelResolutionCache = new Map<string, CacheEntry<unknown>>();

  // 稳定元数据
  private stableMetadata?: GatewayMetadata;
  private stableMetadataLoadedAt = 0;

  // 统计
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    persistWrites: 0,
    persistReads: 0,
  };
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** 防抖持久化定时器：合并短时间内的多次写入为一次落盘 */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PERSIST_DEBOUNCE_MS = 5000;

  constructor(config: Partial<GatewayMetadataCacheConfig> = {}) {
    this.config = {
      metadataTtlMs: config.metadataTtlMs ?? 5 * 60 * 1000,
      costIndexTtlMs: config.costIndexTtlMs ?? 60 * 60 * 1000,
      channelResolutionTtlMs: config.channelResolutionTtlMs ?? 30 * 1000,
      persistPath: config.persistPath ?? "",
      persistEnabled: config.persistEnabled ?? false,
    };
    if (this.config.persistEnabled && this.config.persistPath) {
      this.loadFromDisk();
    }

    // 定期清理过期缓存条目（每5分钟），防止写入但不读取的条目无限堆积
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 5 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  /** 清理所有缓存中的过期条目 */
  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.metadataCache.entries()) {
      if (now > entry.expiresAt) this.metadataCache.delete(key);
    }
    for (const [key, entry] of this.modelCostIndex.entries()) {
      if (now > entry.expiresAt) this.modelCostIndex.delete(key);
    }
    for (const [key, entry] of this.channelResolutionCache.entries()) {
      if (now > entry.expiresAt) this.channelResolutionCache.delete(key);
    }
  }

  /** 停止定时清理，释放资源 */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // 关闭时刷新待写入的持久化，避免丢数据
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persistToDisk();
    }
  }

  // ─── 稳定元数据 ───

  /** 设置稳定元数据(在启动时调用一次) */
  setStableMetadata(metadata: GatewayMetadata): void {
    this.stableMetadata = metadata;
    this.stableMetadataLoadedAt = Date.now();
  }

  /** 获取稳定元数据 */
  getStableMetadata(): GatewayMetadata | undefined {
    return this.stableMetadata;
  }

  /** 稳定元数据是否已加载 */
  isStableMetadataLoaded(): boolean {
    return this.stableMetadata !== undefined;
  }

  // ─── 通用元数据缓存 ───

  /** 设置缓存 */
  set<T>(key: string, value: T, ttlMs?: number): void {
    const ttl = ttlMs ?? this.config.metadataTtlMs;
    this.metadataCache.set(key, {
      value,
      expiresAt: Date.now() + ttl,
      createdAt: Date.now(),
      hits: 0,
    });
    if (this.config.persistEnabled) this.schedulePersist();
  }

  /** 获取缓存 */
  get<T>(key: string): T | undefined {
    const entry = this.metadataCache.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.metadataCache.delete(key);
      this.stats.misses++;
      this.stats.evictions++;
      return undefined;
    }
    entry.hits++;
    this.stats.hits++;
    return entry.value as T;
  }

  /** 获取或计算 */
  getOrCompute<T>(key: string, compute: () => T | Promise<T>, ttlMs?: number): T | Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const result = compute();
    if (result instanceof Promise) {
      return result.then((v) => {
        this.set(key, v, ttlMs);
        return v;
      });
    }
    this.set(key, result, ttlMs);
    return result;
  }

  /** 删除缓存 */
  delete(key: string): boolean {
    return this.metadataCache.delete(key);
  }

  /** 清空 */
  clear(): void {
    this.metadataCache.clear();
    this.modelCostIndex.clear();
    this.channelResolutionCache.clear();
  }

  // ─── Model Cost Index ───

  /** 设置model cost */
  setModelCost(info: ModelCostInfo): void {
    const key = `${info.provider}:${info.model}`;
    this.modelCostIndex.set(key, {
      value: info,
      expiresAt: Date.now() + this.config.costIndexTtlMs,
      createdAt: Date.now(),
      hits: 0,
    });
    if (this.config.persistEnabled) this.schedulePersist();
  }

  /** 批量设置model cost */
  setModelCostBatch(infos: ModelCostInfo[]): void {
    for (const info of infos) this.setModelCost(info);
  }

  /** 获取model cost */
  getModelCost(provider: string, model: string): ModelCostInfo | undefined {
    const key = `${provider}:${model}`;
    const entry = this.modelCostIndex.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.modelCostIndex.delete(key);
      this.stats.misses++;
      return undefined;
    }
    entry.hits++;
    this.stats.hits++;
    return entry.value;
  }

  /** 获取所有model cost */
  getAllModelCosts(): ModelCostInfo[] {
    const result: ModelCostInfo[] = [];
    const now = Date.now();
    for (const [key, entry] of this.modelCostIndex.entries()) {
      if (entry.expiresAt > now) {
        result.push(entry.value);
      } else {
        this.modelCostIndex.delete(key);
      }
    }
    return result;
  }

  // ─── Channel Resolution Cache ───

  /** 缓存channel resolution (short TTL) */
  cacheChannelResolution<T>(channel: string, target: string, value: T): void {
    const key = `${channel}:${target}`;
    this.channelResolutionCache.set(key, {
      value,
      expiresAt: Date.now() + this.config.channelResolutionTtlMs,
      createdAt: Date.now(),
      hits: 0,
    });
  }

  /** 获取channel resolution */
  getChannelResolution<T>(channel: string, target: string): T | undefined {
    const key = `${channel}:${target}`;
    const entry = this.channelResolutionCache.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.channelResolutionCache.delete(key);
      this.stats.misses++;
      this.stats.evictions++;
      return undefined;
    }
    entry.hits++;
    this.stats.hits++;
    return entry.value as T;
  }

  // ─── Hot Path Fact Cache (OpenClaw 5.26) ───

  /** 缓存hot path fact (session/auth相关) */
  cacheFact<T>(key: string, value: T, ttlMs = 60000): void {
    this.set(`fact:${key}`, value, ttlMs);
  }

  /** 获取hot path fact */
  getFact<T>(key: string): T | undefined {
    return this.get<T>(`fact:${key}`);
  }

  // ─── 持久化 ───

  /** 调度防抖持久化：5 秒内多次写入合并为一次落盘 */
  private schedulePersist(): void {
    if (!this.config.persistEnabled) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistToDisk();
    }, GatewayMetadataCache.PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  private persistToDisk(): void {
    if (!this.config.persistPath) return;
    try {
      const dir = path.dirname(this.config.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        modelCosts: Array.from(this.modelCostIndex.entries()).map(([k, v]) => [k, v.value]),
        savedAt: Date.now(),
      };
      // 改用原子写入，符合 AGENTS.md 规则（temp + fsync + rename）
      atomicWriteFileSync(this.config.persistPath, JSON.stringify(data));
      this.stats.persistWrites++;
    } catch (err) { process.stderr.write('[GatewayMetadataCache] persistToDisk failed: ' + err + '\n'); }
  }

  private loadFromDisk(): void {
    if (!this.config.persistPath || !fs.existsSync(this.config.persistPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.config.persistPath, "utf-8"));
      if (data.modelCosts) {
        for (const [key, value] of data.modelCosts as Array<[string, ModelCostInfo]>) {
          this.modelCostIndex.set(key, {
            value,
            expiresAt: Date.now() + this.config.costIndexTtlMs,
            createdAt: data.savedAt ?? Date.now(),
            hits: 0,
          });
        }
      }
      this.stats.persistReads++;
    } catch (err) { process.stderr.write('[GatewayMetadataCache] loadFromDisk failed: ' + err + '\n'); }
  }

  // ─── 统计 ───

  getStats() {
    return {
      ...this.stats,
      hitRate: this.stats.hits + this.stats.misses > 0
        ? this.stats.hits / (this.stats.hits + this.stats.misses)
        : 0,
      metadataCacheSize: this.metadataCache.size,
      modelCostIndexSize: this.modelCostIndex.size,
      channelResolutionCacheSize: this.channelResolutionCache.size,
    };
  }
}

/** 预置的常用模型cost数据 */
export const DEFAULT_MODEL_COSTS: ModelCostInfo[] = [
  { provider: "openai", model: "gpt-4", inputCostPer1k: 0.03, outputCostPer1k: 0.06, contextWindow: 8192, updatedAt: Date.now() },
  { provider: "openai", model: "gpt-4-turbo", inputCostPer1k: 0.01, outputCostPer1k: 0.03, contextWindow: 128000, updatedAt: Date.now() },
  { provider: "openai", model: "gpt-3.5-turbo", inputCostPer1k: 0.0005, outputCostPer1k: 0.0015, contextWindow: 16385, updatedAt: Date.now() },
  { provider: "anthropic", model: "claude-3-5-sonnet-20241022", inputCostPer1k: 0.003, outputCostPer1k: 0.015, contextWindow: 200000, updatedAt: Date.now() },
  { provider: "anthropic", model: "claude-3-haiku-20240307", inputCostPer1k: 0.00025, outputCostPer1k: 0.00125, contextWindow: 200000, updatedAt: Date.now() },
  { provider: "google", model: "gemini-1.5-pro", inputCostPer1k: 0.00125, outputCostPer1k: 0.005, contextWindow: 2000000, updatedAt: Date.now() },
  { provider: "google", model: "gemini-1.5-flash", inputCostPer1k: 0.000075, outputCostPer1k: 0.0003, contextWindow: 1000000, updatedAt: Date.now() },
];
