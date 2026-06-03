import { describe, it, expect, beforeEach, vi } from "vitest";
import { CredentialPool } from "./credential-pool";

describe("CredentialPool", () => {
  let pool: CredentialPool;

  beforeEach(() => {
    pool = new CredentialPool();
  });

  it("addCredential and getCredential work together", () => {
    const id = pool.addCredential("openai", "sk-test-key-12345678");
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");

    const cred = pool.getCredential("openai");
    expect(cred).not.toBeNull();
    expect(cred!.key).toBe("sk-test-key-12345678");
    expect(cred!.provider).toBe("openai");
    expect(cred!.active).toBe(true);
  });

  it("getCredential returns null for unknown provider", () => {
    expect(pool.getCredential("unknown")).toBeNull();
  });

  it("addCredential throws when max credentials per provider is reached", () => {
    const smallPool = new CredentialPool({ maxCredentialsPerProvider: 2 });
    smallPool.addCredential("openai", "key-1");
    smallPool.addCredential("openai", "key-2");

    expect(() => smallPool.addCredential("openai", "key-3")).toThrow("Maximum credentials");
  });

  it("round-robin rotation cycles through credentials", () => {
    pool.addCredential("openai", "key-1");
    pool.addCredential("openai", "key-2");
    pool.addCredential("openai", "key-3");

    const first = pool.getCredential("openai");
    const second = pool.getCredential("openai");
    const third = pool.getCredential("openai");
    const fourth = pool.getCredential("openai");

    expect(first!.key).toBe("key-1");
    expect(second!.key).toBe("key-2");
    expect(third!.key).toBe("key-3");
    expect(fourth!.key).toBe("key-1");
  });

  it("round-robin skips rate-limited credentials", () => {
    const id1 = pool.addCredential("openai", "key-1");
    pool.addCredential("openai", "key-2");

    pool.reportError(id1, "rate_limit");

    const cred = pool.getCredential("openai");
    expect(cred!.key).toBe("key-2");
  });

  it("rate limit handling sets rateLimitedUntil", () => {
    const id = pool.addCredential("openai", "key-1");
    pool.reportError(id, "rate_limit");

    const cred = pool.getCredentials("openai")[0];
    expect(cred.rateLimitedUntil).not.toBeNull();
    expect(cred.rateLimitedUntil!).toBeGreaterThan(Date.now());
  });

  it("rate-limited credential becomes available after cooldown", () => {
    const shortCooldown = new CredentialPool({ rateLimitCooldownMs: 10 });
    const id = shortCooldown.addCredential("openai", "key-1");

    shortCooldown.reportError(id, "rate_limit");
    expect(shortCooldown.getAvailableCount("openai")).toBe(0);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        shortCooldown.cleanupRateLimits();
        expect(shortCooldown.getAvailableCount("openai")).toBe(1);
        resolve();
      }, 50);
    });
  });

  it("auth error disables credential", () => {
    const id = pool.addCredential("openai", "key-1");
    pool.reportError(id, "auth");

    const cred = pool.getCredentials("openai")[0];
    expect(cred.active).toBe(false);
    expect(pool.getCredential("openai")).toBeNull();
  });

  it("error count disables after max", () => {
    const smallPool = new CredentialPool({ maxErrorCount: 3 });
    const id = smallPool.addCredential("openai", "key-1");

    smallPool.reportError(id, "server");
    smallPool.reportError(id, "server");
    expect(smallPool.getCredential("openai")).not.toBeNull();

    smallPool.reportError(id, "server");
    const cred = smallPool.getCredentials("openai")[0];
    expect(cred.active).toBe(false);
    expect(smallPool.getCredential("openai")).toBeNull();
  });

  it("unknown error also disables after max", () => {
    const smallPool = new CredentialPool({ maxErrorCount: 2 });
    const id = smallPool.addCredential("openai", "key-1");

    smallPool.reportError(id, "unknown");
    smallPool.reportError(id, "unknown");

    const cred = smallPool.getCredentials("openai")[0];
    expect(cred.active).toBe(false);
  });

  it("reportSuccess resets error count", () => {
    const smallPool = new CredentialPool({ maxErrorCount: 3 });
    const id = smallPool.addCredential("openai", "key-1");

    smallPool.reportError(id, "server");
    smallPool.reportError(id, "server");
    smallPool.reportSuccess(id);

    const cred = smallPool.getCredentials("openai")[0];
    expect(cred.errorCount).toBe(0);
    expect(cred.active).toBe(true);
  });

  it("cleanupRateLimits clears expired rate limits", () => {
    const shortCooldown = new CredentialPool({ rateLimitCooldownMs: 10 });
    const id = shortCooldown.addCredential("openai", "key-1");

    shortCooldown.reportError(id, "rate_limit");

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        shortCooldown.cleanupRateLimits();
        const cred = shortCooldown.getCredentials("openai")[0];
        expect(cred.rateLimitedUntil).toBeNull();
        resolve();
      }, 50);
    });
  });

  it("getStats returns correct counts", () => {
    pool.addCredential("openai", "key-1");
    pool.addCredential("openai", "key-2");
    pool.addCredential("anthropic", "key-3");

    const stats = pool.getStats();
    expect(stats.totalCredentials).toBe(3);
    expect(stats.activeCredentials).toBe(3);
    expect(stats.rateLimitedCredentials).toBe(0);
    expect(stats.disabledCredentials).toBe(0);
  });

  it("getStats tracks rate-limited and disabled credentials", () => {
    const id1 = pool.addCredential("openai", "key-1");
    const id2 = pool.addCredential("openai", "key-2");
    pool.addCredential("anthropic", "key-3");

    pool.reportError(id1, "rate_limit");
    pool.reportError(id2, "auth");

    const stats = pool.getStats();
    expect(stats.totalCredentials).toBe(3);
    expect(stats.rateLimitedCredentials).toBe(1);
    expect(stats.disabledCredentials).toBe(1);
    expect(stats.activeCredentials).toBe(1);
  });

  it("removeCredential removes entry", () => {
    const id = pool.addCredential("openai", "key-1");
    expect(pool.getCredentials("openai").length).toBe(1);

    const removed = pool.removeCredential(id);
    expect(removed).toBe(true);
    expect(pool.getCredentials("openai").length).toBe(0);
  });

  it("removeCredential returns false for non-existent id", () => {
    expect(pool.removeCredential("non-existent")).toBe(false);
  });

  it("removeCredential cleans up empty provider entries", () => {
    const id = pool.addCredential("openai", "key-1");
    pool.removeCredential(id);
    expect(pool.getCredential("openai")).toBeNull();
  });

  it("getAvailableCount returns correct number", () => {
    const id1 = pool.addCredential("openai", "key-1");
    pool.addCredential("openai", "key-2");

    expect(pool.getAvailableCount("openai")).toBe(2);

    pool.reportError(id1, "auth");
    expect(pool.getAvailableCount("openai")).toBe(1);
  });

  it("getAvailableCount returns 0 for unknown provider", () => {
    expect(pool.getAvailableCount("unknown")).toBe(0);
  });

  it("least-used rotation strategy selects least used credential", () => {
    const leastUsedPool = new CredentialPool({ rotationStrategy: "least-used" });
    const id1 = leastUsedPool.addCredential("openai", "key-1");
    const id2 = leastUsedPool.addCredential("openai", "key-2");

    const cred1 = leastUsedPool.getCredential("openai");
    expect(cred1!.key).toBe("key-1");

    const cred2 = leastUsedPool.getCredential("openai");
    expect(cred2!.key).toBe("key-2");

    const cred3 = leastUsedPool.getCredential("openai");
    const entries = leastUsedPool.getCredentials("openai");
    const useCounts = entries.map((e) => e.useCount);
    expect(Math.max(...useCounts) - Math.min(...useCounts)).toBeLessThanOrEqual(1);
  });

  it("credential useCount increments on getCredential", () => {
    pool.addCredential("openai", "key-1");

    const before = pool.getCredentials("openai")[0].useCount;
    pool.getCredential("openai");
    const after = pool.getCredentials("openai")[0].useCount;

    expect(after).toBe(before + 1);
  });

  it("credential lastUsedAt is updated on getCredential", () => {
    pool.addCredential("openai", "key-1");

    const before = pool.getCredentials("openai")[0].lastUsedAt;
    pool.getCredential("openai");
    const after = pool.getCredentials("openai")[0].lastUsedAt;

    expect(after).toBeGreaterThanOrEqual(before ?? 0);
  });

  // ── getNextKey convenience method ──────────────────────

  it("getNextKey returns the key string from the pool", () => {
    pool.addCredential("openai", "sk-key-aaa");
    pool.addCredential("openai", "sk-key-bbb");

    const key = pool.getNextKey("openai");
    expect(key).toBe("sk-key-aaa");
  });

  it("getNextKey returns empty string for unknown provider", () => {
    expect(pool.getNextKey("unknown")).toBe("");
  });

  it("getNextKey rotates through keys with round-robin", () => {
    pool.addCredential("openai", "key-a");
    pool.addCredential("openai", "key-b");
    pool.addCredential("openai", "key-c");

    expect(pool.getNextKey("openai")).toBe("key-a");
    expect(pool.getNextKey("openai")).toBe("key-b");
    expect(pool.getNextKey("openai")).toBe("key-c");
    expect(pool.getNextKey("openai")).toBe("key-a");
  });

  // ── reportRateLimit convenience method ─────────────────

  it("reportRateLimit marks a key as rate-limited by provider+key", () => {
    pool.addCredential("openai", "key-1");
    pool.addCredential("openai", "key-2");

    pool.reportRateLimit("openai", "key-1");

    // key-1 should be rate-limited, so getNextKey should return key-2
    const key = pool.getNextKey("openai");
    expect(key).toBe("key-2");
  });

  it("reportRateLimit is a no-op for unknown provider", () => {
    expect(() => pool.reportRateLimit("unknown", "some-key")).not.toThrow();
  });

  it("reportRateLimit is a no-op for unknown key", () => {
    pool.addCredential("openai", "key-1");
    expect(() => pool.reportRateLimit("openai", "nonexistent-key")).not.toThrow();
  });

  it("reportRateLimit sets rateLimitedUntil in the future", () => {
    pool.addCredential("openai", "key-1");
    pool.reportRateLimit("openai", "key-1");

    const entry = pool.getCredentials("openai")[0];
    expect(entry.rateLimitedUntil).not.toBeNull();
    expect(entry.rateLimitedUntil!).toBeGreaterThan(Date.now());
  });
});
