import { describe, it, expect } from "vitest";
import { ConfigManager, defaultConfig } from "./config";

describe("ConfigManager", () => {
  it("should use defaults when no override provided", () => {
    const cm = new ConfigManager();
    expect(cm.get("server").port).toBe(3000);
    expect(cm.get("agent").minAgents).toBe(2);
    expect(cm.get("evolution").enabled).toBe(true);
  });

  it("should merge partial overrides", () => {
    const cm = new ConfigManager({
      server: { port: 8080 },
      evolution: { enabled: false },
    });
    expect(cm.get("server").port).toBe(8080);
    expect(cm.get("server").host).toBe("0.0.0.0");
    expect(cm.get("evolution").enabled).toBe(false);
  });

  it("should update config at runtime", () => {
    const cm = new ConfigManager();
    cm.update({ agent: { maxAgents: 20 } });
    expect(cm.get("agent").maxAgents).toBe(20);
    expect(cm.get("agent").minAgents).toBe(2);
  });

  it("should return full config", () => {
    const cm = new ConfigManager();
    const all = cm.getAll();
    expect(all.server).toBeDefined();
    expect(all.agent).toBeDefined();
    expect(all.security).toBeDefined();
  });

  it("should load from environment variables", () => {
    process.env.EvoClaw_PORT = "9999";
    process.env.JWT_SECRET = "test-secret-with-minimum-16-chars";
    const cm = new ConfigManager();
    cm.loadFromEnv();

    expect(cm.get("server").port).toBe(9999);
    expect(cm.get("auth").jwtSecret).toBe("test-secret-with-minimum-16-chars");

    delete process.env.EvoClaw_PORT;
    delete process.env.JWT_SECRET;
  });

  it("should respect evolution env toggle", () => {
    process.env.EvoClaw_EVOLUTION_ENABLED = "false";
    const cm = new ConfigManager();
    cm.loadFromEnv();
    expect(cm.get("evolution").enabled).toBe(false);
    delete process.env.EvoClaw_EVOLUTION_ENABLED;
  });
});