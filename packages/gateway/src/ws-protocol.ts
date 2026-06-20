/**
 * WebSocket Protocol — OpenClaw-style typed WebSocket communication.
 *
 * Implements the wire protocol:
 * - connect handshake (first frame must be connect)
 * - req/res pattern with typed methods
 * - server-push events with sequencing
 * - idempotency keys for side-effecting methods
 * - Heartbeat / health check
 */

import type { EventBus } from "@evoclaw/core";

// ─── Protocol Types ───────────────────────────────────────────────────────────

export interface ConnectFrame {
  type: "connect";
  params: {
    /** Shared auth token or password */
    auth?: {
      token?: string;
      password?: string;
    };
    /** Client role */
    role?: "client" | "node";
    /** Device identity */
    deviceId?: string;
    /** Device token (from prior pairing) */
    deviceToken?: string;
    /** Platform info */
    platform?: string;
    deviceFamily?: string;
    /** For nodes: capabilities and commands */
    caps?: string[];
    commands?: string[];
    /** Challenge nonce for signature verification */
    challenge?: string;
  };
}

export interface ConnectResponse {
  type: "hello-ok";
  serverVersion: string;
  serverId: string;
  features: {
    methods: string[];
    events: string[];
  };
  /** New challenge for V3 signature binding */
  challenge?: string;
}

export interface ConnectError {
  type: "hello-error";
  reason: string;
  code: "auth_failed" | "pairing_required" | "invalid_role" | "protocol_error";
  /** Pairing code for pairing-required errors */
  pairingCode?: string;
}

export interface RequestFrame {
  type: "req";
  /** Unique request ID */
  id: string;
  /** Method name */
  method: string;
  /** Method parameters */
  params: Record<string, unknown>;
  /** Idempotency key for side-effecting methods */
  idempotencyKey?: string;
}

export interface ResponseFrame {
  type: "res";
  /** Matching request ID */
  id: string;
  /** Whether the request succeeded */
  ok: boolean;
  /** Success payload */
  payload?: unknown;
  /** Error details */
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface EventFrame {
  type: "event";
  /** Event name */
  event: string;
  /** Event payload */
  payload: unknown;
  /** Monotonic sequence number */
  seq?: number;
  /** Server state version (for cache invalidation) */
  stateVersion?: number;
}

export type ProtocolFrame =
  | ConnectFrame
  | ConnectResponse
  | ConnectError
  | RequestFrame
  | ResponseFrame
  | EventFrame;

// ─── Allowed Methods ──────────────────────────────────────────────────────────

export const ALLOWED_METHODS = [
  // Agent methods
  "agent",
  "agent.wait",
  "agent.stop",
  // Session methods
  "sessions.list",
  "sessions.history",
  "sessions.send",
  "sessions.spawn",
  "sessions.delete",
  // Message methods
  "message.send",
  "message.status",
  // Channel methods
  "channels.list",
  "channels.status",
  // System methods
  "health",
  "status",
  "shutdown",
  // Config methods
  "config.get",
  "config.set",
  // Pairing methods
  "pairing.approve",
  "pairing.revoke",
  "pairing.list",
  // Node methods (for role=node clients)
  "canvas.render",
  "canvas.update",
  "camera.capture",
  "screen.record",
  "location.get",
  // Cron methods
  "cron.list",
  "cron.create",
  "cron.delete",
  // Plugin methods
  "plugins.list",
  "plugins.install",
  "plugins.remove",
] as const;

export type AllowedMethod = (typeof ALLOWED_METHODS)[number];

// ─── Side-effecting methods (require idempotency key) ─────────────────────────

const SIDE_EFFECTING_METHODS: Set<string> = new Set([
  "agent",
  "message.send",
  "sessions.send",
  "sessions.delete",
  "config.set",
  "pairing.approve",
  "pairing.revoke",
  "cron.create",
  "cron.delete",
  "plugins.install",
  "plugins.remove",
]);

// ─── Protocol Handler ─────────────────────────────────────────────────────────

export interface WSClient {
  /** Unique client ID */
  id: string;
  /** Client role */
  role: "client" | "node";
  /** Connected since */
  connectedAt: Date;
  /** Authenticated identity */
  deviceId?: string;
  /** Approved capabilities (for nodes) */
  caps?: string[];
  commands?: string[];
  /** Send a frame to this client */
  send(frame: ProtocolFrame): void;
  /** Close the connection */
  close(code?: number, reason?: string): void;
  /** Check if still connected */
  isConnected(): boolean;
  /** Get remote address */
  remoteAddress(): string;
}

export interface ProtocolHandlerOptions {
  /** Server version string */
  serverVersion?: string;
  /** Auth token/password for shared-secret auth */
  authToken?: string;
  authPassword?: string;
  /** Whether to skip auth for loopback connections */
  autoApproveLoopback?: boolean;
  /** Idempotency cache TTL in ms */
  idempotencyTTL?: number;
}

export class ProtocolHandler {
  private clients = new Map<string, WSClient>();
  private methodHandlers = new Map<string, (params: Record<string, unknown>, client: WSClient) => Promise<unknown>>();
  private eventSeq = 0;
  private idempotencyCache = new Map<string, { result: ResponseFrame; at: number }>();
  private options: Required<ProtocolHandlerOptions>;
  private eventBus: EventBus | null = null;

