import {
  type MCPCapabilities,
  type MCPInitializeRequest,
  type MCPInitializeResult,
  type MCPToolCallRequest,
  type MCPToolCallResult,
  type MCPTool,
  type MCPContent,
} from "@evoclaw/core";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";

function generateId(): string {
  return randomUUID();
}

/** buffer 最大字节数（防止恶意客户端发送超大无换行数据导致内存耗尽） */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB

/** SSE 连接数上限（防止恶意客户端打开无限连接导致内存耗尽） */
const MAX_SSE_CLIENTS = 100;

declare function setTimeout(
  callback: (...args: unknown[]) => void,
  ms: number,
  ...args: unknown[]
): NodeJS.Timeout;

export interface MCPTransportImpl {
  getType(): "stdio" | "sse";
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
  sendNotification(method: string, params?: Record<string, unknown>): Promise<void>;
  sendRequest(
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  onRequest(
    handler: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  ): void;
}

interface JSONRPCMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

const MCP_PROTOCOL_VERSION = "2024-11-05";

export class MCPSSETransport extends EventEmitter implements MCPTransportImpl {
  private connected = false;
  private pendingRequests = new Map<string | number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private requestHandler: ((method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>) | null = null;
  private messageQueue: JSONRPCMessage[] = [];
  private sseClients: Set<{ write: (data: string) => void; end: () => void }> = new Set();

  private serverInfo = {
    name: "EvoClaw MCP Server",
    version: "0.1.0",
  };

  constructor(
    private endpoint: string,
    private capabilities: MCPCapabilities
  ) {
    super();
    this.on("error", (err) => {
      process.stderr.write(`[MCPTransport] error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }

  getType(): "sse" {
    return "sse";
  }

  async start(): Promise<void> {
    this.connected = true;
    this.emit("status", "connected");
  }

  async stop(): Promise<void> {
    this.connected = false;

    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Transport closed"));
    }
    this.pendingRequests.clear();

    this.emit("status", "disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method,
      params,
    };

    // 迭代快照：避免 write 抛错时修改 sseClients 导致迭代器失效；
    // 每条 write 包 try/catch 防止单个客户端断连中断整个广播。
    for (const client of [...this.sseClients]) {
      try {
        client.write(`data: ${JSON.stringify(message)}\n\n`);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  async sendRequest(
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = generateId();
      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request "${method}" timed out`));
      }, 30000);
      timer.unref?.();

      this.pendingRequests.set(id, { resolve, reject, timer });

      for (const client of [...this.sseClients]) {
        try {
          client.write(`data: ${JSON.stringify(message)}\n\n`);
        } catch {
          this.sseClients.delete(client);
        }
      }
    });
  }

  onRequest(
    handler: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  ): void {
    this.requestHandler = handler;
  }

  addSSEClient(write: (data: string) => void, end: () => void): void {
    // 限制 SSE 客户端数量，超限时驱逐最旧的连接，防止内存无限增长
    if (this.sseClients.size >= MAX_SSE_CLIENTS) {
      const oldest = this.sseClients.values().next().value;
      if (oldest) {
        try { oldest.end(); } catch { /* ignore */ }
        this.sseClients.delete(oldest);
        process.stderr.write(`[MCPTransport] SSE clients exceeded ${MAX_SSE_CLIENTS}, evicted oldest connection\n`);
      }
    }

    this.sseClients.add({ write, end });

    const endpointEvent: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    };
    write(`data: ${JSON.stringify(endpointEvent)}\n\n`);

    this.emit("client_connected");
  }

  removeSSEClient(write: (data: string) => void): void {
    for (const client of this.sseClients) {
      if (client.write === write) {
        this.sseClients.delete(client);
        break;
      }
    }
    this.emit("client_disconnected");
  }

  async handleMessage(data: Record<string, unknown>): Promise<JSONRPCMessage> {
    const msg = data as unknown as JSONRPCMessage;

    if (msg.id && msg.result !== undefined) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        pending.resolve(msg.result);
      }
      return { jsonrpc: "2.0", id: msg.id, result: {} };
    }

    if (msg.id && msg.error) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        pending.reject(new Error(msg.error.message));
      }
      return { jsonrpc: "2.0", id: msg.id, error: msg.error };
    }

    if (msg.method && msg.id) {
      if (msg.method === "initialize") {
        return this.handleInitialize(msg.id, msg.params as unknown as MCPInitializeRequest);
      }

      if (msg.method === "tools/list") {
        return this.handleToolsList(msg.id);
      }

      if (msg.method === "tools/call") {
        return this.handleToolCall(msg.id, msg.params as unknown as MCPToolCallRequest);
      }

      if (msg.method === "resources/list") {
        return this.handleResourcesList(msg.id);
      }

      if (this.requestHandler) {
        try {
          const result = await this.requestHandler(msg.method, msg.params);
          return { jsonrpc: "2.0", id: msg.id, result };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      }

      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      };
    }

    if (msg.method && !msg.id) {
      this.emit("notification", msg.method, msg.params);
      return { jsonrpc: "2.0" };
    }

    return { jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" } };
  }

  private handleInitialize(
    id: string | number,
    params?: MCPInitializeRequest
  ): JSONRPCMessage {
    const result: MCPInitializeResult = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: this.capabilities,
      serverInfo: this.serverInfo,
    };

    return { jsonrpc: "2.0", id, result: result as unknown as Record<string, unknown> };
  }

  private handleToolsList(id: string | number): JSONRPCMessage {
    const tools: MCPTool[] = [];

    if (this.capabilities.tools) {
      for (const [name, tool] of Object.entries(this.capabilities.tools)) {
        tools.push({ name, description: tool.description, inputSchema: tool.inputSchema });
      }
    }

    return {
      jsonrpc: "2.0",
      id,
      result: { tools } as unknown as Record<string, unknown>,
    };
  }

  private handleResourcesList(id: string | number): JSONRPCMessage {
    const resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }> = [];

    if (this.capabilities.resources) {
      for (const [uri, resource] of Object.entries(this.capabilities.resources)) {
        resources.push({
          uri: resource.uri || uri,
          name: resource.name,
          description: resource.description,
          mimeType: resource.mimeType,
        });
      }
    }

    return {
      jsonrpc: "2.0",
      id,
      result: { resources } as unknown as Record<string, unknown>,
    };
  }

  private async handleToolCall(
    id: string | number,
    params?: MCPToolCallRequest
  ): Promise<JSONRPCMessage> {
    if (!params || !params.name) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Missing tool name" },
      };
    }

    try {
      const content: MCPContent[] = [];

      if (this.requestHandler) {
        const result = await this.requestHandler("tools/call", {
          toolName: params.name,
          arguments: params.arguments,
        });

        content.push({
          type: "text",
          text: JSON.stringify(result),
        });
      } else {
        content.push({
          type: "text",
          text: `Tool "${params.name}" executed (no handler registered)`,
        });
      }

      const toolResult: MCPToolCallResult = { content };

      return {
        jsonrpc: "2.0",
        id,
        result: toolResult as unknown as Record<string, unknown>,
      };
    } catch (err) {
      const errorResult: MCPToolCallResult = {
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };

      return {
        jsonrpc: "2.0",
        id,
        result: errorResult as unknown as Record<string, unknown>,
      };
    }
  }
}

