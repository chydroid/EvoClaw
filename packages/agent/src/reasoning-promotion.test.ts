/**
 * Step 4（Hermes 对齐）4a/4b thinking 细节测试
 *
 * 覆盖：
 * - 4a reasoning promotion：最终回复为空但推理内容含完整答案 → 晋升为可见正文。
 *   * 非流式：thinking-only content blocks → reasoning_content 晋升（工具轮不晋升）
 *   * 流式：SSE thinking_delta-only → 晋升；工具轮不晋升
 * - 4b anthropic thinking 保留策略接线：
 *   * llm-caller 历史装配在第三方中继（本地测试 host → third_party）默认剥离 thinking 块
 *   * convertMessagesToAnthropic 单测矩阵：default 剥离 / thinkingReplay 原样重放
 *     （含 signature）/ 空 assistant 轮跳过 / tool_calls → tool_use
 */
import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import { callLLMOnce, convertMessagesToAnthropic, LLMCallerDeps } from "./llm-caller";

interface ToolDef { type?: string; function?: Record<string, unknown> }

// ── minimal deps / provider / capture server（镜像 llm-caller.test.ts 原生 API 段）──

function minimalDeps(overrides: Partial<LLMCallerDeps> = {}): LLMCallerDeps {
  return {
    registry: undefined,
    recordProviderSuccess: vi.fn(),
    recordProviderFailure: vi.fn(),
    ...overrides,
  } as unknown as LLMCallerDeps;
}

function anthropicProvider(port: number, baseURL?: string) {
  return {
    name: "claude",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiKey: "sk-ant-test",
    baseURL: baseURL ?? `http://127.0.0.1:${port}`,
    id: "anthropic-1",
    enabled: true,
    order: 0,
    timeout: 5000,
    maxTokens: 4096,
    temperature: 0.3,
  } as unknown as LLMCallerDeps["providers"][number];
}

function captureServer(
  responder: (req: http.IncomingMessage, res: http.ServerResponse, raw: string) => void,
): {
  server: http.Server;
  captured: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>;
  port: number;
  close: () => void;
} {
  const captured: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      captured.push({ url: req.url || "", headers: req.headers, body: JSON.parse(raw || "{}") });
      responder(req, res, raw);
    });
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;
  return { server, captured, port, close: () => server.close() };
}

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((r) => server.on("listening", r));
}

// ═══════════════════════════════════════════════════════════
// 4a reasoning promotion
// ═══════════════════════════════════════════════════════════

