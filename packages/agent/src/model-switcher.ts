/**
 * Model Switcher — runtime model management with aliases,
 * provider lookup, and the `/model` chat command.
 *
 * Features:
 *  - Model aliases: map friendly names to provider+modelId pairs
 *  - Runtime switching: change active model without restart
 *  - Provider capabilities: max tokens, supports vision, supports function calling
 *  - Model listing: list all registered models with status
 *  - `/model` command: list/switch models via chat
 *  - Per-session model override
 *  - Model presets for common tasks (code, creative, analysis, fast)
 *  - Switch history with undo
 */

// ── Types ─────────────────────────────────────────────────

export interface ModelAlias {
  /** Friendly alias name (e.g., "gpt4", "claude", "fast") */
  alias: string;
  /** Provider ID (e.g., "openai", "anthropic", "local") */
  providerId: string;
  /** Model ID within the provider (e.g., "gpt-4o", "claude-sonnet-4-20250514") */
  modelId: string;
  /** Human-readable description */
  description?: string;
  /** Context window size in tokens */
  maxTokens?: number;
  /** Whether this model supports vision/image input */
  supportsVision?: boolean;
  /** Whether this model supports function calling */
  supportsFunctions?: boolean;
  /** Cost tier: cheap, standard, premium */
  costTier?: "cheap" | "standard" | "premium";
}

export interface ModelPreset {
  /** Preset name (e.g., "coding", "creative", "analysis", "fast") */
  name: string;
  /** Model alias to use */
  modelAlias: string;
  /** Description of when to use this preset */
  description: string;
  /** Whether this preset is recommended as default */
  recommended?: boolean;
}

export interface ActiveModel {
  /** Current model alias */
  alias: string;
  /** Full model info */
  model: ModelAlias;
  /** When the model was activated */
  activatedAt: number;
  /** Session ID this model is active for (undefined = global) */
  sessionId?: string;
}

export interface ModelSwitchEvent {
  from: string;
  to: string;
  timestamp: number;
  reason: "manual" | "failover" | "preset" | "default";
}

export interface ModelSwitcherConfig {
  /** Default model alias to use */
  defaultAlias: string;
  /** Maximum switch history entries */
  maxHistory: number;
  /** Whether to auto-switch on failover */
  autoSwitchOnFailover: boolean;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: ModelSwitcherConfig = {
  defaultAlias: "fast",
  maxHistory: 50,
  autoSwitchOnFailover: false,
};

// ── Built-in model presets ────────────────────────────────

const BUILTIN_PRESETS: ModelPreset[] = [
  { name: "coding", modelAlias: "gpt4", description: "Software development and code generation", recommended: false },
  { name: "creative", modelAlias: "claude", description: "Creative writing and brainstorming", recommended: false },
  { name: "analysis", modelAlias: "gpt4", description: "Deep analysis and research tasks", recommended: false },
  { name: "fast", modelAlias: "fast", description: "Quick responses for simple queries", recommended: true },
  { name: "vision", modelAlias: "vision", description: "Image understanding tasks", recommended: false },
];

// ── Manager ───────────────────────────────────────────────

export class ModelSwitcher {
  private config: ModelSwitcherConfig;
  private aliases = new Map<string, ModelAlias>();
  private presets = new Map<string, ModelPreset>();
  private active: ActiveModel;
  private sessionOverrides = new Map<string, string>(); // sessionId → alias
  private switchHistory: ModelSwitchEvent[] = [];

  constructor(config?: Partial<ModelSwitcherConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.active = {
      alias: this.config.defaultAlias,
      model: { alias: this.config.defaultAlias, providerId: "unknown", modelId: "unknown" },
      activatedAt: Date.now(),
    };

    // Register built-in presets
    for (const preset of BUILTIN_PRESETS) {
      this.presets.set(preset.name, preset);
    }
  }

  /**
   * Register a model alias.
   */
  registerAlias(alias: ModelAlias): void {
    this.aliases.set(alias.alias, alias);

    // If this is the default and no model is active yet, activate it silently
    if (alias.alias === this.config.defaultAlias && this.active.model.modelId === "unknown") {
      this.active = {
        alias: alias.alias,
        model: alias,
        activatedAt: Date.now(),
      };
      // Don't record in history — this is initialization, not a user switch
    }
  }

  /**
   * Register multiple aliases at once.
   */
  registerAllAliases(aliases: ModelAlias[]): void {
    for (const alias of aliases) {
      this.registerAlias(alias);
    }
  }

  /**
   * Register a model preset.
   */
  registerPreset(preset: ModelPreset): void {
    this.presets.set(preset.name, preset);
  }

  /**
   * Activate a model by alias.
   */
  activate(alias: string, reason: ModelSwitchEvent["reason"] = "manual"): ActiveModel {
    const model = this.aliases.get(alias);
    if (!model) {
      throw new Error(`Unknown model alias: "${alias}". Use /model to list available models.`);
    }

    const previous = this.active.alias;
    this.active = {
      alias,
      model,
      activatedAt: Date.now(),
    };

    this.switchHistory.push({
      from: previous,
      to: alias,
      timestamp: Date.now(),
      reason,
    });

    // Trim history
    if (this.switchHistory.length > this.config.maxHistory) {
      this.switchHistory = this.switchHistory.slice(-this.config.maxHistory);
    }

    return this.active;
  }

