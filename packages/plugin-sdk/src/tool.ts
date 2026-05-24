/**
 * Tool SDK — standardized interface for custom tool plugins.
 */

import type { PluginLogger, ServiceLocator } from "./types.js";

// ── Tool Definition ──────────────────────────────────────
export interface ToolDefinition {
  /** Unique tool name (snake_case) */
  name: string;
  /** Human-readable description for the model */
  description: string;
  /** JSON Schema for the tool's parameters */
  parameters: ToolParameterSchema;
  /** Whether this tool requires approval before execution */
  requiresApproval?: boolean;
  /** Tool categories for organization */
  categories?: ToolCategory[];
  /** Whether this tool can be used in sandboxed contexts */
  sandboxSafe?: boolean;
}

export type ToolCategory =
  | "file_system"
  | "network"
  | "browser"
  | "system"
  | "message"
  | "session"
  | "skill"
  | "automation"
  | "security"
  | "media"
  | "custom";

export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolParameter {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: (string | number)[];
  default?: unknown;
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
}

export interface ToolRequest {
  /** Tool name */
  tool: string;
  /** Tool call arguments */
  arguments: Record<string, unknown>;
  /** Calling session context */
  session?: {
    id: string;
    agentId?: string;
    channelId?: string;
  };
}

export interface ToolResult {
  /** Result content (Markdown or plain text) */
  content: string;
  /** Optional structured data */
  data?: unknown;
  /** Whether the tool execution failed */
  error?: boolean;
  /** Optional media attachments */
  media?: {
    type: "image" | "file";
    url: string;
    filename?: string;
  }[];
}

// ── Tool Plugin Interface ────────────────────────────────
export interface ToolPlugin {
  /** Tool definition metadata */
  readonly definition: ToolDefinition;

  /** Initialize the tool */
  init?(logger: PluginLogger, services: ServiceLocator): Promise<void>;

  /** Execute the tool */
  execute(request: ToolRequest): Promise<ToolResult>;

  /** Validate arguments before execution */
  validate?(args: Record<string, unknown>): { valid: boolean; errors?: string[] };

  /** Health check */
  healthCheck?(): Promise<{ healthy: boolean; message?: string }>;
}

// ── Tool Registry ────────────────────────────────────────
export interface ToolRegistry {
  /** Register a tool plugin */
  register(plugin: ToolPlugin): void;
  /** Unregister a tool */
  unregister(name: string): void;
  /** Get a registered tool */
  get(name: string): ToolPlugin | undefined;
  /** List all registered tools */
  list(): ToolDefinition[];
  /** Execute a tool by name */
  execute(name: string, request: ToolRequest): Promise<ToolResult>;
  /** Get tools filtered by category */
  getByCategory(category: ToolCategory): ToolDefinition[];
}

// ── Helpers ──────────────────────────────────────────────
export function createToolDefinition(
  name: string,
  description: string,
  parameters: ToolParameterSchema,
  options?: Partial<Omit<ToolDefinition, "name" | "description" | "parameters">>
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    requiresApproval: options?.requiresApproval ?? false,
    categories: options?.categories ?? ["custom"],
    sandboxSafe: options?.sandboxSafe ?? false,
  };
}