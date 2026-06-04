/**
 * DingTalk (钉钉) Channel Adapter
 *
 * Uses DingTalk Open API with webhook event subscription.
 *
 * DingTalk documentation: https://open.dingtalk.com/document/
 *
 * Features:
 *  - IM message receiving via Event Subscription (webhook)
 *  - Message sending via work notification & robot API
 *  - Access token auto-refresh (7200s, refresh 5min early)
 *  - Challenge verification (URL validation)
 *  - AES-256-CBC decryption for encrypted events
 *  - Group chat / direct chat distinction
 */

import crypto from "node:crypto";
import type { ChannelAdapter, ChannelConfig, ChannelMessage, ChannelSendResult, ChannelType } from "../channel-manager.js";

// ── Config ────────────────────────────────────────────────

export interface DingtalkConfig {
  /** DingTalk App Key (clientId) */
  appKey: string;
  /** DingTalk App Secret (clientSecret) */
  appSecret: string;
  /** Agent ID for work notification messages */
  agentId: string;
  /** Verification token for event subscription */
  verificationToken?: string;
  /** AES key for event subscription encryption (EncryptKey) */
  aesKey?: string;
  /** Webhook path for receiving events */
  webhookPath?: string;
  /** API endpoint (default: https://oapi.dingtalk.com) */
  baseURL?: string;
}

// ── Adapter ───────────────────────────────────────────────

export class DingtalkAdapter implements ChannelAdapter {
  readonly type: ChannelType = "dingtalk" as ChannelType;

  private config: DingtalkConfig;
  private channelConfig: ChannelConfig;
  private baseURL: string;
  private accessToken: string | null = null;
  private tokenExpiry = 0;
  private messageHandler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private statusHandler: ((status: "connected" | "disconnected" | "reconnecting" | "error") => void) | null = null;

  constructor(channelConfig: ChannelConfig) {
    this.channelConfig = channelConfig;
    this.config = channelConfig.settings as unknown as DingtalkConfig;
    this.baseURL = this.config.baseURL ?? "https://oapi.dingtalk.com";
  }

  async start(): Promise<void> {
    if (!this.config.appKey || !this.config.appSecret) {
      this.statusHandler?.("error");
      return;
    }

    try {
      await this.refreshToken();
      this.statusHandler?.("connected");
    } catch (err) {
      this.statusHandler?.("error");
      console.error(`[DingTalk] Start failed: ${err}`);
    }
  }

  async stop(): Promise<void> {
    this.accessToken = null;
    this.tokenExpiry = 0;
    this.statusHandler?.("disconnected");
  }

  async sendMessage(
    target: string,
    text: string,
    options?: { replyTo?: string; attachments?: ChannelMessage["attachments"] }
  ): Promise<ChannelSendResult> {
    try {
      await this.ensureToken();

      // Try robot message first (for group/single chat via robot)
      const robotResult = await this.sendRobotMessage(target, text, options);
      if (robotResult !== null) {
        return robotResult;
      }

      // Fallback to work notification
      return await this.sendWorkNotification(target, text, options);
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        channel: "dingtalk" as ChannelType,
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
   * Handle incoming webhook event from DingTalk Event Subscription.
   * Call this from your HTTP server's webhook route.
   */
  async handleWebhookEvent(
    body: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<{ challenge?: string }> {
    // URL verification challenge
    if (body.type === "url_verification" && body.challenge) {
      return { challenge: body.challenge as string };
    }

    // Handle encrypted event
    let eventData = body;
    if (body.encrypt && this.config.aesKey && this.config.verificationToken) {
      try {
        const decrypted = this.decryptEvent(body.encrypt as string);
        eventData = JSON.parse(decrypted);
      } catch (err) {
        console.error(`[DingTalk] Failed to decrypt event: ${err}`);
        return {};
      }
    }

    // Validate signature if verificationToken is provided
    if (this.config.verificationToken && headers) {
      const timestamp = headers["timestamp"] ?? "";
      const sign = headers["sign"] ?? "";
      if (!this.verifySignature(timestamp, sign)) {
        console.error("[DingTalk] Invalid signature");
        return {};
      }
    }

    // Handle message events
    const eventType = eventData.eventType ?? (eventData.header as Record<string, unknown>)?.event_type;
    if (eventType === "im.message.receive_v1") {
      await this.processEvent(eventData as unknown as DingtalkMessageEvent);
    }

    return {};
  }

  // ── Internal: Token Management ──────────────────────────

  private async refreshToken(): Promise<void> {
    const res = await fetch(
      `${this.baseURL}/gettoken?appkey=${encodeURIComponent(this.config.appKey)}&appsecret=${encodeURIComponent(this.config.appSecret)}`,
      { method: "POST" },
    );

    const data = await res.json() as {
      errcode: number;
      errmsg: string;
      access_token: string;
      expires_in: number;
    };

    if (data.errcode !== 0) {
      throw new Error(`DingTalk auth failed [${data.errcode}]: ${data.errmsg}`);
    }

    this.accessToken = data.access_token;
    // Refresh 5 minutes early (7200s - 300s = 6900s)
    this.tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken || Date.now() >= this.tokenExpiry) {
      await this.refreshToken();
    }
  }

  // ── Internal: Message Sending ───────────────────────────

  /**
   * Send work notification message (requires agentId + userId).
   * Target should be a DingTalk userId.
   */
  private async sendWorkNotification(
    target: string,
    text: string,
    options?: { replyTo?: string; attachments?: ChannelMessage["attachments"] },
  ): Promise<ChannelSendResult> {
    const msgBody: Record<string, unknown> = {
      agent_id: this.config.agentId,
      userid_list: target,
      msg: this.buildMessageContent(text),
    };

    if (options?.replyTo) {
      msgBody.task_id = options.replyTo;
    }

    const res = await fetch(`${this.baseURL}/topapi/message/corpconversation/asyncsend_v2`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": this.accessToken!,
      },
      body: JSON.stringify(msgBody),
    });

    const data = await res.json() as {
      errcode: number;
      errmsg: string;
      task_id?: number;
    };

    if (data.errcode === 0) {
      return {
        success: true,
        messageId: data.task_id?.toString(),
        channel: "dingtalk" as ChannelType,
      };
    }

    return {
      success: false,
      error: `DingTalk work notification error [${data.errcode}]: ${data.errmsg}`,
      channel: "dingtalk" as ChannelType,
    };
  }

