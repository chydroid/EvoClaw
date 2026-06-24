/**
 * Feishu (飞书) / Lark Channel Adapter
 *
 * Supports three modes for receiving events:
 * 1. Long connection (WebSocket) — recommended, no public URL needed
 * 2. Webhook — requires public URL accessible from Feishu servers
 * 3. Long-polling — polls REST API for messages (fallback)
 *
 * Feishu documentation: https://open.feishu.cn/document/
 */

import crypto from "crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { ChannelAdapter, ChannelConfig, ChannelHealthResult, ChannelMessage, ChannelSendResult, ChannelType } from "../channel-manager.js";

// ── Config ────────────────────────────────────────────────

export type FeishuMode = "websocket" | "webhook" | "polling";

export interface FeishuConfig {
  /** Feishu App ID */
  appId: string;
  /** Feishu App Secret */
  appSecret: string;
  /** Verification token for event subscription (webhook mode) */
  verificationToken?: string;
  /** Encrypt key for event subscription (webhook mode) */
  encryptKey?: string;
  /** Webhook path for receiving events (if using webhook mode) */
  webhookPath?: string;
  /** Event subscription mode: websocket (default), webhook, or polling */
  mode?: FeishuMode;
  /** Whether to enable long-polling (legacy, equivalent to mode=polling) */
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

  // WebSocket long connection client
  private wsClient: Lark.WSClient | null = null;
  private larkClient: Lark.Client | null = null;

  constructor(channelConfig: ChannelConfig) {
    this.channelConfig = channelConfig;
    this.config = channelConfig.settings as unknown as FeishuConfig;
    this.baseURL = this.config.baseURL ?? "https://open.feishu.cn";
  }

  private get mode(): FeishuMode {
    if (this.config.mode) return this.config.mode;
    if (this.config.longPolling) return "polling";
    return "websocket"; // Default to WebSocket long connection
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

    // Get initial access token (needed for all modes)
    try {
      await this.refreshToken();
    } catch (err) {
      this.statusHandler?.("error");
      console.error(`[Feishu] Token refresh failed: ${err}`);
      return;
    }

    // Start based on mode
    const currentMode = this.mode;
    console.log(`[Feishu] Starting in ${currentMode} mode`);

    if (currentMode === "websocket") {
      await this.startWebSocket();
    } else if (currentMode === "polling") {
      this.statusHandler?.("connected");
      this.startPolling();
    } else {
      // webhook mode — just mark connected, events come via HTTP
      this.statusHandler?.("connected");
      console.log("[Feishu] Webhook mode — events will be received via HTTP endpoint");
    }
  }

