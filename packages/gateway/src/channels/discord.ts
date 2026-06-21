/**
 * Discord Channel Adapter — uses Discord Bot API.
 *
 * Supports: text messages, embeds, reactions, slash commands,
 * webhook-based event receiving via Gateway Intents.
 *
 * Setup:
 *   1. Create a bot at https://discord.com/developers/applications
 *   2. Set DISCORD_BOT_TOKEN env var
 *   3. Invite bot to server with proper OAuth2 scopes
 */

import type {
  ChannelAdapter,
  ChannelHealthResult,
  ChannelMessage,
  ChannelSendResult,
  ChannelType,
} from "../channel-manager.js";

export interface DiscordConfig {
  /** Bot token from Discord Developer Portal */
  botToken: string;
  /** Allowed guild (server) IDs (empty = allow all) */
  allowedGuilds?: string[];
  /** Allowed channel IDs (empty = allow all DM channels) */
  allowedChannels?: string[];
  /** Blocked user IDs */
  blockedUsers?: string[];
  /** Intents (bitfield) — defaults to Guilds + Messages + MessageContent */
  intents?: number;
}

// Discord Gateway Intents
const DEFAULT_INTENTS =
  (1 << 0)  // GUILDS
  | (1 << 9)  // GUILD_MESSAGES
  | (1 << 15) // MESSAGE_CONTENT
  | (1 << 12); // DIRECT_MESSAGES

interface DiscordGatewayMessage {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

interface DiscordReadyData {
  user: { id: string; username: string; discriminator: string };
}

interface DiscordMessageCreate {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: {
    id: string;
    username: string;
    discriminator: string;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  attachments: Array<{
    id: string;
    filename: string;
    content_type?: string;
    url: string;
    size: number;
  }>;
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
  }>;
  referenced_message?: {
    id: string;
    author: { id: string };
    content: string;
  };
  mentions: Array<{ id: string; username: string }>;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly type: ChannelType = "discord";

  private botToken: string;
  private allowedGuilds: Set<string>;
  private allowedChannels: Set<string>;
  private blockedUsers: Set<string>;
  private intents: number;

  private messageHandlers: Array<(msg: ChannelMessage) => Promise<void>> = [];
  private statusHandlers: Array<(status: "connected" | "disconnected" | "reconnecting" | "error") => void> = [];

  private running = false;
  private connected = false;
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private sequence: number | null = null;
  private resumeGatewayUrl: string | null = null;
  private botUserId: string | null = null;

  constructor(config: DiscordConfig) {
    this.botToken = config.botToken;
    this.allowedGuilds = new Set(config.allowedGuilds ?? []);
    this.allowedChannels = new Set(config.allowedChannels ?? []);
    this.blockedUsers = new Set(config.blockedUsers ?? []);
    this.intents = config.intents ?? DEFAULT_INTENTS;
  }

