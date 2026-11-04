/**
 * LLM Caller — extracted from AgentModelExecutor
 *
 * Standalone functions for the core LLM calling loop with provider failover,
 * tool execution, token budget control, plugin hooks, caching, timeout,
 * and observability.
 */

import type { ServiceRegistry, PersonaConfig } from "@evoclaw/core";
import { Semaphore, buildChatCompletionsUrl, buildAnthropicMessagesUrl } from "@evoclaw/core";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { reconcileCompletionTruthfulness, extractToolFailure, extractEmptyResult, buildUserFacingCorrection } from "./completion-truthfulness";
import { shouldTriggerVerificationGate, buildVerifyOnStopNudge, buildVerifyOnStopNudgeWithHooks, extractChangedPaths } from "./verification-stop";
import { sessionCalledKanbanTerminal, TERMINAL_KANBAN_TOOLS, buildKanbanStopNudge } from "./kanban-stop";
import { RunawayStreamWatch, REPETITION_LOOP_INTERRUPTED } from "./repetition-guard";
import { ThinkingTrace, type ThinkingStep } from "./thinking-trace";
import { detectPrematureStop, buildContinuationDirective } from "./auto-continuation";
import { runTurnFinalizer, type ToolExecutionStats, type ConversationMessageLite } from "./turn-finalizer";
import { getTurnLivenessWatchdog } from "./turn-liveness";
import { isCreationTool } from "./tool-capability-catalog";
import { resolveContextWindow } from "./model-context-window";
import { estimateMessagesTokens } from "./error-classifier";
import { estimateTokensCached, estimateMessagesTokensCached } from "./token-estimate-cache";

// ★ P1 优化（建议4）：异步日志缓冲——process.stdout.write 是同步 I/O，
//   高频调用（每轮 5-15 条）会阻塞主线程。引入 16ms 批量刷新队列，
//   将同步 I/O 变异步，每轮省 ~5-15ms。
const _logQueue: string[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function asyncLog(msg: string): void {
  _logQueue.push(msg);
  if (!_flushTimer) {
    _flushTimer = setTimeout(() => {
      const batch = _logQueue.join("\n");
      _logQueue.length = 0;
      _flushTimer = null;
      process.stdout.write(batch + "\n");
    }, 16); // ~60fps 刷新
    if (_flushTimer.unref) _flushTimer.unref();
  }
}
import type { Span } from "@opentelemetry/api";
import type { ChatContent } from "@evoclaw/plugin-sdk";
import type { ModelConfig, ProviderConfig, ToolDefinition, AgentProgressCallback } from "./types";
import type { ClassifiedError } from "./error-classifier";
import type { LedgerEntry, LedgerEventType } from "./event-ledger";
import { classifyLLMError, LLMErrorType, formatClassifiedErrorForUser } from "./error-classifier";
import { stampFailure, terminalFailureCopy, type TerminalFailureEvidence } from "./turn-failure-copy";
import { taskStatusTracker } from "./task-status-tracker";
import type { ExecutionCheckpointStore } from "./execution-checkpoint";
import type { HumanApprovalManager } from "./human-approval";
import { summarizeToolResult as summarizeToolResultFn, stripWebNoise as stripWebNoiseImpl } from "./text-processor";
import { getToolOutputPruner } from "./tool-output-pruner";
import { hasActionIntent as hasActionIntentFn } from "./quick-reply";
import { needsCompaction as needsCompactionFn, compactConversationHistory as compactConversationHistoryFn, persistSessionTurn as persistSessionTurnFn, persistToolExecutionCheckpoint as persistToolCheckpointFn, closeInterruptedToolSequence as closeInterruptedToolSequenceFn, type SessionPersistenceDeps, type SessionHistoryEntry } from "./session-persistence";
import { applyAnthropicCacheControl } from "./prompt-cache";
import { normalizeUsage } from "./usage-pricing";
import { applyReasoningToggle } from "./reasoning-toggle";
import { retryAsync, jitteredBackoff } from "./retry-utils";
import { getStreamingRecoveryManager } from "./streaming-recovery";
import { getVerificationEvidenceStore, classifyVerificationCommand } from "./verification-evidence";
import { withDeadline, getToolSuspectTracker, type SuspectableBackend } from "./deadline";
import { isOverloadLadderEligible, computeOverloadWait, OVERLOAD_RECOVERY_MAX } from "./overload-recovery";
import { getErrorRecoveryExecutor, type RecoveryMessage } from "./error-recovery-executor";

/**
 * 从 CallLLMOnceResult.usageDetails 提取缓存命中/写入 token（provider 侧真值）。
 * 各 record() 调用点共用，避免四处各写一遍 normalizeUsage 选项拼装。
 * 无 usageDetails 时返回 undefined 字段（tracker 按 ?? 0 兜底）。
 *
 * ★ P0-5（2026-10-27）：**网关未上报任何缓存字段时返回 {}**。
 *   normalizeUsage 对「字段缺失」和「字段存在且为 0」都落成 cacheReadTokens=0，
 *   若不区分，OpenAI 兼容网关只要不回 cached_tokens，命中率指标就会被
 *   「0 命中 + 全额未命中」污染成恒为 0%——看起来"缓存全废"，实际是"网关不上报"。
 *   用「字段是否存在」区分这两种情况：不上报就不发指标，命中率 gauge 保持沉默，
 *   这本身就回答了「这些网关到底回不回传 cached_tokens」。
 *
 *   反之，**字段存在且为 0 必须原样保留 0**（不能 `|| undefined`）：会话首轮
 *   cache 必然冷启动，网关回 cached_tokens:0，这一轮是「0 命中 + 全额未命中」，
 *   正是命中率分母的重要组成部分。旧实现把它塌成 undefined → 指标不发 →
 *   分母只统计有命中的轮次 → 命中率虚高到接近 100%。
 *   （真实数据佐证：data/token-usage/records.json 里 4273 条记录中
 *   `cacheHitTokens` 要么是正数、要么整个字段缺失，**从未出现过显式 0**——
 *   正是 `|| undefined` 把 0 吞掉的痕迹。）
 */
function cacheExtrasFromResult(
  result: { usageDetails?: unknown },
  providerName: string,
): { cacheHitTokens?: number; cacheWriteTokens?: number } {
  if (!result.usageDetails) return {};
  const raw = result.usageDetails as Record<string, unknown>;
  const reportsCache =
    typeof raw.cache_read_input_tokens === "number" ||
    typeof raw.cache_creation_input_tokens === "number" ||
    (typeof raw.prompt_tokens_details === "object" && raw.prompt_tokens_details !== null) ||
    (typeof raw.input_tokens_details === "object" && raw.input_tokens_details !== null);
  if (!reportsCache) return {};
  const canon = normalizeUsage(result.usageDetails, { provider: providerName });
  return {
    cacheHitTokens: canon.cacheReadTokens,
    cacheWriteTokens: canon.cacheWriteTokens,
  };
}
import { getProviderSkipList } from "./provider-skip-list";
import { ToolCallLoopDetector } from "./guardrails";
import { validateToolResult } from "./tool-types";
import { PromptRegistry } from "./prompt-registry";
import * as https from "https";
import * as http from "http";
import * as crypto from "crypto";

// ── Native HTTPS fetch ──
// Uses Node.js native https/http modules instead of undici fetch() to avoid
// triggering Windows Jump List temp file creation (CustomDestinations/*.temp)
// which gets killed by TRAE Sandbox.
//
// Implementation notes:
// - Avoids Readable.toWeb() which has caused crashes under heavy load; instead
//   buffers the response body in-memory (safe for LLM JSON/SSE payloads).
// - Reuses a single keep-alive agent to reduce connection overhead.
// - Defensive abort handling and error propagation.

export interface NativeFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

// Share keep-alive agents to avoid exhausting ephemeral ports and reduce TLS
// handshake overhead during burst LLM calls.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

/**
 * 销毁共享的 keep-alive HTTP/HTTPS agent。
 * 应在进程优雅关闭时调用，防止 socket 文件描述符泄漏。
 */
export function destroyHttpAgents(): void {
  try { httpAgent.destroy(); } catch { /* ignore */ }
  try { httpsAgent.destroy(); } catch { /* ignore */ }
}

export interface NativeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Request timeout in milliseconds. Defaults to 0 (no timeout). */
  timeout?: number;
}

export async function nativeFetch(
  url: string,
  options: NativeFetchOptions = {}
): Promise<NativeFetchResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const lib = isHttps ? https : http;

    // Build an internal abort controller when a timeout is requested so that
    // connection-establishment and response-body delays are both bounded.
    const timeoutMs = options.timeout ?? 0;
    const internalController = timeoutMs > 0 ? new AbortController() : null;
    const timeoutId = internalController
      ? (() => {
          const t = setTimeout(() => internalController.abort(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
          if (t.unref) t.unref();
          return t;
        })()
      : null;

    const externalSignal = options.signal ?? null;
    let timedOut = false;
    let externallyAborted = false;
    const onAbort = (reason?: unknown) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (typeof reason === "string" && reason.startsWith("Request timeout")) {
        timedOut = true;
      } else if (reason instanceof Error && reason.message?.startsWith("Request timeout")) {
        timedOut = true;
      } else {
        externallyAborted = true;
      }
      req.destroy();
    };

    const cleanupAbortListeners = () => {
      if (internalController) {
        internalController.signal.removeEventListener("abort", onAbort);
      }
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onAbort);
      }
    };

    const req = lib.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "GET",
        headers: options.headers || {},
        agent: isHttps ? httpsAgent : httpAgent,
      },
      (res) => {
        if (timeoutId) clearTimeout(timeoutId);

        const status = res.statusCode || 0;
        const ok = status >= 200 && status < 300;
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          cleanupAbortListeners();
          const buffer = Buffer.concat(chunks);
          const bodyStream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(buffer));
              controller.close();
            },
          });

          const response: NativeFetchResponse = {
            ok,
            status,
            statusText: res.statusMessage || "",
            body: bodyStream,
            text: async () => buffer.toString("utf-8"),
            json: async () => {
              const text = buffer.toString("utf-8");
              try {
                return JSON.parse(text);
              } catch (err) {
                throw new Error(
                  `Response body is not valid JSON: ${err instanceof Error ? err.message : String(err)} (body preview: ${text.slice(0, 200)})`,
                  { cause: err },
                );
              }
            },
          };
          resolve(response);
        });
        res.on("error", (err) => {
          if (timeoutId) clearTimeout(timeoutId);
          cleanupAbortListeners();
          reject(err);
        });
      }
    );

    if (options.body) {
      req.write(options.body);
    }

    if (internalController) {
      internalController.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (externalSignal) {
      if (externalSignal.aborted) {
        req.destroy();
        if (timeoutId) clearTimeout(timeoutId);
        reject(new Error("Request aborted"));
        return;
      }
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }

    req.on("error", (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      cleanupAbortListeners();
      if (timedOut) {
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
        return;
      }
      if (externallyAborted) {
        reject(new Error("Request aborted"));
        return;
      }
      reject(err);
    });

    req.end();
  });
}

// ── Provider health tracker ──
// Enriched circuit breaker that tracks consecutive failures, total success /
// failure counts, average response time, and last activity timestamps. Used
// by the provider failover loop to skip unhealthy providers and to expose
// observability metrics.

export interface ProviderHealthSnapshot {
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  averageResponseMs: number;
  tripped: boolean;
}

export class ProviderHealthTracker {
  private providers = new Map<
    string,
    {
      consecutiveFailures: number;
      totalFailures: number;
      totalSuccesses: number;
      lastFailureAt: number | null;
      lastSuccessAt: number | null;
      responseTimesMs: number[];
      trippedAt: number | null;
    }
  >();

  constructor(
    private maxConsecutiveFailures = 2,
    private cooldownMs = 30_000, // 2026-10-26: 从 120s 降为 30s — 实测 120s 冷却导致主 provider 失败后长时间不可用
    private responseTimeWindowSize = 10
  ) {}

  private getEntry(providerId: string) {
    let entry = this.providers.get(providerId);
    if (!entry) {
      entry = {
        consecutiveFailures: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        lastFailureAt: null,
        lastSuccessAt: null,
        responseTimesMs: [],
        trippedAt: null,
      };
      this.providers.set(providerId, entry);
    }
    return entry;
  }

  recordSuccess(providerId: string, responseMs?: number): void {
    const entry = this.getEntry(providerId);
    entry.consecutiveFailures = 0;
    entry.totalSuccesses += 1;
    entry.lastSuccessAt = Date.now();
    entry.trippedAt = null;
    if (responseMs !== undefined && responseMs >= 0) {
      entry.responseTimesMs.push(responseMs);
      if (entry.responseTimesMs.length > this.responseTimeWindowSize) {
        entry.responseTimesMs.shift();
      }
    }
  }

  recordFailure(providerId: string): void {
    const entry = this.getEntry(providerId);
    entry.consecutiveFailures += 1;
    entry.totalFailures += 1;
    entry.lastFailureAt = Date.now();
    if (entry.consecutiveFailures >= this.maxConsecutiveFailures && !entry.trippedAt) {
      entry.trippedAt = Date.now();
      process.stderr.write(
        `[LLMCaller] Provider "${providerId}" circuit breaker tripped after ${entry.consecutiveFailures} consecutive failures — cooldown ${this.cooldownMs / 1000}s\n`
      );
    }
  }

  isTripped(providerId: string): boolean {
    const entry = this.providers.get(providerId);
    if (!entry || !entry.trippedAt) return false;
    if (Date.now() - entry.trippedAt > this.cooldownMs) {
      entry.trippedAt = null;
      entry.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  getSnapshot(providerId: string): ProviderHealthSnapshot {
    const entry = this.getEntry(providerId);
    const avgMs =
      entry.responseTimesMs.length > 0
        ? entry.responseTimesMs.reduce((a, b) => a + b, 0) / entry.responseTimesMs.length
        : 0;
    return {
      consecutiveFailures: entry.consecutiveFailures,
      totalFailures: entry.totalFailures,
      totalSuccesses: entry.totalSuccesses,
      lastFailureAt: entry.lastFailureAt,
      lastSuccessAt: entry.lastSuccessAt,
      averageResponseMs: Math.round(avgMs),
      tripped: this.isTripped(providerId),
    };
  }

  reset(providerId: string): void {
    this.providers.delete(providerId);
  }

  resetAll(): void {
    this.providers.clear();
  }
}

// Module-level tracker shared by the provider failover loop.
const providerHealthTracker = new ProviderHealthTracker();
// ★ P0-5：稳定性评估计数器（每 10 次评估输出命中率摘要行）。
let stabilityEvalCount = 0;

function isProviderTripped(providerName: string): boolean {
  return providerHealthTracker.isTripped(providerName);
}

function recordProviderFailure(providerName: string): void {
  providerHealthTracker.recordFailure(providerName);
}

function recordProviderSuccess(providerName: string, responseMs?: number): void {
  providerHealthTracker.recordSuccess(providerName, responseMs);
}

// ── Circuit breaker for tool execution ──
// Tracks consecutive failures per tool. After MAX_CONSECUTIVE_FAILURES,
// the tool is "tripped" (disabled) for COOLDOWN_MS. This prevents the
// LLM from repeatedly calling a broken tool and wasting tokens.

const MAX_CONSECUTIVE_FAILURES = 3;
const COOLDOWN_MS = 60_000; // 1 minute cooldown after tripping

const toolFailureTracker = new Map<string, { count: number; trippedAt: number | null }>();

// ── 工具执行并发控制信号量 ──
// 灵感来自 hermes-agent 的 semaphore 限制：防止 LLM 返回大量并行工具调用时
// 耗尽 socket/文件句柄/浏览器实例。全局上限防止资源耗尽，浏览器串行化防止
// Playwright 冲突，网络工具上限防止触发对端限流。
const globalToolSemaphore = new Semaphore(5);
const browserToolMutex = new Semaphore(1);
const networkToolSemaphore = new Semaphore(3);

// ── Provider safety-filter rejection detection ──
// Some remote LLM providers (e.g. Mimo) return a plain-text refusal such as
// "The request was rejected because it was considered high risk" instead of
// using HTTP 4xx. Treat those as provider failures so we can fail over.

const PROVIDER_SAFETY_REJECTION_PATTERNS = [
  "The request was rejected because it was considered high risk",
  "request was rejected because it was considered high risk",
  "was rejected because it was considered high risk",
  "considered high risk",
  "rejected due to safety",
  "content filter triggered",
  "input was blocked",
  "request was blocked",
];

export function isProviderSafetyRejection(content: string | null | undefined): boolean {
  if (!content) return false;
  const lower = content.trim().toLowerCase();
  return PROVIDER_SAFETY_REJECTION_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

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
          // 安全：外部 API 可能返回非数字字符串（如 "N/A"），Number() 会产生 NaN 导致 toFixed() 输出 "NaN"
          const prevCloseRaw = Number(item.previous_close ?? 0);
          const prevClose = Number.isFinite(prevCloseRaw) ? prevCloseRaw : 0;
          const currentPriceRaw = Number(item.current_price ?? 0);
          const currentPrice = Number.isFinite(currentPriceRaw) ? currentPriceRaw : 0;
          const changePercent = prevClose > 0 ? ((currentPrice - prevClose) / prevClose * 100) : 0;
          const amountRaw = Number(item.amount ?? 0);
          const amount = Number.isFinite(amountRaw) ? amountRaw : 0;
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
    process.stderr.write(`[CircuitBreaker] Tool "${toolName}" tripped after ${tracker.count} consecutive failures. Cooldown: ${COOLDOWN_MS / 1000}s\n`);
  }
  toolFailureTracker.set(toolName, tracker);
}

function recordToolSuccess(toolName: string): void {
  toolFailureTracker.delete(toolName);
}

// ── Tool parameter validation ──
// Validates that LLM-generated tool parameters match the expected schema.
// Returns a descriptive error if validation fails, or null if OK.

/**
 * 归一化工具参数 schema —— 兼容两种注册风格：
 *   - flat（主流，如 browser_* / shell_*）：parameters = { 参数名: { type, description, ... } }
 *   - wrapped（JSON Schema 原生 / Hermes 风格，如 delegate_task/text_to_speech）：
 *     parameters = { type: "object", properties: {...}, required: [...] }
 * 统一返回 { properties, required }；flat 的 required 为 undefined（走逐属性启发式）。
 *
 * ★ 接线修复（2026-10-29）：此前 wrapped 风格直接进入 buildOpenAITools/validateToolParams
 *   的 flat 迭代，生成 {type, properties, required} 三个字符串参数的损坏 schema
 *   （delegate_task 的 tasks/action 对模型完全不可见）。
 *
 * ★ P1 修复（2026-10-30）：此前解包时丢弃顶层 required 数组，导致 delegate_task 的
 *   tasks 被逐属性启发式误判为必填（顶层 required:[] 表达"无参数无条件必填"）。
 *   现保留顶层 required 数组，wrapped schema 的必填性以顶层数组为准。
 */
export interface NormalizedToolParameters {
  properties: Record<string, unknown>;
  /** 顶层 required 数组（wrapped schema 原生表达）；undefined 表示 flat schema 走逐属性启发式 */
  required: string[] | undefined;
}

export function normalizeToolParameters(
  parameters: Record<string, unknown> | undefined
): NormalizedToolParameters {
  if (
    parameters &&
    typeof parameters === "object" &&
    parameters.type === "object" &&
    parameters.properties &&
    typeof parameters.properties === "object"
  ) {
    const req = Array.isArray(parameters.required) ? (parameters.required as string[]) : undefined;
    return { properties: parameters.properties as Record<string, unknown>, required: req };
  }
  return { properties: parameters ?? {}, required: undefined };
}

/**
 * ★ 2026-10-30 修复（v6 压测 Agnes-china 400 错误）：递归剥离 schema 中所有层级的
 *   required 字段。JSON Schema 规范中 required 是对象级别字段（字符串数组），
 *   不是属性内部字段。OpenAI 兼容网关严格校验：属性内部的 required: true/false
 *   会导致 400 "True/False is not of type 'array'"。
 *
 *   工具定义使用了 flat 风格的 required: true/false 在属性内部——包括嵌套在
 *   items.properties 内部的子属性（如 document-tools.ts 的表格行/单元格定义）。
 *   递归处理：properties → items → additionalProperties → allOf → anyOf → oneOf。
 */
function stripNestedRequired(schema: Record<string, unknown>): void {
  if (schema.required !== undefined) {
    delete schema.required;
  }
  if (schema.properties && typeof schema.properties === "object") {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    for (const key of Object.keys(props)) {
      stripNestedRequired(props[key]);
    }
  }
  if (schema.items && typeof schema.items === "object") {
    stripNestedRequired(schema.items as Record<string, unknown>);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    stripNestedRequired(schema.additionalProperties as Record<string, unknown>);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const arr = schema[key];
    if (Array.isArray(arr)) {
      for (const sub of arr) {
        if (sub && typeof sub === "object") {
          stripNestedRequired(sub as Record<string, unknown>);
        }
      }
    }
  }
}

export function validateToolParams(
  toolName: string,
  args: Record<string, unknown>,
  definition: { parameters: Record<string, unknown> }
): string | null {
  const { properties: params, required: topLevelRequired } = normalizeToolParameters(definition.parameters);
  for (const [key, schema] of Object.entries(params)) {
    const p = schema as Record<string, unknown>;
    // wrapped schema 以顶层 required 数组为准；flat schema 走逐属性启发式
    const isRequired =
      topLevelRequired !== undefined
        ? topLevelRequired.includes(key)
        : p.required !== false && p.default === undefined && !/optional/i.test(String(p.description ?? ""));
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

      // 回归（2026-10-16 实例任务 worktemp.zip 汇总）：document / create_docx 的
      // paragraphs/tables 等 array 参数被模型以 JSON 字符串形式下发（工具参数序列化习惯），
      // 旧逻辑直接报 "wrong type: expected array, got string"，模型原样重试仍失败，成品文档无法生成。
      // 与 number/boolean 同原理：array/object 参数收到合法 JSON 字符串时自动解析。
      if ((expectedType === "array" || expectedType === "object") && typeof value === "string") {
        try {
          const parsed: unknown = JSON.parse(value);
          const matches =
            expectedType === "array"
              ? Array.isArray(parsed)
              : // object 期望必须是「非数组」对象（typeof [] === "object"，不排数组会误放行）
                parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
          if (matches) {
            args[key] = parsed; // auto-coerce
            continue;
          }
        } catch {
          // 不是合法 JSON → 落到下方真类型错误
        }
      }

      // 注：数字已在上面按 string→number 自动强制转换过，到这里类型不符即为真不符
      //（原条件里 `!(expectedType === "number" && actualType === "number")` 恒为 true，
      //  是无作用的死代码，已移除。）
      if (expectedType !== actualType) {
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
  /** contextTokens 是否来自本地估算（true 表示 provider 未上报 usage，为估算值） */
  contextTokensEstimated?: boolean;
  /** 当前模型真实的上下文窗口（分母），由 model-context-window 解析，已考虑用户设置 */
  contextLimit?: number;
  /** 分母来源：user | provider | catalog | fallback，供 UI 标注可信度 */
  contextLimitSource?: "user" | "provider" | "catalog" | "fallback";
  duration: number;
  permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>;
  toolsExecuted: boolean;
  files: Array<{ path: string; size: number; downloadUrl: string }>;
  /**
   * 终态失败盖码（hermes turn_failure_copy stamp_failure 语义）：
   * 终态失败结果必带 failure_reason（FailoverReason 值或站内码）+
   * failure_retryable，供错误呈现层给出具体描述而非 unknown。
   * 成功返回时两个字段均为 undefined。
   */
  failureReason?: string;
  failureRetryable?: boolean;
  /**
   * 本回合的**最终**思考轨迹快照（2026-10-11）。
   *
   * 由 gateway 放进终结 `done` 事件下发，作为「任务完成后还能展开看」的
   * 权威来源：它取自 return 的那一刻，因此包含了完成声明对账等**在流式
   * done 之后**才写入轨迹的条目，与落盘内容完全一致。
   * 没有它时，一旦模型没产出正文（走空回复/全 provider 失败分支），
   * 用户就既看不到轨迹、也收不到 done。
   */
  thinkingTrace?: ThinkingStep[];
}

export interface CallLLMOnceResult {
  message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
  tokensUsed: number;
  promptTokens: number;
  classifiedError?: ClassifiedError;
  /** Response time in milliseconds for observability and provider ranking. */
  responseMs?: number;
  /** provider 原始 usage 对象（未解析）——供 normalizeUsage 提取缓存命中 token。 */
  usageDetails?: unknown;
}

export interface ParseStreamingResponseResult {
  message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
  tokensUsed: number;
  promptTokens: number;
  /** Response time in milliseconds for observability and provider ranking. */
  responseMs?: number;
  /** provider 原始 usage 对象（未解析）——供 normalizeUsage 提取缓存命中 token。 */
  usageDetails?: unknown;
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
  registeredTools: Map<string, { definition: ToolDefinition; handler: (params: Record<string, unknown>) => Promise<unknown>; checkFn?: () => boolean; dynamicSchemaOverrides?: () => Partial<ToolDefinition> }>;
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
  /** 工作区根目录（agent-model-executor 的 workspacePath）。磁盘文件核验用它解析相对路径。 */
  workspacePath?: string;
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
  // ContextPruning manager (optional — enables soft trim and hard clear of tool results)
  contextPruningManager?: import("./context-pruning").ContextPruningManager;
  // Token usage tracker (optional — enables real-time token/cost tracking)
  tokenUsageTracker?: import("./token-usage-tracker").TokenUsageTracker;
  // 会话级工具组单调并集存储（P0-2：buildOpenAITools 的 baseTools 出参回写）
  toolGroupStore?: Map<string, Set<string>>;
  // Service-gated tools: TTL-cached check_fn evaluator (optional — filters unavailable tools before sending to LLM)
  // Inspired by hermes-agent's registry._check_fn_cached (30s TTL, fail-safe).
  checkFnEvaluator?: (checkFn: () => boolean) => boolean;
  // ★ P0-4：运行时缓存稳定性分析器（optional — 每轮 API 调用前评估 request prefix
  // 稳定性，检测 anti-pattern 并输出诊断日志）。未提供时跳过稳定性分析。
  promptCacheStability?: import("./prompt-cache-stability").PromptCacheStabilityManager;
  // ★ P0-5：volatile 区域起始索引（skills 消息/动态尾/user 消息在消息数组中的
  // 位置）。由 tryCallLLM 按布局 [sys, ...history, skills?, tail?, user] 记录，
  // Anthropic 原生路径据此把 volatile system 消息合并进 user 消息（避免 system
  // 参数逐轮变化毒化 history 缓存）。
  volatileSystemStartIdx?: number;
  // ★ P0-5：CacheTracer（optional — 记录每次 LLM 调用的真实 cache 命中 token
  // （provider usage cache_read_input_tokens），周期性输出 token 加权命中率）。
  // 未提供时跳过 trace 记录。
  cacheTracer?: import("./cache-trace").CacheTracer;
  // End-to-end cancellation signal (optional — aborts in-flight LLM calls and tool executions).
  // Set by AgentModelExecutor.abortSession(sessionId); propagated through callLLMOnce,
  // the tool execution retry loop, and HTTP transport (nativeFetch already accepts a signal).
  // When aborted, tryCallLLM stops dispatching new tool rounds and returns the best
  // reply accumulated so far (or a cancellation notice if nothing was produced yet).
  abortSignal?: AbortSignal;
}

// ── Helper: tool cache ──

/**
 * 生成可读的工具操作摘要（进度反馈用）。
 * 针对编程任务高频工具（file_write/delete, shell_exec 等）生成友好提示。
 */
function formatToolSummary(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "file_write": {
      const p = String(args.path || "");
      const content = String(args.content || "");
      const sizeKB = (content.length / 1024).toFixed(1);
      // action=modify 覆盖已有文件；create（默认）新建文件
      return args.action === "modify"
        ? `✏️ 修改文件: ${p} (${sizeKB} KB)`
        : `📝 创建文件: ${p} (${sizeKB} KB)`;
    }
    case "file_delete": {
      const p = String(args.path || "");
      return `🗑️ 删除文件: ${p}`;
    }
    case "file_read": {
      const p = String(args.path || "");
      return `📖 读取文件: ${p}`;
    }
    case "file_list": {
      const dir = String(args.path || String(args.dir || ""));
      return `📂 列出目录: ${dir || "."}`;
    }
    case "shell_exec": {
      const cmd = String(args.command || "");
      // 截断长命令
      const short = cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
      return `🔧 执行命令: ${short}`;
    }
    case "web_search": {
      const q = String(args.query || "");
      return `🔍 搜索: ${q}`;
    }
    case "web_fetch": {
      const url = String(args.url || "");
      return `🌐 获取网页: ${url.slice(0, 60)}`;
    }
    case "code_exec":
    case "python_exec": {
      const code = String(args.code || "");
      const firstLine = code.split("\n").find(l => l.trim().length > 0)?.trim() || "";
      const short = firstLine.length > 60 ? firstLine.slice(0, 60) + "..." : firstLine;
      return `🐍 执行代码: ${short}`;
    }
    default:
      return `🔧 执行工具: ${toolName}`;
  }
}

/**
 * 生成工具完成后的可读摘要（进度反馈用）。
 */
function formatToolResultSummary(toolName: string, args: Record<string, unknown>, result: string): string {
  // 尝试解析结果
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(result); } catch { /* not JSON */ }

  const success = parsed ? (parsed.success !== false) : !result.includes('"error"');

  switch (toolName) {
    case "file_write": {
      const p = String(args.path || "");
      // action=modify 覆盖已有文件；create（默认）新建文件
      return args.action === "modify"
        ? (success ? `✅ 已修改: ${p}` : `❌ 修改失败: ${p}`)
        : (success ? `✅ 已创建: ${p}` : `❌ 创建失败: ${p}`);
    }
    case "file_delete": {
      const p = String(args.path || "");
      return success ? `✅ 已删除: ${p}` : `❌ 删除失败: ${p}`;
    }
    case "file_read": {
      const p = String(args.path || "");
      return `✅ 已读取: ${p}`;
    }
    case "file_list": {
      const dir = String(args.path || String(args.dir || ""));
      // 尝试提取文件数量
      const count = parsed && Array.isArray(parsed.files) ? parsed.files.length : undefined;
      return count !== undefined ? `✅ 列出 ${count} 个文件` : `✅ 列出目录: ${dir || "."}`;
    }
    case "shell_exec": {
      const cmd = String(args.command || "");
      const short = cmd.length > 50 ? cmd.slice(0, 50) + "..." : cmd;
      // 尝试提取执行时间
      const duration = parsed?.duration as number | undefined;
      const timeStr = duration ? ` (${duration}ms)` : "";
      return success ? `✅ 命令完成${timeStr}: ${short}` : `❌ 命令失败: ${short}`;
    }
    case "web_search": {
      const q = String(args.query || "");
      const count = parsed?.results ? String(parsed.results).split(",").length : undefined;
      return count !== undefined ? `✅ 搜索完成: "${q}" (${count} 条结果)` : `✅ 搜索完成: "${q}"`;
    }
    case "web_fetch": {
      const url = String(args.url || "");
      return `✅ 已获取: ${url.slice(0, 60)}`;
    }
    default: {
      return success ? `✅ ${toolName} 完成` : `❌ ${toolName} 失败`;
    }
  }
}

// ── Helper: strip data URI prefix ──
// "data:image/png;base64,XXXX" → "XXXX"; returns "" if not a data URI.
// Used by the multimodal input path to extract raw base64 for audio/file parts.
function stripDataUriPrefix(dataUri: string): string {
  const idx = dataUri.indexOf("base64,");
  return idx >= 0 ? dataUri.slice(idx + 7) : "";
}

// ── Helper: parse MIME type from data URI ──
// "data:image/png;base64,..." → "image/png"; returns "" if not parseable.
// Used by provider adapters to avoid hardcoding MIME types.
export function parseMimeTypeFromDataUri(dataUri: string): string {
  const match = /^data:([^;,]+)/i.exec(dataUri);
  return match ? match[1] : "";
}

// ── Helper: find last message index with given role ──
// P0-5：易变内容（skills 段/动态尾）插入「最后一条 user 消息之前」时使用。
// 找不到返回 -1（调用方回退为 push 到末尾）。
//
// ★ P1 优化（建议3）：WeakMap 缓存——同一 messages 数组引用在单次 tryCallLLM
//   内被多次查询（prevUserIdx / pos），缓存避免重复 O(n) 扫描。
//   WeakMap 键为数组引用，数组被替换时自动失效，安全无内存泄漏。
const _lastIndexCache = new WeakMap<Array<{ role: string; content?: unknown }>, Map<string, number>>();

function lastIndexOfRole(
  messages: Array<{ role: string; content?: unknown }>,
  role: string,
): number {
  let cache = _lastIndexCache.get(messages);
  if (!cache) {
    cache = new Map();
    _lastIndexCache.set(messages, cache);
  }
  const cached = cache.get(role);
  if (cached !== undefined) return cached;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) {
      cache.set(role, i);
      return i;
    }
  }
  cache.set(role, -1);
  return -1;
}

// ── Helper: Anthropic 原生路径 volatile system 消息合并（P0-5）──
// convertMessagesToAnthropic 把全部 system 消息提升进顶层 system 参数，而
// Anthropic 缓存流 = system + messages 连续前缀——逐轮变化的 system 参数字节
// 会毒化其后的 history 缓存。把 volatile 区域（skills 段/动态尾/创造性指令）
// 的 system 消息合并进最后一条 user 消息后，system 参数只剩 frozen + ephemeral
// （会话内字节稳定）→ history 可进缓存。内容为前缀拼接，语义等价。
// 在 tryCallLLM 层（轮循环前）一次性调用；压缩重试重建路径需再次调用。
function mergeVolatileSystemIntoUser(
  messages: Array<LLMMessage>,
  volatileStartIdx: number,
): Array<LLMMessage> {
  if (volatileStartIdx < 0 || volatileStartIdx >= messages.length) {
    return messages;
  }
  const volatileParts: string[] = [];
  const kept: Array<LLMMessage> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system" && i >= volatileStartIdx) {
      volatileParts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
    } else {
      kept.push(m);
    }
  }
  if (volatileParts.length === 0) {
    return messages;
  }
  const lastUserIdx = lastIndexOfRole(kept, "user");
  const prefix = volatileParts.join("\n\n");
  if (lastUserIdx >= 0) {
    const last = kept[lastUserIdx];
    kept[lastUserIdx] = typeof last.content === "string"
      ? { ...last, content: `${prefix}\n\n${last.content}` }
      : { ...last, content: [{ type: "text", text: prefix }, ...(Array.isArray(last.content) ? last.content : [])] };
  } else {
    kept.push({ role: "user", content: prefix });
  }
  return kept;
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
// Prevents duplicate file writes/deletes when the LLM retries
// a tool call with identical parameters within the TTL window.
const idempotencyCache = new Map<string, { result: string; timestamp: number }>();
const IDEMPOTENCY_TTL = 5 * 60 * 1000; // 5 minutes
const IDEMPOTENCY_MAX = 200;
// ★ 2026-10-27 工具合并后：email / scheduler 复合工具同时覆盖只读 action
// （list_inbox / list / add_account），结果非 args 纯函数、不可整体幂等，
// 故不再加入（旧 email_send / scheduler_create / scheduler_delete 已合并消失）。
const IDEMPOTENT_TOOLS = new Set([
  "file_write", "file_delete",
]);

/** 工具结果进入上下文的体积上限（字符）。超出则截断并附提示。 */
// ★ 2026-10-26 修复：工具结果截断从 12K 降到 4K。
//   创造性任务中模型过度调用 shell_exec/file_read，每个结果 2-5K 字符。
//   5 轮 × 3 工具调用 × 4K = 60K 字符上下文，加上系统提示和工具定义，
//   单轮 token 消耗可达 100K+。4K 上限足以保留关键信息，同时大幅降低
//   上下文体积，加快每轮 LLM 调用速度。
const TOOL_RESULT_MAX_CHARS = 4_000;

/**
 * 截断过大的工具结果，避免单个返回值吃掉大量上下文。
 *
 * 事故（2026-10-28）：email / list_inbox 返回 22K 字符，旧的"首尾拼接"
 * 截断让模型只能看到头尾两段邮件，中间整段丢失，整理摘要因此不完整。
 * 改为 JSON 结构感知截断：保留前 N 条**完整**元素 + 总数，截断后仍是
 * 结构清晰的 JSON，模型可直接消费；非 JSON 输出（shell/日志）保留头部主干。
 */
export function truncateToolResult(text: string, maxChars: number = TOOL_RESULT_MAX_CHARS): string {
  if (typeof text !== "string" || text.length <= maxChars) return text;

  const note = (extra: string) =>
    `\n\n...[结果过长已截断：原文 ${text.length} 字符${extra}]...\n\n`;

  // JSON 结构感知截断
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const jsonResult = truncateJsonResult(text, maxChars);
    if (jsonResult !== null) {
      return jsonResult + note("，已按结构保留前段完整条目");
    }
  }

  // 非 JSON 输出：保留头部（主干信息密度最高），尾部丢弃并如实告知
  const budget = Math.max(0, maxChars - 160);
  return text.slice(0, budget) + note(`，尾部 ${text.length - budget} 字符已丢弃`);
}

/**
 * 对 JSON 结果做结构感知截断：找到第一个超预算的数组字段，保留前 N 条完整元素，
 * 并在数组末尾插入总数标记。返回 null 表示不适合 JSON 截断（解析失败 / 无超预算数组）。
 */
function truncateJsonResult(text: string, maxChars: number): string | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null; // 非法 JSON（shell 输出等）——回退普通截断
  }

  const MAX_ARRAY_CHARS = Math.floor(maxChars * 0.7);

  // root 本身就是数组
  if (Array.isArray(data)) {
    const t = truncateJsonArray(data, MAX_ARRAY_CHARS);
    return t ? JSON.stringify(t) : null;
  }

  if (!data || typeof data !== "object") return null;

  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!Array.isArray(obj[key])) continue;
    const arr = obj[key] as unknown[];
    if (arr.length < 2) continue;
    if (JSON.stringify(arr).length <= MAX_ARRAY_CHARS) continue;
    const t = truncateJsonArray(arr, MAX_ARRAY_CHARS);
    if (!t) continue;
    obj[key] = t;
    return JSON.stringify(obj);
  }
  return null;
}

/**
 * 截断数组：保留前 N 条完整元素（序列化后不超预算），末尾插入总数标记。
 * 标记以字符串形式混入数组——模型可读、信息自描述，且不破坏"这是个列表"的语义。
 */
function truncateJsonArray(arr: unknown[], budget: number): unknown[] | null {
  const serialized = arr.map(v => JSON.stringify(v));
  let used = 0;
  let kept = 0;
  for (const s of serialized) {
    const cost = used === 0 ? s.length : s.length + 2; // 元素 + 分隔符
    if (used + cost > budget && kept > 0) break;
    used += cost;
    kept++;
  }
  if (kept >= arr.length) return null; // 无需截断

  const keptItems = serialized.slice(0, kept).map(s => JSON.parse(s));
  const marker =
    `...(共 ${arr.length} 条，仅保留前 ${kept} 条；` +
    `如需其余请缩小 limit/since，或按 uid 用 get_email 单查)`;
  return [...keptItems, marker];
}

/**
 * 工具结果缓存豁免：命令执行类工具。
 *
 * 评测事故（2026-10-15 eval15 t01）：shell_exec 结果在 300s TTL 内按
 * 精确 args 缓存。模型修了 src/index.js 后重跑同一命令
 * `node .../index.js add 3 4`，命中缓存拿到**修复前**的旧输出
 * （用法提示，exit 1），误判「修复无效」反复改 5+ 轮仍失败。
 * 文件内容变了 → 同一命令的输出也变 → 结果不是 args 的纯函数，
 * 命令执行类工具一律不走结果缓存（写操作另有幂等缓存，不受影响）。
 */
export const NO_RESULT_CACHE_TOOLS = new Set([
  "shell_exec",
  "execute_code",
  "run_python",
  "run_node",
  // 浏览器工具：页面状态是跨调用共享的活对象（当前标签/DOM 随导航与交互变化），
  // 结果不是 args 的纯函数。评测事故（2026-10-15 browser-eval b05/b07）：
  // browser_navigate 命中结果缓存 → 导航被跳过执行 → 只读工具（browser_get/js_eval）
  // 继续作用在旧页面上，agent 绕路 shell+fetch 解析站点。
  // browser_fetch_json 已并入 web_fetch/json（纯 URL 抓取，非浏览器活状态），不再列入。
  "browser_navigate",
  "browser_get",
  "browser_js_eval",
  "browser_screenshot",
  "browser_tabs",
  "browser_act",
]);

/**
 * 工具结果缓存查找（带「语义等价」识别）。
 *
 * 事故：模型连续三次调用 email / list_inbox，参数只有 limit 不同
 * （100 → 200 → 50），而邮箱里邮件总数不足 50 封，三次返回的**完全相同**。
 * 严格按 args 字面量做 key 时全部 miss，导致重复拉取 + 重复占上下文。
 *
 * 这里在精确命中失败后，再做一次「忽略分页参数」的等价命中：
 * 仅当缓存结果**未被 limit 截断**时（条目数 < 当时的 limit）才复用，
 * 否则新请求可能确实想要更多数据，不能复用。
 */
export function lookupCachedToolResult(
  cache: Map<string, { result: string; timestamp: number }> | undefined,
  toolName: string,
  args: Record<string, unknown>,
  ttlMs: number,
): string | null {
  if (!cache) return null;
  if (NO_RESULT_CACHE_TOOLS.has(toolName)) return null; // 副作用工具：结果非 args 纯函数
  const exactKey = `${toolName}:${JSON.stringify(args)}`;
  const exact = cache.get(exactKey);
  if (exact && Date.now() - exact.timestamp < ttlMs) return exact.result;

  // 分页类参数不影响"结果集内容"，只在结果未被截断时才可安全忽略
  const PAGINATION_KEYS = new Set(["limit", "limitCount", "maxResults", "topK", "perPage", "pageSize"]);
  const hasPaginationArg = Object.keys(args).some((k) => PAGINATION_KEYS.has(k));
  if (!hasPaginationArg) return null;

  const strip = (o: Record<string, unknown>) => {
    const c: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (!PAGINATION_KEYS.has(k)) c[k] = v;
    return c;
  };
  const normalized = JSON.stringify(strip(args));

  for (const [key, entry] of cache) {
    if (!key.startsWith(`${toolName}:`)) continue;
    if (Date.now() - entry.timestamp >= ttlMs) continue;
    let cachedArgs: Record<string, unknown>;
    try {
      cachedArgs = JSON.parse(key.slice(toolName.length + 1));
    } catch {
      continue;
    }
    if (JSON.stringify(strip(cachedArgs)) !== normalized) continue;
    // 缓存结果必须未被 limit 截断，才敢给更大的 limit 复用
    const cachedLimit = Number((cachedArgs as Record<string, unknown>).limit);
    if (!Number.isFinite(cachedLimit) || cachedLimit <= 0) continue;
    const itemCount = countResultItems(entry.result);
    if (itemCount !== null && itemCount >= cachedLimit) continue; // 被截断了，不复用
    const newLimit = Number(args.limit);
    if (Number.isFinite(newLimit) && newLimit > 0 && itemCount !== null && newLimit < itemCount) continue;
    process.stdout.write(`[AgentModelExecutor] Cache hit (limit-normalized) for ${toolName}\n`);
    return entry.result;
  }
  return null;
}

/** 从结果 JSON 中数出主条目数；无法判断时返回 null（保守地不复用） */
function countResultItems(result: string): number | null {
  try {
    const o = JSON.parse(result);
    if (!o || typeof o !== "object") return null;
    for (const key of ["emails", "items", "results", "messages", "files", "records"]) {
      if (Array.isArray((o as Record<string, unknown>)[key])) {
        return ((o as Record<string, unknown>)[key] as unknown[]).length;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 会产出"搜索结果"的工具——只有它们真的跑通，才值得提示模型别再搜了 */
const SEARCH_TOOLS_HINT = new Set(["web_search", "web_fetch"]);

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
    limit = Math.min(cap, baseLimit + 40);
  } else if (complexPatterns.some(p => p.test(lower))) {
    limit = Math.min(cap, baseLimit + 20);
  }

  if (hasActionIntentFn(message)) {
    // ★ 2026-10-30 提升 +10→+15：v7 压测复跑实证——Task 7/8（运维/算法类）
    //   标题不匹配 complexPatterns 但 hasActionIntent=true，旧 +10 给出 20 轮
    //   不够完成多文件脚手架+测试+部署。+15 → 25 轮，配合 TOKEN_BUDGET=1.8M。
    limit = Math.min(cap, limit + 15);
  }

  const sessionHistory = conversationHistory.get(sessionId) || [];
  if (sessionHistory.length > 30) {
    limit = Math.max(baseLimit, limit - 5);
  }

  return Math.min(cap, limit);
}

/**
 * 从回复文本中提取被声称创建/写入的文件路径。
 *
 * ★ 2026-10-27 新增：完成声明对账只检查"是否调用了写工具"，
 *   但不验证声称创建的文件是否真的存在于磁盘上。此函数从回复中
 *   提取被声称创建/写入的文件路径，供磁盘核验使用。
 *
 * 提取策略：
 * 1. 匹配反引号中的绝对路径（`/home/...`、`/tmp/...` 等）
 * 2. 匹配完成声明关键词附近的路径（"已创建"/"已写入"/"文件清单"/"路径"）
 * 3. 过滤掉 URL、npm/pnpm 包路径、目录路径（无扩展名）等非文件路径
 * 4. 过滤掉常见的系统路径（/proc, /sys, /dev 等）
 */
/**
 * 从回复中提取被声称创建/写入的文件路径（供磁盘核验使用）。
 * 导出仅供测试（回归用例见 llm-caller.test.ts）。
 */
export function extractClaimedFilePaths(reply: string, baseDir?: string): string[] {
  if (!reply) return [];
  const paths = new Set<string>();
  const hasBase = typeof baseDir === "string" && baseDir.length > 0;

  // 1. 反引号中的绝对路径
  // ★ 2026-10-28 修复（v4 复测 Task 7 误报）：排除「记录到 / 写入到 / 输出到」
  //   等运行时写目标——这类路径描述脚本运行期写日志/输出的位置，并非模型
  //   声称创建的文件（如 monitor.sh 的告警日志 alert.log 被误判为缺失文件）。
  //   上下文以写目标介词结尾才排除；介词带「到/为/入」后缀，「已写入 X」这类
  //   完成声明不会误伤（末尾是「入 」而非「入到」）。
  // ★ 2026-10-28 二次补充「自动写入」：v4 Task 7 复测回复以「超阈值自动写入
  //   `/tmp/v4-monitor/alert.log`」描述脚本运行期行为——「自动」前缀区别于
  //   完成声明「已写入」，可安全排除。
  // ★ 2026-10-28 三次补充「尝试写 / 试着写」：v7 复测回复以「会尝试写
  //   `/tmp/v4-monitor/alert.log`」描述脚本运行期行为——「尝试」前缀同样
  //   区别于完成声明，但此前不在列表 → alert.log 被误判为声称创建 → 触发
  //   虚假「任务未完成」更正脚注。
  // ★ 2026-10-28 四次补充「时写入 / 时记录 / 时保存 / 时输出 / 时发送」：
  //   v10 复测 Task 7 回复以「超阈值时写入 `/tmp/v4-monitor/alert.log`」描述
  //   脚本运行期行为——「时」前缀（条件触发）区别于完成声明「已写入」，
  //   此前列表只认「写入到」（带「到」后缀），「时写入」漏网 → alert.log
  //   被误判为声称创建 → 更正脚注误报。
  // ★ 2026-10-28 五次补充「超阈值写入 / 阈值写入」：v12 复测 Task 7 回复以
  //   「超阈值写入 `/tmp/v4-monitor/alert.log`」描述脚本运行期行为——
  //   「超阈值/阈值」条件前缀同样区别于完成声明。
  const runtimeWriteTargetRe = /(?:记录到|写入到|输出到|保存到|追加到|存到|发送到|写到|记到|记入|存入|输出为|存为|自动写入|尝试写|试着写|时写入|时记录|时保存|时输出|时发送|超阈值写入|阈值写入)\s*$/;
  const backtickPathRe = /`(\/[^`]+)`/g;
  for (const m of reply.matchAll(backtickPathRe)) {
    const p = m[1].trim();
    if (!isCandidateFilePath(p)) continue;
    const before = reply.slice(Math.max(0, (m.index ?? 0) - 30), m.index ?? 0);
    if (runtimeWriteTargetRe.test(before)) continue;
    paths.add(p);
  }

  // 2. 完成声明关键词附近的路径
  // ★ 2026-10-28：补充「创建目录 / 初始化 / 验证通过」——v4 Task 8 回复以
  //   「✅ 创建目录 /tmp/v4-ratelimit 并初始化 ratelimit.js 文件」句式声称创建；
  //   复测 Task 7 回复以「三个监控文件已经全部完成并验证通过：」引导文件清单，
  //   关键词在引导行、路径在清单条目行（±3 行窗口覆盖）。
  // ★ 2026-10-28 二次补充「就绪 / 都放在」——v4 Task 7 复测回复以
  //   「监控方案已就绪，三个文件都放在 `/tmp/v4-monitor/` 下了」句式声称完成，
  //   「就绪/都放在」不在原关键词列表 → 整个文件清单漏检。
  const claimKeywords = /(?:已创建|已写入|已保存|已生成|文件清单|路径|已部署|已安装|文件结构|目录结构|创建目录|初始化|验证通过|就绪|就位|都放在)/;
  // 按行分割，找到包含完成声明关键词的行及其前后各 3 行
  const lines = reply.split("\n");
  // ★ 2026-10-28：路径字符集排除 CJK 标点——此前 `[^\s`"'<>()|,;)]*` 会把
  //   中文冒号/逗号粘进路径（v4 Task 8 实测提取出 "/tmp/v4-ratelimit/
  //   ratelimit.js，实现"），产生永远不存在的畸形路径 → 误报缺失。
  //   同时对每个匹配应用运行时写目标守卫（与策略 1 同源）。
  const cjkPunct = "：。，、！？；（）【】《》“”‘’…—～·";
  const linePathRe = new RegExp(
    "\\/(?:home|tmp|var|opt|usr|etc|root|data|workspace)[^\\s`\"'<>()|,;" +
    cjkPunct.split("").map((c) => "\\u" + c.codePointAt(0)!.toString(16).padStart(4, "0")).join("") + "]*",
    "g",
  );
  for (let i = 0; i < lines.length; i++) {
    if (claimKeywords.test(lines[i])) {
      // 检查当前行及前后各 3 行中的路径
      const start = Math.max(0, i - 3);
      const end = Math.min(lines.length, i + 4);
      for (let j = start; j < end; j++) {
        const linePaths = lines[j].match(linePathRe);
        if (linePaths) {
          for (const p of linePaths) {
            if (!isCandidateFilePath(p)) continue;
            // 运行时写目标守卫：路径前的上下文以写目标介词结尾 → 运行期输出，非创建声明。
            // ★ 2026-10-28：indexOf(p) 定位的是反引号**之后**的路径起点，before 末尾
            //   会带一个反引号（「输出到 `/tmp/x/run.log`」→ before 以 "`" 结尾）导致
            //   runtimeWriteTargetRe 失配 → 运行期写目标被误判为声称创建。
            //   先剥掉尾部反引号/空白再判定。
            const line = lines[j];
            const idx = line.indexOf(p);
            const before = line
              .slice(Math.max(0, idx - 30), idx)
              .replace(/[\s`]+$/, "");
            if (runtimeWriteTargetRe.test(before)) continue;
            paths.add(p);
          }
        }
      }
    }
  }

  // 2.5 ★ 2026-10-28 新增：裸文件名 + 文中提及目录拼接（v4 Task 7/8 事故）。
  //   回复常以「在 `/tmp/v4-monitor/` 目录下，已生成 `monitor.sh`」、
  //   「创建目录 /tmp/v4-ratelimit 并初始化 ratelimit.js 文件」这类句式
  //   声称创建了文件，但：
  //   - 目录路径被 isCandidateFilePath 的无扩展名规则过滤；
  //   - 文件名是裸名（无前导 `/`、可能没有反引号），策略 1/2 都不匹配；
  //   → 磁盘核验完全漏掉（Task 7 实测 0 事件）。
  //   修复：收集文中提及的目录（/tmp/xxx 等形态），把行内裸文件名
  //   （带已知扩展名、不在否定语境）与「其前最近提及的目录」拼接。
  const dirMentionRe = /\/(?:home|tmp|var|opt|usr|etc|root|data|workspace)[\w./-]*/g;
  // ★ 2026-10-28 v12 复测：代码块（```/~~~ 围栏）内的目录提及不作为拼接基准——
  //   v12 回复的 monitor.sh 代码块含「for m in / /var /home /tmp」，其中 /tmp
  //   被登记为目录后，标题行「## 2. v4-monitor.service + v4-monitor.timer」的
  //   裸文件名拼到了 /tmp/v4-monitor.service（畸形路径）→ 更正脚注把真实存在
  //   的 /tmp/v4-monitor/v4-monitor.service 报为缺失。围栏内的提及一律跳过。
  const fenceSpans: Array<[number, number]> = [];
  {
    let fenceStart = -1;
    let offset = 0;
    for (const line of reply.split("\n")) {
      if (/^\s*(?:```|~~~)/.test(line)) {
        if (fenceStart < 0) fenceStart = offset;
        else {
          fenceSpans.push([fenceStart, offset]);
          fenceStart = -1;
        }
      }
      offset += line.length + 1;
    }
  }
  const inFence = (idx: number) =>
    fenceSpans.some((s) => idx >= s[0] && idx < s[1]);
  const mentionedDirs: Array<{ dir: string; end: number }> = [];
  for (const m of reply.matchAll(dirMentionRe)) {
    if (inFence(m.index ?? 0)) continue;
    const raw = m[0];
    const dir = raw.replace(/\/+$/, "");
    // 末段带扩展名 → 更像完整文件路径（策略 1/2 已处理），不作为目录
    if ((dir.split("/").pop() || "").includes(".")) continue;
    if (dir) mentionedDirs.push({ dir, end: (m.index ?? 0) + raw.length });
  }
  // 行级完成声明上下文；否定词（不存在/未创建…）说明模型并未声称创建，跳过
  const bareClaimContextRe = /(?:已创建|已写入|已保存|已生成|已部署|已安装|文件清单|文件结构|目录结构|完成|创建|初始化|已存在|就绪|就位)/;
  const bareClaimNegateRe = /(?:不存在|没有|未创建|未生成|未找到|没创建|没生成|未就绪|未就位)/;
  // ★ 2026-10-28：整条回复的完成声明门（原属策略 2.7，此处前置供 2.5 复用）。
  //   补充「就绪 / 都放在」——v4 Task 7 复测回复以「监控方案已就绪，三个文件
  //   都放在 `/tmp/v4-monitor/` 下了」+ 编号清单条目（**1. `monitor.sh`**）声称
  //   完成，就绪/都放在不在原列表 → 编号条目行无行级声明上下文 → 三个文件全漏。
  const replyHasCompletionClaim = /(?:完成|已创建|已生成|已写入|已保存|已部署|已安装|创建|初始化|验证通过|就绪|就位|都放在)/.test(reply);
  // 编号/bullet 清单条目行（**1. `x`** / 1. x / - x / * x / • x）。
  // ★ 2026-10-28：marker 后必须跟空白——「**阈值含义速查**：…」是加粗段落而非
  //   bullet，旧正则把前导「*」当 bullet 放行 → 行内裸文件名误拼到最近提及目录。
  const listItemRe = /^\s*(?:\*{0,2}\s*\d+[.、)]\s+|[-*•]\s+)\*{0,2}\s*/;
  // 引用语境外（详见/参考/位于）——清单条目只是指向文件，并非声称创建
  const listItemRefExclRe = /(?:详见|参考|位于)/;
  // 反引号内的裸文件名（v4 Task 7 实录形态）；扩展名含 systemd 单元（.service/.timer）
  // ——v7 复测 Task 7 回复以 `evomon.timer` 反引号裸名声称创建
  const backtickBareRe = /[`]([A-Za-z0-9][A-Za-z0-9._-]*\.(?:py|js|mjs|cjs|ts|tsx|jsx|md|json|css|html?|toml|txt|csv|tsv|sh|bash|service|timer|ya?ml|xml|ini|cfg|conf|sql|log|png|jpe?g|gif|svg|ico|woff2?|ttf|pdf|zip|gz|tar|bak|spec))[`]/gi;
  // 无反引号的裸文件名（v4 Task 8 实录形态）；前后不能紧跟路径分隔符/引号/
  // 词字符——否则「/tmp/x/monitor.sh」的后缀「onitor.sh」（前字符为词字符 m）
  // 会被误匹配。CJK 标点/汉字不在 \w 内，「、notify.sh」仍正常命中。
  // lookahead 不排「.」——句尾「已生成 report.md.」的 ASCII 句号是标点非文件名。
  const plainBareRe = /(?<![\w\/`"'.-])([A-Za-z0-9][A-Za-z0-9._-]*\.(?:py|js|mjs|cjs|ts|tsx|jsx|md|json|css|html?|toml|txt|csv|tsv|sh|bash|service|timer|ya?ml|xml|ini|cfg|conf|sql|log|png|jpe?g|gif|svg|ico|woff2?|ttf|pdf|zip|gz|tar|bak|spec))(?![\w\/`"'])/gi;
  let lineOffset = 0;
  // ★ 2026-10-28 v11 复测：代码块（``` 围栏）内的 `# 注释`是 bash 注释而非
  //   markdown 标题——「# 就会在 alert.log 中看到…」曾命中标题门，裸文件名
  //   拼到上方最近提及的目录（/etc/systemd/system/alert.log）→ 误报。
  //   围栏内关闭标题门（其余门不变）。
  let inCodeBlock = false;
  for (const rawLine of lines) {
    const lineStartAbs = lineOffset;
    lineOffset += rawLine.length + 1; // +1 为换行符
    if (/^\s*```/.test(rawLine)) inCodeBlock = !inCodeBlock;
    // ★ 2026-10-28：清单条目行（编号/bullet）在整条回复含完成声明时视为声称行——
    //   完成声明常在引导行（「三个文件都放在 X 下了」），条目行本身无声明词。
    const isListItem = listItemRe.test(rawLine);
    // ★ 2026-10-28 v10 复测 Task 7 实录：markdown 标题行列举文件（「## 2.
    //   `evoclaw-monitor.service` + `evoclaw-monitor.timer`」）——文件名在标题、
    //   完成声明在引导行（「三个文件已创建完成」），行级关键词门漏检 → 磁盘
    //   核验放过未落盘的 .service/.timer，更正脚注缺失。标题行 + 完成声明 +
    //   非引用语境外（详见/参考/位于）时视为声称行。
    const isHeading = !inCodeBlock && /^\s{0,3}#{1,6}\s/.test(rawLine);
    if (bareClaimNegateRe.test(rawLine)) continue;
    if (
      !bareClaimContextRe.test(rawLine) &&
      !((isListItem || isHeading) && replyHasCompletionClaim && !listItemRefExclRe.test(rawLine))
    ) continue;
    // 行内目录：取最后一个提及作为本行基准。
    // ★ 2026-10-28：提及若是文件路径（basename 带扩展名），取其父目录——
    //   v8 复测 Task 7 回复「三个文件均已就位（/tmp/v4-monitor/monitor.sh、
    //   notify.sh、monitor.service，另附 monitor.timer）」：目录只以绝对
    //   路径形式出现，同行裸文件名（notify.sh 等）需要父目录作为拼接基准，
    //   否则整行漏提取 → 虚假声称无人更正。
    let lineDir: string | null = null;
    {
      const dirsInLine = [...rawLine.matchAll(dirMentionRe)];
      if (dirsInLine.length > 0) {
        const last = dirsInLine[dirsInLine.length - 1][0].replace(/\/+$/, "");
        const base = last.split("/").pop() || "";
        if (base.includes(".")) {
          const parent = last.slice(0, -(base.length + 1));
          if (parent) lineDir = parent;
        } else {
          lineDir = last;
        }
      }
    }
    const collect = (re: RegExp) => {
      for (const m of rawLine.matchAll(re)) {
        const name = m[1];
        if (name.includes("/") || /^https?:/i.test(name)) continue;
        // ★ 2026-10-28：运行时写目标守卫（与策略 1/2 同源）——文件名前的上下文
        //   以写目标介词结尾（如「超阈值自动写入 `alert.log`」）→ 运行期输出位置，
        //   非创建声明，跳过。
        const beforeName = rawLine.slice(Math.max(0, (m.index ?? 0) - 30), m.index ?? 0);
        if (runtimeWriteTargetRe.test(beforeName)) continue;
        const absStart = lineStartAbs + (m.index ?? 0);
        // 优先本行目录；行内没有则回退到「文件名之前最近提及的目录」（跨行场景）
        let base = lineDir;
        if (!base) {
          for (const d of mentionedDirs) {
            if (d.end <= absStart) base = d.dir;
            else break;
          }
        }
        if (!base) continue;
        const joined = `${base}/${name}`;
        if (isCandidateFilePath(joined)) paths.add(joined);
      }
    };
    collect(backtickBareRe);
    collect(plainBareRe);
  }

  // 2.7 ★ 2026-10-28 新增：清单条目行（bullet + 绝对路径）。
  //   复测 Task 7 回复结构：「三个监控文件已经全部完成并验证通过：\n
  //   - /tmp/v4-monitor/monitor.sh：…\n- /tmp/v4-monitor/notify.sh：…\n
  //   - /tmp/v4-monitor/v4-monitor.service：…」——声称创建的 .service 文件
  //   实际从未落盘，但路径在清单条目行、完成声明在引导行，两者不同行；
  //   策略 2 的关键词窗口只认「已创建/验证通过」等关键词，「完成」不在列表
  //   时整个清单漏检。识别 bullet 起始的绝对路径条目（路径须紧跟 bullet，
  //   「详见/参考/位于」等引用语境外），且整条回复须含完成声明才生效。
  //   replyHasCompletionClaim 已于策略 2.5 前置（含「就绪/都放在」），此处复用。
  if (replyHasCompletionClaim) {
    // bullet（-/*/• 或编号）+ 空格 + 绝对路径（可带尾描述）
    const bulletPathRe = /^\s*(?:[-*•]|\d+[.、)])\s+(\/(?:home|tmp|var|opt|usr|etc|root|data|workspace)[\w./-]*)/;
    for (const rawLine of lines) {
      const b = bulletPathRe.exec(rawLine);
      if (!b) continue;
      // 路径须紧跟 bullet ——「详见/参考/位于 /tmp/x」这类引用语境外自然不匹配
      const p = b[1].replace(/\/+$/, "");
      if (isCandidateFilePath(p)) paths.add(p);
    }
  }

  // 3. ★ 2026-10-27 新增：代码块中的文件树（相对路径）。
  //   实测 Task 1 的回复用代码块树状图声称创建了文件：
  //     todo-cli/
  //     ├── README.md
  //     ├── pyproject.toml
  //     ├── todo_cli/
  //     │   ├── __init__.py
  //     │   └── cli.py
  //   此类相对路径既无前导 `/`，也不在反引号中，旧提取策略完全漏掉。
  //   解析树状行（`├── foo.py` / `└── bar.ts` / `│   └── baz.js`），
  //   去掉树形字符与缩进后得到相对路径；存在 baseDir 时逐个解析为绝对路径。
  //   带目录层级的树（`todo_cli/` 子目录）需维护目录栈以重建完整相对路径。
  if (hasBase) {
    // 树状行：前导（空格 + │）+ 分支符（├──/└──）+ 条目名
    const treeEntryRe = /^([│\s]*)(?:[├└]──\s*)([^\s│].*?)$/;
    let inCodeBlock = false;
    // 每个代码块独立维护：代码块内第一个非空行若是「xxx/」则作为树根目录名
    let blockRoot: string | null = null;
    // 目录栈：[{ depth, relDir }]——depth = 前导缩进列数 / 2（│ 视觉占 2 列、空格 1 列）
    // 弹栈用 `>=`：遇到同级条目时弹出上一级目录，保持栈顶始终是最近的父目录
    const dirStack: Array<{ depth: number; relDir: string }> = [];
    for (const rawLine of lines) {
      if (/^\s*```/.test(rawLine)) {
        inCodeBlock = !inCodeBlock;
        // 代码块切换：重置目录栈与根目录，避免跨块串味
        blockRoot = null;
        dirStack.length = 0;
        continue;
      }
      if (!inCodeBlock) continue;
      const t = treeEntryRe.exec(rawLine);
      if (!t) {
        // 树的根目录行通常无树形前缀（如 `todo-cli/`），仅出现在块首附近；
        // 在尚无根的情况下，把「xxx/」形式的首个非空行视为树根
        const rootRe = /^(\S[^\s/]*)\/$/;
        const r = rootRe.exec(rawLine.trim());
        if (r && !blockRoot) {
          blockRoot = r[1];
        }
        continue;
      }
      // 前导「│」视觉上占 2 列，空格占 1 列；统一折算为列数再 /2 得深度
      const cols = t[1].replace(/│/g, "  ").length;
      const depth = Math.floor(cols / 2);
      let rel = t[2].replace(/\s*(?:\([^)]*\)|[—–-]\s*\d+\s*(?:行|bytes|KB|MB))?\s*$/, "").trim();
      if (!rel) continue;
      // 子目录行：以 `/` 结尾（如 `todo_cli/`）或末段无扩展名
      const looksDir = rel.endsWith("/") || !/\./.test((rel.split("/").pop() || ""));
      // 弹栈：弹出所有 depth >= 当前行的目录，栈顶即父目录
      while (dirStack.length > 0 && dirStack[dirStack.length - 1].depth >= depth) {
        dirStack.pop();
      }
      const parent = dirStack.length > 0 ? dirStack[dirStack.length - 1].relDir : "";
      // parent 已带尾 `/`，rel 不以 `/` 开头，直接拼接避免双斜杠
      const full = parent ? `${parent}${rel}` : rel;
      if (looksDir) {
        dirStack.push({ depth, relDir: full.endsWith("/") ? full : `${full}/` });
        continue;
      }
      if (/^[/~]/.test(rel)) continue; // 已是绝对路径，走策略 1/2
      if (/^https?:\/\//i.test(rel)) continue;
      // 树根目录下的条目补上前缀（如 `todo-cli/README.md`）
      const withRoot = blockRoot && !full.startsWith(`${blockRoot}/`) && full !== blockRoot
        ? `${blockRoot}/${full}`
        : full;
      const resolved = path.isAbsolute(withRoot) ? withRoot : path.join(baseDir, withRoot);
      if (isCandidateFilePath(resolved)) paths.add(resolved);
    }
  }

  return Array.from(paths);
}

/**
 * 判断路径是否为候选文件路径（有扩展名、不是 URL、不是系统路径）。
 */
function isCandidateFilePath(p: string): boolean {
  if (!p) return false;
  // 过滤 URL
  if (/^https?:\/\//i.test(p)) return false;
  // 过滤系统路径
  if (/^\/(?:proc|sys|dev|run|boot|sbin|bin)\//.test(p)) return false;
  // 过滤目录路径（无扩展名）——只检查有扩展名的文件
  const basename = p.split("/").pop() || "";
  if (!basename.includes(".")) return false;
  // 过滤常见的非文件路径（npm/pnpm 包路径等）
  if (/\/(?:node_modules|dist|build|out|src)\//.test(p) && !/\.(?:ts|js|json|md|py|txt|csv|html|css|xml|yaml|yml|toml)$/.test(basename)) return false;
  return true;
}

/**
 * 从本回合工具调用记录中提取真实执行过的 shell 命令文本。
 * 用于「声称运行了验证命令但无执行记录」对账（claimed_command_not_executed，
 * v4 Task 8 事故）。只收录带 command 参数的执行类工具（shell_exec 等）；
 * execute_code 的 code 参数是脚本内容而非命令行，刻意不收录（避免子串误匹配）。
 * 导出仅供测试。
 */
export function extractExecutedShellCommands(
  calls: Array<{ name: string; arguments?: Record<string, unknown> }>,
): string[] {
  const out: string[] = [];
  for (const c of calls) {
    const name = c.name.toLowerCase();
    if (
      !name.includes("shell") &&
      !name.includes("exec") &&
      !name.includes("bash") &&
      !name.includes("terminal")
    ) continue;
    const cmd = c.arguments?.command;
    if (typeof cmd === "string" && cmd.trim()) out.push(cmd.trim());
  }
  return out;
}

/**
 * 计算两个字符串的重叠率（基于字符 n-gram 的 Jaccard 相似度）。
 * 用于检测模型是否在续跑后产生了与上次 yield 高度相似的回复（循环守卫）。
 */
function overlapRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const n = 10; // 10-gram
  const setA = new Set<string>();
  const setB = new Set<string>();
  for (let i = 0; i <= a.length - n; i++) setA.add(a.slice(i, i + n));
  for (let i = 0; i <= b.length - n; i++) setB.add(b.slice(i, i + n));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const g of setA) if (setB.has(g)) intersection++;
  return intersection / Math.min(setA.size, setB.size);
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
    // LLM 摘要生成器：调用 callLLMOnce 用第一个 provider 生成摘要。
    // 对标 Hermes ContextCompressor 的辅助 LLM 调用（auxiliary.compression）。
    llmSummarizer: async (prompt: string): Promise<string> => {
      const provider = deps.providers[0];
      if (!provider) return "";
      const result = await callLLMOnce(
        provider,
        [{ role: "user", content: prompt }],
        [],
        "none",
        undefined,
        deps,
      );
      if (result?.message?.content) return result.message.content;
      return "";
    },
  };
}

// ── Tool groups for dynamic loading ──
// Tools are organized into groups by capability. The LLM receives the
// "core" group always, plus groups that match the current task intent.
// This reduces the number of tool definitions sent to the LLM (best
// practice: ≤15 tools per request) and improves tool selection accuracy.
//
// Composable toolsets: a group may declare `includes` referencing other
// groups by name. When a group is activated, all transitively included
// groups are also activated. Cycle detection uses a visited set (hermes
// toolsets.py resolve_toolset pattern).

interface ToolGroupDef {
  tools: string[];
  keywords: string[];
  /** 其他工具集名称，激活时一并包含（递归解析，带循环检测）。 */
  includes?: string[];
}

/**
 * 工具分组（关键词激活 + 会话单调并集）。
 *
 * ★ P0-5（2026-10-27）常驻工具瘦身：
 *   此前只有 core/browser/skill/email/coding/media/scheduler/memory 八组，
 *   **其余 70 个工具不在任何组里 → 逐轮无条件下发**，实测 ≈37.5K 字符
 *   （≈9–11K token），比整段系统提示词（≈20.8K 字符）还大。这部分是纯粹的
 *   固定前缀开销，每轮重复计费。
 *
 *   本轮把其中「领域专用、关键词可可靠命中」的工具全部收进分组：
 *   会话首消息未命中关键词时不下发，命中后进入单调并集、此后整段保持字节
 *   稳定（缓存不再逐轮漂移）。
 *
 *   ★ 2026-10-29 第二轮瘦身：core 扩到 10 个常驻工具
 *   （+execute_code / +todo_list），其余未分组工具全部收进 on-demand 组。
 *   原 7 个「刻意保留常驻」的工具中，execute_code / todo_list 升入 core；
 *   code_search / dev_check / verify_project 收进 dev 组（关键词覆盖编码语境）；
 *   workflow 本就在 workflow 组；apply_patch 是创建类白名单恒定下发。
 *   创建类白名单（isCreationTool）不受影响，仍恒定下发防「无接口」bug。
 *
 *   ★ 注意「创建类」工具（isCreationTool 白名单）即使被分进某组也**仍然恒定
 *   下发**，所以把它们放进组里不省 token——但为了组内语义完整仍照写，
 *   输出分档时会把它们归入稳定基座（见 buildOpenAITools 的档 1）。
 */
// 「无关键词命中」时的兜底技能集——**只含技能发现/执行/安装**这 3 个复合工具。
// 不能用 TOOL_GROUPS.skill.tools 代替：该组含 skill_manage 全部动作，
// 兜底集刻意只留技能入口，避免任何模糊首消息都常驻下发全部技能管理动作。
const SKILL_DISCOVERY_TOOLS = [
  "skill_manage", "skill_list", "skill_view",
];

const TOOL_GROUPS: Record<string, ToolGroupDef> = {
  core: {
    tools: [
      "web_search", "web_fetch", "file_write", "file_read",
      "file_list", "file_delete", "shell_exec", "sequential_thinking",
      "execute_code", "todo_list",
    ],
    keywords: [], // always included
  },
  browser: {
    tools: [
      "browser_navigate", "browser_launch", "browser_screenshot",
      "browser_get", "browser_act", "browser_tabs", "browser_js_eval",
      "browser_extract_dom", "browser_login",
      // ↑ 以下 2 个此前未分组、逐轮常驻（≈4.2K 字符）
      "browser_scroll", "browser_wait",
      // ↑ 以下 8 个 Hermes 对齐批次（9b89913）新增的浏览器补全工具，此前
      // 未分组 → 逐轮常驻（≈8.1K 字符 ≈2.2K token/轮）。收进本组，由浏览器
      // 关键词统一激活；会话单调并集保证激活一次后在场不回退。
      "browser_back", "browser_press", "browser_get_images", "browser_vision",
      "browser_cdp", "browser_dialog", "browser_vault", "browser_exec",
    ],
    keywords: [
      "browse", "browser", "网页", "网站", "打开", "navigate", "click", "screenshot",
      "登录", "login", "网页操作", "填写表单", "截图",
      // 补充中文常见说法，覆盖此前常驻的 10 个浏览器工具的用途
      "浏览器", "滚动", "scroll", "悬停", "hover", "下拉框", "下拉菜单",
      "等待加载", "页面元素", "dom 索引", "提取页面", "页面检查",
      // ↑ 8 个补全工具的用途关键词（返回/按键/取图/视觉/对话框/CDP/凭据/执行）
      "返回上一页", "后退", "back", "按键", "press", "keystroke", "取图", "图片",
      "images", "视觉", "vision", "对话框", "弹窗", "dialog", "弹窗处理",
      "devtools", "cdp", "凭据", "vault", "执行脚本",
    ],
  },
  skill: {
    tools: ["skill_manage", "skill_list", "skill_view"],
    keywords: ["skill", "技能", "install skill", "安装技能", "搜索技能", "翻译", "translate", "转换", "convert", "查找技能", "执行技能", "卸载技能", "创建技能"],
  },
  email: {
    tools: ["email"],
    // 必须覆盖中文常见说法：「邮箱」此前缺失，导致「添加邮箱账户」无法激活本组，
    // email / add_account 被静默裁剪，模型误判「系统没有添加接口」（真实事故）。
    keywords: [
      "email", "e-mail", "邮件", "邮箱", "邮件账户", "邮箱账户", "电子邮箱",
      "发送邮件", "发邮件", "收邮件", "收件箱", "inbox", "send email",
      "添加邮箱", "配置邮箱", "注册邮箱", "邮件账号", "邮箱账号",
      "imap", "smtp", "pop3", "授权码",
    ],
  },
  coding: {
    tools: ["execute_programming_task", "decompose_programming_task", "assess_coding_capability", "get_task_result"],
    keywords: ["programming", "编程", "代码", "code", "开发", "程序", "写代码", "实现功能"],
  },
  media: {
    tools: ["video", "music", "image_generate", "markitdown_convert"],
    keywords: ["video", "视频", "download", "下载", "music", "音乐", "歌曲", "youtube", "b站", "抖音", "generate video", "生成视频", "制作视频", "create video", "生成图片", "画图", "generate image", "create image", "draw", "画一张", "图片生成"],
  },
  scheduler: {
    tools: ["scheduler"],
    keywords: ["schedule", "定时", "cron", "调度", "定期", "计划任务", "死信", "dlq", "重试队列", "失败重试", "投递失败"],
  },
  memory: {
    // 记忆/会话检索组：memory（语义记忆）/ session_search（历史会话全文检索）
    // 关键词收紧：移除「存储/检索/session」等过度宽泛词——这些词在技术讨论中
    // 频繁出现但并不意味着用户需要记忆/会话检索能力，反而会导致 memory 组被
    // 误激活，增加 tools 数组大小，影响缓存前缀稳定性。
    tools: ["memory", "session_search"],
    keywords: ["memory", "记忆", "记住", "回忆", "remember", "recall", "忘记", "历史会话", "之前的对话", "上次聊", "会话记录"],
  },
  // ── 以下 7 组为 P0-5 新增：把原先「不分组 → 逐轮常驻」的领域工具收进分组 ──
  git: {
    tools: ["git"],
    // 「代码/code/开发/修复/修改/实现」与 coding 组同源：只要消息进入编码语境，
    // git 工具就该在手（status/diff/log 是每轮定位改动的常规动作）。
    // 兜底：即便真的没命中，模型仍可用 core 组的 shell_exec 执行 git 命令。
    keywords: ["git", "commit", "推送", "push", "拉取", "分支", "branch", "合并", "merge", "diff", "仓库", "repo", "代码库", "版本历史", "回滚", "撤销", "stash", "blame", "追溯", "改动", "编程", "代码", "code", "开发", "写代码", "修复", "修改", "实现", "提交代码"],
  },
  kanban: {
    tools: ["kanban"],
    keywords: ["kanban", "看板", "任务板", "任务队列", "领取任务", "看板统计", "board"],
  },
  vision: {
    tools: ["vision_analyze"],
    keywords: ["截图分析", "截图", "图片分析", "视觉分析", "屏幕截图", "对比图片", "找元素", "界面检查", "ui 检查", "图像识别", "视觉", "vision", "screenshot analysis", "analyze image"],
  },
  computer: {
    tools: ["computer_use"],
    keywords: ["电脑", "桌面", "鼠标", "键盘", "窗口管理", "远程桌面", "gui", "desktop", "mouse", "keyboard", "computer use", "电脑自动化", "桌面自动化", "点击屏幕"],
  },
  checkpoint: {
    tools: ["checkpoint"],
    keywords: ["检查点", "checkpoint", "存档", "快照", "回滚点", "保存进度", "恢复现场", "进度存档"],
  },
  workflow: {
    tools: ["workflow"],
    keywords: ["workflow", "工作流", "编排", "流程编排"],
  },
  research: {
    // 研究类意图（research action）已并入 web_search；本组保留关键词语义
    // （命中「研究/调研」时显式激活），web_search 本身在 core 组恒定下发。
    tools: ["web_search"],
    keywords: ["研究", "调研", "查证", "资料收集", "事实核查", "research", "文献"],
  },
  // ── 2026-10-29 第二轮瘦身：以下 4 组把原「未分组常驻」的 10 个工具收进 on-demand ──
  dev: {
    // 开发/调试工具组：dev_check（test/lint）/ code_search（text/references）/
    // verify_project（项目验证）/ apply_patch（SEARCH/REPLACE 补丁 + 重命名）。
    // 关键词覆盖编码语境，与 git 组同源——「开发/代码/修复/修改」等词命中时
    // git+dev 同时激活，工具集一次到位。apply_patch 是主编辑工具，务必与
    // 「修改/修复/实现」同组，否则改代码的请求可能拿不到它。
    tools: ["dev_check", "code_search", "verify_project", "apply_patch"],
    keywords: ["开发", "代码", "测试", "lint", "验证", "调试", "debug", "dev", "test", "verify", "code", "search", "报错", "修复", "修改", "实现", "编程", "代码搜索", "代码检查", "项目验证", "code search", "跑测试", "运行测试", "改成", "改为", "替换", "重构", "patch", "edit", "编辑"],
  },
  report: {
    // 报告生成工具：report（generate/templates/email_digest/weekly）
    tools: ["report"],
    keywords: ["报告", "report", "周报", "生成报告", "总结报告", "报告生成", "weekly", "邮件摘要", "email digest"],
  },
  document: {
    // 办公文档生成工具：document（create_docx / create_xlsx / create_pptx）
    // 此前未分组 → 逐轮常驻（≈1.7K 字符）。与 report 分开成组：report 是
    // 「总结/汇总」语义，document 是「产出文件」语义，关键词几乎不重叠。
    tools: ["document"],
    keywords: ["文档", "docx", "xlsx", "pptx", "word", "excel", "ppt", "演示文稿", "幻灯片", "表格", "document"],
  },
  planning: {
    // 任务规划/分类工具：task_plan（decompose/status/templates）/ classify_task（classify/stats）
    tools: ["task_plan", "classify_task"],
    keywords: ["任务分解", "任务规划", "任务分类", "复杂任务", "任务管理", "分解任务", "规划任务", "task decompose", "task plan", "classify task"],
  },
  system: {
    // 系统/内部工具：execute_tool_chain / complete_bootstrap / permission_status / error_stats
    // 这些工具使用频率低，关键词精确匹配即可。
    tools: ["execute_tool_chain", "complete_bootstrap", "permission_status", "error_stats"],
    keywords: ["工具链", "tool chain", "bootstrap", "初始化", "权限状态", "权限检查", "错误统计", "错误恢复", "完成引导"],
  },
};

// ── buildOpenAITools ──

export function buildOpenAITools(
  registeredTools: Map<string, { definition: ToolDefinition; handler: (params: Record<string, unknown>) => Promise<unknown>; checkFn?: () => boolean; dynamicSchemaOverrides?: () => Partial<ToolDefinition> }>,
  message?: string,
  checkFnEvaluator?: (checkFn: () => boolean) => boolean,
  /**
   * ★ P0-2（2026-10-16 缓存命中改造）：会话已激活的工具**单调并集**。
   * 传入时以此为种子做关键词并集（只增不减）——同一会话稳态下 tools JSON
   * 字节恒定，请求体末尾的 tools 段不再逐轮漂移。
   * ★ 2026-10-27 更正：tools 在 key 插入序上位于 messages 之后（请求体末尾），
   * 故 tools 段的字节稳定只影响 **tools 段自身**的缓存命中，不波及 messages
   * 前缀（含冻结系统提示）。本函数仍要保证字节稳定——tools 段约占请求的
   * 18K 字符（≈5K token），逐轮漂移等于每轮重算这 5K token。
   * 不传（或传空）时保持 fresh-session 语义，与旧行为字节一致（向后兼容：
   * /health 工具计数走 message === undefined 全量分支）。
   */
  baseTools?: Set<string> | null,
  /** 出参：本轮激活结果（会话调用方回写 Map，下一轮作为 baseTools 传入）。 */
  out?: { activeTools?: Set<string> },
): OpenAIToolEntry[] {
  // Determine which tool groups to include based on the user message.
  // Core group is always included. Other groups are included if the
  // message contains relevant keywords.
  //
  // Composable toolsets: when a group is activated, recursively activate
  // all groups listed in its `includes` field. Cycle detection via visited
  // set — silently skip already-visited nodes (hermes toolsets.py pattern).
  const activeTools = baseTools && baseTools.size > 0
    ? new Set(baseTools)
    : new Set(TOOL_GROUPS.core.tools);

  const activateGroup = (groupName: string, visited: Set<string>): void => {
    if (visited.has(groupName)) return; // cycle or diamond — skip
    visited.add(groupName);
    const group = TOOL_GROUPS[groupName];
    if (!group) return;
    for (const t of group.tools) activeTools.add(t);
    if (group.includes) {
      for (const inc of group.includes) {
        activateGroup(inc, visited);
      }
    }
  };

  if (message) {
    const lowerMsg = message.toLowerCase();
    for (const [name, group] of Object.entries(TOOL_GROUPS)) {
      if (group.keywords.length > 0 && group.keywords.some(kw => lowerMsg.includes(kw.toLowerCase()))) {
        activateGroup(name, new Set());
      }
    }
    // If the message doesn't match any specific group, include core + skill
    // groups only (inspired by OpenClaw's tool profile strategy).
    // The skill_manage tool can dynamically discover and run other skills,
    // so we don't need to include ALL tools for ambiguous requests.
    //
    // ★ P0-2：仅在会话首消息（base 为空）生效。后续消息的并集已含 skill
    // （首消息激活过）或本就更多，不再反复补 skill 组导致字节抖动。
    if ((baseTools === undefined || baseTools === null || baseTools.size === 0) &&
        activeTools.size <= TOOL_GROUPS.core.tools.length) {
      for (const t of SKILL_DISCOVERY_TOOLS) activeTools.add(t);
    }
  } else {
    // No message provided — include all tools for backward compatibility
    for (const [, group] of Object.entries(TOOL_GROUPS)) {
      for (const t of group.tools) activeTools.add(t);
    }
  }

  if (out) out.activeTools = activeTools;

  // ── 输出分档（★ P0-5：tools 数组的顺序即缓存边界）──
  // tools 是请求体的一段固定前缀。同一会话内若某个工具被插到**数组中间**，
  // 它之后的所有字节全部失配 → 一次全量重算（≈整段 tools 的 token）。
  // 会话工具集是单调并集（只增不减），所以把「本轮新激活的组」排到数组末尾，
  // 前面的字节就逐轮保持前缀稳定：
  //
  //   档 0  core 组（恒定）
  //   档 1  未分组常驻工具 + 创建类工具（两者都恒定下发 → 稳定基座）
  //   档 2  本轮已激活、且上一轮就在并集里的组（按首次激活顺序）
  //   档 3  本轮新激活的组（排最后 → 前缀只增不改）
  const selected = Array.from(registeredTools.values())
    .filter((t) => {
      // ── 1. 可用性门禁（最高优先级）：check_fn 判定不可用的服务一律不下发 ──
      // Service-gated tools: skip tools whose check_fn returns false.
      // Inspired by hermes-agent registry.get_definitions() — unavailable
      // tools are silently dropped so the LLM never sees them.
      //
      // ★ P0-4 缓存稳定化（2026-10-26）：已进入会话单调并集（baseTools）的工具
      // 跳过 checkFn 过滤——tools 段在请求体末尾，checkFn 抖动（服务短暂不可用
      // →恢复）会导致 tools JSON 逐轮漂移 → tools 段（≈18K 字符 ≈5K token）每轮
      // 重算。会话内已激活的工具保持在场，模型尝试调用时由执行期 checkFn 兜底报错。
      if (t.checkFn) {
        const isInSessionUnion = baseTools?.has(t.definition.name) ?? false;
        if (!isInSessionUnion) {
          if (checkFnEvaluator) {
            // 包装 checkFnEvaluator，防止其内部异常冒泡导致整个 buildOpenAITools 失败
            try {
              if (!checkFnEvaluator(t.checkFn)) return false;
            } catch {
              return false; // fail-safe: exceptions treated as unavailable
            }
          } else {
            // Fallback: evaluate directly without caching
            try {
              if (!t.checkFn()) return false;
            } catch {
              return false; // fail-safe: exceptions treated as unavailable
            }
          }
        }
      }

      // ── 2. 永不裁剪「创建/添加/注册」类工具 ──
      // 关键词激活是 best-effort 的，措辞稍有变化就可能漏激活某个组。
      // 一旦「新增某物」的工具因此消失，模型会直接失去该能力并误判
      // 「系统没有提供接口」（真实事故：说「添加邮箱账户」时 email 组关键词
      // 缺「邮箱」，email / add_account 被裁，模型遂称无法添加邮箱）。
      // 这类工具数量有限且价值极高，故无条件下发（但仍受上面的可用性门禁约束）。
      if (isCreationTool(t.definition.name)) return true;

      // ── 3. 按关键词激活结果裁剪组内的非创建类工具（省 token）──
      // Include tool if it's in the active set OR if it's not in any TOOL_GROUP
      // (i.e., dynamically registered tools not covered by groups are always included)
      const isInAnyGroup = Object.values(TOOL_GROUPS).some(g => g.tools.includes(t.definition.name));
      if (!activeTools.has(t.definition.name) && isInAnyGroup) return false;

      return true;
    });

  // 工具名 → 所属组（一个工具只记第一次出现的组，避免重复）
  const groupOfTool = new Map<string, string>();
  for (const [gName, g] of Object.entries(TOOL_GROUPS)) {
    for (const t of g.tools) if (!groupOfTool.has(t)) groupOfTool.set(t, gName);
  }
  const byName = new Map(selected.map((t) => [t.definition.name, t]));

  const ranked: typeof selected = [];
  const used = new Set<string>();
  const take = (names: string[]): void => {
    for (const n of names) {
      const t = byName.get(n);
      if (t && !used.has(t.definition.name)) {
        used.add(t.definition.name);
        ranked.push(t);
      }
    }
  };

  // 档 0：core
  take(TOOL_GROUPS.core.tools);
  // 档 1：未分组常驻（恒定下发）+ 创建类（白名单恒定下发）
  take(
    Array.from(byName.keys()).filter((n) => !groupOfTool.has(n) || isCreationTool(n)),
  );
  // 档 2 / 档 3：已激活的组按「首次激活顺序」排列。
  //
  // 顺序来源 = baseTools 的**插入序**（Set 的迭代序就是上一轮 tools 的激活序），
  // 取组内工具的最小序号作为该组位次。这一点很关键：若改用「组声明序」，
  // 某个后声明的组先激活、先声明组后激活时，后激活组一旦转为「已激活」
  // 就会跳到前面去 → 数组中间插入 → 缓存全量失配（真实回归，见
  // llm-caller.test.ts「同轮激活多个组」用例）。
  // 用插入序则「谁先激活谁靠前」，组一旦落位永不移动，前缀逐轮只增不改。
  const baseOrder = new Map<string, number>();
  // 注意：Set.forEach 的第二个实参是 value 而非下标，必须自己计数
  let bi = 0;
  for (const t of baseTools ?? []) {
    if (!baseOrder.has(t)) baseOrder.set(t, bi);
    bi++;
  }
  const groupRank = (g: ToolGroupDef): number => {
    let rank = Number.POSITIVE_INFINITY;
    for (const t of g.tools) {
      const i = baseOrder.get(t);
      if (i !== undefined && i < rank) rank = i;
    }
    return rank;
  };
  const activeGroups = Object.entries(TOOL_GROUPS)
    .filter(([, g]) => g.tools.some((t) => activeTools.has(t)))
    .sort((a, b) => {
      const ra = groupRank(a[1]);
      const rb = groupRank(b[1]);
      // 两者都未入并集（本轮新激活）→ 保持声明序（sort 稳定）
      if (ra === Number.POSITIVE_INFINITY && rb === Number.POSITIVE_INFINITY) return 0;
      return ra - rb;
    });
  for (const [, g] of activeGroups) take(g.tools);

  return ranked
    .map((t) => {
      // Dynamic schema overrides: allow tools to inject runtime-dependent
      // description/parameters at schema build time (hermes pattern).
      let effectiveDef = t.definition;
      if (t.dynamicSchemaOverrides) {
        try {
          const overrides = t.dynamicSchemaOverrides();
          if (overrides && typeof overrides === "object") {
            // 过滤掉 undefined 值，避免覆盖现有字段（如 overrides 仅返回 description 时不应清空 parameters）
            const filtered: Partial<ToolDefinition> = {};
            for (const [k, v] of Object.entries(overrides)) {
              if (v !== undefined) (filtered as Record<string, unknown>)[k] = v;
            }
            effectiveDef = { ...t.definition, ...filtered };
          }
        } catch {
          // fail-safe: use static schema on exception
        }
      }

      const props: Record<string, unknown> = {};
      const required: string[] = [];

      // wrapped/flat 归一化（见 normalizeToolParameters）——此前 wrapped 风格
      // 直接迭代会生成 {type, properties, required} 三个字符串参数的损坏 schema。
      const { properties: params, required: topLevelRequired } = normalizeToolParameters(effectiveDef.parameters);
      for (const [key, paramDef] of Object.entries(params)) {
        const p = paramDef as Record<string, unknown>;
        // 完整透传 schema（items/minItems/additionalProperties/嵌套 properties 等）；
        // 仅在缺省时补 type/description 兜底——此前重建子集会丢失嵌套结构。
        const prop: Record<string, unknown> = { ...p };
        // ★ 2026-10-30 修复（v6 压测 Agnes-china 400 错误）：递归剥离所有层级的 required 字段。
        //   JSON Schema 规范中 required 是对象级别字段（字符串数组），不是属性内部字段。
        //   Agnes-china（OpenAI 兼容网关）严格校验：属性内部的 required: false 会导致
        //   400 Bad Request（"False is not of type 'array'"）。所有工具定义都使用了
        //   flat 风格的 required: true/false 在属性内部——包括嵌套在 items.properties
        //   内部的子属性（如 document-tools.ts 的表格行/单元格定义）。此前仅删除顶层
        //   属性的 required，嵌套层级的仍然泄漏到 API → 400。
        //   顶层 required 数组已由 line 2258-2262 的启发式逻辑生成。
        stripNestedRequired(prop);
        if (!prop.type) prop.type = "string";
        if (!prop.description) prop.description = key;
        props[key] = prop;
        // wrapped schema 以顶层 required 数组为准；flat schema 走逐属性启发式
        // （与 validateToolParams 一致：描述里标 "Optional" 的参数不进 required 列表）
        if (topLevelRequired !== undefined) {
          if (topLevelRequired.includes(key)) required.push(key);
        } else if (p.required !== false && p.default === undefined && !/optional/i.test(String(p.description ?? ""))) {
          required.push(key);
        }
      }

      return {
        type: "function",
        function: {
          name: effectiveDef.name,
          description: effectiveDef.description,
          parameters: {
            type: "object",
            properties: props,
            required,
          },
        },
      };
    });
}

// ── StreamingTagScrubber ──
// 灵感来自 hermes-agent StreamingThinkScrubber：有状态的流式标签清洗器，
// 处理跨 chunk 分裂的 <think>/<reasoning> 等推理标签，防止内部推理
// 内容泄漏到用户输出。状态机跟踪是否在标签内，部分标签跨 chunk 持留。

const SCRUBBER_OPEN_TAGS = ["<think>", "<thinking>", "<reasoning>", "<thought>"];
const SCRUBBER_CLOSE_TAGS = ["</think>", "</thinking>", "</reasoning>", "</thought>"];
const SCRUBBER_MAX_TAG_LEN = Math.max(...SCRUBBER_OPEN_TAGS.concat(SCRUBBER_CLOSE_TAGS).map(t => t.length));

/**
 * 有状态的流式标签清洗器。
 * feed() 接收 delta 文本，返回清洗后的可见文本。
 * flush() 在流结束时调用，返回持留的缓冲区。
 * reset() 在每个新 turn 开始时调用。
 */
export class StreamingTagScrubber {
  private inSpan = false;
  private buf = "";
  /**
   * 被清洗掉的推理内容（<think> / <reasoning> / <thinking> / <thought> 内部文本）。
   *
   * 真实事故（2026-10-08）：用户反馈「任务完成后整个思考过程一点都看不到」。
   * 根因之一就是这里 —— span 内的推理文本被**直接丢弃**，既没进正文也没留存。
   * 现在把它累积起来，由调用方取走作为「思考轨迹」的一部分。
   */
  private capturedReasoning = "";

  /** 取走已捕获的推理文本（并清空累积器）。 */
  takeReasoning(): string {
    const v = this.capturedReasoning;
    this.capturedReasoning = "";
    return v;
  }

  /** 只读查看已捕获的推理文本长度，便于流式判断是否需要上报。 */
  get reasoningLength(): number {
    return this.capturedReasoning.length;
  }

  /** 处理一个 delta，返回可见文本。 */
  feed(text: string): string {
    if (!text) return "";
    let output = "";
    this.buf += text;

    while (this.buf.length > 0) {
      if (this.inSpan) {
        // 在 span 内：寻找闭合标签
        const closeIdx = this.findCloseTag(this.buf);
        if (closeIdx >= 0) {
          // 找到闭合标签：span 内容**不输出到正文，但累积到推理轨迹**
          const closeTag = this.matchCloseTag(this.buf, closeIdx);
          this.capturedReasoning += this.buf.slice(0, closeIdx);
          this.buf = this.buf.slice(closeIdx + closeTag.length);
          this.inSpan = false;
        } else {
          // 未找到闭合标签，持留可能是部分闭合标签的尾部
          const partialSuffix = this.maxPartialCloseSuffix(this.buf);
          if (partialSuffix.length > 0) {
            // 持留部分标签，其余作为推理内容累积
            this.capturedReasoning += this.buf.slice(0, this.buf.length - partialSuffix.length);
            this.buf = this.buf.slice(this.buf.length - partialSuffix.length);
          } else {
            // 无部分标签：全部累积为推理内容（在 span 内的内容不输出到正文）
            this.capturedReasoning += this.buf;
            this.buf = "";
          }
          break; // 等待更多 delta
        }
      } else {
        // 在 span 外：寻找开标签
        const openIdx = this.findOpenTag(this.buf);
        if (openIdx >= 0) {
          // 找到开标签，输出标签前的文本
          output += this.buf.slice(0, openIdx);
          const openTag = this.matchOpenTag(this.buf, openIdx);
          this.buf = this.buf.slice(openIdx + openTag.length);
          this.inSpan = true;
        } else {
          // 未找到开标签，输出除可能的部分标签尾部外的所有内容
          const partialSuffix = this.maxPartialOpenSuffix(this.buf);
          if (partialSuffix.length > 0) {
            output += this.buf.slice(0, this.buf.length - partialSuffix.length);
            this.buf = partialSuffix;
          } else {
            output += this.buf;
            this.buf = "";
          }
          break; // 等待更多 delta
        }
      }
    }

    return output;
  }

  /** 流结束时调用，返回持留的缓冲区。 */
  flush(): string {
    if (this.inSpan) {
      // 仍在未闭合 span 内：这段文本**同样是模型推理**，不能丢——
      // 累计进 capturedReasoning 交给调用方入轨迹，只是不进正文。
      // （原实现直接 buf="" 丢弃，未闭合 <think> 的推理会凭空消失。）
      this.capturedReasoning += this.buf;
      this.buf = "";
      this.inSpan = false;
      return "";
    }
    const tail = this.buf;
    this.buf = "";
    return tail;
  }

  /** 每个新 turn 开始时调用。 */
  reset(): void {
    this.inSpan = false;
    this.buf = "";
  }

  private findCloseTag(text: string): number {
    let minIdx = -1;
    for (const tag of SCRUBBER_CLOSE_TAGS) {
      const idx = text.toLowerCase().indexOf(tag);
      if (idx >= 0 && (minIdx < 0 || idx < minIdx)) {
        minIdx = idx;
      }
    }
    return minIdx;
  }

  private matchCloseTag(text: string, idx: number): string {
    const lower = text.toLowerCase();
    for (const tag of SCRUBBER_CLOSE_TAGS) {
      if (lower.startsWith(tag, idx)) return tag;
    }
    return SCRUBBER_CLOSE_TAGS[0]; // fallback
  }

  private findOpenTag(text: string): number {
    let minIdx = -1;
    for (const tag of SCRUBBER_OPEN_TAGS) {
      const idx = text.toLowerCase().indexOf(tag);
      if (idx >= 0 && (minIdx < 0 || idx < minIdx)) {
        minIdx = idx;
      }
    }
    return minIdx;
  }

  private matchOpenTag(text: string, idx: number): string {
    const lower = text.toLowerCase();
    for (const tag of SCRUBBER_OPEN_TAGS) {
      if (lower.startsWith(tag, idx)) return tag;
    }
    return SCRUBBER_OPEN_TAGS[0]; // fallback
  }

  /** 返回 buf 的最长后缀，该后缀是某个闭合标签的前缀。 */
  private maxPartialCloseSuffix(buf: string): string {
    const lower = buf.toLowerCase();
    for (let len = Math.min(buf.length, SCRUBBER_MAX_TAG_LEN - 1); len > 0; len--) {
      const suffix = lower.slice(lower.length - len);
      for (const tag of SCRUBBER_CLOSE_TAGS) {
        if (tag.startsWith(suffix)) return buf.slice(buf.length - len);
      }
    }
    return "";
  }

  /** 返回 buf 的最长后缀，该后缀是某个开标签的前缀。 */
  private maxPartialOpenSuffix(buf: string): string {
    const lower = buf.toLowerCase();
    for (let len = Math.min(buf.length, SCRUBBER_MAX_TAG_LEN - 1); len > 0; len--) {
      const suffix = lower.slice(lower.length - len);
      for (const tag of SCRUBBER_OPEN_TAGS) {
        if (tag.startsWith(suffix)) return buf.slice(buf.length - len);
      }
    }
    return "";
  }
}

// ── Anthropic 原生 Messages API 格式转换 ──
// Anthropic 官方端点为 POST /v1/messages（非 OpenAI 兼容的
// /v1/chat/completions），请求/响应/SSE 事件格式均不同。以下转换函数
// 把通用（OpenAI 兼容）格式与 Anthropic 原生格式互转，仅在
// provider.provider === "anthropic" 时启用，不影响其他 provider。

/** Anthropic tool_choice：auto→{type:"auto"}，required→{type:"any"}。 */
function convertToolChoiceToAnthropic(
  toolChoice: "auto" | "required" | "none",
): Record<string, unknown> | undefined {
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice === "auto") return { type: "auto" };
  return undefined; // "none"：不传 tools
}

/** OpenAI function tool → Anthropic tool（input_schema 而非 parameters）。 */
function convertToolsToAnthropic(
  tools: Array<{ type: string; function: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/**
 * 提取消息文本/多模态内容为 Anthropic content blocks。
 * - 字符串内容：无 cache_control 时返回单 text block；有 cache_control 时
 *   挂在 block 上（Anthropic 断点语义要求 cache_control 在 content block 上，
 *   而非 message 对象上）。
 * - ChatContent[]（text/image_url/input_audio/file）→ Anthropic
 *   text/image/document/audio blocks（data URI 拆出 base64 source）。
 */
interface AnthropicContentPart {
  type?: string;
  text?: string;
  image_url?: { url?: string };
  file?: { data?: string; mimeType?: string; filename?: string };
  input_audio?: { data?: string; format?: "wav" | "mp3" | "flac" | "ogg" };
}

function extractAnthropicContentBlocks(
  content: unknown,
  cacheCtrl: unknown,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  if (typeof content === "string") {
    blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const partRaw of content as Array<unknown>) {
      const part = partRaw as AnthropicContentPart | null | undefined;
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") {
        blocks.push({ type: "text", text: part.text });
      } else if (part.type === "image_url") {
        const url = part.image_url?.url;
        if (typeof url === "string") {
          const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(url);
          if (m) {
            blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
          } else {
            blocks.push({ type: "image", source: { type: "url", url } });
          }
        }
      } else if (part.type === "file") {
        if (typeof part.file?.data === "string") {
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: part.file.mimeType || "application/pdf", data: part.file.data },
          });
        }
      } else if (part.type === "input_audio") {
        if (typeof part.input_audio?.data === "string") {
          const audioMime =
            { wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg" }[part.input_audio.format ?? "wav"];
          blocks.push({ type: "audio", source: { type: "base64", media_type: audioMime, data: part.input_audio.data } });
        }
      }
    }
  }

  // cache_control 只能挂在最后一个 block 上（Anthropic 断点语义）
  if (cacheCtrl && blocks.length > 0) {
    blocks[blocks.length - 1].cache_control = cacheCtrl;
  }
  return blocks;
}

/**
 * 通用消息数组 → Anthropic Messages API 格式。
 * - system 消息 → 顶层 system 字段（content blocks 数组，保留 cache_control）
 * - assistant tool_calls → content 中的 tool_use blocks
 * - role:"tool" 工具结果 → user 消息中的 tool_result blocks
 *   （连续 tool 消息合并进同一条 user 消息，符合 Anthropic 工具往返约定）
 */
function convertMessagesToAnthropic(
  messages: Array<Record<string, unknown>>,
): { system?: unknown; messages: Array<Record<string, unknown>> } {
  const systemBlocks: Array<Record<string, unknown>> = [];
  const out: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    const role = m.role;
    const cacheCtrl = m.cache_control;

    if (role === "system") {
      // system 段：字符串内容转 text block，透传 message 级 cache_control
      if (typeof m.content === "string") {
        const block: Record<string, unknown> = { type: "text", text: m.content };
        if (cacheCtrl) block.cache_control = cacheCtrl;
        systemBlocks.push(block);
      } else if (Array.isArray(m.content)) {
        const parts = extractAnthropicContentBlocks(m.content, undefined);
        if (cacheCtrl && parts.length > 0) {
          // cache_control 只挂在最后一个 block（Anthropic 断点语义）
          parts[parts.length - 1].cache_control = cacheCtrl;
        }
        systemBlocks.push(...parts);
      }
      continue;
    }

    // 工具结果消息 → user 消息中的 tool_result block
    if (role === "tool") {
      const block: Record<string, unknown> = {
        type: "tool_result",
        tool_use_id: String(m.tool_call_id ?? ""),
        content: typeof m.content === "string"
          ? m.content
          : (m.content ? JSON.stringify(m.content) : ""),
      };
      // 连续 tool 消息合并进同一个 user 消息（多个 tool_result blocks）
      const last = out[out.length - 1];
      if (
        last && last.role === "user" && Array.isArray(last.content) &&
        (last.content as Array<Record<string, unknown>>).length > 0 &&
        (last.content as Array<Record<string, unknown>>).every((b) => b?.type === "tool_result")
      ) {
        (last.content as Array<Record<string, unknown>>).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    // assistant 消息：tool_calls → tool_use blocks
    const toolCalls = Array.isArray(m.tool_calls)
      ? (m.tool_calls as Array<Record<string, unknown>>)
      : [];
    const contentBlocks = extractAnthropicContentBlocks(m.content, undefined);
    for (const tc of toolCalls) {
      const fn = tc.function as Record<string, unknown> | undefined;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(String(fn?.arguments ?? "{}"));
      } catch {
        // 参数 JSON 不完整时保留空对象（Anthropic 要求 input 为对象）
      }
      contentBlocks.push({
        type: "tool_use",
        id: String(tc.id ?? ""),
        name: String(fn?.name ?? ""),
        input,
      });
    }
    // cache_control 统一挂在最后一个 block（tool_use 或 text）上
    if (cacheCtrl && contentBlocks.length > 0) {
      contentBlocks[contentBlocks.length - 1].cache_control = cacheCtrl;
    }
    out.push({
      role: role === "assistant" ? "assistant" : "user",
      content: contentBlocks,
    });
  }

  const result: { system?: unknown; messages: Array<Record<string, unknown>> } = { messages: out };
  if (systemBlocks.length > 0) result.system = systemBlocks;
  return result;
}

/**
 * Anthropic 非流式响应 → OpenAI Chat Completions 形状。
 * content blocks 中的 text 拼接为 content；tool_use blocks 转 tool_calls；
 * usage 的 input/output tokens 映射为 total/prompt/completion，并透传
 * cache_read_input_tokens / cache_creation_input_tokens（normalizeUsage 识别）。
 */
function convertAnthropicResponseToOpenAI(data: unknown): Record<string, unknown> {
  const d = (data ?? {}) as {
    content?: Array<Record<string, unknown>>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  const blocks = Array.isArray(d.content) ? d.content : [];
  let text = "";
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (block?.type === "tool_use") {
      toolCalls.push({
        id: String(block.id ?? ""),
        type: "function",
        function: {
          name: String(block.name ?? ""),
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  const usage = d.usage ?? {};
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    choices: [{
      message: {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    }],
    usage: {
      total_tokens: inputTokens + outputTokens,
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      ...(usage.cache_read_input_tokens !== undefined
        ? { cache_read_input_tokens: usage.cache_read_input_tokens }
        : {}),
      ...(usage.cache_creation_input_tokens !== undefined
        ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
        : {}),
    },
  };
}

// ── parseStreamingResponse ──

export async function parseStreamingResponse(
  response: NativeFetchResponse,
  provider: ProviderConfig,
  startTime: number,
  onProgress: AgentProgressCallback,
  deps: LLMCallerDeps,
  /** 思考轨迹采集器（可选） */
  trace?: ThinkingTrace,
  /** 是否让 token/status-generating 事件携带全量累积 reply（默认 false，只带 delta 增量） */
  includeAccumulatedReplyInTokenEvents = false
): Promise<ParseStreamingResponseResult | null> {
  const observability = deps.registry?.resolveService?.("observability") as any;
  const tracing = observability?.getTracingService?.();

  const doParse = async (): Promise<ParseStreamingResponseResult | null> => {
  if (!response.body) {
    process.stderr.write(`[LLMCaller] Stream response has no body\n`);
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let content = "";
  // 流式重复看门狗（hermes RunawayStreamWatch）：模型陷入退化重复循环时
  // 在流式输出中途中断，避免耗尽整个 turn 并把垃圾送进最终回复。
  const runawayWatch = new RunawayStreamWatch();
  // 流式标签清洗器：清洗 <think>/<reasoning> 等推理标签，防止泄漏到用户输出。
  // 灵感来自 hermes-agent StreamingThinkScrubber（有状态跨 chunk 处理）。
  const tagScrubber = new StreamingTagScrubber();
  const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
  let totalTokens = 0;
  let promptTokens = 0;
  // 原始 usage 对象（provider 最后/带 usage 的 chunk）——透传给 record()
  // 供 normalizeUsage 提取 cache_read_input_tokens / cached_tokens（缓存命中真值）。
  let streamUsageDetails: unknown = undefined;
  let lastChunkTime = Date.now();
  // fix-4: 跟踪 finish_reason 以检测 length 截断等场景
  let finishReason: string | undefined;

  // ── Anthropic 原生 Messages API 流式事件状态 ──
  // message_start 携带 input_tokens + cache 字段；message_delta 携带
  // 累计 output_tokens；事件格式见 Anthropic Messages API streaming 文档。
  let anthropicUsageSeen = false;
  let anthropicInputTokens = 0;
  let anthropicOutputTokens = 0;
  let anthropicCacheRead: number | undefined;
  let anthropicCacheCreation: number | undefined;
  // Anthropic 文本增量触发重复看门狗中断时置位（跳出当前行循环，
  // 与 OpenAI 路径 `break` 行为一致）
  let runawayInterrupted = false;

  // ── 分轮气泡标记（2026-10-08）──
  // 用户反馈「下一条内容冲掉上一条」。根因是前端靠长度猜测换轮。
  // 轮次序号由主循环经 trace.nextRound() 自增，这里只读取；
  // roundStarted 保证 roundIndex 只在该轮**首个**正文 token 上出现一次。
  // 注意：没传 trace 时（老调用方）roundIndex 恒为 1 —— 单次调用只有一轮，
  // 语义正确（原 `fallbackRound` 变量从不自增，等价于常量 1，已删除）。
  let roundStarted = false;

  // ── 推理原文实时下发（2026-10-08）──
  // 事故：用户用小米模型时，展开"执行过程"只看到铺天盖地的
  // 「正在生成回复...」，而模型的思考/分析原文一个字都没有。
  // 根因：推理内容（reasoning_content / <think>）此前只 `trace.add*()`
  // 写进内存轨迹，**从不下发 progress 事件** —— 落盘了 ≠ 用户看得到。
  // 实测 mimo-v2.6-flash 是 2–6 字一个 chunk 流式下发推理的，
  // 所以这里逐 chunk 下发 delta，同时按节流附带完整轨迹快照
  // （快照体积大，不能每个 chunk 都带）。
  let reasoningAccum = "";
  let lastReasoningPushAt = 0;
  const REASONING_SNAPSHOT_MS = 400;

  // ── 文本增量统一处理（OpenAI delta.content / Anthropic text_delta 共用）──
  // 清洗推理标签 → 看门狗 → token/status 事件下发。返回 true 表示触发
  // 重复看门狗中断（调用方须跳出当前行的 for 循环，与 OpenAI 路径行为一致）。
  const handleTextDelta = (rawText: string): boolean => {
    const currentRound = trace ? trace.round : 1;
    // 通过清洗器处理 delta，清洗 <think>/<reasoning> 等推理标签
    const cleaned = tagScrubber.feed(rawText);
    // 清洗器丢弃的推理内容转存进思考轨迹（不进正文，但完整保留）
    if (tagScrubber.reasoningLength > 0) {
      const reasoning = tagScrubber.takeReasoning();
      if (reasoning.trim()) {
        trace?.appendReasoning(reasoning, currentRound);
        reasoningAccum += reasoning;
        const nowMs = Date.now();
        const withSnapshot = nowMs - lastReasoningPushAt >= REASONING_SNAPSHOT_MS;
        if (withSnapshot) lastReasoningPushAt = nowMs;
        onProgress({
          type: "reasoning",
          phase: "thinking",
          detail: "模型思考中…",
          progress: 55,
          reasoningDelta: reasoning,
          reasoningText: reasoningAccum,
          roundIndex: currentRound,
          ...(withSnapshot && trace ? { thinkingSteps: trace.toJSON() } : {}),
        });
      }
    }
    content += cleaned;

    // ── 流式重复看门狗（hermes RunawayStreamWatch）──
    // 模型陷入退化重复循环时，在流式输出中途中断，
    // 避免耗尽整个 turn 并把垃圾送进最终回复。
    // 中断检查点丢弃被循环污染的部分（对齐 hermes
    // REPETITION_LOOP_INTERRUPTED 语义）。
    if (runawayWatch.feed(cleaned)) {
      content += REPETITION_LOOP_INTERRUPTED;
      process.stderr.write(
        `[LLMCaller] Runaway repetition detected after ${runawayWatch.getChars()} chars; interrupting stream for session\n`,
      );
      onProgress({
        type: "status",
        phase: "generating",
        detail: "检测到回复陷入重复循环，已中断输出。",
        progress: 80,
      });
      return true;
    }

    // ── Token-level streaming ──
    // Fire a `token` event for every cleaned delta so the client can
    // render incrementally without diffing the accumulated `reply`.
    // Backward-compat: still emit the throttled `status` event with
    // the full accumulated `reply` for older clients that expect it.
    if (cleaned) {
      // ★ roundIndex：只在本轮**首个**正文 token 上携带一次。
      // 前端据此新建气泡，从而「每轮回复各占一个气泡、互不覆盖」
      // （用户反馈 2026-10-08：输出框互相冲掉）。
      // 用局部变量标记，避免每个 token 都重复声明同一轮。
      const isFirstTokenOfRound = !roundStarted;
      if (isFirstTokenOfRound) roundStarted = true;
      const currentRoundForToken = trace ? trace.round : 1;
      // P0 欠账修复（2026-10-12）：默认 token 事件只携带 delta 增量，
      // 不再塞整条累积 reply（旧实现一次 3MB 任务的流里 token 事件
      // 占 95% 体积、平方增长）。includeAccumulatedReplyInTokenEvents
      // 供旧客户端按需开启全量替换渲染；前端按 reply 存在与否自动
      // 决定走增量还是全量路径，无需额外兼容判断。
      onProgress({
        type: "token",
        phase: "generating",
        detail: "正在生成回复...",
        progress: 80,
        delta: cleaned,
        ...(includeAccumulatedReplyInTokenEvents ? { reply: content } : {}),
        ...(isFirstTokenOfRound ? { roundIndex: currentRoundForToken } : {}),
      });
    }

    const now = Date.now();
    if (now - lastChunkTime > 50) {
      // P0 欠账修复（2026-10-12）：status+generating 是前端噪声过滤的对象
      // （WebChatPage.tsx isNoiseProgressStep），但事件体仍每 50ms 携带
      // 全量累积 reply —— 与 token 事件同源的体积浪费。token 事件已默认
      // 只发 delta，status 事件不再携带 reply（保留 phase/detail/progress
      // 供状态栏使用；旧客户端若依赖 status.reply 做全量替换，会被
      // token 增量路径覆盖——前端按 reply 存在与否自动分流，无需改动）。
      onProgress({
        type: "status",
        phase: "generating",
        detail: "正在生成回复...",
        progress: 80,
        ...(includeAccumulatedReplyInTokenEvents ? { reply: content } : {}),
      });
      lastChunkTime = now;
    }
    return false;
  };

  let streamReadError: unknown = null;
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
            type?: string;
            index?: number;
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
            usage?: {
              total_tokens?: number;
              prompt_tokens?: number;
              completion_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
              input_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number } | null;
              // Anthropic message_delta 事件携带的累计 output_tokens
              input_tokens?: number;
              output_tokens?: number;
            };
            // ── Anthropic 原生 Messages API 流式事件字段 ──
            message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
            content_block?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };
            delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; stop_reason?: string };
            error?: { type?: string; message?: string };
          };

          // ── Anthropic 原生 Messages API 流式事件分支 ──
          // 事件类型：message_start / content_block_start / content_block_delta /
          // content_block_stop / message_delta / message_stop（见 Anthropic
          // Messages API streaming 文档）。与 OpenAI chunk（choices 数组）互斥，
          // 命中后 continue，不进入下方 OpenAI 解析路径。
          if (
            typeof chunk.type === "string" &&
            (chunk.type === "message_start" || chunk.type === "message_delta" ||
              chunk.type === "message_stop" || chunk.type === "error" ||
              chunk.type.startsWith("content_block_"))
          ) {
            switch (chunk.type) {
              case "message_start": {
                const u = chunk.message?.usage;
                if (u) {
                  anthropicUsageSeen = true;
                  anthropicInputTokens = u.input_tokens ?? 0;
                  anthropicOutputTokens = u.output_tokens ?? 0;
                  anthropicCacheRead = u.cache_read_input_tokens;
                  anthropicCacheCreation = u.cache_creation_input_tokens;
                }
                break;
              }
              case "content_block_start": {
                const cb = chunk.content_block;
                if (cb?.type === "tool_use") {
                  // 工具调用开始：记录 id/name，参数由后续 input_json_delta 累积
                  const idx = chunk.index ?? toolCallsMap.size;
                  toolCallsMap.set(idx, { id: cb.id || "", name: cb.name || "", arguments: "" });
                  // ── 进度反馈：流式工具调用首次出现时上报 ──
                  if (cb.name && onProgress) {
                    onProgress({
                      type: "status",
                      phase: "thinking",
                      detail: `📋 LLM 决定调用:${cb.name}`,
                      progress: 45,
                    });
                  }
                }
                break;
              }
              case "content_block_delta": {
                const d = chunk.delta;
                if (d?.type === "text_delta" && d.text) {
                  // 文本增量：与 OpenAI delta.content 共用清洗/看门狗/事件下发
                  // 返回 true 表示触发重复看门狗中断（与 OpenAI 路径一致，
                  // 跳出当前行循环，丢弃本批剩余行）。
                  if (handleTextDelta(d.text)) {
                    runawayInterrupted = true;
                    break;
                  }
                } else if (d?.type === "input_json_delta" && d.partial_json) {
                  // 工具参数 JSON 分片累积
                  const idx = chunk.index ?? 0;
                  const existing = toolCallsMap.get(idx);
                  if (existing) existing.arguments += d.partial_json;
                } else if (d?.type === "thinking_delta" && d.thinking) {
                  // 推理增量（Anthropic extended thinking）：与 reasoning_content 同路径
                  const currentRound = trace ? trace.round : 1;
                  trace?.appendReasoning(d.thinking, currentRound);
                  reasoningAccum += d.thinking;
                  const nowMs = Date.now();
                  const withSnapshot = nowMs - lastReasoningPushAt >= REASONING_SNAPSHOT_MS;
                  if (withSnapshot) lastReasoningPushAt = nowMs;
                  onProgress({
                    type: "reasoning",
                    phase: "thinking",
                    detail: "模型思考中…",
                    progress: 55,
                    reasoningDelta: d.thinking,
                    reasoningText: reasoningAccum,
                    roundIndex: currentRound,
                    ...(withSnapshot && trace ? { thinkingSteps: trace.toJSON() } : {}),
                  });
                }
                break;
              }
              case "message_delta": {
                // 末段 usage（累计 output_tokens）+ stop_reason
                const u = chunk.usage;
                if (u) {
                  anthropicUsageSeen = true;
                  if (u.output_tokens !== undefined) anthropicOutputTokens = u.output_tokens;
                  if (u.cache_read_input_tokens !== undefined) anthropicCacheRead = u.cache_read_input_tokens;
                  if (u.cache_creation_input_tokens !== undefined) anthropicCacheCreation = u.cache_creation_input_tokens;
                }
                const stopReason = chunk.delta?.stop_reason;
                if (stopReason) {
                  // Anthropic 的 max_tokens 截断映射为 finishReason "length"
                  // （流式恢复按 finishReason === "length" 判断截断）
                  finishReason = stopReason === "max_tokens" ? "length" : stopReason;
                }
                break;
              }
              case "message_stop":
                break;
              case "error": {
                // Anthropic 流内错误事件：记录日志，不中断已交付内容
                process.stderr.write(
                  `[LLMCaller] Anthropic stream error: ${chunk.error?.type ?? "error"}: ${chunk.error?.message ?? ""}\n`,
                );
                break;
              }
            }
            // 重复看门狗中断：跳出当前行循环（与 OpenAI 路径一致）
            if (runawayInterrupted) break;
            continue;
          }

          // ★ OpenAI 原生流式末块携带 usage（stream_options.include_usage=true 时）：
          // `{"choices":[], "usage":{...}}` —— choices 为空、无 delta。
          // 旧 guard `if (!choice?.delta) continue` 会在此块上直接跳过，导致
          // usage/finish_reason 永远读不到（3d3588b 新增的 provider 侧缓存命中
          // 真值链路在原生 OpenAI 流式路径上失效）。改为：usage/finish 在 guard
          // 之前读取，guard 只拦「delta 内容解析」段。
          const choice = chunk.choices?.[0];
          if ((chunk.usage as Record<string, unknown>)?.total_tokens) {
            totalTokens = (chunk.usage as Record<string, unknown>).total_tokens as number;
          }
          if ((chunk.usage as Record<string, unknown>)?.prompt_tokens) {
            promptTokens = (chunk.usage as Record<string, unknown>).prompt_tokens as number;
          }
          // 保留带 cache 明细的最后一个 usage 对象（OpenAI 流式约定：
          // 开启 stream_options.include_usage 后末块携带完整 usage）。
          if (chunk.usage && typeof chunk.usage === "object") {
            streamUsageDetails = chunk.usage;
          }
          // fix-4: 捕获 finish_reason（用于流式恢复判断 length 截断）
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }

          if (!choice?.delta) continue;

          // OpenAI 风格的独立推理字段（部分 provider 会单独返回）
          const reasoningDelta =
            (choice.delta as { reasoning_content?: string | null }).reasoning_content ??
            (choice.delta as { reasoning?: string | null }).reasoning ??
            null;
          const currentRoundForReasoning = trace ? trace.round : 1;

          if (reasoningDelta) {
            // 同一轮内合并成**一整段**（否则几十条碎片，展开后没法读）
            trace?.appendReasoning(reasoningDelta, currentRoundForReasoning);
            reasoningAccum += reasoningDelta;
            const nowMs = Date.now();
            const withSnapshot = nowMs - lastReasoningPushAt >= REASONING_SNAPSHOT_MS;
            if (withSnapshot) lastReasoningPushAt = nowMs;
            onProgress({
              type: "reasoning",
              phase: "thinking",
              detail: "模型思考中…",
              progress: 55,
              reasoningDelta,
              reasoningText: reasoningAccum,
              roundIndex: currentRoundForReasoning,
              ...(withSnapshot && trace ? { thinkingSteps: trace.toJSON() } : {}),
            });
          }

          if (choice.delta.content) {
            // 文本增量统一走 handleTextDelta（清洗推理标签 → 看门狗 →
            // token/status 事件下发），与 Anthropic text_delta 共用同一逻辑。
            // 返回 true 表示触发重复看门狗中断，跳出当前行循环。
            if (handleTextDelta(choice.delta.content)) break;
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
                // ── 进度反馈：流式工具调用首次出现时上报 ──
                if (tc.function?.name) {
                  // ★ 不在此处记 `addDecision`（2026-10-11）：此时参数还在分片
                  //   传输中，只能写占位 `{_partial:true}`，展开轨迹会看到
                  //   `{"_partial": true}` 这种垃圾。决策统一在工具执行前
                  //   （executeSingleToolCall 拿到完整 args 后）记录一次。
                  if (onProgress) {
                    onProgress({
                      type: "status",
                      phase: "thinking",
                      detail: `📋 LLM 决定调用:${tc.function.name}`,
                      progress: 45,
                    });
                  }
                }
              } else {
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              }
            }
          }

        } catch { /* ignore parse errors in individual chunks */ }
      }
    }
  } catch (readErr) {
    streamReadError = readErr;
    process.stderr.write(`[AgentModelExecutor] Stream read error for ${provider.name}:` + " " + readErr + "\n");
  }

  // ── Anthropic 流式 usage 汇总 ──
  // message_start 携带 input_tokens + cache 字段；message_delta 携带累计
  // output_tokens。合并为 normalizeUsage 可识别的 Anthropic 形状（provider
  // 侧缓存命中真值链路）。放在 streamReadError 之前，流恢复路径同样受益。
  if (anthropicUsageSeen) {
    totalTokens = anthropicInputTokens + anthropicOutputTokens;
    promptTokens = anthropicInputTokens;
    streamUsageDetails = {
      input_tokens: anthropicInputTokens,
      output_tokens: anthropicOutputTokens,
      ...(anthropicCacheRead !== undefined ? { cache_read_input_tokens: anthropicCacheRead } : {}),
      ...(anthropicCacheCreation !== undefined ? { cache_creation_input_tokens: anthropicCacheCreation } : {}),
    };
  }

  // 流读取错误时，记录失败指标并尝试流式恢复（fix-4）
  if (streamReadError) {
    const obs = deps.registry?.resolveService<any>("observability");
    if (obs) {
      const latency = Date.now() - startTime;
      try {
        obs.counterIncrement("evoclaw_llm_calls_total", [{ key: "provider", value: provider.provider || "unknown" }, { key: "model", value: provider.model || "unknown" }, { key: "status", value: "error" }], 1);
        obs.histogramObserve("evoclaw_llm_latency_ms", latency, [{ key: "provider", value: provider.provider || "unknown" }, { key: "model", value: provider.model || "unknown" }, { key: "status", value: "error" }]);
      } catch { /* observability is best-effort */ }
    }
    deps.recordProviderFailure?.(provider.id, `Stream read error: ${streamReadError instanceof Error ? streamReadError.message : String(streamReadError)}`, "stream_read_error");

    // ── fix-4: 流式恢复 — 尝试使用已交付的部分内容 ──
    // 借鉴 hermes-agent conversation_loop.py 的多策略流式恢复：
    // 当流式中断时，如果已有部分内容交付，优先使用而非丢弃。
    // 避免浪费已完成的 LLM 调用，提升用户体验。
    if (content.trim() || toolCallsMap.size > 0) {
      // 先 flush 清洗器，获取残留的缓冲内容
      const flushedTail = tagScrubber.flush();
      if (flushedTail) content += flushedTail;

      const recovery = getStreamingRecoveryManager();
      const toolNames = Array.from(toolCallsMap.values()).map((tc) => tc.name).filter(Boolean);
      // 检测是否在 thinking 块中中断（有开标签但无闭标签）
      const hasOpenThink = /<think(?:ing)?\s*>/i.test(content);
      const hasCloseThink = /<\/think(?:ing)?>/i.test(content);
      // 检测是否在 tool-call 中断（参数 JSON 未闭合）
      const interruptedInToolCall = toolCallsMap.size > 0
        && Array.from(toolCallsMap.values()).some((tc) => !tc.arguments.endsWith("}"));

      const result = recovery.recover({
        partialText: content,
        interruptedInThinking: hasOpenThink && !hasCloseThink,
        interruptedInToolCall,
        truncatedByLength: finishReason === "length",
        toolCallsThisTurn: toolNames,
        hasPriorTurnContent: false, // parseStreamingResponse 不感知 prior turns
        retryCount: 0,
      });

      if (result.usedPartialContent && result.response) {
        process.stdout.write(
          `[LLMCaller] Stream recovered via "${result.strategy}" strategy: ${result.response.length} chars ` +
          `(partial was ${content.length} chars)\n`,
        );
        // 构造 tool_calls（与正常路径一致）
        const recoveredToolCalls = toolCallsMap.size > 0
          ? Array.from(toolCallsMap.entries()).map(([, tc]) => ({
              id: tc.id || `tc_${Date.now()}`,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            }))
          : undefined;
        return {
          message: {
            role: "assistant",
            content: result.response,
            tool_calls: recoveredToolCalls,
          },
          tokensUsed: totalTokens || Math.ceil(result.response.length / 4),
          promptTokens,
          responseMs: Date.now() - startTime,
          usageDetails: streamUsageDetails,
        };
      }

      process.stderr.write(
        `[LLMCaller] Stream recovery unsuccessful (strategy: "${result.strategy}"). Discarding ${content.length} chars of partial content.\n`,
      );
    }

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

  const streamResponseMs = Date.now() - startTime;
  deps.recordProviderSuccess(provider.id);

  const toolCalls = toolCallsMap.size > 0
    ? Array.from(toolCallsMap.entries()).map(([, tc]) => ({
        id: tc.id || `tc_${Date.now()}`,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }))
    : undefined;

  // 流结束时 flush 清洗器，处理持留的缓冲区
  const flushedTail = tagScrubber.flush();
  if (flushedTail) {
    content += flushedTail;
  }

  return {
    message: {
      role: "assistant",
      content: content || null,
      tool_calls: toolCalls,
    },
    tokensUsed: totalTokens || Math.ceil(content.length / 4),
    promptTokens: promptTokens || 0,
    responseMs: streamResponseMs,
    usageDetails: streamUsageDetails,
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

// ── 轨迹快照节流器 ──
//
// 思考轨迹要"实时可见"，就得随事件下发；但快照是**全量**的（含推理全文与
// 工具输出），每个 chunk 都带会把 SSE 流撑爆。实测推理 chunk 间隔仅几十毫秒，
// 因此统一按最小间隔节流，`force` 用于 done / auto_continue 这类"必须落地"的节点。
//
// ★ 节流状态必须**按 trace 隔离**（2026-10-11）。原实现用模块级
//   `{ lastAt: 0 }` 单例，被所有 session / 所有并发任务共享：A 会话刚发过快照，
//   B 会话的快照就被吞掉（节流本意是"同一条流最快 300ms 一次"，不是全局）。
//   表现为"某个会话的思考轨迹长时间不更新"，且完全依赖时序、无法复现。
//   WeakMap 让每个 trace 各记自己的时间戳，trace 被回收时条目自动释放。
const traceSnapshotState = new WeakMap<ThinkingTrace, number>();

export function traceSnapshot(
  trace: ThinkingTrace | undefined,
  opts: { force?: boolean; minIntervalMs?: number } = {},
): ThinkingStep[] | undefined {
  if (!trace || trace.isEmpty) return undefined;
  const now = Date.now();
  const min = opts.minIntervalMs ?? 300;
  const lastAt = traceSnapshotState.get(trace) ?? 0;
  if (!opts.force && now - lastAt < min) return undefined;
  traceSnapshotState.set(trace, now);
  return trace.toJSON();
}

// ── callLLMOnce ──

export async function callLLMOnce(
  provider: ProviderConfig,
  messages: Array<LLMMessage>,
  tools: Array<{ type: string; function: Record<string, unknown> }>,
  toolChoice: "auto" | "required" | "none",
  onProgress: AgentProgressCallback | undefined,
  deps: LLMCallerDeps,
  /** 思考轨迹采集器（可选；传入后推理文本与工具决策会被记录） */
  trace?: ThinkingTrace,
  /**
   * 是否让 token/status-generating 事件携带全量累积 reply（默认 false）。
   * P0 欠账修复（2026-10-12）：token 事件历史上每片段都塞整条累积 reply，
   * 一次 3MB 任务的 SSE 流里 token 事件占 95% 体积（平方增长）。
   * 新客户端按 `delta` 增量渲染；旧客户端可传 true 保持全量替换语义。
   */
  includeAccumulatedReplyInTokenEvents = false,
): Promise<CallLLMOnceResult | null> {
  const observability = deps.registry?.resolveService?.("observability") as any;
  const tracing = observability?.getTracingService?.();

  const doCall = async (): Promise<CallLLMOnceResult | null> => {
  // 使用 ?? 保留 timeout=0（表示"无超时"）的显式配置；仅当 undefined/null 时回退默认值
  const timeout = provider.timeout ?? 60000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  if (timeoutId.unref) timeoutId.unref();

  // ── End-to-end cancellation: merge external abort signal with timeout ──
  // When the caller passes deps.abortSignal (e.g., from AgentModelExecutor.abortSession),
  // we propagate its abort to the per-call controller so that in-flight fetches
  // are cancelled immediately. Uses AbortSignal.any() (Node 20+) when available;
  // falls back to manual listener attachment for older runtimes.
  const externalSignal = deps.abortSignal;
  let externalAbortListener: (() => void) | null = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason ?? new Error("aborted"));
    } else if (typeof (AbortSignal as any).any === "function") {
      // Modern path: use AbortSignal.any to combine. We still need a single
      // controller to pass to fetch, so attach a listener.
      externalAbortListener = () => controller.abort(externalSignal.reason ?? new Error("aborted"));
      externalSignal.addEventListener("abort", externalAbortListener, { once: true });
    }
  }

  const baseURL = provider.baseURL || "";
  const isAnthropicProvider = provider.provider === "anthropic";
  const apiURL = isAnthropicProvider
    ? buildAnthropicMessagesUrl(baseURL)
    : buildChatCompletionsUrl(baseURL);

  const startTime = Date.now();
  let callStart = startTime;

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

    // ── Prompt cache: apply cache_control breakpoints ──
    // 灵感来自 hermes-agent 的 system_and_3 策略：在 system prompt + volatile
    // 区域之前的最后 3 条非 system 消息上注入 cache_control: {type: "ephemeral"}，
    // 启用服务端 prompt 缓存。命中缓存时输入 token 按 10% 计费。
    // ★ P0-6（2026-10-28）：断点扩展到 OpenAI 兼容路径。实测 A/B（12 轮探针）：
    // 开断点命中率随 history 增长 17,664→26,880（97-98%）；关断点恒为 17,664
    // （78-83%）——网关**不**自动前缀缓存 history，必须靠 cache_control 断点。
    // 网关接受该字段不报错（全程 200）。故默认开启，EVOCLAW_PROMPT_CACHE_BREAKPOINTS=0
    // 可关闭（个别严格校验未知字段的 OpenAI 兼容端点可按需 opt-out）。
    // ★ P0-5：volatile system 消息（skills 段/动态尾）的合并已在 tryCallLLM 层
    // 完成（一次性，见该处注释），此处只负责断点。
    let messagesToSend = messages;
    const breakpointsEnabled =
      provider.provider === "anthropic" || process.env.EVOCLAW_PROMPT_CACHE_BREAKPOINTS !== "0";
    if (breakpointsEnabled) {
      // P0-3：ContextEngine 分层上下文时，首条 system = frozen + ephemeral。
      // 把断点放在 frozen 段末尾（frozenContent.length），易变尾不拉进缓存块。
      // 非 CE 路径（stableLength undefined）保持旧行为：整条 system 一个断点。
      const ceResult = deps.contextEngineResult;
      const stableLength =
        ceResult && messages[0]?.role === "system"
          ? (ceResult.frozenContent?.length ?? 0) || undefined
          : undefined;
      messagesToSend = applyAnthropicCacheControl(
        messages as unknown as Array<Record<string, unknown>>,
        stableLength,
      ) as unknown as Array<LLMMessage>;
    }

    // ── 请求体：Anthropic 原生 Messages API 与 OpenAI 兼容格式分叉 ──
    // Anthropic 官方端点为 /v1/messages，请求格式不同（system 顶层字段、
    // tool_use/tool_result content blocks、tools 用 input_schema、
    // tool_choice 用 {type} 对象）。
    let body: Record<string, unknown>;
    if (isAnthropicProvider) {
      const anth = convertMessagesToAnthropic(
        messagesToSend as unknown as Array<Record<string, unknown>>,
      );
      body = {
        model: provider.model,
        messages: anth.messages,
        max_tokens: Math.max(1, provider.maxTokens ?? 4096),
        temperature: provider.temperature ?? 0.3,
        top_p: provider.topP ?? 1,
        stream: useStreaming,
      };
      if (anth.system !== undefined) body.system = anth.system;
      if (tools.length > 0 && toolChoice !== "none") {
        body.tools = convertToolsToAnthropic(tools);
        body.tool_choice = convertToolChoiceToAnthropic(toolChoice);
      }
      // 注意：Anthropic 原生端点不支持 reasoning_effort / enable_thinking
      // 等 OpenAI 系推理开关（传了会 400），故跳过 applyReasoningToggle。
    } else {
      body = {
        model: provider.model,
        messages: messagesToSend.map((m) => {
          const msg: Record<string, unknown> = { role: m.role };
          if (m.content !== undefined) msg.content = m.content;
          if (m.tool_calls) msg.tool_calls = m.tool_calls;
          if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
          if (m.name) msg.name = m.name;
          // 透传 cache_control（applyAnthropicCacheControl 设置：anthropic 路径
          // 或默认开启的 OpenAI 兼容路径，EVOCLAW_PROMPT_CACHE_BREAKPOINTS=0 关闭）
          const cacheCtrl = (m as LLMMessage & { cache_control?: unknown }).cache_control;
          if (cacheCtrl) msg.cache_control = cacheCtrl;
          return msg;
        }),
        max_tokens: Math.max(1, provider.maxTokens ?? 4096),
        temperature: provider.temperature ?? 0.3,
        top_p: provider.topP ?? 1,
        stream: useStreaming,
      };

      // ── 流式 usage 上报：OpenAI 原生端点必须显式开启 stream_options.include_usage
      // 才能在末块拿到完整 usage（含 prompt_tokens_details.cached_tokens）──
      // 其他 OpenAI 兼容 provider（DeepSeek/agnes 代理等）默认就回传 chunk.usage，
      // 不动请求体以免个别严格代理 400 拒绝未知字段。
      if (useStreaming && /api\.openai\.com/i.test(provider.baseURL || "")) {
        body.stream_options = { include_usage: true };
      }

      // ★ 2026-10-27 修复：tools 与 tool_choice **始终**显式下发（只要 tools
      //   非空）。旧实现用 `toolChoice !== "none"` 守卫，tc="none" 时两者都不设
      //   → 部分 OpenAI 兼容网关按规范回退默认 "auto" → 模型照常输出
      //   tool_calls（agnes-3.0-flash 实测）。
      //   曾用「把 tools 置空」来强制禁用。tools 虽在请求体**末尾**（插入序在
      //   messages 之后），置空只让缓存在 tools 段处分叉、不影响 messages 前缀，
      //   但 nudge 是**同一会话内反复触发**的路径：每轮都在「有/无」之间翻转，
      //   tools 段自身就永远无法命中。改为「保留 tools + 显式 tool_choice:"none"」：
      //   网关真正收到禁用指令，且请求体字节逐轮完全一致。个别网关若仍无视
      //   tool_choice，由 tryCallLLM 的拒绝兜底拦截（见 toolCallsNoneRefusals），
      //   语义与置空 tools 等价。
      if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = toolChoice;

        if (provider.provider === "deepseek" || provider.name.toLowerCase().includes("deepseek")) {
          // 注：原代码在 toolChoice !== "none" 的块内再判断 `=== "none"`，
          // 该分支永不成立（死代码）。此处只保留 deepseek 的推理标记。
          body.reasoning_type = "deepseek_reasoning";
        }
      }

      // ── 推理开关：让「不同大模型」都能吐出思考原文 ──
      // 实测（2026-10-08）：抓原始 SSE 流逐个探测发现，provider 之间差异极大——
      //   mimo-v2.6-flash 默认只给 7 字推理，加 enable_thinking 后给 50 字，
      //   加 reasoning_effort:high 给 68 字；agnes-3.0-flash 则一个字段都不给。
      // 系统此前**从不**传任何推理开关，所以即便模型本身支持思考，
      // 拿到的也是被"阉割"的一点点，轨迹里几乎没有 reasoning 条目。
      // 这里按 provider 特征补上开关，让能力被用起来。
      applyReasoningToggle(body, provider);
    }

    process.stdout.write(`[AgentModelExecutor] 📡 Calling ${provider.name} API: ${apiURL} (model: ${provider.model}, tool_choice: ${body.tool_choice}, tools: ${tools.length})\n`);
    callStart = Date.now();

    // ── 临时诊断：prompt 组成转储（EVOCLAW_DEBUG_PROMPT_DUMP=1 时启用）──
    // 用途：缓存命中率专项——测量每轮请求各段（system/history/skills/tail/user/tools）
    // 的字符数与内容哈希，定位逐轮漂移的段。仅调试用，默认关闭。
let bodyJson = "";
if (process.env.EVOCLAW_DEBUG_PROMPT_DUMP) {
try {
const msgLines = (body?.messages as Array<{ role: string; content: unknown; cache_control?: unknown }> | undefined)?.map((m, i) => {
          const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
          const h = crypto.createHash("sha256").update(c, "utf-8").digest("hex").slice(0, 12);
          const cc = m.cache_control ? "CC" : "--";
          return `${i}:${m.role}:${c.length}:${h}:${cc}`;
        }) ?? [];
        const toolsChars = body?.tools ? JSON.stringify(body.tools).length : 0;
        // ★ 工具清单 + 各自大小（仅首条带 tools 的记录写一次，避免日志膨胀）
        const toolEntries = body?.tools as Array<{ function?: { name?: string } }> | undefined;
        const toolList = toolEntries?.map((t) => {
          const n = t?.function?.name ?? "?";
          return { n, c: JSON.stringify(t).length };
        }) ?? [];
// ★ P0-4 优化：请求体序列化一次（bodyJson），dump 与 nativeFetch 复用，省一次 MB 级序列化
const bodyJson = JSON.stringify(body);
// ★ P0-4：同步 appendFileSync 改为异步队列（fire-and-forget），不阻塞热路径
fsPromises.appendFile(
"/tmp/prompt-dump.log",
JSON.stringify({
ts: Date.now(),
model: provider.model,
baseURL: provider.baseURL,
msgs: msgLines,
toolsChars,
toolList,
bodyChars: bodyJson.length,
}) + "\n",
).catch(() => { /* best-effort */ });
      } catch { /* best-effort */ }
    }

// ★ P0-4：dump 开启时复用已序列化的 bodyJson，省一次全量序列化；
//   dump 关闭时保持原行为
const response = await nativeFetch(apiURL, {
method: "POST",
headers,
body: bodyJson || JSON.stringify(body), // dump 开启时 bodyJson 已序列化，复用
signal: controller.signal,
      // Enforce a connection-level timeout as well so nativeFetch aborts even
      // when the TCP handshake or TLS negotiation hangs.
      timeout: timeout + 5000,
    });

    clearTimeout(timeoutId);
    if (externalAbortListener && externalSignal) {
      externalSignal.removeEventListener("abort", externalAbortListener);
    }
    const responseMs = Date.now() - callStart;

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      // fix-1: 传递 sessionTokens 用于 server-disconnect + 大 session 启发式
      // 注意：callLLMOnce 内部无法访问 lastPromptTokens，因此不传 sessionTokens。
      // server-disconnect 启发式在 chat() 函数的其他位置仍可生效。
      const classified = classifyLLMError(response.status, errorText);
      process.stderr.write(
        `[AgentModelExecutor] ❌ LLM API FAILED for "${provider.name}": HTTP ${response.status} [${classified.type}]\n` +
        `  URL: ${apiURL}\n` +
        `  Model: ${provider.model}\n` +
        `  Error: ${errorText.slice(0, 500)}\n`
      );

      deps.recordProviderFailure(provider.id, `HTTP ${response.status}: ${errorText}`, classified.type);

      return {
        message: { role: "assistant", content: null },
        tokensUsed: 0,
        promptTokens: 0,
        classifiedError: classified,
        responseMs,
      };
    }

    if (useStreaming && response.body) {
      return await parseStreamingResponse(response, provider, startTime, onProgress!, deps, trace, includeAccumulatedReplyInTokenEvents);
    }

    let data = await response.json() as {
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

    if (isAnthropicProvider) {
      // Anthropic 原生响应（content blocks + input_tokens/output_tokens）
      // → 转换为 OpenAI Chat Completions 形状，复用下方统一解析路径。
      data = convertAnthropicResponseToOpenAI(data) as typeof data;
    }

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

    // ── 非流式路径同样要记录思考轨迹 ──
    // 实测（2026-10-08）：provider 走非流式时，只有 tool_result 入轨迹，
    // decision 与 reasoning 全部缺失，轨迹只剩孤零零一条。
    //
    // ★ 2026-10-11 两处修正：
    //   1) `decision` 不再在这里记 —— 此时 `msg.tool_calls` 已完整，但**是否
    //      真的执行、参数是否合法**要到主循环才知道；改由 executeSingleToolCall
    //      统一记录（流式/非流式/XML 三条来源合一，避免同一决策记两遍或
    //      流式侧只记 `{_partial:true}` 占位）。
    //   2) 补上正文 `<think>/<reasoning>` 的清洗 —— 原实现只处理独立的
    //      `reasoning_content` 字段，把推理包在正文标签里的 provider 会把
    //      **内部推理原文**原样当正文交给用户（与流式行为不一致的泄漏）。
    if (msg.content && typeof msg.content === "string") {
      const scrub = new StreamingTagScrubber();
      const visible = scrub.feed(msg.content) + scrub.flush();
      const leakedReasoning = scrub.takeReasoning();
      if (leakedReasoning.trim()) {
        trace?.addReasoning(leakedReasoning, trace?.round);
        onProgress?.({
          type: "reasoning",
          phase: "thinking",
          detail: "模型思考中…",
          progress: 55,
          reasoningDelta: leakedReasoning,
          reasoningText: leakedReasoning,
          roundIndex: trace?.round || 1,
          ...(trace ? { thinkingSteps: trace.toJSON() } : {}),
        });
      }
      msg.content = visible;
    }

    if (trace) {
      const rc = (msg as { reasoning_content?: string | null }).reasoning_content;
      if (rc && String(rc).trim()) {
        trace.addReasoning(String(rc), trace.round);
        // 非流式也要下发 —— 否则"落盘了但用户看不到"的老毛病又犯一次
        onProgress?.({
          type: "reasoning",
          phase: "thinking",
          detail: "模型思考中…",
          progress: 55,
          reasoningDelta: String(rc),
          reasoningText: String(rc),
          roundIndex: trace.round || 1,
          thinkingSteps: trace.toJSON(),
        });
      }
    }

    return {
      message: {
        role: msg.role || "assistant",
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      },
      tokensUsed: Number((data.usage as Record<string, unknown>)?.total_tokens ?? 0) || 0,
      promptTokens: Number((data.usage as Record<string, unknown>)?.prompt_tokens ?? 0) || 0,
      responseMs,
      // 原始 usage 透传：normalizeUsage 由此提取 cache_read_input_tokens /
      // prompt_tokens_details.cached_tokens（provider 侧缓存命中真值）。
      usageDetails: data.usage ?? undefined,
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (externalAbortListener && externalSignal) {
      externalSignal.removeEventListener("abort", externalAbortListener);
    }
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
      process.stderr.write(`[AgentModelExecutor] ${msg}\n`);
      classified = classifyLLMError(undefined, undefined, msg);
      errorMessage = msg;
      errorType = "TIMEOUT";
    } else if (err instanceof Error) {
      errorMessage = err.message;
      process.stderr.write(`[AgentModelExecutor] ❌ LLM fetch failed for "${provider.name}": ${errorMessage}\n`);
      process.stderr.write(`  URL: ${apiURL}, Model: ${provider.model}, Timeout: ${timeout}ms\n`);
      // fix-1: classifyLLMError 自动检测 SSL cert / content_policy / model_not_found 等
      classified = classifyLLMError(undefined, undefined, errorMessage);
      errorType = classified?.type || "UNKNOWN";
    }

    deps.recordProviderFailure(provider.id, errorMessage, errorType);

    return {
      message: { role: "assistant", content: null },
      tokensUsed: 0,
      promptTokens: 0,
      classifiedError: classified,
      responseMs: Date.now() - callStart,
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
  /**
   * ★ 2026-10-27 修复：创造性任务判定的原始用户消息。
   * `message` 是增强后的消息（用户消息 + 注入的 Tavily 搜索上下文）。
   * 创造性任务模式（CREATIVE_TASK_PATTERN）若直接测试增强消息，会因注入的
   * 搜索结果中含 "RESTful API"/"技术文档"/"设计 API" 等词而**误判**为创造性
   * 任务——典型事故：kanban 任务注入的看板软件资讯含 "RESTful API"，导致
   * 52 个工具全被禁用、模型无法执行 kanban。创造性判定只应针对用户真正
   * 输入的内容，故单独传入未经增强的原始消息。未传时回退到 message。
   */
  rawUserMessage?: string;
  systemPrompt: string;
  /**
   * ★ P0-7（2026-11-02）：skills 元数据段（"## Available Capabilities" 标题 +
   * 工具说明 + web 策略 + <available_skills> 列表）。由 agent-model-executor 构建后传入，
   * 作为独立 system 消息放在 **首条 system 之后、history 之前**的固定位置。
   * 跨轮布局纯追加（history 增长只在末尾），前缀缓存逐轮不击穿。
   * 空串 = 无 skills 段。
   */
  skillsMessage?: string;
  /**
   * ★ P0-7（2026-11-02）：动态尾（plan/chain/stale-context/记忆检索等易变
   * 内容）。非空时作为独立 system 消息置于 **skills 段之后、history 之前**的固定位置。
   * P0-5 曾置于 history 之后，但每轮位置位移（从 history 前移到 history 后）
   * 击穿前缀缓存；P0-7 固定前置，跨轮公共前缀 = frozen + ephemeral + skills + tail +
   * 全部 history（追加式增长）。内容会话内高度稳定（skills 哈希 4 轮不变、tail 3 轮不变），
   * 变化仅 ~每 4 轮一次（记忆刷新）。
   */
  dynamicSystemTail?: string;
  installedSkills: unknown[];
  providers: ProviderConfig[];
  startTime: number;
  sessionId: string;
  pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>;
  attachments?: Array<{ name: string; type: string; size: number; data?: string | null }>;
  onProgress?: AgentProgressCallback;
  searchPreDone?: boolean;
  channel?: string;
  /** Optional cancellation signal (forwarded from LLMCallerDeps.abortSignal). */
  abortSignal?: AbortSignal;
  /**
   * 正文 token 级事件是否携带累积 reply（默认 true，旧客户端靠它做全量替换渲染）。
   * P0 欠账修复（2026-10-12）：token 事件历史上把**整条累积 reply** 塞进每个事件，
   * 一次 3MB 长任务的 SSE 流里 token 事件占 95% 体积（平方增长）。
   * 新客户端改用 `delta` 增量渲染后，通过此开关让事件只携带增量。
   * 字段仍保留（前端按 reply 存在与否自动决定渲染模式），兼容旧客户端。
   */
  includeAccumulatedReplyInTokenEvents?: boolean;
}

export async function tryCallLLM(
  deps: LLMCallerDeps,
  options: TryCallLLMOptions
): Promise<TryCallLLMResult | null> {
  const observability = deps.registry?.resolveService?.("observability") as any;
  const tracing = observability?.getTracingService?.();

  const doTryCall = async (): Promise<TryCallLLMResult | null> => {
  const {
    message, rawUserMessage, systemPrompt, skillsMessage, dynamicSystemTail: callerDynamicSystemTail, installedSkills, providers, startTime,
    sessionId, pendingPermissions, attachments, onProgress,
    searchPreDone = false, channel, abortSignal,
    includeAccumulatedReplyInTokenEvents = false,
  } = options;

  // 创造性任务判定只针对用户原始输入，不测增强消息（含注入的搜索上下文）。
  // 搜索结果里常见的 "RESTful API"/"技术文档"/"设计 API" 会让 kanban/scheduler
  // 等工具任务被误判为创造性 → 工具全禁 → 模型无法执行。未传时回退到 message。
  const rawMessage = rawUserMessage ?? message;

  // Wire end-to-end cancellation signal into deps so callLLMOnce picks it up.
  // 创建 deps 浅拷贝再设置 abortSignal，避免修改调用方共享的 deps 对象。
  if (abortSignal && !deps.abortSignal) {
    deps = { ...deps, abortSignal };
  }

  // ★ 2026-10-27 调整为 10/20：实测 10 任务压测中，8 轮上限不足以完成
  //   需要多步操作的复杂任务（如全栈脚手架、仓库分析）。base=10 覆盖大多数
  //   任务，cap=20 为极复杂场景留足空间。每轮可并行多个工具调用。
  // ★ 2026-10-30 提升 cap 至 30：v7 压测复跑实证——Task 1/7/8 均在 round 20
  //   撞顶时仍有大量工作未完成（Task 7 刚写完 17 个 .tf 文件还没部署/写 README；
  //   Task 8 写完实现+测试还没跑测试）。30 轮 × ~36K tokens/轮 ≈ 1.1M tokens，
  //   与下方 TOKEN_BUDGET=1.2M 配套。循环安全仍靠 MAX_AUTO_CONTINUE=3 +
  //   overlapRatio>0.7 守卫兜底，勿删。
  const BASE_MAX_TOOL_ROUNDS = 10;
  const MAX_TOOL_ROUNDS_CAP = 30;
  const MAX_CONSECUTIVE_ERRORS = 3;
  // 自动续跑上限：检测到「该继续却停下来问人」时，最多自动回灌多少轮。
  // 上限存在的意义是兜底：万一模型每轮都重复同样的停顿话术，不能无限循环。
  // ★ 2026-10-26 从 3 降为 1：实测 3 次续跑在复杂任务中导致模型循环——
  //   每轮产生"详细但无实质完成"的响应 → 触发 empty_but_detailed → 续跑 →
  //   重复同样的工具调用 → 再触发 → 3 轮消耗 40 万+ token 仍未完成。
  // ★ 2026-10-27 恢复为 3：1 次续跑不够——模型收到 nudge 后再次 yield，
  //   没有第二次续跑就交还用户。加入循环守卫：若模型连续两次 yield 内容
  //   相同（或高度相似），不再续跑，避免旧循环问题。
  const MAX_AUTO_CONTINUE = 3;

  // ── 过载自动恢复阶梯（借鉴 hermes-agent turn_recovery.py auto-recovery）──
  // provider 出现瞬时过载类错误（429/5xx/超时/网络）时，不立即 failover，
  // 而是原地 jittered backoff 等待后重试（15s→60s，最多 5 个周期，
  // Retry-After 契约优先）。按 provider.name 计数——failover 到下一个
  // provider 后用独立的计数（新 provider 的新状态）。
  const overloadAttemptsByProvider = new Map<string, number>();

  const maxToolRounds = computeDynamicToolLimit(message, BASE_MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS_CAP, deps.conversationHistory, sessionId);
  process.stdout.write(`[AgentModelExecutor] Dynamic tool limit for session "${sessionId}": ${maxToolRounds} (base=${BASE_MAX_TOOL_ROUNDS}, cap=${MAX_TOOL_ROUNDS_CAP})\n`);

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
  process.stdout.write(`[AgentModelExecutor] ${expandedProviders.length} model entries from ${providers.length} provider(s) for session "${sessionId}"\n`);

  // ★ P0-5：skills 段不再由 llm-caller 自行构建（旧 deps.buildSkillsPromptForRun），
  // 改由 agent-model-executor 构建 skillsMessage 经 options 传入——构建时机与会话
  // 粘性选择（Fix F）都在 executor 侧完成。

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
      process.stdout.write(`[AgentModelExecutor] Pending command expired (>${PENDING_CMD_TTL / 60000}min), discarding: ${pendingCmd.command}\n`);
      deps.pendingApprovalCommands.delete(sessionId);
    } else {
      process.stdout.write(`[AgentModelExecutor] User approved pending command: ${pendingCmd.command}\n`);
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
      // ── 直接执行分支的 assistant 轮持久化（2026-10-11）──
      // 下面这几条 return **绕过主循环**，必须自己补上 assistant 轮落盘：
      // 否则会话记录里只有用户消息、没有命令执行结果，下一轮模型看不到
      // 「刚才那条命令跑出了什么」（只能靠猜），刷新页面后这段交换也消失。
      // 用户消息本身已在 AgentModelExecutor 里早期落盘，这里只补 assistant。
      const persistDirectAssistantTurn = (reply: string): void => {
        try {
          if (deps.sessionManager) {
            deps.sessionManager.getOrCreateSession("default", sessionId);
            deps.sessionManager.appendTurn("default", sessionId, {
              turnIndex: 0, role: "assistant", content: reply, timestamp: new Date().toISOString(),
            });
          }
        } catch (err) {
          process.stderr.write(`[AgentModelExecutor] SessionManager persist failed (direct reply): ${err}\n`);
        }
        persistSessionTurnFn(getSessionPersistenceDeps(deps), sessionId, "assistant", reply);
        // ★ P0-1（2026-10-16 缓存命中改造）：删除此处的静默 splice。
        // 每轮把最老消息删掉会使**整个 LLM 请求前缀原点漂移**（tools+system+
        // history 全量重价），多轮会话永久失去 prompt-cache 命中。结构改写
        // 统一交给 CompactionManager（AGENTS.md：prompt cache is sacred，压缩
        // 是唯一合法前缀改写）。deps.maxHistoryLength 保留为内存上限语义，
        // 但不再按轮截断前缀。
        const hist = [
          ...(deps.conversationHistory.get(sessionId) || []),
          { role: "assistant" as const, content: reply },
        ];
        deps.conversationHistory.set(sessionId, hist);
      };

      // Execute the pending command directly and return immediately
      try {
        const shellExecTool = deps.registeredTools.get("shell_exec");
        if (shellExecTool) {
          const execResult = await shellExecTool.handler({ command: pendingCmd.command, timeout: "30" });
          const execStr = typeof execResult === "string" ? execResult : JSON.stringify(execResult);
          const execObj = typeof execResult === "object" ? execResult as Record<string, unknown> : null;
          if (execObj?.success !== false && execStr && execStr.length > 0) {
            const reply = formatCommandOutput(execObj, execStr);
            persistDirectAssistantTurn(reply);
            return {
              reply,
              tokensUsed: 0,
              duration: Date.now() - startTime,
              permissionRequests: [],
              toolsExecuted: true,
              files: [],
            };
          } else {
            const reply = `⚠️ 命令执行失败：${execStr.slice(0, 500)}`;
            persistDirectAssistantTurn(reply);
            return {
              reply,
              tokensUsed: 0,
              duration: Date.now() - startTime,
              permissionRequests: [],
              toolsExecuted: true,
              files: [],
            };
          }
        }
      } catch (err) {
        process.stderr.write(`[AgentModelExecutor] Pending command execution failed: ${err}\n`);
        const reply = `❌ 命令执行出错：${err instanceof Error ? err.message : String(err)}`;
        persistDirectAssistantTurn(reply);
        return {
          reply,
          tokensUsed: 0,
          duration: Date.now() - startTime,
          permissionRequests: [],
          toolsExecuted: false,
          files: [],
        };
      }
    }
  }

  // ── 思考轨迹：把"模型怎么想"与"agent 做了什么"合并成可折叠时间线 ──
  // 用户诉求（2026-10-08）：任务完成后整个思考过程要完整保留、可折叠展开。
  //
  // ★ 2026-10-11：轨迹实例提升到 **provider 循环之外**（原先在循环体内 new）。
  //   原因：failover 到下一个 provider 时旧轨迹被整个丢弃，`llmRound` 归零 →
  //   备用 provider 又从 `roundIndex:1` 开始，前端会把它的回复写进第 1 个
  //   气泡（`roundIdx > 1` 不成立），**冲掉已经显示的内容**——正是用户反馈的
  //   「下一条内容冲掉上一条」在 failover 场景下的复现。提升后轮次号全程单调
  //   递增，且跨 provider 的推理/工具记录都能保留（不丢内容）。
  const trace = new ThinkingTrace();
  /** 最近一次 provider 尝试留下的轨迹（全 provider 失败时兜底交付给前端） */
  let lastTraceSnapshot: ThinkingStep[] | undefined;

  // ── 跨 provider 累计（hermes turn_finalizer「静默停止显式说明」语义）──
  // 兜底返回时需要知道「整个 turn 到底执行了多少工具、失败了哪些」，
  // 以便在没有正文产出时给出**如实**的说明，而不是误导性地
  // 「所有模型都未能响应」（工具明明已经跑过了）。
  let totalSuccessfulToolCalls = 0;
  let totalFailedTools: Array<{ name: string; error: string }> = [];

  // ── 终态失败证据（hermes turn_failure_copy 语义）──
  // 收集最后一次 ClassifiedError 的具体失败原因，供兜底回复说清
  // 「发生了什么 + 下一步做什么」，而不是通用的"请检查 API Key/服务是否在线"。
  let lastFailureEvidence: TerminalFailureEvidence | null = null;
  let errorAttemptsByProvider = new Map<string, number>();

  for (const provider of expandedProviders) {
    // ── Provider circuit breaker: skip tripped providers ──
    if (isProviderTripped(provider.name)) {
      process.stdout.write(`[LLMCaller] Skipping tripped provider "${provider.name}" — circuit breaker active\n`);
      continue;
    }

    // ── R1-2: 检查 provider skip list（持久化的 non-transient 失败记录） ──
    // 借鉴 hermes-agent 的 auth failover 持久化机制：
    // provider 发生 AUTH/BILLING 等 non-transient 错误后，加入 skip list，
    // 同 session 内不再重复尝试（TTL 5 分钟后自动重试）。
    const skipEntry = getProviderSkipList().shouldSkip(sessionId, provider.id);
    if (skipEntry) {
      process.stdout.write(
        `[LLMCaller] Skipping provider "${provider.name}" — in skip list (reason: ${skipEntry.reason}, expires in ${Math.round((skipEntry.expiresAt - Date.now()) / 1000)}s)\n`,
      );
      continue;
    }

    let consecutiveErrors = 0;

    // ── 空响应确定性短路（hermes empty_response_guard.deterministic_empty 语义）──
    // 连续 ≥2 次「同一 (provider, model) 且零输出」（usage 证实 0 输出）即判
    // 该 provider 对本上下文确定性无输出：跳过剩余盲重试，直接 failover。
    // 混合证据（有一次非空返回/带 usage 的错误返回）fail-open：重置计数照常重试。
    let consecutiveDeterministicEmpty = 0;

    // ── 本 provider 的工具执行统计（声明在 try 外，供 try/catch 之后的
    //    跨 provider 累计读取；try 内不再重复声明） ──
    let successfulToolCalls = 0;
    // ★ 2026-10-27：tc="none"（nudge 收尾）时网关若无视 tool_choice 仍返回
    //   tool_calls，这里记录**已拒绝执行**的轮数，用于限制「拒绝后续跑」的
    //   次数（防个别网关每轮都调工具烧掉迭代预算）。
    let toolCallsNoneRefusals = 0;
    const failedTools: Array<{ name: string; error: string }> = [];

    try {
      const history = deps.conversationHistory.get(sessionId) || [];

      // ★ P0-5：frozen system 主体只剩 systemPrompt（skills 段已移出为独立消息，
      // 见下方 skillsMessage 插入逻辑）。webToolStrategy 仅服务于 skills 段构建，
      // 已移至 agent-model-executor 侧。
      const stableSystemPrompt = systemPrompt;

      // ★ P0-4：易变尾附加（时区/平台）——与 CE buildEphemeralSuffix 输出一致。
      // CE 路径的 messages[0] = frozen + ephemeral，fallback 路径的 messages[0]
      // 也需追加同样的 ephemeral 内容，两路径逐字节一致，切换不失效缓存。
      const ephemeralSuffix = deps.contextEngineResult?.frozenContent
        ? "" // CE 路径已包含 ephemeral（在 messages[0] 中），不重复追加
        : (() => {
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
            const parts = [`Current timezone: ${tz} (24h format)`];
            if (process.platform) parts.push(`Platform: ${process.platform}`);
            return "\n\n" + parts.join("\n\n");
          })();

      // 易变成分（searchPreDone 提示 + 调用方传入的动态尾：计划/工具链/记忆召回）
      // 全部放在 history 之前的固定位置（见 P0-7 布局说明）。
      // ★ P0-9：searchPreDone 提示改为 transient 注入（不进 tail）。
      // 旧实现把提示拼进 dynamicSystemTail → 本轮 searchPreDone=true 有提示、
      // 下轮 false 无提示 → tail 字节变化 → history 缓存在 tail 处断掉。
      // 改为 transient：只在当前调用末尾追加，不写入 conversationMessages →
      // tail 字节逐轮稳定。
      let pendingTransient: LLMMessage[] = [];
      if (searchPreDone) {
        pendingTransient.push({
          role: "system",
          content: `**Search has already been performed.** Skip searching and go directly to analysis or code execution.\n` +
            PromptRegistry.getInstance().format("search.already_completed", {}),
        });
      }
      const dynamicSystemTail = callerDynamicSystemTail || "";

      const sessionPDeps = getSessionPersistenceDeps(deps);

      // ── fix-2: 中断后孤儿 tool_call 清理 ──
      // 在每轮开始前检测并修复中断的 tool_call 序列，防止下一轮 LLM 调用返回 400。
      // 等价于 hermes-agent 的 close_interrupted_tool_sequence。
      // 注意：closeInterruptedToolSequence 在原数组上 in-place 修改，
      // 而 history 变量持有同一引用，因此修复后 history 自动包含合成消息。
      const closedCount = closeInterruptedToolSequenceFn(sessionPDeps, sessionId);
      if (closedCount > 0) {
        process.stdout.write(`[AgentModelExecutor] Recovered ${closedCount} interrupted tool_call(s) for session "${sessionId}"\n`);
      }

      // 压缩预算按「稳定主体 + 动态尾」全文估算（动态尾短小，误差可忽略，
      // 且比旧 fullSystemPrompt 少算了动态内容更准确）。
      if (needsCompactionFn(sessionPDeps, sessionId, stableSystemPrompt + dynamicSystemTail, deps.config.maxTokens)) {
        process.stdout.write(`[AgentModelExecutor] Auto-compaction triggered for session "${sessionId}"\n`);
        await compactConversationHistoryFn(sessionPDeps, sessionId);
      }

      // ── TrajectoryCompressor: in-place 轨迹压缩（对标 Hermes trajectory_compressor.py）──
      // 与 CompactionManager（session-level，successor transcript）互补：
      // TrajectoryCompressor 做即时 in-place 压缩——保护头尾、摘要中间、原地替换。
      // 仅在 history 超过 token 预算且 session-level compaction 未触发时运行。
      // 摘要经 llmSummarizer 回调（同 CompactionManager 的 LLM 摘要路径）。
      //
      // ★ CE 路径时序说明：contextEngineResult 在 agent-model-executor.ts 中、
      //   tryCallLLM 之前装配，故 CE 路径本回合使用压缩前快照；压缩结果写回
      //   conversationHistory 后，下一回合 CE 装配读取到压缩后历史 → 延迟一回合生效。
      //   非 CE 路径（fallback）本回合即生效（history 局部引用同步更新）。
      //   压缩器内部 totalTokens<=targetMaxTokens 时 skippedUnderTarget 跳过，
      //   故 CE 路径本回合不会重复压缩已压缩内容。
      //
      // ★ P3 修复：gate 使用 conversationHistory 最新引用（compactConversationHistoryFn
      //   通过 set() 替换数组，局部 history 变量指向旧数组）；token 估算包含 tool_calls
      //   （与 compressor.estimateMessageTokens 一致，避免仅计 content 低估大工具调用）。
      if (history.length > 0 && sessionPDeps.llmSummarizer) {
        try {
          const gateHistory = deps.conversationHistory.get(sessionId) || history;
          // 粗略估算 history token（char/3 近似 + tool_calls JSON），超过预算才压缩
          const historyTokens = gateHistory.reduce(
            (sum, m) =>
              sum +
              Math.ceil((typeof m.content === "string" ? m.content.length : 0) / 3) +
              (m.tool_calls ? Math.ceil(JSON.stringify(m.tool_calls).length / 3) : 0),
            0
          );
          const trajectoryBudget = Math.floor(deps.config.maxTokens * 0.8); // 留 20% 给 system/skills/tail
          if (historyTokens > trajectoryBudget) {
            const { TrajectoryCompressor } = await import("./trajectory-compressor.js");
            const compressor = new TrajectoryCompressor({
              targetMaxTokens: trajectoryBudget,
              summaryTargetTokens: Math.floor(deps.config.maxTokens * 0.02),
            });
            const currentHistory = deps.conversationHistory.get(sessionId) || [];
            const { trajectory: compressedHistory, metrics } = await compressor.compress(
              currentHistory as Array<LLMMessage>,
              sessionPDeps.llmSummarizer
            );
            if (metrics.wasCompressed) {
              process.stdout.write(
                `[AgentModelExecutor] TrajectoryCompressor: ${metrics.turnsRemoved} turns removed, ` +
                `${metrics.tokensSaved} tokens saved (ratio ${(metrics.compressionRatio * 100).toFixed(1)}%), ` +
                `region [${metrics.turnsCompressedStartIdx}, ${metrics.turnsCompressedEndIdx}), ` +
                `summarization ${metrics.summarizationApiCalls} calls / ${metrics.summarizationErrors} errors\n`
              );
              // ★ P0-5：压缩结果写回 conversationHistory，保证下轮对已压缩内容再压缩产生相同结果
              deps.conversationHistory.set(sessionId, compressedHistory as Array<SessionHistoryEntry>);
              // 更新局部 history 引用
              (history as Array<SessionHistoryEntry>).length = 0;
              (history as Array<SessionHistoryEntry>).push(...compressedHistory as Array<SessionHistoryEntry>);
            }
          }
        } catch (err) {
          // 压缩失败不阻断主流程——回退到原始 history
          process.stdout.write(
            `[AgentModelExecutor] TrajectoryCompressor failed: ${err instanceof Error ? err.message : String(err)}\n`
          );
        }
      }

      // ── ContextEngine: use pre-assembled layered context when available ──
      // When ContextEngine has already assembled the context (with frozen/ephemeral
      // separation, bootstrap files, token-aware truncation), use its messages
      // instead of building them manually. This ensures consistent context management.
      //
      // ★ P0-7 布局（2026-11-02）：[sys_frozen, sys_ephemeral, sys_skills?, sys_tail?, ...history, user]
      // 易变内容（skills 段 + 动态尾）置于 history **之前**的固定位置。
      // 跨轮公共前缀 = frozen + ephemeral + skills + tail + 全部 history（追加式增长）
      // → provider 前缀缓存逐轮只 miss 新增的 user/assistant/tool 消息。
      // P0-5 曾把易变内容放在 history 之后，但每轮 skills/tail 从「history 前」位移到
      // 「history 后」，字节序列在 history 起点处分叉 → 每轮首调用前缀缓存击穿
      // （实测 4 轮探针：轮首 hit 94%→72%→34%、93%→71%、95%→33%，轮内恢复 99%）。
      // P0-7 改为固定前置：轮边界纯追加，hit 不再逐轮跌落。skills/tail 内容
      // 会话内高度稳定（实测 skills 哈希 4 轮不变、tail 3 轮不变），变化仅 ~每 4 轮
      // 一次（记忆刷新），代价远低于 P0-5 的逐轮位移。
      let messages: Array<LLMMessage>;
      if (deps.contextEngineResult) {
        // Use ContextEngine's pre-assembled messages (frozen system + truncated history +
        // current user message)
        messages = deps.contextEngineResult.messages.map(m => ({
          role: m.role,
          content: m.content,
        })) as Array<LLMMessage>;
        // P0-7：skills 段与动态尾插入**首条 system 之后、history 之前**（固定位置）。
        // CE messages[0] = frozen + ephemeral 合并体（applyAnthropicCacheControl
        // 稍后拆成两条），故插入点为 index 1。
        const volatileInsertIdx = 1;
        if (skillsMessage) {
          messages.splice(volatileInsertIdx, 0, { role: "system", content: skillsMessage });
        }
        if (dynamicSystemTail) {
          messages.splice(volatileInsertIdx + (skillsMessage ? 1 : 0), 0, { role: "system", content: dynamicSystemTail });
        }
        process.stdout.write(`[AgentModelExecutor] Using ContextEngine messages: ${messages.length} messages, ${deps.contextEngineResult.tokenEstimate} tokens\n`);
      } else {
        // Fallback: manual message assembly — ★ P0-7：易变内容前置，history 在后。
        // stableSystemPrompt 追加 ephemeralSuffix（时区/平台），与 CE 路径
        // messages[0] = frozen + ephemeral 结构一致，两路径切换不失效缓存。
        messages = [
          { role: "system", content: stableSystemPrompt + ephemeralSuffix },
          ...(skillsMessage ? [{ role: "system", content: skillsMessage }] : []),
          ...(dynamicSystemTail ? [{ role: "system", content: dynamicSystemTail }] : []),
          ...history,
        ];
      }

      // ── ContextPruning: trim large tool results and clear old ones ──
      // Apply context pruning to reduce token usage and prevent context overflow.
      // This is especially important for long conversations with many tool calls.
      //
      // ★ P0-5 幂等化：hard-clear 的 cutoffIndex 按位置滑动（idx < len-20），
      // 旧实现只修改本地 messages 副本、不写回 conversationHistory → 下一轮
      // 对未剪枝的原始 history 重新滑动 → history 内容逐轮变化 → 永久击穿
      // 前缀缓存。现改为剪枝结果**写回 conversationHistory**：下一轮对已剪枝
      // 内容再剪枝 → 再清空产生相同占位串（soft-trim 同理不再二次触发）→
      // 字节稳定，缓存前缀不再漂移。
      //
      // history 在 messages 中的切片边界（CE 路径 history 可能被 CE 截断为尾部）：
      // P0-7 布局 [sys, skills?, tail?, ...history, user?] 下 history 起点 =
      // 1 + volatileTailCount（跳过 system + 易变段）。
      const volatileTailCount = (skillsMessage ? 1 : 0) + (dynamicSystemTail ? 1 : 0);
      const historyStartIdx = 1 + volatileTailCount;
      const historyEndIdx = deps.contextEngineResult
        ? messages.length - 1 // CE: 末尾还有当前 user 消息
        : 1 + volatileTailCount + history.length;  // 非 CE: user 消息尚未 push

      // ── ToolOutputPruner: 3-pass 工具输出裁剪（对标 Hermes _prune_old_tool_results）──
      // Pass 1: 去重（MD5 哈希，保留最新一份）
      // Pass 2: 信息摘要（18+ 工具特定摘要模式）
      // Pass 3: 参数 JSON 截断（保持有效性）
      // 此前 ToolOutputPruner 已实现但零运行时调用（死代码），现接入活路径。
      // 与 ContextPruningManager 互补：Pruner 做结构化裁剪，Manager 做兜底 soft-trim/hard-clear。
      //
      // ★ P0-5 幂等化：裁剪结果写回 conversationHistory，保证下轮对已裁剪内容再裁剪
      //   产生相同结果（字节稳定，前缀缓存不漂移）。与 ContextPruningManager 写回逻辑一致。
      try {
        const pruner = getToolOutputPruner();
        const toolMessages: Array<{
          role: string;
          content: string | unknown[] | null;
          tool_call_id?: string;
          tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
          name?: string;
        }> = messages.map(m => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : (m.content as unknown[] | null),
          tool_call_id: m.tool_call_id,
          tool_calls: m.tool_calls as typeof toolMessages[0]["tool_calls"],
          name: m.name,
        }));
        const pruneResult = pruner.prune(toolMessages);
        if (pruneResult.stats.deduplicated > 0 || pruneResult.stats.summarized > 0 || pruneResult.stats.argsTruncated > 0) {
          process.stdout.write(`[AgentModelExecutor] ToolOutputPruner: ${pruneResult.stats.deduplicated} deduped, ${pruneResult.stats.summarized} summarized, ${pruneResult.stats.argsTruncated} args truncated, saved ~${pruneResult.stats.prunedChars} chars\n`);
          // Apply pruned content back to messages
          messages = messages.map((orig, idx) => {
            const pruned = pruneResult.messages[idx];
            if (!pruned) return orig;
            if (typeof orig.content === "string" && typeof pruned.content === "string" && pruned.content !== orig.content) {
              return { ...orig, content: pruned.content };
            }
            if (orig.tool_calls && pruned.tool_calls) {
              return { ...orig, tool_calls: pruned.tool_calls };
            }
            return orig;
          });

          // ★ P0-5：裁剪结果写回 conversationHistory（仅替换 history 切片内的条目）
          if (historyEndIdx > historyStartIdx) {
            const fullHistory = deps.conversationHistory.get(sessionId);
            if (fullHistory && fullHistory.length > 0) {
              const sliceLen = historyEndIdx - historyStartIdx;
              const offset = deps.contextEngineResult ? Math.max(0, fullHistory.length - sliceLen) : 0;
              let changed = false;
              const updated: typeof fullHistory = fullHistory.map((entry, i) => {
                const j = i - offset;
                if (j >= 0 && j < sliceLen) {
                  const pruned = pruneResult.messages[historyStartIdx + j];
                  if (
                    pruned &&
                    typeof entry.content === "string" &&
                    typeof pruned.content === "string" &&
                    pruned.content !== entry.content
                  ) {
                    changed = true;
                    return { ...entry, content: pruned.content };
                  }
                }
                return entry;
              });
              if (changed) {
                deps.conversationHistory.set(sessionId, updated);
              }
            }
          }
        }
      } catch {
        // best-effort — pruning failure should not break the LLM call
      }

      // ★ P0-5 短路：ToolOutputPruner 本轮无任何裁剪产出（stats 全 0）时，
//   其下游 ContextPruningManager 的输入与原 messages 逐字节一致。
//   ContextPruningManager.prune() 是纯函数（soft-trim 幂等、hard-clear 幂等），
//   上一轮若已对同内容做过 soft-trim/hard-clear，本轮再次执行也必然无产出。
//   因此 stats 全 0 → 跳过第二轮全量 map 拷贝 + 逐条比较，省 O(history) 分配。
//   注意：pruner stats 非 0 或 pruner 不存在时，仍无条件走第二轮（保守）。
const prunerNoop = !pruneResult || (
pruneResult.stats.deduplicated === 0 &&
pruneResult.stats.summarized === 0 &&
pruneResult.stats.argsTruncated === 0
);
if (deps.contextPruningManager && !prunerNoop) {
        // Cast to expected type — prune() only modifies string content (tool results)
        const pruningInput = messages.map(m => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : "",
          tool_calls: m.tool_calls,
        }));
        const pruningResult = deps.contextPruningManager.prune(pruningInput);
        if (pruningResult.stats.softTrimmed > 0 || pruningResult.stats.hardCleared > 0) {
          process.stdout.write(`[AgentModelExecutor] ContextPruning applied: ${pruningResult.stats.softTrimmed} soft trimmed, ${pruningResult.stats.hardCleared} hard cleared, saved ~${pruningResult.stats.charsSaved} chars\n`);
          // Apply pruned content back to original messages
          messages = messages.map((orig, idx) => {
            const pruned = pruningResult.prunedMessages[idx];
            if (pruned && typeof orig.content === "string" && typeof pruned.content === "string" && pruned.content !== orig.content) {
              return { ...orig, content: pruned.content };
            }
            return orig;
          });

          // ★ P0-5：剪枝结果写回 conversationHistory（仅替换 history 切片内的条目）。
          if (historyEndIdx > historyStartIdx) {
            const fullHistory = deps.conversationHistory.get(sessionId);
            if (fullHistory && fullHistory.length > 0) {
              const sliceLen = historyEndIdx - historyStartIdx;
              // CE 截断保留 history 尾部 → 切片对应 fullHistory 的后缀；
              // 非 CE 路径切片即完整 history（offset=0）。
              const offset = deps.contextEngineResult ? Math.max(0, fullHistory.length - sliceLen) : 0;
              let changed = false;
              const updated: typeof fullHistory = fullHistory.map((entry, i) => {
                const j = i - offset;
                if (j >= 0 && j < sliceLen) {
                  const pruned = pruningResult.prunedMessages[historyStartIdx + j];
                  if (
                    pruned &&
                    typeof entry.content === "string" &&
                    typeof pruned.content === "string" &&
                    pruned.content !== entry.content
                  ) {
                    changed = true;
                    return { ...entry, content: pruned.content };
                  }
                }
                return entry;
              });
              if (changed) {
                deps.conversationHistory.set(sessionId, updated);
              }
            }
          }
        }
      }

      // ── User message length guard ──
      // Truncate excessively long messages to avoid LLM timeout and token waste.
      // 4000 chars ≈ 2000-4000 tokens (CJK chars are ~1-2 tokens each).
      const MAX_USER_MESSAGE_LEN = 4000;
      let effectiveMessage = message;

      // XSS sanitization is now handled by InputPipeline's createXssSanitizeStage()
      // No need to duplicate the logic here.

      if (effectiveMessage.length >= MAX_USER_MESSAGE_LEN) {
        effectiveMessage = effectiveMessage.slice(0, MAX_USER_MESSAGE_LEN) + `\n\n[系统提示：原始消息过长，已截断至${MAX_USER_MESSAGE_LEN}字符。如需完整处理，请分段发送。]`;
        process.stdout.write(`[AgentModelExecutor] User message truncated for session "${sessionId}"\n`);
      }

      // Build user message — use multimodal format when images are attached.
      // ★ P2-1 修复（会话审计 2026-10-17）：CE 分支下当前 user 消息**由
      // ContextEngine 已追加**（assembleContext 末尾 push currentTask，且
      // executor 传 currentTask 与 message 同源），此处**不再**二次追加——
      // 旧逻辑导致当前用户消息在请求里出现两次（CE 原文一份 + 本处一份）。
      // 仅 CE 分支的例外：多模态附件（image/audio/pdf parts）CE 不感知
      // （它只拼字符串 currentTask），需把 CE 追加的最后一条 user 消息
      // **替换**为 parts 版本，附件字节不丢。
      const imageAtts = attachments?.filter(a => a.type.startsWith("image/") && a.data?.startsWith("data:")) ?? [];
      const audioAtts = attachments?.filter(a => a.type.startsWith("audio/") && a.data?.startsWith("data:")) ?? [];
      const pdfAtts = attachments?.filter(a => (a.type === "application/pdf" || a.name?.toLowerCase().endsWith(".pdf")) && a.data?.startsWith("data:")) ?? [];
      const hasMultimodal = imageAtts.length > 0 || audioAtts.length > 0 || pdfAtts.length > 0;
      const buildMultimodalParts = (): ChatContent[] => {
        const contentParts: ChatContent[] = [];
        if (effectiveMessage) {
          contentParts.push({ type: "text", text: effectiveMessage });
        }
        // Images: pass through as image_url (data URI). All three providers
        // accept either a URL or a base64 data URI; the data URI carries its
        // own MIME in the prefix (e.g. "data:image/png;base64,..."), so the
        // provider-side MIME hardcoding is no longer needed.
        for (const img of imageAtts) {
          contentParts.push({
            type: "image_url",
            image_url: { url: img.data!, detail: "auto" },
          });
        }
        // Audio: parse format from MIME (e.g. "audio/wav" → "wav").
        // OpenAI GPT-4o supports wav/mp3/flac/ogg as input_audio content parts.
        const ALLOWED_AUDIO = new Set(["wav", "mp3", "flac", "ogg"]);
        for (const aud of audioAtts) {
          const fmt = aud.type.split("/")[1];
          if (!fmt || !ALLOWED_AUDIO.has(fmt)) continue;
          const base64 = stripDataUriPrefix(aud.data!);
          if (!base64) continue;
          contentParts.push({ type: "input_audio", input_audio: { data: base64, format: fmt as "wav" | "mp3" | "flac" | "ogg" } });
        }
        // PDF / documents: Anthropic accepts `document` content parts with
        // base64 source. OpenAI accepts file_id (we'd need to upload first —
        // for now, pass through and let the provider adapter handle/ignore).
        for (const pdf of pdfAtts) {
          const base64 = stripDataUriPrefix(pdf.data!);
          if (!base64) continue;
          contentParts.push({
            type: "file",
            file: { data: base64, mimeType: "application/pdf", filename: pdf.name },
          });
        }
        return contentParts;
        };
        if (!deps.contextEngineResult) {
          // 非 CE 分支：手动追加当前 user 消息
          if (hasMultimodal) {
            messages.push({ role: "user", content: buildMultimodalParts() });
          } else {
            messages.push({ role: "user", content: effectiveMessage });
          }
        } else if (hasMultimodal && effectiveMessage) {
          // CE 分支：把 CE 已追加的最后一条 user 消息替换为多模态 parts 版本。
          // effectiveMessage 非空是守卫：CE 的 assembleContext 仅在
          // currentTask 非空时 push 末尾 user 消息，此时 messages 最后一条
          // user 必是 currentTask；空 message 时最后一条 user 是 history，
          // 不可误替换。
          const parts = buildMultimodalParts();
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") {
              messages[i] = { role: "user", content: parts };
              break;
            }
          }
        } else if (!hasMultimodal && effectiveMessage) {
          // CE 分支（纯文本）：把 CE 追加的 currentTask（executor 的
          // effectiveMessage）**替换**为本处 effectiveMessage（= 传入 message
          // 即 finalEnhancedMessage，含搜索/新闻上下文增强，与 CE 侧不同串）——
          // 去重（旧逻辑两条 user 消息）且不丢增强内容（直接跳过会丢失）。
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") {
              messages[i] = { role: "user", content: effectiveMessage };
              break;
            }
          }
        }

      // ★ P0-2：会话级工具组单调并集（旧：按当前消息激活，逐轮漂移破坏
      // provider 缓存前缀；现：只增不减，稳态下 tools JSON 字节恒定）。
      // 首消息 / 无 base 时保持 fresh-session 语义（与旧行为字节一致）。
      // ★ 2026-11-04：关键词激活用 rawMessage（用户原始输入），不用增强后的 message。
      //   后者含搜索注入内容（最多 60K 字符），任意网页文本可能触发无关工具组
      //   （如抓取页面含"浏览器/截图" → 激活 19 个浏览器工具），导致跨会话
      //   工具数无意义波动。与创造性任务检测（4540 行）策略一致。
      const baseTools = sessionId ? deps.toolGroupStore?.get(sessionId) : undefined;
      const activeOut: { activeTools?: Set<string> } = {};
      let tools = buildOpenAITools(deps.registeredTools, rawMessage, deps.checkFnEvaluator, baseTools, activeOut);
      if (sessionId && deps.toolGroupStore && activeOut.activeTools) {
        deps.toolGroupStore.set(sessionId, activeOut.activeTools);
      }

      // ★ 2026-10-26 核心修复：创造性任务（API 设计/PRD/商业计划书/技术文档/短篇小说/方案/指南）
      //   在首次 LLM 调用时移除所有工具，强制模型直接在回复中输出完整内容。
      //   实测 agnes-3.0-flash 对这类任务会先 shell_exec 查文件→file_read 读文件→
      //   file_write 写文件→checkpoint / restore，5-9 轮 × 15-61s = 远超超时。
      //   移除工具后模型只能凭自身知识输出，1 轮即可完成。
      //   副作用：模型无法创建文件——但创造性任务的用户诉求是"在聊天中阅读回复"，不是下载文件。
      //   ★ 2026-10-26 二次修复：移除 hasActionIntent 检查——auto-continuation 消息
      //   包含"分析"等 action 关键词会误判为 action task，导致 creative 检测失效。
      //   creative pattern 本身足够具体（PRD/商业计划书/RESTful API 等），不会误匹配 action task。
      // ★ 2026-10-27 修复：只看「当前消息 + 上一条 user 消息」。旧实现用
      //   historyMsgs.some(...) 扫描**全部**历史，一旦会话里出现过创造性任务，
      //   之后每一轮（包括用户转而要求写代码/跑测试）都会把 tools 置空，
      //   模型彻底失去工具能力——这是持久性误伤。只看上一条 user 消息即可
      //   覆盖「继续/是的请继续」这类跟进，又不会跨任务粘连。
      const CREATIVE_TASK_PATTERN = /(?:设计.*API|RESTful.*API|API.*设计|产品需求文档|PRD|商业计划书|商业分析|技术文档|入门指南|操作指南|学习路径|短篇小说|写一篇|创作一篇|写一个.*故事|起草.*方案|需求分析|竞品分析|市场痛点|商业模式|财务预测|融资需求|团队配置|目标用户画像|用户旅程图|技术约束|成功指标|差异化策略)/i;
      const historyMsgs = deps.conversationHistory.get(sessionId) || [];
      // 上一条 user 消息（不含本轮：本轮 message 单独判断）
      const prevUserIdx = lastIndexOfRole(historyMsgs, "user");
      const prevUserMsg = prevUserIdx >= 0 ? historyMsgs[prevUserIdx] : undefined;
      // 创造性判定用 rawMessage（用户原始输入），不用增强后的 message——后者含
      // 注入的 Tavily 搜索上下文，其中常见的 "RESTful API"/"技术文档"/"设计 API"
      // 会让 kanban/scheduler 等工具任务被误判为创造性 → 工具全禁 → 模型无法执行
      // （实测 Task 9 kanban 因此失败）。
      // ★ 2026-10-28 修复（v5 Task 4/5 事故）：用户明确要求把交付物写入指定
      //   路径时（"把设计文档写入 /tmp/v5-billing/…"），创造性禁用工具会让
      //   模型无法 file_write 落盘——文档只贴在聊天里、文件始终不存在（磁盘
      //   核验追加了更正脚注，但工具已被禁用、续跑指令也无工具可用，3 轮空转
      //   后循环保护退出）。识别到写文件请求时不判为创造性任务，保留工具能力。
      const WRITE_PATH_REQUEST_RE =
        /(?:写入|保存到|保存|创建|生成|输出到|放到|落盘|另存)\s*[^。\n]{0,40}?(?:`[^`]+`|\/[A-Za-z0-9_\-./]+|[A-Za-z]:\\)/;
      const hasWritePathRequest = WRITE_PATH_REQUEST_RE.test(rawMessage);
      const prevHasWritePathRequest =
        prevUserMsg && typeof prevUserMsg.content === "string" && WRITE_PATH_REQUEST_RE.test(prevUserMsg.content);
      const isCreativeTask = !hasWritePathRequest && !prevHasWritePathRequest &&
        (CREATIVE_TASK_PATTERN.test(rawMessage) ||
        (prevUserMsg && typeof prevUserMsg.content === "string" && CREATIVE_TASK_PATTERN.test(prevUserMsg.content)));
      if (isCreativeTask && tools.length > 0) {
        process.stdout.write(`[AgentModelExecutor] Creative task detected — tools disabled (${tools.length}→0), forcing direct response in 1 round\n`);
        tools = [];
        // ★ 2026-10-27：此处保留 `tools = []`（与上面 nudge 路径的「保留 tools +
        //   tool_choice:none」相反）是**有意的**。tools 在请求体末尾，置空只丢掉
        //   tools 段本身的缓存、不影响 messages 前缀；而创造性任务**设计上只跑 1 轮**，
        //   这个代价只付一次。换回来的是硬保证——模型手里没有任何工具，不可能先
        //   shell_exec 查文件再 file_write 写文件。若改用 tool_choice:"none"，部分
        //   网关会无视该指令（见 toolCallsNoneRefusals），模型仍发起工具调用 →
        //   5-9 轮 × 15-61s 超时，正是本修复要消灭的问题。用 1 轮的 tools 段缓存
        //   换掉 5-9 轮超时风险，划算。
      }

      // ★ P0-4 缓存稳定化（2026-10-26）：searchPreDone 不再移除搜索工具。
      // ★ 2026-10-27 更正：tools **不是**前缀第一段。请求体 key 的插入序是
      //   model → messages → max_tokens → … → (system) → tools → tool_choice，
      //   `JSON.stringify(body)` 按插入序序列化，tools 因此落在整个请求的**末尾**。
      //   置空 tools 只会让缓存在 tools 段处分叉（丢掉 tools 段自身的命中），
      //   并不影响 messages 前缀——含 20.8K 冻结系统提示——的命中。
      //   这里保留工具的真正原因是**能力**而非缓存：移除后模型无法再发起任何
      //   合法搜索。改为依赖 system prompt 中的 "Search has already been
      //   performed" 提示引导模型跳过搜索。
      if (searchPreDone) {
        process.stdout.write(`[AgentModelExecutor] Search pre-done: keeping all tools for cache stability (${tools.length} tools)\n`);
      }

      const isAction = hasActionIntentFn(message);

      let conversationMessages = [...messages];
      // ★ P0-8：transient 消息不持久化到 history。
      // nudge/warning/directive 等 mid-history 消息如果 push 到 conversationMessages，
      // 其内容变化（round count/file paths/trigger reasons）会击穿前缀缓存，
      // 影响后续所有调用。改为 transient 注入：只在当前 LLM 调用的消息数组末尾
      // 追加，不写入 conversationMessages → 下一轮 history 保持纯追加式增长。
      // （pendingTransient 已在上方声明，searchPreDone 提示也走同一通道）

      // ★ P0-7：记录 volatile 区域起始索引。布局 [sys, skills?, tail?, ...history, user]
      // 下易变 system 消息固定在 index 1-2，volatileStartIdx = 1（有任一易变段时）。
      deps.volatileSystemStartIdx = skillsMessage || dynamicSystemTail ? 1 : -1;

      // ★ 2026-10-26 修复：创造性任务的模型首次响应太短（589 chars），
      //   触发 auto-continuation 额外轮次（+106s），总时间超 300s。
      //   在 conversationMessages 中插入独立的 system 指令，比 system prompt 中的
      //   bullet point 更醒目——模型对紧邻 user message 的 system 指令响应更好。
      // ★ P0-5：指令插入位置从 index 1（frozen 与 history 之间，会毒化 history
      //   缓存前缀）改为**当前 user 消息之前**（history + skills + tail 之后）。
      if (isCreativeTask) {
        const pos = lastIndexOfRole(conversationMessages, "user");
        conversationMessages.splice(pos >= 0 ? pos : conversationMessages.length, 0, {
          role: "system",
          content: "[最高优先级系统指令] 这是一个创造性/设计/写作任务。你必须在本轮回复中直接输出完整的创造性内容（API 设计/PRD/商业计划书/技术文档等），覆盖用户要求的所有要点。不要调用任何工具、不要创建文件、不要搜索文件、不要恢复检查点、不要使用 sequential_thinking。你的语言能力本身就是完成这类任务的最佳工具。直接输出完整内容，不要分轮输出，不要以'接下来我会…'结尾。",
        });
      }

      // ★ P0-5：Anthropic 原生路径一次性合并 volatile system 消息（skills 段 /
      // 动态尾 / 创造性指令）进最后一条 user 消息。原因：convertMessagesToAnthropic
      // 会把全部 system 消息提升进顶层 system 参数，而 Anthropic 缓存流 =
      // system + messages 连续前缀——逐轮变化的 system 参数字节会毒化其后的
      // history 缓存。合并后 system 参数 = frozen + ephemeral（会话内字节稳定）
      // → history 可进缓存。
      // 在此处（轮循环之前）一次性完成：轮内 budget warning 等后续 push 的
      // user 消息不受影响（合并目标在它们之前）。
      if (providers.some((p) => p.provider === "anthropic")) {
        conversationMessages = mergeVolatileSystemIntoUser(
          conversationMessages,
          deps.volatileSystemStartIdx ?? 0,
        );
      }

      let finalReply = "";
      let lastPromptTokens = 0;
      let skillFallbackResult: string | null = null;
      // 本回合**真正执行过**搜索类工具（区别于「尝试调用」）：
      // 用于决定是否注入 "Do NOT search again" 提示，避免给失败调用也加噪音。
      let actualSearchExecuted = false;
      // 本回合「执行了但返回失败」的工具，用于完成声明对账（声明见 provider 循环外）
      // 本回合「执行了但返回空/零结果」的工具 —— 用于识别凭空编造的数据报告
      const emptyResultTools: Array<{ name: string; field: string }> = [];
      // 本回合真实执行过的工具（含参数），用于 transcript 持久化
      const executedToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
      // 本回合真实执行过的**变更类**工具（文件写类）—— 完成声明对账的写操作证据
      const WRITE_EVIDENCE_TOOLS = new Set(["file_write", "file_delete"]);
      // ★ 2026-10-27 修复：shell_exec 写入检测——当 shell 命令包含写入模式
      //   （echo >, printf >, cat >, tee, >> 等）时，视为写操作证据。
      //   实测 Task 10 声称"报告用 shell 写入"但最后一条 shell_exec 是 grep，
      //   无写入命令，文件不存在。将 shell_exec 写入纳入 writeOps 后，
      //   若 agent 声称已写入但 shell 命令不含写入模式，writeOps 为空，
      //   write_claimed_not_executed 检查可捕获虚假完成声明。
      const SHELL_WRITE_PATTERN = /(?:echo|printf|cat|tee)\s+.*[>]|\btee\s|\bcat\s+[^|]*>|>>\s*\S/;
      const writeOps = (): Array<{ name: string; args: string }> =>
        executedToolCalls
          .filter((c) => {
            if (WRITE_EVIDENCE_TOOLS.has(c.name)) return true;
            // shell_exec：检查命令是否包含写入模式
            if (c.name === "shell_exec") {
              const cmd = String(c.arguments?.command ?? c.arguments?.cmd ?? "");
              return SHELL_WRITE_PATTERN.test(cmd);
            }
            return false;
          })
          .map((c) => ({ name: c.name, args: JSON.stringify(c.arguments).slice(0, 200) }));
      // 自动续跑计数：模型"该继续却停下来问人"时回灌指令让其继续的轮数
      let autoContinueCount = 0;
      // 验证门 nudge 计数：模型在变更文件后未验证就声称完成时，回灌验证指令的轮数
      let verificationNudgeCount = 0;
      // 2026-10-25 P2：Kanban worker 终止门计数（对标 hermes kanban_stop.py）
      let kanbanStopNudgeCount = 0;
      // 思考轨迹实例见 provider 循环外（跨 failover 复用同一份）
      // 续跑前的回复备份：若续跑后模型产不出新内容，用备份兜底，避免返回空回复
      let lastReplyBackup = "";
      // ★ 2026-10-27 循环守卫：记录上一次 yield 回复的内容，若模型在收到
      //   续跑指令后再次 yield 且内容高度相似（>80% 重叠），说明模型陷入了
      //   "yield → nudge → 同样的 yield" 循环，不再续跑，避免 token 耗尽。
      let lastYieldReply = "";
      // 验证门暂存回复：验证门触发时，模型已产出但被搁置的最终回复。
      // 若验证门续跑后预算耗尽，用此备份兜底（借鉴 hermes-agent
      // _pending_verification_response 的保留语义）。
      let pendingVerificationReply = "";
      // Turn 退出原因追踪（对标 Hermes turn_finalizer._explain_abnormal_exit）：
      // 在循环 break 时设置，供终末安全网的异常退出说明器使用。
      // 正常完成时保持空字符串（"" = 正常退出，不追加说明）。
      let turnExitReason = "";

      // ── IterationBudget integration ──
      // When available, use the Hermes-style budget system instead of the
      // simple round counter. The budget supports consume/refund and Grace Call.
      const budget = deps.iterationBudget;

      // fix-4: 重置流式恢复重试计数器（每次 chat() 调用重置，防止跨会话累积）
      getStreamingRecoveryManager().resetTurn();
      // 重置错误恢复执行器的 turn 状态（一次性守卫：每 turn 重置 executedActions + retryCount）
      getErrorRecoveryExecutor().resetTurn();

      // R1-3: 工具循环检测器（每个 chat() 调用一个实例）
      const toolLoopDetector = new ToolCallLoopDetector();
      // 验证证据账本（hermes verification_evidence「编辑失效」语义）：
      // 记录每次验证覆盖的路径，之后再编辑这些路径即判失效，
      // 让验证门区分「从未验证」与「验证过但已被改动」，只对失效路径
      // 要求定向复验。
      const evidenceStore = getVerificationEvidenceStore(sessionId);
      let toolLoopWarnedThisTurn = false;
      // 工具循环阻断标志：由 executeSingleToolCall 内部检测设置，外部循环检查并 break
      let toolLoopHaltFlag = false;
      let toolLoopHaltMsg = "";
      let toolLoopHaltDet = "";

      // ★ P0-4：运行时缓存稳定性评估——每轮 API 调用前检查 request prefix
      // 是否与上次一致。检测到 anti-pattern（tools 抖动 / system 漂移 /
      // message 顺序变更）时输出诊断日志，帮助定位缓存命中率低的根因。
      if (deps.promptCacheStability && providers.length > 0) {
        try {
          const firstProvider = providers[0];
          const providerName = String(firstProvider.provider || "");
          const providerType = (providerName === "anthropic" ? "anthropic" :
            providerName === "openai" ? "openai" :
            providerName === "google" ? "google" : "unknown") as
            import("./prompt-cache-stability").CacheProvider;
          const stabilityResult = deps.promptCacheStability.evaluate({
            provider: providerType,
            model: firstProvider.model || "unknown",
            systemPrompt,
            tools: tools.map(t => ({ name: t.function.name, description: t.function.description })),
            messages: conversationMessages,
          });
          if (!stabilityResult.isStable && stabilityResult.brokenReason) {
            process.stdout.write(
              `[AgentModelExecutor] ⚠️ Cache stability: UNSTABLE at message ${stabilityResult.brokenAt} — ${stabilityResult.brokenReason}\n` +
              `  stablePrefix: ${stabilityResult.stablePrefixLength} msgs, hit tokens: ${stabilityResult.estimatedCacheHitTokens}, miss tokens: ${stabilityResult.estimatedCacheMissTokens}\n`
            );
          }
          // ★ P0-5：命中率摘要——每 10 次评估输出一行（stable 比例 + top brokenReasons），
          // 让 96% 目标可实时观察（无需等 WebUI 聚合）。
          stabilityEvalCount++;
          if (stabilityEvalCount % 10 === 0) {
            const hitRate = deps.promptCacheStability!.getHitRate();
            const history = deps.promptCacheStability!.getHistory(50);
            const broken = history.filter((h) => !h.isStable && h.brokenReason);
            const reasonCounts = new Map<string, number>();
            for (const h of broken) {
              const key = h.brokenReason || "unknown";
              reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
            }
            const topReasons = [...reasonCounts.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([r, c]) => `${r}(${c})`)
              .join(", ") || "无";
            process.stdout.write(
              `[AgentModelExecutor] Cache hit rate: ${(hitRate * 100).toFixed(1)}% (${history.length - broken.length}/${history.length} stable, last 50 evals), top broken: ${topReasons}\n`
            );
          }
          // ★ P0-5：CacheTracer token 加权命中率摘要（provider usage 真值，
          // cache_read_input_tokens / (hit + miss)）。每 10 次评估输出一行。
          if (deps.cacheTracer && deps.cacheTracer.size() > 0) {
            const traceStats = deps.cacheTracer.stats();
            const totalTokens = traceStats.totalCacheHitTokens + traceStats.totalCacheMissTokens;
            if (totalTokens > 0) {
              process.stdout.write(
                `[AgentModelExecutor] Cache trace (token-weighted): ${(traceStats.overallHitRate * 100).toFixed(1)}% ` +
                `(${traceStats.totalCacheHitTokens}/${totalTokens} tokens hit, ${traceStats.totalRequests} requests), ` +
                `cost saved ~$${traceStats.totalEstimatedCostSaved.toFixed(4)}, latency saved ~${traceStats.totalEstimatedLatencySavedMs}ms\n`
              );
            }
          }
        } catch { /* best-effort — stability analysis must never block LLM calls */ }
      }

      // ★ 2026-11-04 修复：调查循环检测器。
      // 根因：用户说「好的，开始实现P0/P1」后，模型连续 10 轮只做只读调查
      // （file_read / shell_exec grep / code_search），从未调用编辑工具，
      // 烧掉 918K tokens 后仅产出 40 字符。系统无任何机制提醒模型「该动手了」。
      // 修复：连续 ≥3 轮只读工具（无 file_write/apply_patch/file_delete）且
      // 用户消息含「实现/修复/写代码/修改/edit/implement/fix」意图时，注入 transient
      // nudge 提醒模型使用编辑工具实际改动代码。
      const EDIT_TOOLS = new Set([
        "file_write", "file_delete", "apply_patch", "write_file", "edit_file",
      ]);
      // HOUSEKEEPING_TOOLS（对标 Hermes turn_tool_round.housekeeping）：
      // 只读维护类工具——正常工作流程中预期使用，不计入"进度"但也不触发
      // 调查循环 nudge（除非连续 ≥3 轮且用户有实现意图）。
      const HOUSEKEEPING_TOOLS = new Set([
        "file_read", "file_list", "code_search", "memory_retrieve",
        "web_search", "web_fetch", "skill_list", "skill_view", "skill_manage",
        "sequential_thinking", "assess_coding_capability",
      ]);
      let consecutiveReadOnlyRounds = 0;
      // Run-budget wrap-up notice 是否已注入（每 turn 只注入一次）
      let wrapUpNoticeInjected = false;

      for (let round = 0; round < maxToolRounds; round++) {
        // ── End-to-end cancellation: stop dispatching new rounds when aborted ──
        // In-flight fetches are already cancelled via the abort signal wired into
        // callLLMOnce. Here we short-circuit the loop to return the best reply
        // accumulated so far (or a cancellation notice if nothing was produced).
        if (deps.abortSignal?.aborted) {
          process.stdout.write(`[AgentModelExecutor] Abort signal received at round ${round} — stopping LLM loop for session "${sessionId}"\n`);
          if (finalReply) break;
          return {
            reply: "⏹️ 操作已取消。",
            tokensUsed: totalTokensUsed,
            duration: Date.now() - startTime,
            permissionRequests: pendingPermissions,
            toolsExecuted: anyToolExecuted,
            files: createdFiles,
            thinkingTrace: trace.isEmpty ? undefined : trace.toJSON(),
          };
        }

        // ── IterationBudget: check if budget allows this iteration ──
        if (budget) {
          if (budget.isExhausted) {
            // Budget exhausted — try Grace Call (one final call without tools)
            if (budget.graceCallAvailable) {
              process.stdout.write(`[AgentModelExecutor] Iteration budget exhausted — using Grace Call (no tools)\n`);
              onProgress?.({ type: "budget_exhausted", phase: "generating", detail: `迭代预算已耗尽（${budget.getUsed()}/${budget.getMax()}），正在进行最终总结...`, progress: 92 });
              budget.useGraceCall();
              // Make one final LLM call without tools to produce a text answer
              // ★ 必须带上 trace 并先 nextRound()：否则这次调用的 token 事件会
              //   固定带 roundIndex:1，前端把「最终总结」写进第 1 个气泡、
              //   冲掉之前的回复；它的推理也无从入轨迹（流式可见但落盘没有）。
              trace.nextRound();
              const graceResult = await callLLMOnce(provider, conversationMessages, [], "none", onProgress, deps, trace, includeAccumulatedReplyInTokenEvents);
              if (graceResult && graceResult.message?.content) {
                finalReply = graceResult.message.content;
                totalTokensUsed += graceResult.tokensUsed;
                // Record token usage for grace call
                if (deps.tokenUsageTracker) {
                  try {
                    const outputTokens = Math.max(0, graceResult.tokensUsed - graceResult.promptTokens);
                    deps.tokenUsageTracker.record({
                      sessionId,
                      provider: provider.provider || provider.name,
                      model: provider.model || "unknown",
                      inputTokens: graceResult.promptTokens,
                      outputTokens,
                      durationMs: graceResult.responseMs,
                      channel: channel || "unknown",
                      ...cacheExtrasFromResult(graceResult, provider.provider || provider.name),
                    });
                  } catch { /* best-effort */ }
                }
              } else {
                // Grace Call 失败 —— 优先用验证门暂存的回复兜底
                // （借鉴 hermes-agent _pending_verification_response 保留语义：
                //   验证门搁置的回复比重新生成的一次性总结更可靠）
                if (pendingVerificationReply) {
                  finalReply = pendingVerificationReply;
                  process.stdout.write(`[AgentModelExecutor] Grace Call failed; using pending verification reply as fallback for session "${sessionId}"\n`);
                } else {
                  finalReply = [
                  `⏰ 迭代预算已耗尽，最终总结请求也未能完成。`,
                  ``,
                  `**已执行的操作：**`,
                  `- 已执行工具调用: ${successfulToolCalls} 次`,
                  createdFiles.length > 0 ? `- 已创建文件: ${createdFiles.map(f => f.path).join("、")}` : "",
                  ``,
                  `💡 **建议：** 使用 \`/status\` 查看进度，或重新描述需求继续执行。`,
                  ].filter(Boolean).join("\n");
                }
              }
              break; // Exit loop after Grace Call
            }
            // No Grace Call available — force exit with meaningful summary
            process.stdout.write(`[AgentModelExecutor] Iteration budget exhausted, no Grace Call available — forcing summary\n`);
            onProgress?.({ type: "budget_exhausted", phase: "generating", detail: `迭代预算已耗尽（${budget.getUsed()}/${budget.getMax()}），生成执行总结...`, progress: 95 });
            // 优雅降级：生成有意义的总结，而非空白回复
            if (!finalReply) {
              finalReply = [
                `⏰ 迭代预算已耗尽（${round} 轮），任务在此中断。`,
                ``,
                `**已执行的操作：**`,
                `- 已执行工具调用: ${successfulToolCalls} 次`,
                createdFiles.length > 0 ? `- 已创建文件: ${createdFiles.map(f => f.path).join("、")}` : "",
                ``,
                `💡 **建议：**`,
                `1. 使用 \`/status\` 查看当前进度`,
                `2. 将任务拆分为更小的子任务分批执行`,
                `3. 重新描述需求，我会从已有进度继续`,
              ].filter(Boolean).join("\n");
            }
            turnExitReason = "budget_exhausted";
            break;
          }
          budget.consume(1);
        }

        // ★ 每轮开始就下发一次轨迹快照（force）：保证"上一轮的思考"及时送到前端
        onProgress?.({ type: "llm_call", phase: "thinking", detail: `正在调用 ${provider.name} (${provider.model})，第 ${round + 1}/${maxToolRounds} 轮...`, progress: Math.min(30 + round * 3, 90), providerName: provider.name, round: round + 1, thinkingSteps: traceSnapshot(trace, { force: true }) });

        // ── 进度反馈：预算接近耗尽时预警 ──
        if (budget) {
          const budgetPct = budget.getUsed() / budget.getMax();
          if (budgetPct >= 0.8 && budgetPct < 1.0) {
            onProgress?.({ type: "budget_warning", phase: "thinking", detail: `迭代预算已使用 ${Math.round(budgetPct * 100)}%（${budget.getUsed()}/${budget.getMax()}），即将耗尽`, progress: 85 });
          }
        }

        // ── 进度反馈：接近最大轮次时预警 ──
        if (round === maxToolRounds - 5) {
          onProgress?.({ type: "rounds_warning", phase: "thinking", detail: `即将达到最大轮次限制（${maxToolRounds} 轮），剩余 5 轮`, progress: 88 });
        }

        // ── Run-budget wrap-up notice（对标 Hermes turn_finalizer 80% 提醒）──
        // 在工具轮次达到 80% 时注入 transient 提醒，让模型知道接近上限、
        // 需要开始收尾。这是确定性注入（不调 LLM），与提示词 nudge 不同。
        if (maxToolRounds > 0 && round >= Math.floor(maxToolRounds * 0.8) && round < maxToolRounds - 1) {
          const wrapUpNotice = `[系统提示] 工具轮次已使用 ${round + 1}/${maxToolRounds}（${Math.round((round + 1) / maxToolRounds * 100)}%），接近上限。请基于已有结果开始收尾，避免继续调用工具。如果任务已完成，请直接输出完成状态汇报。`;
          // 只在当前轮次第一次达到 80% 时注入一次
          if (!wrapUpNoticeInjected) {
            pendingTransient.push({ role: "user", content: wrapUpNotice });
            wrapUpNoticeInjected = true;
            process.stdout.write(`[AgentModelExecutor] Run-budget wrap-up notice injected at ${Math.round((round + 1) / maxToolRounds * 100)}% for session "${sessionId}"\n`);
          }
        }

        // ── Activity stamp（对标 Hermes TurnLivenessWatchdog.touch）──
        // 每轮有 LLM 响应后调用，保持 watchdog 活跃，防止飞行中卡死误判。
        try {
          getTurnLivenessWatchdog().touch(sessionId);
        } catch { /* best-effort — watchdog 不可用时不阻断 */ }

        // ── Steer: inject real-time instructions ──
        if (deps.getSteerMessage) {
          const steerMsg = deps.getSteerMessage(sessionId);
          if (steerMsg) {
            pendingTransient.push({ role: "system", content: steerMsg });
          }
        }

        // ★ 2026-10-26 修复：nudge 阈值从 4 降到 2，且 nudge 后强制禁用工具调用。
        //   创造性任务（API 设计/PRD/商业计划书）模型会过度调用工具
        //   （shell_exec 查文件、file_read 读文件、file_write 写文件），
        //   每次工具结果加入对话历史导致上下文爆炸（300K tokens/轮）。
        //   model 对"请给出最终回复"的 nudge 响应很差，会继续调工具。
        //   直接设置 tool_choice="none" 强制模型只输出文本，不再调工具。
        // ★ 2026-10-28 修复（v5 Task 3/10 事故）：nudge 只对创造性任务生效。
        //   此前 successfulToolCalls >= 2 时对所有任务强制 tool_choice="none"——
        //   多步任务（写脚本→运行→写报告 / 写服务→启动→验证）在第 2 次工具调用后
        //   就被剥夺工具能力，模型只能输出文本、编造未执行的结果（Task 3 编造了
        //   CSV 统计数字；Task 10 服务从未启动却声称完成）。行动任务不 nudge，
        //   maxToolRounds 已兜底防死循环。
        const tc: "auto" | "none" = isCreativeTask && successfulToolCalls >= 2 ? "none" : "auto";
        if (isCreativeTask && successfulToolCalls >= 2) {
          process.stdout.write(`[AgentModelExecutor] ${successfulToolCalls} tool calls used, nudging toward final answer (round ${round + 1}) — tool_choice disabled\n`);
          pendingTransient.push({
            role: "user",
            content: PromptRegistry.getInstance().format("tool_loop.nudge_final_answer", {}),
          });
        }

        // ── 新一轮 LLM 调用 ──
        // 轮次序号在**进入下一轮时**自增，并通过 token 事件的 roundIndex 传给前端，
        // 前端据此新建气泡（不再靠"长度是否变短"猜）。
        // 存在 trace 上：它是主循环与 parseStreamingResponse 之间唯一共享的可变对象。
        trace?.nextRound();
        // ── 截断工具调用 max_tokens 提升（hermes turn_truncation
        //    boosted_output_cap）：工具调用被 length 截断后，同一 prompt
        //    大概率再次被截断——按重试次数指数放大 max_tokens，给工具调用
        //    足够空间一次写完（2→4→8→16→32，上限 32×）。
        const maxTokensBoost = getStreamingRecoveryManager().getMaxTokensBoost();
        const callProvider =
          maxTokensBoost > 1
            ? { ...provider, maxTokens: Math.max(provider.maxTokens ?? 4096, 4096) * maxTokensBoost }
            : provider;
        // ★ 2026-10-27 修复：tc="none" 时**不再**传空 tools 数组。tools 是请求体
        //   固定段，逐轮在「有/无」之间翻转会击穿前缀缓存（nudge 在 2 次成功工具
        //   调用后即触发 → 几乎每个编码轮都会翻转一次）。改为始终下发 tools +
        //   显式 tool_choice:"none"（见 callLLMOnce 注释）；个别网关若无视该指令
        //   仍返回 tool_calls，由下方 toolCallsNoneRefusals 兜底拒绝执行。
        // ★ P0-8：构造本轮调用的消息数组 = conversationMessages + pendingTransient。
        // transient 消息（nudge/warning/directive）只影响当前调用，不写入 history。
        // 下一轮 conversationMessages 保持纯追加式增长，前缀缓存不被 mid-history 变化击穿。
        const callMessages = [...conversationMessages, ...pendingTransient];
        pendingTransient = [];
        const result = await callLLMOnce(callProvider, callMessages, tools, tc, onProgress, deps, trace, includeAccumulatedReplyInTokenEvents);

        if (!result) {
          consecutiveErrors++;
          consecutiveDeterministicEmpty++;
          recordProviderFailure(provider.name);
          // 空响应确定性短路（hermes deterministic_empty）：连续 2 次同
          // provider/model 零输出即判该 provider 对本上下文无输出，跳过剩余
          // 盲重试直接 failover——省 1 次调用 + 1 个 backoff 周期。
          if (consecutiveDeterministicEmpty >= 2) {
            process.stderr.write(`[AgentModelExecutor] Provider "${provider.name}" (${provider.model}) returned ${consecutiveDeterministicEmpty} consecutive empty responses — deterministic, skipping remaining retries\n`);
            turnExitReason = "deterministic_empty";
            break;
          }
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            turnExitReason = "max_iterations_reached";
            break;
          }
          continue;
        }

        const classified = result.classifiedError;
        if (classified && classified.type !== LLMErrorType.UNKNOWN) {
          consecutiveErrors++;
          // 混合证据 fail-open（hermes empty_response_guard）：provider 有真响应
          // （即使报错）说明并非「确定性无输出」——重置确定性空响应计数。
          consecutiveDeterministicEmpty = 0;
          recordProviderFailure(provider.name);
          // 终态失败证据：记录最后一次 ClassifiedError（turn_failure_copy 盖码用）。
          // Retry-After 契约已在 error-classifier 解析进 backoffMs（含 jitter），
          // 这里取秒数供限流文案点名重置窗口。
          errorAttemptsByProvider.set(
            provider.name,
            (errorAttemptsByProvider.get(provider.name) ?? 0) + 1,
          );
          lastFailureEvidence = {
            reason: classified.reason ?? null,
            label: `${provider.name}（${provider.provider || provider.name}/${provider.model}）`,
            attempts: errorAttemptsByProvider.get(provider.name) ?? 1,
            retryable: classified.retryable,
            detail: classified.message,
            resetSeconds: classified.hasRetryAfterContract
              ? Math.round(classified.backoffMs / 1000)
              : undefined,
            model: provider.model,
          };
          process.stderr.write(`[AgentModelExecutor] Error classified as "${classified.type}" for provider "${provider.name}": ${classified.message}\n`);

          // ── R2-1: 错误消息友好化（借鉴 hermes-agent _content_policy_blocked_result） ──
          const friendlyError = formatClassifiedErrorForUser(classified, provider.name);
          if (friendlyError.shouldNotifyUser) {
            const detail = friendlyError.actionableHint
              ? `${friendlyError.userMessage}\n💡 ${friendlyError.actionableHint}`
              : friendlyError.userMessage;
            onProgress?.({
              type: "error",
              phase: "generating",
              detail,
              progress: 30,
              round: round + 1,
            });
          }

          // ── IterationBudget: 运行时错误退款 ──
          // 借鉴 hermes-agent iteration_budget.py refund_for_runtime_error：
          // 当 LLM 调用因运行时上下文错误失败时（非决策错误），退还迭代。
          // 决策类错误（内容政策/认证/计费/模型不存在）不退款——已在 refundForRuntimeError 内过滤。
          if (budget && classified.retryable) {
            try {
              const refunded = await budget.refundForRuntimeError(classified.type);
              if (refunded > 0) {
                process.stdout.write(
                  `[AgentModelExecutor] Runtime-error refund: returned ${refunded} iteration(s) for ${classified.type} on provider "${provider.name}"\n`,
                );
              }
            } catch { /* best-effort — refund must never break recovery */ }
          }

          // ── ErrorRecoveryExecutor: 消息修改类恢复 ──
          // 借鉴 hermes-agent conversation_loop.py 错误恢复分支：
          // 剥离 thinking 块、剥离 replay blob、缩小图片、降级 multimodal tool content
          // ——消息级修复，不需要压缩上下文即可重试。
          // TurnRetryState 一次性守卫防止同种动作在同一 turn 内重复执行。
          const reason = classified.reason;
          if (
            reason === "thinking_signature" ||
            reason === "invalid_encrypted_content" ||
            reason === "image_too_large" ||
            reason === "multimodal_tool_content_unsupported"
          ) {
            const recoveryResult = getErrorRecoveryExecutor().executeRecovery({
              messages: conversationMessages as unknown as RecoveryMessage[],
              reason,
              errorText: classified.message,
              providerId: provider.name,
              allowFailover: true,
            });

            if (recoveryResult.recovered && recoveryResult.shouldRetry) {
              // 消息修改类恢复：应用修改后的消息，重试同 provider
              conversationMessages = recoveryResult.messages as unknown as typeof conversationMessages;
              process.stdout.write(
                `[AgentModelExecutor] Recovery action: ${recoveryResult.action} — retrying with modified messages\n`,
              );
              consecutiveErrors = 0;
              continue;
            }

            if (recoveryResult.shouldFailover && !recoveryResult.recovered) {
              // TurnRetryState 守卫已标记该动作执行过 → 不再剥离，failover
              process.stderr.write(
                `[AgentModelExecutor] Message-modification recovery exhausted (${recoveryResult.action}) — failing over to next provider\n`,
              );
              break;
            }
          }

          // ── fix-1: 基于 shouldCompact 统一处理压缩（覆盖 CONTEXT_OVERFLOW 和 PAYLOAD_TOO_LARGE） ──
          if (classified.shouldCompact) {
            process.stdout.write(`[AgentModelExecutor] Compacting due to ${classified.type}...\n`);
            await compactConversationHistoryFn(getSessionPersistenceDeps(deps), sessionId);
            // ★ P0-7：与主路径同布局——易变内容前置，history 在后。
            conversationMessages = [
              { role: "system", content: stableSystemPrompt + ephemeralSuffix },
              ...(skillsMessage ? [{ role: "system", content: skillsMessage }] : []),
              ...(dynamicSystemTail ? [{ role: "system", content: dynamicSystemTail }] : []),
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
            // ★ P0-7：重建后重新执行 Anthropic volatile system 合并（见主路径注释；
            // 必须在 user push 之后，合并目标是当前 user 消息）。
            // 易变段固定在 index 1-2，volatileSystemStartIdx 恒为 1（有任一易变段时）。
            if (providers.some((p) => p.provider === "anthropic")) {
              deps.volatileSystemStartIdx = skillsMessage || dynamicSystemTail ? 1 : -1;
              conversationMessages = mergeVolatileSystemIntoUser(
                conversationMessages,
                deps.volatileSystemStartIdx,
              );
            }
          }

          // ── IterationBudget: 压缩重启退款 ──
          // 借鉴 hermes-agent iteration_budget.py refund_for_compression：
          // 上下文压缩后重启 turn 时，退还压缩前消耗的迭代——压缩不是决策，
          // 不应消耗预算。此前退款机已实现但零活调用点（死代码），现接入活路径。
          if (budget && classified.shouldCompact) {
            try {
              const refunded = await budget.refundForCompaction();
              if (refunded > 0) {
                process.stdout.write(`[AgentModelExecutor] Compaction refund: returned ${refunded} iteration(s) to budget for session "${sessionId}"\n`);
              }
            } catch { /* best-effort — refund must never block recovery */ }
          }

          // ★ 2026-10-30：abort 快速通道——abort 是用户/系统主动取消（软超时暂停、
          // 客户端断开、/cancel），不是 provider 错误。直接 return 退出 tryCallLLM，
          // 不做退避/failover/熔断（否则 ~50-77s 浪费 + 健康 provider 被误排除），
          // 也跳过后处理（总结调用/对账/磁盘核验——这些在后台 resume 中完成）。
          // v7 压测复跑实证：break 进后处理让 ⏳ 延迟 >500s 客户端超时（Task 1）。
          if (classified.type === LLMErrorType.ABORT) {
            process.stdout.write(
              `[AgentModelExecutor] Request aborted for session "${sessionId}" — returning immediately (skipping post-loop processing)\n`,
            );
            return {
              reply: "⏹️ 操作已取消。",
              tokensUsed: totalTokensUsed,
              duration: Date.now() - startTime,
              permissionRequests: pendingPermissions,
              toolsExecuted: anyToolExecuted,
              files: createdFiles,
              thinkingTrace: trace.isEmpty ? undefined : trace.toJSON(),
            };
          }

          // ── fix-1: 基于 backoffMs 统一处理退避（覆盖 RATE_LIMIT/PROVIDER_ERROR/PAYLOAD_TOO_LARGE 等） ──
          // 增强（2026-10-18）：瞬时过载类错误（429/5xx/超时）优先走「原地恢复阶梯」
          // ——最多 5 个周期、15s→60s jittered backoff、Retry-After 契约优先（见
          // overload-recovery.ts），避免 provider 短暂过载时直接 failover 浪费备用渠道。
          if (classified.backoffMs > 0 && classified.retryable) {
            const ladderInfo = {
              type: classified.type,
              retryable: classified.retryable,
              hasRetryAfterContract: classified.hasRetryAfterContract,
              backoffMs: classified.backoffMs,
              isTransient: classified.isTransient,
              reason: classified.reason,
            };
            const used = overloadAttemptsByProvider.get(provider.name) ?? 0;
            if (isOverloadLadderEligible(ladderInfo, used)) {
              const waitMs = computeOverloadWait(used + 1, ladderInfo);
              overloadAttemptsByProvider.set(provider.name, used + 1);
              process.stdout.write(
                `[AgentModelExecutor] Overload ladder ${used + 1}/${OVERLOAD_RECOVERY_MAX} for provider "${provider.name}" (${classified.type}, ${classified.reason ?? "transient"}): ` +
                `waiting ${Math.round(waitMs / 1000)}s before in-place retry\n`,
              );
              onProgress?.({
                type: "error",
                phase: "generating",
                detail: `模型服务瞬时过载（${classified.type}），${Math.round(waitMs / 1000)}s 后原地重试（${used + 1}/${OVERLOAD_RECOVERY_MAX}）...`,
                progress: 30,
                round: round + 1,
              });
              await new Promise((resolve) => {
                const t = setTimeout(resolve, waitMs);
                t.unref?.();
              });
              // 原地重试同 provider：重置连续错误计数，避免 3 连败后误 failover
              consecutiveErrors = 0;
              continue;
            }
            await new Promise((resolve) => {
              const t = setTimeout(resolve, classified.backoffMs);
              t.unref?.();
            });
          }

          // ── fix-1: 基于 shouldSkipProvider 统一处理 provider 跳过 ──
          // 覆盖 AUTH/BILLING/CONTENT_POLICY/SSL_CERT/MODEL_NOT_FOUND/PROVIDER_POLICY 等 non-transient 错误
          if (classified.shouldSkipProvider) {
            process.stderr.write(`[AgentModelExecutor] Skipping provider "${provider.name}" due to ${classified.type} (non-transient)\n`);
            // R1-2: 持久化到 skip list，同 session 内不再重复尝试
            getProviderSkipList().add(sessionId, provider.id, classified.type);
            turnExitReason = classified.type === LLMErrorType.CONTENT_POLICY
              ? "content_filter"
              : "guardrail_halt";
            break;
          }

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            turnExitReason = "max_iterations_reached";
            break;
          }
          continue;
        }

        consecutiveErrors = 0;
        recordProviderSuccess(provider.name, result.responseMs);
        totalTokensUsed += result.tokensUsed;
        if (result.promptTokens > 0) lastPromptTokens = result.promptTokens;

        // ★ 2026-10-30 提升至 1.8M：与 action-intent 轮次上限 25 配套。
        // v7 压测实测：Task 7 每轮 ~40K tokens（795K/20轮），Task 8 每轮 ~61K
        // （1.23M/20轮）。25 轮 × 61K ≈ 1.53M，1.8M 留余量给总结调用。
        const TOKEN_BUDGET = 1800000;
        if (totalTokensUsed > TOKEN_BUDGET * 0.5 && totalTokensUsed <= TOKEN_BUDGET * 0.5 + result.tokensUsed) {
          process.stderr.write(`[AgentModelExecutor] Token budget 50% reached: ${totalTokensUsed}/${TOKEN_BUDGET} for session "${sessionId}"\n`);
          pendingTransient.push({ role: "user", content: PromptRegistry.getInstance().format("token_budget.warning_50", {}) });
        }
        if (totalTokensUsed > TOKEN_BUDGET * 0.8 && totalTokensUsed <= TOKEN_BUDGET * 0.8 + result.tokensUsed) {
          process.stderr.write(`[AgentModelExecutor] Token budget warning: ${totalTokensUsed}/${TOKEN_BUDGET} (80%) for session "${sessionId}"\n`);
          pendingTransient.push({ role: "user", content: PromptRegistry.getInstance().format("token_budget.warning_80", {}) });
        }
        if (totalTokensUsed > TOKEN_BUDGET) {
          process.stderr.write(`[AgentModelExecutor] Token budget exceeded: ${totalTokensUsed}/${TOKEN_BUDGET} for session "${sessionId}". Forcing summary.\n`);
          turnExitReason = "budget_exhausted";
          break;
        }

        const assistantMsg = result.message;

        // 成功路径（无 classifiedError）：有内容或有工具调用 = 混合证据 fail-open，
        // 确定性空响应计数清零；空成功（无内容无工具调用）不清零、继续累计——
        // 连续 2 次空响应即确定性短路（hermes usage-proof 口径，零输出才计）。
        if (assistantMsg.content || (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0)) {
          consecutiveDeterministicEmpty = 0;
        }

        // ── 进度反馈：提取 LLM 思考摘要 ──
        // 当 LLM 返回文本内容时，提取前几行作为思考过程摘要反馈给用户
        if (assistantMsg.content && onProgress) {
          const content = assistantMsg.content;
          // 提取第一段非空文本作为摘要（最多 120 字符）
          const firstLine = content.split("\n").find(l => l.trim().length > 0)?.trim() || "";
          const summary = firstLine.length > 120 ? firstLine.slice(0, 120) + "..." : firstLine;
          if (summary) {
            onProgress({
              type: "status",
              phase: "thinking",
              detail: `💭 ${summary}`,
              progress: Math.min(35 + round * 3, 85),
              round: round + 1,
              thinkingSteps: traceSnapshot(trace),
            });
          }
        }

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
            process.stdout.write(`[AgentModelExecutor] Parsed ${parsedCalls.length} XML tool call(s) from content: ${parsedCalls.map(c => c.function.name).join(", ")}\n`);
          }
        }

        if (assistantMsg.content) {
          finalReply = assistantMsg.content;
          finalReply = finalReply.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, "").trim();
          finalReply = finalReply.replace(/<invoke\s+name="[^"]*">[\s\S]*?<\/invoke>/g, "").trim();
          finalReply = finalReply.replace(/<parameter\s+name="[^"]*">[\s\S]*?<\/parameter>/g, "").trim();
        }

        // ── Provider safety-filter rejection fallback ──
        // If the provider refused the prompt (common with Mimo's content
        // filter), treat it as a provider failure and try the next provider.
        if (finalReply && !assistantMsg.tool_calls && isProviderSafetyRejection(finalReply)) {
          process.stderr.write(`[AgentModelExecutor] Provider "${provider.name}" returned safety-filter rejection for session "${sessionId}": ${finalReply.slice(0, 200)}\n`);
          recordProviderFailure(provider.name);
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            turnExitReason = "content_filter";
            break;
          }
          continue;
        }

        // ★ 2026-10-27 兜底：tc="none" 时若网关无视 tool_choice（按规范回退默认
        //   "auto"）而照常返回 tool_calls，则**拒绝执行**：把 assistant 消息与
        //   对应的 tool 结果原样回灌（保持 OpenAI 消息格式合法——否则下一轮请求
        //   会带无人应答的 tool_calls 被网关 400），并跳过本轮工具执行、进入下
        //   一轮让模型在被拒绝后直接以文本收尾。语义与旧实现「tools 置空」一致，
        //   但请求体 tools 段保持字节稳定，不再击穿前缀缓存。
        //   为防个别网关持续无视（每轮都调工具），同一次调用最多容忍 1 轮拒绝
        //   续跑，之后强制收尾，避免烧掉整个迭代预算。
        let toolCalls = assistantMsg.tool_calls;
        if (tc === "none" && toolCalls && toolCalls.length > 0) {
          toolCallsNoneRefusals++;
          const refusedNames = toolCalls.map((c) => c.function.name).join("、");
          process.stdout.write(
            `[AgentModelExecutor] Provider ignored tool_choice=none — refusing ${toolCalls.length} call(s) [${refusedNames}] (refusal #${toolCallsNoneRefusals})\n`,
          );
          conversationMessages.push(assistantMsg);
          for (const refused of toolCalls) {
            conversationMessages.push({
              role: "tool",
              tool_call_id: refused.id,
              name: refused.function.name,
              content:
                "[系统] 本轮工具调用已被禁用（tool_choice=none），已拒绝执行。" +
                "请直接用文本给出最终回复，不要再调用任何工具。",
            });
          }
          if (toolCallsNoneRefusals > 1) {
            if (!finalReply) {
              finalReply = "（本轮工具调用已被系统禁用，模型未给出文本回复。请重试或换一种问法。）";
            }
            break;
          }
          continue;
        }

        // Record token usage for real-time tracking (after XML tool-call parsing
        // so toolCalls count reflects both native and XML-parsed calls).
        if (deps.tokenUsageTracker) {
          try {
            const outputTokens = Math.max(0, result.tokensUsed - result.promptTokens);
            deps.tokenUsageTracker.record({
              sessionId,
              provider: provider.provider || provider.name,
              model: provider.model || "unknown",
              inputTokens: result.promptTokens,
              outputTokens,
              durationMs: result.responseMs,
              channel: channel || "unknown",
              toolCalls: toolCalls?.length ?? 0,
              ...cacheExtrasFromResult(result, provider.provider || provider.name),
            });
          } catch { /* best-effort */ }
        }

        // ★ P0-4：发射 prompt cache hit ratio 指标（grafana 仪表盘
        // `evoclaw_prompt_cache_hit_ratio` 依赖此 gauge）。cacheHitTokens
        // 来自 provider 响应 usageDetails；cacheMissTokens = input - hit。
        {
          const cacheExtras = cacheExtrasFromResult(result, provider.provider || provider.name);
          if (cacheExtras.cacheHitTokens !== undefined) {
            const cacheMissTokens = Math.max(0, result.promptTokens - cacheExtras.cacheHitTokens);
            const obs = deps.registry?.resolveService<any>("observability");
            if (obs?.recordLLMCacheHit) {
              try {
                obs.recordLLMCacheHit(provider.provider || provider.name, provider.model || "unknown", cacheExtras.cacheHitTokens, cacheMissTokens);
              } catch { /* best-effort */ }
            }
          }
        }
        // ★ P0-5：CacheTracer 记录真实 cache 命中 token（provider usage 真值）。
        // 网关未上报 cache 字段时**跳过记录**：若按 0 命中 + 全额未命中记账，
        // overallHitRate = hit/(hit+miss) 会被「不上报缓存统计」的网关拉向 0%，
        // 与 cacheExtrasFromResult 的既定语义（不上报就不发指标）以及上面
        // P0-4 gauge 路径保持一致。
        if (deps.cacheTracer) {
          try {
            const cacheExtras = cacheExtrasFromResult(result, provider.provider || provider.name);
            if (cacheExtras.cacheHitTokens !== undefined) {
              const cacheHitTokens = cacheExtras.cacheHitTokens;
              const cacheMissTokens = Math.max(0, result.promptTokens - cacheHitTokens);
              deps.cacheTracer.record({
                sessionId,
                provider: provider.provider as import("./prompt-cache-stability").CacheProvider,
                model: provider.model,
                cacheHitTokens,
                cacheMissTokens,
                requestId: undefined,
                durationMs: result.responseMs,
              });
            }
          } catch { /* best-effort */ }
        }
        // Check if LLM used web_search or tavily-search but user intent matches an installed skill
        // Also check if SearchPreprocessor auto-executed a search (searchPreDone)
        const usedWebSearch = toolCalls && toolCalls.some(tc => {
          const args = JSON.stringify(tc.function.arguments || {});
          return tc.function.name === "web_search" ||
            (tc.function.name === "skill_manage" && args.includes("tavily")) ||
            (tc.function.name === "web_fetch" && args.includes("stealth"));
        });
        const usedCiccSkill = toolCalls && toolCalls.some(tc => {
          const args = JSON.stringify(tc.function.arguments || {});
          return (tc.function.name === "skill_manage" && args.includes("cicc")) ||
            (tc.function.name === "shell_exec" && args.includes("cicc"));
        });
        const searchWasDone = usedWebSearch || searchPreDone;
        if (searchWasDone && !usedCiccSkill) {
          process.stdout.write(`[AgentModelExecutor] Search was done (preDone=${searchPreDone}, webSearch=${usedWebSearch}) but no CICC skill — will check for skill fallback\n`);
        }

        if (!toolCalls || toolCalls.length === 0) {
          // ── 空成功确定性累计（hermes empty_response_guard usage-proof 口径）──
          // 无 content 且无 tool_calls = 本次调用零输出。连续 2 次即判该
          // provider 对本上下文确定性无输出：直接 failover（跳过 post_tool_empty
          // nudge 的盲重试，省 1-2 次调用 + 迭代预算）。有工具调用过后再空是
          // 正常分支（nudge 仍兜底，但只在累计 <2 时）。
          if (!assistantMsg.content) {
            consecutiveDeterministicEmpty++;
            if (consecutiveDeterministicEmpty >= 2) {
              process.stderr.write(
                `[AgentModelExecutor] Provider "${provider.name}" (${provider.model}) produced ${consecutiveDeterministicEmpty} consecutive empty completions — deterministic, failing over instead of retrying\n`,
              );
              break;
            }
          }
          // ── Fallback: auto-trigger skill_list / search for skill-install intents ──
          // When the LLM returns a chat reply without calling any tool, but the
          // user message semantically matches a skill-install or action intent,
          // we auto-trigger skill_list (action=search) as a safety net.
          // Prefer semantic classification (embedding-based) over keyword matching.
          // ★ 2026-10-26 修复：action_task 意图的置信度阈值从"任意正值"提高到 0.7，
          //   否则分析类任务（如"设计API"、"项目管理"）会被误判为 action_task
          //   （实测 score 0.51–0.57 就触发），导致无关技能被搜索和安装。
          const MIN_SKILL_INSTALL_SCORE = 0.6;
          const MIN_ACTION_TASK_SCORE = 0.7;
          let shouldTriggerSkillSearch = false;
          const classifier = deps.semanticIntentClassifier;
          if (classifier) {
            try {
              const intent = await classifier.classifyIntent(message);
              if (intent) {
                const threshold = intent.category === "skill_install" ? MIN_SKILL_INSTALL_SCORE : MIN_ACTION_TASK_SCORE;
                if ((intent.category === "skill_install" || intent.category === "action_task") && intent.score >= threshold) {
                  process.stdout.write(`[AgentModelExecutor] Semantic intent="${intent.category}" score=${intent.score.toFixed(4)} (≥${threshold}), auto-triggering skill_list\n`);
                  shouldTriggerSkillSearch = true;
                } else if ((intent.category === "skill_install" || intent.category === "action_task") && intent.score > 0) {
                  process.stdout.write(`[AgentModelExecutor] Semantic intent="${intent.category}" score=${intent.score.toFixed(4)} (<${threshold}), skipping auto skill_list\n`);
                }
              }
            } catch (err) { process.stderr.write(`[AgentModelExecutor] Skill fallback error:` + " " + err + "\n"); /* best-effort */ }
          }
          // Fallback to keyword matching if semantic classifier is unavailable
          if (!shouldTriggerSkillSearch && !classifier) {
            const lowerMsg = String(conversationMessages[conversationMessages.length - 1]?.content ?? "").toLowerCase();
            const skillIntentKeywords = ["install", "安装", "装一个", "装个", "技能", "skill"];
            shouldTriggerSkillSearch = skillIntentKeywords.some(kw => lowerMsg.includes(kw));
          }
          if (shouldTriggerSkillSearch && deps.registeredTools.has("skill_list")) {
            try {
              const searchTool = deps.registeredTools.get("skill_list")!;
              const searchResult = await searchTool.handler({ action: "search", task: message });
              const searchStr = typeof searchResult === "string" ? searchResult : JSON.stringify(searchResult);
              // Log the search result but do NOT append to user-facing reply.
              // The skill search is informational only; if a matching skill
              // was found, the SkillDispatcher would have handled it earlier.
              process.stdout.write(`[AgentModelExecutor] Auto skill_list result: ${searchStr.slice(0, 200)}\n`);
            } catch (err) {
              process.stderr.write(`[AgentModelExecutor] Auto skill_list failed:` + " " + err + "\n");
            }
          }
          // ── fix-4: post_tool_empty 重试 ──
          // 借鉴 hermes-agent 的 post_tool_empty_retried 策略：
          // 当 LLM 在工具执行后返回空响应（无 content 且无 tool_calls）时，
          // 追加一条 nudge 消息重试，而非直接以空回复结束。
          if (!assistantMsg.content && successfulToolCalls > 0 && round < maxToolRounds - 1) {
            const recovery = getStreamingRecoveryManager();
            const retryCount = recovery.getRetryCount("post_tool_empty");
            if (retryCount < recovery.getConfig().maxPostToolEmptyRetries) {
              process.stderr.write(
                `[AgentModelExecutor] Empty response after ${successfulToolCalls} tool calls; ` +
                `nudge retry ${retryCount + 1}/${recovery.getConfig().maxPostToolEmptyRetries}\n`,
              );
              // 标记重试（递增计数器）
              recovery.recover({
                partialText: "",
                interruptedInThinking: false,
                interruptedInToolCall: false,
                truncatedByLength: false,
                toolCallsThisTurn: [],
                hasPriorTurnContent: false,
                retryCount,
              });
              // 追加 nudge 消息，引导 LLM 基于工具结果回复
              conversationMessages.push(assistantMsg);
              pendingTransient.push({
                role: "user",
                content: "工具已执行完毕，请根据以上工具执行结果回答我的问题。",
              });
              continue;
            }
            process.stderr.write(
              `[AgentModelExecutor] post_tool_empty retries exhausted (${retryCount}). Breaking with empty reply.\n`,
            );
          }

          // ── 自动续跑：检测到"该继续却停下来问人"时，回灌指令让模型继续 ──
          // 用户反馈（核心痛点）：agent 发现问题后**不自动纠正后接着跑**，
          // 而是停下来等用户输入"继续"。这里把两类停顿识别出来并自动续跑：
          //   1) 明确要求用户回复"继续" / 承诺后续动作却没做（detectPrematureStop）
          //   2) 工具失败 / 返回空结果 / 声称完成却没执行（completion-truthfulness）
          // 例外：需要人工审批（pendingPermissions）时必须停下来等用户，不自动续跑。
          if (
            finalReply &&
            autoContinueCount < MAX_AUTO_CONTINUE &&
            // ★ 2026-10-30 v7 压测修复：旧门 round < maxToolRounds - 2 把末两轮
            //   的 nudge 全部挡掉——复杂任务（cap=20）第 18~19 轮模型说"下一步/
            //   继续"也无人续跑，直接带未完成交付收尾（Task 7 terraform 只产出
            //   6 个 .tf 就停）。放宽到 cap-1：倒数第二轮仍可 nudge 续跑（续跑
            //   占用最后一轮）；末轮本身不 nudge，由兜底总结调用（下方
            //   round === maxToolRounds - 1 的总结分支）接管。循环安全仍靠
            //   MAX_AUTO_CONTINUE=3 + overlapRatio>0.7 循环守卫兜底，勿删。
            round < maxToolRounds - 1 &&
            pendingPermissions.length === 0
          ) {
            const premature = detectPrematureStop(finalReply, { toolCallsThisRound: false });
            const preVerdict = reconcileCompletionTruthfulness({
              finalReply,
              pendingPermissions,
              toolsExecuted: anyToolExecuted,
              lastUserMessage: message,
              failedTools,
              emptyResultTools,
              writeOps: writeOps(),
              executedShellCommands: extractExecutedShellCommands(executedToolCalls),
            });

            // ── 磁盘文件核验（Task 10 修复：盘内续跑触发）─────────────────
            // ★ 2026-10-27：完成声明对账只检查"是否调用了写工具"，但不验证
            //   声称创建的文件是否真的存在于磁盘上。磁盘核验此前只在循环结束
            //   后追加更正说明，从不回灌到 auto-continue —— 导致声称"已创建
            //   cache-analysis.md"但文件不存在时，模型不会重试（Task 10 失败）。
            //   现在把磁盘核验移入循环内：声称文件不存在 → 触发续跑让模型真正创建。
            let diskMissingPaths: string[] = [];
            try {
              const claimedPaths = extractClaimedFilePaths(finalReply, deps.workspacePath);
              if (claimedPaths.length > 0) {
                diskMissingPaths = claimedPaths.filter((p) => {
                  try { return !fs.existsSync(p); } catch { return true; }
                });
              }
            } catch { /* skip — 磁盘核验失败不阻断主流程 */ }

            // 只有在"确实有活可干"的语境下才续跑，避免把纯闲聊的承诺句式误判成停顿
            const hasWorkContext =
              anyToolExecuted ||
              failedTools.length > 0 ||
              emptyResultTools.length > 0 ||
              diskMissingPaths.length > 0 ||
              hasActionIntentFn(message);
            // ★ 2026-10-26 修复：创造性任务的首次响应可能较短但已包含实质内容
            //   （1307 chars），不应触发 auto-continuation——续跑会额外消耗
            //   60-100s（第二轮 LLM call），总时间超 300s。只有当创造性任务
            //   的响应极短（< 300 chars，可能是确认/敷衍）时才续跑。
            // ★ 2026-10-28 修复（v5 Task 4 事故）：磁盘核验发现用户要求写入的
            //   文件不存在时（diskMissingPaths > 0），即使回复已是实质内容也
            //   必须放行续跑——否则"文档贴在聊天里、文件不落盘"的回复会直接
            //   收尾（实测：更正脚注已追加但文件始终没写）。
            const isCreativeSubstantive = isCreativeTask && finalReply.length > 300 && diskMissingPaths.length === 0;
            process.stdout.write(`[AgentModelExecutor] Auto-continue check: isCreativeTask=${isCreativeTask}, replyLen=${finalReply.length}, isCreativeSubstantive=${isCreativeSubstantive}, premature=${premature}, needsCorrection=${preVerdict.needsCorrection}, reason=${preVerdict.reason}\n`);
            // ★ 第三条触发条件（2026-10-07 补充）：**工具失败了，但模型只是把错误
            // 复述一遍就收尾**，既没说完成（对账不会触发），用词也不像在求确认
            // （停顿检测抓不到）。真实案例：node -e 引号报错 + Docker 不可用，
            // 模型放弃并反问用户「要不要我继续」。这类必须让它换方案再试。
            // 注意 pendingPermissions 非空时整个块已被跳过 —— 那是真的在等人工审批，
            // 不该自动重试；extractToolFailure 也已把「等待审批」排除在 failedTools 外。
            // ★ 2026-10-27 循环守卫：若模型在收到续跑指令后再次 yield 且内容
            //   与上次 yield 高度相似（>70% 重叠），说明模型陷入循环，不再续跑。
            const yieldSimilarity = lastYieldReply && finalReply
              ? overlapRatio(finalReply, lastYieldReply)
              : 0;
            const isLooping = yieldSimilarity > 0.7 && autoContinueCount > 0;
            process.stdout.write(`[AgentModelExecutor] Auto-continue loop guard: similarity=${yieldSimilarity.toFixed(2)}, isLooping=${isLooping}, lastYieldLen=${lastYieldReply.length}\n`);
            const stalledAfterFailure = failedTools.length > 0;
            const shouldContinue =
              !isCreativeSubstantive &&
              !isLooping &&
              hasWorkContext &&
              (premature !== null ||
                stalledAfterFailure ||
                diskMissingPaths.length > 0 ||
                (preVerdict.needsCorrection && preVerdict.reason !== "pending_permissions"));

            // ── 验证门（Verification Gate）───────────────────────────
            // 借鉴 hermes-agent verification_stop.py：模型在变更类工具
            // （文件写类）之后声称完成，但未提供验证证据时，注入合成
            // nudge 要求先验证再结束。与 completion-truthfulness 的
            // 「事后对账」不同，这是事前拦截 —— 让模型继续跑。
            // 仅当变更路径中存在「可验证」文件（非纯文档/数据）时才触发。
            const changedPathsForGate = extractChangedPaths(executedToolCalls);
            // ── 验证证据账本（hermes verification_evidence「编辑失效」语义）──
            // getStalePaths() 三种返回值：
            //   null  → 从未验证过 → 按旧行为全量 nudge
            //   []    → 上次验证仍然有效（之后没再编辑）→ 不重复 nudge
            //   [paths] → 上次验证已被后续编辑作废 → 只对失效路径定向复验
            const stalePaths = evidenceStore.getStalePaths();
            const verificationGateTriggered =
              shouldTriggerVerificationGate(
                changedPathsForGate,
                executedToolCalls.map((c) => c.name),
                finalReply,
                verificationNudgeCount,
              ) &&
              // 验证仍然有效（stalePaths === []，之后没再编辑）→ 不重复 nudge
              (stalePaths === null || stalePaths.length > 0);
            // ── Kanban 终止门（对标 hermes kanban_stop.py）──
            // Kanban worker 必须以终端 board 工具结束（kanban_complete / kanban_block /
            // kanban_request_review / kanban_request_changes），而非仅文字叙述。
            // 仅在会话执行过 kanban 工具且未调用终端工具时触发。
            const isKanbanWorkerSession = executedToolCalls.some((c) =>
              TERMINAL_KANBAN_TOOLS.has(c.name) || c.name.startsWith("kanban_"),
            );
            const kanbanStopTriggered =
              isKanbanWorkerSession &&
              kanbanStopNudgeCount < 2 &&
              finalReply &&
              !sessionCalledKanbanTerminal(conversationMessages);
            const kanbanShouldContinue = kanbanStopTriggered;

            const effectiveShouldContinue = shouldContinue || verificationGateTriggered || kanbanShouldContinue;

            if (effectiveShouldContinue) {
              if (kanbanStopTriggered) {
                kanbanStopNudgeCount++;
                const kanbanNudge = buildKanbanStopNudge(conversationMessages, kanbanStopNudgeCount - 1, {});
                if (kanbanNudge) {
                  trace.addSystem(
                    `Kanban 终止门 #${kanbanStopNudgeCount}（worker 未调用终端工具即收尾）`,
                    `已执行 kanban 工具但未调用 kanban_complete/kanban_block/kanban_request_review`,
                  );
                  process.stdout.write(
                    `[AgentModelExecutor] Kanban stop gate #${kanbanStopNudgeCount} ` +
                    `— kanban worker stopped without terminal board tool; nudging to complete\n`,
                  );
                  conversationMessages.push(assistantMsg);
                  pendingTransient.push({ role: "user", content: kanbanNudge });
                  if (finalReply) {
                    lastReplyBackup = finalReply;
                  }
                  finalReply = "";
                  continue;
                }
              }

              if (verificationGateTriggered) {
                verificationNudgeCount++;
                // 定向复验：失效路径优先（stalePaths 非空），否则用全部变更路径
                const nudgePaths = stalePaths && stalePaths.length > 0 ? stalePaths : changedPathsForGate;
                const nudge = await buildVerifyOnStopNudgeWithHooks(nudgePaths, verificationNudgeCount - 1);
                trace.addSystem(
                  `验证门 #${verificationNudgeCount}（变更文件后未验证即声称完成）`,
                  `变更文件：${nudgePaths.join("、")}`,
                );
                process.stdout.write(
                  `[AgentModelExecutor] Verification gate #${verificationNudgeCount} ` +
                  `— file mutations detected without verification evidence; nudging agent to verify\n`,
                );
                onProgress?.({
                  type: "auto_continue",
                  phase: "thinking",
                  detail: `验证门触发（第 ${verificationNudgeCount} 次）：请先验证工作成果再结束`,
                  progress: Math.min(30 + round * 3, 90),
                  thinkingSteps: trace.toJSON(),
                });
                conversationMessages.push(assistantMsg);
                pendingTransient.push({ role: "user", content: nudge! });
                if (finalReply) {
                  lastReplyBackup = finalReply;
                  pendingVerificationReply = finalReply;
                }
                finalReply = "";
                continue;
              }

              autoContinueCount++;
              // ★ 2026-10-27 循环守卫：记录本次 yield 回复，用于下一轮检测
              //   模型是否陷入"yield → nudge → 同样的 yield"循环。
              lastYieldReply = finalReply;
              // ★ 2026-10-11：`stalledAfterFailure`（工具失败后直接收尾，没有
              //   明确停顿词、也没触发对账更正）时，原来 fallback 成字面量
              //   "unknown"，轨迹条目 detail 甚至是空的 —— 用户点开续跑记录
              //   看不到"为什么续跑"。实测日志确为 `trigger=unknown`。
              //   现在归因清楚，并把失败工具名列进 detail。
              const trigger = premature
                ?? (diskMissingPaths.length > 0 ? "disk_files_missing" : null)
                ?? (stalledAfterFailure ? "tool_failed" : preVerdict.reason)
                ?? "unknown";
              trace.addSystem(
                `自动续跑 #${autoContinueCount}/${MAX_AUTO_CONTINUE}（原因：${trigger}）`,
                [
                  premature ? `停顿检测：${premature}` : "",
                  diskMissingPaths.length > 0
                    ? `磁盘文件核验：声称创建的文件不存在：${diskMissingPaths.join("、")}`
                    : "",
                  preVerdict.notice ?? "",
                  failedTools.length > 0
                    ? `本轮失败工具：${failedTools.map((f) => `${f.name}(${f.error})`).join("、")}`
                    : "",
                  emptyResultTools.length > 0
                    ? `本轮空结果工具：${emptyResultTools.map((e) => `${e.name}.${e.field}`).join("、")}`
                    : "",
                ].filter(Boolean).join("\n"),
              );
              // 磁盘文件缺失时，把缺失文件列表注入续跑指令，让模型明确知道要补建哪些
              // ★ 2026-10-28 强化（v4 Task 7/8 事故）：此前指令只说"必须重新创建"，
              //   模型仍可能创建其他文件名的文件替代、或只在回复里描述内容。
              //   v9 复测新增：模型曾把相对路径 `tmp_v4_monitor/...` 传给 file_write，
              //   文件落到了工作区 data/workspace/ 下、磁盘核验仍失败。现在明确要求
              //   使用绝对路径原样传入——相对路径会解析到工作区，写到错误位置。
              const diskCorrection = diskMissingPaths.length > 0
                ? `\n\n**磁盘文件核验失败**：以下声称创建的文件在磁盘上不存在，必须重新创建：\n${diskMissingPaths.map((p) => `- \`${p}\``).join("\n")}\n\n必须真正调用 file_write 工具创建这些文件，并把上面列出的路径**原样作为 path 参数传入**（例如 file_write action=create、path="/tmp/v4-monitor/monitor.sh"）。**不要用相对路径**——相对路径会解析到工作区 data/workspace/ 下，文件会写到错误位置、磁盘核验仍会失败。**文件名必须与上面完全一致**——不要创建其他文件名替代。**绝对禁止把文件内容（包括完整代码/代码块）贴在回复里**——贴在回复里不算完成，磁盘核验会判定失败；v5 实测模型多次把测试代码贴在聊天里而不调用 file_write，6 次续跑均未纠正。创建后立即用 file_read 或 \`ls -la <目录>\` 验证文件确实存在，再继续。`
                : undefined;
              const directive = buildContinuationDirective({
                kind: premature ?? "needs_correction",
                userMessage: message,
                correction: [
                  preVerdict.needsCorrection ? preVerdict.notice : undefined,
                  diskCorrection,
                ].filter(Boolean).join("\n") || undefined,
                failedTools,
                emptyResultTools,
              });
              process.stdout.write(
                `[AgentModelExecutor] Auto-continue #${autoContinueCount}/${MAX_AUTO_CONTINUE} ` +
                `(trigger=${trigger}) — resuming task instead of yielding to user\n`,
              );
              onProgress?.({
                type: "auto_continue",
                phase: "thinking",
                detail: `检测到任务未完成（${trigger}），自动继续执行（${autoContinueCount}/${MAX_AUTO_CONTINUE}）…`,
                progress: Math.min(30 + round * 3, 90),
                thinkingSteps: trace.toJSON(),
              });
              conversationMessages.push(assistantMsg);
              pendingTransient.push({ role: "user", content: directive });
              // 保留一份备份，防止续跑后产不出新回复时返回空
              if (finalReply) lastReplyBackup = finalReply;
              // 清空本轮 finalReply：避免下一轮模型若返回空内容时误用旧的"停顿版"回复
              finalReply = "";
              continue;
            }
          }

          conversationMessages.push(assistantMsg);
          break;
        }

        conversationMessages.push(assistantMsg);

        // ── Parallel tool execution (inspired by OpenClaw's executeToolCallsParallel) ──
        // Tools that are read-only and independent can be executed in parallel.
        // Tools with side-effects or dependencies must be executed sequentially.
        // 注意：browser_* 工具已从并行安全集合中移除，因为 Playwright 不支持
        // 并发操作同一浏览器实例。浏览器工具通过 browserToolMutex 串行化。
        const PARALLEL_SAFE_TOOLS = new Set([
          "web_search", "web_fetch", "file_read", "file_list",
          "skill_manage", "skill_list", "skill_view",
          "memory_retrieve", "memory",
          "sequential_thinking", "assess_coding_capability",
          "markitdown_convert",
        ]);

        // ── 工具执行并发控制（灵感来自 hermes-agent 的 semaphore 限制） ──
        // 防止 LLM 返回大量并行工具调用时耗尽 socket/文件句柄/浏览器实例。
        // 全局上限防止资源耗尽，浏览器串行化防止 Playwright 冲突，
        // 网络工具上限防止触发对端限流。
        const getToolSemaphore = (toolName: string): Semaphore => {
          if (toolName.startsWith("browser_")) return browserToolMutex;
          if (["web_search", "web_fetch"].includes(toolName)) {
            return networkToolSemaphore;
          }
          return globalToolSemaphore;
        };

        // Separate tool calls into parallel-safe and sequential groups
        const parallelCalls: typeof toolCalls = [];
        const sequentialCalls: typeof toolCalls = [];

        // ── IterationBudget: 收集本轮工具名（execute_code 退款用） ──
        // 借鉴 hermes-agent iteration_budget.py refund_for_execute_code：
        // 当一轮中只调用了 execute_code 类工具时，退还该次迭代——执行不是决策。
        // 此前退款机已实现但零活调用点（死代码），现接入活路径。
        const roundToolNames = toolCalls.map((tc) => tc.function.name);

        if (toolCalls.length > 1) {
          // If ALL tool calls are parallel-safe, execute them all in parallel
          const allParallelSafe = toolCalls.every(tc => PARALLEL_SAFE_TOOLS.has(tc.function.name));
          if (allParallelSafe) {
            parallelCalls.push(...toolCalls);
          } else {
            // Mixed: execute parallel-safe ones first (in parallel), then sequential ones
            for (const tc of toolCalls) {
              if (PARALLEL_SAFE_TOOLS.has(tc.function.name)) {
                parallelCalls.push(tc);
              } else {
                sequentialCalls.push(tc);
              }
            }
          }
        } else {
          sequentialCalls.push(...toolCalls);
        }

        // Helper: execute a single tool call and return the result message
        // (extracted from the original for-loop body below)
        const executeSingleToolCall = async (tc: typeof toolCalls[0]): Promise<{ role: string; tool_call_id: string; name: string; content: string }> => {
          const toolStartTime = Date.now();
          const toolName = tc.function.name;
          const toolEntry = deps.registeredTools.get(toolName);

          taskStatusTracker.set(sessionId, "tool_calling", `正在执行: ${toolName}...`, 50 + Math.floor((toolCalls.indexOf(tc) / toolCalls.length) * 20));
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch (parseErr) {
            process.stderr.write(`[LLMCaller] Failed to parse tool arguments for ${toolName}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n`);
            args = { _parseError: true, _rawArguments: tc.function.arguments?.slice(0, 200) };
          }

          // ★ 决策入轨迹的**唯一**位置（2026-10-11）：此处三条来源（流式
          //   tool_calls / 非流式 tool_calls / 正文 XML 解析）已汇合，参数也已
          //   完整解析，因此无论走哪条路径、参数取哪个早退分支，轨迹里都能看到
          //   一句带真实参数的「决定调用 X」。（历史：流式侧只记占位
          //   `{_partial:true}`、XML 来源完全不记 → 同一功能不同 provider 表现不一。）
          trace.addDecision(toolName, args, round + 1);

          // ── 进度反馈：生成可读的工具操作摘要 ──
          const toolSummary = formatToolSummary(toolName, args);
          const toolIdx = toolCalls.indexOf(tc);
          const toolProgress = 50 + Math.floor((toolIdx / toolCalls.length) * 20);
          onProgress?.({ type: "tool_call", phase: "tool_calling", detail: toolSummary, progress: toolProgress, toolName, toolArgs: args, round: round + 1, thinkingSteps: traceSnapshot(trace) });

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
              // 统一失败契约：历史返回只有 {skipped,reason} 没有 success:false，
              // 下游失败对账完全识别不到，模型把「被取消」当成终态失败后
              // 直接放弃并转向向用户索要替代方案。
              // 现在显式区分：blocked 不可重试，cancelled 可以重试一次。
              return {
                role: "tool",
                tool_call_id: tc.id,
                name: toolName,
                content: JSON.stringify({
                  success: false,
                  skipped: true,
                  reason: blocked ? "blocked" : "cancelled",
                  retryable: !blocked,
                  error: blocked
                    ? `Tool "${toolName}" was blocked by a before_tool_call hook and did not run.`
                    : `Tool "${toolName}" was cancelled by a before_tool_call hook and did not run. This is often transient — retry once before giving up or switching approach.`,
                }),
              };
            }
            const mergedBTC = merged as Partial<import("@evoclaw/core").BeforeToolCallResult>;
            if (mergedBTC.params) args = mergedBTC.params as Record<string, unknown>;
            if (mergedBTC.skipWithResult !== undefined) {
              skipWithResult = mergedBTC.skipWithResult;
            }
          }

          // ── Human-in-the-Loop approval check ──
          // 技能中的 Python 脚本执行无须批准：shell_exec 已设为 low 风险级别，
          // 此处额外检查命令是否为 Python 脚本执行，确保即使 HITL 配置变更也不会拦截。
          const isPythonScriptExecution =
            toolName === "shell_exec" &&
            typeof args.command === "string" &&
            /^\s*(python3?|py)\s+/i.test(args.command);

          // ── R2-3: 破坏性命令检测（借鉴 hermes-agent _is_destructive_command） ──
          // 检测 rm -rf / git reset --hard / mkfs 等破坏性命令，
          // 通过 progress 上报警告，提示用户该操作不可逆。
          if (toolName === "shell_exec" && typeof args.command === "string") {
            try {
              const { isDestructiveCommand } = await import("@evoclaw/security");
              if (isDestructiveCommand(args.command)) {
                process.stderr.write(`[AgentModelExecutor] Destructive command detected: ${args.command.slice(0, 100)}\n`);
                onProgress?.({
                  type: "error",
                  phase: "tool_calling",
                  detail: `⚠️ 检测到破坏性命令：${args.command.slice(0, 80)}${args.command.length > 80 ? "..." : ""}\n此操作不可逆，请确认是否继续。`,
                  progress: 50,
                  toolName,
                  round: round + 1,
                });
              }
            } catch (importErr) {
              // 安全包不可用时不阻断
            }
          }

          if (
            deps.humanApprovalManager &&
            !isPythonScriptExecution &&
            deps.humanApprovalManager.requiresApproval(toolName, args)
          ) {
            const riskLevel = deps.humanApprovalManager.getRiskLevel(toolName);

            if (hitlRejectCount >= 1) {
              process.stdout.write(`[AgentModelExecutor] HITL: Fast-rejecting tool "${toolName}" (${hitlRejectCount} prior rejections in session)\n`);
              return {
                role: "tool",
                tool_call_id: tc.id,
                name: toolName,
                content: JSON.stringify({ error: "Operation requires approval but was auto-rejected due to a previous rejection in this session. Please explicitly confirm if you want to proceed.", riskLevel }),
              };
            }

            const approvalRequest = {
              id: `hitl-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
              operation: toolName,
              params: args,
              riskLevel: riskLevel || "medium",
              description: `Tool "${toolName}" requires approval (${riskLevel || "medium"} risk)`,
              target: toolName,
            };
            pendingPermissions.push(approvalRequest);
            return {
              role: "tool",
              tool_call_id: tc.id,
              name: toolName,
              // 统一失败契约：必须带 success:false，否则下游无法把它识别为
              // 「未生效」的结果。同时保留 requiresPermission:true，让失败对账
              // 把它归入「等待审批」而非「执行失败」，避免误报。
              content: JSON.stringify({
                success: false,
                pendingApproval: true,
                requiresPermission: true,
                retryable: false,
                requestId: approvalRequest.id,
                message: "This operation requires your approval. Please approve or reject it.",
              }),
            };
          }

          // ── Parameter validation ──
          if (!args._parseError) {
            const paramError = validateToolParams(toolName, args, toolEntry?.definition || { parameters: {} });
            if (paramError) {
              return {
                role: "tool",
                tool_call_id: tc.id,
                name: toolName,
                content: JSON.stringify({ error: `Invalid parameters: ${paramError}`, suggestion: "Check the parameter types and required fields." }),
              };
            }
          }

          let rawResult: unknown = undefined;

          if (!toolEntry) {
            return {
              role: "tool",
              tool_call_id: tc.id,
              name: toolName,
              content: JSON.stringify({
                error: `Tool "${toolName}" is not registered`,
                suggestion: "Check the tool name for typos. Use only tools that are available in your tool list.",
                toolName,
              }),
            };
          }

          // ── Circuit breaker check ──
          if (isToolTripped(toolName)) {
            return {
              role: "tool",
              tool_call_id: tc.id,
              name: toolName,
              content: JSON.stringify({ error: `Tool "${toolName}" is temporarily disabled due to repeated failures. Try a different approach.`, cooldownRemaining: "60s" }),
            };
          }

          // ── Idempotency cache for write operations ──
          // 使用模块级 IDEMPOTENT_TOOLS 定义，避免重复定义导致集合不一致。
          // key 保留**全量 args**（含内容），只按路径去重会让「同路径不同内容」
          // 的第二次写入被误判为重复而**静默跳过**，风险高于收益。
          if (IDEMPOTENT_TOOLS.has(toolName)) {
            cleanIdempotencyCache();
            const cacheKey = `${toolName}:${JSON.stringify(args)}`;
            const cached = idempotencyCache.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < IDEMPOTENCY_TTL) {
              process.stdout.write(`[AgentModelExecutor] Idempotent cache hit for ${toolName}\n`);
              return { role: "tool", tool_call_id: tc.id, name: toolName, content: cached.result };
            }
          }

          // ── Tool result cache ──
          if (deps.toolResultCache) cleanToolCache(deps.toolResultCache);
          const cachedResult = lookupCachedToolResult(deps.toolResultCache, toolName, args, 300_000);
          if (cachedResult !== null) {
            process.stdout.write(`[AgentModelExecutor] Cache hit for ${toolName}\n`);
            return { role: "tool", tool_call_id: tc.id, name: toolName, content: cachedResult };
          }

          // ── Skip with result from plugin hook ──
          if (skipWithResult !== undefined) {
            toolResult = typeof skipWithResult === "string" ? skipWithResult : JSON.stringify(skipWithResult);
          } else if (!toolErrored) {
            // ── Execute the tool ──
            const isNetworkTool = ["web_search", "web_fetch", "browser_navigate", "browser_act", "skill_manage"].includes(toolName);
            const isBrowser = toolName.startsWith("browser_");
            const toolTimeout = isBrowser || toolName === "shell_exec" ? 300_000 : 30_000;

            try {
              // Use retryAsync for network tools (max 2 retries with exponential
              // backoff + jitter). Non-network tools get a single attempt.
              // Refactored from the inline for-loop to leverage the production-grade
              // retry utilities (crypto-secure jitter, decorrelated backoff, abort signal).
              const execOnce = async (): Promise<unknown> => {
                const toolSem = getToolSemaphore(toolName);
                return toolSem.withPermit(async () => {
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  // 为工具执行创建 AbortController，超时时 cancel 底层操作
                  const toolAbortController = new AbortController();
                  // 将 AbortSignal 注入 args，让支持取消的 handler 可以响应
                  const argsWithSignal = { ...args, _signal: toolAbortController.signal };
                  try {
                    const toolPromise = toolEntry.handler(argsWithSignal);
                    toolPromise.catch(() => {}); // 防止超时后 unhandledRejection
                    return await Promise.race([
                      toolPromise,
                      new Promise<never>((_, reject) => {
                        timer = setTimeout(() => {
                          toolAbortController.abort(new Error(`Tool "${toolName}" timed out after ${toolTimeout / 1000}s`));
                          // ★ 工具超时后标记 suspect（hermes SuspectableBackend 语义）：
                          // 一个卡死的工具若被无脑重试，会耗尽整个 turn 的预算。
                          // 标记后重试前可先 ensureHealthy()，避免盲目重试。
                          getToolSuspectTracker().markToolSuspect(
                            toolName,
                            `timed out after ${toolTimeout / 1000}s`,
                          );
                          reject(new Error(`Tool "${toolName}" timed out after ${toolTimeout / 1000}s`));
                        }, toolTimeout);
                        if (timer.unref) timer.unref();
                      }),
                    ]);
                  } finally {
                    if (timer) clearTimeout(timer);
                  }
                });
              };

              if (isNetworkTool) {
                rawResult = await retryAsync(execOnce, {
                  attempts: 3, // 1 initial + 2 retries (matches previous MAX_RETRIES=2)
                  minDelayMs: 1000,
                  maxDelayMs: 5000,
                  jitter: 0.3,
                  label: `tool:${toolName}`,
                  onRetry: (info) => {
                    process.stderr.write(`[AgentModelExecutor] Tool "${toolName}" retry ${info.attempt}/${info.maxAttempts} after ${info.delayMs}ms: ${info.err instanceof Error ? info.err.message : String(info.err)}\n`);
                  },
                });
              } else {
                rawResult = await execOnce();
              }

              // Process result
              if (typeof rawResult === "string") {
                toolResult = rawResult;
              } else if (rawResult !== null && rawResult !== undefined) {
                const r = rawResult as Record<string, unknown>;
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
              // ★ 2026-11-03 修复：file_read/code_search 使用更高上限（32K），
              //   因为 JSON 序列化后比原始内容大 5-10%（引号/换行转义），
              //   20K 文件序列化后 ~22K 超过 16K 被截断 → agent 反复分块读取死循环。
              const MAX_RESULT_LEN = isBrowser ? 8000 : (toolName === "file_read" || toolName === "code_search" ? 32000 : 16000);
              if (toolResult.length > MAX_RESULT_LEN) {
                toolResult = JSON.stringify({ truncated: true, originalLength: toolResult.length, preview: toolResult.slice(0, MAX_RESULT_LEN), hint: `结果已截断(原${toolResult.length}字符)` });
              }
              toolResult = summarizeToolResultFn(toolName, toolResult);

              // ── Output schema validation ──
              // If the tool declares an `outputSchema`, validate the raw result
              // against it. On mismatch, surface a structured error to the LLM
              // so it can retry or self-correct, instead of silently passing
              // malformed data downstream. Inspired by LangChain args_schema and
              // OpenAI function calling strict mode.
              const outputSchema = toolEntry.definition.outputSchema;
              if (outputSchema) {
                const validation = validateToolResult(toolName, rawResult, outputSchema);
                if (!validation.valid) {
                  process.stderr.write(`[AgentModelExecutor] Tool "${toolName}" output schema validation failed: ${validation.errors.join("; ")}\n`);
                  toolResult = JSON.stringify({
                    error: "tool_output_schema_validation_failed",
                    tool: toolName,
                    violations: validation.errors,
                    hint: "The tool returned a value that does not match its declared output schema. Adjust your parameters and retry, or fall back to a different approach.",
                  });
                }
              }

              // Cache result（副作用工具不缓存：结果非 args 纯函数，见 NO_RESULT_CACHE_TOOLS）
              // ★ P0 性能优化：JSON.stringify(args) 只调用一次，复用给两个缓存 key
              const argsKey = `${toolName}:${JSON.stringify(args)}`;
              if (deps.toolResultCache && !NO_RESULT_CACHE_TOOLS.has(toolName)) {
                deps.toolResultCache.set(argsKey, { result: toolResult, timestamp: Date.now() });
              }
              if (IDEMPOTENT_TOOLS.has(toolName)) {
                idempotencyCache.set(argsKey, { result: toolResult, timestamp: Date.now() });
              }

              // ★ 只在**真的执行过搜索类工具**时才注入。
              // 事故（2026-10-07 15:2x）：`skill_manage` 明明返回
              // 「不是技能而是内置工具」的错误，这里仍给它追加
              // "You have search results now. Do NOT search again"，
              // 与场景完全无关的噪音指令把模型带偏（它随即放弃了正确路径）。
              // 事故（2026-10-16 sess_mvasc4w8）：用户要「前 10 条 + 读各自 README」，
              // web_fetch 返回的 json 被截断（`"truncated":true`，只拿到第 1 条完整数据），
              // 提示仍触发 → 模型被劝「直接回答」，产出一篇只含 1 条数据的残稿并让用户重发。
              // 修复：结果被截断（数据不完整）时跳过——截断恰恰是「还需要取数据」的信号。
              const resultTruncated = toolResult.includes('"truncated":true') || toolResult.includes('"truncated": true');
              if (
                !resultTruncated &&
                successfulToolCalls >= 2 &&
                SEARCH_TOOLS_HINT.has(toolName) &&
                actualSearchExecuted
              ) {
                toolResult += "\n\n[SYSTEM HINT: You have search results now. Do NOT search again. Provide your answer directly in chat.]";
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
                  deps.pendingOperations.set(requestId, { sessionId, message, requestId, toolName, toolArgs: args });
                }
              }
              // ── 识别「执行了但返回失败」的工具 ──
              // 典型：skill_manage 外层 success:true、内层 errors:["Skill not found"]，
              // 模型极易误读为成功并声称完成。此处收集失败证据供对账使用。
              //
              // ★ 2026-10-11 修正：原实现这里先写一条 `ok:false`，紧接着又**无条件**
              //   写一条 `ok:true`，于是同一次调用在轨迹里既"失败"又"成功"，
              //   且 `successfulToolCalls++` 也照加 —— 完成声明对账看到的成功数
              //   被虚高，会提前触发「别再调工具了」的 nudge。现在语义失败
              //   只记一条（ok:false），且不计入成功数。
              const failure = extractToolFailure(toolName, rawResult);
              const semanticallyFailed = failure !== null && failure !== undefined;
              if (semanticallyFailed) {
                failedTools.push({ name: toolName, error: failure });
                process.stdout.write(
                  `[AgentModelExecutor] Tool "${toolName}" returned failure: ${failure}\n`,
                );
              }
              const emptyEvidence = extractEmptyResult(toolName, rawResult);
              if (emptyEvidence) {
                emptyResultTools.push(emptyEvidence);
                process.stdout.write(
                  `[AgentModelExecutor] Tool "${toolName}" returned EMPTY result (${emptyEvidence.field})\n`,
                );
              }
              // ── 记录真实工具调用，供 transcript 持久化 ──
              // 历史实现在持久化时硬编码成 [{name:"llm_tools",arguments:{}}]，
              // 导致会话恢复后模型完全看不到自己上一轮调用过什么、返回了什么，
              // 只能靠猜——这是「反复要求用户说『继续』」的直接成因之一。
              executedToolCalls.push({ id: tc.id, name: toolName, arguments: args });
              trace.addToolResult(toolName, toolResult, { round: round + 1, ok: !semanticallyFailed });
              if (semanticallyFailed) {
                process.stdout.write(`[AgentModelExecutor] Tool "${toolName}" finished with a failure result (not counted as success)\n`);
              } else {
                process.stdout.write(`[AgentModelExecutor] Tool "${toolName}" executed successfully\n`);
                successfulToolCalls++;
                // ── 后成功取代前失败（2026-10-14 评测修复）──
                // 同名工具本轮先失败后成功时，清掉早前的 failedTools 记录：
                // 对账以**最新状态**为准。否则模型重试成功后的诚实完成声明
                // 仍会被 failedTools.length > 0 判成"任务未完成"，追加过期否定。
                for (let i = failedTools.length - 1; i >= 0; i--) {
                  if (failedTools[i].name === toolName) failedTools.splice(i, 1);
                }
                // 只有搜索类工具**真的成功**了，后面才值得提示「别再搜了」
                if (SEARCH_TOOLS_HINT.has(toolName)) actualSearchExecuted = true;
                // ── 收集「产物文件」下载链（2026-10-12 P0 欠账修复）──
                // 此前 `createdFiles` 声明后无任何写入方，`TryCallLLMResult.files`
                // 恒为 []，前端「文件下载」区永远不出现。
                // 只识别明确的文件写入类工具；结果 shape 见 file-tools.ts
                // （errRecovery.executeWithRetry 剥掉 success 后透传 path/size/workspaceRelative）。
                // TTS 工具也收集——音频文件可作为附件发送。
                if ((toolName === "file_write" || toolName === "text_to_speech") && rawResult && typeof rawResult === "object") {
                  const r = rawResult as Record<string, unknown>;
                  const filePath =
                    (typeof r.path === "string" && r.path) ||
                    (typeof r.workspaceRelative === "string" && r.workspaceRelative) ||
                    (typeof args.path === "string" ? args.path : undefined);
                  const fileSize = typeof r.size === "number" ? r.size : 0;
                  if (filePath) {
                    // downloadUrl 走网关静态路由 /api/files/download/{path}（见 protocol-adapter）。
                    // 用 workspaceRelative / 入参 path（相对 workspace 根），与路由的
                    // 解析逻辑一致；绝对 path（沙箱外）不在该路由的边界内，仍保留 path 供 UI 展示。
                    const relativePath =
                      (typeof r.workspaceRelative === "string" && r.workspaceRelative) ||
                      (typeof args.path === "string" ? args.path : filePath);
                    const entry = {
                      path: filePath,
                      size: fileSize,
                      downloadUrl: relativePath
                        ? `/api/files/download/${relativePath.replace(/\\/g, "/")}`
                        : "",
                    };
                    // 同一文件被 create 后再次 modify，只保留一条（路径+大小更新）
                    const existing = createdFiles.find((f) => f.path === entry.path);
                    if (existing) {
                      existing.size = entry.size;
                      existing.downloadUrl = entry.downloadUrl || existing.downloadUrl;
                    } else {
                      createdFiles.push(entry);
                    }
                  }
                }
              }
              // ── 验证证据：编辑会让之前的验证作废（hermes mark_workspace_edited）──
              // 文件写类工具成功 = 世界状态已变，此前的验证覆盖不再可信，
              // 标记为失效；验证门后续会要求对这些路径定向复验。
              if (
                toolName === "file_write" &&
                rawResult && typeof rawResult === "object"
              ) {
                const r = rawResult as Record<string, unknown>;
                const editedPath =
                  (typeof r.path === "string" && r.path) ||
                  (typeof args.path === "string" ? args.path : undefined);
                if (editedPath) evidenceStore.markEdited([editedPath]);
              }
              anyToolExecuted = true;
              recordToolSuccess(toolName);
              // ── 验证证据：把「验证类命令的成功运行」记入账本 ──
              // 成功（exitCode===0）会清空编辑记录——与 hermes 语义一致：
              // 「全量通过的验证证明工作区没问题」，之后的编辑才需重验。
              const verifyKind = toolName === "shell_exec" || toolName === "execute_code"
                ? classifyVerificationCommand(
                    typeof (args as Record<string, unknown>).command === "string"
                      ? (args as Record<string, unknown>).command as string
                      : typeof (args as Record<string, unknown>).code === "string"
                        ? (args as Record<string, unknown>).code as string
                        : "",
                  )
                : null;
              if (verifyKind) {
                const exitCode =
                  rawResult && typeof rawResult === "object" && typeof (rawResult as Record<string, unknown>).exitCode === "number"
                    ? (rawResult as Record<string, unknown>).exitCode as number
                    : 0;
                evidenceStore.record(
                  createdFiles.map((f) => f.path),
                  `${toolName}:${verifyKind}`,
                  exitCode,
                );
              }
              // ── 进度反馈：工具完成时显示可读摘要 ──
              const doneSummary = formatToolResultSummary(toolName, args, toolResult);
              onProgress?.({ type: "tool_result", phase: "tool_calling", detail: doneSummary, progress: 55 + Math.floor((toolCalls.indexOf(tc) / toolCalls.length) * 20), toolName, toolResult: toolResult.slice(0, 200), toolError: false, round: round + 1, thinkingSteps: traceSnapshot(trace) });
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              const isTimeout = errMsg.includes("timed out");
              const isNotFound = errMsg.includes("not found") || errMsg.includes("404");
              const isAuth = errMsg.includes("401") || errMsg.includes("403") || errMsg.includes("auth");
              const isNetwork = errMsg.includes("ECONNREFUSED") || errMsg.includes("ENOTFOUND") || errMsg.includes("fetch failed");

              let suggestion = "";
              if (isTimeout) suggestion = "Suggestion: The operation timed out. Try a simpler query or use a different tool.";
              else if (isNotFound) suggestion = "Suggestion: The resource was not found. Verify the URL/path is correct.";
              else if (isAuth) suggestion = "Suggestion: Authentication failed. Try a public alternative.";
              else if (isNetwork) suggestion = "Suggestion: Network error. Try again later or use a different source.";
              else suggestion = "Suggestion: Try different parameters or use an alternative tool.";

              toolResult = JSON.stringify({ error: errMsg, suggestion, retried: isNetworkTool, toolName });
              toolErrored = true;
              toolError = errMsg;
              recordToolFailure(toolName);
              // ★ 2026-10-11：硬失败（抛异常）此前**既不进 failedTools 也不进轨迹**，
              //   导致轨迹里只有「决定调用 X」却没有任何结果（断裂），
              //   完成声明对账也漏掉这类失败（"失败被当成成功"的另一道缝）。
              failedTools.push({ name: toolName, error: errMsg });
              trace.addToolResult(toolName, toolResult, { round: round + 1, ok: false });
              // ★ 失败也是「执行过」：anyToolExecuted 用于兜底回复的静默停止
              // 显式说明——工具调用被真正发起过（即使失败），就不该用
              // 「所有模型都未能响应」糊弄用户。
              anyToolExecuted = true;
              process.stderr.write(`[AgentModelExecutor] Tool "${toolName}" failed:` + " " + errMsg + "\n");
              onProgress?.({ type: "tool_result", phase: "tool_calling", detail: `工具 ${toolName} 执行失败: ${toolError}`, progress: 55, toolName, toolResult: toolError, toolError: true, round: round + 1, thinkingSteps: traceSnapshot(trace) });
            }
          }

          // Plugin hook: after_tool_call
          if (deps.pluginManager?.hasHooks("after_tool_call")) {
            try {
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
            } catch (hookErr) {
              process.stderr.write(`[LLMCaller] after_tool_call hook failed for ${toolName}:` + " " + hookErr + "\n");
            }
          }

          // Record tool trace
          if (deps.recordToolTrace) {
            deps.recordToolTrace(sessionId, toolName, args, toolResult.slice(0, 500), !toolErrored, Date.now() - toolStartTime, toolError);
          }
          if (deps.recordStaleContext) {
            deps.recordStaleContext(sessionId, toolName);
          }

          // Observability: end tool span
          if (deps.observability && deps.currentTraceId && toolSpanId) {
            deps.observability.addSpanAttribute(deps.currentTraceId, toolSpanId, "tool.success", !toolErrored);
            deps.observability.endSpan(deps.currentTraceId, toolSpanId, toolErrored ? "error" : "ok");
          }

          // Update planning step status
          if (deps.updatePlanStep) {
            deps.updatePlanStep(sessionId, toolName, {
              status: toolErrored ? "failed" : "completed",
              result: toolResult.slice(0, 200),
              error: toolError,
            });
          }

          // Execution checkpoint
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

          // ── R1-3: 工具循环检测（借鉴 hermes-agent tool_guardrails.py） ──
          let toolLoopHalt = false;
          let toolLoopHaltMessage = "";
          let toolLoopHaltDetection = "";
          try {
            const loopResult = toolLoopDetector.check(toolName, args, !toolErrored, toolResult);
            if (loopResult.action === "halt") {
              process.stderr.write(`[AgentModelExecutor] Tool loop detected: ${loopResult.message}\n`);
              onProgress?.({
                type: "error",
                phase: "tool_calling",
                detail: loopResult.message,
                progress: 60,
                round: round + 1,
              });
              toolLoopHalt = true;
              toolLoopHaltMessage = loopResult.message;
              toolLoopHaltDetection = loopResult.detection;
            } else if (loopResult.action === "warn" && !toolLoopWarnedThisTurn) {
              toolLoopWarnedThisTurn = true;
              process.stderr.write(`[AgentModelExecutor] Tool loop warning: ${loopResult.message}\n`);
              onProgress?.({
                type: "status",
                phase: "tool_calling",
                detail: loopResult.message,
                progress: 55,
                round: round + 1,
              });
            }
          } catch (loopErr) {
            process.stderr.write(`[AgentModelExecutor] Tool loop detector error: ${loopErr instanceof Error ? loopErr.message : String(loopErr)}\n`);
          }

          // 工具循环阻断：通过标记跳出外部 for 循环
          if (toolLoopHalt) {
            process.stderr.write(`[AgentModelExecutor] Halting tool loop: ${toolLoopHaltMessage}\n`);
            toolLoopHaltFlag = true;
            toolLoopHaltMsg = toolLoopHaltMessage;
            toolLoopHaltDet = toolLoopHaltDetection;
          }

          toolCallCount++;

          // 注意：技能自动提取（considerExtraction）已移除。
          // 历史上每 15 次工具调用会触发 SkillCurator 自动生成低质量技能，
          // 导致 data/skills/ 堆积大量 evoclaw-curator 自动生成的无用技能。
          // 现在技能只能通过 WebUI 手动创建或显式 API 调用创建。

          // 体积上限：单个工具结果最多 TOOL_RESULT_MAX_CHARS 字符进入上下文。
          // 事故：email / list_inbox 单次 6920 字符、同一轮被重复调用 3 次，
          // 仅一个工具就吃掉约 20KB 上下文。
          //
          // ★ 2026-10-26 修复：sequential_thinking 工具结果不进入对话历史。
          //   该工具每次调用返回完整 JSON + 最近 5 条思考上下文（~1500 字符），
          //   一轮 13-15 次调用 = 20-22K 字符。这些思考痕迹被加入 conversationMessages
          //   后，下一轮 LLM 调用要处理全部历史，导致 token 爆炸（185K-285K/轮）、
          //   速度雪崩（12s→58s→141s），180s 超时内根本无法完成复杂任务。
          //   思考痕迹已通过 trace 持久化，模型自身也记得思考内容，无需重复携带。
          if (toolName === "sequential_thinking") {
            return { role: "tool", tool_call_id: tc.id, name: toolName, content: "思考步骤已记录。请继续或给出最终回复。" };
          }
          // ★ 2026-11-03 修复：file_read/code_search 使用 32K 上限，
          //   与上方 MAX_RESULT_LEN 保持一致。其他工具保持 4K 上限不变。
          const maxChars = (toolName === "file_read" || toolName === "code_search") ? 32_000 : TOOL_RESULT_MAX_CHARS;
          return { role: "tool", tool_call_id: tc.id, name: toolName, content: truncateToolResult(toolResult, maxChars) };
        };

        // ── Execute parallel-safe tools concurrently ──
        if (parallelCalls.length > 1) {
          process.stdout.write(`[AgentModelExecutor] Executing ${parallelCalls.length} tools in parallel: ${parallelCalls.map(tc => tc.function.name).join(", ")}\n`);
          const parallelResults = await Promise.allSettled(parallelCalls.map(tc => executeSingleToolCall(tc)));
          for (let i = 0; i < parallelResults.length; i++) {
            const result = parallelResults[i];
            const toolCall = parallelCalls[i];
            if (result.status === "fulfilled") {
              conversationMessages.push(result.value);
            } else {
              // 失败结果也以工具消息形式加入对话，避免 LLM 等待永远不会到来的工具结果导致卡死
              process.stderr.write(`[AgentModelExecutor] Parallel tool execution failed: ${result.reason}\n`);
              conversationMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                name: toolCall.function.name,
                content: JSON.stringify({
                  error: "Tool execution failed",
                  reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
                }),
              });
            }
          }
        } else if (parallelCalls.length === 1) {
          const result = await executeSingleToolCall(parallelCalls[0]);
          conversationMessages.push(result);
        }

        // ── Execute sequential tools one by one ──
        for (const tc of sequentialCalls) {
          // Reflection check before each sequential tool
          if (deps.checkAndReflect && toolCallCount > 0 && toolCallCount % 3 === 0) {
            try {
              const reflectionResult = await deps.checkAndReflect(sessionId);
              if (reflectionResult) {
                if (reflectionResult.shouldReplan) {
                  pendingTransient.push({
                    role: "system",
                    content: `[反思] ${reflectionResult.analysis}\n建议: ${reflectionResult.nextStepSuggestion || "重新规划任务"}`,
                  });
                } else if (reflectionResult.shouldRetry && reflectionResult.retrySuggestion) {
                  pendingTransient.push({
                    role: "system",
                    content: `[反思] ${reflectionResult.analysis}\n重试建议: ${reflectionResult.retrySuggestion}`,
                  });
                }
              }
            } catch (reflectErr) {
              process.stderr.write(`[LLMCaller] Reflection check failed: ${reflectErr}\n`);
            }
          }

          const result = await executeSingleToolCall(tc);
          conversationMessages.push(result);

          // R1-3: 工具循环阻断检查（sequential 执行后）
          if (toolLoopHaltFlag) {
            pendingTransient.push({
              role: "user",
              content: `[系统提示] 检测到工具调用循环（${toolLoopHaltDet}）。已停止工具调用。请基于已完成的工具执行结果，总结当前进展并给出回复。不要再调用相同的工具。`,
            });
            turnExitReason = "guardrail_halt";
            break;
          }
        }

        // R1-3: 工具循环阻断检查（parallel 执行后）
        if (toolLoopHaltFlag && sequentialCalls.length === 0) {
          pendingTransient.push({
            role: "user",
            content: `[系统提示] 检测到工具调用循环（${toolLoopHaltDet}）。已停止工具调用。请基于已完成的工具执行结果，总结当前进展并给出回复。不要再调用相同的工具。`,
          });
          turnExitReason = "guardrail_halt";
          break;
        }

        // ── 调查循环检测器（2026-11-04）──
        // 连续 ≥3 轮只读工具 + 用户意图含「实现/修复/写代码/修改」→ 注入 transient nudge
        if (roundToolNames.length > 0) {
          const usedEditTool = roundToolNames.some((n) => EDIT_TOOLS.has(n));
          if (usedEditTool) {
            consecutiveReadOnlyRounds = 0;
          } else {
            consecutiveReadOnlyRounds++;
          }
          if (consecutiveReadOnlyRounds >= 3) {
            // 检查用户消息是否含实现/修复意图
            const userMsg = String(message || "");
            const implIntent = /实现|修复|写代码|修改|编辑|implement|fix|edit|write.*code|apply.*patch/i.test(userMsg);
            if (implIntent && consecutiveReadOnlyRounds === 3) {
              process.stdout.write(
                `[AgentModelExecutor] Investigation loop detected (${consecutiveReadOnlyRounds} consecutive read-only rounds) — nudging model to start editing\n`,
              );
              pendingTransient.push({
                role: "user",
                content: "[系统提示] 你已连续多轮只做只读调查（读文件/grep/搜索），但尚未实际修改任何代码。请立即使用 file_write / apply_patch 等编辑工具对目标文件做出实际改动。如果已经调查充分，就直接动手实现，不要再继续读文件了。",
              });
              consecutiveReadOnlyRounds = 0; // 重置，避免重复 nudge
            }
          }
        }

        // ── IterationBudget: execute_code 退款 ──
        // 本轮所有工具调用均为 execute_code 类（执行而非决策）时退还迭代。
        // 退款机此前为死代码（仅定义+测试），现接入活路径。
        if (budget && roundToolNames.length > 0) {
          try {
            const refunded = await budget.refundForExecuteCode(roundToolNames);
            if (refunded > 0) {
              process.stdout.write(
                `[AgentModelExecutor] Execute-code refund: returned ${refunded} iteration(s) for round ${round + 1} (all ${roundToolNames.length} tools were execute_code-type)\n`,
              );
            }
          } catch { /* best-effort — refund must never break the loop */ }
        }

        // ── fix-3: 工具执行增量持久化（防止崩溃丢失进度） ──
        // 在每个工具执行轮次后将 assistant 消息（含 tool_calls）和工具响应
        // 追加到 session JSONL 文件。即使进程崩溃，JSONL 文件保留了完整的执行状态，
        // 可用于后续恢复或审计。借鉴 hermes-agent 的增量 session 持久化。
        if (round > 0 || toolCallCount > 0) {
          const sessionPDeps2 = getSessionPersistenceDeps(deps);
          // 持久化 assistant 消息（含 tool_calls）
          const assistantToolCalls = assistantMsg.tool_calls as Array<{ id: string; type: string; function: { name: string; arguments: string } }> | undefined;
          if (assistantToolCalls && assistantToolCalls.length > 0) {
            const assistantContent = typeof assistantMsg.content === "string" ? assistantMsg.content : null;
            persistToolCheckpointFn(sessionPDeps2, sessionId, "assistant", assistantContent, {
              tool_calls: assistantToolCalls,
              round,
              tokensUsed: totalTokensUsed,
            });
            // 持久化每个工具响应（回溯到本轮 assistant 消息之后的 tool 消息）
            for (let i = conversationMessages.length - 1; i >= 0; i--) {
              const msg = conversationMessages[i];
              if (msg.role === "tool" && msg.tool_call_id) {
                const toolContent = typeof msg.content === "string"
                  ? msg.content
                  : (msg.content ? JSON.stringify(msg.content) : "");
                persistToolCheckpointFn(sessionPDeps2, sessionId, "tool", toolContent, {
                  tool_call_id: msg.tool_call_id,
                  name: msg.name,
                  round,
                });
              } else if (msg.role === "assistant") {
                break; // 遇到 assistant 消息，停止回溯
              }
            }
          }
        }

        // ── Fallback: auto-execute installed skill when LLM used web_search instead ──
        // When the LLM chose web_search over an installed skill, and the user intent
        // matches an installed skill, we auto-execute the skill's script and store
        // the result to append to the final reply later.
        if (searchWasDone && !usedCiccSkill && deps.registeredTools.has("skill_list")) {
          try {
            const classifier = deps.semanticIntentClassifier;
            let shouldAutoExecute = false;
            if (classifier) {
              const intent = await classifier.classifyIntent(message);
              process.stdout.write(`[AgentModelExecutor] Skill fallback intent: category=${intent?.category} score=${intent?.score}\n`);
              if (intent && intent.category === "action_task" && intent.score > 0.6) {
                shouldAutoExecute = true;
              }
            } else {
              process.stdout.write(`[AgentModelExecutor] Skill fallback: no semantic classifier available\n`);
            }
            if (shouldAutoExecute) {
              const searchTool = deps.registeredTools.get("skill_list")!;
              const searchResult = await searchTool.handler({ action: "search", task: message });
              process.stdout.write(`[AgentModelExecutor] Skill fallback search result:` + " " + JSON.stringify(searchResult).slice(0, 500) + "\n");
              const searchObj = typeof searchResult === "object" ? searchResult as Record<string, unknown> : null;
              if (searchObj?.installed && searchObj.commands && Array.isArray(searchObj.commands)) {
                const commands = searchObj.commands as string[];
                const skillDir = searchObj.installPath
                  ? String(searchObj.installPath).replace(/SKILL\.md$/i, "").replace(/[/\\]$/, "")
                  : "";
                // Execute the first relevant command
                const cmd = commands[0];
                if (cmd && skillDir) {
                  const resolvedCmd = cmd.replace(/\{baseDir\}/g, () => skillDir);
                  process.stdout.write(`[AgentModelExecutor] Auto-executing installed skill command: ${resolvedCmd}\n`);
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
                      process.stderr.write(`[AgentModelExecutor] Auto skill execution failed: ${err}\n`);
                    }
                  }
                }
              }
            }
          } catch (err) { process.stderr.write(`[AgentModelExecutor] Skill fallback error:` + " " + err + "\n"); /* best-effort */ }
        }

        if (!finalReply && round === maxToolRounds - 1) {
          try {
            const summaryMessages = [
              ...conversationMessages,
              { role: "user" as const, content: "请根据以上工具执行结果，总结回答用户的问题。" as string | null },
            ];
            // ★ 末轮总结同上：先占一个新轮次再调用，避免总结内容被写进
            //   既有气泡（roundIndex 固定为 1）而覆盖用户已看到的回复。
            trace.nextRound();
            const summaryResult = await callLLMOnce(provider, summaryMessages, [], "auto", onProgress, deps, trace, includeAccumulatedReplyInTokenEvents);
            if (summaryResult && summaryResult.message?.content) {
              finalReply = summaryResult.message.content;
              totalTokensUsed += summaryResult.tokensUsed;
              // Record token usage for summary call
              if (deps.tokenUsageTracker) {
                try {
                  const outputTokens = Math.max(0, summaryResult.tokensUsed - summaryResult.promptTokens);
                  deps.tokenUsageTracker.record({
                    sessionId,
                    provider: provider.provider || provider.name,
                    model: provider.model || "unknown",
                    inputTokens: summaryResult.promptTokens,
                    outputTokens,
                    durationMs: summaryResult.responseMs,
                    channel: channel || "unknown",
                    ...cacheExtrasFromResult(summaryResult, provider.provider || provider.name),
                  });
                } catch { /* best-effort */ }
              }
            } else {
              finalReply = "工具已执行完毕，但未能生成总结回复。替代方案：① 请重新提问，我会尝试不同的方式回答；② 提供更多上下文信息帮助我理解您的需求。";
            }
          } catch {
            finalReply = "工具已执行完毕，但未能生成总结回复。";
          }
        }
      }

      // 自动续跑兜底：若续跑后模型产不出新回复，恢复续跑前的内容，
      // 以免返回空回复（其后的完成声明对账仍会追加更正说明）。
      // 优先级：pendingVerificationReply（验证门暂存）> lastReplyBackup（续跑备份）
      if (!finalReply && pendingVerificationReply) {
        finalReply = pendingVerificationReply;
        process.stdout.write(`[AgentModelExecutor] No new reply after verification gate; using pending verification reply for session "${sessionId}"\n`);
      } else if (!finalReply && lastReplyBackup) {
        finalReply = lastReplyBackup;
        process.stdout.write(`[AgentModelExecutor] Auto-continue produced no new reply; restored previous reply for session "${sessionId}"\n`);
      }

      if (finalReply) {
        // ★ force=true：任务结束时必须下发完整轨迹 —— 这是"完成后还能展开看"的最后一道保障
        onProgress?.({ type: "done", phase: "done", detail: `任务完成（${successfulToolCalls} 次工具调用）`, progress: 100, thinkingSteps: traceSnapshot(trace, { force: true }) });
        // Append skill fallback result if available
        if (skillFallbackResult) {
          finalReply += skillFallbackResult;
        }

        // ── 剥离泄漏的原始 tool_call XML（先于对账/核验执行）──
        // ★ 2026-10-28 顺序修复（v4 复测 Task 7 事故）：本块原先位于「完成声明
        //   对账 + 磁盘文件核验」**之后**。当模型在末轮（tool_choice:none）仍把
        //   工具调用以裸 XML 写进正文时：对账/核验跑在 XML 垃圾文本上（提取不到
        //   任何声称路径 → 零更正），随后 XML 剥离把回复清空 → 触发兜底总结调用
        //   （tools:[]，即日志里那次 tools:0 调用）→ 用新总结**替换** finalReply。
        //   结果：最终回复声称「三个文件都放在 /tmp/v4-monitor/ 下了」但核验从未
        //   在这份回复上跑过，缺失文件（.service/notify.sh）无人发现。
        //   修复：文本清洗（剥离 XML）必须先于一切「读回复文本」的分析——对账与
        //   磁盘核验都应作用在**用户最终看到**的那份回复上。
        // 事故（2026-10-07 15:3x）：模型在最后一轮把工具调用以**裸 XML**
        // 写进正文发给用户（XML 工具调用标记），用户看到的是一堆积木而不是回复。
        // 成因是模型模仿了 prompt 里的 XML 工具调用格式，而本轮又没有真正执行它。
        if (finalReply) {
          const beforeStrip = finalReply;
          finalReply = finalReply
            .replace(/<\u200b?tool_call>[\s\S]*?<\/\u200b?tool_call>/gi, "")
            .replace(/<\u200b?function=[^>]*>[\s\S]*?<\/\u200b?function>/gi, "")
            .replace(/<\u200b?parameter\s+name=[^>]*>[\s\S]*?<\/\u200b?parameter>/gi, "")
            .replace(/<\u200b?invoke\s+name=[^>]*>[\s\S]*?<\/\u200b?invoke>/gi, "");
          if (finalReply.trim().length === 0 && beforeStrip.trim().length > 0) {
            // 整条回复只有裸 XML（模型没写出任何自然语言）。
            // 2026-10-14 评测修复：此前直接丢生硬兜底文案（10 任务中 2 次命中，
            // 用户拿不到任何任务总结）。现在先补一次无工具的强制总结调用，
            // 成功则用真实总结，失败才降级为兜底文案。
            let recovered = "";
            if (successfulToolCalls > 0) {
              try {
                trace?.nextRound();
                const summaryResult = await callLLMOnce(
                  provider,
                  [
                    ...conversationMessages,
                    {
                      role: "user" as const,
                      content:
                        "请根据以上工具执行结果，用自然语言总结回答用户的问题（直接输出总结，不要调用工具）。" as string,
                    },
                  ],
                  [],
                  "auto",
                  onProgress,
                  deps,
                  trace,
                  includeAccumulatedReplyInTokenEvents
                );
                if (summaryResult?.message?.content && String(summaryResult.message.content).trim()) {
                  recovered = String(summaryResult.message.content);
                  totalTokensUsed += summaryResult.tokensUsed;
                  if (deps.tokenUsageTracker) {
                    try {
                      const outputTokens = Math.max(0, summaryResult.tokensUsed - summaryResult.promptTokens);
                      deps.tokenUsageTracker.record({
                        sessionId,
                        provider: provider.provider || provider.name,
                        model: provider.model || "unknown",
                        inputTokens: summaryResult.promptTokens,
                        outputTokens,
                        durationMs: summaryResult.responseMs,
                        channel: channel || "unknown",
                        ...cacheExtrasFromResult(summaryResult, provider.provider || provider.name),
                      });
                    } catch { /* best-effort */ }
                  }
                }
              } catch (sumErr) {
                process.stderr.write(
                  `[AgentModelExecutor] XML-only reply summary failed: ${sumErr instanceof Error ? sumErr.message : String(sumErr)}\n`
                );
              }
            }
            finalReply =
              recovered.trim() ||
              "（本轮模型只输出了工具调用标记，没有给出文字回复。已停止执行；" +
                "如需继续，请明确说明下一步要做什么。）";
          }
        }

        // ── 完成声明真实性对账 ──
        // 防止「声称已完成但实际未执行」的伪造完成态：把模型的完成声明
        // 与「本回合真实工具执行情况 + 仍未决的审批操作」比对，
        // 一旦发现不可信的完成声明，确定性地追加一段更正说明。
        // 详见 completion-truthfulness.ts。
        try {
          const verdict = reconcileCompletionTruthfulness({
            finalReply,
            pendingPermissions,
            toolsExecuted: anyToolExecuted,
            lastUserMessage: message,
            failedTools,
            emptyResultTools,
            writeOps: writeOps(),
            executedShellCommands: extractExecutedShellCommands(executedToolCalls),
          });
          if (verdict.needsCorrection && verdict.notice) {
            // ★ 修复（2026-10-08，用户反馈）：这段 notice 是写给 **LLM 看的续跑指令**
            //（"请修复上述失败后重新执行；在拿到工具的成功返回之前，请勿认为操作已经完成"），
            // 属于内部提示词，**绝不能**拼进给用户看的正文。
            // 事故实录：20:24 那轮回复末尾直接暴露了
            //   "⚠️ 更正：上面的「已完成」并不成立……请修复上述失败后重新执行"
            // 用户看到的是一段本该给模型自己看的纠错指令。
            // 现在只记入轨迹（可追溯），正文保持干净；
            // 若确实需要告知用户，用下面这句人话版摘要。
            finalReply += buildUserFacingCorrection(verdict);
            process.stderr.write(
              `[AgentModelExecutor] Completion-claim reconciliation triggered (${verdict.reason}) for session "${sessionId}"\n`
            );
            // 同时把完整内部指令入轨迹，保留可追溯性而不污染 UI
            trace?.addSystem?.(
              `完成声明对账触发（${verdict.reason}）`,
              verdict.notice
            );
          }
        } catch (reconcileErr) {
          // 对账失败不得阻断主流程
          process.stderr.write(
            `[AgentModelExecutor] Completion-claim reconciliation skipped: ${reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr)}\n`
          );
        }

        // ── 磁盘文件核验 ──
        // ★ 2026-10-27 新增：完成声明对账只检查"是否调用了写工具"，
        //   但不验证声称创建的文件是否真的存在于磁盘上。
        //   实测 Task 1（声称创建 cli.py/__init__.py 等文件但实际不存在）
        //   和 Task 10（声称 shell 写入报告但文件不存在）都未被捕获。
        //   此步骤从回复中提取被声称创建/写入的文件路径，逐一验证磁盘存在性。
        try {
          const claimedPaths = extractClaimedFilePaths(finalReply, deps.workspacePath);
          if (claimedPaths.length > 0) {
            const missingPaths: string[] = [];
            for (const p of claimedPaths) {
              try {
                if (!fs.existsSync(p)) missingPaths.push(p);
              } catch {
                missingPaths.push(p);
              }
            }
            if (missingPaths.length > 0) {
              const correction =
                "\n\n---\n\n**⚠️ 任务未完成**：回复中声称已创建/写入的文件在磁盘上不存在：\n" +
                missingPaths.map((p) => `- \`${p}\``).join("\n") +
                "\n\n请以实际执行结果为准，以上文件可能未被成功写入。";
              finalReply += correction;
              process.stderr.write(
                `[AgentModelExecutor] Disk verification found ${missingPaths.length} missing claimed file(s) for session "${sessionId}"\n`
              );
              trace?.addSystem?.(
                `磁盘文件核验：${missingPaths.length} 个声称文件不存在`,
                missingPaths.join("\n")
              );
            }
          }
        } catch (diskErr) {
          process.stderr.write(
            `[AgentModelExecutor] Disk verification skipped: ${diskErr instanceof Error ? diskErr.message : String(diskErr)}\n`
          );
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

        // ── R2-2: 输出安全过滤（借鉴 hermes-agent redact.py + ansi_strip.py） ──
        // 1. redactSensitiveText：剥离可能泄漏到响应的 API key / Bearer token / 密码
        // 2. stripAnsi：剥离 shell 工具结果中的 ANSI 颜色码（防止污染响应）
        if (finalReply) {
          try {
            const { redactSensitiveText, stripAnsi } = await import("@evoclaw/security");
            finalReply = redactSensitiveText(finalReply).redacted;
            finalReply = stripAnsi(finalReply);
          } catch (importErr) {
            // 安全包不可用时不阻断主流程
            process.stderr.write(`[AgentModelExecutor] Output security filter skipped: ${importErr instanceof Error ? importErr.message : String(importErr)}\n`);
          }
        }

        // ── Turn-end activity stamp（对标 Hermes TurnLivenessWatchdog.stop）──
        // turn 结束时调用 touch 保持活跃，防止后续 watchdog 误判为卡死。
        try {
          getTurnLivenessWatchdog().touch(sessionId);
        } catch { /* best-effort */ }

        // ── Turn Finalizer：终末安全网（对标 hermes-agent turn_finalizer.py）──
        // 在回复组装完毕后、持久化前运行。五个结构机制：
        //   1. 静默停止检测：turn 以工具结果结尾、无后续 assistant 文本时，合成状态摘要
        //   2. 碎片终止守卫：turn 做了工具工作后以碎片结束时，追加状态块
        //   3. 完成状态强制：回复不含完成状态标记时，追加结构状态块
        //   4. 文件变更 Footer：写文件失败时追加验证者 footer（对标 Hermes _append_file_mutation_footer）
        //   5. 异常退出说明：异常退出时追加原因解释（对标 Hermes _explain_abnormal_exit）
        // 这是确定性后处理（不调 LLM），不是提示词 nudge——模型无法忽略。
        // 对标 sess_mw23sp1y_e557da27 场景：模型做完只读调查后戛然而止，无完成状态汇报。
        try {
          // 从工具执行记录构建统计
          // 构建 failedFileMutations：从 failedTools 中筛选写文件类工具，提取路径
          const FILE_MUTATING_TOOLS = new Set(["file_write", "file_delete"]);
          const failedFileMutations: Array<{ path: string; error: string }> = [];
          for (const ft of failedTools) {
            if (!FILE_MUTATING_TOOLS.has(ft.name)) continue;
            // 从 executedToolCalls 中查找对应的 args 以提取路径
            const entry = executedToolCalls.find((c) => c.name === ft.name);
            let path = "";
            if (entry) {
              const args = entry.arguments as Record<string, unknown>;
              path = String(args?.path ?? args?.filePath ?? args?.file_path ?? "");
            }
            if (path) {
              failedFileMutations.push({ path, error: ft.error });
            }
          }
          const toolStats: ToolExecutionStats = {
            successful: successfulToolCalls,
            failed: failedTools.length,
            createdFiles: createdFiles.map((f) => f.path),
            modifiedFiles: writeOps()
              .filter((w) => w.name !== "shell_exec")
              .map((w) => {
                // 从 write op 的 args 中提取路径
                try {
                  const args = JSON.parse(w.args) as Record<string, unknown>;
                  return String(args.path ?? args.filePath ?? args.file_path ?? "");
                } catch {
                  return "";
                }
              })
              .filter((p) => p.length > 0),
            executedCommands: extractExecutedShellCommands(executedToolCalls),
            failedFileMutations: failedFileMutations.length > 0 ? failedFileMutations : undefined,
          };
          const liteMessages: Array<ConversationMessageLite> = conversationMessages.map((m) => ({
            role: m.role,
            content: m.content as string | null | undefined,
            tool_calls: m.tool_calls as unknown,
            tool_call_id: m.tool_call_id,
            name: m.name,
          }));
          const finalizerResult = runTurnFinalizer(finalReply, liteMessages, toolStats, 0, turnExitReason);
          if (finalizerResult.silentStopSynthesized) {
            process.stdout.write(
              `[AgentModelExecutor] Turn finalizer: silent stop synthesized status summary for session "${sessionId}"\n`,
            );
          }
          if (finalizerResult.completionStatusAppended) {
            process.stdout.write(
              `[AgentModelExecutor] Turn finalizer: completion status block appended for session "${sessionId}"\n`,
            );
          }
          if (finalizerResult.fileMutationFooterAppended) {
            process.stdout.write(
              `[AgentModelExecutor] Turn finalizer: file mutation footer appended (${toolStats.failedFileMutations?.length ?? 0} failed mutations) for session "${sessionId}"\n`,
            );
          }
          if (finalizerResult.abnormalExitExplained) {
            process.stdout.write(
              `[AgentModelExecutor] Turn finalizer: abnormal exit explanation appended (reason=${turnExitReason}) for session "${sessionId}"\n`,
            );
          }
          if (finalizerResult.degenerateFinalDetected) {
            // 碎片终止：在回复末尾追加结构状态块（one-shot，不续跑）
            // 对标 Hermes degenerate-final guard 的简化版——
            // 在 turn 末尾无法续跑，故追加状态块而非注入 nudge
            finalReply = finalizerResult.finalReply;
            process.stdout.write(
              `[AgentModelExecutor] Turn finalizer: degenerate final detected — appended status block for session "${sessionId}"\n`,
            );
          } else {
            finalReply = finalizerResult.finalReply;
          }
        } catch (finalizerErr) {
          // 终末安全网失败不得阻断主流程
          process.stderr.write(
            `[AgentModelExecutor] Turn finalizer skipped: ${finalizerErr instanceof Error ? finalizerErr.message : String(finalizerErr)}\n`,
          );
        }

        if (deps.sessionManager) {
          try {
            const agentId = "default";
            deps.sessionManager.getOrCreateSession(agentId, sessionId);
            process.stdout.write(`[AgentModelExecutor] Persisting thinking trace: ${trace.size} step(s), round=${trace.round}, provider=${provider.name}, replyChars=${finalReply.length}\n`);
            deps.sessionManager.appendTurn(agentId, sessionId, {
              turnIndex: 0, role: "assistant", content: finalReply, timestamp: new Date().toISOString(),
              // 持久化真实工具调用（历史实现是 llm_tools 占位符，导致会话恢复后
              // 模型看不到上一轮做过什么）。参数与结果均经脱敏。
              toolCalls: executedToolCalls.length > 0
                ? executedToolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }))
                : undefined,
              // ★ 思考轨迹一并落盘。用户诉求：任务完成后思考过程要完整保留、
              //   可折叠展开 —— 不落盘就等于没有（历史根因：transcript 只有
              //   role/content/toolCalls，没有任何思考字段）。
              thinkingTrace: trace.toJSON(),
              thinkingSummary: trace.summary(30),
            });
          } catch (err) {
            process.stderr.write(`[AgentModelExecutor] SessionManager persist failed: ${err}\n`);
          }
        }
        // ── 收尾清理（hermes turn_finalizer「回复优先 guarded cleanup」）──
        // 清理步骤一律独立 try/catch：**回复已组装完毕**，任何一步清理失败
        // 都不得丢掉已算好的 finalReply。错误只记日志，不抛给调用方。
        try {
          persistSessionTurnFn(getSessionPersistenceDeps(deps), sessionId, "assistant", finalReply, { tokensUsed: totalTokensUsed });
        } catch (persistErr) {
          process.stderr.write(`[AgentModelExecutor] Session persistence failed: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}\n`);
        }

        // ★ P0-9 缓存稳定化：history 存**原始**用户消息，而非增强消息。
        // 旧实现存 `message`（= finalEnhancedMessage，含搜索/新闻注入的 URL 优先级
        // 提示等）→ 内存 history 与 transcript（存原始消息，agent-model-executor.ts:2021）
        // 字节不一致 → 下轮从 transcript 重建后，同位置字节不同 → 请求前缀不连续 →
        // 用户消息边界处缓存断裂。存原始消息后，内存与 transcript 逐字节一致，
        // 前缀跨轮连续。
        const cleanHistory: SessionHistoryEntry[] = [
          { role: "user", content: rawUserMessage ?? message },
          { role: "assistant", content: finalReply },
        ];
        // ★ P0-5：末尾必须重新读取 conversationHistory。本轮剪枝写回（见上方
        // pruning write-back）已把 Map 替换为剪枝后的数组；若沿用 provider 循环
        // 开头捕获的局部 history，这里的新数组会把它覆盖回去，剪枝永不生效，
        // history 前缀逐轮漂移 → 缓存命中率修复形同虚设。
        const latestHistory = deps.conversationHistory.get(sessionId) || history;
        const newHistory = [...latestHistory, ...cleanHistory];
        // ★ P0-1（2026-10-16 缓存命中改造）：此 splice 是最后的前缀保护性截断。
        // 历史教训：每轮按 maxHistoryLength(20) 静默删最老消息 → 整个 LLM 请求
        // 前缀原点逐轮漂移，多轮会话永久失去 prompt-cache 命中。现上限已提高
        // （见 AgentModelExecutor.maxHistoryLength），CompactionManager（100k
        // tokens 阈值）在实践中先触发，正常轮次不再发生结构性改写。
        if (newHistory.length > deps.maxHistoryLength) {
          newHistory.splice(0, newHistory.length - deps.maxHistoryLength);
        }
        deps.conversationHistory.set(sessionId, newHistory);

        const ledgerEnd = deps.getEventLedger();
        if (ledgerEnd) {
          ledgerEnd.append("session_end", { toolsExecuted: anyToolExecuted, totalTokens: totalTokensUsed, durationMs: Date.now() - startTime }, { agentId: "default", sessionId });
        }

        // ── Execution checkpoint: mark completed ──
        // 清理步骤：失败不得丢掉已组装好的 finalReply（hermes 回复优先语义）
        if (checkpointStore) {
          try {
            checkpointStore.completeExecution(sessionId, finalReply);
          } catch (cpErr) {
            process.stderr.write(`[AgentModelExecutor] Checkpoint complete failed: ${cpErr instanceof Error ? cpErr.message : String(cpErr)}\n`);
          }
        }

        // ── 上下文占用（分子）──
        // 优先用最后一次 LLM 调用真实上报的 prompt_tokens（最精确）。
        // 旧实现在 lastPromptTokens 为 0 时回退到 totalTokensUsed，但那是
        // **本轮所有调用的 token 总和**（含每次请求重复携带的 system prompt），
        // 会把上下文占用严重高估——这正是用户感觉"精度不高"的原因。
        // 现在改为：真实上报优先；否则对最终消息数组做本地估算，并显式
        // 标记 contextTokensEstimated，让前端能如实标注"估算"。
        let contextTokens = lastPromptTokens;
        let contextTokensEstimated = false;
        if (!(contextTokens > 0)) {
          try {
            contextTokens = estimateMessagesTokensCached(
              messages.map((m) => ({ role: String(m.role), content: m.content == null ? null : String(m.content) }))
            );
            contextTokensEstimated = contextTokens > 0;
          } catch { /* 估算不可用时保持 0 */ }
        }

        // ── 上下文窗口（分母）──
        // 由 model-context-window 统一解析：用户设置 > provider 报告 >
        // 内置模型库 > provider 兜底。绝不再硬编码 128k。
        const contextWindow = resolveContextWindow({
          model: provider.model,
          provider: provider.provider || provider.name,
        });

        return {
          reply: finalReply,
          tokensUsed: totalTokensUsed,
          contextTokens,
          contextTokensEstimated,
          contextLimit: contextWindow.limit,
          contextLimitSource: contextWindow.source,
          duration: Date.now() - startTime,
          permissionRequests: pendingPermissions.length > 0 ? pendingPermissions : [],
          toolsExecuted: anyToolExecuted,
          files: createdFiles,
          // ★ 最终轨迹（此处取值，含完成声明对账等在流式 done 之后写入的条目）
          thinkingTrace: trace.isEmpty ? undefined : trace.toJSON(),
        };
      }

      // ── 本 provider 没产出正文：**轨迹仍要交付**（2026-10-11）──
      // 用户诉求是"任务完成后能看到完整思考过程"，失败/空回复同样是"完成"。
      // 原实现直接 continue 到下一个 provider，若随后全部失败，用户既收不到
      // done、也看不到任何轨迹（thinkingTrace 只在最终的 `if (finalReply)` 里落盘）。
      // 这里先把已采集的轨迹存下来，兜底返回时一并交给前端。
      if (!trace.isEmpty) {
        lastTraceSnapshot = trace.toJSON();
        onProgress?.({ type: "done", phase: "done", detail: `本轮未产出回复（${successfulToolCalls} 次工具调用）`, progress: 100, thinkingSteps: traceSnapshot(trace, { force: true }) });
      }
      process.stderr.write(`[AgentModelExecutor] LLM provider "${provider.name}" returned empty response (model: ${provider.model})\n`);
    } catch (err: unknown) {
      // ── Execution checkpoint: mark failed ──
      if (checkpointStore) {
        checkpointStore.failExecution(sessionId, err instanceof Error ? err.message : String(err));
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        process.stderr.write(`[AgentModelExecutor] LLM provider "${provider.name}" (model: ${provider.model}) timed out after ${provider.timeout || 60000}ms\n`);
      } else if (err instanceof Error) {
        process.stderr.write(`[AgentModelExecutor] LLM provider "${provider.name}" (model: ${provider.model}) error: ${err.message}\n`);
        process.stderr.write(`[AgentModelExecutor] Error stack: ${err.stack?.slice(0, 500)}\n`);
      } else {
        process.stderr.write(`[AgentModelExecutor] LLM provider "${provider.name}" (model: ${provider.model}) unknown error: ${String(err)}\n`);
      }
    }
    // ── 跨 provider 累计：本轮执行了多少工具、失败了哪些 ──
    // 放在 try/catch **之外**：无论 provider 循环正常结束还是抛异常，
    // 都要把本轮的工具统计累加到外层，供兜底回复如实说明。
    totalSuccessfulToolCalls += successfulToolCalls;
    totalFailedTools.push(...failedTools);
  }

  // ── 兜底回复：终态失败盖码 + 人话文案（hermes turn_failure_copy 语义）──
  // 边界二分（hermes failed_turn_notice 不变式）：
  //   - 跑过工具 → PARTIAL_FAILED_TURN_NOTICE（可能有副作用已生效，重发前先验证）
  //   - 什么都没跑 → FAILED_TURN_NOTICE（未处理，重发即可）
  // 主体：有具体错误证据时按 reason 给 cause + 下一步指引（替代通用三条）；
  //      没有证据（provider 静默跳过等）才退回通用文案。
  const fallbackCopy = terminalFailureCopy(
    lastFailureEvidence ?? {
      reason: null,
      label: expandedProviders[0] ? expandedProviders[0].name : "模型服务",
      attempts: expandedProviders.length,
      retryable: true,
    },
    {
      partial: anyToolExecuted,
      toolStats: {
        executed: totalSuccessfulToolCalls,
        failed: totalFailedTools,
      },
    },
  );
  const fallbackResult: TryCallLLMResult = {
    reply: fallbackCopy,
    tokensUsed: 0,
    contextTokens: 0,
    duration: Date.now() - startTime,
    permissionRequests: pendingPermissions,
    toolsExecuted: anyToolExecuted,
    files: createdFiles,
    // 全部 provider 失败时，把最后一次尝试留下的轨迹交付前端 ——
    // 否则用户只看到"所有模型都未能响应"，看不到之前每个模型都做了什么。
    thinkingTrace: lastTraceSnapshot,
  };
  // ★ 终态盖码不变式（hermes stamp_failure）：终态失败结果必带
  //   failure_reason + failure_retryable，否则下游只能显示 unknown。
  if (lastFailureEvidence?.reason) {
    stampFailure(fallbackResult, lastFailureEvidence.reason, lastFailureEvidence.retryable);
  } else {
    stampFailure(fallbackResult, "unclassified", true);
  }
  process.stderr.write(`[AgentModelExecutor] All ${expandedProviders.length} model entry(s) across ${providers.length} provider(s) failed for session "${sessionId}". Provider details: ${expandedProviders.map(p => `${p.name}(${p.provider}/${p.model}, baseURL=${p.baseURL?.slice(0, 50)}, timeout=${p.timeout}ms)`).join("; ")}. Returning fallback message.\n`);
  return fallbackResult;
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
