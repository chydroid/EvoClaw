import { type ShortTermMemory } from "@evoclaw/core";

export class ShortTermMemoryStore implements ShortTermMemory {
  private store = new Map<string, { value: unknown; expiresAt: number | null }>();
  private cleanupInterval: NodeJS.Timeout;
  /** store Map 的容量上限，防止无 TTL 条目永不过期导致内存泄漏 */
  private static readonly MAX_ENTRIES = 10000;

  constructor() {
    this.cleanupInterval = setInterval(() => {
      try { this.cleanup(); } catch (err) {
        process.stderr.write(`[ShortTermMemory] cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }, 60_000);
    this.cleanupInterval.unref();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    const expiresAt = ttl ? Date.now() + ttl : null;
    this.store.set(key, { value, expiresAt });

    // LRU 上限保护：超过容量时删除最旧的条目（Map 按插入顺序保留首个条目）
    if (this.store.size > ShortTermMemoryStore.MAX_ENTRIES) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value as T;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async keys(pattern: string): Promise<string[]> {
    const allKeys = Array.from(this.store.keys());
    if (pattern === "*") return allKeys;

    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const regex = new RegExp(`^${escaped}$`);
    return allKeys.filter((k) => regex.test(k));
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}
