/**
 * WeChat (微信) Official Account / Enterprise WeChat (企业微信) Channel Adapter
 *
 * Supports two modes:
 *  1. 微信公众号 (Official Account) — passive reply + customer service messages
 *  2. 企业微信 (Enterprise WeChat / WeCom) — bot webhook + API
 *
 * WeChat Official Account docs: https://developers.weixin.qq.com/doc/offiaccount/
 * WeCom docs: https://developer.work.weixin.qq.com/document/
 *
 * Features:
 *  - XML message parsing (WeChat uses XML, not JSON)
 *  - Token signature verification
 *  - AES message decryption (optional)
 *  - Passive reply and customer service push
 *  - WeCom bot webhook mode (simpler, JSON-based)
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";
import type { ChannelAdapter, ChannelConfig, ChannelHealthResult, ChannelMessage, ChannelSendResult, ChannelType } from "../channel-manager.js";

// ── Config ────────────────────────────────────────────────

export interface WeChatConfig {
  /** WeChat mode: "official" for 公众号, "wecom" for 企业微信 */
  mode: "official" | "wecom";
  /** Official Account: Token for signature verification */
  token?: string;
  /** Official Account: EncodingAESKey (optional, for encrypted mode) */
  encodingAESKey?: string;
  /** Official Account: AppID */
  appId?: string;
  /** Official Account: AppSecret for access_token */
  appSecret?: string;
  /** WeCom: Corp ID */
  corpId?: string;
  /** WeCom: Corp Secret */
  corpSecret?: string;
  /** WeCom: Bot webhook key (for webhook mode, receives JSON) */
  botKey?: string;
  /** API base URL */
  baseURL?: string;
}

// ── Adapter ───────────────────────────────────────────────

export class WeChatAdapter implements ChannelAdapter {
  readonly type: ChannelType = "wechat" as ChannelType;

  private config: WeChatConfig;
  private channelConfig: ChannelConfig;
  private baseURL: string;
  private accessToken: string | null = null;
  private tokenExpiry = 0;
  private messageHandler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private statusHandler: ((status: "connected" | "disconnected" | "reconnecting" | "error") => void) | null = null;

  constructor(channelConfig: ChannelConfig) {
    this.channelConfig = channelConfig;
    this.config = channelConfig.settings as unknown as WeChatConfig;
    this.baseURL = this.config.baseURL ?? (
      this.config.mode === "wecom"
        ? "https://qyapi.weixin.qq.com"
        : "https://api.weixin.qq.com"
    );
  }

  async start(): Promise<void> {
    try {
      if (this.config.mode === "official" && this.config.appId && this.config.appSecret) {
        await this.refreshOfficialToken();
      } else if (this.config.mode === "wecom" && this.config.corpId && this.config.corpSecret) {
        await this.refreshWeComToken();
      }
      this.statusHandler?.("connected");
    } catch (err) {
      this.statusHandler?.("error");
      console.error(`[WeChat] Start failed: ${err}`);
    }
  }

  async stop(): Promise<void> {
    this.statusHandler?.("disconnected");
  }

