import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PassThrough } from "stream";
import {
  AcpServer,
  type JsonRpcResponse,
  type AcpMessage,
  type ToolActivity,
  type FileDiff,
  type TerminalCommand,
} from "./acp-server";
import { AcpAdapter, type SessionManagerLike, type AgentExecutorLike, type EventBusLike } from "./acp-adapter";

/**
 * AcpServer / AcpAdapter 测试套件。
 *
 * 覆盖：
 * - JSON-RPC 请求解析
 * - 会话管理（创建 / 列表 / 关闭）
 * - 消息发送（流式响应）
 * - 取消消息
 * - 能力查询
 * - 通知推送（toolActivity / fileDiff / terminalCommand）
 * - 无效请求处理
 * - 未关闭会话清理
 * - 并发会话
 * - stdio 读写
 * - AcpAdapter 桥接
 */

/** 从 PassThrough stdout 收集并解析 JSON-RPC 消息 */
function collectMessages(stream: PassThrough): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line));
        } catch {
          // ignore parse errors
        }
      }
    });
    // 等待下一个 tick 让数据写入完成
    setImmediate(() => resolve(messages));
  });
}

/** 发送请求并等待单条响应 */
async function sendAndAwait(
  server: AcpServer,
  stdin: PassThrough,
  stdout: PassThrough,
  request: Record<string, unknown>
): Promise<JsonRpcResponse> {
  const messagesPromise = collectMessages(stdout);
  stdin.write(JSON.stringify(request) + "\n");
  // 等待响应
  await new Promise((r) => setImmediate(r));
  const messages = await messagesPromise;
  // 找到带 id 的响应
  const response = messages.find(
    (m) => m.id === request.id || (request.id === undefined && m.id === null)
  );
  return (response ?? { jsonrpc: "2.0", id: null, error: { code: -32603, message: "no response" } }) as JsonRpcResponse;
}

