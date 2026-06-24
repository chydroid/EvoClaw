/**
 * Session Retention — policy-based automatic session cleanup.
 *
 * Prunes old sessions to prevent unbounded growth. Supports:
 *  - Max-session-count limit (keep N most recent)
 *  - Max-age limit (delete sessions older than N ms)
 *  - Idle-timeout (delete sessions inactive for N ms)
 *  - Cron-session pruning (isolated cron sessions age out faster)
 *  - Per-channel retention policies
 *  - Dry-run mode for inspection without deletion
 */

// ── Types ─────────────────────────────────────────────────

export interface SessionEntry {
  sessionId: string;
  channel?: string;
  peerId?: string;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  isCronSession: boolean;
  metadata?: Record<string, unknown>;
}

export interface RetentionPolicy {
  /** Maximum number of sessions to keep (0 = unlimited) */
  maxSessions?: number;
  /** Maximum age in ms (0 = never expire by age) */
  maxAgeMs?: number;
  /** Idle timeout in ms (0 = never expire by idle) */
  idleTimeoutMs?: number;
  /** Channel this policy applies to (undefined = all channels) */
  channel?: string;
  /** Whether this policy is active */
  enabled: boolean;
}

export interface RetentionConfig {
  /** Default retention policy */
  defaultPolicy: RetentionPolicy;
  /** Per-channel overrides */
  channelPolicies: Record<string, RetentionPolicy>;
  /** Whether to keep at least N sessions even if all would be pruned */
  keepMinimum: number;
  /** Whether to run in dry-run mode (no actual deletion) */
  dryRun: boolean;
}

export interface RetentionResult {
  /** Sessions examined */
  examined: number;
  /** Sessions marked for deletion */
  toDelete: number;
  /** Sessions actually deleted */
  deleted: number;
  /** Deleted session IDs */
  deletedIds: string[];
  /** Reason each was deleted */
  reasons: Map<string, string>;
  /** Whether the operation was a dry run */
  dryRun: boolean;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: RetentionConfig = {
  defaultPolicy: {
    maxSessions: 1000,
    maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    idleTimeoutMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    enabled: true,
  },
  channelPolicies: {},
  keepMinimum: 5,
  dryRun: false,
};

// ── Manager ───────────────────────────────────────────────

export class SessionRetentionManager {
  private config: RetentionConfig;

  constructor(config?: Partial<RetentionConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      channelPolicies: { ...DEFAULT_CONFIG.channelPolicies, ...config?.channelPolicies },
    };
  }

