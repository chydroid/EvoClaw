/**
 * TUI Terminal Interface — interactive terminal UI for EvoClaw.
 *
 * Provides a rich terminal-based experience for:
 *  - Live conversation view with the agent
 *  - System status dashboard (channels, providers, evolution)
 *  - Interactive command input with auto-complete
 *  - Split-pane layout (conversation + status)
 *  - Log viewer with filtering
 *
 * Uses ink.js (React for CLI) for rendering, with keyboard input
 * handling for interactive navigation. Designed to be lightweight
 * and usable over SSH/tmux.
 *
 * This module provides the logic and data flow; rendering is
 * handled by the CLI app using ink components.
 */

import { EventEmitter } from "events";
import * as crypto from "crypto";

// ── Types ─────────────────────────────────────────────────

export type TUIPanel = "conversation" | "status" | "logs" | "channels" | "help";

export interface TUIState {
  /** Active panel */
  activePanel: TUIPanel;
  /** Conversation messages (latest first) */
  messages: TUIMessage[];
  /** System status */
  status: TUIStatus;
  /** Input buffer (what user is typing) */
  inputBuffer: string;
  /** Command history */
  commandHistory: string[];
  /** Whether agent is currently processing */
  isProcessing: boolean;
  /** Current typing indicator text */
  typingText: string;
  /** Notifications queue */
  notifications: TUINotification[];
}

export interface TUIMessage {
  id: string;
  role: "user" | "assistant" | "system" | "error";
  content: string;
  timestamp: number;
  channel?: string;
  /** Whether this message was from a connected channel */
  fromChannel?: boolean;
}

export interface TUIStatus {
  /** Connected channels with online status */
  channels: Array<{ type: string; label: string; online: boolean; msgCount: number }>;
  /** Active provider info */
  provider: { name: string; model: string; healthy: boolean };
  /** Evolution state */
  evolution: { active: boolean; cycles: number; lastCycle?: number };
  /** Memory usage */
  memory: { sessions: number; entries: number };
  /** System uptime (ms) */
  uptime: number;
  /** Server version */
  version: string;
}

export interface TUINotification {
  id: string;
  type: "info" | "warning" | "error" | "success";
  message: string;
  timestamp: number;
  /** Auto-dismiss after ms (0 = persistent) */
  dismissAfter: number;
}

export interface TUICommand {
  name: string;
  aliases: string[];
  description: string;
  handler: (args: string[]) => Promise<string>;
}

export interface TUIConfig {
  /** Max messages to keep in conversation view */
  maxMessages?: number;
  /** Max command history entries */
  maxHistory?: number;
  /** Auto-scroll notification dismiss default (ms) */
  notificationTTLMs?: number;
  /** Whether to show channel messages in conversation */
  showChannelMessages?: boolean;
}

// ── TUI Manager ──────────────────────────────────────────

export class TUIManager extends EventEmitter {
  state: TUIState;
  private config: Required<TUIConfig>;
  private commands = new Map<string, TUICommand>();
  private startTime: number;

  constructor(config: TUIConfig = {}) {
    super();
    this.config = {
      maxMessages: config.maxMessages ?? 500,
      maxHistory: config.maxHistory ?? 100,
      notificationTTLMs: config.notificationTTLMs ?? 8000,
      showChannelMessages: config.showChannelMessages ?? true,
    };

    this.startTime = Date.now();

    this.state = {
      activePanel: "conversation",
      messages: [],
      status: {
        channels: [],
        provider: { name: "none", model: "none", healthy: false },
        evolution: { active: false, cycles: 0 },
        memory: { sessions: 0, entries: 0 },
        uptime: 0,
        version: "0.4.0",
      },
      inputBuffer: "",
      commandHistory: [],
      isProcessing: false,
      typingText: "",
      notifications: [],
    };
  }

  // ── Message Management ─────────────────────────────────

  /** Add a user message to the conversation */
  addUserMessage(content: string, channel?: string): void {
    this.state.messages.push({
      id: `msg_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`,
      role: "user",
      content,
      timestamp: Date.now(),
      channel,
    });
    this.trimMessages();
    this.emit("update");
  }

  /** Add an assistant message */
  addAssistantMessage(content: string): void {
    this.state.messages.push({
      id: `msg_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`,
      role: "assistant",
      content,
      timestamp: Date.now(),
    });
    this.trimMessages();
    this.emit("update");
  }

