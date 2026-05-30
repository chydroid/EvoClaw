import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContextEngine } from "./context-engine";
import * as fs from "fs";
import * as crypto from "crypto";

vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe("ContextEngine", () => {
  let engine: ContextEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new ContextEngine({
      workspacePath: "/tmp/test-workspace",
      maxContextTokens: 60000,
      reserveTokens: 4000,
      promptMode: "full",
    });
  });

  const makeInput = (overrides?: Partial<import("./context-engine").ContextAssemblyInput>) => ({
    conversationHistory: [],
    systemPrompt: "You are a helpful assistant.",
    ...overrides,
  });

  it("buildFrozenPrefix returns cached result when content unchanged", () => {
    const input = makeInput();
    const first = engine.buildFrozenPrefix(input);
    const second = engine.buildFrozenPrefix(input);
    expect(first.hash).toBe(second.hash);
    expect(first).toBe(second);
  });

  it("buildFrozenPrefix rebuilds when content changes after invalidateFrozen", () => {
    const input1 = makeInput({ systemPrompt: "System A" });
    const first = engine.buildFrozenPrefix(input1);
    engine.invalidateFrozen();
    const input2 = makeInput({ systemPrompt: "System B" });
    const second = engine.buildFrozenPrefix(input2);
    expect(first.hash).not.toBe(second.hash);
    expect(first.content).not.toBe(second.content);
  });

  it("buildEphemeralSuffix includes timezone and platform hint", () => {
    const engineWithHints = new ContextEngine({
      workspacePath: "/tmp/test-workspace",
      timezone: "Asia/Singapore",
      timeFormat: "24",
      platformHint: "linux",
    });
    const input = makeInput();
    const suffix = engineWithHints.buildEphemeralSuffix(input);
    expect(suffix).toContain("Asia/Singapore");
    expect(suffix).toContain("24h format");
    expect(suffix).toContain("Platform: linux");
  });

  it("assembleContext returns LayeredContextResult with frozenHash", () => {
    const input = makeInput();
    const result = engine.assembleContext(input);
    expect(result.frozenHash).toBeDefined();
    expect(typeof result.frozenHash).toBe("string");
    expect(result.frozenHash.length).toBe(64);
    expect(result.frozenContent).toBeDefined();
    expect(result.ephemeralContent).toBeDefined();
  });

  it("cache control annotations are present", () => {
    const input = makeInput();
    const result = engine.assembleContext(input);
    expect(result.cacheControlAnnotations).toBeDefined();
    expect(result.cacheControlAnnotations.length).toBeGreaterThan(0);
    expect(result.cacheControlAnnotations[0].role).toBe("system");
    expect(result.cacheControlAnnotations[0].cache_control).toBeDefined();
    expect(result.cacheControlAnnotations[0].cache_control.type).toBe("ephemeral");
  });

  it("getFrozenHash returns null initially, then returns hash after build", () => {
    expect(engine.getFrozenHash()).toBeNull();
    const input = makeInput();
    engine.buildFrozenPrefix(input);
    const hash = engine.getFrozenHash();
    expect(hash).not.toBeNull();
    expect(typeof hash).toBe("string");
    expect(hash!.length).toBe(64);
  });

  it("assembleContext still works without using new methods directly", () => {
    const input = makeInput({
      conversationHistory: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
      systemPrompt: "You are helpful.",
    });
    const result = engine.assembleContext(input);
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    expect(result.tokenEstimate).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
    expect(result.warnings).toBeDefined();
    expect(result.loadedBootstrapFiles).toBeDefined();
  });

  it("token estimation still works", () => {
    expect(engine.estimateTokens("")).toBe(0);
    expect(engine.estimateTokens("hello")).toBe(2);
    expect(engine.estimateTokens("a".repeat(100))).toBe(25);
    expect(engine.estimateTokens("This is a test sentence.")).toBe(6);
  });

  it("buildEphemeralSuffix includes currentTask when provided", () => {
    const engineWithHints = new ContextEngine({
      workspacePath: "/tmp/test-workspace",
      timezone: "UTC",
    });
    const input = makeInput({ currentTask: "Fix the login bug" });
    const suffix = engineWithHints.buildEphemeralSuffix(input);
    expect(suffix).toContain("Fix the login bug");
  });

  it("buildEphemeralSuffix returns empty string when no hints configured", () => {
    const bareEngine = new ContextEngine({
      workspacePath: "/tmp/test-workspace",
    });
    const input = makeInput();
    const suffix = bareEngine.buildEphemeralSuffix(input);
    expect(suffix).toBe("");
  });

  it("assembleContext truncates history when context limit is exceeded", () => {
    const smallEngine = new ContextEngine({
      workspacePath: "/tmp/test-workspace",
      maxContextTokens: 100,
      reserveTokens: 10,
    });
    const longHistory = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "This is a somewhat long message that takes up tokens. ".repeat(10),
    }));
    const input = makeInput({
      conversationHistory: longHistory,
      systemPrompt: "You are helpful.",
    });
    const result = smallEngine.assembleContext(input);
    expect(result.truncated).toBe(true);
    expect(result.messages.length).toBeLessThan(longHistory.length + 1);
  });

  it("needsCompaction returns true when context is large", () => {
    const smallEngine = new ContextEngine({
      workspacePath: "/tmp/test-workspace",
      maxContextTokens: 100,
    });
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: "This is a message that adds to the token count significantly. ".repeat(5),
    }));
    expect(smallEngine.needsCompaction(history, "system prompt")).toBe(true);
  });

  it("needsCompaction returns false when context is small", () => {
    const history = [{ role: "user", content: "Hi" }];
    expect(engine.needsCompaction(history, "system")).toBe(false);
  });

  it("getAvailableTokens returns correct remaining tokens", () => {
    const available = engine.getAvailableTokens("short text");
    expect(available).toBeGreaterThan(0);
    expect(available).toBeLessThan(engine.getConfig().maxContextTokens);
  });

  it("updateConfig changes configuration", () => {
    engine.updateConfig({ maxContextTokens: 100000 });
    expect(engine.getConfig().maxContextTokens).toBe(100000);
  });

  it("estimateMessagesTokens accounts for role overhead", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const tokens = engine.estimateMessagesTokens(messages);
    const rawTokens = engine.estimateTokens("Hello") + engine.estimateTokens("Hi");
    expect(tokens).toBe(rawTokens + 8);
  });
});
