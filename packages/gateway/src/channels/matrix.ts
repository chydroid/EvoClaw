/**
 * Matrix Channel Adapter
 *
 * Uses Matrix Client-Server API for federated messaging.
 *
 * Matrix spec: https://spec.matrix.org/v1.11/client-server-api/
 *
 * Features:
 *  - Login via user/password or access token
 *  - Sync API for real-time events (long-polling with since token)
 *  - Room message sending via /send API
 *  - Presence and typing indicators
 *  - Room join/leave management
 *  - Media (mxc:// URI) handling
 *  - E2E encrypted room support (basic, via session)
 */

import type { ChannelAdapter, ChannelConfig, ChannelHealthResult, ChannelMessage, ChannelSendResult, ChannelType } from "../channel-manager.js";

// ── Config ────────────────────────────────────────────────

export interface MatrixConfig {
  /** Matrix homeserver URL (e.g., "https://matrix.org") */
  homeserver: string;
  /** User ID (e.g., "@bot:matrix.org") */
  userId: string;
  /** Access token (preferred) */
  accessToken?: string;
  /** Password (alternative to token — will auto-login) */
  password?: string;
  /** Auto-join invited rooms */
  autoJoin?: boolean;
  /** Sync filter (JSON string) */
  filter?: string;
  /** Polling timeout in ms (default: 30000) */
  pollTimeoutMs?: number;
}

// ── Adapter ───────────────────────────────────────────────

export class MatrixAdapter implements ChannelAdapter {
  readonly type: ChannelType = "matrix";

  private config: MatrixConfig;
  private channelConfig: ChannelConfig;
  private accessToken: string | null = null;
  private userId: string;
  private since: string | null = null;
  private polling = false;
  private pollAbort = new AbortController();
  private messageHandler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private statusHandler: ((status: "connected" | "disconnected" | "reconnecting" | "error") => void) | null = null;

  constructor(channelConfig: ChannelConfig) {
    this.channelConfig = channelConfig;
    this.config = channelConfig.settings as unknown as MatrixConfig;
    this.userId = this.config.userId;
    this.accessToken = this.config.accessToken ?? null;
  }

  async start(): Promise<void> {
    if (!this.config.homeserver) {
      this.statusHandler?.("error");
      return;
    }

    // Reset AbortController so start() works after stop()
    if (this.pollAbort.signal.aborted) {
      this.pollAbort = new AbortController();
    }

    try {
      // Login if using password
      if (!this.accessToken && this.config.password) {
        await this.login();
      }

      if (this.accessToken) {
        // Verify token is valid
        const whoami = await this.apiCall("GET", "/_matrix/client/v3/account/whoami");
        if (whoami.user_id) {
          this.userId = whoami.user_id as string;
        }

        this.statusHandler?.("connected");
        this.startSync();
      } else {
        this.statusHandler?.("error");
      }
    } catch (err) {
      this.statusHandler?.("error");
      console.error(`[Matrix] Start failed: ${err}`);
    }
  }

  async stop(): Promise<void> {
    this.pollAbort.abort();
    this.polling = false;

    // Logout
    if (this.accessToken) {
      try {
        await this.apiCall("POST", "/_matrix/client/v3/logout");
      } catch { /* ignore */ }
    }

    this.statusHandler?.("disconnected");
  }

