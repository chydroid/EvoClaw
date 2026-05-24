import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProtocolHandler, ALLOWED_METHODS } from "./ws-protocol";
import type { WSClient, ProtocolFrame } from "./ws-protocol";

function makeClient(overrides: Partial<WSClient> = {}): WSClient {
  const client: WSClient = {
    id: "client-1",
    role: "client",
    connectedAt: new Date(),
    send: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    remoteAddress: vi.fn().mockReturnValue("127.0.0.1"),
  };
  return { ...client, ...overrides };
}

describe("ProtocolHandler", () => {
  let handler: ProtocolHandler;

  beforeEach(() => {
    handler = new ProtocolHandler({ serverVersion: "0.4.0-test" });
  });

  // ── Connection Management ────────────────────────

  it("should handle new connection", () => {
    const client = makeClient();
    handler.handleConnection(client);
    expect(handler.getConnectionCount()).toBe(1);
  });

  it("should handle disconnection", () => {
    const client = makeClient();
    handler.handleConnection(client);
    handler.handleDisconnect(client.id);
    expect(handler.getConnectionCount()).toBe(0);
  });

  // ── Connect Handshake ────────────────────────────

  it("should complete handshake for loopback client", async () => {
    const client = makeClient();
    handler.handleConnection(client);

    await handler.processFrame(
      client,
      JSON.stringify({
        type: "connect",
        params: { role: "client" },
      })
    );

    expect(client.send).toHaveBeenCalled();
    const response = (client.send as any).mock.calls[0][0];
    expect(response.type).toBe("hello-ok");
    expect(response.serverVersion).toBe("0.4.0-test");
    expect(response.features.methods).toEqual([...ALLOWED_METHODS]);
  });

  it("should reject invalid role", async () => {
    const client = makeClient();
    handler.handleConnection(client);

    await handler.processFrame(
      client,
      JSON.stringify({
        type: "connect",
        params: { role: "admin" },
      })
    );

    expect(client.close).toHaveBeenCalledWith(4003, "Invalid role");
  });

  it("should reject remote connection without auth", async () => {
    const client = makeClient({
      remoteAddress: vi.fn().mockReturnValue("192.168.1.1"),
    });
    handler.handleConnection(client);

    await handler.processFrame(
      client,
      JSON.stringify({
        type: "connect",
        params: {},
      })
    );

    expect(client.close).toHaveBeenCalledWith(4004, "Auth required for remote connections");
  });

  it("should accept remote connection with valid token", async () => {
    const handlerWithAuth = new ProtocolHandler({ authToken: "secret-token" });
    const client = makeClient({
      remoteAddress: vi.fn().mockReturnValue("192.168.1.1"),
    });
    handlerWithAuth.handleConnection(client);

    await handlerWithAuth.processFrame(
      client,
      JSON.stringify({
        type: "connect",
        params: { auth: { token: "secret-token" } },
      })
    );

    expect(client.send).toHaveBeenCalled();
    const response = (client.send as any).mock.calls[0][0];
    expect(response.type).toBe("hello-ok");
  });

  it("should reject invalid token on remote connection", async () => {
    const handlerWithAuth = new ProtocolHandler({ authToken: "secret-token" });
    const client = makeClient({
      remoteAddress: vi.fn().mockReturnValue("192.168.1.1"),
    });
    handlerWithAuth.handleConnection(client);

    await handlerWithAuth.processFrame(
      client,
      JSON.stringify({
        type: "connect",
        params: { auth: { token: "wrong-token" } },
      })
    );

    expect(client.close).toHaveBeenCalledWith(4004, "Auth failed");
  });

  // ── Invalid Frames ───────────────────────────────

  it("should close connection on invalid JSON", async () => {
    const client = makeClient();
    handler.handleConnection(client);

    await handler.processFrame(client, "not-json{");

    expect(client.close).toHaveBeenCalledWith(4000, "Invalid JSON frame");
  });

  it("should require connect handshake before other frames", async () => {
    const client = makeClient();
    handler.handleConnection(client);

    await handler.processFrame(
      client,
      JSON.stringify({
        type: "req",
        id: "1",
        method: "health",
        params: {},
      })
    );

    expect(client.close).toHaveBeenCalledWith(4001, "Connect handshake required");
  });

  // ── Request Handling ─────────────────────────────

  it("should handle registered method", async () => {
    const client = makeClient();
    handler.handleConnection(client);

    // Complete handshake first
    await handler.processFrame(client, JSON.stringify({ type: "connect", params: {} }));

    handler.registerMethod("health", async () => ({ status: "ok" }));

    await handler.processFrame(
      client,
      JSON.stringify({
        type: "req",
        id: "req-1",
        method: "health",
        params: {},
      })
    );

    const calls = (client.send as any).mock.calls;
    // First call is hello-ok, second is response
    const resFrame = calls.find((c: any) => c[0].type === "res");
    expect(resFrame).toBeDefined();
    expect(resFrame[0].ok).toBe(true);
    expect(resFrame[0].payload).toEqual({ status: "ok" });
  });

  it("should reject unknown method", async () => {
    const client = makeClient();
    handler.handleConnection(client);
    await handler.processFrame(client, JSON.stringify({ type: "connect", params: {} }));

    await handler.processFrame(
      client,
      JSON.stringify({
        type: "req",
        id: "req-1",
        method: "unknown.method",
        params: {},
      })
    );

    const calls = (client.send as any).mock.calls;
    const errorRes = calls.find(
      (c: any) => c[0].type === "res" && c[0].ok === false
    );
    expect(errorRes).toBeDefined();
    expect(errorRes[0].error.code).toBe("unknown_method");
  });

  it("should return not_implemented for known but unregistered method", async () => {
    const client = makeClient();
    handler.handleConnection(client);
    await handler.processFrame(client, JSON.stringify({ type: "connect", params: {} }));

    await handler.processFrame(
      client,
      JSON.stringify({
        type: "req",
        id: "req-1",
        method: "health",
        params: {},
      })
    );

    const calls = (client.send as any).mock.calls;
    const errorRes = calls.find(
      (c: any) => c[0].type === "res" && c[0].error?.code === "not_implemented"
    );
    expect(errorRes).toBeDefined();
  });

  // ── Idempotency ──────────────────────────────────

  it("should require idempotency key for side-effecting methods", async () => {
    const client = makeClient();
    handler.handleConnection(client);
    await handler.processFrame(client, JSON.stringify({ type: "connect", params: {} }));

    await handler.processFrame(
      client,
      JSON.stringify({
        type: "req",
        id: "req-1",
        method: "agent",
        params: {},
        // missing idempotencyKey
      })
    );

    const calls = (client.send as any).mock.calls;
    const errorRes = calls.find(
      (c: any) => c[0].error?.code === "missing_idempotency_key"
    );
    expect(errorRes).toBeDefined();
  });

  it("should cache and return idempotent responses", async () => {
    const client = makeClient();
    handler.handleConnection(client);
    await handler.processFrame(client, JSON.stringify({ type: "connect", params: {} }));

    let callCount = 0;
    handler.registerMethod("agent", async () => {
      callCount++;
      return { result: "done" };
    });

    // First request
    await handler.processFrame(
      client,
      JSON.stringify({
        type: "req",
        id: "req-1",
        method: "agent",
        params: {},
        idempotencyKey: "idem-1",
      })
    );

    // Second request with same key
    await handler.processFrame(
      client,
      JSON.stringify({
        type: "req",
        id: "req-2",
        method: "agent",
        params: {},
        idempotencyKey: "idem-1",
      })
    );

    // Handler should only be called once
    expect(callCount).toBe(1);
  });

  // ── Broadcasting ─────────────────────────────────

  it("should broadcast event to all connected clients", () => {
    const c1 = makeClient({ id: "c1" });
    const c2 = makeClient({ id: "c2" });
    handler.handleConnection(c1);
    handler.handleConnection(c2);

    handler.broadcast("test.event", { data: "hello" });

    expect(c1.send).toHaveBeenCalled();
    expect(c2.send).toHaveBeenCalled();

    const frame1 = (c1.send as any).mock.calls.find(
      (c: any) => c[0].type === "event"
    );
    expect(frame1).toBeDefined();
    expect(frame1[0].event).toBe("test.event");
    expect(frame1[0].payload).toEqual({ data: "hello" });
    expect(frame1[0].seq).toBe(1);
  });

  it("should increment sequence numbers", () => {
    const client = makeClient();
    handler.handleConnection(client);

    handler.broadcast("e1", {});
    handler.broadcast("e2", {});

    const calls = (client.send as any).mock.calls.filter(
      (c: any) => c[0].type === "event"
    );
    expect(calls[0][0].seq).toBe(1);
    expect(calls[1][0].seq).toBe(2);
  });

  it("should send event to specific client", () => {
    const c1 = makeClient({ id: "c1" });
    const c2 = makeClient({ id: "c2" });
    handler.handleConnection(c1);
    handler.handleConnection(c2);

    const result = handler.sendToClient("c1", "private.event", { secret: true });
    expect(result).toBe(true);
    expect(c1.send).toHaveBeenCalled();
  });

  it("should return false when sending to unknown client", () => {
    const result = handler.sendToClient("unknown", "event", {});
    expect(result).toBe(false);
  });

  it("should send to matching clients via filter", () => {
    const c1 = makeClient({ id: "c1" });
    const c2 = makeClient({ id: "c2" });
    handler.handleConnection(c1);
    handler.handleConnection(c2);

    handler.sendToMatching(
      (c) => c.id === "c1",
      "filtered.event",
      {}
    );

    expect(c1.send).toHaveBeenCalled();
    expect(c2.send).not.toHaveBeenCalled();
  });

  // ── Diagnostics ──────────────────────────────────

  it("should list connected clients", () => {
    handler.handleConnection(makeClient({ id: "a" }));
    handler.handleConnection(makeClient({ id: "b" }));

    const clients = handler.getConnectedClients();
    expect(clients).toHaveLength(2);
    expect(clients[0].id).toBeDefined();
  });

  it("should clean up idempotency cache", async () => {
    const client = makeClient();
    handler.handleConnection(client);
    await handler.processFrame(client, JSON.stringify({ type: "connect", params: {} }));

    handler.registerMethod("agent", async () => ({ result: "ok" }));

    await handler.processFrame(
      client,
      JSON.stringify({
        type: "req",
        id: "r1",
        method: "agent",
        params: {},
        idempotencyKey: "old-key",
      })
    );

    // With default 5min TTL, cleanup shouldn't touch recent entries
    handler.cleanupIdempotencyCache();
    // The entry should still be there (we can verify by sending same key again)
  });

  // ── Error Handling in Handlers ───────────────────

  it("should return error response when handler throws", async () => {
    const client = makeClient();
    handler.handleConnection(client);
    await handler.processFrame(client, JSON.stringify({ type: "connect", params: {} }));

    handler.registerMethod("health", async () => {
      throw new Error("Service unavailable");
    });

    await handler.processFrame(
      client,
      JSON.stringify({
        type: "req",
        id: "req-1",
        method: "health",
        params: {},
      })
    );

    const calls = (client.send as any).mock.calls;
    const errorRes = calls.find(
      (c: any) => c[0].type === "res" && c[0].ok === false && c[0].error?.code === "internal_error"
    );
    expect(errorRes).toBeDefined();
    expect(errorRes[0].error.message).toBe("Service unavailable");
  });
});