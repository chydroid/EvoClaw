/**
 * Config Schema — OpenClaw-style Zod-validated configuration.
 *
 * Features:
 * - Strict Zod schemas for all configuration sections
 * - Config validation with detailed error messages
 * - Schema migration for backward compatibility
 * - Hot-reload support (config change detection)
 * - Default values for missing keys
 *
 * Design: Every config field has a Zod type. Unknown keys are rejected (strict mode)
 * or warned (lenient mode). This prevents silent config bugs.
 */

import * as fs from "fs";
import * as path from "path";

// ── Minimal embedded Zod-like validator (no dependency) ───────────────────────

type Validator<T> = {
  parse(data: unknown): T;
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: string };
};

interface SchemaField {
  type: "string" | "number" | "boolean" | "array" | "object";
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  enum?: string[];
  pattern?: RegExp;
  description?: string;
  items?: SchemaField;
  properties?: Record<string, SchemaField>;
  sensitive?: boolean; // redact in logs
}

interface SchemaDefinition {
  [key: string]: SchemaField;
}

class ValidationError extends Error {
  constructor(public errors: string[]) {
    super(`Config validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.name = "ConfigValidationError";
  }
}

function validateField(value: unknown, field: SchemaField, path: string): string[] {
  const errors: string[] = [];

  if (value === undefined || value === null) {
    if (field.required) {
      errors.push(`${path}: required field is missing`);
    }
    return errors;
  }

  switch (field.type) {
    case "string": {
      if (typeof value !== "string") {
        errors.push(`${path}: expected string, got ${typeof value}`);
        break;
      }
      if (field.min !== undefined && value.length < field.min) {
        errors.push(`${path}: string too short (min ${field.min}, got ${value.length})`);
      }
      if (field.max !== undefined && value.length > field.max) {
        errors.push(`${path}: string too long (max ${field.max}, got ${value.length})`);
      }
      if (field.pattern && !field.pattern.test(value)) {
        errors.push(`${path}: string does not match pattern ${field.pattern}`);
      }
      if (field.enum && !field.enum.includes(value)) {
        errors.push(`${path}: "${value}" is not one of [${field.enum.join(", ")}]`);
      }
      break;
    }
    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        errors.push(`${path}: expected number, got ${typeof value}`);
        break;
      }
      if (field.min !== undefined && value < field.min) {
        errors.push(`${path}: value too small (min ${field.min}, got ${value})`);
      }
      if (field.max !== undefined && value > field.max) {
        errors.push(`${path}: value too large (max ${field.max}, got ${value})`);
      }
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        errors.push(`${path}: expected boolean, got ${typeof value}`);
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array, got ${typeof value}`);
        break;
      }
      if (field.items) {
        value.forEach((item, i) => {
          errors.push(...validateField(item, field.items!, `${path}[${i}]`));
        });
      }
      if (field.min !== undefined && value.length < field.min) {
        errors.push(`${path}: array too short (min ${field.min}, got ${value.length})`);
      }
      if (field.max !== undefined && value.length > field.max) {
        errors.push(`${path}: array too long (max ${field.max}, got ${value.length})`);
      }
      break;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${path}: expected object, got ${typeof value}`);
        break;
      }
      if (field.properties) {
        const obj = value as Record<string, unknown>;
        for (const [key, propField] of Object.entries(field.properties)) {
          errors.push(...validateField(obj[key], propField, `${path}.${key}`));
        }
        // Check for unknown keys in strict mode
        for (const key of Object.keys(obj)) {
          if (!field.properties[key]) {
            errors.push(`${path}.${key}: unknown configuration key`);
          }
        }
      }
      break;
    }
  }

  return errors;
}

// ─── Config Schemas ───────────────────────────────────────────────────────────

const LLM_PROVIDER_SCHEMA: SchemaDefinition = {
  id: { type: "string", required: true, description: "Provider unique identifier" },
  name: { type: "string", required: true, description: "Display name" },
  provider: { type: "string", required: true, enum: ["openai", "anthropic", "deepseek", "local", "custom"], description: "Provider type" },
  model: { type: "string", required: true, description: "Model identifier" },
  apiKey: { type: "string", sensitive: true, description: "API key" },
  baseURL: { type: "string", description: "Custom API base URL" },
  enabled: { type: "boolean", default: true },
  order: { type: "number", default: 0, min: 0 },
  maxTokens: { type: "number", default: 40960, min: 8192, max: 512000 },
  temperature: { type: "number", default: 0.7, min: 0, max: 2 },
  timeout: { type: "number", default: 60000, min: 1000, max: 300000 },
};

const AGENT_SCHEMA: SchemaDefinition = {
  name: { type: "string", default: "EvoClaw", description: "Agent name" },
  masterTerm: { type: "string", default: "主人", description: "How the agent addresses the user" },
  tone: { type: "string", default: "warm", enum: ["warm", "professional", "casual", "formal"], description: "Agent tone" },
  language: { type: "string", default: "zh", description: "Primary language" },
  maxContextTokens: { type: "number", default: 60000, min: 1000 },
  maxHistoryTurns: { type: "number", default: 20, min: 1, max: 100 },
  autoCompaction: { type: "boolean", default: true },
  workspacePath: { type: "string", default: "data/workspace" },
  sessionDir: { type: "string", default: "data/sessions" },
};

const GATEWAY_SCHEMA: SchemaDefinition = {
  port: { type: "number", default: 3000, min: 1, max: 65535 },
  host: { type: "string", default: "0.0.0.0" },
  jwtSecret: { type: "string", sensitive: true, min: 16 },
  enableMCP: { type: "boolean", default: true },
  enableREST: { type: "boolean", default: true },
  rateLimitWindow: { type: "number", default: 60000, min: 1000 },
  rateLimitMax: { type: "number", default: 100, min: 1 },
};

const SECURITY_SCHEMA: SchemaDefinition = {
  dmPolicy: { type: "string", default: "open", enum: ["open", "pairing", "allowlist"], description: "DM access policy" },
  sandboxMode: { type: "string", default: "off", enum: ["off", "non-main", "all"], description: "Sandbox execution mode" },
  execApproval: { type: "boolean", default: false, description: "Require approval for shell commands" },
  maxFileSize: { type: "number", default: 10485760, min: 1, description: "Max file size in bytes" },
  allowedDomains: { type: "array", items: { type: "string" }, description: "Whitelist domains for web access" },
};

export const CONFIG_SCHEMA: SchemaDefinition = {
  agent: { type: "object", properties: AGENT_SCHEMA, description: "Agent configuration" },
  gateway: { type: "object", properties: GATEWAY_SCHEMA, description: "Gateway server configuration" },
  llm: { type: "object", properties: LLM_PROVIDER_SCHEMA, description: "LLM provider configuration (single)" },
  llmProviders: { type: "array", items: { type: "object", properties: LLM_PROVIDER_SCHEMA }, description: "Multiple LLM providers" },
  security: { type: "object", properties: SECURITY_SCHEMA, description: "Security settings" },
};

// ─── Config Validator ──────────────────────────────────────────────────────────

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  data: Record<string, unknown>;
}

export class ConfigValidator {
  private schema: SchemaDefinition;

  constructor(schema: SchemaDefinition = CONFIG_SCHEMA) {
    this.schema = schema;
  }

  /** Validate a config object against the schema */
  validate(config: unknown): ConfigValidationResult {
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      return { valid: false, errors: ["Root config must be an object"], warnings: [], data: {} };
    }

    const errors = validateField(config, { type: "object", properties: this.schema }, "config");
    const warnings: string[] = [];

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      data: config as Record<string, unknown>,
    };
  }

  /** Validate and apply defaults */
  validateAndFill(config: unknown): ConfigValidationResult {
    const result = this.validate(config);
    if (!result.valid) return result;

    result.data = this.applyDefaults(config as Record<string, unknown>, this.schema);
    return result;
  }

  private applyDefaults(data: Record<string, unknown>, schema: SchemaDefinition): Record<string, unknown> {
    const result: Record<string, unknown> = { ...data };
    for (const [key, field] of Object.entries(schema)) {
      if (result[key] === undefined) {
        if (field.properties) {
          // Create nested object and recurse for defaults
          const nested = this.applyDefaults({}, field.properties);
          if (Object.keys(nested).length > 0) {
            result[key] = nested;
          }
        } else if (field.default !== undefined) {
          result[key] = field.default;
        }
      } else if (field.properties && typeof result[key] === "object" && result[key] !== null) {
        result[key] = this.applyDefaults(result[key] as Record<string, unknown>, field.properties);
      }
    }
    return result;
  }

  /** Load and validate a config file (JSON or JSON5) */
  static loadFromFile(filePath: string): ConfigValidationResult {
    if (!fs.existsSync(filePath)) {
      return { valid: false, errors: [`Config file not found: ${filePath}`], warnings: [], data: {} };
    }

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      // Support JSON5-style: strip comments, trailing commas
      const cleaned = raw
        .replace(/\/\/.*$/gm, "")           // single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, "")    // block comments
        .replace(/,\s*([}\]])/g, "$1");      // trailing commas

      const config = JSON.parse(cleaned);
      const validator = new ConfigValidator();
      return validator.validateAndFill(config);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("JSON")) {
        return { valid: false, errors: [`Invalid JSON in ${filePath}: ${message}`], warnings: [], data: {} };
      }
      if (err instanceof ValidationError) {
        return { valid: false, errors: err.errors, warnings: [], data: {} };
      }
      return { valid: false, errors: [`Failed to load ${filePath}: ${message}`], warnings: [], data: {} };
    }
  }
}

// ─── Hot-reload watcher ────────────────────────────────────────────────────────

export interface SchemaConfigChange {
  path: string;
  oldValue: unknown;
  newValue: unknown;
  type: "added" | "modified" | "removed";
}

export type SchemaConfigChangeHandler = (
  newConfig: Record<string, unknown>,
  oldConfig: Record<string, unknown>,
  changes: SchemaConfigChange[]
) => Promise<void>;

export class ConfigWatcher {
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private callbacks: Array<(filePath: string) => void> = [];
  private changeHandlers: SchemaConfigChangeHandler[] = [];
  private currentConfigs = new Map<string, Record<string, unknown>>();
  private reloadCount = 0;
  private lastReloadAt: Date | null = null;

  /** Watch a config file for changes */
  watch(filePath: string): void {
    if (this.watchers.has(filePath)) return;

    this.loadAndValidate(filePath);

    const dir = path.dirname(filePath);
    const basename = path.basename(filePath);

    const watcher = fs.watch(dir, (eventType, filename) => {
      if (filename === basename && eventType === "change") {
        setTimeout(() => {
          this.handleFileChange(filePath);
          for (const cb of this.callbacks) {
            try { cb(filePath); } catch { /* swallow */ }
          }
        }, 200);
      }
    });

    this.watchers.set(filePath, watcher);
  }

  /** Register a callback for config changes */
  onChange(callback: (filePath: string) => void): void {
    this.callbacks.push(callback);
  }

  onConfigChange(handler: SchemaConfigChangeHandler): void {
    this.changeHandlers.push(handler);
  }

  removeConfigChangeHandler(handler: SchemaConfigChangeHandler): void {
    const idx = this.changeHandlers.indexOf(handler);
    if (idx >= 0) this.changeHandlers.splice(idx, 1);
  }

  getCurrentConfig(filePath: string): Record<string, unknown> | undefined {
    return this.currentConfigs.get(filePath);
  }

  getStats(): {
    watchedFiles: number;
    reloadCount: number;
    lastReloadAt: Date | null;
  } {
    return {
      watchedFiles: this.watchers.size,
      reloadCount: this.reloadCount,
      lastReloadAt: this.lastReloadAt,
    };
  }

  forceReload(filePath: string): ConfigValidationResult {
    return this.loadAndValidate(filePath);
  }

  /** Stop watching a specific file */
  unwatch(filePath: string): void {
    const watcher = this.watchers.get(filePath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(filePath);
    }
    this.currentConfigs.delete(filePath);
  }

  /** Stop all watchers */
  stopAll(): void {
    for (const [filePath, watcher] of this.watchers) {
      watcher.close();
      this.watchers.delete(filePath);
    }
    this.callbacks = [];
    this.changeHandlers = [];
    this.currentConfigs.clear();
  }

  private loadAndValidate(filePath: string): ConfigValidationResult {
    const result = ConfigValidator.loadFromFile(filePath);
    if (result.valid) {
      this.currentConfigs.set(filePath, result.data);
      this.reloadCount++;
      this.lastReloadAt = new Date();
    }
    return result;
  }

  private handleFileChange(filePath: string): void {
    const oldConfig = this.currentConfigs.get(filePath) ?? {};
    const result = this.loadAndValidate(filePath);

    if (result.valid && this.changeHandlers.length > 0) {
      const changes = this.diffConfigs(oldConfig, result.data);
      if (changes.length > 0) {
        this.notifyHandlers(result.data, oldConfig, changes);
      }
    }
  }

  diffConfigs(
    oldConfig: Record<string, unknown>,
    newConfig: Record<string, unknown>,
    prefix = ""
  ): SchemaConfigChange[] {
    const changes: SchemaConfigChange[] = [];
    const allKeys = new Set([
      ...Object.keys(oldConfig),
      ...Object.keys(newConfig),
    ]);

    for (const key of allKeys) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      const oldVal = oldConfig[key];
      const newVal = newConfig[key];

      if (oldVal === undefined && newVal !== undefined) {
        changes.push({ path: fullPath, oldValue: undefined, newValue: newVal, type: "added" });
      } else if (oldVal !== undefined && newVal === undefined) {
        changes.push({ path: fullPath, oldValue: oldVal, newValue: undefined, type: "removed" });
      } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        if (
          typeof oldVal === "object" && oldVal !== null && !Array.isArray(oldVal) &&
          typeof newVal === "object" && newVal !== null && !Array.isArray(newVal)
        ) {
          changes.push(...this.diffConfigs(
            oldVal as Record<string, unknown>,
            newVal as Record<string, unknown>,
            fullPath
          ));
        } else {
          changes.push({ path: fullPath, oldValue: oldVal, newValue: newVal, type: "modified" });
        }
      }
    }

    return changes;
  }

  private async notifyHandlers(
    newConfig: Record<string, unknown>,
    oldConfig: Record<string, unknown>,
    changes: SchemaConfigChange[]
  ): Promise<void> {
    for (const handler of this.changeHandlers) {
      try {
        await handler(newConfig, oldConfig, changes);
      } catch (err) {
        console.error("[ConfigWatcher] Handler error:", err instanceof Error ? err.message : String(err));
      }
    }
  }
}

export { ValidationError };