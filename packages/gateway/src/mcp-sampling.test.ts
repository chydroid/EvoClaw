/**
 * P6 MCP sampling 护栏测试（对标 hermes-agent mcp_tool_sampling.py）。
 */

import { describe, it, expect } from "vitest";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  createSamplingHandler,
  sanitizeSamplingError,
  type McpSamplingConfig,
  type SamplingLlmRequest,
  type SamplingLlmResult,
  type SamplingParamsLike,
} from "./mcp-sampling";

const params = (over: Partial<SamplingParamsLike> = {}): SamplingParamsLike => ({
  messages: [{ role: "user", content: { type: "text", text: "hi" } }],
  maxTokens: 1000,
  ...over,
});

const config = (over: Partial<McpSamplingConfig> = {}): McpSamplingConfig => ({
  enabled: true,
  ...over,
});

const textLlm = (text = "answer"): (req: SamplingLlmRequest) => Promise<SamplingLlmResult> =>
  async () => ({ model: "test-model", text, usage: { totalTokens: 7, promptTokens: 3 } });

describe("createSamplingHandler（P6）", () => {
  it("文本响应：返回 text content + 指标记账", async () => {
    const { handler, getMetrics } = createSamplingHandler("s1", config(), textLlm("hello"));
    const result = await handler(params());

    expect(result).toMatchObject({
      role: "assistant",
      model: "test-model",
      stopReason: "endTurn",
      content: { type: "text", text: "hello" },
    });
    expect(getMetrics()).toMatchObject({ requests: 1, total: 1, succeeded: 1, errors: 0, tokensUsed: 7 });
  });

  it("被拒请求计入 total 与 errors，且 total = succeeded + errors", async () => {
    const { handler, getMetrics } = createSamplingHandler(
      "s1",
      config({ maxRequestsPerMinute: 1 }),
      textLlm(),
    );
    await handler(params());
    await expect(handler(params())).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    const m = getMetrics();
    expect(m.total).toBe(2);
    expect(m.succeeded).toBe(1);
    expect(m.errors).toBe(1);
    expect(m.total).toBe(m.succeeded + m.errors);
  });

  it("滑动窗口限流：超过 maxRequestsPerMinute 拒绝", async () => {
    const { handler } = createSamplingHandler(
      "s1",
      config({ maxRequestsPerMinute: 2 }),
      textLlm(),
    );
    await handler(params());
    await handler(params());
    await expect(handler(params())).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining("rate limit"),
    });
  });

  it("模型 allowlist：不在列表内拒绝，命中则透传模型", async () => {
    const seen: Array<string | undefined> = [];
    const llm = async (req: SamplingLlmRequest): Promise<SamplingLlmResult> => {
      seen.push(req.model);
      return { model: req.model ?? "default", text: "ok" };
    };
    const { handler } = createSamplingHandler(
      "s1",
      config({ allowedModels: ["model-a"] }),
      llm,
    );

    await expect(
      handler(params({ modelPreferences: { hints: [{ name: "model-b" }] } })),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidRequest, message: expect.stringContaining("not allowed") });

    await handler(params({ modelPreferences: { hints: [{ name: "model-a" }] } }));
    expect(seen).toEqual(["model-a"]);
  });

  it("maxTokens 被客户端硬上限钳制", async () => {
    let seenMax = 0;
    const llm = async (req: SamplingLlmRequest): Promise<SamplingLlmResult> => {
      seenMax = req.maxTokens;
      return { model: "m", text: "ok" };
    };
    const { handler } = createSamplingHandler("s1", config({ maxTokensCap: 128 }), llm);

    await handler(params({ maxTokens: 999_999 }));
    expect(seenMax).toBe(128);

    await handler(params({ maxTokens: 20 }));
    expect(seenMax).toBe(20);
  });

  it("超时 abort 并返回 RequestTimeout（fail-closed）", async () => {
    let aborted = false;
    const llm = (req: SamplingLlmRequest): Promise<SamplingLlmResult> =>
      new Promise((_resolve, reject) => {
        req.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const { handler } = createSamplingHandler("s1", config({ timeoutMs: 50 }), llm);

    await expect(handler(params())).rejects.toMatchObject({ code: ErrorCode.RequestTimeout });
    expect(aborted).toBe(true);
  });

  it("空响应视为错误，不静默返回空文本", async () => {
    const { handler } = createSamplingHandler(
      "s1",
      config(),
      async () => ({ model: "m", text: "" }),
    );
    await expect(handler(params())).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining("empty response"),
    });
  });

  it("sampling.tools 默认关闭：带 tools 的请求被拒绝", async () => {
    const { handler } = createSamplingHandler("s1", config(), textLlm());
    await expect(
      handler(params({ tools: [{ name: "t", inputSchema: { type: "object" } }] })),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidRequest, message: expect.stringContaining("tools are not enabled") });
  });

  it("tool-use 连续轮次上限：超过 maxToolRounds 拒绝", async () => {
    const llm = async (): Promise<SamplingLlmResult> => ({
      model: "m",
      toolCalls: [{ id: "1", name: "probe", arguments: { a: 1 } }],
    });
    const { handler, getMetrics } = createSamplingHandler(
      "s1",
      config({ exposeClientTools: true, maxToolRounds: 2 }),
      llm,
    );

    const first = await handler(params({ tools: [{ name: "probe", inputSchema: { type: "object" } }] }));
    expect(first.stopReason).toBe("toolUse");
    expect(first.content).toEqual([
      { type: "tool_use", id: "1", name: "probe", input: { a: 1 } },
    ]);
    await handler(params({ tools: [{ name: "probe", inputSchema: { type: "object" } }] }));
    await expect(
      handler(params({ tools: [{ name: "probe", inputSchema: { type: "object" } }] })),
    ).rejects.toMatchObject({ message: expect.stringContaining("tool loop limit exceeded") });
    expect(getMetrics().toolUseCount).toBe(3);
    // 轮次闸门拒绝的那次不能同时算成功：total = succeeded + errors 恒成立
    const m = getMetrics();
    expect(m.total).toBe(3);
    expect(m.succeeded).toBe(2);
    expect(m.errors).toBe(1);
    expect(m.total).toBe(m.succeeded + m.errors);
  });

  it("maxToolRounds=0 时禁用工具", async () => {
    const llm = async (): Promise<SamplingLlmResult> => ({
      model: "m",
      toolCalls: [{ id: "1", name: "probe", arguments: {} }],
    });
    const { handler } = createSamplingHandler(
      "s1",
      config({ exposeClientTools: true, maxToolRounds: 0 }),
      llm,
    );
    await expect(
      handler(params({ tools: [{ name: "probe", inputSchema: { type: "object" } }] })),
    ).rejects.toMatchObject({ message: expect.stringContaining("disabled") });
  });

  it("消息块转换为纯文本（text/image/systemPrompt/temperature）", async () => {
    let seen: SamplingLlmRequest | undefined;
    const llm = async (req: SamplingLlmRequest): Promise<SamplingLlmResult> => {
      seen = req;
      return { model: "m", text: "ok" };
    };
    const { handler } = createSamplingHandler("s1", config(), llm);

    await handler(params({
      systemPrompt: "be nice",
      temperature: 0.3,
      stopSequences: ["END"],
      messages: [
        { role: "user", content: [{ type: "text", text: "one" }, { type: "image", data: "x", mimeType: "image/png" }] },
        { role: "assistant", content: { type: "text", text: "two" } },
      ],
    }));

    expect(seen?.systemPrompt).toBe("be nice");
    expect(seen?.temperature).toBe(0.3);
    expect(seen?.stopSequences).toEqual(["END"]);
    expect(seen?.messages).toEqual([
      { role: "user", content: "one\n[image omitted: image/png]" },
      { role: "assistant", content: "two" },
    ]);
  });

  it("并发请求互不阻塞", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const llm = async (req: SamplingLlmRequest): Promise<SamplingLlmResult> => {
      await gate;
      return { model: "m", text: `echo:${req.messages[0]?.content ?? ""}` };
    };
    const { handler } = createSamplingHandler("s1", config({ maxRequestsPerMinute: 10 }), llm);

    const p1 = handler(params({ messages: [{ role: "user", content: "a" }] }));
    const p2 = handler(params({ messages: [{ role: "user", content: "b" }] }));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect((r1.content as { text: string }).text).toBe("echo:a");
    expect((r2.content as { text: string }).text).toBe("echo:b");
  });

  it("LLM 抛错时信息脱敏并返回 InternalError", async () => {
    const llm = async () => {
      throw new Error("provider rejected key sk-abcdefghijklmnop");
    };
    const { handler, getMetrics } = createSamplingHandler("s1", config(), llm);
    await expect(handler(params())).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.not.stringContaining("sk-abcdefghijklmnop"),
    });
    expect(getMetrics().errors).toBe(1);
  });
});

describe("sanitizeSamplingError", () => {
  it("脱敏 Bearer 与 api key 形态", () => {
    expect(sanitizeSamplingError("Authorization: Bearer abc.def.ghi")).toContain("Bearer ***");
    expect(sanitizeSamplingError("bad key sk-1234567890abcdef")).not.toContain("sk-1234567890abcdef");
  });
});
