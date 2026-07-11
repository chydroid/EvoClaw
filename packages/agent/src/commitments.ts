/**
 * Commitments System — OpenClaw compatibility layer.
 *
 * Tracks promises ("commitments") the agent makes to the user during
 * conversations. Each commitment has a status lifecycle:
 *
 *   pending → in_progress → fulfilled | cancelled
 *
 * Supports:
 *   - Promise creation with optional deadline
 *   - Status transitions
 *   - Reminder triggers (overdue commitments)
 *   - JSON-based persistence
 *   - Conversation-aware scope (linked to sessionId)
 *
 * In OpenClaw, the commitments system is a key part of the agent's
 * reliability — it ensures the agent doesn't "forget" things it promised.
 */
import type { EventBus } from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export type CommitmentStatus =
  | "pending"
  | "in_progress"
  | "fulfilled"
  | "cancelled";

export interface Commitment {
  /** Unique id */
  id: string;
  /** What was promised */
  description: string;
  /** Current status */
  status: CommitmentStatus;
  /** Session this commitment belongs to */
  sessionId?: string;
  /** Agent that made the commitment */
  agentId?: string;
  /** When the commitment was made */
  createdAt: number;
  /** When the status last changed */
  updatedAt: number;
  /** Optional deadline (epoch ms) */
  deadline?: number;
  /** Free-form metadata */
  metadata?: Record<string, unknown>;
  /** Tags for categorisation */
  tags?: string[];
}

export interface CommitmentStore {
  [commitmentId: string]: Commitment;
}

export interface CommitmentFilter {
  status?: CommitmentStatus | CommitmentStatus[];
  sessionId?: string;
  agentId?: string;
  overdue?: boolean;
  tags?: string[];
}

// ──────────────────────────────────────────────────────────────
// CommitmentManager
// ──────────────────────────────────────────────────────────────

