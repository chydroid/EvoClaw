/**
 * Config RPC — runtime configuration API with JSON path
 * access, validation, and event emission.
 *
 * Enables dynamic configuration changes at runtime without
 * restart. Mirrors OpenClaw's `config.set/config.get/config.unset`
 * CLI commands as an in-process API.
 *
 * Features:
 *  - Deep get/set/unset via dot-path (e.g., "server.port")
 *  - Per-key validation with custom validators
 *  - Change events for subscribers
 *  - Immutable snapshot for reading
 *  - Reset to defaults or LKG
 *  - Change history with undo
 *  - Secret masking for sensitive keys
 */

import { EventEmitter } from "events";

// ── Types ─────────────────────────────────────────────────

export type ConfigValue = string | number | boolean | null | ConfigValue[] | { [key: string]: ConfigValue };

export interface ConfigChange {
  /** The path that was changed */
  path: string;
  /** Previous value */
  oldValue: ConfigValue;
  /** New value */
  newValue: ConfigValue;
  /** When the change was made */
  timestamp: number;
  /** Who/what made the change */
  source?: string;
}

export interface ConfigValidator {
  /** Validate a proposed value. Return null if ok, error string if invalid. */
  (value: ConfigValue): string | null;
}

export interface ConfigSchemaEntry {
  /** Default value */
  default: ConfigValue;
  /** Optional description */
  description?: string;
  /** Optional validator */
  validate?: ConfigValidator;
  /** Whether this key is sensitive (value masked in logs) */
  sensitive?: boolean;
  /** Whether this key can be changed at runtime */
  mutable?: boolean;
}

export interface ConfigRPCConfig {
  /** Whether to record change history for undo */
  keepHistory: boolean;
  /** Maximum history entries */
  maxHistory: number;
  /** Source label for change attribution */
  source: string;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: ConfigRPCConfig = {
  keepHistory: true,
  maxHistory: 100,
  source: "config-rpc",
};

// ── RPC ───────────────────────────────────────────────────

export class ConfigRPC extends EventEmitter {
  private config: ConfigRPCConfig;
  private values = new Map<string, ConfigValue>();
  private schema = new Map<string, ConfigSchemaEntry>();
  private history: ConfigChange[] = [];
  private defaults = new Map<string, ConfigValue>();

  constructor(rpcConfig?: Partial<ConfigRPCConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...rpcConfig };
  }

  /**
   * Register a config key with schema.
   */
  register(key: string, schema: ConfigSchemaEntry): void {
    this.schema.set(key, schema);
    this.defaults.set(key, schema.default);
    this.values.set(key, schema.default);
  }

  /**
   * Batch register multiple keys.
   */
  registerAll(entries: Record<string, ConfigSchemaEntry>): void {
    for (const [key, schema] of Object.entries(entries)) {
      this.register(key, schema);
    }
  }

  /**
   * Set a config value by path. Supports dot-notation for nested paths.
   */
  set(path: string, value: ConfigValue): ConfigValue {
    const schema = this.schema.get(path);

    // Check mutability
    if (schema && schema.mutable === false) {
      throw new Error(`Config key "${path}" is not mutable at runtime`);
    }

    // Validate
    if (schema?.validate) {
      const error = schema.validate(value);
      if (error) {
        throw new Error(`Invalid value for "${path}": ${error}`);
      }
    }

    // Handle nested path
    if (path.includes(".")) {
      return this.setNested(path, value);
    }

    const oldValue = this.values.get(path) ?? null;
    const newValue = value;

    this.values.set(path, newValue);

    // Record history
    this.recordChange(path, oldValue, newValue);

    // Emit event
    this.emit("change", { path, oldValue, newValue, timestamp: Date.now(), source: this.config.source });
    this.emit(`change:${path}`, newValue, oldValue);

    return newValue;
  }

  /**
   * Get a config value by path.
   */
  get<T extends ConfigValue = ConfigValue>(path: string): T | null {
    // Check flat key first (keys may contain dots like "server.port")
    if (this.values.has(path)) {
      return this.values.get(path) as T;
    }
    if (path.includes(".")) {
      return this.getNested(path) as T;
    }
    return (this.values.get(path) ?? null) as T;
  }

