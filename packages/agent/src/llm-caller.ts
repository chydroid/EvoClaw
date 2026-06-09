/**
 * LLM Caller — extracted from AgentModelExecutor
 *
 * Standalone functions for the core LLM calling loop with provider failover,
 * tool execution, token budget control, plugin hooks, caching, timeout,
 * and observability.
 */

import type { ServiceRegistry, PersonaConfig } from "@evoclaw/core";
import type { Span } from "@opentelemetry/api";
import type { ChatContent } from "@evoclaw/plugin-sdk";
import type { ModelConfig, ProviderConfig, ToolDefinition, AgentProgressCallback } from "./types";
import type { ClassifiedError } from "./error-classifier";
import type { LedgerEntry, LedgerEventType } from "./event-ledger";
import { classifyLLMError, LLMErrorType } from "./error-classifier";
import { taskStatusTracker } from "./task-status-tracker";
import type { ExecutionCheckpointStore } from "./execution-checkpoint";
import type { HumanApprovalManager } from "./human-approval";
import { summarizeToolResult as summarizeToolResultFn, stripWebNoise as stripWebNoiseImpl } from "./text-processor";
import { hasActionIntent as hasActionIntentFn } from "./quick-reply";
import { needsCompaction as needsCompactionFn, compactConversationHistory as compactConversationHistoryFn, persistSessionTurn as persistSessionTurnFn, type SessionPersistenceDeps, type SessionHistoryEntry } from "./session-persistence";

// ── Shared message types ──

export interface ToolCallEntry {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface ConversationMessage {
  role: string;
  content: string | null | ChatContent[];
  tool_calls?: ToolCallEntry[];
  tool_call_id?: string;
  name?: string;
}

/** Messages passed to the LLM API (content can be multimodal) */
export interface LLMMessage {
  role: string;
  content: string | null | ChatContent[];
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIToolEntry {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

// ── Result types ──

export interface TryCallLLMResult {
  reply: string;
  tokensUsed: number;
  contextTokens?: number;
  duration: number;
  permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>;
  toolsExecuted: boolean;
  files: Array<{ path: string; size: number; downloadUrl: string }>;
}

export interface CallLLMOnceResult {
  message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
  tokensUsed: number;
  promptTokens: number;
  classifiedError?: ClassifiedError;
}

export interface ParseStreamingResponseResult {
  message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
  tokensUsed: number;
  promptTokens: number;
}

// ── Tool cache types ──

export interface ToolResultCacheEntry {
  result: string;
  timestamp: number;
}

const TOOL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const TOOL_CACHE_MAX = 100;

// ── EventLedger type (mirrors the lazy-resolved type from AgentModelExecutor) ──

export interface EventLedgerLike {
  append(type: LedgerEventType, data: Record<string, unknown>, opts?: { agentId?: string; sessionId?: string; causedBy?: number; duration?: number }): number;
  recordToolExecution(toolName: string, params: Record<string, unknown>, result: unknown, duration: number, opts?: { agentId?: string; sessionId?: string }): { callSeq: number; resultSeq: number };
  query(q: Record<string, unknown>): LedgerEntry[];
  snapshot(): Record<string, unknown>;
}

// ── Dependencies interface ──

export interface LLMCallerDeps {
  config: ModelConfig;
  providers: ProviderConfig[];
  persona: PersonaConfig;
  registeredTools: Map<string, { definition: ToolDefinition; handler: (params: Record<string, unknown>) => Promise<unknown> }>;
  conversationHistory: Map<string, Array<SessionHistoryEntry>>;
  maxHistoryLength: number;
  providerStats: Map<string, { successCount: number; failureCount: number; lastError?: string; lastErrorType?: string }>;
  pluginManager: import("@evoclaw/core").PluginManager | null;
  registry: ServiceRegistry;
  sessionManager: import("./session-manager").SessionManager | null;
  pendingOperations: Map<string, { sessionId: string; message: string; requestId: string; toolName: string; toolArgs: Record<string, unknown> }>;
  toolResultCache: Map<string, ToolResultCacheEntry>;
  // Session persistence deps
  sessionDataDir: string;
  sessionPersistenceEnabled: boolean;
  autoCompactionEnabled: boolean;
  compactionTokenThreshold: number;
  compactionManager: import("./compaction-manager").CompactionManager | null;
  lifecycleManager: import("./agent-lifecycle").AgentLifecycleManager | null;
  memoryHub: { getLongTerm(): { store(entry: import("@evoclaw/core").MemoryEntry): Promise<import("@evoclaw/core").MemoryEntry>; search(query: import("@evoclaw/core").MemorySearchQuery): Promise<import("@evoclaw/core").MemorySearchResult[]> } } | null;
  // Callbacks for provider stats
  recordProviderSuccess: (id: string) => void;
  recordProviderFailure: (id: string, error: string, errorType?: string) => void;
  // EventLedger resolver
  getEventLedger: () => EventLedgerLike | null;
  // Skills prompt builder
  buildSkillsPromptForRun: () => Promise<string>;
  // Execution checkpoint store (optional — enables durable execution)
  executionCheckpointStore?: ExecutionCheckpointStore;
  // Human-in-the-Loop approval manager (optional — enables approval workflow)
  humanApprovalManager?: HumanApprovalManager;
  // Eval runner (optional — enables evaluation system)
  evalRunner?: import("./evals").EvalRunner;
}

// ── Helper: tool cache ──

function getToolCacheKey(toolName: string, params: Record<string, unknown>): string {
  const sortedParams = Object.keys(params).sort().map(k => `${k}=${JSON.stringify(params[k])}`).join("&");
  return `${toolName}:${sortedParams}`;
}

function cleanToolCache(cache: Map<string, ToolResultCacheEntry>): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > TOOL_CACHE_TTL) {
      cache.delete(key);
    }
  }
  if (cache.size > TOOL_CACHE_MAX) {
    const entries = Array.from(cache.entries())
      .sort((a, b) => b[1].timestamp - a[1].timestamp);
    cache.clear();
    for (let i = 0; i < TOOL_CACHE_MAX && i < entries.length; i++) {
      cache.set(entries[i][0], entries[i][1]);
    }
  }
}

// ── Helper: dynamic tool limit ──

