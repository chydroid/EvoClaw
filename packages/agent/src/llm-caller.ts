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

// ── Circuit breaker for tool execution ──
// Tracks consecutive failures per tool. After MAX_CONSECUTIVE_FAILURES,
// the tool is "tripped" (disabled) for COOLDOWN_MS. This prevents the
// LLM from repeatedly calling a broken tool and wasting tokens.

const MAX_CONSECUTIVE_FAILURES = 3;
const COOLDOWN_MS = 60_000; // 1 minute cooldown after tripping

const toolFailureTracker = new Map<string, { count: number; trippedAt: number | null }>();

// ── Format command output into readable text ──
function formatNum(v: unknown, digits = 2): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toFixed(digits);
}

function fmtMoney(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
  return n.toFixed(2);
}

function formatCommandOutput(execObj: Record<string, unknown> | null, execStr: string): string {
  const rawOutput = String(execObj?.output || execStr);
  let outputData: unknown;
  try {
    outputData = JSON.parse(rawOutput);
  } catch {
    return `✅ 已执行您批准的命令，结果如下：\n\`\`\`\n${rawOutput.slice(0, 4000)}\n\`\`\``;
  }

  // Market ranking data
  if (outputData && typeof outputData === "object" && !Array.isArray(outputData)) {
    const d = outputData as Record<string, unknown>;
    if (Array.isArray(d.items) && d.items.length > 0 && typeof d.items[0] === "object" && d.items[0] !== null) {
      const first = d.items[0] as Record<string, unknown>;
      if ("code" in first && "name" in first) {
        // Market ranking
        const items = d.items as Array<Record<string, unknown>>;
        const sortName = String(d.sort_name || "排行");
        const total = d.total || items.length;
        let result = `📊 **A股${sortName}**（共 ${total} 只，显示前 ${items.length} 只）\n\n`;
        result += "| # | 代码 | 名称 | 现价 | 昨收 | 涨跌幅 | 成交额 |\n";
        result += "|---|------|------|------|------|--------|--------|\n";
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const prevClose = Number(item.previous_close || 0);
          const currentPrice = Number(item.current_price || 0);
          const changePercent = prevClose > 0 ? ((currentPrice - prevClose) / prevClose * 100) : 0;
          const amount = Number(item.amount || 0);
          const amountStr = amount >= 1e8 ? `${(amount / 1e8).toFixed(2)}亿` : amount >= 1e4 ? `${(amount / 1e4).toFixed(0)}万` : String(amount);
          // A股惯例：红涨绿跌
          const changeText = changePercent >= 0 ? `+${changePercent.toFixed(2)}%` : `${changePercent.toFixed(2)}%`;
          const changeColor = changePercent >= 0 ? "#e74c3c" : "#2ecc71";
          const changeStr = `<span style="color:${changeColor};font-weight:600;">${changeText}</span>`;
          const priceColor = currentPrice >= prevClose ? "#e74c3c" : currentPrice < prevClose ? "#2ecc71" : "inherit";
          const priceStr = `<span style="color:${priceColor};">${currentPrice.toFixed(2)}</span>`;
          result += `| ${i + 1} | ${String(item.code || "")} | ${String(item.name || "")} | ${priceStr} | ${prevClose.toFixed(2)} | ${changeStr} | ${amountStr} |\n`;
        }
        return result;
      }
      if ("title" in first) {
        // News data (direct items array)
        const items = d.items as Array<Record<string, unknown>>;
        let result = `📰 **资讯热榜**（共 ${items.length} 条）\n\n`;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const title = String(item.title || "无标题");
          const link = String(item.redirect_url || item.out_detail_url || item.detail_url || "");
          result += `${i + 1}. **${title}**${link ? ` ([详情](${link}))` : ""}\n`;
          const meta: string[] = [];
          if (item.source) meta.push(`来源：${String(item.source)}`);
          if (item.pub_time || item.publish_time) meta.push(`时间：${String(item.pub_time || item.publish_time)}`);
          if (meta.length > 0) result += `   ${meta.join(" | ")}\n`;
        }
        return result;
      }
    }
    // CICC hot-news wraps content under data.rsp.content_list
    if (d.data && typeof d.data === "object") {
      const rsp = (d.data as Record<string, unknown>).rsp as Record<string, unknown> | undefined;
      if (rsp && Array.isArray(rsp.content_list) && rsp.content_list.length > 0 &&
        typeof rsp.content_list[0] === "object" &&
        ("title" in (rsp.content_list[0] as object))) {
        const items = rsp.content_list as Array<Record<string, unknown>>;
        const specName = String(rsp.spec_subject_name || "今日热榜");
        const total = Number(rsp.total || items.length);
        let result = `📰 **${specName}**（共 ${total} 条，显示前 ${items.length} 条）\n\n`;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const title = String(item.title || "无标题");
          const link = String(item.redirect_url || item.out_detail_url || item.detail_url || "");
          result += `${i + 1}. **${title}**${link ? ` ([详情](${link}))` : ""}\n`;
          const meta: string[] = [];
          if (item.source) meta.push(`来源：${String(item.source)}`);
          if (item.pub_time) meta.push(`时间：${String(item.pub_time)}`);
          if (Array.isArray(item.stock_info) && (item.stock_info as unknown[]).length > 0) {
            const stocks = (item.stock_info as Array<Record<string, unknown>>)
              .map((s) => s.stock_name || s.stock_code)
              .filter(Boolean)
              .slice(0, 3)
              .join(", ");
            if (stocks) meta.push(`相关：${stocks}`);
          }
          if (meta.length > 0) result += `   ${meta.join(" | ")}\n`;
        }
        return result;
      }
    }
  }

  // Financial indicator data: items with rq + financial fields (top-level)
  if (outputData && typeof outputData === "object" && !Array.isArray(outputData)) {
    const d = outputData as Record<string, unknown>;
    if (Array.isArray(d.items) && d.items.length > 0 && typeof d.items[0] === "object" && d.items[0] !== null) {
      const first = d.items[0] as Record<string, unknown>;
      if ("rq" in first && ("yysr" in first || "jlr" in first || "xsmll" in first || "jzzsyl" in first || "kfjlr" in first)) {
        const items = d.items as Array<Record<string, unknown>>;
        const statementName = String(d.statement_name || "财务数据");
        const code = String(d.code || "");
        // Pick the most useful columns
        const colMap: Array<{ key: string; label: string; fmt?: (v: unknown) => string }> = [
          { key: "rq", label: "报告期" },
          { key: "yysr", label: "营业收入", fmt: fmtMoney },
          { key: "lrze", label: "利润总额", fmt: fmtMoney },
          { key: "kfjlr", label: "扣非净利润", fmt: fmtMoney },
          { key: "mgsy", label: "每股收益", fmt: (v) => `${formatNum(v, 2)}元` },
          { key: "xsmll", label: "毛利率", fmt: (v) => `${formatNum(v, 2)}%` },
          { key: "xsjll", label: "净利率", fmt: (v) => `${formatNum(v, 2)}%` },
          { key: "jzzsyl", label: "ROE", fmt: (v) => `${formatNum(v, 2)}%` },
          { key: "zcfzl", label: "资产负债率", fmt: (v) => `${formatNum(v, 2)}%` },
        ];
        // Only keep columns that have data
        const activeCols = colMap.filter((c) => items.some((it) => it[c.key] !== undefined && it[c.key] !== ""));
        let result = `📊 **${code} ${statementName}**（最近 ${items.length} 期）\n\n`;
        result += `| ${activeCols.map((c) => c.label).join(" | ")} |\n`;
        result += `|${activeCols.map(() => "---").join("|")}|\n`;
        for (const item of items) {
          const row = activeCols.map((c) => {
            const v = item[c.key];
            if (v === undefined || v === "") return "—";
            return c.fmt ? c.fmt(v) : String(v);
          });
          result += `| ${row.join(" | ")} |\n`;
        }
        return result;
      }
    }
  }

  // Array data
  if (Array.isArray(outputData)) {
    const arr = outputData as unknown[];
    let result = `✅ 已执行您批准的命令，返回 ${arr.length} 条结果：\n\n`;
    for (let i = 0; i < Math.min(arr.length, 20); i++) {
      const item = arr[i];
      if (typeof item === "object" && item !== null) {
        const entries = Object.entries(item as Record<string, unknown>).slice(0, 6);
        result += `${i + 1}. ${entries.map(([k, v]) => `${k}=${String(v).slice(0, 30)}`).join(", ")}\n`;
      } else {
        result += `${i + 1}. ${String(item).slice(0, 100)}\n`;
      }
    }
    if (arr.length > 20) result += `\n... 还有 ${arr.length - 20} 条结果`;
    return result;
  }

  // Generic JSON
  try {
    const pretty = JSON.stringify(outputData, null, 2);
    return `✅ 已执行您批准的命令，结果如下：\n\`\`\`json\n${pretty.slice(0, 4000)}\n\`\`\``;
  } catch {
    return `✅ 已执行您批准的命令，结果如下：\n\`\`\`\n${rawOutput.slice(0, 4000)}\n\`\`\``;
  }
}