export class MCPStdioTransport extends EventEmitter implements MCPTransportImpl {
  private connected = false;
  private pendingRequests = new Map<string | number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private requestHandler: ((method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>) | null = null;
  private buffer = "";
  private readHandler: ((data: string) => void) | null = null;

  private serverInfo = {
    name: "EvoClaw MCP Server",
    version: "0.1.0",
  };

  constructor(
    private capabilities: MCPCapabilities,
    private stdin: NodeJS.ReadableStream = process.stdin,
    private stdout: NodeJS.WritableStream = process.stdout
  ) {
    super();
    this.on("error", (err) => {
      process.stderr.write(`[MCPTransport] error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }

  getType(): "stdio" {
    return "stdio";
  }

  async start(): Promise<void> {
    this.connected = true;

    this.setupStdinListener();

    this.emit("status", "connected");
  }

  async stop(): Promise<void> {
    this.connected = false;

    if (this.readHandler) {
      this.stdin.removeListener("data", this.readHandler);
      this.readHandler = null;
    }

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Transport closed"));
    }
    this.pendingRequests.clear();

    this.emit("status", "disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method,
      params,
    };

    this.writeToStdout(message);
  }

  async sendRequest(
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = generateId();
      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request "${method}" timed out`));
      }, 30000);
      timer.unref?.();

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.writeToStdout(message);
    });
  }

  onRequest(
    handler: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  ): void {
    this.requestHandler = handler;
  }

  private writeToStdout(message: JSONRPCMessage): void {
    this.stdout.write(JSON.stringify(message) + "\n");
  }

  private setupStdinListener(): void {
    this.readHandler = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : chunk;
      this.buffer += data;

      // 超过 buffer 上限时按 newline 边界清理，保留最后一条未完成消息，避免整段清空丢消息
      if (this.buffer.length > MAX_BUFFER_SIZE) {
        const lastNewline = this.buffer.lastIndexOf("\n");
        if (lastNewline >= 0) {
          this.buffer = this.buffer.slice(lastNewline + 1);
        } else {
          this.buffer = "";
        }
      }

      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim()) as JSONRPCMessage;
          this.processMessage(msg).catch((err) => {
            this.emit("error", err);
          });
        } catch (err) {
          this.emit("parse_error", line, err);
        }
      }
    };

    this.stdin.on("data", this.readHandler);
  }

  private async processMessage(msg: JSONRPCMessage): Promise<void> {
    if (msg.id && msg.result !== undefined) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.id && msg.error) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        pending.reject(new Error(msg.error.message));
      }
      return;
    }

    if (msg.method && msg.id) {
      let response: JSONRPCMessage;

      if (msg.method === "initialize") {
        response = {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: this.capabilities,
            serverInfo: this.serverInfo,
          } as unknown as Record<string, unknown>,
        };
      } else if (msg.method === "tools/list") {
        const tools: MCPTool[] = [];
        if (this.capabilities.tools) {
          for (const [name, tool] of Object.entries(this.capabilities.tools)) {
            tools.push({ name, description: tool.description, inputSchema: tool.inputSchema });
          }
        }
        response = {
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools } as unknown as Record<string, unknown>,
        };
      } else if (msg.method === "tools/call") {
        const params = msg.params as unknown as MCPToolCallRequest;
        if (!params || !params.name) {
          response = {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32602, message: "Missing tool name" },
          };
        } else if (this.capabilities.tools && !(params.name in this.capabilities.tools)) {
          response = {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32602, message: `Tool not found: ${params.name}` },
          };
        } else {
          try {
            const content: MCPContent[] = [];
            if (this.requestHandler) {
              const result = await this.requestHandler("tools/call", {
                toolName: params.name,
                arguments: params.arguments,
              });
              content.push({
                type: "text",
                text: JSON.stringify(result),
              });
            } else {
              content.push({
                type: "text",
                text: `Tool "${params.name}" executed (no handler registered)`,
              });
            }
            const toolResult: MCPToolCallResult = { content };
            response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: toolResult as unknown as Record<string, unknown>,
            };
          } catch (err) {
            const errorResult: MCPToolCallResult = {
              content: [
                {
                  type: "text",
                  text: err instanceof Error ? err.message : String(err),
                },
              ],
              isError: true,
            };
            response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: errorResult as unknown as Record<string, unknown>,
            };
          }
        }
      } else if (this.requestHandler) {
        try {
          const result = await this.requestHandler(msg.method, msg.params);
          response = { jsonrpc: "2.0", id: msg.id, result };
        } catch (err) {
          response = {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          };
        }
      } else {
        response = {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        };
      }

      this.writeToStdout(response);
      return;
    }

    if (msg.method && !msg.id) {
      this.emit("notification", msg.method, msg.params);
    }
  }
}