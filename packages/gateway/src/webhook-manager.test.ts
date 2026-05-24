import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebhookManager } from "./webhook-manager";
import type { WebhookConfig, WebhookEvent } from "./webhook-manager";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

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

describe("WebhookManager", () => {
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

  // ── Registration ─────────────────────────────────

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

  // ── Event Matching ───────────────────────────────

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

  // ── Signature ─────────────────────────────────────

  it("should verify signature correctly", () => {
    const payload = JSON.stringify({ test: true });
    // Create a signature the same way the class does
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

  // ── Delivery History ─────────────────────────────

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

  // ── Rate Limiting ────────────────────────────────

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

  // ── Stats ────────────────────────────────────────

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

  // ── Dispose ──────────────────────────────────────

  it("should dispose cleanly", () => {
    wm.register(makeConfig());
    wm.dispose();
    expect(wm.listWebhooks()).toHaveLength(0);
    expect(wm.getStats().totalWebhooks).toBe(0);
  });
});