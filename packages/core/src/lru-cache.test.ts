import { describe, it, expect, beforeEach, vi } from "vitest";
import { LRUCache } from "./lru-cache";

describe("LRUCache", () => {
  let cache: LRUCache<string>;

  beforeEach(() => {
    cache = new LRUCache<string>({ maxSize: 5, defaultTTLMs: 0 });
  });

  describe("set/get", () => {
    it("should set and get a value", () => {
      cache.set("a", "apple");
      expect(cache.get("a")).toBe("apple");
    });

    it("should return undefined for missing key", () => {
      expect(cache.get("missing")).toBeUndefined();
    });

    it("should overwrite existing key", () => {
      cache.set("a", "apple");
      cache.set("a", "apricot");
      expect(cache.get("a")).toBe("apricot");
    });

    it("should update access order on set", () => {
      cache.set("a", "1");
      cache.set("b", "2");
      cache.set("c", "3");
      cache.set("d", "4");
      cache.set("e", "5");

      // Access "a" to make it MRU
      cache.get("a");

      // Insert new — should evict LRU ("b")
      cache.set("f", "6");

      expect(cache.get("a")).toBe("1"); // Still present (accessed)
      expect(cache.get("b")).toBeUndefined(); // Evicted
      expect(cache.get("f")).toBe("6");
    });
  });

  describe("LRU eviction", () => {
    it("should evict least recently used when full", () => {
      cache.set("a", "1");
      cache.set("b", "2");
      cache.set("c", "3");
      cache.set("d", "4");
      cache.set("e", "5");

      // "a" is LRU (inserted first)
      cache.set("f", "6");

      expect(cache.get("a")).toBeUndefined(); // Evicted
      expect(cache.size).toBe(5);
    });

    it("should call onEvict callback", () => {
      const onEvict = vi.fn();
      const evictCache = new LRUCache<string>({ maxSize: 2 }, onEvict);

      evictCache.set("a", "1");
      evictCache.set("b", "2");
      evictCache.set("c", "3"); // Evicts "a"

      expect(onEvict).toHaveBeenCalledWith("a", "1");
    });
  });

  describe("has", () => {
    it("should return true for existing key", () => {
      cache.set("x", "y");
      expect(cache.has("x")).toBe(true);
    });

    it("should return false for missing key", () => {
      expect(cache.has("z")).toBe(false);
    });
  });

  describe("delete", () => {
    it("should delete a key", () => {
      cache.set("a", "1");
      expect(cache.delete("a")).toBe(true);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    it("should return false for missing key", () => {
      expect(cache.delete("z")).toBe(false);
    });
  });

  describe("clear", () => {
    it("should clear all entries", () => {
      cache.set("a", "1");
      cache.set("b", "2");
      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.get("a")).toBeUndefined();
    });
  });

  describe("TTL", () => {
    it("should expire entries after TTL", async () => {
      const ttlCache = new LRUCache<string>({ maxSize: 10, defaultTTLMs: 50 });

      ttlCache.set("x", "value");
      expect(ttlCache.get("x")).toBe("value");

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 60));

      expect(ttlCache.get("x")).toBeUndefined();
    });

    it("should respect per-entry TTL override", async () => {
      const ttlCache = new LRUCache<string>({ maxSize: 10, defaultTTLMs: 5000 });

      ttlCache.set("x", "value", 50); // Short TTL
      expect(ttlCache.get("x")).toBe("value");

      await new Promise((r) => setTimeout(r, 60));
      expect(ttlCache.get("x")).toBeUndefined();
    });

    it("should refresh TTL on access when configured", async () => {
      const ttlCache = new LRUCache<string>({
        maxSize: 10,
        defaultTTLMs: 100,
        refreshOnAccess: true,
      });

      ttlCache.set("x", "value");
      await new Promise((r) => setTimeout(r, 60));
      ttlCache.get("x"); // Refreshes TTL
      await new Promise((r) => setTimeout(r, 60));
      expect(ttlCache.get("x")).toBe("value"); // Still valid
    });
  });

  describe("keys/entries", () => {
    it("should list all keys", () => {
      cache.set("a", "1");
      cache.set("b", "2");
      cache.set("c", "3");

      expect(cache.keys().sort()).toEqual(["a", "b", "c"]);
    });

    it("should list all entries", () => {
      cache.set("a", "1");
      cache.set("b", "2");

      const entries = cache.entries();
      expect(entries.length).toBe(2);
      expect(entries.map(([k]) => k).sort()).toEqual(["a", "b"]);
    });
  });

  describe("sweep", () => {
    it("should evict expired entries", async () => {
      const ttlCache = new LRUCache<string>({ maxSize: 10, defaultTTLMs: 50 });
      ttlCache.set("a", "1");
      ttlCache.set("b", "2");

      await new Promise((r) => setTimeout(r, 60));

      const swept = ttlCache.sweep();
      expect(swept).toBe(2);
      expect(ttlCache.size).toBe(0);
    });
  });

  describe("stats", () => {
    it("should track hits and misses", () => {
      cache.set("a", "1");
      cache.get("a"); // hit
      cache.get("b"); // miss
      cache.get("a"); // hit

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe(2 / 3);
    });
  });

  describe("getOrSet", () => {
    it("should return existing value", async () => {
      cache.set("x", "cached");
      const value = await cache.getOrSet("x", async () => "fresh");
      expect(value).toBe("cached");
    });

    it("should compute and cache new value", async () => {
      let factoryCalls = 0;
      const factory = async () => {
        factoryCalls++;
        return "fresh";
      };

      const value = await cache.getOrSet("new-key", factory);
      expect(value).toBe("fresh");
      expect(factoryCalls).toBe(1);

      const cached = await cache.getOrSet("new-key", factory);
      expect(cached).toBe("fresh");
      expect(factoryCalls).toBe(1); // Factory called only once
    });
  });
});