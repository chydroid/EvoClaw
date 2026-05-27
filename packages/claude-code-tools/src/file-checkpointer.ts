/**
 * File Checkpointer — 文件变更快照与回滚
 *
 * 借鉴 Claude Code 的 Checkpointing 机制：
 *   - 在关键操作前创建文件快照
 *   - 支持回滚到任意检查点
 *   - 基于 diff 的精简回滚
 *
 * 参考: https://code.claude.com/docs/en/agent-sdk/file-checkpointing
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ──

export interface FileSnapshot {
  /** Original file path */
  filePath: string;
  /** Backup content (base64 for binary safety) */
  content: string;
  /** File size in bytes */
  size: number;
  /** Snapshot timestamp */
  timestamp: number;
}

export interface Checkpoint {
  /** Unique checkpoint ID */
  id: string;
  /** Human label (e.g. "before-auth-refactor") */
  label: string;
  /** All file snapshots in this checkpoint */
  snapshots: FileSnapshot[];
  /** Session ID */
  sessionId: string;
  /** Creation timestamp */
  createdAt: number;
  /** Parent checkpoint (for chains) */
  parentId?: string;
}

// ── Checkpointer ──

export class FileCheckpointer {
  private checkpoints = new Map<string, Checkpoint>();
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? process.cwd();
  }

  /**
   * Create a checkpoint by snapshotting all files matching the given globs.
   * (Claude Code: file checkpoint before major writes)
   */
  createCheckpoint(
    label: string,
    filePaths: string[],
    options: { sessionId?: string; parentId?: string } = {},
  ): Checkpoint {
    const snapshots: FileSnapshot[] = [];

    for (const relPath of filePaths) {
      const fullPath = path.resolve(this.baseDir, relPath);
      if (!fs.existsSync(fullPath)) continue;

      try {
        const content = fs.readFileSync(fullPath);
        snapshots.push({
          filePath: relPath,
          content: content.toString("base64"),
          size: content.length,
          timestamp: Date.now(),
        });
      } catch {
        // Skip unreadable files
      }
    }

    const checkpoint: Checkpoint = {
      id: crypto.randomUUID(),
      label,
      snapshots,
      sessionId: options.sessionId ?? "default",
      createdAt: Date.now(),
      parentId: options.parentId,
    };

    this.checkpoints.set(checkpoint.id, checkpoint);
    return checkpoint;
  }

  /**
   * Rollback to a specific checkpoint — restore all snapshotted files.
   * Returns the list of restored files.
   */
  rollback(checkpointId: string): { restored: string[]; failed: string[] } {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      return { restored: [], failed: [`Checkpoint ${checkpointId} not found`] };
    }

    const restored: string[] = [];
    const failed: string[] = [];

    for (const snapshot of checkpoint.snapshots) {
      const fullPath = path.resolve(this.baseDir, snapshot.filePath);
      try {
        // Ensure parent directory exists
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(fullPath, Buffer.from(snapshot.content, "base64"));
        restored.push(snapshot.filePath);
      } catch (err) {
        failed.push(`${snapshot.filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { restored, failed };
  }

  /**
   * Discard a checkpoint (free memory).
   */
  discard(checkpointId: string): boolean {
    return this.checkpoints.delete(checkpointId);
  }

  /**
   * List all checkpoints, most recent first.
   */
  list(options: { sessionId?: string } = {}): Checkpoint[] {
    let all = Array.from(this.checkpoints.values());
    if (options.sessionId) {
      all = all.filter((c) => c.sessionId === options.sessionId);
    }
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get a specific checkpoint by ID.
   */
  get(checkpointId: string): Checkpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  /**
   * Create a diff-based rollback (only restore files that changed).
   * More efficient than full rollback for large projects.
   */
  rollbackChanged(checkpointId: string): { restored: string[]; skipped: string[]; failed: string[] } {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      return { restored: [], skipped: [], failed: [`Checkpoint ${checkpointId} not found`] };
    }

    const restored: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    for (const snapshot of checkpoint.snapshots) {
      const fullPath = path.resolve(this.baseDir, snapshot.filePath);

      try {
        if (fs.existsSync(fullPath)) {
          const currentContent = fs.readFileSync(fullPath);
          const snapshotContent = Buffer.from(snapshot.content, "base64");

          if (currentContent.equals(snapshotContent)) {
            skipped.push(snapshot.filePath);
            continue;
          }
        }

        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullPath, Buffer.from(snapshot.content, "base64"));
        restored.push(snapshot.filePath);
      } catch (err) {
        failed.push(`${snapshot.filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { restored, skipped, failed };
  }

  /**
   * Get the diff summary between a checkpoint and current files.
   */
  diffCheckpoint(checkpointId: string): {
    added: string[];
    removed: string[];
    modified: string[];
    unchanged: string[];
  } {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      return { added: [], removed: [], modified: [], unchanged: [] };
    }

    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    const unchanged: string[] = [];

    const snapshotPaths = new Set(checkpoint.snapshots.map((s) => s.filePath));

    // Check snapshot files against current
    for (const snapshot of checkpoint.snapshots) {
      const fullPath = path.resolve(this.baseDir, snapshot.filePath);
      if (!fs.existsSync(fullPath)) {
        removed.push(snapshot.filePath);
      } else {
        const currentContent = fs.readFileSync(fullPath);
        const snapshotContent = Buffer.from(snapshot.content, "base64");
        if (currentContent.equals(snapshotContent)) {
          unchanged.push(snapshot.filePath);
        } else {
          modified.push(snapshot.filePath);
        }
      }
    }

    // Check for new files not in the checkpoint (we can only detect within existing dirs)
    // This is approximate — we don't do full filesystem scan

    return { added, removed, modified, unchanged };
  }
}