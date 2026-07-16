/**
 * ACP 协议层测试 — 标准 ACP 方法、事件账本、策略门控。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PassThrough } from "stream";
import {
  AcpServer,
  type JsonRpcResponse,
} from "./acp-server";
import {
  ACP_PROTOCOL_VERSION,
  ACP_METHODS,
  ACP_SESSION_UPDATE_TAGS,
  ACP_ERROR_CODES,
  ACP_MAX_PROMPT_BYTES,
  DEFAULT_ACP_AGENT_INFO,
  AcpError,
  toAcpError,
  isAcpError,
  type AcpAgentInfo,
  type AcpSessionUpdate,
} from "./acp-protocol";
import {
  InMemoryAcpEventLedger,
  LEDGER_VERSION,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MAX_EVENTS_PER_SESSION,
} from "./acp-event-ledger";
import {
  isAcpEnabledByPolicy,
  resolveAcpDispatchPolicyError,
  resolveAcpExplicitTurnPolicyError,
  resolveAcpAgentPolicyError,
  resolveConcurrentSessionLimitError,
  type AcpConfig,
} from "./acp-policy";

// ─── 辅助函数 ──────────────────────────────────────────────────────────

function createServer(): { server: AcpServer; stdout: PassThrough } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const server = new AcpServer(stdin, stdout);
  server.start();
  return { server, stdout };
}

async function sendRequest(server: AcpServer, stdin: PassThrough, req: object): Promise<JsonRpcResponse | null> {
  return new Promise((resolve) => {
    const line = JSON.stringify({ jsonrpc: "2.0", ...req }) + "\n";
    stdin.write(line);
    setImmediate(() => {
      const result = server.processRequestLine(JSON.stringify({ jsonrpc: "2.0", ...req }));
      resolve(result);
    });
  });
}

/** 从 stdout 收集消息 */
function collectMessages(stdout: PassThrough): Promise<any[]> {
  return new Promise((resolve) => {
    const messages: any[] = [];
    let buffer = "";
    stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { messages.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    });
    setImmediate(() => resolve(messages));
  });
}

// ─── acp-protocol 测试 ────────────────────────────────────────────────

describe("ACP Protocol 常量", () => {
  it("协议版本为 1", () => {
    expect(ACP_PROTOCOL_VERSION).toBe(1);
  });

  it("标准方法名与 ACP 规范一致", () => {
    expect(ACP_METHODS.INITIALIZE).toBe("initialize");
    expect(ACP_METHODS.NEW_SESSION).toBe("session/new");
    expect(ACP_METHODS.PROMPT).toBe("session/prompt");
    expect(ACP_METHODS.CANCEL).toBe("session/cancel");
    expect(ACP_METHODS.LIST_SESSIONS).toBe("session/list");
    expect(ACP_METHODS.LOAD_SESSION).toBe("session/load");
    expect(ACP_METHODS.RESUME_SESSION).toBe("session/resume");
    expect(ACP_METHODS.CLOSE_SESSION).toBe("session/close");
    expect(ACP_METHODS.NOTIFICATION_SESSION_UPDATE).toBe("session/update");
  });

  it("会话更新 tag 与 OpenClaw 一致", () => {
    expect(ACP_SESSION_UPDATE_TAGS.AGENT_MESSAGE_CHUNK).toBe("agent_message_chunk");
    expect(ACP_SESSION_UPDATE_TAGS.TOOL_CALL).toBe("tool_call");
    expect(ACP_SESSION_UPDATE_TAGS.USAGE_UPDATE).toBe("usage_update");
    expect(ACP_SESSION_UPDATE_TAGS.PLAN).toBe("plan");
  });

  it("错误码覆盖所有 ACP 场景", () => {
    expect(ACP_ERROR_CODES).toContain("ACP_BACKEND_MISSING");
    expect(ACP_ERROR_CODES).toContain("ACP_DISPATCH_DISABLED");
    expect(ACP_ERROR_CODES).toContain("ACP_SESSION_INIT_FAILED");
    expect(ACP_ERROR_CODES).toContain("ACP_TURN_FAILED");
  });

  it("prompt 大小限制为 2MB", () => {
    expect(ACP_MAX_PROMPT_BYTES).toBe(2 * 1024 * 1024);
  });

  it("默认代理身份", () => {
    expect(DEFAULT_ACP_AGENT_INFO.name).toBe("evoclaw-acp");
    expect(DEFAULT_ACP_AGENT_INFO.protocolVersion).toBe(1);
  });
});

