/**
 * Last-Known-Good Config — saves snapshots of working configuration
 * and enables rollback when a broken config is detected.
 *
 * OpenClaw-style safety net: before applying a config change, the
 * previous working config is saved. If the new config fails validation
 * or crashes the system, the last-known-good config can be restored.
 *
 * Features:
 *  - Automatic snapshot on config save
 *  - Snapshot rotation (keep N recent)
 *  - Quick rollback to last working config
 *  - Snapshot comparison (diff)
 *  - Integrity check (checksum)
 *  - Snapshot listing with timestamps
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ── Types ─────────────────────────────────────────────────

export interface ConfigSnapshot {
  /** Unique snapshot ID */
  id: string;
  /** When the snapshot was created (ISO string) */
  timestamp: string;
  /** Human-readable label */
  label: string;
  /** Full config content as JSON */
  content: Record<string, unknown>;
  /** SHA-256 checksum of the content */
  checksum: string;
  /** Whether this snapshot was validated successfully */
  validated: boolean;
  /** Source path of the config file */
  sourcePath?: string;
}

export interface LKGConfig {
  /** Directory where snapshots are stored */
  snapshotsDir: string;
  /** Maximum number of snapshots to keep */
  maxSnapshots: number;
  /** Whether to auto-snapshot on config changes */
  autoSnapshot: boolean;
  /** Path to the current config file (for snapshot labeling) */
  configPath?: string;
}

export interface DiffResult {
  /** Keys added in the new config */
  added: string[];
  /** Keys removed from the new config */
  removed: string[];
  /** Keys with changed values */
  changed: Array<{ key: string; oldValue: unknown; newValue: unknown }>;
  /** Whether the configs are identical */
  identical: boolean;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: LKGConfig = {
  snapshotsDir: path.join(process.cwd(), ".lkg-config"),
  maxSnapshots: 10,
  autoSnapshot: true,
};

// ── Manager ────────────────────────────────────────────────

export class LastKnownGoodConfig {
  private config: LKGConfig;
  private counter = 0;

  constructor(config?: Partial<LKGConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Save a snapshot of the current config.
   */
  snapshot(
    content: Record<string, unknown>,
    label?: string,
  ): ConfigSnapshot {
    this.ensureDir();

    const id = `lkg_${Date.now()}_${++this.counter}_${crypto.randomBytes(3).toString("hex")}`;
    const snapshot: ConfigSnapshot = {
      id,
      timestamp: new Date().toISOString(),
      label: label ?? `Snapshot at ${new Date().toLocaleString()}`,
      content,
      checksum: this.computeChecksum(content),
      validated: true,
      sourcePath: this.config.configPath,
    };

    const filePath = this.snapshotPath(id);
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8");

    this.rotateSnapshots();
    return snapshot;
  }

  /**
   * Restore the most recent snapshot. Returns the restored config.
   */
  restore(latestOnly = true): ConfigSnapshot | null {
    const snapshots = this.listSnapshots();
    if (snapshots.length === 0) return null;

    const target = latestOnly ? snapshots[0] : snapshots[snapshots.length - 1];

    // Write restored config back to source
    if (this.config.configPath) {
      const dir = path.dirname(this.config.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.config.configPath,
        JSON.stringify(target.content, null, 2),
        "utf-8",
      );
    }

    return target;
  }

  /**
   * Restore a specific snapshot by ID.
   */
  restoreById(snapshotId: string): ConfigSnapshot | null {
    const snapshots = this.listSnapshots();
    const target = snapshots.find((s) => s.id === snapshotId);
    if (!target) return null;

    if (this.config.configPath) {
      const dir = path.dirname(this.config.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.config.configPath,
        JSON.stringify(target.content, null, 2),
        "utf-8",
      );
    }

    return target;
  }

  /**
   * List all snapshots, newest first.
   */
  listSnapshots(): ConfigSnapshot[] {
    this.ensureDir();
    const files = fs
      .readdirSync(this.config.snapshotsDir)
      .filter((f) => f.startsWith("lkg_") && f.endsWith(".json"));

    const snapshots: ConfigSnapshot[] = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(
          path.join(this.config.snapshotsDir, file),
          "utf-8",
        );
        snapshots.push(JSON.parse(content));
      } catch {
        // Skip corrupted snapshots
      }
    }

    // Sort by timestamp descending (newest first), with ID as tiebreaker
    snapshots.sort(
      (a, b) => {
        const tsDiff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        if (tsDiff !== 0) return tsDiff;
        // Tiebreaker: higher ID = newer (IDs contain Date.now())
        return b.id.localeCompare(a.id);
      },
    );
    return snapshots;
  }

