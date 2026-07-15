/**
 * ProviderSkipList — 失败 provider 跳过列表（session 级别持久化）
 *
 * 借鉴 hermes-agent credential_pool.py 的 auth failover 机制：
 *   当 provider 发生 non-transient 错误（AUTH/BILLING/CONTENT_POLICY 等）时，
 *   将其加入 skip list，避免同一 session 内重复尝试已知失败 provider，
 *   浪费 API 调用和增加用户等待时间。
 *
 * 设计：
 *   - session 级别隔离：每个 session 维护独立的 skip list
 *   - TTL 自动过期：默认 5 分钟后自动重试（provider 可能恢复）
 *   - 持久化到 JSON 文件：跨进程共享，使用 atomicWriteFileSync
 *   - LRU 淘汰：限制 session 数量防止内存无限增长
 *   - 线程安全：所有操作同步执行（Node.js 单线程）
 */

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync } from "@evoclaw/core";

/** 单个 provider 的跳过记录 */
export interface ProviderSkipEntry {
  /** provider ID */
  providerId: string;
  /** 跳过原因（错误类型） */
  reason: string;
  /** 失败时间戳（ms） */
  failedAt: number;
  /** 过期时间戳（ms） */
  expiresAt: number;
}

/** Session 级别的 skip list */
export interface SessionSkipList {
  /** session ID */
  sessionId: string;
  /** 该 session 的所有 skip 记录 */
  entries: Map<string, ProviderSkipEntry>;
  /** 最后更新时间 */
  updatedAt: number;
}

/** 配置 */
export interface ProviderSkipListConfig {
  /** 单个 skip 记录的 TTL（ms），默认 5 分钟 */
  defaultTtlMs: number;
  /** 持久化文件路径 */
  filePath: string;
  /** 最大 session 数量（LRU 淘汰） */
  maxSessions: number;
}

const DEFAULT_CONFIG: Omit<ProviderSkipListConfig, "filePath"> = {
  defaultTtlMs: 5 * 60 * 1000, // 5 分钟
  maxSessions: 500,
};

export class ProviderSkipList {
  private config: ProviderSkipListConfig;
  private sessions = new Map<string, SessionSkipList>();
  /** 是否已从磁盘加载 */
  private loaded = false;

  constructor(config: Partial<ProviderSkipListConfig> = {}) {
    const filePath = config.filePath
      ?? path.join(process.cwd(), "data", "provider-skip-list.json");
    this.config = { ...DEFAULT_CONFIG, ...config, filePath };
  }

  /**
   * 添加一个 provider 到 session 的 skip list。
   *
   * @param sessionId session ID
   * @param providerId provider ID
   * @param reason 跳过原因（如 "auth"、"billing"、"content_policy"）
   * @param ttlMs 自定义 TTL（ms），默认使用 config.defaultTtlMs
   */
  add(sessionId: string, providerId: string, reason: string, ttlMs?: number): void {
    this.ensureLoaded();
    const ttl = ttlMs ?? this.config.defaultTtlMs;
    const now = Date.now();

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { sessionId, entries: new Map(), updatedAt: now };
      this.sessions.set(sessionId, session);
      // LRU 淘汰
      if (this.sessions.size > this.config.maxSessions) {
        const oldestKey = this.sessions.keys().next().value;
        if (oldestKey) this.sessions.delete(oldestKey);
      }
    }

    session.entries.set(providerId, {
      providerId,
      reason,
      failedAt: now,
      expiresAt: now + ttl,
    });
    session.updatedAt = now;

    this.persist();
  }

  /**
   * 检查 provider 是否应被跳过（在 skip list 中且未过期）。
   *
   * @returns 如果应跳过，返回 ProviderSkipEntry；否则返回 undefined
   */
  shouldSkip(sessionId: string, providerId: string): ProviderSkipEntry | undefined {
    this.ensureLoaded();
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const entry = session.entries.get(providerId);
    if (!entry) return undefined;

    // 过期则移除
    if (Date.now() >= entry.expiresAt) {
      session.entries.delete(providerId);
      this.persist();
      return undefined;
    }

    return entry;
  }

  /**
   * 获取 session 的所有 skip 记录。
   */
  getSessionSkips(sessionId: string): ProviderSkipEntry[] {
    this.ensureLoaded();
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    this.purgeExpired(session);
    return Array.from(session.entries.values());
  }

  /**
   * 手动移除一个 provider 的 skip 记录（如手动恢复）。
   */
  remove(sessionId: string, providerId: string): boolean {
    this.ensureLoaded();
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const removed = session.entries.delete(providerId);
    if (removed) this.persist();
    return removed;
  }

  /**
   * 清除 session 的所有 skip 记录。
   */
  clearSession(sessionId: string): void {
    this.ensureLoaded();
    const session = this.sessions.get(sessionId);
    if (session) {
      session.entries.clear();
      session.updatedAt = Date.now();
      this.persist();
    }
  }

  /**
   * 清除所有 session 的 skip 记录。
   */
  clearAll(): void {
    this.sessions.clear();
    this.persist();
  }

  /**
   * 获取统计信息。
   */
  getStats(): { totalSessions: number; totalSkips: number } {
    this.ensureLoaded();
    let totalSkips = 0;
    for (const session of this.sessions.values()) {
      this.purgeExpired(session);
      totalSkips += session.entries.size;
    }
    return { totalSessions: this.sessions.size, totalSkips };
  }

  // ── 内部方法 ──────────────────────────────────────────────

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.config.filePath)) return;
      const data = fs.readFileSync(this.config.filePath, "utf-8");
      const parsed = JSON.parse(data) as Array<{
        sessionId: string;
        entries: Array<ProviderSkipEntry>;
        updatedAt: number;
      }>;

      const now = Date.now();
      for (const s of parsed) {
        const entries = new Map<string, ProviderSkipEntry>();
        for (const e of s.entries) {
          // 加载时过滤已过期的
          if (now < e.expiresAt) {
            entries.set(e.providerId, e);
          }
        }
        if (entries.size > 0) {
          this.sessions.set(s.sessionId, {
            sessionId: s.sessionId,
            entries,
            updatedAt: s.updatedAt,
          });
        }
      }
    } catch (err) {
      process.stderr.write(
        `[ProviderSkipList] Failed to load from disk: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.config.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.sessions.values()).map((s) => ({
        sessionId: s.sessionId,
        entries: Array.from(s.entries.values()),
        updatedAt: s.updatedAt,
      }));
      atomicWriteFileSync(this.config.filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      // 持久化失败不阻塞主流程（skip list 只是优化，不是关键路径）
      process.stderr.write(
        `[ProviderSkipList] Failed to persist: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  private purgeExpired(session: SessionSkipList): void {
    const now = Date.now();
    let changed = false;
    for (const [id, entry] of session.entries) {
      if (now >= entry.expiresAt) {
        session.entries.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}

// ── 单例 ────────────────────────────────────────────────────────────────────

let singleton: ProviderSkipList | null = null;

export function getProviderSkipList(config?: Partial<ProviderSkipListConfig>): ProviderSkipList {
  if (!singleton) {
    singleton = new ProviderSkipList(config);
  } else if (config) {
    // 更新配置（主要用于测试）
    const old = singleton;
    singleton = new ProviderSkipList(config);
    // 保留已加载的数据
    void old;
  }
  return singleton;
}

export function resetProviderSkipList(): void {
  singleton = null;
}