describe("AcpServer", () => {
  let stdin: PassThrough;
  let stdout: PassThrough;
  let server: AcpServer;

  beforeEach(() => {
    stdin = new PassThrough();
    stdout = new PassThrough();
    server = new AcpServer(stdin, stdout);
  });

  afterEach(() => {
    server.stop();
  });

  // ─── 1. JSON-RPC 请求解析 ────────────────────────────────────────────────

  describe("JSON-RPC 请求解析", () => {
    it("应解析有效 JSON-RPC 2.0 请求", async () => {
      const response = await server.processRequestLine(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "acp.getCapabilities" })
      );
      expect(response).not.toBeNull();
      expect(response?.jsonrpc).toBe("2.0");
      expect(response?.id).toBe(1);
      expect(response?.error).toBeUndefined();
    });

    it("应拒绝非 JSON 输入（parse error）", async () => {
      const response = await server.processRequestLine("{invalid json}");
      expect(response).not.toBeNull();
      expect(response?.error?.code).toBe(-32700);
    });

    it("应拒绝非 2.0 版本的请求", async () => {
      const response = await server.processRequestLine(
        JSON.stringify({ jsonrpc: "1.0", id: 2, method: "acp.getCapabilities" })
      );
      expect(response?.error?.code).toBe(-32600);
    });

    it("应拒绝缺少 method 的请求", async () => {
      const response = await server.processRequestLine(
        JSON.stringify({ jsonrpc: "2.0", id: 3 })
      );
      expect(response?.error?.code).toBe(-32600);
    });
  });

  // ─── 2. 能力查询 ─────────────────────────────────────────────────────────

  describe("能力查询", () => {
    it("应返回完整能力声明", async () => {
      const response = await server.processRequestLine(
        JSON.stringify({ jsonrpc: "2.0", id: "cap-1", method: "acp.getCapabilities" })
      );
      expect(response?.result).toBeDefined();
      const result = response?.result as { capabilities: Record<string, unknown> };
      expect(result.capabilities.streaming).toBe(true);
      expect(result.capabilities.toolActivity).toBe(true);
      expect(result.capabilities.fileDiff).toBe(true);
      expect(result.capabilities.terminalCommands).toBe(true);
      expect(result.capabilities.cancellation).toBe(true);
    });
  });

  // ─── 3. 创建会话 ────────────────────────────────────────────────────────

  describe("会话管理", () => {
    it("应创建会话并返回 id", async () => {
      const response = await server.processRequestLine(
        JSON.stringify({ jsonrpc: "2.0", id: "s1", method: "acp.createSession" })
      );
      expect(response?.error).toBeUndefined();
      const session = response?.result as { id: string; status: string };
      expect(session.id).toBeTruthy();
      expect(session.status).toBe("active");
      expect(server.sessionCount).toBe(1);
    });

    it("应保留传入的 metadata", async () => {
      const response = await server.processRequestLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "s2",
          method: "acp.createSession",
          params: { metadata: { editor: "vscode", workspace: "/tmp/proj" } },
        })
      );
      const session = response?.result as { metadata?: Record<string, string> };
      expect(session.metadata?.editor).toBe("vscode");
      expect(session.metadata?.workspace).toBe("/tmp/proj");
    });

    // ─── 4. 列出会话 ────────────────────────────────────────────────────

    it("应列出所有活跃会话", async () => {
      await server.createSession();
      await server.createSession();
      const response = await server.processRequestLine(
        JSON.stringify({ jsonrpc: "2.0", id: "l1", method: "acp.listSessions" })
      );
      const sessions = response?.result as AcpMessage[];
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions).toHaveLength(2);
    });

    // ─── 5. 关闭会话 ────────────────────────────────────────────────────

    it("应关闭指定会话", async () => {
      const session = await server.createSession();
      const response = await server.processRequestLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "c1",
          method: "acp.closeSession",
          params: { sessionId: session.id },
        })
      );
      expect(response?.error).toBeUndefined();
      expect(server.getSession(session.id)?.status).toBe("closed");
    });

    it("关闭不存在的会话应报错", async () => {
      const response = await server.processRequestLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "c2",
          method: "acp.closeSession",
          params: { sessionId: "nonexistent" },
        })
      );
      expect(response?.error).toBeDefined();
      expect(response?.error?.code).toBe(-32603);
    });

    it("关闭会话时应缺少 sessionId 报错", async () => {
      const response = await server.processRequestLine(
        JSON.stringify({ jsonrpc: "2.0", id: "c3", method: "acp.closeSession" })
      );
      expect(response?.error?.code).toBe(-32602);
    });
  });

  // ─── 6. 发送消息（流式响应） ─────────────────────────────────────────────

  describe("消息发送", () => {
    it("应流式返回消息（默认 echo 实现）", async () => {
      const session = await server.createSession();
      const response = await server.processRequestLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "m1",
          method: "acp.sendMessage",
          params: { sessionId: session.id, content: "hello" },
        })
      );
      expect(response?.error).toBeUndefined();
      const result = response?.result as { messages: AcpMessage[] };
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content).toBe("hello");
      expect(result.messages[1].role).toBe("assistant");
      expect(result.messages[1].content).toBe("[echo] hello");
    });

    it("应使用注入的 messageHandler 生成响应", async () => {
      server.setMessageHandler(async function* (_sid, content, _signal) {
        yield {
          role: "assistant" as const,
          content: `processed: ${content}`,
          timestamp: new Date().toISOString(),
        };
      });
      const session = await server.createSession();
      const response = await server.processRequestLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "m2",
          method: "acp.sendMessage",
          params: { sessionId: session.id, content: "test" },
        })
      );
      const result = response?.result as { messages: AcpMessage[] };
      expect(result.messages[1].content).toBe("processed: test");
    });

    it("应拒绝对不存在会话的消息", async () => {
      const response = await server.processRequestLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "m3",
          method: "acp.sendMessage",
          params: { sessionId: "ghost", content: "hi" },
        })
      );
      expect(response?.error).toBeDefined();
    });

    it("应拒绝缺少 content 的消息", async () => {
      const session = await server.createSession();
      const response = await server.processRequestLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "m4",
          method: "acp.sendMessage",
          params: { sessionId: session.id },
        })
      );
      expect(response?.error?.code).toBe(-32602);
    });

    // ─── 7. 取消消息 ────────────────────────────────────────────────────

    it("应取消正在处理的消息", async () => {
      let cancelled = false;
      server.setMessageHandler(async function* (_sid, _content, signal) {
        // 模拟异步处理
        await new Promise((r) => setTimeout(r, 10));
        if (signal.aborted) {
          cancelled = true;
          return;
        }
        yield { role: "assistant" as const, content: "done", timestamp: new Date().toISOString() };
      });

      const session = await server.createSession();
      // 启动消息但不等待
      const responsePromise = server.processRequestLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "cancel-1",
          method: "acp.sendMessage",
          params: { sessionId: session.id, content: "long" },
        })
      );
      // 立即取消
      server.cancelMessage(session.id);
      await responsePromise;
      // 验证取消信号被传递
      expect(cancelled).toBe(true);
    });

    it("应通过 JSON-RPC 发送取消请求", async () => {
      const session = await server.createSession();
      const response = await server.processRequestLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "cancel-2",
          method: "acp.cancelMessage",
          params: { sessionId: session.id },
        })
      );
      expect(response?.error).toBeUndefined();
      const result = response?.result as { cancelled: boolean };
      expect(result.cancelled).toBe(true);
    });
  });

  // ─── 8. 通知推送 ─────────────────────────────────────────────────────────

  describe("通知推送", () => {
    it("应推送 toolActivity 通知", () => {
      server.start();
      const activity: ToolActivity = {
        toolName: "read_file",
        args: { path: "/tmp/test.txt" },
        status: "completed",
        result: "file contents",
      };
      // notifyToolActivity 直接写 stdout，需要从 stdout 捕获
      const chunks: string[] = [];
      stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      server.notifyToolActivity("session-x", activity);
      const combined = chunks.join("");
      const msg = JSON.parse(combined.trim());
      expect(msg.method).toBe("acp.toolActivity");
      expect(msg.params.sessionId).toBe("session-x");
      expect(msg.params.activity.toolName).toBe("read_file");
      expect(msg.params.activity.status).toBe("completed");
    });

    it("应推送 fileDiff 通知", () => {
      server.start();
      const chunks: string[] = [];
      stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      const diff: FileDiff = {
        filePath: "/tmp/app.ts",
        diff: "+new line",
        changeType: "modify",
      };
      server.notifyFileDiff("session-y", diff);
      const msg = JSON.parse(chunks.join("").trim());
      expect(msg.method).toBe("acp.fileDiff");
      expect(msg.params.diff.filePath).toBe("/tmp/app.ts");
      expect(msg.params.diff.changeType).toBe("modify");
    });

    it("应推送 terminalCommand 通知", () => {
      server.start();
      const chunks: string[] = [];
      stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      const cmd: TerminalCommand = {
        command: "npm install",
        exitCode: 0,
        stdout: "added 1 package",
      };
      server.notifyTerminalCommand("session-z", cmd);
      const msg = JSON.parse(chunks.join("").trim());
      expect(msg.method).toBe("acp.terminalCommand");
      expect(msg.params.command.command).toBe("npm install");
      expect(msg.params.command.exitCode).toBe(0);
    });

    it("stop 后不应推送通知", () => {
      server.start();
      server.stop();
      const chunks: string[] = [];
      stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      server.notifyToolActivity("session-x", {
        toolName: "x",
        args: {},
        status: "started",
      });
      expect(chunks).toHaveLength(0);
    });
  });

  // ─── 9. 无效请求处理 ──────────────────────────────────────────────────────

  describe("无效请求处理", () => {
    it("应返回 method not found 错误", async () => {
      const response = await server.processRequestLine(
        JSON.stringify({ jsonrpc: "2.0", id: "x1", method: "acp.unknownMethod" })
      );
      expect(response?.error?.code).toBe(-32601);
      expect(response?.error?.message).toContain("acp.unknownMethod");
    });

    it("应处理 notification（无 id 的请求不返回响应）", async () => {
      const response = await server.processRequestLine(
        JSON.stringify({ jsonrpc: "2.0", method: "acp.someNotification", params: { x: 1 } })
      );
      expect(response).toBeNull();
    });
  });

  // ─── 10. 未关闭会话清理 ───────────────────────────────────────────────────

  describe("会话清理", () => {
    it("stop() 应标记所有活跃会话为 closed", async () => {
      await server.createSession();
      await server.createSession();
      expect(server.sessionCount).toBe(2);

      server.stop();

      // 所有会话应为 closed 状态
      const sessions = await server.listSessions();
      expect(sessions).toHaveLength(0); // listSessions 只返回 active
    });

    it("stop() 应取消所有进行中的消息", async () => {
      let aborted = false;
      server.setMessageHandler(async function* (_sid, _content, signal) {
        await new Promise((r) => setTimeout(r, 50));
        if (signal.aborted) {
          aborted = true;
          return;
        }
        yield { role: "assistant" as const, content: "x", timestamp: new Date().toISOString() };
      });
      const session = await server.createSession();
      // 启动但不等待
      void server.processRequestLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "cleanup-1",
          method: "acp.sendMessage",
          params: { sessionId: session.id, content: "long" },
        })
      );
      server.stop();
      // 等待 abort 传播
      await new Promise((r) => setTimeout(r, 60));
      expect(aborted).toBe(true);
    });
  });

  // ─── 11. 并发会话 ────────────────────────────────────────────────────────

  describe("并发会话", () => {
    it("应支持多个并发活跃会话", async () => {
      const s1 = await server.createSession();
      const s2 = await server.createSession();
      const s3 = await server.createSession();
      expect(server.sessionCount).toBe(3);
      const sessions = await server.listSessions();
      expect(sessions).toHaveLength(3);
      const ids = sessions.map((s) => s.id).sort();
      expect(ids).toContain(s1.id);
      expect(ids).toContain(s2.id);
      expect(ids).toContain(s3.id);
    });

    it("应支持并发消息处理（不同会话）", async () => {
      const s1 = await server.createSession();
      const s2 = await server.createSession();
      const [r1, r2] = await Promise.all([
        server.processRequestLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "conc1",
            method: "acp.sendMessage",
            params: { sessionId: s1.id, content: "msg-1" },
          })
        ),
        server.processRequestLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "conc2",
            method: "acp.sendMessage",
            params: { sessionId: s2.id, content: "msg-2" },
          })
        ),
      ]);
      const res1 = r1?.result as { messages: AcpMessage[] };
      const res2 = r2?.result as { messages: AcpMessage[] };
      expect(res1.messages[1].content).toBe("[echo] msg-1");
      expect(res2.messages[1].content).toBe("[echo] msg-2");
    });
  });

  // ─── 12. stdio 读写 ──────────────────────────────────────────────────────

  describe("stdio 读写", () => {
    it("应从 stdin 读取并写响应到 stdout", async () => {
      server.start();
      const response = await sendAndAwait(
        server,
        stdin,
        stdout,
        { jsonrpc: "2.0", id: "stdio-1", method: "acp.getCapabilities" }
      );
      expect(response.id).toBe("stdio-1");
      expect(response.error).toBeUndefined();
    });

    it("应处理多行连续请求", async () => {
      server.start();
      const messagesPromise = collectMessages(stdout);
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "acp.getCapabilities" }) + "\n");
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "acp.getCapabilities" }) + "\n");
      await new Promise((r) => setImmediate(r));
      const messages = await messagesPromise;
      const ids = messages.map((m) => m.id).sort();
      expect(ids).toContain(1);
      expect(ids).toContain(2);
    });

    it("应忽略空行", async () => {
      server.start();
      const chunks: string[] = [];
      stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      stdin.write("\n\n\n");
      await new Promise((r) => setImmediate(r));
      expect(chunks).toHaveLength(0);
    });

    it("应支持 start / stop 幂等性", () => {
      server.start();
      server.start(); // 二次调用不应报错
      expect(server.isRunning()).toBe(true);
      server.stop();
      expect(server.isRunning()).toBe(false);
      server.stop(); // 二次调用不应报错
    });
  });
});

