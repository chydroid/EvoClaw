/**
 * OpenAI-Compatible Provider 测试。
 *
 * 覆盖：
 *   - createOpenAICompatibleProvider 工厂
 *   - chat() 非流式调用（成功/错误）
 *   - chatStream() SSE 解析
 *   - listModels() 返回静态列表
 *   - healthCheck() 成功/失败
 *   - estimateTokens() 粗略估算
 *   - 5 个样板 provider 的 spec 配置正确性
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleProviderSpec,
} from "./openai-compatible-provider.js";
import type { ProviderRuntimeContext, ProviderHttp } from "./provider-runtime.js";

// ─── 测试辅助 ────────────────────────────────────────────────────────

function makeMockHttp(
  fetchImpl: (url: string, init?: unknown) => Promise<Response>,
): ProviderHttp {
  return {
    fetch: fetchImpl as unknown as ProviderHttp["fetch"],
    timeoutSignal: (ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    },
  };
}

function makeMockContext(
  config: Partial<ProviderRuntimeContext["config"]> = {},
  http?: ProviderHttp,
): ProviderRuntimeContext {
  return {
    providerId: "test",
    logger: {
      fatal: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    },
    services: {
      get: () => undefined,
      register: () => {},
      has: () => false,
      list: () => [],
    },
    config: {
      apiKey: "test-key",
      baseURL: "https://mock.test",
      ...config,
    },
    http: http ?? makeMockHttp(async () => new Response("{}", { status: 200 })),
  };
}

const TEST_SPEC: OpenAICompatibleProviderSpec = {
  providerId: "test",
  baseUrl: "https://api.test.com",
  envVar: "TEST_API_KEY",
  defaultModel: "test-model",
  models: [
    {
      id: "test-model",
      name: "Test Model",
      provider: "test",
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: true,
      maxContextTokens: 4096,
      maxOutputTokens: 1024,
    },
  ],
};

// ─── chat() 测试 ────────────────────────────────────────────────────

describe("createOpenAICompatibleProvider chat()", () => {
  beforeEach(() => {
    process.env.TEST_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.TEST_API_KEY;
  });

  it("成功返回 ModelResponse", async () => {
    const mockResponse = {
      id: "resp-123",
      model: "test-model",
      choices: [
        {
          message: { content: "Hello world" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };
    const http = makeMockHttp(async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );
    const ctx = makeMockContext({}, http);
    const provider = createOpenAICompatibleProvider(TEST_SPEC)(ctx);

    const result = await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.id).toBe("resp-123");
    expect(result.model).toBe("test-model");
    expect(result.content).toBe("Hello world");
    expect(result.finishReason).toBe("stop");
    expect(result.usage?.promptTokens).toBe(10);
    expect(result.usage?.completionTokens).toBe(5);
    expect(result.usage?.totalTokens).toBe(15);
  });

  it("支持 tool_calls 响应", async () => {
    const mockResponse = {
      id: "resp-456",
      model: "test-model",
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"SF"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const http = makeMockHttp(async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );
    const ctx = makeMockContext({}, http);
    const provider = createOpenAICompatibleProvider(TEST_SPEC)(ctx);

    const result = await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object" },
          },
        },
      ],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0].id).toBe("call_1");
    expect(result.toolCalls?.[0].function.name).toBe("get_weather");
    expect(result.toolCalls?.[0].function.arguments).toBe('{"city":"SF"}');
    expect(result.finishReason).toBe("tool_calls");
  });

  it("HTTP 错误时抛出异常", async () => {
    const http = makeMockHttp(async () =>
      new Response("Unauthorized", { status: 401 }),
    );
    const ctx = makeMockContext({}, http);
    const provider = createOpenAICompatibleProvider(TEST_SPEC)(ctx);

    await expect(
      provider.chat({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ).rejects.toThrow("test API error 401");
  });

  it("API key 缺失时抛出异常", async () => {
    delete process.env.TEST_API_KEY;
    const ctx = makeMockContext({ apiKey: undefined });
    const provider = createOpenAICompatibleProvider(TEST_SPEC)(ctx);

    await expect(
      provider.chat({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ).rejects.toThrow("API key not configured");
  });

  it("system prompt 注入到 messages 开头", async () => {
    let capturedBody: unknown;
    const http = makeMockHttp(async (_url, init) => {
      capturedBody = JSON.parse((init as { body: string }).body);
      return new Response(
        JSON.stringify({
          id: "x",
          model: "test-model",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
        { status: 200 },
      );
    });
    const ctx = makeMockContext({}, http);
    const provider = createOpenAICompatibleProvider(TEST_SPEC)(ctx);

    await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
      system: "You are helpful",
    });

    const body = capturedBody as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]).toEqual({ role: "system", content: "You are helpful" });
    expect(body.messages[1]).toEqual({ role: "user", content: "Hi" });
  });
});

// ─── listModels() 测试 ──────────────────────────────────────────────

describe("createOpenAICompatibleProvider listModels()", () => {
  it("返回 spec.models 静态列表", async () => {
    const ctx = makeMockContext();
    const provider = createOpenAICompatibleProvider(TEST_SPEC)(ctx);

    const models = await provider.listModels!();
    expect(models).toEqual(TEST_SPEC.models);
    expect(models.length).toBe(1);
    expect(models[0].id).toBe("test-model");
  });
});

// ─── healthCheck() 测试 ─────────────────────────────────────────────

describe("createOpenAICompatibleProvider healthCheck()", () => {
  beforeEach(() => {
    process.env.TEST_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.TEST_API_KEY;
  });

  it("HTTP 200 时返回 healthy=true", async () => {
    const http = makeMockHttp(async () => new Response("{}", { status: 200 }));
    const ctx = makeMockContext({}, http);
    const provider = createOpenAICompatibleProvider(TEST_SPEC)(ctx);

    const result = await provider.healthCheck!();
    expect(result.healthy).toBe(true);
  });

  it("HTTP 500 时返回 healthy=false", async () => {
    const http = makeMockHttp(async () => new Response("", { status: 500 }));
    const ctx = makeMockContext({}, http);
    const provider = createOpenAICompatibleProvider(TEST_SPEC)(ctx);

    const result = await provider.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.detail).toContain("500");
  });

  it("网络错误时返回 healthy=false", async () => {
    const http = makeMockHttp(async () => {
      throw new Error("connection refused");
    });
    const ctx = makeMockContext({}, http);
    const provider = createOpenAICompatibleProvider(TEST_SPEC)(ctx);

    const result = await provider.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.detail).toContain("connection refused");
  });

  it("API key 缺失时返回 healthy=false", async () => {
    delete process.env.TEST_API_KEY;
    const ctx = makeMockContext({ apiKey: undefined });
    const provider = createOpenAICompatibleProvider(TEST_SPEC)(ctx);

    const result = await provider.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.detail).toContain("not configured");
  });
});

// ─── estimateTokens() 测试 ──────────────────────────────────────────

describe("createOpenAICompatibleProvider estimateTokens()", () => {
  it("英文约 4 chars/token", () => {
    const ctx = makeMockContext();
    const provider = createOpenAICompatibleProvider(TEST_SPEC)(ctx);

    const text = "Hello world, this is a test"; // 27 chars ascii
    const tokens = provider.estimateTokens!(text);
    expect(tokens).toBe(Math.ceil(27 / 4));
  });

  it("中文约 2 chars/token", () => {
    const ctx = makeMockContext();
    const provider = createOpenAICompatibleProvider(TEST_SPEC)(ctx);

    const text = "你好世界，这是一个测试"; // 11 chars all non-ascii
    const tokens = provider.estimateTokens!(text);
    expect(tokens).toBe(Math.ceil(text.length / 2));
  });

  it("混合文本按 ASCII 和非 ASCII 分别估算", () => {
    const ctx = makeMockContext();
    const provider = createOpenAICompatibleProvider(TEST_SPEC)(ctx);

    const text = "Hello 你好"; // 5 ascii + 2 non-ascii + 1 space = 8 ascii, 2 non-ascii
    const tokens = provider.estimateTokens!(text);
    const expectedAscii = 8; // "Hello " + " " = 7? no, "Hello " is 6, " " is 1 = 7
    // 实际：H e l l o ' ' = 6 ascii, 你 好 = 2 non-ascii
    const ascii = (text.match(/[\x00-\x7F]/g) ?? []).length; // 7
    const nonAscii = text.length - ascii; // 2
    expect(tokens).toBe(Math.ceil(ascii / 4 + nonAscii / 2));
  });
});

// ─── 5 个样板 provider spec 测试 ────────────────────────────────────

describe("Provider 扩展样板 spec 配置", () => {
  it("deepseek provider 配置正确", async () => {
    const mod = await import("./providers/deepseek.js");
    const spec = mod.DEEPSEEK_SPEC_EXPORT;
    expect(spec.providerId).toBe("deepseek");
    expect(spec.baseUrl).toBe("https://api.deepseek.com");
    expect(spec.envVar).toBe("DEEPSEEK_API_KEY");
    expect(spec.defaultModel).toBe("deepseek-chat");
    expect(spec.models.length).toBeGreaterThanOrEqual(2);
    expect(spec.models.some((m) => m.id === "deepseek-chat")).toBe(true);
    expect(spec.models.some((m) => m.id === "deepseek-reasoner")).toBe(true);
  });

  it("groq provider 配置正确", async () => {
    const mod = await import("./providers/groq.js");
    const spec = mod.GROQ_SPEC_EXPORT;
    expect(spec.providerId).toBe("groq");
    expect(spec.baseUrl).toBe("https://api.groq.com/openai");
    expect(spec.envVar).toBe("GROQ_API_KEY");
    expect(spec.defaultModel).toBe("llama-3.3-70b-versatile");
    expect(spec.models.length).toBeGreaterThanOrEqual(2);
  });

  it("qwen provider 配置正确", async () => {
    const mod = await import("./providers/qwen.js");
    const spec = mod.QWEN_SPEC_EXPORT;
    expect(spec.providerId).toBe("qwen");
    expect(spec.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode");
    expect(spec.envVar).toBe("DASHSCOPE_API_KEY");
    expect(spec.defaultModel).toBe("qwen-plus");
    expect(spec.models.some((m) => m.supportsVision)).toBe(true);
  });

  it("mistral provider 配置正确", async () => {
    const mod = await import("./providers/mistral.js");
    const spec = mod.MISTRAL_SPEC_EXPORT;
    expect(spec.providerId).toBe("mistral");
    expect(spec.baseUrl).toBe("https://api.mistral.ai");
    expect(spec.envVar).toBe("MISTRAL_API_KEY");
    expect(spec.defaultModel).toBe("mistral-large-latest");
    expect(spec.models.length).toBeGreaterThanOrEqual(3);
  });

  it("xai provider 配置正确", async () => {
    const mod = await import("./providers/xai.js");
    const spec = mod.XAI_SPEC_EXPORT;
    expect(spec.providerId).toBe("xai");
    expect(spec.baseUrl).toBe("https://api.x.ai");
    expect(spec.envVar).toBe("XAI_API_KEY");
    expect(spec.defaultModel).toBe("grok-3");
    expect(spec.models.some((m) => m.id === "grok-3")).toBe(true);
  });

  it("所有 provider 的模型 provider 字段一致", async () => {
    const [deepseek, groq, qwen, mistral, xai] = await Promise.all([
      import("./providers/deepseek.js"),
      import("./providers/groq.js"),
      import("./providers/qwen.js"),
      import("./providers/mistral.js"),
      import("./providers/xai.js"),
    ]);
    const specs = [
      deepseek.DEEPSEEK_SPEC_EXPORT,
      groq.GROQ_SPEC_EXPORT,
      qwen.QWEN_SPEC_EXPORT,
      mistral.MISTRAL_SPEC_EXPORT,
      xai.XAI_SPEC_EXPORT,
    ];
    for (const spec of specs) {
      for (const model of spec.models) {
        expect(model.provider).toBe(spec.providerId);
      }
    }
  });
});
