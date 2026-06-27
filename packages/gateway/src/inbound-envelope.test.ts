import { describe, it, expect, beforeEach } from "vitest";
import {
  createInboundEnvelope,
  filterEnvelope,
  serializeEnvelope,
  deserializeEnvelope,
  bumpRetry,
  withRoutingHint,
  withAgentBinding,
  tagEnvelope,
} from "./inbound-envelope";
import type { ChannelMessage, ChannelType } from "./channel-manager.js";

function makeMsg(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return {
    messageId: "msg-001",
    channel: "webchat" as ChannelType,
    from: "user-1",
    to: "agent-1",
    text: "Hello, how are you?",
    timestamp: new Date().toISOString(),
    isDirect: true,
    isGroup: false,
    raw: {},
    ...overrides,
  };
}

describe("Inbound Envelope", () => {
  describe("createInboundEnvelope", () => {
    it("should create envelope with auto-detected intent", () => {
      const msg = makeMsg({ text: "Hello world" });
      const env = createInboundEnvelope(msg);

      expect(env.envelopeId).toBeDefined();
      expect(env.intent).toBe("chat");
      expect(env.priority).toBe("normal");
      expect(env.message).toEqual(msg);
      expect(env.delivery.retryCount).toBe(0);
      expect(env.metadata.traceId).toBeDefined();
      expect(env.contentHash).toBeDefined();
    });

    it("should detect command intent from / prefix", () => {
      const env = createInboundEnvelope(makeMsg({ text: "/status" }));
      expect(env.intent).toBe("command");
    });

    it("should detect command intent from ! prefix", () => {
      const env = createInboundEnvelope(makeMsg({ text: "!reset" }));
      expect(env.intent).toBe("command");
    });

    it("should detect command intent from . prefix", () => {
      const env = createInboundEnvelope(makeMsg({ text: ".compact" }));
      expect(env.intent).toBe("command");
    });

    it("should detect attachment intent", () => {
      const msg = makeMsg({
        text: "",
        attachments: [{ type: "image", url: "https://example.com/img.png" }],
      });
      const env = createInboundEnvelope(msg);
      expect(env.intent).toBe("attachment");
    });

    it("should detect high priority from urgent keyword", () => {
      const env = createInboundEnvelope(makeMsg({ text: "This is urgent!" }));
      expect(env.priority).toBe("high");
    });

    it("should detect critical priority", () => {
      const env = createInboundEnvelope(makeMsg({ text: "critical issue ⚠️" }));
      expect(env.priority).toBe("critical");
    });

    it("should override intent via options", () => {
      const env = createInboundEnvelope(makeMsg({ text: "/status" }), {
        intent: "chat",
      });
      expect(env.intent).toBe("chat");
    });

    it("should set reply reference", () => {
      const msg = makeMsg({ replyTo: "msg-000" });
      const env = createInboundEnvelope(msg);
      expect(env.delivery.replyRef).toBe("msg-000");
    });

    it("should set retry count", () => {
      const env = createInboundEnvelope(makeMsg(), { retryCount: 2 });
      expect(env.delivery.retryCount).toBe(2);
    });

    it("should set agent binding via options", () => {
      const env = createInboundEnvelope(makeMsg(), { agentId: "agent-42" });
      expect(env.routing.agentId).toBe("agent-42");
    });

    it("should compute session key from channel + sender", () => {
      const env = createInboundEnvelope(makeMsg({ channel: "discord" as ChannelType, from: "discord-user" }));
      expect(env.routing.sessionKey).toBe("discord:discord-user");
    });

    it("should produce deterministic content hash", () => {
      const msg = makeMsg({ text: "test", timestamp: "2024-01-01T00:00:00Z" });
      const env1 = createInboundEnvelope(msg);
      const env2 = createInboundEnvelope(msg);
      expect(env1.contentHash).toBe(env2.contentHash);
    });
  });

  describe("filterEnvelope", () => {
    it("should allow envelope with no filters", () => {
      const env = createInboundEnvelope(makeMsg());
      const result = filterEnvelope(env, {});
      expect(result.allowed).toBe(true);
    });

    it("should block by channel", () => {
      const env = createInboundEnvelope(makeMsg({ channel: "telegram" as ChannelType }));
      const result = filterEnvelope(env, {
        blockedChannels: ["telegram"],
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Blocked channel");
    });

    it("should block by sender", () => {
      const env = createInboundEnvelope(makeMsg({ from: "spammer" }));
      const result = filterEnvelope(env, { blockedSenders: ["spammer"] });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Blocked sender");
    });

    it("should block by intent", () => {
      const env = createInboundEnvelope(makeMsg({ text: "/status" }));
      const result = filterEnvelope(env, { allowedIntents: ["chat", "attachment"] });
      expect(result.allowed).toBe(false);
    });

    it("should allow matching intent", () => {
      const env = createInboundEnvelope(makeMsg({ text: "/status" }));
      const result = filterEnvelope(env, { allowedIntents: ["command", "chat"] });
      expect(result.allowed).toBe(true);
    });

    it("should block when max retries exceeded", () => {
      const env = createInboundEnvelope(makeMsg(), { retryCount: 5 });
      const result = filterEnvelope(env, { maxRetries: 3 });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Max retries");
    });

    it("should accept when retries within limit", () => {
      const env = createInboundEnvelope(makeMsg(), { retryCount: 2 });
      const result = filterEnvelope(env, { maxRetries: 3 });
      expect(result.allowed).toBe(true);
    });

    it("should block short text", () => {
      const env = createInboundEnvelope(makeMsg({ text: "Hi" }));
      const result = filterEnvelope(env, { minTextLength: 5 });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Text too short");
    });

    it("should allow text meeting minimum length", () => {
      const env = createInboundEnvelope(makeMsg({ text: "Hello world" }));
      const result = filterEnvelope(env, { minTextLength: 5 });
      expect(result.allowed).toBe(true);
    });
  });

  describe("serializeEnvelope / deserializeEnvelope", () => {
    it("should round-trip serialize/deserialize", () => {
      const env = createInboundEnvelope(makeMsg());
      const json = serializeEnvelope(env);
      const restored = deserializeEnvelope(json);
      expect(restored).not.toBeNull();
      if (!restored) throw new Error("expected non-null envelope");
      expect(restored.envelopeId).toBe(env.envelopeId);
      expect(restored.intent).toBe(env.intent);
      expect(restored.message.text).toBe(env.message.text);
    });
  });

  describe("bumpRetry", () => {
    it("should increment retry count and chain trace", () => {
      const env = createInboundEnvelope(makeMsg());
      const bumped = bumpRetry(env);

      expect(bumped.delivery.retryCount).toBe(1);
      expect(bumped.envelopeId).not.toBe(env.envelopeId);
      expect(bumped.metadata.causalityChain).toContain(env.metadata.traceId);
    });

    it("should chain multiple retries", () => {
      let env = createInboundEnvelope(makeMsg());
      env = bumpRetry(env);
      env = bumpRetry(env);
      expect(env.delivery.retryCount).toBe(2);
      expect(env.metadata.causalityChain).toHaveLength(2);
    });
  });

  describe("withRoutingHint", () => {
    it("should set routing hint", () => {
      const env = createInboundEnvelope(makeMsg());
      const updated = withRoutingHint(env, { escalated: true });
      expect(updated.routing.escalated).toBe(true);
    });
  });

  describe("withAgentBinding", () => {
    it("should set agent binding", () => {
      const env = createInboundEnvelope(makeMsg());
      const updated = withAgentBinding(env, "agent-99");
      expect(updated.routing.agentId).toBe("agent-99");
    });
  });

  describe("tagEnvelope", () => {
    it("should add tags", () => {
      const env = createInboundEnvelope(makeMsg(), { tags: ["initial"] });
      const tagged = tagEnvelope(env, "important", "review");
      expect(tagged.metadata.tags).toContain("initial");
      expect(tagged.metadata.tags).toContain("important");
      expect(tagged.metadata.tags).toContain("review");
    });

    it("should deduplicate tags", () => {
      const env = createInboundEnvelope(makeMsg(), { tags: ["important"] });
      const tagged = tagEnvelope(env, "important");
      expect(tagged.metadata.tags.filter((t) => t === "important")).toHaveLength(1);
    });
  });
});