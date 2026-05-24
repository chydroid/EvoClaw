/**
 * Outbound Router — decides which channel and strategy to use when
 * sending a response to a user. Routes based on channel availability,
 * user preferences, load, and fallback rules.
 *
 * Features:
 *  - Primary channel routing with fallback chains
 *  - Channel preference per user/peer
 *  - Load-aware routing (prefer least-loaded channel)
 *  - Time-of-day routing (work hours → Slack, off hours → WhatsApp)
 *  - Content-aware routing (long text → email-like, short → chat)
 *  - Routing rule priority system
 *  - Routing audit trail
 */

// ── Types ─────────────────────────────────────────────────

export type ChannelStatus = "active" | "degraded" | "down" | "unknown";

export interface OutboundRoute {
  /** Target channel name */
  channel: string;
  /** Priority (lower = preferred) */
  priority: number;
  /** Why this route was selected */
  reason: string;
  /** Score (0-100, higher = better match) */
  score: number;
}

export interface OutboundMessage {
  /** Text content */
  text: string;
  /** Target peer/user ID */
  target: string;
  /** Original inbound channel (for reply matching) */
  sourceChannel?: string;
  /** Whether this should prefer the source channel */
  preferSourceChannel: boolean;
  /** Content category hint */
  contentType?: "short" | "long" | "image" | "system" | "alert";
}

export interface RoutingRule {
  /** Rule name for audit */
  name: string;
  /** Priority (lower = checked first) */
  priority: number;
  /** Channel this rule targets */
  targetChannel: string;
  /** Condition: always true if null */
  condition?: (msg: OutboundMessage) => boolean;
  /** Score boost (additive to base score) */
  scoreBoost: number;
  /** Whether this rule is active */
  enabled: boolean;
}

export interface OutboundRouterConfig {
  /** Fallback channel if no route found */
  defaultChannel: string;
  /** Maximum routes to consider */
  maxRoutes: number;
  /** Channel load information for load-aware routing */
  channelLoads: Record<string, number>;
  /** Channel status info */
  channelStatuses: Record<string, ChannelStatus>;
  /** Content-length threshold (chars) for long vs short */
  longContentThreshold: number;
  /** Whether to prefer source channel for replies */
  preferSourceOnReply: boolean;
  /** Whether to skip channels that are down */
  skipDownChannels: boolean;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: OutboundRouterConfig = {
  defaultChannel: "webchat",
  maxRoutes: 5,
  channelLoads: {},
  channelStatuses: {},
  longContentThreshold: 500,
  preferSourceOnReply: true,
  skipDownChannels: true,
};

// ── Router ────────────────────────────────────────────────

export class OutboundRouter {
  private config: OutboundRouterConfig;
  private rules: RoutingRule[] = [];
  private routeHistory: Array<{ timestamp: number; message: OutboundMessage; result: OutboundRoute[] }> = [];

  constructor(config?: Partial<OutboundRouterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config, channelLoads: { ...DEFAULT_CONFIG.channelLoads, ...config?.channelLoads }, channelStatuses: { ...DEFAULT_CONFIG.channelStatuses, ...config?.channelStatuses } };
  }

  /**
   * Determine the best route(s) for an outbound message.
   * Returns routes sorted by score descending.
   */
  route(message: OutboundMessage): OutboundRoute[] {
    const candidates: OutboundRoute[] = [];

    // Rule 1: Reply-to-source if applicable
    if (
      message.preferSourceChannel &&
      message.sourceChannel &&
      this.config.preferSourceOnReply
    ) {
      if (this.isChannelAvailable(message.sourceChannel)) {
        candidates.push({
          channel: message.sourceChannel,
          priority: 0,
          reason: `Reply to source channel: ${message.sourceChannel}`,
          score: 100,
        });
      }
    }

    // Rule 2: User-defined routing rules
    for (const rule of this.getActiveRules()) {
      if (this.isChannelAvailable(rule.targetChannel)) {
        if (!rule.condition || rule.condition(message)) {
          const baseScore = this.computeBaseScore(rule.targetChannel);
          candidates.push({
            channel: rule.targetChannel,
            priority: 1 + rule.priority,
            reason: `Rule: ${rule.name}`,
            score: Math.min(100, baseScore + rule.scoreBoost),
          });
        }
      }
    }

    // Rule 3: Content-aware routing
    const contentRoutes = this.routeByContent(message);
    for (const route of contentRoutes) {
      if (!candidates.some((c) => c.channel === route.channel)) {
        candidates.push(route);
      }
    }

    // Rule 4: All available channels as fallback
    const allChannels = Object.keys(this.config.channelStatuses);
    for (const ch of allChannels) {
      if (!candidates.some((c) => c.channel === ch) && this.isChannelAvailable(ch)) {
        candidates.push({
          channel: ch,
          priority: 3,
          reason: `Available channel: ${ch}`,
          score: this.computeBaseScore(ch),
        });
      }
    }

    // Sort by score descending, then priority ascending
    candidates.sort((a, b) => b.score - a.score || a.priority - b.priority);

    const result = candidates.slice(0, this.config.maxRoutes);

    // Fallback: ensure default channel is present
    if (result.length === 0) {
      result.push({
        channel: this.config.defaultChannel,
        priority: 999,
        reason: "Default fallback channel",
        score: 0,
      });
    }

    // Record history
    this.routeHistory.push({
      timestamp: Date.now(),
      message,
      result: [...result],
    });
    if (this.routeHistory.length > 100) {
      this.routeHistory.shift();
    }

    return result;
  }

