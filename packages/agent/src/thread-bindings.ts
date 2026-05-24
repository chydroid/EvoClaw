/**
 * Thread Bindings — manages sticky session bindings between
 * conversation peers (users/channels) and agent sessions.
 *
 * In multi-channel environments, the same user may interact from
 * different channels. Thread bindings maintain the association
 * between a peer identity and their active session, ensuring
 * continuity across conversations.
 *
 * Features:
 *  - Peer → Session binding with idle timeout
 *  - Max age expiry (force new session after N hours)
 *  - Per-channel binding policies
 *  - Session transfer between channels
 *  - Binding history for audit
 *  - Automatic cleanup of stale bindings
 */

import { EventEmitter } from "events";

// ── Types ─────────────────────────────────────────────────

export interface ThreadBinding {
  /** Composite key (channel:peerId) */
  bindingKey: string;
  /** Channel type */
  channel: string;
  /** Peer identifier (phone number, user ID, etc.) */
  peerId: string;
  /** Bound session ID */
  sessionId: string;
  /** Agent ID */
  agentId: string;
  /** When the binding was created */
  boundAt: number;
  /** Last activity timestamp */
  lastActivityAt: number;
  /** Total message count in this binding */
  messageCount: number;
  /** Whether the binding is active */
  active: boolean;
}

export interface ThreadBindingsConfig {
  /** Idle timeout in ms — unbind after this duration with no activity */
  idleTimeoutMs: number;
  /** Max binding age in ms — force new session after this */
  maxAgeMs: number;
  /** Cleanup interval in ms */
  cleanupIntervalMs: number;
  /** Max bindings to keep in memory */
  maxBindings: number;
  /** Whether to reuse sessions across channels for same peer */
  crossChannelBinding: boolean;
  /** Whether to log binding events */
  logBindings: boolean;
}

export interface BindingEvent {
  type: "bound" | "unbound" | "expired" | "transferred";
  binding: ThreadBinding;
  previousSessionId?: string;
  reason?: string;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: ThreadBindingsConfig = {
  idleTimeoutMs: 30 * 60 * 1000,    // 30 minutes
  maxAgeMs: 24 * 60 * 60 * 1000,    // 24 hours
  cleanupIntervalMs: 60 * 1000,      // 1 minute
  maxBindings: 1000,
  crossChannelBinding: false,
  logBindings: true,
};

// ── Manager ───────────────────────────────────────────────

export class ThreadBindingsManager extends EventEmitter {
  private config: ThreadBindingsConfig;
  private bindings = new Map<string, ThreadBinding>();
  private bindingHistory: BindingEvent[] = [];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<ThreadBindingsConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Bind a peer to a session. If a binding already exists and is
   * within its max age, returns the existing session.
   */
  bind(
    channel: string,
    peerId: string,
    sessionId: string,
    agentId: string,
  ): { bound: boolean; sessionId: string; isExisting: boolean } {
    const bindingKey = this.makeKey(channel, peerId);

    // Check existing binding
    const existing = this.bindings.get(bindingKey);
    if (existing && existing.active) {
      if (!this.isExpired(existing)) {
        // Refresh activity
        existing.lastActivityAt = Date.now();
        existing.messageCount++;
        return { bound: true, sessionId: existing.sessionId, isExisting: true };
      }

      // Expired — unbind old, create new
      this.unbindInternal(bindingKey, "expired");
    }

    // Cross-channel binding: check other channels for same peer
    if (this.config.crossChannelBinding) {
      for (const [key, binding] of this.bindings) {
        if (binding.peerId === peerId && binding.active && !this.isExpired(binding)) {
          binding.lastActivityAt = Date.now();
          binding.messageCount++;
          return { bound: true, sessionId: binding.sessionId, isExisting: true };
        }
      }
    }

    // Create new binding
    const now = Date.now();
    const binding: ThreadBinding = {
      bindingKey,
      channel,
      peerId,
      sessionId,
      agentId,
      boundAt: now,
      lastActivityAt: now,
      messageCount: 1,
      active: true,
    };

    // Clean up old binding for this peer if crossChannelBinding is off
    if (!this.config.crossChannelBinding) {
      for (const [key, existingBinding] of this.bindings) {
        if (existingBinding.peerId === peerId && existingBinding.active) {
          this.unbindInternal(key, "transferred");
        }
      }
    }

    this.bindings.set(bindingKey, binding);
    this.trimBindings();

    this.emitEvent("bound", binding);

    return { bound: true, sessionId, isExisting: false };
  }

  /**
   * Get the session bound to a peer.
   */
  getBinding(channel: string, peerId: string): ThreadBinding | null {
    const bindingKey = this.makeKey(channel, peerId);
    const binding = this.bindings.get(bindingKey);

    if (!binding || !binding.active) return null;
    if (this.isExpired(binding)) {
      this.unbindInternal(bindingKey, "expired");
      return null;
    }

    // Touch activity
    binding.lastActivityAt = Date.now();
    binding.messageCount++;
    return binding;
  }

  /**
   * Get binding by session ID (reverse lookup).
   */
  getBindingBySession(sessionId: string): ThreadBinding | null {
    for (const binding of this.bindings.values()) {
      if (binding.sessionId === sessionId && binding.active) {
        return binding;
      }
    }
    return null;
  }

  /**
   * Unbind a peer from their session.
   */
  unbind(channel: string, peerId: string, reason?: string): boolean {
    const bindingKey = this.makeKey(channel, peerId);
    return this.unbindInternal(bindingKey, reason);
  }

  /**
   * Unbind all bindings for a session.
   */
  unbindSession(sessionId: string): number {
    let count = 0;
    for (const [key, binding] of this.bindings) {
      if (binding.sessionId === sessionId) {
        if (this.unbindInternal(key, "session-ended")) count++;
      }
    }
    return count;
  }

