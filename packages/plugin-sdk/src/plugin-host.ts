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

  constructor(config?: PluginHostConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
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
        console.error(`[PluginHost] Auto-activation failed for "${manifest.id}":`, err);
      });
    }
  }

  async activate(pluginId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);
    if (!entry) throw new Error(`Plugin "${pluginId}" not found`);

    if (entry.state.status === PluginStatus.Active) return;

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

      try {
        await Promise.race([
          entry.plugin.onHook(context),
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Hook timeout for "${pluginId}" on "${hookName}"`)),
              this.config.hookTimeoutMs
            )
          ),
        ]);
      } catch (err) {
        console.error(
          `[PluginHost] Hook error for "${pluginId}" on "${hookName}":`,
          err instanceof Error ? err.message : String(err)
        );
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
          console.error(`[PluginHost] Shutdown error for "${id}":`, err);
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
      fatal(msg: string, ...args: unknown[]) { console.error(prefix, msg, ...args); },
      error(msg: string, ...args: unknown[]) { console.error(prefix, msg, ...args); },
      warn(msg: string, ...args: unknown[]) { console.warn(prefix, msg, ...args); },
      info(msg: string, ...args: unknown[]) { console.log(prefix, msg, ...args); },
      debug(msg: string, ...args: unknown[]) { console.debug(prefix, msg, ...args); },
      trace(msg: string, ...args: unknown[]) {},
    };
  }
}
