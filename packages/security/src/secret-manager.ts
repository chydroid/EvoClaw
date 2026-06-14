/**
 * Secret Manager — centralized credential and sensitive value management.
 *
 * Provides a unified interface for storing, accessing, rotating, and
 * auditing secrets (API keys, tokens, passwords, certificates). Integrates
 * with the audit system for compliance and supports environment variable
 * fallback for CI/CD and containerized deployments.
 *
 * Features:
 *  - Typed secret registration with metadata (rotation schedule, owner, scope)
 *  - Environment variable fallback with masking
 *  - Secret rotation: time-based + manual trigger
 *  - Access auditing: who accessed what, when
 *  - Sensitive value masking in logs/debug output
 *  - Expiry tracking with warning thresholds
 *  - Bulk operations (rotate all expired, list expiring)
 *  - Encryption-ready storage abstraction
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";

// ── Types ─────────────────────────────────────────────────

export type SecretScope =
  | "gateway"       // Gateway/auth secrets
  | "channel"       // Channel-specific tokens (Telegram, Discord, etc.)
  | "provider"      // LLM provider API keys
  | "infrastructure" // DB passwords, certs, etc.
  | "plugin"        // Plugin-specific secrets
  | "internal";     // Internal service secrets

export type SecretProvider = "env" | "vault" | "file" | "inline" | "aws-secrets" | "gcp-secrets";

export interface SecretEntry {
  /** Unique secret name (e.g., "OPENAI_API_KEY") */
  name: string;
  /** Human-readable description */
  description: string;
  /** Classification scope */
  scope: SecretScope;
  /** Where the secret is sourced from */
  provider: SecretProvider;
  /** The actual secret value (only stored in memory, never persisted plaintext) */
  value: string;
  /** When this secret was created/registered */
  createdAt: number;
  /** When this secret was last rotated */
  lastRotatedAt: number;
  /** Rotation interval in ms (0 = never auto-rotate) */
  rotationIntervalMs: number;
  /** When this secret expires (0 = never) */
  expiresAt: number;
  /** Owner/team responsible for this secret */
  owner: string;
  /** Arbitrary tags for categorization */
  tags: string[];
  /** Secret version (incremented on rotation) */
  version: number;
  /** Whether this secret is active */
  active: boolean;
}

export interface SecretAccessLog {
  /** Secret name accessed */
  secretName: string;
  /** Who/what accessed it (caller identity) */
  accessedBy: string;
  /** When the access occurred */
  accessedAt: number;
  /** Operation performed */
  operation: "get" | "rotate" | "register" | "revoke" | "verify";
  /** Whether access was granted */
  granted: boolean;
  /** Reason for access/denial */
  reason?: string;
}

export interface SecretRotationResult {
  /** Whether rotation succeeded */
  success: boolean;
  /** Secret name */
  secretName: string;
  /** New version number */
  newVersion: number;
  /** Old value hash (for verification) */
  oldHash: string;
  /** New value hash */
  newHash: string;
  /** Error message if failed */
  error?: string;
}

export interface SecretManagerConfig {
  /** Maximum access log entries to retain */
  maxAccessLogSize: number;
  /** Warning threshold before expiry (ms before expiresAt) */
  expiryWarningMs: number;
  /** Default rotation interval for new secrets (ms) */
  defaultRotationIntervalMs: number;
  /** Mask character for sensitive values in logs */
  maskChar: string;
  /** Number of characters to show in masked value */
  maskShowCount: number;
  /** Whether to hash stored values for integrity verification */
  hashStoredValues: boolean;
}

export interface SecretQuery {
  scope?: SecretScope;
  provider?: SecretProvider;
  tag?: string;
  active?: boolean;
  expiringWithinMs?: number;
  owner?: string;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: SecretManagerConfig = {
  maxAccessLogSize: 10_000,
  expiryWarningMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  defaultRotationIntervalMs: 90 * 24 * 60 * 60 * 1000, // 90 days
  maskChar: "*",
  maskShowCount: 4,
  hashStoredValues: true,
};

// ── Manager ───────────────────────────────────────────────

export class SecretManager {
  private config: SecretManagerConfig;
  private secrets = new Map<string, SecretEntry>();
  private accessLogs: SecretAccessLog[] = [];
  private envMasked = new Set<string>();

