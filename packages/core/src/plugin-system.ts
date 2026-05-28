/**
 * Plugin Hook System — OpenClaw-style plugin API with comprehensive lifecycle hooks.
 *
 * Plugins can register hooks to intercept and modify agent behavior at every stage
 * of the lifecycle. Hooks run in priority order and can block, transform, or augment data.
 */

import type { EventBus } from "./event-bus";
import type { ServiceRegistry } from "./service-registry";

// ─── Hook Types ───────────────────────────────────────────────────────────────

export type HookPriority = "first" | "normal" | "last";

export interface HookContext {
  /** Session ID (if available) */
  sessionId?: string;
  /** Agent ID */
  agentId?: string;
  /** Run ID */
  runId?: string;
  /** Channel source (e.g. "whatsapp", "telegram") */
  channel?: string;
  /** User/peer identifier */
  peerId?: string;
  /** Whether this is a sandboxed run */
  sandboxed?: boolean;
}

export interface HookBaseResult {
  /** Set to true to block further processing */
  block?: boolean;
  /** Set to true to cancel message sending */
  cancel?: boolean;
  /** Error message if blocked */
  error?: string;
}

// ─── Individual Hook Types ────────────────────────────────────────────────────

/** Before agent starts processing a turn */
export interface BeforeAgentStartHook {
  type: "before_agent_start";
  context: HookContext;
  /** The incoming message */
  message: string;
  /** Attachments (if any) */
  attachments?: Array<{ name: string; type: string; url?: string; data?: Buffer }>;
}

export interface BeforeAgentStartResult extends HookBaseResult {
  /** Override the message content */
  message?: string;
  /** Synthetic reply — skip LLM entirely */
  syntheticReply?: string;
}

/** Before the LLM call, after context assembly */
export interface BeforeAgentReplyHook {
  type: "before_agent_reply";
  context: HookContext;
  /** Assembled messages going to the model */
  messages: Array<{ role: string; content: string | null }>;
  /** Model being used */
  model: string;
  /** Provider being used */
  provider: string;
}

export interface BeforeAgentReplyResult extends HookBaseResult {
  /** Claim the turn with a synthetic reply (skips LLM) */
  syntheticReply?: string;
  /** Append extra system context */
  appendSystemContext?: string;
  /** Prepend extra system context */
  prependSystemContext?: string;
}

/** After agent completes a turn */
export interface AgentEndHook {
  type: "agent_end";
  context: HookContext;
  /** Final messages in the session after the turn */
  messages: Array<{ role: string; content: string | null }>;
  /** Run metadata */
  metadata: {
    tokensUsed: number;
    duration: number;
    toolCalls: number;
    success: boolean;
    error?: string;
  };
}

export interface AgentEndResult extends HookBaseResult {
  /* no additional fields */
}

/** Before model resolution */
export interface BeforeModelResolveHook {
  type: "before_model_resolve";
  context: HookContext;
  /** Current model config */
  model: string;
  provider: string;
}

export interface BeforeModelResolveResult extends HookBaseResult {
  /** Override model ID */
  model?: string;
  /** Override provider */
  provider?: string;
}

/** Before prompt is built (has access to session messages) */
export interface BeforePromptBuildHook {
  type: "before_prompt_build";
  context: HookContext;
  /** Session messages so far */
  messages: Array<{ role: string; content: string | null }>;
  /** Current system prompt */
  systemPrompt: string;
}

export interface BeforePromptBuildResult extends HookBaseResult {
  /** Append to system prompt */
  appendSystemContext?: string;
  /** Prepend to system prompt */
  prependSystemContext?: string;
  /** Prepend to message context (per-turn dynamic text) */
  prependContext?: string;
}

/** Before/after tool calls */
export interface BeforeToolCallHook {
  type: "before_tool_call";
  context: HookContext;
  /** Tool name */
  toolName: string;
  /** Tool parameters */
  params: Record<string, unknown>;
}

export interface BeforeToolCallResult extends HookBaseResult {
  /** Override tool parameters */
  params?: Record<string, unknown>;
  /** Skip tool execution and return this as result */
  skipWithResult?: unknown;
}

