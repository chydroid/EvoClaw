import { describe, it, expect } from "vitest";

// Re-export test - validate config schema types are importable
describe("ConfigSchema types", () => {
  it("should export CONFIG_SCHEMA", async () => {
    const mod = await import("./config-schema.js");
    expect(mod.CONFIG_SCHEMA).toBeDefined();
    expect(mod.CONFIG_SCHEMA.gateway).toBeDefined();
    expect(mod.CONFIG_SCHEMA.agent).toBeDefined();
    expect(mod.CONFIG_SCHEMA.llm).toBeDefined();
    expect(mod.CONFIG_SCHEMA.security).toBeDefined();
  });

  it("should export ConfigValidator class", async () => {
    const mod = await import("./config-schema.js");
    expect(mod.ConfigValidator).toBeDefined();
    const validator = new mod.ConfigValidator();
    expect(typeof validator.validate).toBe("function");
    expect(typeof validator.validateAndFill).toBe("function");
  });

  it("should export ConfigWatcher class", async () => {
    const mod = await import("./config-schema.js");
    expect(mod.ConfigWatcher).toBeDefined();
    const watcher = new mod.ConfigWatcher();
    expect(typeof watcher.watch).toBe("function");
    expect(typeof watcher.onChange).toBe("function");
    expect(typeof watcher.stopAll).toBe("function");
  });

  it("should export ValidationError", async () => {
    const mod = await import("./config-schema.js");
    expect(mod.ValidationError).toBeDefined();
  });
});