function isToolTripped(toolName: string): boolean {
  const tracker = toolFailureTracker.get(toolName);
  if (!tracker || !tracker.trippedAt) return false;
  // Auto-recover after cooldown
  if (Date.now() - tracker.trippedAt > COOLDOWN_MS) {
    toolFailureTracker.delete(toolName);
    return false;
  }
  return true;
}

function recordToolFailure(toolName: string): void {
  const tracker = toolFailureTracker.get(toolName) || { count: 0, trippedAt: null };
  tracker.count++;
  if (tracker.count >= MAX_CONSECUTIVE_FAILURES) {
    tracker.trippedAt = Date.now();
    console.warn(`[CircuitBreaker] Tool "${toolName}" tripped after ${tracker.count} consecutive failures. Cooldown: ${COOLDOWN_MS / 1000}s`);
  }
  toolFailureTracker.set(toolName, tracker);
}

function recordToolSuccess(toolName: string): void {
  toolFailureTracker.delete(toolName);
}

// ── Tool parameter validation ──
// Validates that LLM-generated tool parameters match the expected schema.
// Returns a descriptive error if validation fails, or null if OK.

function validateToolParams(
  toolName: string,
  args: Record<string, unknown>,
  definition: { parameters: Record<string, unknown> }
): string | null {
  const params = definition.parameters;
  for (const [key, schema] of Object.entries(params)) {
    const p = schema as Record<string, unknown>;
    const isRequired = p.required !== false && p.default === undefined;
    const value = args[key];

    // Check required parameters
    if (isRequired && (value === undefined || value === null || value === "")) {
      return `Missing required parameter "${key}" for tool "${toolName}". Expected type: ${p.type || "string"}. Description: ${p.description || key}`;
    }

    // Type check if value is provided
    if (value !== undefined && value !== null && p.type) {
      const expectedType = String(p.type);
      const actualType = Array.isArray(value) ? "array" : typeof value;

      // Allow numeric strings for number params (LLM often sends "42" instead of 42)
      if (expectedType === "number" && typeof value === "string") {
        const num = Number(value);
        if (!isNaN(num)) {
          args[key] = num; // auto-coerce
          continue;
        }
      }

      // Allow boolean strings for boolean params
      if (expectedType === "boolean" && typeof value === "string") {
        if (value === "true" || value === "false") {
          args[key] = value === "true"; // auto-coerce
          continue;
        }
      }

      if (expectedType !== actualType && !(expectedType === "number" && actualType === "number")) {
        return `Parameter "${key}" for tool "${toolName}" has wrong type: expected ${expectedType}, got ${actualType}. Value: ${JSON.stringify(value).slice(0, 100)}`;
      }
    }
  }
  return null;
}

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
  // Planning & Reflection integration (optional — enables Plan→Reflect→Replan)
  recordToolTrace?: (sessionId: string, toolName: string, params: Record<string, unknown>, result: unknown, success: boolean, duration: number, error?: string) => void;
  checkAndReflect?: (sessionId: string) => Promise<import("./reflection-engine").ReflectionResult | null>;
  // Planning step update (optional — enables plan progress tracking)
  updatePlanStep?: (sessionId: string, stepId: string, update: { status: string; result?: string; error?: string }) => void;
  // Guardrails integration (optional — enables input/output/tool safety checks)
  checkInputGuardrail?: (input: string) => import("./guardrails").GuardrailResult;
  checkOutputGuardrail?: (output: string) => import("./guardrails").GuardrailResult;
  checkToolGuardrail?: (toolName: string, args: Record<string, unknown>) => import("./guardrails").GuardrailResult;
  // Observability integration (optional — enables trace/span recording)
  observability?: import("./agent-observability").AgentObservability;
  currentTraceId?: string;
  // Stale Context integration (optional — records tool result timestamps for staleness tracking)
  recordStaleContext?: (sessionId: string, toolName: string) => void;
  // Steer integration (optional — injects real-time instructions into conversation)
  getSteerMessage?: (sessionId: string) => string | null;
  // Semantic intent classifier (optional — replaces keyword matching for intent routing)
  semanticIntentClassifier?: { classifyIntent(message: string): Promise<{ category: string; score: number } | null> };
  // Pending approval commands (optional — enables chat-based approval for rejected shell commands)
  pendingApprovalCommands?: Map<string, { command: string; rejectedAt: number }>;
  // Iteration budget (optional — enables Hermes-style budget tracking with Grace Call)
  iterationBudget?: import("./iteration-budget").IterationBudget;
  // ContextEngine result (optional — enables layered context with frozen/ephemeral separation)
  contextEngineResult?: import("./context-engine").LayeredContextResult;
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

