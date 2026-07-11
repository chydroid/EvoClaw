/**
 * Slack Channel Adapter — uses Slack Web API + Socket Mode via HTTP.
 *
 * Supports: text messages, threads, reactions, blocks/file attachments,
 * slash commands, interactive messages.
 *
 * Setup:
 *   1. Create a Slack app at https://api.slack.com/apps
 *   2. Set SLACK_BOT_TOKEN env var (Bot User OAuth Token)
 *   3. Enable Socket Mode or use Events API for production
 */

import { createHmac, timingSafeEqual } from "crypto";
import type {
  ChannelAdapter,
  ChannelHealthResult,
  ChannelMessage,
  ChannelSendResult,
  ChannelType,
} from "../channel-manager.js";

export interface SlackConfig {
  botToken: string;
  /** App-level token for Socket Mode (xapp-...) */
  appToken?: string;
  /** Signing secret for event verification */
  signingSecret?: string;
  /** Webhook mode (recommended) */
  webhookURL?: string;
  /** Allowed channel IDs (empty = all) */
  allowedChannels?: string[];
}

const SLACK_API = "https://slack.com/api";

interface SlackEventPayload {
  token?: string;
  team_id?: string;
  event?: SlackEvent;
  type?: string;
  challenge?: string;
}

interface SlackEvent {
  type: string;
  user?: string;
  channel?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  files?: Array<{
    id: string;
    name: string;
    url_private: string;
    mimetype: string;
  }>;
  subtype?: string;
  bot_id?: string;
}

export class SlackAdapter implements ChannelAdapter {
  readonly type: ChannelType = "slack";

  private token: string;
  private appToken?: string;
  private signingSecret?: string;
  private webhookURL?: string;
  private allowedChannels: Set<string>;

  private socketModeWS: WebSocket | null = null;
  private socketModeURL: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private botUserId: string | null = null;

  private messageHandlers: Array<(msg: ChannelMessage) => Promise<void>> = [];
  private statusHandlers: Array<
    (status: "connected" | "disconnected" | "reconnecting" | "error") => void
  > = [];
  private processedEvents = new Set<string>();
  private static MAX_PROCESSED_EVENTS = 1000;

  constructor(config: SlackConfig) {
    this.token = config.botToken;
    this.appToken = config.appToken;
    this.signingSecret = config.signingSecret;
    this.webhookURL = config.webhookURL;
    this.allowedChannels = new Set(config.allowedChannels ?? []);
  }

