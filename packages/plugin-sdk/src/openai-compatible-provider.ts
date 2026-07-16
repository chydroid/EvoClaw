/**
 * OpenAI-Compatible Provider 基类。
 *
 * 大量 LLM provider（DeepSeek/Groq/Qwen/Mistral/xAI 等）遵循 OpenAI
 * Chat Completions API 协议，仅在 baseURL / 模型列表 / envVar 上有差异。
 *
 * 本模块封装共享逻辑，让具体 provider 扩展样板只需声明差异配置。
 *
 * 对标 OpenClaw 的 buildProviderReplayFamilyHooks("openai-compatible") 模式。
 */
import type {
  ModelInfo,
  ModelRequest,
  ModelResponse,
  ProviderConfig,
  StreamChunk,
  ToolCall,
} from "./provider.js";
import type {
  ProviderHttp,
  ProviderRuntime,
  ProviderRuntimeContext,
} from "./provider-runtime.js";

/** OpenAI-compatible provider 静态配置。 */
export interface OpenAICompatibleProviderSpec {
  /** Provider ID（如 "deepseek"、"groq"） */
  providerId: string;
  /** 默认 baseURL（不带末尾斜杠） */
  baseUrl: string;
  /** 默认 API key 环境变量名（如 "DEEPSEEK_API_KEY"） */
  envVar: string;
  /** 默认模型 ID */
  defaultModel: string;
  /** 模型目录 */
  models: ModelInfo[];
  /** 可选：自定义请求头注入 */
  extraHeaders?: (config: ProviderConfig) => Record<string, string>;
  /** 可选：provider 特有的请求体转换 */
  transformRequest?: (req: ModelRequest) => ModelRequest;
}

/**
 * 创建 OpenAI-compatible provider 运行时。
 *
 * 实现：
 *   - chat(): POST /v1/chat/completions（非流式）
 *   - chatStream(): 同上但 stream=true，SSE 解析
 *   - listModels(): 返回静态 models 列表
 *   - healthCheck(): GET /v1/models（best-effort）
 *
 * 错误处理：
 *   - HTTP 非 2xx：抛出 Error(message)
 *   - 网络错误：抛出原异常
 *   - JSON 解析错误：抛出 Error("invalid response body")
 */
export function createOpenAICompatibleProvider(
  spec: OpenAICompatibleProviderSpec,
): (ctx: ProviderRuntimeContext) => ProviderRuntime {
  return (ctx: ProviderRuntimeContext): ProviderRuntime => {
    const baseUrl = ctx.config.baseURL || spec.baseUrl;
    const apiKey =
      ctx.config.apiKey ||
      process.env[spec.envVar] ||
      "";
    const timeoutMs = ctx.config.timeout ?? 60_000;

    if (!apiKey) {
      ctx.logger.warn(
        `${spec.providerId}: API key not set (env ${spec.envVar}) — provider disabled`,
      );
    }

    const headers = (extra?: Record<string, string>) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(spec.extraHeaders?.(ctx.config) ?? {}),
      ...(extra ?? {}),
    });

    const doRequest = async (
      req: ModelRequest,
      stream: boolean,
    ): Promise<Response> => {
      const finalReq = spec.transformRequest?.(req) ?? req;
      const body = buildRequestBody(spec.providerId, finalReq, stream);
      return ctx.http.fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
        signal: ctx.http.timeoutSignal(timeoutMs),
      });
    };

    const chat = async (req: ModelRequest): Promise<ModelResponse> => {
      if (!apiKey) {
        throw new Error(
          `${spec.providerId}: API key not configured (env ${spec.envVar})`,
        );
      }
      const resp = await doRequest(req, false);
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `${spec.providerId} API error ${resp.status}: ${text.slice(0, 200)}`,
        );
      }
      const data = (await resp.json()) as OpenAIChatResponse;
      return mapResponse(spec.providerId, data);
    };

    const chatStream = async function* (
      req: ModelRequest,
    ): AsyncIterable<StreamChunk> {
      if (!apiKey) {
        throw new Error(
          `${spec.providerId}: API key not configured (env ${spec.envVar})`,
        );
      }
      const resp = await doRequest(req, true);
      if (!resp.ok || !resp.body) {
        const text = resp.body ? await resp.text().catch(() => "") : "";
        throw new Error(
          `${spec.providerId} stream error ${resp.status}: ${text.slice(0, 200)}`,
        );
      }
      yield* parseSSEStream(resp.body);
    };

    const listModels = async (): Promise<ModelInfo[]> => spec.models;

    const healthCheck = async (): Promise<{
      healthy: boolean;
      detail?: string;
    }> => {
      if (!apiKey) {
        return {
          healthy: false,
          detail: `API key not configured (env ${spec.envVar})`,
        };
      }
      try {
        const resp = await ctx.http.fetch(`${baseUrl}/v1/models`, {
          method: "GET",
          headers: headers(),
          signal: ctx.http.timeoutSignal(5_000),
        });
        return {
          healthy: resp.ok,
          detail: resp.ok ? "ok" : `HTTP ${resp.status}`,
        };
      } catch (err) {
        return {
          healthy: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    };

    const estimateTokens = (text: string): number => {
      // 粗略估算：英文 4 chars/token，中文 2 chars/token
      // 对标 OpenClaw 的 simpleTokenEstimator
      const asciiChars = (text.match(/[\x00-\x7F]/g) ?? []).length;
      const nonAsciiChars = text.length - asciiChars;
      return Math.ceil(asciiChars / 4 + nonAsciiChars / 2);
    };

    return {
      chat,
      chatStream,
      listModels,
      healthCheck,
      estimateTokens,
    };
  };
}

