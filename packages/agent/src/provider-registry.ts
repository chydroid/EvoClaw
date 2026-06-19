/**
 * Provider Registry — implementation of the Plugin SDK's ProviderRegistry
 * interface. Manages registered LLM provider plugins, model resolution,
 * health tracking, and integration with the failover system.
 *
 * Features:
 *  - Dynamic registration/unregistration of ProviderPlugin instances
 *  - Model-to-provider resolution with priority
 *  - Cross-provider model listing and capability queries
 *  - Health-aware provider selection
 *  - Auto-discovery of built-in providers
 */

import type {
  ProviderPlugin,
  ProviderRegistry,
  ModelInfo,
  ModelRequest,
  ModelResponse,
  StreamChunk,
} from "@evoclaw/plugin-sdk";
import type { FailoverProvider } from "./model-failover";

// ── Types ─────────────────────────────────────────────────

export interface RegistryEntry {
  plugin: ProviderPlugin;
  /** When this provider was registered */
  registeredAt: number;
  /** Priority (lower = higher priority) */
  priority: number;
  /** Whether this is a built-in provider */
  builtIn: boolean;
}

export interface ResolvedProvider {
  plugin: ProviderPlugin;
  model: ModelInfo;
}

export interface RegistryConfig {
  /** Whether to auto-discover built-in providers */
  autoDiscover?: boolean;
  /** Default priority for registered providers */
  defaultPriority?: number;
  /** Max models to cache per provider */
  modelCacheMaxAgeMs?: number;
}

// ── Registry Implementation ───────────────────────────────

export class DefaultProviderRegistry implements ProviderRegistry {
  private entries = new Map<string, RegistryEntry>();
  private modelCache = new Map<string, { models: ModelInfo[]; timestamp: number }>();
  private config: Required<RegistryConfig>;

  constructor(config: RegistryConfig = {}) {
    this.config = {
      autoDiscover: config.autoDiscover ?? true,
      defaultPriority: config.defaultPriority ?? 100,
      modelCacheMaxAgeMs: config.modelCacheMaxAgeMs ?? 300_000, // 5 min
    };
  }

  // ── Provider Management ─────────────────────────────────

  register(plugin: ProviderPlugin, priority?: number): void {
    const entry: RegistryEntry = {
      plugin,
      registeredAt: Date.now(),
      priority: priority ?? this.config.defaultPriority,
      builtIn: false,
    };
    this.entries.set(plugin.provider, entry);
    this.modelCache.delete(plugin.provider);
  }

  registerBuiltIn(plugin: ProviderPlugin, priority = 10): void {
    const entry: RegistryEntry = {
      plugin,
      registeredAt: Date.now(),
      priority,
      builtIn: true,
    };
    this.entries.set(plugin.provider, entry);
    this.modelCache.delete(plugin.provider);
  }

  unregister(provider: string): void {
    this.entries.delete(provider);
    this.modelCache.delete(provider);
  }

  get(provider: string): ProviderPlugin | undefined {
    return this.entries.get(provider)?.plugin;
  }

  list(): string[] {
    return Array.from(this.entries.keys());
  }

  /** Get all registry entries (for failover integration) */
  listEntries(): RegistryEntry[] {
    return Array.from(this.entries.values())
      .sort((a, b) => a.priority - b.priority);
  }

  // ── Model Resolution ────────────────────────────────────

  async listAllModels(): Promise<ModelInfo[]> {
    const allModels: ModelInfo[] = [];
    const now = Date.now();

    for (const [provider, entry] of this.entries) {
      const cached = this.modelCache.get(provider);
      if (cached && (now - cached.timestamp) < this.config.modelCacheMaxAgeMs) {
        allModels.push(...cached.models);
        continue;
      }

      try {
        const models = await entry.plugin.listModels();
        this.modelCache.set(provider, { models, timestamp: now });
        allModels.push(...models);
      } catch (err) {
        process.stderr.write(`[ProviderRegistry] Failed to list models for "${provider}": ${err}`);
        // Use stale cache if available
        if (cached) {
          allModels.push(...cached.models);
        }
      }
    }

    return allModels;
  }

  resolve(modelId: string): ProviderPlugin | undefined {
    // Try exact provider prefix match first (e.g., "openai/gpt-4o")
    const slashIndex = modelId.indexOf("/");
    if (slashIndex > 0) {
      const providerPrefix = modelId.slice(0, slashIndex);
      const entry = this.entries.get(providerPrefix);
      if (entry) return entry.plugin;
    }

    // Search cached models to find the provider
    for (const [provider, entry] of this.entries) {
      const cached = this.modelCache.get(provider);
      if (cached) {
        const found = cached.models.some((m) => m.id === modelId);
        if (found) return entry.plugin;
      }
    }

    // Fallback: ask each provider if it supports this model
    // (done synchronously from cache, async resolution via resolveAsync)
    return undefined;
  }

