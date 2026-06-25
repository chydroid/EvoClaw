/**
 * ChannelManager — OpenClaw-style multi-channel support.
 *
 * Manages communication channels like WhatsApp, Telegram, Discord, Slack,
 * WebChat, etc. Each channel has its own adapter, message handling, and
 * delivery pipeline.
 */

import * as crypto from "node:crypto";
import type { EventBus } from "@evoclaw/core";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChannelType =
  | "whatsapp"
  | "telegram"
  | "discord"
  | "slack"
  | "feishu"
  | "wechat"
  | "qq"
  | "signal"
  | "imessage"
  | "google-chat"
  | "microsoft-teams"
  | "matrix"
  | "webchat"
  | "cli"
  | "api"
  | "dingtalk"
  | "custom";

export type DirectMessagePolicy = "open" | "pairing" | "closed";

export interface ChannelConfig {
  type: ChannelType;
  enabled: boolean;
  label: string;
  /** Direct message policy */
  dmPolicy: DirectMessagePolicy;
  /** Allowlist of peer IDs (e.g., phone numbers, user IDs) */
  allowFrom: string[];
  /** Blocklist of peer IDs */
  blockFrom: string[];
  /** Channel-specific configuration */
  settings: Record<string, unknown>;
}

export interface ChannelMessage {
  /** Unique message ID (channel-level) */
  messageId: string;
  /** Channel type */
  channel: ChannelType;
  /** Sender identifier (phone number, user ID, etc.) */
  from: string;
  /** Target (channel, group ID, etc.) */
  to: string;
  /** Message text content */
  text: string;
  /** Message timestamp */
  timestamp: string;
  /** Whether this is a direct message */
  isDirect: boolean;
  /** Whether this is a group message */
  isGroup: boolean;
  /** Group ID if applicable */
  groupId?: string;
  /** Attachments (media, files) */
  attachments?: Array<{
    type: "image" | "video" | "audio" | "document" | "sticker";
    url?: string;
    data?: Buffer;
    mimeType?: string;
    filename?: string;
  }>;
  /** Reply context (if replying to a previous message) */
  replyTo?: string;
  /** Raw channel metadata */
  raw: Record<string, unknown>;
}

export interface ChannelSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  channel: ChannelType;
}

export interface ChannelHealthResult {
  healthy: boolean;
  message: string;
  details?: Record<string, string>;
  suggestions?: string[];
}

export interface ChannelAdapter {
  /** Channel type identifier */
  readonly type: ChannelType;
  /** Start the channel adapter */
  start(): Promise<void>;
  /** Stop the channel adapter */
  stop(): Promise<void>;
  /** Send a message through this channel */
  sendMessage(target: string, text: string, options?: {
    replyTo?: string;
    attachments?: ChannelMessage["attachments"];
  }): Promise<ChannelSendResult>;
  /** Check channel health */
  healthCheck(): Promise<ChannelHealthResult>;
  /** Handle incoming message callback */
  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void;
  /** Handle connection status changes */
  onStatusChange(handler: (status: "connected" | "disconnected" | "reconnecting" | "error") => void): void;
}

// ─── Channel Manager ──────────────────────────────────────────────────────────

export interface ChannelStatus {
  type: ChannelType;
  label: string;
  enabled: boolean;
  connected: boolean;
  lastActivity?: string;
  messageCount: number;
  error?: string;
}

