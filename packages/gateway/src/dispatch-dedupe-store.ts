// ── Dispatch Dedupe Store ──
// OpenClaw 6.6 引入: 持久化dispatch dedupe (在SDK层)
// 防止消息被重复分发到下游, 即使重启后也能识别

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync } from "./atomic-write";

/** Dispatch dedupe key (由channel + external_id + timestamp_window 组成) */
export interface DispatchDedupeKey {
  channel: string;
  externalId: string;
  /** 桶时间窗口(ms) - 同一时间窗口内的相同消息合并 */
  windowMs?: number;
}

/** Dispatch dedupe entry */
export interface DispatchDedupeEntry {
  key: string;
  channel: string;
  externalId: string;
  dispatchedAt: number;
  /** dispatch次数 (首次=1, 重试+1) */
  attempt: number;
  /** 目标agent/session */
  target?: string;
  /** 结果 */
  result?: "success" | "failed" | "pending";
  /** payload hash */
  payloadHash: string;
  expiresAt: number;
}

/** 存储配置 */
export interface DispatchDedupeConfig {
  /** 持久化路径 */
  persistPath?: string;
  /** 是否启用持久化 */
  persistEnabled?: boolean;
  /** 默认TTL (ms), 默认24小时 */
  defaultTtlMs?: number;
  /** 内存中保留的最大entry数 */
  maxEntries?: number;
  /** 清理间隔 */
  cleanupIntervalMs?: number;
}

/**
 * DispatchDedupeStore
 * 核心功能:
 * 1. 检测消息是否已被dispatch (返回true=已dispatch, 跳过)
 * 2. 记录每次dispatch (支持重试计数)
 * 3. 持久化到磁盘(可选), 重启后仍能识别
 * 4. 自动清理过期entry
 */
export class DispatchDedupeStore {
  private entries = new Map<string, DispatchDedupeEntry>();
  private config: Required<DispatchDedupeConfig>;
  private cleanupTimer?: NodeJS.Timeout;

  // 统计
  private stats = {
    checks: 0,
    hits: 0,
    misses: 0,
    records: 0,
    evictions: 0,
    persistWrites: 0,
  };

  constructor(config: Partial<DispatchDedupeConfig> = {}) {
    this.config = {
      persistPath: config.persistPath ?? "",
      persistEnabled: config.persistEnabled ?? false,
      defaultTtlMs: config.defaultTtlMs ?? 24 * 60 * 60 * 1000,
      maxEntries: config.maxEntries ?? 100000,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 5 * 60 * 1000,
    };
    if (this.config.persistEnabled && this.config.persistPath) {
      this.loadFromDisk();
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupIntervalMs);
    if (typeof this.cleanupTimer.unref === "function") this.cleanupTimer.unref();
  }

  /** 生成key — 不包含时间桶，依赖 expiresAt 做过期判断 */
  static generateKey(key: DispatchDedupeKey): string {
    return `${key.channel}:${key.externalId}`;
  }

  /** 检查是否已dispatch (是=跳过) */
  isDispatched(key: DispatchDedupeKey): boolean {
    this.stats.checks++;
    const dedupeKey = DispatchDedupeStore.generateKey(key);
    const entry = this.entries.get(dedupeKey);
    if (!entry) {
      this.stats.misses++;
      return false;
    }
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(dedupeKey);
      this.stats.misses++;
      this.stats.evictions++;
      return false;
    }
    this.stats.hits++;
    return true;
  }

  /** 记录一次dispatch */
  record(key: DispatchDedupeKey, payloadHash: string, target?: string, result?: DispatchDedupeEntry["result"]): DispatchDedupeEntry {
    const dedupeKey = DispatchDedupeStore.generateKey(key);
    const existing = this.entries.get(dedupeKey);
    const entry: DispatchDedupeEntry = existing
      ? {
          ...existing,
          attempt: existing.attempt + 1,
          result: result ?? existing.result,
          payloadHash,
        }
      : {
          key: dedupeKey,
          channel: key.channel,
          externalId: key.externalId,
          dispatchedAt: Date.now(),
          attempt: 1,
          target,
          result: result ?? "pending",
          payloadHash,
          expiresAt: Date.now() + this.config.defaultTtlMs,
        };
    this.entries.set(dedupeKey, entry);
    this.stats.records++;
    if (this.config.persistEnabled) this.persistToDisk();
    this.evictIfNeeded();
    return entry;
  }

  /** 获取entry */
  get(key: DispatchDedupeKey): DispatchDedupeEntry | undefined {
    const dedupeKey = DispatchDedupeStore.generateKey(key);
    const entry = this.entries.get(dedupeKey);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(dedupeKey);
      return undefined;
    }
    return entry;
  }

  /** 删除entry */
  delete(key: DispatchDedupeKey): boolean {
    const dedupeKey = DispatchDedupeStore.generateKey(key);
    const result = this.entries.delete(dedupeKey);
    if (this.config.persistEnabled) this.persistToDisk();
    return result;
  }

  /** 列出所有entries (用于调试/UI) */
  list(filter?: { channel?: string; result?: DispatchDedupeEntry["result"]; limit?: number }): DispatchDedupeEntry[] {
    let result = Array.from(this.entries.values());
    if (filter?.channel) {
      result = result.filter((e) => e.channel === filter.channel);
    }
    if (filter?.result) {
      result = result.filter((e) => e.result === filter.result);
    }
    if (filter?.limit) {
      result = result.slice(-filter.limit);
    }
    return result;
  }

  /** 清理过期 */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt < now) {
        this.entries.delete(key);
        removed++;
      }
    }
    this.stats.evictions += removed;
    if (this.config.persistEnabled) this.persistToDisk();
  }

  /** 驱逐最旧entries (LRU策略) */
  private evictIfNeeded(): void {
    if (this.entries.size <= this.config.maxEntries) return;
    const sorted = Array.from(this.entries.entries())
      .sort((a, b) => a[1].dispatchedAt - b[1].dispatchedAt);
    const toRemove = this.entries.size - this.config.maxEntries;
    for (let i = 0; i < toRemove; i++) {
      this.entries.delete(sorted[i][0]);
      this.stats.evictions++;
    }
  }

  /** 持久化 */
  private persistToDisk(): void {
    if (!this.config.persistPath) return;
    try {
      const dir = path.dirname(this.config.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        entries: Array.from(this.entries.entries()),
        savedAt: Date.now(),
      };
      // 使用原子写入，符合 AGENTS.md 规则
      atomicWriteFileSync(this.config.persistPath, JSON.stringify(data));
      this.stats.persistWrites++;
    } catch { /* 静默失败 */ }
  }

  /** 从磁盘加载 */
  private loadFromDisk(): void {
    if (!this.config.persistPath || !fs.existsSync(this.config.persistPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.config.persistPath, "utf-8"));
      if (data.entries && Array.isArray(data.entries)) {
        for (const [key, entry] of data.entries as Array<[string, DispatchDedupeEntry]>) {
          // 只加载未过期的
          if (entry.expiresAt > Date.now()) {
            this.entries.set(key, entry);
          }
        }
      }
    } catch { /* 静默失败 */ }
  }

  /** 关闭 */
  shutdown(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /** 统计 */
  getStats() {
    return {
      ...this.stats,
      entryCount: this.entries.size,
      hitRate: this.stats.checks > 0 ? this.stats.hits / this.stats.checks : 0,
    };
  }

  /** 清空 */
  clear(): void {
    this.entries.clear();
    if (this.config.persistEnabled) this.persistToDisk();
  }
}
