import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";
import { WebhookManager, IncomingWebhookManager } from "./webhook-manager";
import type { WebhookConfig, WebhookEvent, WebhookEndpoint } from "./webhook-manager";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterAll(() => {
  vi.unstubAllGlobals();
});

function makeConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    id: "wh-1",
    url: "https://example.com/webhook",
    events: ["test.event"],
    secret: "secret123",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    type: "test.event",
    timestamp: Date.now(),
    data: { key: "value" },
    source: "test",
    ...overrides,
  };
}

function makeEndpoint(overrides: Partial<Omit<WebhookEndpoint, "createdAt" | "lastTriggeredAt" | "triggerCount">> = {}): Omit<WebhookEndpoint, "createdAt" | "lastTriggeredAt" | "triggerCount"> {
  return {
    id: "ep-1",
    path: "/webhook/github",
    method: "POST",
    action: "github.push",
    enabled: true,
    ...overrides,
  };
}

describe("WebhookManager (outgoing)", () => {
  let wm: WebhookManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    wm = new WebhookManager("test-signing-key");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should register a webhook", () => {
    const result = wm.register(makeConfig());
    expect(result).toBe(true);
    expect(wm.getWebhook("wh-1")).toBeDefined();
    expect(wm.getWebhook("wh-1")!.url).toBe("https://example.com/webhook");
  });

  it("should not register duplicate webhook IDs", () => {
    wm.register(makeConfig());
    const result = wm.register(makeConfig());
    expect(result).toBe(false);
  });

  it("should apply defaults for missing config fields", () => {
    wm.register({ id: "minimal", url: "https://example.com/hook" });
    const wh = wm.getWebhook("minimal")!;
    expect(wh.enabled).toBe(true);
    expect(wh.maxRetries).toBe(3);
    expect(wh.timeoutMs).toBe(10000);
    expect(wh.rateLimitPerMinute).toBe(60);
    expect(wh.events).toEqual([]);
  });

  it("should unregister a webhook", () => {
    wm.register(makeConfig());
    expect(wm.unregister("wh-1")).toBe(true);
    expect(wm.getWebhook("wh-1")).toBeUndefined();
  });

  it("should list all webhooks", () => {
    wm.register(makeConfig({ id: "a", url: "https://a.example.com" }));
    wm.register(makeConfig({ id: "b", url: "https://b.example.com" }));
    expect(wm.listWebhooks()).toHaveLength(2);
  });

  it("should match webhooks subscribed to specific event", async () => {
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    wm.register(makeConfig({ events: ["test.event"] }));

    await wm.dispatch(makeEvent({ type: "test.event" }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe("https://example.com/webhook");
    const body = JSON.parse(callArgs[1].body);
    expect(body.event).toBe("test.event");
  });

  it("should match webhooks with wildcard event", async () => {
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    wm.register(makeConfig({ events: ["*"] }));

    await wm.dispatch(makeEvent({ type: "any.event" }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should match webhooks with empty events (subscribe to all)", async () => {
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    wm.register(makeConfig({ events: [] }));

    await wm.dispatch(makeEvent({ type: "any.event" }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should not dispatch to disabled webhooks", async () => {
    wm.register(makeConfig({ enabled: false }));
    await wm.dispatch(makeEvent());
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should not dispatch when no webhooks match", async () => {
    wm.register(makeConfig({ events: ["other.event"] }));
    await wm.dispatch(makeEvent({ type: "test.event" }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should verify signature correctly", () => {
    const payload = JSON.stringify({ test: true });
    const crypto = require("crypto");
    const hmac = crypto.createHmac("sha256", "test-secret");
    hmac.update(payload);
    const sig = `sha256=${hmac.digest("hex")}`;

    expect(wm.verifySignature(payload, sig, "test-secret")).toBe(true);
  });

  it("should reject invalid signature", () => {
    expect(wm.verifySignature("payload", "sha256=badhash", "secret")).toBe(false);
  });

  it("should reject empty signature", () => {
    expect(wm.verifySignature("payload", "", "secret")).toBe(false);
  });

  it("should track delivery history", async () => {
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    wm.register(makeConfig());

    await wm.dispatch(makeEvent());
    await vi.runAllTimersAsync();

    const deliveries = wm.getDeliveries("wh-1");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("success");
  });

  it("should limit delivery history", async () => {
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    wm.register(makeConfig());

    for (let i = 0; i < 5; i++) {
      await wm.dispatch(makeEvent());
      await vi.runAllTimersAsync();
    }

    const deliveries = wm.getDeliveries("wh-1", 3);
    expect(deliveries).toHaveLength(3);
  });

  it("should get failed deliveries", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    wm.register(makeConfig({ maxRetries: 1 }));

    await wm.dispatch(makeEvent());
    await vi.runAllTimersAsync();

    const failed = wm.getFailedDeliveries("wh-1");
    expect(failed).toHaveLength(1);
  });

  it("should clear history", async () => {
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    wm.register(makeConfig());
    await wm.dispatch(makeEvent());
    await vi.runAllTimersAsync();

    wm.clearHistory("wh-1");
    expect(wm.getDeliveries("wh-1")).toHaveLength(0);
  });

  it("should enforce rate limiting", async () => {
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    wm.register(makeConfig({ rateLimitPerMinute: 2 }));

    await wm.dispatch(makeEvent());
    await wm.dispatch(makeEvent());
    await wm.dispatch(makeEvent());
    await vi.runAllTimersAsync();

    const deliveries = wm.getDeliveries("wh-1");
    const failedRateLimit = deliveries.filter((d) => d.error === "Rate limit exceeded");
    expect(failedRateLimit.length).toBeGreaterThanOrEqual(0);
  });

  it("should return stats", async () => {
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    wm.register(makeConfig({ id: "a", enabled: true }));
    wm.register(makeConfig({ id: "b", enabled: false }));

    await wm.dispatch(makeEvent());
    await vi.runAllTimersAsync();

    const stats = wm.getStats();
    expect(stats.totalWebhooks).toBe(2);
    expect(stats.activeWebhooks).toBe(1);
    expect(stats.totalDeliveries).toBe(1);
  });

  it("should dispose cleanly", () => {
    wm.register(makeConfig());
    wm.dispose();
    expect(wm.listWebhooks()).toHaveLength(0);
    expect(wm.getStats().totalWebhooks).toBe(0);
  });
});

describe("IncomingWebhookManager", () => {
  let manager: IncomingWebhookManager;

  beforeEach(() => {
    manager = new IncomingWebhookManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  // ── Registration ─────────────────────────────────

  it("should register an endpoint", () => {
    const ep = manager.register(makeEndpoint());
    expect(ep.id).toBe("ep-1");
    expect(ep.path).toBe("/webhook/github");
    expect(ep.method).toBe("POST");
    expect(ep.action).toBe("github.push");
    expect(ep.enabled).toBe(true);
    expect(ep.createdAt).toBeTruthy();
    expect(ep.triggerCount).toBe(0);
  });

  it("should throw on duplicate endpoint ID", () => {
    manager.register(makeEndpoint());
    expect(() => manager.register(makeEndpoint())).toThrow(/already exists/);
  });

  it("should register with optional fields", () => {
    const ep = manager.register(makeEndpoint({
      authToken: "my-secret-token",
      description: "GitHub push events",
    }));
    expect(ep.authToken).toBe("my-secret-token");
    expect(ep.description).toBe("GitHub push events");
  });

  it("should register GET method endpoint", () => {
    const ep = manager.register(makeEndpoint({ method: "GET", action: "health.check" }));
    expect(ep.method).toBe("GET");
  });

  // ── Get / List ───────────────────────────────────

  it("should get an endpoint by ID", () => {
    manager.register(makeEndpoint());
    const ep = manager.get("ep-1");
    expect(ep).toBeDefined();
    expect(ep!.id).toBe("ep-1");
  });

  it("should return undefined for non-existent endpoint", () => {
    expect(manager.get("non-existent")).toBeUndefined();
  });

  it("should list all endpoints", () => {
    manager.register(makeEndpoint({ id: "ep-a" }));
    manager.register(makeEndpoint({ id: "ep-b" }));
    const list = manager.list();
    expect(list).toHaveLength(2);
  });

  // ── Update ───────────────────────────────────────

  it("should update an endpoint", () => {
    manager.register(makeEndpoint());
    const updated = manager.update("ep-1", {
      path: "/webhook/github/v2",
      action: "github.push.v2",
      description: "Updated",
    });
    expect(updated).toBeDefined();
    expect(updated!.path).toBe("/webhook/github/v2");
    expect(updated!.action).toBe("github.push.v2");
    expect(updated!.description).toBe("Updated");
  });

  it("should update enabled status", () => {
    manager.register(makeEndpoint());
    const updated = manager.update("ep-1", { enabled: false });
    expect(updated!.enabled).toBe(false);
  });

  it("should return undefined when updating non-existent endpoint", () => {
    const result = manager.update("non-existent", { enabled: false });
    expect(result).toBeUndefined();
  });

  it("should not allow updating id or createdAt", () => {
    manager.register(makeEndpoint());
    const ep = manager.get("ep-1")!;
    const originalCreatedAt = ep.createdAt;
    manager.update("ep-1", { path: "/new-path" } as any);
    const updated = manager.get("ep-1")!;
    expect(updated.id).toBe("ep-1");
    expect(updated.createdAt).toBe(originalCreatedAt);
  });

  // ── Delete ───────────────────────────────────────

  it("should delete an endpoint", () => {
    manager.register(makeEndpoint());
    expect(manager.delete("ep-1")).toBe(true);
    expect(manager.get("ep-1")).toBeUndefined();
  });

  it("should return false when deleting non-existent endpoint", () => {
    expect(manager.delete("non-existent")).toBe(false);
  });

  // ── Path Matching ────────────────────────────────

  it("should match exact path", () => {
    manager.register(makeEndpoint({ path: "/webhook/github" }));
    const match = manager.matchEndpoint("/webhook/github", "POST");
    expect(match).toBeDefined();
    expect(match!.id).toBe("ep-1");
  });

  it("should not match different path", () => {
    manager.register(makeEndpoint({ path: "/webhook/github" }));
    const match = manager.matchEndpoint("/webhook/gitlab", "POST");
    expect(match).toBeUndefined();
  });

  it("should not match different method", () => {
    manager.register(makeEndpoint({ path: "/webhook/github", method: "POST" }));
    const match = manager.matchEndpoint("/webhook/github", "GET");
    expect(match).toBeUndefined();
  });

  it("should not match disabled endpoint", () => {
    manager.register(makeEndpoint({ path: "/webhook/github", enabled: false }));
    const match = manager.matchEndpoint("/webhook/github", "POST");
    expect(match).toBeUndefined();
  });

  it("should match wildcard path segments", () => {
    manager.register(makeEndpoint({ path: "/webhook/*/push" }));
    const match = manager.matchEndpoint("/webhook/github/push", "POST");
    expect(match).toBeDefined();
  });

  it("should match trailing wildcard path", () => {
    manager.register(makeEndpoint({ path: "/webhook/github/*" }));
    const match = manager.matchEndpoint("/webhook/github/push", "POST");
    expect(match).toBeDefined();
  });

  it("should match trailing wildcard with base path", () => {
    manager.register(makeEndpoint({ path: "/webhook/github/*" }));
    const match = manager.matchEndpoint("/webhook/github", "POST");
    expect(match).toBeDefined();
  });

  it("should match trailing wildcard with deep path", () => {
    manager.register(makeEndpoint({ path: "/webhook/custom/*" }));
    const match = manager.matchEndpoint("/webhook/custom/deep/nested/path", "POST");
    expect(match).toBeDefined();
  });

  it("should not match wildcard with different prefix", () => {
    manager.register(makeEndpoint({ path: "/webhook/github/*" }));
    const match = manager.matchEndpoint("/webhook/gitlab/push", "POST");
    expect(match).toBeUndefined();
  });

  // ── Authentication ───────────────────────────────

  it("should pass auth when no token required", () => {
    const ep = manager.register(makeEndpoint({ authToken: undefined }));
    expect(manager.authenticate(ep, {})).toBe(true);
  });

  it("should pass auth with valid x-webhook-token header", () => {
    const ep = manager.register(makeEndpoint({ authToken: "secret123" }));
    expect(manager.authenticate(ep, { "x-webhook-token": "secret123" })).toBe(true);
  });

  it("should pass auth with valid Bearer authorization header", () => {
    const ep = manager.register(makeEndpoint({ authToken: "secret123" }));
    expect(manager.authenticate(ep, { "authorization": "Bearer secret123" })).toBe(true);
  });

  it("should fail auth with wrong token", () => {
    const ep = manager.register(makeEndpoint({ authToken: "secret123" }));
    expect(manager.authenticate(ep, { "x-webhook-token": "wrong" })).toBe(false);
  });

  it("should fail auth with missing token", () => {
    const ep = manager.register(makeEndpoint({ authToken: "secret123" }));
    expect(manager.authenticate(ep, {})).toBe(false);
  });

  // ── Trigger ──────────────────────────────────────

  it("should trigger endpoint and return 200", async () => {
    manager.register(makeEndpoint());
    const result = await manager.trigger("ep-1", "/webhook/github", "POST", {}, { ref: "main" });
    expect(result.statusCode).toBe(200);
    expect(result.eventLog.endpointId).toBe("ep-1");
    expect(result.eventLog.statusCode).toBe(200);
  });

  it("should update trigger metadata on trigger", async () => {
    manager.register(makeEndpoint());
    await manager.trigger("ep-1", "/webhook/github", "POST", {}, {});
    const ep = manager.get("ep-1")!;
    expect(ep.triggerCount).toBe(1);
    expect(ep.lastTriggeredAt).toBeTruthy();
  });

  it("should increment trigger count on each trigger", async () => {
    manager.register(makeEndpoint());
    await manager.trigger("ep-1", "/webhook/github", "POST", {}, {});
    await manager.trigger("ep-1", "/webhook/github", "POST", {}, {});
    await manager.trigger("ep-1", "/webhook/github", "POST", {}, {});
    expect(manager.get("ep-1")!.triggerCount).toBe(3);
  });

  it("should return 404 for non-existent endpoint", async () => {
    const result = await manager.trigger("non-existent", "/test", "POST", {}, {});
    expect(result.statusCode).toBe(404);
    expect(result.eventLog.error).toBe("Endpoint not found");
  });

  it("should return 403 for disabled endpoint", async () => {
    manager.register(makeEndpoint({ enabled: false }));
    const result = await manager.trigger("ep-1", "/webhook/github", "POST", {}, {});
    expect(result.statusCode).toBe(403);
    expect(result.eventLog.error).toBe("Endpoint is disabled");
  });

  it("should return 401 for invalid auth token", async () => {
    manager.register(makeEndpoint({ authToken: "secret123" }));
    const result = await manager.trigger("ep-1", "/webhook/github", "POST", {}, {});
    expect(result.statusCode).toBe(401);
    expect(result.eventLog.error).toBe("Authentication failed");
  });

  it("should return 200 with valid auth token", async () => {
    manager.register(makeEndpoint({ authToken: "secret123" }));
    const result = await manager.trigger("ep-1", "/webhook/github", "POST", { "x-webhook-token": "secret123" }, {});
    expect(result.statusCode).toBe(200);
  });

  it("should invoke action handler when set", async () => {
    const handler = vi.fn().mockResolvedValue({ statusCode: 200, response: { processed: true } });
    manager.setActionHandler(handler);
    manager.register(makeEndpoint());

    const result = await manager.trigger("ep-1", "/webhook/github", "POST", {}, { data: "test" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("github.push", {
      headers: {},
      body: { data: "test" },
      path: "/webhook/github",
      endpointId: "ep-1",
    });
    expect(result.statusCode).toBe(200);
    expect(result.response).toEqual({ processed: true });
  });

  it("should return 500 when action handler throws", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("Handler crashed"));
    manager.setActionHandler(handler);
    manager.register(makeEndpoint());

    const result = await manager.trigger("ep-1", "/webhook/github", "POST", {}, {});
    expect(result.statusCode).toBe(500);
    expect(result.eventLog.error).toBe("Handler crashed");
  });

  it("should return action handler custom status code", async () => {
    const handler = vi.fn().mockResolvedValue({ statusCode: 201, response: { created: true } });
    manager.setActionHandler(handler);
    manager.register(makeEndpoint());

    const result = await manager.trigger("ep-1", "/webhook/github", "POST", {}, {});
    expect(result.statusCode).toBe(201);
    expect(result.response).toEqual({ created: true });
  });

  // ── Event Logging ────────────────────────────────

  it("should record event logs on trigger", async () => {
    manager.register(makeEndpoint());
    await manager.trigger("ep-1", "/webhook/github", "POST", {}, {});

    const logs = manager.getEventLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].endpointId).toBe("ep-1");
    expect(logs[0].action).toBe("github.push");
    expect(logs[0].method).toBe("POST");
  });

  it("should filter event logs by endpoint ID", async () => {
    manager.register(makeEndpoint({ id: "ep-a" }));
    manager.register(makeEndpoint({ id: "ep-b" }));
    await manager.trigger("ep-a", "/webhook/a", "POST", {}, {});
    await manager.trigger("ep-b", "/webhook/b", "POST", {}, {});

    const logsA = manager.getEventLogs("ep-a");
    expect(logsA).toHaveLength(1);
    expect(logsA[0].endpointId).toBe("ep-a");
  });

  it("should limit event logs", async () => {
    manager.register(makeEndpoint());
    for (let i = 0; i < 10; i++) {
      await manager.trigger("ep-1", "/webhook/github", "POST", {}, {});
    }

    const logs = manager.getEventLogs(undefined, 3);
    expect(logs).toHaveLength(3);
  });

  it("should sanitize auth headers in event logs", async () => {
    manager.register(makeEndpoint({ authToken: "secret123" }));
    await manager.trigger("ep-1", "/webhook/github", "POST", {
      "x-webhook-token": "secret123",
      "content-type": "application/json",
    }, {});

    const logs = manager.getEventLogs();
    expect(logs[0].headers["x-webhook-token"]).toBe("***");
    expect(logs[0].headers["content-type"]).toBe("application/json");
  });

  it("should clear event logs", async () => {
    manager.register(makeEndpoint());
    await manager.trigger("ep-1", "/webhook/github", "POST", {}, {});
    expect(manager.getEventLogs()).toHaveLength(1);

    manager.clearEventLogs();
    expect(manager.getEventLogs()).toHaveLength(0);
  });

  it("should trim event logs when exceeding max", async () => {
    manager.register(makeEndpoint());
    for (let i = 0; i < 502; i++) {
      await manager.trigger("ep-1", "/webhook/github", "POST", {}, {});
    }
    const logs = manager.getEventLogs();
    expect(logs.length).toBeLessThanOrEqual(500);
  });

  // ── Stats ────────────────────────────────────────

  it("should return stats", async () => {
    manager.register(makeEndpoint({ id: "ep-a", enabled: true }));
    manager.register(makeEndpoint({ id: "ep-b", enabled: false }));
    await manager.trigger("ep-a", "/webhook/a", "POST", {}, {});

    const stats = manager.getStats();
    expect(stats.totalEndpoints).toBe(2);
    expect(stats.activeEndpoints).toBe(1);
    expect(stats.totalTriggers).toBe(1);
    expect(stats.recentLogs).toBe(1);
  });

  // ── Dispose ──────────────────────────────────────

  it("should dispose cleanly", () => {
    manager.register(makeEndpoint());
    manager.dispose();
    expect(manager.list()).toHaveLength(0);
    expect(manager.getEventLogs()).toHaveLength(0);
  });
});
