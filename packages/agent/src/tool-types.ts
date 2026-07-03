// Tool Types - Core type definitions for the tool system

import type { ToolAvailabilityExpression } from './tool-availability.js';

/**
 * JSON primitive types
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * JSON value types
 */
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/**
 * JSON object type
 */
export type JsonObject = { [key: string]: JsonValue };

/**
 * JSON array type
 */
export type JsonArray = JsonValue[];

/**
 * Tool input schema definition (JSON Schema compatible)
 */
export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

/**
 * JSON Schema property definition
 */
export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: readonly JsonPrimitive[];
  items?: JsonSchemaProperty;
  default?: JsonValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/**
 * Tool executor function type
 */
export type ToolExecutor = (input: JsonObject) => Promise<ToolResult>;

/**
 * Tool execution result
 */
export interface ToolResult {
  success: boolean;
  output?: JsonValue;
  error?: string;
  metadata?: Record<string, JsonValue>;
}

/**
 * Tool descriptor - defines a tool's metadata and capabilities
 */
export interface ToolDescriptor {
  /** Unique name of the tool */
  name: string;
  
  /** Human-readable description */
  description: string;
  
  /** Input schema for the tool */
  inputSchema: ToolInputSchema;
  
  /** Availability expression - determines when this tool can be used */
  availability?: ToolAvailabilityExpression;
  
  /** Tool executor function */
  executor?: ToolExecutor;
  
  /** Sort key for deterministic ordering */
  sortKey?: string;
  
  /** Whether this tool is optional (non-critical failures are acceptable) */
  optional?: boolean;
  
  /** Whether this tool is safe to replay (idempotent) */
  replaySafe?: boolean;
  
  /** Additional metadata */
  metadata?: Record<string, JsonValue>;

  /**
   * Optional output schema describing the shape of the value returned by
   * `executor`. When present, the runtime validates the tool's return value
   * against this schema and surfaces mismatches to the LLM as a tool error.
   */
  outputSchema?: ToolInputSchema;
}

/**
 * Tool call request from LLM
 */
export interface ToolCallRequest {
  /** Unique ID for this tool call */
  id: string;
  
  /** Name of the tool to call */
  name: string;
  
  /** Input parameters for the tool */
  input: JsonObject;
}

/**
 * Tool call response
 */
export interface ToolCallResponse {
  /** ID matching the request */
  id: string;
  
  /** Name of the tool that was called */
  name: string;
  
  /** Result of the tool execution */
  result: ToolResult;
  
  /** Execution duration in milliseconds */
  durationMs?: number;
}

/**
 * Tool execution context
 */
export interface ToolExecutionContext {
  /** Session ID for tracking */
  sessionId: string;
  
  /** User ID who initiated the call */
  userId?: string;
  
  /** Agent ID executing the tool */
  agentId: string;
  
  /** Timestamp of the call */
  timestamp: number;
  
  /** Additional context data */
  metadata?: Record<string, JsonValue>;
}

/**
 * Tool registry - manages available tools
 */
export interface ToolRegistry {
  /** Register a tool */
  register(descriptor: ToolDescriptor): void;
  
  /** Unregister a tool by name */
  unregister(name: string): boolean;
  
  /** Get a tool descriptor by name */
  get(name: string): ToolDescriptor | undefined;
  
  /** Check if a tool exists */
  has(name: string): boolean;
  
  /** Get all registered tools */
  getAll(): readonly ToolDescriptor[];
  
  /** Clear all registered tools */
  clear(): void;
}

/**
 * Tool execution options
 */
export interface ToolExecutionOptions {
  /** Timeout in milliseconds */
  timeoutMs?: number;
  
  /** Whether to retry on failure */
  retry?: boolean;
  
  /** Maximum number of retries */
  maxRetries?: number;
  
  /** Delay between retries in milliseconds */
  retryDelayMs?: number;
}

/**
 * Tool validation error
 */
export class ToolValidationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly validationErrors: readonly string[]
  ) {
    super(`Tool validation failed for ${toolName}: ${validationErrors.join(', ')}`);
    this.name = 'ToolValidationError';
  }
}

/**
 * Tool execution error
 */
export class ToolExecutionError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly originalError: unknown,
    public readonly durationMs: number
  ) {
    super(`Tool execution failed for ${toolName}: ${String(originalError)}`);
    this.name = 'ToolExecutionError';
  }
}

/**
 * Validate a tool descriptor
 */
export function validateToolDescriptor(descriptor: ToolDescriptor): void {
  const errors: string[] = [];
  
  // Check required fields
  if (!descriptor.name || typeof descriptor.name !== 'string') {
    errors.push('name is required and must be a string');
  }
  
  if (!descriptor.description || typeof descriptor.description !== 'string') {
    errors.push('description is required and must be a string');
  }
  
  if (!descriptor.inputSchema || typeof descriptor.inputSchema !== 'object') {
    errors.push('inputSchema is required and must be an object');
  }
  
  // Check input schema structure
  if (descriptor.inputSchema) {
    if (descriptor.inputSchema.type !== 'object') {
      errors.push('inputSchema.type must be "object"');
    }
  }
  
  // Check executor if provided
  if (descriptor.executor && typeof descriptor.executor !== 'function') {
    errors.push('executor must be a function if provided');
  }
  
  if (errors.length > 0) {
    throw new ToolValidationError(descriptor.name, errors);
  }
}

