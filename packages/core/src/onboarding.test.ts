import { describe, it, expect, beforeEach, vi } from "vitest";
import { OnboardingWizard } from "./onboarding";

function createWizard(
  responses: Record<string, string> = {},
  selectOverride?: (options: string[]) => string,
) {
  const input = vi.fn(async (prompt: string, defaultValue?: string) => {
    // Find matching response by prompt keyword
    for (const [key, value] of Object.entries(responses)) {
      if (prompt.toLowerCase().includes(key.toLowerCase())) {
        return value;
      }
    }
    return defaultValue ?? "";
  });

  const select = vi.fn(async (_prompt: string, options: string[], defaultIndex?: number) => {
    if (selectOverride) return selectOverride(options);
    return options[defaultIndex ?? 0];
  });

  const confirm = vi.fn(async () => true);

  return {
    wizard: new OnboardingWizard({ interactive: true }, { input, select, confirm }),
    input,
    select,
    confirm,
  };
}

describe("OnboardingWizard", () => {
  describe("acceptAllDefaults", () => {
    it("should generate complete config with defaults", async () => {
      const wizard = new OnboardingWizard({ acceptDefaults: false });
      const config = await wizard.acceptAllDefaults();

      expect(config.identity.assistantName).toBe("EvoClaw");
      expect(config.identity.tone).toBe("professional");
      expect(config.auth.adminUsername).toBe("admin");
      expect(config.auth.jwtSecret).toBeTruthy();
      expect(config.auth.adminPassword).toBeTruthy();
      expect(config.gateway.port).toBe(3000);
      expect(config.llm.provider).toBe("openai");
      expect(config.llm.temperature).toBe(0.7);
      expect(config.data.dataDir).toBe("./data");
    });

    it("should generate unique secrets each time", async () => {
      const wizard = new OnboardingWizard();
      const config1 = await wizard.acceptAllDefaults();
      const config2 = await wizard.acceptAllDefaults();

      expect(config1.auth.jwtSecret).not.toBe(config2.auth.jwtSecret);
      expect(config1.auth.adminPassword).not.toBe(config2.auth.adminPassword);
    });
  });

  describe("exportConfig", () => {
    it("should export valid JSON", async () => {
      const wizard = new OnboardingWizard({ acceptDefaults: false });

      // Prime with identity
      const { wizard: w, input, select, confirm } = createWizard({
        name: "TestBot",
        title: "Test Assistant",
        address: "User",
        message: "Hello test",
      });

      const config = await w.generateConfig();
      const json = w.exportConfig();

      const parsed = JSON.parse(json);
      expect(parsed.identity.assistantName).toBeDefined();
      expect(parsed.auth.jwtSecret).toBeDefined();
    });
  });

  describe("generateConfig", () => {
    it("should merge progress with defaults", () => {
      const wizard = new OnboardingWizard({ acceptDefaults: false });
      const config = wizard.generateConfig();

      expect(config.identity.assistantName).toBe("EvoClaw");
      expect(config.gateway.port).toBe(3000);
    });
  });

  describe("runStep", () => {
    it("should run identity step with custom values", async () => {
      const { wizard } = createWizard({
        name: "MyBot",
        title: "My Assistant",
        address: "Master",
        message: "Greetings",
      });

      await wizard.runStep("identity");
      const progress = wizard.getProgress();

      expect(progress.config.identity?.assistantName).toBe("MyBot");
    });

    it("should run auth step with custom values", async () => {
      const { wizard } = createWizard({
        secret: "my-custom-secret",
        username: "root",
        password: "p@ss",
        expiry: "24",
      });

      await wizard.runStep("auth");
      const progress = wizard.getProgress();

      expect(progress.config.auth?.adminUsername).toBe("root");
      expect(progress.config.auth?.tokenExpiryHours).toBe(24);
    });

    it("should run gateway step", async () => {
      const { wizard } = createWizard({
        port: "8080",
        host: "127.0.0.1",
        cors: "http://localhost:3000",
      });

      await wizard.runStep("gateway");
      const progress = wizard.getProgress();

      expect(progress.config.gateway?.port).toBe(8080);
      expect(progress.config.gateway?.host).toBe("127.0.0.1");
      expect(progress.config.gateway?.enableREST).toBe(true);
    });

    it("should run llm step with custom values", async () => {
      const { wizard } = createWizard({
        key: "sk-test",
      }, (options) => options[1]); // Select "anthropic"

      await wizard.runStep("llm");
      const progress = wizard.getProgress();

      expect(progress.config.llm?.provider).toBe("anthropic");
      expect(progress.config.llm?.apiKey).toBe("sk-test");
    });

    it("should run data step", async () => {
      const { wizard } = createWizard({
        "data directory": "/custom/data",
        sessions: "/custom/sessions",
        logs: "/custom/logs",
        skills: "/custom/skills",
      });

      await wizard.runStep("data");
      const progress = wizard.getProgress();

      expect(progress.config.data?.dataDir).toBe("/custom/data");
    });
  });

  describe("run (full flow)", () => {
    it("should run complete onboarding flow", async () => {
      const { wizard } = createWizard({
        "assistant name": "FullBot",
        "assistant title": "Full Assistant",
        "address you": "Boss",
        "introduction message": "Hi",
        "jwt secret": "",
        "admin username": "admin",
        "admin password": "",
        "token expiry": "168",
        "gateway port": "3000",
        "host address": "0.0.0.0",
        "cors origins": "",
        "api key": "",
        "model id": "gpt-4o",
        "temperature ": "1.0",
        "max tokens": "8192",
        "data directory": "./data",
        "sessions directory": "./data/sessions",
        "logs directory": "./data/logs",
        "skills directory": "./data/skills",
      });

      const config = await wizard.run();

      expect(config.identity.assistantName).toBe("FullBot");
      expect(config.auth.adminUsername).toBe("admin");
      expect(config.gateway.port).toBe(3000);
      expect(config.llm.provider).toBeDefined();
      expect(config.data.dataDir).toBe("./data");
    });
  });

  describe("progress/resume", () => {
    it("should track and resume progress", () => {
      const wizard = new OnboardingWizard();

      const progress = wizard.getProgress();
      expect(progress.currentStep).toBe("identity");
      expect(progress.completedSteps).toHaveLength(0);

      wizard.resumeFrom({
        currentStep: "gateway",
        completedSteps: ["identity", "auth"],
        config: { identity: { assistantName: "Resumed", assistantTitle: "", masterTerm: "", tone: "warm", introduction: "" } },
        startedAt: Date.now(),
      });

      const resumed = wizard.getProgress();
      expect(resumed.currentStep).toBe("gateway");
      expect(resumed.completedSteps).toEqual(["identity", "auth"]);
    });
  });

  describe("acceptDefaults mode", () => {
    it("should skip interaction when acceptDefaults is true", async () => {
      const input = vi.fn(async () => "");
      const select = vi.fn(async () => "");

      const wizard = new OnboardingWizard(
        { acceptDefaults: true },
        { input, select },
      );

      const config = await wizard.run();

      // No interaction should have occurred
      expect(input).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();

      expect(config.identity.assistantName).toBe("EvoClaw");
      expect(config.gateway.port).toBe(3000);
    });
  });

  describe("llm temperature clamping", () => {
    it("should clamp temperature to valid range", async () => {
      const { wizard } = createWizard({
        temperature: "5.0",
      }, (options) => options[0]);

      await wizard.runStep("llm");
      const progress = wizard.getProgress();

      expect(progress.config.llm?.temperature).toBe(2.0); // Clamped to max
    });
  });
});