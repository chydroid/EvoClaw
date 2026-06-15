// v0.35 提升 - Gateway package综合测试
import { describe, it, expect, beforeEach } from "vitest";
import {
  GatewayMetadataCache,
  DEFAULT_MODEL_COSTS,
  DispatchDedupeStore,
  ReactionApprovalHandler,
} from "./index";

describe("DispatchDedupeStore", () => {
  let store: DispatchDedupeStore;
  beforeEach(() => {
    store = new DispatchDedupeStore();
  });

  it("should detect first dispatch", () => {
    const dispatched = store.isDispatched({ channel: "telegram", externalId: "msg-1" });
    expect(dispatched).toBe(false);
    store.record({ channel: "telegram", externalId: "msg-1" }, "hash1");
    const dispatched2 = store.isDispatched({ channel: "telegram", externalId: "msg-1" });
    expect(dispatched2).toBe(true);
  });

  it("should track attempts", () => {
    store.record({ channel: "telegram", externalId: "m1" }, "h1");
    const e2 = store.record({ channel: "telegram", externalId: "m1" }, "h1");
    expect(e2.attempt).toBe(2);
  });

  it("should generate consistent keys", () => {
    const k1 = DispatchDedupeStore.generateKey({ channel: "c", externalId: "x" });
    const k2 = DispatchDedupeStore.generateKey({ channel: "c", externalId: "x" });
    expect(k1).toBe(k2);
  });

  it("should filter by channel", () => {
    store.record({ channel: "telegram", externalId: "m1" }, "h1");
    store.record({ channel: "discord", externalId: "m2" }, "h2");
    const list = store.list({ channel: "telegram" });
    expect(list.length).toBe(1);
    expect(list[0].channel).toBe("telegram");
  });
});

describe("ReactionApprovalHandler", () => {
  let handler: ReactionApprovalHandler;
  beforeEach(() => {
    handler = new ReactionApprovalHandler();
  });

  it("should create request with default emojis", () => {
    const req = handler.createRequest({
      channel: "telegram",
      messageId: "m1",
      conversationId: "c1",
      userId: "u1",
      approvalType: "tool_execution",
      description: "Execute shell command",
      promptText: "Allow?",
      context: {},
    });
    expect(req.approveEmoji).toBe("👍");
    expect(req.denyEmoji).toBe("👎");
  });

  it("should handle approve reaction", async () => {
    const req = handler.createRequest({
      channel: "signal",
      messageId: "m1",
      conversationId: "c1",
      userId: "u1",
      approvalType: "send_message",
      description: "Send message",
      promptText: "Allow?",
      context: {},
    });
    const result = await handler.handleReaction("signal", "m1", "u1", "✅");
    expect(result.handled).toBe(true);
    expect(result.decision).toBe("approved");
  });

  it("should handle deny reaction", async () => {
    const req = handler.createRequest({
      channel: "whatsapp",
      messageId: "m1",
      conversationId: "c1",
      userId: "u1",
      approvalType: "delete_data",
      description: "Delete data",
      promptText: "Allow?",
      context: {},
    });
    const result = await handler.handleReaction("whatsapp", "m1", "u1", "🛑");
    expect(result.decision).toBe("denied");
  });

  it("should ignore reactions from other users", async () => {
    handler.createRequest({
      channel: "telegram",
      messageId: "m1",
      conversationId: "c1",
      userId: "u1",
      approvalType: "tool_execution",
      description: "test",
      promptText: "Allow?",
      context: {},
    });
    const result = await handler.handleReaction("telegram", "m1", "u2", "👍");
    expect(result.handled).toBe(false);
  });

  it("should expire on timeout", async () => {
    const onDecision = (req: any, decision: string) => {
      expect(decision).toBe("expired");
    };
    const h = new ReactionApprovalHandler({
      defaultTimeoutMs: 50,
      onDecision,
    });
    h.createRequest({
      channel: "imessage",
      messageId: "m1",
      conversationId: "c1",
      userId: "u1",
      approvalType: "tool_execution",
      description: "test",
      promptText: "Allow?",
      context: {},
    });
    await new Promise((r) => setTimeout(r, 100));
    const stats = h.getStats();
    expect(stats.expired).toBe(1);
  });
});

describe("GatewayMetadataCache", () => {
  it("should support model cost index", () => {
    const cache = new GatewayMetadataCache();
    cache.setModelCostBatch(DEFAULT_MODEL_COSTS);
    expect(cache.getModelCost("openai", "gpt-4")).toBeDefined();
    expect(cache.getModelCost("openai", "gpt-4")?.inputCostPer1k).toBe(0.03);
  });

  it("should support channel resolution cache", () => {
    const cache = new GatewayMetadataCache();
    cache.cacheChannelResolution("telegram", "user-123", { chatId: 12345 });
    expect(cache.getChannelResolution<{ chatId: number }>("telegram", "user-123")?.chatId).toBe(12345);
  });

  it("should support hot path fact cache", () => {
    const cache = new GatewayMetadataCache();
    cache.cacheFact("user:123:role", "admin");
    expect(cache.getFact<string>("user:123:role")).toBe("admin");
  });
});
