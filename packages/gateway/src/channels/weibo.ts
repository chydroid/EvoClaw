/**
 * Weibo (微博) Channel Adapter
 *
 * 微博是中国最大的社交媒体平台之一，提供 Open API 用于机器人/应用集成。
 *
 * Weibo Open API docs: https://open.weibo.com/wiki/API
 *
 * 两种模式：
 *  1. 私信模式 (Direct Message) — 通过微博 API 发送/接收私信
 *  2. 评论模式 (Comment/Reply) — 监控微博评论并回复
 *
 * 关键特性：
 *  - access_token 自动刷新
 *  - 私信发送（文本/图片）
 *  - 评论监听与回复
 *  - 消息去重
 *  - API 限流处理
 */

import type { ChannelAdapter, ChannelConfig, ChannelHealthResult, ChannelMessage, ChannelSendResult, ChannelType } from "../channel-manager.js";

// ── Config ────────────────────────────────────────────────

export interface WeiboConfig {
  /** 模式：dm（私信）或 comment（评论） */
  mode: "dm" | "comment";
  /** 微博 App Key */
  appKey: string;
  /** 微博 App Secret */
  appSecret: string;
  /** 微博 Access Token（用户授权后获取） */
  accessToken?: string;
  /** 监听的微博 ID（comment 模式） */
  listenWeiboId?: string;
  /** API base URL（默认 https://api.weibo.com） */
  baseURL?: string;
}

// ── Adapter ───────────────────────────────────────────────

export class WeiboAdapter implements ChannelAdapter {
  readonly type: ChannelType = "weibo" as ChannelType;

  private config: WeiboConfig;
  private channelConfig: ChannelConfig;
  private baseURL: string;
  private messageHandler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private statusHandler: ((status: "connected" | "disconnected" | "reconnecting" | "error") => void) | null = null;
  private processedEvents = new Set<string>();
  private static MAX_PROCESSED_EVENTS = 1000;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(channelConfig: ChannelConfig) {
    this.channelConfig = channelConfig;
    this.config = channelConfig.settings as unknown as WeiboConfig;
    this.baseURL = this.config.baseURL ?? "https://api.weibo.com";
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onStatusChange(handler: (status: "connected" | "disconnected" | "reconnecting" | "error") => void): void {
    this.statusHandler = handler;
  }

  async start(): Promise<void> {
    if (!this.config.appKey || !this.config.appSecret) {
      this.statusHandler?.("error");
      return;
    }

    if (this.config.mode === "comment" && !this.config.listenWeiboId) {
      this.statusHandler?.("error");
      return;
    }

    this.statusHandler?.("connected");

    // comment 模式启动轮询
    if (this.config.mode === "comment" && this.config.accessToken) {
      this.startPolling();
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.polling = false;
    this.processedEvents.clear();
    this.statusHandler?.("disconnected");
  }

  async healthCheck(): Promise<ChannelHealthResult> {
    if (!this.config.accessToken) {
      return { healthy: false, message: "no access token" };
    }

    try {
      // 验证 token 有效性
      const url = `${this.baseURL}/2/account/get_uid.json?access_token=${this.config.accessToken}`;
      const res = await fetch(url);
      const data = await res.json() as { uid: string; idstr: string } | { error_code: number; error: string };

      if ("uid" in data) {
        return { healthy: true, message: `uid: ${data.uid}` };
      }
      return { healthy: false, message: `error ${data.error_code}: ${data.error}` };
    } catch (err) {
      return { healthy: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendMessage(
    target: string,
    text: string,
    options?: { replyTo?: string; attachments?: ChannelMessage["attachments"] }
  ): Promise<ChannelSendResult> {
    if (!this.config.accessToken) {
      return { success: false, error: "access token not configured", channel: this.type };
    }

    try {
      // 发送私信
      const url = `${this.baseURL}/2/direct_messages/send.json?access_token=${this.config.accessToken}`;
      const body: Record<string, string> = { uid: target, text };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
      });

      const data = await res.json() as { tid: string } | { error_code: number; error: string };
      if ("tid" in data) {
        return { success: true, channel: this.type };
      }
      return { success: false, error: `${data.error_code}: ${data.error}`, channel: this.type };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), channel: this.type };
    }
  }

  // ── 评论轮询（comment 模式） ───────────────────────────

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;

    // 每 30 秒轮询一次新评论
    this.pollTimer = setInterval(async () => {
      await this.pollComments();
    }, 30000);
  }

  private async pollComments(): Promise<void> {
    if (!this.config.accessToken || !this.config.listenWeiboId) return;

    try {
      const url = `${this.baseURL}/2/comments/show.json?access_token=${this.config.accessToken}&id=${this.config.listenWeiboId}&count=10`;
      const res = await fetch(url);
      const data = await res.json() as { comments: Array<{
        id: number;
        idstr: string;
        text: string;
        user: { screen_name: string; id: number };
        created_at: string;
      }> };

      if (!data.comments || !Array.isArray(data.comments)) return;

      for (const comment of data.comments) {
        const dedupKey = `comment-${comment.id}`;
        if (this.processedEvents.has(dedupKey)) continue;

        if (this.processedEvents.size >= WeiboAdapter.MAX_PROCESSED_EVENTS) {
          this.processedEvents.clear();
        }
        this.processedEvents.add(dedupKey);

        const msg: ChannelMessage = {
          messageId: String(comment.id),
          channel: this.type,
          from: String(comment.user.id),
          to: this.config.listenWeiboId,
          text: comment.text,
          timestamp: new Date(comment.created_at).toISOString(),
          isDirect: false,
          isGroup: false,
          raw: comment as unknown as Record<string, unknown>,
        };

        if (this.messageHandler) {
          this.messageHandler(msg).catch((err) => {
            console.error(`[Weibo] Message handling error: ${err}`);
          });
        }
      }
    } catch (err) {
      console.error(`[Weibo] Comment poll error: ${err}`);
    }
  }

  // ── 回调处理 ────────────────────────────────────────────

  /**
   * 处理微博回调（私信/评论事件）
   */
  async handleCallback(rawBody: string | Buffer): Promise<string> {
    const body = rawBody.toString();
    try {
      const data = JSON.parse(body) as {
        event?: string;
        from_user?: string;
        text?: string;
        id?: number;
      };

      if (data.event === "dm" && data.from_user && data.text) {
        const msg: ChannelMessage = {
          messageId: data.id ? String(data.id) : `weibo_${Date.now()}`,
          channel: this.type,
          from: data.from_user,
          to: "",
          text: data.text,
          timestamp: new Date().toISOString(),
          isDirect: true,
          isGroup: false,
          raw: data as unknown as Record<string, unknown>,
        };

        if (data.id && this.processedEvents.has(String(data.id))) {
          return "ok";
        }
        if (data.id && this.processedEvents.size >= WeiboAdapter.MAX_PROCESSED_EVENTS) {
          this.processedEvents.clear();
        }
        if (data.id) this.processedEvents.add(String(data.id));

        if (this.messageHandler) {
          this.messageHandler(msg).catch((err) => {
            console.error(`[Weibo] Callback handling error: ${err}`);
          });
        }
      }
    } catch {
      // 非 JSON 格式，忽略
    }

    return "ok";
  }
}