// ─── 请求体构建 ─────────────────────────────────────────────────────

interface OpenAIChatRequest {
  model: string;
  messages: Array<{
    role: string;
    content: string | unknown;
  }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string[];
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: unknown };
  }>;
}

function buildRequestBody(
  providerId: string,
  req: ModelRequest,
  stream: boolean,
): OpenAIChatRequest {
  const messages = req.messages.map((m) => {
    const content =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((c) => c.text ?? "").join("")
          : "";
    return { role: m.role, content };
  });

  if (req.system) {
    messages.unshift({ role: "system", content: req.system });
  }

  const body: OpenAIChatRequest = {
    model: req.model,
    messages,
    stream,
  };

  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.stop) body.stop = req.stop;

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));
  }

  return body;
}

// ─── 响应映射 ───────────────────────────────────────────────────────

interface OpenAIChatResponse {
  id: string;
  model: string;
  choices: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function mapResponse(providerId: string, data: OpenAIChatResponse): ModelResponse {
  const choice = data.choices?.[0];
  const message = choice?.message;
  const toolCalls: ToolCall[] | undefined = message?.tool_calls?.map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments,
    },
  }));

  return {
    id: data.id || `${providerId}-${Date.now()}`,
    model: data.model,
    content: message?.content ?? "",
    toolCalls,
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined,
    finishReason: (choice?.finish_reason as ModelResponse["finishReason"]) || "stop",
  };
}

// ─── SSE 解析 ───────────────────────────────────────────────────────

async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以双换行分隔
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        const lines = event.split("\n");
        let data = "";
        for (const line of lines) {
          if (line.startsWith("data:")) {
            data += line.slice(5).trim();
          }
        }
        if (!data) continue;
        if (data === "[DONE]") {
          return;
        }
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  id: string;
                  function: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string;
            }>;
          };
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (delta?.content) {
            yield { text: delta.content };
          }
          if (delta?.tool_calls) {
            yield {
              toolCalls: delta.tool_calls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: {
                  name: tc.function.name ?? "",
                  arguments: tc.function.arguments ?? "",
                },
              })),
            };
          }
          if (choice.finish_reason) {
            yield { finishReason: choice.finish_reason };
          }
        } catch {
          // 跳过无法解析的事件
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
