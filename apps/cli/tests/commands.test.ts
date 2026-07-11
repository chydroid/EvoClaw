import { describe, it, expect } from "vitest";
import {
  COMMAND_REGISTRY,
  COMMAND_LOOKUP,
  COMMANDS_BY_CATEGORY,
  GATEWAY_KNOWN_COMMANDS,
  resolveCommand,
  isGatewayKnownCommand,
  shouldBypassActiveSession,
} from "../src/commands/registry";

describe("Command Registry", () => {
  describe("COMMAND_REGISTRY", () => {
    it("应包含 50+ 命令", () => {
      expect(COMMAND_REGISTRY.length).toBeGreaterThanOrEqual(50);
    });

    it("每个命令都有 name 和 description", () => {
      for (const cmd of COMMAND_REGISTRY) {
        expect(cmd.name).toBeTruthy();
        expect(cmd.description).toBeTruthy();
      }
    });

    it("命令名称唯一（无重复）", () => {
      const names = COMMAND_REGISTRY.map((c) => c.name);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });
  });

  describe("resolveCommand", () => {
    it("通过名称查找命令", () => {
      const cmd = resolveCommand("config");
      expect(cmd).not.toBeNull();
      expect(cmd!.name).toBe("config");
      expect(cmd!.description).toBe("Read and write EvoClaw configuration");
    });

    it("查找不存在的命令返回 null", () => {
      expect(resolveCommand("nonexistent-command-xyz")).toBeNull();
    });

    it("查找空字符串返回 null", () => {
      expect(resolveCommand("")).toBeNull();
    });

    it("通过别名查找命令", () => {
      const cmd = resolveCommand("capability");
      expect(cmd).not.toBeNull();
      expect(cmd!.name).toBe("infer");
    });

    it("通过 terminal 别名查找 tui 命令", () => {
      const cmd = resolveCommand("terminal");
      expect(cmd).not.toBeNull();
      expect(cmd!.name).toBe("tui");
    });

    it("通过名称和别名都能找到同一命令", () => {
      const byName = resolveCommand("infer");
      const byAlias = resolveCommand("capability");
      expect(byName).not.toBeNull();
      expect(byAlias).not.toBeNull();
      expect(byName).toBe(byAlias);
    });
  });

  describe("COMMAND_LOOKUP", () => {
    it("包含所有命令名称", () => {
      for (const cmd of COMMAND_REGISTRY) {
        expect(COMMAND_LOOKUP.has(cmd.name)).toBe(true);
      }
    });

    it("包含所有别名", () => {
      for (const cmd of COMMAND_REGISTRY) {
        if (cmd.aliases) {
          for (const alias of cmd.aliases) {
            expect(COMMAND_LOOKUP.has(alias)).toBe(true);
          }
        }
      }
    });

    it("通过名称获取的命令与注册表一致", () => {
      const cmd = COMMAND_LOOKUP.get("chat");
      expect(cmd).toBeDefined();
      expect(cmd!.name).toBe("chat");
    });
  });

  describe("COMMANDS_BY_CATEGORY", () => {
    it("按类别分组命令", () => {
      const systemCmds = COMMANDS_BY_CATEGORY.get("system");
      expect(systemCmds).toBeDefined();
      expect(systemCmds!.length).toBeGreaterThan(0);
      // 所有命令的 category 都是 system
      for (const cmd of systemCmds!) {
        expect(cmd.category).toBe("system");
      }
    });

    it("config 类别包含 config 和 models", () => {
      const configCmds = COMMANDS_BY_CATEGORY.get("config");
      expect(configCmds).toBeDefined();
      const names = configCmds!.map((c) => c.name);
      expect(names).toContain("config");
      expect(names).toContain("models");
    });

    it("每个类别中的命令都属于该类别", () => {
      for (const [category, cmds] of COMMANDS_BY_CATEGORY) {
        for (const cmd of cmds) {
          expect(cmd.category).toBe(category);
        }
      }
    });

    it("agent 类别包含 chat 和 agent", () => {
      const agentCmds = COMMANDS_BY_CATEGORY.get("agent");
      expect(agentCmds).toBeDefined();
      const names = agentCmds!.map((c) => c.name);
      expect(names).toContain("chat");
      expect(names).toContain("agent");
    });

    it("maintenance 类别包含 update 和 backup", () => {
      const maintCmds = COMMANDS_BY_CATEGORY.get("maintenance");
      expect(maintCmds).toBeDefined();
      const names = maintCmds!.map((c) => c.name);
      expect(names).toContain("update");
      expect(names).toContain("backup");
    });
  });

  describe("GATEWAY_KNOWN_COMMANDS", () => {
    it("包含非 cliOnly 的命令", () => {
      // chat 不是 cliOnly，应在集合中
      expect(GATEWAY_KNOWN_COMMANDS.has("chat")).toBe(true);
      expect(GATEWAY_KNOWN_COMMANDS.has("config")).toBe(true);
      expect(GATEWAY_KNOWN_COMMANDS.has("gateway")).toBe(true);
    });

    it("不包含 cliOnly 的命令", () => {
      // setup 是 cliOnly，不应在集合中
      expect(GATEWAY_KNOWN_COMMANDS.has("setup")).toBe(false);
      expect(GATEWAY_KNOWN_COMMANDS.has("onboard")).toBe(false);
      expect(GATEWAY_KNOWN_COMMANDS.has("completion")).toBe(false);
    });

    it("包含别名", () => {
      // capability 是 infer 的别名，infer 不是 cliOnly
      expect(GATEWAY_KNOWN_COMMANDS.has("capability")).toBe(true);
    });

    it("不包含 cliOnly 命令的别名", () => {
      // terminal 是 tui 的别名，tui 是 cliOnly
      expect(GATEWAY_KNOWN_COMMANDS.has("terminal")).toBe(false);
    });
  });

  describe("isGatewayKnownCommand", () => {
    it("已知命令返回 true", () => {
      expect(isGatewayKnownCommand("chat")).toBe(true);
      expect(isGatewayKnownCommand("config")).toBe(true);
    });

    it("cliOnly 命令返回 false", () => {
      expect(isGatewayKnownCommand("setup")).toBe(false);
      expect(isGatewayKnownCommand("completion")).toBe(false);
    });

    it("未知命令返回 false", () => {
      expect(isGatewayKnownCommand("nonexistent")).toBe(false);
    });

    it("别名可识别", () => {
      expect(isGatewayKnownCommand("capability")).toBe(true);
    });
  });

  describe("shouldBypassActiveSession", () => {
    it("config 命令应跳过排队", () => {
      expect(shouldBypassActiveSession("config")).toBe(true);
    });

    it("models 命令应跳过排队", () => {
      expect(shouldBypassActiveSession("models")).toBe(true);
    });

    it("help 命令应跳过排队", () => {
      expect(shouldBypassActiveSession("help")).toBe(true);
    });

    it("status 命令应跳过排队", () => {
      expect(shouldBypassActiveSession("status")).toBe(true);
    });

    it("clear 命令应跳过排队", () => {
      expect(shouldBypassActiveSession("clear")).toBe(true);
    });

    it("reset 命令应跳过排队", () => {
      expect(shouldBypassActiveSession("reset")).toBe(true);
    });

    it("chat 命令不应跳过排队", () => {
      expect(shouldBypassActiveSession("chat")).toBe(false);
    });

    it("agent 命令不应跳过排队", () => {
      expect(shouldBypassActiveSession("agent")).toBe(false);
    });

    it("未知命令不应跳过排队", () => {
      expect(shouldBypassActiveSession("unknown")).toBe(false);
    });
  });
});