  /**
   * Send robot message (for group/single chat via robot).
   * Target should be a conversationId or userId list.
   * Returns null if the target format doesn't match robot API expectations.
   */
  private async sendRobotMessage(
    target: string,
    text: string,
    options?: { replyTo?: string; attachments?: ChannelMessage["attachments"] },
  ): Promise<ChannelSendResult | null> {
    // Robot API uses a different base URL (api.dingtalk.com vs oapi.dingtalk.com)
    const robotBaseURL = this.baseURL.replace("oapi.dingtalk.com", "api.dingtalk.com");

    const msgContent = this.buildMessageContent(text);
    const msgKey = Object.keys(msgContent)[0]; // "text" or "markdown"

    const body: Record<string, unknown> = {
      msgKey: msgKey === "markdown" ? "sampleMarkdown" : "sampleText",
      msgParam: JSON.stringify(msgContent[msgKey]),
    };

    // Determine if target is a conversationId (starts with "cid") or userId
    if (target.startsWith("cid")) {
      // Group chat via robot
      body.conversationId = target;
    } else {
      // Single chat via robot — need robotCode and userIds
      body.robotCode = this.config.appKey;
      body.userIds = [target];
    }

    if (options?.replyTo) {
      body.quoteMessageId = options.replyTo;
    }

    try {
      const res = await fetch(`${robotBaseURL}/v1.0/robot/oToMessages/batchSend`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": this.accessToken!,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json() as {
        code?: string;
        message?: string;
        body?: Record<string, unknown>;
      };

      // DingTalk new API returns 200 with empty body on success
      if (!data.code || data.code === "0") {
        return {
          success: true,
          channel: "dingtalk" as ChannelType,
        };
      }

      return {
        success: false,
        error: `DingTalk robot message error [${data.code}]: ${data.message}`,
        channel: "dingtalk" as ChannelType,
      };
    } catch {
      // Robot API not available, fallback to work notification
      return null;
    }
  }

