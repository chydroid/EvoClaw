/**
 * LRU Cache — generic Least-Recently-Used cache with TTL support,
 * max-size eviction, and event hooks.
 *
 * Features:
 *  - LRU eviction when exceeding max size
 *  - TTL (time-to-live) per entry with lazy expiration
 *  - On-evict callback for cleanup
 *  - get/set/delete/has/clear operations
 *  - Cache statistics (hits, misses, evictions)
 *  - Manual eviction sweep
 *  - Entry-level TTL override
 */

// ── Types ─────────────────────────────────────────────────

export interface CacheEntry<V> {
  key: string;
  value: V;
  /** When the entry was created/updated (epoch ms) */
  createdAt: number;
  /** When the entry was last accessed (epoch ms) */
  lastAccessedAt: number;
  /** TTL in ms (0 = no expiry) */
  ttlMs: number;
}

export interface LRUCacheConfig {
  /** Maximum number of entries */
  maxSize: number;
  /** Default TTL in ms (0 = never expire) */
  defaultTTLMs: number;
  /** Whether to refresh TTL on get */
  refreshOnAccess: boolean;
  /** Whether to refresh TTL on set */
  refreshOnSet: boolean;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
  hitRate: number;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: LRUCacheConfig = {
  maxSize: 1000,
  defaultTTLMs: 0,
  refreshOnAccess: false,
  refreshOnSet: true,
};

// ── Cache ─────────────────────────────────────────────────

export class LRUCache<V> {
  private static readonly MAX_INFLIGHT = 10000;
  private config: LRUCacheConfig;
  private map = new Map<string, DoublyLinkedNode<V>>();
  private head: DoublyLinkedNode<V> | null = null;
  private tail: DoublyLinkedNode<V> | null = null;
  // getOrSet 的 in-flight Promise 去重表，防止并发同 key 重复执行 factory
  private inflight = new Map<string, Promise<V>>();

  private stats: CacheStats = {
    size: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
    hitRate: 0,
  };

  private onEvict?: (key: string, value: V, expired?: boolean) => void;

  constructor(config?: Partial<LRUCacheConfig>, onEvict?: (key: string, value: V, expired?: boolean) => void) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onEvict = onEvict;
  }

  /**
   * Get a value from the cache. Returns undefined if not found or expired.
   */
  get(key: string): V | undefined {
    const node = this.map.get(key);
    if (!node) {
      this.stats.misses++;
      this.updateHitRate();
      return undefined;
    }

    const entry = node.entry;

    // Check TTL
    if (this.isExpired(entry)) {
      this.delete(key, true);
      this.stats.misses++;
      this.updateHitRate();
      return undefined;
    }

    // Refresh access time
    if (this.config.refreshOnAccess) {
      entry.lastAccessedAt = Date.now();
      entry.createdAt = Date.now(); // Refresh TTL start
    } else {
      entry.lastAccessedAt = Date.now();
    }

    // Move to front (MRU)
    this.moveToFront(node);

    this.stats.hits++;
    this.updateHitRate();
    return entry.value;
  }

  /**
   * Set a value. Optionally override TTL for this entry.
   */
  set(key: string, value: V, ttlMs?: number): void {
    if (this.config.maxSize <= 0) return;

    const existing = this.map.get(key);

    if (existing) {
      // Update existing
      existing.entry.value = value;
      if (this.config.refreshOnSet) {
        existing.entry.createdAt = Date.now();
      }
      existing.entry.lastAccessedAt = Date.now();
      existing.entry.ttlMs = ttlMs ?? this.config.defaultTTLMs;

      this.moveToFront(existing);
      return;
    }

    // Evict if at capacity
    while (this.map.size >= this.config.maxSize) {
      this.evictLRU();
    }

    const now = Date.now();
    const entry: CacheEntry<V> = {
      key,
      value,
      createdAt: now,
      lastAccessedAt: now,
      ttlMs: ttlMs ?? this.config.defaultTTLMs,
    };

    const node: DoublyLinkedNode<V> = { entry, prev: null, next: null };
    this.map.set(key, node);

    // Insert at head (MRU)
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;

    this.stats.size = this.map.size;
  }

