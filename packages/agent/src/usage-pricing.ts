/**
 * Usage pricing — model pricing table, billing-route resolution, and cost
 * estimation from canonical token usage. TypeScript port of
 * hermes-agent/agent/usage_pricing.py.
 *
 * Precision: TypeScript has no native Decimal type. Token counts and per-
 * million prices both fit comfortably inside Number.isSafeInteger range for
 * any realistic API call (a 1B-token call at $75/M = $75,000 — well within
 * float64 precision). For paranoia about precision at extreme scales, callers
 * can re-implement with bigint; for normal session accounting, number is fine.
 */

// ── CanonicalUsage ────────────────────────────────────────────────────
export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  requestCount: number;
  /** Original raw usage object (optional, for debugging). Dropped on sum. */
  rawUsage?: unknown;
}

export function emptyUsage(): CanonicalUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    requestCount: 1,
  };
}

export function promptTokens(u: CanonicalUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

export function totalTokens(u: CanonicalUsage): number {
  return promptTokens(u) + u.outputTokens;
}

/** Sum two usage buckets (e.g. MoA advisor fan-out + aggregator). */
export function sumUsage(a: CanonicalUsage, b: CanonicalUsage): CanonicalUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    requestCount: a.requestCount + b.requestCount,
    // rawUsage is dropped on sum — describes a single API response only.
  };
}

// ── BillingRoute ──────────────────────────────────────────────────────
export type BillingMode =
  | "subscription_included"
  | "official_models_api"
  | "official_docs_snapshot"
  | "unknown";

export interface BillingRoute {
  provider: string;
  model: string;
  baseUrl: string;
  billingMode: BillingMode;
}

// ── PricingEntry ──────────────────────────────────────────────────────
export type CostStatus = "actual" | "estimated" | "included" | "unknown";
export type CostSource =
  | "provider_cost_api"
  | "provider_generation_api"
  | "provider_models_api"
  | "official_docs_snapshot"
  | "user_override"
  | "custom_contract"
  | "none";

export interface PricingEntry {
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
  requestCost?: number;
  source: CostSource;
  sourceUrl?: string;
  pricingVersion?: string;
  fetchedAt?: number; // epoch ms
}

export function makePricingEntry(partial: Partial<PricingEntry> & { source: CostSource }): PricingEntry {
  return { ...partial };
}

// ── CostResult ────────────────────────────────────────────────────────
export interface CostResult {
  amountUsd: number | null;
  status: CostStatus;
  source: CostSource;
  label: string;
  fetchedAt?: number;
  pricingVersion?: string;
  notes?: string[];
}

const ZERO = 0;
const ONE_MILLION = 1_000_000;
const NOUS_DEFAULT_BASE_URL = "https://inference-api.nousresearch.com/v1";

