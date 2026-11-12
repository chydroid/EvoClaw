/**
 * P6 端到端：真实 stdio MCP server 发起 sampling/createMessage，
 * 客户端 transport 声明能力、注册 handler 并返回 LLM 结果。
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { MCPClientTransport } from "./mcp-client-transport";

const sdkBase = pathToFileURL(
  path.resolve("packages/gateway/node_modules/@modelcontextprotocol/sdk/dist/esm"),
).href;

const SERVER_SCRIPT = `
import { Server } from ${JSON.stringify(sdkBase + "/server/index.js")};
import { StdioServerTransport } from ${JSON.stringify(sdkBase + "/server/stdio.js")};
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CreateMessageResultSchema,
} from ${JSON.stringify(sdkBase + "/types.js")};

const server = new Server(
  { name: "sampling-test", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "ask",
    description: "ask the client LLM via sampling",
    inputSchema: { type: "object", properties: {} },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async () => {
  try {
    const result = await server.request(
      {
        method: "sampling/createMessage",
        params: {
          messages: [{ role: "user", content: { type: "text", text: "hello" } }],
          maxTokens: 64,
        },
      },
      CreateMessageResultSchema,
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    return { content: [{ type: "text", text: "ERR:" + (err && err.message ? err.message : String(err)) }] };
  }
});

await server.connect(new StdioServerTransport());
`;

describe("MCP sampling 端到端（stdio，P6）", () => {
  let tmpDir: string | null = null;
  let transport: MCPClientTransport | null = null;

  afterEach(async () => {
    await transport?.disconnect();
    transport = null;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("server 发起 sampling，客户端 handler 返回文本且指标记账", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-sampling-e2e-"));
    const scriptPath = path.join(tmpDir, "server.mjs");
    fs.writeFileSync(scriptPath, SERVER_SCRIPT, "utf-8");

    transport = new MCPClientTransport(
      "sampling-e2e",
      { type: "stdio", command: process.execPath, args: [scriptPath] },
      undefined,
      {
        config: { enabled: true, maxRequestsPerMinute: 10 },
        llm: async () => ({
          model: "fake-model",
          text: "sampled-answer",
          usage: { totalTokens: 12, promptTokens: 7 },
        }),
      },
    );
    await transport.connect();

    const tools = await transport.listTools();
    expect(tools.map((t) => t.name)).toContain("ask");

    const raw = await transport.callTool({
      toolName: "ask",
      args: {},
      signal: AbortSignal.timeout(15_000),
    }) as { content: Array<{ type: string; text?: string }> };

    const text = raw.content?.[0]?.text ?? "";
    expect(text).toContain("sampled-answer");
    expect(text).toContain("fake-model");
    expect(transport.getSamplingMetrics()).toMatchObject({ requests: 1, tokensUsed: 12 });
  }, 30_000);

  it("默认关闭：未配置 sampling 时 server 的 sampling 请求被拒绝", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-sampling-e2e-off-"));
    const scriptPath = path.join(tmpDir, "server.mjs");
    fs.writeFileSync(scriptPath, SERVER_SCRIPT, "utf-8");

    transport = new MCPClientTransport(
      "sampling-off",
      { type: "stdio", command: process.execPath, args: [scriptPath] },
    );
    await transport.connect();

    const raw = await transport.callTool({
      toolName: "ask",
      args: {},
      signal: AbortSignal.timeout(15_000),
    }) as { content: Array<{ type: string; text?: string }> };

    expect(raw.content?.[0]?.text ?? "").toContain("ERR:");
    expect(transport.getSamplingMetrics()).toBeNull();
  }, 30_000);
});
