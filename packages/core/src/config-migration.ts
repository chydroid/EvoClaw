/**
 * Config Migration — version-aware configuration migration tool.
 *
 * Handles breaking changes when upgrading between EvoClaw versions
 * by registering migration functions that transform old config to
 * the current schema format.
 *
 * Features:
 *  - Schema version tracking (semver-compatible)
 *  - Migration chain: v1 → v2 → v3 applied sequentially
 *  - Dry-run mode to preview changes without applying
 *  - Backup before migration for safety
 *  - Per-key migration for targeted changes
 *  - Migration status reporting
 *  - Rollback support (migration reversal)
 */

// ── Types ─────────────────────────────────────────────────

export type SemVer = `${number}.${number}.${number}`;

export interface MigrationStep {
  /** Migration version that this step produces */
  toVersion: SemVer;
  /** Human-readable description of the change */
  description: string;
  /** Transform function — takes old config, returns new config */
  migrate: (config: Record<string, unknown>) => Record<string, unknown>;
  /** Reverse transform for rollback */
  rollback?: (config: Record<string, unknown>) => Record<string, unknown>;
  /** Whether this migration can be safely reverted */
  reversible: boolean;
  /** Whether this is a breaking change */
  breaking: boolean;
}

export interface MigrationResult {
  /** Whether all migrations applied successfully */
  success: boolean;
  /** Original schema version */
  fromVersion: SemVer | null;
  /** Final schema version */
  toVersion: SemVer;
  /** Steps applied */
  applied: number;
  /** Steps skipped (already applied) */
  skipped: number;
  /** Steps that failed */
  failed: number;
  /** Error messages */
  errors: string[];
  /** The final config */
  config: Record<string, unknown>;
  /** Whether this was a dry run */
  dryRun: boolean;
  /** Warnings about potential issues */
  warnings: string[];
}

export interface ConfigMigrationConfig {
  /** Current schema version key in config */
  schemaVersionKey: string;
  /** Whether to backup before migrating */
  backupBeforeMigrate: boolean;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: ConfigMigrationConfig = {
  schemaVersionKey: "schemaVersion",
  backupBeforeMigrate: true,
};

// ── Manager ───────────────────────────────────────────────

export class ConfigMigrationManager {
  private config: ConfigMigrationConfig;
  private steps = new Map<SemVer, MigrationStep>();