  /**
   * Analyze sessions and determine which should be pruned.
   * Does NOT delete unless dryRun is false.
   * @param sessions — list of all sessions to evaluate
   * @param deleteFn — callback to actually delete a session (returns true if deleted)
   */
  async prune(
    sessions: SessionEntry[],
    deleteFn?: (sessionId: string) => Promise<boolean>,
  ): Promise<RetentionResult> {
    const result: RetentionResult = {
      examined: sessions.length,
      toDelete: 0,
      deleted: 0,
      deletedIds: [],
      reasons: new Map(),
      dryRun: this.config.dryRun,
    };

    if (sessions.length <= this.config.keepMinimum) {
      return result;
    }

    const toDelete = new Set<string>();

    // Pass 1: Apply channel-specific policies (age, idle, count)
    for (const session of sessions) {
      if (sessions.length - toDelete.size <= this.config.keepMinimum) break;

      const policy = this.getEffectivePolicy(session.channel);
      if (!policy.enabled) continue;

      // Check max age
      if (policy.maxAgeMs && policy.maxAgeMs > 0) {
        const age = Date.now() - session.createdAt;
        if (age > policy.maxAgeMs) {
          toDelete.add(session.sessionId);
          result.reasons.set(session.sessionId, "max age exceeded");
          continue;
        }
      }

      // Check idle timeout
      if (policy.idleTimeoutMs && policy.idleTimeoutMs > 0) {
        const idle = Date.now() - session.lastActiveAt;
        if (idle > policy.idleTimeoutMs) {
          toDelete.add(session.sessionId);
          result.reasons.set(session.sessionId, "idle timeout exceeded");
          continue;
        }
      }
    }

    // Pass 1b: Channel-specific max session count
    if (sessions.length - toDelete.size > this.config.keepMinimum) {
      // Group sessions by channel
      const byChannel = new Map<string | undefined, SessionEntry[]>();
      for (const s of sessions) {
        if (toDelete.has(s.sessionId)) continue;
        const ch = s.channel;
        if (!byChannel.has(ch)) byChannel.set(ch, []);
        byChannel.get(ch)!.push(s);
      }

      for (const [channel, channelSessions] of byChannel) {
        const policy = this.getEffectivePolicy(channel);
        if (!policy.enabled || !policy.maxSessions || policy.maxSessions <= 0) continue;

        channelSessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
        const overflow = channelSessions.slice(policy.maxSessions);
        for (const s of overflow) {
          if (sessions.length - toDelete.size <= this.config.keepMinimum) break;
          toDelete.add(s.sessionId);
          result.reasons.set(s.sessionId, `channel "${channel}" session count limit exceeded`);
        }
      }
    }

    // Pass 2: Enforce max session count
    if (sessions.length - toDelete.size > this.config.keepMinimum) {
      const activePolicy = this.config.defaultPolicy;
      if (activePolicy.maxSessions && activePolicy.maxSessions > 0) {
        // Keep the most recently active sessions
        const notDeleted = sessions.filter((s) => !toDelete.has(s.sessionId));
        notDeleted.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

        const overflow = notDeleted.slice(activePolicy.maxSessions);
        for (const s of overflow) {
          if (sessions.length - toDelete.size <= this.config.keepMinimum) break;
          toDelete.add(s.sessionId);
          result.reasons.set(s.sessionId, "session count limit exceeded");
        }
      }
    }

    // Pass 3: Cron sessions age out faster (half the normal maxAge)
    const now = Date.now();
    for (const session of sessions) {
      if (!session.isCronSession) continue;
      if (toDelete.has(session.sessionId)) continue;
      if (sessions.length - toDelete.size <= this.config.keepMinimum) break;

      const policy = this.getEffectivePolicy(session.channel);
      const cronMaxAge = (policy.maxAgeMs ?? 0) / 2;
      if (cronMaxAge > 0 && now - session.createdAt > cronMaxAge) {
        toDelete.add(session.sessionId);
        result.reasons.set(session.sessionId, "cron session aged out");
      }
    }

    result.toDelete = toDelete.size;

    // Execute deletion
    if (!this.config.dryRun && deleteFn) {
      for (const id of toDelete) {
        try {
          const deleted = await deleteFn(id);
          if (deleted) {
            result.deleted++;
            result.deletedIds.push(id);
          }
        } catch {
          // Deletion failure is non-fatal
        }
      }
    } else if (this.config.dryRun) {
      result.deletedIds = [...toDelete];
    }

    return result;
  }

  /**
   * Add or update a channel-specific policy.
   */
  setChannelPolicy(channel: string, policy: Partial<RetentionPolicy>): void {
    this.config.channelPolicies[channel] = {
      ...this.config.defaultPolicy,
      ...policy,
    };
  }

  /**
   * Remove a channel-specific policy.
   */
  removeChannelPolicy(channel: string): boolean {
    if (this.config.channelPolicies[channel]) {
      delete this.config.channelPolicies[channel];
      return true;
    }
    return false;
  }

  /**
   * Get the effective policy for a channel.
   */
  getEffectivePolicy(channel?: string): RetentionPolicy {
    if (channel && this.config.channelPolicies[channel]) {
      return this.config.channelPolicies[channel];
    }
    return this.config.defaultPolicy;
  }

  /**
   * List all policies.
   */
  listPolicies(): Array<{ channel?: string; policy: RetentionPolicy }> {
    const policies: Array<{ channel?: string; policy: RetentionPolicy }> = [
      { policy: this.config.defaultPolicy },
    ];

    for (const [channel, policy] of Object.entries(this.config.channelPolicies)) {
      policies.push({ channel, policy });
    }

    return policies;
  }

  configure(updates: Partial<RetentionConfig>): void {
    this.config = {
      ...this.config,
      ...updates,
      channelPolicies: {
        ...this.config.channelPolicies,
        ...updates.channelPolicies,
      },
    };
  }
}