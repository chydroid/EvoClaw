/**
 * Tool Result Cache — 工具结果缓存。
 *
 * 借鉴 Cursor / Continue / Aider 的工具结果缓存机制：
 * - 对确定性工具（read_file, list_dir, search 等只读操作）的结果做 LRU 缓存
 * - 非确定性工具（write, delete, execute 等有副作用的操作）跳过缓存
 * - TTL 过期 + LRU 淘汰，防止缓存无限增长
 * - 支持手动失效（写入操作后主动清除相关缓存）
 *
 * 收益：
 * - 减少重复工具调用的 API 成本（特别是 browser, web_search 等昂贵操作）
 * - 加快 Agent 响应速度（同一问题的工具调用直接命中缓存）
 * - 减少 LLM token 消耗（工具结果不重复返回）
 */

/** 缓存条目 */
interface CacheEntry {
  /** 缓存键（toolName + params hash） */
  key: string;
  /** 工具名 */
  toolName: string;
  /** 缓存的结果 */
  result: unknown;
  /** 创建时间戳 */
  createdAt: number;
  /** 最后访问时间戳（用于 LRU） */
  accessedAt: number;
  /** 命中次数 */
  hitCount: number;
}

/** Tool Result Cache 配置 */
export interface ToolResultCacheOptions {
  /** 最大缓存条目数（LRU 淘汰）。默认 200。 */
  maxEntries?: number;
  /** 默认 TTL（毫秒）。默认 5 分钟。 */
  defaultTtlMs?: number;
  /** 单工具 TTL 覆盖（按工具名）。 */
  ttlOverrides?: Record<string, number>;
  /** 跳过缓存的工具名（黑名单，如 write/delete/exec 等有副作用的工具）。 */
  skipCacheTools?: string[];
  /** 仅缓存这些工具（白名单，优先于黑名单）。 */
  onlyCacheTools?: string[];
}

const DEFAULT_OPTIONS: Required<Omit<ToolResultCacheOptions, "ttlOverrides" | "onlyCacheTools">> = {
  maxEntries: 200,
  defaultTtlMs: 5 * 60 * 1000,
  skipCacheTools: [
    "write_file",
    "edit_file",
    "delete_file",
    "execute_command",
    "execute_shell",
    "shell_exec",
    "send_message",
    "send_email",
    "create_session",
    "delete_session",
    "reset_session",
    "install_skill",
    "uninstall_skill",
    "publish_skill",
    "submit_review",
    "approve_request",
    "deny_request",
  ],
};

/** 缓存统计 */
export interface CacheStats {
  /** 当前缓存条目数 */
  size: number;
  /** 总命中次数 */
  hits: number;
  /** 总未命中次数 */
  misses: number;
  /** 命中率 */
  hitRate: number;
  /** 按工具统计命中/未命中 */
  byTool: Record<string, { hits: number; misses: number }>;
}

/**
 * 工具结果缓存。线程安全（单进程 Node.js 事件循环保证）。
 *
 * 使用方式：
 * ```ts
 * const cache = new ToolResultCache({ maxEntries: 100 });
 *
 * // 执行工具前查询缓存
 * const cached = cache.get("read_file", { path: "/foo.txt" });
 * if (cached.hit) {
 *   return cached.value;
 * }
 * const result = await executeTool(...);
 * cache.set("read_file", { path: "/foo.txt" }, result);
 * ```
 */
export class ToolResultCache {
  private opts: typeof DEFAULT_OPTIONS & Pick<ToolResultCacheOptions, "ttlOverrides" | "onlyCacheTools">;
  private cache = new Map<string, CacheEntry>();
  private stats = {
    hits: 0,
    misses: 0,
    byTool: new Map<string, { hits: number; misses: number }>(),
  };

  constructor(options: ToolResultCacheOptions = {}) {
    this.opts = {
      ...DEFAULT_OPTIONS,
      ...options,
      ttlOverrides: options.ttlOverrides ?? {},
      onlyCacheTools: options.onlyCacheTools,
    };
  }

  /** 判断工具是否应被缓存 */
  shouldCache(toolName: string): boolean {
    // 白名单优先
    if (this.opts.onlyCacheTools && this.opts.onlyCacheTools.length > 0) {
      return this.opts.onlyCacheTools.includes(toolName);
    }
    return !this.opts.skipCacheTools.includes(toolName);
  }

  /** 计算缓存键 */
  private computeKey(toolName: string, params: Record<string, unknown>): string {
    // 稳定排序参数键，确保相同参数生成相同 key
    const sortedParams = JSON.stringify(params, Object.keys(params).sort());
    return `${toolName}:${sortedParams}`;
  }

  /** 查询缓存 */
  get(toolName: string, params: Record<string, unknown>): { hit: boolean; value?: unknown } {
    if (!this.shouldCache(toolName)) {
      this.recordMiss(toolName);
      return { hit: false };
    }

    const key = this.computeKey(toolName, params);
    const entry = this.cache.get(key);

    if (!entry) {
      this.recordMiss(toolName);
      return { hit: false };
    }

    const now = Date.now();
    const ttl = this.opts.ttlOverrides?.[toolName] ?? this.opts.defaultTtlMs;
    if (now - entry.createdAt > ttl) {
      // TTL 过期
      this.cache.delete(key);
      this.recordMiss(toolName);
      return { hit: false };
    }

    // 命中：更新访问时间 + 命中计数
    entry.accessedAt = now;
    entry.hitCount++;
    this.stats.hits++;
    this.stats.byTool.get(toolName)!.hits++;

    // LRU：移到 Map 末尾（Map 按插入顺序遍历，末尾是最近访问）
    this.cache.delete(key);
    this.cache.set(key, entry);

    return { hit: true, value: entry.result };
  }

  /** 写入缓存 */
  set(toolName: string, params: Record<string, unknown>, result: unknown): void {
    if (!this.shouldCache(toolName)) return;

    const key = this.computeKey(toolName, params);
    const now = Date.now();

    // LRU 淘汰：超过 maxEntries 时删除最旧（Map 第一个）
    if (this.cache.size >= this.opts.maxEntries && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    // 确保 byTool 统计条目存在（get 命中时会递增 hits）
    if (!this.stats.byTool.has(toolName)) {
      this.stats.byTool.set(toolName, { hits: 0, misses: 0 });
    }

    this.cache.set(key, {
      key,
      toolName,
      result,
      createdAt: now,
      accessedAt: now,
      hitCount: 0,
    });
  }

  /** 失效指定工具的所有缓存（写入操作后调用） */
  invalidateTool(toolName: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.toolName === toolName) {
        this.cache.delete(key);
      }
    }
  }

  /** 失效全部缓存 */
  clear(): void {
    this.cache.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.byTool.clear();
  }

  /** 获取缓存统计 */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    const byTool: Record<string, { hits: number; misses: number }> = {};
    for (const [name, s] of this.stats.byTool) {
      byTool[name] = { hits: s.hits, misses: s.misses };
    }
    return {
      size: this.cache.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      byTool,
    };
  }

  /** 记录未命中 */
  private recordMiss(toolName: string): void {
    this.stats.misses++;
    let s = this.stats.byTool.get(toolName);
    if (!s) {
      s = { hits: 0, misses: 0 };
      this.stats.byTool.set(toolName, s);
    }
    s.misses++;
  }
}
