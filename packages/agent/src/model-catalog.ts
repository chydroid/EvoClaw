/**
 * Model Catalog — OpenClaw compatibility layer.
 *
 * Registry of known AI models with their capabilities, context windows,
 * cost tiers, and provider information. Used for:
 *
 *   - Model selection by capability (vision, audio, tool-use, etc.)
 *   - Context window awareness (auto-selection of models with enough context)
 *   - Provider-based routing (OpenAI, Anthropic, Google, etc.)
 *   - Cost estimation (input/output token pricing tiers)
 *
 * The catalog is a static dataset (no API calls needed) that can be
 * queried programmatically.
 */

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export type ModelProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "meta"
  | "mistral"
  | "deepseek"
  | "qwen"
  | "dashscope"
  | "custom";

export type ModelCapability =
  | "text"
  | "vision"
  | "audio"
  | "tool-use"
  | "function-calling"
  | "streaming"
  | "json-mode"
  | "code"
  | "reasoning"
  | "embedding";

export interface ModelEntry {
  /** Canonical model ID (e.g. "gpt-4o") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Provider */
  provider: ModelProvider;
  /** Max context window in tokens */
  maxContextTokens: number;
  /** Max output tokens */
  maxOutputTokens: number;
  /** Capabilities */
  capabilities: ModelCapability[];
  /** Cost tier (1 = cheapest, 5 = most expensive) */
  costTier: 1 | 2 | 3 | 4 | 5;
  /** Whether the model is available */
  available: boolean;
  /** Release date (approximate YYYY-MM-DD) */
  releasedAt?: string;
  /** Notes */
  notes?: string;
}

export interface ModelQuery {
  provider?: ModelProvider | ModelProvider[];
  minContextTokens?: number;
  capabilities?: ModelCapability[];
  maxCostTier?: number;
  available?: boolean;
}

// ──────────────────────────────────────────────────────────────
// Model Catalog Data
// ──────────────────────────────────────────────────────────────

const CATALOG: ModelEntry[] = [
  // ── OpenAI ──
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    maxContextTokens: 128_000,
    maxOutputTokens: 16_384,
    capabilities: ["text", "vision", "tool-use", "function-calling", "streaming", "json-mode", "code"],
    costTier: 3,
    available: true,
    releasedAt: "2024-05-13",
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    provider: "openai",
    maxContextTokens: 128_000,
    maxOutputTokens: 16_384,
    capabilities: ["text", "vision", "tool-use", "function-calling", "streaming", "json-mode"],
    costTier: 1,
    available: true,
    releasedAt: "2024-07-18",
  },
  {
    id: "o4-mini",
    name: "o4-mini",
    provider: "openai",
    maxContextTokens: 200_000,
    maxOutputTokens: 100_000,
    capabilities: ["text", "reasoning", "tool-use", "function-calling", "streaming"],
    costTier: 2,
    available: true,
    releasedAt: "2025-04-16",
  },
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    maxContextTokens: 1_000_000,
    maxOutputTokens: 32_768,
    capabilities: ["text", "vision", "tool-use", "function-calling", "streaming", "json-mode", "code"],
    costTier: 4,
    available: true,
    releasedAt: "2025-04-14",
  },
  {
    id: "codex-cli",
    name: "Codex CLI",
    provider: "openai",
    maxContextTokens: 128_000,
    maxOutputTokens: 16_384,
    capabilities: ["text", "code", "tool-use", "function-calling", "streaming"],
    costTier: 3,
    available: true,
  },
  // ── Anthropic ──
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    maxContextTokens: 200_000,
    maxOutputTokens: 32_768,
    capabilities: ["text", "vision", "tool-use", "function-calling", "streaming", "code", "reasoning"],
    costTier: 5,
    available: true,
    releasedAt: "2025-07-01",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    maxContextTokens: 200_000,
    maxOutputTokens: 16_384,
    capabilities: ["text", "vision", "tool-use", "function-calling", "streaming", "code"],
    costTier: 3,
    available: true,
    releasedAt: "2025-07-01",
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
    capabilities: ["text", "vision", "tool-use", "function-calling", "streaming", "code"],
    costTier: 1,
    available: true,
    releasedAt: "2025-10-01",
  },
  // ── Google ──
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "google",
    maxContextTokens: 1_000_000,
    maxOutputTokens: 65_536,
    capabilities: ["text", "vision", "audio", "tool-use", "function-calling", "streaming", "code", "reasoning"],
    costTier: 3,
    available: true,
    releasedAt: "2025-03-25",
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
    maxContextTokens: 1_000_000,
    maxOutputTokens: 65_536,
    capabilities: ["text", "vision", "audio", "tool-use", "function-calling", "streaming"],
    costTier: 1,
    available: true,
    releasedAt: "2025-03-25",
  },
  // ── DeepSeek ──
  {
    id: "deepseek-v4",
    name: "DeepSeek V4",
    provider: "deepseek",
    maxContextTokens: 1_000_000,
    maxOutputTokens: 32_768,
    capabilities: ["text", "code", "reasoning", "tool-use", "function-calling", "streaming"],
    costTier: 2,
    available: true,
    releasedAt: "2025-05-01",
  },
  {
    id: "deepseek-r1",
    name: "DeepSeek R1",
    provider: "deepseek",
    maxContextTokens: 128_000,
    maxOutputTokens: 32_768,
    capabilities: ["text", "reasoning", "code", "streaming"],
    costTier: 2,
    available: true,
    releasedAt: "2025-01-20",
  },
  // ── Alibaba / Qwen ──
  {
    id: "qwen3-max",
    name: "Qwen3 Max",
    provider: "qwen",
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    capabilities: ["text", "code", "tool-use", "function-calling", "streaming"],
    costTier: 2,
    available: true,
    releasedAt: "2025-06-01",
  },
  // ── Meta ──
  {
    id: "llama-4-maverick",
    name: "Llama 4 Maverick",
    provider: "meta",
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    capabilities: ["text", "code", "tool-use", "streaming"],
    costTier: 1,
    available: true,
    releasedAt: "2025-04-01",
  },
  // ── Mistral ──
  {
    id: "mistral-large-2",
    name: "Mistral Large 2",
    provider: "mistral",
    maxContextTokens: 128_000,
    maxOutputTokens: 16_384,
    capabilities: ["text", "code", "function-calling", "streaming", "json-mode"],
    costTier: 3,
    available: true,
    releasedAt: "2025-02-01",
  },
];