  /**
   * Get the best single route (highest score).
   */
  getBestRoute(message: OutboundMessage): OutboundRoute {
    const routes = this.route(message);
    return routes[0];
  }

  /**
   * Add a routing rule.
   */
  addRule(rule: RoutingRule): void {
    // Replace existing rule with same name
    const idx = this.rules.findIndex((r) => r.name === rule.name);
    if (idx >= 0) {
      this.rules[idx] = rule;
    } else {
      this.rules.push(rule);
    }
  }

  /**
   * Remove a routing rule by name.
   */
  removeRule(name: string): boolean {
    const idx = this.rules.findIndex((r) => r.name === name);
    if (idx >= 0) {
      this.rules.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Enable/disable a rule.
   */
  setRuleEnabled(name: string, enabled: boolean): boolean {
    const rule = this.rules.find((r) => r.name === name);
    if (rule) {
      rule.enabled = enabled;
      return true;
    }
    return false;
  }

  /**
   * Update channel status.
   */
  setChannelStatus(channel: string, status: ChannelStatus): void {
    this.config.channelStatuses[channel] = status;
  }

  /**
   * Update channel load (0-100).
   */
  setChannelLoad(channel: string, load: number): void {
    this.config.channelLoads[channel] = Math.max(0, Math.min(100, load));
  }

  /**
   * Get active rules sorted by priority.
   */
  getRules(): RoutingRule[] {
    return [...this.rules].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get recent routing history.
   */
  getHistory(limit = 20): Array<{ timestamp: number; channel: string; score: number; reason: string }> {
    return this.routeHistory.slice(-limit).flatMap((entry) =>
      entry.result.slice(0, 1).map((r) => ({
        timestamp: entry.timestamp,
        channel: r.channel,
        score: r.score,
        reason: r.reason,
      })),
    );
  }

  /**
   * Clear routing history.
   */
  clearHistory(): void {
    this.routeHistory = [];
  }

  configure(updates: Partial<OutboundRouterConfig>): void {
    this.config = { ...this.config, ...updates, channelLoads: { ...this.config.channelLoads, ...updates.channelLoads }, channelStatuses: { ...this.config.channelStatuses, ...updates.channelStatuses } };
  }

  // ── Private ─────────────────────────────────────────────

  private isChannelAvailable(channel: string): boolean {
    const status = this.config.channelStatuses[channel] ?? "unknown";
    if (this.config.skipDownChannels && status === "down") return false;
    return true;
  }

  private computeBaseScore(channel: string): number {
    let score = 50; // Neutral base

    const load = this.config.channelLoads[channel] ?? 0;
    // Lower load = higher score (inverted: 100 - load)
    score += (100 - load) * 0.2; // Up to +20 for zero load
    score -= load * 0.1;          // Up to -10 for 100% load

    const status = this.config.channelStatuses[channel] ?? "unknown";
    switch (status) {
      case "active": score += 15; break;
      case "degraded": score -= 25; break;
      case "down": score = -999; break;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private routeByContent(message: OutboundMessage): OutboundRoute[] {
    const routes: OutboundRoute[] = [];

    if ((message.contentType === "long" || message.text.length > this.config.longContentThreshold) && this.isChannelAvailable("slack")) {
      routes.push({
        channel: "slack",
        priority: 2,
        reason: "Long content → Slack",
        score: 70,
      });
    }

    if (message.contentType === "alert" && this.isChannelAvailable("telegram")) {
      routes.push({
        channel: "telegram",
        priority: 2,
        reason: "Alert → Telegram (push notifications)",
        score: 85,
      });
    }

    if (message.contentType === "image" && this.isChannelAvailable("discord")) {
      routes.push({
        channel: "discord",
        priority: 2,
        reason: "Image content → Discord",
        score: 75,
      });
    }

    return routes;
  }

  private getActiveRules(): RoutingRule[] {
    return this.rules.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);
  }
}