  /**
   * Get the latest snapshot without restoring.
   */
  getLatest(): ConfigSnapshot | null {
    const list = this.listSnapshots();
    return list.length > 0 ? list[0] : null;
  }

  /**
   * Compare two snapshots (or a snapshot vs a current config).
   */
  diff(
    a: ConfigSnapshot | Record<string, unknown>,
    b: ConfigSnapshot | Record<string, unknown>,
  ): DiffResult {
    const aContent: Record<string, unknown> = "content" in a ? (a as ConfigSnapshot).content : a;
    const bContent: Record<string, unknown> = "content" in b ? (b as ConfigSnapshot).content : b;

    const aKeys = this.flattenKeys(aContent);
    const bKeys = this.flattenKeys(bContent);

    const added = bKeys.filter((k) => !aKeys.includes(k));
    const removed = aKeys.filter((k) => !bKeys.includes(k));

    const changed: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];
    for (const key of aKeys) {
      if (!bKeys.includes(key) || removed.includes(key)) continue;
      const oldVal = this.getValueByPath(aContent, key);
      const newVal = this.getValueByPath(bContent, key);
      // Skip object values — leaf key changes are already tracked
      if (typeof oldVal === "object" && oldVal !== null && !Array.isArray(oldVal)) continue;
      if (typeof newVal === "object" && newVal !== null && !Array.isArray(newVal)) continue;
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        changed.push({ key, oldValue: oldVal, newValue: newVal });
      }
    }

    return {
      added,
      removed,
      changed,
      identical: added.length === 0 && removed.length === 0 && changed.length === 0,
    };
  }

  /**
   * Verify the integrity of a snapshot (checksum check).
   */
  verify(snapshotId: string): boolean {
    const snapshots = this.listSnapshots();
    const target = snapshots.find((s) => s.id === snapshotId);
    if (!target) return false;

    const computed = this.computeChecksum(target.content);
    return computed === target.checksum;
  }

  /**
   * Delete a specific snapshot.
   */
  deleteSnapshot(snapshotId: string): boolean {
    const filePath = this.snapshotPath(snapshotId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  /**
   * Delete all snapshots older than N days.
   */
  pruneSnapshots(maxAgeDays: number): number {
    const snapshots = this.listSnapshots();
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let deleted = 0;

    for (const snapshot of snapshots) {
      if (new Date(snapshot.timestamp).getTime() < cutoff) {
        if (this.deleteSnapshot(snapshot.id)) deleted++;
      }
    }
    return deleted;
  }

  /**
   * Check if the config change is safe (no large deltas).
   * Returns warnings if the change seems risky.
   */
  validateChange(
    newConfig: Record<string, unknown>,
    previousSnapshot?: ConfigSnapshot,
  ): { safe: boolean; warnings: string[] } {
    const warnings: string[] = [];
    const previous = previousSnapshot ?? this.getLatest();

    if (!previous) return { safe: true, warnings: [] };

    const diff = this.diff(previous, newConfig);

    if (diff.removed.length > 10) {
      warnings.push(`Large removal: ${diff.removed.length} keys removed at once`);
    }
    if (diff.added.length > 20) {
      warnings.push(`Large addition: ${diff.added.length} keys added at once`);
    }
    if (diff.changed.length > 20) {
      warnings.push(`Large modification: ${diff.changed.length} keys changed at once`);
    }

    return {
      safe: warnings.length === 0,
      warnings,
    };
  }

  configure(updates: Partial<LKGConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ── Private ─────────────────────────────────────────────

  private ensureDir(): void {
    if (!fs.existsSync(this.config.snapshotsDir)) {
      fs.mkdirSync(this.config.snapshotsDir, { recursive: true });
    }
  }

  private snapshotPath(id: string): string {
    return path.join(this.config.snapshotsDir, `${id}.json`);
  }

  private computeChecksum(content: Record<string, unknown>): string {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(content))
      .digest("hex");
  }

  private rotateSnapshots(): void {
    const snapshots = this.listSnapshots();
    if (snapshots.length <= this.config.maxSnapshots) return;

    // Delete oldest snapshots (they're sorted newest first)
    const toDelete = snapshots.slice(this.config.maxSnapshots);
    for (const snapshot of toDelete) {
      this.deleteSnapshot(snapshot.id);
    }
  }

  private flattenKeys(
    obj: Record<string, unknown>,
    prefix = "",
  ): string[] {
    const keys: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      keys.push(fullKey);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        keys.push(...this.flattenKeys(value as Record<string, unknown>, fullKey));
      }
    }
    return keys.sort();
  }

  private getValueByPath(
    obj: Record<string, unknown>,
    path: string,
  ): unknown {
    const parts = path.split(".");
    let current: unknown = obj;
    for (const part of parts) {
      if (current && typeof current === "object" && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return current;
  }
}