// ── Official docs snapshot pricing table ──────────────────────────────
// Keyed on [provider, model] tuples (model names already lowercased).
const OFFICIAL_DOCS_PRICING: Map<string, PricingEntry> = new Map([
  // ── Anthropic Claude 4.8 ─────────────────────────────────────────────
  pricing("anthropic", "claude-opus-4-8", 5.0, 25.0, 0.5, 6.25),
  pricing("anthropic", "claude-opus-4-8-fast", 10.0, 50.0, 1.0, 12.5),
  // ── Anthropic Claude 4.7 ─────────────────────────────────────────────
  pricing("anthropic", "claude-opus-4-7", 5.0, 25.0, 0.5, 6.25),
  pricing("anthropic", "claude-opus-4-7-20250507", 5.0, 25.0, 0.5, 6.25),
  // ── Anthropic Claude 4.6 ─────────────────────────────────────────────
  pricing("anthropic", "claude-opus-4-6", 5.0, 25.0, 0.5, 6.25),
  pricing("anthropic", "claude-opus-4-6-20250414", 5.0, 25.0, 0.5, 6.25),
  pricing("anthropic", "claude-sonnet-4-6", 3.0, 15.0, 0.3, 3.75),
  pricing("anthropic", "claude-sonnet-4-6-20250414", 3.0, 15.0, 0.3, 3.75),
  // ── Anthropic Claude 4.5 ─────────────────────────────────────────────
  pricing("anthropic", "claude-opus-4-5", 5.0, 25.0, 0.5, 6.25),
  pricing("anthropic", "claude-sonnet-4-5", 3.0, 15.0, 0.3, 3.75),
  pricing("anthropic", "claude-haiku-4-5", 1.0, 5.0, 0.1, 1.25),
  // ── Anthropic Claude 4 / 4.1 ─────────────────────────────────────────
  pricing("anthropic", "claude-opus-4-20250514", 15.0, 75.0, 1.5, 18.75),
  pricing("anthropic", "claude-sonnet-4-20250514", 3.0, 15.0, 0.3, 3.75),
  // ── OpenAI ────────────────────────────────────────────────────────────
  pricing("openai", "gpt-4o", 2.5, 10.0, 1.25),
  pricing("openai", "gpt-4o-mini", 0.15, 0.6, 0.075),
  pricing("openai", "gpt-4.1", 2.0, 8.0, 0.5),
  pricing("openai", "gpt-4.1-mini", 0.4, 1.6, 0.1),
  pricing("openai", "gpt-4.1-nano", 0.1, 0.4, 0.025),
  pricing("openai", "o3", 10.0, 40.0, 2.5),
  pricing("openai", "o3-mini", 1.1, 4.4, 0.55),
  // ── Anthropic older models ──────────────────────────────────────────
  pricing("anthropic", "claude-3-5-sonnet-20241022", 3.0, 15.0, 0.3, 3.75),
  pricing("anthropic", "claude-3-5-haiku-20241022", 0.8, 4.0, 0.08, 1.0),
  pricing("anthropic", "claude-3-opus-20240229", 15.0, 75.0, 1.5, 18.75),
  pricing("anthropic", "claude-3-haiku-20240307", 0.25, 1.25, 0.03, 0.3),
  // ── DeepSeek ──────────────────────────────────────────────────────────
  pricing("deepseek", "deepseek-chat", 0.14, 0.28),
  pricing("deepseek", "deepseek-reasoner", 0.55, 2.19),
  pricing("deepseek", "deepseek-v4-pro", 1.74, 3.48, 0.0145),
  // ── Google Gemini ─────────────────────────────────────────────────────
  pricing("google", "gemini-2.5-pro", 1.25, 10.0),
  pricing("google", "gemini-2.5-flash", 0.15, 0.6),
  pricing("google", "gemini-2.0-flash", 0.1, 0.4),
  // ── AWS Bedrock ──────────────────────────────────────────────────────
  pricing("bedrock", "anthropic.claude-opus-4-6", 15.0, 75.0, 1.5, 18.75),
  pricing("bedrock", "anthropic.claude-sonnet-4-6", 3.0, 15.0, 0.3, 3.75),
  pricing("bedrock", "anthropic.claude-sonnet-4-5", 3.0, 15.0, 0.3, 3.75),
  pricing("bedrock", "anthropic.claude-haiku-4-5", 0.8, 4.0, 0.08, 1.0),
  pricing("bedrock", "amazon.nova-pro", 0.8, 3.2),
  pricing("bedrock", "amazon.nova-lite", 0.06, 0.24),
  pricing("bedrock", "amazon.nova-micro", 0.035, 0.14),
  // ── MiniMax ───────────────────────────────────────────────────────────
  pricing("minimax", "minimax-m2.7", 0.3, 1.2),
  pricing("minimax-cn", "minimax-m2.7", 0.3, 1.2),
]);