  /**
   * Get or set — if key exists and not expired, return its value.
   * Otherwise compute and store the value.
   *
   * 并发同 key 调用会复用同一个 in-flight Promise，避免重复执行 factory
   * （factory 可能有副作用或远端配额消耗）。
   */
  async getOrSet(
    key: string,
    factory: () => Promise<V>,
    ttlMs?: number,
  ): Promise<V> {
    const existing = this.get(key);
    if (existing !== undefined) return existing;

    // in-flight 去重：多个并发调用同一 key 时共享同一个 Promise
    const inflight = this.inflight.get(key);
    if (inflight) return inflight as Promise<V>;

    // 若并发去重表已达上限，不再新增 in-flight 条目，直接执行 factory。
    // 这避免了在工厂运行期间删除其他 key 的 in-flight Promise，导致缓存雪崩。
    if (this.inflight.size >= LRUCache.MAX_INFLIGHT) {
      const value = await factory();
      this.set(key, value, ttlMs);
      return value;
    }

    // 先 set 占位 Promise 再执行 factory，避免 factory 同步抛出时
    // try/finally 在 inflight.set 之前运行导致该条目永久残留
    let resolveFn!: (v: V) => void;
    let rejectFn!: (e: unknown) => void;
    const p = new Promise<V>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    this.inflight.set(key, p);

    (async () => {
      try {
        const value = await factory();
        this.set(key, value, ttlMs);
        resolveFn(value);
      } catch (err) {
        rejectFn(err);
      } finally {
        this.inflight.delete(key);
      }
    })();

    return p;
  }

  /**
   * Check if key exists and is not expired.
   */
  has(key: string): boolean {
    const node = this.map.get(key);
    if (!node) return false;
    if (this.isExpired(node.entry)) {
      this.delete(key, true);
      return false;
    }
    return true;
  }

  /**
   * Delete a key.
   *
   * @param expired 标记本次删除是否因 TTL 过期触发。无论哪种场景都会调用 onEvict
   *               （回调可自行判断是否忽略 expired 触发的驱逐），避免 sweep 与
   *               get/has 中的过期清理路径绕过资源回收回调造成泄漏。
   */
  delete(key: string, expired = false): boolean {
    const node = this.map.get(key);
    if (!node) return false;

    this.unlink(node);
    this.map.delete(key);

    if (this.onEvict) {
      this.onEvict(key, node.entry.value, expired);
    }

    this.stats.size = this.map.size;
    return true;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    const keys = [...this.map.keys()];
    for (const key of keys) {
      this.delete(key);
    }
    this.head = null;
    this.tail = null;
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.evictions = 0;
    this.stats.size = 0;
  }

  /**
   * Manually evict all expired entries. Returns count evicted.
   */
  sweep(): number {
    let count = 0;
    const keys = [...this.map.keys()];
    for (const key of keys) {
      const node = this.map.get(key);
      if (node && this.isExpired(node.entry)) {
        this.delete(key, true);
        count++;
      }
    }
    this.stats.evictions += count;
    return count;
  }

  /**
   * Get all keys (non-expired).
   */
  keys(): string[] {
    // Sweep expired first for accuracy
    const keys: string[] = [];
    for (const [key, node] of this.map) {
      if (!this.isExpired(node.entry)) {
        keys.push(key);
      }
    }
    return keys;
  }

  /**
   * Get number of entries (non-expired).
   *
   * 已知性能限制：本 getter 为 O(n)——需遍历全部条目过滤已过期项以保证计数准确
   * （过期是惰性的，无独立计数器维护）。在条目数极大且频繁读取 size 的场景下，
   * 可先调用 purgeExpired() 再用 this.map.size 近似，或引入显式计数器。
   */
  get size(): number {
    return this.keys().length;
  }

  /**
   * Get cache stats.
   */
  getStats(): CacheStats {
    return { ...this.stats, size: this.size };
  }

  /**
   * Get all entries as [key, value] pairs.
   */
  entries(): Array<[string, V]> {
    const result: Array<[string, V]> = [];
    for (const [key, node] of this.map) {
      if (!this.isExpired(node.entry)) {
        result.push([key, node.entry.value]);
      }
    }
    return result;
  }

  configure(updates: Partial<LRUCacheConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ── Private ─────────────────────────────────────────────

  private isExpired(entry: CacheEntry<V>): boolean {
    if (entry.ttlMs <= 0) return false;
    return Date.now() - entry.createdAt > entry.ttlMs;
  }

  private moveToFront(node: DoublyLinkedNode<V>): void {
    if (node === this.head) return; // Already at front

    this.unlink(node);

    node.next = this.head;
    node.prev = null;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private unlink(node: DoublyLinkedNode<V>): void {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (this.head === node) this.head = node.next;
    if (this.tail === node) this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  private evictLRU(): void {
    const lru = this.tail;
    if (!lru) return;

    this.unlink(lru);
    this.map.delete(lru.entry.key);

    this.stats.evictions++;

    if (this.onEvict) {
      this.onEvict(lru.entry.key, lru.entry.value);
    }
  }

  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }
}

// ── Doubly-Linked List Node (internal) ────────────────────

interface DoublyLinkedNode<V> {
  entry: CacheEntry<V>;
  prev: DoublyLinkedNode<V> | null;
  next: DoublyLinkedNode<V> | null;
}