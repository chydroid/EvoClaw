/**
 * Provider SDK — standardized interface for LLM provider plugins.
 */

import type { PluginLogger, ServiceLocator } from "./types.js";

// ── Model Types ──────────────────────────────────────────
export interface ModelInfo {
  /** Model identifier (e.g., "gpt-4o") */
  id: string;
  /** Display name */
  name: string;
  /** Provider identifier */
  provider: string;
  /** Whether this model supports vision/image input */
  supportsVision: boolean;
  /** Whether this model supports streaming */
  supportsStreaming: boolean;
  /** Whether this model supports tool calling */
  supportsTools: boolean;
  /** Maximum context window in tokens */
  maxContextTokens: number;
  /** Maximum output tokens */
  maxOutputTokens: number;
  /** Cost per 1M input tokens (USD) */
  costInputPerMillion?: number;
  /** Cost per 1M output tokens (USD) */
  costOutputPerMillion?: number;
}

export interface ModelRequest {
  /** Model to use */
  model: string;
  /** Conversation messages */
  messages: ChatMessage[];
  /** System prompt */
  system?: string;
  /** Temperature (0-2) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Tool definitions for function calling */
  tools?: ModelToolDefinition[];
  /** Whether to stream the response */
  stream?: boolean;
  /** Stop sequences */
  stop?: string[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContent[];
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ChatContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: "auto" | "low" | "high" };
}

export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelResponse {
  /** Response ID */
  id: string;
  /** Model used */
  model: string;
  /** Response content */
  content: string;
  /** Tool calls if any */
  toolCalls?: ToolCall[];
  /** Token usage */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Finish reason */
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "error";
}

export interface StreamChunk {
  /** Delta text */
  text?: string;
  /** Delta tool calls (partial) */
  toolCalls?: Partial<ToolCall>[];
  /** Finish reason (only on final chunk) */
  finishReason?: string;
}

// ── Provider Plugin Interface ────────────────────────────
export interface ProviderPlugin {
  /** Provider identifier (e.g., "openai", "anthropic") */
  readonly provider: string;

  /** Initialize the provider */
  init(config: ProviderConfig, logger: PluginLogger, services: ServiceLocator): Promise<void>;

  /** List available models */
  listModels(): Promise<ModelInfo[]>;

  /** Check if a model is available */
  hasModel(modelId: string): Promise<boolean>;

  /** Generate a completion */
  complete(request: ModelRequest): Promise<ModelResponse>;

  /** Stream a completion */
  streamComplete(
    request: ModelRequest,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<ModelResponse>;

  /** Get current usage/cost statistics */
  getUsage?(): Promise<{
    totalTokens: number;
    totalCost: number;
    requests: number;
  }>;

  /** Health check */
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
}

// ── Provider Configuration ───────────────────────────────
export interface ProviderConfig {
  /** API key */
  apiKey?: string;
  /** Base URL for self-hosted providers */
  baseURL?: string;
  /** Default model */
  defaultModel?: string;
  /** API timeout in ms */
  timeout?: number;
  /** Max retries */
  maxRetries?: number;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Provider-specific config */
  extra?: Record<string, unknown>;
}

// ── Provider Registry ────────────────────────────────────
export interface ProviderRegistry {
  /** Register a provider plugin */
  register(plugin: ProviderPlugin): void;
  /** Unregister a provider */
  unregister(provider: string): void;
  /** Get a registered provider */
  get(provider: string): ProviderPlugin | undefined;
  /** List all registered providers */
  list(): string[];
  /** List all available models across providers */
  listAllModels(): Promise<ModelInfo[]>;
  /** Find the best provider for a model */
  resolve(modelId: string): ProviderPlugin | undefined;
}