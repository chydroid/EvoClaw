/**
 * Feature Flags — runtime feature toggle system with percentage
 * rollouts, environment scoping, and audit logging.
 *
 * Enables gradual rollouts, A/B testing, kill switches, and
 * environment-specific configurations without redeploying.
 *
 * Features:
 *  - Boolean + percentage-based (0-100) flags
 *  - Environment scoping (dev/staging/production)
 *  - User/channel targeting (allowlist/blocklist)
 *  - Flag dependencies (if A depends on B, A auto-false when B is false)
 *  - Default value when flag is undefined
 *  - Audit log of flag evaluations
 *  - Immutable snapshot for consistent evaluation
 */

// ── Types ─────────────────────────────────────────────────

export interface FeatureFlag {
  /** Unique flag key */
  key: string;
  /** Human-readable description */
  description: string;
  /** Whether the flag is enabled */
  enabled: boolean;
  /** Percentage rollout (0-100, overrides boolean for hashed checks) */
  rolloutPercent?: number;
  /** Environments where this flag applies (empty = all) */
  environments?: string[];
  /** Allowlisted user/channel IDs */
  allowlist?: string[];
  /** Blocklisted user/channel IDs */
  blocklist?: string[];
  /** Flags that must be enabled for this flag to work */
  dependsOn?: string[];
  /** When the flag was last modified (epoch ms) */
  updatedAt: number;
  /** Flag owner/team */
  owner?: string;
  /** Optional expiry (epoch ms, after which flag auto-disables) */
  expiresAt?: number;
}

export interface FeatureFlagsConfig {
  /** Default enabled state for undefined flags */
  defaultEnabled: boolean;
  /** Whether to log flag evaluations */
  auditEvaluations: boolean;
  /** Current environment name */
  environment: string;
  /** Max evaluation history entries */
  maxAuditEntries: number;
}

export interface FlagEvaluation {
  key: string;
  result: boolean;
  reason: string;
  timestamp: number;
  context?: Record<string, unknown>;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: FeatureFlagsConfig = {
  defaultEnabled: false,
  auditEvaluations: false,
  environment: "production",
  maxAuditEntries: 200,
};

// ── Mersenne-style deterministic hash ─────────────────────

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

function rollPercentage(flag: FeatureFlag, id: string): boolean {
  if (flag.rolloutPercent === undefined) return flag.enabled;
  if (flag.rolloutPercent >= 100) return true;
  if (flag.rolloutPercent <= 0) return false;

  // Deterministic hash-based rollout
  const hash = hashString(`${flag.key}:${id}`);
  return (hash % 100) < flag.rolloutPercent;
}

// ── Store ─────────────────────────────────────────────────

export class FeatureFlagStore {
  private flags = new Map<string, FeatureFlag>();
  private config: FeatureFlagsConfig;
  private evaluations: FlagEvaluation[] = [];

