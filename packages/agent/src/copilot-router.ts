/**
 * CopilotRouter — 智能任务路由器
 *
 * 根据任务复杂度将请求路由到合适的模型：
 * 1. 简单任务（问候、翻译、格式化）→ 本地模型（如已安装）→ 省Token
 * 2. 复杂任务（代码、推理）→ 远程API（按用户配置的Provider顺序）
 *
 * 关键原则：
 * - 本地模型不可用时，不阻塞，正常路由到远程API
 * - 远程API按用户LLM配置的Provider顺序调用，不默认GPT-4o
 * - 优先使用用户配置的第一个已启用的Provider
 */

import { getLocalLLMService, LOCAL_MODEL_INFO } from "./local-llm-service";

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
  useLocalModel: boolean;
  originalModel: string;
  originalProvider: string;
  routedModel: string;
  routedProvider: string;
  reason: string;
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

export class CopilotRouter {
  private config: CopilotRouterConfig;

  constructor(config?: Partial<CopilotRouterConfig>) {
    this.config = {
      enabled: config?.enabled ?? true,
      defaultModel: config?.defaultModel ?? "",
      defaultProvider: config?.defaultProvider ?? "",
      rules: config?.rules ?? [],
      userProviders: config?.userProviders ?? [],
    };
  }

  /**
   * 核心路由决策
   */
  route(taskDescription: string, currentModel: string, currentProvider: string): RoutingDecision {
    if (!this.config.enabled) {
      return {
        shouldDowngrade: false,
        useLocalModel: false,
        originalModel: currentModel,
        originalProvider: currentProvider,
        routedModel: currentModel,
        routedProvider: currentProvider,
        reason: "Copilot routing is disabled",
      };
    }

    // Complex tasks always use full remote model
    if (this.isCodeTask(taskDescription) || this.isMathTask(taskDescription)) {
      return {
        shouldDowngrade: false,
        useLocalModel: false,
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
      const localService = getLocalLLMService();
      // If rule targets a "cheap" model and local is available, prefer local
      if (localService.isAvailable() && this.isCheapModelTarget(matchedRule.targetModel)) {
        return {
          shouldDowngrade: true,
          useLocalModel: true,
          originalModel: currentModel,
          originalProvider: currentProvider,
          routedModel: LOCAL_MODEL_INFO.name,
          routedProvider: "local",
          reason: `Matched rule "${matchedRule.description}" → local model`,
        };
      }

      return {
        shouldDowngrade: true,
        useLocalModel: false,
        originalModel: currentModel,
        originalProvider: currentProvider,
        routedModel: matchedRule.targetModel,
        routedProvider: matchedRule.targetProvider,
        reason: `Matched rule: ${matchedRule.description}`,
      };
    }

    // Check if simple task that can use local model
    if (this.isSimpleTask(taskDescription)) {
      const localService = getLocalLLMService();
      if (localService.isAvailable()) {
        return {
          shouldDowngrade: true,
          useLocalModel: true,
          originalModel: currentModel,
          originalProvider: currentProvider,
          routedModel: LOCAL_MODEL_INFO.name,
          routedProvider: "local",
          reason: "Simple task → local model (saving tokens)",
        };
      }

      // Local model not available, route to first enabled user provider
      const fallback = this.getFirstEnabledProvider(currentModel, currentProvider);
      return {
        shouldDowngrade: fallback.shouldDowngrade,
        useLocalModel: false,
        originalModel: currentModel,
        originalProvider: currentProvider,
        routedModel: fallback.model,
        routedProvider: fallback.provider,
        reason: `Simple task → ${fallback.provider}/${fallback.model} (local model not installed)`,
      };
    }

    // Default: no routing change
    return {
      shouldDowngrade: false,
      useLocalModel: false,
      originalModel: currentModel,
      originalProvider: currentProvider,
      routedModel: currentModel,
      routedProvider: currentProvider,
      reason: "No routing rule matched",
    };
  }

  /**
   * 使用本地模型生成回复
   */
  async generateLocal(prompt: string): Promise<string> {
    const localService = getLocalLLMService();
    if (!localService.isAvailable()) {
      throw new Error("Local model is not available");
    }

    const systemPrompt = "你是一个简洁的AI助手。请用简短、准确的方式回答。不要使用markdown格式。";
    return localService.generate(prompt, systemPrompt);
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
      const regex = typeof rule.pattern === "string"
        ? new RegExp(rule.pattern, "i")
        : rule.pattern;
      if (regex.test(taskDescription)) {
        return rule;
      }
    }
    return null;
  }

  /**
   * 判断目标模型是否是"便宜"模型（可被本地模型替代）
   */
  private isCheapModelTarget(model: string): boolean {
    const cheapModels = [
      "gpt-4o-mini", "gpt-3.5-turbo", "gpt-4.1-nano",
      "claude-haiku", "deepseek-v4-flash", "deepseek-chat",
      "qwen3.5-0.8b", "qwen3.5-2b",  // Local models are cheap
    ];
    return cheapModels.some(m => model.toLowerCase().includes(m));
  }

  /**
   * 获取第一个已启用的用户Provider
   * 不默认GPT-4o，严格按用户配置顺序
   */
  private getFirstEnabledProvider(currentModel: string, currentProvider: string): {
    model: string;
    provider: string;
    shouldDowngrade: boolean;
  } {
    const providers = this.config.userProviders;
    if (providers && providers.length > 0) {
      const sorted = [...providers].sort((a, b) => a.order - b.order);
      const first = sorted.find(p => p.enabled);
      if (first) {
        return {
          model: first.selectedModel,
          provider: first.id,
          shouldDowngrade: first.id !== currentProvider,
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
}