// ── Idempotency cache for write operations ──
// Prevents duplicate file creates, email sends, etc. when the LLM retries
// a tool call with identical parameters within the TTL window.
const idempotencyCache = new Map<string, { result: string; timestamp: number }>();
const IDEMPOTENCY_TTL = 5 * 60 * 1000; // 5 minutes
const IDEMPOTENCY_MAX = 200;
const IDEMPOTENT_TOOLS = new Set([
  "file_create", "file_modify", "file_delete",
  "email_send",
  "scheduler_create", "scheduler_delete",
]);

function getIdempotencyKey(toolName: string, args: Record<string, unknown>): string {
  // Only include fields that affect the write outcome
  const relevantFields: Record<string, unknown> = {};
  if (toolName === "file_create" || toolName === "file_modify") {
    relevantFields.path = args.path;
  } else if (toolName === "email_send") {
    relevantFields.to = args.to;
    relevantFields.subject = args.subject;
  } else if (toolName === "scheduler_create") {
    relevantFields.name = args.name;
    relevantFields.cronExpression = args.cronExpression;
  } else {
    // Generic: hash all args
    return `${toolName}:${JSON.stringify(args)}`;
  }
  return `${toolName}:${JSON.stringify(relevantFields)}`;
}

function cleanIdempotencyCache(): void {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache) {
    if (now - entry.timestamp > IDEMPOTENCY_TTL) {
      idempotencyCache.delete(key);
    }
  }
  if (idempotencyCache.size > IDEMPOTENCY_MAX) {
    const entries = Array.from(idempotencyCache.entries())
      .sort((a, b) => b[1].timestamp - a[1].timestamp);
    idempotencyCache.clear();
    for (let i = 0; i < IDEMPOTENCY_MAX && i < entries.length; i++) {
      idempotencyCache.set(entries[i][0], entries[i][1]);
    }
  }
}

// ── Helper: dynamic tool limit ──

