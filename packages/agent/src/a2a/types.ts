/** A2A Agent Card - describes an agent's capabilities */
export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: A2ACapability[];
  authentication?: {
    type: "none" | "api_key" | "oauth2";
    details?: string;
  };
  metadata?: Record<string, unknown>;
}

/** A2A Capability */
export interface A2ACapability {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/** A2A Task - a unit of work sent to a remote agent */
export interface A2ATask {
  id: string;
  capabilityId: string;
  input: unknown;
  metadata?: Record<string, unknown>;
}

/** A2A Task Result */
export interface A2ATaskResult {
  taskId: string;
  status: "completed" | "failed" | "in_progress";
  output?: unknown;
  error?: string;
  durationMs?: number;
}

/** A2A Message for inter-agent communication */
export interface A2AMessage {
  id: string;
  fromAgent: string;
  toAgent: string;
  type: "task_request" | "task_result" | "task_error" | "capability_query" | "capability_response" | "heartbeat";
  payload: unknown;
  timestamp: number;
  replyTo?: string;
}

/** Configuration for A2A client */
export interface A2AClientConfig {
  /** Default timeout for remote calls in ms */
  timeout: number;
  /** Maximum retries */
  maxRetries: number;
  /** API keys for known agents */
  apiKeys: Record<string, string>;
}

/** Configuration for A2A server */
export interface A2AServerConfig {
  /** URL where this agent is accessible */
  publicUrl: string;
  /** Whether to enable the A2A server */
  enabled: boolean;
  /** Authentication type */
  authType: "none" | "api_key";
  /** Valid API keys (if authType is api_key) */
  validApiKeys?: string[];
}
