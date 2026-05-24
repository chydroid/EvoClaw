/**
 * Message Lifecycle — manages the full lifecycle of outbound messages
 * from creation to final delivery confirmation (or failure).
 *
 * State Machine:
 *
 *   pending → queued → sending → sent → delivered
 *                    ↘ failed → retrying → sending
 *                             ↘ permanent_failure
 *
 * Each transition is observable via events. The lifecycle manager
 * provides a unified view of message state across all channels.
 *
 * Features:
 *  - State machine with strict transitions
 *  - Per-message lifecycle tracking
 *  - Time-to-live (TTL) expiry
 *  - Event emission on state changes
 *  - Bulk lifecycle queries for monitoring
 *  - Automatic cleanup of terminal states
 */

import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type { ChannelType, ChannelSendResult } from "./channel-manager.js";

// ── Types ─────────────────────────────────────────────────

export type MessageState =
  | "pending"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "failed"
  | "retrying"
  | "permanent_failure";

export interface LifecycleRecord {
  /** Unique record ID */
  id: string;
  /** Target message ID (channel-level) */
  messageId?: string;
  /** Channel this message is on */
  channel: ChannelType;
  /** Message text */
  text: string;
  /** Target recipient identifier */
  target: string;
  /** Current state */
  state: MessageState;
  /** When the record was created */
  createdAt: number;
  /** When the state last changed */
  updatedAt: number;
  /** State transition history */
  history: StateTransition[];
  /** Error info if in failed state */
  lastError?: string;
  /** Attempt count */
  attempts: number;
  /** TTL in ms (0 = no expiry) */
  ttlMs: number;
  /** Whether this message has been acknowledged */
  acknowledged: boolean;
}

export interface StateTransition {
  from: MessageState;
  to: MessageState;
  timestamp: number;
  reason?: string;
}

export interface LifecycleEvent {
  record: LifecycleRecord;
  previousState: MessageState;
  newState: MessageState;
  reason?: string;
}

export interface LifecycleConfig {
  /** Default TTL for messages (ms) */
  defaultTTLMs: number;
  /** Maximum history entries per record */
  maxHistoryLength: number;
  /** Cleanup interval for terminal states (ms) */
  cleanupIntervalMs: number;
  /** Maximum age of terminal records before cleanup (ms) */
  maxTerminalAgeMs: number;
  /** Maximum records to keep in memory */
  maxRecords: number;
}

// ── Valid Transitions ─────────────────────────────────────

const VALID_TRANSITIONS: Record<MessageState, MessageState[]> = {
  pending: ["queued", "failed"],
  queued: ["sending", "failed"],
  sending: ["sent", "failed"],
  sent: ["delivered", "failed"],
  delivered: [], // Terminal
  failed: ["retrying", "permanent_failure"],
  retrying: ["sending", "permanent_failure"],
  permanent_failure: [], // Terminal
};

const TERMINAL_STATES: MessageState[] = ["delivered", "permanent_failure"];

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: LifecycleConfig = {
  defaultTTLMs: 5 * 60 * 1000,   // 5 minutes
  maxHistoryLength: 20,
  cleanupIntervalMs: 60 * 1000,   // 1 minute
  maxTerminalAgeMs: 30 * 60 * 1000, // 30 minutes
  maxRecords: 10_000,
};

// ── Manager ───────────────────────────────────────────────

export class MessageLifecycleManager extends EventEmitter {
  private config: LifecycleConfig;
  private records = new Map<string, LifecycleRecord>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<LifecycleConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Lifecycle Methods ───────────────────────────────────

  /** Register a new message and begin tracking */
  register(
    channel: ChannelType,
    target: string,
    text: string,
    options?: { ttlMs?: number; messageId?: string },
  ): LifecycleRecord {
    const now = Date.now();
    const record: LifecycleRecord = {
      id: randomUUID(),
      messageId: options?.messageId,
      channel,
      text: text.length > 200 ? text.substring(0, 197) + "..." : text,
      target,
      state: "pending",
      createdAt: now,
      updatedAt: now,
      history: [{ from: "pending" as MessageState, to: "pending" as MessageState, timestamp: now, reason: "Created" }],
      attempts: 0,
      ttlMs: options?.ttlMs ?? this.config.defaultTTLMs,
      acknowledged: false,
    };

    // Replace existing record for same message
    for (const [key, existing] of this.records) {
      if (existing.channel === channel && existing.target === target && existing.text === text) {
        this.records.delete(key);
        break;
      }
    }

    this.records.set(record.id, record);
    this.trimRecords();
    return record;
  }

  /** Transition a message to a new state */
  transition(
    recordId: string,
    toState: MessageState,
    options?: {
      reason?: string;
      messageId?: string;
      error?: string;
    },
  ): LifecycleRecord | null {
    const record = this.records.get(recordId);
    if (!record) return null;

    const validTargets = VALID_TRANSITIONS[record.state];
    if (!validTargets.includes(toState)) {
      return null; // Invalid transition, silently reject
    }

    const previousState = record.state;
    record.state = toState;
    record.updatedAt = Date.now();
    record.attempts++;

    if (options?.messageId) record.messageId = options.messageId;
    if (options?.error) record.lastError = options.error;

    record.history.push({
      from: previousState,
      to: toState,
      timestamp: Date.now(),
      reason: options?.reason,
    });

    if (record.history.length > this.config.maxHistoryLength) {
      record.history = record.history.slice(-this.config.maxHistoryLength);
    }

    this.emit("stateChange", {
      record,
      previousState,
      newState: toState,
      reason: options?.reason,
    } satisfies LifecycleEvent);

    return record;
  }