describe("llm-caller > 4a 非流式 reasoning promotion", () => {
  it("thinking-only 回复（空 text）→ reasoning_content 晋升为正文", async () => {
    const { server, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        content: [
          { type: "thinking", thinking: "答案在推理里：42。", signature: "sig-abc" },
          { type: "text", text: "" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    });
    await listen(server);

    const result = await callLLMOnce(
      anthropicProvider(port),
      [{ role: "user", content: "q" }],
      [],
      "auto",
      undefined,
      minimalDeps(),
    );
    close();

    expect(result).not.toBeNull();
    expect(result!.message.content).toBe("答案在推理里：42。");
    // 晋升只填正文；返回为 OpenAI 形状（content/tool_calls），无 reasoning_content 字段
    expect(result!.message.tool_calls).toBeUndefined();
  });

  it("text 非空 → 不晋升（正文优先于推理）", async () => {
    const { server, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        content: [
          { type: "thinking", thinking: "内部推演", signature: "sig-xyz" },
          { type: "text", text: "可见答案" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    });
    await listen(server);

    const result = await callLLMOnce(
      anthropicProvider(port),
      [{ role: "user", content: "q" }],
      [],
      "auto",
      undefined,
      minimalDeps(),
    );
    close();

    expect(result!.message.content).toBe("可见答案");
  });

  it("工具轮（thinking + tool_use，text 空）→ 不晋升", async () => {
    const { server, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        content: [
          { type: "thinking", thinking: "我要调工具", signature: "sig-1" },
          { type: "tool_use", id: "toolu_pro", name: "shell_exec", input: { command: "ls" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    });
    await listen(server);

    const result = await callLLMOnce(
      anthropicProvider(port),
      [{ role: "user", content: "列目录" }],
      [{ type: "function", function: { name: "shell_exec", description: "run a command", parameters: { type: "object", properties: {} } } }],
      "auto",
      undefined,
      minimalDeps(),
    );
    close();

    expect(result!.message.tool_calls).toHaveLength(1);
    expect(result!.message.content).not.toBe("我要调工具");
  });
});

describe("llm-caller > 4a 流式 reasoning promotion", () => {
  it("SSE thinking_delta-only → 晋升为正文（空 text）", async () => {
    const events = [
      { type: "message_start", message: { id: "msg_f", role: "assistant", content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "答案是" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "42。" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ];
    const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    const { server, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.end(sse);
    });
    await listen(server);

    const onProgress = vi.fn();
    const result = await callLLMOnce(
      anthropicProvider(port),
      [{ role: "user", content: "q" }],
      [],
      "auto",
      onProgress,
      minimalDeps(),
    );
    close();

    expect(result).not.toBeNull();
    expect(result!.message.content).toBe("答案是42。");
    expect(result!.message.tool_calls).toBeUndefined();
  });

  it("SSE thinking + tool_use → 工具轮不晋升", async () => {
    const events = [
      { type: "message_start", message: { id: "msg_t", role: "assistant", content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "调工具再回答" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_f", name: "shell_exec", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ];
    const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    const { server, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.end(sse);
    });
    await listen(server);

    const result = await callLLMOnce(
      anthropicProvider(port),
      [{ role: "user", content: "列目录" }],
      [{ type: "function", function: { name: "shell_exec", description: "run a command", parameters: { type: "object", properties: {} } } }],
      "auto",
      vi.fn(),
      minimalDeps(),
    );
    close();

    expect(result!.message.tool_calls).toHaveLength(1);
    expect(result!.message.content).not.toBe("调工具再回答");
  });
});

// ═══════════════════════════════════════════════════════════
// 4b anthropic thinking 保留策略接线
// ═══════════════════════════════════════════════════════════

describe("llm-caller > 4b 历史装配 thinking 重放策略", () => {
  it("第三方中继（非 native/minimax）路径：历史 assistant thinking 块被剥离", async () => {
    let call = 0;
    const { server, captured, port, close } = captureServer((_req, res) => {
      call++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        content: [{ type: "text", text: call === 1 ? "第一答" : "第二答" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 3 },
      }));
    });
    await listen(server);

    // 历史含先手回合 thinking 块（真实本地 server = third_party 路由）
    const history = [
      { role: "user", content: "Q1" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先手回合思考", signature: "sig-prior" },
          { type: "text", text: "第一答" },
        ],
      },
      { role: "user", content: "继续" },
    ];
    const result = await callLLMOnce(
      anthropicProvider(port),
      history as Array<Record<string, unknown>>,
      [],
      "auto",
      undefined,
      minimalDeps(),
    );
    close();

    expect(result).not.toBeNull();
    const msgs = captured[0].body.messages as Array<Record<string, unknown>>;
    const allBlocks = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(allBlocks.some((b) => (b as { type?: string }).type === "thinking")).toBe(false);
    // 非 thinking 内容照常透传
    expect(allBlocks.some((b) => (b as { text?: string }).text === "第一答")).toBe(true);
  });

  it("convertMessagesToAnthropic 单测：thinkingReplay 开关矩阵", () => {
    const messages = [
      { role: "user", content: "Q" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先手回合思考", signature: "sig-x" },
          { type: "text", text: "A" },
        ],
      },
    ] as Array<Record<string, unknown>>;

    // 默认（无 opts）→ 剥离
    const stripped = convertMessagesToAnthropic(messages);
    const strippedBlocks = stripped.messages.flatMap((m) => m.content as Array<Record<string, unknown>>);
    expect(strippedBlocks.some((b) => b.type === "thinking")).toBe(false);

    // thinkingReplay:true → 原样重放（含 signature，逐字透传）
    const replayed = convertMessagesToAnthropic(messages, { thinkingReplay: true });
    const rBlocks = replayed.messages.flatMap((m) => m.content as Array<Record<string, unknown>>);
    const think = rBlocks.find((b) => b.type === "thinking");
    expect(think).toMatchObject({ thinking: "先手回合思考", signature: "sig-x" });

    // thinkingReplay:false → 剥离
    const off = convertMessagesToAnthropic(messages, { thinkingReplay: false });
    const offBlocks = off.messages.flatMap((m) => m.content as Array<Record<string, unknown>>);
    expect(offBlocks.some((b) => b.type === "thinking")).toBe(false);
  });

  it("空 assistant 轮（content 为空数组且无 tool_calls）被跳过（避免 Anthropic content:[] 400）", () => {
    const out = convertMessagesToAnthropic([
      { role: "user", content: "Q" },
      { role: "assistant", content: [] },
      { role: "user", content: "继续" },
    ]);
    expect(out.messages.every((m) => m.role !== "assistant")).toBe(true);
    expect(out.messages).toHaveLength(2);
  });

  it("assistant tool_calls → tool_use blocks（input 解析；坏 JSON 置空对象）", () => {
    const out = convertMessagesToAnthropic([
      { role: "user", content: "Q" },
      {
        role: "assistant",
        content: "好的，调工具。",
        tool_calls: [
          { id: "tc_ok", type: "function", function: { name: "t1", arguments: '{"a":1}' } },
          { id: "tc_bad", type: "function", function: { name: "t2", arguments: "{not json" } },
        ],
      },
    ]);
    const blocks = out.messages[1].content as Array<Record<string, unknown>>;
    const toolBlocks = blocks.filter((b) => b.type === "tool_use");
    expect(toolBlocks[0]).toMatchObject({ id: "tc_ok", name: "t1", input: { a: 1 } });
    expect(toolBlocks[1]).toMatchObject({ id: "tc_bad", name: "t2", input: {} });
  });

  it("tool 结果消息 → user 消息的 tool_result blocks（连续合并进同一 user）", () => {
    const out = convertMessagesToAnthropic([
      { role: "user", content: "Q" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "t1", arguments: "{}" } },
          { id: "tc2", type: "function", function: { name: "t2", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "tc1", content: "r1" },
      { role: "tool", tool_call_id: "tc2", content: "r2" },
    ]);
    const toolMsg = out.messages[out.messages.length - 1];
    expect(toolMsg.role).toBe("user");
    const blocks = toolMsg.content as Array<Record<string, unknown>>;
    expect(blocks).toMatchObject([
      { type: "tool_result", tool_use_id: "tc1", content: "r1" },
      { type: "tool_result", tool_use_id: "tc2", content: "r2" },
    ]);
  });
});
