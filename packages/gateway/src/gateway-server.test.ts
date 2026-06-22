import { describe, it, expect, beforeEach, vi } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { GatewayServer } from "./gateway-server";

describe("GatewayServer", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let gateway: GatewayServer;

  beforeEach(() => {
    // 防止前面测试文件 stub 了 global.fetch 后未恢复，导致本文件使用真实 HTTP 请求失败
    vi.unstubAllGlobals();
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    gateway = new GatewayServer(registry, eventBus);
  });

  it("aggregated health should report subsystems before start", () => {
    const health = gateway.getAggregatedHealth();
    expect(health.status).toBe("unhealthy");
    expect(health.subsystems.http.status).toBe("unhealthy");
    expect(health.subsystems.websocket.status).toBe("degraded");
    expect(health.subsystems.protocol.status).toBe("healthy");
  });

  it("aggregated health should reflect channel manager status", () => {
    registry.registerService("channelManager", {
      getAllStatuses: () => [
        { type: "webchat", enabled: true, connected: true },
        { type: "telegram", enabled: true, connected: false },
      ],
    });

    const health = gateway.getAggregatedHealth();
    expect(health.subsystems.channels.status).toBe("degraded");
    expect(health.subsystems.channels.details).toMatchObject({
      enabled: 2,
      connected: 1,
    });
  });

  it("should start and stop gracefully", async () => {
    gateway.configure({ port: 0, host: "127.0.0.1", enableWS: false, shutdownTimeoutMs: 2000 });
    await gateway.start();

    const health = gateway.getAggregatedHealth();
    expect(health.status).toBe("degraded"); // ws disabled => degraded
    expect(health.subsystems.http.status).toBe("healthy");

    await gateway.stop();

    const afterStop = gateway.getAggregatedHealth();
    expect(afterStop.subsystems.http.status).toBe("unhealthy");
  });

  it("/health endpoint should include subsystems", async () => {
    gateway.configure({ port: 0, host: "127.0.0.1", enableWS: false, shutdownTimeoutMs: 2000 });
    await gateway.start();

    try {
      const address = (gateway as any).server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.subsystems).toBeDefined();
      expect(body.subsystems.http).toBeDefined();
      expect(body.subsystems.channels).toBeDefined();
    } finally {
      await gateway.stop();
    }
  });
});
