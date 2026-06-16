import { describe, it, expect, beforeEach } from "vitest";
import { CopilotRouter } from "./copilot-router";

describe("CopilotRouter", () => {
  let router: CopilotRouter;

  beforeEach(() => {
    router = new CopilotRouter();
  });

  it("route keeps original model for code tasks", () => {
    const result = router.route(
      "Write a function to sort an array using quicksort",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(false);
    expect(result.routedModel).toBe("claude-3-opus");
    expect(result.routedProvider).toBe("anthropic");
    expect(result.reason).toContain("full model");
  });

  it("route keeps original model for debug tasks", () => {
    const result = router.route(
      "Debug this runtime error in my Express server",
      "gpt-4o",
      "openai"
    );
    expect(result.shouldDowngrade).toBe(false);
    expect(result.routedModel).toBe("gpt-4o");
  });

  it("route keeps original model for API-related tasks", () => {
    const result = router.route(
      "Create a REST API endpoint for user authentication",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(false);
  });

  it("route keeps original model for math tasks", () => {
    const result = router.route(
      "Calculate the integral of x^2 from 0 to 10",
      "gpt-4o",
      "openai"
    );
    expect(result.shouldDowngrade).toBe(false);
    expect(result.routedModel).toBe("gpt-4o");
    expect(result.reason).toContain("full model");
  });

  it("route keeps original model for equation solving", () => {
    const result = router.route(
      "Solve the differential equation dy/dx = 2x",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(false);
  });

  it("route keeps original model for matrix operations", () => {
    const result = router.route(
      "Compute the eigenvalues of this matrix",
      "gpt-4o",
      "openai"
    );
    expect(result.shouldDowngrade).toBe(false);
  });

  it("route downgrades casual chat to first enabled user provider", () => {
    const customRouter = new CopilotRouter({
      userProviders: [
        { id: "deepseek", name: "DeepSeek", enabled: true, order: 1, selectedModel: "deepseek-chat", baseURL: "https://api.deepseek.com" },
        { id: "openai", name: "OpenAI", enabled: false, order: 2, selectedModel: "gpt-4o", baseURL: "https://api.openai.com/v1" },
      ],
    });
    const result = customRouter.route(
      "Hello, how are you?",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
    expect(result.routedModel).toBe("deepseek-chat");
    expect(result.routedProvider).toBe("deepseek");
    expect(result.originalModel).toBe("claude-3-opus");
  });

  it("route downgrades Chinese casual chat with custom rule", () => {
    router.addRule({
      pattern: /^你好/i,
      targetModel: "deepseek-chat",
      targetProvider: "deepseek",
      description: "Chinese greeting",
    });
    const result = router.route(
      "你好",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
  });

  it("route downgrades simple greeting to user provider", () => {
    const customRouter = new CopilotRouter({
      userProviders: [
        { id: "mimo", name: "Mimo", enabled: true, order: 1, selectedModel: "mimo-v2.5", baseURL: "https://token-plan-cn.xiaomimimo.com/v1" },
      ],
    });
    const result = customRouter.route(
      "Hey what's up?",
      "gpt-4o",
      "openai"
    );
    expect(result.shouldDowngrade).toBe(true);
    expect(result.routedProvider).toBe("mimo");
  });

  it("route downgrades simple formatting to user provider", () => {
    const customRouter = new CopilotRouter({
      userProviders: [
        { id: "deepseek", name: "DeepSeek", enabled: true, order: 1, selectedModel: "deepseek-chat", baseURL: "https://api.deepseek.com" },
      ],
    });
    const result = customRouter.route(
      "Format this text as a bullet list",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
    expect(result.routedModel).toBe("deepseek-chat");
  });

  it("route downgrades summarize in one sentence", () => {
    const customRouter = new CopilotRouter({
      userProviders: [
        { id: "deepseek", name: "DeepSeek", enabled: true, order: 1, selectedModel: "deepseek-chat", baseURL: "https://api.deepseek.com" },
      ],
    });
    const result = customRouter.route(
      "Summarize in one sentence: the quick brown fox",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
  });

  it("route downgrades translation tasks", () => {
    const customRouter = new CopilotRouter({
      userProviders: [
        { id: "deepseek", name: "DeepSeek", enabled: true, order: 1, selectedModel: "deepseek-chat", baseURL: "https://api.deepseek.com" },
      ],
    });
    const result = customRouter.route(
      "Translate this to French: Hello world",
      "gpt-4o",
      "openai"
    );
    expect(result.shouldDowngrade).toBe(true);
  });

  it("simple task without user providers keeps current model", () => {
    // No user providers configured — no downgrade target
    const result = router.route(
      "Hello, how are you?",
      "claude-3-opus",
      "anthropic"
    );
    // Local model not available, no user providers → keeps current
    expect(result.shouldDowngrade).toBe(false);
    expect(result.routedModel).toBe("claude-3-opus");
  });

  it("route does not downgrade when disabled", () => {
    const disabledRouter = new CopilotRouter({ enabled: false });
    const result = disabledRouter.route(
      "Hello, how are you?",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(false);
    expect(result.routedModel).toBe("claude-3-opus");
    expect(result.reason).toContain("disabled");
  });

  it("route does not downgrade for unknown tasks that are not low-value", () => {
    const result = router.route(
      "Analyze the competitive landscape of the EV market in Southeast Asia",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(false);
    expect(result.reason).toContain("No routing rule");
  });

  it("addRule adds a custom routing rule", () => {
    router.addRule({
      pattern: /^generate haiku/i,
      targetModel: "deepseek-chat",
      targetProvider: "deepseek",
      description: "Haiku generation",
    });

    const result = router.route(
      "Generate haiku about spring",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
    expect(result.reason).toContain("Haiku generation");
  });

  it("addRule with string pattern", () => {
    router.addRule({
      pattern: "^tell me a joke",
      targetModel: "deepseek-chat",
      targetProvider: "deepseek",
      description: "Joke requests",
    });

    const result = router.route(
      "Tell me a joke about programming",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
  });

  it("removeRule removes an existing rule", () => {
    router.addRule({
      pattern: /^test rule/i,
      targetModel: "deepseek-chat",
      targetProvider: "deepseek",
      description: "Test rule for removal",
    });
    const initialRules = router.getRules();
    expect(initialRules.length).toBe(1);

    // RegExp.source for /^test rule/i is "^test rule"
    const removed = router.removeRule("^test rule");
    expect(removed).toBe(true);
    expect(router.getRules().length).toBe(0);
  });

  it("removeRule returns false for non-existent pattern", () => {
    const removed = router.removeRule("non-existent-pattern-xyz");
    expect(removed).toBe(false);
  });

  it("getRules returns all current rules", () => {
    router.addRule({
      pattern: /^test/i,
      targetModel: "deepseek-chat",
      targetProvider: "deepseek",
      description: "Test rule",
    });
    const rules = router.getRules();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0]).toHaveProperty("pattern");
    expect(rules[0]).toHaveProperty("targetModel");
    expect(rules[0]).toHaveProperty("targetProvider");
    expect(rules[0]).toHaveProperty("description");
  });

  it("user providers are used in order for simple tasks", () => {
    const customRouter = new CopilotRouter({
      userProviders: [
        { id: "mimo", name: "Mimo", enabled: true, order: 1, selectedModel: "mimo-v2.5", baseURL: "https://token-plan-cn.xiaomimimo.com/v1" },
        { id: "deepseek", name: "DeepSeek", enabled: true, order: 2, selectedModel: "deepseek-chat", baseURL: "https://api.deepseek.com" },
        { id: "openai", name: "OpenAI", enabled: false, order: 3, selectedModel: "gpt-4o", baseURL: "https://api.openai.com/v1" },
      ],
    });
    const result = customRouter.route(
      "Hello",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
    // First enabled provider is Mimo (order 1), not OpenAI (disabled)
    expect(result.routedProvider).toBe("mimo");
    expect(result.routedModel).toBe("mimo-v2.5");
  });

  it("custom rules override default routing", () => {
    const customRouter = new CopilotRouter({
      rules: [
        {
          pattern: /^hello/i,
          targetModel: "custom-model",
          targetProvider: "custom-provider",
          description: "Custom hello rule",
        },
      ],
    });
    const result = customRouter.route(
      "Hello there",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
    expect(result.routedModel).toBe("custom-model");
  });

  it("preserves original model and provider in routing decision", () => {
    const result = router.route(
      "Hello",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.originalModel).toBe("claude-3-opus");
    expect(result.originalProvider).toBe("anthropic");
  });

  it("updateUserProviders updates provider list", () => {
    router.updateUserProviders([
      { id: "deepseek", name: "DeepSeek", enabled: true, order: 1, selectedModel: "deepseek-chat", baseURL: "https://api.deepseek.com" },
    ]);
    const result = router.route(
      "你好",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
    expect(result.routedProvider).toBe("deepseek");
  });

  it("does not default to GPT-4o for simple tasks", () => {
    const customRouter = new CopilotRouter({
      userProviders: [
        { id: "deepseek", name: "DeepSeek", enabled: true, order: 1, selectedModel: "deepseek-chat", baseURL: "https://api.deepseek.com" },
        { id: "openai", name: "OpenAI", enabled: true, order: 2, selectedModel: "gpt-4o", baseURL: "https://api.openai.com/v1" },
      ],
    });
    const result = customRouter.route(
      "Hello",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
    // Should route to DeepSeek (order 1), NOT OpenAI/GPT-4o (order 2)
    expect(result.routedProvider).toBe("deepseek");
    expect(result.routedModel).toBe("deepseek-chat");
  });
});
