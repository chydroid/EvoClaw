/**
 * Telegram Channel Adapter — uses Telegram Bot API (grammY compatible).
 *
 * Supports: text messages, media (photo/video/audio/document),
 * inline keyboards, commands, webhook-based event receiving.
 *
 * Setup:
 *   1. Create a bot via @BotFather on Telegram
 *   2. Set TELEGRAM_BOT_TOKEN env var
 *   3. Optionally set webhook URL or use long polling
 */

import { timingSafeEqual } from "crypto";
import type {
  ChannelAdapter,
  ChannelHealthResult,
  ChannelMessage,
  ChannelSendResult,
  ChannelType,
} from "../channel-manager.js";

export interface TelegramConfig {
  /** Bot token from @BotFather */
  botToken: string;
  /** Webhook URL (optional, uses long polling if not set) */
  webhookUrl?: string;
  /** Webhook secret token (X-Telegram-Bot-Api-Secret-Token header) for verifying webhook requests */
  secretToken?: string;
  /** Allowed user/chat IDs (empty = allow all) */
  allowedChats?: number[];
  /** Blocked user/chat IDs */
  blockedChats?: number[];
  /** 是否拒绝未授权的私聊DM（OpenClaw安全策略） */
  rejectUnauthorizedDm?: boolean;
  /** 未授权DM的自动回复消息（空则不回复） */
  unauthorizedDmReply?: string;
  /** 是否在群组中只响应@bot的消息 */
  onlyRespondToMentions?: boolean;
  /** DM配对管理器（可选，用于动态授权DM） */
  dmPairingHandler?: {
    isPaired: (userId: number) => Promise<boolean> | boolean;
    requestPairing: (userId: number, chatId: number) => Promise<void>;
  };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  };
  chat: {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
    title?: string;
    username?: string;
  };
  date: number;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
  video?: { file_id: string; width: number; height: number; duration: number; mime_type?: string };
  audio?: { file_id: string; duration: number; mime_type?: string; title?: string };
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  sticker?: { file_id: string; emoji?: string };
  location?: { latitude: number; longitude: number };
  reply_to_message?: TelegramMessage;
  entities?: Array<{ type: string; offset: number; length: number }>;
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number; first_name: string; username?: string };
  message?: TelegramMessage;
  data?: string;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly type: ChannelType = "telegram";

  private botToken: string;
  private webhookUrl?: string;
  private secretToken?: string;
  private allowedChats: Set<number>;
  private blockedChats: Set<number>;
  private rejectUnauthorizedDm: boolean;
  private unauthorizedDmReply: string | undefined;
  private onlyRespondToMentions: boolean;
  private dmPairingHandler: TelegramConfig["dmPairingHandler"];
  private botUsername: string | undefined;

  private messageHandlers: Array<(msg: ChannelMessage) => Promise<void>> = [];
  private statusHandlers: Array<(status: "connected" | "disconnected" | "reconnecting" | "error") => void> = [];

  private running = false;
  private connected = false;
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateId = 0;
  private apiBase: string;

  constructor(config: TelegramConfig) {
    this.botToken = config.botToken;
    this.webhookUrl = config.webhookUrl;
    this.secretToken = config.secretToken;
    this.allowedChats = new Set(config.allowedChats ?? []);
    this.blockedChats = new Set(config.blockedChats ?? []);
    this.rejectUnauthorizedDm = config.rejectUnauthorizedDm ?? true;
    this.unauthorizedDmReply = config.unauthorizedDmReply;
    this.onlyRespondToMentions = config.onlyRespondToMentions ?? false;
    this.dmPairingHandler = config.dmPairingHandler;
    this.apiBase = `https://api.telegram.org/bot${this.botToken}`;
  }

  async start(): Promise<void> {
    if (this.running) return;

    try {
      // Verify bot token by calling getMe
      const me = await this.telegramApi<{
        ok: boolean;
        result?: { id: number; first_name: string; username?: string };
        description?: string;
      }>("getMe");

      if (!me.ok || !me.result) {
        throw new Error(me.description ?? "Failed to verify bot token");
      }

      const botName = me.result.username
        ? `@${me.result.username}`
        : me.result.first_name;
      console.log(`[Telegram] Connected as ${botName} (id: ${me.result.id})`);

      this.botUsername = me.result.username;

      this.running = true;
      this.connected = true;
      this.notifyStatus("connected");

      if (this.webhookUrl) {
        await this.setWebhook();
      } else {
        this.startLongPolling();
      }
    } catch (err) {
      this.notifyStatus("error");
      throw new Error(
        `Telegram connection failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.connected = false;

    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }

    // Delete webhook if set (so we don't miss messages after stop)
    if (this.webhookUrl) {
      try {
        await this.telegramApi("deleteWebhook");
      } catch {
        // ignore
      }
    }

    this.notifyStatus("disconnected");
    console.log("[Telegram] Stopped");
  }

  async sendMessage(
    target: string,
    text: string,
    options?: {
      replyTo?: string;
      attachments?: ChannelMessage["attachments"];
    }
  ): Promise<ChannelSendResult> {
    try {
      const body: Record<string, unknown> = {
        chat_id: target,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      };

      if (options?.replyTo) {
        body.reply_to_message_id = parseInt(options.replyTo, 10);
      }

      // Handle single photo attachment
      if (options?.attachments && options.attachments.length > 0) {
        const firstAttachment = options.attachments[0];
        if (firstAttachment.type === "image" && firstAttachment.url) {
          // Send as photo with caption
          const photoResult = await this.telegramApi<{
            ok: boolean;
            result?: { message_id: number };
            description?: string;
          }>("sendPhoto", {
            chat_id: target,
            photo: firstAttachment.url,
            caption: text,
            parse_mode: "HTML",
          });

          if (!photoResult.ok) {
            return {
              success: false,
              error: photoResult.description,
              channel: "telegram",
            };
          }

          return {
            success: true,
            messageId: String(photoResult.result?.message_id),
            channel: "telegram",
          };
        }

        if (firstAttachment.type === "document" && firstAttachment.url) {
          const docResult = await this.telegramApi<{
            ok: boolean;
            result?: { message_id: number };
            description?: string;
          }>("sendDocument", {
            chat_id: target,
            document: firstAttachment.url,
            caption: text,
            parse_mode: "HTML",
          });

          if (!docResult.ok) {
            return {
              success: false,
              error: docResult.description,
              channel: "telegram",
            };
          }

          return {
            success: true,
            messageId: String(docResult.result?.message_id),
            channel: "telegram",
          };
        }
      }

      const result = await this.telegramApi<{
        ok: boolean;
        result?: { message_id: number };
        description?: string;
      }>("sendMessage", body);

      if (!result.ok) {
        return {
          success: false,
          error: result.description,
          channel: "telegram",
        };
      }

      return {
        success: true,
        messageId: String(result.result?.message_id),
        channel: "telegram",
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        channel: "telegram",
      };
    }
  }

  async healthCheck(): Promise<ChannelHealthResult> {
    try {
      const me = await this.telegramApi<{ ok: boolean }>("getMe");
      if (me.ok === true) {
        return { healthy: true, message: "Telegram Bot API is reachable" };
      }
      return { healthy: false, message: "Telegram Bot API returned not ok" };
    } catch (err) {
      return { healthy: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  onStatusChange(
    handler: (status: "connected" | "disconnected" | "reconnecting" | "error") => void
  ): void {
    this.statusHandlers.push(handler);
  }

  // ── Webhook Handling ──────────────────────────────────────────────────────

  /**
   * Handle incoming webhook update from Telegram.
   * 若配置了 secretToken，则验证 X-Telegram-Bot-Api-Secret-Token 头。
   */
  async handleWebhook(body: unknown, headers?: Record<string, string>): Promise<void> {
    if (typeof body !== "object" || body === null) return;

    // 验证 webhook secret token（如果配置了）
    if (this.secretToken) {
      const receivedToken = headers?.["x-telegram-bot-api-secret-token"];
      if (!receivedToken) {
        console.warn("[Telegram] Webhook rejected: missing X-Telegram-Bot-Api-Secret-Token header");
        return;
      }
      try {
        const expectedBuf = Buffer.from(this.secretToken);
        const receivedBuf = Buffer.from(receivedToken);
        if (expectedBuf.length !== receivedBuf.length || !timingSafeEqual(expectedBuf, receivedBuf)) {
          console.warn("[Telegram] Webhook rejected: invalid secret token");
          return;
        }
      } catch {
        console.warn("[Telegram] Webhook rejected: secret token comparison failed");
        return;
      }
    }

    const update = body as TelegramUpdate;
    await this.processUpdate(update);
  }

  // ── Long Polling ──────────────────────────────────────────────────────────

  private startLongPolling(): void {
    // 递归 setTimeout：等上一次 getUpdates 完成后再发起下一次，
    // 避免服务端长轮询（timeout: 30）期间并发请求导致 409 Conflict。
    const poll = async (): Promise<void> => {
      if (!this.running) return;

      try {
        const updates = await this.telegramApi<{
          ok: boolean;
          result?: TelegramUpdate[];
        }>("getUpdates", {
          offset: this.lastUpdateId + 1,
          timeout: 30,
          allowed_updates: ["message", "edited_message", "callback_query"],
        });

        if (updates.ok && updates.result) {
          for (const update of updates.result) {
            await this.processUpdate(update);
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          }
        }
      } catch (err) {
        if (this.running) {
          this.notifyStatus("reconnecting");
          console.error("[Telegram] Polling error:", err);
        }
      }

      if (this.running) {
        this.pollingTimer = setTimeout(poll, 1000);
      }
    };

    poll();
  }

  // ── Update Processing ─────────────────────────────────────────────────────

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message || update.edited_message;
    if (!msg) return;

    // Access control
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (this.blockedChats.has(chatId)) return;
    if (userId && this.blockedChats.has(userId)) return;
    if (this.allowedChats.size > 0) {
      if (!this.allowedChats.has(chatId) && (!userId || !this.allowedChats.has(userId))) {
        return;
      }
    }

    const isDirect = msg.chat.type === "private";
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

    // 未授权DM拦截（OpenClaw安全策略）
    if (this.rejectUnauthorizedDm && isDirect) {
      const isAllowed = this.allowedChats.size === 0
        || this.allowedChats.has(chatId)
        || (userId && this.allowedChats.has(userId));

      if (!isAllowed) {
        // 检查DM配对
        const isPaired = this.dmPairingHandler
          ? await this.dmPairingHandler.isPaired(userId ?? chatId)
          : false;

        if (!isPaired) {
          console.warn(`[Telegram] Rejected unauthorized DM from user ${userId} (chat ${chatId})`);
          if (this.unauthorizedDmReply) {
            await this.sendMessage(String(chatId), this.unauthorizedDmReply);
          }
          return;
        }
      }
    }

    // 群组中只响应@bot的消息
    if (this.onlyRespondToMentions && isGroup) {
      const isMentioned = msg.entities?.some(e => e.type === "mention")
        && msg.text?.includes(`@${this.botUsername}`);
      if (!isMentioned && !msg.reply_to_message) {
        return; // 忽略未@bot的群组消息
      }
    }

    const text = msg.text || msg.caption || "";

    const channelMsg: ChannelMessage = {
      messageId: String(msg.message_id),
      channel: "telegram",
      from: String(msg.from?.id ?? chatId),
      to: String(chatId),
      text,
      timestamp: new Date(msg.date * 1000).toISOString(),
      isDirect,
      isGroup,
      groupId: !isDirect ? String(chatId) : undefined,
      replyTo: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      attachments: this.extractAttachments(msg),
      raw: msg as unknown as Record<string, unknown>,
    };

    for (const handler of this.messageHandlers) {
      try {
        await handler(channelMsg);
      } catch (err) {
        console.error("[Telegram] Message handler error:", err);
      }
    }
  }

  private extractAttachments(msg: TelegramMessage): ChannelMessage["attachments"] {
    const attachments: Array<{
      type: "image" | "video" | "audio" | "document" | "sticker";
      url?: string;
      data?: Buffer;
      mimeType?: string;
      filename?: string;
    }> = [];

    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      attachments.push({ type: "image", url: largest.file_id, mimeType: "image/jpeg" });
    }
    if (msg.video) {
      attachments.push({ type: "video", url: msg.video.file_id, mimeType: msg.video.mime_type });
    }
    if (msg.audio) {
      attachments.push({ type: "audio", url: msg.audio.file_id, mimeType: msg.audio.mime_type });
    }
    if (msg.document) {
      attachments.push({
        type: "document",
        url: msg.document.file_id,
        mimeType: msg.document.mime_type,
        filename: msg.document.file_name,
      });
    }
    if (msg.sticker) {
      attachments.push({ type: "sticker", url: msg.sticker.file_id });
    }
    if (msg.location) {
      attachments.push({
        type: "document",
        mimeType: "application/json",
        filename: "location.json",
      });
    }

    return attachments.length > 0 ? attachments : undefined;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async setWebhook(): Promise<void> {
    if (!this.webhookUrl) return;

    const result = await this.telegramApi<{
      ok: boolean;
      description?: string;
    }>("setWebhook", {
      url: this.webhookUrl,
      allowed_updates: ["message", "edited_message", "callback_query"],
      max_connections: 100,
      ...(this.secretToken ? { secret_token: this.secretToken } : {}),
    });

    if (!result.ok) {
      console.warn("[Telegram] Failed to set webhook:", result.description);
    } else {
      console.log("[Telegram] Webhook set to:", this.webhookUrl);
    }
  }

  private async telegramApi<T>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    let url: string;
    let body: string | undefined;

    if (method === "getMe" || method === "deleteWebhook" || method === "getUpdates") {
      const queryParams = new URLSearchParams();
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          queryParams.append(key, String(value));
        }
      }
      url = `${this.apiBase}/${method}?${queryParams.toString()}`;
      body = undefined;
    } else {
      url = `${this.apiBase}/${method}`;
      body = JSON.stringify(params ?? {});
    }

    const response = await fetch(url, {
      method: method === "getMe" || method === "getUpdates" ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Telegram API ${method}: HTTP ${response.status} - ${text.slice(0, 200)}`
      );
    }

    return response.json() as Promise<T>;
  }

  private notifyStatus(
    status: "connected" | "disconnected" | "reconnecting" | "error"
  ): void {
    for (const handler of this.statusHandlers) {
      try {
        handler(status);
      } catch (err) { console.debug("[Telegram]", err instanceof Error ? err.message : String(err)); }
    }
  }
}