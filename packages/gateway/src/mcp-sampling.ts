/**
 * MCP Sampling 护栏（P6，对标 hermes-agent tools/mcp_tool_sampling.py）。
 *
 * 远端 MCP server 可以请求本客户端代为调用 LLM（sampling/createMessage）。
 * 这是一个新的信任边界，因此默认关闭，且开启后仍受以下限制：
 *   - 滑动窗口限流（默认 10 次/分钟/服务器）
 *   - 模型 allowlist（config.model 覆盖 > server hints）
 *   - max_tokens 客户端硬上限（默认 4096）
 *   - 单次调用超时（默认 30s，超时 abort）
 *   - 连续 tool-use 响应轮次上限（默认 5，0 表示禁止）
 *   - 默认不广告 sampling.tools 子能力（exposeClientTools=false）
 *   - 失败返回明确 MCP 错误，绝不静默空回复
 */

import {
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

// ─── 配置与 LLM 契约 ───────────────────────────────────────

export interface McpSamplingConfig {
  /** 必须显式为 true 才启用（默认关闭） */
  enabled: boolean;
  /** 强制使用的模型（优先于 server hint） */
  model?: string;
  /** 允许的模型名；非空时不在列表内的请求被拒绝 */
  allowedModels?: string[];
  /** max_tokens 硬上限（默认 4096，客户端永远不信任 server 的请求值） */
  maxTokensCap?: number;
  /** 每 60 秒窗口最大请求数（默认 10） */
  maxRequestsPerMinute?: number;
  /** 单次 LLM 调用超时（默认 30000ms） */
  timeoutMs?: number;
  /** 连续 tool-use 响应上限（默认 5；0 禁止工具） */
  maxToolRounds?: number;
  /** 是否声明/转发 sampling.tools（默认 false） */
  exposeClientTools?: boolean;
}

export interface SamplingToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface SamplingLlmRequest {
  model?: string;
  systemPrompt?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  temperature?: number;
  stopSequences?: string[];
  tools?: SamplingToolDefinition[];
  signal?: AbortSignal;
}

export interface SamplingLlmToolCall {
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

export interface SamplingLlmResult {
  model: string;
  text?: string;
  toolCalls?: SamplingLlmToolCall[];
  stopReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/** 由应用注入的 LLM 回调（网关不直接依赖 agent 包的具体实现） */
export type SamplingLlm = (req: SamplingLlmRequest) => Promise<SamplingLlmResult>;

export interface SamplingMetrics {
  requests: number;
  errors: number;
  tokensUsed: number;
  toolUseCount: number;
}

/** createMessage 请求参数的结构子集（避免把 SDK 内部类型泄漏到调用方） */
export interface SamplingParamsLike {
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  modelPreferences?: { hints?: Array<{ name?: string }> };
  systemPrompt?: string;
  maxTokens: number;
  temperature?: number;
  stopSequences?: string[];
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}

/** 内容块 → 纯文本（我们的辅助 LLM 通道只接受文本） */
function contentBlocksToText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  const parts: string[] = [];
  for (const raw of blocks) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw === "string") {
      parts.push(raw);
      continue;
    }
    const block = raw as Record<string, unknown>;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") parts.push(block.text);
        break;
      case "image":
        parts.push(`[image omitted: ${String(block.mimeType ?? "unknown")}]`);
        break;
      case "audio":
        parts.push(`[audio omitted: ${String(block.mimeType ?? "unknown")}]`);
        break;
      case "tool_use":
        parts.push(`[tool_use ${String(block.name ?? "")}: ${JSON.stringify(block.input ?? {})}]`);
        break;
      case "tool_result":
        parts.push(`[tool_result: ${contentBlocksToText(block.content)}]`);
        break;
      default:
        parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n");
}

/** 错误信息脱敏：不把疑似 token 回传给远端 server */
export function sanitizeSamplingError(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/\b(sk|pk|api|key)[-_][A-Za-z0-9_-]{8,}\b/gi, "$1-***");
}

/**
 * 单个 MCP server 的 sampling handler 工厂。
 * 每个 transport 持有自己的实例（独立限流窗口与 tool 轮次计数）。
 */
