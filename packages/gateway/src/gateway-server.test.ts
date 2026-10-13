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

  it("P1-1 Bot Mode：/api/config/avatars 支持 botByAgent 与 ?agentId 查询", async () => {
    gateway.configure({ port: 0, host: "127.0.0.1", enableWS: false, shutdownTimeoutMs: 2000 });
    await gateway.start();

    try {
      const address = (gateway as any).server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      // 1. PUT 写入 botByAgent
      const putRes = await fetch(`http://127.0.0.1:${port}/api/config/avatars`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatars: { botByAgent: { coder: "assets/images/coder.png" } } }),
      });
      expect(putRes.status).toBe(200);
      const putBody = await putRes.json();
      expect(putBody.avatars.botByAgent).toEqual({ coder: "assets/images/coder.png" });

      // 2. GET ?agentId=coder 命中专属头像
      const res = await fetch(`http://127.0.0.1:${port}/api/config/avatars?agentId=coder`);
      const body = await res.json();
      expect(body.agentId).toBe("coder");
      expect(body.avatar).toBe("assets/images/coder.png");

      // 3. GET ?agentId=unknown 回退 bot 头像
      const res2 = await fetch(`http://127.0.0.1:${port}/api/config/avatars?agentId=unknown`);
      const body2 = await res2.json();
      expect(body2.avatar).toBeNull();
      expect(body2.fallback).toBe(putBody.avatars.bot);

      // 4. 普通 GET 仍返回全量 avatars（向后兼容）
      const res3 = await fetch(`http://127.0.0.1:${port}/api/config/avatars`);
      const body3 = await res3.json();
      expect(body3.avatars.botByAgent).toEqual({ coder: "assets/images/coder.png" });

      // 5. 原型污染键被过滤
      const putRes2 = await fetch(`http://127.0.0.1:${port}/api/config/avatars`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatars: { botByAgent: { "__proto__": "evil", admin: "assets/images/admin.png" } } }),
      });
      const putBody2 = await putRes2.json();
      expect(putBody2.avatars.botByAgent).toEqual({ coder: "assets/images/coder.png", admin: "assets/images/admin.png" });
      // __proto__ 键应被过滤，不能作为自有属性存在
      expect(Object.prototype.hasOwnProperty.call(putBody2.avatars.botByAgent, "__proto__")).toBe(false);
    } finally {
      await gateway.stop();
    }
  });
});
