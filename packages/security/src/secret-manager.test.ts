import { describe, it, expect, beforeEach } from "vitest";
import { SecretManager, SecretEntry } from "./secret-manager";

describe("SecretManager", () => {
  let sm: SecretManager;

  beforeEach(() => {
    sm = new SecretManager();
  });

  // ── Registration ──────────────────────────────────────

  describe("register", () => {
    it("registers a secret and returns its entry", () => {
      const entry = sm.register("API_KEY", "secret-value-123");
      expect(entry.name).toBe("API_KEY");
      expect(entry.value).toBe("secret-value-123");
      expect(entry.version).toBe(1);
      expect(entry.active).toBe(true);
      expect(entry.scope).toBe("internal");
      expect(entry.provider).toBe("inline");
    });

    it("supports custom options", () => {
      const entry = sm.register("TOKEN", "tok", {
        description: "Auth token",
        scope: "gateway",
        provider: "vault",
        rotationIntervalMs: 3600000,
        expiresAt: Date.now() + 86400000,
        owner: "team-a",
        tags: ["prod", "critical"],
      });
      expect(entry.description).toBe("Auth token");
      expect(entry.scope).toBe("gateway");
      expect(entry.provider).toBe("vault");
      expect(entry.owner).toBe("team-a");
      expect(entry.tags).toEqual(["prod", "critical"]);
    });

    it("registers from environment variable", () => {
      process.env.TEST_ENV_VAR = "env-value";
      const entry = sm.registerFromEnv("ENV_KEY", "TEST_ENV_VAR", {
        scope: "provider",
        required: true,
      });
      expect(entry).not.toBeNull();
      expect(entry!.value).toBe("env-value");
      expect(entry!.provider).toBe("env");
    });

    it("returns null for missing optional env var", () => {
      const entry = sm.registerFromEnv("MISSING", "NONEXISTENT_VAR");
      expect(entry).toBeNull();
    });

    it("throws for missing required env var", () => {
      expect(() =>
        sm.registerFromEnv("MISSING", "NONEXISTENT_VAR", { required: true }),
      ).toThrow("Required environment variable");
    });
  });

  // ── Access ────────────────────────────────────────────

  describe("get", () => {
    it("returns secret value by name", () => {
      sm.register("KEY", "my-value");
      expect(sm.get("KEY")).toBe("my-value");
    });

    it("returns null for unknown secret", () => {
      expect(sm.get("UNKNOWN")).toBeNull();
    });

    it("returns null for revoked secret", () => {
      sm.register("KEY", "val");
      sm.revoke("KEY");
      expect(sm.get("KEY")).toBeNull();
    });

    it("returns null for expired secret", () => {
      sm.register("KEY", "val", { expiresAt: Date.now() - 1000 });
      expect(sm.get("KEY")).toBeNull();
    });

    it("logs access with caller identity", () => {
      sm.register("KEY", "val");
      sm.get("KEY", "agent-42");
      const logs = sm.getAccessLogs({ secretName: "KEY", operation: "get" });
      expect(logs).toHaveLength(1);
      expect(logs[0].accessedBy).toBe("agent-42");
      expect(logs[0].operation).toBe("get");
      expect(logs[0].granted).toBe(true);
    });

    it("logs denied access", () => {
      sm.get("NOPE", "caller");
      const logs = sm.getAccessLogs({ secretName: "NOPE" });
      expect(logs[0].granted).toBe(false);
      expect(logs[0].reason).toBe("Not found");
    });
  });

  describe("getMasked", () => {
    it("returns masked value", () => {
      sm.register("KEY", "sk-very-long-secret-key-12345");
      const masked = sm.getMasked("KEY");
      expect(masked).not.toBeNull();
      expect(masked!).not.toBe("sk-very-long-secret-key-12345");
      expect(masked!).toContain("*");
    });

    it("returns null for unknown secret", () => {
      expect(sm.getMasked("NOPE")).toBeNull();
    });
  });

  describe("getMetadata", () => {
    it("returns metadata without value", () => {
      sm.register("KEY", "secret", { scope: "channel", owner: "ops" });
      const meta = sm.getMetadata("KEY");
      expect(meta).not.toBeNull();
      expect(meta!.scope).toBe("channel");
      expect(meta!.owner).toBe("ops");
      expect((meta as any).value).toBeUndefined();
    });

    it("returns null for unknown secret", () => {
      expect(sm.getMetadata("NOPE")).toBeNull();
    });
  });

  describe("has", () => {
    it("returns true for active secret", () => {
      sm.register("KEY", "val");
      expect(sm.has("KEY")).toBe(true);
    });

    it("returns false for revoked secret", () => {
      sm.register("KEY", "val");
      sm.revoke("KEY");
      expect(sm.has("KEY")).toBe(false);
    });

    it("returns false for expired secret", () => {
      sm.register("KEY", "val", { expiresAt: Date.now() - 1 });
      expect(sm.has("KEY")).toBe(false);
    });
  });

  // ── Rotation ──────────────────────────────────────────

  describe("rotate", () => {
    it("rotates a secret to a new value", () => {
      sm.register("KEY", "old");
      const result = sm.rotate("KEY", "new");
      expect(result.success).toBe(true);
      expect(result.newVersion).toBe(2);
      expect(result.oldHash).toBeTruthy();
      expect(result.newHash).toBeTruthy();
      expect(sm.get("KEY")).toBe("new");
    });

    it("returns failure for unknown secret", () => {
      const result = sm.rotate("NOPE", "val");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("rotateAuto", () => {
    it("generates and rotates a secret", () => {
      sm.register("KEY", "old");
      const result = sm.rotateAuto("KEY", 32);
      expect(result.success).toBe(true);
      expect(result.newVersion).toBe(2);
      expect(sm.get("KEY")).not.toBe("old");
    });
  });

  describe("rotateExpired", () => {
    it("rotates secrets past their rotation interval", () => {
      // Register with very short rotation interval
      const entry = sm.register("KEY", "old", { rotationIntervalMs: 1 });
      // Force lastRotatedAt to be in the past
      (entry as any).lastRotatedAt = Date.now() - 10000;

      const results = sm.rotateExpired(() => "new-auto");
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(sm.get("KEY")).toBe("new-auto");
    });

    it("skips secrets not yet due for rotation", () => {
      sm.register("KEY", "val", { rotationIntervalMs: 999999999 });
      const results = sm.rotateExpired(() => "new");
      expect(results).toHaveLength(0);
    });

    it("skips revoked secrets", () => {
      const entry = sm.register("KEY", "val", { rotationIntervalMs: 1 });
      (entry as any).lastRotatedAt = Date.now() - 10000;
      sm.revoke("KEY");

      const results = sm.rotateExpired(() => "new");
      expect(results).toHaveLength(0);
    });
  });

  // ── Revocation ────────────────────────────────────────

  describe("revoke / activate", () => {
    it("revokes a secret", () => {
      sm.register("KEY", "val");
      expect(sm.revoke("KEY")).toBe(true);
      expect(sm.get("KEY")).toBeNull();
    });

    it("returns false for unknown secret", () => {
      expect(sm.revoke("NOPE")).toBe(false);
    });

    it("re-activates a revoked secret", () => {
      sm.register("KEY", "val");
      sm.revoke("KEY");
      expect(sm.activate("KEY")).toBe(true);
      expect(sm.get("KEY")).toBe("val");
    });

    it("returns false for unknown on activate", () => {
      expect(sm.activate("NOPE")).toBe(false);
    });
  });

  // ── Verification ──────────────────────────────────────

  describe("verify", () => {
    it("returns true for correct value", () => {
      sm.register("KEY", "correct");
      expect(sm.verify("KEY", "correct")).toBe(true);
    });

    it("returns false for incorrect value", () => {
      sm.register("KEY", "correct");
      expect(sm.verify("KEY", "wrong")).toBe(false);
    });

    it("returns false for revoked secret", () => {
      sm.register("KEY", "val");
      sm.revoke("KEY");
      expect(sm.verify("KEY", "val")).toBe(false);
    });

    it("returns false for expired secret", () => {
      sm.register("KEY", "val", { expiresAt: Date.now() - 1 });
      expect(sm.verify("KEY", "val")).toBe(false);
    });
  });

  // ── Query ─────────────────────────────────────────────

  describe("query", () => {
    beforeEach(() => {
      sm.register("GW_KEY", "v1", { scope: "gateway", tags: ["prod"] });
      sm.register("CH_KEY", "v2", { scope: "channel", tags: ["prod"] });
      sm.register("PR_KEY", "v3", { scope: "provider", owner: "ai-team" });
    });

    it("filters by scope", () => {
      const results = sm.query({ scope: "gateway" });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("GW_KEY");
    });

    it("filters by tag", () => {
      const results = sm.query({ tag: "prod" });
      expect(results).toHaveLength(2);
    });

    it("filters by owner", () => {
      const results = sm.query({ owner: "ai-team" });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("PR_KEY");
    });

    it("filters active only", () => {
      sm.revoke("CH_KEY");
      const results = sm.query({ active: true });
      expect(results).toHaveLength(2);
    });

    it("filters expired within time window", () => {
      sm.register("EXP_KEY", "v", {
        expiresAt: Date.now() + 3600000, // 1 hour
      });
      const results = sm.query({ expiringWithinMs: 7200000 }); // 2 hours
      expect(results.some((r) => r.name === "EXP_KEY")).toBe(true);
    });

    it("never exposes secret values", () => {
      const results = sm.query();
      for (const r of results) {
        expect((r as any).value).toBeUndefined();
      }
    });
  });

  describe("listNames", () => {
    it("returns all secret names", () => {
      sm.register("A", "a");
      sm.register("B", "b");
      expect(sm.listNames()).toEqual(expect.arrayContaining(["A", "B"]));
    });
  });

  describe("getExpiringSoon", () => {
    it("returns secrets near expiry", () => {
      const soon = Date.now() + 3600000; // 1 hour
      sm.register("EXP", "v", { expiresAt: soon });
      const expiring = sm.getExpiringSoon();
      expect(expiring.some((e) => e.name === "EXP")).toBe(true);
    });
  });

  describe("countByScope", () => {
    it("groups counts by scope", () => {
      sm.register("A", "a", { scope: "gateway" });
      sm.register("B", "b", { scope: "gateway" });
      sm.register("C", "c", { scope: "channel" });
      const counts = sm.countByScope();
      expect(counts.gateway).toBe(2);
      expect(counts.channel).toBe(1);
    });
  });

  // ── Audit ─────────────────────────────────────────────

  describe("getAccessLogs", () => {
    it("filters by secret name", () => {
      sm.register("A", "va");
      sm.register("B", "vb");
      const logs = sm.getAccessLogs({ secretName: "A" });
      expect(logs).toHaveLength(1);
    });

    it("filters by operation", () => {
      sm.register("KEY", "val");
      sm.get("KEY");
      const logs = sm.getAccessLogs({ operation: "get" });
      expect(logs).toHaveLength(1);
      expect(logs[0].operation).toBe("get");
    });

    it("limits results", () => {
      sm.register("A", "a");
      sm.register("B", "b");
      sm.register("C", "c");
      const logs = sm.getAccessLogs({ limit: 2 });
      expect(logs).toHaveLength(2);
    });

    it("clearAccessLogs empties logs", () => {
      sm.register("A", "a");
      sm.clearAccessLogs();
      expect(sm.getAccessLogs()).toHaveLength(0);
    });
  });

  // ── Utility ───────────────────────────────────────────

  describe("mask", () => {
    it("masks long values showing prefix and suffix", () => {
      const masked = sm.mask("very-long-secret-value-here");
      expect(masked).toContain("*");
      expect(masked).not.toBe("very-long-secret-value-here");
    });

    it("fully masks short values", () => {
      const sm2 = new SecretManager({ maskShowCount: 4 });
      const masked = sm2.mask("short");
      expect(masked).toBe("*****");
    });
  });

  describe("static generate", () => {
    it("generates random secrets", () => {
      const s1 = SecretManager.generate(32);
      const s2 = SecretManager.generate(32);
      expect(s1.length).toBe(32);
      expect(s1).not.toBe(s2);
    });
  });

  describe("static generateApiKey", () => {
    it("generates API key with prefix", () => {
      const key = SecretManager.generateApiKey("evoclaw", 40);
      expect(key).toMatch(/^evoclaw_/);
      expect(key.length).toBeGreaterThan(40);
    });
  });

  // ── Counts ────────────────────────────────────────────

  describe("count / activeCount", () => {
    it("counts total registered secrets", () => {
      expect(sm.count).toBe(0);
      sm.register("A", "a");
      sm.register("B", "b");
      expect(sm.count).toBe(2);
    });

    it("counts active secrets", () => {
      sm.register("A", "a");
      sm.register("B", "b");
      sm.revoke("B");
      expect(sm.activeCount).toBe(1);
    });
  });

  // ── configure ─────────────────────────────────────────

  describe("configure", () => {
    it("updates config", () => {
      sm.configure({ maskShowCount: 6 });
      sm.register("KEY", "very-secret-value");
      const masked = sm.getMasked("KEY");
      expect(masked).not.toBeNull();
      // Should show 6 chars on each side
      expect(masked!).toMatch(/^very-s/);
    });
  });
});