/**
 * CopilotRouter — 智能任务路由器
 *
 * 根据任务复杂度将请求路由到合适的模型：
 * 1. 简单任务（问候、翻译、格式化）→ 轻量级远程模型（省Token）
 * 2. 复杂任务（代码、推理）→ 高性能远程API（按用户配置的Provider顺序）
 *
 * 关键原则：
 * - 远程API按用户LLM配置的Provider顺序调用，不默认GPT-4o
 * - 优先使用用户配置的第一个已启用的Provider
 */

export interface CopilotRouteRule {
  pattern: RegExp | string;
  targetModel: string;
  targetProvider: string;
  description: string;
}

export interface CopilotRouterConfig {
  enabled: boolean;
  defaultModel: string;
  defaultProvider: string;
  rules: CopilotRouteRule[];
  /** User-configured LLM providers in priority order */
  userProviders?: UserLLMProvider[];
  /** 路由缓存 TTL（ms），默认 60 秒 */
  cacheTtlMs?: number;
  /** 路由缓存最大条目数，默认 200 */
  cacheMaxEntries?: number;
  /** 启用成本感知路由（简单任务优先选择更便宜的 provider） */
  costAware?: boolean;
}

export interface UserLLMProvider {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  selectedModel: string;
  baseURL: string;
}

export interface RoutingDecision {
  shouldDowngrade: boolean;
  originalModel: string;
  originalProvider: string;
  routedModel: string;
  routedProvider: string;
  reason: string;
  /** 是否命中缓存 */
  fromCache?: boolean;
}

/**
 * Provider 健康信息接口。
 * 借鉴 openclaw 的健康感知设计，路由时考虑 provider 健康状态。
 */
export interface ProviderHealthInfo {
  providerId: string;
  /** 健康分数 (0-100，越高越好) */
  healthScore: number;
  /** 是否熔断中 */
  circuitOpen: boolean;
  /** 平均延迟（ms） */
  avgLatencyMs: number;
}

/**
 * 模型成本信息（每 1K token 的美元价格）。
 * 借鉴 Aider 的双模型分工理念：简单任务用便宜模型，复杂任务用强力模型。
 */
export interface ModelCostInfo {
  /** 每 1K input token 价格（美元） */
  inputCostPer1K: number;
  /** 每 1K output token 价格（美元） */
  outputCostPer1K: number;
}

const CODE_PATTERNS: RegExp[] = [
  /^(write|create|implement|build|fix|debug|refactor|code|program|develop|deploy)\b/i,
  /\b(function|class|method|api|endpoint|module|component|algorithm|sql|regex)\b/i,
  /\b(bug|error|exception|stack trace|compile|runtime|syntax error)\b/i,
];

const MATH_PATTERNS: RegExp[] = [
  /^(calculate|solve|compute|prove|derive|evaluate|simplify)\b/i,
  /\b(equation|theorem|integral|derivative|matrix|polynomial|logarithm)\b/i,
];

