import type {
  PluginManifest,
  PluginState,
  PluginHookName,
  PluginHookContext,
  PluginLogger,
} from "./types.js";
import { PluginStatus } from "./types.js";
import type { Plugin } from "./plugin.js";
import { validateManifest } from "./plugin.js";
import type {
  Plugin as CorePlugin,
  PluginManifest as CorePluginManifest,
  PluginHookRegistration,
  PluginHook,
  PluginHookResult,
  HookPriority,
} from "@evoclaw/core";

// ─── SDK → Core Hook Mapping ─────────────────────────────────────────────────

const SDK_TO_CORE_HOOK_MAP: Partial<Record<PluginHookName, PluginHook["type"]>> = {
  onMessageReceived: "message_received",
  onMessageSent: "message_sent",
  onModelCalled: "before_agent_reply",
  onToolExecuted: "after_tool_call",
  onChannelConnected: "gateway_start",
  onChannelDisconnected: "gateway_stop",
  onSkillInstalled: "before_install",
};

// ─── Conversion Helper ────────────────────────────────────────────────────────

/**
 * Convert an SDK Plugin to a core Plugin format.
 * Maps SDK hook names to core hook types and adapts the interface.
 */
export function convertToCorePlugin(sdkPlugin: Plugin): CorePlugin {
  const manifest = sdkPlugin.manifest;

  const coreManifest: CorePluginManifest = {
    name: manifest.id,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    homepage: manifest.homepage,
    minVersion: manifest.evoclawVersion,
  };

  const hooks: PluginHookRegistration[] = [];

  if (sdkPlugin.getHooks && sdkPlugin.onHook) {
    const sdkHooks = sdkPlugin.getHooks();
    for (const hookName of sdkHooks) {
      const coreHookType = SDK_TO_CORE_HOOK_MAP[hookName];
      if (coreHookType) {
        const onHook = sdkPlugin.onHook.bind(sdkPlugin);
        hooks.push({
          hookType: coreHookType,
          priority: "normal" as HookPriority,
          handler: async (hook: PluginHook): Promise<PluginHookResult | void> => {
            const context: PluginHookContext = {
              pluginId: manifest.id,
              hookName,
              timestamp: new Date(),
              data: hook,
            };
            await onHook(context);
          },
        });
      }
    }
  }

  const corePlugin: CorePlugin = {
    manifest: coreManifest,
    hooks,
    async init(ctx): Promise<void> {
      const serviceLocator = {
        get: <T>(id: string) => ctx.resolveService<T>(id),
        register: () => {},
        has: (id: string) => ctx.resolveService(id) !== undefined,
        list: () => [],
      };
      const logger: PluginLogger = {
        fatal(msg: string, ...args: unknown[]) { process.stderr.write(`[Plugin:${manifest.id}] ${msg} ${args.map(String).join(" ")}\n`); },
        error(msg: string, ...args: unknown[]) { process.stderr.write(`[Plugin:${manifest.id}] ${msg} ${args.map(String).join(" ")}\n`); },
        warn(msg: string, ...args: unknown[]) { process.stderr.write(`[Plugin:${manifest.id}] ${msg} ${args.map(String).join(" ")}\n`); },
        info(msg: string, ...args: unknown[]) { process.stdout.write(`[Plugin:${manifest.id}] ${msg} ${args.map(String).join(" ")}\n`); },
        debug(msg: string, ...args: unknown[]) { process.stdout.write(`[Plugin:${manifest.id}] ${msg} ${args.map(String).join(" ")}\n`); },
        trace() {},
      };
      await sdkPlugin.init(serviceLocator, logger);
    },
    async shutdown(): Promise<void> {
      await sdkPlugin.shutdown();
    },
    async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
      if (sdkPlugin.healthCheck) {
        return sdkPlugin.healthCheck();
      }
      return { healthy: true };
    },
  };

  return corePlugin;
}

export interface PluginHostConfig {
  maxPlugins?: number;
  autoActivate?: boolean;
  hookTimeoutMs?: number;
}

interface PluginEntry {
  plugin: Plugin;
  state: PluginState;
  hooks: Set<PluginHookName>;
}

const DEFAULT_CONFIG: Required<PluginHostConfig> = {
  maxPlugins: 50,
  autoActivate: true,
  hookTimeoutMs: 30000,
};

export class PluginHost {
  private plugins = new Map<string, PluginEntry>();
  private services = new Map<string, unknown>();
  private config: Required<PluginHostConfig>;
  private hookHandlers = new Map<PluginHookName, Set<string>>();
  private pluginManager: import("@evoclaw/core").PluginManager | null;

