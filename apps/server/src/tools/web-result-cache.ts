/**
 * web_search / web_fetch 结果缓存（对标 hermes-agent `tools/web_result_cache.py`）。
 *
 * 两部分：
 * - **SearchMemo**：进程内、单飞（single-flight）、TTL 有界的搜索结果记忆。
 *   并发相同的查询共享同一次付费请求；limit 归入 10/20/50/100 桶，使近似请求命中同一条目。
 *   仅成功结果入缓存。
 * - **ExtractCache**：磁盘（`data/cache/web/extract`）跨进程的网页抓取缓存，JSON sidecar 索引
 *   + TTL。命中时**跳过厂商/网络抓取**，仍由调用方重跑安全校验与截断管道（安全不变式）。
 *   **默认关闭**（opt-in），避免把陈旧页面内容当作实时结果。
 *
 * 落点在本模块而非工具分发层：命中发生在所有安全检查之后，只跳过昂贵的外部调用。
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { atomicWriteFileSync } from "@evoclaw/core";

// ── 配置 ──────────────────────────────────────────────────

export interface WebCacheConfig {
  /** 是否启用磁盘抓取缓存（默认 false） */
  extractEnabled: boolean;
  /** 抓取缓存 TTL（分钟，默认 20） */
  extractTtlMinutes: number;
  /** 搜索记忆 TTL（分钟，默认 20） */
  searchMemoTtlMinutes: number;
}

export const DEFAULT_WEB_CACHE_CONFIG: WebCacheConfig = {
  extractEnabled: false,
  extractTtlMinutes: 20,
  searchMemoTtlMinutes: 20,
};