/** 简单任务模式 — 可路由到本地模型 */
const SIMPLE_TASK_PATTERNS: RegExp[] = [
  // 问候
  /^(你好|hello|hi|hey|how are you|what'?s up|sup|yo|早上好|晚上好|下午好)\b/i,
  /^(good morning|good afternoon|good evening|good night)\b/i,
  // 翻译
  /^(translate|翻译)\b/i,
  // 格式化
  /^(format this|convert to|summarize in one sentence|reformat|rewrite as|change to)\b/i,
  // 简单查询
  /^(what time|what date|what day|spell|define|what is)\b/i,
  // 确认/感谢
  /^(thanks|thank you|ok|okay|got it|好的|谢谢|收到|明白了)\b/i,
  // 简短对话（<15字符的中文/英文）
];

// ── 路由缓存条目 ───────────────────────────────────────────
interface CacheEntry {
  decision: RoutingDecision;
  expiresAt: number;
}

export class CopilotRouter {
  private config: CopilotRouterConfig;
  /** 路由决策缓存（LRU + TTL），避免重复计算 */
  private routeCache = new Map<string, CacheEntry>();
  /** Provider 健康状态映射 */
  private providerHealth = new Map<string, ProviderHealthInfo>();
  /** 模型成本映射（model name → cost info） */
  private modelCosts = new Map<string, ModelCostInfo>();
  /** 缓存统计 */
  private cacheStats = { hits: 0, misses: 0 };

  constructor(config?: Partial<CopilotRouterConfig>) {
    this.config = {
      enabled: config?.enabled ?? true,
      defaultModel: config?.defaultModel ?? "",
      defaultProvider: config?.defaultProvider ?? "",
      rules: config?.rules ?? [],
      userProviders: config?.userProviders ?? [],
      cacheTtlMs: config?.cacheTtlMs ?? 60_000,
      cacheMaxEntries: config?.cacheMaxEntries ?? 200,
      costAware: config?.costAware ?? true,
    };
  }

  /**
   * 核心路由决策（带缓存）。
   *
   * 改进：
   * 1. 路由缓存：相同输入直接返回缓存结果，避免重复正则匹配
   * 2. 健康感知：跳过熔断中的 provider，优先选择健康的 provider
   * 3. 缓存键包含 model+provider，确保不同上下文不混淆
   */
  route(taskDescription: string, currentModel: string, currentProvider: string): RoutingDecision {
    if (!this.config.enabled) {
      return {
        shouldDowngrade: false,
        originalModel: currentModel,
        originalProvider: currentProvider,
        routedModel: currentModel,
        routedProvider: currentProvider,
        reason: "Copilot routing is disabled",
      };
    }

    // 检查缓存
    const cacheKey = this.buildCacheKey(taskDescription, currentModel, currentProvider);
    const cached = this.routeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.cacheStats.hits++;
      return { ...cached.decision, fromCache: true };
    }
    this.cacheStats.misses++;

    // 计算路由决策
    const decision = this.computeRoute(taskDescription, currentModel, currentProvider);

    // 写入缓存
    this.setCache(cacheKey, decision);

    return decision;
  }

  /**
   * 实际的路由计算逻辑（无缓存）。
   */
  private computeRoute(taskDescription: string, currentModel: string, currentProvider: string): RoutingDecision {
    // Complex tasks always use full remote model
    if (this.isCodeTask(taskDescription) || this.isMathTask(taskDescription)) {
      return {
        shouldDowngrade: false,
        originalModel: currentModel,
        originalProvider: currentProvider,
        routedModel: currentModel,
        routedProvider: currentProvider,
        reason: "Task requires full model capability",
      };
    }

    // Check custom rules first (user-defined rules take priority)
    const matchedRule = this.matchRule(taskDescription);
    if (matchedRule) {
      // 检查规则目标 provider 是否健康
      const health = this.providerHealth.get(matchedRule.targetProvider);
      if (health?.circuitOpen) {
        // provider 熔断中，不降级到该 provider
        return {
          shouldDowngrade: false,
          originalModel: currentModel,
          originalProvider: currentProvider,
          routedModel: currentModel,
          routedProvider: currentProvider,
          reason: `Rule matched but target provider "${matchedRule.targetProvider}" is in circuit open state`,
        };
      }
      return {
        shouldDowngrade: true,
        originalModel: currentModel,
        originalProvider: currentProvider,
        routedModel: matchedRule.targetModel,
        routedProvider: matchedRule.targetProvider,
        reason: `Matched rule: ${matchedRule.description}`,
      };
    }

    // Check if simple task that can use lighter model
    if (this.isSimpleTask(taskDescription)) {
      // Route to first enabled healthy user provider
      const fallback = this.getFirstEnabledHealthyProvider(currentModel, currentProvider);
      return {
        shouldDowngrade: fallback.shouldDowngrade,
        originalModel: currentModel,
        originalProvider: currentProvider,
        routedModel: fallback.model,
        routedProvider: fallback.provider,
        reason: `Simple task → ${fallback.provider}/${fallback.model}`,
      };
    }

    // Default: no routing change
    return {
      shouldDowngrade: false,
      originalModel: currentModel,
      originalProvider: currentProvider,
      routedModel: currentModel,
      routedProvider: currentProvider,
      reason: "No routing rule matched",
    };
  }

  addRule(rule: CopilotRouteRule): void {
    this.config.rules.push(rule);
  }

  removeRule(pattern: string): boolean {
    const index = this.config.rules.findIndex((r) => {
      if (typeof r.pattern === "string") return r.pattern === pattern;
      return r.pattern.source === pattern;
    });
    if (index === -1) return false;
    this.config.rules.splice(index, 1);
    return true;
  }

  getRules(): CopilotRouteRule[] {
    return [...this.config.rules];
  }

  updateUserProviders(providers: UserLLMProvider[]): void {
    this.config.userProviders = providers;
  }

  /** 更新模型成本映射，用于成本感知路由 */
  updateModelCosts(costs: Record<string, ModelCostInfo>): void {
    for (const [model, cost] of Object.entries(costs)) {
      this.modelCosts.set(model, cost);
    }
  }

  // ── Private ──

  private isSimpleTask(taskDescription: string): boolean {
    const lower = taskDescription.toLowerCase().trim();

    // Match simple task patterns
    for (const p of SIMPLE_TASK_PATTERNS) {
      if (p.test(lower)) return true;
    }

    // Very short messages (< 15 chars) are likely simple
    if (lower.length <= 15) return true;

    return false;
  }

  private isCodeTask(taskDescription: string): boolean {
    return CODE_PATTERNS.some((p) => p.test(taskDescription));
  }

  private isMathTask(taskDescription: string): boolean {
    return MATH_PATTERNS.some((p) => p.test(taskDescription));
  }

  private matchRule(taskDescription: string): CopilotRouteRule | null {
    for (const rule of this.config.rules) {
      try {
        const regex = typeof rule.pattern === "string"
          ? new RegExp(rule.pattern, "i")
          : rule.pattern;
        if (regex.test(taskDescription)) {
          return rule;
        }
      } catch (err) {
        // 非法正则模式，记录到 stderr 并跳过该规则（视为不匹配）
        process.stderr.write(
          "[CopilotRouter] invalid rule pattern '" + String(rule.pattern) + "': " + err + "\n",
        );
      }
    }
    return null;
  }

  /**
   * 获取第一个已启用的健康用户Provider。
   * 不默认GPT-4o，严格按用户配置顺序。
   * 跳过熔断中的 provider，优先选择健康的 provider。
   *
   * 成本感知模式（costAware=true）：在所有健康的已启用 provider 中，
   * 选择成本最低的（基于 modelCosts 映射），借鉴 Aider 的双模型分工理念。
   */
  private getFirstEnabledHealthyProvider(currentModel: string, currentProvider: string): {
    model: string;
    provider: string;
    shouldDowngrade: boolean;
  } {
    const providers = this.config.userProviders;
    if (providers && providers.length > 0) {
      const sorted = [...providers].sort((a, b) => a.order - b.order);

      // 收集所有已启用且健康的 provider
      const healthy: typeof sorted = [];
      for (const p of sorted) {
        if (!p.enabled) continue;
        const health = this.providerHealth.get(p.id);
        if (health?.circuitOpen) continue;
        healthy.push(p);
      }

      if (healthy.length > 0) {
        // 成本感知：简单任务优先选择最便宜的 provider
        if (this.config.costAware && this.modelCosts.size > 0) {
          const cheapest = this.findCheapestProvider(healthy);
          if (cheapest) {
            return {
              model: cheapest.selectedModel,
              provider: cheapest.id,
              shouldDowngrade: cheapest.id !== currentProvider,
            };
          }
        }

        // 默认：取第一个健康的 provider（按用户配置顺序）
        const first = healthy[0];
        return {
          model: first.selectedModel,
          provider: first.id,
          shouldDowngrade: first.id !== currentProvider,
        };
      }

      // 所有 provider 都熔断了，回退到第一个已启用的（即使不健康）
      const fallback = sorted.find(p => p.enabled);
      if (fallback) {
        return {
          model: fallback.selectedModel,
          provider: fallback.id,
          shouldDowngrade: fallback.id !== currentProvider,
        };
      }
    }

    // No user providers configured, keep current
    return {
      model: currentModel,
      provider: currentProvider,
      shouldDowngrade: false,
    };
  }

  /** 在健康 provider 列表中选择成本最低的 */
  private findCheapestProvider(providers: UserLLMProvider[]): UserLLMProvider | null {
    let cheapest: UserLLMProvider | null = null;
    let cheapestCost = Infinity;
    for (const p of providers) {
      const cost = this.modelCosts.get(p.selectedModel);
      if (cost) {
        // 用 input + output 成本之和作为排序依据
        const total = cost.inputCostPer1K + cost.outputCostPer1K;
        if (total < cheapestCost) {
          cheapestCost = total;
          cheapest = p;
        }
      }
    }
    return cheapest;
  }

  // ── 缓存管理 ──────────────────────────────────────────────

  /**
   * 构建缓存键。
   * 包含消息前缀 + model + provider，确保不同上下文不混淆。
   */
  private buildCacheKey(taskDescription: string, model: string, provider: string): string {
    // 使用消息前 100 字符作为键，避免过长消息占用过多内存
    const prefix = taskDescription.slice(0, 100).toLowerCase().trim();
    return `${prefix}|${model}|${provider}`;
  }

  /**
   * 写入缓存，执行 LRU 淘汰。
   */
  private setCache(key: string, decision: RoutingDecision): void {
    const maxEntries = this.config.cacheMaxEntries ?? 200;
    const ttlMs = this.config.cacheTtlMs ?? 60_000;

    // LRU 淘汰：超过最大条目数时删除最旧的
    if (this.routeCache.size >= maxEntries) {
      const oldestKey = this.routeCache.keys().next().value;
      if (oldestKey) {
        this.routeCache.delete(oldestKey);
      }
    }

    this.routeCache.set(key, {
      decision,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * 清除路由缓存。
   */
  clearCache(): void {
    this.routeCache.clear();
    this.cacheStats = { hits: 0, misses: 0 };
  }

  /**
   * 获取缓存统计信息。
   */
  getCacheStats(): { hits: number; misses: number; hitRate: number; size: number } {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    return {
      hits: this.cacheStats.hits,
      misses: this.cacheStats.misses,
      hitRate: total > 0 ? this.cacheStats.hits / total : 0,
      size: this.routeCache.size,
    };
  }

  // ── 健康感知 ──────────────────────────────────────────────

  /**
   * 更新 provider 健康状态。
   * 当 provider 熔断或恢复时调用，路由决策会感知到状态变化。
   */
  updateProviderHealth(info: ProviderHealthInfo): void {
    this.providerHealth.set(info.providerId, info);
    // provider 健康状态变化时清除缓存，确保下次路由使用最新状态
    this.routeCache.clear();
  }

  /**
   * 批量更新 provider 健康状态。
   */
  updateProviderHealthBatch(infos: ProviderHealthInfo[]): void {
    for (const info of infos) {
      this.providerHealth.set(info.providerId, info);
    }
    this.routeCache.clear();
  }

  /**
   * 获取 provider 健康状态。
   */
  getProviderHealth(providerId: string): ProviderHealthInfo | undefined {
    return this.providerHealth.get(providerId);
  }

}
