/**
 * Context Focus — manages which session/channel context is actively
 * in view. Allows agents to switch focus between different conversation
 * contexts without losing state.
 *
 * OpenClaw-style /focus, /unfocus, /agents commands.
 *
 * Features:
 *  - Focus on a specific channel, session, or agent
 *  - Unfocus to return to default broadcast mode
 *  - List active contexts with metadata
 *  - Auto-focus on incoming DM (if configured)
 *  - Focus history for quick switching
 *  - Context isolation (each focus is an independent view)
 */

import { randomUUID } from "crypto";

// ── Types ─────────────────────────────────────────────────

export interface FocusTarget {
  /** Type of focus target */
  type: "channel" | "session" | "agent" | "peer";
  /** Target identifier */
  targetId: string;
  /** Human-friendly label */
  label: string;
  /** When focus was acquired (epoch ms) */
  focusedAt: number;
  /** Focus ID for history tracking */
  focusId: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface FocusContext {
  /** Current focus target (null = broadcast/unfocused) */
  current: FocusTarget | null;
  /** Focus history (most recent first) */
  history: FocusTarget[];
  /** Whether auto-focus on DM is enabled */
  autoFocusDM: boolean;
  /** Default channel when unfocused */
  defaultChannel?: string;
}

export interface ContextFocusConfig {
  /** Maximum focus history entries */
  maxHistory: number;
  /** Whether auto-focus on DM is enabled */
  autoFocusDM: boolean;
  /** Default broadcast channel */
  defaultChannel?: string;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: ContextFocusConfig = {
  maxHistory: 20,
  autoFocusDM: true,
};

// ── Manager ────────────────────────────────────────────────

export class ContextFocusManager {
  private config: ContextFocusConfig;
  private context: FocusContext;
  /** Registered contexts/channels that can be focused */
  private availableContexts = new Map<string, { type: FocusTarget["type"]; label: string; metadata?: Record<string, unknown> }>();

  constructor(config?: Partial<ContextFocusConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.context = {
      current: null,
      history: [],
      autoFocusDM: this.config.autoFocusDM,
      defaultChannel: this.config.defaultChannel,
    };
  }

  /**
   * Focus on a target (channel, session, agent, or peer).
   * Returns the new focus state.
   */
  focus(
    type: FocusTarget["type"],
    targetId: string,
    options?: { label?: string; metadata?: Record<string, unknown> },
  ): FocusTarget {
    // Push current to history before switching
    if (this.context.current) {
      this.context.history.unshift({ ...this.context.current });
      if (this.context.history.length > this.config.maxHistory) {
        this.context.history.pop();
      }
    }

    const focusTarget: FocusTarget = {
      type,
      targetId,
      label: options?.label ?? `${type}:${targetId}`,
      focusedAt: Date.now(),
      focusId: randomUUID(),
      metadata: options?.metadata,
    };

    this.context.current = focusTarget;

    // Register this context as available
    this.availableContexts.set(targetId, {
      type,
      label: focusTarget.label,
      metadata: options?.metadata,
    });

    return focusTarget;
  }

  /**
   * Focus on a channel.
   */
  focusChannel(channel: string, label?: string): FocusTarget {
    return this.focus("channel", channel, { label: label ?? channel });
  }

  /**
   * Focus on a session.
   */
  focusSession(sessionId: string, label?: string): FocusTarget {
    return this.focus("session", sessionId, { label: label ?? `Session ${sessionId.slice(0, 8)}` });
  }

  /**
   * Focus on an agent.
   */
  focusAgent(agentId: string, label?: string): FocusTarget {
    return this.focus("agent", agentId, { label: label ?? agentId });
  }

  /**
   * Focus on a specific peer (user).
   */
  focusPeer(peerId: string, label?: string): FocusTarget {
    return this.focus("peer", peerId, { label: label ?? peerId });
  }

  /**
   * Unfocus — return to broadcast/default mode.
   */
  unfocus(): { previous: FocusTarget | null; nowUnfocused: boolean } {
    const previous = this.context.current;
    this.context.current = null;
    return { previous, nowUnfocused: true };
  }

  /**
   * Switch focus to the most recent previous context.
   */
  focusPrevious(): FocusTarget | null {
    if (this.context.history.length === 0) return null;

    // Get the previous target from history first
    const previous = this.context.history.shift()!;

    // Push current to history before switching
    if (this.context.current) {
      this.context.history.unshift({ ...this.context.current });
    }

    const newFocus = this.focus(previous.type, previous.targetId, {
      label: previous.label,
      metadata: previous.metadata,
    });

    // Remove the duplicate that focus() added (it pushed the old current again)
    this.context.history.shift();

    return newFocus;
  }

