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
        if (typeof parsed === "object" && parsed !== null) {
          // Ensure numbers are parsed correctly
          for (const [k, v] of Object.entries(parsed)) {
            const c = v as Commitment;
            if (c.createdAt) c.createdAt = Number(c.createdAt);
            if (c.updatedAt) c.updatedAt = Number(c.updatedAt);
            if (c.deadline) c.deadline = Number(c.deadline);
          }
          this.commitments = parsed as CommitmentStore;
        }
      }
    } catch {
      // Silent — start with empty store
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.flush();
    }, 500);
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
      fs.writeFileSync(
        this.storePath,
        JSON.stringify(this.commitments, null, 2),
        "utf-8",
      );
      this.dirty = false;
    } catch {
      // Best-effort persistence
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

    c.status = newStatus;
    c.updatedAt = Date.now();
    if (metadata) {
      c.metadata = { ...c.metadata, ...metadata };
    }

    this.scheduleSave();

    this.eventBus?.publish("commitment.transition", {
      commitmentId: id, from: c.status, to: newStatus,
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
}