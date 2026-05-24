/**
 * OpenAI Provider — native implementation of the ProviderPlugin interface
 * for OpenAI's Chat Completions API (GPT-4o, GPT-4.1, o3, o4-mini, etc.).
 *
 * Supports:
 *  - OpenAI API (api.openai.com)
 *  - Azure OpenAI
 *  - OpenAI-compatible endpoints (vLLM, Ollama, LM Studio, etc.)
 *  - Streaming via SSE
 *  - Tool calling (function calling)
 *  - Vision (image inputs)
 *  - Token usage tracking
 */

import type {
  ProviderPlugin,
  ProviderConfig,
  PluginLogger,
  ServiceLocator,
  ModelInfo,
  ModelRequest,
  ModelResponse,
  StreamChunk,
  ChatMessage,
  ChatContent,
  ToolCall,
} from "@evoclaw/plugin-sdk";

// ── Known Models ──────────────────────────────────────────

const OPENAI_MODELS: ModelInfo[] = [
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 128000,
    maxOutputTokens: 16384,
    costInputPerMillion: 2.50,
    costOutputPerMillion: 10.00,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    provider: "openai",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 128000,
    maxOutputTokens: 16384,
    costInputPerMillion: 0.15,
    costOutputPerMillion: 0.60,
  },
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 1000000,
    maxOutputTokens: 32768,
    costInputPerMillion: 2.00,
    costOutputPerMillion: 8.00,
  },
  {
    id: "gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    provider: "openai",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 1000000,
    maxOutputTokens: 32768,
    costInputPerMillion: 0.40,
    costOutputPerMillion: 1.60,
  },
  {
    id: "gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    provider: "openai",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 1000000,
    maxOutputTokens: 32768,
    costInputPerMillion: 0.10,
    costOutputPerMillion: 0.40,
  },
  {
    id: "o3",
    name: "o3",
    provider: "openai",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 200000,
    maxOutputTokens: 100000,
    costInputPerMillion: 10.00,
    costOutputPerMillion: 40.00,
  },
  {
    id: "o4-mini",
    name: "o4-mini",
    provider: "openai",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 200000,
    maxOutputTokens: 100000,
    costInputPerMillion: 1.10,
    costOutputPerMillion: 4.40,
  },
  {
    id: "gpt-4-turbo",
    name: "GPT-4 Turbo",
    provider: "openai",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
    costInputPerMillion: 10.00,
    costOutputPerMillion: 30.00,
  },
];

// ── Provider Implementation ───────────────────────────────

export class OpenAIProvider implements ProviderPlugin {
  readonly provider = "openai";

  private config: ProviderConfig = {};
  private logger: PluginLogger = console as unknown as PluginLogger;
  private baseURL = "https://api.openai.com";
  private totalTokens = 0;
  private totalCost = 0;
  private requestCount = 0;

  async init(
    config: ProviderConfig,
    logger: PluginLogger,
    _services: ServiceLocator
  ): Promise<void> {
    this.config = config;
    this.logger = logger;
    this.baseURL = config.baseURL || "https://api.openai.com";
    // Strip trailing slashes
    this.baseURL = this.baseURL.replace(/\/+$/, "");
  }

