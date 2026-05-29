import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, Server } from "http";
import { WebSocket } from "ws";
import { ProtocolHandler } from "./ws-protocol";
import { WSServerTransport } from "./ws-server-transport";

describe("WSServerTransport", () => {
  let server: Server;
  let protocolHandler: ProtocolHandler;
  let transport: WSServerTransport;
  let port: number;

  const mockEventBus = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };

  beforeEach(async () => {
    protocolHandler = new ProtocolHandler({
      serverVersion: "test-0.1",
      authToken: "test-secret",
      autoApproveLoopback: true,
    });
    protocolHandler.setEventBus(mockEventBus as any);

    transport = new WSServerTransport(protocolHandler, mockEventBus as any);

    server = createServer();
    transport.attach(server);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    transport.detach();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connectWS(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  function waitForMessage(ws: WebSocket, timeout = 3000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Message timeout")), timeout);
      ws.once("message", (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
    });
  }

  it("should accept WebSocket connections at /ws", async () => {
    const ws = await connectWS();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("should track connected clients", async () => {
    expect(transport.getConnectedCount()).toBe(0);

    const ws1 = await connectWS();
    await new Promise((r) => setTimeout(r, 100));
    expect(transport.getConnectedCount()).toBe(1);

    const ws2 = await connectWS();
    await new Promise((r) => setTimeout(r, 100));
    expect(transport.getConnectedCount()).toBe(2);

    ws1.close();
    ws2.close();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("should complete connect handshake for loopback with auth token", async () => {
    const ws = await connectWS();

    ws.send(JSON.stringify({
      type: "connect",
      params: { auth: { token: "test-secret" }, role: "client" },
    }));

    const response = await waitForMessage(ws);
    expect(response.type).toBe("hello-ok");
    expect(response.serverVersion).toBe("test-0.1");
    expect(response.features.methods).toContain("health");
    expect(response.features.events).toContain("agent");

    ws.close();
  });

  it("should reject invalid auth token for non-loopback", async () => {
    const nonLoopbackHandler = new ProtocolHandler({
      serverVersion: "test-0.1",
      authToken: "test-secret",
      autoApproveLoopback: false,
    });
    nonLoopbackHandler.setEventBus(mockEventBus as any);

    const nonLoopbackTransport = new WSServerTransport(nonLoopbackHandler, mockEventBus as any);
    const separateServer = createServer();
    nonLoopbackTransport.attach(separateServer);

    const separatePort = await new Promise<number>((resolve) => {
      separateServer.listen(0, "127.0.0.1", () => {
        const addr = separateServer.address();
        if (addr && typeof addr === "object") resolve(addr.port);
      });
    });

    const ws = new WebSocket(`ws://127.0.0.1:${separatePort}/ws`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    ws.send(JSON.stringify({
      type: "connect",
      params: { auth: { token: "wrong-token" }, role: "client" },
    }));

    const response = await waitForMessage(ws);
    expect(response.type).toBe("hello-error");
    expect(response.code).toBe("auth_failed");

    ws.close();
    nonLoopbackTransport.detach();
    await new Promise<void>((resolve) => separateServer.close(() => resolve()));
  });

  it("should handle req/res after handshake", async () => {
    protocolHandler.registerMethod("health", async () => ({
      status: "ok",
      timestamp: new Date().toISOString(),
    }));

    const ws = await connectWS();

    ws.send(JSON.stringify({
      type: "connect",
      params: { auth: { token: "test-secret" } },
    }));
    await waitForMessage(ws);

    ws.send(JSON.stringify({
      type: "req",
      id: "req-1",
      method: "health",
      params: {},
    }));

    const response = await waitForMessage(ws);
    expect(response.type).toBe("res");
    expect(response.id).toBe("req-1");
    expect(response.ok).toBe(true);
    expect(response.payload.status).toBe("ok");

    ws.close();
  });

  it("should close connection when request sent before handshake", async () => {
    const ws = await connectWS();

    ws.send(JSON.stringify({
      type: "req",
      id: "req-early",
      method: "health",
      params: {},
    }));

    await new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
    });
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("should require idempotency key for side-effecting methods", async () => {
    const ws = await connectWS();

    ws.send(JSON.stringify({
      type: "connect",
      params: { auth: { token: "test-secret" } },
    }));
    await waitForMessage(ws);

    ws.send(JSON.stringify({
      type: "req",
      id: "req-2",
      method: "agent",
      params: { message: "hello" },
    }));

    const response = await waitForMessage(ws);
    expect(response.type).toBe("res");
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("missing_idempotency_key");

    ws.close();
  });

  it("should broadcast events to connected clients", async () => {
    const ws1 = await connectWS();
    const ws2 = await connectWS();

    ws1.send(JSON.stringify({
      type: "connect",
      params: { auth: { token: "test-secret" } },
    }));
    await waitForMessage(ws1);

    ws2.send(JSON.stringify({
      type: "connect",
      params: { auth: { token: "test-secret" } },
    }));
    await waitForMessage(ws2);

    const msgPromise1 = waitForMessage(ws1);
    const msgPromise2 = waitForMessage(ws2);

    protocolHandler.broadcast("test-event", { hello: "world" });

    const [msg1, msg2] = await Promise.all([msgPromise1, msgPromise2]);
    expect(msg1.type).toBe("event");
    expect(msg1.event).toBe("test-event");
    expect(msg1.payload).toEqual({ hello: "world" });
    expect(msg2.type).toBe("event");
    expect(msg2.event).toBe("test-event");

    ws1.close();
    ws2.close();
  });

  it("should handle client disconnect gracefully", async () => {
    const ws = await connectWS();
    await new Promise((r) => setTimeout(r, 100));

    expect(transport.getConnectedCount()).toBe(1);

    ws.close();
    await new Promise((r) => setTimeout(r, 200));

    expect(transport.getConnectedCount()).toBe(0);
  });

  it("should reject binary frames", async () => {
    const ws = await connectWS();

    ws.send(Buffer.from([0x00, 0x01, 0x02]));

    await new Promise((r) => setTimeout(r, 200));
    expect(ws.readyState).not.toBe(WebSocket.OPEN);

    ws.close();
  });

  it("should reject invalid JSON frames", async () => {
    const ws = await connectWS();

    ws.send("not-json{{{");

    await new Promise((r) => setTimeout(r, 200));
    expect(ws.readyState).not.toBe(WebSocket.OPEN);

    ws.close();
  });

  it("should detach cleanly", async () => {
    const ws = await connectWS();
    await new Promise((r) => setTimeout(r, 100));

    transport.detach();
    await new Promise((r) => setTimeout(r, 200));

    expect(ws.readyState).not.toBe(WebSocket.OPEN);
    expect(transport.getConnectedCount()).toBe(0);
  });

  it("should handle node role with capabilities", async () => {
    const ws = await connectWS();

    ws.send(JSON.stringify({
      type: "connect",
      params: {
        auth: { token: "test-secret" },
        role: "node",
        deviceId: "test-device-001",
        caps: ["camera", "screen"],
        commands: ["capture", "record"],
      },
    }));

    const response = await waitForMessage(ws);
    expect(response.type).toBe("hello-ok");
    expect(response.features.methods).toContain("camera.capture");
    expect(response.features.methods).toContain("screen.record");

    ws.close();
  });

  it("should handle multiple sequential requests", async () => {
    let callCount = 0;
    protocolHandler.registerMethod("health", async () => {
      callCount++;
      return { call: callCount };
    });

    const ws = await connectWS();

    ws.send(JSON.stringify({
      type: "connect",
      params: { auth: { token: "test-secret" } },
    }));
    await waitForMessage(ws);

    for (let i = 1; i <= 3; i++) {
      ws.send(JSON.stringify({
        type: "req",
        id: `req-${i}`,
        method: "health",
        params: {},
      }));

      const response = await waitForMessage(ws);
      expect(response.type).toBe("res");
      expect(response.ok).toBe(true);
      expect(response.payload.call).toBe(i);
    }

    ws.close();
  });
});
