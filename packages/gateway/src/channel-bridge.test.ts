import { describe, it, expect, beforeEach } from "vitest";
import { ChannelBridgeManager } from "./channel-bridge";
import type { BridgeFilter } from "./channel-bridge";

describe("ChannelBridgeManager", () => {
  let cbm: ChannelBridgeManager;

  beforeEach(() => {
    cbm = new ChannelBridgeManager();
  });

  describe("bridge pairs", () => {
    it("should create a bridge pair", () => {
      const pair = cbm.createPair("telegram", "discord");
      expect(pair.id).toContain("pair_");
      expect(pair.sourceChannel).toBe("telegram");
      expect(pair.targetChannel).toBe("discord");
      expect(pair.active).toBe(true);
      expect(pair.prefixWithOrigin).toBe(true);
    });

    it("should create pair with custom options", () => {
      const pair = cbm.createPair("whatsapp", "slack", {
        name: "WA→Slack",
        prefixWithOrigin: false,
      });
      expect(pair.name).toBe("WA→Slack");
      expect(pair.prefixWithOrigin).toBe(false);
    });

    it("should list all pairs", () => {
      cbm.createPair("a", "b");
      cbm.createPair("c", "d");
      expect(cbm.listPairs()).toHaveLength(2);
    });

    it("should toggle pair active status", () => {
      const pair = cbm.createPair("telegram", "discord");
      cbm.setPairActive(pair.id, false);
      expect(cbm.getPair(pair.id)!.active).toBe(false);
    });

    it("should delete pair", () => {
      const pair = cbm.createPair("a", "b");
      expect(cbm.deletePair(pair.id)).toBe(true);
      expect(cbm.getPair(pair.id)).toBeNull();
    });

    it("should return null for unknown pair", () => {
      expect(cbm.getPair("nonexistent")).toBeNull();
    });
  });

  describe("bridge groups", () => {
    it("should create a bridge group", () => {
      const group = cbm.createGroup("Test Group", ["telegram", "discord", "slack"]);
      expect(group.id).toContain("group_");
      expect(group.channels).toEqual(["telegram", "discord", "slack"]);
      expect(group.active).toBe(true);
    });

    it("should reject groups with less than 2 channels", () => {
      expect(() => cbm.createGroup("Solo", ["webchat"])).toThrow("at least 2");
    });

    it("should list all groups", () => {
      cbm.createGroup("A", ["a", "b"]);
      cbm.createGroup("B", ["c", "d"]);
      expect(cbm.listGroups()).toHaveLength(2);
    });

    it("should delete group", () => {
      const group = cbm.createGroup("Test", ["a", "b"]);
      expect(cbm.deleteGroup(group.id)).toBe(true);
      expect(cbm.getGroup(group.id)).toBeNull();
    });

    it("should toggle group active status", () => {
      const group = cbm.createGroup("Test", ["a", "b"]);
      cbm.setGroupActive(group.id, false);
      expect(cbm.getGroup(group.id)!.active).toBe(false);
    });
  });

  describe("getForwardTargets", () => {
    it("should return forward targets for active pair", () => {
      cbm.createPair("telegram", "discord");

      const targets = cbm.getForwardTargets("telegram", {
        text: "Hello from Telegram!",
        sender: "user-1",
        messageId: "msg-1",
      });

      expect(targets).toHaveLength(1);
      expect(targets[0].targetChannel).toBe("discord");
      expect(targets[0].bridgedMessage.text).toContain("[telegram]");
      expect(targets[0].bridgedMessage.originalSender).toBe("user-1");
    });

    it("should not forward from inactive pair", () => {
      const pair = cbm.createPair("telegram", "discord");
      cbm.setPairActive(pair.id, false);

      const targets = cbm.getForwardTargets("telegram", {
        text: "Hello",
        sender: "user-1",
      });

      expect(targets).toHaveLength(0);
    });

    it("should forward to all group channels", () => {
      cbm.createGroup("Bridge", ["webchat", "telegram", "discord"]);

      const targets = cbm.getForwardTargets("webchat", {
        text: "Hello all!",
        sender: "user-1",
      });

      expect(targets).toHaveLength(2);
      const channels = targets.map((t) => t.targetChannel).sort();
      expect(channels).toEqual(["discord", "telegram"]);
    });

    it("should not bridge to source channel", () => {
      cbm.createGroup("Bridge", ["webchat", "telegram"]);

      const targets = cbm.getForwardTargets("webchat", {
        text: "Hello",
        sender: "user-1",
      });

      const selfTarget = targets.find((t) => t.targetChannel === "webchat");
      expect(selfTarget).toBeUndefined();
    });

    it("should include origin prefix when enabled", () => {
      cbm.createPair("discord", "telegram", { prefixWithOrigin: true });

      const targets = cbm.getForwardTargets("discord", {
        text: "Test message",
        sender: "user-1",
      });

      expect(targets[0].bridgedMessage.hasOriginPrefix).toBe(true);
      expect(targets[0].bridgedMessage.text).toContain("[discord]");
    });

    it("should exclude origin prefix when disabled", () => {
      cbm.createPair("discord", "telegram", { prefixWithOrigin: false });

      const targets = cbm.getForwardTargets("discord", {
        text: "Test message",
        sender: "user-1",
      });

      expect(targets[0].bridgedMessage.hasOriginPrefix).toBe(false);
      expect(targets[0].bridgedMessage.text).toBe("Test message");
    });
  });

  describe("bridge filters", () => {
    it("should apply allow filter", () => {
      const filter: BridgeFilter = { allowedSenders: ["admin"] };
      cbm.createPair("telegram", "discord", { filter });

      const adminTargets = cbm.getForwardTargets("telegram", {
        text: "Hello",
        sender: "admin",
      });

      expect(adminTargets).toHaveLength(1);

      const userTargets = cbm.getForwardTargets("telegram", {
        text: "Hello",
        sender: "user-1",
      });

      expect(userTargets).toHaveLength(0);
    });

    it("should apply block filter", () => {
      const filter: BridgeFilter = { blockedSenders: ["spammer"] };
      cbm.createPair("telegram", "discord", { filter });

      const blockedTargets = cbm.getForwardTargets("telegram", {
        text: "Hello",
        sender: "spammer",
      });

      expect(blockedTargets).toHaveLength(0);

      const normalTargets = cbm.getForwardTargets("telegram", {
        text: "Hello",
        sender: "normal-user",
      });

      expect(normalTargets).toHaveLength(1);
    });

    it("should apply min/max length filter", () => {
      const filter: BridgeFilter = { minLength: 5, maxLength: 100 };
      cbm.createPair("telegram", "discord", { filter });

      const shortTargets = cbm.getForwardTargets("telegram", { text: "Hi", sender: "u1" });
      expect(shortTargets).toHaveLength(0);

      const goodTargets = cbm.getForwardTargets("telegram", { text: "Hello world", sender: "u1" });
      expect(goodTargets).toHaveLength(1);

      const longTargets = cbm.getForwardTargets("telegram", { text: "A".repeat(200), sender: "u1" });
      expect(longTargets).toHaveLength(0);
    });

    it("should apply include/exclude patterns", () => {
      const filter: BridgeFilter = {
        includePatterns: ["urgent", "alert"],
        excludePatterns: ["spam"],
      };
      cbm.createPair("telegram", "discord", { filter });

      const matchTargets = cbm.getForwardTargets("telegram", { text: "urgent message", sender: "u1" });
      expect(matchTargets).toHaveLength(1);

      const noMatchTargets = cbm.getForwardTargets("telegram", { text: "normal message", sender: "u1" });
      expect(noMatchTargets).toHaveLength(0);

      const excludeTargets = cbm.getForwardTargets("telegram", { text: "urgent spam detected", sender: "u1" });
      expect(excludeTargets).toHaveLength(0);
    });
  });

  describe("loop prevention", () => {
    it("should prevent same message bridging twice to same channel", () => {
      cbm.createGroup("Loop", ["telegram", "discord", "slack"]);

      // First bridge
      const targets1 = cbm.getForwardTargets("telegram", {
        text: "Hello",
        sender: "user-1",
        messageId: "msg-loop",
      });

      expect(targets1).toHaveLength(2);

      // Second bridge (same message, same source) — should still go through
      const targets2 = cbm.getForwardTargets("discord", {
        text: "[telegram] Hello",
        sender: "user-1",
        messageId: "msg-loop",
      });

      // Should not bridge back to telegram (already bridged)
      const backToTelegram = targets2.find((t) => t.targetChannel === "telegram");
      expect(backToTelegram).toBeUndefined();
    });
  });

  describe("stats", () => {
    it("should compute stats", () => {
      cbm.createPair("telegram", "discord");
      cbm.createGroup("Test", ["webchat", "slack"]);

      const stats = cbm.getStats();
      expect(stats.totalPairs).toBe(1);
      expect(stats.totalGroups).toBe(1);
      expect(stats.activePairs).toBe(1);
      expect(stats.channelsWithBridges).toContain("telegram");
      expect(stats.channelsWithBridges).toContain("discord");
    });
  });

  describe("history", () => {
    it("should record bridge history", () => {
      cbm.createPair("telegram", "discord");
      cbm.getForwardTargets("telegram", { text: "Test", sender: "u1" });

      const history = cbm.getHistory();
      expect(history.length).toBe(1);
      expect(history[0].sourceChannel).toBe("telegram");
    });

    it("should clear history", () => {
      cbm.createPair("a", "b");
      cbm.getForwardTargets("a", { text: "T", sender: "u1" });
      cbm.clearHistory();
      expect(cbm.getHistory()).toHaveLength(0);
    });
  });

  describe("clearAll", () => {
    it("should clear all pairs, groups, and history", () => {
      cbm.createPair("a", "b");
      cbm.createGroup("G", ["x", "y"]);
      cbm.getForwardTargets("a", { text: "T", sender: "u1" });

      cbm.clearAll();
      expect(cbm.listPairs()).toHaveLength(0);
      expect(cbm.listGroups()).toHaveLength(0);
      expect(cbm.getHistory()).toHaveLength(0);
    });
  });

  describe("max bridges", () => {
    it("should throw when max bridges reached", () => {
      const small = new ChannelBridgeManager({ maxBridges: 1 });
      small.createPair("a", "b");
      expect(() => small.createPair("c", "d")).toThrow("Max bridges");
    });
  });

  describe("configure", () => {
    it("should update config", () => {
      cbm.configure({ originPrefixFormat: "[{channel}] → {message}" });
      cbm.createPair("telegram", "discord");

      const targets = cbm.getForwardTargets("telegram", { text: "Hello", sender: "u1" });
      expect(targets[0].bridgedMessage.text).toContain("→");
    });
  });
});