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

  it("route downgrades casual chat", () => {
    const result = router.route(
      "Hello, how are you?",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
    expect(result.routedModel).toBe("gpt-4o-mini");
    expect(result.routedProvider).toBe("openai");
    expect(result.originalModel).toBe("claude-3-opus");
  });

  it("route downgrades Chinese casual chat with custom rule", () => {
    router.addRule({
      pattern: /^你好/i,
      targetModel: "gpt-4o-mini",
      targetProvider: "openai",
      description: "Chinese greeting",
    });
    const result = router.route(
      "你好",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
  });

  it("route downgrades simple greeting", () => {
    const result = router.route(
      "Hey what's up?",
      "gpt-4o",
      "openai"
    );
    expect(result.shouldDowngrade).toBe(true);
  });

  it("route downgrades simple formatting", () => {
    const result = router.route(
      "Format this text as a bullet list",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
    expect(result.routedModel).toBe("gpt-4o-mini");
  });

  it("route downgrades summarize in one sentence", () => {
    const result = router.route(
      "Summarize in one sentence: the quick brown fox",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
  });

  it("route downgrades translation tasks", () => {
    const result = router.route(
      "Translate this to French: Hello world",
      "gpt-4o",
      "openai"
    );
    expect(result.shouldDowngrade).toBe(true);
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
      targetModel: "gpt-4o-mini",
      targetProvider: "openai",
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
      targetModel: "gpt-4o-mini",
      targetProvider: "openai",
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
    const initialRules = router.getRules();
    const rulePattern = initialRules[0].pattern;
    const patternSource = typeof rulePattern === "string" ? rulePattern : rulePattern.source;

    const removed = router.removeRule(patternSource);
    expect(removed).toBe(true);
    expect(router.getRules().length).toBe(initialRules.length - 1);
  });

  it("removeRule returns false for non-existent pattern", () => {
    const removed = router.removeRule("non-existent-pattern-xyz");
    expect(removed).toBe(false);
  });

  it("getRules returns all current rules", () => {
    const rules = router.getRules();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0]).toHaveProperty("pattern");
    expect(rules[0]).toHaveProperty("targetModel");
    expect(rules[0]).toHaveProperty("targetProvider");
    expect(rules[0]).toHaveProperty("description");
  });

  it("custom default model and provider are used for low-value tasks", () => {
    const customRouter = new CopilotRouter({
      defaultModel: "custom-mini",
      defaultProvider: "custom-provider",
    });
    const result = customRouter.route(
      "What is the capital of France?",
      "claude-3-opus",
      "anthropic"
    );
    expect(result.shouldDowngrade).toBe(true);
    expect(result.routedModel).toBe("custom-mini");
    expect(result.routedProvider).toBe("custom-provider");
  });

  it("custom rules override default rules", () => {
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
});