  constructor(options?: ProtocolHandlerOptions) {
    this.options = {
      serverVersion: options?.serverVersion ?? "0.4.0",
      authToken: options?.authToken ?? "",
      authPassword: options?.authPassword ?? "",
      autoApproveLoopback: options?.autoApproveLoopback ?? true,
      idempotencyTTL: options?.idempotencyTTL ?? 300000, // 5 minutes
    };
  }

  setEventBus(eb: EventBus): void {
    this.eventBus = eb;
  }

  // ─── Client Management ────────────────────────────────────────────────────

  /** Handle a new WebSocket connection */
  handleConnection(client: WSClient): void {
    this.clients.set(client.id, client);
    process.stdout.write(`[ProtocolHandler] Client connected: ${client.id} (${client.remoteAddress()})`);
  }

  /** Handle client disconnect */
  handleDisconnect(clientId: string): void {
    this.clients.delete(clientId);
    process.stdout.write(`[ProtocolHandler] Client disconnected: ${clientId}`);
  }

  /** Process an incoming frame from a client */
  async processFrame(client: WSClient, raw: string): Promise<void> {
    let frame: ProtocolFrame;

    try {
      frame = JSON.parse(raw);
    } catch {
      client.close(4000, "Invalid JSON frame");
      return;
    }

    // First frame must be connect
    if (frame.type === "connect" && !client.deviceId) {
      return this.handleConnect(client, frame as ConnectFrame);
    }

    // All other frames require connect handshake
    if (!client.deviceId) {
      client.close(4001, "Connect handshake required");
      return;
    }

    switch (frame.type) {
      case "req":
        return this.handleRequest(client, frame as RequestFrame);
      default:
        client.close(4002, `Unexpected frame type: ${frame.type}`);
    }
  }

  // ─── Connect Handshake ────────────────────────────────────────────────────

  private async handleConnect(client: WSClient, frame: ConnectFrame): Promise<void> {
    const { auth, role, deviceId, deviceToken } = frame.params;

    // Validate role
    const clientRole = role ?? "client";
    if (!["client", "node"].includes(clientRole)) {
      client.send({ type: "hello-error", reason: "Invalid role", code: "invalid_role" });
      client.close(4003, "Invalid role");
      return;
    }

    // Auth check
    const isLoopback = client.remoteAddress() === "127.0.0.1" || client.remoteAddress() === "::1";

    if (!this.options.autoApproveLoopback || !isLoopback) {
      const token = auth?.token;
      const password = auth?.password;

      if (this.options.authToken && token !== this.options.authToken) {
        client.send({ type: "hello-error", reason: "Authentication failed", code: "auth_failed" });
        client.close(4004, "Auth failed");
        return;
      }

      if (this.options.authPassword && password !== this.options.authPassword) {
        client.send({ type: "hello-error", reason: "Authentication failed", code: "auth_failed" });
        client.close(4004, "Auth failed");
        return;
      }

      if (!this.options.authToken && !this.options.authPassword && !isLoopback) {
        client.send({
          type: "hello-error",
          reason: "Remote connections require authentication",
          code: "auth_failed",
        });
        client.close(4004, "Auth required for remote connections");
        return;
      }
    }

    // Assign identity
    (client as unknown as Record<string, unknown>).role = clientRole;
    (client as unknown as Record<string, unknown>).deviceId = deviceId ?? `anon-${client.id}`;

    if (clientRole === "node") {
      (client as unknown as Record<string, unknown>).caps = frame.params.caps ?? [];
      (client as unknown as Record<string, unknown>).commands = frame.params.commands ?? [];
    }

    // Send hello-ok
    client.send({
      type: "hello-ok",
      serverVersion: this.options.serverVersion,
      serverId: "evoclaw-gateway",
      features: {
        methods: [...ALLOWED_METHODS],
        events: [
          "agent", "chat", "presence", "health", "heartbeat",
          "cron", "lifecycle", "tool", "assistant", "error", "shutdown",
        ],
      },
    });

    process.stdout.write(`[ProtocolHandler] Handshake complete for ${client.id} (role=${clientRole})`);
  }