function computeDynamicToolLimit(
  message: string,
  baseLimit: number,
  cap: number,
  conversationHistory: Map<string, Array<SessionHistoryEntry>>
): number {
  const lower = message.toLowerCase();
  let limit = baseLimit;

  const complexPatterns = [
    /搜索.*新闻|search.*news/i,
    /整理.*报告|compile.*report/i,
    /分析.*代码|analyze.*code/i,
    /调试|debug/i,
    /部署|deploy/i,
    /重构|refactor/i,
    /批量|batch/i,
    /对比.*分析|comparative.*analysis/i,
    /多步|multi.?step/i,
    /完整.*流程|complete.*workflow/i,
  ];
  const veryComplexPatterns = [
    /搜索.*整理.*报告/i,
    /分析.*修复.*测试/i,
    /调研.*对比.*建议/i,
    /全面.*分析.*方案/i,
    /帮我.*搜索.*github/i,
    /本周.*重大.*新闻/i,
  ];

  if (veryComplexPatterns.some(p => p.test(lower))) {
    limit = Math.min(cap, baseLimit + 20);
  } else if (complexPatterns.some(p => p.test(lower))) {
    limit = Math.min(cap, baseLimit + 10);
  }

  if (hasActionIntentFn(message)) {
    limit = Math.min(cap, limit + 5);
  }

  const sessionHistory = conversationHistory.get("default") || [];
  if (sessionHistory.length > 20) {
    limit = Math.max(baseLimit, limit - 5);
  }

  return Math.min(cap, limit);
}

// ── Helper: session persistence delegation ──

function getSessionPersistenceDeps(deps: LLMCallerDeps): SessionPersistenceDeps {
  return {
    sessionDataDir: deps.sessionDataDir,
    sessionPersistenceEnabled: deps.sessionPersistenceEnabled,
    autoCompactionEnabled: deps.autoCompactionEnabled,
    compactionTokenThreshold: deps.compactionTokenThreshold,
    conversationHistory: deps.conversationHistory,
    compactionManager: deps.compactionManager,
    lifecycleManager: deps.lifecycleManager,
    sessionManager: deps.sessionManager,
    memoryHub: deps.memoryHub,
  };
}

// ── buildOpenAITools ──

export function buildOpenAITools(registeredTools: Map<string, { definition: ToolDefinition; handler: (params: Record<string, unknown>) => Promise<unknown> }>): OpenAIToolEntry[] {
  const essentialTools = new Set([
    "web_search", "web_fetch", "fetch_node_page", "file_read", "file_create",
    "file_modify", "file_list", "file_delete", "skill_execute", "skill_install",
    "skill_search", "skill_find_and_install", "skill_view", "skill_index_list",
    "email_send", "email_add_account",
    "browser_navigate", "browser_search", "browser_launch", "browser_screenshot",
    "browser_get_text", "browser_get_html", "browser_click", "browser_fetch_json",
    "browser_find_elements", "browser_submit_form", "browser_tabs", "browser_js_eval",
    "browser_fill_form", "browser_login", "browser_capture_network",
    "execute_programming_task", "decompose_programming_task", "assess_coding_capability", "get_task_result",
    "shell_exec", "scrapling_fetch",
    "markitdown_convert",
    "video_download", "music_download",
    "sequential_thinking",
  ]);
  return Array.from(registeredTools.values())
    .filter((t) => essentialTools.has(t.definition.name))
    .map((t) => {
      const props: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, paramDef] of Object.entries(t.definition.parameters)) {
        const p = paramDef as Record<string, unknown>;
        props[key] = {
          type: p.type || "string",
          description: p.description || key,
        };
        if (p.required !== false && p.default === undefined) {
          required.push(key);
        }
      }

      return {
        type: "function",
        function: {
          name: t.definition.name,
          description: t.definition.description,
          parameters: {
            type: "object",
            properties: props,
            required,
          },
        },
      };
    });
}

// ── parseStreamingResponse ──

export async function parseStreamingResponse(
  response: Response,
  provider: ProviderConfig,
  startTime: number,
  onProgress: AgentProgressCallback,
  deps: LLMCallerDeps
): Promise<ParseStreamingResponseResult | null> {
  const observability = deps.registry?.resolveService?.("observability") as any;
  const tracing = observability?.getTracingService?.();

  const doParse = async (): Promise<ParseStreamingResponseResult | null> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let content = "";
  const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
  let totalTokens = 0;
  let promptTokens = 0;
  let lastChunkTime = Date.now();

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

        const dataStr = trimmed.slice(6);
        if (dataStr === "[DONE]") continue;

        try {
          const chunk = JSON.parse(dataStr) as {
            choices?: Array<{
              delta?: {
                content?: string | null;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  type?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string;
            }>;
            usage?: { total_tokens?: number };
          };

          const choice = chunk.choices?.[0];
          if (!choice?.delta) continue;

          if (choice.delta.content) {
            content += choice.delta.content;
            const now = Date.now();
            if (now - lastChunkTime > 50) {
              onProgress({
                type: "status",
                phase: "generating",
                detail: "正在生成回复...",
                progress: 80,
                reply: content,
              });
              lastChunkTime = now;
            }
          }

          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const existing = toolCallsMap.get(tc.index);
              if (!existing) {
                toolCallsMap.set(tc.index, {
                  id: tc.id || "",
                  name: tc.function?.name || "",
                  arguments: tc.function?.arguments || "",
                });
              } else {
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              }
            }
          }

          if ((chunk.usage as Record<string, unknown>)?.total_tokens) {
            totalTokens = (chunk.usage as Record<string, unknown>).total_tokens as number;
          }
          if ((chunk.usage as Record<string, unknown>)?.prompt_tokens) {
            promptTokens = (chunk.usage as Record<string, unknown>).prompt_tokens as number;
          }
        } catch { /* ignore parse errors in individual chunks */ }
      }
    }
  } catch (readErr) {
    console.warn(`[AgentModelExecutor] Stream read error for ${provider.name}:`, readErr);
  }

  const obs = deps.registry?.resolveService<any>("observability");
  if (obs) {
    const latency = Date.now() - startTime;
    try {
      obs.counterIncrement("evoclaw_llm_calls_total", [{ key: "provider", value: provider.provider || "unknown" }, { key: "model", value: provider.model || "unknown" }, { key: "status", value: "success" }], 1);
      obs.histogramObserve("evoclaw_llm_latency_ms", latency, [{ key: "provider", value: provider.provider || "unknown" }, { key: "model", value: provider.model || "unknown" }, { key: "status", value: "success" }]);
    } catch { /* observability is best-effort */ }
  }

  deps.recordProviderSuccess(provider.id);

  const toolCalls = toolCallsMap.size > 0
    ? Array.from(toolCallsMap.entries()).map(([, tc]) => ({
        id: tc.id || `tc_${Date.now()}`,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }))
    : undefined;

  return {
    message: {
      role: "assistant",
      content: content || null,
      tool_calls: toolCalls,
    },
    tokensUsed: totalTokens || Math.ceil(content.length / 4),
    promptTokens: promptTokens || 0,
  };
  }; // end doParse

  if (tracing?.isEnabled()) {
    return tracing.withSpan("llm.stream_parse", async (span: Span) => {
      span.setAttribute("provider.name", provider.name);
      span.setAttribute("provider.model", provider.model);
      return doParse();
    });
  } else {
    return doParse();
  }
}

