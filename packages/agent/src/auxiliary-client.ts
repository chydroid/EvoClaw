/**
 * Auxiliary-client — 统一 side-task LLM 回退链。
 *
 * 对标 Hermes `agent/auxiliary_client.py`：
 *   单一解析链让所有 side task（上下文压缩、会话搜索、web 抽取、vision 分析、
 *   标题生成）共用同一回退链：主 provider → OpenRouter → 自定义 endpoint →
 *   原生 Anthropic → 直连 API-key 供应商。
 *
 * HTTP 402 / 积分耗尽 → 自动重试下一供应商。
 *
 * 配置：`auxiliary.<task>.{provider,model}` 覆盖自动解析。
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ── 类型定义 ────────────────────────────────────────────────

export type AuxTask =
  | "compression"
  | "session_search"
  | "web_extract"
  | "vision"
  | "title_generation"
  | "background_review"
  | "generic";

export type ProviderKind =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "nous_portal"
  | "custom_endpoint"
  | "zai"
  | "kimi"
  | "minimax"
  | "minimax_cn"
  | "codex"
  | "unknown";

/** 解析后的供应商 runtime */
export interface AuxRuntime {
  provider: ProviderKind;
  model: string | null;
  apiKey: string | null;
  baseUrl: string | null;
  /** 来源：main / openrouter / nous / custom / anthropic / direct / override */
  source: string;
  /** 是否支持 vision */
  visionCapable: boolean;
}

/** side-task LLM 调用请求 */
export interface AuxCallRequest {
  task: AuxTask;
  messages: Array<{ role: string; content: string | unknown }>;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /** 强制使用 vision-capable 供应商 */
  requireVision?: boolean;
  /** 覆盖自动解析的 provider/model */
  overrideProvider?: string;
  overrideModel?: string;
}

/** side-task LLM 调用结果 */
export interface AuxCallResult {
  content: string;
  model: string;
  provider: ProviderKind;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** 实际使用的 runtime（回退后可能与请求不同） */
  runtime: AuxRuntime;
}

/** side-task LLM 调用函数签名 */
export type AuxChatFn = (runtime: AuxRuntime, req: AuxCallRequest) => Promise<AuxCallResult>;

// ── 供应商环境变量解析 ─────────────────────────────────────

interface EnvProvider {
  kind: ProviderKind;
  envKey: string;
  baseUrl: string | null;
  visionCapable: boolean;
}