  /**
   * Get the currently active model.
   */
  getActive(): ActiveModel {
    return this.active;
  }

  /**
   * Get the active model for a specific session (with override support).
   */
  getActiveForSession(sessionId?: string): ActiveModel {
    if (sessionId && this.sessionOverrides.has(sessionId)) {
      const alias = this.sessionOverrides.get(sessionId)!;
      const model = this.aliases.get(alias);
      if (model) {
        return { alias, model, activatedAt: Date.now(), sessionId };
      }
    }
    return this.active;
  }

  /**
   * Override the model for a specific session.
   */
  setSessionOverride(sessionId: string, alias: string): void {
    if (!this.aliases.has(alias)) {
      throw new Error(`Unknown model alias: "${alias}"`);
    }
    this.sessionOverrides.set(sessionId, alias);
  }

  /**
   * Clear a session's model override.
   */
  clearSessionOverride(sessionId: string): boolean {
    return this.sessionOverrides.delete(sessionId);
  }

  /**
   * Switch to a model by preset name.
   */
  activatePreset(presetName: string): ActiveModel {
    const preset = this.presets.get(presetName);
    if (!preset) {
      throw new Error(`Unknown preset: "${presetName}"`);
    }
    return this.activate(preset.modelAlias, "preset");
  }

  /**
   * Get a model alias by name.
   */
  getAlias(name: string): ModelAlias | null {
    return this.aliases.get(name) ?? null;
  }

  /**
   * List all registered model aliases.
   */
  listAliases(): ModelAlias[] {
    return [...this.aliases.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  }

  /**
   * List all registered presets.
   */
  listPresets(): ModelPreset[] {
    return [...this.presets.values()];
  }

  /**
   * Get the default alias.
   */
  getDefaultAlias(): string {
    return this.config.defaultAlias;
  }

  /**
   * Get switch history.
   */
  getHistory(limit?: number): ModelSwitchEvent[] {
    if (limit) return this.switchHistory.slice(-limit);
    return [...this.switchHistory];
  }

  /**
   * Undo last switch.
   */
  undo(): ActiveModel | null {
    if (this.switchHistory.length === 0) return null;

    const last = this.switchHistory.pop()!;
    const model = this.aliases.get(last.from);
    if (!model) return null;

    this.active = {
      alias: last.from,
      model,
      activatedAt: Date.now(),
    };

    return this.active;
  }

  /**
   * Handle `/model` command. Returns a formatted response string.
   */
  handleModelCommand(args: string[]): string {
    if (args.length === 0) {
      // List available models
      return this.formatModelList();
    }

    const subCommand = args[0].toLowerCase();

    switch (subCommand) {
      case "list":
      case "ls":
        return this.formatModelList();

      case "presets":
        return this.formatPresetList();

      case "switch":
      case "use": {
        if (args.length < 2) {
          return `Usage: /model ${subCommand} <alias|preset>`;
        }
        try {
          const target = args[1];
          // Try preset first
          if (this.presets.has(target)) {
            const result = this.activatePreset(target);
            return `Switched to ${result.model.description ?? result.alias} (${result.model.providerId}/${result.model.modelId})`;
          }
          const result = this.activate(target, "manual");
          return `Switched to ${result.model.description ?? result.alias} (${result.model.providerId}/${result.model.modelId})`;
        } catch (err) {
          return (err as Error).message;
        }
      }

      case "current":
      case "active": {
        const a = this.active;
        return `Current model: ${a.model.description ?? a.alias} (${a.model.providerId}/${a.model.modelId})`;
      }

      case "undo": {
        const result = this.undo();
        if (!result) return "No previous model to switch back to.";
        return `Switched back to ${result.model.description ?? result.alias} (${result.model.providerId}/${result.model.modelId})`;
      }

      default:
        return `Unknown /model subcommand: "${subCommand}". Available: list, presets, switch <alias>, current, undo`;
    }
  }

  /**
   * Set the default alias.
   */
  setDefaultAlias(alias: string): void {
    if (!this.aliases.has(alias)) {
      throw new Error(`Unknown model alias: "${alias}"`);
    }
    this.config.defaultAlias = alias;
    if (this.active.model.modelId === "unknown") {
      this.activate(alias, "default");
    }
  }

  configure(updates: Partial<ModelSwitcherConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ── Private ─────────────────────────────────────────────

  private formatModelList(): string {
    const aliases = this.listAliases();
    if (aliases.length === 0) {
      return "No models registered. Use registerAlias() to add models.";
    }

    const lines: string[] = ["Available models:"];
    for (const a of aliases) {
      const isActive = a.alias === this.active.alias ? " [active]" : "";
      const tier = a.costTier ? ` (${a.costTier})` : "";
      const caps: string[] = [];
      if (a.supportsVision) caps.push("vision");
      if (a.supportsFunctions) caps.push("functions");
      const capStr = caps.length > 0 ? ` [${caps.join(", ")}]` : "";

      lines.push(`  ${a.alias}${isActive} — ${a.description ?? a.modelId}${tier}${capStr}`);
    }

    return lines.join("\n");
  }

  private formatPresetList(): string {
    const presets = this.listPresets();
    const lines: string[] = ["Available presets:"];
    for (const p of presets) {
      const rec = p.recommended ? " [recommended]" : "";
      lines.push(`  ${p.name}${rec} → ${p.modelAlias} — ${p.description}`);
    }
    return lines.join("\n");
  }
}