function parsePositiveInt(raw: string | undefined): number | null {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 从环境变量解析缓存配置（非法值回落默认）。 */
export function resolveWebCacheConfig(env: NodeJS.ProcessEnv = process.env): WebCacheConfig {
  const enabledRaw = String(env.EVOCLAW_WEB_CACHE_ENABLED ?? "").trim().toLowerCase();
  const extractEnabled = enabledRaw === "1" || enabledRaw === "true" || enabledRaw === "yes";
  return {
    extractEnabled,
    extractTtlMinutes: parsePositiveInt(env.EVOCLAW_WEB_CACHE_TTL_MINUTES) ?? DEFAULT_WEB_CACHE_CONFIG.extractTtlMinutes,
    searchMemoTtlMinutes: parsePositiveInt(env.EVOCLAW_WEB_SEARCH_MEMO_TTL_MINUTES) ?? DEFAULT_WEB_CACHE_CONFIG.searchMemoTtlMinutes,
  };
}

// ── SearchMemo：进程内单飞记忆 ─────────────────────────────

interface MemoEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * 进程内 TTL 记忆 + 单飞。
 *
 * `run(key, fn, isSuccess)`：命中未过期 → 直接返回；否则若已有同 key 在飞行中 → 共享该 Promise；
 * 否则执行 fn 并在成功（isSuccess 默认 `v => v !== undefined`）且非空时写入缓存。
 */
export class SearchMemo<T = unknown> {
  private entries = new Map<string, MemoEntry<T>>();
  private inflight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = Number.isFinite(opts.ttlMs) && (opts.ttlMs ?? 0) > 0 ? opts.ttlMs! : 20 * 60 * 1000;
    this.maxEntries = Number.isFinite(opts.maxEntries) && (opts.maxEntries ?? 0) > 0 ? opts.maxEntries! : 200;
  }

  /** 读取未过期条目；过期则删除并返回 undefined。 */
  get(key: string, now: number = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU 提升
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** 写入条目（带 TTL 与上限淘汰）。 */
  set(key: string, value: T, now: number = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /**
   * 单飞执行：并发相同 key 只真正执行一次。
   * @param isSuccess 结果是否值得缓存（默认非 undefined）
   */
  async run(key: string, fn: () => Promise<T>, isSuccess: (v: T) => boolean = (v) => v !== undefined): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const value = await fn();
        if (isSuccess(value)) this.set(key, value);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  /** 当前条目数（测试用）。 */
  size(): number {
    return this.entries.size;
  }

  /** 清空（测试用）。 */
  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}

/** 构造搜索缓存键：查询归一化 + limit 归桶 + freshness。 */
export function buildSearchMemoKey(parts: { query: string; limit: number; freshness?: string }): string {
  const query = parts.query.trim().replace(/\s+/g, " ").toLowerCase();
  // limit 归入向上取整的桶，使 10/20/50/100 附近的近似请求共享条目
  const buckets = [10, 20, 50, 100];
  const bucket = buckets.find((b) => parts.limit <= b) ?? 100;
  const freshness = (parts.freshness ?? "").trim().toLowerCase();
  return `${query}|${bucket}|${freshness}`;
}

// ── ExtractCache：磁盘跨进程抓取缓存 ───────────────────────

export interface ExtractedPage {
  url: string;
  title: string;
  text: string;
  fetchedAt: number;
}

interface ExtractIndexEntry {
  file: string;
  fetchedAt: number;
  title: string;
}

interface ExtractIndex {
  entries: Record<string, ExtractIndexEntry>;
}

const INDEX_FILENAME = "index.json";
const INDEX_MAX_ENTRIES = 500;

export function defaultExtractCacheDir(cwd: string = process.cwd()): string {
  return path.join(cwd, "data", "cache", "web", "extract");
}

function urlDigest(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 24);
}

/**
 * 磁盘抓取缓存（跨进程，TTL 有界，JSON sidecar 索引）。
 *
 * 命中时返回缓存页面；调用方仍须重跑 SSRF 与截断管道。
 */
export class ExtractCache {
  private readonly dir: string;
  private readonly ttlMs: number;

  constructor(dir: string = defaultExtractCacheDir(), ttlMs: number = 20 * 60 * 1000) {
    this.dir = dir;
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 20 * 60 * 1000;
  }

  private indexPath(): string {
    return path.join(this.dir, INDEX_FILENAME);
  }

  private readIndex(): ExtractIndex {
    try {
      const raw = fs.readFileSync(this.indexPath(), "utf-8");
      const parsed = JSON.parse(raw) as ExtractIndex;
      if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
        return parsed;
      }
    } catch {
      // 缺失 / 损坏 → 空索引
    }
    return { entries: {} };
  }

  private writeIndex(index: ExtractIndex): void {
    atomicWriteFileSync(this.indexPath(), JSON.stringify(index), { encoding: "utf-8", mode: 0o600 });
  }

  /** 读取未过期的缓存页面；无缓存/过期返回 null。 */
  get(url: string, now: number = Date.now()): ExtractedPage | null {
    const digest = urlDigest(url);
    const index = this.readIndex();
    const entry = index.entries[digest];
    if (!entry) return null;
    if (now - entry.fetchedAt > this.ttlMs) {
      // 过期：清理索引（数据文件随淘汰/覆盖处理）
      delete index.entries[digest];
      try { this.writeIndex(index); } catch { /* 索引写失败不阻断读取 */ }
      return null;
    }
    try {
      const raw = fs.readFileSync(path.join(this.dir, entry.file), "utf-8");
      const page = JSON.parse(raw) as ExtractedPage;
      if (page && typeof page.text === "string") return page;
    } catch {
      // 数据文件缺失/损坏 → 当作未命中
    }
    return null;
  }

  /** 写入一次抓取结果。 */
  set(url: string, page: { title: string; text: string }, now: number = Date.now()): void {
    try {
      const digest = urlDigest(url);
      const file = `${digest}.json`;
      const payload: ExtractedPage = { url, title: page.title, text: page.text, fetchedAt: now };
      atomicWriteFileSync(path.join(this.dir, file), JSON.stringify(payload), { encoding: "utf-8", mode: 0o600 });
      const index = this.readIndex();
      index.entries[digest] = { file, fetchedAt: now, title: page.title };
      this.evictIfNeeded(index);
      this.writeIndex(index);
    } catch (err) {
      process.stderr.write(`[web_cache] extract set failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  private evictIfNeeded(index: ExtractIndex): void {
    const keys = Object.keys(index.entries);
    if (keys.length <= INDEX_MAX_ENTRIES) return;
    // 按 fetchedAt 升序淘汰最旧
    keys.sort((a, b) => index.entries[a].fetchedAt - index.entries[b].fetchedAt);
    const excess = keys.length - INDEX_MAX_ENTRIES;
    for (let i = 0; i < excess; i++) {
      const k = keys[i];
      const entry = index.entries[k];
      if (entry) {
        try { fs.unlinkSync(path.join(this.dir, entry.file)); } catch { /* 已不存在 */ }
      }
      delete index.entries[k];
    }
  }
}