  private hmacKey: string;

  constructor(config?: Partial<SecretManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.hmacKey = process.env.EVOCLAW_SECRET_HMAC_KEY || randomBytes(32).toString("hex");
  }

  // ── Registration ────────────────────────────────────────

  /**
   * Register a secret with an inline value.
   */
  register(
    name: string,
    value: string,
    opts?: {
      description?: string;
      scope?: SecretScope;
      provider?: SecretProvider;
      rotationIntervalMs?: number;
      expiresAt?: number;
      owner?: string;
      tags?: string[];
    },
  ): SecretEntry {
    const now = Date.now();
    const entry: SecretEntry = {
      name,
      description: opts?.description ?? "",
      scope: opts?.scope ?? "internal",
      provider: opts?.provider ?? "inline",
      value,
      createdAt: now,
      lastRotatedAt: now,
      rotationIntervalMs:
        opts?.rotationIntervalMs ?? this.config.defaultRotationIntervalMs,
      expiresAt: opts?.expiresAt ?? 0,
      owner: opts?.owner ?? "system",
      tags: opts?.tags ?? [],
      version: 1,
      active: true,
    };

    this.secrets.set(name, entry);
    this.logAccess(name, "system", "register", true, "Secret registered");
    return entry;
  }

  /**
   * Register a secret sourced from an environment variable.
   * The value is read from process.env and masked in logs.
   */
  registerFromEnv(
    name: string,
    envVar: string,
    opts?: {
      description?: string;
      scope?: SecretScope;
      rotationIntervalMs?: number;
      owner?: string;
      tags?: string[];
      required?: boolean;
    },
  ): SecretEntry | null {
    const value = process.env[envVar];
    if (!value) {
      if (opts?.required) {
        throw new Error(`Required environment variable "${envVar}" not set for secret "${name}"`);
      }
      return null;
    }

    this.envMasked.add(envVar);
    return this.register(name, value, {
      description: opts?.description ?? `From env: ${envVar}`,
      scope: opts?.scope ?? "internal",
      provider: "env",
      rotationIntervalMs: opts?.rotationIntervalMs,
      owner: opts?.owner,
      tags: opts?.tags,
    });
  }

  // ── Access ──────────────────────────────────────────────

  /**
   * Get a secret value. Logs the access for audit.
   * @param name Secret name
   * @param accessedBy Caller identity
   * @returns The secret value, or null if not found/expired
   */
  get(name: string, accessedBy = "system"): string | null {
    const entry = this.secrets.get(name);
    if (!entry) {
      this.logAccess(name, accessedBy, "get", false, "Not found");
      return null;
    }

    if (!entry.active) {
      this.logAccess(name, accessedBy, "get", false, "Secret is revoked");
      return null;
    }

    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.logAccess(name, accessedBy, "get", false, "Secret expired");
      return null;
    }

    this.logAccess(name, accessedBy, "get", true, "OK");
    return entry.value;
  }

  /**
   * Get a masked version of the secret (safe for logging/debug).
   */
  getMasked(name: string): string | null {
    const value = this.get(name);
    if (value === null) return null;
    return this.mask(value);
  }

  /**
   * Get secret metadata without the value.
   */
  getMetadata(name: string): Omit<SecretEntry, "value"> | null {
    const entry = this.secrets.get(name);
    if (!entry) return null;
    const { value: _, ...meta } = entry;
    return meta;
  }

  /**
   * Check if a secret exists and is active.
   */
  has(name: string): boolean {
    const entry = this.secrets.get(name);
    if (!entry || !entry.active) return false;
    return !(entry.expiresAt > 0 && Date.now() > entry.expiresAt);
  }

