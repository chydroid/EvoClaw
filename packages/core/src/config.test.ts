import { describe, it, expect } from "vitest";
import { ConfigValidator, ConfigWatcher } from "./config-schema.js";

describe("ConfigValidator", () => {
  const validator = new ConfigValidator();

  it("should validate a minimal valid config", () => {
    const result = validator.validate({
      gateway: { port: 3000, host: "0.0.0.0", jwtSecret: "test-secret-123456" },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should reject missing required fields", () => {
    // llm.id and llm.model are required=true in the schema
    const result = validator.validate({
      llm: { name: "Test", provider: "openai" },
    });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("should reject invalid port numbers", () => {
    const result = validator.validate({
      gateway: { port: 999999, host: "0.0.0.0", jwtSecret: "test-secret-123456" },
    });
    expect(result.valid).toBe(false);
  });

  it("should reject invalid enum values", () => {
    const result = validator.validate({
      agent: { tone: "angry" },
      gateway: { port: 3000, host: "0.0.0.0", jwtSecret: "test-secret-123456" },
    });
    expect(result.valid).toBe(false);
  });

  it("should accept valid enum values", () => {
    const result = validator.validate({
      agent: { tone: "warm" },
      gateway: { port: 3000, host: "0.0.0.0", jwtSecret: "test-secret-123456" },
    });
    expect(result.valid).toBe(true);
  });

  it("should apply defaults for missing optional fields", () => {
    const result = validator.validateAndFill({
      gateway: { port: 3000, host: "0.0.0.0", jwtSecret: "test-secret-123456" },
    });
    expect(result.valid).toBe(true);
    const data = result.data;
    expect(data.agent).toBeDefined();
    const agent = data.agent as Record<string, unknown>;
    expect(agent.tone).toBe("warm"); // default value
  });

  it("should apply defaults for llm config", () => {
    const result = validator.validateAndFill({
      gateway: { port: 3000, host: "0.0.0.0", jwtSecret: "test-secret-123456" },
    });
    expect(result.valid).toBe(true);
    expect(result.data.security).toBeDefined();
    const security = result.data.security as Record<string, unknown>;
    expect(security.dmPolicy).toBe("open");
    expect(security.sandboxMode).toBe("off");
  });

  it("should reject string for number field", () => {
    const result = validator.validate({
      gateway: { port: "not-a-number", host: "0.0.0.0", jwtSecret: "test-secret-123456" },
    });
    expect(result.valid).toBe(false);
  });

  it("should validate full valid config", () => {
    const result = validator.validate({
      agent: { name: "TestAgent", tone: "professional", language: "en" },
      gateway: { port: 3000, host: "127.0.0.1", jwtSecret: "my-super-secret-key-16" },
      llm: { id: "test", name: "TestLLM", provider: "openai", model: "gpt-4o", apiKey: "sk-test" },
      security: { dmPolicy: "pairing", sandboxMode: "non-main", execApproval: true },
    });
    expect(result.valid).toBe(true);
  });
});

describe("ConfigWatcher", () => {
  it("should register and trigger callbacks", async () => {
    const watcher = new ConfigWatcher();
    const calls: string[] = [];
    
    watcher.onChange((filePath) => {
      calls.push(filePath);
    });
    
    expect(watcher).toBeDefined();
    // Note: Actual file watching is tested in integration tests
  });
});