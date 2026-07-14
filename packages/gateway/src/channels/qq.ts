/**
 * QQ Bot Channel Adapter
 *
 * Uses QQ Official Bot API (QQ 开放平台).
 *
 * QQ Bot docs: https://bot.q.qq.com/wiki/
 *
 * Features:
 *  - WebSocket gateway connection (WSS)
 *  - Group and C2C (private) messages
 *  - AT message parsing (@bot)
 *  - Heartbeat keep-alive
 *  - Rich media (images/attachments)
 *  - Auto-reconnect with exponential backoff
 */

import type { ChannelAdapter, ChannelConfig, ChannelHealthResult, ChannelMessage, ChannelSendResult, ChannelType } from "../channel-manager.js";
import * as crypto from "crypto";

function random01(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000;
}

// ── Config ────────────────────────────────────────────────

export interface QQConfig {
  /** QQ Bot AppID */
  appId: string;
  /** QQ Bot Token */
  token: string;
  /** QQ Bot Secret (for generating signatures) */
  secret?: string;
  /** Whether it's a sandbox bot */
  sandbox?: boolean;
  /** API base URL */
  baseURL?: string;
}

// ── QQ WebSocket Op Codes ─────────────────────────────────

const QQ_OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

// ── Adapter ───────────────────────────────────────────────

export class QQAdapter implements ChannelAdapter {
  readonly type: ChannelType = "qq" as ChannelType;

  private config: QQConfig;
  private channelConfig: ChannelConfig;
  private baseURL: string;
  private wsURL: string;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private seqNumber = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private maxReconnectAttempts = 10;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private invalidSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private messageHandler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private statusHandler: ((status: "connected" | "disconnected" | "reconnecting" | "error") => void) | null = null;

  constructor(channelConfig: ChannelConfig) {
    this.channelConfig = channelConfig;
    this.config = channelConfig.settings as unknown as QQConfig;
    this.baseURL = this.config.baseURL ?? "https://api.sgroup.qq.com";
    if (this.config.sandbox) {
      this.baseURL = "https://sandbox.api.sgroup.qq.com";
    }
    this.wsURL = "wss://api.sgroup.qq.com/websocket";
    if (this.config.sandbox) {
      this.wsURL = "wss://sandbox.api.sgroup.qq.com/websocket";
    }
  }

  async start(): Promise<void> {
    if (!this.config.appId || !this.config.token) {
      this.statusHandler?.("error");
      return;
    }

    // 重置重连计数器，确保 stop() 后可以重新启动
    this.reconnectAttempt = 0;
    this.reconnecting = false;
    // 重置会话状态，避免重启时误走 RESUME 路径使用已失效的 sessionId/seq
    this.sessionId = null;
    this.seqNumber = 0;

    await this.connect();
  }