  /**
   * Get all config values as a flat record.
   */
  getAll(): Record<string, ConfigValue> {
    const result: Record<string, ConfigValue> = {};
    for (const [key, value] of this.values) {
      const schema = this.schema.get(key);
      if (schema?.sensitive) {
        result[key] = "***";
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Unset (reset to default) a config key.
   */
  unset(path: string): boolean {
    const schema = this.schema.get(path);
    if (!schema) return false;

    return this.set(path, schema.default) !== null;
  }

  /**
   * Reset all config keys to their defaults.
   */
  resetAll(): void {
    for (const [key, schema] of this.schema) {
      this.set(key, schema.default);
    }
  }

  /**
   * Check if a config key is registered.
   */
  has(path: string): boolean {
    // Check flat key first
    if (this.schema.has(path)) return true;
    if (path.includes(".")) {
      const parts = path.split(".");
      const obj = this.values.get(parts[0]);
      if (typeof obj !== "object" || obj === null) return false;
      let current: Record<string, unknown> = obj as Record<string, unknown>;
      for (let i = 1; i < parts.length; i++) {
        if (!(parts[i] in current)) return false;
        const val = current[parts[i]];
        if (i < parts.length - 1 && typeof val === "object" && val !== null) {
          current = val as Record<string, unknown>;
        }
      }
      return true;
    }
    return this.schema.has(path);
  }

  /**
   * Get change history.
   */
  getHistory(limit?: number): ConfigChange[] {
    if (limit) return this.history.slice(-limit);
    return [...this.history];
  }

  /**
   * Undo last N changes.
   */
  undo(count = 1): number {
    let undone = 0;
    for (let i = 0; i < count && this.history.length > 0; i++) {
      const change = this.history.pop()!;
      // 验证 oldValue 仍然符合当前 schema（schema 可能在 set 和 undo 之间被更新）
      const schema = this.schema.get(change.path);
      if (schema?.validate) {
        const error = schema.validate(change.oldValue);
        if (error) {
          // 验证失败：将变更放回历史栈，中止 undo，避免写入非法值
          this.history.push(change);
          process.stderr.write(`[ConfigRpc] undo() rejected for "${change.path}": ${error}\n`);
          break;
        }
      }
      this.values.set(change.path, change.oldValue);
      this.emit("change", { ...change, oldValue: change.newValue, newValue: change.oldValue, timestamp: Date.now(), source: "undo" });
      undone++;
    }
    return undone;
  }

  /**
   * Clear change history.
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Get schema for a key.
   */
  getSchema(key: string): ConfigSchemaEntry | null {
    return this.schema.get(key) ?? null;
  }

  /**
   * List all registered config keys.
   */
  listKeys(): string[] {
    return [...this.schema.keys()].sort();
  }

  /**
   * Diff current values against defaults.
   */
  diff(): Array<{ key: string; current: ConfigValue; default: ConfigValue }> {
    const diffs: Array<{ key: string; current: ConfigValue; default: ConfigValue }> = [];
    for (const [key, schema] of this.schema) {
      const current = this.values.get(key);
      if (JSON.stringify(current) !== JSON.stringify(schema.default)) {
        diffs.push({ key, current: current ?? null, default: schema.default });
      }
    }
    return diffs;
  }

  configure(updates: Partial<ConfigRPCConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ── Private ─────────────────────────────────────────────

  private setNested(path: string, value: ConfigValue): ConfigValue {
    const parts = path.split(".");
    const rootKey = parts[0];

    const current = this.values.get(rootKey);
    const oldValue = current ?? null;

    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      // Create new object
      const newObj: Record<string, unknown> = {};
      this.setNestedValue(newObj, parts.slice(1), value);
      this.values.set(rootKey, newObj as ConfigValue);
      this.recordChange(path, oldValue, newObj as ConfigValue);
      return newObj as ConfigValue;
    }

    // Clone current object
    const cloned = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
    this.setNestedValue(cloned, parts.slice(1), value);

    this.values.set(rootKey, cloned as ConfigValue);
    this.recordChange(path, oldValue, cloned as ConfigValue);

    return cloned as ConfigValue;
  }

  private setNestedValue(
    obj: Record<string, unknown>,
    path: string[],
    value: unknown,
  ): void {
    if (path.length === 0) throw new Error("path cannot be empty");
    let current = obj;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }
    current[path[path.length - 1]] = value;
  }

  private getNested(path: string): ConfigValue | null {
    const parts = path.split(".");
    const root = this.values.get(parts[0]);

    if (root === undefined) return null;
    if (typeof root !== "object" || root === null) return null;

    let current: Record<string, unknown> = root as Record<string, unknown>;
    for (let i = 1; i < parts.length; i++) {
      if (!(parts[i] in current)) return null;
      const val = current[parts[i]];
      if (i === parts.length - 1) return val as ConfigValue;
      if (typeof val !== "object" || val === null) return null;
      current = val as Record<string, unknown>;
    }

    return current as ConfigValue;
  }

  private recordChange(path: string, oldValue: ConfigValue, newValue: ConfigValue): void {
    if (!this.config.keepHistory) return;

    this.history.push({
      path,
      oldValue,
      newValue,
      timestamp: Date.now(),
      source: this.config.source,
    });

    if (this.history.length > this.config.maxHistory) {
      this.history = this.history.slice(-this.config.maxHistory);
    }
  }
}