  constructor(config?: PluginHostConfig, pluginManager?: import("@evoclaw/core").PluginManager) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.pluginManager = pluginManager ?? null;
  }

  registerPlugin(plugin: Plugin): void {
    const manifest = plugin.manifest;

    if (!validateManifest(manifest)) {
      throw new Error(`Invalid plugin manifest: id, name, and version are required`);
    }

    if (this.plugins.has(manifest.id)) {
      throw new Error(`Plugin "${manifest.id}" is already registered`);
    }

    if (this.plugins.size >= this.config.maxPlugins) {
      throw new Error(`Maximum number of plugins (${this.config.maxPlugins}) reached`);
    }

    // Delegate to PluginManager when available
    if (this.pluginManager) {
      const corePlugin = convertToCorePlugin(plugin);
      this.pluginManager.registerPlugin(corePlugin).catch((err) => {
        process.stderr.write(`[PluginHost] Delegated registerPlugin failed for "${manifest.id}": ${err instanceof Error ? err.message : String(err)}\n`);
      });

      // Still track locally for state queries
      const state: PluginState = {
        manifest,
        status: PluginStatus.Active,
      };
      const hooks = new Set<PluginHookName>();
      if (plugin.getHooks) {
        for (const hook of plugin.getHooks()) {
          hooks.add(hook);
        }
      }
      this.plugins.set(manifest.id, { plugin, state, hooks });
      return;
    }

    const state: PluginState = {
      manifest,
      status: PluginStatus.Registered,
    };

    const hooks = new Set<PluginHookName>();
    if (plugin.getHooks) {
      for (const hook of plugin.getHooks()) {
        hooks.add(hook);
      }
    }

    this.plugins.set(manifest.id, { plugin, state, hooks });

    for (const hook of hooks) {
      if (!this.hookHandlers.has(hook)) {
        this.hookHandlers.set(hook, new Set());
      }
      this.hookHandlers.get(hook)!.add(manifest.id);
    }

    if (this.config.autoActivate) {
      this.activate(manifest.id).catch((err) => {
        process.stderr.write(`[PluginHost] Auto-activation failed for "${manifest.id}": ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
  }

  async activate(pluginId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);
    if (!entry) throw new Error(`Plugin "${pluginId}" not found`);

    if (entry.state.status === PluginStatus.Active) return;

    // When delegating, activation is handled by PluginManager during registerPlugin
    if (this.pluginManager) {
      entry.state.status = PluginStatus.Active;
      entry.state.loadedAt = new Date();
      return;
    }

    if (entry.state.status === PluginStatus.Loading) {
      throw new Error(`Plugin "${pluginId}" is already loading`);
    }

    entry.state.status = PluginStatus.Loading;

    try {
      const logger = this.createLogger(pluginId);
      await entry.plugin.init(this, logger);

      entry.state.status = PluginStatus.Active;
      entry.state.loadedAt = new Date();
      entry.state.error = undefined;

      await this.emitHook("onInit", { pluginId });
    } catch (err) {
      entry.state.status = PluginStatus.Error;
      entry.state.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async deactivate(pluginId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);
    if (!entry) throw new Error(`Plugin "${pluginId}" not found`);

    if (entry.state.status !== PluginStatus.Active) return;

    // Delegate to PluginManager
    if (this.pluginManager) {
      try {
        await this.pluginManager.unregisterPlugin(pluginId);
        entry.state.status = PluginStatus.Disabled;
      } catch (err) {
        entry.state.status = PluginStatus.Error;
        entry.state.error = err instanceof Error ? err.message : String(err);
      }
      return;
    }

    try {
      await entry.plugin.shutdown();
      entry.state.status = PluginStatus.Disabled;
    } catch (err) {
      entry.state.status = PluginStatus.Error;
      entry.state.error = err instanceof Error ? err.message : String(err);
    }
  }

  async unregister(pluginId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;

    if (entry.state.status === PluginStatus.Active) {
      await this.deactivate(pluginId);
    }

    for (const hook of entry.hooks) {
      this.hookHandlers.get(hook)?.delete(pluginId);
    }

    this.plugins.delete(pluginId);
  }

  async emitHook(hookName: PluginHookName, data?: unknown): Promise<void> {
    // Delegate to PluginManager when available
    if (this.pluginManager) {
      const coreHookType = SDK_TO_CORE_HOOK_MAP[hookName];
      if (coreHookType) {
        const hook: PluginHook = {
          type: coreHookType,
          context: {},
          ...(data instanceof Object ? data : {}),
        } as PluginHook;
        await this.pluginManager.runHooks(hook);
      }
      return;
    }

    const handlerIds = this.hookHandlers.get(hookName);
    if (!handlerIds) return;

    for (const pluginId of handlerIds) {
      const entry = this.plugins.get(pluginId);
      if (!entry || entry.state.status !== PluginStatus.Active) continue;

      if (!entry.plugin.onHook) continue;

      const context: PluginHookContext = {
        pluginId,
        hookName,
        timestamp: new Date(),
        data,
      };

      let hookTimer: ReturnType<typeof setTimeout> | undefined;
      const hookPromise = entry.plugin.onHook(context);
      hookPromise.catch(() => {}); // 防止超时后 unhandledRejection
      try {
        await Promise.race([
          hookPromise,
          new Promise<void>((_, reject) => {
            hookTimer = setTimeout(
              () => reject(new Error(`Hook timeout for "${pluginId}" on "${hookName}"`)),
              this.config.hookTimeoutMs
            );
            if (hookTimer.unref) hookTimer.unref();
          }),
        ]);
      } catch (err) {
        process.stderr.write(
          `[PluginHost] Hook error for "${pluginId}" on "${hookName}":` + " " + (err instanceof Error ? err.message : String(err)) + "\n"
        );
      } finally {
        if (hookTimer) clearTimeout(hookTimer);
      }
    }
  }

  getPlugin(pluginId: string): Plugin | undefined {
    return this.plugins.get(pluginId)?.plugin;
  }

  getPluginState(pluginId: string): PluginState | undefined {
    return this.plugins.get(pluginId)?.state;
  }

  listPlugins(): Array<{ id: string; name: string; version: string; status: PluginStatus; description: string }> {
    return Array.from(this.plugins.values()).map((entry) => ({
      id: entry.state.manifest.id,
      name: entry.state.manifest.name,
      version: entry.state.manifest.version,
      status: entry.state.status,
      description: entry.state.manifest.description,
    }));
  }

  getActivePlugins(): string[] {
    return Array.from(this.plugins.values())
      .filter((e) => e.state.status === PluginStatus.Active)
      .map((e) => e.state.manifest.id);
  }

  async healthCheck(): Promise<Array<{ pluginId: string; healthy: boolean; message?: string }>> {
    // Delegate to PluginManager when available
    if (this.pluginManager) {
      const pluginInfos = this.pluginManager.getPlugins();
      const results: Array<{ pluginId: string; healthy: boolean; message?: string }> = [];
      for (const info of pluginInfos) {
        if (info.status === "error") {
          results.push({ pluginId: info.manifest.name, healthy: false, message: info.error });
        } else if (info.status === "active") {
          results.push({ pluginId: info.manifest.name, healthy: true });
        } else {
          results.push({ pluginId: info.manifest.name, healthy: false, message: `Plugin is ${info.status}` });
        }
      }
      return results;
    }

    const results: Array<{ pluginId: string; healthy: boolean; message?: string }> = [];

    for (const [id, entry] of this.plugins) {
      if (entry.state.status !== PluginStatus.Active) {
        results.push({ pluginId: id, healthy: false, message: `Plugin is ${entry.state.status}` });
        continue;
      }

      if (entry.plugin.healthCheck) {
        try {
          const result = await entry.plugin.healthCheck();
          results.push({ pluginId: id, ...result });
        } catch (err) {
          results.push({
            pluginId: id,
            healthy: false,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        results.push({ pluginId: id, healthy: true });
      }
    }

    return results;
  }

  getStats(): {
    total: number;
    active: number;
    errors: number;
    disabled: number;
  } {
    let active = 0;
    let errors = 0;
    let disabled = 0;

    for (const entry of this.plugins.values()) {
      switch (entry.state.status) {
        case PluginStatus.Active: active++; break;
        case PluginStatus.Error: errors++; break;
        case PluginStatus.Disabled: disabled++; break;
      }
    }

    return { total: this.plugins.size, active, errors, disabled };
  }

  async shutdown(): Promise<void> {
    await this.emitHook("onShutdown");

    for (const [id, entry] of this.plugins) {
      if (entry.state.status === PluginStatus.Active) {
        try {
          await entry.plugin.shutdown();
        } catch (err) {
          process.stderr.write(`[PluginHost] Shutdown error for "${id}":` + " " + (err instanceof Error ? err.message : String(err)) + "\n");
        }
      }
    }

    this.plugins.clear();
    this.hookHandlers.clear();
  }

  get<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  register<T>(name: string, service: T): void {
    this.services.set(name, service);
  }

  has(name: string): boolean {
    return this.services.has(name);
  }

  list(): string[] {
    return Array.from(this.services.keys());
  }

  private createLogger(pluginId: string): PluginLogger {
    const prefix = `[Plugin:${pluginId}]`;
    return {
      fatal(msg: string, ...args: unknown[]) { process.stderr.write(`${prefix} ${msg} ${args.map(String).join(" ")}\n`); },
      error(msg: string, ...args: unknown[]) { process.stderr.write(`${prefix} ${msg} ${args.map(String).join(" ")}\n`); },
      warn(msg: string, ...args: unknown[]) { process.stderr.write(`${prefix} ${msg} ${args.map(String).join(" ")}\n`); },
      info(msg: string, ...args: unknown[]) { process.stdout.write(`${prefix} ${msg} ${args.map(String).join(" ")}\n`); },
      debug(msg: string, ...args: unknown[]) { process.stdout.write(`${prefix} ${msg} ${args.map(String).join(" ")}\n`); },
      trace(msg: string, ...args: unknown[]) {},
    };
  }
}
