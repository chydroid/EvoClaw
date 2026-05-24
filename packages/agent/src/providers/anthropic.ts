/**
 * Anthropic Provider — native implementation of the ProviderPlugin interface
 * for Anthropic's Messages API (Claude 4 Sonnet, Claude Opus 4, etc.).
 *
 * Unlike OpenAI, Anthropic uses:
 *  - x-api-key header (not Bearer)
 *  - Anthropic-Version header
 *  - Different message format (system top-level, content blocks)
 *  - Different tool format (input_schema instead of parameters)
 *  - Different streaming format (SSE with different event types)
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
} from "@evoclaw/plugin-sdk";

// ── Known Models ──────────────────────────────────────────

const ANTHROPIC_MODELS: ModelInfo[] = [
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    provider: "anthropic",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 200000,
    maxOutputTokens: 64000,
    costInputPerMillion: 3.00,
    costOutputPerMillion: 15.00,
  },
  {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    provider: "anthropic",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 200000,
    maxOutputTokens: 32000,
    costInputPerMillion: 15.00,
    costOutputPerMillion: 75.00,
  },
  {
    id: "claude-3.5-sonnet",
    name: "Claude 3.5 Sonnet",
    provider: "anthropic",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 200000,
    maxOutputTokens: 8192,
    costInputPerMillion: 3.00,
    costOutputPerMillion: 15.00,
  },
  {
    id: "claude-3.5-haiku",
    name: "Claude 3.5 Haiku",
    provider: "anthropic",
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 200000,
    maxOutputTokens: 8192,
    costInputPerMillion: 0.80,
    costOutputPerMillion: 4.00,
  },
];

// ── Provider Implementation ───────────────────────────────

export class AnthropicProvider implements ProviderPlugin {
  readonly provider = "anthropic";

  private config: ProviderConfig = {};
  private logger: PluginLogger = console as unknown as PluginLogger;
  private baseURL = "https://api.anthropic.com";
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
    this.baseURL = config.baseURL || "https://api.anthropic.com";
    this.baseURL = this.baseURL.replace(/\/+$/, "");
  }

  async listModels(): Promise<ModelInfo[]> {
    return [...ANTHROPIC_MODELS];
  }

  async hasModel(modelId: string): Promise<boolean> {
    return ANTHROPIC_MODELS.some((m) => m.id === modelId);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const startTime = Date.now();
    const body = this.buildRequestBody(request, false);

    this.logger.info(`[Anthropic] → ${request.model} (${request.messages.length} msgs)`);

    const response = await this.fetchWithRetry(`${this.baseURL}/v1/messages`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout ?? 60_000),
    });

    const data = await response.json() as AnthropicResponse;

    return this.parseResponse(data, request.model, startTime);
  }

  async streamComplete(
    request: ModelRequest,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<ModelResponse> {
    const startTime = Date.now();
    const url = `${this.baseURL}/v1/messages`;

    const body = this.buildRequestBody(request, true);

    this.logger.info(`[Anthropic] → ${request.model} (stream, ${request.messages.length} msgs)`);

    const response = await this.fetchWithRetry(url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout ?? 120_000),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Anthropic stream failed: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalContent = "";
    let finishReason = "stop";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);

          try {
            const event = JSON.parse(data) as AnthropicStreamEvent;

            switch (event.type) {
              case "content_block_delta":
                if (event.delta?.type === "text_delta" && event.delta.text) {
                  finalContent += event.delta.text;
                  onChunk({ text: event.delta.text });
                }
                break;

              case "message_delta":
                if (event.delta?.stop_reason) {
                  finishReason = this.mapStopReason(event.delta.stop_reason);
                  onChunk({ finishReason });
                }
                if (event.usage) {
                  outputTokens = event.usage.output_tokens ?? 0;
                }
                break;

              case "message_start":
                if (event.message?.usage?.input_tokens) {
                  inputTokens = event.message.usage.input_tokens;
                }
                break;
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const totalTokens = inputTokens + outputTokens;
    this.recordUsage(totalTokens, request.model);

    return {
      id: `msg_${Date.now()}`,
      model: request.model,
      content: finalContent,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens,
      },
      finishReason: finishReason as ModelResponse["finishReason"],
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (!this.config.apiKey) {
      return { healthy: false, message: "No API key configured" };
    }
    try {
      const res = await fetch(`${this.baseURL}/v1/messages`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      // 200 = healthy; 401/403 = auth issue (still reachable)
      return { healthy: res.ok || res.status === 401 || res.status === 403 };
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
      "x-api-key": this.config.apiKey ?? "",
      "anthropic-version": "2023-06-01",
      ...(this.config.headers ?? {}),
    };
  }

  private buildRequestBody(
    request: ModelRequest,
    stream: boolean
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 4096,
      stream,
    };

    // Anthropic handles system separately from messages
    const systemMessages: string[] = [];
    const contentMessages: Record<string, unknown>[] = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : msg.content?.map((c: { type: string; text?: string }) => c.text ?? "").join("") ?? "";
        systemMessages.push(text);
      } else {
        contentMessages.push(this.convertMessage(msg));
      }
    }

    // Add request-level system prompt
    if (request.system) {
      systemMessages.push(request.system);
    }

    if (systemMessages.length > 0) {
      body.system = systemMessages.join("\n\n");
    }

    body.messages = contentMessages;

    // Convert tools to Anthropic format
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    if (request.stop) {
      body.stop_sequences = request.stop;
    }

    return body;
  }

  private convertMessage(msg: ChatMessage): Record<string, unknown> {
    const out: Record<string, unknown> = { role: msg.role };

    if (msg.role === "assistant" && msg.toolCalls) {
      // Anthropic tool_use blocks
      const content: Record<string, unknown>[] = [];
      if (typeof msg.content === "string" && msg.content.trim()) {
        content.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: (() => {
            try {
              return JSON.parse(tc.function.arguments);
            } catch {
              return {};
            }
          })(),
        });
      }
      out.content = content;
    } else if (msg.role === "tool" && msg.toolCallId) {
      out.content = [
        {
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        },
      ];
    } else if (typeof msg.content === "string") {
      out.content = msg.content;
    } else if (Array.isArray(msg.content)) {
      const content: Record<string, unknown>[] = [];
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "image_url" && part.image_url?.url) {
          content.push({
            type: "image",
            source: {
              type: "url",
              url: part.image_url.url,
            },
          });
        }
      }
      out.content = content;
    }

    return out;
  }

  private parseResponse(
    data: AnthropicResponse,
    model: string,
    startTime: number
  ): ModelResponse {
    let content = "";
    const toolCalls: ModelResponse["toolCalls"] = [];

    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === "text" && block.text) {
          content += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id ?? `call_${Date.now()}`,
            type: "function" as const,
            function: {
              name: block.name ?? "",
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
    }

    const tokens =
      (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);
    this.recordUsage(tokens, model);

    return {
      id: data.id ?? `msg_${Date.now()}`,
      model,
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: data.usage?.input_tokens ?? 0,
        completionTokens: data.usage?.output_tokens ?? 0,
        totalTokens: tokens,
      },
      finishReason: toolCalls.length > 0
        ? "tool_calls"
        : this.mapStopReason(data.stop_reason ?? "end_turn"),
    };
  }

  private mapStopReason(reason: string): ModelResponse["finishReason"] {
    switch (reason) {
      case "end_turn": return "stop";
      case "max_tokens": return "length";
      case "stop_sequence": return "stop";
      case "tool_use": return "tool_calls";
      default: return "stop";
    }
  }

  private recordUsage(tokens: number, model: string): void {
    this.totalTokens += tokens;
    this.requestCount++;
    const info = ANTHROPIC_MODELS.find((m) => m.id === model);
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

interface AnthropicResponse {
  id?: string;
  type?: string;
  role?: string;
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  stop_reason?: string;
  stop_sequence?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface AnthropicStreamEvent {
  type: string;
  delta?: {
    type?: string;
    text?: string;
    stop_reason?: string;
  };
  message?: {
    usage?: { input_tokens?: number };
  };
  usage?: {
    output_tokens?: number;
  };
}