export function createSamplingHandler(
  serverName: string,
  config: McpSamplingConfig,
  llm: SamplingLlm,
): {
  handler: (params: SamplingParamsLike) => Promise<Record<string, unknown>>;
  getMetrics: () => SamplingMetrics;
} {
  const maxTokensCap = Math.max(1, config.maxTokensCap ?? 4096);
  const maxPerMinute = Math.max(0, config.maxRequestsPerMinute ?? 10);
  const timeoutMs = Math.max(1, config.timeoutMs ?? 30_000);
  const maxToolRounds = Math.max(0, config.maxToolRounds ?? 5);
  const allowedModels = config.allowedModels ?? [];

  const metrics: SamplingMetrics = { requests: 0, errors: 0, tokensUsed: 0, toolUseCount: 0 };
  /** 滑动窗口时间戳（ms） */
  let rateWindow: number[] = [];
  let toolLoopCount = 0;

  const fail = (message: string, code: number = ErrorCode.InternalError): never => {
    metrics.errors++;
    throw new McpError(code, `[MCP sampling:${serverName}] ${message}`);
  };

  const checkRateLimit = (now: number): void => {
    rateWindow = rateWindow.filter((t) => t > now - 60_000);
    if (rateWindow.length >= maxPerMinute) {
      fail(`rate limit exceeded (${maxPerMinute}/min)`, ErrorCode.InvalidRequest);
    }
    rateWindow.push(now);
  };

  const resolveModel = (params: SamplingParamsLike): string | undefined => {
    if (config.model) return config.model;
    const hints = params.modelPreferences?.hints ?? [];
    return hints.find((h) => typeof h?.name === "string" && h.name.length > 0)?.name;
  };

  const handler = async (params: SamplingParamsLike): Promise<Record<string, unknown>> => {
    checkRateLimit(Date.now());

    const model = resolveModel(params);
    if (allowedModels.length > 0 && model && !allowedModels.includes(model)) {
      fail(
        `model "${model}" not allowed (allowed: ${allowedModels.join(", ")})`,
        ErrorCode.InvalidRequest,
      );
    }

    const requestedTools = params.tools ?? [];
    if (requestedTools.length > 0 && !config.exposeClientTools) {
      fail("sampling tools are not enabled for this server", ErrorCode.InvalidRequest);
    }

    const maxTokens = Math.min(
      Math.max(1, Number.isFinite(params.maxTokens) ? params.maxTokens : maxTokensCap),
      maxTokensCap,
    );

    const messages = params.messages.map((m) => ({
      role: m.role,
      content: contentBlocksToText(m.content),
    }));
    const tools: SamplingToolDefinition[] | undefined = requestedTools.length > 0
      ? requestedTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: (t.inputSchema as Record<string, unknown> | undefined) ?? { type: "object", properties: {} },
        }))
      : undefined;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // 先以 RequestTimeout 结束 race，再 abort LLM —— 否则 LLM 的 abort
        // 错误可能先到，被包装成 InternalError，丢失超时语义。
        reject(new McpError(
          ErrorCode.RequestTimeout,
          `[MCP sampling:${serverName}] LLM call timed out after ${timeoutMs}ms`,
        ));
        controller.abort();
      }, timeoutMs);
      timer.unref?.();
    });

    let result: SamplingLlmResult;
    try {
      result = await Promise.race([
        llm({
          model,
          systemPrompt: params.systemPrompt,
          messages,
          maxTokens,
          temperature: params.temperature,
          stopSequences: params.stopSequences,
          tools,
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
    } catch (err) {
      metrics.errors++;
      if (err instanceof McpError) throw err;
      const message = sanitizeSamplingError(err instanceof Error ? err.message : String(err));
      throw new McpError(
        ErrorCode.InternalError,
        `[MCP sampling:${serverName}] LLM call failed: ${message}`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    const toolCalls = result.toolCalls ?? [];
    const text = result.text ?? "";
    if (toolCalls.length === 0 && text.length === 0) {
      fail("LLM returned an empty response");
    }

    metrics.requests++;
    metrics.tokensUsed += result.usage?.totalTokens ?? 0;

    if (toolCalls.length > 0) {
      metrics.toolUseCount++;
      toolLoopCount++;
      if (maxToolRounds === 0) {
        toolLoopCount = 0;
        fail("tool loops are disabled for this server (maxToolRounds=0)");
      }
      if (toolLoopCount > maxToolRounds) {
        toolLoopCount = 0;
        fail(`tool loop limit exceeded (max ${maxToolRounds} rounds)`);
      }
      return {
        role: "assistant",
        model: result.model,
        stopReason: "toolUse",
        content: toolCalls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: typeof call.arguments === "string"
            ? safeJsonParse(call.arguments)
            : call.arguments,
        })),
      };
    }

    // 文本响应重置连续 tool-use 计数
    toolLoopCount = 0;
    // 文本响应使用单 content（CreateMessageResultSchema 的向后兼容形态）；
    // 工具响应才用数组（CreateMessageResultWithTools）。
    return {
      role: "assistant",
      model: result.model,
      stopReason: result.stopReason ?? "endTurn",
      content: { type: "text", text },
    };
  };

  return { handler, getMetrics: () => ({ ...metrics }) };
}

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}