// ─── AcpAdapter 测试 ────────────────────────────────────────────────────────

describe("AcpAdapter", () => {
  let stdin: PassThrough;
  let stdout: PassThrough;
  let server: AcpServer;

  beforeEach(() => {
    stdin = new PassThrough();
    stdout = new PassThrough();
    server = new AcpServer(stdin, stdout);
  });

  afterEach(() => {
    server.stop();
  });

  /** 创建 mock SessionManager */
  function createMockSessionManager(): SessionManagerLike & { _calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = [];
    return {
      _calls: calls,
      createSession(agentId: string, options?: { sessionId?: string }) {
        calls.push({ type: "create", agentId, options });
        const sessionId = options?.sessionId ?? `internal-${Date.now()}`;
        return { sessionId, agentId, status: "active" };
      },
      archiveSession(agentId: string, sessionId: string, reason: string) {
        calls.push({ type: "archive", agentId, sessionId, reason });
      },
    };
  }

  /** 创建 mock AgentExecutor */
  function createMockAgentExecutor(replies: string[] = ["mock reply"]): AgentExecutorLike {
    let idx = 0;
    return {
      async chat(message: string) {
        const reply = replies[idx] ?? "fallback";
        idx++;
        return { reply: `${reply}: ${message}`, tokensUsed: 10 };
      },
    };
  }

  /** 创建 mock EventBus */
  function createMockEventBus(): EventBusLike & { _listeners: Map<string, Array<(...args: unknown[]) => void>> } {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const bus: EventBusLike = {
      on(event: string, listener: (...args: unknown[]) => void) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event)!.push(listener);
        return bus;
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        const arr = listeners.get(event);
        if (arr) {
          const i = arr.indexOf(listener);
          if (i >= 0) arr.splice(i, 1);
        }
        return bus;
      },
      emit(event: string, ...args: unknown[]) {
        const arr = listeners.get(event);
        if (arr) arr.forEach((l) => l(...args));
        return true;
      },
    };
    return Object.assign(bus, { _listeners: listeners });
  }

  it("应将消息委托给 AgentExecutor", async () => {
    const executor = createMockAgentExecutor(["hello from agent"]);
    const adapter = new AcpAdapter(server, null, executor);
    adapter.attach();

    const session = await server.createSession();
    const response = await server.processRequestLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "adapter-1",
        method: "acp.sendMessage",
        params: { sessionId: session.id, content: "ping" },
      })
    );
    const result = response?.result as { messages: AcpMessage[] };
    expect(result.messages[1].content).toBe("hello from agent: ping");
    adapter.detach();
  });

  it("应桥接 ACP 会话到 SessionManager", () => {
    const sm = createMockSessionManager();
    const adapter = new AcpAdapter(server, sm, null);
    adapter.attach();

    const internalId = adapter.linkSession("acp-session-1");
    expect(internalId).toBe("acp-session-1");
    expect(sm._calls).toHaveLength(1);
    expect(sm._calls[0].type).toBe("create");
    expect(adapter.getInternalSessionId("acp-session-1")).toBe("acp-session-1");
    adapter.detach();
  });

  it("unlinkSession 应调用 archiveSession", () => {
    const sm = createMockSessionManager();
    const adapter = new AcpAdapter(server, sm, null);
    adapter.attach();

    adapter.linkSession("acp-1");
    adapter.unlinkSession("acp-1");
    expect(sm._calls.some((c) => c.type === "archive")).toBe(true);
    adapter.detach();
  });

  it("EventBus 工具事件应转发为 ACP 通知", () => {
    const sm = createMockSessionManager();
    const bus = createMockEventBus();
    const adapter = new AcpAdapter(server, sm, null, bus);
    adapter.attach();

    // 建立 ACP sessionId → 内部 sessionId 映射
    adapter.linkSession("acp-event-1");

    const chunks: string[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    server.start();

    // 触发工具完成事件（sessionId 为内部 sessionId，即 "acp-event-1"）
    bus.emit("tool:execute:complete", {
      sessionId: "acp-event-1",
      toolName: "write_file",
      args: { path: "/tmp/x" },
      result: "ok",
      durationMs: 15,
    });

    const combined = chunks.join("");
    expect(combined).toContain("acp.toolActivity");
    expect(combined).toContain("write_file");
    adapter.detach();
  });

  it("未配置 executor 时应返回提示消息", async () => {
    const adapter = new AcpAdapter(server, null, null);
    adapter.attach();

    const session = await server.createSession();
    const response = await server.processRequestLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "adapter-2",
        method: "acp.sendMessage",
        params: { sessionId: session.id, content: "test" },
      })
    );
    const result = response?.result as { messages: AcpMessage[] };
    expect(result.messages[1].content).toContain("No agent executor");
    adapter.detach();
  });

  it("detach 后应停止转发 EventBus 事件", () => {
    const bus = createMockEventBus();
    const adapter = new AcpAdapter(server, null, null, bus);
    adapter.attach();
    adapter.detach();

    const chunks: string[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    server.start();

    bus.emit("tool:execute:complete", { sessionId: "x", toolName: "y", args: {} });
    expect(chunks).toHaveLength(0);
  });
});