describe("AcpError", () => {
  it("构造错误并携带 code", () => {
    const err = new AcpError("ACP_TURN_FAILED", "turn failed");
    expect(err.code).toBe("ACP_TURN_FAILED");
    expect(err.message).toBe("turn failed");
    expect(err.name).toBe("AcpError");
  });

  it("toJSON 序列化", () => {
    const err = new AcpError("ACP_DISPATCH_DISABLED", "disabled", { detailCode: "policy" });
    const json = err.toJSON();
    expect(json.code).toBe("ACP_DISPATCH_DISABLED");
    expect(json.detailCode).toBe("policy");
  });

  it("toAcpError 包装普通错误", () => {
    const err = toAcpError(new Error("boom"));
    expect(err).toBeInstanceOf(AcpError);
    expect(err.code).toBe("ACP_TURN_FAILED");
    expect(err.message).toBe("boom");
  });

  it("toAcpError 不重复包装 AcpError", () => {
    const original = new AcpError("ACP_BACKEND_MISSING", "missing");
    const wrapped = toAcpError(original);
    expect(wrapped).toBe(original);
  });

  it("isAcpError 类型守卫", () => {
    expect(isAcpError(new AcpError("ACP_TURN_FAILED", "x"))).toBe(true);
    expect(isAcpError(new Error("x"))).toBe(false);
    expect(isAcpError("string")).toBe(false);
  });
});

// ─── acp-event-ledger 测试 ────────────────────────────────────────────

describe("InMemoryAcpEventLedger", () => {
  it("常量值正确", () => {
    expect(LEDGER_VERSION).toBe(1);
    expect(DEFAULT_MAX_SESSIONS).toBe(200);
    expect(DEFAULT_MAX_EVENTS_PER_SESSION).toBe(5000);
  });

  it("startSession 返回唯一 sessionId", () => {
    const ledger = new InMemoryAcpEventLedger();
    const id1 = ledger.startSession();
    const id2 = ledger.startSession();
    expect(id1).not.toBe(id2);
    expect(ledger.sessionCount).toBe(2);
  });

  it("recordUserPrompt 和 recordUpdate 记录事件", () => {
    const ledger = new InMemoryAcpEventLedger();
    const sid = ledger.startSession();
    ledger.recordUserPrompt(sid, "hello");
    ledger.recordUpdate(sid, { tag: "agent_message_chunk", text: "hi" });
    expect(ledger.getEventCount(sid)).toBe(2);
  });

  it("readReplay 返回事件列表", () => {
    const ledger = new InMemoryAcpEventLedger();
    const sid = ledger.startSession("session-key-1");
    ledger.recordUserPrompt(sid, "hello");
    ledger.recordUpdate(sid, { tag: "agent_message_chunk", text: "response" });

    const replay = ledger.readReplay(sid);
    expect(replay.complete).toBe(true);
    expect(replay.sessionId).toBe(sid);
    expect(replay.sessionKey).toBe("session-key-1");
    expect(replay.events).toHaveLength(2);
    expect(replay.events[0].update.tag).toBe("user_prompt");
    expect(replay.events[1].update.tag).toBe("agent_message_chunk");
  });

  it("readReplayBySessionKey 按 key 查找", () => {
    const ledger = new InMemoryAcpEventLedger();
    const sid = ledger.startSession("my-key");
    ledger.recordUpdate(sid, { tag: "plan" });

    const replay = ledger.readReplayBySessionKey("my-key");
    expect(replay.sessionId).toBe(sid);
    expect(replay.events).toHaveLength(1);
  });

  it("readReplay 不存在的 sessionId 返回空", () => {
    const ledger = new InMemoryAcpEventLedger();
    const replay = ledger.readReplay("nonexistent");
    expect(replay.complete).toBe(true);
    expect(replay.events).toEqual([]);
  });

  it("markIncomplete 标记后 replay complete=false", () => {
    const ledger = new InMemoryAcpEventLedger();
    const sid = ledger.startSession();
    ledger.recordUpdate(sid, { tag: "plan" });
    ledger.markIncomplete(sid);

    const replay = ledger.readReplay(sid);
    expect(replay.complete).toBe(false);
  });

  it("超过 maxEventsPerSession 时丢弃最旧", () => {
    const ledger = new InMemoryAcpEventLedger({ maxEventsPerSession: 3 });
    const sid = ledger.startSession();
    ledger.recordUpdate(sid, { tag: "plan" });
    ledger.recordUpdate(sid, { tag: "plan" });
    ledger.recordUpdate(sid, { tag: "plan" });
    ledger.recordUpdate(sid, { tag: "plan" });
    // 应保留最后 3 条
    expect(ledger.getEventCount(sid)).toBe(3);
  });

  it("close 清空所有会话", async () => {
    const ledger = new InMemoryAcpEventLedger();
    ledger.startSession();
    ledger.startSession();
    expect(ledger.sessionCount).toBe(2);
    await ledger.close();
    expect(ledger.sessionCount).toBe(0);
  });
});