const ENV_PROVIDERS: ReadonlyArray<EnvProvider> = [
  { kind: "openrouter", envKey: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api/v1", visionCapable: true },
  { kind: "zai", envKey: "ZAI_API_KEY", baseUrl: "https://api.z.ai/api/paas/v4", visionCapable: true },
  { kind: "kimi", envKey: "MOONSHOT_API_KEY", baseUrl: "https://api.moonshot.cn/v1", visionCapable: false },
  { kind: "minimax", envKey: "MINIMAX_API_KEY", baseUrl: "https://api.minimaxi.chat/v1", visionCapable: false },
  { kind: "minimax_cn", envKey: "MINIMAX_API_KEY", baseUrl: "https://api.minimaxi.com/v1", visionCapable: false },
];

const ANTHROPIC_ENV_KEY = "ANTHROPIC_API_KEY";
const OPENAI_ENV_KEY = "OPENAI_API_KEY";

// ── 主供应商上下文 ─────────────────────────────────────────

export interface MainRuntimeContext {
  provider: string | null;
  model: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
  visionCapable?: boolean;
}

// ── 配置 ───────────────────────────────────────────────────

export interface AuxiliaryConfig {
  /** per-task 覆盖：`auxiliary.<task>.{provider,model,api_key,base_url}` */
  tasks?: Partial<Record<AuxTask, {
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  }>>;
  /** 自定义 endpoint（OPENAI_API_KEY + 自定义 base_url） */
  customEndpoint?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
}

// ── 解析链 ─────────────────────────────────────────────────

/**
 * 解析 auxiliary runtime（按回退链顺序尝试）。
 *
 * Text 任务回退链：
 *   1. 主供应商（任意类型）
 *   2. OpenRouter（OPENROUTER_API_KEY）
 *   3. 自定义 endpoint（customEndpoint.baseUrl + OPENAI_API_KEY）
 *   4. 原生 Anthropic（ANTHROPIC_API_KEY）
 *   5. 直连 API-key 供应商（zai / kimi / minimax）
 *   6. None
 *
 * Vision 任务回退链：
 *   1. 主供应商（若 visionCapable）
 *   2. OpenRouter
 *   3. 原生 Anthropic
 *   4. 自定义 endpoint（本地 vision 模型）
 *   5. None
 *
 * @param task side-task 类型
 * @param main 主供应商上下文
 * @param config auxiliary 配置
 * @param requireVision 是否要求 vision 能力
 */
export function resolveAuxRuntime(
  task: AuxTask,
  main: MainRuntimeContext,
  config: AuxiliaryConfig = {},
  requireVision = false,
): AuxRuntime | null {
  // 1. per-task override
  const taskCfg = config.tasks?.[task];
  if (taskCfg?.provider && taskCfg?.model) {
    return {
      provider: classifyProvider(taskCfg.provider),
      model: taskCfg.model,
      apiKey: taskCfg.apiKey ?? null,
      baseUrl: taskCfg.baseUrl ?? null,
      source: "override",
      visionCapable: requireVision,
    };
  }

  // 2. 主供应商
  if (main.provider && main.model) {
    const mainVision = main.visionCapable ?? false;
    if (!requireVision || mainVision) {
      return {
        provider: classifyProvider(main.provider),
        model: main.model,
        apiKey: main.apiKey ?? null,
        baseUrl: main.baseUrl ?? null,
        source: "main",
        visionCapable: mainVision,
      };
    }
  }

  // 3. OpenRouter
  const openrouter = ENV_PROVIDERS.find((p) => p.kind === "openrouter");
  if (openrouter) {
    const key = process.env[openrouter.envKey];
    if (key) {
      return {
        provider: openrouter.kind,
        model: null, // 由调用方选默认模型
        apiKey: key,
        baseUrl: openrouter.baseUrl,
        source: "openrouter",
        visionCapable: openrouter.visionCapable,
      };
    }
  }

  // 4. vision 任务优先 Anthropic；text 任务优先自定义 endpoint
  if (requireVision) {
    const anthropic = tryAnthropic();
    if (anthropic) return anthropic;
    const custom = tryCustomEndpoint(config, requireVision);
    if (custom) return custom;
  } else {
    const custom = tryCustomEndpoint(config, requireVision);
    if (custom) return custom;
    const anthropic = tryAnthropic();
    if (anthropic) return anthropic;
  }

  // 5. 直连 API-key 供应商
  for (const p of ENV_PROVIDERS) {
    if (p.kind === "openrouter") continue; // 已尝试
    const key = process.env[p.envKey];
    if (key && (!requireVision || p.visionCapable)) {
      return {
        provider: p.kind,
        model: null,
        apiKey: key,
        baseUrl: p.baseUrl,
        source: p.kind,
        visionCapable: p.visionCapable,
      };
    }
  }

  return null;
}

function tryAnthropic(): AuxRuntime | null {
  const key = process.env[ANTHROPIC_ENV_KEY];
  if (!key) return null;
  return {
    provider: "anthropic",
    model: null,
    apiKey: key,
    baseUrl: "https://api.anthropic.com",
    source: "anthropic",
    visionCapable: true,
  };
}

function tryCustomEndpoint(config: AuxiliaryConfig, requireVision: boolean): AuxRuntime | null {
  const baseUrl = config.customEndpoint?.baseUrl;
  const apiKey = config.customEndpoint?.apiKey ?? process.env[OPENAI_ENV_KEY];
  if (!baseUrl || !apiKey) return null;
  return {
    provider: "custom_endpoint",
    model: config.customEndpoint?.model ?? null,
    apiKey,
    baseUrl,
    source: "custom",
    visionCapable: requireVision,
  };
}

export function classifyProvider(name: string): ProviderKind {
  const lower = name.toLowerCase();
  if (lower.includes("openrouter")) return "openrouter";
  if (lower.includes("anthropic") || lower.includes("claude")) return "anthropic";
  if (lower.includes("openai") || lower.includes("gpt")) return "openai";
  if (lower.includes("codex")) return "codex";
  if (lower.includes("zai") || lower.includes("z.ai") || lower.includes("glm")) return "zai";
  if (lower.includes("kimi") || lower.includes("moonshot")) return "kimi";
  if (lower.includes("minimax")) {
    return lower.includes("cn") ? "minimax_cn" : "minimax";
  }
  if (lower.includes("nous")) return "nous_portal";
  return "unknown";
}

// ── 402 / 积分耗尽回退 ─────────────────────────────────────

/** 判断错误是否为积分耗尽 / 支付失败（应回退到下一供应商） */
export function isCreditExhaustedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; statusCode?: number; message?: string; code?: string };
  const status = e.status ?? e.statusCode;
  if (status === 402) return true;
  const msg = String(e.message ?? e.code ?? "").toLowerCase();
  return (
    msg.includes("insufficient credits") ||
    msg.includes("payment required") ||
    msg.includes("credit balance") ||
    msg.includes("402")
  );
}

/** 判断错误是否为限流（应回退到下一供应商） */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; statusCode?: number; code?: string };
  const status = e.status ?? e.statusCode;
  if (status === 429) return true;
  const code = String(e.code ?? "").toLowerCase();
  return code.includes("rate_limit") || code.includes("ratelimit");
}

// ── 核心调用：带回退的 side-task LLM ───────────────────────

