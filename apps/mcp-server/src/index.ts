#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "fs";
import { resolve } from "path";

const GATEWAY_URL = process.env.EVOCLAW_GATEWAY_URL || "http://localhost:27788";
const API_KEY = process.env.EVOCLAW_API_KEY;
const DEBUG = process.env.EVOCLAW_MCP_DEBUG === "true";

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

// ── HTTP 调用 Gateway 的 /api/mcp 端点 ──
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
  { capabilities: { tools: {} } },
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
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  log(`Tool call: ${name}`);

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
  log(`EvoClaw MCP Server started (gateway: ${GATEWAY_URL})`);
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