  /** Add a system message (status, info) */
  addSystemMessage(content: string): void {
    this.state.messages.push({
      id: `sys_${Date.now()}`,
      role: "system",
      content,
      timestamp: Date.now(),
    });
    this.trimMessages();
    this.emit("update");
  }

  /** Add an error message */
  addErrorMessage(content: string): void {
    this.state.messages.push({
      id: `err_${Date.now()}`,
      role: "error",
      content,
      timestamp: Date.now(),
    });
    this.emit("update");
  }

  /** Update typing indicator (shows what the agent is "typing") */
  setTyping(text: string): void {
    this.state.typingText = text;
    this.emit("update");
  }

  // ── Processing State ────────────────────────────────────

  setProcessing(active: boolean): void {
    this.state.isProcessing = active;
    if (!active) {
      this.state.typingText = "";
    }
    this.emit("update");
  }

  // ── Input Management ────────────────────────────────────

  /** Handle character input */
  handleInput(char: string): void {
    this.state.inputBuffer += char;
    this.emit("update");
  }

  /** Handle backspace */
  handleBackspace(): void {
    if (this.state.inputBuffer.length > 0) {
      this.state.inputBuffer = this.state.inputBuffer.slice(0, -1);
    }
    this.emit("update");
  }

  /** Submit current input as a command or message */
  async submit(): Promise<string> {
    const input = this.state.inputBuffer.trim();
    if (!input) return "";

    // Store in history
    this.state.commandHistory.unshift(input);
    if (this.state.commandHistory.length > this.config.maxHistory) {
      this.state.commandHistory.pop();
    }

    this.state.inputBuffer = "";

    // Check if it's a command (starts with /)
    if (input.startsWith("/")) {
      return this.executeCommand(input);
    }

    // Otherwise it's a regular message
    this.addUserMessage(input);
    return input;
  }

  /** Navigate command history (up/down) */
  navigateHistory(direction: "up" | "down", currentHistoryIndex: number): { text: string; index: number } {
    const total = this.state.commandHistory.length;
    if (total === 0) return { text: "", index: -1 };

    let newIndex: number;
    if (direction === "up") {
      newIndex = currentHistoryIndex < total - 1 ? currentHistoryIndex + 1 : currentHistoryIndex;
    } else {
      newIndex = currentHistoryIndex > 0 ? currentHistoryIndex - 1 : -1;
    }

    if (newIndex === -1) {
      return { text: "", index: -1 };
    }

    return { text: this.state.commandHistory[newIndex] ?? "", index: newIndex };
  }

  // ── Panel Management ────────────────────────────────────

  switchPanel(panel: TUIPanel): void {
    this.state.activePanel = panel;
    this.emit("update");
  }

  /** Cycle to next panel */
  nextPanel(): void {
    const panels: TUIPanel[] = ["conversation", "status", "logs", "channels", "help"];
    const idx = panels.indexOf(this.state.activePanel);
    this.state.activePanel = panels[(idx + 1) % panels.length];
    this.emit("update");
  }

  // ── Status Updates ──────────────────────────────────────

  updateStatus(partial: Partial<TUIStatus>): void {
    Object.assign(this.state.status, partial);
    this.state.status.uptime = Date.now() - this.startTime;
    this.emit("update");
  }

  /** Refresh uptime counter */
  refreshUptime(): void {
    this.state.status.uptime = Date.now() - this.startTime;
    this.emit("update");
  }

  // ── Notifications ───────────────────────────────────────

  notify(type: TUINotification["type"], message: string, dismissAfter?: number): void {
    const notif: TUINotification = {
      id: `notif_${Date.now()}`,
      type,
      message,
      timestamp: Date.now(),
      dismissAfter: dismissAfter ?? this.config.notificationTTLMs,
    };

    this.state.notifications.push(notif);

    // Auto-dismiss
    if (notif.dismissAfter > 0) {
      setTimeout(() => this.dismissNotification(notif.id), notif.dismissAfter);
    }

    this.emit("update");
  }

  dismissNotification(id: string): void {
    this.state.notifications = this.state.notifications.filter((n) => n.id !== id);
    this.emit("update");
  }

  // ── Command Registration ────────────────────────────────

  registerCommand(command: TUICommand): void {
    this.commands.set(command.name, command);
    for (const alias of command.aliases) {
      this.commands.set(alias, command);
    }
  }

  /** Get list of registered commands for auto-complete */
  getCommands(): Array<{ name: string; description: string }> {
    const seen = new Set<string>();
    const result: Array<{ name: string; description: string }> = [];
    for (const cmd of this.commands.values()) {
      if (!seen.has(cmd.name)) {
        seen.add(cmd.name);
        result.push({ name: cmd.name, description: cmd.description });
      }
    }
    return result;
  }

