import { describe, it, expect, beforeEach } from "vitest";
import { ModelSwitcher } from "./model-switcher";
import type { ModelAlias } from "./model-switcher";

function makeGpt4(): ModelAlias {
  return {
    alias: "gpt4",
    providerId: "openai",
    modelId: "gpt-4o",
    description: "GPT-4o — best overall",
    maxTokens: 128000,
    supportsVision: true,
    supportsFunctions: true,
    costTier: "premium",
  };
}

function makeClaude(): ModelAlias {
  return {
    alias: "claude",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    description: "Claude — creative & coding",
    maxTokens: 200000,
    supportsVision: true,
    supportsFunctions: true,
    costTier: "standard",
  };
}

function makeFast(): ModelAlias {
  return {
    alias: "fast",
    providerId: "openai",
    modelId: "gpt-4o-mini",
    description: "GPT-4o Mini — fast & cheap",
    maxTokens: 128000,
    supportsVision: true,
    supportsFunctions: true,
    costTier: "cheap",
  };
}

describe("ModelSwitcher", () => {
  let switcher: ModelSwitcher;

  beforeEach(() => {
    switcher = new ModelSwitcher({ defaultAlias: "fast" });
  });

  describe("register/alias", () => {
    it("should register a model alias", () => {
      switcher.registerAlias(makeFast());
      const alias = switcher.getAlias("fast");
      expect(alias).not.toBeNull();
      expect(alias!.providerId).toBe("openai");
      expect(alias!.modelId).toBe("gpt-4o-mini");
    });

    it("should batch register aliases", () => {
      switcher.registerAllAliases([makeFast(), makeGpt4(), makeClaude()]);
      expect(switcher.listAliases()).toHaveLength(3);
    });

    it("should auto-activate the default alias on register", () => {
      switcher.registerAlias(makeFast());
      expect(switcher.getActive().alias).toBe("fast");
    });
  });

  describe("activate", () => {
    beforeEach(() => {
      switcher.registerAllAliases([makeFast(), makeGpt4(), makeClaude()]);
    });

    it("should activate a model by alias", () => {
      const active = switcher.activate("gpt4");
      expect(active.alias).toBe("gpt4");
      expect(active.model.providerId).toBe("openai");
    });

    it("should throw for unknown alias", () => {
      expect(() => switcher.activate("unknown")).toThrow("Unknown model alias");
    });

    it("should record switch history", () => {
      switcher.activate("gpt4");
      switcher.activate("claude");

      const history = switcher.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].from).toBe("fast");
      expect(history[0].to).toBe("gpt4");
      expect(history[1].from).toBe("gpt4");
      expect(history[1].to).toBe("claude");
    });

    it("should undo last switch", () => {
      switcher.activate("gpt4");
      switcher.activate("claude");

      const result = switcher.undo();
      expect(result!.alias).toBe("gpt4");
    });

    it("should return null when no history to undo", () => {
      expect(switcher.undo()).toBeNull();
    });
  });

  describe("presets", () => {
    beforeEach(() => {
      switcher.registerAllAliases([makeFast(), makeGpt4(), makeClaude()]);
    });

    it("should list built-in presets", () => {
      const presets = switcher.listPresets();
      expect(presets.length).toBeGreaterThan(0);
      // "fast" preset should be recommended
      const fastPreset = presets.find((p) => p.name === "fast");
      expect(fastPreset!.recommended).toBe(true);
    });

    it("should activate by preset name", () => {
      const result = switcher.activatePreset("coding");
      expect(result.alias).toBe("gpt4");
    });

    it("should throw for unknown preset", () => {
      expect(() => switcher.activatePreset("nonexistent")).toThrow("Unknown preset");
    });

    it("should register custom preset", () => {
      switcher.registerPreset({
        name: "custom-task",
        modelAlias: "fast",
        description: "Custom preset",
      });

      const preset = switcher.listPresets().find((p) => p.name === "custom-task");
      expect(preset).not.toBeUndefined();
    });
  });

  describe("session override", () => {
    beforeEach(() => {
      switcher.registerAllAliases([makeFast(), makeGpt4()]);
    });

    it("should override model for a session", () => {
      switcher.setSessionOverride("sess-1", "gpt4");
      const active = switcher.getActiveForSession("sess-1");
      expect(active.alias).toBe("gpt4");
    });

    it("should fall back to global when no override", () => {
      const active = switcher.getActiveForSession("sess-unknown");
      expect(active.alias).toBe(switcher.getActive().alias);
    });

    it("should clear session override", () => {
      switcher.setSessionOverride("sess-1", "gpt4");
      expect(switcher.clearSessionOverride("sess-1")).toBe(true);
      expect(switcher.clearSessionOverride("sess-1")).toBe(false);
    });
  });

  describe("/model command", () => {
    beforeEach(() => {
      switcher.registerAllAliases([makeFast(), makeGpt4(), makeClaude()]);
    });

    it("should list models with empty args", () => {
      const output = switcher.handleModelCommand([]);
      expect(output).toContain("Available models:");
      expect(output).toContain("gpt4");
      expect(output).toContain("claude");
      expect(output).toContain("fast");
    });

    it("should list models with list subcommand", () => {
      const output = switcher.handleModelCommand(["list"]);
      expect(output).toContain("Available models:");
    });

    it("should list presets", () => {
      const output = switcher.handleModelCommand(["presets"]);
      expect(output).toContain("Available presets:");
    });

    it("should show current model", () => {
      const output = switcher.handleModelCommand(["current"]);
      expect(output).toContain("Current model:");
    });

    it("should switch model via command", () => {
      const output = switcher.handleModelCommand(["switch", "gpt4"]);
      expect(output).toContain("Switched to");
      expect(switcher.getActive().alias).toBe("gpt4");
    });

    it("should handle unknown subcommand", () => {
      const output = switcher.handleModelCommand(["invalid"]);
      expect(output).toContain("Unknown /model subcommand");
    });

    it("should show usage for switch without target", () => {
      const output = switcher.handleModelCommand(["switch"]);
      expect(output).toContain("Usage:");
    });

    it("should undo via command", () => {
      switcher.activate("gpt4");
      const output = switcher.handleModelCommand(["undo"]);
      expect(output).toContain("Switched back");
    });
  });

  describe("configure", () => {
    it("should update config", () => {
      switcher.configure({ maxHistory: 100 });
    });
  });
});