export interface AfterToolCallHook {
  type: "after_tool_call";
  context: HookContext;
  /** Tool name */
  toolName: string;
  /** Tool parameters (as executed) */
  params: Record<string, unknown>;
  /** Tool result */
  result: unknown;
  /** Whether the tool call errored */
  errored: boolean;
  /** Error message if errored */
  error?: string;
}

export interface AfterToolCallResult extends HookBaseResult {
  /** Transform the result */
  result?: unknown;
}

/** Transform tool results before persisting to transcript */
export interface ToolResultPersistHook {
  type: "tool_result_persist";
  context: HookContext;
  /** Tool name */
  toolName: string;
  /** Raw result */
  result: string;
}

export interface ToolResultPersistResult {
  /** Transformed result */
  result: string;
}

/** Compaction lifecycle hooks */
export interface BeforeCompactionHook {
  type: "before_compaction";
  context: HookContext;
  /** Number of turns being compacted */
  turnCount: number;
  /** Why compaction was triggered */
  reason: "auto" | "manual" | "overflow" | "byte_guard";
}

export interface BeforeCompactionResult extends HookBaseResult {
  /** Custom compaction instructions */
  instructions?: string;
}

export interface AfterCompactionHook {
  type: "after_compaction";
  context: HookContext;
  /** Summary produced */
  summary: string;
  /** Number of turns compacted */
  turnCount: number;
  /** Successor session ID */
  successorSessionId?: string;
}

export interface AfterCompactionResult extends HookBaseResult {
  /* no additional fields */
}

/** Message lifecycle hooks */
export interface MessageReceivedHook {
  type: "message_received";
  context: HookContext;
  /** Raw message text */
  text: string;
  /** Message metadata */
  metadata: Record<string, unknown>;
}

export interface MessageReceivedResult extends HookBaseResult {
  /** Transform the message text */
  text?: string;
}

export interface MessageSendingHook {
  type: "message_sending";
  context: HookContext;
  /** Message text about to be sent */
  text: string;
  /** Target (channel-specific identifier) */
  target: string;
}

export interface MessageSendingResult extends HookBaseResult {
  /** Transform the message */
  text?: string;
}

export interface MessageSentHook {
  type: "message_sent";
  context: HookContext;
  /** Message text that was sent */
  text: string;
  /** Target */
  target: string;
  /** Delivery success */
  success: boolean;
}

export interface MessageSentResult extends HookBaseResult {
  /* no additional fields — this is a notification hook */
}

/** Session lifecycle hooks */
export interface SessionStartHook {
  type: "session_start";
  context: HookContext;
}

export interface SessionStartResult extends HookBaseResult {
  /* no additional fields */
}

export interface SessionEndHook {
  type: "session_end";
  context: HookContext;
  /** Reason for session end */
  reason: "completed" | "timeout" | "error" | "reset" | "new_session";
}

export interface SessionEndResult extends HookBaseResult {
  /* no additional fields */
}

/** Gateway lifecycle hooks */
export interface GatewayStartHook {
  type: "gateway_start";
}

export interface GatewayStopHook {
  type: "gateway_stop";
}

/** Before skill/plugin install */
export interface BeforeInstallHook {
  type: "before_install";
  /** Package name */
  packageName: string;
  /** Package version */
  version: string;
  /** Install source */
  source: string;
  /** Scan findings (if scanned) */
  scanFindings?: string[];
}

export interface BeforeInstallResult extends HookBaseResult {
  /** Human-readable reason for blocking */
  reason?: string;
}

// ─── Union Hook Types ─────────────────────────────────────────────────────────

export type PluginHook =
  | BeforeAgentStartHook
  | BeforeAgentReplyHook
  | AgentEndHook
  | BeforeModelResolveHook
  | BeforePromptBuildHook
  | BeforeToolCallHook
  | AfterToolCallHook
  | ToolResultPersistHook
  | BeforeCompactionHook
  | AfterCompactionHook
  | MessageReceivedHook
  | MessageSendingHook
  | MessageSentHook
  | SessionStartHook
  | SessionEndHook
  | GatewayStartHook
  | GatewayStopHook
  | BeforeInstallHook;

