/**
 * WhatsApp Cloud API Channel Adapter — uses Meta WhatsApp Business API.
 *
 * Supports: text messages, media (image/video/audio/document), interactive
 * messages, template messages, webhook-based event receiving.
 *
 * Setup:
 *   1. Set up a Meta Business app with WhatsApp
 *   2. Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN env vars
 *   3. Configure webhook URL in Meta Developer Console
 *   4. Get a test phone number from the WhatsApp sandbox
 */

import crypto from "crypto";
import type {
  ChannelAdapter,
  ChannelHealthResult,
  ChannelMessage,
  ChannelSendResult,
  ChannelType,
} from "../channel-manager.js";

export interface WhatsAppConfig {
  /** Phone Number ID from Meta Business */
  phoneNumberId: string;
  /** Permanent access token */
  accessToken: string;
  /** Webhook verify token */
  verifyToken?: string;
  /** Meta App Secret for X-Hub-Signature-256 webhook signature verification */
  appSecret?: string;
  /** Allowed phone numbers (empty = all) */
  allowedNumbers?: string[];
  /** Business account ID */
  businessAccountId?: string;
  /** API version (default: v22.0) */
  apiVersion?: string;
}

interface WhatsAppWebhookEntry {
  id: string;
  changes: Array<{
    value: {
      messaging_product: string;
      metadata: { display_phone_number: string; phone_number_id: string };
      contacts?: Array<{ profile: { name: string }; wa_id: string }>;
      messages?: WhatsAppIncomingMessage[];
      statuses?: WhatsAppStatus[];
    };
  }>;
}

interface WhatsAppIncomingMessage {
  id: string;
  from: string;
  timestamp: string;
  type: "text" | "image" | "video" | "audio" | "document" | "sticker" | "location" | "button" | "interactive";
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256?: string };
  video?: { id: string; mime_type: string };
  audio?: { id: string; mime_type: string };
  document?: { id: string; mime_type: string; filename?: string };
  sticker?: { id: string; mime_type: string };
  location?: { latitude: number; longitude: number };
  button?: { text: string; payload: string };
  interactive?: {
    type: "button_reply" | "list_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description: string };
  };
  context?: { id: string; from: string };
}

interface WhatsAppStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipient_id: string;
}

type WhatsAppMediaType = "image" | "video" | "audio" | "document";

export class WhatsAppAdapter implements ChannelAdapter {
  readonly type: ChannelType = "whatsapp";

  private phoneNumberId: string;
  private accessToken: string;
  private verifyToken: string;
  private appSecret?: string;
  private apiVersion: string;
  private allowedNumbers: Set<string>;
  private businessAccountId?: string;

  private messageHandlers: Array<(msg: ChannelMessage) => Promise<void>> = [];
  private statusHandlers: Array<
    (status: "connected" | "disconnected" | "reconnecting" | "error") => void
  > = [];

  private running = false;
  private connected = false;

  constructor(config: WhatsAppConfig) {
    this.phoneNumberId = config.phoneNumberId;
    this.accessToken = config.accessToken;
    this.verifyToken = config.verifyToken ?? "evoclaw-whatsapp";
    this.appSecret = config.appSecret;
    this.apiVersion = config.apiVersion ?? "v22.0";
    this.allowedNumbers = new Set(config.allowedNumbers ?? []);
    this.businessAccountId = config.businessAccountId;
  }

