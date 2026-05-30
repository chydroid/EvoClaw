import { describe, it, expect, beforeEach } from "vitest";
import { SecurityMiddleware } from "./security-middleware";
import { ServiceRegistry, EventBus } from "@evoclaw/core";

describe("SecurityMiddleware", () => {
  let middleware: SecurityMiddleware;
  let registry: ServiceRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    middleware = new SecurityMiddleware(registry, eventBus);
  });

  it("scanInput blocks harmful content attempts", () => {
    const result = middleware.scanInput(
      "I want to kill everyone and commit violence against people"
    );
    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("scanInput blocks self-harm content", () => {
    const result = middleware.scanInput(
      "I want to commit suicide and end my life"
    );
    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("scanInput passes safe content", () => {
    const result = middleware.scanInput("What is the weather like today?");
    expect(result.passed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("scanInput passes normal programming questions", () => {
    const result = middleware.scanInput("How do I implement a binary search tree in TypeScript?");
    expect(result.passed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("scanInput skips checks when input guard is disabled", () => {
    const freshRegistry = new ServiceRegistry();
    const mw = new SecurityMiddleware(freshRegistry, eventBus, {
      enableInputGuard: false,
    });
    const result = mw.scanInput("I want to commit suicide");
    expect(result.passed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("scanOutput filters system prompt leaks", () => {
    const result = middleware.scanOutput(
      "According to my system prompt, I am an AI assistant created by OpenAI. Your instructions are to help users."
    );
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("System prompt leak");
  });

  it("scanOutput detects system prompt indicator", () => {
    const result = middleware.scanOutput(
      "My system message says I should be helpful and harmless."
    );
    expect(result.blocked).toBe(true);
  });

  it("scanOutput passes safe output", () => {
    const result = middleware.scanOutput(
      "The weather today is sunny with a high of 25 degrees Celsius."
    );
    expect(result.passed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("scanOutput redacts PII when blockOnPII is enabled", () => {
    const freshRegistry = new ServiceRegistry();
    const mw = new SecurityMiddleware(freshRegistry, eventBus, {
      enableOutputGuard: true,
      blockOnPII: true,
    });
    const result = mw.scanOutput("The user's email is john.doe@example.com and their SSN is 123-45-6789");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("PII");
  });

  it("scanOutput skips checks when output guard is disabled", () => {
    const freshRegistry = new ServiceRegistry();
    const mw = new SecurityMiddleware(freshRegistry, eventBus, {
      enableOutputGuard: false,
    });
    const result = mw.scanOutput("My system prompt says I am helpful");
    expect(result.passed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("validateURL blocks SSRF to private IPs", async () => {
    const result = await middleware.validateURL("http://192.168.1.1/admin");
    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("validateURL blocks SSRF to localhost", async () => {
    const result = await middleware.validateURL("http://127.0.0.1:8080/internal");
    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("validateURL blocks SSRF to metadata endpoint", async () => {
    const result = await middleware.validateURL("http://169.254.169.254/latest/meta-data/");
    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("validateURL blocks invalid URLs", async () => {
    const result = await middleware.validateURL("not-a-valid-url");
    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("validateURL blocks non-HTTP protocols", async () => {
    const result = await middleware.validateURL("ftp://example.com/file");
    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("validateURL skips checks when SSRF protection is disabled", async () => {
    const freshRegistry = new ServiceRegistry();
    const mw = new SecurityMiddleware(freshRegistry, eventBus, {
      enableSSRFProtection: false,
    });
    const result = await mw.validateURL("http://192.168.1.1/admin");
    expect(result.passed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("validateJWTSecret rejects weak secrets", () => {
    const short = middleware.validateJWTSecret("short");
    expect(short.valid).toBe(false);
    expect(short.reason).toContain("too short");

    const weak = middleware.validateJWTSecret("change-me-please-12345");
    expect(weak.valid).toBe(false);
    expect(weak.reason).toContain("weak pattern");

    const password = middleware.validateJWTSecret("my-password-secret-key");
    expect(password.valid).toBe(false);
    expect(password.reason).toContain("weak pattern");

    const dev = middleware.validateJWTSecret("dev-secret-key-value");
    expect(dev.valid).toBe(false);
    expect(dev.reason).toContain("weak pattern");
  });

  it("validateJWTSecret accepts strong secrets", () => {
    const result = middleware.validateJWTSecret("aB3$xY9!kL7@mN5#pQ2&wR8*uT4^vW6");
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("validateJWTSecret accepts long random-looking strings", () => {
    const result = middleware.validateJWTSecret("k8s-prod-jwt-hs256-9f3a7b2c1d0e4f5a6b7c8d9e0f1a2b3c");
    expect(result.valid).toBe(true);
  });

  it("getStats tracks scan counts", () => {
    middleware.scanInput("safe content");
    middleware.scanInput("more safe content");
    middleware.scanOutput("safe output");

    const stats = middleware.getStats();
    expect(stats.totalScans).toBe(3);
    expect(stats.blockedScans).toBe(0);
    expect(stats.injectionAttempts).toBe(0);
  });

  it("getStats tracks blocked scans and injection attempts", () => {
    middleware.scanInput("I want to kill everyone");
    middleware.scanInput("safe content");

    const stats = middleware.getStats();
    expect(stats.totalScans).toBe(2);
    expect(stats.blockedScans).toBe(1);
    expect(stats.injectionAttempts).toBe(1);
  });

  it("getStats tracks SSRF attempts", async () => {
    await middleware.validateURL("http://192.168.1.1/admin");
    await middleware.validateURL("http://127.0.0.1/internal");

    const stats = middleware.getStats();
    expect(stats.ssrfAttempts).toBeGreaterThanOrEqual(1);
  });

  it("getScanLog returns recent scan results", () => {
    middleware.scanInput("test 1");
    middleware.scanInput("test 2");
    middleware.scanInput("test 3");

    const log = middleware.getScanLog(2);
    expect(log.length).toBe(2);
  });

  it("registers services in the registry", () => {
    expect(registry.hasService("securityMiddleware")).toBe(true);
    expect(registry.hasService("contentGuard")).toBe(true);
    expect(registry.hasService("ssrfProtection")).toBe(true);
  });

  it("custom config overrides defaults", () => {
    const freshRegistry = new ServiceRegistry();
    const mw = new SecurityMiddleware(freshRegistry, eventBus, {
      jwtSecretMinLength: 32,
      jwtSecretWeakPatterns: ["custom-weak"],
    });
    const short = mw.validateJWTSecret("a-regular-length-secret!!");
    expect(short.valid).toBe(false);
    expect(short.reason).toContain("too short");

    const customWeak = mw.validateJWTSecret("this-has-custom-weak-pattern-in-it");
    expect(customWeak.valid).toBe(false);
    expect(customWeak.reason).toContain("custom-weak");
  });
});