  async stop(): Promise<void> {
    this.reconnectAttempt = this.maxReconnectAttempts; // prevent reconnection
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.invalidSessionTimer) {
      clearTimeout(this.invalidSessionTimer);
      this.invalidSessionTimer = null;
    }
    this.clearHeartbeat();
    if (this.ws) {
      this.ws.close(1000, "User stopped");
      this.ws = null;
    }
    this.statusHandler?.("disconnected");
  }

  async sendMessage(
    target: string,
    text: string,
    options?: { replyTo?: string; attachments?: ChannelMessage["attachments"] }
  ): Promise<ChannelSendResult> {
    try {
      // Determine if it's a group or private message
      const isGroup = target.startsWith("group:") || target.includes("group");
      const chatId = target.replace(/^(group:|private:)/, "");

      const url = isGroup
        ? `${this.baseURL}/v2/groups/${chatId}/messages`
        : `${this.baseURL}/v2/users/${chatId}/messages`;

      const body: Record<string, unknown> = {
        content: text,
        msg_type: 0, // text
      };

      if (options?.replyTo) {
        body.msg_id = options.replyTo;
      }

      // Handle image attachments
      if (options?.attachments?.some((a) => a.type === "image" && a.url)) {
        body.msg_type = 7; // rich media
        const img = options.attachments.find((a) => a.type === "image");
        body.media = { file_info: img?.url };
      }

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bot ${this.config.appId}.${this.config.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      const data = await res.json() as { id?: string; code?: number; message?: string };

      return {
        success: res.ok,
        messageId: data.id ?? `qq_${Date.now()}`,
        error: !res.ok ? (data.message ?? `HTTP ${res.status}`) : undefined,
        channel: "qq" as ChannelType,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        channel: "qq" as ChannelType,
      };
    }
  }

  async healthCheck(): Promise<ChannelHealthResult> {
    try {
      const res = await fetch(`${this.baseURL}/gateway`, {
        headers: { Authorization: `Bot ${this.config.appId}.${this.config.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        return { healthy: true, message: "QQ Bot gateway is reachable" };
      }
      return { healthy: false, message: `QQ Bot gateway returned status ${res.status}` };
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

  // ── WebSocket Connection ────────────────────────────────

  private async connect(): Promise<void> {
    // 并发保护：若已有 WebSocket 正在连接中，直接返回避免重复连接
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;

    try {
      // First get the WebSocket gateway URL
      const gwRes = await fetch(`${this.baseURL}/gateway`, {
        headers: { Authorization: `Bot ${this.config.appId}.${this.config.token}` },
        // connect() 在 start() 路径上，无超时会导致适配器启动永久挂起
        signal: AbortSignal.timeout(10_000),
      });
      const gwData = await gwRes.json() as { url?: string };

      if (gwData.url) {
        this.wsURL = gwData.url;
      }

      this.ws = new WebSocket(this.wsURL);

      this.ws.onopen = () => {
        // Wait for HELLO
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data as string) as QQGatewayPayload;
          this.handlePayload(payload);
        } catch (err) {
          // Ignore parse errors
          process.stderr.write('[QQ] parse error: ' + err + '\n');
        }
      };

      this.ws.onclose = (event: Event) => {
        const closeEvt = event as { code?: number; reason?: string; wasClean?: boolean };
        this.clearHeartbeat();
        if (this.reconnecting) {
          this.reconnecting = false;
          return;
        }
        if (this.reconnectAttempt < this.maxReconnectAttempts) {
          this.statusHandler?.("reconnecting");
          const delay = Math.min(1000 * 2 ** this.reconnectAttempt + random01() * 1000, 30000);
          this.reconnectAttempt++;
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect().catch((err) => {
              process.stderr.write("[QQ] Reconnect failed:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
            });
          }, delay);
          this.reconnectTimer.unref?.();
        } else {
          this.statusHandler?.("disconnected");
        }
      };

      this.ws.onerror = () => {
        this.statusHandler?.("error");
      };
    } catch (err) {
      console.error(`[QQ] Connection failed: ${err}`);
      this.statusHandler?.("error");
      // gateway URL 获取失败时调度重连，避免渠道永久死亡
      if (this.reconnectAttempt < this.maxReconnectAttempts) {
        this.statusHandler?.("reconnecting");
        const delay = Math.min(1000 * 2 ** this.reconnectAttempt + random01() * 1000, 30000);
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          void this.connect().catch((err) => {
            process.stderr.write("[QQ] Reconnect (after error) failed:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
          });
        }, delay);
        this.reconnectTimer.unref?.();
      } else {
        this.statusHandler?.("disconnected");
      }
    }
  }

  // ── Payload Handling ────────────────────────────────────

  private handlePayload(payload: QQGatewayPayload): void {
    const { op, d, s, t } = payload;

    if (s) {
      this.seqNumber = s;
    }

    switch (op) {
      case QQ_OP.HELLO:
        // Start heartbeat
        this.startHeartbeat((d as { heartbeat_interval: number }).heartbeat_interval);
        // Identify
        this.identify();
        break;

      case QQ_OP.HEARTBEAT_ACK:
        break;

      case QQ_OP.DISPATCH:
        this.handleDispatch(t, d);
        break;

      case QQ_OP.RECONNECT:
        this.reconnect();
        break;

      case QQ_OP.INVALID_SESSION:
        this.sessionId = null;
        // 存储定时器句柄，便于 stop() 清理，避免泄漏；unref 不阻止进程退出
        this.invalidSessionTimer = setTimeout(() => {
          this.invalidSessionTimer = null;
          this.identify();
        }, 1000);
        this.invalidSessionTimer.unref?.();
        break;
    }
  }

  private handleDispatch(eventType: string | undefined, data: unknown): void {
    switch (eventType) {
      case "READY":
        this.sessionId = (data as { session_id: string }).session_id;
        this.reconnectAttempt = 0;
        this.statusHandler?.("connected");
        break;

      case "C2C_MESSAGE_CREATE":
      case "GROUP_AT_MESSAGE_CREATE":
      case "AT_MESSAGE_CREATE":
        this.processMessage(data as QQMessageData, eventType);
        break;
    }
  }

  private async processMessage(data: QQMessageData, eventType: string | undefined): Promise<void> {
    if (!this.messageHandler) return;

    const isGroup = !!(eventType?.includes("GROUP") || eventType?.includes("group"));
    const content = data.content ?? "";
    // Strip @bot mention if present (清除所有 @提及，而非仅第一个)
    const cleanContent = content.replace(/<@!\d+>/g, "").trim();

    const msg: ChannelMessage = {
      messageId: data.id ?? `qq_${Date.now()}`,
      channel: "qq" as ChannelType,
      from: data.author?.id ?? "unknown",
      to: isGroup ? (data.group_id ?? "group") : "direct",
      text: cleanContent,
      timestamp: data.timestamp ?? new Date().toISOString(),
      isDirect: !isGroup,
      isGroup,
      groupId: isGroup ? data.group_id : undefined,
      attachments: data.attachments?.map((a) => ({
        type: a.content_type?.startsWith("image") ? "image" : "document",
        url: a.url,
        filename: a.filename,
      })),
      raw: data as unknown as Record<string, unknown>,
    };

    await this.messageHandler(msg);
  }

  // ── Gateway Operations ──────────────────────────────────

  private identify(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const identify = {
      op: QQ_OP.IDENTIFY,
      d: {
        token: `Bot ${this.config.appId}.${this.config.token}`,
        intents: 1107296256, // Group + C2C + interactions
        shard: [0, 1],
        properties: {},
      },
    };

    this.ws.send(JSON.stringify(identify));
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const hb = {
      op: QQ_OP.HEARTBEAT,
      d: this.seqNumber,
    };

    this.ws.send(JSON.stringify(hb));
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
    // 不阻止进程退出
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private reconnect(): void {
    this.reconnecting = true;
    if (this.ws) {
      this.ws.close(4000, "Reconnect requested");
    }
    void this.connect().catch((err) => {
      process.stderr.write("[QQ] Reconnect (RECONNECT op) failed:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
    });
  }
}

// ── Internal Types ────────────────────────────────────────

interface QQGatewayPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

interface QQMessageData {
  id?: string;
  author?: { id: string; username?: string; avatar?: string };
  content?: string;
  timestamp?: string;
  group_id?: string;
  guild_id?: string;
  attachments?: Array<{
    url?: string;
    filename?: string;
    content_type?: string;
  }>;
}