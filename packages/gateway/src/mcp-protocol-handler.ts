/**
 * MCP Protocol Handler — Complete MCP (Model Context Protocol) handler.
 *
 * Implements JSON-RPC 2.0 based routing for MCP methods including:
 *  - initialize
 *  - tools/list, tools/call
 *  - resources/list, resources/read
 *  - prompts/list, prompts/get
 *
 * Uses a tool registry (injected via constructor) for tool listing and execution.
 */

// ─── JSON-RPC Error Codes ────────────────────────────────────────────────────

const JSONRPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ─── Tool Registry Interface ─────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolRegistry {
  listTools(): ToolDefinition[];
  executeTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

// ─── Resource / Prompt Types ─────────────────────────────────────────────────

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface PromptDefinition {
  name: string;
  description: string;
  arguments: Array<{
    name: string;
    description: string;
    required: boolean;
  }>;
}

// ─── MCPProtocolHandler ──────────────────────────────────────────────────────

export class MCPProtocolHandler {
  private readonly serverName: string;
  private readonly serverVersion: string;
  private readonly toolRegistry: ToolRegistry | null;
  private readonly resources: ResourceDefinition[];
  private readonly prompts: PromptDefinition[];
  private readonly resourceContentProvider: ((uri: string) => Promise<string>) | null;
  private readonly promptProvider:
    | ((name: string, args: Record<string, string>) => Array<{ role: string; content: { type: string; text: string } }>)
    | null;

  /** 危险工具黑名单：禁止通过 MCP 暴露/调用 */
  private static readonly MCP_BLOCKED_TOOLS = new Set([
    "shell_exec", "execute_code", "file_delete", "file_modify",
    "video_download",
  ]);

  constructor(options: {
    serverName?: string;
    serverVersion?: string;
    toolRegistry?: ToolRegistry;
    resources?: ResourceDefinition[];
    prompts?: PromptDefinition[];
    resourceContentProvider?: (uri: string) => Promise<string>;
    promptProvider?: (
      name: string,
      args: Record<string, string>,
    ) => Array<{ role: string; content: { type: string; text: string } }>;
  } = {}) {
    this.serverName = options.serverName ?? "EvoClaw MCP Server";
    this.serverVersion = options.serverVersion ?? "0.1.0";
    this.toolRegistry = options.toolRegistry ?? null;
    this.resources = options.resources ?? [];
    this.prompts = options.prompts ?? [];
    this.resourceContentProvider = options.resourceContentProvider ?? null;
    this.promptProvider = options.promptProvider ?? null;
  }

  // ─── MCP Method Handlers ────────────────────────────────────────────────

  handleInitialize(params: {
    clientInfo: { name: string; version: string };
    capabilities: Record<string, unknown>;
  }): {
    serverInfo: { name: string; version: string };
    capabilities: Record<string, unknown>;
  } {
    const serverCapabilities: Record<string, unknown> = {};

    if (this.toolRegistry !== null) {
      serverCapabilities.tools = { listChanged: false };
    }

    if (this.resources.length > 0) {
      serverCapabilities.resources = { subscribe: false, listChanged: false };
    }

    if (this.prompts.length > 0) {
      serverCapabilities.prompts = { listChanged: false };
    }

    return {
      serverInfo: {
        name: this.serverName,
        version: this.serverVersion,
      },
      capabilities: serverCapabilities,
    };
  }

  handleToolsList(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    if (!this.toolRegistry) {
      return [];
    }
    const tools = this.toolRegistry.listTools();
    return tools.filter(t => !MCPProtocolHandler.MCP_BLOCKED_TOOLS.has(t.name));
  }

  async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (MCPProtocolHandler.MCP_BLOCKED_TOOLS.has(name)) {
      return {
        content: [
          { type: "text", text: `Tool "${name}" is blocked over MCP for security` },
        ],
      };
    }

    if (!this.toolRegistry) {
      return {
        content: [
          { type: "text", text: `No tool registry configured; cannot execute tool "${name}"` },
        ],
      };
    }

    let result: unknown;
    try {
      result = await this.toolRegistry.executeTool(name, args);
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Tool "${name}" execution failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }

    // 检测 "tool not found" 错误并抛出，让 routeMessage 返回 JSON-RPC 顶层 error（code: -32601），
    // 而非以 HTTP 200 + result.content 内嵌 error 文本的形式返回（违反 JSON-RPC 2.0 / MCP 规范）。
    if (result && typeof result === "object" && "error" in result) {
      const errMsg = String((result as Record<string, unknown>).error);
      if (/not found/i.test(errMsg)) {
        const notFoundErr = new Error(`Tool not found: ${name}`);
        (notFoundErr as Error & { code?: string }).code = "TOOL_NOT_FOUND";
        throw notFoundErr;
      }
    }

    const sanitized = this.sanitizeToolResult(result);
    return {
      content: [
        {
          type: "text",
          text: typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized, null, 2),
        },
      ],
    };
  }

  /**
   * Sanitize MCP tool result blocks — convert non-text/image blocks to text
   * to prevent API errors (e.g., Anthropic 400 on resource_link/audio blocks)
   * Inspired by OpenClaw 2026.6.5 MCP tool result compatibility
   */
  private sanitizeToolResult(result: unknown): unknown {
    if (!result || typeof result !== "object") return result;

    const obj = result as Record<string, unknown>;

    // If result has content array (MCP tool result format)
    if (Array.isArray(obj.content)) {
      obj.content = obj.content.map((block: Record<string, unknown>) => {
        if (!block || typeof block !== "object") {
          return { type: "text", text: `[invalid] ${JSON.stringify(block)}` };
        }
        if (block.type === "text" || block.type === "image") {
          return block; // Keep text and image blocks as-is
        }
        // Convert resource_link, audio, resource, and other non-standard blocks to text
        return {
          type: "text",
          text: `[${block.type || "unknown"}] ${JSON.stringify(block)}`,
        };
      });
    }

    return obj;
  }

  handleResourcesList(): Array<{
    uri: string;
    name: string;
    description: string;
    mimeType: string;
  }> {
    return this.resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  async handleResourceRead(uri: string): Promise<{
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  }> {
    const resource = this.resources.find((r) => r.uri === uri);

    if (!resource) {
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: `Resource not found: ${uri}`,
          },
        ],
      };
    }

    if (this.resourceContentProvider) {
      try {
        const text = await this.resourceContentProvider(uri);
        return {
          contents: [{ uri, mimeType: resource.mimeType, text }],
        };
      } catch (err) {
        return {
          contents: [
            {
              uri,
              mimeType: "text/plain",
              text: `Failed to read resource "${uri}": ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }

    return {
      contents: [
        {
          uri,
          mimeType: resource.mimeType,
          text: `Resource content for "${resource.name}" is not available (no content provider configured)`,
        },
      ],
    };
  }

  handlePromptsList(): Array<{
    name: string;
    description: string;
    arguments: Array<{ name: string; description: string; required: boolean }>;
  }> {
    return this.prompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments.map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required,
      })),
    }));
  }

  handlePromptGet(
    name: string,
    args: Record<string, string>,
  ): {
    messages: Array<{ role: string; content: { type: string; text: string } }>;
  } {
    const prompt = this.prompts.find((p) => p.name === name);

    if (!prompt) {
      return {
        messages: [
          {
            role: "system",
            content: { type: "text", text: `Prompt not found: ${name}` },
          },
        ],
      };
    }

    // Validate required arguments
    for (const arg of prompt.arguments) {
      if (arg.required && !(arg.name in args)) {
        return {
          messages: [
            {
              role: "system",
              content: {
                type: "text",
                text: `Missing required argument "${arg.name}" for prompt "${name}"`,
              },
            },
          ],
        };
      }
    }

    if (this.promptProvider) {
      try {
        const messages = this.promptProvider(name, args);
        return { messages };
      } catch (err) {
        return {
          messages: [
            {
              role: "system",
              content: {
                type: "text",
                text: `Failed to generate prompt "${name}": ${err instanceof Error ? err.message : String(err)}`,
              },
            },
          ],
        };
      }
    }

    // Default: build a simple prompt from the definition
    const argDescriptions = prompt.arguments
      .map((a) => `- ${a.name}${a.required ? " (required)" : " (optional)"}: ${a.description}`)
      .join("\n");

    const filledArgs = prompt.arguments
      .map((a) => `${a.name}: ${args[a.name] ?? "(not provided)"}`)
      .join("\n");

    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${prompt.description}\n\nArguments:\n${argDescriptions}\n\nValues:\n${filledArgs}`,
          },
        },
      ],
    };
  }

  // ─── JSON-RPC Message Router ────────────────────────────────────────────

  async routeMessage(message: {
    jsonrpc: string;
    method: string;
    params?: Record<string, unknown>;
    id?: string;
  }): Promise<{
    jsonrpc: string;
    result?: unknown;
    error?: { code: number; message: string };
    id: string;
  }> {
    const id = message.id ?? "";

    // Validate JSON-RPC version
    if (message.jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        error: { code: JSONRPC_ERROR.INVALID_REQUEST, message: "Invalid Request: jsonrpc must be \"2.0\"" },
        id,
      };
    }

    // Validate method is present
    if (!message.method || typeof message.method !== "string") {
      return {
        jsonrpc: "2.0",
        error: { code: JSONRPC_ERROR.INVALID_REQUEST, message: "Invalid Request: method is required" },
        id,
      };
    }

    const { method, params } = message;

    try {
      switch (method) {
        case "initialize": {
          if (!params || typeof params !== "object") {
            return {
              jsonrpc: "2.0",
              error: { code: JSONRPC_ERROR.INVALID_PARAMS, message: "Invalid params: clientInfo and capabilities are required" },
              id,
            };
          }
          const clientInfo = params.clientInfo as { name: string; version: string } | undefined;
          const capabilities = params.capabilities as Record<string, unknown> | undefined;
          if (!clientInfo || !capabilities) {
            return {
              jsonrpc: "2.0",
              error: { code: JSONRPC_ERROR.INVALID_PARAMS, message: "Invalid params: clientInfo and capabilities are required" },
              id,
            };
          }
          const result = this.handleInitialize({ clientInfo, capabilities });
          return { jsonrpc: "2.0", result, id };
        }

        case "tools/list": {
          const result = this.handleToolsList();
          return { jsonrpc: "2.0", result: { tools: result }, id };
        }

        case "tools/call": {
          if (!params || typeof params !== "object") {
            return {
              jsonrpc: "2.0",
              error: { code: JSONRPC_ERROR.INVALID_PARAMS, message: "Invalid params: name and arguments are required" },
              id,
            };
          }
          const toolName = params.name as string | undefined;
          const toolArgs = (params.arguments as Record<string, unknown>) ?? {};
          if (!toolName || typeof toolName !== "string") {
            return {
              jsonrpc: "2.0",
              error: { code: JSONRPC_ERROR.INVALID_PARAMS, message: "Invalid params: tool name is required" },
              id,
            };
          }
          const result = await this.handleToolCall(toolName, toolArgs);
          return { jsonrpc: "2.0", result, id };
        }

        case "resources/list": {
          const result = this.handleResourcesList();
          return { jsonrpc: "2.0", result: { resources: result }, id };
        }

        case "resources/read": {
          if (!params || typeof params !== "object") {
            return {
              jsonrpc: "2.0",
              error: { code: JSONRPC_ERROR.INVALID_PARAMS, message: "Invalid params: uri is required" },
              id,
            };
          }
          const uri = params.uri as string | undefined;
          if (!uri || typeof uri !== "string") {
            return {
              jsonrpc: "2.0",
              error: { code: JSONRPC_ERROR.INVALID_PARAMS, message: "Invalid params: uri is required" },
              id,
            };
          }
          const result = await this.handleResourceRead(uri);
          return { jsonrpc: "2.0", result, id };
        }

        case "prompts/list": {
          const result = this.handlePromptsList();
          return { jsonrpc: "2.0", result: { prompts: result }, id };
        }

        case "prompts/get": {
          if (!params || typeof params !== "object") {
            return {
              jsonrpc: "2.0",
              error: { code: JSONRPC_ERROR.INVALID_PARAMS, message: "Invalid params: name is required" },
              id,
            };
          }
          const promptName = params.name as string | undefined;
          const promptArgs = (params.arguments as Record<string, string>) ?? {};
          if (!promptName || typeof promptName !== "string") {
            return {
              jsonrpc: "2.0",
              error: { code: JSONRPC_ERROR.INVALID_PARAMS, message: "Invalid params: prompt name is required" },
              id,
            };
          }
          const result = this.handlePromptGet(promptName, promptArgs);
          return { jsonrpc: "2.0", result, id };
        }

        default:
          return {
            jsonrpc: "2.0",
            error: { code: JSONRPC_ERROR.METHOD_NOT_FOUND, message: `Method not found: ${method}` },
            id,
          };
      }
    } catch (err) {
      // handleToolCall 抛出的 "tool not found" 错误返回 -32601 (METHOD_NOT_FOUND)，
      // 符合 JSON-RPC 2.0 / MCP 规范；其余错误返回 -32603 (INTERNAL_ERROR)。
      const isNotFound = err instanceof Error && (err as Error & { code?: string }).code === "TOOL_NOT_FOUND";
      return {
        jsonrpc: "2.0",
        error: {
          code: isNotFound ? JSONRPC_ERROR.METHOD_NOT_FOUND : JSONRPC_ERROR.INTERNAL_ERROR,
          message: isNotFound
            ? (err instanceof Error ? err.message : String(err))
            : `Internal error: ${err instanceof Error ? err.message : String(err)}`,
        },
        id,
      };
    }
  }
}
