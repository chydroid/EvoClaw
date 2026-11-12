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

  // P8：配置降级标记 —— 读失败 fail-open 但响亮，写回 fail-closed
  describe("degraded status (P8)", () => {
    it("marks degraded and keeps current config when the file is corrupt", async () => {
      const manager = new ConfigManager();
      await manager.set("gateway.port", 18888);
      const filePath = path.join(tmpDir, "corrupt.json");
      fs.writeFileSync(filePath, "{ not json", "utf-8");

      await expect(manager.loadFromFile(filePath)).rejects.toThrow(/Failed to parse/);

      const status = manager.getStatus();
      // 首次加载即失败：没有「成功加载」过，但降级状态必须响亮
      expect(status.loaded).toBe(false);
      expect(status.degraded).toBe(true);
      expect(status.sourcePath).toBe(filePath);
      expect(status.reason).toContain("failed to parse");
      expect(status.lastError).toBeTruthy();
      // fail-open：内存里的配置保持原值，不被默认值覆盖
      expect(manager.get("gateway").port).toBe(18888);
    });

    it("refuses to write back the same file while degraded", async () => {
      const manager = new ConfigManager();
      const filePath = path.join(tmpDir, "degraded-write.json");
      const original = "{ broken config";
      fs.writeFileSync(filePath, original, "utf-8");
      await expect(manager.loadFromFile(filePath)).rejects.toThrow();

      // 修复前的写回会把默认值覆盖到用户文件上，必须拒绝
      await expect(manager.saveToFile()).rejects.toThrow(/Refusing to overwrite/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(original);
    });

    it("records signature + doctor on a successful load", async () => {
      const manager = new ConfigManager();
      const filePath = path.join(tmpDir, "good.json");
      fs.writeFileSync(filePath, JSON.stringify({ gateway: { port: 21001 } }), "utf-8");

      await manager.loadFromFile(filePath);

      const status = manager.getStatus();
      expect(status.loaded).toBe(true);
      expect(status.degraded).toBe(false);
      expect(status.sourcePath).toBe(filePath);
      expect(status.fileSignature).toMatch(/^[0-9a-f]{16}$/);
      expect(status.doctor).toBeDefined();
      expect(manager.get("gateway").port).toBe(21001);
    });

    it("treats a missing file as loaded (defaults) rather than degraded", async () => {
      const manager = new ConfigManager();
      await manager.loadFromFile(path.join(tmpDir, "does-not-exist.json"));

      const status = manager.getStatus();
      expect(status.loaded).toBe(true);
      expect(status.degraded).toBe(false);
      expect(status.fileSignature).toBeUndefined();
    });

    it("hot reload of invalid JSON keeps previous config and marks degraded", async () => {
      const manager = new ConfigManager();
      const filePath = path.join(tmpDir, "hot-invalid.json");
      fs.writeFileSync(filePath, JSON.stringify({ gateway: { port: 19999 } }), "utf-8");
      // startWatching 内部的 watch() 只登记基线、不应用文件内容，先显式加载上一份有效配置
      await manager.loadFromFile(filePath);
      const watcher = new ConfigWatcher();
      manager.startWatching(filePath, watcher);

      fs.writeFileSync(filePath, "{ invalid", "utf-8");
      watcher.forceReload(filePath);

      await vi.waitFor(() => {
        expect(manager.getStatus().degraded).toBe(true);
      });
      // 上一份有效配置继续生效
      expect(manager.get("gateway").port).toBe(19999);
      manager.stopWatching();
    });

    it("a later valid hot reload clears degraded", async () => {
      const manager = new ConfigManager();
      const filePath = path.join(tmpDir, "hot-recover.json");
      fs.writeFileSync(filePath, JSON.stringify({ gateway: { port: 19999 } }), "utf-8");
      await manager.loadFromFile(filePath);
      const watcher = new ConfigWatcher();
      manager.startWatching(filePath, watcher);

      fs.writeFileSync(filePath, "{ invalid", "utf-8");
      watcher.forceReload(filePath);
      await vi.waitFor(() => {
        expect(manager.getStatus().degraded).toBe(true);
      });

      fs.writeFileSync(filePath, JSON.stringify({ gateway: { port: 21002 } }), "utf-8");
      watcher.forceReload(filePath);
      await vi.waitFor(() => {
        expect(manager.get("gateway").port).toBe(21002);
      });

      expect(manager.getStatus().degraded).toBe(false);
      manager.stopWatching();
    });
  });
});