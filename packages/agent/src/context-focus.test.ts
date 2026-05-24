import { describe, it, expect, beforeEach } from "vitest";
import { ContextFocusManager } from "./context-focus";

describe("ContextFocusManager", () => {
  let cfm: ContextFocusManager;

  beforeEach(() => {
    cfm = new ContextFocusManager({ maxHistory: 5, autoFocusDM: true });
  });

  describe("focus", () => {
    it("should focus on a channel", () => {
      const target = cfm.focusChannel("discord", "Discord");
      expect(target.type).toBe("channel");
      expect(target.targetId).toBe("discord");
      expect(target.label).toBe("Discord");
      expect(target.focusId).toBeDefined();
      expect(cfm.isFocused()).toBe(true);
    });

    it("should focus on a session", () => {
      const target = cfm.focusSession("sess-12345", "My Session");
      expect(target.type).toBe("session");
      expect(target.targetId).toBe("sess-12345");
    });

    it("should focus on an agent", () => {
      const target = cfm.focusAgent("agent-42");
      expect(target.type).toBe("agent");
      expect(target.targetId).toBe("agent-42");
    });

    it("should focus on a peer", () => {
      const target = cfm.focusPeer("user-1", "Alice");
      expect(target.type).toBe("peer");
      expect(target.targetId).toBe("user-1");
      expect(target.label).toBe("Alice");
    });

    it("should push previous focus to history", () => {
      cfm.focusChannel("webchat");
      cfm.focusChannel("discord");

      const history = cfm.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].targetId).toBe("webchat");
    });

    it("should respect max history limit", () => {
      for (let i = 0; i < 10; i++) {
        cfm.focusChannel(`channel-${i}`);
      }
      expect(cfm.getHistory().length).toBeLessThanOrEqual(5);
    });
  });

  describe("unfocus", () => {
    it("should unfocus and return previous target", () => {
      cfm.focusChannel("telegram");
      const result = cfm.unfocus();

      expect(result.nowUnfocused).toBe(true);
      expect(result.previous).not.toBeNull();
      expect(result.previous!.targetId).toBe("telegram");
      expect(cfm.isFocused()).toBe(false);
    });

    it("should return null previous when already unfocused", () => {
      const result = cfm.unfocus();
      expect(result.previous).toBeNull();
      expect(result.nowUnfocused).toBe(true);
    });
  });

  describe("focusPrevious", () => {
    it("should switch to previous focus", () => {
      cfm.focusChannel("webchat");
      cfm.focusChannel("telegram");
      cfm.focusChannel("discord");

      const prev = cfm.focusPrevious();
      expect(prev).not.toBeNull();
      expect(prev!.targetId).toBe("telegram");
    });

    it("should return null when no history", () => {
      expect(cfm.focusPrevious()).toBeNull();
    });

    it("should preserve current in history", () => {
      cfm.focusChannel("first");
      cfm.focusChannel("second");
      cfm.focusPrevious();

      // "second" should now be in history
      const history = cfm.getHistory();
      expect(history.some((h) => h.targetId === "second")).toBe(true);
    });
  });

  describe("getCurrent", () => {
    it("should return current focus", () => {
      cfm.focusChannel("discord");
      const current = cfm.getCurrent();
      expect(current).not.toBeNull();
      expect(current!.targetId).toBe("discord");
    });

    it("should return null when unfocused", () => {
      expect(cfm.getCurrent()).toBeNull();
    });
  });

  describe("isTargetFocused", () => {
    it("should return true when target is focused", () => {
      cfm.focusChannel("discord");
      expect(cfm.isTargetFocused("channel", "discord")).toBe(true);
    });

    it("should return false for different target", () => {
      cfm.focusChannel("discord");
      expect(cfm.isTargetFocused("channel", "telegram")).toBe(false);
    });

    it("should return false for different type", () => {
      cfm.focusChannel("discord");
      expect(cfm.isTargetFocused("agent", "discord")).toBe(false);
    });
  });

  describe("registerContext / listAvailable", () => {
    it("should register and list contexts", () => {
      cfm.registerContext("discord", "channel", "Discord", { guild: "test" });
      cfm.registerContext("agent-1", "agent", "Main Agent");

      const available = cfm.listAvailable();
      expect(available).toHaveLength(2);
      expect(available[0].id).toBe("discord");
      expect(available[0].type).toBe("channel");
      expect(available[0].metadata).toEqual({ guild: "test" });
    });

    it("should unregister context", () => {
      cfm.registerContext("discord", "channel", "Discord");
      cfm.unregisterContext("discord");
      expect(cfm.listAvailable()).toHaveLength(0);
    });

    it("should auto-register on focus", () => {
      cfm.focusChannel("telegram", "Telegram");
      const available = cfm.listAvailable();
      expect(available).toHaveLength(1);
      expect(available[0].id).toBe("telegram");
    });
  });

  describe("getSummary", () => {
    it("should return unfocused summary", () => {
      const summary = cfm.getSummary();
      expect(summary).toContain("Unfocused");
    });

    it("should return focused summary", () => {
      cfm.focusChannel("discord", "Discord");
      const summary = cfm.getSummary();
      expect(summary).toContain("Discord");
      expect(summary).toContain("Focused on channel");
    });

    it("should include auto-focus DM status", () => {
      cfm.focusChannel("test");
      const summary = cfm.getSummary();
      expect(summary).toContain("Auto-focus DM: on");
    });
  });

  describe("clearHistory", () => {
    it("should clear focus history", () => {
      cfm.focusChannel("a");
      cfm.focusChannel("b");
      cfm.clearHistory();
      expect(cfm.getHistory()).toHaveLength(0);
    });
  });

  describe("shouldAutoFocus", () => {
    it("should return true for DM from unfocused channel with autoFocus enabled", () => {
      expect(cfm.shouldAutoFocus("discord", true)).toBe(true);
    });

    it("should return false when already focused on channel", () => {
      cfm.focusChannel("discord");
      expect(cfm.shouldAutoFocus("discord", true)).toBe(false);
    });

    it("should return false for non-DM messages", () => {
      expect(cfm.shouldAutoFocus("discord", false)).toBe(false);
    });

    it("should return false when autoFocus disabled", () => {
      cfm.setAutoFocusDM(false);
      expect(cfm.shouldAutoFocus("discord", true)).toBe(false);
    });

    it("should return true for different channel DM", () => {
      cfm.focusChannel("telegram");
      expect(cfm.shouldAutoFocus("discord", true)).toBe(true);
    });
  });

  describe("handleCommand", () => {
    it("should handle /focus channel", () => {
      const result = cfm.handleCommand("focus", ["channel", "discord"]);
      expect(result).toContain("Focused on");
      expect(cfm.isFocused()).toBe(true);
    });

    it("should handle /focus session", () => {
      const result = cfm.handleCommand("focus", ["session", "sess-abc"]);
      expect(result).toContain("sess-abc");
    });

    it("should handle /unfocus", () => {
      cfm.focusChannel("discord");
      const result = cfm.handleCommand("unfocus", []);
      expect(result).toContain("Unfocused");
      expect(cfm.isFocused()).toBe(false);
    });

    it("should handle /unfocus when already unfocused", () => {
      const result = cfm.handleCommand("unfocus", []);
      expect(result).toContain("Already unfocused");
    });

    it("should handle /agents", () => {
      cfm.registerContext("discord", "channel", "Discord");
      const result = cfm.handleCommand("agents", []);
      expect(result).toContain("Available");
    });

    it("should handle /agents when no contexts registered", () => {
      const result = cfm.handleCommand("agents", []);
      expect(result).toContain("No registered contexts");
    });

    it("should reject invalid focus type", () => {
      const result = cfm.handleCommand("focus", ["invalid", "x"]);
      expect(result).toContain("Invalid focus type");
    });

    it("should reject unknown command", () => {
      const result = cfm.handleCommand("unknown", []);
      expect(result).toContain("Unknown focus command");
    });

    it("should show usage for focus with missing args", () => {
      const result = cfm.handleCommand("focus", []);
      expect(result).toContain("Usage");
    });
  });

  describe("setAutoFocusDM", () => {
    it("should toggle autoFocusDM", () => {
      cfm.setAutoFocusDM(false);
      expect(cfm.shouldAutoFocus("test", true)).toBe(false);
    });
  });

  describe("configure", () => {
    it("should update config", () => {
      cfm.configure({ autoFocusDM: false, maxHistory: 10 });
      expect(cfm.shouldAutoFocus("test", true)).toBe(false);
    });
  });
});