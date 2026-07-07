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
// 运行/空闲态子代理若超过此阈值仍未推进，视为父代理崩溃后遗留，允许清理
const STALE_RUNNING_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── SubagentRegistry ─────────────────────────────────────────────────────────

export class SubagentRegistry {
  private subagents = new Map<string, SubagentInfo>();
  private maxConcurrent: number;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private eventBus: EventBus,
    maxConcurrent?: number,
  ) {
    this.maxConcurrent = maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    // 周期性清理：避免父代理崩溃或忘记 markDone 时 subagents Map 无限增长
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  /**
   * 释放资源：停止周期性清理定时器。
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ─── Spawn ─────────────────────────────────────────────────────────────────

  /**
   * Spawn a new subagent with its own session, workspace, and tool policy.
   * Fails if the concurrent subagent limit has been reached or if spawning
   * would create a parent-child cycle (A spawns B, B spawns A).
   */
  spawn(config: SubagentConfig): SubagentInfo {
    const runningCount = Array.from(this.subagents.values()).filter((s) => s.status === "running").length;
    if (runningCount >= this.maxConcurrent) {
      throw new Error(
        `Subagent limit reached (${this.maxConcurrent}). Kill or wait for existing subagents before spawning more.`,
      );
    }

    // 循环检测：遍历 config.parentAgentId 的祖先链，若发现 config.parentAgentId
    // 本身就是当前要创建的 subagent 的后代（即 parent 的祖先链中已有该 parent），
    // 则会形成 A→B→A 循环，导致无限递归 spawn。
    if (config.parentAgentId) {
      if (this.wouldCreateCycle(config.parentAgentId, config.parentAgentId)) {
        throw new Error(
          `Cycle detected: parent agent "${config.parentAgentId}" is already a descendant. Spawning would create an infinite loop.`,
        );
      }
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
      `[SubagentRegistry] Spawned subagent "${info.id}" for parent "${info.parentAgentId}"\n`
    );

    return info;
  }

  /**
   * 检测从 agentId 向上遍历祖先链是否会回到 agentId 自身（形成环）。
   * agentId 是即将被 spawn 的 subagent 的 parentAgentId。
   * 如果 agentId 本身是某个 subagent 的 id，我们检查它的祖先链是否已包含 agentId。
   */
  private wouldCreateCycle(agentId: string, _originalAgentId: string, visited?: Set<string>): boolean {
    const seen = visited ?? new Set<string>();
    if (seen.has(agentId)) return true;
    seen.add(agentId);

    // 查找 agentId 是否是某个 subagent（即它有自己的 parentAgentId）
    const subagent = this.subagents.get(agentId);
    if (!subagent || !subagent.parentAgentId) return false;

    // 递归向上遍历父链
    return this.wouldCreateCycle(subagent.parentAgentId, _originalAgentId, seen);
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
    process.stdout.write(`[SubagentRegistry] Subagent "${id}" completed\n`);
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
    process.stderr.write(`[SubagentRegistry] Subagent "${id}" errored: ${error}\n`);
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
    process.stdout.write(`[SubagentRegistry] Killed subagent "${id}"\n`);
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
   * 运行/空闲态子代理若超过 STALE_RUNNING_MAX_AGE_MS 仍未推进 lastActive，
   * 视为父代理崩溃后遗留，也一并清理，避免 Map 无限增长。
   * @param maxAgeMs Maximum age in ms before a dead/idle subagent is eligible for removal (default 30 min)
   * @returns Count of removed subagents
   */
  cleanup(maxAgeMs?: number): number {
    const now = Date.now();
    const threshold = maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    let removed = 0;

    for (const [id, info] of this.subagents) {
      const age = now - new Date(info.lastActive).getTime();

      if (info.status === "done" || info.status === "error") {
        if (age >= threshold) {
          this.subagents.delete(id);
          this.emit("cleanup", info);
          removed++;
        }
      } else if (info.status === "running" || info.status === "idle") {
        // 长时间未推进的 running/idle 视为孤儿条目，清理以防 Map 泄漏
        if (age >= STALE_RUNNING_MAX_AGE_MS) {
          process.stderr.write(
            `[SubagentRegistry] Removing stale ${info.status} subagent "${id}" (age=${Math.floor(age / 1000)}s, parent=${info.parentAgentId})\n`,
          );
          this.subagents.delete(id);
          this.emit("cleanup", info);
          removed++;
        }
      }
    }

    if (removed > 0) {
      process.stdout.write(`[SubagentRegistry] Cleaned up ${removed} subagent(s)\n`);
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
    // 只计算 running 状态的子代理，与 spawn 检查逻辑一致。
    // subagents.size 包含所有状态（含 done、error），会导致 availableSlots 偏小。
    const runningCount = Array.from(this.subagents.values()).filter(
      (s) => s.status === "running",
    ).length;
    return Math.max(0, this.maxConcurrent - runningCount);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private emit(event: SubagentEvent, info: SubagentInfo): void {
    const payload: SubagentRegistryEvent = {
      event,
      subagent: info,
      timestamp: new Date().toISOString(),
    };

    this.eventBus.publish(`subagent.${event}`, payload, "subagent-registry").catch((err) => {
      process.stderr.write(`[SubagentRegistry] EventBus publish failed for "${event}":` + " " + err + "\n");
    });
  }
}