/**
 * ChannelManager — OpenClaw-style multi-channel support.
 *
 * Manages communication channels like WhatsApp, Telegram, Discord, Slack,
 * WebChat, etc. Each channel has its own adapter, message handling, and
 * delivery pipeline.
 */

import * as crypto from "node:crypto";
import type { EventBus } from "@evoclaw/core";
// R11 P0 死码接线（台账第 5 项）：DispatchDedupeStore / BotLoopProtection 此前
// 仅 barrel 导出、零实例化。接入点选在 ChannelManager.handleIncomingMessage——
// 全部渠道适配器（telegram/feishu/discord/...）的 onMessage 都汇入此处。
// OpenClaw 对位：src/channels/turn/ 的 dedupe + bot-loop-protection 同层。
import { DispatchDedupeStore } from "./dispatch-dedupe-store.js";
import type { HistoryEntry } from "./history-window.js";
import { BotLoopProtection } from "./bot-loop-protection.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChannelType =
  | "whatsapp"
  | "telegram"
  | "discord"
  | "slack"
  | "feishu"
  | "wechat"
  | "qq"
  | "weibo"
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
  // ── R11 P0 死码接线 ──
  /** 入站分发去重（channel+messageId 键；成功才记账，失败允许重投）。 */
  private dedupeStore: DispatchDedupeStore | null = null;
  /** bot 自循环防护（按群分实例；DM 不启用——ping-pong 检测本就面向群聊）。 */
  private loopProtectionByGroup = new Map<string, BotLoopProtection>();
  /** 循环防护动作日志去抖：同一群短时间内不重复告警。 */
  private lastLoopActionByGroup = new Map<string, { action: string; at: number }>();

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus ?? null;
  }

  /**
   * 启用入站分发去重。server 启动时调用；未调用则零开销（向后兼容）。
   */
  enableDispatchDedupe(config?: { persistPath?: string; persistEnabled?: boolean }): void {
    this.dedupeStore = new DispatchDedupeStore({
      persistPath: config?.persistPath,
      persistEnabled: config?.persistEnabled ?? false,
      defaultTtlMs: 6 * 60 * 60 * 1000, // 6h：重投窗口远小于消息重放周期即可
    });
  }

  getDispatchDedupeStats(): ReturnType<DispatchDedupeStore["getStats"]> | null {
    return this.dedupeStore?.getStats() ?? null;
  }

  /** 取（或懒建）某群的循环防护实例。 */
  private loopProtectionFor(groupId: string): BotLoopProtection {
    let inst = this.loopProtectionByGroup.get(groupId);
    if (!inst) {
      inst = new BotLoopProtection();
      // 防实例泄漏：超过 256 群时清理无抑制条目的旧实例（窗口/抑制都在实例内）
      if (this.loopProtectionByGroup.size >= 256) {
        for (const [gid, lp] of this.loopProtectionByGroup) {
          if (lp.pruneSuppressions() === 0 && !this.recentLoopAction(gid)) {
            this.loopProtectionByGroup.delete(gid);
            break;
          }
        }
      }
      this.loopProtectionByGroup.set(groupId, inst);
    }
    return inst;
  }

  private recentLoopAction(groupId: string): boolean {
    const last = this.lastLoopActionByGroup.get(groupId);
    return !!last && Date.now() - last.at < 5 * 60 * 1000;
  }

  /** 消息 payload 稳定哈希（dedupe 记账用）。 */
  private hashMessagePayload(msg: ChannelMessage): string {
    return crypto.createHash("sha256").update(`${msg.from}:${msg.text}`).digest("hex").slice(0, 16);
  }

  /** ChannelMessage → 循环防护 HistoryEntry（内容脱敏：截断 200 字符）。 */
  private toHistoryEntry(msg: ChannelMessage): HistoryEntry {
    return {
      messageId: msg.messageId,
      senderId: msg.from,
      recipientId: msg.groupId ?? msg.to,
      content: (msg.text ?? "").slice(0, 200),
      timestamp: new Date(msg.timestamp),
      channel: msg.channel,
      isBot: (msg.raw as Record<string, unknown> | undefined ? ((msg.raw as Record<string, unknown>).from as Record<string, unknown> | undefined)?.is_bot === true || ((msg.raw as Record<string, unknown>).author as Record<string, unknown> | undefined)?.bot === true : false),
    };
  }

  /** 关闭时释放去重存储（刷新待写持久化）。 */
  shutdownDedupe(): void {
    this.dedupeStore?.shutdown();
    this.dedupeStore = null;
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

    process.stdout.write(`[ChannelManager] Registered channel: ${config.type} (${config.label})\n`);
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
      }, "channel")?.catch((err) => {
        process.stderr.write(`[ChannelManager] publish channel.status failed: ${err}\n`);
      });
    });

    // Start if channel is enabled
    const config = this.channels.get(adapter.type);
    if (config?.enabled) {
      try {
        await adapter.start();
        const channelStatus = this.statuses.get(adapter.type);
        if (channelStatus) channelStatus.connected = true;
        process.stdout.write(`[ChannelManager] Started adapter: ${adapter.type}\n`);
      } catch (err) {
        process.stderr.write(`[ChannelManager] Failed to start adapter ${adapter.type}:` + " " + err + "\n");
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
    // ── R11 P0：入站分发去重（OpenClaw 6.6 对位）──
    // 同一 (channel, messageId) 只分发一次；记账发生在**处理成功后**——
    // 处理失败/中途崩溃不记账，平台重投时 isDispatched=false 允许再次分发。
    // （不采用「pending 占位」方案：占位本身就会挡住重投，与重投语义矛盾。）
    // messageId 缺失（如 framework 兜底的随机 id）不去重——随机 id 天然唯一。
    let dedupePending = false;
    if (this.dedupeStore && msg.messageId && !/^\w+-\d+-[0-9a-f]+$/.test(msg.messageId)) {
      dedupePending = !this.dedupeStore.isDispatched({ channel: msg.channel, externalId: msg.messageId });
      if (!dedupePending) {
        process.stdout.write(`[ChannelManager] Dedupe: skipped already-dispatched message ${msg.channel}/${msg.messageId}\n`);
        return;
      }
    }

    // ── R11 P0：群聊 bot 自循环防护（openclaw 对位）──
    // 只拦「block/alert」级动作；throttle 及以下放行，避免误伤正常群聊。
    if (msg.isGroup && msg.text) {
      const groupId = msg.groupId ?? msg.to;
      const loopResult = this.loopProtectionFor(groupId).evaluate(this.toHistoryEntry(msg));
      if (loopResult.action === "block" || loopResult.action === "alert") {
        process.stdout.write(`[ChannelManager] Bot-loop ${loopResult.pattern} (${loopResult.repeatedCount}x) in ${msg.channel}/${groupId}: ${loopResult.reason} — blocked\n`);
        this.lastLoopActionByGroup.set(groupId, { action: loopResult.action, at: Date.now() });
        return;
      }
    }

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
        // 使用与 approvePairing 一致的 5 分钟 TTL，避免过期码长时间残留
        const now = Date.now();
        for (const [oldCode, entry] of this.pairingCodes) {
          if (now - entry.createdAt > 5 * 60 * 1000 || (entry.peerId === msg.from && entry.channel === msg.channel)) {
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
        process.stdout.write(`[ChannelManager] Blocked DM from unapproved peer on ${msg.channel}: ${msg.from}\n`);
        return;
      }
    }

    // Check blocklist
    if (this.isPeerBlocklisted(msg.channel, msg.from)) {
      process.stdout.write(`[ChannelManager] Blocked message from blocklisted peer on ${msg.channel}: ${msg.from}\n`);
      return;
    }

    // Forward to message handler
    if (this.messageHandler) {
      try {
        await this.messageHandler(msg);
        // 分发成功 → 记账（失败不记，平台重投允许再次分发）
        if (dedupePending && this.dedupeStore && msg.messageId) {
          this.dedupeStore.record(
            { channel: msg.channel, externalId: msg.messageId },
            this.hashMessagePayload(msg),
            msg.from,
            "success",
          );
        }
      } catch (err) {
        process.stderr.write(`[ChannelManager] Message handler error:` + " " + err + "\n");
        // 尝试通过适配器向用户发送错误通知，避免用户等待无响应
        // 用 try/catch 包裹，防止通知失败再次抛错造成循环
        // 不向用户泄露内部错误详情（err 已记录到日志）
        if (msg.isDirect) {
          try {
            const adapter = this.adapters.get(msg.channel);
            if (adapter) {
              await adapter.sendMessage(
                msg.from,
                `⚠️ 处理您的消息时出现错误，请稍后重试，或联系管理员。`,
              );
            }
          } catch (notifyErr) {
            process.stderr.write(`[ChannelManager] Failed to send error notification to user:` + " " + notifyErr + "\n");
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
      process.stderr.write(`[ChannelManager] Pairing code expired for peer ${entry.peerId} on ${entry.channel}\n`);
      return false;
    }

    const approved = this.approvedPeers.get(entry.channel);
    if (approved) {
      approved.add(entry.peerId);
    }

    this.pairingCodes.delete(code);
    process.stdout.write(`[ChannelManager] Approved peer ${entry.peerId} on ${entry.channel}\n`);
    return true;
  }

  /** Reject (discard) a pending pairing code. Returns true if a pending code was removed. */
  rejectPairing(code: string, channel?: ChannelType): boolean {
    const entry = this.pairingCodes.get(code);
    if (!entry) return false;
    // 若调用方指定了 channel，则需匹配，防止误删其他 channel 的配对码
    if (channel && entry.channel !== channel) return false;
    this.pairingCodes.delete(code);
    process.stdout.write(`[ChannelManager] Rejected pairing code ${code} for peer ${entry.peerId} on ${entry.channel}\n`);
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
          process.stdout.write(`[ChannelManager] Started ${type}\n`);
        } catch (err) {
          process.stderr.write(`[ChannelManager] Failed to start ${type}:` + " " + err + "\n");
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
        process.stdout.write(`[ChannelManager] Stopped ${type}\n`);
      } catch (err) {
        process.stderr.write(`[ChannelManager] Failed to stop ${type}:` + " " + err + "\n");
      }
    }
  }

  /** Stop alias — delegates to stopAll() for shutdown compatibility */
  async stop(): Promise<void> {
    return this.stopAll();
  }
}