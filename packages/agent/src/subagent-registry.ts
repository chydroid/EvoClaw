/**
 * SubagentRegistry — manages child/spawned subagents with lifecycle tracking.
 *
 * Each subagent has its own session, workspace, and tool policy.
 * Supports spawning, status queries, termination, listing, and cleanup
 * with a configurable concurrency cap and event emission.
 */

import { EventBus } from "@evoclaw/core";
import { v4 as uuid } from "uuid";
import type { ToolPolicy } from "./agent-router";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Subagent lifecycle status */
export type SubagentStatus = "idle" | "running" | "done" | "error";

/** Events emitted by the subagent registry */
export type SubagentEvent = "spawn" | "complete" | "error" | "kill" | "cleanup";

/** Configuration used when spawning a new subagent */
export interface SubagentConfig {
  /** ID of the parent agent that owns this subagent */
  parentAgentId: string;
  /** Session ID to associate (auto-generated if omitted) */
  sessionId?: string;
  /** Workspace directory for the subagent */
  workspace: string;
  /** Tool policy controlling what this subagent is allowed to do */
  toolPolicy: ToolPolicy;
  /** Optional human-readable label */
  label?: string;
  /** Optional metadata payload */
  metadata?: Record<string, unknown>;
}

/** Runtime information about a spawned subagent */
export interface SubagentInfo {
  /** Unique subagent identifier */
  id: string;
  /** ID of the parent agent */
  parentAgentId: string;
  /** Session ID */
  sessionId: string;
  /** Current lifecycle status */
  status: SubagentStatus;
  /** Workspace directory */
  workspace: string;
  /** Effective tool policy */
  toolPolicy: ToolPolicy;
  /** Optional label */
  label?: string;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** ISO-8601 last-activity timestamp */
  lastActive: string;
  /** Error message when status is "error" */
  error?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/** Filter criteria for list() */
export interface SubagentListFilter {
  /** Filter by status */
  status?: SubagentStatus | SubagentStatus[];
  /** Filter by parent agent ID */
  parentAgentId?: string;
}

/** Event payload emitted on spawn / complete / error / kill / cleanup */
export interface SubagentRegistryEvent {
  event: SubagentEvent;
  subagent: SubagentInfo;
  timestamp: string;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CONCURRENT = 10;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

// ─── SubagentRegistry ─────────────────────────────────────────────────────────

export class SubagentRegistry {
  private subagents = new Map<string, SubagentInfo>();
  private maxConcurrent: number;

  constructor(
    private eventBus: EventBus,
    maxConcurrent?: number,
  ) {
    this.maxConcurrent = maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  // ─── Spawn ─────────────────────────────────────────────────────────────────

  /**
   * Spawn a new subagent with its own session, workspace, and tool policy.
   * Fails if the concurrent subagent limit has been reached.
   */
  spawn(config: SubagentConfig): SubagentInfo {
    if (this.subagents.size >= this.maxConcurrent) {
      throw new Error(
        `Subagent limit reached (${this.maxConcurrent}). Kill or wait for existing subagents before spawning more.`,
      );
    }

    const now = new Date().toISOString();
    const info: SubagentInfo = {
      id: `subagent_${uuid()}`,
      parentAgentId: config.parentAgentId,
      sessionId: config.sessionId ?? `subsession_${uuid()}`,
      status: "running",
      workspace: config.workspace,
      toolPolicy: config.toolPolicy,
      label: config.label,
      createdAt: now,
      lastActive: now,
      metadata: config.metadata,
    };

    this.subagents.set(info.id, info);
    this.emit("spawn", info);

    process.stdout.write(
      `[SubagentRegistry] Spawned subagent "${info.id}" for parent "${info.parentAgentId}"`,
    );

    return info;
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  /** Get the current status / info for a subagent */
  status(id: string): SubagentInfo | undefined {
    return this.subagents.get(id);
  }

  // ─── Complete / Error (called by the subagent runner) ───────────────────────

  /** Mark a subagent as done */
  markDone(id: string): boolean {
    const info = this.subagents.get(id);
    if (!info) return false;

    info.status = "done";
    info.lastActive = new Date().toISOString();
    this.emit("complete", info);
    process.stdout.write(`[SubagentRegistry] Subagent "${id}" completed`);
    return true;
  }

  /** Mark a subagent as errored */
  markError(id: string, error: string): boolean {
    const info = this.subagents.get(id);
    if (!info) return false;

    info.status = "error";
    info.error = error;
    info.lastActive = new Date().toISOString();
    this.emit("error", info);
    process.stderr.write(`[SubagentRegistry] Subagent "${id}" errored: ${error}`);
    return true;
  }

  /** Update lastActive timestamp (touch) */
  touch(id: string): boolean {
    const info = this.subagents.get(id);
    if (!info) return false;

    info.lastActive = new Date().toISOString();
    return true;
  }

  // ─── Kill ──────────────────────────────────────────────────────────────────

  /** Terminate a subagent immediately */
  kill(id: string): boolean {
    const info = this.subagents.get(id);
    if (!info) return false;

    this.subagents.delete(id);
    this.emit("kill", info);
    process.stdout.write(`[SubagentRegistry] Killed subagent "${id}"`);
    return true;
  }

  // ─── List ──────────────────────────────────────────────────────────────────

  /**
   * List subagents, optionally filtered by status and/or parent agent.
   * Results are sorted by creation time descending (newest first).
   */
  list(filter?: SubagentListFilter): SubagentInfo[] {
    let results = Array.from(this.subagents.values());

    if (filter) {
      if (filter.status !== undefined) {
        const allowed = Array.isArray(filter.status) ? filter.status : [filter.status];
        results = results.filter((s) => allowed.includes(s.status));
      }
      if (filter.parentAgentId !== undefined) {
        results = results.filter((s) => s.parentAgentId === filter.parentAgentId);
      }
    }

    return results.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Remove subagents that are done, errored, or idle beyond `maxAgeMs`.
   * @param maxAgeMs Maximum age in ms before a dead/idle subagent is eligible for removal (default 30 min)
   * @returns Count of removed subagents
   */
  cleanup(maxAgeMs?: number): number {
    const now = Date.now();
    const threshold = maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    let removed = 0;

    for (const [id, info] of this.subagents) {
      // Only auto-remove terminal states
      if (info.status !== "done" && info.status !== "error") continue;

      const age = now - new Date(info.lastActive).getTime();
      if (age >= threshold) {
        this.subagents.delete(id);
        this.emit("cleanup", info);
        removed++;
      }
    }

    if (removed > 0) {
      process.stdout.write(`[SubagentRegistry] Cleaned up ${removed} subagent(s)`);
    }

    return removed;
  }

  // ─── Query ─────────────────────────────────────────────────────────────────

  /** Get the current count of active subagents */
  get count(): number {
    return this.subagents.size;
  }

  /** Get the max concurrent limit */
  get limit(): number {
    return this.maxConcurrent;
  }

  /** Check how many more subagents can be spawned */
  get availableSlots(): number {
    return Math.max(0, this.maxConcurrent - this.subagents.size);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private emit(event: SubagentEvent, info: SubagentInfo): void {
    const payload: SubagentRegistryEvent = {
      event,
      subagent: info,
      timestamp: new Date().toISOString(),
    };

    this.eventBus.publish(`subagent.${event}`, payload, "subagent-registry").catch((err) => {
      process.stderr.write(`[SubagentRegistry] EventBus publish failed for "${event}":` + " " + err);
    });
  }
}