// ─── acp-policy 测试 ──────────────────────────────────────────────────

describe("ACP Policy", () => {
  it("未配置时默认启用", () => {
    expect(isAcpEnabledByPolicy(undefined)).toBe(true);
  });

  it("enabled=false 时禁用", () => {
    expect(isAcpEnabledByPolicy({ enabled: false })).toBe(false);
  });

  it("enabled=true 时启用", () => {
    expect(isAcpEnabledByPolicy({ enabled: true })).toBe(true);
  });

  it("dispatch 被禁时返回错误", () => {
    const err = resolveAcpDispatchPolicyError({ dispatch: { enabled: false } });
    expect(err).not.toBeNull();
    expect(err!.code).toBe("ACP_DISPATCH_DISABLED");
  });

  it("ACP 全局禁用时 dispatch 返回错误", () => {
    const err = resolveAcpDispatchPolicyError({ enabled: false });
    expect(err).not.toBeNull();
    expect(err!.code).toBe("ACP_DISPATCH_DISABLED");
  });

  it("ACP 启用时 dispatch 返回 null", () => {
    expect(resolveAcpDispatchPolicyError({ enabled: true })).toBeNull();
  });

  it("explicitTurn 全局禁用时返回错误", () => {
    const err = resolveAcpExplicitTurnPolicyError({ enabled: false });
    expect(err).not.toBeNull();
    expect(err!.code).toBe("ACP_SESSION_INIT_FAILED");
  });

  it("agent 不在 allowedAgents 中时返回错误", () => {
    const cfg: AcpConfig = { allowedAgents: ["agent-a", "agent-b"] };
    const err = resolveAcpAgentPolicyError("agent-c", cfg);
    expect(err).not.toBeNull();
    expect(err!.code).toBe("ACP_SESSION_INIT_FAILED");
    expect(err!.message).toContain("agent-c");
  });

  it("agent 在 allowedAgents 中时返回 null", () => {
    const cfg: AcpConfig = { allowedAgents: ["agent-a", "agent-b"] };
    expect(resolveAcpAgentPolicyError("agent-a", cfg)).toBeNull();
  });

  it("allowedAgents 未配置时允许所有", () => {
    expect(resolveAcpAgentPolicyError("any-agent", undefined)).toBeNull();
  });

  it("并发会话数超限时返回错误", () => {
    const err = resolveConcurrentSessionLimitError(5, { maxConcurrentSessions: 5 });
    expect(err).not.toBeNull();
    expect(err!.code).toBe("ACP_SESSION_INIT_FAILED");
    expect(err!.message).toContain("5");
  });

  it("并发会话数未超限时返回 null", () => {
    expect(resolveConcurrentSessionLimitError(3, { maxConcurrentSessions: 5 })).toBeNull();
  });
});

// ─── AcpServer 标准 ACP 方法测试 ──────────────────────────────────────