  // ─── Request Handling ─────────────────────────────────────────────────────

  /** Register a method handler */
  registerMethod(method: string, handler: (params: Record<string, unknown>, client: WSClient) => Promise<unknown>): void {
    this.methodHandlers.set(method, handler);
  }

  private async handleRequest(client: WSClient, frame: RequestFrame): Promise<void> {
    const { id, method, params, idempotencyKey } = frame;

    // Validate method
    if (!ALLOWED_METHODS.includes(method as AllowedMethod)) {
      client.send({
        type: "res",
        id,
        ok: false,
        error: { code: "unknown_method", message: `Unknown method: ${method}` },
      });
      return;
    }

    // Idempotency check for side-effecting methods
    if (SIDE_EFFECTING_METHODS.has(method)) {
      if (!idempotencyKey) {
        client.send({
          type: "res",
          id,
          ok: false,
          error: {
            code: "missing_idempotency_key",
            message: `Method "${method}" requires an idempotency key`,
          },
        });
        return;
      }

      const cached = this.idempotencyCache.get(idempotencyKey);
      if (cached && Date.now() - cached.at < this.options.idempotencyTTL) {
        client.send({ ...cached.result, id });
        return;
      }
    }

    // Execute handler
    const handler = this.methodHandlers.get(method);
    if (!handler) {
      client.send({
        type: "res",
        id,
        ok: false,
        error: { code: "not_implemented", message: `Method "${method}" not implemented` },
      });
      return;
    }

    try {
      const payload = await handler(params, client);
      const response: ResponseFrame = { type: "res", id, ok: true, payload };

      // Cache idempotent response
      if (idempotencyKey) {
        this.idempotencyCache.set(idempotencyKey, { result: response, at: Date.now() });
      }

      client.send(response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      client.send({
        type: "res",
        id,
        ok: false,
        error: { code: "internal_error", message: msg },
      });
    }
  }

  // ─── Event Broadcasting ───────────────────────────────────────────────────

  /** Broadcast an event to all connected clients */
  broadcast(event: string, payload: unknown): void {
    this.eventSeq++;
    const frame: EventFrame = {
      type: "event",
      event,
      payload,
      seq: this.eventSeq,
    };

    for (const client of this.clients.values()) {
      try {
        if (client.isConnected()) {
          client.send(frame);
        }
      } catch {
        // Client may have disconnected
        this.clients.delete(client.id);
      }
    }
  }

  /** Send an event to a specific client */
  sendToClient(clientId: string, event: string, payload: unknown): boolean {
    const client = this.clients.get(clientId);
    if (!client || !client.isConnected()) return false;

    this.eventSeq++;
    client.send({
      type: "event",
      event,
      payload,
      seq: this.eventSeq,
    });
    return true;
  }

  /** Send an event to clients matching a filter */
  sendToMatching(
    filter: (client: WSClient) => boolean,
    event: string,
    payload: unknown,
  ): void {
    this.eventSeq++;
    const frame: EventFrame = {
      type: "event",
      event,
      payload,
      seq: this.eventSeq,
    };

    for (const client of this.clients.values()) {
      if (client.isConnected() && filter(client)) {
        try { client.send(frame); } catch { /* ignore */ }
      }
    }
  }

  // ─── Health / Diagnostics ──────────────────────────────────────────────────

  /** Get connection count */
  getConnectionCount(): number {
    return this.clients.size;
  }

  /** Get list of connected clients */
  getConnectedClients(): Array<{ id: string; role: string; connectedAt: Date; remoteAddress: string }> {
    return Array.from(this.clients.values()).map((c) => ({
      id: c.id,
      role: c.role,
      connectedAt: c.connectedAt,
      remoteAddress: c.remoteAddress(),
    }));
  }

  /** Clean up expired idempotency cache entries */
  cleanupIdempotencyCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.idempotencyCache) {
      if (now - entry.at > this.options.idempotencyTTL) {
        this.idempotencyCache.delete(key);
      }
    }
  }

  /** Close all connected clients and clear state. */
  stop(): void {
    for (const client of this.clients.values()) {
      try { client.close(1001, "Server shutting down"); } catch { /* ignore */ }
    }
    this.clients.clear();
    this.methodHandlers.clear();
    this.idempotencyCache.clear();
    process.stdout.write("[ProtocolHandler] Stopped");
  }
}