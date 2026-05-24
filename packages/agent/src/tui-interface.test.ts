import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TUIManager } from "../src/tui-interface";
import type { TUIMessage, TUIStatus } from "../src/tui-interface";

describe("TUIManager", () => {
  let tui: TUIManager;

  beforeEach(() => {
    vi.useFakeTimers();
    tui = new TUIManager({ maxMessages: 10, maxHistory: 5, notificationTTLMs: 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Initial State ───────────────────────────────────────

  describe("initial state", () => {
    it("should initialize with default state", () => {
      expect(tui.state.activePanel).toBe("conversation");
      expect(tui.state.messages).toEqual([]);
      expect(tui.state.inputBuffer).toBe("");
      expect(tui.state.commandHistory).toEqual([]);
      expect(tui.state.isProcessing).toBe(false);
      expect(tui.state.typingText).toBe("");
      expect(tui.state.notifications).toEqual([]);
    });

    it("should initialize status with defaults", () => {
      expect(tui.state.status.version).toBe("0.4.0");
      expect(tui.state.status.provider.name).toBe("none");
      expect(tui.state.status.evolution.active).toBe(false);
      expect(tui.state.status.memory.sessions).toBe(0);
    });
  });

  // ── Message Management ──────────────────────────────────

  describe("message management", () => {
    it("should add user messages", () => {
      tui.addUserMessage("Hello", "test-channel");
      expect(tui.state.messages).toHaveLength(1);
      expect(tui.state.messages[0].role).toBe("user");
      expect(tui.state.messages[0].content).toBe("Hello");
      expect(tui.state.messages[0].channel).toBe("test-channel");
    });

    it("should add assistant messages", () => {
      tui.addAssistantMessage("Hi there!");
      expect(tui.state.messages).toHaveLength(1);
      expect(tui.state.messages[0].role).toBe("assistant");
      expect(tui.state.messages[0].content).toBe("Hi there!");
    });

    it("should add system messages", () => {
      tui.addSystemMessage("System started");
      const msg = tui.state.messages[0];
      expect(msg.role).toBe("system");
      expect(msg.id).toMatch(/^sys_/);
    });

    it("should add error messages", () => {
      tui.addErrorMessage("Something went wrong");
      const msg = tui.state.messages[0];
      expect(msg.role).toBe("error");
      expect(msg.id).toMatch(/^err_/);
    });

    it("should trim messages when exceeding maxMessages", () => {
      for (let i = 0; i < 15; i++) {
        tui.addUserMessage(`msg_${i}`);
      }
      expect(tui.state.messages.length).toBeLessThanOrEqual(10);
    });

    it("should emit update event on message add", () => {
      const spy = vi.fn();
      tui.on("update", spy);
      tui.addUserMessage("test");
      expect(spy).toHaveBeenCalled();
    });
  });

  // ── Processing State ────────────────────────────────────

  describe("processing state", () => {
    it("should set processing flag", () => {
      tui.setProcessing(true);
      expect(tui.state.isProcessing).toBe(true);
    });

    it("should clear typing text when processing stops", () => {
      tui.setTyping("typing...");
      tui.setProcessing(true);
      tui.setProcessing(false);
      expect(tui.state.typingText).toBe("");
    });
  });

  // ── Input / Submit ──────────────────────────────────────

  describe("input handling", () => {
    it("should append characters to input buffer", () => {
      tui.handleInput("a");
      tui.handleInput("b");
      expect(tui.state.inputBuffer).toBe("ab");
    });

    it("should handle backspace", () => {
      tui.handleInput("abc");
      tui.handleBackspace();
      expect(tui.state.inputBuffer).toBe("ab");
      tui.handleBackspace();
      tui.handleBackspace();
      tui.handleBackspace();
      expect(tui.state.inputBuffer).toBe("");
    });

    it("should return empty for blank input on submit", async () => {
      const result = await tui.submit();
      expect(result).toBe("");
    });

    it("should add user message on regular submit", async () => {
      tui.handleInput("Hello world");
      const result = await tui.submit();
      expect(result).toBe("Hello world");
      expect(tui.state.messages).toHaveLength(1);
      expect(tui.state.messages[0].content).toBe("Hello world");
      expect(tui.state.inputBuffer).toBe("");
    });

    it("should store submitted input in command history", async () => {
      tui.handleInput("command1");
      await tui.submit();
      expect(tui.state.commandHistory).toContain("command1");
    });
  });

  // ── Command Execution ───────────────────────────────────

  describe("command execution", () => {
    beforeEach(() => {
      tui.registerBuiltins();
    });

    it("should execute /help command", async () => {
      tui.handleInput("/help");
      const result = await tui.submit();
      expect(result).toContain("/help");
      expect(result).toContain("/status");
      expect(result).toContain("/clear");
      expect(result).toContain("/exit");
    });

    it("should execute /status command with alias /st", async () => {
      tui.handleInput("/st");
      const result = await tui.submit();
      expect(result).toContain("Channels:");
      expect(result).toContain("Provider:");
    });

    it("should show unknown command message", async () => {
      tui.handleInput("/unknown");
      const result = await tui.submit();
      expect(result).toContain("Unknown command");
    });

    it("should suggest similar commands for typos", async () => {
      tui.handleInput("/hel");
      const result = await tui.submit();
      expect(result).toContain("Did you mean");
    });

    it("should execute /clear command", async () => {
      tui.addUserMessage("msg1");
      tui.addUserMessage("msg2");
      tui.handleInput("/clear");
      await tui.submit();
      // /clear adds a system confirmation message
      expect(tui.state.messages.filter((m) => m.role !== "system")).toEqual([]);
      expect(tui.state.messages[0].content).toBe("Conversation cleared.");
    });

    it("should execute /exit and emit exit event", async () => {
      const spy = vi.fn();
      tui.on("exit", spy);
      tui.handleInput("/exit");
      const result = await tui.submit();
      expect(result).toBe("Goodbye!");
      expect(spy).toHaveBeenCalled();
    });
  });

  // ── Panel Management ────────────────────────────────────

  describe("panel management", () => {
    it("should switch panels", () => {
      tui.switchPanel("status");
      expect(tui.state.activePanel).toBe("status");
      tui.switchPanel("logs");
      expect(tui.state.activePanel).toBe("logs");
    });

    it("should cycle through panels with nextPanel", () => {
      expect(tui.state.activePanel).toBe("conversation");
      tui.nextPanel();
      expect(tui.state.activePanel).toBe("status");
      tui.nextPanel();
      expect(tui.state.activePanel).toBe("logs");
      tui.nextPanel();
      expect(tui.state.activePanel).toBe("channels");
      tui.nextPanel();
      expect(tui.state.activePanel).toBe("help");
      tui.nextPanel();
      expect(tui.state.activePanel).toBe("conversation"); // wraps around
    });
  });

  // ── Status Updates ──────────────────────────────────────

  describe("status updates", () => {
    it("should merge partial status updates", () => {
      tui.updateStatus({
        provider: { name: "openai", model: "gpt-4", healthy: true },
      });
      expect(tui.state.status.provider.name).toBe("openai");
      expect(tui.state.status.provider.model).toBe("gpt-4");
    });

    it("should update uptime on status refresh", () => {
      vi.advanceTimersByTime(5000);
      tui.refreshUptime();
      expect(tui.state.status.uptime).toBeGreaterThanOrEqual(5000);
    });
  });

  // ── Notifications ───────────────────────────────────────

  describe("notifications", () => {
    it("should add notifications", () => {
      tui.notify("info", "Test notification");
      expect(tui.state.notifications).toHaveLength(1);
      expect(tui.state.notifications[0].type).toBe("info");
      expect(tui.state.notifications[0].message).toBe("Test notification");
    });

    it("should auto-dismiss notifications after TTL", () => {
      tui.notify("info", "Auto-dismiss", 500);
      expect(tui.state.notifications).toHaveLength(1);

      vi.advanceTimersByTime(600);
      expect(tui.state.notifications).toHaveLength(0);
    });

    it("should support persistent notifications (TTL 0)", () => {
      tui.notify("error", "Persistent", 0);
      vi.advanceTimersByTime(10000);
      expect(tui.state.notifications).toHaveLength(1);
    });

    it("should dismiss notification manually", () => {
      tui.notify("warning", "Dismiss me");
      const id = tui.state.notifications[0].id;
      tui.dismissNotification(id);
      expect(tui.state.notifications).toHaveLength(0);
    });
  });

  // ── Command Registration ────────────────────────────────

  describe("command registration", () => {
    it("should register custom commands", () => {
      tui.registerCommand({
        name: "test",
        aliases: ["t"],
        description: "Test command",
        handler: async () => "Test result",
      });

      const cmds = tui.getCommands();
      expect(cmds.some((c) => c.name === "test")).toBe(true);
    });

    it("should support auto-complete for commands", () => {
      tui.registerBuiltins();

      const suggestions = tui.autoComplete("/st");
      expect(suggestions).toContain("/status");
      expect(suggestions).toContain("/st");
    });

    it("should return empty for non-command auto-complete", () => {
      const suggestions = tui.autoComplete("hello");
      expect(suggestions).toEqual([]);
    });
  });

  // ── History Navigation ──────────────────────────────────

  describe("history navigation", () => {
    beforeEach(async () => {
      tui.handleInput("msg1");
      await tui.submit();
      tui.handleInput("msg2");
      await tui.submit();
      tui.handleInput("msg3");
      await tui.submit();
    });

    it("should navigate up through history", () => {
      const result1 = tui.navigateHistory("up", -1);
      expect(result1.text).toBe("msg3");
      expect(result1.index).toBe(0);

      const result2 = tui.navigateHistory("up", 0);
      expect(result2.text).toBe("msg2");
      expect(result2.index).toBe(1);
    });

    it("should navigate down through history", () => {
      const up1 = tui.navigateHistory("up", -1); // index 0 = msg3
      const up2 = tui.navigateHistory("up", up1.index); // index 1 = msg2
      const down = tui.navigateHistory("down", up2.index);
      expect(down.index).toBe(0);
    });

    it("should return empty at history boundary", () => {
      const result = tui.navigateHistory("down", -1);
      expect(result.text).toBe("");
      expect(result.index).toBe(-1);
    });
  });

  // ── Layout Helpers ──────────────────────────────────────

  describe("layout helpers", () => {
    it("should get recent messages", () => {
      for (let i = 0; i < 20; i++) {
        tui.addUserMessage(`msg_${i}`);
      }
      const recent = tui.getRecentMessages(5);
      expect(recent).toHaveLength(5);
    });

    it("should format timestamps", () => {
      const ts = new Date("2024-06-15T14:30:45").getTime();
      const formatted = tui.formatTime(ts);
      expect(formatted).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it("should return summary string", () => {
      tui.addUserMessage("user msg");
      tui.addAssistantMessage("assistant msg");
      const summary = tui.getSummary();
      expect(summary).toContain("2 msgs");
      expect(summary).toContain("1 user");
      expect(summary).toContain("idle");
    });
  });

  // ── Shutdown ────────────────────────────────────────────

  describe("shutdown", () => {
    it("should remove all listeners on shutdown", () => {
      const spy = vi.fn();
      tui.on("update", spy);
      tui.shutdown();
      tui.addUserMessage("test");
      expect(spy).not.toHaveBeenCalled();
    });
  });
});