/**
 * 调用 side-task LLM，带供应商回退。
 *
 * 解析链：主供应商 → OpenRouter → 自定义 → Anthropic → 直连 → None
 * 402/积分耗尽 → 自动重试下一供应商
 *
 * @param req 调用请求
 * @param main 主供应商上下文
 * @param chatFn 实际的 LLM 调用函数（由调用方注入）
 * @param config auxiliary 配置
 */
export async function callAuxLLM(
  req: AuxCallRequest,
  main: MainRuntimeContext,
  chatFn: AuxChatFn,
  config: AuxiliaryConfig = {},
): Promise<AuxCallResult> {
  const requireVision = req.requireVision ?? false;
  const tried: Set<ProviderKind> = new Set();

  // 构建回退链
  const chain: AuxRuntime[] = [];
  const primary = resolveAuxRuntime(req.task, main, config, requireVision);
  if (primary) chain.push(primary);

  // 收集所有可能的 runtime 作为回退
  const allRuntimes = collectAllRuntimes(main, config, requireVision);
  for (const r of allRuntimes) {
    if (!chain.some((c) => c.provider === r.provider && c.apiKey === r.apiKey)) {
      chain.push(r);
    }
  }

  let lastErr: unknown = null;
  for (const runtime of chain) {
    if (tried.has(runtime.provider)) continue;
    tried.add(runtime.provider);

    try {
      const result = await chatFn(runtime, req);
      return result;
    } catch (err) {
      lastErr = err;
      // 402/积分耗尽 → 回退到下一供应商
      if (isCreditExhaustedError(err) || isRateLimitError(err)) {
        continue;
      }
      // 其他错误 → 直接抛出（非瞬时错误，回退无意义）
      throw err;
    }
  }

  throw lastErr ?? new Error(`No auxiliary runtime available for task ${req.task}`);
}

/** 收集所有可用的 runtime（用于回退链） */
export function collectAllRuntimes(
  main: MainRuntimeContext,
  config: AuxiliaryConfig,
  requireVision: boolean,
): AuxRuntime[] {
  const runtimes: AuxRuntime[] = [];

  // 主供应商
  if (main.provider && main.model) {
    const mainVision = main.visionCapable ?? false;
    if (!requireVision || mainVision) {
      runtimes.push({
        provider: classifyProvider(main.provider),
        model: main.model,
        apiKey: main.apiKey ?? null,
        baseUrl: main.baseUrl ?? null,
        source: "main",
        visionCapable: mainVision,
      });
    }
  }

  // 环境变量供应商
  for (const p of ENV_PROVIDERS) {
    const key = process.env[p.envKey];
    if (key && (!requireVision || p.visionCapable)) {
      runtimes.push({
        provider: p.kind,
        model: null,
        apiKey: key,
        baseUrl: p.baseUrl,
        source: p.kind,
        visionCapable: p.visionCapable,
      });
    }
  }

  // Anthropic
  const anthropicKey = process.env[ANTHROPIC_ENV_KEY];
  if (anthropicKey) {
    runtimes.push({
      provider: "anthropic",
      model: null,
      apiKey: anthropicKey,
      baseUrl: "https://api.anthropic.com",
      source: "anthropic",
      visionCapable: true,
    });
  }

  // 自定义 endpoint
  const customBaseUrl = config.customEndpoint?.baseUrl;
  const customKey = config.customEndpoint?.apiKey ?? process.env[OPENAI_ENV_KEY];
  if (customBaseUrl && customKey) {
    runtimes.push({
      provider: "custom_endpoint",
      model: config.customEndpoint?.model ?? null,
      apiKey: customKey,
      baseUrl: customBaseUrl,
      source: "custom",
      visionCapable: requireVision,
    });
  }

  return runtimes;
}

// ── 中断保护（atomic side-task） ──────────────────────────

/**
 * 中断保护标志（异步上下文局部，等价 Python threading.local）。
 *
 * 某些 side-task（如 context compression）不能被 gateway interrupt 中途打断：
 * 若 summary LLM 调用被部分中断，压缩会回退到静态 "summary unavailable" 标记，
 * 真正的 handoff 丢失。设置此标志后，stream 取消检查会跳过该调用。
 *
 * TIMEOUT 仍然生效（hung 调用必须死）；其他 side-task（vision / web_extract /
 * title_generation）保持可中断。
 *
 * 实现说明：Hermes 原版用 threading.local() 实现线程隔离；TS 移植用模块级
 * 全局计数器会让所有并发 side-task 共享同一标志，违背"其他 side-task 保持
 * 可中断"的语义。改用 AsyncLocalStorage 在异步调用链中传播上下文局部状态。
 */
const protectionDepth = new AsyncLocalStorage<number>();

/** 标记当前调用为中断保护（atomic side-task 专用） */
export function withInterruptProtection<T>(fn: () => Promise<T>): Promise<T> {
  const depth = (protectionDepth.getStore() ?? 0) + 1;
  return protectionDepth.run(depth, fn);
}

/** 查询当前异步上下文是否处于中断保护状态 */
export function isInterruptProtected(): boolean {
  return (protectionDepth.getStore() ?? 0) > 0;
}
