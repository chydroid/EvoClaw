/**
 * Channel Adapter Framework — base framework for implementing message channel adapters.
 *
 * Provides:
 *  - Abstract ChannelAdapterBase base class that implements the ChannelAdapter interface
 *    from channel-manager.ts, ensuring unified adapter contract
 *  - WebhookChannelAdapter — generic webhook-based adapter
 *  - TelegramChannelAdapter — Telegram Bot API adapter (polling mode)
 */

import * as crypto from "crypto";
import type {
  ChannelAdapter as ChannelAdapterInterface,
  ChannelType,
  ChannelMessage,
  ChannelSendResult,
  ChannelHealthResult,
} from "./channel-manager";

// ─── Channel Adapter Base ────────────────────────────────────────────────────

export interface ChannelAdapterConfig {
  channelId: string;
  channelName: string;
  enabled: boolean;
  /** Channel type for ChannelAdapter interface compliance */
  channelType?: ChannelType;
}

export type ChannelAdapterStatus = "stopped" | "starting" | "running" | "stopping" | "error";

/**
 * Abstract base class for channel adapters.
 * Implements the ChannelAdapter interface from channel-manager.ts for unified contract.
 * Subclasses must implement start(), stop(), and sendMessage().
 */
export abstract class ChannelAdapterBase implements ChannelAdapterInterface {
  protected readonly config: ChannelAdapterConfig;
  protected status: ChannelAdapterStatus = "stopped";
  protected messageHandlers: Array<(msg: ChannelMessage) => Promise<void>> = [];
  protected statusChangeHandlers: Array<(status: "connected" | "disconnected" | "reconnecting" | "error") => void> = [];

  constructor(config: ChannelAdapterConfig) {
    this.config = config;
  }

  /** Channel type identifier (implements ChannelAdapter interface) */
  get type(): ChannelType {
    return this.config.channelType ?? "custom";
  }

  /** Start the channel adapter (connect, begin listening, etc.) */
  abstract start(): Promise<void>;

  /** Stop the channel adapter (disconnect, cleanup, etc.) */
  abstract stop(): Promise<void>;

  /** Send a message to a specific peer (simplified signature) */
  abstract sendMessage(target: string, text: string, options?: {
    replyTo?: string;
    attachments?: ChannelMessage["attachments"];
  }): Promise<ChannelSendResult>;

  /** Register a handler for incoming messages (implements ChannelAdapter interface) */
  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  /** Handle connection status changes (implements ChannelAdapter interface) */
  onStatusChange(handler: (status: "connected" | "disconnected" | "reconnecting" | "error") => void): void {
    this.statusChangeHandlers.push(handler);
  }

  /** Check channel health (implements ChannelAdapter interface) */
  async healthCheck(): Promise<ChannelHealthResult> {
    return {
      healthy: this.status === "running",
      message: this.status === "running" ? "Channel is running" : `Channel is ${this.status}`,
    };
  }

  /** Get the current status of the adapter */
  getStatus(): ChannelAdapterStatus {
    return this.status;
  }

  /** Check if the adapter is currently running */
  isRunning(): boolean {
    return this.status === "running";
  }

  /** Get the channel identifier */
  getChannelId(): string {
    return this.config.channelId;
  }

  /** Dispatch an incoming message to all registered handlers */
  protected async dispatchMessage(msg: ChannelMessage): Promise<void> {
    for (const handler of this.messageHandlers) {
      try {
        await handler(msg);
      } catch (err) {
        process.stderr.write(
          `[ChannelAdapter:${this.config.channelId}] Message handler error:` + " " + (err instanceof Error ? err.message : String(err)) + "\n"
        );
      }
    }
  }

  /** Notify status change handlers */
  protected notifyStatusChange(status: "connected" | "disconnected" | "reconnecting" | "error"): void {
    for (const handler of this.statusChangeHandlers) {
      try {
        handler(status);
      } catch (err) {
        process.stderr.write(
          `[ChannelAdapter:${this.config.channelId}] Status change handler error:` + " " + (err instanceof Error ? err.message : String(err)) + "\n"
        );
      }
    }
  }

