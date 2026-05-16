import { type ShortTermMemory } from "@evoclaw/core";

export class ShortTermMemoryStore implements ShortTermMemory {
  private store = new Map<string, { value: unknown; expiresAt: number | null }>();

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    const expiresAt = ttl ? Date.now() + ttl : null;
    this.store.set(key, { value, expiresAt });
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

    const regex = new RegExp(pattern.replace(/\*/g, ".*"));
    return allKeys.filter((k) => regex.test(k));
  }
}