/**
 * Execution Checkpoint — Durable Execution & Checkpointing
 *
 * Stores snapshots of execution state after each tool call in the LLM loop,
 * enabling crash recovery and time-travel debugging.
 */

import * as fs from "fs";
import * as path from "path";

/** Snapshot of execution state at a given point */
export interface ExecutionSnapshot {
  sessionId: string;
  stepIndex: number;
  stepType: "llm_call" | "tool_call" | "tool_result" | "memory_search" | "skill_dispatch";
  timestamp: number;
  /** Serialized conversation messages up to this point */
  messages: Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>;
  /** Tool call being executed (if stepType is tool_call) */
  currentToolCall?: { name: string; arguments: string };
  /** Tool result (if stepType is tool_result) */
  toolResult?: { name: string; result: string; success: boolean };
  /** Token usage so far */
  tokensUsed: number;
  /** Duration so far in ms */
  durationMs: number;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/** Full execution state that can be restored */
export interface ExecutionState {
  sessionId: string;
  originalMessage: string;
  startTime: number;
  lastCheckpointTime: number;
  status: "running" | "completed" | "failed" | "interrupted";
  snapshots: ExecutionSnapshot[];
  finalResult?: string;
  error?: string;
}

export class ExecutionCheckpointStore {
  private storeDir: string;
  private activeExecutions = new Map<string, ExecutionState>();

  constructor(baseDir?: string) {
    this.storeDir = baseDir || path.resolve(process.cwd(), "data", "execution-checkpoints");
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }
    this.loadFromDisk();
  }

  /** Start tracking a new execution */
  startExecution(sessionId: string, originalMessage: string): ExecutionState {
    const state: ExecutionState = {
      sessionId,
      originalMessage,
      startTime: Date.now(),
      lastCheckpointTime: Date.now(),
      status: "running",
      snapshots: [],
    };
    this.activeExecutions.set(sessionId, state);
    this.persistToDisk(sessionId, state);
    return state;
  }

  /** Save a checkpoint snapshot */
  saveSnapshot(sessionId: string, snapshot: ExecutionSnapshot): void {
    const state = this.activeExecutions.get(sessionId);
    if (!state) return;
    snapshot.timestamp = Date.now();
    state.snapshots.push(snapshot);
    state.lastCheckpointTime = Date.now();
    this.persistToDisk(sessionId, state);
  }

  /** Mark execution as completed */
  completeExecution(sessionId: string, result: string): void {
    const state = this.activeExecutions.get(sessionId);
    if (!state) return;
    state.status = "completed";
    state.finalResult = result;
    state.lastCheckpointTime = Date.now();
    this.persistToDisk(sessionId, state);
  }

  /** Mark execution as failed */
  failExecution(sessionId: string, error: string): void {
    const state = this.activeExecutions.get(sessionId);
    if (!state) return;
    state.status = "failed";
    state.error = error;
    state.lastCheckpointTime = Date.now();
    this.persistToDisk(sessionId, state);
  }

  /** Get execution state */
  getExecution(sessionId: string): ExecutionState | undefined {
    return this.activeExecutions.get(sessionId);
  }

  /** Find all interrupted/failed executions that can be resumed */
  getResumableExecutions(): ExecutionState[] {
    return Array.from(this.activeExecutions.values())
      .filter(s => s.status === "running" || s.status === "failed" || s.status === "interrupted");
  }

  /** Resume from a specific snapshot index */
  getSnapshotForResume(sessionId: string, snapshotIndex?: number): { messages: ExecutionSnapshot["messages"]; originalMessage: string } | null {
    const state = this.activeExecutions.get(sessionId);
    if (!state || state.snapshots.length === 0) return null;

    const idx = snapshotIndex ?? state.snapshots.length - 1;
    const snapshot = state.snapshots[idx];
    if (!snapshot) return null;

    return {
      messages: snapshot.messages,
      originalMessage: state.originalMessage,
    };
  }

  /** Get a specific snapshot for time-travel debugging */
  getSnapshot(sessionId: string, snapshotIndex: number): ExecutionSnapshot | undefined {
    const state = this.activeExecutions.get(sessionId);
    return state?.snapshots[snapshotIndex];
  }

  /** Get all snapshots for a session */
  getAllSnapshots(sessionId: string): ExecutionSnapshot[] {
    const state = this.activeExecutions.get(sessionId);
    return state?.snapshots ?? [];
  }

  /** Delete an execution */
  deleteExecution(sessionId: string): void {
    this.activeExecutions.delete(sessionId);
    try {
      const filePath = path.join(this.storeDir, `${sessionId}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* ignore */ }
  }

  /** Clean up old completed executions (older than maxAge ms) */
  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [sessionId, state] of this.activeExecutions) {
      if (state.status === "completed" && now - state.lastCheckpointTime > maxAgeMs) {
        this.deleteExecution(sessionId);
        cleaned++;
      }
    }
    return cleaned;
  }

  private persistToDisk(sessionId: string, state: ExecutionState): void {
    try {
      const filePath = path.join(this.storeDir, `${sessionId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(state), "utf-8");
    } catch (err) {
      console.warn(`[ExecutionCheckpointStore] Failed to persist execution ${sessionId}:`, err);
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.storeDir)) return;
      const files = fs.readdirSync(this.storeDir).filter(f => f.endsWith(".json"));
      const now = Date.now();
      const MAX_AGE = 24 * 60 * 60 * 1000;
      for (const file of files) {
        try {
          const data = fs.readFileSync(path.join(this.storeDir, file), "utf-8");
          const state = JSON.parse(data) as ExecutionState;
          // Only load recent, non-completed executions
          if (now - state.lastCheckpointTime < MAX_AGE || state.status !== "completed") {
            // Mark running executions as interrupted (they crashed)
            if (state.status === "running") {
              state.status = "interrupted";
            }
            this.activeExecutions.set(state.sessionId, state);
          } else {
            fs.unlinkSync(path.join(this.storeDir, file));
          }
        } catch { /* skip corrupt files */ }
      }
    } catch { /* ignore */ }
    console.log(`[ExecutionCheckpointStore] Loaded ${this.activeExecutions.size} execution states from disk`);
  }
}