// ── callLLMOnce ──

export async function callLLMOnce(
  provider: ProviderConfig,
  messages: Array<LLMMessage>,
  tools: Array<{ type: string; function: Record<string, unknown> }>,
  toolChoice: "auto" | "required" | "none",
  onProgress: AgentProgressCallback | undefined,
  deps: LLMCallerDeps
): Promise<CallLLMOnceResult | null> {
  const observability = deps.registry?.resolveService?.("observability") as any;
  const tracing = observability?.getTracingService?.();

  const doCall = async (): Promise<CallLLMOnceResult | null> => {
  const timeout = provider.timeout || 60000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const baseURL = provider.baseURL || "";
  let apiURL = baseURL;
  if (!apiURL.endsWith("/chat/completions") && !apiURL.endsWith("/v1/chat/completions")) {
    apiURL = apiURL.replace(/\/+$/, "");
    if (!apiURL.endsWith("/v1")) {
      apiURL = `${apiURL}/v1`;
    }
    apiURL = `${apiURL}/chat/completions`;
  }

  const startTime = Date.now();

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (provider.apiKey) {
      if (provider.provider === "anthropic") {
        headers["x-api-key"] = provider.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${provider.apiKey}`;
      }
    }

    const useStreaming = !!onProgress;

    const body: Record<string, unknown> = {
      model: provider.model,
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role };
        if (m.content !== undefined) msg.content = m.content;
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.name) msg.name = m.name;
        return msg;
      }),
      max_tokens: provider.maxTokens || 4096,
      temperature: provider.temperature || 0.3,
      top_p: provider.topP ?? 1,
      stream: useStreaming,
    };

    if (tools.length > 0 && toolChoice !== "none") {
      body.tools = tools;
      body.tool_choice = toolChoice;

      if (provider.provider === "deepseek" || provider.name.toLowerCase().includes("deepseek")) {
        if (body.tool_choice === "none") {
          body.tool_choice = "auto";
        }
        body.reasoning_type = "deepseek_reasoning";
      }
    }

    console.log(`[AgentModelExecutor] 📡 Calling ${provider.name} API: ${apiURL} (model: ${provider.model}, tool_choice: ${body.tool_choice}, tools: ${tools.length})`);
    const response = await fetch(apiURL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const classified = classifyLLMError(response.status, errorText);
      console.error(
        `[AgentModelExecutor] ❌ LLM API FAILED for "${provider.name}": HTTP ${response.status} [${classified.type}]\n` +
        `  URL: ${apiURL}\n` +
        `  Model: ${provider.model}\n` +
        `  Error: ${errorText.slice(0, 500)}`
      );

      deps.recordProviderFailure(provider.id, `HTTP ${response.status}: ${errorText}`, classified.type);

      return {
        message: { role: "assistant", content: null },
        tokensUsed: 0,
        promptTokens: 0,
        classifiedError: classified,
      };
    }

    if (useStreaming && response.body) {
      return await parseStreamingResponse(response, provider, startTime, onProgress!, deps);
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          role?: string;
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: { total_tokens?: number };
    };

    const choice = data.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      deps.recordProviderFailure(provider.id, "Empty message in LLM response", "empty_response");
      return null;
    }

    const obs = deps.registry?.resolveService<any>("observability");
    if (obs) {
      const latency = Date.now() - startTime;
      try {
        obs.counterIncrement("evoclaw_llm_calls_total", [{ key: "provider", value: provider.provider || "unknown" }, { key: "model", value: provider.model || "unknown" }, { key: "status", value: "success" }], 1);
        obs.histogramObserve("evoclaw_llm_latency_ms", latency, [{ key: "provider", value: provider.provider || "unknown" }, { key: "model", value: provider.model || "unknown" }, { key: "status", value: "success" }]);
      } catch { /* observability is best-effort */ }
    }

    deps.recordProviderSuccess(provider.id);

    return {
      message: {
        role: msg.role || "assistant",
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      },
      tokensUsed: (data.usage as Record<string, unknown>)?.total_tokens as number || 0,
      promptTokens: (data.usage as Record<string, unknown>)?.prompt_tokens as number || 0,
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const obs = deps.registry?.resolveService<any>("observability");
    if (obs) {
      const latency = Date.now() - startTime;
      try {
        obs.counterIncrement("evoclaw_llm_calls_total", [{ key: "provider", value: provider.provider || "unknown" }, { key: "model", value: provider.model || "unknown" }, { key: "status", value: "error" }], 1);
        obs.histogramObserve("evoclaw_llm_latency_ms", latency, [{ key: "provider", value: provider.provider || "unknown" }, { key: "model", value: provider.model || "unknown" }, { key: "status", value: "error" }]);
      } catch { /* observability is best-effort */ }
    }
    let classified: ClassifiedError | undefined;
    let errorMessage = "Unknown error";
    let errorType = "UNKNOWN";
    if (err instanceof DOMException && err.name === "AbortError") {
      const msg = `LLM provider "${provider.name}" timed out after ${timeout}ms`;
      console.warn(`[AgentModelExecutor] ${msg}`);
      classified = classifyLLMError(undefined, undefined, msg);
      errorMessage = msg;
      errorType = "TIMEOUT";
    } else if (err instanceof Error) {
      errorMessage = err.message;
      console.error(`[AgentModelExecutor] ❌ LLM fetch failed for "${provider.name}": ${errorMessage}`);
      console.error(`  URL: ${apiURL}, Model: ${provider.model}, Timeout: ${timeout}ms`);
      classified = classifyLLMError(undefined, undefined, errorMessage);
      errorType = classified?.type || "UNKNOWN";
    }

    deps.recordProviderFailure(provider.id, errorMessage, errorType);

    return {
      message: { role: "assistant", content: null },
      tokensUsed: 0,
      promptTokens: 0,
      classifiedError: classified,
    };
  }
  }; // end doCall

  if (tracing?.isEnabled()) {
    return tracing.withSpan("llm.call_once", async (span: Span) => {
      span.setAttribute("provider.name", provider.name);
      span.setAttribute("provider.model", provider.model);
      span.setAttribute("provider.id", provider.id);
      span.setAttribute("tools.count", tools.length);
      return doCall();
    });
  } else {
    return doCall();
  }
}

// ── tryCallLLM ──

export interface TryCallLLMOptions {
  message: string;
  systemPrompt: string;
  installedSkills: unknown[];
  providers: ProviderConfig[];
  startTime: number;
  sessionId: string;
  pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>;
  attachments?: Array<{ name: string; type: string; size: number; data?: string | null }>;
  onProgress?: AgentProgressCallback;
  searchPreDone?: boolean;
  channel?: string;
}

export async function tryCallLLM(
  deps: LLMCallerDeps,
  options: TryCallLLMOptions
): Promise<TryCallLLMResult | null> {
  const observability = deps.registry?.resolveService?.("observability") as any;
  const tracing = observability?.getTracingService?.();

  const doTryCall = async (): Promise<TryCallLLMResult | null> => {
  const {
    message, systemPrompt, installedSkills, providers, startTime,
    sessionId, pendingPermissions, attachments, onProgress,
    searchPreDone = false, channel,
  } = options;

  const BASE_MAX_TOOL_ROUNDS = 20;
  const MAX_TOOL_ROUNDS_CAP = 50;
  const MAX_CONSECUTIVE_ERRORS = 3;

  const maxToolRounds = computeDynamicToolLimit(message, BASE_MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS_CAP, deps.conversationHistory);
  console.log(`[AgentModelExecutor] Dynamic tool limit for session "${sessionId}": ${maxToolRounds} (base=${BASE_MAX_TOOL_ROUNDS}, cap=${MAX_TOOL_ROUNDS_CAP})`);

  let totalTokensUsed = 0;
  let anyToolExecuted = false;
  let toolCallCount = 0;
  const createdFiles: Array<{ path: string; size: number; downloadUrl: string }> = [];

  // ── Execution checkpoint: start tracking ──
  const checkpointStore = deps.executionCheckpointStore;
  if (checkpointStore) {
    checkpointStore.startExecution(sessionId, message);
  }

  // Expand providers with multiple models
  const expandedProviders: ProviderConfig[] = [];
  for (const p of providers) {
    const models = p.models && p.models.length > 0 ? p.models : (p.model ? [p.model] : []);
    if (models.length === 0) {
      expandedProviders.push(p);
    } else {
      for (const m of models) {
        expandedProviders.push({ ...p, model: m });
      }
    }
  }
  console.log(`[AgentModelExecutor] ${expandedProviders.length} model entries from ${providers.length} provider(s) for session "${sessionId}"`);

  const skillsPrompt = await deps.buildSkillsPromptForRun();

  for (const provider of expandedProviders) {
    let consecutiveErrors = 0;

    try {
      const history = deps.conversationHistory.get(sessionId) || [];

      const webToolStrategy = `### Web Tool Decision Strategy (ReAct)
Follow this decision tree when handling web-related tasks:

\`\`\`
Have a specific URL?
├─ YES → Is it static content (article/doc/API/RSS)?
│        ├─ YES → web_fetch
│        │        Failed (blank/403/CAPTCHA)? → Try skill_execute with search skills → browser
│        └─ NO (needs JS/login/interaction/screenshot) → browser_navigate
└─ NO  → web_search (or skill_execute with tavily-search/baidu-search)
         ├─ Success → For result URLs, apply the URL logic above
         ├─ Failed → Try skill_execute with tavily-search or baidu-search
         └─ No results → browser_search
\`\`\`

**Key rules:**
1. For search tasks, prefer skill_execute with **tavily-search** (highest quality) or **baidu-search** over web_search
2. When web_search returns no results, try tavily-search or baidu-search via skill_execute before giving up
3. Always inform the user when switching tools — never silently downgrade
4. For Chinese content, baidu-search often works better; for English/global content, tavily-search is preferred`;

      const fullSystemPrompt = skillsPrompt
        ? `${systemPrompt}\n\n## Available Capabilities\n\n### Tools\nYou have access to tools including: **web_search** (search the web for live information), **web_fetch** (fetch and extract content from web pages), **skill_execute** (execute installed skills like tavily-search, baidu-search), and many more.\n\n${searchPreDone ? "**Search has already been performed.** Skip searching and go directly to analysis or code execution." : webToolStrategy}\n\n### Skills\nScan the available skills below. If one clearly applies, use skill_execute to invoke it. For search tasks, prefer **tavily-search** or **baidu-search** over generic web_search.\nOne skill up front max. Never guess or fabricate skill paths.\n${skillsPrompt}`
        : systemPrompt;

      const searchPreDoneNotice = searchPreDone
        ? "\n\n**⚠ SEARCH ALREADY COMPLETED**: The system has performed web searches and injected results into the user message. Do NOT search again. You have web_fetch, file_create, and shell_exec tools available. If this is a download/scraping task: 1) web_fetch the target pages, 2) analyze HTML, 3) write a Python scraper with file_create, 4) run it with shell_exec, 5) verify with file_list. NEVER refuse a download task — always attempt first."
        : "";

      const sessionPDeps = getSessionPersistenceDeps(deps);
      if (needsCompactionFn(sessionPDeps, sessionId, fullSystemPrompt, deps.config.maxTokens)) {
        console.log(`[AgentModelExecutor] Auto-compaction triggered for session "${sessionId}"`);
        compactConversationHistoryFn(sessionPDeps, sessionId);
      }

      const messages: Array<LLMMessage> = [
        { role: "system", content: fullSystemPrompt + searchPreDoneNotice },
      ];

      messages.push(...history);

      // Build user message — use multimodal format when images are attached
      const imageAtts = attachments?.filter(a => a.type.startsWith("image/") && a.data?.startsWith("data:"));
      if (imageAtts && imageAtts.length > 0) {
        const contentParts: ChatContent[] = [];
        if (message) {
          contentParts.push({ type: "text", text: message });
        }
        for (const img of imageAtts) {
          contentParts.push({
            type: "image_url",
            image_url: { url: img.data!, detail: "auto" },
          });
        }
        messages.push({ role: "user", content: contentParts });
      } else {
        messages.push({ role: "user", content: message });
      }

      let tools = buildOpenAITools(deps.registeredTools);

      const SEARCH_ONLY_TOOLS = new Set(["web_search", "browser_search", "browser_navigate"]);
      if (searchPreDone) {
        tools = tools.filter(t => !SEARCH_ONLY_TOOLS.has(t.function.name as string));
        console.log(`[AgentModelExecutor] Search pre-done: removed search tools, ${tools.length} tools remaining`);
      }

      const isAction = hasActionIntentFn(message);

      let conversationMessages = [...messages];
      let finalReply = "";
      let successfulToolCalls = 0;
      let lastPromptTokens = 0;

      for (let round = 0; round < maxToolRounds; round++) {
        onProgress?.({ type: "llm_call", phase: "thinking", detail: `正在调用 ${provider.name} (${provider.model})，第 ${round + 1} 轮...`, progress: 30 + round * 3, providerName: provider.name, round: round + 1 });

        const tc: "auto" | "none" = "auto";
        if (successfulToolCalls >= 4) {
          console.log(`[AgentModelExecutor] ${successfulToolCalls} tool calls used, nudging toward final answer (round ${round + 1})`);
          conversationMessages.push({
            role: "user",
            content: "You have gathered enough information. Now provide your final answer directly in chat. Only create a file if the user explicitly asked for a detailed report or the content is very long (>3000 chars). Do NOT search again."
          });
        }

        const result = await callLLMOnce(provider, conversationMessages, tools, tc, onProgress, deps);

        if (!result) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
          continue;
        }

        const classified = result.classifiedError;
        if (classified && classified.type !== LLMErrorType.UNKNOWN) {
          consecutiveErrors++;
          console.warn(`[AgentModelExecutor] Error classified as "${classified.type}" for provider "${provider.name}": ${classified.message}`);

          if (classified.type === LLMErrorType.CONTEXT_OVERFLOW && classified.shouldCompact) {
            console.log(`[AgentModelExecutor] Compacting due to context overflow...`);
            compactConversationHistoryFn(getSessionPersistenceDeps(deps), sessionId);
            conversationMessages = [
              { role: "system", content: fullSystemPrompt },
              ...(deps.conversationHistory.get(sessionId) || []),
            ];
            if (imageAtts && imageAtts.length > 0) {
              const retryParts: ChatContent[] = [];
              if (message) retryParts.push({ type: "text", text: message });
              for (const img of imageAtts) {
                retryParts.push({ type: "image_url", image_url: { url: img.data!, detail: "auto" } });
              }
              conversationMessages.push({ role: "user", content: retryParts });
            } else {
              conversationMessages.push({ role: "user", content: message });
            }
          }

          if (classified.type === LLMErrorType.RATE_LIMIT && classified.backoffMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, classified.backoffMs));
          }

          if (classified.type === LLMErrorType.AUTH || classified.type === LLMErrorType.BILLING) {
            console.warn(`[AgentModelExecutor] Skipping provider "${provider.name}" due to ${classified.type}`);
            break;
          }

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
          continue;
        }

        consecutiveErrors = 0;
        totalTokensUsed += result.tokensUsed;
        if (result.promptTokens > 0) lastPromptTokens = result.promptTokens;

        const TOKEN_BUDGET = 900000;
        if (totalTokensUsed > TOKEN_BUDGET * 0.5 && totalTokensUsed <= TOKEN_BUDGET * 0.5 + result.tokensUsed) {
          console.warn(`[AgentModelExecutor] Token budget 50% reached: ${totalTokensUsed}/${TOKEN_BUDGET} for session "${sessionId}"`);
          conversationMessages.push({ role: "user", content: "⚠ Token budget is 50% used. STOP searching. Provide your answer now based on what you've found. Only write files if the user explicitly requested a detailed report. Do NOT search again." });
        }
        if (totalTokensUsed > TOKEN_BUDGET * 0.8 && totalTokensUsed <= TOKEN_BUDGET * 0.8 + result.tokensUsed) {
          console.warn(`[AgentModelExecutor] Token budget warning: ${totalTokensUsed}/${TOKEN_BUDGET} (80%) for session "${sessionId}"`);
          conversationMessages.push({ role: "user", content: "⚠ Token budget 80% used. You MUST produce a final answer NOW. If you have any results, format them for the user. If you have a script, run it with shell_exec immediately." });
        }
        if (totalTokensUsed > TOKEN_BUDGET) {
          console.warn(`[AgentModelExecutor] Token budget exceeded: ${totalTokensUsed}/${TOKEN_BUDGET} for session "${sessionId}". Forcing summary.`);
          break;
        }

        const assistantMsg = result.message;

        if (assistantMsg.content) {
          finalReply = assistantMsg.content;
          finalReply = finalReply.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, "").trim();
          finalReply = finalReply.replace(/<invoke\s+name="[^"]*">[\s\S]*?<\/invoke>/g, "").trim();
          finalReply = finalReply.replace(/<parameter\s+name="[^"]*">[\s\S]*?<\/parameter>/g, "").trim();
        }

        const toolCalls = assistantMsg.tool_calls;
        if (!toolCalls || toolCalls.length === 0) {
          conversationMessages.push(assistantMsg);
          break;
        }

        conversationMessages.push(assistantMsg);

        for (const tc of toolCalls) {
          const toolStartTime = Date.now();
          const toolName = tc.function.name;
          const toolEntry = deps.registeredTools.get(toolName);

          taskStatusTracker.set(sessionId, "tool_calling", `正在执行: ${toolName}...`, 50 + Math.floor((toolCalls.indexOf(tc) / toolCalls.length) * 20));
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* ignore parse errors */ }
          onProgress?.({ type: "tool_call", phase: "tool_calling", detail: `正在执行工具: ${toolName}`, progress: 50 + Math.floor((toolCalls.indexOf(tc) / toolCalls.length) * 20), toolName, toolArgs: args, round: round + 1 });

          // Plugin hook: before_tool_call
          let skipWithResult: unknown = undefined;

          if (deps.pluginManager?.hasHooks("before_tool_call")) {
            const { blocked, cancelled, merged } = await deps.pluginManager.runHooksMerged({
              type: "before_tool_call",
              context: { sessionId, agentId: "default", channel: "web-ui" },
              toolName,
              params: args,
            });
            if (cancelled || blocked) {
              conversationMessages.push({
                role: "tool",
                tool_call_id: tc.id,
                name: toolName,
                content: JSON.stringify({ skipped: true, reason: blocked ? "blocked" : "cancelled" }),
              });
              continue;
            }
            const mergedBTC = merged as Partial<import("@evoclaw/core").BeforeToolCallResult>;
            if (mergedBTC.params) args = mergedBTC.params as Record<string, unknown>;
            if (mergedBTC.skipWithResult !== undefined) {
              skipWithResult = mergedBTC.skipWithResult;
            }
          }

          // ── Human-in-the-Loop approval check ──
          if (deps.humanApprovalManager && deps.humanApprovalManager.requiresApproval(toolName, args)) {
            const riskLevel = deps.humanApprovalManager.getRiskLevel(toolName);
            onProgress?.({
              type: "approval_pending",
              phase: "waiting_approval",
              detail: `等待人工审批: ${toolName} (${riskLevel})`,
              progress: 50,
              toolName,
              toolArgs: args,
              round: round + 1,
            });

            console.log(`[AgentModelExecutor] HITL: Requesting approval for tool "${toolName}" (risk: ${riskLevel}) in session "${sessionId}"`);

            const approvalResult = await deps.humanApprovalManager.requestApproval(
              sessionId,
              toolName,
              args,
              "agent",
            );

            if (approvalResult.decision === "rejected") {
              console.log(`[AgentModelExecutor] HITL: Tool "${toolName}" rejected by user`);
              conversationMessages.push({
                role: "tool",
                tool_call_id: tc.id,
                name: toolName,
                content: JSON.stringify({ skipped: true, reason: "rejected_by_user" }),
              });
              continue;
            }

            if (approvalResult.decision === "modified" && approvalResult.modifiedArgs) {
              console.log(`[AgentModelExecutor] HITL: Tool "${toolName}" approved with modified arguments`);
              args = approvalResult.modifiedArgs;
            } else {
              console.log(`[AgentModelExecutor] HITL: Tool "${toolName}" approved`);
            }
          }

          let toolResult: string;
          let toolErrored = false;
          let toolError: string | undefined;
          let rawResult: unknown = undefined;
          let cacheHit = false;

          if (toolEntry) {
            try {
              if (skipWithResult !== undefined) {
                rawResult = skipWithResult;
                toolResult = JSON.stringify(skipWithResult);
              } else {
                const cacheKey = getToolCacheKey(toolName, args);
                const cached = deps.toolResultCache.get(cacheKey);
                if (cached && Date.now() - cached.timestamp < TOOL_CACHE_TTL) {
                  console.log(`[AgentModelExecutor] Tool cache hit: ${toolName}`);
                  toolResult = cached.result;
                  cacheHit = true;
                } else {
                  const LONG_RUNNING_TOOLS = new Set([
                    "execute_programming_task", "decompose_programming_task",
                    "browser_launch", "browser_screenshot", "browser_login",
                    "browser_navigate", "browser_submit_form", "browser_js_eval",
                    "get_task_result", "shell_exec", "scrapling_fetch",
                  ]);
                  const TOOL_TIMEOUT = LONG_RUNNING_TOOLS.has(toolName) ? 300000 : 30000;
                  const toolExecFn = async () => {
                    const toolPromise = toolEntry.handler(args);
                    let toolTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
                    const toolTimeoutPromise = new Promise<never>((_, reject) => {
                      toolTimeoutHandle = setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${TOOL_TIMEOUT / 1000}s`)), TOOL_TIMEOUT);
                    });
                    try {
                      rawResult = await Promise.race([toolPromise, toolTimeoutPromise]);
                    } finally {
                      if (toolTimeoutHandle) clearTimeout(toolTimeoutHandle);
                    }
                  };
                  if (tracing?.isEnabled()) {
                    await tracing.withSpan("tool.execute", async (span: Span) => {
                      span.setAttribute("tool.name", toolName);
                      span.setAttribute("tool.timeout", TOOL_TIMEOUT);
                      await toolExecFn();
                    });
                  } else {
                    await toolExecFn();
                  }
                  toolResult = JSON.stringify(rawResult);
                  if (toolResult && typeof toolResult === "string" && toolResult.length > 0) {
                    deps.toolResultCache.set(cacheKey, { result: toolResult, timestamp: Date.now() });
                    cleanToolCache(deps.toolResultCache);
                  }
                }
              }
              anyToolExecuted = true;

              if ((toolName === "file_create" || toolName === "file_modify") && rawResult && typeof rawResult === "object") {
                const r = rawResult as Record<string, unknown>;
                if (r.path && typeof r.path === "string") {
                  const isImChannel = channel ? !["webchat", "cli", "web-ui"].includes(channel) : false;
                  createdFiles.push({
                    path: r.path as string,
                    size: (r.size as number) || 0,
                    downloadUrl: isImChannel ? "" : `/api/files/download/${(r.path as string).replace(/\\/g, "/")}`,
                  });
                }
              }

              const ledger = deps.getEventLedger();
              if (ledger) {
                ledger.recordToolExecution(toolName, args, rawResult, Date.now() - toolStartTime, { agentId: "default", sessionId });
              }

              const isBrowser = toolName.startsWith("browser_");
              const isWebTool = toolName === "web_search" || toolName === "web_fetch" || toolName === "fetch_node_page" || toolName === "skill_execute" || toolName === "browser_search" || toolName === "browser_navigate";
              if (isWebTool && rawResult && typeof rawResult === "object") {
                const r = rawResult as Record<string, unknown>;
                if (typeof r.content === "string" && r.content.length > 100) {
                  r.content = stripWebNoiseImpl(r.content);
                }
                if (typeof r.text === "string" && r.text.length > 100) {
                  r.text = stripWebNoiseImpl(r.text);
                }
                if (typeof r.body === "string" && r.body.length > 100) {
                  r.body = stripWebNoiseImpl(r.body);
                }
                if (typeof r.snippet === "string" && r.snippet.length > 100) {
                  r.snippet = stripWebNoiseImpl(r.snippet);
                }
                if (Array.isArray(r.results)) {
                  for (const item of r.results as Array<Record<string, unknown>>) {
                    if (typeof item.snippet === "string" && item.snippet.length > 100) {
                      item.snippet = stripWebNoiseImpl(item.snippet as string);
                    }
                    if (typeof item.content === "string" && item.content.length > 100) {
                      item.content = stripWebNoiseImpl(item.content as string);
                    }
                  }
                }
                if (typeof r.output === "string" && r.output.length > 200) {
                  r.output = stripWebNoiseImpl(r.output);
                }
                toolResult = JSON.stringify(r);
              }
              const MAX_RESULT_LEN = isBrowser ? 8000 : 16000;
              if (toolResult.length > MAX_RESULT_LEN) {
                const truncated = JSON.stringify({ truncated: true, originalLength: toolResult.length, preview: toolResult.slice(0, MAX_RESULT_LEN), hint: `结果已截断(原${toolResult.length}字符)，请使用 browser_get_text 获取特定内容` });
                toolResult = truncated;
              }
              if (!cacheHit) {
                toolResult = summarizeToolResultFn(toolName, toolResult);
              }
              if ((toolName === "web_search" || toolName === "skill_execute" || toolName === "web_fetch" || toolName === "fetch_node_page") && successfulToolCalls >= 2) {
                toolResult += "\n\n[SYSTEM HINT: You have search results now. Do NOT search again. Provide your answer directly in chat. Only create a file if the user explicitly asked for a detailed report or the content exceeds 3000 chars.]";
              }
              if (rawResult && typeof rawResult === "object" && (rawResult as Record<string, unknown>).requiresPermission) {
                const r = rawResult as Record<string, unknown>;
                const requestId = (r.requestId as string) || (r.id as string) || "";
                pendingPermissions.push({
                  id: requestId,
                  operation: (r.operation as string) || toolName,
                  description: (r.description as string) || "需要权限确认",
                  target: (r.target as string) || tc.function.name,
                });

                if (requestId) {
                  deps.pendingOperations.set(requestId, { sessionId: sessionId, message: message, requestId: requestId, toolName: toolName, toolArgs: args });
                }
              }
              console.log(`[AgentModelExecutor] Tool "${toolName}" executed successfully`);
              successfulToolCalls++;
              onProgress?.({ type: "tool_result", phase: "tool_calling", detail: `工具 ${toolName} 执行完成`, progress: 55 + Math.floor((toolCalls.indexOf(tc) / toolCalls.length) * 20), toolName, toolResult: toolResult.slice(0, 200), toolError: false, round: round + 1 });
              try {
                const toolObs = deps.registry?.resolveService<any>("observability");
                if (toolObs) {
                  const latency = Date.now() - toolStartTime;
                  toolObs.counterIncrement("evoclaw_tool_calls_total", [{ key: "tool", value: toolName || "unknown" }, { key: "status", value: "success" }], 1);
                  toolObs.histogramObserve("evoclaw_tool_latency_ms", latency, [{ key: "tool", value: toolName || "unknown" }, { key: "status", value: "success" }]);
                }
              } catch { /* observability is best-effort */ }
            } catch (err: unknown) {
              toolResult = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
              toolErrored = true;
              toolError = err instanceof Error ? err.message : String(err);
              console.warn(`[AgentModelExecutor] Tool "${toolName}" failed:`, toolResult);
              onProgress?.({ type: "tool_result", phase: "tool_calling", detail: `工具 ${toolName} 执行失败: ${toolError}`, progress: 55, toolName, toolResult: toolError, toolError: true, round: round + 1 });

              try {
                const toolErrObs = deps.registry?.resolveService<any>("observability");
                if (toolErrObs) {
                  const latency = Date.now() - toolStartTime;
                  toolErrObs.counterIncrement("evoclaw_tool_calls_total", [{ key: "tool", value: toolName || "unknown" }, { key: "status", value: "error" }], 1);
                  toolErrObs.histogramObserve("evoclaw_tool_latency_ms", latency, [{ key: "tool", value: toolName || "unknown" }, { key: "status", value: "error" }]);
                }
              } catch { /* observability is best-effort */ }

              const ledger = deps.getEventLedger();
              if (ledger) {
                ledger.append("error", { tool: toolName, params: args, error: toolError }, { agentId: "default", sessionId, duration: Date.now() - toolStartTime });
              }
            }
          } else {
            toolResult = JSON.stringify({ error: `Tool "${toolName}" not found` });
            toolErrored = true;
            toolError = `Tool "${toolName}" not found`;
          }

          // Plugin hook: after_tool_call
          if (deps.pluginManager?.hasHooks("after_tool_call")) {
            const { merged } = await deps.pluginManager.runHooksMerged({
              type: "after_tool_call",
              context: { sessionId, agentId: "default", channel: "web-ui" },
              toolName,
              params: args,
              result: (() => { try { return JSON.parse(toolResult); } catch { return toolResult; } })(),
              errored: toolErrored,
              error: toolError,
            });
            const mergedATC = merged as Partial<import("@evoclaw/core").AfterToolCallResult>;
            if (mergedATC.result !== undefined) {
              toolResult = typeof mergedATC.result === "string" ? mergedATC.result : JSON.stringify(mergedATC.result);
            }
          }

          conversationMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: toolName,
            content: toolResult,
          });

          // ── Execution checkpoint: save snapshot after tool result ──
          if (checkpointStore) {
            checkpointStore.saveSnapshot(sessionId, {
              sessionId,
              stepIndex: toolCallCount,
              stepType: "tool_result",
              timestamp: Date.now(),
              messages: conversationMessages.map(m => ({
                role: m.role,
                content: typeof m.content === "string" ? m.content : null,
                tool_calls: m.tool_calls as unknown[] | undefined,
                tool_call_id: m.tool_call_id,
                name: m.name,
              })),
              currentToolCall: { name: toolName, arguments: tc.function.arguments },
              toolResult: { name: toolName, result: toolResult.slice(0, 2000), success: !toolErrored },
              tokensUsed: totalTokensUsed,
              durationMs: Date.now() - startTime,
            });
          }

          // Auto skill extraction consideration (GEPA-inspired)
          toolCallCount++;
          try {
            const skillCurator = deps.registry?.resolveService<{
              considerExtraction(sessionId: string, toolCallCount: number, lastToolResult: unknown, taskDescription: string): void;
            }>("skillCurator");
            if (skillCurator) {
              skillCurator.considerExtraction(sessionId, toolCallCount, rawResult, message);
            }
          } catch { /* skill extraction is best-effort */ }
        }

        if (!finalReply && round === maxToolRounds - 1) {
          try {
            const summaryMessages = [
              ...conversationMessages,
              { role: "user" as const, content: "请根据以上工具执行结果，总结回答用户的问题。" as string | null },
            ];
            const summaryResult = await callLLMOnce(provider, summaryMessages, [], "auto", onProgress, deps);
            if (summaryResult && summaryResult.message?.content) {
              finalReply = summaryResult.message.content;
              totalTokensUsed += summaryResult.tokensUsed;
            } else {
              finalReply = "工具已执行完毕，但未能生成总结回复。替代方案：① 请重新提问，我会尝试不同的方式回答；② 提供更多上下文信息帮助我理解您的需求。";
            }
          } catch {
            finalReply = "工具已执行完毕，但未能生成总结回复。";
          }
        }
      }

      if (finalReply) {
        if (deps.sessionManager) {
          try {
            const agentId = "default";
            deps.sessionManager.getOrCreateSession(agentId, sessionId);
            deps.sessionManager.appendTurn(agentId, sessionId, {
              turnIndex: 0, role: "assistant", content: finalReply, timestamp: new Date().toISOString(),
              toolCalls: anyToolExecuted ? [{ id: "tool-call", name: "llm_tools", arguments: {} }] : undefined,
            });
          } catch (err) {
            console.warn(`[AgentModelExecutor] SessionManager persist failed: ${err}`);
          }
        }
        persistSessionTurnFn(getSessionPersistenceDeps(deps), sessionId, "assistant", finalReply, { tokensUsed: totalTokensUsed });

        const cleanHistory: SessionHistoryEntry[] = [
          { role: "user", content: message },
          { role: "assistant", content: finalReply },
        ];
        const newHistory = [...history, ...cleanHistory];
        if (newHistory.length > deps.maxHistoryLength) {
          newHistory.splice(0, newHistory.length - deps.maxHistoryLength);
        }
        deps.conversationHistory.set(sessionId, newHistory);

        const ledgerEnd = deps.getEventLedger();
        if (ledgerEnd) {
          ledgerEnd.append("session_end", { toolsExecuted: anyToolExecuted, totalTokens: totalTokensUsed, durationMs: Date.now() - startTime }, { agentId: "default", sessionId });
        }

        // ── Execution checkpoint: mark completed ──
        if (checkpointStore) {
          checkpointStore.completeExecution(sessionId, finalReply);
        }

        return {
          reply: finalReply,
          tokensUsed: totalTokensUsed,
          contextTokens: lastPromptTokens || totalTokensUsed,
          duration: Date.now() - startTime,
          permissionRequests: pendingPermissions.length > 0 ? pendingPermissions : [],
          toolsExecuted: anyToolExecuted,
          files: createdFiles,
        };
      }

      console.warn(`[AgentModelExecutor] LLM provider "${provider.name}" returned empty response (model: ${provider.model})`);
    } catch (err: unknown) {
      // ── Execution checkpoint: mark failed ──
      if (checkpointStore) {
        checkpointStore.failExecution(sessionId, err instanceof Error ? err.message : String(err));
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        console.warn(`[AgentModelExecutor] LLM provider "${provider.name}" (model: ${provider.model}) timed out after ${provider.timeout || 60000}ms`);
      } else if (err instanceof Error) {
        console.warn(`[AgentModelExecutor] LLM provider "${provider.name}" (model: ${provider.model}) error: ${err.message}`);
        console.warn(`[AgentModelExecutor] Error stack: ${err.stack?.slice(0, 500)}`);
      } else {
        console.warn(`[AgentModelExecutor] LLM provider "${provider.name}" (model: ${provider.model}) unknown error: ${String(err)}`);
      }
    }
  }

  const fallbackReply = "抱歉，所有已启用的模型提供商均未能响应。请检查：\n1. 模型 API Key 是否正确配置\n2. 模型服务是否在线\n3. 网络连接是否正常\n\n替代方案：\n① 前往 Ops 页面查看详细诊断信息并修复配置\n② 尝试切换到其他模型提供商（如 DeepSeek、Qwen 等）\n③ 检查网络代理设置是否正确\n\n需要我帮您排查具体哪个模型出了问题吗？";
  console.error(`[AgentModelExecutor] All ${expandedProviders.length} model entry(s) across ${providers.length} provider(s) failed for session "${sessionId}". Provider details: ${expandedProviders.map(p => `${p.name}(${p.provider}/${p.model}, baseURL=${p.baseURL?.slice(0, 50)}, timeout=${p.timeout}ms)`).join("; ")}. Returning fallback message.`);
  return {
    reply: fallbackReply,
    tokensUsed: 0,
    contextTokens: 0,
    duration: Date.now() - startTime,
    permissionRequests: pendingPermissions,
    toolsExecuted: false,
    files: [],
  };
  }; // end doTryCall

  if (tracing?.isEnabled()) {
    return tracing.withSpan("llm.try_call", async (span: Span) => {
      span.setAttribute("session.id", options.sessionId);
      span.setAttribute("providers.count", options.providers.length);
      span.setAttribute("message.length", options.message.length);
      return doTryCall();
    });
  } else {
    return doTryCall();
  }
}
