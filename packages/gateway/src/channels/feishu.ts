/**
 * Feishu (飞书) / Lark Channel Adapter
 *
 * Uses Feishu Open API v2 with long-polling + webhook dual mode.
 *
 * Feishu documentation: https://open.feishu.cn/document/
 *
 * Features:
 *  - IM message receiving via Event Subscription (webhook)
 *  - Message sending via /im/v1/messages API
 *  - Card messages (interactive template)
 *  - Tenant access token auto-refresh
 *  - Challenge verification (URL validation)
 *  - Group chat support
 */

import crypto from "crypto";
import type { ChannelAdapter, ChannelConfig, ChannelMessage, ChannelSendResult, ChannelType } from "../channel-manager.js";

// ── Config ────────────────────────────────────────────────

export interface FeishuConfig {
  /** Feishu App ID */
  appId: string;
  /** Feishu App Secret */
  appSecret: string;
  /** Verification token for event subscription */
  verificationToken?: string;
  /** Webhook path for receiving events (if using webhook mode) */
  webhookPath?: string;
  /** Whether to enable long-polling (alternative to webhook) */
  longPolling?: boolean;
  /** API endpoint (default: https://open.feishu.cn) */
  baseURL?: string;
}

// ── Adapter ───────────────────────────────────────────────

export class FeishuAdapter implements ChannelAdapter {
  readonly type: ChannelType = "feishu" as ChannelType;

  private config: FeishuConfig;
  private channelConfig: ChannelConfig;
  private baseURL: string;
  private accessToken: string | null = null;
  private tokenExpiry = 0;
  private messageHandler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private statusHandler: ((status: "connected" | "disconnected" | "reconnecting" | "error") => void) | null = null;
  private polling = false;
  private pollAbort = new AbortController();
  private processedEvents = new Set<string>();
  private static MAX_PROCESSED_EVENTS = 1000;

  constructor(channelConfig: ChannelConfig) {
    this.channelConfig = channelConfig;
    this.config = channelConfig.settings as unknown as FeishuConfig;
    this.baseURL = this.config.baseURL ?? "https://open.feishu.cn";
  }

  async start(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      this.statusHandler?.("error");
      return;
    }

    // Reset AbortController so start() works after stop()
    if (this.pollAbort.signal.aborted) {
      this.pollAbort = new AbortController();
    }

