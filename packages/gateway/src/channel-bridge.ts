/**
 * Channel Bridge — cross-channel message relay and bridging.
 *
 * Connects channels together so messages can flow between them.
 * For example, a message sent on Telegram can be forwarded to
 * Discord, or a WhatsApp group can be bridged to Slack.
 *
 * Features:
 *  - Bridge pairs: bidirectional message forwarding
 *  - Bridge groups: multi-channel mesh forwarding
 *  - Filter rules: block specific content types from bridging
 *  - Prefix labeling: add channel origin tag to bridged messages
 *  - Loop prevention: detect and block circular bridges
 *  - Bridge rules: conditional forwarding based on patterns
 *  - Bridge stats and audit
 */

import { randomUUID } from "crypto";

// ── Types ─────────────────────────────────────────────────

export interface BridgePair {
  /** Unique bridge pair ID */
  id: string;
  /** Source channel */
  sourceChannel: string;
  /** Target channel */
  targetChannel: string;
  /** Whether this bridge is active */
  active: boolean;
  /** Whether to label messages with origin */
  prefixWithOrigin: boolean;
  /** Message filter (null = all) */
  filter?: BridgeFilter;
  /** Created timestamp */
  createdAt: number;
  /** Bridge name for display */
  name?: string;
}

export interface BridgeGroup {
  /** Unique group ID */
  id: string;
  /** Channels in this group (fully meshed) */
  channels: string[];
  /** Whether this group is active */
  active: boolean;
  /** Whether to label messages with origin */
  prefixWithOrigin: boolean;
  /** Group name */
  name: string;
  /** Created timestamp */
  createdAt: number;
}

export interface BridgeFilter {
  /** Only bridge messages matching these patterns */
  includePatterns?: string[];
  /** Exclude messages matching these patterns */
  excludePatterns?: string[];
  /** Only bridge messages from these senders */
  allowedSenders?: string[];
  /** Never bridge messages from these senders */
  blockedSenders?: string[];
  /** Minimum text length to bridge */
  minLength?: number;
  /** Maximum text length to bridge */
  maxLength?: number;
  /** Only bridge specific content types */
  contentTypes?: string[];
}

export interface BridgedMessage {
  /** Original message text */
  text: string;
  /** Source channel */
  sourceChannel: string;
  /** Original sender */
  originalSender: string;
  /** When the message was bridged */
  bridgedAt: number;
  /** Bridge pair/group ID */
  bridgeId: string;
  /** Whether the message has origin prefix */
  hasOriginPrefix: boolean;
}

export interface ChannelBridgeConfig {
  /** Origin prefix format: "[Channel] text" */
  originPrefixFormat: string;
  /** Maximum bridge depth to prevent loops */
  maxBridgeDepth: number;
  /** Maximum pairs + groups combined */
  maxBridges: number;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: ChannelBridgeConfig = {
  originPrefixFormat: "[{channel}] {message}",
  maxBridgeDepth: 3,
  maxBridges: 50,
};

// ── Manager ───────────────────────────────────────────────

export class ChannelBridgeManager {
  private config: ChannelBridgeConfig;
  private pairs = new Map<string, BridgePair>();
  private groups = new Map<string, BridgeGroup>();
  /** Track message trace to prevent loops */
  private messageTraces = new Map<string, Set<string>>(); // messageId → set of channels that saw it
  private bridgeHistory: BridgedMessage[] = [];