  async resolveAsync(modelId: string): Promise<ResolvedProvider | undefined> {
    // Try provider prefix
    const slashIndex = modelId.indexOf("/");
    if (slashIndex > 0) {
      const providerPrefix = modelId.slice(0, slashIndex);
      const modelPart = modelId.slice(slashIndex + 1);
      const entry = this.entries.get(providerPrefix);
      if (entry) {
        const hasIt = await entry.plugin.hasModel(modelPart);
        if (hasIt) {
          const models = await this.getModelsFor(providerPrefix);
          const model = models.find((m) => m.id === modelPart);
          return { plugin: entry.plugin, model: model ?? { id: modelPart, name: modelPart, provider: providerPrefix, supportsVision: false, supportsStreaming: false, supportsTools: false, maxContextTokens: 8192, maxOutputTokens: 4096 } };
        }
      }
    }

    // Check each provider
    for (const [provider, entry] of this.entries) {
      const hasIt = await entry.plugin.hasModel(modelId);
      if (hasIt) {
        const models = await this.getModelsFor(provider);
        const model = models.find((m) => m.id === modelId);
        return { plugin: entry.plugin, model: model ?? { id: modelId, name: modelId, provider, supportsVision: false, supportsStreaming: false, supportsTools: false, maxContextTokens: 8192, maxOutputTokens: 4096 } };
      }
    }

    return undefined;
  }

  /** Resolve by capability requirements */
  async resolveByCapability(requirements: {
    supportsVision?: boolean;
    supportsTools?: boolean;
    minContextTokens?: number;
    maxCostTier?: number;
    preferredProviders?: string[];
  }): Promise<ResolvedProvider[]> {
    const allModels = await this.listAllModels();
    const results: ResolvedProvider[] = [];

    for (const model of allModels) {
      if (requirements.supportsVision && !model.supportsVision) continue;
      if (requirements.supportsTools && !model.supportsTools) continue;
      if (requirements.minContextTokens && model.maxContextTokens < requirements.minContextTokens) continue;

      const plugin = this.get(model.provider);
      if (!plugin) continue;

      results.push({ plugin, model });
    }

    // Sort: preferred providers first, then by context window (larger = better)
    const preferred = requirements.preferredProviders ?? [];
    results.sort((a, b) => {
      const aPref = preferred.indexOf(a.model.provider);
      const bPref = preferred.indexOf(b.model.provider);
      if (aPref !== -1 && bPref !== -1) return aPref - bPref;
      if (aPref !== -1) return -1;
      if (bPref !== -1) return 1;
      return b.model.maxContextTokens - a.model.maxContextTokens;
    });

    return results;
  }

  // ── Completion Helpers ──────────────────────────────────

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const resolved = await this.resolveAsync(request.model);
    if (!resolved) {
      throw new Error(`No provider found for model "${request.model}"`);
    }
    return resolved.plugin.complete(request);
  }

  async streamComplete(
    request: ModelRequest,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<ModelResponse> {
    const resolved = await this.resolveAsync(request.model);
    if (!resolved) {
      throw new Error(`No provider found for model "${request.model}"`);
    }
    return resolved.plugin.streamComplete(request, onChunk);
  }

  // ── Failover Integration ────────────────────────────────

  /** Convert registry entries to FailoverProvider format */
  toFailoverProviders(): FailoverProvider[] {
    return this.listEntries().map((entry) => ({
      id: entry.plugin.provider,
      name: entry.plugin.provider,
      enabled: true,
      order: entry.priority,
      weight: entry.builtIn ? 2 : 1,
      healthCheck: async () => {
        try {
          const result = await entry.plugin.healthCheck();
          return result.healthy;
        } catch {
          return false;
        }
      },
    }));
  }

  /** Get healthy providers sorted by priority for failover selection */
  async getHealthyProviders(): Promise<ProviderPlugin[]> {
    const plugins: ProviderPlugin[] = [];
    for (const entry of this.listEntries()) {
      try {
        const health = await entry.plugin.healthCheck();
        if (health.healthy) {
          plugins.push(entry.plugin);
        }
      } catch {
        // Skip unhealthy
      }
    }
    return plugins;
  }

  // ── Internal Helpers ────────────────────────────────────

  private async getModelsFor(provider: string): Promise<ModelInfo[]> {
    const cached = this.modelCache.get(provider);
    if (cached) return cached.models;

    const entry = this.entries.get(provider);
    if (!entry) return [];

    try {
      const models = await entry.plugin.listModels();
      this.modelCache.set(provider, { models, timestamp: Date.now() });
      return models;
    } catch {
      return [];
    }
  }

  /** Clear all caches */
  clearCache(): void {
    this.modelCache.clear();
  }

  /** Get total registered provider count */
  get providerCount(): number {
    return this.entries.size;
  }
}