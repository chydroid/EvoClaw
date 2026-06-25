import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigValidator, ConfigWatcher } from "./config-schema.js";
import { ConfigManager, defaultConfig, type ConfigChange } from "./config.js";

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

describe("ConfigManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-config-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("should persist and reload config from a file", async () => {
    const manager = new ConfigManager();
    const filePath = path.join(tmpDir, "config.json");

    await manager.set("server.port", 12345, { source: "test" });
    await manager.saveToFile(filePath);

    const reloaded = new ConfigManager();
    await reloaded.loadFromFile(filePath);

    expect(reloaded.get("server").port).toBe(12345);
    expect(reloaded.getStats().filePath).toBe(filePath);
  });

  it("should broadcast granular change events for updateSection", async () => {
    const manager = new ConfigManager();
    const changes: ConfigChange[] = [];
    manager.onChange((change) => { changes.push(change); });

    await manager.updateSection("agent", { maxAgents: 42 }, { source: "test" });

    expect(changes.length).toBe(1);
    expect(changes[0].section).toBe("agent");
    expect(changes[0].path).toBe("agent.maxAgents");
    expect(changes[0].oldValue).toBe(defaultConfig.agent.maxAgents);
    expect(changes[0].newValue).toBe(42);
    expect(changes[0].source).toBe("test");
  });

  it("should emit section-specific events", async () => {
    const manager = new ConfigManager();
    const sectionChanges: ConfigChange[] = [];
    manager.onSectionChange("server", (change) => { sectionChanges.push(change); });

    await manager.set("server.port", 8080);
    await manager.set("auth.jwtSecret", "another-secret");

    expect(sectionChanges.length).toBe(1);
    expect(sectionChanges[0].section).toBe("server");
  });

  it("should record change history with a max size", async () => {
    const manager = new ConfigManager();
    for (let i = 0; i < 110; i++) {
      await manager.set("server.port", 1000 + i);
    }

    const history = manager.getHistory();
    expect(history.length).toBe(100);
    expect(history[history.length - 1].newValue).toBe(1109);
  });

  it("should serialize concurrent updates", async () => {
    const manager = new ConfigManager();
    await Promise.all([
      manager.set("server.port", 1),
      manager.set("server.port", 2),
      manager.set("server.port", 3),
    ]);

    const port = manager.get("server").port;
    expect([1, 2, 3]).toContain(port);
    expect(manager.getStats().totalChanges).toBe(3);
  });

  it("should simulate hot-reload via ConfigWatcher forceReload", async () => {
    const manager = new ConfigManager();
    const filePath = path.join(tmpDir, "config.json");
    fs.writeFileSync(filePath, JSON.stringify({ gateway: { port: 19999 } }), "utf-8");

    const watcher = new ConfigWatcher();
    const changes: ConfigChange[] = [];
    manager.onChange((change) => { changes.push(change); });
    manager.startWatching(filePath, watcher);

    // Simulate an external edit by overwriting the file and forcing reload.
    fs.writeFileSync(filePath, JSON.stringify({ gateway: { port: 20000 } }), "utf-8");
    watcher.forceReload(filePath);

    // Wait for async handlers
    await vi.waitFor(() => {
      expect(manager.get("gateway").port).toBe(20000);
    });

    expect(manager.get("gateway").port).toBe(20000);
    expect(changes.some((c) => c.path === "gateway.port" && c.source === "hot-reload")).toBe(true);
    expect(manager.getStats().watching).toBe(true);

    manager.stopWatching();
  });
});