  async start(): Promise<void> {
    if (this.running) return;

    try {
      // Verify token + get bot info
      const auth = await this.api<{ ok: boolean; user_id: string; error?: string }>(
        "auth.test"
      );
      if (!auth.ok) {
        throw new Error(`Invalid token: ${auth.error}`);
      }

      this.botUserId = auth.user_id;
      console.log(`[Slack] Authenticated as user ${this.botUserId}`);

      this.running = true;

      if (this.webhookURL) {
        // Events API mode: set up webhook URL via Slack app config
        console.log(`[Slack] Using Events API at ${this.webhookURL}`);
        this.notifyStatus("connected");
      } else if (this.appToken) {
        await this.connectSocketMode();
      } else {
        console.log("[Slack] No Socket Mode or webhook — passive mode");
        this.notifyStatus("connected");
      }
    } catch (err) {
      this.notifyStatus("error");
      throw new Error(
        `Slack connection failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socketModeWS) {
      try {
        this.socketModeWS.close();
      } catch {
        // ignore
      }
      this.socketModeWS = null;
    }

    // 清理已处理事件去重集合，避免重启后误判重复消息
    this.processedEvents.clear();

    this.notifyStatus("disconnected");
    console.log("[Slack] Stopped");
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
        channel: target,
        text: text,
        unfurl_links: false,
        unfurl_media: false,
      };

      if (options?.replyTo) {
        body.thread_ts = options.replyTo;
      }

      const result = await this.api<{
        ok: boolean;
        ts?: string;
        channel?: string;
        error?: string;
        errors?: string[];
      }>("chat.postMessage", body);

      if (!result.ok) {
        return {
          success: false,
          error: result.error ?? "Failed to send message",
          channel: "slack",
        };
      }

      return {
        success: true,
        messageId: result.ts,
        channel: "slack",
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        channel: "slack",
      };
    }
  }

  async healthCheck(): Promise<ChannelHealthResult> {
    try {
      const result = await this.api<{ ok: boolean }>("auth.test");
      if (result.ok === true) {
        return { healthy: true, message: "Slack API is reachable" };
      }
      return { healthy: false, message: "Slack auth.test returned not ok" };
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

  /**
   * Handle event from Events API webhook.
   * 若配置了 signingSecret，则按 Slack 算法验证 X-Slack-Signature 签名
   * （HMAC-SHA256 of "v0:timestamp:body"），并检查时间戳防重放（超过5分钟拒绝）。
   * 如果 signingSecret 未配置则跳过验证（向后兼容）。
   */
  async handleEvent(
    body: SlackEventPayload,
    headers?: Record<string, string>,
    rawBody?: string,
  ): Promise<{ challenge?: string }> {
    // 签名验证
    if (this.signingSecret && headers && rawBody !== undefined) {
      const signature = headers["x-slack-signature"];
      const timestamp = headers["x-slack-request-timestamp"];
      if (!signature || !timestamp) {
        console.warn("[Slack] Webhook rejected: missing signature/timestamp headers");
        return {};
      }

      // 防重放：时间戳超过 5 分钟拒绝
      const tsNum = Number(timestamp);
      if (!Number.isFinite(tsNum)) {
        console.warn("[Slack] Webhook rejected: invalid timestamp");
        return {};
      }
      const ageSeconds = Math.abs(Date.now() / 1000 - tsNum);
      if (ageSeconds > 300) {
        console.warn(`[Slack] Webhook rejected: timestamp too old (${ageSeconds.toFixed(0)}s)`);
        return {};
      }

      const basestring = `v0:${timestamp}:${rawBody}`;
      const expected = "v0=" + createHmac("sha256", this.signingSecret).update(basestring).digest("hex");

      try {
        const expectedBuf = Buffer.from(expected);
        const sigBuf = Buffer.from(signature);
        if (expectedBuf.length !== sigBuf.length || !timingSafeEqual(expectedBuf, sigBuf)) {
          console.warn("[Slack] Webhook rejected: invalid signature");
          return {};
        }
      } catch {
        console.warn("[Slack] Webhook rejected: signature comparison failed");
        return {};
      }
    }

    // URL verification challenge
    if (body.type === "url_verification") {
      return { challenge: body.challenge };
    }

    const event = body.event;
    if (!event) return {};

    // Filter subtypes
    if (event.subtype === "bot_message" || event.bot_id) return {};

    if (event.type === "message" || event.type === "app_mention") {
      await this.processSlackEvent(event);
    }

    return {};
  }

  // ── Socket Mode ────────────────────────────────────────────────

  private async connectSocketMode(): Promise<void> {
    try {
      // Get Socket Mode URL
      const connResult = await this.api<{ ok: boolean; url: string; error?: string }>(
        "apps.connections.open"
      );

      if (!connResult.ok || !connResult.url) {
        throw new Error(`Socket Mode: ${connResult.error ?? "no URL returned"}`);
      }

      this.socketModeURL = connResult.url;

      const ws = new WebSocket(connResult.url);
      this.socketModeWS = ws;

      ws.onopen = () => {
        console.log("[Slack] Socket Mode connected");
        this.reconnectAttempts = 0;
        this.notifyStatus("connected");
      };

      ws.onmessage = (event) => {
        try {
          const raw = event.data as string;
          const data = JSON.parse(raw);

          if (data.type === "hello") {
            console.log("[Slack] Socket Mode hello received");
            return;
          }

          if (data.type === "disconnect") {
            console.log("[Slack] Socket Mode requested disconnect");
            this.closeSocket();
            this.reconnectWithBackoff();
            return;
          }

          if (data.payload?.event) {
            this.processSlackEvent(data.payload.event as SlackEvent).catch((err) => { process.stderr.write('[Slack] event processing failed: ' + err + '\n'); });
          }

          // Acknowledge envelope
          if (data.envelope_id) {
            ws.send(
              JSON.stringify({ envelope_id: data.envelope_id })
            );
          }
        } catch (err) {
          // ignore
          process.stderr.write('[Slack] ws.onmessage error: ' + err + '\n');
        }
      };

      ws.onclose = () => {
        this.socketModeWS = null;
        if (this.running) {
          this.reconnectWithBackoff();
        }
      };

      ws.onerror = () => {
        // onclose will fire
      };
    } catch (err) {
      console.error("[Slack] Socket Mode error:", err);
      if (this.running) {
        this.reconnectWithBackoff();
      }
    }
  }

  private reconnectWithBackoff(): void {
    if (!this.running) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.notifyStatus("error");
      console.error("[Slack] Max reconnect attempts reached");
      return;
    }

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 60000);
    this.reconnectAttempts++;
    console.log(
      `[Slack] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    // 存储定时器句柄，使 stop() 能够清除避免重连泄漏
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectSocketMode().catch((err) => {
        console.error("[Slack] Reconnect failed:", err);
        if (this.running) {
          this.reconnectWithBackoff();
        }
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private closeSocket(): void {
    if (this.socketModeWS) {
      try {
        this.socketModeWS.close();
      } catch {
        // ignore
      }
      this.socketModeWS = null;
    }
  }

  // ── Message Processing ──────────────────────────────────────────────

  private async processSlackEvent(event: SlackEvent): Promise<void> {
    if (!event.user || !event.channel || !event.text) return;
    if (event.user === this.botUserId) return;

    // 事件去重，防止 Socket Mode / Events API 重复投递
    const eventId = event.ts;
    if (eventId) {
      if (this.processedEvents.has(eventId)) return;
      this.processedEvents.add(eventId);
      if (this.processedEvents.size > SlackAdapter.MAX_PROCESSED_EVENTS) {
        const first = this.processedEvents.values().next().value;
        if (first !== undefined) this.processedEvents.delete(first);
      }
    }

    // Access control
    if (this.allowedChannels.size > 0) {
      if (!this.allowedChannels.has(event.channel)) return;
    }

    const isDirect = event.channel.startsWith("D");

    // 解析 Slack 时间戳（秒级浮点数）；ts="0" 会被 parseFloat 解析为 0 导致 epoch (1970-01-01)，需额外检查 > 0
    const tsNum = parseFloat(event.ts ?? "");
    const validTs = Number.isFinite(tsNum) && tsNum > 0;

    const channelMsg: ChannelMessage = {
      messageId: event.ts ?? String(Date.now()),
      channel: "slack",
      from: event.user,
      to: event.channel,
      text: event.text,
      timestamp: (validTs ? new Date(tsNum * 1000) : new Date()).toISOString(),
      isDirect,
      isGroup: !isDirect,
      groupId: !isDirect ? event.channel : undefined,
      replyTo: event.thread_ts,
      attachments: event.files?.map((f) => ({
        type:
          f.mimetype?.startsWith("image/")
            ? "image"
            : f.mimetype?.startsWith("video/")
              ? "video"
              : "document",
        url: f.url_private,
        mimeType: f.mimetype,
        filename: f.name,
      })),
      raw: event as unknown as Record<string, unknown>,
    };

    for (const handler of this.messageHandlers) {
      try {
        await handler(channelMsg);
      } catch (err) {
        console.error("[Slack] Message handler error:", err);
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private async api<T>(
    method: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${SLACK_API}/${method}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`Slack API ${method}: HTTP ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  private notifyStatus(
    status: "connected" | "disconnected" | "reconnecting" | "error"
  ): void {
    for (const handler of this.statusHandlers) {
      try {
        handler(status);
      } catch (err) {
        // swallow
        process.stderr.write('[Slack] statusHandler failed: ' + err + '\n');
      }
    }
  }
}