describe("AcpServer 标准 ACP 方法", () => {
  it("initialize 返回协议版本和代理信息", async () => {
    const { server } = createServer();
    const response = await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: ACP_METHODS.INITIALIZE, params: { protocolVersion: 1 } })
    );
    expect(response).not.toBeNull();
    expect(response!.result).toMatchObject({
      protocolVersion: 1,
      agentInfo: { name: "evoclaw-acp" },
    });
  });

  it("session/new 创建会话", async () => {
    const { server } = createServer();
    const response = await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: ACP_METHODS.NEW_SESSION, params: { cwd: "/test" } })
    );
    expect(response).not.toBeNull();
    const result = response!.result as { sessionId: string; cwd: string };
    expect(result.sessionId).toBeTruthy();
    expect(result.cwd).toBe("/test");
  });

  it("session/prompt 发送消息并推送 session/update", async () => {
    const { server, stdout } = createServer();
    // 先创建会话
    const createResp = await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: ACP_METHODS.NEW_SESSION, params: {} })
    );
    const sessionId = (createResp!.result as any).sessionId;

    // 发送 prompt
    const promptResp = await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: ACP_METHODS.PROMPT, params: { sessionId, prompt: "hello" } })
    );
    expect(promptResp).not.toBeNull();
    expect((promptResp!.result as any).stop).toEqual({ reason: "end_turn" });

    // stdout 应包含 session/update 通知
    const messages = await collectMessages(stdout);
    const updates = messages.filter((m) => m.method === ACP_METHODS.NOTIFICATION_SESSION_UPDATE);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0].params.update.tag).toBe("agent_message_chunk");
  });

  it("session/list 返回会话列表", async () => {
    const { server } = createServer();
    await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: ACP_METHODS.NEW_SESSION, params: {} })
    );
    const response = await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: ACP_METHODS.LIST_SESSIONS, params: {} })
    );
    expect(response).not.toBeNull();
    const result = response!.result as { sessions: any[] };
    expect(result.sessions.length).toBeGreaterThan(0);
    expect(result.sessions[0].state).toBe("idle");
  });

  it("session/close 关闭会话", async () => {
    const { server } = createServer();
    const createResp = await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: ACP_METHODS.NEW_SESSION, params: {} })
    );
    const sessionId = (createResp!.result as any).sessionId;

    const closeResp = await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: ACP_METHODS.CLOSE_SESSION, params: { sessionId } })
    );
    expect(closeResp).not.toBeNull();
    expect((closeResp!.result as any).state).toBe("closed");
  });

  it("session/load 在无 eventLedger 时返回错误", async () => {
    const { server } = createServer();
    const response = await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: ACP_METHODS.LOAD_SESSION, params: { sessionId: "s1" } })
    );
    expect(response).not.toBeNull();
    expect(response!.error).toBeDefined();
    expect(response!.error!.code).toBe(-32601); // METHOD_NOT_FOUND
  });

  it("session/load 在有 eventLedger 时返回重放", async () => {
    const { server } = createServer();
    const ledger = new InMemoryAcpEventLedger();
    server.setEventLedger(ledger);

    const ledgerSid = ledger.startSession();
    ledger.recordUserPrompt(ledgerSid, "test prompt");

    const response = await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: ACP_METHODS.LOAD_SESSION, params: { sessionId: ledgerSid } })
    );
    expect(response).not.toBeNull();
    const result = response!.result as { events: any[]; complete: boolean };
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("setAgentInfo 更新代理身份", () => {
    const { server } = createServer();
    server.setAgentInfo({ name: "custom-agent", version: "1.2.3" });
    const info = server.getAgentInfo();
    expect(info.name).toBe("custom-agent");
    expect(info.version).toBe("1.2.3");
  });

  it("session/prompt 超大 prompt 返回错误", async () => {
    const { server } = createServer();
    const createResp = await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: ACP_METHODS.NEW_SESSION, params: {} })
    );
    const sessionId = (createResp!.result as any).sessionId;

    const hugePrompt = "x".repeat(ACP_MAX_PROMPT_BYTES + 1);
    const response = await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: ACP_METHODS.PROMPT, params: { sessionId, prompt: hugePrompt } })
    );
    expect(response).not.toBeNull();
    expect(response!.error).toBeDefined();
    expect(response!.error!.message).toContain("maximum size");
  });

  it("session/resume 恢复已存在会话", async () => {
    const { server } = createServer();
    const createResp = await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: ACP_METHODS.NEW_SESSION, params: {} })
    );
    const sessionId = (createResp!.result as any).sessionId;

    // 关闭
    await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: ACP_METHODS.CLOSE_SESSION, params: { sessionId } })
    );

    // 恢复
    const resumeResp = await server.processRequestLine(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: ACP_METHODS.RESUME_SESSION, params: { sessionId } })
    );
    expect(resumeResp).not.toBeNull();
    expect((resumeResp!.result as any).state).toBe("idle");
  });
});