  /**
   * Build message content object for DingTalk APIs.
   * Supports text and markdown message types.
   */
  private buildMessageContent(text: string): Record<string, unknown> {
    // Check if text looks like markdown content
    if (text.includes("**") || text.includes("##") || text.includes("- ") || text.includes("1. ")) {
      return {
        markdown: {
          title: text.split("\n")[0]?.replace(/[#*]/g, "").trim().slice(0, 50) || "Message",
          text,
        },
      };
    }

    return {
      text: {
        content: text,
      },
    };
  }

  // ── Internal: Event Processing ──────────────────────────

  private async processEvent(event: DingtalkMessageEvent): Promise<void> {
    if (!this.messageHandler) return;

    const msgBody = event.message;
    if (!msgBody) return;

    const content = this.parseContent(msgBody.messageType ?? msgBody.msgtype ?? "text", msgBody.content ?? msgBody.text ?? "");

    const isGroup = msgBody.conversationType === "2" || msgBody.conversationType === 2 || msgBody.chatType === "group";
    const senderId = event.sender?.senderId ?? event.sender?.staffId ?? "unknown";

    const msg: ChannelMessage = {
      messageId: msgBody.messageId ?? `msg_${Date.now()}`,
      channel: "dingtalk" as ChannelType,
      from: senderId,
      to: isGroup ? (msgBody.conversationId ?? "group") : "direct",
      text: content.text,
      timestamp: msgBody.createAt ? new Date(Number(msgBody.createAt)).toISOString() : new Date().toISOString(),
      isDirect: !isGroup,
      isGroup,
      groupId: isGroup ? msgBody.conversationId : undefined,
      attachments: content.attachments,
      raw: event as unknown as Record<string, unknown>,
    };

    await this.messageHandler(msg);
  }

  private parseContent(msgType: string, contentStr: string): {
    text: string;
    attachments?: ChannelMessage["attachments"];
  } {
    try {
      const parsed = JSON.parse(contentStr);
      const attachments: ChannelMessage["attachments"] = [];

      if (msgType === "text") {
        return {
          text: parsed.content ?? parsed.text ?? contentStr,
          attachments: attachments.length > 0 ? attachments : undefined,
        };
      }

      if (msgType === "markdown") {
        return {
          text: parsed.text ?? parsed.content ?? contentStr,
          attachments: attachments.length > 0 ? attachments : undefined,
        };
      }

      if (msgType === "picture" || msgType === "image") {
        attachments.push({
          type: "image",
          url: parsed.downloadCode ?? parsed.picURL ?? parsed.imageUrl,
        });
        return {
          text: "",
          attachments,
        };
      }

      if (msgType === "file") {
        attachments.push({
          type: "document",
          url: parsed.downloadCode ?? parsed.fileCode,
          filename: parsed.fileName,
        });
        return {
          text: "",
          attachments,
        };
      }

      if (msgType === "audio" || msgType === "voice") {
        attachments.push({
          type: "audio",
          url: parsed.downloadCode,
        });
        return {
          text: "",
          attachments,
        };
      }

      if (msgType === "video") {
        attachments.push({
          type: "video",
          url: parsed.downloadCode ?? parsed.videoUrl,
        });
        return {
          text: "",
          attachments,
        };
      }

      // Fallback: try to extract text
      return {
        text: parsed.content ?? parsed.text ?? contentStr,
        attachments: attachments.length > 0 ? attachments : undefined,
      };
    } catch {
      return { text: contentStr };
    }
  }

  // ── Internal: Encryption ────────────────────────────────

  /**
   * Decrypt DingTalk encrypted event data.
   * Uses AES-256-CBC with aesKey (Base64 decoded) and verificationToken as key/IV.
   */
  private decryptEvent(encrypt: string): string {
    if (!this.config.aesKey || !this.config.verificationToken) {
      throw new Error("aesKey and verificationToken are required for decryption");
    }

    // Decode the aesKey from Base64 to get the AES key (32 bytes)
    const key = Buffer.from(this.config.aesKey, "base64");
    // IV is the first 16 bytes of the key
    const iv = key.subarray(0, 16);

    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    decipher.setAutoPadding(true);

    const encrypted = Buffer.from(encrypt, "base64");
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    // DingTalk encrypts as: random(16) + msgLen(4) + msg + verificationToken
    // Skip the 16-byte random prefix and 4-byte length
    const msgLen = decrypted.readUInt32BE(16);
    const msg = decrypted.subarray(20, 20 + msgLen).toString("utf8");
    const receivedToken = decrypted.subarray(20 + msgLen).toString("utf8");

    // Validate the token suffix
    if (receivedToken !== this.config.verificationToken) {
      throw new Error("Verification token mismatch in decrypted event");
    }

    return msg;
  }

  /**
   * Verify DingTalk webhook signature.
   * Signature = HmacSHA256(timestamp + "\n" + verificationToken, aesKey)
   */
  private verifySignature(timestamp: string, sign: string): boolean {
    if (!this.config.aesKey || !this.config.verificationToken) {
      return true; // Skip verification if not configured
    }

    const stringToSign = `${timestamp}\n${this.config.verificationToken}`;
    const key = Buffer.from(this.config.aesKey, "base64");
    const hmac = crypto.createHmac("sha256", key);
    hmac.update(stringToSign);
    const expectedSign = hmac.digest("base64");

    return sign === expectedSign;
  }
}

// ── Internal Types ────────────────────────────────────────

interface DingtalkMessageRecord {
  messageId?: string;
  conversationId?: string;
  conversationType?: string | number;
  chatType?: string;
  createAt?: string;
  senderId?: string;
  content?: string;
  text?: string;
  msgtype?: string;
  messageType?: string;
}

interface DingtalkMessageEvent {
  sender?: {
    senderId?: string;
    staffId?: string;
    corpId?: string;
  };
  message?: {
    messageId?: string;
    conversationId?: string;
    conversationType?: string | number;
    chatType?: string;
    createAt?: string;
    content?: string;
    text?: string;
    msgtype?: string;
    messageType?: string;
  };
}
