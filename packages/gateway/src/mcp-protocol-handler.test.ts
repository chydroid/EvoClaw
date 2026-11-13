/**
 * MCPProtocolHandler — initialize 协议版本回归测试（P6 收尾）。
 *
 * MCP 规范与 SDK 的 InitializeResultSchema 都要求 initialize 结果带
 * protocolVersion；缺失会让标准 SDK Client.connect() 解析失败。
 */

import { describe, it, expect } from "vitest";
import { MCPProtocolHandler } from "./mcp-protocol-handler";
import { InitializeResultSchema } from "@modelcontextprotocol/sdk/types.js";

const initParams = (over: Record<string, unknown> = {}) => ({
  protocolVersion: "2025-06-18",
  clientInfo: { name: "test-client", version: "1.0.0" },
  capabilities: {},
  ...over,
});

describe("MCPProtocolHandler.initialize — protocolVersion", () => {
  const handler = new MCPProtocolHandler({
    serverName: "test-server",
    serverVersion: "1.0.0",
    toolRegistry: { listTools: () => [], executeTool: async () => ({}) },
  });

  it("回显受支持的客户端版本，且响应可被 SDK InitializeResultSchema 解析", async () => {
    const res = await handler.routeMessage({
      jsonrpc: "2.0",
      id: "1",
      method: "initialize",
      params: initParams(),
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ protocolVersion: "2025-06-18" });
    // SDK schema 要求 protocolVersion 为必填 string
    expect(() => InitializeResultSchema.parse(res.result)).not.toThrow();
  });

  it("不支持/缺失的协议版本回落到 2024-11-05（所有 SDK 版本都支持）", async () => {
    const unsupported = await handler.routeMessage({
      jsonrpc: "2.0",
      id: "2",
      method: "initialize",
      params: initParams({ protocolVersion: "1999-01-01" }),
    });
    expect(unsupported.result).toMatchObject({ protocolVersion: "2024-11-05" });

    const missing = await handler.routeMessage({
      jsonrpc: "2.0",
      id: "3",
      method: "initialize",
      params: { clientInfo: initParams().clientInfo, capabilities: {} },
    });
    expect(missing.result).toMatchObject({ protocolVersion: "2024-11-05" });
  });

  it("缺少 clientInfo / capabilities 仍返回 INVALID_PARAMS", async () => {
    const res = await handler.routeMessage({
      jsonrpc: "2.0",
      id: "4",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(res.error?.code).toBe(-32602);
  });
});
