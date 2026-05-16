export interface MCPTool {
  name: string;
  description: string;
  inputSchema: MCPJsonSchema;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPJsonSchema {
  type: string;
  properties?: Record<string, MCPJsonSchema>;
  required?: string[];
  description?: string;
  enum?: string[];
  items?: MCPJsonSchema;
}

export interface MCPCapabilities {
  tools?: Record<string, MCPTool>;
  resources?: Record<string, MCPResource>;
  prompts?: Record<string, MCPPrompt>;
  experimental?: Record<string, unknown>;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: MCPPromptArgument[];
}

export interface MCPPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface MCPInitializeRequest {
  protocolVersion: string;
  capabilities: MCPClientCapabilities;
  clientInfo: MCPClientInfo;
}

export interface MCPClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: Record<string, unknown>;
}

export interface MCPClientInfo {
  name: string;
  version: string;
}

export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: MCPCapabilities;
  serverInfo: MCPServerInfo;
}

export interface MCPServerInfo {
  name: string;
  version: string;
}

export interface MCPTransport {
  type: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
}

export interface MCPToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MCPToolCallResult {
  content: MCPContent[];
  isError?: boolean;
}

export interface MCPContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface MCPResourceReadRequest {
  uri: string;
}

export interface MCPResourceReadResult {
  contents: MCPResourceContent[];
}

export interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}