  async start(): Promise<void> {
    if (this.running) return;

    try {
      // Verify credentials by fetching phone number info
      const info = await this.whatsappApi<{
        verified_name?: string;
        display_phone_number?: string;
      }>("GET", `/${this.phoneNumberId}`);

      const displayName =
        info.verified_name ?? info.display_phone_number ?? "unknown";
      console.log(`[WhatsApp] Connected as ${displayName}`);

      this.running = true;
      this.connected = true;
      this.notifyStatus("connected");
    } catch (err) {
      this.notifyStatus("error");
      throw new Error(
        `WhatsApp connection failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.connected = false;
    this.notifyStatus("disconnected");
    console.log("[WhatsApp] Stopped");
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
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: target,
        type: "text",
        text: { preview_url: false, body: text },
      };

      if (options?.replyTo) {
        body.type = "text";
        (body.text as Record<string, unknown>).preview_url = false;
        body.context = { message_id: options.replyTo };
      }

      const result = await this.whatsappApi<{
        messages?: Array<{ id: string }>;
        error?: { message: string };
      }>(
        "POST",
        `/${this.phoneNumberId}/messages`,
        body
      );

      if (result.error) {
        return {
          success: false,
          error: result.error.message,
          channel: "whatsapp",
        };
      }

      return {
        success: true,
        messageId: result.messages?.[0]?.id,
        channel: "whatsapp",
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        channel: "whatsapp",
      };
    }
  }

  async healthCheck(): Promise<ChannelHealthResult> {
    try {
      const result = await this.whatsappApi<{ verified_name?: string }>(
        "GET",
        `/${this.phoneNumberId}`
      );
      if (result.verified_name) {
        return { healthy: true, message: "WhatsApp Cloud API is reachable" };
      }
      return { healthy: false, message: "WhatsApp phone number not verified" };
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

  // ── Webhook Handling ───────────────────────────────────────────────

  /**
   * Verify webhook challenge from Meta.
   * Returns the challenge string if verified, null otherwise.
   */
  verifyWebhook(
    mode: string,
    token: string,
    challenge: string
  ): string | null {
    if (mode !== "subscribe") return null;
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(this.verifyToken);
    if (tokenBuf.length !== expectedBuf.length) return null;
    return crypto.timingSafeEqual(tokenBuf, expectedBuf) ? challenge : null;
  }

  /**
   * Handle incoming webhook event from WhatsApp Cloud API.
   * 若配置了 appSecret，则验证 X-Hub-Signature-256 签名（HMAC-SHA256 of rawBody）。
   * 如果 appSecret 未配置则跳过验证（向后兼容）。
   */
  async handleWebhook(body: unknown, headers?: Record<string, string>, rawBody?: string): Promise<void> {
    if (typeof body !== "object" || body === null) return;

    // 验证 Meta 签名（如果配置了 appSecret）
    if (this.appSecret && rawBody !== undefined) {
      const sigHeader = headers?.["x-hub-signature-256"];
      if (!sigHeader || !sigHeader.startsWith("sha256=")) {
        console.warn("[WhatsApp] Webhook rejected: missing or invalid X-Hub-Signature-256 header");
        return;
      }
      const expected = "sha256=" + crypto
        .createHmac("sha256", this.appSecret)
        .update(rawBody)
        .digest("hex");
      try {
        const expectedBuf = Buffer.from(expected);
        const sigBuf = Buffer.from(sigHeader);
        if (expectedBuf.length !== sigBuf.length || !crypto.timingSafeEqual(expectedBuf, sigBuf)) {
          console.warn("[WhatsApp] Webhook rejected: invalid X-Hub-Signature-256 signature");
          return;
        }
      } catch {
        console.warn("[WhatsApp] Webhook rejected: signature comparison failed");
        return;
      }
    }

    const payload = body as {
      object?: string;
      entry?: WhatsAppWebhookEntry[];
    };

    if (payload.object !== "whatsapp_business_account") return;

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (value.messaging_product !== "whatsapp") continue;

        // Handle incoming messages
        if (value.messages) {
          for (const msg of value.messages) {
            await this.processIncomingMessage(msg);
          }
        }

        // Handle status updates
        if (value.statuses) {
          for (const status of value.statuses) {
            if (status.status === "failed") {
              console.warn(
                `[WhatsApp] Message ${status.id} failed for ${status.recipient_id}`
              );
            }
          }
        }
      }
    }
  }

  // ── Message Processing ──────────────────────────────────────────────

  private async processIncomingMessage(
    msg: WhatsAppIncomingMessage
  ): Promise<void> {
    // Access control
    if (this.allowedNumbers.size > 0) {
      if (!this.allowedNumbers.has(msg.from)) return;
    }

    let text = "";
    if (msg.text) {
      text = msg.text.body;
    } else if (msg.button) {
      text = msg.button.text;
    } else if (msg.interactive) {
      const reply = msg.interactive.button_reply || msg.interactive.list_reply;
      text = reply?.title ?? "";
    }

    const channelMsg: ChannelMessage = {
      messageId: msg.id,
      channel: "whatsapp",
      from: msg.from,
      to: this.phoneNumberId,
      text,
      timestamp: new Date(parseInt(msg.timestamp, 10) * 1000).toISOString(),
      isDirect: true,
      isGroup: false,
      replyTo: msg.context?.id,
      attachments: this.extractAttachments(msg),
      raw: msg as unknown as Record<string, unknown>,
    };

    for (const handler of this.messageHandlers) {
      try {
        await handler(channelMsg);
      } catch (err) {
        console.error("[WhatsApp] Message handler error:", err);
      }
    }
  }

  private extractAttachments(
    msg: WhatsAppIncomingMessage
  ): ChannelMessage["attachments"] {
    const attachments: Array<{
      type: "image" | "video" | "audio" | "document" | "sticker";
      url?: string;
      data?: Buffer;
      mimeType?: string;
      filename?: string;
    }> = [];

    if (msg.image) {
      attachments.push({ type: "image", url: msg.image.id, mimeType: msg.image.mime_type });
    }
    if (msg.video) {
      attachments.push({ type: "video", url: msg.video.id, mimeType: msg.video.mime_type });
    }
    if (msg.audio) {
      attachments.push({ type: "audio", url: msg.audio.id, mimeType: msg.audio.mime_type });
    }
    if (msg.document) {
      attachments.push({ type: "document", url: msg.document.id, mimeType: msg.document.mime_type, filename: msg.document.filename });
    }
    if (msg.sticker) {
      attachments.push({ type: "sticker", url: msg.sticker.id, mimeType: msg.sticker.mime_type });
    }
    if (msg.location) {
      attachments.push({ type: "document", mimeType: "application/json", filename: "location.json" });
    }

    return attachments.length > 0 ? attachments : undefined;
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private async whatsappApi<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const baseURL = `https://graph.facebook.com/${this.apiVersion}`;
    const url = `${baseURL}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `WhatsApp API ${method} ${path}: HTTP ${response.status} - ${text.slice(0, 200)}`
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
      } catch {
        // swallow
      }
    }
  }
}