  async listModels(): Promise<ModelInfo[]> {
    // Try to fetch from API if key is available
    if (this.config.apiKey) {
      try {
        const res = await fetch(`${this.baseURL}/v1/models`, {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            ...(this.config.headers ?? {}),
          },
        });
        if (res.ok) {
          const data = (await res.json()) as { data?: Array<{ id: string }> };
          if (data.data) {
            const remoteIds = new Set(data.data.map((m) => m.id));
            // Merge remote IDs with known model metadata
            const remoteModels: ModelInfo[] = [];
            for (const remote of data.data) {
              const known = OPENAI_MODELS.find((m) => m.id === remote.id);
              if (known) {
                remoteModels.push(known);
              } else if (!remote.id.includes("-embedding") && !remote.id.includes("tts-") && !remote.id.includes("whisper-") && !remote.id.includes("dall-e")) {
                remoteModels.push({
                  id: remote.id,
                  name: remote.id,
                  provider: "openai",
                  supportsVision: false,
                  supportsStreaming: true,
                  supportsTools: false,
                  maxContextTokens: 128000,
                  maxOutputTokens: 4096,
                });
              }
            }
            return remoteModels;
          }
        }
      } catch {
        this.logger.warn("[OpenAI] Failed to fetch remote models, using built-in catalog");
      }
    }
    return [...OPENAI_MODELS];
  }

  async hasModel(modelId: string): Promise<boolean> {
    const builtIn = OPENAI_MODELS.some((m) => m.id === modelId);
    if (builtIn) return true;

    // Check remote if available
    if (this.config.apiKey) {
      try {
        const res = await fetch(`${this.baseURL}/v1/models/${modelId}`, {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            ...(this.config.headers ?? {}),
          },
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    return false;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const startTime = Date.now();
    const url = `${this.baseURL}/v1/chat/completions`;

    const body = this.buildRequestBody(request, false);

    const msgCount = request.messages.length;
    this.logger.info(`[OpenAI] → ${request.model} (${msgCount} msgs)`);

    const response = await this.fetchWithRetry(url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout ?? 60_000),
    });

    const data = await response.json() as OpenAIChatResponse;

    return this.parseResponse(data, request.model, startTime);
  }

  async streamComplete(
    request: ModelRequest,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<ModelResponse> {
    const startTime = Date.now();
    const url = `${this.baseURL}/v1/chat/completions`;

    const body = this.buildRequestBody(request, true);

    const msgCountS = request.messages.length;
    this.logger.info(`[OpenAI] → ${request.model} (stream, ${msgCountS} msgs)`);

    const response = await this.fetchWithRetry(url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout ?? 120_000),
    });

    if (!response.ok || !response.body) {
      throw new Error(`OpenAI stream failed: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalContent = "";
    const toolCalls: Partial<ToolCall>[] = [];
    let finishReason = "stop";
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data) as StreamingDelta;

            if (parsed.choices?.[0]?.delta?.content) {
              const text = parsed.choices[0].delta.content;
              finalContent += text;
              onChunk({ text });
            }

            if (parsed.choices?.[0]?.delta?.tool_calls) {
              for (const tc of parsed.choices[0].delta.tool_calls) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = {
                    id: tc.id,
                    type: "function",
                    function: { name: "", arguments: "" },
                  };
                }
                if (tc.function?.name) toolCalls[tc.index].function!.name = tc.function.name;
                if (tc.function?.arguments) toolCalls[tc.index].function!.arguments += tc.function.arguments;
              }
              onChunk({ toolCalls: [...toolCalls] });
            }

            if (parsed.choices?.[0]?.finish_reason) {
              finishReason = parsed.choices[0].finish_reason;
              onChunk({ finishReason });
            }

            if (parsed.usage) {
              usage = {
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                totalTokens: parsed.usage.total_tokens ?? 0,
              };
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const finalToolCalls: ToolCall[] = toolCalls
      .filter((tc): tc is ToolCall & { function: { name: string; arguments: string } } =>
        !!tc?.function?.name
      )
      .map((tc) => ({
        id: tc.id || `call_${Date.now()}`,
        type: "function" as const,
        function: {
          name: tc.function!.name,
          arguments: tc.function!.arguments,
        },
      }));

    this.recordUsage(usage.totalTokens, request.model);

    return {
      id: `chatcmpl_${Date.now()}`,
      model: request.model,
      content: finalContent,
      toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
      usage,
      finishReason: finalToolCalls.length > 0 ? "tool_calls" : (finishReason as ModelResponse["finishReason"]),
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (!this.config.apiKey) {
      return { healthy: false, message: "No API key configured" };
    }
    try {
      const res = await fetch(`${this.baseURL}/v1/models`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return { healthy: res.ok, message: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { healthy: false, message: (err as Error).message };
    }
  }

  async getUsage(): Promise<{ totalTokens: number; totalCost: number; requests: number }> {
    return {
      totalTokens: this.totalTokens,
      totalCost: this.totalCost,
      requests: this.requestCount,
    };
  }

  // ── Internal ────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey ?? ""}`,
      ...(this.config.headers ?? {}),
    };
  }

  private buildRequestBody(
    request: ModelRequest,
    stream: boolean
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => this.convertMessage(m)),
      temperature: request.temperature ?? 0.3,
      max_tokens: request.maxTokens ?? 4096,
      top_p: 1,
      stream,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: t.type,
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
      body.tool_choice = "auto";
    }

    if (request.stop) {
      body.stop = request.stop;
    }

    // For o-series models, temperature must be 1
    if (request.model.startsWith("o3") || request.model.startsWith("o4")) {
      delete body.temperature;
    }

    return body;
  }

  private convertMessage(msg: ChatMessage): Record<string, unknown> {
    const out: Record<string, unknown> = { role: msg.role };

    if (typeof msg.content === "string") {
      out.content = msg.content;
    } else if (Array.isArray(msg.content)) {
      out.content = msg.content.map((part: ChatContent) => {
        if (part.type === "text") {
          return { type: "text", text: part.text ?? "" };
        }
        if (part.type === "image_url") {
          return {
            type: "image_url",
            image_url: {
              url: part.image_url?.url ?? "",
              detail: part.image_url?.detail ?? "auto",
            },
          };
        }
        return part;
      });
    }

    if (msg.name) out.name = msg.name;
    if (msg.toolCallId) out.tool_call_id = msg.toolCallId;
    if (msg.toolCalls) {
      out.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

    return out;
  }

  private parseResponse(
    data: OpenAIChatResponse,
    model: string,
    startTime: number
  ): ModelResponse {
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const finishReason = (choice?.finish_reason ?? "stop") as ModelResponse["finishReason"];

    const tokens = data.usage?.total_tokens ?? 0;
    this.recordUsage(tokens, model);

    return {
      id: data.id ?? `chatcmpl_${Date.now()}`,
      model,
      content: msg?.content ?? "",
      toolCalls: msg?.tool_calls?.map((tc) => ({
        id: tc.id,
        type: tc.type as "function",
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: tokens,
      },
      finishReason,
    };
  }

  private recordUsage(tokens: number, model: string): void {
    this.totalTokens += tokens;
    this.requestCount++;
    const info = OPENAI_MODELS.find((m) => m.id === model);
    if (info) {
      const inputCost = (info.costInputPerMillion ?? 0) / 1_000_000;
      const outputCost = (info.costOutputPerMillion ?? 0) / 1_000_000;
      this.totalCost += tokens * ((inputCost + outputCost) / 2);
    }
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    retries = 2
  ): Promise<Response> {
    const maxRetries = this.config.maxRetries ?? retries;
    let lastError: Error | undefined;

    for (let i = 0; i <= maxRetries; i++) {
      try {
        const response = await fetch(url, init);
        if (response.ok || response.status < 500) return response;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (err) {
        lastError = err as Error;
      }

      if (i < maxRetries) {
        const delay = Math.min(1000 * 2 ** i + Math.random() * 500, 10000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastError ?? new Error("Max retries exceeded");
  }
}

// ── Internal Types ────────────────────────────────────────

interface OpenAIChatResponse {
  id?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface StreamingDelta {
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}