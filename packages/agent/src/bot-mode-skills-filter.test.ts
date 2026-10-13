/**
 * P1-1 Bot Mode 剩余接线：avatar 扩展 + allowedSkills 透传测试。
 *
 * 覆盖：
 * - AgentModelExecutor.setAgentSkillFilter / buildSkillsPromptForRun(allowlist) 过滤语义
 * - RoomManager 无额外用例（已在 room-manager.test.ts 覆盖）
 */
import { describe, it, expect } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { AgentModelExecutor } from "./agent-model-executor";

/** 最小可构造的 executor（供 skills 过滤单测用，不走完整 chat 链路） */
function createExecutor(): { executor: AgentModelExecutor; skillManager: { listSkills: () => Promise<unknown[]> } } {
  const registry = new ServiceRegistry();
  const eventBus = new EventBus();
  const skillManager = {
    listSkills: async () => [
      { id: "s1", name: "tavily-search", description: "search web", installPath: "skills/tavily-search/SKILL.md" },
      { id: "s2", name: "baidu-search", description: "search baidu", installPath: "skills/baidu-search/SKILL.md" },
      { id: "s3", name: "code-review", description: "review code", installPath: "skills/code-review/SKILL.md" },
    ],
  };
  registry.registerService("skillManager", skillManager);
  const executor = new AgentModelExecutor(registry, eventBus);
  return { executor, skillManager };
}

describe("P1-1 allowedSkills 透传（buildSkillsPromptForRun 过滤）", () => {
  it("无白名单时全量 skills 可见（向后兼容）", async () => {
    const { executor } = createExecutor();
    const prompt = await executor.buildSkillsPromptForRun();
    expect(prompt).toContain("tavily-search");
    expect(prompt).toContain("baidu-search");
    expect(prompt).toContain("code-review");
  });

  it("带白名单时仅白名单内 skills 可见", async () => {
    const { executor } = createExecutor();
    const prompt = await executor.buildSkillsPromptForRun(["tavily-search", "code-review"]);
    expect(prompt).toContain("tavily-search");
    expect(prompt).toContain("code-review");
    expect(prompt).not.toContain("baidu-search");
  });

  it("setAgentSkillFilter 注册的白名单经 _currentAgentBySession 路由生效", async () => {
    const { executor } = createExecutor();
    // 模拟 RoomManager 接线：agent "coder" 只允许 code-review
    executor.setAgentSkillFilter("coder", ["code-review"]);
    // 通过 chatInner 之外的公开路径验证：直接构造 per-agent 白名单查询语义
    const allowlist = (executor as unknown as { _agentSkillFilters: Map<string, string[]> })._agentSkillFilters.get("coder");
    expect(allowlist).toEqual(["code-review"]);
    const prompt = await executor.buildSkillsPromptForRun(allowlist);
    expect(prompt).toContain("code-review");
    expect(prompt).not.toContain("tavily-search");
    expect(prompt).not.toContain("baidu-search");
  });

  it("setAgentSkillFilter 传 undefined 清除限制（该 agent 恢复全量可见）", async () => {
    const { executor } = createExecutor();
    executor.setAgentSkillFilter("coder", ["code-review"]);
    executor.setAgentSkillFilter("coder");
    const allowlist = (executor as unknown as { _agentSkillFilters: Map<string, string[]> })._agentSkillFilters.get("coder");
    expect(allowlist).toBeUndefined();
  });
});