export class CommitmentManager {
  private commitments: CommitmentStore = {};
  private storePath: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private eventBus?: EventBus,
    opts?: { storePath?: string },
  ) {
    this.storePath =
      opts?.storePath ||
      path.resolve(process.cwd(), "data", "commitments.json");
    this.load();
  }

  // ── Persistence ──

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          // Ensure numbers are parsed correctly
          for (const [k, v] of Object.entries(parsed)) {
            const c = v as Commitment;
            if (c.createdAt) {
              const n = Number(c.createdAt);
              c.createdAt = Number.isFinite(n) ? n : Date.now();
            }
            if (c.updatedAt) {
              const n = Number(c.updatedAt);
              c.updatedAt = Number.isFinite(n) ? n : Date.now();
            }
            if (c.deadline) {
              const n = Number(c.deadline);
              c.deadline = Number.isFinite(n) ? n : 0;
            }
          }
          this.commitments = parsed as CommitmentStore;
        }
      }
    } catch (err) {
      // 不再静默吞掉错误：记录错误类型、文件路径与堆栈，便于排查
      const error = err as Error;
      process.stderr.write(
        `[CommitmentManager] Failed to load commitments from ${this.storePath}: ` +
        `${error.name}: ${error.message}\n${error.stack ?? ""}\n`
      );
      // JSON 解析失败时备份原文件为 .corrupt-<timestamp>，便于事后恢复，而非直接覆盖
      if (error instanceof SyntaxError && fs.existsSync(this.storePath)) {
        const backupPath = `${this.storePath}.corrupt-${Date.now()}`;
        try {
          fs.copyFileSync(this.storePath, backupPath);
          process.stderr.write(
            `[CommitmentManager] Backed up corrupt store to ${backupPath}\n`
          );
        } catch (backupErr) {
          process.stderr.write(
            `[CommitmentManager] Failed to back up corrupt store: ${(backupErr as Error).message}\n`
          );
        }
      }
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.flush();
    }, 500);
    // unref 防止定时器阻止进程优雅退出
    this.saveTimer.unref();
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // 原子写入：temp + fsync + rename，防止崩溃导致 commitments.json 截断损坏
      const tmpPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
      const fd = fs.openSync(tmpPath, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(this.commitments, null, 2), "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.renameSync(tmpPath, this.storePath);
      } catch {
        // EXDEV/EBUSY 跨设备回退：复制到目标侧临时文件后再 rename，并清理两侧临时文件
        const dstTmp = `${this.storePath}.${process.pid}.${Date.now()}.dst.tmp`;
        try {
          fs.copyFileSync(tmpPath, dstTmp);
          fs.renameSync(dstTmp, this.storePath);
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        } catch (fallbackErr) {
          try { fs.unlinkSync(dstTmp); } catch { /* ignore */ }
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          throw fallbackErr;
        }
      }
      this.dirty = false;
    } catch (err) {
      // Best-effort persistence，但记录错误以便排查
      process.stderr.write("[CommitmentStore] flush failed: " + err + "\n");
    }
  }

  /**
   * 释放资源：清理挂起的 saveTimer。dirty 数据会先尝试落盘。
   */
  dispose(): void {
    if (this.dirty) {
      this.flush();
    } else if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  // ── CRUD ──

  /**
   * Create a new commitment.
   */
  create(params: {
    description: string;
    sessionId?: string;
    agentId?: string;
    deadline?: number;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): Commitment {
    const now = Date.now();
    const id = `cmt_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const commitment: Commitment = {
      id,
      description: params.description,
      status: "pending",
      sessionId: params.sessionId,
      agentId: params.agentId,
      createdAt: now,
      updatedAt: now,
      deadline: params.deadline,
      metadata: params.metadata,
      tags: params.tags,
    };
    this.commitments[id] = commitment;
    this.scheduleSave();

    this.eventBus?.publish("commitment.created", commitment, "commitment-manager");

    return commitment;
  }

  /**
   * Get a single commitment by id.
   */
  get(id: string): Commitment | undefined {
    return this.commitments[id];
  }

  /**
   * Query commitments with optional filters.
   */
  list(filter?: CommitmentFilter): Commitment[] {
    let results = Object.values(this.commitments);

    if (filter?.status) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      results = results.filter((c) => statuses.includes(c.status));
    }

    if (filter?.sessionId) {
      results = results.filter((c) => c.sessionId === filter.sessionId);
    }

    if (filter?.agentId) {
      results = results.filter((c) => c.agentId === filter.agentId);
    }

    if (filter?.overdue) {
      const now = Date.now();
      results = results.filter(
        (c) =>
          c.deadline &&
          c.deadline < now &&
          c.status !== "fulfilled" &&
          c.status !== "cancelled",
      );
    }

    if (filter?.tags && filter.tags.length > 0) {
      results = results.filter((c) =>
        c.tags?.some((t) => filter.tags!.includes(t)),
      );
    }

    // Most recent first
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results;
  }

  /**
   * Transition a commitment to a new status.
   */
  transition(
    id: string,
    newStatus: CommitmentStatus,
    metadata?: Record<string, unknown>,
  ): Commitment | null {
    const c = this.commitments[id];
    if (!c) return null;

    const validTransitions: Record<CommitmentStatus, CommitmentStatus[]> = {
      pending: ["in_progress", "fulfilled", "cancelled"],
      in_progress: ["fulfilled", "cancelled"],
      fulfilled: [],
      cancelled: [],
    };

    if (!validTransitions[c.status].includes(newStatus)) {
      return null; // Invalid transition
    }

    const oldStatus = c.status;
    c.status = newStatus;
    c.updatedAt = Date.now();
    if (metadata) {
      c.metadata = { ...c.metadata, ...metadata };
    }

    this.scheduleSave();

    this.eventBus?.publish("commitment.transition", {
      commitmentId: id, from: oldStatus, to: newStatus,
    }, "commitment-manager");

    return c;
  }

  /**
   * Mark a commitment as fulfilled.
   */
  fulfill(id: string): Commitment | null {
    return this.transition(id, "fulfilled");
  }

  /**
   * Mark a commitment as cancelled.
   */
  cancel(id: string, reason?: string): Commitment | null {
    return this.transition(id, "cancelled", { cancelReason: reason });
  }

  /**
   * Start working on a commitment.
   */
  start(id: string): Commitment | null {
    return this.transition(id, "in_progress");
  }

  /**
   * Delete a commitment entirely.
   */
  delete(id: string): boolean {
    if (!this.commitments[id]) return false;
    delete this.commitments[id];
    this.scheduleSave();

    // 与 create() 一致，发布删除事件供下游订阅
    this.eventBus?.publish("commitment.deleted", { commitmentId: id }, "commitment-manager");

    return true;
  }

  /**
   * Get all overdue commitments (past deadline, not fulfilled/cancelled).
   */
  getOverdue(): Commitment[] {
    return this.list({ overdue: true });
  }

  /**
   * Get active commitment count for a session.
   */
  getActiveCount(sessionId?: string): number {
    return this.list({
      status: ["pending", "in_progress"],
      sessionId,
    }).length;
  }

  /**
   * Build a human-readable summary of active commitments.
   */
  summarize(sessionId?: string): string {
    const active = this.list({
      status: ["pending", "in_progress"],
      sessionId,
    });

    if (active.length === 0) return "No outstanding commitments.";

    const lines = ["**Outstanding Commitments**", ""];
    const pending = active.filter((c) => c.status === "pending");
    const inProgress = active.filter((c) => c.status === "in_progress");

    if (inProgress.length > 0) {
      lines.push("In Progress:");
      for (const c of inProgress) {
        const deadline = c.deadline
          ? ` (due ${new Date(c.deadline).toLocaleDateString()})`
          : "";
        lines.push(`  - [ ] ${c.description}${deadline}`);
      }
    }

    if (pending.length > 0) {
      lines.push("Pending:");
      for (const c of pending) {
        const deadline = c.deadline
          ? ` (due ${new Date(c.deadline).toLocaleDateString()})`
          : "";
        lines.push(`  - [ ] ${c.description}${deadline}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Total number of stored commitments.
   */
  get count(): number {
    return Object.keys(this.commitments).length;
  }

  /**
   * 移除超过指定时间的已完成/已取消承诺，防止 commitments 无界增长。
   * 仅清理终态（fulfilled / cancelled）承诺，活跃承诺不受影响。
   * @param maxAgeMs 最大保留时长（毫秒），基于 updatedAt 判断
   * @returns 被移除的承诺数量
   */
  pruneOlderThan(maxAgeMs: number): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, c] of Object.entries(this.commitments)) {
      if (
        (c.status === "fulfilled" || c.status === "cancelled") &&
        now - c.updatedAt > maxAgeMs
      ) {
        delete this.commitments[id];
        removed++;
      }
    }
    if (removed > 0) {
      this.scheduleSave();
    }
    return removed;
  }
}