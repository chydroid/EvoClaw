/**
 * Progress Drafts — streaming progress reporting for long-running
 * agent operations. Enables the agent to emit structured progress
 * updates during task execution, which can be consumed by channels
 * to show real-time status to users.
 *
 * Features:
 *  - Draft state machine (pending → running → completed/failed)
 *  - Streaming progress events with percentage and status
 *  - Sub-task tracking with parent-child hierarchy
 *  - Time-based auto-completion for stuck drafts
 *  - Event-driven subscriber model
 *  - History with TTL-based cleanup
 */

import { EventEmitter } from "events";

// ── Types ─────────────────────────────────────────────────

export type DraftStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface ProgressDraft {
  /** Unique draft ID */
  id: string;
  /** Parent draft ID (for sub-tasks) */
  parentId?: string;
  /** Short label describing the task */
  label: string;
  /** Detailed description of current step */
  description?: string;
  /** Current status */
  status: DraftStatus;
  /** Progress percentage (0-100) */
  progress: number;
  /** Current step index */
  currentStep?: number;
  /** Total steps (if known) */
  totalSteps?: number;
  /** Result message (on completion/failure) */
  result?: string;
  /** Error details (on failure) */
  error?: string;
  /** When the draft was created */
  createdAt: number;
  /** When the draft was last updated */
  updatedAt: number;
  /** When the draft completed/failed (if done) */
  completedAt?: number;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

export interface ProgressEvent {
  type: "created" | "updated" | "completed" | "failed" | "cancelled";
  draft: ProgressDraft;
  /** Previous draft state (for updated events) */
  previous?: ProgressDraft;
}

export interface ProgressDraftsConfig {
  /** Maximum number of completed drafts to keep in history */
  maxHistory?: number;
  /** TTL for completed draft history in ms (default: 1 hour) */
  historyTTLMs?: number;
  /** Auto-complete drafts stuck at 100% for this long (ms) */
  autoCompleteStuckMs?: number;
  /** Garbage collection interval in ms (default: 60000) */
  gcIntervalMs?: number;
}

export type ProgressListener = (event: ProgressEvent) => void;

// ── Progress Manager ──────────────────────────────────────

export class ProgressDraftsManager extends EventEmitter {
  private drafts = new Map<string, ProgressDraft>();
  private draftHistory: ProgressDraft[] = [];
  private config: Required<ProgressDraftsConfig>;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private idCounter = 0;

  constructor(config: ProgressDraftsConfig = {}) {
    super();
    this.config = {
      maxHistory: config.maxHistory ?? 100,
      historyTTLMs: config.historyTTLMs ?? 3_600_000, // 1 hour
      autoCompleteStuckMs: config.autoCompleteStuckMs ?? 300_000, // 5 min
      gcIntervalMs: config.gcIntervalMs ?? 60_000,
    };
  }

  // ── Draft Lifecycle ─────────────────────────────────────

  /** Create a new progress draft and start tracking */
  createDraft(
    label: string,
    options?: {
      parentId?: string;
      totalSteps?: number;
      description?: string;
      metadata?: Record<string, unknown>;
    }
  ): ProgressDraft {
    const id = this.generateId();
    const now = Date.now();

    const draft: ProgressDraft = {
      id,
      parentId: options?.parentId,
      label,
      description: options?.description ?? label,
      status: "pending",
      progress: 0,
      currentStep: 0,
      totalSteps: options?.totalSteps,
      createdAt: now,
      updatedAt: now,
      metadata: options?.metadata,
    };

    // Attach to parent if specified
    if (options?.parentId) {
      const parent = this.drafts.get(options.parentId);
      if (parent) {
        if (!parent.metadata) {
          parent.metadata = {};
        }
        const children = (parent.metadata.children as string[]) ?? [];
        children.push(id);
        parent.metadata.children = children;
        parent.updatedAt = now;
        this.emit("draft:updated", {
          type: "updated",
          draft: parent,
          previous: { ...parent },
        });
      }
    }

    this.drafts.set(id, draft);
    this.emit("draft:created", { type: "created", draft: { ...draft } });

    return draft;
  }

  /** Update an existing draft's progress */
  updateDraft(
    id: string,
    update: {
      status?: DraftStatus;
      progress?: number;
      currentStep?: number;
      description?: string;
      metadata?: Record<string, unknown>;
    }
  ): ProgressDraft | null {
    const draft = this.drafts.get(id);
    if (!draft) return null;

    const previous = { ...draft };

    if (update.status !== undefined) draft.status = update.status;
    if (update.progress !== undefined) draft.progress = Math.max(0, Math.min(100, update.progress));
    if (update.currentStep !== undefined) draft.currentStep = update.currentStep;
    if (update.description !== undefined) draft.description = update.description;
    if (update.metadata !== undefined) draft.metadata = { ...draft.metadata, ...update.metadata };

    draft.updatedAt = Date.now();

    this.emit("draft:updated", { type: "updated", draft: { ...draft }, previous });
    return draft;
  }

  /** Mark a draft as completed */
  completeDraft(id: string, result?: string): ProgressDraft | null {
    const draft = this.drafts.get(id);
    if (!draft) return null;

    const previous = { ...draft };
    const now = Date.now();

    draft.status = "completed";
    draft.progress = 100;
    draft.result = result;
    draft.completedAt = now;
    draft.updatedAt = now;

    this.moveToHistory(draft);
    this.drafts.delete(id);

    this.emit("draft:completed", { type: "completed", draft: { ...draft }, previous });
    return draft;
  }

  /** Mark a draft as failed */
  failDraft(id: string, error: string): ProgressDraft | null {
    const draft = this.drafts.get(id);
    if (!draft) return null;

    const previous = { ...draft };
    const now = Date.now();

    draft.status = "failed";
    draft.error = error;
    draft.completedAt = now;
    draft.updatedAt = now;

    this.moveToHistory(draft);
    this.drafts.delete(id);

    this.emit("draft:failed", { type: "failed", draft: { ...draft }, previous });
    return draft;
  }

  /** Cancel a running draft */
  cancelDraft(id: string, reason?: string): ProgressDraft | null {
    const draft = this.drafts.get(id);
    if (!draft) return null;

    const previous = { ...draft };
    const now = Date.now();

    draft.status = "cancelled";
    draft.result = reason ?? "Cancelled";
    draft.completedAt = now;
    draft.updatedAt = now;

    this.moveToHistory(draft);
    this.drafts.delete(id);

    this.emit("draft:cancelled", { type: "cancelled", draft: { ...draft }, previous });
    return draft;
  }

  // ── Queries ─────────────────────────────────────────────

  /** Get a specific draft by ID */
  getDraft(id: string): ProgressDraft | undefined {
    return this.drafts.get(id);
  }

  /** Get all active (non-terminal) drafts */
  getActiveDrafts(): ProgressDraft[] {
    return Array.from(this.drafts.values())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Get all drafts including history */
  getAllDrafts(): ProgressDraft[] {
    const active = this.getActiveDrafts();
    return [...active, ...this.draftHistory];
  }

  /** Get child drafts of a parent */
  getChildren(parentId: string): ProgressDraft[] {
    const parent = this.drafts.get(parentId);
    if (!parent?.metadata?.children) return [];
    const childIds = parent.metadata.children as string[];
    return childIds
      .map((id) => this.drafts.get(id))
      .filter((d): d is ProgressDraft => d !== undefined);
  }

  /** Get drafts by status */
  getByStatus(status: DraftStatus): ProgressDraft[] {
    if (status === "completed" || status === "failed" || status === "cancelled") {
      return this.draftHistory.filter((d) => d.status === status);
    }
    return Array.from(this.drafts.values()).filter((d) => d.status === status);
  }

  /** Get a summary of all active drafts for channel display */
  getActiveSummary(): string {
    const active = this.getActiveDrafts();
    if (active.length === 0) return "";

    const lines = active.map((d) => {
      const pct = d.progress;
      const bar = this.progressBar(pct);
      const step = d.totalSteps ? ` (${d.currentStep ?? 0}/${d.totalSteps})` : "";
      return `${bar} ${d.label}${step}: ${d.description ?? ""}`;
    });

    return lines.join("\n");
  }

  // ── Batch Operations ────────────────────────────────────

  /** Create multiple sub-tasks under a parent */
  createSubTasks(
    parentId: string,
    tasks: Array<{ label: string; description?: string }>
  ): ProgressDraft[] {
    return tasks.map((t) =>
      this.createDraft(t.label, {
        parentId,
        description: t.description,
      })
    );
  }

  /** Run a step with automatic progress tracking */
  async runStep<T>(
    draftId: string,
    stepIndex: number,
    description: string,
    fn: () => Promise<T>
  ): Promise<T> {
    this.updateDraft(draftId, {
      status: "running",
      currentStep: stepIndex,
      description,
    });

    try {
      const result = await fn();
      return result;
    } catch (err) {
      this.failDraft(draftId, (err as Error).message);
      throw err;
    }
  }

  // ── Lifecycle ───────────────────────────────────────────

  /** Start periodic garbage collection */
  startGC(): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => {
      try { this.collectGarbage(); } catch (err) {
        process.stderr.write(`[ProgressDrafts] GC failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }, this.config.gcIntervalMs);
    // 避免定时器阻止进程退出
    this.gcTimer.unref?.();
  }

  /** Stop periodic garbage collection */
  stopGC(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  /** Clear all drafts and history */
  clear(): void {
    this.drafts.clear();
    this.draftHistory = [];
    this.idCounter = 0;
  }

  /** Get count of active drafts */
  get activeCount(): number {
    return this.drafts.size;
  }

  /** Get count of completed history drafts */
  get historyCount(): number {
    return this.draftHistory.length;
  }

  /** Subscribe to all draft events */
  onEvent(listener: ProgressListener): () => void {
    const types = ["draft:created", "draft:updated", "draft:completed", "draft:failed", "draft:cancelled"];
    for (const type of types) {
      this.on(type, listener);
    }
    return () => {
      for (const type of types) {
        this.off(type, listener);
      }
    };
  }

  // ── Internal ────────────────────────────────────────────

  private generateId(): string {
    this.idCounter++;
    return `draft_${Date.now()}_${this.idCounter.toString(36)}`;
  }

  private moveToHistory(draft: ProgressDraft): void {
    this.draftHistory.push(draft);
    // Trim history to max size
    if (this.draftHistory.length > this.config.maxHistory) {
      this.draftHistory = this.draftHistory.slice(-this.config.maxHistory);
    }
  }

  private collectGarbage(): void {
    const now = Date.now();
    const ttl = this.config.historyTTLMs;

    // Clean expired history
    this.draftHistory = this.draftHistory.filter(
      (d) => now - (d.completedAt ?? d.createdAt) < ttl
    );

    // Auto-complete stuck drafts
    const stuckMs = this.config.autoCompleteStuckMs;
    for (const [id, draft] of this.drafts) {
      if (
        draft.status === "running" &&
        draft.progress >= 100 &&
        now - draft.updatedAt > stuckMs
      ) {
        this.completeDraft(id, "Auto-completed (stuck)");
      }
    }
  }

  private progressBar(pct: number): string {
    const width = 10;
    const filled = Math.round((pct / 100) * width);
    const empty = width - filled;
    return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${pct}%`;
  }
}