export type PluginHookResult =
  | BeforeAgentStartResult
  | BeforeAgentReplyResult
  | AgentEndResult
  | BeforeModelResolveResult
  | BeforePromptBuildResult
  | BeforeToolCallResult
  | AfterToolCallResult
  | ToolResultPersistResult
  | BeforeCompactionResult
  | AfterCompactionResult
  | MessageReceivedResult
  | MessageSendingResult
  | MessageSentResult
  | SessionStartResult
  | SessionEndResult
  | BeforeInstallResult;

// ─── Plugin Manifest ──────────────────────────────────────────────────────────

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  /** Minimum EvoClaw version required */
  minVersion?: string;
}

export interface PluginHookRegistration {
  hookType: PluginHook["type"];
  priority: HookPriority;
  handler: (hook: PluginHook) => Promise<PluginHookResult | void> | PluginHookResult | void;
}

export interface Plugin {
  manifest: PluginManifest;
  hooks: PluginHookRegistration[];
  /** Called when plugin is loaded */
  init?(ctx: PluginContext): Promise<void>;
  /** Called when plugin is unloaded */
  shutdown?(): Promise<void>;
  /** Perform a health check */
  healthCheck?(): Promise<{ healthy: boolean; message?: string }>;
}

export interface PluginContext {
  eventBus: EventBus;
  /** Resolve a registered service */
  resolveService<T>(name: string): T | undefined;
  /** Emit a custom event */
  emitEvent(type: string, data: unknown): void;
  /** Plugin data directory */
  dataDir: string;
}

// ─── Plugin Manager ───────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<HookPriority, number> = {
  first: 0,
  normal: 1,
  last: 2,
};

interface LoadedPlugin {
  plugin: Plugin;
  status: "active" | "disabled" | "error";
  error?: string;
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private hookRegistry = new Map<PluginHook["type"], Array<{ plugin: string; handler: PluginHookRegistration["handler"]; priority: HookPriority }>>();
  private eventBus: EventBus | null = null;
  private registry: ServiceRegistry | null = null;
  private pluginDataDir: string;

  constructor(dataDir?: string) {
    this.pluginDataDir = dataDir ?? "data/plugins";
  }

  setEventBus(eb: EventBus): void {
    this.eventBus = eb;
  }

  setRegistry(registry: ServiceRegistry): void {
    this.registry = registry;
  }

  /** Register a plugin */
  async registerPlugin(plugin: Plugin): Promise<void> {
    const name = plugin.manifest.name;

    if (this.plugins.has(name)) {
      throw new Error(`Plugin "${name}" is already registered`);
    }

    const loaded: LoadedPlugin = { plugin, status: "active" };
    this.plugins.set(name, loaded);

    // Register hooks
    for (const hookReg of plugin.hooks) {
      if (!this.hookRegistry.has(hookReg.hookType)) {
        this.hookRegistry.set(hookReg.hookType, []);
      }
      const handlers = this.hookRegistry.get(hookReg.hookType)!;
      handlers.push({ plugin: name, handler: hookReg.handler, priority: hookReg.priority });
      // Sort by priority
      handlers.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
    }

    // Initialize plugin
    if (plugin.init) {
      try {
        const ctx: PluginContext = {
          eventBus: this.eventBus!,
          resolveService: <T>(name: string) => {
            if (!this.registry) return undefined as T | undefined;
            return this.registry.resolveService<T>(name);
          },
          emitEvent: (type: string, data: unknown) => {
            this.eventBus?.publish(type, data, "plugin");
          },
          dataDir: this.pluginDataDir,
        };
        await plugin.init(ctx);
      } catch (err) {
        loaded.status = "error";
        loaded.error = String(err);
        console.error(`[PluginManager] Plugin "${name}" init failed:`, err);
      }
    }

    console.log(`[PluginManager] Plugin "${name}" v${plugin.manifest.version} registered`);
  }

