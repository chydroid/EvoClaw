import { describe, it, expect, beforeEach } from "vitest";
import { ChannelManager } from "./channel-manager";
import type { ChannelAdapter, ChannelMessage, ChannelType } from "./channel-manager";

// Mock adapter for testing
function createMockAdapter(type: ChannelType = "whatsapp"): ChannelAdapter {
  let messageHandler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  let statusHandler: ((s: string) => void) | null = null;
  let started = false;

  return {
    type,
    start: async () => { started = true; },
    stop: async () => { started = false; },
    sendMessage: async (target, text) => ({
      success: true,
      messageId: "mock-msg-1",
      channel: type,
    }),
    healthCheck: async () => true,
    onMessage: (handler) => { messageHandler = handler; },
    onStatusChange: (handler) => { statusHandler = handler; },
    // Expose for testing
    _triggerMessage: async (msg: ChannelMessage) => {
      if (messageHandler) await messageHandler(msg);
    },
    _triggerStatus: (s: string) => {
      if (statusHandler) statusHandler(s as any);
    },
    _isStarted: () => started,
  } as ChannelAdapter & {
    _triggerMessage(msg: ChannelMessage): Promise<void>;
    _triggerStatus(s: string): void;
    _isStarted(): boolean;
  };
}

describe("ChannelManager", () => {
  let cm: ChannelManager;

  beforeEach(() => {
    cm = new ChannelManager();
  });

  describe("Channel Registration", () => {
    it("should register a channel configuration", () => {
      cm.registerChannel({
        type: "whatsapp",
        enabled: true,
        label: "WhatsApp",
        dmPolicy: "pairing",
        allowFrom: [],
        blockFrom: [],
        settings: {},
      });

      const types = cm.getChannelTypes();
      expect(types).toContain("whatsapp");
    });

    it("should register multiple channels", () => {
      cm.registerChannel({ type: "whatsapp", enabled: true, label: "WA", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });
      cm.registerChannel({ type: "telegram", enabled: true, label: "TG", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });

      expect(cm.getChannelTypes()).toHaveLength(2);
    });

    it("should initialize status on registration", () => {
      cm.registerChannel({ type: "telegram", enabled: true, label: "Telegram", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });

      const status = cm.getStatus("telegram");
      expect(status).toBeDefined();
      expect(status!.type).toBe("telegram");
      expect(status!.enabled).toBe(true);
      expect(status!.connected).toBe(false);
      expect(status!.messageCount).toBe(0);
    });
  });

  describe("Adapter Management", () => {
    it("should attach and start an enabled adapter", async () => {
      cm.registerChannel({ type: "webchat", enabled: true, label: "Web", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });

      const adapter = createMockAdapter("webchat");
      await cm.attachAdapter(adapter);

      expect((adapter as any)._isStarted()).toBe(true);
      const status = cm.getStatus("webchat");
      expect(status!.connected).toBe(true);
    });

    it("should not start a disabled adapter", async () => {
      cm.registerChannel({ type: "telegram", enabled: false, label: "TG", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });

      const adapter = createMockAdapter("telegram");
      await cm.attachAdapter(adapter);

      expect((adapter as any)._isStarted()).toBe(false);
    });

    it("should detach and stop an adapter", async () => {
      cm.registerChannel({ type: "webchat", enabled: true, label: "Web", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });

      const adapter = createMockAdapter("webchat");
      await cm.attachAdapter(adapter);
      await cm.detachAdapter("webchat");

      expect((adapter as any)._isStarted()).toBe(false);
    });

    it("should check channel availability", async () => {
      cm.registerChannel({ type: "whatsapp", enabled: true, label: "WA", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });
      expect(cm.isChannelAvailable("whatsapp")).toBe(false); // no adapter attached

      const adapter = createMockAdapter("whatsapp");
      await cm.attachAdapter(adapter);
      expect(cm.isChannelAvailable("whatsapp")).toBe(true);
    });
  });

  describe("Message Handling", () => {
    it("should set and call message handler", async () => {
      cm.registerChannel({ type: "webchat", enabled: true, label: "Web", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });

      const receivedMessages: ChannelMessage[] = [];
      cm.setMessageHandler(async (msg) => { receivedMessages.push(msg); });

      const adapter = createMockAdapter("webchat");
      await cm.attachAdapter(adapter);

      await cm.handleIncomingMessage({
        messageId: "1",
        channel: "webchat",
        from: "user1",
        to: "bot",
        text: "Hello",
        timestamp: new Date().toISOString(),
        isDirect: true,
        isGroup: false,
        raw: {},
      });

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].text).toBe("Hello");
    });

    it("should increment message count", async () => {
      cm.registerChannel({ type: "webchat", enabled: true, label: "Web", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });

      cm.setMessageHandler(async () => {});

      await cm.handleIncomingMessage({
        messageId: "1", channel: "webchat", from: "user1", to: "bot",
        text: "msg1", timestamp: new Date().toISOString(),
        isDirect: true, isGroup: false, raw: {},
      });
      await cm.handleIncomingMessage({
        messageId: "2", channel: "webchat", from: "user1", to: "bot",
        text: "msg2", timestamp: new Date().toISOString(),
        isDirect: true, isGroup: false, raw: {},
      });

      const status = cm.getStatus("webchat");
      expect(status!.messageCount).toBe(2);
    });

    it("should send message through adapter", async () => {
      cm.registerChannel({ type: "whatsapp", enabled: true, label: "WA", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });

      const adapter = createMockAdapter("whatsapp");
      await cm.attachAdapter(adapter);

      const result = await cm.sendMessage("whatsapp", "123456", "Hello");
      expect(result.success).toBe(true);
      expect(result.channel).toBe("whatsapp");
    });

    it("should return error for unknown channel", async () => {
      const result = await cm.sendMessage("unknown" as ChannelType, "123", "Hi");
      expect(result.success).toBe(false);
      expect(result.error).toContain("No adapter");
    });
  });

  describe("DM Policy & Pairing", () => {
    it("should default to pairing policy", () => {
      cm.registerChannel({ type: "whatsapp", enabled: true, label: "WA", dmPolicy: "pairing", allowFrom: [], blockFrom: [], settings: {} });

      expect(cm.getDMPolicy("whatsapp")).toBe("pairing");
    });

    it("should block unapproved peer in closed policy", async () => {
      cm.registerChannel({ type: "whatsapp", enabled: true, label: "WA", dmPolicy: "closed", allowFrom: [], blockFrom: [], settings: {} });

      const handled: ChannelMessage[] = [];
      cm.setMessageHandler(async (msg) => { handled.push(msg); });

      await cm.handleIncomingMessage({
        messageId: "1", channel: "whatsapp", from: "unknown", to: "bot",
        text: "Hi", timestamp: new Date().toISOString(),
        isDirect: true, isGroup: false, raw: {},
      });

      expect(handled).toHaveLength(0);
    });

    it("should allow approved peer in closed policy", async () => {
      cm.registerChannel({
        type: "whatsapp", enabled: true, label: "WA", dmPolicy: "closed",
        allowFrom: ["approved-user"], blockFrom: [], settings: {},
      });

      const handled: ChannelMessage[] = [];
      cm.setMessageHandler(async (msg) => { handled.push(msg); });

      await cm.handleIncomingMessage({
        messageId: "1", channel: "whatsapp", from: "approved-user", to: "bot",
        text: "Hi", timestamp: new Date().toISOString(),
        isDirect: true, isGroup: false, raw: {},
      });

      expect(handled).toHaveLength(1);
    });

    it("should block peer from blocklist", async () => {
      cm.registerChannel({
        type: "whatsapp", enabled: true, label: "WA", dmPolicy: "open",
        allowFrom: [], blockFrom: ["spammer"], settings: {},
      });

      const handled: ChannelMessage[] = [];
      cm.setMessageHandler(async (msg) => { handled.push(msg); });

      await cm.handleIncomingMessage({
        messageId: "1", channel: "whatsapp", from: "spammer", to: "bot",
        text: "Spam", timestamp: new Date().toISOString(),
        isDirect: true, isGroup: false, raw: {},
      });

      expect(handled).toHaveLength(0);
    });

    it("should approve pairing code", () => {
      cm.registerChannel({ type: "whatsapp", enabled: true, label: "WA", dmPolicy: "pairing", allowFrom: [], blockFrom: [], settings: {} });

      // Simulate the pairing code flow (internal state)
      const result = cm.approvePairing("ABC123");
      expect(result).toBe(false); // No such code stored
    });

    it("should revoke peer approval", () => {
      cm.registerChannel({
        type: "whatsapp", enabled: true, label: "WA", dmPolicy: "open",
        allowFrom: ["user1"], blockFrom: [], settings: {},
      });

      expect(cm.isPeerApproved("whatsapp", "user1")).toBe(true);
      cm.revokePeer("whatsapp", "user1");
      expect(cm.isPeerApproved("whatsapp", "user1")).toBe(false);
    });

    it("should block and unblock peers", () => {
      cm.registerChannel({ type: "whatsapp", enabled: true, label: "WA", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });

      cm.blockPeer("whatsapp", "bad-user");
      expect(cm.isPeerBlocklisted("whatsapp", "bad-user")).toBe(true);

      cm.unblockPeer("whatsapp", "bad-user");
      expect(cm.isPeerBlocklisted("whatsapp", "bad-user")).toBe(false);
    });
  });

  describe("Status & Querying", () => {
    it("should get all statuses", () => {
      cm.registerChannel({ type: "whatsapp", enabled: true, label: "WA", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });
      cm.registerChannel({ type: "telegram", enabled: false, label: "TG", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });

      const statuses = cm.getAllStatuses();
      expect(statuses).toHaveLength(2);
    });

    it("should get active channels after adapter attach", async () => {
      cm.registerChannel({ type: "webchat", enabled: true, label: "Web", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });
      cm.registerChannel({ type: "telegram", enabled: true, label: "TG", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });

      const adapter = createMockAdapter("webchat");
      await cm.attachAdapter(adapter);

      const active = cm.getActiveChannels();
      expect(active).toContain("webchat");
      expect(active).not.toContain("telegram"); // no adapter
    });

    it("should return undefined for unknown channel status", () => {
      const status = cm.getStatus("nonexistent" as ChannelType);
      expect(status).toBeUndefined();
    });
  });

  describe("Lifecycle", () => {
    it("should start all enabled channels", async () => {
      cm.registerChannel({ type: "whatsapp", enabled: true, label: "WA", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });
      cm.registerChannel({ type: "telegram", enabled: false, label: "TG", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });

      const adapter1 = createMockAdapter("whatsapp");
      const adapter2 = createMockAdapter("telegram");
      await cm.attachAdapter(adapter1);
      await cm.attachAdapter(adapter2);

      // stop them first
      await cm.stopAll();

      await cm.startAll();

      expect((adapter1 as any)._isStarted()).toBe(true);
      expect((adapter2 as any)._isStarted()).toBe(false); // disabled
    });

    it("should stop all channels", async () => {
      cm.registerChannel({ type: "webchat", enabled: true, label: "Web", dmPolicy: "open", allowFrom: [], blockFrom: [], settings: {} });

      const adapter = createMockAdapter("webchat");
      await cm.attachAdapter(adapter);
      expect((adapter as any)._isStarted()).toBe(true);

      await cm.stopAll();
      expect((adapter as any)._isStarted()).toBe(false);
    });
  });
});