/**
 * Create a simple tool descriptor
 */
export function createToolDescriptor(
  name: string,
  description: string,
  inputSchema: ToolInputSchema,
  executor: ToolExecutor,
  options?: Partial<Pick<ToolDescriptor, 'availability' | 'sortKey' | 'optional' | 'replaySafe' | 'metadata' | 'outputSchema'>>
): ToolDescriptor {
  const descriptor: ToolDescriptor = {
    name,
    description,
    inputSchema,
    executor,
    ...options,
  };

  validateToolDescriptor(descriptor);

  return descriptor;
}

// ── Tool result schema validation ─────────────────────────────────────────
//
// Mirrors the input-side `validateToolParams` flow but for output. When a
// tool descriptor declares `outputSchema`, the runtime can validate the
// handler's return value against it and surface structural mismatches to
// the LLM (as a tool error message) so the model can retry or self-correct.
//
// Inspired by:
// - LangChain `Tool.args_schema` (Pydantic) — input validation
// - OpenAI function calling strict-mode — result schema enforcement
// - AutoGen type-hinted tool results
//
// Implementation is intentionally self-contained (no external deps) and
// covers the same JSON Schema subset as `validateToolParams`:
// type / enum / minimum / maximum / minLength / maxLength / pattern /
// items (arrays) / properties+required (objects).

export interface ToolResultValidation {
  valid: boolean;
  errors: readonly string[];
}

/**
 * Validate a tool's return value against its declared `outputSchema`.
 *
 * - `result` may be a primitive, plain object, or array (matching JSON Schema).
 * - When `schema` is undefined, validation is a no-op (treat as valid).
 * - String results are common (many tools return raw text); they validate
 *   only against `{ type: "string" }` schemas.
 */
export function validateToolResult(
  toolName: string,
  result: unknown,
  schema?: ToolInputSchema,
): ToolResultValidation {
  if (!schema) return { valid: true, errors: [] };
  const errors: string[] = [];
  validateJsonValue(result, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}

function validateJsonValue(
  value: unknown,
  schema: ToolInputSchema | JsonSchemaProperty,
  path: string,
  errors: string[],
): void {
  // JsonSchemaProperty carries the validation fields (enum/minimum/maximum/...);
  // ToolInputSchema only carries type/properties/required. Cast to a merged
  // view where `type` is `string` so both "object" and "array" comparisons work.
  const s = schema as {
    type?: string;
    properties?: Record<string, JsonSchemaProperty>;
    required?: readonly string[];
    additionalProperties?: boolean;
    enum?: readonly JsonPrimitive[];
    items?: JsonSchemaProperty;
    default?: JsonValue;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };

  // type
  if (s.type && !checkJsonType(value, s.type)) {
    errors.push(`At ${path}: expected type "${s.type}", got "${typeNameOf(value)}"`);
    return;
  }

  // enum
  if (s.enum && !s.enum.includes(value as JsonPrimitive)) {
    errors.push(`At ${path}: value ${JSON.stringify(value)} not in enum [${s.enum.map((v: JsonPrimitive) => JSON.stringify(v)).join(", ")}]`);
    return;
  }

  // numeric range
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) {
      errors.push(`At ${path}: value ${value} is less than minimum ${s.minimum}`);
    }
    if (s.maximum !== undefined && value > s.maximum) {
      errors.push(`At ${path}: value ${value} is greater than maximum ${s.maximum}`);
    }
  }

  // string length + pattern
  if (typeof value === "string") {
    if (s.minLength !== undefined && value.length < s.minLength) {
      errors.push(`At ${path}: string length ${value.length} is less than minLength ${s.minLength}`);
    }
    if (s.maxLength !== undefined && value.length > s.maxLength) {
      errors.push(`At ${path}: string length ${value.length} is greater than maxLength ${s.maxLength}`);
    }
    if (s.pattern) {
      try {
        if (!new RegExp(s.pattern).test(value)) {
          errors.push(`At ${path}: string does not match pattern /${s.pattern}/`);
        }
      } catch {
        // Invalid pattern — skip rather than crash validation
      }
    }
  }

  // object
  if (s.type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const properties = s.properties;
    const required = s.required;
    if (required) {
      for (const reqField of required) {
        if (!(reqField in obj)) {
          errors.push(`At ${path}: missing required field "${reqField}"`);
        }
      }
    }
    if (properties) {
      for (const [propName, propSchema] of Object.entries(properties)) {
        if (propName in obj) {
          validateJsonValue(obj[propName], propSchema, `${path}.${propName}`, errors);
        }
      }
    }
  }

  // array
  if (s.type === "array" && Array.isArray(value)) {
    const items = s.items;
    if (items) {
      for (let i = 0; i < value.length; i++) {
        validateJsonValue(value[i], items, `${path}[${i}]`, errors);
      }
    }
  }
}

function checkJsonType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    default: return true; // unknown type — be permissive
  }
}

function typeNameOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
