/**
 * Google Provider — native implementation of the ProviderPlugin interface
 * for Google's Gemini API (Gemini 2.5 Pro, Gemini 2.5 Flash, etc.).
 *
 * Google Gemini uses:
 *  - REST API at generativelanguage.googleapis.com
 *  - API key as query parameter or Bearer token
 *  - contents/parts format instead of messages
 *  - Different system instruction handling
 *  - Function declarations in tools.functionDeclarations
 *  - SSE streaming with different chunk format
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
  ToolCall,
} from "@evoclaw/plugin-sdk";
import type { CredentialPool } from "../credential-pool.js";
import { parseMimeTypeFromDataUri } from "../llm-caller.js";

// ── Known Models ──────────────────────────────────────────

const GEMINI_MODELS: ModelInfo[] = [
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "google",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 1048576,
    maxOutputTokens: 65536,
    costInputPerMillion: 1.25,
    costOutputPerMillion: 10.00,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 1048576,
    maxOutputTokens: 65536,
    costInputPerMillion: 0.15,
    costOutputPerMillion: 0.60,
  },
  {
    id: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    provider: "google",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 1048576,
    maxOutputTokens: 8192,
    costInputPerMillion: 0.10,
    costOutputPerMillion: 0.40,
  },
  {
    id: "gemini-2.0-flash-lite",
    name: "Gemini 2.0 Flash Lite",
    provider: "google",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    maxContextTokens: 1048576,
    maxOutputTokens: 8192,
    costInputPerMillion: 0.075,
    costOutputPerMillion: 0.30,
  },
];

// ── Provider Implementation ───────────────────────────────

export class GoogleProvider implements ProviderPlugin {
  readonly provider = "google";

  private config: ProviderConfig = {};
  private logger: PluginLogger = console as unknown as PluginLogger;
  private credentialPool: CredentialPool | undefined;
  private baseURL = "https://generativelanguage.googleapis.com";
  private totalTokens = 0;
  private totalCost = 0;
  private requestCount = 0;

  async init(
    config: ProviderConfig,
    logger: PluginLogger,
    services: ServiceLocator
  ): Promise<void> {
    this.config = config;
    this.logger = logger;
    this.baseURL = config.baseURL || "https://generativelanguage.googleapis.com";
    this.baseURL = this.baseURL.replace(/\/+$/, "");
    this.credentialPool = services.get<CredentialPool>("credentialPool");
  }

  async listModels(): Promise<ModelInfo[]> {
    // If API key is available, try to fetch the live model list
    const apiKey = this.resolveApiKey();
    if (apiKey) {
      try {
        const url = `${this.baseURL}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
        const res = await fetch(url, {
          headers: this.config.headers ?? {},
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const data = (await res.json()) as { models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> };
          if (data.models) {
            const remoteModels: ModelInfo[] = [];
            for (const m of data.models) {
              if (m.supportedGenerationMethods?.includes("generateContent")) {
                const id = m.name.replace("models/", "");
                const known = GEMINI_MODELS.find((k) => k.id === id);
                remoteModels.push(known ?? {
                  id,
                  name: m.displayName ?? id,
                  provider: "google",
                  supportsVision: false,
                  supportsStreaming: true,
                  supportsTools: false,
                  maxContextTokens: 1048576,
                  maxOutputTokens: 8192,
                });
              }
            }
            if (remoteModels.length > 0) return remoteModels;
          }
        }
      } catch {
        this.logger.warn("[Google] Failed to fetch remote models, using built-in catalog");
      }
    }
    return [...GEMINI_MODELS];
  }

  async hasModel(modelId: string): Promise<boolean> {
    const builtIn = GEMINI_MODELS.some((m) => m.id === modelId);
    if (builtIn) return true;

    const apiKey = this.resolveApiKey();
    if (apiKey) {
      try {
        const url = `${this.baseURL}/v1beta/models/${modelId}?key=${encodeURIComponent(apiKey)}`;
        const res = await fetch(url, {
          headers: this.config.headers ?? {},
          signal: AbortSignal.timeout(5000),
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

    const body = this.buildRequestBody(request);

    this.logger.info(`[Google] → ${request.model} (${request.messages.length} msgs)`);

    const maxKeyRetries = this.credentialPool ? 3 : 0;
    let lastKey = this.resolveApiKey();

    for (let keyAttempt = 0; keyAttempt <= maxKeyRetries; keyAttempt++) {
      const url = this.buildURL(request.model, false, lastKey);
      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeout ?? 60_000),
      });

      if (response.status === 429 && this.credentialPool && keyAttempt < maxKeyRetries) {
        this.credentialPool.reportRateLimit(this.provider, lastKey);
        this.logger.warn(`[Google] 429 rate limit on key, rotating (attempt ${keyAttempt + 1})`);
        const nextKey = this.credentialPool.getNextKey(this.provider);
        if (nextKey && nextKey !== lastKey) {
          lastKey = nextKey;
          continue;
        }
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as GeminiResponse;
      return this.parseResponse(data, request.model, startTime);
    }

    throw new Error("All key rotation attempts exhausted");
  }

  async streamComplete(
    request: ModelRequest,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<ModelResponse> {
    const startTime = Date.now();

    const body = this.buildRequestBody(request);

    this.logger.info(`[Google] → ${request.model} (stream, ${request.messages.length} msgs)`);

    const maxKeyRetries = this.credentialPool ? 3 : 0;
    let lastKey = this.resolveApiKey();

    for (let keyAttempt = 0; keyAttempt <= maxKeyRetries; keyAttempt++) {
      const url = this.buildURL(request.model, true, lastKey);
      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeout ?? 120_000),
      });

      if (response.status === 429 && this.credentialPool && keyAttempt < maxKeyRetries) {
        this.credentialPool.reportRateLimit(this.provider, lastKey);
        this.logger.warn(`[Google] 429 rate limit on key (stream), rotating (attempt ${keyAttempt + 1})`);
        const nextKey = this.credentialPool.getNextKey(this.provider);
        if (nextKey && nextKey !== lastKey) {
          lastKey = nextKey;
          continue;
        }
      }

      if (!response.ok || !response.body) {
        throw new Error(`Gemini stream failed: HTTP ${response.status}`);
      }

      return this.processStreamResponse(response, request.model, startTime, onChunk);
    }

    throw new Error("All key rotation attempts exhausted (stream)");
  }

  private async processStreamResponse(
    response: Response,
    model: string,
    startTime: number,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<ModelResponse> {

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalContent = "";
    let finishReason = "stop";
    let promptTokens = 0;
    let completionTokens = 0;
    const toolCalls: Partial<ToolCall>[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Gemini SSE uses "data: [...]" format (array of events)
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const dataStr = trimmed.slice(6);

          try {
            const events = JSON.parse(dataStr) as GeminiStreamEvent[];

            for (const event of events) {
              if (event.candidates) {
                for (const candidate of event.candidates) {
                  if (candidate.content?.parts) {
                    for (const part of candidate.content.parts) {
                      if (part.text) {
                        finalContent += part.text;
                        onChunk({ text: part.text });
                      } else if (part.functionCall) {
                        toolCalls.push({
                          id: `call_${Date.now()}_${toolCalls.length}`,
                          type: "function",
                          function: {
                            name: part.functionCall.name,
                            arguments: JSON.stringify(part.functionCall.args ?? {}),
                          },
                        });
                        onChunk({ toolCalls: [...toolCalls] });
                      }
                    }
                  }
                  if (candidate.finishReason) {
                    finishReason = this.mapFinishReason(candidate.finishReason);
                    onChunk({ finishReason });
                  }
                }
              }

              if (event.usageMetadata) {
                promptTokens = event.usageMetadata.promptTokenCount ?? 0;
                completionTokens = event.usageMetadata.candidatesTokenCount ?? 0;
              }
            }
          } catch {
            // Skip malformed SSE chunks
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

    const totalTokens = promptTokens + completionTokens;
    this.recordUsage(totalTokens, model);

    return {
      id: `gemini_${Date.now()}`,
      model,
      content: finalContent,
      toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
      },
      finishReason: finalToolCalls.length > 0 ? "tool_calls" : (finishReason as ModelResponse["finishReason"]),
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      return { healthy: false, message: "No API key configured" };
    }
    try {
      const url = `${this.baseURL}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
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

  /** Resolve the API key: try credential pool first, fall back to config */
  private resolveApiKey(): string {
    if (this.credentialPool) {
      const key = this.credentialPool.getNextKey(this.provider);
      if (key) return key;
    }
    return this.config.apiKey ?? "";
  }

  private buildURL(model: string, stream: boolean, key?: string): string {
    const apiKey = key ?? this.resolveApiKey();
    const params = new URLSearchParams();
    if (apiKey) {
      params.set("key", apiKey);
    }
    if (stream) {
      params.set("alt", "sse");
    }
    return `${this.baseURL}/v1beta/models/${model}:${stream ? "streamGenerateContent" : "generateContent"}?${params.toString()}`;
  }

  private buildRequestBody(request: ModelRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {};

    // Convert messages to Gemini contents format
    const contents: Record<string, unknown>[] = [];
    const systemInstructions: string[] = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        const text = typeof msg.content === "string" ? msg.content : "";
        systemInstructions.push(text);
      } else {
        const content: Record<string, unknown> = {
          role: msg.role === "assistant" ? "model" : "user",
          parts: [],
        };

        if (typeof msg.content === "string") {
          (content.parts as Record<string, unknown>[]).push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === "text" && part.text) {
              (content.parts as Record<string, unknown>[]).push({ text: part.text });
            } else if (part.type === "image_url" && part.image_url?.url) {
              // Parse MIME from data URI; Gemini requires raw base64 (no prefix).
              const url = part.image_url.url;
              const isDataUri = url.startsWith("data:");
              const mimeType = isDataUri
                ? parseMimeTypeFromDataUri(url) || "image/jpeg"
                : "image/jpeg";
              const base64 = isDataUri && url.indexOf("base64,") >= 0
                ? url.slice(url.indexOf("base64,") + 7)
                : url;
              (content.parts as Record<string, unknown>[]).push({
                inlineData: { mimeType, data: base64 },
              });
            } else if (part.type === "input_audio" && part.input_audio?.data) {
              // Gemini supports audio/wav, audio/mp3, audio/aiff, audio/ogg, audio/flac
              (content.parts as Record<string, unknown>[]).push({
                inlineData: {
                  mimeType: `audio/${part.input_audio.format}`,
                  data: part.input_audio.data,
                },
              });
            } else if (part.type === "file" && part.file?.data) {
              // Gemini supports application/pdf via inlineData
              (content.parts as Record<string, unknown>[]).push({
                inlineData: { mimeType: part.file.mimeType, data: part.file.data },
              });
            }
          }
        }

        // Handle tool calls in assistant messages
        if (msg.role === "assistant" && msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            (content.parts as Record<string, unknown>[]).push({
              functionCall: {
                name: tc.function.name,
                args: (() => {
                  try { return JSON.parse(tc.function.arguments); }
                  catch { return {}; }
                })(),
              },
            });
          }
        }

        // Handle tool results
        if (msg.role === "tool" && msg.toolCallId) {
          (content.parts as Record<string, unknown>[]).push({
            functionResponse: {
              name: msg.name ?? "unknown",
              response: {
                content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
              },
            },
          });
        }

        contents.push(content);
      }
    }

    // Add request-level system prompt
    if (request.system) {
      systemInstructions.push(request.system);
    }

    if (systemInstructions.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemInstructions.join("\n\n") }],
      };
    }

    body.contents = contents;

    // Generation config
    body.generationConfig = {
      temperature: request.temperature ?? 0.3,
      maxOutputTokens: request.maxTokens ?? 40960,
    };

    if (request.stop && request.stop.length > 0) {
      (body.generationConfig as Record<string, unknown>).stopSequences = request.stop;
    }

    // Tools (function declarations)
    if (request.tools && request.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          })),
        },
      ];
    }

    return body;
  }

  private parseResponse(
    data: GeminiResponse,
    model: string,
    startTime: number
  ): ModelResponse {
    let content = "";
    const toolCalls: ModelResponse["toolCalls"] = [];

    const candidate = data.candidates?.[0];
    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text) {
          content += part.text;
        } else if (part.functionCall) {
          toolCalls.push({
            id: `call_${Date.now()}_${toolCalls.length}`,
            type: "function",
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            },
          });
        }
      }
    }

    const tokens =
      (data.usageMetadata?.promptTokenCount ?? 0) +
      (data.usageMetadata?.candidatesTokenCount ?? 0);
    this.recordUsage(tokens, model);

    return {
      id: `gemini_${Date.now()}`,
      model,
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens: tokens,
      },
      finishReason: toolCalls.length > 0
        ? "tool_calls"
        : this.mapFinishReason(candidate?.finishReason ?? "STOP"),
    };
  }

  private mapFinishReason(reason: string): ModelResponse["finishReason"] {
    switch (reason) {
      case "STOP": return "stop";
      case "MAX_TOKENS": return "length";
      case "SAFETY": return "content_filter";
      case "RECITATION": return "content_filter";
      // Google API 可能返回 OTHER / FINISH_REASON_UNSPECIFIED 等未知原因，
      // 误映射为 "stop" 会掩盖真实终止原因并误导下游逻辑（如判断是否成功完成）。
      default: return "error";
    }
  }

  private recordUsage(tokens: number, model: string): void {
    this.totalTokens += tokens;
    this.requestCount++;
    const info = GEMINI_MODELS.find((m) => m.id === model);
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

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      role?: string;
      parts?: Array<{
        text?: string;
        functionCall?: {
          name: string;
          args?: Record<string, unknown>;
        };
      }>;
    };
    finishReason?: string;
    safetyRatings?: Array<{ category: string; probability: string }>;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface GeminiStreamEvent {
  candidates?: Array<{
    content?: {
      role?: string;
      parts?: Array<{
        text?: string;
        functionCall?: {
          name: string;
          args?: Record<string, unknown>;
        };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}