  /** Unregister a plugin */
  async unregisterPlugin(name: string): Promise<void> {
    const loaded = this.plugins.get(name);
    if (!loaded) return;

    if (loaded.plugin.shutdown) {
      try {
        await loaded.plugin.shutdown();
      } catch (err) {
        console.error(`[PluginManager] Plugin "${name}" shutdown error:`, err);
      }
    }

    // Remove hooks
    for (const [hookType, handlers] of this.hookRegistry) {
      this.hookRegistry.set(
        hookType,
        handlers.filter((h) => h.plugin !== name),
      );
    }

    this.plugins.delete(name);
    console.log(`[PluginManager] Plugin "${name}" unregistered`);
  }

  /** Enable/disable a plugin without unregistering */
  setPluginStatus(name: string, status: "active" | "disabled"): void {
    const loaded = this.plugins.get(name);
    if (loaded) {
      loaded.status = status;
    }
  }

  /** Get all registered plugins */
  getPlugins(): Array<{ manifest: PluginManifest; status: string; error?: string }> {
    return Array.from(this.plugins.values()).map((p) => ({
      manifest: p.plugin.manifest,
      status: p.status,
      error: p.error,
    }));
  }

  /** Run all hooks of a given type in priority order */
  async runHooks<T extends PluginHook, R extends PluginHookResult>(
    hook: T,
  ): Promise<{ blocked: boolean; blockReason?: string; cancelled: boolean; results: R[] }> {
    const handlers = this.hookRegistry.get(hook.type) ?? [];
    const results: R[] = [];
    let blocked = false;
    let blockReason: string | undefined;
    let cancelled = false;

    for (const { plugin, handler } of handlers) {
      try {
        const result = await Promise.resolve(handler(hook)) as R | undefined;
        if (result) {
          results.push(result);

          // Block rules (from OpenClaw docs):
          // - block: true is terminal and stops lower-priority handlers
          if ((result as HookBaseResult).block === true) {
            blocked = true;
            blockReason = (result as HookBaseResult).error ?? `Blocked by plugin "${plugin}"`;
            break; // Stop processing lower priority handlers
          }
          // - block: false is a no-op

          // Cancel rules:
          // - cancel: true is terminal
          if ((result as HookBaseResult).cancel === true) {
            cancelled = true;
            break;
          }
          // - cancel: false is a no-op
        }
      } catch (err) {
        console.error(`[PluginManager] Hook "${hook.type}" handler in plugin "${plugin}" failed:`, err);
      }
    }

    return { blocked, blockReason, cancelled, results };
  }

  /** Run all hooks of a given type and collect merged results */
  async runHooksMerged<T extends PluginHook, R extends PluginHookResult>(
    hook: T,
  ): Promise<{ blocked: boolean; blockReason?: string; cancelled: boolean; merged: Partial<R>; results: R[] }> {
    const { blocked, blockReason, cancelled, results } = await this.runHooks<T, R>(hook);

    // Merge non-blocking results (later handlers override earlier ones for same keys)
    const merged: Record<string, unknown> = {};
    for (const r of results) {
      for (const [key, value] of Object.entries(r as Record<string, unknown>)) {
        if (value !== undefined && key !== "block" && key !== "cancel" && key !== "error") {
          merged[key] = value;
        }
      }
    }

    return { blocked, blockReason, cancelled, merged: merged as Partial<R>, results };
  }

  /** Run hooks with a mixed handler — collect results from non-blocking hooks */
  async runHooksRaw(hookType: PluginHook["type"], hook: PluginHook): Promise<PluginHookResult[]> {
    const handlers = this.hookRegistry.get(hookType) ?? [];
    const results: PluginHookResult[] = [];

    for (const { plugin, handler } of handlers) {
      try {
        const result = await Promise.resolve(handler(hook));
        if (result) {
          results.push(result);
          if ((result as HookBaseResult).block || (result as HookBaseResult).cancel) {
            break;
          }
        }
      } catch (err) {
        console.error(`[PluginManager] Hook "${hookType}" handler in plugin "${plugin}" failed:`, err);
      }
    }

    return results;
  }

  /** Check if any hooks are registered for a given type */
  hasHooks(hookType: PluginHook["type"]): boolean {
    return (this.hookRegistry.get(hookType)?.length ?? 0) > 0;
  }
}