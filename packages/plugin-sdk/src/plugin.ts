/**
 * Plugin Interface — the main contract every plugin must implement.
 */

import type { PluginManifest, PluginState, PluginHookContext, PluginHookName, ServiceLocator, PluginLogger } from "./types.js";

export interface Plugin {
  /** Plugin metadata */
  readonly manifest: PluginManifest;
  /** Current plugin state */
  readonly state: PluginState;

  /**
   * Initialize the plugin. Called once when the plugin is first loaded.
   * @param services - Service locator for accessing core services
   * @param logger - Logger instance for this plugin
   */
  init(services: ServiceLocator, logger: PluginLogger): Promise<void>;

  /**
   * Handle a lifecycle hook event.
   * @param hook - Hook context
   */
  onHook?(hook: PluginHookContext): Promise<void>;

  /**
   * Register hooks this plugin wants to listen to.
   * Called after init() to subscribe to events.
   */
  getHooks?(): PluginHookName[];

  /**
   * Shutdown the plugin cleanly. Called on gateway shutdown.
   */
  shutdown(): Promise<void>;

  /**
   * Perform a health check.
   * @returns Health status or error message
   */
  healthCheck?(): Promise<{ healthy: boolean; message?: string }>;
}

/**
 * Plugin factory function type. Allows plugins to be created
 * with constructor-style dependency injection.
 */
export type PluginFactory = (services: ServiceLocator, logger: PluginLogger) => Plugin;

/**
 * Validate a plugin manifest for required fields.
 */
export function validateManifest(m: unknown): m is PluginManifest {
  if (typeof m !== "object" || m === null) return false;
  const obj = m as Record<string, unknown>;
  return typeof obj.id === "string" &&
    typeof obj.name === "string" &&
    typeof obj.version === "string";
}

/**
 * Create a minimal plugin manifest for registration.
 */
export function createManifest(
  id: string,
  name: string,
  version: string,
  options?: Partial<Omit<PluginManifest, "id" | "name" | "version">>
): PluginManifest {
  return {
    id,
    name,
    version,
    description: options?.description ?? "",
    ...options,
  };
}