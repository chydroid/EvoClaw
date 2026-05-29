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
}

export interface RoutingDecision {
  shouldDowngrade: boolean;
  originalModel: string;
  originalProvider: string;
  routedModel: string;
  routedProvider: string;
  reason: string;
}

const DEFAULT_RULES: CopilotRouteRule[] = [
  {
    pattern: /^(你好|hello|hi|hey|how are you|what'?s up|good morning|good afternoon|good evening|sup|yo)\b/i,
    targetModel: "gpt-4o-mini",
    targetProvider: "openai",
    description: "Casual chat",
  },
  {
    pattern: /^(format this|convert to|summarize in one sentence|reformat|rewrite as|change to)\b/i,
    targetModel: "gpt-4o-mini",
    targetProvider: "openai",
    description: "Simple formatting",
  },
  {
    pattern: /^(translate|spell|what time|what date|what day|convert .* to)\b/i,
    targetModel: "gpt-4o-mini",
    targetProvider: "openai",
    description: "Translation and simple lookup",
  },
];

const CODE_PATTERNS: RegExp[] = [
  /^(write|create|implement|build|fix|debug|refactor|code|program|develop|deploy)\b/i,
  /\b(function|class|method|api|endpoint|module|component|algorithm|sql|regex)\b/i,
  /\b(bug|error|exception|stack trace|compile|runtime|syntax error)\b/i,
];

const MATH_PATTERNS: RegExp[] = [
  /^(calculate|solve|compute|prove|derive|evaluate|simplify)\b/i,
  /\b(equation|theorem|integral|derivative|matrix|polynomial|logarithm)\b/i,
];

export class CopilotRouter {
  private config: CopilotRouterConfig;

  constructor(config?: Partial<CopilotRouterConfig>) {
    this.config = {
      enabled: config?.enabled ?? true,
      defaultModel: config?.defaultModel ?? "gpt-4o-mini",
      defaultProvider: config?.defaultProvider ?? "openai",
      rules: config?.rules ?? [...DEFAULT_RULES],
    };
  }

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

    const matchedRule = this.matchRule(taskDescription);

    if (matchedRule) {
      return {
        shouldDowngrade: true,
        originalModel: currentModel,
        originalProvider: currentProvider,
        routedModel: matchedRule.targetModel,
        routedProvider: matchedRule.targetProvider,
        reason: `Matched rule: ${matchedRule.description}`,
      };
    }

    if (this.isLowValueTask(taskDescription)) {
      return {
        shouldDowngrade: true,
        originalModel: currentModel,
        originalProvider: currentProvider,
        routedModel: this.config.defaultModel,
        routedProvider: this.config.defaultProvider,
        reason: "Low-value task detected",
      };
    }

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

  private isLowValueTask(taskDescription: string): boolean {
    const lower = taskDescription.toLowerCase().trim();

    const casualChatPatterns = [
      /^(你好|hello|hi|hey|how are you|what'?s up|sup|yo)\b/i,
      /^(good morning|good afternoon|good evening|good night)\b/i,
      /^(tell me about|what is|who is|who are|where is|when is|why is)\b/i,
    ];

    const formattingPatterns = [
      /^(format this|convert to|summarize in one sentence|reformat|rewrite as)\b/i,
    ];

    const lookupPatterns = [
      /^(what time|what date|what day|translate|spell|define)\b/i,
    ];

    for (const p of casualChatPatterns) {
      if (p.test(lower)) return true;
    }
    for (const p of formattingPatterns) {
      if (p.test(lower)) return true;
    }
    for (const p of lookupPatterns) {
      if (p.test(lower)) return true;
    }

    return false;
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

  private isCodeTask(taskDescription: string): boolean {
    return CODE_PATTERNS.some((p) => p.test(taskDescription));
  }

  private isMathTask(taskDescription: string): boolean {
    return MATH_PATTERNS.some((p) => p.test(taskDescription));
  }
}