  /** Auto-complete suggestions for partial input */
  autoComplete(partial: string): string[] {
    if (!partial.startsWith("/")) return [];

    const prefix = partial.slice(1).toLowerCase();
    const suggestions: string[] = [];

    for (const cmd of this.commands.values()) {
      if (cmd.name.startsWith(prefix)) {
        suggestions.push(`/${cmd.name}`);
      }
      for (const alias of cmd.aliases) {
        if (alias.startsWith(prefix) && !suggestions.includes(`/${alias}`)) {
          suggestions.push(`/${alias}`);
        }
      }
    }

    return suggestions.sort();
  }

  // ── Built-in Commands ───────────────────────────────────

  /** Register built-in TUI commands */
  registerBuiltins(): void {
    this.registerCommand({
      name: "help",
      aliases: ["h", "?"],
      description: "Show available commands",
      handler: async () => {
        const cmds = this.getCommands();
        return cmds.map((c) => `  /${c.name.padEnd(12)} ${c.description}`).join("\n");
      },
    });

    this.registerCommand({
      name: "clear",
      aliases: ["cls"],
      description: "Clear conversation view",
      handler: async () => {
        this.state.messages = [];
        this.emit("update");
        return "Conversation cleared.";
      },
    });

    this.registerCommand({
      name: "status",
      aliases: ["st"],
      description: "Show system status",
      handler: async () => {
        this.switchPanel("status");
        const s = this.state.status;
        return [
          `Channels: ${s.channels.filter((c) => c.online).length}/${s.channels.length} online`,
          `Provider: ${s.provider.name} / ${s.provider.model} (${s.provider.healthy ? "healthy" : "unhealthy"})`,
          `Evolution: ${s.evolution.cycles} cycles`,
          `Memory: ${s.memory.sessions} sessions, ${s.memory.entries} entries`,
          `Uptime: ${Math.floor(s.uptime / 3600000)}h ${Math.floor((s.uptime % 3600000) / 60000)}m`,
        ].join("\n");
      },
    });

    this.registerCommand({
      name: "exit",
      aliases: ["quit", "q"],
      description: "Exit TUI",
      handler: async () => {
        this.emit("exit");
        return "Goodbye!";
      },
    });

    this.registerCommand({
      name: "channels",
      aliases: ["ch"],
      description: "Show channel status",
      handler: async () => {
        this.switchPanel("channels");
        return this.state.status.channels
          .map((c) => `  ${c.online ? "●" : "○"} ${c.type.padEnd(12)} ${c.label} (${c.msgCount} msgs)`)
          .join("\n");
      },
    });
  }

  // ── Layout Helpers ──────────────────────────────────────

  /** Get the last N messages for the conversation panel */
  getRecentMessages(n = 50): TUIMessage[] {
    return this.state.messages.slice(-n);
  }

  /** Format a timestamp for display */
  formatTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  }

  /** Get conversation summary for status bar */
  getSummary(): string {
    const total = this.state.messages.length;
    const userMsgs = this.state.messages.filter((m) => m.role === "user").length;
    return `${total} msgs (${userMsgs} user) | Processing: ${this.state.isProcessing ? "yes" : "idle"}`;
  }

  // ── Internal ────────────────────────────────────────────

  private async executeCommand(input: string): Promise<string> {
    const parts = input.split(/\s+/);
    const cmdName = parts[0].slice(1).toLowerCase();
    const args = parts.slice(1);

    const cmd = this.commands.get(cmdName);
    if (!cmd) {
      const suggestions = this.autoComplete(input);
      const msg = suggestions.length > 0
        ? `Unknown command: /${cmdName}\nDid you mean: ${suggestions.slice(0, 5).join(", ")}?`
        : `Unknown command: /${cmdName}. Type /help for available commands.`;
      this.addSystemMessage(msg);
      return msg;
    }

    try {
      const result = await cmd.handler(args);
      this.addSystemMessage(result);
      return result;
    } catch (err) {
      const msg = `Command error: ${(err as Error).message}`;
      this.addErrorMessage(msg);
      return msg;
    }
  }

  private trimMessages(): void {
    if (this.state.messages.length > this.config.maxMessages) {
      this.state.messages = this.state.messages.slice(-this.config.maxMessages);
    }
  }

  /** Clean shutdown */
  shutdown(): void {
    this.removeAllListeners();
  }
}