  constructor(config?: Partial<ChannelBridgeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Bridge Pair Management ──────────────────────────────

  /**
   * Create a bridge pair between two channels.
   */
  createPair(
    sourceChannel: string,
    targetChannel: string,
    options?: { name?: string; prefixWithOrigin?: boolean; filter?: BridgeFilter },
  ): BridgePair {
    if (this.pairs.size + this.groups.size >= this.config.maxBridges) {
      throw new Error(`Max bridges reached (${this.config.maxBridges})`);
    }

    const pair: BridgePair = {
      id: `pair_${randomUUID().slice(0, 8)}`,
      sourceChannel,
      targetChannel,
      active: true,
      prefixWithOrigin: options?.prefixWithOrigin ?? true,
      filter: options?.filter,
      createdAt: Date.now(),
      name: options?.name,
    };

    this.pairs.set(pair.id, pair);
    return pair;
  }

  /**
   * Delete a bridge pair.
   */
  deletePair(pairId: string): boolean {
    return this.pairs.delete(pairId);
  }

  /**
   * Get a bridge pair by ID.
   */
  getPair(pairId: string): BridgePair | null {
    return this.pairs.get(pairId) ?? null;
  }

  /**
   * List all bridge pairs.
   */
  listPairs(): BridgePair[] {
    return [...this.pairs.values()];
  }

  /**
   * Toggle a pair active/inactive.
   */
  setPairActive(pairId: string, active: boolean): boolean {
    const pair = this.pairs.get(pairId);
    if (!pair) return false;
    pair.active = active;
    return true;
  }

  // ── Bridge Group Management ─────────────────────────────

  /**
   * Create a bridge group (full mesh between channels).
   */
  createGroup(
    name: string,
    channels: string[],
    options?: { prefixWithOrigin?: boolean },
  ): BridgeGroup {
    if (this.pairs.size + this.groups.size >= this.config.maxBridges) {
      throw new Error(`Max bridges reached (${this.config.maxBridges})`);
    }

    if (channels.length < 2) {
      throw new Error("Bridge group requires at least 2 channels");
    }

    const group: BridgeGroup = {
      id: `group_${randomUUID().slice(0, 8)}`,
      channels,
      active: true,
      prefixWithOrigin: options?.prefixWithOrigin ?? true,
      name,
      createdAt: Date.now(),
    };

    this.groups.set(group.id, group);
    return group;
  }

  /**
   * Delete a bridge group.
   */
  deleteGroup(groupId: string): boolean {
    return this.groups.delete(groupId);
  }

  /**
   * Get a bridge group by ID.
   */
  getGroup(groupId: string): BridgeGroup | null {
    return this.groups.get(groupId) ?? null;
  }

  /**
   * List all bridge groups.
   */
  listGroups(): BridgeGroup[] {
    return [...this.groups.values()];
  }

  /**
   * Toggle a group active/inactive.
   */
  setGroupActive(groupId: string, active: boolean): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    group.active = active;
    return true;
  }

  // ── Message Bridging ────────────────────────────────────

  /**
   * Check if a message should be bridged and to which channels.
   * Returns list of destination channels the message should be forwarded to.
   */
  getForwardTargets(
    sourceChannel: string,
    message: { text: string; sender: string; messageId?: string },
  ): Array<{ targetChannel: string; bridgedMessage: BridgedMessage; bridgeId: string }> {
    const targets: Array<{ targetChannel: string; bridgedMessage: BridgedMessage; bridgeId: string }> = [];

    // Check pairs where source matches
    for (const pair of this.pairs.values()) {
      if (!pair.active) continue;
      if (pair.sourceChannel !== sourceChannel) continue;
      if (pair.targetChannel === sourceChannel) continue; // No self-loop

      if (!this.passesFilter(pair.filter, message)) continue;
      if (!this.checkLoopPrevention(message.messageId, pair.targetChannel)) continue;

      // Record trace: source channel also blocks reverse bridging
      this.recordTrace(message.messageId, sourceChannel);

      const prefix = pair.prefixWithOrigin
        ? this.formatOriginPrefix(sourceChannel, message.text)
        : message.text;

      const bridged: BridgedMessage = {
        text: prefix,
        sourceChannel,
        originalSender: message.sender,
        bridgedAt: Date.now(),
        bridgeId: pair.id,
        hasOriginPrefix: pair.prefixWithOrigin,
      };

      // Record trace
      this.recordTrace(message.messageId, pair.targetChannel);

      targets.push({ targetChannel: pair.targetChannel, bridgedMessage: bridged, bridgeId: pair.id });
    }

    // Check groups where source is a member
    for (const group of this.groups.values()) {
      if (!group.active) continue;
      if (!group.channels.includes(sourceChannel)) continue;

      for (const ch of group.channels) {
        if (ch === sourceChannel) continue;
        if (!this.checkLoopPrevention(message.messageId, ch)) continue;

        // Record trace: source channel also blocks reverse bridging
        this.recordTrace(message.messageId, sourceChannel);

        const prefix = group.prefixWithOrigin
          ? this.formatOriginPrefix(sourceChannel, message.text)
          : message.text;

        const bridged: BridgedMessage = {
          text: prefix,
          sourceChannel,
          originalSender: message.sender,
          bridgedAt: Date.now(),
          bridgeId: group.id,
          hasOriginPrefix: group.prefixWithOrigin,
        };

        this.recordTrace(message.messageId, ch);
        targets.push({ targetChannel: ch, bridgedMessage: bridged, bridgeId: group.id });
      }
    }

    // Record history
    for (const t of targets) {
      this.bridgeHistory.push(t.bridgedMessage);
      if (this.bridgeHistory.length > 200) {
        this.bridgeHistory.shift();
      }
    }

    return targets;
  }