    // Get initial access token
    try {
      await this.refreshToken();
      this.statusHandler?.("connected");

      if (this.config.longPolling) {
        this.startPolling();
      }
    } catch (err) {
      this.statusHandler?.("error");
      console.error(`[Feishu] Start failed: ${err}`);
    }
  }

  async stop(): Promise<void> {
    this.pollAbort.abort();
    this.polling = false;
    this.statusHandler?.("disconnected");
  }

  async sendMessage(
    target: string,
    text: string,
    options?: { replyTo?: string; attachments?: ChannelMessage["attachments"] }
  ): Promise<ChannelSendResult> {
    try {
      await this.ensureToken();

      const body: Record<string, unknown> = {
        receive_id: target,
        msg_type: "text",
        content: JSON.stringify({ text }),
      };

      // Handle card messages for interactive content
      if (text.startsWith("{") && text.includes("card")) {
        try {
          const card = JSON.parse(text);
          if (card.msg_type === "interactive" || card.card) {
            body.msg_type = "interactive";
            body.content = text;
          }
        } catch {
          // Not a card, use text
        }
      }

      // Handle post (rich text) messages
      if (body.msg_type === "text") {
        try {
          const parsed = JSON.parse(text);
          if (parsed.zh_cn || parsed.en_us || parsed.ja_jp) {
            body.msg_type = "post";
            body.content = text;
          }
        } catch {
          // Not a post
        }
      }

      if (options?.replyTo) {
        body.root_id = options.replyTo;
      }

      const res = await fetch(`${this.baseURL}/open-apis/im/v1/messages?receive_id_type=open_id`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json() as {
        code: number;
        msg: string;
        data?: { message_id: string };
      };

      if (data.code === 0) {
        return {
          success: true,
          messageId: data.data?.message_id,
          channel: "feishu" as ChannelType,
        };
      }

      return {
        success: false,
        error: `Feishu API error [${data.code}]: ${data.msg}`,
        channel: "feishu" as ChannelType,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        channel: "feishu" as ChannelType,
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.ensureToken();
      return this.accessToken !== null;
    } catch {
      return false;
    }
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onStatusChange(handler: (status: "connected" | "disconnected" | "reconnecting" | "error") => void): void {
    this.statusHandler = handler;
  }

  /**
   * Handle incoming webhook event from Feishu Event Subscription.
   * Call this from your HTTP server's webhook route.
   */
  async handleWebhookEvent(body: Record<string, unknown>, headers?: Record<string, string>, rawBody?: string): Promise<{ challenge?: string }> {
    // Verify event signature using raw body if available
    if (rawBody && headers?.["x-lark-signature"]) {
      if (!this.verifySignature(rawBody, headers["x-lark-signature"])) {
        return {};
      }
    }

    // URL verification challenge
    if (body.type === "url_verification" && body.challenge) {
      return { challenge: body.challenge as string };
    }

    // Handle message events
    const header = body.header as Record<string, unknown> | undefined;
    if (header?.event_type === "im.message.receive_v1") {
      await this.processEvent(body.event as FeishuMessageEvent);
    }

    return {};
  }

  // ── Internal ────────────────────────────────────────────

  private verifySignature(body: string, signature: string | undefined): boolean {
    if (!this.config.verificationToken || !signature) {
      return true; // Skip if not configured
    }
    const expected = crypto.createHmac("sha256", this.config.verificationToken).update(body).digest("base64");
    return expected === signature;
  }

  private async refreshToken(): Promise<void> {
    const res = await fetch(`${this.baseURL}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }),
    });

    const data = await res.json() as {
      code: number;
      tenant_access_token: string;
      expire: number;
    };

    if (data.code !== 0) {
      throw new Error(`Feishu auth failed: ${(data as Record<string, unknown>).msg}`);
    }

    this.accessToken = data.tenant_access_token;
    // Expire slightly early (30s margin)
    this.tokenExpiry = Date.now() + (data.expire - 30) * 1000;
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken || Date.now() >= this.tokenExpiry) {
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.refreshToken();
          return;
        } catch (err) {
          lastError = err as Error;
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
      }
      throw lastError;
    }
  }

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;

    const poll = async () => {
      while (this.polling && !this.pollAbort.signal.aborted) {
        try {
          await this.pollMessages();
        } catch (err) {
          console.error("[Feishu] Polling error:", err);
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    };

    poll();
  }

  private async pollMessages(): Promise<void> {
    await this.ensureToken();

    const res = await fetch(
      `${this.baseURL}/open-apis/im/v1/messages?receive_id_type=open_id&page_size=20`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        signal: this.pollAbort.signal,
      }
    );

    if (!res.ok) return;

    const data = await res.json() as {
      code: number;
      data?: { items?: Array<FeishuMessageRecord> };
    };

    if (data.code === 0 && data.data?.items) {
      for (const item of data.data.items) {
        await this.processMessageRecord(item);
      }
    }
  }

  private async processMessageRecord(record: FeishuMessageRecord): Promise<void> {
    if (!this.messageHandler) return;

    const content = this.parseContent(record.body?.content ?? "");
    if (!content.text.trim()) return;

    // Determine if it's a group chat
    const isGroup = record.chat_type === "group";

    const msg: ChannelMessage = {
      messageId: record.message_id,
      channel: "feishu" as ChannelType,
      from: record.sender?.id ?? "unknown",
      to: isGroup ? (record.chat_id ?? "group") : "direct",
      text: content.text,
      timestamp: new Date(Number(record.create_time) || Date.now()).toISOString(),
      isDirect: !isGroup,
      isGroup,
      groupId: isGroup ? record.chat_id : undefined,
      attachments: content.attachments,
      raw: record as unknown as Record<string, unknown>,
    };

    await this.messageHandler(msg);
  }

  private async processEvent(event: FeishuMessageEvent): Promise<void> {
    if (!this.messageHandler) return;

    const msgBody = event.message;
    if (!msgBody) return;

    // Event deduplication
    const eventId = msgBody.message_id;
    if (eventId) {
      if (this.processedEvents.has(eventId)) return;
      this.processedEvents.add(eventId);
      if (this.processedEvents.size > FeishuAdapter.MAX_PROCESSED_EVENTS) {
        this.processedEvents.clear();
      }
    }

    const content = this.parseContent(msgBody.content);

    const msg: ChannelMessage = {
      messageId: msgBody.message_id ?? `msg_${Date.now()}`,
      channel: "feishu" as ChannelType,
      from: event.sender?.sender_id?.open_id ?? "unknown",
      to: msgBody.chat_id ?? "direct",
      text: content.text,
      timestamp: new Date(Number(msgBody.create_time) || Date.now()).toISOString(),
      isDirect: msgBody.chat_type !== "group",
      isGroup: msgBody.chat_type === "group",
      groupId: msgBody.chat_type === "group" ? msgBody.chat_id : undefined,
      attachments: content.attachments,
      raw: event as unknown as Record<string, unknown>,
    };

    await this.messageHandler(msg);
  }

  private parseContent(contentStr: string): {
    text: string;
    attachments?: ChannelMessage["attachments"];
  } {
    try {
      const parsed = JSON.parse(contentStr);
      const text = parsed.text ?? "";
      const attachments: ChannelMessage["attachments"] = [];

      if (parsed.image_key) {
        attachments.push({
          type: "image",
          url: parsed.image_key,
        });
      }
      if (parsed.file_key) {
        attachments.push({
          type: "document",
          url: parsed.file_key,
          filename: parsed.file_name,
        });
      }
      if (parsed.audio_key) {
        attachments.push({
          type: "audio",
          url: parsed.audio_key,
        });
      }

      return {
        text,
        attachments: attachments.length > 0 ? attachments : undefined,
      };
    } catch {
      return { text: contentStr };
    }
  }
}

// ── Internal Types ────────────────────────────────────────

interface FeishuMessageRecord {
  message_id: string;
  chat_id?: string;
  chat_type?: string;
  create_time?: string;
  sender?: {
    id: string;
    id_type?: string;
    sender_type?: string;
  };
  body?: {
    content: string;
  };
}

interface FeishuMessageEvent {
  sender?: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
    };
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    create_time?: string;
    content: string;
    message_type?: string;
  };
}