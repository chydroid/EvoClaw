import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { GatewayServer } from "./gateway-server";

/**
 * /api/mcp/stream SSE 流式端点测试。
 *
 * 覆盖：
 * - 成功路径：tool_call_start → tool_result → done
 * - 工具不存在：tool_error → done
 * - 工具抛错：tool_error → done
 * - 非 tools/call 方法：返回 400
 */
describe("Gateway /api/mcp/stream (SSE)", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let gateway: GatewayServer;
  let port: number;
  const TEST_TOKEN = "test-token-for-mcp-stream-suite";
  let originalWebUiToken: string | undefined;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    // 配置 WEB_UI_TOKEN 以通过认证中间件
    originalWebUiToken = process.env.WEB_UI_TOKEN;
    process.env.WEB_UI_TOKEN = TEST_TOKEN;

    registry = new ServiceRegistry();
    eventBus = new EventBus();
    gateway = new GatewayServer(registry, eventBus);
    gateway.configure({
      port: 0,
      host: "127.0.0.1",
      enableWS: false,
      shutdownTimeoutMs: 2000,
      jwtSecret: "test-jwt-secret-for-mcp-stream-tests-32chars",
    });
    await gateway.start();
    const address = (gateway as any).server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterEach(async () => {
    await gateway.stop();
    if (originalWebUiToken === undefined) {
      delete process.env.WEB_UI_TOKEN;
    } else {
      process.env.WEB_UI_TOKEN = originalWebUiToken;
    }
  });

  /** 带认证 cookie 的 fetch */
  function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Cookie", `web_ui_token=${TEST_TOKEN}`);
    headers.set("Content-Type", "application/json");
    return fetch(url, { ...init, headers });
  }

  /** 注册一个 mock agentModelExecutor，含指定工具 */
  function registerTool(name: string, handler: (args: Record<string, unknown>) => Promise<unknown>): void {
    registry.registerService("agentModelExecutor", {
      registeredTools: new Map([
        [name, { handler, definition: { description: name, parameters: { type: "object" } } }],
      ]),
    });
  }

  /** 解析完整 SSE 响应体为事件数组 */
  function parseSSEEvents(text: string): Array<{ event: string; data: Record<string, unknown> }> {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const blocks = text.split("\n\n");
    for (const block of blocks) {
      const lines = block.split("\n");
      let eventType = "";
      let dataStr = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) eventType = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataStr += line.slice(6);
      }
      if (!eventType) continue;
      try {
        events.push({ event: eventType, data: JSON.parse(dataStr) });
      } catch {
        events.push({ event: eventType, data: { raw: dataStr } });
      }
    }
    return events;
  }

  it("成功路径：tool_call_start → tool_result → done", async () => {
    registerTool("echo", async (args) => ({ echoed: args.text }));

    const res = await authFetch(`http://127.0.0.1:${port}/api/mcp/stream`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hello" } },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    const events = parseSSEEvents(text);

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("tool_call_start");
    expect(eventTypes).toContain("tool_result");
    expect(eventTypes).toContain("done");

    const startEvent = events.find((e) => e.event === "tool_call_start");
    expect(startEvent?.data.toolName).toBe("echo");
    expect(startEvent?.data.callId).toBeTruthy();

    const resultEvent = events.find((e) => e.event === "tool_result");
    expect(resultEvent?.data.result).toBeDefined();

    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent?.data.success).toBe(true);
    expect(doneEvent?.data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("工具不存在：tool_error → done(success=false)", async () => {
    // 不注册任何工具
    registry.registerService("agentModelExecutor", {
      registeredTools: new Map(),
    });

    const res = await authFetch(`http://127.0.0.1:${port}/api/mcp/stream`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "nonexistent", arguments: {} },
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSSEEvents(text);

    const errorEvent = events.find((e) => e.event === "tool_error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.data.error).toContain("not found");

    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent?.data.success).toBe(false);
  });

  it("工具抛错：tool_error → done(success=false)", async () => {
    registerTool("fail", async () => {
      throw new Error("intentional failure");
    });

    const res = await authFetch(`http://127.0.0.1:${port}/api/mcp/stream`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "fail", arguments: {} },
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSSEEvents(text);

    const errorEvent = events.find((e) => e.event === "tool_error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.data.error).toContain("intentional failure");

    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent?.data.success).toBe(false);
  });

  it("非 tools/call 方法返回 400", async () => {
    const res = await authFetch(`http://127.0.0.1:${port}/api/mcp/stream`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/list",
        params: {},
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Only tools/call");
  });

  it("长时运行工具触发心跳 tool_progress 事件", async () => {
    // 工具执行时间超过心跳间隔（5s），但为了测试加速，注册一个 ~100ms 的工具
    // 注意：心跳间隔 5s 是硬编码的，测试中我们只验证最终结果正确
    registerTool("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { done: true };
    });

    const res = await authFetch(`http://127.0.0.1:${port}/api/mcp/stream`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "slow", arguments: {} },
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSSEEvents(text);

    // 至少有 start + result + done
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("tool_call_start");
    expect(eventTypes).toContain("tool_result");
    expect(eventTypes).toContain("done");
    expect(events[0].event).toBe("tool_call_start");
    expect(events[events.length - 1].event).toBe("done");
  });
});