  /**
   * Check if bridging from source to target would create a loop.
   */
  wouldCreateLoop(sourceChannel: string, targetChannel: string): boolean {
    return sourceChannel === targetChannel;
  }

  // ── Queries ──────────────────────────────────────────────

  /**
   * Get recent bridge history.
   */
  getHistory(limit = 50): BridgedMessage[] {
    return this.bridgeHistory.slice(-limit);
  }

  /**
   * Get bridge count and stats.
   */
  getStats(): {
    totalPairs: number;
    totalGroups: number;
    activePairs: number;
    activeGroups: number;
    totalBridged: number;
    channelsWithBridges: string[];
  } {
    const activePairs = [...this.pairs.values()].filter((p) => p.active);
    const activeGroups = [...this.groups.values()].filter((g) => g.active);

    const allChannels = new Set<string>();
    for (const p of this.pairs.values()) {
      allChannels.add(p.sourceChannel);
      allChannels.add(p.targetChannel);
    }
    for (const g of this.groups.values()) {
      for (const ch of g.channels) allChannels.add(ch);
    }

    return {
      totalPairs: this.pairs.size,
      totalGroups: this.groups.size,
      activePairs: activePairs.length,
      activeGroups: activeGroups.length,
      totalBridged: this.bridgeHistory.length,
      channelsWithBridges: [...allChannels],
    };
  }

  /**
   * Clear bridge history.
   */
  clearHistory(): void {
    this.bridgeHistory = [];
  }

  /**
   * Clear all pairs and groups.
   */
  clearAll(): void {
    this.pairs.clear();
    this.groups.clear();
    this.messageTraces.clear();
    this.bridgeHistory = [];
  }

  configure(updates: Partial<ChannelBridgeConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ── Private ─────────────────────────────────────────────

  private passesFilter(
    filter: BridgeFilter | undefined,
    message: { text: string; sender: string },
  ): boolean {
    if (!filter) return true;

    if (filter.blockedSenders?.includes(message.sender)) return false;
    if (filter.allowedSenders && !filter.allowedSenders.includes(message.sender)) return false;

    if (filter.minLength !== undefined && message.text.length < filter.minLength) return false;
    if (filter.maxLength !== undefined && message.text.length > filter.maxLength) return false;

    if (filter.excludePatterns) {
      for (const pattern of filter.excludePatterns) {
        if (message.text.includes(pattern)) return false;
      }
    }

    if (filter.includePatterns) {
      const hasMatch = filter.includePatterns.some((p) => message.text.includes(p));
      if (!hasMatch) return false;
    }

    return true;
  }

  private checkLoopPrevention(messageId: string | undefined, targetChannel: string): boolean {
    if (!messageId) return true;

    const trace = this.messageTraces.get(messageId);
    if (!trace) return true;

    if (trace.has(targetChannel)) return false; // Already bridged to this channel

    if (trace.size >= this.config.maxBridgeDepth) return false; // Max depth reached

    return true;
  }

  private recordTrace(messageId: string | undefined, channel: string): void {
    if (!messageId) return;

    let trace = this.messageTraces.get(messageId);
    if (!trace) {
      trace = new Set();
      this.messageTraces.set(messageId, trace);
    }
    trace.add(channel);

    // Cleanup old traces (keep ~500 entries)
    if (this.messageTraces.size > 500) {
      const keys = [...this.messageTraces.keys()];
      for (let i = 0; i < 100; i++) {
        this.messageTraces.delete(keys[i]);
      }
    }
  }

  private formatOriginPrefix(channel: string, text: string): string {
    return this.config.originPrefixFormat
      .replace("{channel}", channel)
      .replace("{message}", text);
  }
}