  /**
   * Check if a peer is already bound to an active session.
   */
  isBound(channel: string, peerId: string): boolean {
    const bindingKey = this.makeKey(channel, peerId);
    const binding = this.bindings.get(bindingKey);
    return !!(binding && binding.active && !this.isExpired(binding));
  }

  /**
   * Transfer a peer's binding to a new session.
   */
  transfer(
    channel: string,
    peerId: string,
    newSessionId: string,
  ): { transferred: boolean; previousSessionId?: string } {
    const bindingKey = this.makeKey(channel, peerId);
    const existing = this.bindings.get(bindingKey);

    if (!existing || !existing.active) {
      return { transferred: false };
    }

    const previousSessionId = existing.sessionId;
    existing.sessionId = newSessionId;
    existing.boundAt = Date.now();
    existing.lastActivityAt = Date.now();
    existing.messageCount = 0;

    // Update key if channel changes are possible
    this.emitEvent("transferred", existing, previousSessionId);
    return { transferred: true, previousSessionId };
  }

  /**
   * Record activity on a binding.
   */
  touch(channel: string, peerId: string): boolean {
    const bindingKey = this.makeKey(channel, peerId);
    const binding = this.bindings.get(bindingKey);
    if (!binding || !binding.active) return false;

    binding.lastActivityAt = Date.now();
    binding.messageCount++;
    return true;
  }

  // ── Queries ──────────────────────────────────────────────

  /** Get all active bindings */
  getActiveBindings(): ThreadBinding[] {
    return [...this.bindings.values()].filter((b) => b.active && !this.isExpired(b));
  }

  /** Get bindings for a specific channel */
  getBindingsByChannel(channel: string): ThreadBinding[] {
    return [...this.bindings.values()].filter(
      (b) => b.channel === channel && b.active && !this.isExpired(b),
    );
  }

  /** Get bindings for a specific agent */
  getBindingsByAgent(agentId: string): ThreadBinding[] {
    return [...this.bindings.values()].filter(
      (b) => b.agentId === agentId && b.active,
    );
  }

  /** Get idle bindings (no activity for > idleTimeoutMs) */
  getIdleBindings(): ThreadBinding[] {
    const now = Date.now();
    return [...this.bindings.values()].filter(
      (b) => b.active && now - b.lastActivityAt > this.config.idleTimeoutMs,
    );
  }

  /** Count active bindings */
  getActiveCount(): number {
    return this.getActiveBindings().length;
  }

  /** Get binding stats */
  getStats(): {
    total: number;
    active: number;
    idle: number;
    expired: number;
    byChannel: Record<string, number>;
  } {
    const now = Date.now();
    let active = 0;
    let idle = 0;
    let expired = 0;
    const byChannel: Record<string, number> = {};

    for (const binding of this.bindings.values()) {
      if (!binding.active) continue;

      if (now - binding.boundAt > this.config.maxAgeMs) {
        expired++;
      } else if (now - binding.lastActivityAt > this.config.idleTimeoutMs) {
        idle++;
      } else {
        active++;
      }

      byChannel[binding.channel] = (byChannel[binding.channel] || 0) + 1;
    }

    return {
      total: this.bindings.size,
      active,
      idle,
      expired,
      byChannel,
    };
  }

  /** Get recent binding history */
  getHistory(limit = 50): BindingEvent[] {
    return this.bindingHistory.slice(-limit);
  }

  // ── Mutation ─────────────────────────────────────────────

  clear(): void {
    this.bindings.clear();
    this.bindingHistory = [];
  }

  // ── Maintenance ─────────────────────────────────────────

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

  /** Force cleanup of all expired/idle bindings. Returns count removed. */
  cleanup(): number {
    let removed = 0;
    const now = Date.now();

    for (const [key, binding] of this.bindings) {
      if (!binding.active) continue;

      const isExpired = now - binding.boundAt > this.config.maxAgeMs;
      const isIdle = now - binding.lastActivityAt > this.config.idleTimeoutMs;

      if (isExpired || isIdle) {
        const reason = isExpired ? "expired" : "idle";
        if (this.unbindInternal(key, reason)) {
          removed++;
        }
      }
    }

    return removed;
  }

  configure(updates: Partial<ThreadBindingsConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ── Private ─────────────────────────────────────────────

  private makeKey(channel: string, peerId: string): string {
    return `${channel}:${peerId}`;
  }

  private isExpired(binding: ThreadBinding): boolean {
    const now = Date.now();
    return (
      now - binding.boundAt > this.config.maxAgeMs ||
      now - binding.lastActivityAt > this.config.idleTimeoutMs
    );
  }

  private unbindInternal(bindingKey: string, reason?: string): boolean {
    const binding = this.bindings.get(bindingKey);
    if (!binding || !binding.active) return false;

    binding.active = false;
    this.bindings.delete(bindingKey);

    this.emitEvent("unbound", binding, undefined, reason);
    return true;
  }

  private emitEvent(
    type: BindingEvent["type"],
    binding: ThreadBinding,
    previousSessionId?: string,
    reason?: string,
  ): void {
    const event: BindingEvent = { type, binding, previousSessionId, reason };

    if (this.config.logBindings) {
      this.bindingHistory.push(event);
      if (this.bindingHistory.length > 200) {
        this.bindingHistory = this.bindingHistory.slice(-200);
      }
    }

    this.emit(type, event);
  }

  private trimBindings(): void {
    if (this.bindings.size <= this.config.maxBindings) return;

    // Remove inactive bindings first
    for (const [key, binding] of this.bindings) {
      if (!binding.active) {
        this.bindings.delete(key);
        if (this.bindings.size <= this.config.maxBindings) return;
      }
    }
  }
}