// ──────────────────────────────────────────────────────────────
// Query API
// ──────────────────────────────────────────────────────────────

/**
 * Query the model catalog with optional filters.
 */
export function queryModels(query: ModelQuery = {}): ModelEntry[] {
  let results = [...CATALOG];

  if (query.provider) {
    const providers = Array.isArray(query.provider)
      ? query.provider
      : [query.provider];
    results = results.filter((m) => providers.includes(m.provider));
  }

  if (query.minContextTokens) {
    results = results.filter((m) => m.maxContextTokens >= query.minContextTokens!);
  }

  if (query.capabilities && query.capabilities.length > 0) {
    results = results.filter((m) =>
      query.capabilities!.every((cap) => m.capabilities.includes(cap)),
    );
  }

  if (query.maxCostTier !== undefined) {
    results = results.filter((m) => m.costTier <= query.maxCostTier!);
  }

  if (query.available !== undefined) {
    results = results.filter((m) => m.available === query.available);
  }

  return results;
}

/**
 * Get a single model by ID.
 */
export function getModel(id: string): ModelEntry | undefined {
  return CATALOG.find((m) => m.id === id);
}

/**
 * Get all models from a specific provider.
 */
export function getModelsByProvider(provider: ModelProvider): ModelEntry[] {
  return CATALOG.filter((m) => m.provider === provider);
}

/**
 * Find the best model for a given context size.
 * Returns the cheapest model that can handle the token count.
 */
export function findBestModelForContext(
  tokensNeeded: number,
  provider?: ModelProvider,
): ModelEntry | undefined {
  const candidates = CATALOG
    .filter((m) => m.maxContextTokens >= tokensNeeded && m.available)
    .filter((m) => !provider || m.provider === provider)
    .sort((a, b) => a.costTier - b.costTier);

  return candidates[0];
}

/**
 * List all available models formatted for LLM prompt injection.
 */
export function formatModelList(
  provider?: ModelProvider,
): string {
  const models = provider
    ? CATALOG.filter((m) => m.provider === provider)
    : CATALOG;

  const lines = ["**Available Models**", ""];
  for (const m of models) {
    const caps = m.capabilities.join(", ");
    const ctx = (m.maxContextTokens / 1000).toFixed(0) + "K";
    lines.push(
      `- \`${m.id}\` — ${m.name} (${ctx} context, ${caps}) [tier ${m.costTier}]`,
    );
  }
  return lines.join("\n");
}

/**
 * Get all unique providers in the catalog.
 */
export function getProviders(): ModelProvider[] {
  const set = new Set(CATALOG.map((m) => m.provider));
  return [...set];
}

/**
 * Total number of models in the catalog.
 */
export function getTotalModels(): number {
  return CATALOG.length;
}

/**
 * Get the full catalog (readonly).
 */
export function getCatalog(): ReadonlyArray<ModelEntry> {
  return CATALOG;
}