  /** Mark message as sent (transition: pending/queued/sending → sent) */
  markSent(recordId: string, result: ChannelSendResult): LifecycleRecord | null {
    if (result.success) {
      const record = this.records.get(recordId);
      if (record && record.state !== "sent") {
        return this.transition(recordId, "sent", {
          messageId: result.messageId,
          reason: result.messageId ? `Channel message ID: ${result.messageId}` : "Sent",
        });
      }
      return record ?? null;
    }

    return this.transition(recordId, "failed", {
      error: result.error,
      reason: `Send failed: ${result.error}`,
    });
  }

  /** Mark message as delivered (terminal) */
  markDelivered(recordId: string): LifecycleRecord | null {
    return this.transition(recordId, "delivered", { reason: "Delivery confirmed" });
  }

  /** Mark as permanent failure (terminal) */
  markPermanentFailure(recordId: string, reason: string): LifecycleRecord | null {
    return this.transition(recordId, "permanent_failure", {
      error: reason,
      reason: `Permanent failure: ${reason}`,
    });
  }

  /** Retry a failed message */
  markRetrying(recordId: string): LifecycleRecord | null {
    return this.transition(recordId, "retrying", { reason: "Retry initiated" });
  }

  /** Acknowledge receipt */
  acknowledge(recordId: string): LifecycleRecord | null {
    const record = this.records.get(recordId);
    if (!record) return null;
    record.acknowledged = true;
    return record;
  }

  // ── Queries ──────────────────────────────────────────────

  get(recordId: string): LifecycleRecord | null {
    return this.records.get(recordId) ?? null;
  }

  /** Get all records in a specific state */
  getByState(state: MessageState): LifecycleRecord[] {
    return [...this.records.values()].filter((r) => r.state === state);
  }

  /** Get records for a specific channel */
  getByChannel(channel: ChannelType): LifecycleRecord[] {
    return [...this.records.values()].filter((r) => r.channel === channel);
  }

  /** Get active (non-terminal) records */
  getActive(): LifecycleRecord[] {
    return [...this.records.values()].filter(
      (r) => !TERMINAL_STATES.includes(r.state),
    );
  }

  /** Get records by target */
  getByTarget(target: string): LifecycleRecord[] {
    return [...this.records.values()].filter((r) => r.target === target);
  }

  /** Get summary statistics */
  getStats(): {
    total: number;
    byState: Record<MessageState, number>;
    byChannel: Record<string, number>;
    failedCount: number;
    deliveredCount: number;
  } {
    const byState: Record<string, number> = {};
    const byChannel: Record<string, number> = {};

    for (const record of this.records.values()) {
      byState[record.state] = (byState[record.state] || 0) + 1;
      byChannel[record.channel] = (byChannel[record.channel] || 0) + 1;
    }

    return {
      total: this.records.size,
      byState: byState as Record<MessageState, number>,
      byChannel,
      failedCount: (byState["failed"] || 0) + (byState["permanent_failure"] || 0),
      deliveredCount: byState["delivered"] || 0,
    };
  }

  /** List expired records (TTL exceeded, still in non-terminal state) */
  getExpired(): LifecycleRecord[] {
    const now = Date.now();
    return [...this.records.values()].filter(
      (r) =>
        !TERMINAL_STATES.includes(r.state) &&
        r.ttlMs > 0 &&
        now - r.createdAt > r.ttlMs,
    );
  }

  // ── Mutation ─────────────────────────────────────────────

  delete(recordId: string): boolean {
    return this.records.delete(recordId);
  }

  clear(): void {
    this.records.clear();
  }

  // ── Maintenance ──────────────────────────────────────────

  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupIntervalMs);
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Check and expire stale TTL records. Auto-transitions to permanent_failure. */
  checkExpiry(): number {
    let expired = 0;
    for (const record of this.getExpired()) {
      this.transition(record.id, "permanent_failure", {
        reason: `TTL expired (${record.ttlMs}ms)`,
      });
      expired++;
    }
    return expired;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (
        TERMINAL_STATES.includes(record.state) &&
        now - record.updatedAt > this.config.maxTerminalAgeMs
      ) {
        this.records.delete(id);
      }
    }
  }

  private trimRecords(): void {
    if (this.records.size <= this.config.maxRecords) return;

    // Remove oldest terminal records first
    const terminalEntries = [...this.records.entries()]
      .filter(([, r]) => TERMINAL_STATES.includes(r.state))
      .sort(([, a], [, b]) => a.updatedAt - b.updatedAt);

    for (const [id] of terminalEntries) {
      if (this.records.size <= this.config.maxRecords) break;
      this.records.delete(id);
    }

    // If still over, remove oldest pending
    const pendingEntries = [...this.records.entries()]
      .sort(([, a], [, b]) => a.createdAt - b.createdAt);

    for (const [id] of pendingEntries) {
      if (this.records.size <= this.config.maxRecords) break;
      this.records.delete(id);
    }
  }

  configure(updates: Partial<LifecycleConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}