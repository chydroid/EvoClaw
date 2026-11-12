import { describe, it, expect, beforeEach } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { AgentModelExecutor } from "./agent-model-executor";
import type { ToolDefinition, ToolSource } from "./types";

/**
 * P2 插件准入护栏：核心工具封存后，非 core 来源不得撞名覆盖。
 */
describe("AgentModelExecutor — 工具来源护栏（P2）", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  const CORE_TOOL = "execute_tool_chain";

  const def = (name: string): ToolDefinition => ({
    name,
    description: "probe",
    parameters: { value: { type: "string", description: "v", required: false } },
  });

  function makeExecutor(allowCoreToolOverride?: boolean): AgentModelExecutor {
    return new AgentModelExecutor(registry, eventBus, undefined, undefined, { allowCoreToolOverride });
  }

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    delete process.env.EVOCLAW_ALLOW_CORE_TOOL_OVERRIDE;
  });

  it("封存前：非 core 来源撞名天然豁免", () => {
    const executor = makeExecutor();
    executor.registerTool(CORE_TOOL, def(CORE_TOOL), async () => ({ replaced: true }), undefined, undefined, "extension");
    expect(executor.getToolSource(CORE_TOOL)).toBe("extension");
  });

  it("封存后：extension/plugin/mcp 撞名核心工具被拒绝，原 handler 保留", async () => {
    const executor = makeExecutor();
    executor.sealCoreToolSet();
    expect(executor.isCoreToolSetSealed()).toBe(true);

    for (const source of ["extension", "plugin", "mcp"] as ToolSource[]) {
      executor.registerTool(CORE_TOOL, def(CORE_TOOL), async () => ({ replaced: source }), undefined, undefined, source);
      expect(executor.getToolSource(CORE_TOOL)).toBe("core");
    }

    // 原 handler 仍在（toolChainRegistry 未初始化 → 返回 not available 错误 JSON）
    const result = await executor.executeToolByName(CORE_TOOL, { chain_name: "x" });
    expect(String(result)).toContain("ToolChain system not available");
  });

  it("封存后：非 core 来源注册新工具名不受影响", () => {
    const executor = makeExecutor();
    executor.sealCoreToolSet();
    executor.registerTool("mcp__srv__probe", def("mcp__srv__probe"), async () => ({ ok: true }), undefined, undefined, "mcp");
    expect(executor.getToolSource("mcp__srv__probe")).toBe("mcp");
  });

  it("封存后：非 core 之间同名允许覆盖（MCP 重连语义），来源跟随最新", () => {
    const executor = makeExecutor();
    executor.sealCoreToolSet();
    executor.registerTool("mcp__srv__probe", def("mcp__srv__probe"), async () => 1, undefined, undefined, "mcp");
    executor.registerTool("mcp__srv__probe", def("mcp__srv__probe"), async () => 2, undefined, undefined, "extension");
    expect(executor.getToolSource("mcp__srv__probe")).toBe("extension");
  });

  it("allowCoreToolOverride=true 时允许覆盖（显式信任逃生门）", () => {
    const executor = makeExecutor(true);
    executor.sealCoreToolSet();
    executor.registerTool(CORE_TOOL, def(CORE_TOOL), async () => ({ replaced: true }), undefined, undefined, "plugin");
    expect(executor.getToolSource(CORE_TOOL)).toBe("plugin");
  });

  it("env EVOCLAW_ALLOW_CORE_TOOL_OVERRIDE=1 同样生效", () => {
    process.env.EVOCLAW_ALLOW_CORE_TOOL_OVERRIDE = "1";
    const executor = makeExecutor(undefined);
    executor.sealCoreToolSet();
    executor.registerTool(CORE_TOOL, def(CORE_TOOL), async () => ({ replaced: true }), undefined, undefined, "plugin");
    expect(executor.getToolSource(CORE_TOOL)).toBe("plugin");
    delete process.env.EVOCLAW_ALLOW_CORE_TOOL_OVERRIDE;
  });
});