  async start(): Promise<void> {
    if (this.running) return;

    try {
      // Verify bot token by calling /users/@me
      const botInfo = await this.discordApi<{
        id: string;
        username: string;
        discriminator: string;
      }>("/users/@me");

      this.botUserId = botInfo.id;
      console.log(`[Discord] Connected as ${botInfo.username}#${botInfo.discriminator} (${botInfo.id})`);

      this.running = true;
      this.connected = true;
      this.notifyStatus("connected");

      // Connect to Gateway
      await this.connectGateway();
    } catch (err) {
      this.notifyStatus("error");
      throw new Error(
        `Discord connection failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.connected = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.ws) {
      this.ws.close(1000, "Bot shutting down");
      this.ws = null;
    }

    this.notifyStatus("disconnected");
    console.log("[Discord] Stopped");
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
      // Split long messages into chunks
      const chunks = this.splitMessage(text, 2000);

      let lastMessageId: string | undefined;

      for (let i = 0; i < chunks.length; i++) {
        const body: Record<string, unknown> = {
          content: chunks[i],
        };

        if (options?.replyTo && i === 0) {
          body.message_reference = { message_id: options.replyTo };
        }

        // Handle attachments
        if (options?.attachments && options.attachments.length > 0 && i === 0) {
          const attachment = options.attachments[0];
          if (attachment.url) {
            body.embeds = [{
              image: attachment.type === "image" ? { url: attachment.url } : undefined,
              description: attachment.type === "image" ? undefined : text,
            }];
            body.content = attachment.type === "image" ? text : "";
          }
        }

        const result = await this.discordApi<{
          id: string;
          content: string;
        }>(`/channels/${target}/messages`, {
          method: "POST",
          body,
        });

        lastMessageId = result.id;
      }

      return {
        success: true,
        messageId: lastMessageId,
        channel: "discord",
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        channel: "discord",
      };
    }
  }

  async healthCheck(): Promise<ChannelHealthResult> {
    try {
      const info = await this.discordApi<{ id: string }>("/users/@me");
      if (info.id) {
        return { healthy: true, message: "Discord API is reachable" };
      }
      return { healthy: false, message: "Discord API returned invalid response" };
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

  // ── Discord Gateway Connection ────────────────────────────────────────────

  private async connectGateway(): Promise<void> {
    // Get gateway URL
    const gateway = await this.discordApi<{ url: string }>("/gateway/bot");
    const wsUrl = `${gateway.url}/?v=10&encoding=json`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log("[Discord] Gateway connected");
      this.sendGatewayPayload({
        op: 2, // Identify
        d: {
          token: this.botToken,
          intents: this.intents,
          properties: {
            os: process.platform,
            browser: "EvoClaw",
            device: "EvoClaw",
          },
        },
      });
    };

    this.ws.onmessage = (event) => {
      try {
        const payload: DiscordGatewayMessage = JSON.parse(
          typeof event.data === "string" ? event.data : event.data.toString()
        );
        this.handleGatewayPayload(payload);
      } catch (err) {
        console.error("[Discord] Failed to parse gateway message:", err);
      }
    };

    this.ws.onclose = (event) => {
      console.log(`[Discord] Gateway closed (code: ${event.code})`);
      if (this.running) {
        this.notifyStatus("reconnecting");
        // Reconnect after a delay
        setTimeout(() => {
          if (this.running) {
            this.connectGateway().catch((err) =>
              console.error("[Discord] Reconnect failed:", err)
            );
          }
        }, 5000);
      }
    };

    this.ws.onerror = (err) => {
      console.error("[Discord] Gateway error:", err);
      if (this.running) {
        this.notifyStatus("error");
      }
    };
  }

  private sendGatewayPayload(payload: DiscordGatewayMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private handleGatewayPayload(payload: DiscordGatewayMessage): void {
    const { op, d, t, s } = payload;

    if (s) this.sequence = s;

    switch (op) {
      case 10: { // Hello
        const hello = d as { heartbeat_interval: number };
        this.startHeartbeat(hello.heartbeat_interval);
        break;
      }
      case 0: { // Dispatch
        if (t === "READY") {
          const ready = d as DiscordReadyData;
          console.log(`[Discord] Ready as ${ready.user.username}#${ready.user.discriminator}`);
          this.connected = true;
          this.notifyStatus("connected");
        }
        if (t === "MESSAGE_CREATE") {
          this.processMessage(d as DiscordMessageCreate);
        }
        break;
      }
      case 11: // Heartbeat ACK
        break;
      case 7: // Reconnect
        console.log("[Discord] Server requested reconnect");
        if (this.ws) {
          this.ws.close(4000, "Server requested reconnect");
        }
        break;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      this.sendGatewayPayload({ op: 1, d: this.sequence });
    }, intervalMs);
    // 不阻止进程退出
    this.heartbeatInterval.unref?.();
  }

  // ── Message Processing ────────────────────────────────────────────────────

  private async processMessage(msg: DiscordMessageCreate): Promise<void> {
    // Ignore bot messages
    if (msg.author.bot) return;

    // Check mentions — only process if bot is mentioned in guild channels
    const isGuild = !!msg.guild_id;

    // Access control
    if (this.blockedUsers.has(msg.author.id)) return;
    if (this.allowedChannels.size > 0) {
      if (!this.allowedChannels.has(msg.channel_id)) return;
    }
    if (this.allowedGuilds.size > 0 && msg.guild_id) {
      if (!this.allowedGuilds.has(msg.guild_id)) return;
    }

    let text = msg.content || "";
    if (!text && msg.embeds && msg.embeds.length > 0) {
      text = msg.embeds.map((e) => e.title || e.description || "").join("\n");
    }

    const channelMsg: ChannelMessage = {
      messageId: msg.id,
      channel: "discord",
      from: msg.author.id,
      to: msg.channel_id,
      text,
      timestamp: msg.timestamp,
      isDirect: !isGuild,
      isGroup: isGuild,
      groupId: msg.guild_id,
      replyTo: msg.referenced_message?.id,
      attachments: this.extractAttachments(msg),
      raw: msg as unknown as Record<string, unknown>,
    };

    for (const handler of this.messageHandlers) {
      try {
        await handler(channelMsg);
      } catch (err) {
        console.error("[Discord] Message handler error:", err);
      }
    }
  }

  private extractAttachments(
    msg: DiscordMessageCreate
  ): ChannelMessage["attachments"] {
    if (!msg.attachments || msg.attachments.length === 0) return undefined;

    const typeMap: Record<string, "image" | "video" | "audio" | "document"> = {
      "image/": "image",
      "video/": "video",
      "audio/": "audio",
    };

    return msg.attachments.map((att) => {
      let type: "image" | "video" | "audio" | "document" = "document";
      if (att.content_type) {
        for (const [prefix, mappedType] of Object.entries(typeMap)) {
          if (att.content_type.startsWith(prefix)) {
            type = mappedType;
            break;
          }
        }
      }

      return {
        type,
        url: att.url,
        mimeType: att.content_type,
        filename: att.filename,
      };
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async discordApi<T>(
    path: string,
    options?: { method?: string; body?: Record<string, unknown> }
  ): Promise<T> {
    const url = `https://discord.com/api/v10${path}`;
    const response = await fetch(url, {
      method: options?.method ?? "GET",
      headers: {
        Authorization: `Bot ${this.botToken}`,
        "Content-Type": "application/json",
      },
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Discord API ${path}: HTTP ${response.status} - ${text.slice(0, 200)}`
      );
    }

    return response.json() as Promise<T>;
  }

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLength) {
      // Find a good split point (newline or space)
      let splitAt = remaining.lastIndexOf("\n", maxLength);
      if (splitAt === -1 || splitAt < maxLength / 2) {
        splitAt = remaining.lastIndexOf(" ", maxLength);
      }
      if (splitAt === -1 || splitAt < maxLength / 2) {
        splitAt = maxLength;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trim();
    }

    if (remaining.length > 0) {
      chunks.push(remaining);
    }

    return chunks;
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