export class ChannelManager {
  private channels = new Map<ChannelType, ChannelConfig>();
  private adapters = new Map<ChannelType, ChannelAdapter>();
  private statuses = new Map<ChannelType, ChannelStatus>();
  private messageHandler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private pairingCodes = new Map<string, { code: string; channel: ChannelType; peerId: string; createdAt: number }>();
  private approvedPeers = new Map<ChannelType, Set<string>>();
  private blocklistedPeers = new Map<ChannelType, Set<string>>();
  private eventBus: EventBus | null = null;
  private sendFailureHandler: ((channel: ChannelType, target: string, text: string, error: string) => void) | null = null;

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus ?? null;
  }

  /** Set a callback for when message delivery fails (for DLQ integration) */
  onSendFailure(handler: (channel: ChannelType, target: string, text: string, error: string) => void): void {
    this.sendFailureHandler = handler;
  }

  // ─── Channel Registration ─────────────────────────────────────────────────

  /** Register a channel configuration */
  registerChannel(config: ChannelConfig): void {
    this.channels.set(config.type, config);

    // Initialize status
    this.statuses.set(config.type, {
      type: config.type,
      label: config.label,
      enabled: config.enabled,
      connected: false,
      messageCount: 0,
    });

    // Initialize peer sets
    this.approvedPeers.set(config.type, new Set(config.allowFrom));
    this.blocklistedPeers.set(config.type, new Set(config.blockFrom));

    process.stdout.write(`[ChannelManager] Registered channel: ${config.type} (${config.label})`);
  }

  /** Attach a channel adapter */
  async attachAdapter(adapter: ChannelAdapter): Promise<void> {
    this.adapters.set(adapter.type, adapter);

    // Wire up message handler
    if (this.messageHandler) {
      adapter.onMessage(this.messageHandler);
    }

    // Wire up status change handler
    adapter.onStatusChange((status) => {
      const channelStatus = this.statuses.get(adapter.type);
      if (channelStatus) {
        channelStatus.connected = status === "connected";
        channelStatus.error = status === "error" ? "Connection error" : undefined;
      }
      this.eventBus?.publish("channel.status", {
        channel: adapter.type,
        status,
      }, "channel");
    });

    // Start if channel is enabled
    const config = this.channels.get(adapter.type);
    if (config?.enabled) {
      try {
        await adapter.start();
        const channelStatus = this.statuses.get(adapter.type);
        if (channelStatus) channelStatus.connected = true;
        process.stdout.write(`[ChannelManager] Started adapter: ${adapter.type}`);
      } catch (err) {
        process.stderr.write(`[ChannelManager] Failed to start adapter ${adapter.type}:` + " " + err);
      }
    }
  }

  /** Detach a channel adapter */
  async detachAdapter(type: ChannelType): Promise<void> {
    const adapter = this.adapters.get(type);
    if (adapter) {
      await adapter.stop();
      this.adapters.delete(type);
    }
  }

  /** Get adapter by channel type */
  getAdapter(type: ChannelType): ChannelAdapter | undefined {
    return this.adapters.get(type);
  }

  // ─── Message Handling ─────────────────────────────────────────────────────

  /** Set the global message handler for all channels */
  setMessageHandler(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
    for (const adapter of this.adapters.values()) {
      adapter.onMessage(handler);
    }
  }

  /** Handle an incoming message from any channel */
  async handleIncomingMessage(msg: ChannelMessage): Promise<void> {
    // Update status
    const status = this.statuses.get(msg.channel);
    if (status) {
      status.lastActivity = new Date().toISOString();
      status.messageCount++;
    }

    // Check DM policy
    if (msg.isDirect && !msg.isGroup) {
      const policy = this.getDMPolicy(msg.channel);
      if (policy === "pairing" && !this.isPeerApproved(msg.channel, msg.from)) {
        // Clean up expired codes and old codes for this peer
        const now = Date.now();
        for (const [oldCode, entry] of this.pairingCodes) {
          if (now - entry.createdAt > 10 * 60 * 1000 || (entry.peerId === msg.from && entry.channel === msg.channel)) {
            this.pairingCodes.delete(oldCode);
          }
        }
        // Generate pairing code
        const pairingCode = this.generatePairingCode();
        this.pairingCodes.set(pairingCode, {
          code: pairingCode,
          channel: msg.channel,
          peerId: msg.from,
          createdAt: Date.now(),
        });

        // Send pairing challenge
        const adapter = this.adapters.get(msg.channel);
        if (adapter) {
          await adapter.sendMessage(msg.from,
            `DM from unknown sender. To approve, use pairing code: ${pairingCode}\n\n` +
            `Command: EvoClaw pairing approve ${msg.channel} ${pairingCode}`,
          );
        }
        return;
      }

      if (policy === "closed" && !this.isPeerApproved(msg.channel, msg.from)) {
        process.stdout.write(`[ChannelManager] Blocked DM from unapproved peer on ${msg.channel}: ${msg.from}`);
        return;
      }
    }

    // Check blocklist
    if (this.isPeerBlocklisted(msg.channel, msg.from)) {
      process.stdout.write(`[ChannelManager] Blocked message from blocklisted peer on ${msg.channel}: ${msg.from}`);
      return;
    }

    // Forward to message handler
    if (this.messageHandler) {
      try {
        await this.messageHandler(msg);
      } catch (err) {
        process.stderr.write(`[ChannelManager] Message handler error:` + " " + err);
        // 尝试通过适配器向用户发送错误通知，避免用户等待无响应
        // 用 try/catch 包裹，防止通知失败再次抛错造成循环
        if (msg.isDirect) {
          try {
            const adapter = this.adapters.get(msg.channel);
            if (adapter) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await adapter.sendMessage(
                msg.from,
                `⚠️ 处理您的消息时出现错误：${errMsg}\n\n请稍后重试，或联系管理员。`,
              );
            }
          } catch (notifyErr) {
            process.stderr.write(`[ChannelManager] Failed to send error notification to user:` + " " + notifyErr);
          }
        }
      }
    }
  }

  /** Send a message through a specific channel */
  async sendMessage(
    channel: ChannelType,
    target: string,
    text: string,
    options?: {
      replyTo?: string;
      attachments?: ChannelMessage["attachments"];
    },
  ): Promise<ChannelSendResult> {
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      const error = `No adapter for channel: ${channel}`;
      this.sendFailureHandler?.(channel, target, text, error);
      return { success: false, error, channel };
    }

    const result = await adapter.sendMessage(target, text, options);
    if (!result.success && result.error) {
      this.sendFailureHandler?.(channel, target, text, result.error);
    }
    return result;
  }

  // ─── Pairing / DM Policy ───────────────────────────────────────────────────

  /** Get DM policy for a channel */
  getDMPolicy(channel: ChannelType): DirectMessagePolicy {
    return this.channels.get(channel)?.dmPolicy ?? "pairing";
  }

  /** Check if a peer is approved */
  isPeerApproved(channel: ChannelType, peerId: string): boolean {
    const approved = this.approvedPeers.get(channel);
    if (approved?.has("*")) return true;
    return approved?.has(peerId) ?? false;
  }

  /** Check if a peer is blocklisted */
  isPeerBlocklisted(channel: ChannelType, peerId: string): boolean {
    return this.blocklistedPeers.get(channel)?.has(peerId) ?? false;
  }

  /** Approve a pairing code */
  approvePairing(code: string): boolean {
    const entry = this.pairingCodes.get(code);
    if (!entry) return false;

    // Pairing codes expire after 5 minutes
    if (Date.now() - entry.createdAt > 5 * 60 * 1000) {
      this.pairingCodes.delete(code);
      process.stderr.write(`[ChannelManager] Pairing code expired for peer ${entry.peerId} on ${entry.channel}`);
      return false;
    }

    const approved = this.approvedPeers.get(entry.channel);
    if (approved) {
      approved.add(entry.peerId);
    }

    this.pairingCodes.delete(code);
    process.stdout.write(`[ChannelManager] Approved peer ${entry.peerId} on ${entry.channel}`);
    return true;
  }

  /** Generate a random pairing code */
  private generatePairingCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += chars[crypto.randomInt(chars.length)];
    }
    return code;
  }

  /** Revoke approval for a peer */
  revokePeer(channel: ChannelType, peerId: string): boolean {
    return this.approvedPeers.get(channel)?.delete(peerId) ?? false;
  }

  /** Blocklist a peer */
  blockPeer(channel: ChannelType, peerId: string): void {
    const blocklist = this.blocklistedPeers.get(channel);
    if (blocklist) blocklist.add(peerId);
  }

  /** Unblock a peer */
  unblockPeer(channel: ChannelType, peerId: string): void {
    this.blocklistedPeers.get(channel)?.delete(peerId);
  }

  // ─── Channel Status ───────────────────────────────────────────────────────

  /** Get status for all channels */
  getAllStatuses(): ChannelStatus[] {
    return Array.from(this.statuses.values());
  }

  /** Get status for a specific channel */
  getStatus(type: ChannelType): ChannelStatus | undefined {
    return this.statuses.get(type);
  }

  /** Check if a channel is available */
  isChannelAvailable(type: ChannelType): boolean {
    const config = this.channels.get(type);
    return config?.enabled === true && this.adapters.has(type);
  }

  /** List all registered channel types */
  getChannelTypes(): ChannelType[] {
    return Array.from(this.channels.keys());
  }

  /** List all active (connected) channel types */
  getActiveChannels(): ChannelType[] {
    return Array.from(this.statuses.entries())
      .filter(([, status]) => status.enabled && status.connected)
      .map(([type]) => type);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Start all enabled channels */
  async startAll(): Promise<void> {
    for (const [type, adapter] of this.adapters) {
      const config = this.channels.get(type);
      if (config?.enabled) {
        try {
          await adapter.start();
          const status = this.statuses.get(type);
          if (status) status.connected = true;
          process.stdout.write(`[ChannelManager] Started ${type}`);
        } catch (err) {
          process.stderr.write(`[ChannelManager] Failed to start ${type}:` + " " + err);
        }
      }
    }
  }

  /** Stop all channels */
  async stopAll(): Promise<void> {
    for (const [type, adapter] of this.adapters) {
      try {
        await adapter.stop();
        const status = this.statuses.get(type);
        if (status) status.connected = false;
        process.stdout.write(`[ChannelManager] Stopped ${type}`);
      } catch (err) {
        process.stderr.write(`[ChannelManager] Failed to stop ${type}:` + " " + err);
      }
    }
  }

  /** Stop alias — delegates to stopAll() for shutdown compatibility */
  async stop(): Promise<void> {
    return this.stopAll();
  }
}