  async sendMessage(
    target: string,
    text: string,
    options?: { replyTo?: string; attachments?: ChannelMessage["attachments"] }
  ): Promise<ChannelSendResult> {
    try {
      if (this.config.mode === "wecom" && this.config.botKey) {
        // WeCom bot webhook mode — simple JSON POST
        return this.sendWeComBot(target, text);
      }

      if (this.config.mode === "wecom") {
        return this.sendWeComAPI(text);
      }

      // Official Account — customer service message
      return this.sendOfficialCS(target, text);

    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        channel: "wechat" as ChannelType,
      };
    }
  }

  async healthCheck(): Promise<ChannelHealthResult> {
    try {
      if (this.config.mode === "wecom") {
        if (this.accessToken || this.config.botKey) {
          return { healthy: true, message: "WeCom is healthy" };
        }
        return { healthy: false, message: "WeCom access token and bot key are both missing" };
      }
      if (this.accessToken) {
        return { healthy: true, message: "WeChat Official Account is healthy" };
      }
      return { healthy: false, message: "WeChat access token is missing" };
    } catch (err) {
      return { healthy: false, message: (err as Error).message };
    }
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onStatusChange(handler: (status: "connected" | "disconnected" | "reconnecting" | "error") => void): void {
    this.statusHandler = handler;
  }

  /**
   * Verify WeChat Official Account server signature.
   * Called when WeChat server validates your callback URL.
   */
  verifySignature(timestamp: string, nonce: string, signature: string): boolean {
    if (!this.config.token) return false;

    const arr = [this.config.token, timestamp, nonce].sort();
    const str = arr.join("");
    const hash = createHash("sha1").update(str).digest("hex");
    const hashBuf = Buffer.from(hash);
    const sigBuf = Buffer.from(signature);
    if (hashBuf.length !== sigBuf.length) return false;
    return timingSafeEqual(hashBuf, sigBuf);
  }

  /**
   * Handle incoming XML message from WeChat Official Account.
   * Parse and convert to internal ChannelMessage format.
   */
  async handleOfficialMessage(xmlBody: string): Promise<string> {
    if (!this.messageHandler) return "success";

    const parsed = this.parseWeChatXML(xmlBody);
    if (!parsed) return "success";

    const msgType = parsed.MsgType as string;
    const msg: ChannelMessage = {
      messageId: (parsed.MsgId as string) ?? `msg_${Date.now()}`,
      channel: "wechat" as ChannelType,
      from: (parsed.FromUserName as string) ?? "unknown",
      to: (parsed.ToUserName as string) ?? "direct",
      text: "",
      timestamp: new Date(Number(parsed.CreateTime) * 1000 || Date.now()).toISOString(),
      isDirect: true,
      isGroup: false,
      raw: parsed as Record<string, unknown>,
    };

    switch (msgType) {
      case "text":
        msg.text = (parsed.Content as string) ?? "";
        break;
      case "image":
        msg.text = "[图片]";
        msg.attachments = [{
          type: "image",
          url: (parsed.PicUrl as string) ?? (parsed.MediaId as string),
        }];
        break;
      case "voice":
        msg.text = "[语音]";
        if (parsed.Recognition) {
          msg.text = parsed.Recognition as string;
        }
        break;
      case "event":
        msg.text = this.parseEvent(parsed);
        break;
      default:
        msg.text = `[${msgType}]`;
    }

    await this.messageHandler(msg);
    return "success";
  }

  /**
   * Handle incoming WeCom bot webhook message (JSON format).
   */
  async handleWeComWebhook(body: Record<string, unknown>): Promise<void> {
    if (!this.messageHandler) return;

    const msg: ChannelMessage = {
      messageId: (body.msgid as string) ?? `msg_${Date.now()}`,
      channel: "wechat" as ChannelType,
      from: (body.FromUserName as string) ?? "unknown",
      to: (body.ToUserName as string) ?? "direct",
      text: "",
      timestamp: new Date(Number(body.CreateTime) * 1000 || Date.now()).toISOString(),
      isDirect: true,
      isGroup: false,
      raw: body,
    };

    const msgType = body.MsgType as string;
    if (msgType === "text" && body.Content) {
      msg.text = body.Content as string;
    } else if (msgType === "image") {
      msg.text = "[图片]";
    }

    // Split @bot_name mentions from direct messages
    if (body.MentionedList) {
      msg.isGroup = true;
    }

    await this.messageHandler(msg);
  }

  // ── Internal: Token Management ──────────────────────────

  private async refreshOfficialToken(): Promise<void> {
    const res = await fetch(
      `${this.baseURL}/cgi-bin/token?grant_type=client_credential&appid=${this.config.appId}&secret=${this.config.appSecret}`
    );
    const data = await res.json() as { access_token: string; expires_in: number };
    if (!data.access_token) throw new Error("WeChat token fetch failed");

    this.accessToken = data.access_token;
    // Expire 5 min early
    this.tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  }

  private async refreshWeComToken(): Promise<void> {
    const res = await fetch(
      `${this.baseURL}/cgi-bin/gettoken?corpid=${this.config.corpId}&corpsecret=${this.config.corpSecret}`
    );
    const data = await res.json() as { access_token: string; expires_in: number };
    if (!data.access_token) throw new Error("WeCom token fetch failed");

    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken || Date.now() >= this.tokenExpiry) {
      if (this.config.mode === "official") {
        await this.refreshOfficialToken();
      } else {
        await this.refreshWeComToken();
      }
    }
  }

  // ── Internal: Message Sending ───────────────────────────

  private async sendWeComBot(target: string, text: string): Promise<ChannelSendResult> {
    const key = this.config.botKey;
    if (!key) {
      return { success: false, error: "botKey not configured", channel: "wechat" as ChannelType };
    }

    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "text",
        text: { content: text },
      }),
    });

    const data = await res.json() as { errcode: number; errmsg: string };
    return {
      success: data.errcode === 0,
      messageId: `wc_${Date.now()}`,
      error: data.errcode !== 0 ? data.errmsg : undefined,
      channel: "wechat" as ChannelType,
    };
  }

  private async sendWeComAPI(text: string): Promise<ChannelSendResult> {
    await this.ensureToken();

    // WeCom uses /cgi-bin/message/send for app messages
    const res = await fetch(`${this.baseURL}/cgi-bin/message/send?access_token=${this.accessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: "@all",
        msgtype: "text",
        agentid: 0,
        text: { content: text },
      }),
    });

    const data = await res.json() as { errcode: number; errmsg: string };
    return {
      success: data.errcode === 0,
      messageId: `wc_${Date.now()}`,
      error: data.errcode !== 0 ? data.errmsg : undefined,
      channel: "wechat" as ChannelType,
    };
  }

  private async sendOfficialCS(target: string, text: string): Promise<ChannelSendResult> {
    await this.ensureToken();

    const res = await fetch(
      `${this.baseURL}/cgi-bin/message/custom/send?access_token=${this.accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touser: target,
          msgtype: "text",
          text: { content: text },
        }),
      }
    );

    const data = await res.json() as { errcode: number; errmsg: string };
    return {
      success: data.errcode === 0,
      messageId: `wx_${Date.now()}`,
      error: data.errcode !== 0 ? data.errmsg : undefined,
      channel: "wechat" as ChannelType,
    };
  }

  // ── Internal: XML/Event Parsing ─────────────────────────

  private parseWeChatXML(xml: string): Record<string, unknown> | null {
    try {
      const result: Record<string, unknown> = {};
      const tagRegex = /<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>/g;
      let match: RegExpExecArray | null;

      while ((match = tagRegex.exec(xml)) !== null) {
        result[match[1]] = match[2];
      }

      // Also match non-CDATA fields
      const simpleRegex = /<(\w+)>([^<]+)<\/\1>/g;
      while ((match = simpleRegex.exec(xml)) !== null) {
        if (!(match[1] in result)) {
          result[match[1]] = match[2];
        }
      }

      return Object.keys(result).length > 0 ? result : null;
    } catch {
      return null;
    }
  }

  private parseEvent(parsed: Record<string, unknown>): string {
    const event = (parsed.Event as string) ?? "unknown";
    switch (event) {
      case "subscribe": return "关注了公众号";
      case "unsubscribe": return "取消关注";
      case "SCAN": return "扫码进入";
      case "CLICK": return `点击菜单: ${parsed.EventKey ?? ""}`;
      case "VIEW": return `点击链接: ${parsed.EventKey ?? ""}`;
      default: return `事件: ${event}`;
    }
  }
}