  // ── Rotation ────────────────────────────────────────────

  /**
   * Rotate a secret to a new value.
   */
  rotate(name: string, newValue: string): SecretRotationResult {
    const entry = this.secrets.get(name);
    if (!entry) {
      return {
        success: false,
        secretName: name,
        newVersion: 0,
        oldHash: "",
        newHash: "",
        error: "Secret not found",
      };
    }

    const oldHash = this.hashValue(entry.value);
    const newHash = this.hashValue(newValue);

    entry.value = newValue;
    entry.lastRotatedAt = Date.now();
    entry.version++;

    this.logAccess(name, "system", "rotate", true, `Rotated to v${entry.version}`);

    return {
      success: true,
      secretName: name,
      newVersion: entry.version,
      oldHash,
      newHash,
    };
  }

  /**
   * Auto-generate a new value and rotate the secret.
   */
  rotateAuto(name: string, length = 64): SecretRotationResult {
    const newValue = randomBytes(length).toString("hex").slice(0, length);
    return this.rotate(name, newValue);
  }

  /**
   * Rotate all secrets that are past their rotation interval.
   * Uses the rotation callback to generate new values.
   */
  rotateExpired(
    generator: (entry: Omit<SecretEntry, "value">) => string,
  ): SecretRotationResult[] {
    const results: SecretRotationResult[] = [];
    const now = Date.now();

    for (const entry of this.secrets.values()) {
      if (!entry.active) continue;
      if (entry.rotationIntervalMs <= 0) continue;

      const nextRotation = entry.lastRotatedAt + entry.rotationIntervalMs;
      if (now >= nextRotation) {
        const newValue = generator(entry);
        results.push(this.rotate(entry.name, newValue));
      }
    }

    return results;
  }

  // ── Revocation ──────────────────────────────────────────

  /**
   * Revoke (deactivate) a secret.
   */
  revoke(name: string): boolean {
    const entry = this.secrets.get(name);
    if (!entry) return false;

    entry.active = false;
    this.logAccess(name, "system", "revoke", true, "Secret revoked");
    return true;
  }

  /**
   * Re-activate a previously revoked secret.
   */
  activate(name: string): boolean {
    const entry = this.secrets.get(name);
    if (!entry) return false;

    entry.active = true;
    this.logAccess(name, "system", "register", true, "Secret re-activated");
    return true;
  }

  // ── Verification ────────────────────────────────────────

  /**
   * Verify a value against a stored secret using constant-time comparison.
   */
  verify(name: string, candidate: string): boolean {
    const entry = this.secrets.get(name);
    if (!entry || !entry.active) return false;
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) return false;

