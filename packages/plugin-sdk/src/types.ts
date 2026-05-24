/**
 * Core type definitions for the EvoClaw Plugin SDK.
 */

// ── Plugin Metadata ──────────────────────────────────────
export interface PluginManifest {
  /** Unique plugin identifier (npm-style) */
  id: string;
  /** Display name */
  name: string;
  /** Semantic version */
  version: string;
  /** Human-readable description */
  description: string;
  /** Author or organization */
  author?: string;
  /** License identifier */
  license?: string;
  /** Minimum EvoClaw version required */
  evoclawVersion?: string;
  /** Plugin categories */
  categories?: ("channel" | "provider" | "tool" | "skill" | "automation" | "security" | "utility")[];
  /** Dependencies on other plugins */
  dependencies?: Record<string, string>;
  /** Entry point (relative to plugin root) */
  main?: string;
  /** Icon URL or data URI */
  icon?: string;
  /** Homepage URL */
  homepage?: string;
}

// ── Plugin Lifecycle ─────────────────────────────────────
export enum PluginStatus {
  /** Plugin is registered but not loaded */
  Registered = "registered",
  /** Plugin is being loaded */
  Loading = "loading",
  /** Plugin is active and functional */
  Active = "active",
  /** Plugin encountered an error */
  Error = "error",
  /** Plugin is disabled */
  Disabled = "disabled",
}

export interface PluginState {
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
  loadedAt?: Date;
}

// ── Extension Points ─────────────────────────────────────
export type PluginHookName =
  | "onInit"
  | "onShutdown"
  | "onConfigChanged"
  | "onChannelConnected"
  | "onChannelDisconnected"
  | "onMessageReceived"
  | "onMessageSent"
  | "onModelCalled"
  | "onToolExecuted"
  | "onSkillInstalled"
  | "onSkillExecuted"
  | "onAuditEvent";

export interface PluginHookContext {
  pluginId: string;
  hookName: PluginHookName;
  timestamp: Date;
  data?: unknown;
}

// ── Service Locator ──────────────────────────────────────
export interface ServiceLocator {
  /** Get a registered service by name */
  get<T>(name: string): T | undefined;
  /** Register a service */
  register<T>(name: string, service: T): void;
  /** Check if a service exists */
  has(name: string): boolean;
  /** List all registered service names */
  list(): string[];
}

// ── Logger ───────────────────────────────────────────────
export type LogLevel = "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export interface PluginLogger {
  fatal(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  trace(msg: string, ...args: unknown[]): void;
}