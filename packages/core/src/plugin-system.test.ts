import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PluginManager, type Plugin } from "./plugin-system";
import { EventBus } from "./event-bus";

/**
 * P2 插件准入护栏：PluginContext.registerTool 的「声明-实际」校验。
 */
describe("PluginManager — 声明-实际工具校验（P2）", () => {
  let tmpDir: string;
  let manager: PluginManager;
  let registered: Array<{ name: string; source?: string }>;
  /** 模拟 executor 已占用的工具名 → 来源（用于验证拒绝后的台账） */
  let occupied: Map<string, string>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-plugin-p2-"));
    manager = new PluginManager(tmpDir);
    manager.setEventBus(new EventBus());
    registered = [];
    occupied = new Map();
    const fakeRegistry = {
      resolveService: (name: string) =>
        name === "agentModelExecutor"
          ? {
              registerTool: (
                toolName: string,
                _def: unknown,
                _handler: unknown,
                _checkFn?: unknown,
                _overrides?: unknown,
                source?: string,
              ) => {
                // 模拟核心工具封存后的拒绝语义：只告警、不覆盖
                if (occupied.has(toolName)) return;
                occupied.set(toolName, source ?? "core");
                registered.push({ name: toolName, source });
              },
              getToolSource: (toolName: string) => occupied.get(toolName),
            }
          : undefined,
    };
    manager.setRegistry(fakeRegistry as never);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const plugin = (manifest: Plugin["manifest"], toolNames: string[]): Plugin => ({
    manifest,
    hooks: [],
    async init(ctx) {
      for (const name of toolNames) {
        ctx.registerTool?.(
          name,
          { name, description: "probe", parameters: {} },
          async () => ({ ok: true }),
        );
      }
    },
  });

  it("已声明 providesTools：注册声明内工具成功，来源标记 plugin", async () => {
    await manager.registerPlugin(
      plugin({ name: "p-ok", version: "1.0.0", description: "x", providesTools: ["alpha"] }, ["alpha"]),
    );
    const info = manager.getPlugins().find((p) => p.manifest.name === "p-ok");
    expect(info?.status).toBe("active");
    expect(info?.tools).toEqual(["alpha"]);
    expect(registered).toEqual([{ name: "alpha", source: "plugin" }]);
  });

  it("已声明 providesTools：注册未声明工具 → init 失败（不注册）", async () => {
    await manager.registerPlugin(
      plugin({ name: "p-bad", version: "1.0.0", description: "x", providesTools: ["alpha"] }, ["beta"]),
    );
    const info = manager.getPlugins().find((p) => p.manifest.name === "p-bad");
    expect(info?.status).toBe("error");
    expect(info?.error).toContain("undeclared tool");
    expect(registered.length).toBe(0);
  });

  it("未声明 providesTools：注册允许但记录（告警语义）", async () => {
    await manager.registerPlugin(
      plugin({ name: "p-legacy", version: "1.0.0", description: "x" }, ["gamma"]),
    );
    const info = manager.getPlugins().find((p) => p.manifest.name === "p-legacy");
    expect(info?.status).toBe("active");
    expect(info?.tools).toEqual(["gamma"]);
    expect(registered).toEqual([{ name: "gamma", source: "plugin" }]);
  });

  it("注册被 executor 拒绝（核心工具撞名）时不计入 tools 台账", async () => {
    occupied.set("shell_exec", "core");
    await manager.registerPlugin(
      plugin({ name: "p-shadow", version: "1.0.0", description: "x", providesTools: ["shell_exec"] }, ["shell_exec"]),
    );
    const info = manager.getPlugins().find((p) => p.manifest.name === "p-shadow");
    expect(info?.status).toBe("active");
    expect(info?.tools).toEqual([]);
    expect(registered.length).toBe(0);
  });

  it("executor 服务缺席时 init 失败（fail-closed）", async () => {
    manager.setRegistry({ resolveService: () => undefined } as never);
    await manager.registerPlugin(
      plugin({ name: "p-noexec", version: "1.0.0", description: "x", providesTools: ["delta"] }, ["delta"]),
    );
    const info = manager.getPlugins().find((p) => p.manifest.name === "p-noexec");
    expect(info?.status).toBe("error");
    expect(info?.error).toContain("agentModelExecutor");
  });
});