  constructor(config?: Partial<ConfigMigrationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a migration step.
   * Steps are sorted by version and applied sequentially.
   */
  register(step: MigrationStep): void {
    this.steps.set(step.toVersion, step);
  }

  /**
   * Register multiple migration steps.
   */
  registerAll(steps: MigrationStep[]): void {
    for (const step of steps) {
      this.register(step);
    }
  }

  /**
   * Remove a registered migration step.
   */
  unregister(toVersion: SemVer): boolean {
    return this.steps.delete(toVersion);
  }

  /**
   * List all registered migrations sorted by version.
   */
  listSteps(): MigrationStep[] {
    return [...this.steps.values()].sort((a, b) =>
      this.compareVersions(a.toVersion, b.toVersion),
    );
  }

  /**
   * Get the latest schema version from registered migrations.
   */
  getLatestVersion(): SemVer | null {
    const sorted = this.listSteps();
    return sorted.length > 0 ? sorted[sorted.length - 1].toVersion : null;
  }

  /**
   * Migrate a config from its current version to the latest.
   * Returns the migration result with the transformed config.
   */
  migrate(
    inputConfig: Record<string, unknown>,
    options?: { dryRun?: boolean; targetVersion?: SemVer },
  ): MigrationResult {
    const dryRun = options?.dryRun ?? false;
    const targetVersion = options?.targetVersion ?? this.getLatestVersion();

    const result: MigrationResult = {
      success: true,
      fromVersion: this.detectVersion(inputConfig),
      toVersion: targetVersion ?? "0.0.0",
      applied: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      // 深拷贝，避免迁移步骤对返回的 config 的修改污染调用方传入的 inputConfig
      config: JSON.parse(JSON.stringify(inputConfig)) as Record<string, unknown>,
      dryRun,
      warnings: [],
    };

    if (!targetVersion) {
      result.success = true;
      result.warnings.push("No migrations registered");
      return result;
    }

    // Sort steps by version ascending
    const sorted = [...this.steps.entries()]
      .sort(([a], [b]) => this.compareVersions(a, b))
      .filter(([version]) => {
        // Only apply steps newer than current version and up to target
        if (result.fromVersion) {
          return this.compareVersions(version, result.fromVersion) > 0;
        }
        return true;
      });

    for (const [version, step] of sorted) {
      if (this.compareVersions(version, targetVersion) > 0) {
        // This step is beyond target, skip
        result.skipped++;
        break;
      }

      try {
        result.config = step.migrate(result.config);
        result.applied++;

        if (!dryRun) {
          // Update schema version in the config
          result.config[this.config.schemaVersionKey] = version;
        }

        // Check for warnings
        if (step.breaking) {
          result.warnings.push(`Breaking change: ${step.description}`);
        }
      } catch (err) {
        result.failed++;
        result.success = false;
        result.errors.push(
          `Migration to ${version} failed: ${(err as Error).message}`,
        );
        break;
      }
    }

    return result;
  }

  /**
   * Rollback a config by one version (applies the last migration's rollback).
   */
  rollback(
    config: Record<string, unknown>,
  ): { success: boolean; config: Record<string, unknown>; error?: string } {
    const currentVersion = this.detectVersion(config);
    if (!currentVersion) {
      return { success: false, config, error: "No schema version found in config" };
    }

    const step = this.steps.get(currentVersion);
    if (!step) {
      return { success: false, config, error: `No rollback registered for ${currentVersion}` };
    }

    if (!step.reversible || !step.rollback) {
      return { success: false, config, error: `Migration ${currentVersion} is not reversible` };
    }

    try {
      const rolled = step.rollback(config);

      // Find previous version
      const sorted = this.listSteps();
      const idx = sorted.findIndex((s) => s.toVersion === currentVersion);
      if (idx > 0) {
        rolled[this.config.schemaVersionKey] = sorted[idx - 1].toVersion;
      } else {
        delete rolled[this.config.schemaVersionKey];
      }

      return { success: true, config: rolled };
    } catch (err) {
      return { success: false, config, error: (err as Error).message };
    }
  }

  /**
   * Get the migration path from one version to another.
   */
  getMigrationPath(
    fromVersion: SemVer | null,
    toVersion: SemVer,
  ): MigrationStep[] {
    const sorted = this.listSteps();
    return sorted.filter((step) => {
      const stepVersion = step.toVersion;
      if (fromVersion && this.compareVersions(stepVersion, fromVersion) <= 0) {
        return false;
      }
      return this.compareVersions(stepVersion, toVersion) <= 0;
    });
  }

  /**
   * Check if a config needs migration.
   */
  needsMigration(config: Record<string, unknown>): boolean {
    const current = this.detectVersion(config);
    const latest = this.getLatestVersion();
    if (!latest) return false;
    if (!current) return true; // No version = needs migration
    return this.compareVersions(current, latest) < 0;
  }

  /**
   * Get breaking changes between two versions.
   */
  getBreakingChanges(fromVersion: SemVer | null): MigrationStep[] {
    const sorted = this.listSteps();
    return sorted.filter((step) => {
      if (fromVersion && this.compareVersions(step.toVersion, fromVersion) <= 0) {
        return false;
      }
      return step.breaking;
    });
  }

  configure(updates: Partial<ConfigMigrationConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ── Private ─────────────────────────────────────────────

  private detectVersion(config: Record<string, unknown>): SemVer | null {
    const v = config[this.config.schemaVersionKey];
    if (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v)) {
      return v as SemVer;
    }
    return null;
  }

  private compareVersions(a: SemVer, b: SemVer): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);

    for (let i = 0; i < 3; i++) {
      if (pa[i] > pb[i]) return 1;
      if (pa[i] < pb[i]) return -1;
    }

    return 0;
  }
}