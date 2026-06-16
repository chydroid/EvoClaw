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
  options?: Partial<Pick<ToolDescriptor, 'availability' | 'sortKey' | 'optional' | 'replaySafe' | 'metadata'>>
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