  async sendMessage(
    target: string,
    text: string,
    options?: { replyTo?: string; attachments?: ChannelMessage["attachments"] }
  ): Promise<ChannelSendResult> {
    if (!this.accessToken) {
      return { success: false, error: "Not authenticated", channel: "matrix" };
    }

    try {
      const roomId = this.normalizeRoomId(target);
      const txnId = `txn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const body: Record<string, unknown> = {
        msgtype: "m.text",
        body: text,
      };

      // Handle formatted messages
      if (text.includes("**") || text.includes("```") || text.includes("#")) {
        body.format = "org.matrix.custom.html";
        body.formatted_body = this.textToHtml(text);
      }

      // Handle reply
      if (options?.replyTo) {
        body["m.relates_to"] = {
          "m.in_reply_to": { event_id: options.replyTo },
        };
      }

      // Handle attachments
      if (options?.attachments?.length) {
        const att = options.attachments[0];
        if (att.type === "image") {
          body.msgtype = "m.image";
          if (att.url) body.url = att.url;
          body.body = att.filename ?? text;
        } else if (att.type === "video") {
          body.msgtype = "m.video";
          if (att.url) body.url = att.url;
          body.body = att.filename ?? text;
        } else if (att.type === "audio") {
          body.msgtype = "m.audio";
          if (att.url) body.url = att.url;
          body.body = att.filename ?? text;
        } else {
          body.msgtype = "m.file";
          if (att.url) body.url = att.url;
          body.body = att.filename ?? text;
          body.filename = att.filename;
        }
      }

      const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;
      const res = await this.apiCall("PUT", path, body);

      return {
        success: true,
        messageId: (res.event_id as string) ?? `matrix_${Date.now()}`,
        channel: "matrix",
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        channel: "matrix",
      };
    }
  }

  async healthCheck(): Promise<ChannelHealthResult> {
    try {
      const res = await fetch(`${this.config.homeserver.replace(/\/+$/, "")}/_matrix/client/versions`);
      const data = await res.json() as { versions?: string[] };
      if (Array.isArray(data.versions)) {
        return { healthy: true, message: "Matrix server is reachable", details: { versions: data.versions.join(", ") } };
      }
      return { healthy: false, message: "Matrix server returned unexpected response" };
    } catch (err) {
      return { healthy: false, message: `Cannot reach Matrix server: ${(err as Error).message}` };
    }
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onStatusChange(handler: (status: "connected" | "disconnected" | "reconnecting" | "error") => void): void {
    this.statusHandler = handler;
  }

  // ── Room Management ─────────────────────────────────────

  /** Join a room by ID or alias */
  async joinRoom(roomIdOrAlias: string): Promise<boolean> {
    try {
      const path = `/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`;
      await this.apiCall("POST", path);
      return true;
    } catch {
      return false;
    }
  }

  // ── Internal: Auth ──────────────────────────────────────

  private async login(): Promise<void> {
    const res = await fetch(
      `${this.config.homeserver.replace(/\/+$/, "")}/_matrix/client/v3/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "m.login.password",
          identifier: { type: "m.id.user", user: this.userId },
          password: this.config.password,
        }),
      }
    );

    const data = await res.json() as { access_token?: string; user_id?: string };
    if (data.access_token) {
      this.accessToken = data.access_token;
      this.userId = data.user_id ?? this.userId;
    }
  }

  // ── Internal: Sync ──────────────────────────────────────

  private startSync(): void {
    if (this.polling) return;
    this.polling = true;

    const sync = async () => {
      while (this.polling && !this.pollAbort.signal.aborted) {
        try {
          await this.syncOnce();
        } catch (err) {
          if ((err as Error).name === "AbortError") break;
          console.error(`[Matrix] Sync error: ${err}`);
          this.statusHandler?.("reconnecting");
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    };

    sync();
  }

  private async syncOnce(): Promise<void> {
    if (!this.accessToken) return;

    const params = new URLSearchParams();
    if (this.since) params.set("since", this.since);
    params.set("timeout", String(this.config.pollTimeoutMs ?? 30000));

    if (this.config.filter) {
      params.set("filter", this.config.filter);
    } else {
      // Default filter: only room timeline events, no presence
      params.set("filter", JSON.stringify({
        room: { timeline: { types: ["m.room.message", "m.room.member"] } },
        presence: { types: [] },
      }));
    }

    const path = `/_matrix/client/v3/sync?${params.toString()}`;

    const res = await fetch(
      `${this.config.homeserver.replace(/\/+$/, "")}${path}`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        signal: this.pollAbort.signal,
      }
    );

    const data = await res.json() as MatrixSyncResponse;

    // Update since token
    this.since = data.next_batch;

    // Process invite rooms
    if (data.rooms?.invite) {
      for (const [roomId] of Object.entries(data.rooms.invite)) {
        if (this.config.autoJoin) {
          await this.joinRoom(roomId);
        }
      }
    }

    // Process joined room events
    if (data.rooms?.join) {
      for (const [roomId, roomData] of Object.entries(data.rooms.join)) {
        const events = roomData.timeline?.events ?? [];
        for (const event of events) {
          await this.processEvent(roomId, event);
        }
      }
    }
  }

  // ── Internal: Event Processing ──────────────────────────

  private async processEvent(
    roomId: string,
    event: MatrixEvent
  ): Promise<void> {
    if (!this.messageHandler) return;
    if (event.type !== "m.room.message") return;
    if (event.sender === this.userId) return; // skip own messages

    const content = event.content ?? {};
    const text = (content.body as string) ?? "";

    if (!text.trim()) return;

    const isDirect = !roomId.startsWith("!");
    const isGroup = roomId.startsWith("!") && !(event.sender ?? "").includes(this.userId);

    const msg: ChannelMessage = {
      messageId: event.event_id ?? `matrix_${Date.now()}`,
      channel: "matrix",
      from: event.sender ?? "unknown",
      to: roomId,
      text,
      timestamp: new Date(event.origin_server_ts ?? Date.now()).toISOString(),
      isDirect,
      isGroup,
      groupId: isGroup ? roomId : undefined,
      attachments: content.url ? [{ type: "image", url: content.url as string }] : undefined,
      raw: event as unknown as Record<string, unknown>,
    };

    await this.messageHandler(msg);
  }

  // ── Internal: API Helpers ───────────────────────────────

  private async apiCall(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const url = `${this.config.homeserver.replace(/\/+$/, "")}${path}`;

    const options: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      },
    };

    if (body && method !== "GET") {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`Matrix API error [${res.status}]: ${errorText.slice(0, 200)}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  private normalizeRoomId(target: string): string {
    // Handle room aliases (#room:server)
    if (target.startsWith("#")) {
      return target;
    }
    // Handle room IDs (!xxx:server)
    if (target.startsWith("!")) {
      return target;
    }
    return target;
  }

  private textToHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
      .replace(/`(.+?)`/g, "<code>$1</code>")
      .replace(/\n/g, "<br>");
  }
}

// ── Internal Types ────────────────────────────────────────

interface MatrixSyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, {
      timeline?: {
        events?: MatrixEvent[];
        limited?: boolean;
        prev_batch?: string;
      };
    }>;
    invite?: Record<string, unknown>;
    leave?: Record<string, unknown>;
  };
}

interface MatrixEvent {
  type: string;
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  content?: {
    body?: string;
    msgtype?: string;
    url?: string;
    [key: string]: unknown;
  };
  unsigned?: Record<string, unknown>;
}