    try {
      const stored = Buffer.from(entry.value, "utf-8");
      const input = Buffer.from(candidate, "utf-8");
      // Use constant-time comparison even with different lengths to avoid timing leaks
      const maxLen = Math.max(stored.length, input.length);
      const paddedStored = Buffer.alloc(maxLen);
      const paddedInput = Buffer.alloc(maxLen);
      stored.copy(paddedStored, maxLen - stored.length);
      input.copy(paddedInput, maxLen - input.length);
      const result = timingSafeEqual(paddedStored, paddedInput);
      this.logAccess(name, "system", "verify", result, result ? "Match" : "Mismatch");
      return result;
    } catch {
      this.logAccess(name, "system", "verify", false, "Error during comparison");
      return false;
    }
  }

  // ── Query ───────────────────────────────────────────────

  /**
   * Query secrets with optional filters. Never exposes values.
   */
  query(q: SecretQuery = {}): Omit<SecretEntry, "value">[] {
    let results = [...this.secrets.values()];

    if (q.scope) {
      results = results.filter((s) => s.scope === q.scope);
    }
    if (q.provider) {
      results = results.filter((s) => s.provider === q.provider);
    }
    if (q.tag) {
      results = results.filter((s) => s.tags.includes(q.tag!));
    }
    if (q.active !== undefined) {
      results = results.filter((s) => s.active === q.active);
    }
    if (q.owner) {
      results = results.filter((s) => s.owner === q.owner);
    }
    if (q.expiringWithinMs) {
      const cutoff = Date.now() + q.expiringWithinMs;
      results = results.filter(
        (s) => s.expiresAt > 0 && s.expiresAt <= cutoff,
      );
    }

    return results.map(({ value: _, ...meta }) => meta);
  }

  /**
   * List all secret names.
   */
  listNames(): string[] {
    return [...this.secrets.keys()];
  }

  /**
   * Get secrets that are near expiry.
   */
  getExpiringSoon(): Omit<SecretEntry, "value">[] {
    const warningThreshold = Date.now() + this.config.expiryWarningMs;
    return this.query({
      expiringWithinMs: this.config.expiryWarningMs,
      active: true,
    });
  }

  /**
   * Get a count of secrets by scope.
   */
  countByScope(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const s of this.secrets.values()) {
      counts[s.scope] = (counts[s.scope] ?? 0) + 1;
    }
    return counts;
  }

  // ── Audit ───────────────────────────────────────────────

  /**
   * Get access logs with optional filtering.
   */
  getAccessLogs(opts?: {
    secretName?: string;
    limit?: number;
    operation?: SecretAccessLog["operation"];
  }): SecretAccessLog[] {
    let logs = [...this.accessLogs];

    if (opts?.secretName) {
      logs = logs.filter((l) => l.secretName === opts.secretName);
    }
    if (opts?.operation) {
      logs = logs.filter((l) => l.operation === opts.operation);
    }

    logs.sort((a, b) => b.accessedAt - a.accessedAt);
    return logs.slice(0, opts?.limit ?? logs.length);
  }

  /**
   * Clear access logs.
   */
  clearAccessLogs(): void {
    this.accessLogs = [];
  }

  // ── Utility ─────────────────────────────────────────────

  /**
   * Mask a sensitive value for safe display.
   */
  mask(value: string): string {
    if (value.length <= this.config.maskShowCount * 2) {
      return this.config.maskChar.repeat(value.length);
    }
    const show = this.config.maskShowCount;
    return (
      value.slice(0, show) +
      this.config.maskChar.repeat(Math.min(value.length - show * 2, 12)) +
      value.slice(-show)
    );
  }

  /**
   * Generate a cryptographically secure random secret.
   */
  static generate(length = 48): string {
    return randomBytes(length).toString("base64url").slice(0, length);
  }

  /**
   * Generate a secure API key with a prefix.
   */
  static generateApiKey(prefix: string, length = 40): string {
    const random = randomBytes(length).toString("base64url").slice(0, length);
    return `${prefix}_${random}`;
  }

  configure(updates: Partial<SecretManagerConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /** Total number of registered secrets */
  get count(): number {
    return this.secrets.size;
  }

  /** Number of active secrets */
  get activeCount(): number {
    let c = 0;
    for (const s of this.secrets.values()) {
      if (s.active && (s.expiresAt === 0 || Date.now() <= s.expiresAt)) c++;
    }
    return c;
  }

  // ── Private ─────────────────────────────────────────────

  private logAccess(
    secretName: string,
    accessedBy: string,
    operation: SecretAccessLog["operation"],
    granted: boolean,
    reason?: string,
  ): void {
    this.accessLogs.push({
      secretName,
      accessedBy,
      accessedAt: Date.now(),
      operation,
      granted,
      reason,
    });

    if (this.accessLogs.length > this.config.maxAccessLogSize) {
      this.accessLogs = this.accessLogs.slice(-this.config.maxAccessLogSize);
    }
  }

  private hashValue(value: string): string {
    if (!this.config.hashStoredValues) return "";
    return createHmac("sha256", this.hmacKey).update(value).digest("hex").slice(0, 16);
  }
}