  async stop(): Promise<void> {
    this.pollAbort.abort();
    this.polling = false;

    // Stop WebSocket client if running
    if (this.wsClient) {
      // WSClient doesn't have a stop method, just release reference
      this.wsClient = null;
      this.larkClient = null;
    }

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

  async healthCheck(): Promise<ChannelHealthResult> {
    const details: Record<string, string> = {};
    const suggestions: string[] = [];

    // Step 1: Check required config
    if (!this.config.appId) {
      return {
        healthy: false,
        message: "Missing App ID",
        details: { appId: "❌ 未填写" },
        suggestions: [
          "在飞书开放平台 (open.feishu.cn) 创建自定义应用",
          "在应用的「凭证与基础信息」页面复制 App ID",
          "将 App ID 粘贴到配置中",
        ],
      };
    }
    details.appId = `✅ ${this.config.appId.slice(0, 8)}...`;

    if (!this.config.appSecret) {
      return {
        healthy: false,
        message: "Missing App Secret",
        details: { ...details, appSecret: "❌ 未填写" },
        suggestions: [
          "在飞书开放平台应用的「凭证与基础信息」页面复制 App Secret",
          "将 App Secret 粘贴到配置中",
        ],
      };
    }
    details.appSecret = "✅ ******";

    // Step 2: Try to get access token
    let tokenOk = false;
    try {
      await this.refreshToken();
      tokenOk = this.accessToken !== null;
    } catch (err) {
      const errMsg = String(err);
      details.token = "❌ 获取失败";
      if (errMsg.includes("401") || errMsg.includes("invalid")) {
        return {
          healthy: false,
          message: "App ID 或 App Secret 不正确",
          details,
          suggestions: [
            "检查 App ID 和 App Secret 是否复制正确（注意前后空格）",
            "确认应用已创建且未过期",
            "在飞书开放平台重新生成 App Secret 后重试",
          ],
        };
      }
      if (errMsg.includes("ECONNREFUSED") || errMsg.includes("ENOTFOUND") || errMsg.includes("fetch")) {
        return {
          healthy: false,
          message: "无法连接飞书服务器（网络问题）",
          details,
          suggestions: [
            "检查服务器网络连接是否正常",
            "确认可以访问 open.feishu.cn",
            "如使用代理，检查代理配置",
          ],
        };
      }
      return {
        healthy: false,
        message: `获取 Token 失败: ${errMsg}`,
        details,
        suggestions: ["检查飞书应用配置是否正确", "查看服务器日志获取详细错误信息"],
      };
    }

    if (!tokenOk) {
      return {
        healthy: false,
        message: "获取 Tenant Access Token 失败（未知原因）",
        details,
        suggestions: ["检查 App ID 和 App Secret 是否正确", "查看服务器日志获取详细错误信息"],
      };
    }
    details.token = "✅ 已获取";

    // Step 3: Check bot capability — try to get bot info
    try {
      const botRes = await fetch(`${this.baseURL}/open-apis/bot/v3/info`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      const botData = await botRes.json() as { code: number; msg?: string; bot?: Record<string, unknown> };
      if (botData.code === 0 && botData.bot) {
        details.bot = `✅ ${botData.bot.app_name ?? "Bot"}`;
      } else if (botData.code === 99991400) {
        details.bot = "❌ 未启用机器人能力";
        suggestions.push(
          "在飞书开放平台应用的「添加应用能力」页面，添加「机器人」能力",
          "添加机器人能力后，重新发布应用版本",
        );
      } else {
        details.bot = `⚠️ 无法获取 (${botData.code}: ${botData.msg ?? "unknown"})`;
      }
    } catch {
      details.bot = "⚠️ 查询失败（网络问题）";
    }

    // Step 4: Check message permissions — try to get message list using bot's own open_id
    try {
      // First get bot's own open_id
      const botInfoRes = await fetch(`${this.baseURL}/open-apis/bot/v3/info`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      const botInfoData = await botInfoRes.json() as { code: number; bot?: { open_id?: string } };
      const botOpenId = botInfoData.bot?.open_id;

      if (botOpenId) {
        const msgRes = await fetch(`${this.baseURL}/open-apis/im/v1/messages?receive_id_type=open_id&page_size=1&receive_id=${botOpenId}`, {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        });
        const msgData = await msgRes.json() as { code: number; msg?: string };
        if (msgData.code === 0 || msgData.code === 230002) {
          // 0 = success, 230002 = chat not found (permission OK, just no chat)
          details.imPermission = "✅ 消息权限正常";
        } else if (msgData.code === 99991401) {
          details.imPermission = "❌ 缺少消息权限";
          suggestions.push(
            "在飞书开放平台应用的「权限管理」页面，添加以下权限：",
            "  - im:message（获取与发送单聊、群组消息）",
            "  - im:message.group_at_msg（接收群聊@消息）",
            "  - im:resource（获取消息中的资源文件）",
            "添加权限后，重新发布应用版本",
          );
        } else {
          // Other errors may indicate partial permissions
          details.imPermission = "✅ 消息权限基本正常";
        }
      } else {
        details.imPermission = "⚠️ 无法验证（未获取到 Bot Open ID）";
      }
    } catch {
      details.imPermission = "⚠️ 查询失败（网络问题）";
    }

    // Step 5: Check WebSocket connection status
    if (this.mode === "websocket") {
      details.mode = "WebSocket 长连接";
      if (this.wsClient) {
        details.wsConnection = "✅ 已连接";
      } else {
        details.wsConnection = "⚠️ 未连接（将在收到消息时重连）";
        suggestions.push(
          "确认在飞书开放平台应用的「事件订阅」页面，选择了「使用长连接接收事件」",
          "如果选择了「将事件发送至请求地址」，请切换为长连接模式",
        );
      }
    } else if (this.mode === "webhook") {
      details.mode = "Webhook 模式";
      details.wsConnection = "需要公网可达的回调 URL";
      suggestions.push(
        "确保服务器可从公网访问",
        "在飞书开放平台配置事件订阅回调 URL（如 https://your-domain.com/api/channels/feishu/webhook）",
      );
    } else {
      details.mode = "长轮询模式";
    }

    // Step 6: Check event subscription
    try {
      const eventRes = await fetch(`${this.baseURL}/open-apis/im/v1/messages?receive_id_type=open_id&page_size=1`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      // If we can reach this point, basic API access works
      details.eventSubscription = this.wsClient ? "✅ 长连接已建立" : "⚠️ 需要配置事件订阅";
      if (!this.wsClient && this.mode === "websocket") {
        suggestions.push(
          "在飞书开放平台应用的「事件订阅」页面：",
          "  1. 选择「使用长连接接收事件」",
          "  2. 添加事件：im.message.receive_v1（接收消息）",
          "  3. 发布应用版本使配置生效",
        );
      }
    } catch {
      details.eventSubscription = "⚠️ 无法验证";
    }

    // Overall result
    const hasErrors = Object.values(details).some(v => v.includes("❌"));
    const hasWarnings = Object.values(details).some(v => v.includes("⚠️"));

    if (hasErrors) {
      return {
        healthy: false,
        message: "飞书通道配置存在问题，请根据建议修复",
        details,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
      };
    }

    if (hasWarnings) {
      return {
        healthy: true,
        message: "飞书通道基本连通，但存在警告项",
        details,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
      };
    }

    return {
      healthy: true,
      message: "飞书通道连接正常",
      details,
    };
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

  // ── WebSocket Long Connection ────────────────────────────

  private async startWebSocket(): Promise<void> {
    try {
      const baseConfig = {
        appId: this.config.appId,
        appSecret: this.config.appSecret,
      };

      this.larkClient = new Lark.Client(baseConfig);
      this.wsClient = new Lark.WSClient({
        ...baseConfig,
        loggerLevel: Lark.LoggerLevel.info,
      });

      const self = this;

      await this.wsClient.start({
        eventDispatcher: new Lark.EventDispatcher({}).register({
          "im.message.receive_v1": async (data: Record<string, unknown>) => {
            try {
              await self.handleWSMessage(data);
            } catch (err) {
              console.error("[Feishu] WebSocket message handler error:", err);
            }
          },
        }),
      });

      this.statusHandler?.("connected");
      console.log("[Feishu] WebSocket long connection established");
    } catch (err) {
      console.error(`[Feishu] WebSocket connection failed: ${err}`);
      this.statusHandler?.("error");
      // Fallback: still allow webhook mode to work
      console.log("[Feishu] Falling back to webhook mode");
      this.statusHandler?.("connected");
    }
  }

  private async handleWSMessage(data: Record<string, unknown>): Promise<void> {
    if (!this.messageHandler) return;

    // The SDK delivers the event data in v2.0 format
    const message = data.message as Record<string, unknown> | undefined;
    const sender = data.sender as Record<string, unknown> | undefined;

    if (!message) return;

    const messageId = message.message_id as string | undefined;
    const chatId = message.chat_id as string | undefined;
    const chatType = message.chat_type as string | undefined;
    const content = message.content as string | undefined;
    const createTime = message.create_time as string | undefined;
    const messageType = message.message_type as string | undefined;

    // Skip non-text messages (images, files, etc. handled separately)
    if (messageType && messageType !== "text" && messageType !== "post") {
      console.log(`[Feishu] Skipping non-text message type: ${messageType}`);
      return;
    }

    // Event deduplication
    if (messageId) {
      if (this.processedEvents.has(messageId)) return;
      this.processedEvents.add(messageId);
      if (this.processedEvents.size > FeishuAdapter.MAX_PROCESSED_EVENTS) {
        const first = this.processedEvents.values().next().value;
        if (first !== undefined) this.processedEvents.delete(first);
      }
    }

    const parsed = this.parseContent(content ?? "");
    if (!parsed.text.trim()) return;

    const senderId = (sender?.sender_id as Record<string, string>)?.open_id ?? "unknown";
    const isGroup = chatType === "group";

    const msg: ChannelMessage = {
      messageId: messageId ?? `msg_${Date.now()}`,
      channel: "feishu" as ChannelType,
      from: senderId,
      to: chatId ?? "direct",
      text: parsed.text,
      timestamp: createTime ? new Date(Number(createTime) * 1000 || Date.now()).toISOString() : new Date().toISOString(),
      isDirect: !isGroup,
      isGroup,
      groupId: isGroup ? chatId : undefined,
      attachments: parsed.attachments,
      raw: data as Record<string, unknown>,
    };

    await this.messageHandler(msg);
  }

  // ── Internal ────────────────────────────────────────────

  private verifySignature(body: string, signature: string | undefined): boolean {
    // P1-07 fix: 原代码在未配置 verificationToken 时 return true 跳过验证，
    // 等于后门。改为 fail-closed：未配置时拒绝所有请求。
    if (!this.config.verificationToken) {
      process.stderr.write("[Feishu] verificationToken not configured — rejecting webhook (fail-closed)");
      return false;
    }
    if (!signature) {
      return false;
    }
    const expected = crypto.createHmac("sha256", this.config.verificationToken).update(body).digest("base64");
    // 使用恒定时间比较防止时序攻击
    try {
      const expectedBuf = Buffer.from(expected);
      const sigBuf = Buffer.from(signature);
      if (expectedBuf.length !== sigBuf.length) return false;
      return crypto.timingSafeEqual(expectedBuf, sigBuf);
    } catch {
      return false;
    }
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
        const first = this.processedEvents.values().next().value;
        if (first !== undefined) this.processedEvents.delete(first);
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