function computeDynamicToolLimit(
  message: string,
  baseLimit: number,
  cap: number,
  conversationHistory: Map<string, Array<SessionHistoryEntry>>,
  sessionId: string
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

  const sessionHistory = conversationHistory.get(sessionId) || [];
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

// ── Tool groups for dynamic loading ──
// Tools are organized into groups by capability. The LLM receives the
// "core" group always, plus groups that match the current task intent.
// This reduces the number of tool definitions sent to the LLM (best
// practice: ≤15 tools per request) and improves tool selection accuracy.

const TOOL_GROUPS: Record<string, { tools: string[]; keywords: string[] }> = {
  core: {
    tools: [
      "web_search", "web_fetch", "file_read", "file_create", "file_modify",
      "file_list", "file_delete", "shell_exec", "sequential_thinking",
    ],
    keywords: [], // always included
  },
  browser: {
    tools: [
      "browser_navigate", "browser_search", "browser_launch", "browser_screenshot",
      "browser_get_text", "browser_get_html", "browser_click", "browser_fetch_json",
      "browser_find_elements", "browser_submit_form", "browser_tabs", "browser_js_eval",
      "browser_fill_form", "browser_login",
    ],
    keywords: ["browse", "browser", "网页", "网站", "打开", "navigate", "click", "screenshot", "登录", "login", "网页操作", "填写表单"],
  },
  skill: {
    tools: ["skill_execute", "skill_install", "skill_search", "skill_find_and_install", "skill_view", "skill_index_list"],
    keywords: ["skill", "技能", "install skill", "安装技能", "搜索技能", "翻译", "translate", "转换", "convert", "查找技能", "执行技能"],
  },
  email: {
    tools: ["email_send", "email_add_account"],
    keywords: ["email", "邮件", "发送邮件", "send email", "inbox", "收件箱"],
  },
  coding: {
    tools: ["execute_programming_task", "decompose_programming_task", "assess_coding_capability", "get_task_result"],
    keywords: ["programming", "编程", "代码", "code", "开发", "程序", "写代码", "实现功能"],
  },
  media: {
    tools: ["video_download", "music_download", "scrapling_fetch", "fetch_node_page", "markitdown_convert"],
    keywords: ["video", "视频", "download", "下载", "music", "音乐", "歌曲", "youtube", "b站", "抖音"],
  },
  scheduler: {
    tools: ["scheduler_create", "scheduler_list", "scheduler_update", "scheduler_delete", "scheduler_execute", "scheduler_history"],
    keywords: ["schedule", "定时", "cron", "调度", "定期", "计划任务"],
  },
  memory: {
    tools: ["memory_store", "memory_retrieve", "memory_search", "memory_delete"],
    keywords: ["memory", "记忆", "记住", "回忆", "remember", "recall", "忘记", "存储", "检索"],
  },
};

// ── buildOpenAITools ──

export function buildOpenAITools(
  registeredTools: Map<string, { definition: ToolDefinition; handler: (params: Record<string, unknown>) => Promise<unknown> }>,
  message?: string,
): OpenAIToolEntry[] {
  // Determine which tool groups to include based on the user message.
  // Core group is always included. Other groups are included if the
  // message contains relevant keywords.
  const activeTools = new Set(TOOL_GROUPS.core.tools);
  if (message) {
    const lowerMsg = message.toLowerCase();
    for (const [, group] of Object.entries(TOOL_GROUPS)) {
      if (group.keywords.length > 0 && group.keywords.some(kw => lowerMsg.includes(kw.toLowerCase()))) {
        for (const t of group.tools) activeTools.add(t);
      }
    }
    // If the message doesn't match any specific group, include all tools
    // (fallback to avoid missing capabilities for ambiguous requests).
    if (activeTools.size <= TOOL_GROUPS.core.tools.length) {
      for (const [, group] of Object.entries(TOOL_GROUPS)) {
        for (const t of group.tools) activeTools.add(t);
      }
    }
  } else {
    // No message provided — include all tools for backward compatibility
    for (const [, group] of Object.entries(TOOL_GROUPS)) {
      for (const t of group.tools) activeTools.add(t);
    }
  }

  return Array.from(registeredTools.values())
    .filter((t) => {
      // Include tool if it's in the active set OR if it's not in any TOOL_GROUP
      // (i.e., dynamically registered tools not covered by groups are always included)
      const isInAnyGroup = Object.values(TOOL_GROUPS).some(g => g.tools.includes(t.definition.name));
      return activeTools.has(t.definition.name) || !isInAnyGroup;
    })
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
  if (!response.body) {
    console.warn(`[LLMCaller] Stream response has no body`);
    return null;
  }
  const reader = response.body.getReader();
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

  const maxToolRounds = computeDynamicToolLimit(message, BASE_MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS_CAP, deps.conversationHistory, sessionId);
  console.log(`[AgentModelExecutor] Dynamic tool limit for session "${sessionId}": ${maxToolRounds} (base=${BASE_MAX_TOOL_ROUNDS}, cap=${MAX_TOOL_ROUNDS_CAP})`);

  let totalTokensUsed = 0;
  let anyToolExecuted = false;
  let toolCallCount = 0;
  const createdFiles: Array<{ path: string; size: number; downloadUrl: string }> = [];
  // Track HITL rejections per session to avoid repeated 30s timeouts
  let hitlRejectCount = 0;

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

  // ── Approval intent detection: if user says "同意/执行/yes/approve",
  //    auto-execute the pending rejected shell command ──
  //    This MUST run BEFORE the provider loop so the approval is handled
  //    immediately without going through LLM (which would treat it as chat).
  const APPROVAL_PATTERNS = /^(同意|批准|允许|执行|确认|yes|approve|confirm|go ahead|do it|run it|ok|okay|好的|可以|没问题)[\s!.。！？?]*$/i;
  const isApprovalIntent = APPROVAL_PATTERNS.test(message.trim());
  const pendingCmd = deps.pendingApprovalCommands?.get(sessionId);
  if (isApprovalIntent && pendingCmd && deps.pendingApprovalCommands) {
    // TTL check: expire after 30 minutes
    const PENDING_CMD_TTL = 30 * 60 * 1000;
    if (Date.now() - pendingCmd.rejectedAt > PENDING_CMD_TTL) {
      console.log(`[AgentModelExecutor] Pending command expired (>${PENDING_CMD_TTL / 60000}min), discarding: ${pendingCmd.command}`);
      deps.pendingApprovalCommands.delete(sessionId);
    } else {
      console.log(`[AgentModelExecutor] User approved pending command: ${pendingCmd.command}`);
      deps.pendingApprovalCommands.delete(sessionId);
      // Reset HITL reject count so the command can go through
      hitlRejectCount = 0;
      // Add the pending command's tool to trust rules temporarily
      if (deps.humanApprovalManager) {
        deps.humanApprovalManager.addTrustRule({
          toolName: "shell_exec",
          argPattern: { command: pendingCmd.command },
          trustedBy: "chat_approval",
          createdAt: Date.now(),
          expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
        });
      }
      // Execute the pending command directly and return immediately
      try {
        const shellExecTool = deps.registeredTools.get("shell_exec");
        if (shellExecTool) {
          const execResult = await shellExecTool.handler({ command: pendingCmd.command, timeout: "30" });
          const execStr = typeof execResult === "string" ? execResult : JSON.stringify(execResult);
          const execObj = typeof execResult === "object" ? execResult as Record<string, unknown> : null;
          if (execObj?.success !== false && execStr && execStr.length > 0) {
            return {
              reply: formatCommandOutput(execObj, execStr),
              tokensUsed: 0,
              duration: Date.now() - startTime,
              permissionRequests: [],
              toolsExecuted: true,
              files: [],
            };
          } else {
            return {
              reply: `⚠️ 命令执行失败：${execStr.slice(0, 500)}`,
              tokensUsed: 0,
              duration: Date.now() - startTime,
              permissionRequests: [],
              toolsExecuted: true,
              files: [],
            };
          }
        }
      } catch (err) {
        console.warn(`[AgentModelExecutor] Pending command execution failed: ${err}`);
        return {
          reply: `❌ 命令执行出错：${err instanceof Error ? err.message : String(err)}`,
          tokensUsed: 0,
          duration: Date.now() - startTime,
          permissionRequests: [],
          toolsExecuted: false,
          files: [],
        };
      }
    }
  }

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

      // ── ContextEngine: use pre-assembled layered context when available ──
      // When ContextEngine has already assembled the context (with frozen/ephemeral
      // separation, bootstrap files, token-aware truncation), use its messages
      // instead of building them manually. This ensures consistent context management.
      let messages: Array<LLMMessage>;
      if (deps.contextEngineResult) {
        // Use ContextEngine's pre-assembled messages (includes system prompt,
        // bootstrap files, skills context, memory, and truncated history)
        messages = deps.contextEngineResult.messages.map(m => ({
          role: m.role,
          content: m.content,
        })) as Array<LLMMessage>;
        // Add search pre-done notice if applicable
        if (searchPreDoneNotice) {
          const sysMsg = messages.find(m => m.role === "system");
          if (sysMsg && typeof sysMsg.content === "string") {
            sysMsg.content += searchPreDoneNotice;
          }
        }
        console.log(`[AgentModelExecutor] Using ContextEngine messages: ${messages.length} messages, ${deps.contextEngineResult.tokenEstimate} tokens`);
      } else {
        // Fallback: manual message assembly (original behavior)
        messages = [
          { role: "system", content: fullSystemPrompt + searchPreDoneNotice },
        ];
        messages.push(...history);
      }

      // ── User message length guard ──
      // Truncate excessively long messages to avoid LLM timeout and token waste.
      // 4000 chars ≈ 2000-4000 tokens (CJK chars are ~1-2 tokens each).
      const MAX_USER_MESSAGE_LEN = 4000;
      let effectiveMessage = message;

      // ── XSS / injection sanitization ──
      // Strip dangerous HTML/script patterns from user input before sending to LLM.
      // This prevents XSS payloads from being echoed back and ensures consistent
      // safety behavior regardless of LLM judgment.
      const XSS_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
        { pattern: /<script[\s\S]*?>[\s\S]*?<\/script>/gi, replacement: "[filtered:script-tag]" },
        { pattern: /\s+on\w+\s*=\s*["'][^"']*["']/gi, replacement: " [filtered:event-handler]" },
        { pattern: /&#x?[0-9a-f]+;/gi, replacement: "" },
      ];
      let xssFiltered = false;
      for (const { pattern, replacement } of XSS_PATTERNS) {
        if (pattern.test(effectiveMessage)) {
          effectiveMessage = effectiveMessage.replace(pattern, replacement);
          xssFiltered = true;
        }
      }
      if (xssFiltered) {
        effectiveMessage += "\n\n[系统提示：检测到潜在的安全风险内容，已自动过滤。]";
        console.log(`[AgentModelExecutor] XSS/injection patterns filtered in user message for session "${sessionId}"`);
      }

      if (effectiveMessage.length >= MAX_USER_MESSAGE_LEN) {
        effectiveMessage = effectiveMessage.slice(0, MAX_USER_MESSAGE_LEN) + `\n\n[系统提示：原始消息过长，已截断至${MAX_USER_MESSAGE_LEN}字符。如需完整处理，请分段发送。]`;
        console.log(`[AgentModelExecutor] User message truncated for session "${sessionId}"`);
      }

      // Build user message — use multimodal format when images are attached
      const imageAtts = attachments?.filter(a => a.type.startsWith("image/") && a.data?.startsWith("data:"));
      if (imageAtts && imageAtts.length > 0) {
        const contentParts: ChatContent[] = [];
        if (effectiveMessage) {
          contentParts.push({ type: "text", text: effectiveMessage });
        }
        for (const img of imageAtts) {
          contentParts.push({
            type: "image_url",
            image_url: { url: img.data!, detail: "auto" },
          });
        }
        messages.push({ role: "user", content: contentParts });
      } else {
        messages.push({ role: "user", content: effectiveMessage });
      }

      let tools = buildOpenAITools(deps.registeredTools, message);

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
      let skillFallbackResult: string | null = null;

      // ── IterationBudget integration ──
      // When available, use the Hermes-style budget system instead of the
      // simple round counter. The budget supports consume/refund and Grace Call.
      const budget = deps.iterationBudget;

      for (let round = 0; round < maxToolRounds; round++) {
        // ── IterationBudget: check if budget allows this iteration ──
        if (budget) {
          if (budget.isExhausted) {
            // Budget exhausted — try Grace Call (one final call without tools)
            if (budget.graceCallAvailable) {
              console.log(`[AgentModelExecutor] Iteration budget exhausted — using Grace Call (no tools)`);
              budget.useGraceCall();
              // Make one final LLM call without tools to produce a text answer
              const graceResult = await callLLMOnce(provider, conversationMessages, [], "none", onProgress, deps);
              if (graceResult && graceResult.message?.content) {
                finalReply = graceResult.message.content;
                totalTokensUsed += graceResult.tokensUsed;
              }
              break; // Exit loop after Grace Call
            }
            // No Grace Call available — force exit
            console.log(`[AgentModelExecutor] Iteration budget exhausted, no Grace Call available — forcing summary`);
            break;
          }
          budget.consume(1);
        }

        onProgress?.({ type: "llm_call", phase: "thinking", detail: `正在调用 ${provider.name} (${provider.model})，第 ${round + 1} 轮...`, progress: 30 + round * 3, providerName: provider.name, round: round + 1 });

        // ── Steer: inject real-time instructions ──
        if (deps.getSteerMessage) {
          const steerMsg = deps.getSteerMessage(sessionId);
          if (steerMsg) {
            conversationMessages.push({ role: "system", content: steerMsg });
          }
        }

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

        // ── Parse XML-format tool calls from non-standard LLM providers ──
        // Some providers (Mimo/MiniMax, etc.) embed tool calls as XML in the
        // content field instead of using the standard tool_calls field. We need
        // to parse these into proper tool_calls BEFORE stripping them.
        if (assistantMsg.content && (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0)) {
          const parsedCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
          let callIdx = 0;

          // Parse <invoke name="tool_name"><parameter name="p">value</parameter>...</invoke>
          const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
          let invokeMatch: RegExpExecArray | null;
          while ((invokeMatch = invokeRegex.exec(assistantMsg.content)) !== null) {
            const fnName = invokeMatch[1];
            const paramBlock = invokeMatch[2];
            const params: Record<string, unknown> = {};
            const paramRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
            let paramMatch: RegExpExecArray | null;
            while ((paramMatch = paramRegex.exec(paramBlock)) !== null) {
              let val: unknown = paramMatch[2].trim();
              // Try to parse JSON values (numbers, booleans, objects, arrays)
              try { val = JSON.parse(val as string); } catch { /* keep as string */ }
              params[paramMatch[1]] = val;
            }
            parsedCalls.push({
              id: `parsed_invoke_${callIdx++}`,
              type: "function",
              function: { name: fnName, arguments: JSON.stringify(params) },
            });
          }

          // Parse <minimax:tool_call> blocks with nested <function_calls>
          const minimaxRegex = /<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>/g;
          let minimaxMatch: RegExpExecArray | null;
          while ((minimaxMatch = minimaxRegex.exec(assistantMsg.content)) !== null) {
            const block = minimaxMatch[1];
            const fnRegex = /<function_name>([^<]+)<\/function_name>\s*<parameters>([\s\S]*?)<\/parameters>/g;
            let fnMatch: RegExpExecArray | null;
            while ((fnMatch = fnRegex.exec(block)) !== null) {
              const fnName = fnMatch[1].trim();
              const paramStr = fnMatch[2].trim();
              let params: Record<string, unknown> = {};
              try { params = JSON.parse(paramStr); } catch {
                // Fallback: try XML-style params
                const pRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
                let pMatch: RegExpExecArray | null;
                while ((pMatch = pRegex.exec(paramStr)) !== null) {
                  let val: unknown = pMatch[2].trim();
                  try { val = JSON.parse(val as string); } catch { /* keep as string */ }
                  params[pMatch[1]] = val;
                }
              }
              parsedCalls.push({
                id: `parsed_minimax_${callIdx++}`,
                type: "function",
                function: { name: fnName, arguments: JSON.stringify(params) },
              });
            }
          }

          if (parsedCalls.length > 0) {
            assistantMsg.tool_calls = parsedCalls;
            console.log(`[AgentModelExecutor] Parsed ${parsedCalls.length} XML tool call(s) from content: ${parsedCalls.map(c => c.function.name).join(", ")}`);
          }
        }

        if (assistantMsg.content) {
          finalReply = assistantMsg.content;
          finalReply = finalReply.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, "").trim();
          finalReply = finalReply.replace(/<invoke\s+name="[^"]*">[\s\S]*?<\/invoke>/g, "").trim();
          finalReply = finalReply.replace(/<parameter\s+name="[^"]*">[\s\S]*?<\/parameter>/g, "").trim();
        }

        const toolCalls = assistantMsg.tool_calls;
        // Check if LLM used web_search or tavily-search but user intent matches an installed skill
        // Also check if SearchPreprocessor auto-executed a search (searchPreDone)
        const usedWebSearch = toolCalls && toolCalls.some(tc => {
          const args = JSON.stringify(tc.function.arguments || {});
          return tc.function.name === "web_search" ||
            (tc.function.name === "skill_execute" && args.includes("tavily")) ||
            tc.function.name === "scrapling_fetch";
        });
        const usedCiccSkill = toolCalls && toolCalls.some(tc => {
          const args = JSON.stringify(tc.function.arguments || {});
          return (tc.function.name === "skill_execute" && args.includes("cicc")) ||
            (tc.function.name === "shell_exec" && args.includes("cicc"));
        });
        const searchWasDone = usedWebSearch || searchPreDone;
        if (searchWasDone && !usedCiccSkill) {
          console.log(`[AgentModelExecutor] Search was done (preDone=${searchPreDone}, webSearch=${usedWebSearch}) but no CICC skill — will check for skill fallback`);
        }

        if (!toolCalls || toolCalls.length === 0) {
          // ── Fallback: auto-trigger skill_search for skill-install intents ──
          // When the LLM returns a chat reply without calling any tool, but the
          // user message semantically matches a skill-install or action intent,
          // we auto-trigger skill_search as a safety net.
          // Prefer semantic classification (embedding-based) over keyword matching.
          let shouldTriggerSkillSearch = false;
          const classifier = deps.semanticIntentClassifier;
          if (classifier) {
            try {
              const intent = await classifier.classifyIntent(message);
              if (intent && (intent.category === "skill_install" || intent.category === "action_task")) {
                console.log(`[AgentModelExecutor] Semantic intent="${intent.category}" score=${intent.score.toFixed(4)}, auto-triggering skill_search`);
                shouldTriggerSkillSearch = true;
              }
            } catch (err) { console.warn(`[AgentModelExecutor] Skill fallback error:`, err); /* best-effort */ }
          }
          // Fallback to keyword matching if semantic classifier is unavailable
          if (!shouldTriggerSkillSearch && !classifier) {
            const lowerMsg = (conversationMessages[conversationMessages.length - 1]?.content as string || "").toLowerCase();
            const skillIntentKeywords = ["install", "安装", "装一个", "装个", "技能", "skill"];
            shouldTriggerSkillSearch = skillIntentKeywords.some(kw => lowerMsg.includes(kw));
          }
          if (shouldTriggerSkillSearch && deps.registeredTools.has("skill_search")) {
            try {
              const searchTool = deps.registeredTools.get("skill_search")!;
              const searchResult = await searchTool.handler({ task: message });
              const searchStr = typeof searchResult === "string" ? searchResult : JSON.stringify(searchResult);
              if (finalReply) {
                finalReply += `\n\n🔍 自动技能搜索结果：\n${searchStr}`;
              } else {
                finalReply = `🔍 技能搜索结果：\n${searchStr}`;
              }
            } catch (err) {
              console.warn(`[AgentModelExecutor] Auto skill_search failed:`, err);
            }
          }
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
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch (parseErr) {
            console.warn(`[LLMCaller] Failed to parse tool arguments for ${toolName}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
            args = { _parseError: true, _rawArguments: tc.function.arguments?.slice(0, 200) };
          }
          onProgress?.({ type: "tool_call", phase: "tool_calling", detail: `正在执行工具: ${toolName}`, progress: 50 + Math.floor((toolCalls.indexOf(tc) / toolCalls.length) * 20), toolName, toolArgs: args, round: round + 1 });

          // ── Observability: start tool span ──
          let toolSpanId: string | undefined;
          if (deps.observability && deps.currentTraceId) {
            const span = deps.observability.startSpan(deps.currentTraceId, "tool", `tool:${toolName}`);
            toolSpanId = span.spanId;
            deps.observability.addSpanAttribute(deps.currentTraceId, span.spanId, "tool.name", toolName);
          }

          // ── Guardrails: tool call validation ──
          let toolResult: string = "";
          let toolErrored = false;
          let toolError: string | undefined;
          if (deps.checkToolGuardrail) {
            const toolCheck = deps.checkToolGuardrail(toolName, args);
            if (!toolCheck.passed && toolCheck.severity === "high") {
              toolResult = JSON.stringify({ error: `[工具安全拦截] ${toolCheck.reason}` });
              toolErrored = true;
              toolError = toolCheck.reason;
              // Skip actual tool execution — will be handled below
            }
          }

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

            // If we've already had a HITL rejection in this session,
            // skip the approval request entirely (instant reject) to avoid
            // repeated timeouts that cause the overall request to time out.
            if (hitlRejectCount >= 1) {
              console.log(`[AgentModelExecutor] HITL: Fast-rejecting tool "${toolName}" (${hitlRejectCount} prior rejections in session)`);
              conversationMessages.push({
                role: "tool",
                tool_call_id: tc.id,
                name: toolName,
                content: JSON.stringify({
                  skipped: true,
                  reason: "rejected_by_user",
                  hint: `Previous ${riskLevel}-risk operations were not approved. Do NOT attempt any more high/critical-risk tools (shell_exec, file_modify, file_delete, browser_navigate). Respond to the user directly without executing tools.`,
                }),
              });
              continue;
            }

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
              hitlRejectCount++;
              console.log(`[AgentModelExecutor] HITL: Tool "${toolName}" rejected (timeout or user denied, total rejections: ${hitlRejectCount})`);
              // Store the rejected command for potential chat-based approval
              if (toolName === "shell_exec" && args.command && deps.pendingApprovalCommands) {
                deps.pendingApprovalCommands.set(sessionId, {
                  command: String(args.command),
                  rejectedAt: Date.now(),
                });
                console.log(`[AgentModelExecutor] Stored pending approval command for session "${sessionId}": ${args.command}`);
              }
              conversationMessages.push({
                role: "tool",
                tool_call_id: tc.id,
                name: toolName,
                content: JSON.stringify({
                  skipped: true,
                  reason: "rejected_by_user",
                  hint: `The user did not approve this ${riskLevel}-risk operation. Tell the user what you wanted to do and that they can reply "同意" or "approve" to allow it. Do NOT retry the command.`,
                }),
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

          let rawResult: unknown = undefined;
          let cacheHit = false;

          // ── Retry with exponential backoff for network tools ──
          // Network tools (web_search, web_fetch, etc.) are prone to transient
          // failures (5xx, timeout, rate-limit). Retry up to 2 times with
          // 1s → 2s backoff. Non-network tools (file, shell) are not retried
          // because they may not be idempotent.
          const NETWORK_TOOLS = new Set([
            "web_search", "web_fetch", "fetch_node_page", "scrapling_fetch",
            "browser_search", "browser_navigate", "browser_fetch_json",
            "browser_launch", "browser_login",
          ]);
          const MAX_RETRIES = NETWORK_TOOLS.has(toolName) ? 2 : 0;
          const isNetworkTool = NETWORK_TOOLS.has(toolName);

          // ── Guardrails: skip tool execution if blocked ──
          if (toolErrored && toolError) {
            // Tool was blocked by guardrails — skip execution, push result directly
          } else if (toolEntry) {
            // ── Parameter schema validation ──
            const paramError = validateToolParams(toolName, args, toolEntry.definition);
            if (paramError) {
              toolResult = JSON.stringify({
                error: paramError,
                suggestion: "Check the parameter names and types against the tool's schema. Make sure all required parameters are provided with correct types.",
                validationError: true,
                toolName,
              });
              toolErrored = true;
              toolError = paramError;
              console.warn(`[AgentModelExecutor] Parameter validation failed for "${toolName}": ${paramError}`);
            } else {
            // ── Circuit breaker check ──
            if (isToolTripped(toolName)) {
              toolResult = JSON.stringify({
                error: `Tool "${toolName}" is temporarily disabled due to repeated failures`,
                suggestion: "This tool has failed multiple times in a row. Try an alternative tool or approach. The tool will be re-enabled automatically after a cooldown period.",
                circuitBreaker: true,
                toolName,
              });
              toolErrored = true;
              toolError = `Circuit breaker: ${toolName} is tripped`;
              console.warn(`[AgentModelExecutor] Circuit breaker: skipping ${toolName}`);
            } else {
            try {
              // ── Idempotency check for write operations ──
              let idempotencyHit = false;
              if (IDEMPOTENT_TOOLS.has(toolName)) {
                const idemKey = getIdempotencyKey(toolName, args);
                const idemEntry = idempotencyCache.get(idemKey);
                if (idemEntry && Date.now() - idemEntry.timestamp < IDEMPOTENCY_TTL) {
                  console.log(`[AgentModelExecutor] Idempotency hit: ${toolName} (skipping duplicate write)`);
                  toolResult = idemEntry.result;
                  toolErrored = false;
                  cacheHit = true; // treat as cache hit to skip further processing
                  // Parse the cached result as rawResult for downstream processing
                  try { rawResult = JSON.parse(idemEntry.result); } catch { rawResult = idemEntry.result; }
                  idempotencyHit = true;
                }
              }
              if (!idempotencyHit && skipWithResult !== undefined) {
                rawResult = skipWithResult;
                toolResult = JSON.stringify(skipWithResult);
              } else if (!idempotencyHit) {
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

                  // Execute with retry for network tools
                  let lastExecError: Error | null = null;
                  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                    try {
                      if (attempt > 0) {
                        const backoffMs = Math.pow(2, attempt - 1) * 1000;
                        console.log(`[AgentModelExecutor] Retrying tool "${toolName}" (attempt ${attempt + 1}/${MAX_RETRIES + 1}) after ${backoffMs}ms backoff`);
                        await new Promise(resolve => setTimeout(resolve, backoffMs));
                      }
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
                          if (attempt > 0) span.setAttribute("tool.retry_attempt", attempt);
                          await toolExecFn();
                        });
                      } else {
                        await toolExecFn();
                      }
                      lastExecError = null;
                      break; // success — exit retry loop
                    } catch (retryErr: unknown) {
                      lastExecError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
                      // Don't retry on non-recoverable errors (DNS failure, auth errors, etc.)
                      const errMsg = lastExecError.message;
                      const isNonRecoverable = errMsg.includes("ENOTFOUND") || errMsg.includes("getaddrinfo");
                      if (isNonRecoverable || attempt >= MAX_RETRIES) {
                        if (attempt < MAX_RETRIES) {
                          console.warn(`[AgentModelExecutor] Tool "${toolName}" non-recoverable error, skipping retry: ${errMsg}`);
                        }
                        break;
                      }
                      if (attempt < MAX_RETRIES) {
                        console.warn(`[AgentModelExecutor] Tool "${toolName}" attempt ${attempt + 1} failed: ${errMsg}, will retry`);
                      }
                    }
                  }
                  if (lastExecError) throw lastExecError;
                  toolResult = JSON.stringify(rawResult);
                  if (toolResult && typeof toolResult === "string" && toolResult.length > 0) {
                    // Record in idempotency cache for write operations
                    if (IDEMPOTENT_TOOLS.has(toolName)) {
                      const idemKey = getIdempotencyKey(toolName, args);
                      idempotencyCache.set(idemKey, { result: toolResult, timestamp: Date.now() });
                      cleanIdempotencyCache();
                    }
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
              recordToolSuccess(toolName);
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
              const errMsg = err instanceof Error ? err.message : String(err);
              // Build a structured, actionable error message that helps the LLM
              // self-correct rather than just repeating the same failed call.
              const isTimeout = errMsg.includes("timed out");
              const isNotFound = errMsg.includes("not found") || errMsg.includes("404");
              const isAuth = errMsg.includes("401") || errMsg.includes("403") || errMsg.includes("auth");
              const isNetwork = errMsg.includes("ECONNREFUSED") || errMsg.includes("ENOTFOUND") || errMsg.includes("fetch failed");

              let suggestion = "";
              if (isTimeout) {
                suggestion = "Suggestion: The operation timed out. Try a simpler query, reduce the scope, or use a different tool.";
              } else if (isNotFound) {
                suggestion = "Suggestion: The resource was not found. Verify the URL/path is correct, or try a different search query.";
              } else if (isAuth) {
                suggestion = "Suggestion: Authentication failed. This resource requires credentials. Try a public alternative or inform the user.";
              } else if (isNetwork) {
                suggestion = "Suggestion: Network error. The remote server may be down. Try again later or use a different source.";
              } else {
                suggestion = "Suggestion: Try different parameters, use an alternative tool, or break the task into smaller steps.";
              }

              toolResult = JSON.stringify({
                error: errMsg,
                suggestion,
                retried: isNetworkTool && MAX_RETRIES > 0,
                toolName,
              });
              toolErrored = true;
              toolError = errMsg;
              recordToolFailure(toolName);
              console.warn(`[AgentModelExecutor] Tool "${toolName}" failed after ${isNetworkTool ? MAX_RETRIES + 1 : 1} attempt(s):`, errMsg);
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
            } // end circuit-breaker else
            } // end parameter-validation else
          } else {
            toolResult = JSON.stringify({
              error: `Tool "${toolName}" is not registered`,
              suggestion: "Check the tool name for typos. Use only tools that are available in your tool list. If you need a capability not available, inform the user.",
              toolName,
            });
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

          // ── Record tool execution trace for reflection ──
          if (deps.recordToolTrace) {
            deps.recordToolTrace(sessionId, toolName, args, toolResult.slice(0, 500), !toolErrored, Date.now() - toolStartTime, toolError);
          }

          // ── Stale Context: record tool result timestamp ──
          if (deps.recordStaleContext) {
            deps.recordStaleContext(sessionId, toolName);
          }

          // ── Observability: end tool span ──
          if (deps.observability && deps.currentTraceId && toolSpanId) {
            deps.observability.addSpanAttribute(deps.currentTraceId, toolSpanId, "tool.success", !toolErrored);
            deps.observability.endSpan(deps.currentTraceId, toolSpanId, toolErrored ? "error" : "ok");
          }

          // ── Update planning step status ──
          if (deps.updatePlanStep) {
            deps.updatePlanStep(sessionId, toolName, {
              status: toolErrored ? "failed" : "completed",
              result: toolResult.slice(0, 200),
              error: toolError,
            });
          }

          // ── Reflection: check if we should reflect after this tool call ──
          if (deps.checkAndReflect && toolCallCount > 0 && (toolCallCount + 1) % 3 === 0) {
            try {
              const reflectionResult = await deps.checkAndReflect(sessionId);
              if (reflectionResult) {
                if (reflectionResult.shouldReplan) {
                  // Inject replan hint into conversation
                  conversationMessages.push({
                    role: "system",
                    content: `[反思] ${reflectionResult.analysis}\n建议: ${reflectionResult.nextStepSuggestion || "重新规划任务"}`,
                  });
                } else if (reflectionResult.shouldRetry && reflectionResult.retrySuggestion) {
                  // Inject retry hint
                  conversationMessages.push({
                    role: "system",
                    content: `[反思] ${reflectionResult.analysis}\n重试建议: ${reflectionResult.retrySuggestion}`,
                  });
                }
              }
            } catch (reflectErr) {
              console.warn(`[LLMCaller] Reflection check failed: ${reflectErr}`);
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

        // ── Fallback: auto-execute installed skill when LLM used web_search instead ──
        // When the LLM chose web_search over an installed skill, and the user intent
        // matches an installed skill, we auto-execute the skill's script and store
        // the result to append to the final reply later.
        if (searchWasDone && !usedCiccSkill && deps.registeredTools.has("skill_search")) {
          try {
            const classifier = deps.semanticIntentClassifier;
            let shouldAutoExecute = false;
            if (classifier) {
              const intent = await classifier.classifyIntent(message);
              console.log(`[AgentModelExecutor] Skill fallback intent: category=${intent?.category} score=${intent?.score}`);
              if (intent && intent.category === "action_task" && intent.score > 0.6) {
                shouldAutoExecute = true;
              }
            } else {
              console.log(`[AgentModelExecutor] Skill fallback: no semantic classifier available`);
            }
            if (shouldAutoExecute) {
              const searchTool = deps.registeredTools.get("skill_search")!;
              const searchResult = await searchTool.handler({ task: message });
              console.log(`[AgentModelExecutor] Skill fallback search result:`, JSON.stringify(searchResult).slice(0, 500));
              const searchObj = typeof searchResult === "object" ? searchResult as Record<string, unknown> : null;
              if (searchObj?.installed && searchObj.commands && Array.isArray(searchObj.commands)) {
                const commands = searchObj.commands as string[];
                const skillDir = searchObj.installPath
                  ? String(searchObj.installPath).replace(/SKILL\.md$/i, "").replace(/[/\\]$/, "")
                  : "";
                // Execute the first relevant command
                const cmd = commands[0];
                if (cmd && skillDir) {
                  const resolvedCmd = cmd.replace(/\{baseDir\}/g, skillDir);
                  console.log(`[AgentModelExecutor] Auto-executing installed skill command: ${resolvedCmd}`);
                  const shellExecTool = deps.registeredTools.get("shell_exec");
                  if (shellExecTool) {
                    try {
                      const execResult = await shellExecTool.handler({ command: resolvedCmd, timeout: "30" });
                      const execStr = typeof execResult === "string" ? execResult : JSON.stringify(execResult);
                      const execObj = typeof execResult === "object" ? execResult as Record<string, unknown> : null;
                      if (execObj?.success !== false && execStr && execStr.length > 10) {
                        skillFallbackResult = `\n\n---\n📊 **来自${searchObj.skillName || '技能'}的实时数据：**\n\`\`\`\n${execStr.slice(0, 3000)}\n\`\`\``;
                      }
                    } catch (err) {
                      console.warn(`[AgentModelExecutor] Auto skill execution failed: ${err}`);
                    }
                  }
                }
              }
            }
          } catch (err) { console.warn(`[AgentModelExecutor] Skill fallback error:`, err); /* best-effort */ }
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
        // Append skill fallback result if available
        if (skillFallbackResult) {
          finalReply += skillFallbackResult;
        }
        // ── Guardrails: output validation ──
        if (deps.checkOutputGuardrail && finalReply) {
          const outputCheck = deps.checkOutputGuardrail(finalReply);
          if (!outputCheck.passed && outputCheck.severity === "high") {
            finalReply = `[输出安全过滤] ${outputCheck.reason}`;
          } else if (outputCheck.sanitizedOutput) {
            finalReply = outputCheck.sanitizedOutput;
          }
        }

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