  /**
   * Get the current focus target.
   */
  getCurrent(): FocusTarget | null {
    return this.context.current;
  }

  /**
   * Check if currently focused.
   */
  isFocused(): boolean {
    return this.context.current !== null;
  }

  /**
   * Check if a specific target is currently focused.
   */
  isTargetFocused(type: FocusTarget["type"], targetId: string): boolean {
    return (
      this.context.current !== null &&
      this.context.current.type === type &&
      this.context.current.targetId === targetId
    );
  }

  /**
   * Get focus history (most recent first).
   */
  getHistory(limit?: number): FocusTarget[] {
    if (limit) return this.context.history.slice(0, limit);
    return [...this.context.history];
  }

  /**
   * Clear focus history.
   */
  clearHistory(): void {
    this.context.history = [];
  }

  /**
   * Register a new available context for focus.
   */
  registerContext(
    id: string,
    type: FocusTarget["type"],
    label: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.availableContexts.set(id, { type, label, metadata });
  }

  /**
   * Unregister a context.
   */
  unregisterContext(id: string): void {
    this.availableContexts.delete(id);
  }

  /**
   * List all available contexts.
   */
  listAvailable(): Array<{ id: string; type: string; label: string; metadata?: Record<string, unknown> }> {
    return [...this.availableContexts.entries()].map(([id, ctx]) => ({
      id,
      type: ctx.type,
      label: ctx.label,
      metadata: ctx.metadata,
    }));
  }

  /**
   * Get a human-readable summary of the current context state.
   */
  getSummary(): string {
    if (!this.context.current) {
      const def = this.context.defaultChannel ?? "broadcast";
      return `Unfocused — messages go to ${def}`;
    }

    const target = this.context.current;
    const elapsed = Math.round((Date.now() - target.focusedAt) / 1000);
    const elapsedStr =
      elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m`;

    return [
      `Focused on ${target.type}: **${target.label}**`,
      `ID: \`${target.targetId}\``,
      `Duration: ${elapsedStr}`,
      `Auto-focus DM: ${this.context.autoFocusDM ? "on" : "off"}`,
      this.context.history.length > 0
        ? `History: ${this.context.history.length} entries`
        : null,
    ]
      .filter(Boolean)
      .join(" | ");
  }

  /**
   * Handle a slash command for context focus.
   * Supports: /focus, /unfocus, /agents
   */
  handleCommand(command: string, args: string[]): string {
    switch (command) {
      case "focus": {
        if (args.length < 2) {
          return "Usage: `/focus <type> <id>` — type can be `channel`, `session`, `agent`, or `peer`";
        }
        const [type, targetId] = args;
        const validTypes = ["channel", "session", "agent", "peer"];
        if (!validTypes.includes(type)) {
          return `Invalid focus type: "${type}". Valid: ${validTypes.join(", ")}`;
        }

        const target = this.focus(type as FocusTarget["type"], targetId);
        return `Focused on ${type}: \`${targetId}\``;
      }

      case "unfocus": {
        const result = this.unfocus();
        if (result.previous) {
          return `Unfocused from ${result.previous.type}: \`${result.previous.targetId}\`.`;
        }
        return "Already unfocused. Messages go to broadcast.";
      }

      case "agents": {
        const available = this.listAvailable();
        if (available.length === 0) {
          return "No registered contexts available. Use `/focus <type> <id>` to focus.";
        }

        const lines = available.map(
          (ctx) => `- ${ctx.type}: **${ctx.label}** (\`${ctx.id}\`)`,
        );

        const current = this.context.current
          ? `\nCurrently focused: ${this.context.current.type}: \`${this.context.current.targetId}\``
          : "\nCurrently unfocused.";

        return [
          `**Available Contexts** (${available.length})`,
          "",
          ...lines,
          current,
        ].join("\n");
      }

      default:
        return `Unknown focus command: ${command}`;
    }
  }

  /**
   * Check if a new incoming message should auto-focus.
   */
  shouldAutoFocus(channel: string, isDirect: boolean): boolean {
    if (!this.context.autoFocusDM) return false;
    if (!isDirect) return false;
    if (this.isTargetFocused("channel", channel)) return false;
    return true;
  }

  /**
   * Set auto-focus DM setting.
   */
  setAutoFocusDM(enabled: boolean): void {
    this.context.autoFocusDM = enabled;
    this.config.autoFocusDM = enabled;
  }

  configure(updates: Partial<ContextFocusConfig>): void {
    this.config = { ...this.config, ...updates };
    if (updates.autoFocusDM !== undefined) {
      this.context.autoFocusDM = updates.autoFocusDM;
    }
  }
}