function pricing(
  provider: string,
  model: string,
  inputCostPerMillion: number,
  outputCostPerMillion: number,
  cacheReadCostPerMillion?: number,
  cacheWriteCostPerMillion?: number,
): [string, PricingEntry] {
  return [
    `${provider}:${model}`,
    {
      inputCostPerMillion,
      outputCostPerMillion,
      cacheReadCostPerMillion,
      cacheWriteCostPerMillion,
      source: "official_docs_snapshot",
      pricingVersion: "evoclaw-pricing-2026-07",
    },
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────
function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toInt(value: unknown): number {
  const n = toNumber(value);
  if (n === undefined) return 0;
  // Truncate toward zero (matches Python int()).
  return Math.trunc(n);
}

function baseUrlHostMatches(baseUrl: string, host: string): boolean {
  if (!baseUrl) return false;
  try {
    const u = new URL(baseUrl);
    return u.hostname === host || u.hostname.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

// ── resolve_billing_route ─────────────────────────────────────────────
/**
 * Resolve a (model_name, provider, base_url) triple to a BillingRoute.
 *
 * Strips vendor prefixes (`anthropic/`, `openai/`) from the model name when
 * the provider is also named explicitly, since the pricing table keys on the
 * bare model id.
 */
export function resolveBillingRoute(
  modelName: string,
  provider?: string | null,
  baseUrl?: string | null,
): BillingRoute {
  let providerName = (provider ?? "").trim().toLowerCase();
  const base = (baseUrl ?? "").trim().toLowerCase();
  let model = (modelName ?? "").trim();

  if (!providerName && model.includes("/")) {
    const slashIdx = model.indexOf("/");
    const inferred = model.slice(0, slashIdx);
    const bare = model.slice(slashIdx + 1);
    if (inferred === "anthropic" || inferred === "openai" || inferred === "google") {
      providerName = inferred;
      model = bare;
    }
  }

  if (providerName === "openai-codex") {
    return { provider: "openai-codex", model, baseUrl: baseUrl ?? "", billingMode: "subscription_included" };
  }
  if (providerName === "openrouter" || baseUrlHostMatches(baseUrl ?? "", "openrouter.ai")) {
    return { provider: "openrouter", model, baseUrl: baseUrl ?? "", billingMode: "official_models_api" };
  }
  if (providerName === "nous" || baseUrlHostMatches(baseUrl ?? "", "inference-api.nousresearch.com")) {
    return {
      provider: "nous",
      model,
      baseUrl: baseUrl ?? NOUS_DEFAULT_BASE_URL,
      billingMode: "official_models_api",
    };
  }
  if (providerName === "anthropic") {
    return {
      provider: "anthropic",
      model: model.split("/").pop() ?? model,
      baseUrl: baseUrl ?? "",
      billingMode: "official_docs_snapshot",
    };
  }
  if (providerName === "openai") {
    return {
      provider: "openai",
      model: model.split("/").pop() ?? model,
      baseUrl: baseUrl ?? "",
      billingMode: "official_docs_snapshot",
    };
  }
  if (providerName === "minimax" || providerName === "minimax-cn") {
    return {
      provider: providerName,
      model: model.split("/").pop() ?? model,
      baseUrl: baseUrl ?? "",
      billingMode: "official_docs_snapshot",
    };
  }
  if (providerName === "vertex" || baseUrlHostMatches(baseUrl ?? "", "aiplatform.googleapis.com")) {
    return {
      provider: "gemini",
      model: model.split("/").pop() ?? model,
      baseUrl: baseUrl ?? "",
      billingMode: "official_docs_snapshot",
    };
  }
  if (providerName === "custom" || providerName === "local" || (base && base.includes("localhost"))) {
    return { provider: providerName || "custom", model, baseUrl: baseUrl ?? "", billingMode: "unknown" };
  }
  return {
    provider: providerName || "unknown",
    model: model ? (model.split("/").pop() ?? model) : "",
    baseUrl: baseUrl ?? "",
    billingMode: "unknown",
  };
}

function normalizeBedrockModelName(model: string): string {
  let name = model.toLowerCase().trim();
  for (const prefix of ["us.", "global.", "eu.", "ap.", "jp."]) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  // Normalize dot-notation version numbers (4.7 → 4-7).
  name = name.replace(/(\d+)\.(\d+)/g, "$1-$2");
  return name;
}

function normalizeAnthropicModelName(model: string): string {
  let name = model.toLowerCase().trim();
  if (name.startsWith("anthropic/")) {
    name = name.slice("anthropic/".length);
  }
  name = name.replace(/(\d+)\.(\d+)/g, "$1-$2");
  return name;
}

function lookupOfficialDocsPricing(route: BillingRoute): PricingEntry | null {
  const model = route.model.toLowerCase();
  let entry = OFFICIAL_DOCS_PRICING.get(`${route.provider}:${model}`);
  if (entry) return entry;
  if (route.provider === "anthropic") {
    const normalized = normalizeAnthropicModelName(model);
    if (normalized !== model) {
      entry = OFFICIAL_DOCS_PRICING.get(`${route.provider}:${normalized}`);
      if (entry) return entry;
    }
  }
  if (route.provider === "bedrock") {
    const normalized = normalizeBedrockModelName(model);
    if (normalized !== model) {
      entry = OFFICIAL_DOCS_PRICING.get(`${route.provider}:${normalized}`);
      if (entry) return entry;
    }
  }
  return null;
}

// ── get_pricing_entry ─────────────────────────────────────────────────
/**
 * Look up the pricing entry for a model+route.
 *
 * Subscription-included routes (e.g. openai-codex) return a zero-cost entry.
 * The openrouter path returns null here — the TS port does not embed the
 * OpenRouter models API client; callers that want live OpenRouter pricing
 * must fetch and pass it in via the optional `metadataProvider` argument.
 */
export function getPricingEntry(
  modelName: string,
  opts: {
    provider?: string | null;
    baseUrl?: string | null;
    apiKey?: string | null;
    /** Optional caller-supplied pricing metadata keyed on model id. */
    metadata?: Record<string, Record<string, unknown>> | null;
  } = {},
): PricingEntry | null {
  const route = resolveBillingRoute(modelName, opts.provider, opts.baseUrl);
  if (route.billingMode === "subscription_included") {
    return {
      inputCostPerMillion: ZERO,
      outputCostPerMillion: ZERO,
      cacheReadCostPerMillion: ZERO,
      cacheWriteCostPerMillion: ZERO,
      source: "none",
      pricingVersion: "included-route",
    };
  }
  // Caller-supplied metadata (e.g. fetched from /v1/models) takes precedence
  // when present, mirroring the Python flow where openrouter/endpoint models
  // API data wins over the static docs snapshot.
  if (opts.metadata && route.model in opts.metadata) {
    const entry = pricingEntryFromMetadata(
      opts.metadata,
      route.model,
      "openai-compatible-models-api",
    );
    if (entry) return entry;
  }
  return lookupOfficialDocsPricing(route);
}

function pricingEntryFromMetadata(
  metadata: Record<string, Record<string, unknown>>,
  modelId: string,
  pricingVersion: string,
): PricingEntry | null {
  const item = metadata[modelId];
  if (!item) return null;
  const pricing = (item.pricing ?? {}) as Record<string, unknown>;
  const prompt = toNumber(pricing.prompt);
  const completion = toNumber(pricing.completion);
  const request = toNumber(pricing.request);
  const cacheRead =
    toNumber(pricing.cache_read) ??
    toNumber(pricing.cached_prompt) ??
    toNumber(pricing.input_cache_read);
  const cacheWrite =
    toNumber(pricing.cache_write) ??
    toNumber(pricing.cache_creation) ??
    toNumber(pricing.input_cache_write);
  if (prompt === undefined && completion === undefined && request === undefined) {
    return null;
  }
  const perTokenToPerMillion = (v?: number): number | undefined =>
    v === undefined ? undefined : v * ONE_MILLION;
  return {
    inputCostPerMillion: perTokenToPerMillion(prompt),
    outputCostPerMillion: perTokenToPerMillion(completion),
    cacheReadCostPerMillion: perTokenToPerMillion(cacheRead),
    cacheWriteCostPerMillion: perTokenToPerMillion(cacheWrite),
    requestCost: request,
    source: "provider_models_api",
    pricingVersion,
    fetchedAt: Date.now(),
  };
}

// ── normalize_usage ───────────────────────────────────────────────────
export interface RawUsageLike {
  // Anthropic shape
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // OpenAI Chat Completions shape
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
  // Responses API shape
  input_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
}

/**
 * Normalize raw API response usage into canonical token buckets.
 *
 * Handles three API shapes:
 *   - Anthropic: input_tokens/output_tokens/cache_read_input_tokens/cache_creation_input_tokens
 *   - Codex Responses: input_tokens includes cache tokens; input_tokens_details.cached_tokens separates them
 *   - OpenAI Chat Completions: prompt_tokens includes cache tokens; prompt_tokens_details.cached_tokens separates them
 *
 * In both Codex and OpenAI modes, input_tokens is derived by subtracting
 * cache tokens from the total — the API contract is that input/prompt totals
 * include cached tokens and the details object breaks them out.
 */
export function normalizeUsage(
  responseUsage: unknown,
  opts: { provider?: string | null; apiMode?: string | null } = {},
): CanonicalUsage {
  if (!responseUsage || typeof responseUsage !== "object") {
    return emptyUsage();
  }
  const u = responseUsage as RawUsageLike;
  const providerName = (opts.provider ?? "").trim().toLowerCase();
  const mode = (opts.apiMode ?? "").trim().toLowerCase();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  if (mode === "anthropic_messages" || providerName === "anthropic") {
    inputTokens = toInt(u.input_tokens);
    outputTokens = toInt(u.output_tokens);
    cacheReadTokens = toInt(u.cache_read_input_tokens);
    cacheWriteTokens = toInt(u.cache_creation_input_tokens);
  } else if (mode === "codex_responses") {
    const inputTotal = toInt(u.input_tokens);
    outputTokens = toInt(u.output_tokens);
    const details = u.input_tokens_details;
    cacheReadTokens = details ? toInt(details.cached_tokens) : 0;
    cacheWriteTokens = details ? toInt(details.cache_creation_tokens) : 0;
    inputTokens = Math.max(0, inputTotal - cacheReadTokens - cacheWriteTokens);
  } else {
    const promptTotal = toInt(u.prompt_tokens);
    outputTokens = toInt(u.completion_tokens);
    const details = u.prompt_tokens_details;
    cacheReadTokens = details ? toInt(details.cached_tokens) : 0;
    // Fallback: some OpenAI-compatible proxies surface cache fields at the
    // top level instead of in the details object.
    if (!cacheReadTokens) {
      cacheReadTokens = toInt(u.cache_read_input_tokens);
    }
    cacheWriteTokens = details ? toInt(details.cache_write_tokens) : 0;
    if (!cacheWriteTokens) {
      cacheWriteTokens = toInt(u.cache_creation_input_tokens);
    }
    inputTokens = Math.max(0, promptTotal - cacheReadTokens - cacheWriteTokens);
  }

  // Reasoning tokens — Responses API shape first, then Chat Completions shape.
  // Without this fallback, hidden thinking was invisible in session accounting
  // even though it dominates output spend on reasoning models.
  let reasoningTokens = 0;
  const outputDetails = u.output_tokens_details;
  if (outputDetails) {
    reasoningTokens = toInt(outputDetails.reasoning_tokens);
  }
  if (!reasoningTokens) {
    const completionDetails = u.completion_tokens_details;
    if (completionDetails) {
      reasoningTokens = toInt(completionDetails.reasoning_tokens);
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    requestCount: 1,
    rawUsage: responseUsage,
  };
}

// ── estimate_usage_cost ──────────────────────────────────────────────
export function estimateUsageCost(
  modelName: string,
  usage: CanonicalUsage,
  opts: {
    provider?: string | null;
    baseUrl?: string | null;
    apiKey?: string | null;
    metadata?: Record<string, Record<string, unknown>> | null;
  } = {},
): CostResult {
  const route = resolveBillingRoute(modelName, opts.provider, opts.baseUrl);
  if (route.billingMode === "subscription_included") {
    return {
      amountUsd: ZERO,
      status: "included",
      source: "none",
      label: "included",
      pricingVersion: "included-route",
    };
  }

  const entry = getPricingEntry(modelName, opts);
  if (!entry) {
    return { amountUsd: null, status: "unknown", source: "none", label: "n/a" };
  }

  const notes: string[] = [];
  let amount = ZERO;

  if (usage.inputTokens && entry.inputCostPerMillion === undefined) {
    return { amountUsd: null, status: "unknown", source: entry.source, label: "n/a" };
  }
  if (usage.outputTokens && entry.outputCostPerMillion === undefined) {
    return { amountUsd: null, status: "unknown", source: entry.source, label: "n/a" };
  }
  if (usage.cacheReadTokens) {
    if (entry.cacheReadCostPerMillion === undefined) {
      return {
        amountUsd: null,
        status: "unknown",
        source: entry.source,
        label: "n/a",
        notes: ["cache-read pricing unavailable for route"],
      };
    }
  }
  if (usage.cacheWriteTokens) {
    if (entry.cacheWriteCostPerMillion === undefined) {
      return {
        amountUsd: null,
        status: "unknown",
        source: entry.source,
        label: "n/a",
        notes: ["cache-write pricing unavailable for route"],
      };
    }
  }

  if (entry.inputCostPerMillion !== undefined) {
    amount += (usage.inputTokens * entry.inputCostPerMillion) / ONE_MILLION;
  }
  if (entry.outputCostPerMillion !== undefined) {
    amount += (usage.outputTokens * entry.outputCostPerMillion) / ONE_MILLION;
  }
  if (entry.cacheReadCostPerMillion !== undefined) {
    amount += (usage.cacheReadTokens * entry.cacheReadCostPerMillion) / ONE_MILLION;
  }
  if (entry.cacheWriteCostPerMillion !== undefined) {
    amount += (usage.cacheWriteTokens * entry.cacheWriteCostPerMillion) / ONE_MILLION;
  }
  if (entry.requestCost !== undefined && usage.requestCount) {
    amount += usage.requestCount * entry.requestCost;
  }

  let status: CostStatus = "estimated";
  let label = `~$${amount.toFixed(2)}`;
  if (entry.source === "none" && amount === ZERO) {
    status = "included";
    label = "included";
  }
  if (route.provider === "openrouter") {
    notes.push("OpenRouter cost is estimated from the models API until reconciled.");
  }

  return {
    amountUsd: amount,
    status,
    source: entry.source,
    label,
    fetchedAt: entry.fetchedAt,
    pricingVersion: entry.pricingVersion,
    notes: notes.length ? notes : undefined,
  };
}

// ── has_known_pricing ─────────────────────────────────────────────────
export function hasKnownPricing(
  modelName: string,
  opts: {
    provider?: string | null;
    baseUrl?: string | null;
    apiKey?: string | null;
    metadata?: Record<string, Record<string, unknown>> | null;
  } = {},
): boolean {
  const route = resolveBillingRoute(modelName, opts.provider, opts.baseUrl);
  if (route.billingMode === "subscription_included") return true;
  return getPricingEntry(modelName, opts) !== null;
}

// ── Display formatters ────────────────────────────────────────────────
export function formatDurationCompact(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(0)}m`;
  const hours = minutes / 60;
  if (hours < 24) {
    const remainingMin = Math.floor(minutes) % 60;
    return remainingMin ? `${Math.floor(hours)}h ${remainingMin}m` : `${Math.floor(hours)}h`;
  }
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
}

export function formatTokenCountCompact(value: number): string {
  // 用 trunc 而非 floor：对负数 token（如 sumUsage 边界情况），
  // floor(-1.5) = -2 会偏离 -1，trunc(-1.5) = -1 与 toInt 一致
  const trunced = Math.trunc(value);
  const absValue = Math.abs(trunced);
  if (absValue < 1_000) return String(trunced);

  const sign = trunced < 0 ? "-" : "";
  const units: Array<[number, string]> = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (const [threshold, suffix] of units) {
    if (absValue >= threshold) {
      const scaled = absValue / threshold;
      let text: string;
      if (scaled < 10) text = scaled.toFixed(2);
      else if (scaled < 100) text = scaled.toFixed(1);
      else text = scaled.toFixed(0);
      if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
      return `${sign}${text}${suffix}`;
    }
  }
  return value.toLocaleString();
}