  constructor(config?: Partial<FeatureFlagsConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a feature flag.
   */
  register(flag: FeatureFlag): void {
    flag.updatedAt = flag.updatedAt || Date.now();
    this.flags.set(flag.key, flag);
  }

  /**
   * Batch register multiple flags.
   */
  registerAll(flags: FeatureFlag[]): void {
    for (const flag of flags) {
      this.register(flag);
    }
  }

  /**
   * Unregister a flag.
   */
  unregister(key: string): boolean {
    return this.flags.delete(key);
  }

  /**
   * Get a flag definition.
   */
  getFlag(key: string): FeatureFlag | null {
    return this.flags.get(key) ?? null;
  }

  /**
   * List all registered flags.
   */
  listFlags(): FeatureFlag[] {
    return [...this.flags.values()];
  }

  /**
   * List flags filtered by owner.
   */
  listByOwner(owner: string): FeatureFlag[] {
    return [...this.flags.values()].filter((f) => f.owner === owner);
  }

  /**
   * Enable a flag.
   */
  enable(key: string): boolean {
    const flag = this.flags.get(key);
    if (!flag) return false;
    flag.enabled = true;
    flag.updatedAt = Date.now();
    return true;
  }

  /**
   * Disable a flag.
   */
  disable(key: string): boolean {
    const flag = this.flags.get(key);
    if (!flag) return false;
    flag.enabled = false;
    flag.updatedAt = Date.now();
    return true;
  }

  /**
   * Set rollout percentage for a flag.
   */
  setRollout(key: string, percent: number): boolean {
    const flag = this.flags.get(key);
    if (!flag) return false;
    flag.rolloutPercent = Math.max(0, Math.min(100, percent));
    flag.updatedAt = Date.now();
    return true;
  }

  /**
   * Evaluate whether a flag is active for a given context.
   * Checks: dependsOn → expiresAt → environment → blocklist → allowlist → rollout% → enabled.
   */
  evaluate(
    key: string,
    options?: { userId?: string; channel?: string; context?: Record<string, unknown> },
  ): boolean {
    const flag = this.flags.get(key);

    if (!flag) {
      this.recordEval(key, this.config.defaultEnabled, "Flag not registered", options?.context);
      return this.config.defaultEnabled;
    }

    // Check expiry
    if (flag.expiresAt && Date.now() > flag.expiresAt) {
      this.recordEval(key, false, "Flag expired", options?.context);
      return false;
    }

    // Check environment
    if (flag.environments && flag.environments.length > 0) {
      if (!flag.environments.includes(this.config.environment)) {
        this.recordEval(key, false, `Environment "${this.config.environment}" not in [${flag.environments}]`, options?.context);
        return false;
      }
    }

    // Check dependencies
    if (flag.dependsOn && flag.dependsOn.length > 0) {
      for (const dep of flag.dependsOn) {
        if (!this.evaluate(dep, options)) {
          this.recordEval(key, false, `Dependency "${dep}" not met`, options?.context);
          return false;
        }
      }
    }

    // Check blocklist
    const id = options?.userId ?? options?.channel ?? "";
    if (flag.blocklist?.includes(id)) {
      this.recordEval(key, false, `User/channel "${id}" is blocklisted`, options?.context);
      return false;
    }

    // Check allowlist (if specified, target must be in it)
    if (flag.allowlist && flag.allowlist.length > 0) {
      if (!id || !flag.allowlist.includes(id)) {
        this.recordEval(key, false, `User/channel "${id}" not in allowlist`, options?.context);
        return false;
      }
    }

    // Rollout percentage (deterministic hash)
    if (flag.rolloutPercent !== undefined && id) {
      const result = rollPercentage(flag, id);
      this.recordEval(key, result, `Rollout ${flag.rolloutPercent}% → hash=${hashString(`${flag.key}:${id}`) % 100}`, options?.context);
      return result;
    }

    this.recordEval(key, flag.enabled, `Flag enabled=${flag.enabled}`, options?.context);
    return flag.enabled;
  }

  /**
   * Return ALL enabled flag keys for a context (bulk evaluation).
   */
  evaluateAll(
    options?: { userId?: string; channel?: string; context?: Record<string, unknown> },
  ): string[] {
    const enabled: string[] = [];
    for (const key of this.flags.keys()) {
      if (this.evaluate(key, options)) {
        enabled.push(key);
      }
    }
    return enabled.sort();
  }

  /**
   * Check if a flag is globally enabled (without context).
   */
  isEnabled(key: string): boolean {
    return this.evaluate(key);
  }

  /**
   * Get all flags that are enabled for ALL users (no rollout, no allowlist).
   */
  getGloballyEnabled(): string[] {
    return [...this.flags.entries()]
      .filter(([, flag]) => {
        if (!flag.enabled) return false;
        if (flag.rolloutPercent !== undefined && flag.rolloutPercent < 100) return false;
        if (flag.allowlist && flag.allowlist.length > 0) return false;
        return true;
      })
      .map(([key]) => key)
      .sort();
  }

  // ── Audit ───────────────────────────────────────────────

  /**
   * Get recent evaluation history.
   */
  getEvaluations(limit?: number): FlagEvaluation[] {
    if (limit) return this.evaluations.slice(-limit);
    return [...this.evaluations];
  }

  /**
   * Clear evaluation history.
   */
  clearEvaluations(): void {
    this.evaluations = [];
  }

  /**
   * Get evaluation statistics.
   */
  getStats(): {
    totalFlags: number;
    enabledFlags: number;
    evaluations: number;
    byResult: { enabled: number; disabled: number };
  } {
    const total = this.flags.size;
    const enabled = [...this.flags.values()].filter((f) => f.enabled).length;
    const evals = this.evaluations;

    return {
      totalFlags: total,
      enabledFlags: enabled,
      evaluations: evals.length,
      byResult: {
        enabled: evals.filter((e) => e.result).length,
        disabled: evals.filter((e) => !e.result).length,
      },
    };
  }

  configure(updates: Partial<FeatureFlagsConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ── Private ─────────────────────────────────────────────

  private recordEval(
    key: string,
    result: boolean,
    reason: string,
    context?: Record<string, unknown>,
  ): void {
    if (!this.config.auditEvaluations) return;

    this.evaluations.push({
      key,
      result,
      reason,
      timestamp: Date.now(),
      context,
    });

    if (this.evaluations.length > this.config.maxAuditEntries) {
      this.evaluations = this.evaluations.slice(-this.config.maxAuditEntries);
    }
  }
}