  /** Helper: create a ChannelMessage from basic fields */
  protected createChannelMessage(from: string, text: string, extra?: Partial<ChannelMessage>): ChannelMessage {
    return {
      messageId: `${this.config.channelId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel: this.type,
      from,
      to: this.config.channelId,
      text,
      timestamp: new Date().toISOString(),
      isDirect: true,
      isGroup: false,
      raw: {},
      ...extra,
    };
  }
}

// ─── Webhook Channel Adapter ─────────────────────────────────────────────────

export interface WebhookChannelConfig extends ChannelAdapterConfig {
  /** URL to send outgoing messages to */
  webhookUrl: string;
  /** Secret for HMAC signature verification */
  secret?: string;
  /** Path to register for incoming webhook payloads */
  incomingPath?: string;
  /** Custom headers to include in outgoing requests */
  headers?: Record<string, string>;
  /** Request timeout in ms (default: 10000) */
  timeoutMs?: number;
}

export class WebhookChannelAdapter extends ChannelAdapterBase {
  private readonly webhookUrl: string;
  private readonly secret: string;
  private readonly incomingPath: string;
  private readonly customHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private registered = false;

  constructor(config: WebhookChannelConfig) {
    super(config);
    this.webhookUrl = config.webhookUrl;
    this.secret = config.secret ?? "";
    this.incomingPath = config.incomingPath ?? `/webhook/${config.channelId}`;
    this.customHeaders = config.headers ?? {};
    this.timeoutMs = config.timeoutMs ?? 10000;
  }

  async start(): Promise<void> {
    if (this.status === "running") return;

    this.status = "starting";
    try {
      // Register the webhook endpoint
      this.registered = true;
      this.status = "running";
      process.stdout.write(
        `[WebhookChannel:${this.config.channelId}] Started — outgoing URL: ${this.webhookUrl}, incoming path: ${this.incomingPath}`,
      );
    } catch (err) {
      this.status = "error";
      throw new Error(
        `WebhookChannel "${this.config.channelId}" start failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async stop(): Promise<void> {
    this.status = "stopping";
    try {
      // Unregister the webhook endpoint
      this.registered = false;
      this.status = "stopped";
      process.stdout.write(`[WebhookChannel:${this.config.channelId}] Stopped`);
    } catch (err) {
      this.status = "error";
      throw new Error(
        `WebhookChannel "${this.config.channelId}" stop failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async sendMessage(target: string, text: string, _options?: {
    replyTo?: string;
    attachments?: ChannelMessage["attachments"];
  }): Promise<ChannelSendResult> {
    if (!this.registered) {
      process.stderr.write(`[WebhookChannel:${this.config.channelId}] Cannot send — adapter not started`);
      return { success: false, error: "Adapter not started", channel: this.type };
    }

    try {
      const body = JSON.stringify({
        channelId: this.config.channelId,
        peerId: target,
        message: text,
        timestamp: new Date().toISOString(),
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "EvoClaw-WebhookAdapter/1.0",
        "X-Channel-Id": this.config.channelId,
        ...this.customHeaders,
      };

      if (this.secret) {
        headers["X-Webhook-Signature"] = this.signPayload(body);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        process.stderr.write(
          `[WebhookChannel:${this.config.channelId}] Send failed — HTTP ${response.status}`,
        );
        return { success: false, error: `HTTP ${response.status}`, channel: this.type };
      }

      return { success: true, channel: this.type };
    } catch (err) {
      process.stderr.write(
        `[WebhookChannel:${this.config.channelId}] Send error:` + " " + (err instanceof Error ? err.message : String(err)) + "\n"
      );
      return { success: false, error: err instanceof Error ? err.message : String(err), channel: this.type };
    }
  }

  /**
   * Handle an incoming webhook payload.
   * Call this from your HTTP server when a request arrives at the incoming path.
   */
  async handleIncomingPayload(payload: {
    peerId?: string;
    message?: string;
    [key: string]: unknown;
  }): Promise<void> {
    if (this.status !== "running") {
      process.stderr.write(`[WebhookChannel:${this.config.channelId}] Ignoring payload — adapter not running`);
      return;
    }

    const peerId = payload.peerId ?? "unknown";
    const message = payload.message ?? "";

    if (!message) {
      process.stderr.write(`[WebhookChannel:${this.config.channelId}] Ignoring payload — empty message`);
      return;
    }

    await this.dispatchMessage(this.createChannelMessage(String(peerId), String(message), { raw: payload }));
  }

  /** Get the incoming webhook path for route registration */
  getIncomingPath(): string {
    return this.incomingPath;
  }

  /** Check if the webhook endpoint is registered */
  isRegistered(): boolean {
    return this.registered;
  }

  private signPayload(body: string): string {
    if (!this.secret) return "";
    // 使用顶部 import 的 crypto 模块，避免 ESM 中 require 未定义导致签名静默失效
    const hmac = crypto.createHmac("sha256", this.secret);
    hmac.update(body);
    return `sha256=${hmac.digest("hex")}`;
  }
}

// ─── Telegram Channel Adapter ────────────────────────────────────────────────

export interface TelegramChannelConfig extends ChannelAdapterConfig {
  /** Bot token from @BotFather */
  botToken: string;
  /** Polling interval in ms (default: 2000) */
  pollingIntervalMs?: number;
  /** Long polling timeout in seconds (default: 30) */
  longPollTimeout?: number;
  /** Allowed chat IDs (empty = allow all) */
  allowedChats?: number[];
  /** Blocked chat IDs */
  blockedChats?: number[];
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
  };
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export class TelegramChannelAdapter extends ChannelAdapterBase {
  private readonly botToken: string;
  private readonly pollingIntervalMs: number;
  private readonly longPollTimeout: number;
  private readonly allowedChats: Set<number>;
  private readonly blockedChats: Set<number>;
  private readonly apiBase: string;

  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateId = 0;
  private botUsername: string | null = null;

  constructor(config: TelegramChannelConfig) {
    super(config);
    this.botToken = config.botToken;
    this.pollingIntervalMs = config.pollingIntervalMs ?? 2000;
    this.longPollTimeout = config.longPollTimeout ?? 30;
    this.allowedChats = new Set(config.allowedChats ?? []);
    this.blockedChats = new Set(config.blockedChats ?? []);
    this.apiBase = `https://api.telegram.org/bot${this.botToken}`;
  }

  async start(): Promise<void> {
    if (this.status === "running") return;

    this.status = "starting";
    try {
      // Verify bot token
      const me = await this.telegramApi<{ id: number; first_name: string; username?: string }>("getMe");
      if (!me.ok || !me.result) {
        throw new Error(me.description ?? "Failed to verify bot token");
      }

      this.botUsername = me.result.username ?? me.result.first_name;
      process.stdout.write(
        `[TelegramChannel:${this.config.channelId}] Connected as @${this.botUsername} (id: ${me.result.id})`,
      );

      // Start polling
      this.startPolling();
      this.status = "running";
    } catch (err) {
      this.status = "error";
      throw new Error(
        `TelegramChannel "${this.config.channelId}" start failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async stop(): Promise<void> {
    this.status = "stopping";
    try {
      if (this.pollingTimer) {
        clearInterval(this.pollingTimer);
        this.pollingTimer = null;
      }
      this.status = "stopped";
      process.stdout.write(`[TelegramChannel:${this.config.channelId}] Stopped`);
    } catch (err) {
      this.status = "error";
      throw new Error(
        `TelegramChannel "${this.config.channelId}" stop failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async sendMessage(target: string, text: string, _options?: {
    replyTo?: string;
    attachments?: ChannelMessage["attachments"];
  }): Promise<ChannelSendResult> {
    try {
      const result = await this.telegramApi<{ message_id: number }>("sendMessage", {
        chat_id: target,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });

      if (!result.ok) {
        process.stderr.write(
          `[TelegramChannel:${this.config.channelId}] Send failed: ${result.description}`,
        );
        return { success: false, error: result.description, channel: this.type };
      }

      return { success: true, messageId: String(result.result?.message_id), channel: this.type };
    } catch (err) {
      process.stderr.write(
        `[TelegramChannel:${this.config.channelId}] Send error:` + " " + (err instanceof Error ? err.message : String(err)) + "\n"
      );
      return { success: false, error: err instanceof Error ? err.message : String(err), channel: this.type };
    }
  }

  /** Get the bot username (available after start) */
  getBotUsername(): string | null {
    return this.botUsername;
  }

  // ── Polling ─────────────────────────────────────────────────────────────

  private startPolling(): void {
    // 使用递归 setTimeout 而非 setInterval，避免长轮询未返回时下一次 tick 重叠触发
    const poll = async (): Promise<void> => {
      if (this.status !== "running") return;
      try {
        const updates = await this.telegramApi<TelegramUpdate[]>("getUpdates", {
          offset: this.lastUpdateId + 1,
          timeout: this.longPollTimeout,
          allowed_updates: ["message"],
        });

        if (updates.ok && updates.result) {
          for (const update of updates.result) {
            await this.processUpdate(update);
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          }
        }
      } catch (err) {
        if (this.status === "running") {
          process.stderr.write(
            `[TelegramChannel:${this.config.channelId}] Polling error:` + " " + (err instanceof Error ? err.message : String(err)) + "\n"
          );
        }
      } finally {
        if (this.status === "running") {
          this.pollingTimer = setTimeout(() => { void poll(); }, this.pollingIntervalMs);
          this.pollingTimer.unref?.();
        }
      }
    };
    this.pollingTimer = setTimeout(() => { void poll(); }, this.pollingIntervalMs);
    this.pollingTimer.unref?.();
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.text) return;

    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    // Access control
    if (this.blockedChats.has(chatId)) return;
    if (userId && this.blockedChats.has(userId)) return;
    if (this.allowedChats.size > 0) {
      if (!this.allowedChats.has(chatId) && (!userId || !this.allowedChats.has(userId))) {
        return;
      }
    }

    const peerId = String(chatId);
    await this.dispatchMessage(this.createChannelMessage(peerId, msg.text, {
      isGroup: msg.chat.type === "group" || msg.chat.type === "supergroup",
      groupId: msg.chat.type !== "private" ? peerId : undefined,
      raw: update as unknown as Record<string, unknown>,
    }));
  }

  // ── Telegram API Helper ─────────────────────────────────────────────────

  private async telegramApi<T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<TelegramApiResponse<T>> {
    const url = `${this.apiBase}/${method}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params ? JSON.stringify(params) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Telegram API ${method}: HTTP ${response.status} — ${text.slice(0, 200)}`);
    }

    return response.json() as Promise<TelegramApiResponse<T>>;
  }
}
