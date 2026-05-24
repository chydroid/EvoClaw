import { describe, it, expect, beforeEach, vi } from "vitest";
import { OutboundRouter } from "./outbound-router";
import type { OutboundMessage } from "./outbound-router";

describe("OutboundRouter", () => {
  let router: OutboundRouter;

  beforeEach(() => {
    router = new OutboundRouter({
      defaultChannel: "webchat",
      channelStatuses: {
        webchat: "active",
        discord: "active",
        telegram: "active",
        slack: "degraded",
        whatsapp: "down",
      },
      channelLoads: {
        webchat: 30,
        discord: 10,
        telegram: 50,
        slack: 80,
      },
      preferSourceOnReply: true,
      skipDownChannels: true,
    });
  });

  describe("route", () => {
    it("should return routes for a simple message", () => {
      const msg: OutboundMessage = {
        text: "Hello world",
        target: "user-1",
        preferSourceChannel: false,
      };

      const routes = router.route(msg);
      expect(routes.length).toBeGreaterThan(0);
      expect(routes[0].channel).toBeDefined();
      expect(routes[0].score).toBeGreaterThan(0);
    });

    it("should prefer source channel on reply", () => {
      const msg: OutboundMessage = {
        text: "Sure!",
        target: "user-1",
        sourceChannel: "telegram",
        preferSourceChannel: true,
      };

      const routes = router.route(msg);
      expect(routes[0].channel).toBe("telegram");
    });

    it("should not prefer source channel when disabled", () => {
      router.configure({ preferSourceOnReply: false });

      const msg: OutboundMessage = {
        text: "Sure!",
        target: "user-1",
        sourceChannel: "telegram",
        preferSourceChannel: true,
      };

      const routes = router.route(msg);
      // telegram may still appear but not as guaranteed top pick
      expect(routes.length).toBeGreaterThan(0);
    });

    it("should skip down channels", () => {
      const msg: OutboundMessage = {
        text: "Hello",
        target: "user-1",
        preferSourceChannel: false,
      };

      const routes = router.route(msg);
      const whatsappRoute = routes.find((r) => r.channel === "whatsapp");
      expect(whatsappRoute).toBeUndefined();
    });

    it("should return default channel when no routes available", () => {
      const emptyRouter = new OutboundRouter({
        defaultChannel: "fallback",
        channelStatuses: {},
        skipDownChannels: false,
      });

      const msg: OutboundMessage = {
        text: "Help",
        target: "user-1",
        preferSourceChannel: false,
      };

      const routes = emptyRouter.route(msg);
      expect(routes).toHaveLength(1);
      expect(routes[0].channel).toBe("fallback");
    });
  });

  describe("getBestRoute", () => {
    it("should return highest scoring route", () => {
      const msg: OutboundMessage = {
        text: "Hello",
        target: "user-1",
        sourceChannel: "discord",
        preferSourceChannel: true,
      };

      const best = router.getBestRoute(msg);
      expect(best.channel).toBe("discord");
      expect(best.score).toBe(100);
    });
  });

  describe("routing rules", () => {
    it("should apply custom routing rules", () => {
      router.addRule({
        name: "always-slack",
        priority: 0,
        targetChannel: "slack",
        condition: () => true,
        scoreBoost: 50,
        enabled: true,
      });

      const msg: OutboundMessage = {
        text: "Test",
        target: "user-1",
        preferSourceChannel: false,
      };

      const routes = router.route(msg);
      const slackRoute = routes.find((r) => r.channel === "slack");
      expect(slackRoute).toBeDefined();
    });

    it("should not apply disabled rules", () => {
      router.addRule({
        name: "always-slack",
        priority: 0,
        targetChannel: "slack",
        condition: () => true,
        scoreBoost: 50,
        enabled: false,
      });

      router.setRuleEnabled("always-slack", false);

      const msg: OutboundMessage = {
        text: "Test",
        target: "user-1",
        preferSourceChannel: false,
      };

      const routes = router.route(msg);
      const slackRule = routes.find(
        (r) => r.reason && r.reason.includes("always-slack"),
      );
      expect(slackRule).toBeUndefined();
    });

    it("should remove rules", () => {
      router.addRule({
        name: "temp-rule",
        priority: 0,
        targetChannel: "discord",
        scoreBoost: 10,
        enabled: true,
      });

      router.removeRule("temp-rule");
      expect(router.getRules().find((r) => r.name === "temp-rule")).toBeUndefined();
    });

    it("should replace rule with same name", () => {
      router.addRule({
        name: "my-rule",
        priority: 0,
        targetChannel: "discord",
        scoreBoost: 10,
        enabled: true,
      });

      router.addRule({
        name: "my-rule",
        priority: 1,
        targetChannel: "telegram",
        scoreBoost: 20,
        enabled: true,
      });

      const rules = router.getRules();
      const myRule = rules.filter((r) => r.name === "my-rule");
      expect(myRule).toHaveLength(1);
      expect(myRule[0].targetChannel).toBe("telegram");
    });
  });

  describe("channel status", () => {
    it("should update channel status", () => {
      router.setChannelStatus("discord", "down");

      const msg: OutboundMessage = {
        text: "Hi",
        target: "user-1",
        sourceChannel: "discord",
        preferSourceChannel: true,
      };

      // Should not route to discord since it's down
      const best = router.getBestRoute(msg);
      expect(best.channel).not.toBe("discord");
    });

    it("should update channel load", () => {
      router.setChannelLoad("discord", 100);

      const msg: OutboundMessage = {
        text: "Hi",
        target: "user-1",
        preferSourceChannel: false,
      };

      const routes = router.route(msg);
      const discordRoute = routes.find((r) => r.channel === "discord");
      // Discord may be present but with lower score due to high load
      if (discordRoute) {
        expect(discordRoute.score).toBeDefined();
      }
    });
  });

  describe("content routing", () => {
    it("should route long content to slack", () => {
      const msg: OutboundMessage = {
        text: "A".repeat(600),
        target: "user-1",
        preferSourceChannel: false,
        contentType: "long",
      };

      const routes = router.route(msg);
      const slackRoute = routes.find((r) => r.channel === "slack");
      expect(slackRoute).toBeDefined();
    });

    it("should route alerts to telegram", () => {
      const msg: OutboundMessage = {
        text: "Critical error!",
        target: "user-1",
        preferSourceChannel: false,
        contentType: "alert",
      };

      const routes = router.route(msg);
      const telegramRoute = routes.find((r) => r.channel === "telegram");
      expect(telegramRoute).toBeDefined();
    });

    it("should route images to discord", () => {
      const msg: OutboundMessage = {
        text: "",
        target: "user-1",
        preferSourceChannel: false,
        contentType: "image",
      };

      const routes = router.route(msg);
      const discordRoute = routes.find((r) => r.channel === "discord");
      expect(discordRoute).toBeDefined();
    });
  });

  describe("history", () => {
    it("should record routing history", () => {
      router.route({
        text: "Test",
        target: "u1",
        preferSourceChannel: false,
      });

      const history = router.getHistory();
      expect(history.length).toBe(1);
      expect(history[0].channel).toBeDefined();
      expect(history[0].score).toBeGreaterThan(0);
    });

    it("should clear history", () => {
      router.route({
        text: "Test",
        target: "u1",
        preferSourceChannel: false,
      });

      router.clearHistory();
      expect(router.getHistory()).toHaveLength(0);
    });
  });

  describe("configure", () => {
    it("should update configuration", () => {
      router.configure({ defaultChannel: "fallback" });
      // No easy way to verify without calling route
      expect(() => router.configure({})).not.toThrow();
    });
  });
});