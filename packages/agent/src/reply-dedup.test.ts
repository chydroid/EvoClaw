import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ReplyDeduplicator, areMessagesDuplicate } from "./reply-dedup";

describe("ReplyDeduplicator", () => {
  let dedup: ReplyDeduplicator;

  beforeEach(() => {
    dedup = new ReplyDeduplicator();
  });

  describe("Basic Deduplication", () => {
    it("should return process action for first message", () => {
      const result = dedup.check("Hello world", "webchat", "session-1");
      expect(result.isDuplicate).toBe(false);
      expect(result.action).toBe("process");
    });

    it("should detect exact duplicate in same session/channel", () => {
      dedup.check("Hello world", "webchat", "session-1");
      const result = dedup.check("Hello world", "webchat", "session-1");
      expect(result.isDuplicate).toBe(true);
      expect(result.action).toBe("skip");
    });

    it("should normalize whitespace for dedup", () => {
      dedup.check("Hello   world", "webchat", "session-1");
      const result = dedup.check("Hello world", "webchat", "session-1");
      expect(result.isDuplicate).toBe(true);
    });

    it("should case-fold for dedup", () => {
      dedup.check("HELLO WORLD", "webchat", "session-1");
      const result = dedup.check("hello world", "webchat", "session-1");
      expect(result.isDuplicate).toBe(true);
    });

    it("should strip emojis for dedup", () => {
      dedup.check("Hello world 😊", "webchat", "session-1");
      const result = dedup.check("Hello world 🎉", "webchat", "session-1");
      expect(result.isDuplicate).toBe(true);
    });

    it("should not match different messages", () => {
      dedup.check("Hello world", "webchat", "session-1");
      const result = dedup.check("Goodbye world", "webchat", "session-1");
      expect(result.isDuplicate).toBe(false);
      expect(result.action).toBe("process");
    });
  });

  describe("Cross-Session / Cross-Channel", () => {
    it("should warn on cross-session duplicate", () => {
      dedup.check("Deploy to production", "webchat", "session-1");
      const result = dedup.check("Deploy to production", "webchat", "session-2");
      // Same channel but different session, within half window
      expect(result.isDuplicate).toBe(true);
      expect(result.action).toBe("warn");
    });

    it("should allow different channel same message", () => {
      dedup.check("Hello", "discord", "session-1");
      // Same session, different channel — flags as cross-channel possible duplicate
      const result = dedup.check("Hello", "telegram", "session-1");
      expect(result.isDuplicate).toBe(true);
      expect(result.action).toBe("warn");
    });
  });

  describe("Hash Computation", () => {
    it("should generate deterministic hash", () => {
      const hash1 = dedup.computeHash("Hello world");
      const hash2 = dedup.computeHash("Hello world");
      expect(hash1).toBe(hash2);
    });

    it("should generate different hashes for different content", () => {
      const hash1 = dedup.computeHash("Hello");
      const hash2 = dedup.computeHash("World");
      expect(hash1).not.toBe(hash2);
    });

    it("should normalize before hashing", () => {
      const hash1 = dedup.computeHash("Hello World");
      const hash2 = dedup.computeHash("hello world");
      expect(hash1).toBe(hash2);
    });
  });

  describe("Fuzzy Matching", () => {
    it("should detect near-identical messages", () => {
      // Only last character differs (! vs ?) — Jaccard ≈ 0.92
      const result = dedup.isFuzzyDuplicate(
        "Hello world, how are you?",
        "Hello world, how are you!",
        0.9
      );
      expect(result).toBe(true);
    });

    it("should not match very different messages", () => {
      const result = dedup.isFuzzyDuplicate(
        "Hello world",
        "Goodbye everyone",
        0.9
      );
      expect(result).toBe(false);
    });

    it("should handle identical messages with perfect similarity", () => {
      const result = dedup.isFuzzyDuplicate(
        "Hello world",
        "Hello world",
        0.9
      );
      expect(result).toBe(true);
    });
  });

  describe("Cache Management", () => {
    it("should clear all entries", () => {
      dedup.check("Msg1", "webchat", "s1");
      dedup.check("Msg2", "webchat", "s1");

      dedup.clear();
      const stats = dedup.getStats();
      expect(stats.totalEntries).toBe(0);
    });

    it("should clear specific session entries", () => {
      dedup.check("A", "webchat", "s1");
      dedup.check("B", "webchat", "s2");

      dedup.clearSession("s1");
      const stats = dedup.getStats();
      expect(stats.totalEntries).toBe(1);
    });

    it("should report stats", () => {
      dedup.check("Msg1", "webchat", "s1");
      dedup.check("Msg2", "webchat", "s1");

      const stats = dedup.getStats();
      expect(stats.totalEntries).toBe(2);
      expect(stats.oldestEntry).toBeDefined();
    });

    it("should respect max cache size", () => {
      const smallDedup = new ReplyDeduplicator({ maxCacheSize: 3 });
      smallDedup.check("A", "webchat", "s1");
      smallDedup.check("B", "webchat", "s1");
      smallDedup.check("C", "webchat", "s1");
      smallDedup.check("D", "webchat", "s1");

      const stats = smallDedup.getStats();
      expect(stats.totalEntries).toBeLessThanOrEqual(3);
    });

    it("should expire old entries", async () => {
      const shortDedup = new ReplyDeduplicator({ dedupWindowMs: 10 });

      shortDedup.check("Msg1", "webchat", "s1");

      // Wait for entries to expire
      await new Promise((resolve) => setTimeout(resolve, 20));

      const stats = shortDedup.getStats();
      expect(stats.totalEntries).toBe(0);
    });
  });

  describe("Configuration", () => {
    it("should update configuration", () => {
      const hashBefore = dedup.computeHash("Hello World");
      dedup.configure({ caseFold: false, dedupWindowMs: 60000, maxCacheSize: 100 });
      const hashAfter = dedup.computeHash("Hello World");
      // caseFold changed from true (default) to false, so the normalized
      // input differs and the hash must change.
      expect(hashAfter).not.toBe(hashBefore);
      // Instance still functions after reconfigure.
      const result = dedup.check("test", "webchat", "s1");
      expect(result.action).toBe("process");
    });

    it("should respect caseFold config", () => {
      const caseSensitive = new ReplyDeduplicator({ caseFold: false });
      caseSensitive.check("Hello", "webchat", "s1");
      const result = caseSensitive.check("hello", "webchat", "s1");
      // With caseFold off, "Hello" and "hello" produce different hashes,
      // so the second message is not a duplicate.
      expect(result.isDuplicate).toBe(false);
      expect(result.action).toBe("process");
    });
  });

  describe("Utility Function", () => {
    it("areMessagesDuplicate should detect duplicates", () => {
      expect(areMessagesDuplicate("Hello world", "Hello world")).toBe(true);
      expect(areMessagesDuplicate("Hello   world", "Hello world")).toBe(true);
      expect(areMessagesDuplicate("HELLO WORLD", "hello world")).toBe(true);
      expect(areMessagesDuplicate("Hello", "World")).toBe(false);
    });
  });
});