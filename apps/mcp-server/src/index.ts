#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseSSEChunk, type SSEEvent } from "./sse-parser.js";

const GATEWAY_URL = process.env.EVOCLAW_GATEWAY_URL || "http://localhost:27788";
const API_KEY = process.env.EVOCLAW_API_KEY;
const DEBUG = process.env.EVOCLAW_MCP_DEBUG === "true";
// 禁用流式：设为 "true" 时回退到同步 /api/mcp 端点（兼容旧 Gateway）
const DISABLE_STREAM = process.env.EVOCLAW_MCP_DISABLE_STREAM === "true";

// 从根 package.json 动态读取版本号，避免硬编码漂移
function readVersion(): string {
  const candidates = [
    resolve(__dirname, "../../../package.json"),
    resolve(__dirname, "../../package.json"),
    resolve(process.cwd(), "package.json"),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf-8"));
      if (pkg.version) return pkg.version;
    } catch {
      // 尝试下一个候选路径
    }
  }
  return "0.0.0";
}
const SERVER_VERSION = readVersion();

function log(msg: string): void {
  if (DEBUG) process.stderr.write(`[EvoClaw MCP] ${msg}\n`);
}

// ── HTTP 调用 Gateway 的 /api/mcp 端点（同步） ──
async function callGateway(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params });

  log(`→ ${method}: ${JSON.stringify(params).substring(0, 200)}`);

  const response = await fetch(`${GATEWAY_URL}/api/mcp`, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    throw new Error(`Gateway returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as { result?: unknown; error?: { message: string } };

  if (data.error) {
    throw new Error(data.error.message || "Gateway error");
  }

  log(`← ${method} OK`);
  return data.result;
}

// ── SSE 流式调用 Gateway 的 /api/mcp/stream 端点 ──
// 返回最终结果，同时通过 onProgress 回调推送中间进度事件
interface StreamCallResult {
  result: unknown;
  durationMs: number;
}

async function callGatewayStream(
  method: string,
  params: Record<string, unknown>,
  onProgress?: (event: SSEEvent) => void,
): Promise<StreamCallResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "Accept": "text/event-stream" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params });

  log(`→ stream ${method}: ${JSON.stringify(params).substring(0, 200)}`);

  const response = await fetch(`${GATEWAY_URL}/api/mcp/stream`, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    throw new Error(`Gateway stream returned ${response.status}: ${await response.text()}`);
  }

  if (!response.body) {
    throw new Error("Gateway stream returned no body");
  }

  // 解析 SSE 事件流
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: unknown = null;
  let durationMs = 0;

  const handleEvent = (evt: SSEEvent): void => {
    // 捕获最终结果
    if (evt.event === "tool_result") {
      finalResult = evt.data.result;
    }
    if (evt.event === "done") {
      durationMs = (evt.data.durationMs as number) || 0;
    }

    // 推送进度回调
    if (evt.event !== "done" && onProgress) {
      onProgress(evt);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = parseSSEChunk(buffer, handleEvent);
  }

  // 处理最后剩余的缓冲区
  if (buffer.trim()) {
    parseSSEChunk(buffer + "\n\n", handleEvent);
  }

  log(`← stream ${method} OK (duration: ${durationMs}ms)`);
  return { result: finalResult, durationMs };
}

// ── 工具列表缓存 ──
type GatewayTool = { name: string; description: string; inputSchema: unknown };
let cachedTools: GatewayTool[] | null = null;

async function getTools(): Promise<GatewayTool[]> {
  if (cachedTools) return cachedTools;

  const result = await callGateway("tools/list") as { tools?: Array<{ name: string; description: string; inputSchema: unknown }> };
  cachedTools = result?.tools || [];
  log(`Loaded ${cachedTools.length} tools from gateway`);
  return cachedTools;
}

// ── MCP Server ──
const server = new Server(
  { name: "evoclaw-mcp-server", version: SERVER_VERSION },
  { capabilities: { tools: {}, logging: {} } },
);

// tools/list — 桥接 Gateway 的工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await getTools();
  return {
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    })),
  };
});

// tools/call — 桥接工具调用到 Gateway
// 优先使用流式端点（支持进度反馈 + 客户端取消），
// 回退到同步端点（兼容旧版 Gateway 或显式禁用流式时）
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  log(`Tool call: ${name}`);

  // 流式路径：通过 /api/mcp/stream + SSE，推送进度到 MCP 客户端
  if (!DISABLE_STREAM) {
    try {
      const { result } = await callGatewayStream("tools/call", {
        name,
        arguments: args || {},
      }, async (evt) => {
        // 将 Gateway 的 SSE 事件转换为 MCP logging notifications
        // MCP 客户端（如 Cursor/Claude Desktop）会在 UI 中显示这些日志
        const level = evt.event === "tool_error" ? "error" :
                      evt.event === "tool_progress" ? "info" :
                      "notice";
        try {
          await server.sendLoggingMessage({
            level: level as "error" | "info" | "notice",
            logger: "evoclaw-mcp",
            data: {
              event: evt.event,
              ...evt.data,
            },
          });
        } catch {
          // 客户端可能未订阅 logging，忽略发送失败
        }
      });

      // MCP 标准返回格式：content 数组
      const resultObj = typeof result === "string" ? JSON.parse(result) : result;
      if (resultObj && typeof resultObj === "object" && "content" in resultObj) {
        return { content: (resultObj as { content: Array<{ type: string; text?: string }> }).content };
      }
      return {
        content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
      };
    } catch (streamErr) {
      // 流式失败时回退到同步端点（除非是客户端取消）
      const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      if (msg.includes("cancelled")) {
        return {
          content: [{ type: "text", text: `Tool execution cancelled: ${msg}` }],
          isError: true,
        };
      }
      log(`Stream call failed, falling back to sync: ${msg}`);
      // 继续走下面的同步路径
    }
  }

  // 同步路径：通过 /api/mcp
  const result = await callGateway("tools/call", {
    name,
    arguments: args || {},
  }) as { content?: Array<{ type: string; text?: string }> };

  // MCP 标准返回格式：content 数组
  return {
    content: result?.content || [{ type: "text", text: JSON.stringify(result) }],
  };
});

// ── 启动 ──
const transport = new StdioServerTransport();

transport.start().then(() => {
  log(`EvoClaw MCP Server started (gateway: ${GATEWAY_URL}, stream: ${!DISABLE_STREAM})`);
  log("Connect your IDE to use EvoClaw's 100+ tools");
}).catch(err => {
  process.stderr.write(`[EvoClaw MCP] Failed to start: ${err}\n`);
  process.exit(1);
});

// 优雅退出
process.on("SIGINT", () => {
  log("Shutting down...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  process.exit(0);
});
