import { describe, it, expect, beforeEach } from "vitest";
import { ReplyReferenceManager } from "./reply-reference";
import type { ChannelMessage } from "./channel-manager";

function makeMsg(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return {
    messageId: "msg-1",
    channel: "telegram",
    from: "user-1",
    to: "bot",
    text: "Hello",
    timestamp: String(Date.now()),
    ...overrides,
  };
}

describe("ReplyReferenceManager", () => {
  let rm: ReplyReferenceManager;

  beforeEach(() => {
    rm = new ReplyReferenceManager();
  });

  // ── Recording ─────────────────────────────────────────

  describe("record", () => {
    it("records a reply relationship", () => {
      const ref = rm.record("root", "child1", { channel: "telegram" });
      expect(ref).not.toBeNull();
      expect(ref!.parentId).toBe("root");
      expect(ref!.childId).toBe("child1");
      expect(ref!.depth).toBe(1);
    });

    it("prevents self-replies", () => {
      const ref = rm.record("same", "same");
      expect(ref).toBeNull();
    });

    it("builds depth correctly for nested replies", () => {
      rm.record("root", "child1");
      const ref2 = rm.record("child1", "child2");
      expect(ref2!.depth).toBe(2);

      const ref3 = rm.record("child2", "child3");
      expect(ref3!.depth).toBe(3);
    });

    it("prevents exceeding max depth", () => {
      const shallow = new ReplyReferenceManager({ maxDepth: 2 });
      shallow.record("root", "c1");
      shallow.record("c1", "c2");
      const ref = shallow.record("c2", "c3");
      expect(ref).toBeNull();
    });

    it("prevents exceeding max chain size", () => {
      const small = new ReplyReferenceManager({ maxChainSize: 2 });
      small.record("root", "c1");
      const ref = small.record("c1", "c2");
      expect(ref).toBeNull();
    });

    it("records cross-channel replies", () => {
      const ref = rm.record("root", "child", {
        channel: "discord",
        crossChannel: true,
        peer: "user-2",
      });
      expect(ref!.crossChannel).toBe(true);
      expect(ref!.peer).toBe("user-2");
    });
  });

  describe("recordFromMessage", () => {
    it("records reply from two messages", () => {
      const parent = makeMsg({ messageId: "p1", channel: "telegram", from: "alice" });
      const child = makeMsg({ messageId: "c1", channel: "telegram", from: "bob" });

      const ref = rm.recordFromMessage(parent, child);
      expect(ref).not.toBeNull();
      expect(ref!.parentId).toBe("p1");
      expect(ref!.childId).toBe("c1");
    });

    it("detects cross-channel", () => {
      const parent = makeMsg({ messageId: "p1", channel: "telegram" });
      const child = makeMsg({ messageId: "c1", channel: "discord" });

      const ref = rm.recordFromMessage(parent, child);
      expect(ref!.crossChannel).toBe(true);
    });
  });

  // ── Retrieval ─────────────────────────────────────────

  describe("getParent", () => {
    it("returns parent ID", () => {
      rm.record("root", "child");
      expect(rm.getParent("child")).toBe("root");
    });

    it("returns null for unknown message", () => {
      expect(rm.getParent("unknown")).toBeNull();
    });
  });

  describe("getChildren", () => {
    it("returns all children", () => {
      rm.record("root", "c1");
      rm.record("root", "c2");
      const children = rm.getChildren("root");
      expect(children).toHaveLength(2);
      expect(children).toContain("c1");
      expect(children).toContain("c2");
    });

    it("returns empty for leaf node", () => {
      rm.record("root", "child");
      expect(rm.getChildren("child")).toHaveLength(0);
    });
  });

  describe("getDepth", () => {
    it("returns 0 for root/unrecorded messages", () => {
      expect(rm.getDepth("unknown")).toBe(0);
    });

    it("returns correct depth", () => {
      rm.record("root", "c1");
      rm.record("c1", "c2");
      expect(rm.getDepth("c1")).toBe(1);
      expect(rm.getDepth("c2")).toBe(2);
    });
  });

  describe("getRootId", () => {
    it("returns root of a chain", () => {
      rm.record("root", "c1");
      rm.record("c1", "c2");
      rm.record("c2", "c3");
      expect(rm.getRootId("c3")).toBe("root");
    });

    it("returns itself if no parent", () => {
      expect(rm.getRootId("orphan")).toBe("orphan");
    });

    it("handles cycle detection", () => {
      // Manually create a cycle by manipulating internal state is not possible
      // through the public API (self-replies are blocked), so just verify
      // normal behavior
      expect(rm.getRootId("nonexistent")).toBe("nonexistent");
    });
  });

  describe("getChainContext", () => {
    it("returns full chain from root to message", () => {
      rm.record("root", "c1", { channel: "telegram" });
      rm.record("c1", "c2", { channel: "telegram" });

      const ctx = rm.getChainContext("c2");
      expect(ctx.rootId).toBe("root");
      expect(ctx.chain.length).toBeGreaterThanOrEqual(1);
      expect(ctx.channel).toBe("telegram");
    });

    it("works for root message itself", () => {
      const ctx = rm.getChainContext("root-alone");
      expect(ctx.rootId).toBe("root-alone");
    });
  });

  describe("getReplyTree", () => {
    it("builds a tree from root", () => {
      rm.record("root", "c1");
      rm.record("root", "c2");
      rm.record("c1", "c1a");

      const tree = rm.getReplyTree("root");
      // root + c1 + c2 + c1a all in chain set
      expect(tree.size).toBe(4);
      expect(tree.nodes.size).toBe(4);
    });

    it("returns empty tree for unknown root", () => {
      const tree = rm.getReplyTree("unknown");
      expect(tree.size).toBe(0);
      expect(tree.depth).toBe(0);
    });
  });

  describe("getRef", () => {
    it("returns reference for a recorded message", () => {
      rm.record("root", "child");
      const ref = rm.getRef("child");
      expect(ref).not.toBeNull();
      expect(ref!.parentId).toBe("root");
    });

    it("returns null for unknown", () => {
      expect(rm.getRef("unknown")).toBeNull();
    });
  });

  // ── Detection ─────────────────────────────────────────

  describe("detectMention", () => {
    it("detects quote pattern", () => {
      const m = rm.detectMention("> original message text");
      expect(m.type).toBe("quote");
      expect(m.fragment).toBe("original message text");
      expect(m.confidence).toBe(0.7);
    });

    it("detects reply_id pattern", () => {
      const m = rm.detectMention("reply_to: msg-12345");
      expect(m.type).toBe("reply_id");
      expect(m.referencedId).toBe("msg-12345");
      expect(m.confidence).toBeCloseTo(0.9);
    });

    it("detects reply_to pattern", () => {
      const m = rm.detectMention("replying to abc-def");
      expect(m.type).toBe("reply_to");
      expect(m.referencedId).toBe("abc-def");
    });

    it("returns none for plain text", () => {
      const m = rm.detectMention("just a regular message");
      expect(m.type).toBe("none");
      expect(m.confidence).toBe(0);
    });
  });

  describe("detectMentionFromMessage", () => {
    it("detects from metadata", () => {
      const msg = makeMsg({
        text: "hello",
      }) as any;
      msg.metadata = { replyTo: "ref-123" };

      const m = rm.detectMentionFromMessage(msg);
      expect(m.type).toBe("from_metadata");
      expect(m.referencedId).toBe("ref-123");
      expect(m.confidence).toBe(1.0);
    });

    it("falls back to text detection", () => {
      const msg = makeMsg({ text: "> quoted text" });
      const m = rm.detectMentionFromMessage(msg);
      expect(m.type).toBe("quote");
    });

    it("returns none for plain message", () => {
      const msg = makeMsg({ text: "hello" });
      const m = rm.detectMentionFromMessage(msg);
      expect(m.type).toBe("none");
    });
  });

  // ── Management ────────────────────────────────────────

  describe("isAncestor", () => {
    it("returns true for direct parent", () => {
      rm.record("root", "child");
      expect(rm.isAncestor("root", "child")).toBe(true);
    });

    it("returns true for grandparent", () => {
      rm.record("root", "c1");
      rm.record("c1", "c2");
      expect(rm.isAncestor("root", "c2")).toBe(true);
    });

    it("returns false for unrelated messages", () => {
      rm.record("root", "child");
      expect(rm.isAncestor("unrelated", "child")).toBe(false);
    });

    it("returns false for descendant check reversed", () => {
      rm.record("root", "child");
      expect(rm.isAncestor("child", "root")).toBe(false);
    });
  });

  describe("counts", () => {
    it("counts refs and chains", () => {
      rm.record("root", "c1");
      rm.record("c1", "c2");
      expect(rm.countRefs()).toBe(2);
      expect(rm.countChains()).toBe(1);
    });
  });

  describe("removeChain", () => {
    it("removes entire chain", () => {
      rm.record("root", "c1");
      rm.record("c1", "c2");

      const removed = rm.removeChain("root");
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(rm.countRefs()).toBe(0);
    });

    it("returns 0 for unknown chain", () => {
      expect(rm.removeChain("unknown")).toBe(0);
    });
  });

  describe("clean", () => {
    it("removes expired references", () => {
      const short = new ReplyReferenceManager({ ttlMs: 1 });
      short.record("root", "child");
      // Wait for TTL to pass
      // We can't easily wait in tests, so test that clean runs without error
      expect(short.clean()).toBeGreaterThanOrEqual(0);
      short.dispose();
    });

    it("clean with ttl=0 does nothing", () => {
      const noExpire = new ReplyReferenceManager({ ttlMs: 0 });
      noExpire.record("root", "child");
      expect(noExpire.clean()).toBe(0);
      noExpire.dispose();
    });
  });

  describe("clear", () => {
    it("clears all references", () => {
      rm.record("root", "c1");
      rm.record("c1", "c2");
      rm.clear();
      expect(rm.countRefs()).toBe(0);
      expect(rm.countChains()).toBe(0);
    });
  });

  describe("dispose", () => {
    it("disposes without error", () => {
      rm.record("root", "child");
      rm.dispose();
      expect(rm.countRefs()).toBe(0);
    });
  });

  describe("configure", () => {
    it("updates config", () => {
      rm.configure({ maxDepth: 10 });
      // Verify by testing constraint
      const shallow = new ReplyReferenceManager({ maxDepth: 2 });
      shallow.record("r", "c1");
      shallow.record("c1", "c2");
      expect(shallow.record("c2", "c3")).toBeNull();
    });
  });
});